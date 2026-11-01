"""AI Agent Service API (API doc §9). Owner: Slice 5.

POST /ai/requests is implemented as the reference: create task_id/trace_id/plan_id,
publish to ai.requests, return 202. Agents and the Chair are separate Kafka
consumers (agents/), never called over HTTP from here."""
import uuid
from contextlib import asynccontextmanager
from datetime import date

from fastapi import FastAPI, Header, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from . import config
from .bus import Bus
from .envelope import create_envelope
from .store import InMemoryTaskStore


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None, retryable=False):
        self.status, self.code, self.message = status, code, message
        self.details, self.retryable = details or [], retryable


class StructuredFilters(BaseModel):
    city: str | None = None
    guests: int | None = Field(default=None, ge=1, le=16)
    price_max: float | None = Field(default=None, ge=0)
    amenities: list[str] = []
    min_rating: float | None = Field(default=None, ge=0, le=5)


class AiRequest(BaseModel):
    model_config = {"extra": "forbid"}
    request_text: str | None = Field(default=None, min_length=5, max_length=1000)
    structured: StructuredFilters | None = None
    check_in: date | None = None
    check_out: date | None = None
    property_pool_ref: str = "active-pool-v1"
    config_version: str | None = None

    @model_validator(mode="after")
    def check(self):
        if not self.request_text and not self.structured:
            raise ValueError("request_text or structured is required")
        if self.check_in and self.check_out and self.check_out <= self.check_in:
            raise ValueError("check_out must be after check_in")
        return self


bus = Bus()
store = InMemoryTaskStore()


@asynccontextmanager
async def lifespan(_app):
    await bus.start()
    yield
    await bus.stop()


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


def _user(x_user_id: str | None, x_user_role: str | None, *roles: str) -> dict:
    if not x_user_id:
        raise ApiError(401, "UNAUTHENTICATED", "Missing or invalid token.")
    if roles and x_user_role not in roles and x_user_role != "admin":
        raise ApiError(403, "FORBIDDEN", "Not allowed.")
    return {"id": x_user_id, "role": x_user_role}


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
    if await store.count_open_for_user(user["id"]) >= config.MAX_OPEN_TASKS_PER_USER:
        raise ApiError(429, "RATE_LIMITED", "Too many open AI tasks.", retryable=True)

    trace_id = request.state.trace_id
    task_id = f"tsk_{uuid.uuid4().hex}"
    plan_id = f"pln_{uuid.uuid4().hex}"
    version = body.config_version or config.CONFIG_VERSION

    await store.create({"task_id": task_id, "trace_id": trace_id, "plan_id": plan_id, "user_id": user["id"],
                        "status": "QUEUED", "config_version": version, "request": body.model_dump(mode="json")})
    env = create_envelope(
        event_type="ai.requests", trace_id=trace_id, actor_id=user["id"], actor_type=user["role"],
        entity_type="ai_task", entity_id=task_id, idempotency_key=task_id,
        payload={"task_id": task_id, "plan_id": plan_id, "config_version": version, **body.model_dump(mode="json")},
    )
    try:
        await bus.publish("ai.requests", env)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(503, "DEPENDENCY_UNAVAILABLE", "Kafka is unavailable.", retryable=True) from exc

    return {"data": {"task_id": task_id, "trace_id": trace_id, "plan_id": plan_id, "status": "QUEUED",
                     "stream_url": f"/ai/tasks/{task_id}/stream"}, "trace_id": trace_id}


@app.get("/ai/tasks/{task_id}")
async def get_task(task_id: str, request: Request):
    task = await store.get(task_id)
    if not task:
        raise ApiError(404, "NOT_FOUND", "Task not found.")
    # TODO (slice 5): owner check; include plan steps, agents[], round, errors[]
    return {"data": {k: task[k] for k in ("task_id", "trace_id", "plan_id", "status", "created_at", "updated_at")},
            "trace_id": request.state.trace_id}


@app.get("/ai/results/{task_id}")
async def get_result(task_id: str):
    task = await store.get(task_id)
    if not task:
        raise ApiError(404, "NOT_FOUND", "Task not found.")
    if "result" not in task:
        raise ApiError(409, "NOT_READY", "The Chair has not published a result yet.", retryable=True)
    return {"data": task["result"]}


@app.post("/ai/tasks/{task_id}/approve")
async def approve(task_id: str):
    not_implemented("POST /ai/tasks/{task_id}/approve")


@app.get("/ai/tasks/{task_id}/debate")
async def debate(task_id: str):
    not_implemented("GET /ai/tasks/{task_id}/debate")


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
