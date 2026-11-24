"""Both stores must behave the same. The Mongo half runs only when TEST_MONGO_URL
is set (docker compose: mongodb://localhost:27018) and uses its own throwaway database."""
import asyncio
import os
import uuid

import pytest

from app.store import DuplicateTrace, InMemoryTaskStore, MongoTaskStore

MONGO = os.getenv("TEST_MONGO_URL")


@pytest.fixture(params=["memory", pytest.param("mongo", marks=pytest.mark.skipif(not MONGO, reason="TEST_MONGO_URL not set"))])
def run(request):
    """run(test) calls `await test(store)` with a clean store."""
    def runner(test):
        async def go():
            store = InMemoryTaskStore() if request.param == "memory" else MongoTaskStore(MONGO, f"ai_test_{uuid.uuid4().hex}")
            await store.start()
            try:
                await test(store)
            finally:
                if request.param == "mongo":
                    await store.client.drop_database(store.db_name)
                await store.stop()
        asyncio.run(go())
    return runner


def task(**over):
    return {"task_id": f"tsk_{uuid.uuid4().hex}", "trace_id": str(uuid.uuid4()), "plan_id": "pln_1", "user_id": "gst_1",
            "config_version": "matcher-v1", "request": {"request_text": "beach house"}, **over}


def test_create_and_read_back(run):
    async def t(s):
        created = await s.create(task())
        got = await s.get(created["task_id"])
        assert got == created == await s.get_by_trace(created["trace_id"])
        assert got["status"] == "QUEUED" and got["created_at"].endswith("Z") and "_id" not in got
        assert await s.get("tsk_missing") is None
    run(t)


def test_trace_id_is_unique(run):
    async def t(s):
        first = await s.create(task())
        with pytest.raises(DuplicateTrace):
            await s.create(task(trace_id=first["trace_id"]))
    run(t)


def test_transitions_only_move_forward(run):
    async def t(s):
        tid = (await s.create(task()))["task_id"]
        assert (await s.transition(tid, "ROUND_0", {"round": 0}))["round"] == 0
        assert await s.transition(tid, "PLANNING") is None
        assert await s.transition(tid, "ROUND_0") is None
        assert await s.transition(tid, "APPROVED") is None
        await s.transition(tid, "AWAITING_APPROVAL")
        assert await s.transition(tid, "TIMED_OUT") is None
        assert (await s.transition(tid, "APPROVED"))["status"] == "APPROVED"
        assert await s.transition(tid, "REJECTED") is None
        assert await s.transition("tsk_missing", "PLANNING") is None
    run(t)


def test_concurrent_transition_has_one_winner(run):
    async def t(s):
        tid = (await s.create(task()))["task_id"]
        await s.transition(tid, "AWAITING_APPROVAL")
        done = await asyncio.gather(*(s.transition(tid, d) for d in ["APPROVED", "REJECTED", "EDITED"] * 4))
        assert sum(d is not None for d in done) == 1
    run(t)


def test_open_count_ignores_other_users_and_finished_tasks(run):
    async def t(s):
        ids = [(await s.create(task()))["task_id"] for _ in range(3)]
        await s.create(task(user_id="gst_2"))
        assert await s.count_open_for_user("gst_1") == 3
        await s.transition(ids[0], "AWAITING_APPROVAL")
        await s.transition(ids[1], "TIMED_OUT")
        assert await s.count_open_for_user("gst_1") == 1
    run(t)


def test_update_cannot_change_identity_or_status(run):
    async def t(s):
        tid = (await s.create(task()))["task_id"]
        assert (await s.update(tid, {"parsed_request": {"city": "Napa"}}))["parsed_request"] == {"city": "Napa"}
        for field in ("status", "user_id", "trace_id"):
            with pytest.raises(ValueError):
                await s.update(tid, {field: "x"})
    run(t)


def test_messages_are_deduped_ordered_and_isolated_by_trace(run):
    async def t(s):
        a, b = str(uuid.uuid4()), str(uuid.uuid4())
        ev = str(uuid.uuid4())
        assert await s.add_message(trace_id=a, task_id="tsk_a", round_no=2, agent="risk", payload={})
        assert await s.add_message(trace_id=a, task_id="tsk_a", round_no=0, agent="risk", payload={"n": 1}, event_id=ev)
        assert not await s.add_message(trace_id=a, task_id="tsk_a", round_no=0, agent="risk", payload={"n": 2}, event_id=ev)
        await s.add_message(trace_id=b, task_id="tsk_b", round_no=0, agent="risk", payload={})
        msgs = await s.list_messages(a)
        assert [m["round"] for m in msgs] == [0, 2] and msgs[0]["payload"] == {"n": 1}
        assert len(await s.list_messages(b)) == 1
    run(t)


def test_frames_are_appended_once_per_key(run):
    async def t(s):
        tid = (await s.create(task()))["task_id"]
        assert await s.add_frame(tid, "plan", {"type": "plan.created"})
        assert not await s.add_frame(tid, "plan", {"type": "plan.created"})
        assert not await s.add_frame("tsk_missing", "plan", {})
        await s.transition(tid, "PLANNING")
        assert [f["type"] for f in (await s.get(tid))["frames"]] == ["status", "plan.created", "status"]
    run(t)


def test_feedback_is_stored_once(run):
    async def t(s):
        first = await s.save_feedback({"feedback_id": "fbk_1", "label": "correct"})
        assert await s.save_feedback({"feedback_id": "fbk_1", "label": "incorrect"}) == first
    run(t)


def test_version_promotion(run):
    async def t(s):
        assert (await s.current_version())["version_id"] == "matcher-v1"
        if isinstance(s, InMemoryTaskStore):
            s.versions["v2"] = {"version_id": "v2", "parent_version": "matcher-v1", "status": "candidate"}
        else:
            await s.db.agent_versions.insert_one({"version_id": "v2", "parent_version": "matcher-v1", "status": "candidate"})
        await s.promote(await s.get_version("v2"), await s.current_version(), {"promoted_at": "2026-11-24T00:00:00Z"})
        assert (await s.current_version())["version_id"] == "v2"
        assert [v["status"] for v in await s.list_versions()] == ["candidate", "promoted"]
        await s.promote(await s.get_version("matcher-v1"), await s.current_version(), {"promoted_at": "2026-11-25T00:00:00Z"})
        assert [v["status"] for v in await s.list_versions()] == ["promoted", "rolled_back"]
        assert await s.get_version("nope") is None
    run(t)
