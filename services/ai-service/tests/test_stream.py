import asyncio
import logging
import threading
import time

import jwt
import pytest
from fastapi.testclient import TestClient
from pymongo.errors import ServerSelectionTimeoutError
from starlette.websockets import WebSocketDisconnect

from app import config
from app.main import app, bus, store
from app.stream import RedactToken

OWNER = {"X-User-Id": "gst_0001", "X-User-Role": "guest"}


def token(sub="gst_0001", role="guest", secret=None, alg="HS256", **over):
    claims = {"sub": sub, "role": role, "exp": time.time() + 60, **over}
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, config.JWT_SECRET if secret is None else secret, alg)


@pytest.fixture
def c(monkeypatch):
    monkeypatch.setattr(config, "STREAM_POLL_S", 0.01)
    bus.sent.clear(), store.tasks.clear(), store.messages.clear()
    with TestClient(app) as client:
        yield client


@pytest.fixture
def tid(c):
    return c.post("/ai/requests", headers=OWNER, json={"request_text": "beach house"}).json()["data"]["task_id"]


def do(coro):
    return asyncio.run(coro)


def read_all(ws):
    frames = []
    while True:
        try:
            frames.append(ws.receive_json())
        except WebSocketDisconnect as e:
            return frames, e.code


def collect(c, tid, query="", path="/ai/tasks/{}/stream", headers=None):
    with c.websocket_connect(f"{path.format(tid)}?token={token()}{query}", headers=headers or {}) as ws:
        return read_all(ws)


def finish(tid, status="AWAITING_APPROVAL"):
    do(store.transition(tid, "PLANNING"))
    do(store.add_frame(tid, "plan", {"type": "plan.created", "plan_id": "pln_1", "steps": []}))
    do(store.transition(tid, status, {"errors": [{"code": "NOT_ENOUGH_AGENTS", "message": "why"}]} if status == "TIMED_OUT" else {}))


def test_late_client_gets_a_full_replay_then_a_clean_close(c, tid):
    finish(tid)
    frames, code = collect(c, tid)
    assert code == 1000 and [f["type"] for f in frames] == ["status", "status", "plan.created", "status"]
    assert [f["seq"] for f in frames] == [1, 2, 3, 4] and frames[-1]["status"] == "AWAITING_APPROVAL"
    for f in frames:
        assert {"type", "task_id", "trace_id", "timestamp", "payload"} <= f.keys() and "key" not in f
    assert frames[2]["plan_id"] == frames[2]["payload"]["plan_id"] == "pln_1"


def test_live_frames_arrive_while_connected(c, tid):
    with c.websocket_connect(f"/ai/tasks/{tid}/stream?token={token()}") as ws:
        assert ws.receive_json()["status"] == "QUEUED"
        t = threading.Thread(target=finish, args=(tid,))
        t.start()
        frames, code = read_all(ws)
        t.join()
    assert code == 1000 and frames[-1]["status"] == "AWAITING_APPROVAL"


def test_reconnect_continues_after_the_last_seen_frame(c, tid):
    finish(tid)
    assert [f["seq"] for f in collect(c, tid, "&after=2")[0]] == [3, 4]
    assert len(collect(c, tid, "&after=junk")[0]) == len(collect(c, tid, "&after=-5")[0]) == 4
    assert collect(c, tid, "&after=99") == ([], 1000)


def test_failed_task_ends_with_an_error_frame(c, tid):
    finish(tid, "TIMED_OUT")
    frames, code = collect(c, tid)
    assert code == 1000 and frames[-1]["type"] == "error" and frames[-1]["code"] == "NOT_ENOUGH_AGENTS"


def test_gateway_path_works_too(c, tid):
    finish(tid)
    assert collect(c, tid, path="/api/v1/ai/ai/tasks/{}/stream")[1] == 1000


@pytest.mark.parametrize("tok", [
    "", "nope", token(secret="wrong"), token(exp=time.time() - 5), token(exp=None), token(role=None), token(sub=None), token(sub=""),
    token(alg="none", secret=""), token(alg="HS512")])
def test_bad_tokens_close_4401_and_spoofed_headers_do_not_help(c, tid, tok):
    with c.websocket_connect(f"/ai/tasks/{tid}/stream?token={tok}", headers=OWNER) as ws:
        assert read_all(ws) == ([], 4401)


def test_missing_token_closes_4401(c, tid):
    with c.websocket_connect(f"/ai/tasks/{tid}/stream") as ws:
        assert read_all(ws) == ([], 4401)


def test_other_user_4403_admin_allowed_unknown_4404(c, tid):
    finish(tid)
    for tok, task, code in ((token("gst_2"), tid, 4403), (token("adm_1", "admin"), tid, 1000), (token(), "tsk_nope", 4404)):
        with c.websocket_connect(f"/ai/tasks/{task}/stream?token={tok}", headers=OWNER) as ws:
            frames, got = read_all(ws)
            assert got == code and (code == 1000 or frames == [])


def test_two_tasks_do_not_share_frames(c, tid):
    other = c.post("/ai/requests", headers=OWNER, json={"request_text": "city flat"}).json()["data"]["task_id"]
    finish(tid), finish(other)
    assert {f["task_id"] for f in collect(c, tid)[0]} == {tid}


def test_stream_closes_an_overdue_task(c, tid, monkeypatch):
    monkeypatch.setattr(config, "TASK_DEADLINE_S", -10)
    frames, code = collect(c, tid)
    assert code == 1000 and frames[-2]["status"] == "TIMED_OUT" and frames[-1]["type"] == "error"


def test_mongo_outage_sends_an_error_and_1011(c, tid, monkeypatch):
    async def down(_):
        raise ServerSelectionTimeoutError("down")
    monkeypatch.setattr(store, "get", down)
    frames, code = collect(c, tid)
    assert code == 1011 and frames[0]["code"] == "DEPENDENCY_UNAVAILABLE"


def test_token_is_redacted_from_logs():
    r = logging.LogRecord("uvicorn.error", 20, "", 0, '%s - "WebSocket %s" [accepted]', ("1.1.1.1", "/ai/x?token=abc.def&after=2"), None)
    RedactToken().filter(r)
    assert "abc.def" not in r.getMessage() and "after=2" in r.getMessage()
