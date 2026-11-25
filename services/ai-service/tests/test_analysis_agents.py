import asyncio
import copy
import json
import uuid
from types import SimpleNamespace

import pytest

from agents import base
from agents.harness import check_opinion, check_round0
from agents.parsing import parse_request
from agents.roles import FairnessAgent, MatchingAgent, RiskAgent
from app.envelope import create_envelope, validate_envelope
from app.pool import load_pool
from app.store import InMemoryTaskStore

POOL = load_pool()
CLASSES = [MatchingAgent, RiskAgent, FairnessAgent]


class FakeProducer:
    def __init__(self):
        self.sent = []

    async def send_and_wait(self, topic, value, key=None, headers=None):
        self.sent.append(SimpleNamespace(topic=topic, value=value, key=key))


def parsed_env(task_id=None, trace=None, actor="agent:parser", text="San Jose under $250 with parking for 2", **payload):
    req = asyncio.run(parse_request({"request_text": text}, POOL))["requirements"]
    return create_envelope(event_type="ai.requests", trace_id=trace or str(uuid.uuid4()), actor_id=actor, actor_type="agent",
                           entity_type="ai_task", entity_id=task_id or f"tsk_{uuid.uuid4().hex}",
                           payload={"structured_requirements": req, **payload})


def build(cls, env, store=None):
    agent = cls(store or InMemoryTaskStore(), FakeProducer())
    asyncio.run(agent.store.create({"task_id": env["entity"]["entity_id"], "trace_id": env["trace_id"], "plan_id": "p",
                                    "user_id": "gst_1", "config_version": "v", "request": {}}))
    return agent


def process(agent, env, topic="ai.requests"):
    return asyncio.run(agent.process(SimpleNamespace(topic=topic, value=json.dumps(env).encode(), key=b"k", partition=0, offset=0)))


def opinion(cls=MatchingAgent):
    env = parsed_env()
    agent = build(cls, env)
    process(agent, env)
    return env, json.loads(agent.producer.sent[0].value)


def verify(env, out):
    return check_opinion(out, expected_trace_id=env["trace_id"], expected_task_id=env["entity"]["entity_id"], known_property_ids=POOL.ids)


@pytest.mark.parametrize("cls", CLASSES)
def test_publishes_a_valid_round0_opinion(cls):
    env, out = opinion(cls)
    assert validate_envelope(out, "debate.round.0") == [] and verify(env, out) == []
    assert out["idempotency_key"] == f"{env['entity']['entity_id']}:{cls.name}:round0"
    assert out["payload"]["reflection"]["verdict"] == "keep" and out["payload"]["round"] == 0


@pytest.mark.parametrize("cls", CLASSES)
@pytest.mark.parametrize("text", ["surprise me please", "Fresno for 16 guests under $1 with a pool rated 5 stars"])
def test_vague_and_impossible_requests_still_produce_valid_opinions(cls, text):
    env = parsed_env(text=text)
    agent = build(cls, env)
    assert process(agent, env) == "ok" and verify(env, json.loads(agent.producer.sent[0].value)) == []


def test_agents_run_concurrently_on_one_task_and_tasks_do_not_mix():
    async def go():
        store, agents = InMemoryTaskStore(), []
        envs = [await asyncio.to_thread(parsed_env, text=t) for t in ("Napa for 2", "Fresno for 2", "Oakland for 2")]
        for e in envs:
            await store.create({"task_id": e["entity"]["entity_id"], "trace_id": e["trace_id"], "plan_id": "p", "user_id": "g",
                                "config_version": "v", "request": {}})
        agents = [c(store, FakeProducer()) for c in CLASSES]
        await asyncio.gather(*(a.handle(e, "ai.requests") for a in agents for e in envs))
        return envs, [json.loads(m.value) for a in agents for m in a.producer.sent]
    envs, outs = asyncio.run(go())
    assert len(outs) == 9
    for e, city in zip(envs, ("Napa", "Fresno", "Oakland")):
        mine = [o for o in outs if o["trace_id"] == e["trace_id"]]
        assert {o["payload"]["agent"] for o in mine} == {"matching", "risk", "fairness"}
        assert all(POOL.by_id[o["payload"]["ranked"][0]["property_id"]]["city"] == city and verify(e, o) == [] for o in mine)


def test_round0_is_independent():
    assert all("debate.round.0" not in c.subscribe for c in CLASSES)


def test_raw_request_is_ignored():
    env = parsed_env()
    del env["payload"]["structured_requirements"]
    agent = build(MatchingAgent, env)
    assert process(agent, env) == "ok" and not agent.producer.sent


def test_requirements_must_come_from_the_parser():
    env = parsed_env(actor="gst_1")
    agent = build(MatchingAgent, env)
    assert process(agent, env) == "dlq" and agent.producer.sent[0].topic == "ai.requests.dlq"


def test_duplicate_delivery_gives_the_same_idempotency_key_and_ranking():
    env = parsed_env()
    agent = build(RiskAgent, env)
    process(agent, env)
    process(agent, env)
    a, b = (json.loads(m.value) for m in agent.producer.sent)
    assert a["idempotency_key"] == b["idempotency_key"] and a["payload"]["ranked"] == b["payload"]["ranked"]


def test_closed_task_is_dropped():
    env = parsed_env()
    agent = build(MatchingAgent, env)
    asyncio.run(agent.store.transition(env["entity"]["entity_id"], "TIMED_OUT"))
    assert process(agent, env) == "ok" and not agent.producer.sent


def test_reflection_revises_once_then_refuses(monkeypatch):
    env = parsed_env()
    agent = build(MatchingAgent, env)
    real = agent.opinion

    def one_bad(req):
        d = real(req)
        d["ranked"][4]["property_id"] = "prp_invented"
        return d
    monkeypatch.setattr(agent, "opinion", one_bad)
    assert process(agent, env) == "ok"
    out = json.loads(agent.producer.sent[0].value)
    assert out["payload"]["reflection"]["verdict"] == "revise" and len(out["payload"]["ranked"]) == 9 and verify(env, out) == []

    def all_bad(req):
        d = real(req)
        for r in d["ranked"]:
            r["reasons"] = []
        return d
    monkeypatch.setattr(agent, "opinion", all_bad)
    agent.producer.sent.clear()
    assert process(agent, env) == "dlq" and agent.producer.sent[0].topic == "ai.requests.dlq"


def set_item(field, value):
    return lambda o: o["payload"]["ranked"][0].__setitem__(field, value)


def set_payload(field, value):
    return lambda o: o["payload"].__setitem__(field, value)


BREAKS = {
    "unknown property": set_item("property_id", "prp_nope"), "score high": set_item("score", 1.1), "score bool": set_item("score", True),
    "score nan": set_item("score", float("nan")), "score text": set_item("score", "0.9"), "no reasons": set_item("reasons", []),
    "blank reason": set_item("reasons", [" "]), "id is a list": set_item("property_id", []),
    "no evidence": set_item("evidence_refs", []), "fake evidence": set_item("evidence_refs", ["review:rev_1"]),
    "order": set_item("score", 0), "confidence": set_payload("confidence", 2), "confidence missing": set_payload("confidence", None),
    "empty ranking": set_payload("ranked", []), "ranked text": set_payload("ranked", "x"), "item not object": set_payload("ranked", ["x"]),
    "oversized": lambda o: o["payload"]["ranked"].extend(o["payload"]["ranked"][:1]), "round": set_payload("round", 2),
    "round bool": set_payload("round", False), "agent spoof": set_payload("agent", "risk"), "agent list": set_payload("agent", []),
    "chair opinion": lambda o: (o["payload"].update(agent="chair"), o.update(actor_id="agent:chair")),
    "no reflection": set_payload("reflection", None), "checks": set_payload("reflection", {"checks": {}, "verdict": "keep"}),
    "verdict": lambda o: o["payload"]["reflection"].update(verdict="maybe"), "flags": set_payload("risk_flags", [1]),
    "concerns": set_payload("concerns", [{"evidence_refs": []}]), "payload": lambda o: o.update(payload=[]),
    "trace": lambda o: o.update(trace_id=str(uuid.uuid4())), "task": lambda o: o["entity"].update(entity_id="tsk_x"),
    "entity": lambda o: o.update(entity=None),
}


@pytest.mark.parametrize("name", BREAKS)
def test_harness_rejects(name):
    env, out = opinion()
    bad = copy.deepcopy(out)
    BREAKS[name](bad)
    assert verify(env, out) == [] and verify(env, bad)


def test_old_check_survives_garbage():
    for payload in (None, [], {"ranked": [None, 3, {}]}):
        assert check_round0({"payload": payload}, expected_trace_id="t", known_property_ids=set())
