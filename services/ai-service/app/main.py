"""AI Agent Service API (API doc §9). Owner: Slice 5.

POST /ai/requests is implemented as the reference: create task_id/trace_id/plan_id,
publish to ai.requests, return 202. Agents and the Chair are separate Kafka
consumers (agents/), never called over HTTP from here."""
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Literal

from fastapi import FastAPI, Header, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints, model_validator
from pymongo.errors import PyMongoError
from starlette.exceptions import HTTPException

from . import config
from .bus import Bus
from .envelope import create_envelope
from .store import DuplicateTrace, InMemoryTaskStore, MongoTaskStore

log = logging.getLogger("ai-service")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None, retryable=False):
        self.status, self.code, self.message = status, code, message
        self.details, self.retryable = details or [], retryable


class StructuredFilters(BaseModel):
    model_config = {"extra": "forbid"}
    city: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)] | None = None
    guests: int | None = Field(default=None, ge=1, le=16)
    price_max: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    amenities: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]] = Field(
        default=[], max_length=20)
    min_rating: float | None = Field(default=None, ge=0, le=5)


class AiRequest(BaseModel):
    model_config = {"extra": "forbid"}
    request_text: str | None = Field(default=None, min_length=5, max_length=1000)
    structured: StructuredFilters | None = None
    check_in: date | None = None
    check_out: date | None = None
    property_pool_ref: Literal["active-pool-v1"] = "active-pool-v1"
    config_version: str | None = Field(default=None, min_length=1, max_length=60)

    @model_validator(mode="after")
    def check(self):
        has_filters = self.structured and any(v not in (None, []) for v in self.structured.model_dump().values())
        if not self.request_text and not has_filters:
            raise ValueError("request_text or structured is required")
        if self.check_in and self.check_out and self.check_out <= self.check_in:
            raise ValueError("check_out must be after check_in")
        return self


bus = Bus()
store = MongoTaskStore(config.MONGO_URL, config.MONGO_DB) if config.MONGO_ENABLED else InMemoryTaskStore()


@asynccontextmanager
async def lifespan(_app):
    await store.start()
    await bus.start()
    yield
    await bus.stop()
    await store.stop()


app = FastAPI(title="AI Agent Service", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def trace_middleware(request: Request, call_next):
    request.state.trace_id = request.headers.get("x-trace-id") or str(uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Trace-Id"] = request.state.trace_id
    return response


def _error(request: Request, status: int, code: str, message: str, details=None, retryable=False):
    return JSONResponse(status_code=status, content={
        "error": {"code": code, "message": message, "details": details or [], "retryable": retryable},
        "trace_id": getattr(request.state, "trace_id", None),
    })


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return _error(request, exc.status, exc.code, exc.message, exc.details, exc.retryable)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    details = [{"field": ".".join(str(p) for p in e["loc"][1:]) or "body", "issue": e["msg"]} for e in exc.errors()]
    return _error(request, 400, "VALIDATION_ERROR", "Request body is invalid.", details)


@app.exception_handler(HTTPException)
async def http_handler(request: Request, exc: HTTPException):
    code = "NOT_FOUND" if exc.status_code == 404 else "VALIDATION_ERROR" if exc.status_code < 500 else "INTERNAL_ERROR"
    return _error(request, exc.status_code, code, str(exc.detail), retryable=exc.status_code >= 500)


@app.exception_handler(PyMongoError)
async def mongo_handler(request: Request, exc: PyMongoError):
    log.error("mongo error trace_id=%s: %s", request.state.trace_id, exc)
    return _error(request, 503, "DEPENDENCY_UNAVAILABLE", "MongoDB is unavailable.", retryable=True)


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    return _error(request, 500, "INTERNAL_ERROR", "Unexpected error.", retryable=True)


def _user(x_user_id: str | None, x_user_role: str | None, *roles: str) -> dict:
    if not x_user_id:
        raise ApiError(401, "UNAUTHENTICATED", "Missing or invalid token.")
    if roles and x_user_role not in roles and x_user_role != "admin":
        raise ApiError(403, "FORBIDDEN", "Not allowed.")
    return {"id": x_user_id, "role": x_user_role}


async def _owned_task(task_id: str, x_user_id: str | None, x_user_role: str | None) -> dict:
    """Load a task for its owner or an admin: 401, then 404, then 403 (API doc §9)."""
    user = _user(x_user_id, x_user_role)
    task = await store.get(task_id)
    if not task:
        raise ApiError(404, "NOT_FOUND", "Task not found.")
    if user["role"] != "admin" and task["user_id"] != user["id"]:
        raise ApiError(403, "FORBIDDEN", "Not allowed.")
    return task


def _require_uuid_trace(trace_id: str):
    try:
        ok = str(uuid.UUID(trace_id)) == trace_id.lower()
    except ValueError:
        ok = False
    if not ok:
        raise ApiError(400, "VALIDATION_ERROR", "Request is invalid.",
                       [{"field": "X-Trace-Id", "issue": "must be a UUID"}])


def not_implemented(endpoint: str):
    raise ApiError(501, "NOT_IMPLEMENTED", f"{endpoint} is not implemented yet.")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ai-service", "kafka_enabled": config.KAFKA_ENABLED}


@app.post("/ai/requests", status_code=202)
async def create_request(body: AiRequest, request: Request,
                         x_user_id: str | None = Header(default=None),
                         x_user_role: str | None = Header(default=None)):
    user = _user(x_user_id, x_user_role, "guest", "host")
    trace_id = request.state.trace_id
    _require_uuid_trace(trace_id)
    if await store.count_open_for_user(user["id"]) >= config.MAX_OPEN_TASKS_PER_USER:
        raise ApiError(429, "RATE_LIMITED", "Too many open AI tasks.", retryable=True)

    task_id = f"tsk_{uuid.uuid4().hex}"
    plan_id = f"pln_{uuid.uuid4().hex}"
    version = body.config_version or config.CONFIG_VERSION

    try:
        await store.create({"task_id": task_id, "trace_id": trace_id, "plan_id": plan_id, "user_id": user["id"],
                            "config_version": version, "request": body.model_dump(mode="json")})
    except DuplicateTrace as exc:
        raise ApiError(400, "VALIDATION_ERROR", "Request is invalid.",
                       [{"field": "X-Trace-Id", "issue": "already used by another AI task"}]) from exc
    env = create_envelope(
        event_type="ai.requests", trace_id=trace_id, actor_id=user["id"], actor_type=user["role"],
        entity_type="ai_task", entity_id=task_id, idempotency_key=task_id,
        payload={"task_id": task_id, "plan_id": plan_id, "config_version": version, **body.model_dump(mode="json")},
    )
    try:
        await bus.publish("ai.requests", env)
    except Exception as exc:  # noqa: BLE001
        # Never leave it QUEUED: that would hold one of the user's open-task slots forever.
        # If the send timed out but did arrive, agents drop it because the task is closed.
        await store.transition(task_id, "FAILED", {"errors": [{"code": "DEPENDENCY_UNAVAILABLE", "message": "Kafka is unavailable."}]})
        raise ApiError(503, "DEPENDENCY_UNAVAILABLE", "Kafka is unavailable.", retryable=True) from exc

    return {"data": {"task_id": task_id, "trace_id": trace_id, "plan_id": plan_id, "status": "QUEUED",
                     "stream_url": f"/ai/tasks/{task_id}/stream"}, "trace_id": trace_id}


@app.get("/ai/tasks/{task_id}")
async def get_task(task_id: str, request: Request,
                   x_user_id: str | None = Header(default=None),
                   x_user_role: str | None = Header(default=None)):
    task = await _owned_task(task_id, x_user_id, x_user_role)
    fields = ("task_id", "trace_id", "plan_id", "status", "round", "plan", "agents",
              "started_at", "created_at", "updated_at", "errors")
    return {"data": {k: task[k] for k in fields}, "trace_id": request.state.trace_id}


@app.get("/ai/results/{task_id}")
async def get_result(task_id: str, request: Request,
                     x_user_id: str | None = Header(default=None),
                     x_user_role: str | None = Header(default=None)):
    task = await _owned_task(task_id, x_user_id, x_user_role)
    if not task.get("result"):
        # A failed task will never have a result, so polling again cannot help.
        dead = task["status"] in ("FAILED", "TIMED_OUT")
        raise ApiError(409, "NOT_READY",
                       f"The task ended {task['status']} without a result." if dead
                       else "The Chair has not published a result yet.", retryable=not dead)
    return {"data": task["result"], "trace_id": request.state.trace_id}


@app.post("/ai/tasks/{task_id}/approve")
async def approve(task_id: str):
    not_implemented("POST /ai/tasks/{task_id}/approve")


@app.get("/ai/tasks/{task_id}/debate")
async def debate(task_id: str, request: Request,
                 x_user_id: str | None = Header(default=None),
                 x_user_role: str | None = Header(default=None)):
    task = await _owned_task(task_id, x_user_id, x_user_role)
    messages = await store.list_messages(task["trace_id"])
    return {"data": {"trace_id": task["trace_id"],
                     "messages": [{k: m[k] for k in ("round", "agent", "event_id", "payload")} for m in messages]},
            "trace_id": request.state.trace_id}


@app.post("/ai/feedback")
async def feedback():
    not_implemented("POST /ai/feedback")


@app.get("/ai/versions")
async def versions():
    not_implemented("GET /ai/versions")


@app.websocket("/ai/tasks/{task_id}/stream")
async def stream(ws: WebSocket, task_id: str):
    task = await store.get(task_id)
    if not task:
        await ws.close(code=4404)
        return
    await ws.accept()
    await ws.send_json({"type": "status", "task_id": task_id, "trace_id": task["trace_id"], "status": task["status"]})
    # TODO (slice 5): consume debate.round.* / ai.results for this trace_id and forward frames
    # (plan.created, agent.published, challenge.issued, vote.cast, agent.timeout, harness.rejected, verdict)
    await ws.close()
