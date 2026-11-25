import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest

from agents import base
from agents.roles import ChairAgent, ParserAgent
from app.envelope import create_envelope, validate_envelope
from app.store import InMemoryTaskStore


class FakeProducer:
    def __init__(self):
        self.sent = []

    async def send_and_wait(self, topic, value, key=None, headers=None):
        self.sent.append(SimpleNamespace(topic=topic, value=value, key=key, headers=dict(headers or [])))


@pytest.fixture
def agent(monkeypatch):
    monkeypatch.setattr(base, "BASE_DELAY_S", 0)
    return ParserAgent(InMemoryTaskStore(), FakeProducer())


def raw_env(text="San Jose under $250", trace=None, **payload):
    return create_envelope(event_type="ai.requests", trace_id=trace or str(uuid.uuid4()), actor_id="gst_1", actor_type="guest",
                           entity_type="ai_task", entity_id=f"tsk_{uuid.uuid4().hex}",
                           payload={"request_text": text, "property_pool_ref": "active-pool-v1", **payload})


def msg(env):
    value = env if isinstance(env, bytes) else json.dumps(env).encode()
    return SimpleNamespace(topic="ai.requests", value=value, key=b"k", partition=2, offset=7)


def add_task(agent, env, **over):
    asyncio.run(agent.store.create({"task_id": env["entity"]["entity_id"], "trace_id": env["trace_id"], "plan_id": "pln_1",
                                    "user_id": "gst_1", "config_version": "matcher-v1", "request": {}, **over}))


def process(agent, env):
    return asyncio.run(agent.process(msg(env)))


def stored(agent, env):
    return agent.store.tasks[env["entity"]["entity_id"]]


def test_publishes_parsed_request_with_same_trace(agent):
    env = raw_env()
    add_task(agent, env)
    assert process(agent, env) == "ok"
    out = json.loads(agent.producer.sent[0].value)
    assert validate_envelope(out, "ai.requests") == []
    assert out["trace_id"] == env["trace_id"] and agent.producer.sent[0].key == env["trace_id"].encode()
    assert out["payload"]["structured_requirements"]["city"] == "San Jose"
    assert out["actor_id"] == "agent:parser" and out["idempotency_key"].endswith(":parsed")
    assert stored(agent, env)["parsed_request"]["latency_ms"] >= 0


def test_ignores_its_own_output(agent):
    env = raw_env()
    add_task(agent, env)
    process(agent, env)
    assert process(agent, json.loads(agent.producer.sent[0].value)) == "ok"
    assert len(agent.producer.sent) == 1


def test_duplicate_request_gets_the_same_answer(agent):
    env = raw_env()
    add_task(agent, env)
    process(agent, env)
    process(agent, env)
    a, b = (json.loads(m.value) for m in agent.producer.sent)
    assert a["payload"] == b["payload"] and a["idempotency_key"] == b["idempotency_key"]


def test_unknown_closed_and_cross_trace_tasks_are_dropped(agent):
    unknown, closed, mixed = raw_env(), raw_env(), raw_env()
    add_task(agent, closed)
    asyncio.run(agent.store.transition(closed["entity"]["entity_id"], "FAILED"))
    add_task(agent, mixed, trace_id=str(uuid.uuid4()))
    assert [process(agent, e) for e in (unknown, closed, mixed)] == ["ok"] * 3
    assert agent.producer.sent == []


def test_unusable_request_fails_the_task(agent):
    env = raw_env(text=None, structured={"city": "Paris"})
    add_task(agent, env)
    assert process(agent, env) == "ok"
    t = stored(agent, env)
    assert t["status"] == "FAILED" and t["errors"][0]["field"] == "structured.city"
    assert agent.producer.sent == []


def test_bad_messages_go_to_dlq_unchanged(agent):
    bad = raw_env()
    del bad["idempotency_key"]
    future = {**raw_env(), "schema_version": 99}
    wrong_topic = {**raw_env(), "event_type": "ai.results"}
    for m in (b"{oops", b"[]", bad, future, wrong_topic):
        assert process(agent, m) == "dlq"
    assert {m.topic for m in agent.producer.sent} == {"ai.requests.dlq"}
    first = agent.producer.sent[0]
    assert first.value == b"{oops" and first.headers["consumer_group"] == b"parser-cg"
    assert first.headers["source_offset"] == b"7"


def test_transient_errors_retry_then_succeed(agent, monkeypatch):
    env = raw_env()
    add_task(agent, env)
    real, calls = agent.store.get, []

    async def flaky(task_id):
        calls.append(1)
        if len(calls) < 3:
            raise ConnectionError
        return await real(task_id)
    monkeypatch.setattr(agent.store, "get", flaky)
    assert process(agent, env) == "ok" and len(calls) >= 3
    assert [m.topic for m in agent.producer.sent] == ["ai.requests"]


def test_retries_are_bounded(agent, monkeypatch):
    calls = []

    async def down(_):
        calls.append(1)
        raise ConnectionError
    monkeypatch.setattr(agent.store, "get", down)
    assert process(agent, raw_env()) == "dlq" and len(calls) == 4


def test_consumer_groups_match_api_doc(agent):
    assert agent.group_id == "parser-cg" and ChairAgent().group_id == "chair-cg"
