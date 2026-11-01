"""Task store. In-memory implementation so the API runs and tests pass without
Mongo. TODO (slice 5): MongoTaskStore over ai_tasks / debate_messages (motor)."""
from datetime import datetime, timezone


class InMemoryTaskStore:
    def __init__(self):
        self.tasks: dict[str, dict] = {}

    async def create(self, task: dict) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        task = {**task, "created_at": now, "updated_at": now}
        self.tasks[task["task_id"]] = task
        return task

    async def get(self, task_id: str) -> dict | None:
        return self.tasks.get(task_id)

    async def count_open_for_user(self, user_id: str) -> int:
        closed = {"APPROVED", "EDITED", "REJECTED", "FAILED", "TIMED_OUT"}
        return sum(1 for t in self.tasks.values() if t["user_id"] == user_id and t["status"] not in closed)
