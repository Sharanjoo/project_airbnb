import asyncio

import pytest
from fastapi.testclient import TestClient
from pymongo.errors import ServerSelectionTimeoutError

from app.main import app, bus, store

OWNER = {"X-User-Id": "gst_0001", "X-User-Role": "guest"}
OTHER = {"X-User-Id": "gst_0002", "X-User-Role": "guest"}
ADMIN = {"X-User-Id": "adm_1", "X-User-Role": "admin"}
TRACE = "7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01"


@pytest.fixture
def c():
    bus.sent.clear()
    store.tasks.clear()
    store.messages.clear()
    with TestClient(app) as client:
        yield client


def create(c, **headers):
    return c.post("/ai/requests", headers={**OWNER, **headers}, json={"request_text": "beach house"})


@pytest.mark.parametrize("path", ["/ai/tasks/{}", "/ai/results/{}", "/ai/tasks/{}/debate"])
def test_reads_are_owner_or_admin_only(c, path):
    tid = create(c).json()["data"]["task_id"]
    asyncio.run(store.update(tid, {"result": {"task_id": tid}}))
    assert c.get(path.format(tid), headers=OWNER).status_code == 200
    assert c.get(path.format(tid), headers=ADMIN).status_code == 200
    for headers, status, code in ((OTHER, 403, "FORBIDDEN"), ({}, 401, "UNAUTHENTICATED")):
        r = c.get(path.format(tid), headers=headers)
        assert (r.status_code, r.json()["error"]["code"]) == (status, code)
    assert c.get(path.format("tsk_missing"), headers=OWNER).status_code == 404


def test_task_body_matches_api_doc(c):
    tid = create(c).json()["data"]["task_id"]
    r = c.get(f"/ai/tasks/{tid}", headers={**OWNER, "X-Trace-Id": TRACE}).json()
    assert r["trace_id"] == TRACE
    assert {"status", "plan", "agents", "round", "started_at", "updated_at", "errors"} <= r["data"].keys()
    assert [a["name"] for a in r["data"]["agents"]] == ["matching", "risk", "fairness"]
    assert "user_id" not in r["data"]


def test_result_returned_with_trace_id(c):
    tid = create(c).json()["data"]["task_id"]
    asyncio.run(store.update(tid, {"result": {"confidence": 0.7}}))
    r = c.get(f"/ai/results/{tid}", headers=OWNER).json()
    assert r["data"] == {"confidence": 0.7} and r["trace_id"]


def test_failed_task_result_is_not_retryable(c):
    tid = create(c).json()["data"]["task_id"]
    asyncio.run(store.transition(tid, "TIMED_OUT"))
    r = c.get(f"/ai/results/{tid}", headers=OWNER)
    assert r.status_code == 409 and r.json()["error"]["retryable"] is False


def test_debate_replay_is_in_round_order(c):
    d = create(c).json()["data"]
    for rnd, agent in ((1, "chair"), (0, "risk")):
        asyncio.run(store.add_message(trace_id=d["trace_id"], task_id=d["task_id"], round_no=rnd, agent=agent, payload={}))
    msgs = c.get(f"/ai/tasks/{d['task_id']}/debate", headers=OWNER).json()["data"]["messages"]
    assert [(m["round"], m["agent"]) for m in msgs] == [(0, "risk"), (1, "chair")]
    assert set(msgs[0]) == {"round", "agent", "event_id", "payload"}


def test_trace_id_must_be_a_fresh_uuid(c):
    assert create(c, **{"X-Trace-Id": "not-a-uuid"}).status_code == 400
    assert not store.tasks and not bus.sent
    assert create(c, **{"X-Trace-Id": TRACE}).status_code == 202
    r = create(c, **{"X-Trace-Id": TRACE})
    assert r.status_code == 400 and r.json()["error"]["details"][0]["field"] == "X-Trace-Id"
    assert len(bus.sent) == 1


def test_kafka_down_fails_the_task_and_frees_the_slot(c, monkeypatch):
    async def down(*_):
        raise TimeoutError
    monkeypatch.setattr(bus, "publish", down)
    for _ in range(4):  # one more than the open-task limit
        r = create(c)
        assert r.status_code == 503 and r.json()["error"]["retryable"] is True
    assert {t["status"] for t in store.tasks.values()} == {"FAILED"}


def test_mongo_down_is_503(c, monkeypatch):
    async def down(*_):
        raise ServerSelectionTimeoutError("down")
    monkeypatch.setattr(store, "get", down)
    r = c.get("/ai/tasks/tsk_1", headers=OWNER)
    assert r.status_code == 503 and r.json()["error"]["code"] == "DEPENDENCY_UNAVAILABLE"


@pytest.mark.parametrize("body", [
    {"structured": {}},
    {"structured": {"city": "Napa", "hack": 1}},
    {"structured": {"city": "  "}},
    {"structured": {"guests": 0}},
    {"structured": {"min_rating": 6}},
    {"structured": {"city": "Napa"}, "property_pool_ref": "other"},
    {"request_text": "beach house", "check_in": "2026-11-16", "check_out": "2026-11-16"},
])
def test_invalid_bodies_are_400(c, body):
    r = c.post("/ai/requests", headers=OWNER, json=body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_structured_only_request_is_accepted(c):
    r = c.post("/ai/requests", headers=OWNER, json={"structured": {"city": "San Jose", "price_max": 250}})
    assert r.status_code == 202
    assert bus.sent[0][1]["payload"]["structured"]["city"] == "San Jose"


def test_unknown_route_uses_common_error_body(c):
    r = c.get("/ai/nope", headers=OWNER)
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND" and r.json()["trace_id"]


def test_overdue_task_is_closed_even_if_the_chair_is_down(c, monkeypatch):
    from app import config
    tid = create(c).json()["data"]["task_id"]
    create(c), create(c)
    assert create(c).status_code == 429
    monkeypatch.setattr(config, "TASK_DEADLINE_S", -10)
    assert create(c).status_code == 202  # old ones no longer hold the slots
    assert c.get(f"/ai/tasks/{tid}", headers=OWNER).json()["data"]["status"] == "TIMED_OUT"
