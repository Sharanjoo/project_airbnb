"""Task store (API doc §9, §11). Two implementations with the same interface:

  MongoTaskStore     ai_tasks + debate_messages (the default)
  InMemoryTaskStore  offline tests, MONGO_ENABLED=false

Status changes go through transition(), a compare-and-set that only moves a task
forward, so a late or duplicate event can never reopen a finished task."""
import copy
import uuid

from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from .envelope import utc_now_iso

# API doc §9, in workflow order.
WORKFLOW = ["QUEUED", "PLANNING", "ROUND_0", "ROUND_1", "ROUND_2", "DECIDING", "AWAITING_APPROVAL"]
FAILURES = {"FAILED", "TIMED_OUT"}
DECISIONS = {"APPROVED", "EDITED", "REJECTED"}
# Tasks the agents are still working on. AWAITING_APPROVAL is not counted: the
# debate is over, so an unanswered result must not block a user's next request.
OPEN_STATUSES = WORKFLOW[:-1]
ANALYSIS_AGENTS = ("matching", "risk", "fairness")


class DuplicateTrace(Exception):
    """Another task already uses this trace_id."""


def allowed_from(to_status: str) -> list[str]:
    """Statuses a task may be in just before it becomes to_status."""
    if to_status in FAILURES:
        return list(OPEN_STATUSES)
    if to_status in DECISIONS:
        return ["AWAITING_APPROVAL"]
    return WORKFLOW[:WORKFLOW.index(to_status)]


def new_task(task: dict) -> dict:
    now = utc_now_iso()
    return {
        "status": "QUEUED", "round": None, "parsed_request": None, "plan": {"steps": [], "revisions": []},
        "agents": [{"name": a, "status": "pending", "published_at": None} for a in ANALYSIS_AGENTS],
        "errors": [], "deadlines": {}, "started_at": None, "approval": None,
        **copy.deepcopy(task), "created_at": now, "updated_at": now,
    }


def new_message(*, trace_id, task_id, round_no, agent, payload, event_id=None) -> dict:
    return {"event_id": event_id or str(uuid.uuid4()), "trace_id": trace_id, "task_id": task_id,
            "round": round_no, "agent": agent, "payload": copy.deepcopy(payload), "stored_at": utc_now_iso()}


_PROTECTED = {"_id", "task_id", "trace_id", "user_id", "status", "created_at"}


def _changes(fields: dict) -> dict:
    bad = _PROTECTED & fields.keys()
    if bad:
        raise ValueError(f"cannot overwrite {sorted(bad)}")
    return {**copy.deepcopy(fields), "updated_at": utc_now_iso()}


class InMemoryTaskStore:
    def __init__(self):
        self.tasks: dict[str, dict] = {}
        self.messages: list[dict] = []

    async def start(self):
        pass

    async def stop(self):
        pass

    async def create(self, task: dict) -> dict:
        if await self.get_by_trace(task["trace_id"]):
            raise DuplicateTrace(task["trace_id"])
        doc = new_task(task)
        self.tasks[doc["task_id"]] = doc
        return copy.deepcopy(doc)

    async def get(self, task_id: str) -> dict | None:
        return copy.deepcopy(self.tasks.get(task_id))

    async def get_by_trace(self, trace_id: str) -> dict | None:
        return next((copy.deepcopy(t) for t in self.tasks.values() if t["trace_id"] == trace_id), None)

    async def count_open_for_user(self, user_id: str) -> int:
        return sum(t["user_id"] == user_id and t["status"] in OPEN_STATUSES for t in self.tasks.values())

    async def update(self, task_id: str, fields: dict) -> dict | None:
        changes = _changes(fields)
        if task_id not in self.tasks:
            return None
        self.tasks[task_id].update(changes)
        return await self.get(task_id)

    async def transition(self, task_id: str, to_status: str, fields: dict | None = None) -> dict | None:
        """Returns the updated task, or None when the move is not allowed."""
        changes = _changes(fields or {})
        task = self.tasks.get(task_id)
        if not task or task["status"] not in allowed_from(to_status):
            return None
        task.update(changes, status=to_status)
        return await self.get(task_id)

    async def add_message(self, **kw) -> bool:
        """Store a round message once. False means this event_id was already stored."""
        doc = new_message(**kw)
        if any(m["event_id"] == doc["event_id"] for m in self.messages):
            return False
        self.messages.append(doc)
        return True

    async def list_messages(self, trace_id: str) -> list[dict]:
        found = [m for m in self.messages if m["trace_id"] == trace_id]
        return copy.deepcopy(sorted(found, key=lambda m: (m["round"], m["stored_at"])))


class MongoTaskStore:
    def __init__(self, url: str, db_name: str, timeout_ms: int = 2000):
        self.url, self.db_name, self.timeout_ms = url, db_name, timeout_ms
        self.client = None
        self.db = None

    async def start(self):
        from motor.motor_asyncio import AsyncIOMotorClient
        self.client = AsyncIOMotorClient(self.url, serverSelectionTimeoutMS=self.timeout_ms,
                                         connectTimeoutMS=self.timeout_ms, socketTimeoutMS=self.timeout_ms)
        self.db = self.client[self.db_name]
        # Same indexes as infra/mongo/init/001_init.js, so volumes created before
        # this code also have them, plus one for the open-task count.
        await self.db.ai_tasks.create_index("task_id", unique=True)
        await self.db.ai_tasks.create_index("trace_id", unique=True)
        await self.db.ai_tasks.create_index([("status", ASCENDING), ("updated_at", DESCENDING)])
        await self.db.ai_tasks.create_index([("user_id", ASCENDING), ("status", ASCENDING)])
        await self.db.debate_messages.create_index([("trace_id", ASCENDING), ("round", ASCENDING), ("agent", ASCENDING)])
        await self.db.debate_messages.create_index("event_id", unique=True)

    async def stop(self):
        if self.client:
            self.client.close()

    async def create(self, task: dict) -> dict:
        doc = new_task(task)
        try:
            await self.db.ai_tasks.insert_one(dict(doc))
        except DuplicateKeyError as exc:
            raise DuplicateTrace(task["trace_id"]) from exc
        return doc

    async def get(self, task_id: str) -> dict | None:
        return await self.db.ai_tasks.find_one({"task_id": task_id}, {"_id": 0})

    async def get_by_trace(self, trace_id: str) -> dict | None:
        return await self.db.ai_tasks.find_one({"trace_id": trace_id}, {"_id": 0})

    async def count_open_for_user(self, user_id: str) -> int:
        return await self.db.ai_tasks.count_documents({"user_id": user_id, "status": {"$in": OPEN_STATUSES}})

    async def _set(self, query: dict, changes: dict) -> dict | None:
        return await self.db.ai_tasks.find_one_and_update(
            query, {"$set": changes}, projection={"_id": 0}, return_document=ReturnDocument.AFTER)

    async def update(self, task_id: str, fields: dict) -> dict | None:
        return await self._set({"task_id": task_id}, _changes(fields))

    async def transition(self, task_id: str, to_status: str, fields: dict | None = None) -> dict | None:
        return await self._set({"task_id": task_id, "status": {"$in": allowed_from(to_status)}},
                               {**_changes(fields or {}), "status": to_status})

    async def add_message(self, **kw) -> bool:
        try:
            await self.db.debate_messages.insert_one(new_message(**kw))
            return True
        except DuplicateKeyError:
            return False

    async def list_messages(self, trace_id: str) -> list[dict]:
        cursor = self.db.debate_messages.find({"trace_id": trace_id}, {"_id": 0})
        return await cursor.sort([("round", ASCENDING), ("stored_at", ASCENDING), ("_id", ASCENDING)]).to_list(None)
