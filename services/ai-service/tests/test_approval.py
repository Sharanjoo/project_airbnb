import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient

from app.envelope import validate_envelope
from app.main import app, bus, store
from app.pool import load_pool
from app.store import FIRST_VERSION

OWNER = {"X-User-Id": "gst_0001", "X-User-Role": "guest"}
OTHER = {"X-User-Id": "gst_0002", "X-User-Role": "guest"}
ADMIN = {"X-User-Id": "hst_admin_01", "X-User-Role": "admin"}
A, B = sorted(load_pool().ids)[:2]


@pytest.fixture
def c():
    bus.sent.clear(), store.tasks.clear(), store.messages.clear(), store.feedback.clear()
    store.versions = {"matcher-v1": dict(FIRST_VERSION)}
    with TestClient(app) as client:
        yield client


@pytest.fixture
def tid(c):
    t = c.post("/ai/requests", headers=OWNER, json={"request_text": "beach house"}).json()["data"]["task_id"]
    asyncio.run(store.transition(t, "AWAITING_APPROVAL", {"result": {"recommended": {"property_id": A, "score": .8}, "human_decision": None}}))
    bus.sent.clear()
    return t


def approve(c, tid, body, key=None, headers=OWNER):
    h = {**headers, "Idempotency-Key": key if key is not None else str(uuid.uuid4())}
    return c.post(f"/ai/tasks/{tid}/approve", headers=h, json=body)


def code(r):
    return r.status_code, r.json()["error"]["code"]


@pytest.mark.parametrize("body,status,chosen", [
    ({"decision": "approved"}, "APPROVED", A), ({"decision": "edited", "edited_property_id": B, "reason": "closer"}, "EDITED", B),
    ({"decision": "rejected", "reason": "too far"}, "REJECTED", None)])
def test_decisions(c, tid, body, status, chosen):
    r = approve(c, tid, body)
    assert r.status_code == 200 and r.json()["data"] == {"task_id": tid, "status": status, "recommended": A, "chosen": chosen}
    (topic, env), = bus.sent
    assert topic == "ai.approvals" and validate_envelope(env, topic) == []
    p = env["payload"]
    assert p["decision"] == body["decision"] and p["user_id"] == p["reviewer_id"] == "gst_0001" and p["chosen"] == chosen
    assert {"task_id", "edited_property_id", "reason"} <= p.keys() and env["trace_id"] == store.tasks[tid]["trace_id"]
    fb, = store.feedback.values()
    assert fb["trace_id"] == env["trace_id"] and fb["human_decision"] == body["decision"]
    result = c.get(f"/ai/results/{tid}", headers=OWNER).json()["data"]
    assert result["human_decision"]["decision"] == body["decision"] and result["human_decision"]["chosen"] == chosen
    assert result["recommended"]["property_id"] == A  # the AI's own answer is never overwritten


def test_same_key_replays_without_a_second_event(c, tid):
    key = str(uuid.uuid4())
    first, again = approve(c, tid, {"decision": "approved"}, key), approve(c, tid, {"decision": "approved"}, key.upper())
    assert first.json()["data"] == again.json()["data"] and len(bus.sent) == 1 and len(store.feedback) == 1


def test_same_key_other_body_and_second_decision_conflict(c, tid):
    key = str(uuid.uuid4())
    approve(c, tid, {"decision": "approved"}, key)
    assert code(approve(c, tid, {"decision": "rejected"}, key)) == (409, "IDEMPOTENCY_KEY_REUSED")
    assert code(approve(c, tid, {"decision": "rejected"})) == (409, "INVALID_STATE_TRANSITION")
    assert store.tasks[tid]["status"] == "APPROVED" and len(bus.sent) == 1


def test_not_ready_or_failed_task_conflicts(c):
    t = c.post("/ai/requests", headers=OWNER, json={"request_text": "beach house"}).json()["data"]["task_id"]
    assert code(approve(c, t, {"decision": "approved"})) == (409, "INVALID_STATE_TRANSITION")
    asyncio.run(store.transition(t, "TIMED_OUT"))
    assert code(approve(c, t, {"decision": "approved"})) == (409, "INVALID_STATE_TRANSITION")


def test_only_the_owner_decides(c, tid):
    body = {"decision": "approved"}
    assert code(approve(c, tid, body, headers=OTHER)) == code(approve(c, tid, body, headers=ADMIN)) == (403, "FORBIDDEN")
    assert code(approve(c, tid, body, headers={})) == (401, "UNAUTHENTICATED")
    assert code(approve(c, "tsk_nope", body)) == (404, "NOT_FOUND")


@pytest.mark.parametrize("body", [
    {}, {"decision": "maybe"}, {"decision": "edited"}, {"decision": "approved", "edited_property_id": B},
    {"decision": "edited", "edited_property_id": "prp_nope"}, {"decision": "approved", "hack": 1}, {"decision": "rejected", "reason": "x" * 501}])
def test_invalid_bodies(c, tid, body):
    assert code(approve(c, tid, body)) == (400, "VALIDATION_ERROR")
    assert store.tasks[tid]["status"] == "AWAITING_APPROVAL"


@pytest.mark.parametrize("key", ["", "abc"])
def test_idempotency_key_is_required(c, tid, key):
    assert code(approve(c, tid, {"decision": "approved"}, key)) == (400, "VALIDATION_ERROR")
    assert c.post(f"/ai/tasks/{tid}/approve", headers=OWNER, json={"decision": "approved"}).status_code == 400


def test_kafka_outage_then_retry_with_the_same_key(c, tid, monkeypatch):
    key, body, real = str(uuid.uuid4()), {"decision": "approved"}, bus.publish

    async def down(*_):
        raise TimeoutError
    monkeypatch.setattr(bus, "publish", down)
    r = approve(c, tid, body, key)
    assert r.status_code == 503 and r.json()["error"]["retryable"]
    monkeypatch.setattr(bus, "publish", real)
    assert approve(c, tid, body, key).status_code == 200
    assert len(bus.sent) == 1 and len(store.feedback) == 1


def test_racing_decisions_have_one_winner(c, tid):
    from httpx import ASGITransport, AsyncClient

    async def go():
        async with AsyncClient(transport=ASGITransport(app), base_url="http://t") as h:
            return await asyncio.gather(*(h.post(f"/ai/tasks/{tid}/approve", headers={**OWNER, "Idempotency-Key": str(uuid.uuid4())},
                                                 json={"decision": d}) for d in ("approved", "rejected") * 5))
    got = [r.status_code for r in asyncio.run(go())]
    assert got.count(200) == 1 and got.count(409) == 9 and len(bus.sent) == 1


def test_feedback(c, tid):
    body = {"task_id": tid, "label": "incorrect", "note": "wrong area"}
    r = c.post("/ai/feedback", headers=ADMIN, json=body)
    assert r.status_code == 201 and r.json()["data"]["trace_id"] == store.tasks[tid]["trace_id"] and r.json()["data"]["label"] == "incorrect"
    assert store.feedback[r.json()["data"]["feedback_id"]]["recommendation"] == A
    assert c.post("/ai/feedback", headers=OWNER, json=body).status_code == 201
    assert c.post("/ai/feedback", headers=OTHER, json=body).status_code == 403
    assert c.post("/ai/feedback", headers=OWNER, json={**body, "task_id": "tsk_nope"}).status_code == 404
    for bad in ({**body, "label": "meh"}, {**body, "x": 1}, {"task_id": tid}):
        assert c.post("/ai/feedback", headers=OWNER, json=bad).status_code == 400


def promote(c, v, headers=ADMIN, body=None):
    return c.post(f"/ai/versions/{v}/promote", headers=headers, json=body or {"reviewer_id": "hst_admin_01"})


def test_versions_are_admin_only(c):
    assert c.get("/ai/versions", headers=ADMIN).json()["data"]["items"][0]["version_id"] == "matcher-v1"
    assert c.get("/ai/versions", headers=OWNER).status_code == promote(c, "matcher-v1", OWNER).status_code == 403
    assert c.get("/ai/versions").status_code == 401


def test_promotion_needs_a_fresh_evaluation_and_can_roll_back(c):
    v2 = store.versions["matcher-v2"] = {"version_id": "matcher-v2", "parent_version": "matcher-v1", "description": "d", "status": "candidate",
                                         "changed_at": "2026-11-02T00:00:00Z"}
    assert code(promote(c, "matcher-v2")) == (409, "INVALID_STATE_TRANSITION")
    v2.update(eval_run_id="eval_1", evaluated_at="2026-11-01T00:00:00Z")  # older than the change
    assert promote(c, "matcher-v2").status_code == 409
    v2["evaluated_at"] = "2026-11-03T00:00:00Z"
    assert promote(c, "matcher-v2").json()["data"] == {"version_id": "matcher-v2", "status": "promoted", "previous": "matcher-v1", "approved_by": "hst_admin_01"}
    c.post("/ai/requests", headers=OWNER, json={"request_text": "beach house"})
    assert bus.sent[-1][1]["payload"]["config_version"] == "matcher-v2"
    assert promote(c, "matcher-v2").status_code == 409
    assert promote(c, "matcher-v1").status_code == 200 and store.versions["matcher-v2"]["status"] == "rolled_back"
    assert promote(c, "nope").status_code == 404 and promote(c, "matcher-v2", body={"reviewer_id": "x", "y": 1}).status_code == 400


def test_unknown_config_version_is_400(c):
    assert c.post("/ai/requests", headers=OWNER, json={"request_text": "beach house", "config_version": "nope"}).status_code == 400
