"""AI Agent Service API (API doc §9). Owner: Slice 5.

POST /ai/requests is implemented as the reference: create task_id/trace_id/plan_id,
publish to ai.requests, return 202. Agents and the Chair are separate Kafka
consumers (agents/), never called over HTTP from here."""
import hashlib
import json
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import FastAPI, Header, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints, model_validator
from pymongo.errors import PyMongoError
from starlette.exceptions import HTTPException

from . import config
from .bus import Bus
from .envelope import create_envelope, utc_now_iso
from .pool import load_pool
from .store import OPEN_STATUSES, DuplicateTrace, InMemoryTaskStore, MongoTaskStore
from .stream import install_log_redaction, serve

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


class ApproveRequest(BaseModel):
    model_config = {"extra": "forbid"}
    decision: Literal["approved", "edited", "rejected"]
    edited_property_id: str | None = Field(default=None, min_length=1, max_length=40)
    reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def check(self):
        if self.decision == "edited" and not self.edited_property_id:
            raise ValueError("edited_property_id is required when decision is edited")
        if self.decision != "edited" and self.edited_property_id:
            raise ValueError("edited_property_id is only allowed when decision is edited")
        if self.edited_property_id and self.edited_property_id not in load_pool().ids:
            raise ValueError("edited_property_id is not in the property pool")
        return self


class FeedbackRequest(BaseModel):
    model_config = {"extra": "forbid"}
    task_id: str = Field(min_length=1, max_length=60)
    label: Literal["correct", "incorrect"]
    note: str | None = Field(default=None, max_length=1000)


class PromoteRequest(BaseModel):
    model_config = {"extra": "forbid"}
    reviewer_id: str = Field(min_length=1, max_length=60)


bus = Bus()
store = MongoTaskStore(config.MONGO_URL, config.MONGO_DB) if config.MONGO_ENABLED else InMemoryTaskStore()


@asynccontextmanager
async def lifespan(_app):
    install_log_redaction()
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


async def _expire(task: dict) -> dict:
    """Backstop for when the Chair itself is down: an overdue task is closed on read,
    so it can never stay open forever."""
    limit = datetime.now(timezone.utc) - timedelta(seconds=config.TASK_DEADLINE_S + 5)
    created = datetime.fromisoformat(task["created_at"].replace("Z", "+00:00"))
    if task["status"] not in OPEN_STATUSES or created > limit:
        return task
    errors = [*task["errors"], {"code": "TASK_DEADLINE", "message": "The debate did not finish in time."}]
    return await store.transition(task["task_id"], "TIMED_OUT", {"errors": errors}) or await store.get(task["task_id"])


async def _owned_task(task_id: str, x_user_id: str | None, x_user_role: str | None) -> dict:
    """Load a task for its owner or an admin: 401, then 404, then 403 (API doc §9)."""
    user = _user(x_user_id, x_user_role)
    task = await store.get(task_id)
    if not task:
        raise ApiError(404, "NOT_FOUND", "Task not found.")
    if user["role"] != "admin" and task["user_id"] != user["id"]:
        raise ApiError(403, "FORBIDDEN", "Not allowed.")
    return await _expire(task)


def _is_uuid(value: str | None) -> bool:
    try:
        return str(uuid.UUID(value or "")) == value.lower()
    except ValueError:
        return False


def _require_uuid_trace(trace_id: str):
    if not _is_uuid(trace_id):
        raise ApiError(400, "VALIDATION_ERROR", "Request is invalid.",
                       [{"field": "X-Trace-Id", "issue": "must be a UUID"}])


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
        for task in await store.list_open():
            if task["user_id"] == user["id"]:
                await _expire(task)
    if await store.count_open_for_user(user["id"]) >= config.MAX_OPEN_TASKS_PER_USER:
        raise ApiError(429, "RATE_LIMITED", "Too many open AI tasks.", retryable=True)

    task_id = f"tsk_{uuid.uuid4().hex}"
    plan_id = f"pln_{uuid.uuid4().hex}"
    if body.config_version and not await store.get_version(body.config_version):
        raise ApiError(400, "VALIDATION_ERROR", "Request body is invalid.", [{"field": "config_version", "issue": "unknown version"}])
    current = await store.current_version()
    version = body.config_version or (current["version_id"] if current else config.CONFIG_VERSION)

    try:
        await store.create({"task_id": task_id, "trace_id": trace_id, "plan_id": plan_id, "user_id": user["id"],
                            "config_version": version, "request": body.model_dump(mode="json")})
    except DuplicateTrace as exc:
        raise ApiError(400, "VALIDATION_ERROR", "Request is invalid.",
                       [{"field": "X-Trace-Id", "issue": "already used by another AI task"}]) from exc
    env = create_envelope(
        event_type="ai.requests", trace_id=trace_id, actor_id=user["id"], actor_type=user["role"],
        entity_type="ai_task", entity_id=task_id, idempotency_key=task_id,
        payload={**body.model_dump(mode="json"), "task_id": task_id, "plan_id": plan_id, "config_version": version},
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
async def approve(task_id: str, body: ApproveRequest, request: Request,
                  x_user_id: str | None = Header(default=None),
                  x_user_role: str | None = Header(default=None),
                  idempotency_key: str | None = Header(default=None)):
    """Human checkpoint. Order: decide (compare-and-set) -> feedback -> ai.approvals.
    If a later step fails the caller gets 503 and the same key finishes the job."""
    task = await _owned_task(task_id, x_user_id, x_user_role)
    if task["user_id"] != x_user_id:  # admins may look, but only the owner decides (§9)
        raise ApiError(403, "FORBIDDEN", "Only the task owner can decide.")
    if not _is_uuid(idempotency_key):
        raise ApiError(400, "VALIDATION_ERROR", "Request is invalid.",
                       [{"field": "Idempotency-Key", "issue": "header is required and must be a UUID"}])
    digest = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True).encode()).hexdigest()
    key = idempotency_key.lower()

    if task["status"] == "AWAITING_APPROVAL":
        recommended = task["result"]["recommended"]["property_id"]
        chosen = {"approved": recommended, "edited": body.edited_property_id, "rejected": None}[body.decision]
        decision = {"decision": body.decision, "edited_property_id": body.edited_property_id, "reason": body.reason,
                    "reviewer_id": x_user_id, "chosen": chosen, "decided_at": utc_now_iso()}
        # Loses the race (None) if another request decided first; read what that one stored.
        task = await store.transition(task_id, body.decision.upper(), {
            "approval": {**decision, "recommended": recommended, "idempotency_key": key, "body_hash": digest, "published": False},
            "result": {**task["result"], "human_decision": decision}}) or await store.get(task_id)

    done = task["approval"]
    if not done or done["idempotency_key"] != key:
        raise ApiError(409, "INVALID_STATE_TRANSITION", "Task is not awaiting approval.")
    if done["body_hash"] != digest:
        raise ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used with a different body.")

    if not done["published"]:
        await store.save_feedback({
            "feedback_id": f"fbk_{task_id}_approval", "kind": "approval", "trace_id": task["trace_id"], "task_id": task_id,
            "recommendation": done["recommended"], "human_decision": done["decision"], "chosen": done["chosen"],
            "reason": done["reason"], "user_id": x_user_id, "created_at": done["decided_at"]})
        env = create_envelope(
            event_type="ai.approvals", trace_id=task["trace_id"], actor_id=x_user_id, actor_type=x_user_role,
            entity_type="ai_task", entity_id=task_id, idempotency_key=f"{task_id}:approval",
            payload={"task_id": task_id, "plan_id": task["plan_id"], "user_id": task["user_id"], "config_version": task["config_version"],
                     **{k: done[k] for k in ("decision", "edited_property_id", "reason", "reviewer_id", "recommended", "chosen")}})
        try:
            await bus.publish("ai.approvals", env)
        except Exception as exc:  # noqa: BLE001
            raise ApiError(503, "DEPENDENCY_UNAVAILABLE", "Kafka is unavailable. Retry with the same Idempotency-Key.", retryable=True) from exc
        await store.update(task_id, {"approval": {**done, "published": True}})
    return {"data": {"task_id": task_id, "status": task["status"], "recommended": done["recommended"], "chosen": done["chosen"]},
            "trace_id": request.state.trace_id}


@app.get("/ai/tasks/{task_id}/debate")
async def debate(task_id: str, request: Request,
                 x_user_id: str | None = Header(default=None),
                 x_user_role: str | None = Header(default=None)):
    task = await _owned_task(task_id, x_user_id, x_user_role)
    messages = await store.list_messages(task["trace_id"])
    return {"data": {"trace_id": task["trace_id"],
                     "messages": [{k: m[k] for k in ("round", "agent", "event_id", "payload")} for m in messages]},
            "trace_id": request.state.trace_id}


@app.post("/ai/feedback", status_code=201)
async def feedback(body: FeedbackRequest, request: Request,
                   x_user_id: str | None = Header(default=None),
                   x_user_role: str | None = Header(default=None)):
    task = await _owned_task(body.task_id, x_user_id, x_user_role)
    result = task["result"] or {}
    doc = await store.save_feedback({
        "feedback_id": f"fbk_{uuid.uuid4().hex}", "kind": "label", "trace_id": task["trace_id"], "task_id": task["task_id"],
        "label": body.label, "note": body.note, "recommendation": (result.get("recommended") or {}).get("property_id"),
        "human_decision": (task["approval"] or {}).get("decision"), "user_id": x_user_id, "created_at": utc_now_iso()})
    return {"data": {k: doc[k] for k in ("feedback_id", "trace_id", "label")}, "trace_id": request.state.trace_id}


VERSION_FIELDS = ("version_id", "parent_version", "description", "status", "eval_run_id", "precision_at_10", "recall_at_10",
                  "mean_rank", "approval_rate", "approved_by")


@app.get("/ai/versions")
async def versions(request: Request, x_user_id: str | None = Header(default=None), x_user_role: str | None = Header(default=None)):
    _user(x_user_id, x_user_role, "admin")
    items = [{k: v[k] for k in VERSION_FIELDS if v.get(k) is not None} for v in await store.list_versions()]
    return {"data": {"items": items}, "trace_id": request.state.trace_id}


@app.post("/ai/versions/{version_id}/promote")
async def promote(version_id: str, body: PromoteRequest, request: Request,
                  x_user_id: str | None = Header(default=None), x_user_role: str | None = Header(default=None)):
    """Manual admin call; agents can never promote. A version needs an evaluation run
    newer than its last change, unless it was promoted before (rollback)."""
    _user(x_user_id, x_user_role, "admin")
    target = await store.get_version(version_id)
    if not target:
        raise ApiError(404, "NOT_FOUND", "Version not found.")
    if target["status"] == "promoted":
        raise ApiError(409, "INVALID_STATE_TRANSITION", "This version is already promoted.")
    evaluated = bool(target.get("eval_run_id") and target.get("evaluated_at")
                     and target["evaluated_at"] > (target.get("changed_at") or ""))
    if not evaluated and not target.get("was_promoted"):
        raise ApiError(409, "INVALID_STATE_TRANSITION", "Run the evaluation before promoting.")
    current = await store.current_version()
    await store.promote(target, current, {"approved_by": body.reviewer_id, "promoted_by": x_user_id, "promoted_at": utc_now_iso()})
    return {"data": {"version_id": version_id, "status": "promoted", "previous": current["version_id"] if current else None,
                     "approved_by": body.reviewer_id}, "trace_id": request.state.trace_id}


# The second path is what arrives through the gateway today: it does not strip
# /api/v1/ai from WebSocket upgrades. Drop it once the gateway does.
@app.websocket("/ai/tasks/{task_id}/stream")
@app.websocket("/api/v1/ai/ai/tasks/{task_id}/stream")
async def stream(ws: WebSocket, task_id: str):
    await serve(ws, task_id, store, _expire)
