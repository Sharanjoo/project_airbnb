import os

os.environ["KAFKA_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app, bus, store  # noqa: E402

GUEST = {"X-User-Id": "gst_0001", "X-User-Role": "guest"}
TRACE = "7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01"


def setup_function():
    bus.sent.clear()
    store.tasks.clear()


def test_health():
    with TestClient(app) as c:
        assert c.get("/health").json()["status"] == "ok"


def test_request_publishes_ai_requests_with_same_trace_id():
    with TestClient(app) as c:
        r = c.post("/ai/requests", headers={**GUEST, "X-Trace-Id": TRACE},
                   json={"request_text": "two nights in San Jose under $250 with parking",
                         "check_in": "2026-11-14", "check_out": "2026-11-16"})
    assert r.status_code == 202
    data = r.json()["data"]
    assert data["status"] == "QUEUED" and data["trace_id"] == TRACE
    topic, env = bus.sent[0]
    assert topic == "ai.requests"
    assert env["trace_id"] == TRACE
    assert env["entity"] == {"entity_type": "ai_task", "entity_id": data["task_id"]}


def test_empty_request_is_400_with_common_error_body():
    with TestClient(app) as c:
        r = c.post("/ai/requests", headers=GUEST, json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert r.json()["trace_id"]


def test_unknown_field_rejected():
    with TestClient(app) as c:
        r = c.post("/ai/requests", headers=GUEST, json={"request_text": "beach house", "hack": 1})
    assert r.status_code == 400


def test_no_user_is_401():
    with TestClient(app) as c:
        r = c.post("/ai/requests", json={"request_text": "beach house"})
    assert r.status_code == 401


def test_result_not_ready_is_409():
    with TestClient(app) as c:
        task_id = c.post("/ai/requests", headers=GUEST, json={"request_text": "beach house"}).json()["data"]["task_id"]
        r = c.get(f"/ai/results/{task_id}")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "NOT_READY"


def test_open_task_limit_is_429():
    with TestClient(app) as c:
        for _ in range(3):
            assert c.post("/ai/requests", headers=GUEST, json={"request_text": "beach house"}).status_code == 202
        r = c.post("/ai/requests", headers=GUEST, json={"request_text": "beach house"})
    assert r.status_code == 429


def test_stream_sends_status_then_closes():
    with TestClient(app) as c:
        task_id = c.post("/ai/requests", headers=GUEST, json={"request_text": "beach house"}).json()["data"]["task_id"]
        with c.websocket_connect(f"/ai/tasks/{task_id}/stream") as ws:
            assert ws.receive_json()["status"] == "QUEUED"
