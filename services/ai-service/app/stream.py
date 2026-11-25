"""Live task stream (API doc §9): replay what already happened, then follow.

Frames are stored on the task by the Chair and by every status change, so a client
that connects late or reconnects sees the same frames in the same order. Reading
them from MongoDB also means any API instance can serve any stream."""
import asyncio
import logging
import re

import jwt
from fastapi import WebSocket, WebSocketDisconnect
from pymongo.errors import PyMongoError

from . import config
from .envelope import utc_now_iso
from .store import FAILURES, OPEN_STATUSES

UNAUTHENTICATED, FORBIDDEN, UNKNOWN_TASK, INTERNAL = 4401, 4403, 4404, 1011
META = {"key", "type", "task_id", "trace_id", "timestamp"}
log = logging.getLogger("ai-service")


class RedactToken(logging.Filter):
    """The browser can only send the token in the URL; keep it out of the access log."""

    def filter(self, record):
        if isinstance(record.args, tuple):
            record.args = tuple(re.sub(r"token=[^&\s\"]+", "token=***", a) if isinstance(a, str) else a for a in record.args)
        return True


def install_log_redaction():
    for name in ("uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactToken) for f in logger.filters):
            logger.addFilter(RedactToken())


def verify_token(token: str | None) -> dict | None:
    """The identity in a valid JWT. A WebSocket upgrade skips the gateway's login
    check, so X-User-Id / X-User-Role on it are never trusted."""
    try:
        claims = jwt.decode(token or "", config.JWT_SECRET, algorithms=["HS256"], options={"require": ["sub", "exp"]})
    except jwt.PyJWTError:
        return None
    sub, role = claims.get("sub"), claims.get("role")
    return {"id": sub, "role": role} if isinstance(sub, str) and sub and isinstance(role, str) and role else None


def outgoing(frame: dict, seq: int) -> dict:
    """Fields at the top level as in the API doc, and the same ones under payload."""
    fields = {k: v for k, v in frame.items() if k not in META}
    return {**fields, "payload": fields, "seq": seq, **{k: frame[k] for k in META - {"key"}}}


def error_frame(task: dict) -> dict:
    last = task["errors"][-1] if task["errors"] else {"code": task["status"], "message": "The task ended without a result."}
    return {"type": "error", "task_id": task["task_id"], "trace_id": task["trace_id"], "timestamp": utc_now_iso(),
            "code": last.get("code"), "message": last.get("message"), "errors": task["errors"]}


async def serve(ws: WebSocket, task_id: str, store, expire):
    # Accept first: a browser only sees a close code on an accepted socket.
    await ws.accept()
    user = verify_token(ws.query_params.get("token"))
    if not user:
        return await ws.close(UNAUTHENTICATED, "unauthenticated")
    try:
        sent = int(ws.query_params.get("after", 0))
    except ValueError:
        sent = 0
    sent = max(0, sent)
    # The client has nothing to say; this only notices that it left.
    gone = asyncio.create_task(_until_disconnect(ws))
    try:
        while not gone.done():
            task = await store.get(task_id)
            if not task:
                return await ws.close(UNKNOWN_TASK, "unknown task")
            if user["role"] != "admin" and task["user_id"] != user["id"]:
                return await ws.close(FORBIDDEN, "not the task owner")
            task = await expire(task)
            frames = task["frames"]
            for seq in range(sent + 1, len(frames) + 1):
                await ws.send_json(outgoing(frames[seq - 1], seq))
            sent = max(sent, len(frames))
            if task["status"] not in OPEN_STATUSES:  # frames and status come from one read, so none is missed
                if task["status"] in FAILURES:
                    await ws.send_json(outgoing(error_frame(task), len(frames) + 1))
                return await ws.close(1000)
            await asyncio.wait({gone}, timeout=config.STREAM_POLL_S)
    except PyMongoError as exc:
        log.error("stream for task %s lost MongoDB: %s", task_id, exc)
        await _quietly(ws.send_json({"type": "error", "task_id": task_id, "timestamp": utc_now_iso(), "code": "DEPENDENCY_UNAVAILABLE",
                                     "message": "MongoDB is unavailable.", "payload": {"code": "DEPENDENCY_UNAVAILABLE"}}))
        await _quietly(ws.close(INTERNAL, "try again"))
    except (WebSocketDisconnect, RuntimeError):
        pass  # the client left while a frame was being sent
    finally:
        gone.cancel()


async def _until_disconnect(ws: WebSocket):
    try:
        while (await ws.receive())["type"] != "websocket.disconnect":
            pass
    except RuntimeError:
        pass


async def _quietly(coro):
    try:
        await coro
    except (WebSocketDisconnect, RuntimeError):
        pass
