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
    doc = {
        "status": "QUEUED", "round": None, "parsed_request": None, "plan": {"steps": [], "revisions": []},
        "agents": [{"name": a, "status": "pending", "published_at": None} for a in ANALYSIS_AGENTS],
        "errors": [], "deadlines": {}, "timings": {}, "retries": {}, "round1": None, "result": None,
        "started_at": None, "approval": None, "frames": [],
        **copy.deepcopy(task), "created_at": now, "updated_at": now,
    }
    doc["frames"] = [status_frame(doc["task_id"], doc["trace_id"], "QUEUED")]
    return doc


def status_frame(task_id: str, trace_id: str, status: str) -> dict:
    return {"key": f"status:{status}", "type": "status", "task_id": task_id, "trace_id": trace_id,
            "timestamp": utc_now_iso(), "status": status}


def new_message(*, trace_id, task_id, round_no, agent, payload, event_id=None, rejected=None) -> dict:
    return {"event_id": event_id or str(uuid.uuid4()), "trace_id": trace_id, "task_id": task_id,
            "round": round_no, "agent": agent, "payload": copy.deepcopy(payload), "rejected": rejected or [], "stored_at": utc_now_iso()}


_PROTECTED = {"_id", "task_id", "trace_id", "user_id", "status", "created_at", "frames"}


def _changes(fields: dict) -> dict:
    bad = _PROTECTED & fields.keys()
    if bad:
        raise ValueError(f"cannot overwrite {sorted(bad)}")
    return {**copy.deepcopy(fields), "updated_at": utc_now_iso()}


FIRST_VERSION = {"version_id": "matcher-v1", "parent_version": None, "description": "Initial weights", "status": "promoted"}


def promotion_changes(current: dict | None, target: dict) -> tuple[dict, dict]:
    """(fields for the promoted version, fields for the one it replaces). Going back to
    the current version's parent is a rollback; otherwise the old one stays a candidate."""
    rollback = bool(current) and current.get("parent_version") == target["version_id"]
    return {"status": "promoted"}, {"status": "rolled_back" if rollback else "candidate", "was_promoted": True}


class InMemoryTaskStore:
    def __init__(self):
        self.tasks: dict[str, dict] = {}
        self.messages: list[dict] = []
        self.feedback: dict[str, dict] = {}
        self.versions: dict[str, dict] = {"matcher-v1": dict(FIRST_VERSION)}

    async def save_feedback(self, doc: dict) -> dict:
        """Insert once per feedback_id; a repeat returns the stored one."""
        return copy.deepcopy(self.feedback.setdefault(doc["feedback_id"], copy.deepcopy(doc)))

    async def list_versions(self) -> list[dict]:
        return [copy.deepcopy(self.versions[k]) for k in sorted(self.versions)]

    async def get_version(self, version_id: str) -> dict | None:
        return copy.deepcopy(self.versions.get(version_id))

    async def current_version(self) -> dict | None:
        return next((copy.deepcopy(v) for v in self.versions.values() if v["status"] == "promoted"), None)

    async def promote(self, target: dict, current: dict | None, fields: dict) -> None:
        new, old = promotion_changes(current, target)
        self.versions[target["version_id"]].update(new, **fields)
        if current:
            self.versions[current["version_id"]].update(old)

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
        task["frames"].append(status_frame(task_id, task["trace_id"], to_status))
        return await self.get(task_id)

    async def add_frame(self, task_id: str, key: str, frame: dict) -> bool:
        """Append one stream frame, once per key."""
        task = self.tasks.get(task_id)
        if not task or any(f["key"] == key for f in task["frames"]):
            return False
        task["frames"].append({"key": key, "task_id": task_id, "trace_id": task["trace_id"],
                               "timestamp": utc_now_iso(), **copy.deepcopy(frame)})
        return True

    async def list_open(self) -> list[dict]:
        return [copy.deepcopy(t) for t in self.tasks.values() if t["status"] in OPEN_STATUSES]

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
        await self.db.feedback.create_index("feedback_id", unique=True, sparse=True)
        # Seeded by 001_init.js on a new volume; make sure it exists on an old one too.
        await self.db.agent_versions.create_index("version_id", unique=True)
        await self.db.agent_versions.update_one({"version_id": FIRST_VERSION["version_id"]}, {"$setOnInsert": dict(FIRST_VERSION)}, upsert=True)

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
        changes = {**_changes(fields or {}), "status": to_status}
        task = await self.db.ai_tasks.find_one({"task_id": task_id}, {"trace_id": 1})
        if not task:
            return None
        return await self.db.ai_tasks.find_one_and_update(
            {"task_id": task_id, "status": {"$in": allowed_from(to_status)}},
            {"$set": changes, "$push": {"frames": status_frame(task_id, task["trace_id"], to_status)}},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER)

    async def add_frame(self, task_id: str, key: str, frame: dict) -> bool:
        task = await self.db.ai_tasks.find_one({"task_id": task_id}, {"trace_id": 1})
        if not task:
            return False
        doc = {"key": key, "task_id": task_id, "trace_id": task["trace_id"], "timestamp": utc_now_iso(), **frame}
        done = await self.db.ai_tasks.update_one({"task_id": task_id, "frames.key": {"$ne": key}}, {"$push": {"frames": doc}})
        return done.modified_count == 1

    async def list_open(self) -> list[dict]:
        return await self.db.ai_tasks.find({"status": {"$in": OPEN_STATUSES}}, {"_id": 0, "frames": 0}).to_list(None)

    async def add_message(self, **kw) -> bool:
        try:
            await self.db.debate_messages.insert_one(new_message(**kw))
            return True
        except DuplicateKeyError:
            return False

    async def list_messages(self, trace_id: str) -> list[dict]:
        cursor = self.db.debate_messages.find({"trace_id": trace_id}, {"_id": 0})
        return await cursor.sort([("round", ASCENDING), ("stored_at", ASCENDING), ("_id", ASCENDING)]).to_list(None)

    async def save_feedback(self, doc: dict) -> dict:
        try:
            await self.db.feedback.insert_one(dict(doc))
            return doc
        except DuplicateKeyError:
            return await self.db.feedback.find_one({"feedback_id": doc["feedback_id"]}, {"_id": 0})

    async def list_versions(self) -> list[dict]:
        return await self.db.agent_versions.find({}, {"_id": 0}).sort("version_id", ASCENDING).to_list(None)

    async def get_version(self, version_id: str) -> dict | None:
        return await self.db.agent_versions.find_one({"version_id": version_id}, {"_id": 0})

    async def current_version(self) -> dict | None:
        return await self.db.agent_versions.find_one({"status": "promoted"}, {"_id": 0}, sort=[("promoted_at", DESCENDING)])

    async def promote(self, target: dict, current: dict | None, fields: dict) -> None:
        # New one first: if the second write is lost, current_version() still picks the newest.
        new, old = promotion_changes(current, target)
        await self.db.agent_versions.update_one({"version_id": target["version_id"]}, {"$set": {**new, **fields}})
        await self.db.agent_versions.update_many({"status": "promoted", "version_id": {"$ne": target["version_id"]}}, {"$set": old})
