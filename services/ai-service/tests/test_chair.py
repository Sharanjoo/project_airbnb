"""Whole debates: every real agent, connected by an in-memory bus instead of Kafka."""
import asyncio
import json
import os
import uuid
from types import SimpleNamespace

import pytest

from agents import base
from agents.harness import check_topic_allowed
from agents.roles import AGENTS, ChairAgent
from app import config
from app.availability import is_available
from app.envelope import create_envelope, validate_envelope
from app.pool import load_pool
from app.store import InMemoryTaskStore, MongoTaskStore

POOL = load_pool()
MONGO = os.getenv("TEST_MONGO_URL")


class Bus:
    """Delivers each message to every agent subscribed to its topic, in order."""

    def __init__(self, store, only=tuple(AGENTS), availability=None):
        self.store, self.log, self.queue, self.tamper = store, [], [], lambda topic, v: v
        async def unknown(*_):
            return None
        self.agents = {}
        for name in only:
            kw = {"availability": availability or unknown} if name == "chair" else {}
            self.agents[name] = AGENTS[name](store, self, **kw)

    async def send_and_wait(self, topic, value, key=None, headers=None):
        self.log.append((topic, value))
        if not topic.endswith(".dlq"):
            self.queue.append((topic, value))

    async def drain(self):
        while self.queue:
            topic, value = self.queue.pop(0)
            value = self.tamper(topic, value)
            for a in self.agents.values():
                if topic in a.subscribe:
                    await a.process(SimpleNamespace(topic=topic, value=value, key=b"k", partition=0, offset=0))

    def sent(self, topic):
        return [json.loads(v) for t, v in self.log if t == topic]

    async def request(self, text="San Jose under $250 with parking for 2", user="gst_1", **payload):
        tid, trace = f"tsk_{uuid.uuid4().hex}", str(uuid.uuid4())
        await self.store.create({"task_id": tid, "trace_id": trace, "plan_id": "pln_1", "user_id": user, "config_version": "matcher-v1",
                                 "request": {"request_text": text}})
        env = create_envelope(event_type="ai.requests", trace_id=trace, actor_id=user, actor_type="guest", entity_type="ai_task",
                              entity_id=tid, payload={"task_id": tid, "request_text": text, **payload}, idempotency_key=tid)
        await self.send_and_wait("ai.requests", json.dumps(env).encode())
        return tid


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(base, "BASE_DELAY_S", 0)
    monkeypatch.setattr(config, "ROUND0_DEADLINE_S", 30)
    monkeypatch.setattr(config, "ROUND2_DEADLINE_S", 30)


@pytest.fixture(params=["memory", pytest.param("mongo", marks=pytest.mark.skipif(not MONGO, reason="TEST_MONGO_URL not set"))])
def run(request):
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


async def past_deadline(bus, tid, rnd):
    task = await bus.store.get(tid)
    await bus.store.update(tid, {"deadlines": {**task["deadlines"], f"round{rnd}": "2020-01-01T00:00:00.000Z"}})
    await bus.agents["chair"].sweep()
    await bus.drain()


def types(task):
    return [f["type"] for f in task["frames"]]


def test_full_debate(run):
    async def t(store):
        bus = Bus(store)
        tid = await bus.request()
        await bus.drain()
        task = await store.get(tid)
        assert task["status"] == "AWAITING_APPROVAL"
        (env,) = bus.sent("ai.results")
        assert validate_envelope(env, "ai.results") == [] and env["trace_id"] == task["trace_id"]
        r = env["payload"]
        assert {k: r[k] for k in task["result"]} == task["result"]
        doc = {"task_id", "trace_id", "config_version", "recommended", "ranked", "confidence", "rationale", "risks", "rejected_alternative",
               "decision", "dissent", "limitations", "explanation", "human_decision"}
        assert doc | {"user_id", "plan_id", "disagreement_score"} <= r.keys() and r["user_id"] == "gst_1"
        assert not {"guest_id", "host_id", "property_id", "receiver_id"} & r.keys()
        assert r["recommended"]["property_id"] == r["ranked"][0] and len(set(r["ranked"])) == len(r["ranked"])
        assert POOL.by_id[r["ranked"][0]]["city"] == "San Jose" and sum(r["decision"]["votes"].values()) == 3
        assert r["rejected_alternative"]["property_id"] != r["ranked"][0] and r["explanation"]
        assert all(v is not None for v in r["timings_ms"].values())
        # These requests have no dates, so step 6 must not claim it was done.
        assert r["availability"] == "no_dates"
        assert [s["status"] for s in task["plan"]["steps"]] == ["done"] * 5 + ["skipped", "done"]
        assert "No dates" in task["plan"]["steps"][5]["note"]
        assert {a["status"] for a in task["agents"]} == {"published"}
        assert [m["round"] for m in await store.list_messages(task["trace_id"])] == [0, 0, 0, 1, 2, 2, 2]
        ty = types(task)
        assert ty.count("agent.published") == 6 and ty.count("vote.cast") == 3 and ty.count("challenge.issued") >= 2
        assert ty[-2:] == ["verdict", "status"] and "plan.created" in ty and "parser.completed" in ty
        assert [f["status"] for f in task["frames"] if f["type"] == "status"] == [
            "QUEUED", "PLANNING", "ROUND_0", "ROUND_1", "ROUND_2", "DECIDING", "AWAITING_APPROVAL"]
        assert all(f["task_id"] == tid and f["trace_id"] == task["trace_id"] and f["timestamp"] for f in task["frames"])
    run(t)


def test_three_concurrent_debates_do_not_mix(run):
    async def t(store):
        bus = Bus(store)
        want = {await bus.request(f"{c} for 2"): c for c in ("Napa", "Fresno", "Oakland")}
        await bus.drain()
        for tid, city in want.items():
            task = await store.get(tid)
            assert task["status"] == "AWAITING_APPROVAL" and POOL.by_id[task["result"]["ranked"][0]]["city"] == city
            msgs = await store.list_messages(task["trace_id"])
            assert len(msgs) == 7 and {m["task_id"] for m in msgs} == {tid}
    run(t)


def test_concurrent_handling_of_one_trace_is_serialised(run):
    async def t(store):
        bus = Bus(store)
        tids = [await bus.request(f"{c} for 2") for c in ("Napa", "Fresno")]
        while bus.queue:
            batch, bus.queue = bus.queue, []
            await asyncio.gather(*(a.process(SimpleNamespace(topic=tp, value=v, key=b"", partition=0, offset=0))
                                   for tp, v in batch for a in bus.agents.values() if tp in a.subscribe))
        await bus.agents["chair"].sweep()
        await bus.drain()
        assert [(await store.get(i))["status"] for i in tids] == ["AWAITING_APPROVAL"] * 2 and len(bus.sent("ai.results")) == 2
    run(t)


def test_one_agent_missing_continues_after_the_deadline(run):
    async def t(store):
        bus = Bus(store, ("parser", "matching", "risk", "chair"))
        tid = await bus.request()
        await bus.drain()
        assert (await store.get(tid))["status"] == "ROUND_0"
        await past_deadline(bus, tid, 0)
        task = await store.get(tid)
        assert task["status"] == "AWAITING_APPROVAL"
        assert any("fairness" in x for x in task["result"]["limitations"])
        frame = next(f for f in task["frames"] if f["type"] == "agent.timeout")
        assert (frame["agent"], frame["round"], frame["deadline_ms"]) == ("fairness", 0, 30000)
        assert [a["status"] for a in task["agents"]] == ["published", "published", "timed_out"]
        assert sum(task["result"]["decision"]["votes"].values()) == 2
    run(t)


def test_two_agents_missing_times_out(run):
    async def t(store):
        bus = Bus(store, ("parser", "matching", "chair"))
        tid = await bus.request()
        await bus.drain()
        await past_deadline(bus, tid, 0)
        task = await store.get(tid)
        assert task["status"] == "TIMED_OUT" and not bus.sent("ai.results") and await store.count_open_for_user("gst_1") == 0
        assert types(task).count("agent.timeout") == 2 and task["errors"][-1]["code"] == "NOT_ENOUGH_AGENTS"
        assert "stopped" in [s["status"] for s in task["plan"]["steps"]]
    run(t)


def test_agent_lost_before_voting_is_an_abstention(run):
    async def t(store):
        bus = Bus(store)
        bus.tamper = lambda topic, v: (bus.agents.pop("risk", None), v)[1] if topic == "debate.round.1" else v
        tid = await bus.request()
        await bus.drain()
        assert (await store.get(tid))["status"] == "ROUND_2"
        await past_deadline(bus, tid, 2)
        r = (await store.get(tid))["result"]
        assert r["decision"]["votes"]["abstain"] == 1 and any("risk" in x for x in r["limitations"])
    run(t)


def test_nobody_votes_is_forced(run):
    async def t(store):
        bus = Bus(store)
        bus.tamper = lambda topic, v: v if topic != "debate.round.2" else b"{lost"
        tid = await bus.request()
        await bus.drain()
        await past_deadline(bus, tid, 2)
        r = (await store.get(tid))["result"]
        assert r["decision"] == {"mode": "forced", "votes": {"keep": 0, "switch": 0, "abstain": 3}} and r["dissent"][-1]["agent"] == "chair"
    run(t)


def test_parser_down_times_out(run, monkeypatch):
    async def t(store):
        bus = Bus(store, ("chair",))
        tid = await bus.request()
        await bus.drain()
        assert (await store.get(tid))["status"] == "PLANNING"
        monkeypatch.setattr(config, "PARSE_DEADLINE_S", -1)
        await bus.agents["chair"].sweep()
        assert (await store.get(tid))["errors"][-1]["code"] == "PARSER_TIMEOUT"
    run(t)


def test_overall_deadline_closes_any_open_task(run, monkeypatch):
    async def t(store):
        bus = Bus(store, ("parser", "matching", "chair"))
        tid = await bus.request()
        await bus.drain()
        monkeypatch.setattr(config, "TASK_DEADLINE_S", -1)
        await bus.agents["chair"].sweep()
        assert (await store.get(tid))["status"] == "TIMED_OUT"
    run(t)


def corrupt(times, agent="risk", topic="debate.round.0"):
    left = [times]

    def tamper(t, v):
        e = json.loads(v)
        if t == topic and e["actor_id"] == f"agent:{agent}" and left[0] > 0:
            left[0] -= 1
            if topic == "debate.round.0":
                e["payload"]["ranked"][0]["property_id"] = "prp_invented"
            else:
                e["payload"]["vote"]["property_id"] = "prp_invented"
        return json.dumps(e).encode()
    return tamper


@pytest.mark.parametrize("topic,dlq", [("debate.round.0", "debate.round.0.dlq"), ("debate.round.2", "debate.round.2.dlq")])
def test_rejected_message_gets_one_retry(run, topic, dlq):
    async def t(store):
        bus = Bus(store)
        bus.tamper = corrupt(1, topic=topic)
        tid = await bus.request()
        await bus.drain()
        task = await store.get(tid)
        assert task["status"] == "AWAITING_APPROVAL" and task["result"]["limitations"] == ["No dates given, so availability was not checked."]
        assert len(bus.sent(dlq)) == 1 and types(task).count("harness.rejected") == 1
        assert sum(task["result"]["decision"]["votes"].values()) == 3 and task["result"]["decision"]["votes"]["abstain"] == 0
    run(t)


def test_second_rejection_counts_as_timeout_without_waiting(run):
    async def t(store):
        bus = Bus(store)
        bus.tamper = corrupt(5)
        tid = await bus.request()
        await bus.drain()
        task = await store.get(tid)
        assert task["status"] == "AWAITING_APPROVAL" and any("risk" in x for x in task["result"]["limitations"])
        assert len(bus.sent("debate.round.0.dlq")) == 2
    run(t)


def test_duplicates_of_everything_change_nothing(run):
    async def t(store):
        bus = Bus(store)
        tid = await bus.request()
        await bus.drain()
        before = await store.get(tid)
        bus.queue = [(tp, v) for tp, v in bus.log]
        await bus.drain()
        after = await store.get(tid)
        assert after["result"] == before["result"] and after["frames"] == before["frames"]
        assert len({e["idempotency_key"] for e in bus.sent("ai.results")}) == 1 and len(bus.sent("ai.results")) == 1
    run(t)


def test_duplicate_delivery_during_the_debate(run):
    async def t(store):
        bus = Bus(store)
        real = bus.send_and_wait

        async def twice(topic, value, key=None, headers=None):
            await real(topic, value)
            if not topic.endswith(".dlq"):
                bus.queue.append((topic, value))
        bus.send_and_wait = twice
        tid = await bus.request()
        await bus.drain()
        task = await store.get(tid)
        assert task["status"] == "AWAITING_APPROVAL" and types(task).count("vote.cast") == 3 and len(bus.sent("ai.results")) == 1
    run(t)


@pytest.mark.parametrize("stop_at", ["debate.round.0", "debate.round.2"])
def test_chair_restart_mid_debate_continues(run, stop_at):
    async def t(store):
        bus = Bus(store)
        tid = await bus.request()
        while bus.queue and bus.queue[0][0] != stop_at:
            head, rest = bus.queue[0], bus.queue[1:]
            bus.queue = [head]
            topic, value = bus.queue.pop()
            for a in bus.agents.values():
                if topic in a.subscribe:
                    await a.process(SimpleNamespace(topic=topic, value=value, key=b"", partition=0, offset=0))
            bus.queue = rest + bus.queue
        bus.agents["chair"] = ChairAgent(store, bus, availability=bus.agents["chair"].availability)  # nothing in memory
        await bus.drain()
        assert (await store.get(tid))["status"] == "AWAITING_APPROVAL"
    run(t)


@pytest.mark.parametrize("topic", ["debate.round.1", "ai.results"])
def test_publish_failure_is_retried_by_the_sweep(run, topic):
    async def t(store):
        bus = Bus(store)
        real, broken = bus.send_and_wait, [True]

        async def flaky(tp, value, key=None, headers=None):
            if tp == topic and broken[0]:
                raise ConnectionError("kafka down")
            await real(tp, value)
        bus.send_and_wait = flaky
        tid = await bus.request()
        await bus.drain()
        assert (await store.get(tid))["status"] in ("ROUND_2", "DECIDING")
        broken[0] = False
        await bus.agents["chair"].sweep()
        await bus.drain()
        task = await store.get(tid)
        assert task["status"] == "AWAITING_APPROVAL" and len(bus.sent("ai.results")) == 1
        assert bus.sent("ai.results")[0]["payload"]["ranked"] == task["result"]["ranked"]
    run(t)


def test_unavailable_winner_is_replaced(run):
    async def t(store):
        seen = []

        async def first_taken(pid, *_):
            seen.append(pid)
            return len(seen) > 1
        bus = Bus(store, availability=first_taken)
        tid = await bus.request(check_in="2027-01-05", check_out="2027-01-07")
        await bus.drain()
        r = (await store.get(tid))["result"]
        assert r["recommended"]["property_id"] == seen[1] and seen[0] not in r["ranked"]
        assert r["availability"] == "verified"
        assert {s["status"] for s in (await store.get(tid))["plan"]["steps"]} == {"done"}
        assert any("not free" in x for x in r["limitations"]) and r["rejected_alternative"]["property_id"] != seen[0]
    run(t)


def test_nothing_available_fails_the_task(run):
    async def t(store):
        async def taken(*_):
            return False
        bus = Bus(store, availability=taken)
        tid = await bus.request(check_in="2027-01-05", check_out="2027-01-07")
        await bus.drain()
        task = await store.get(tid)
        assert task["status"] == "FAILED" and task["errors"][-1]["code"] == "NO_AVAILABLE_PROPERTY" and not bus.sent("ai.results")
    run(t)


def test_unchecked_availability_is_a_limitation(run):
    async def t(store):
        bus = Bus(store)
        tid = await bus.request(check_in="2027-01-05", check_out="2027-01-07")
        await bus.drain()
        task = await store.get(tid)
        assert any("could not be verified" in x for x in task["result"]["limitations"])
        assert task["result"]["availability"] == "unverified" and task["plan"]["steps"][5]["status"] == "skipped"
    run(t)


def test_availability_is_unknown_when_not_configured_or_down(monkeypatch):
    args = ("prp_1", "2027-01-05", "2027-01-07", "gst_1", "t")
    assert asyncio.run(is_available(*args)) is None
    monkeypatch.setattr(config, "PROPERTY_SERVICE_URL", "http://127.0.0.1:1")
    assert asyncio.run(is_available(*args)) is None


def test_impossible_request_still_ends_with_an_honest_result(run):
    async def t(store):
        bus = Bus(store)
        tid = await bus.request("Fresno for 16 guests under $1 with a pool rated 5 stars")
        await bus.drain()
        r = (await store.get(tid))["result"]
        assert r["eligible_count"] == 0 and any("No property meets" in x for x in r["limitations"])
    run(t)


def test_a_spoofed_rejection_cannot_use_up_another_agents_retry(run):
    async def t(store):
        bus = Bus(store)

        def spoof(topic, v):
            e = json.loads(v)
            if topic == "debate.round.0" and e["actor_id"] == "agent:matching":
                e["payload"]["agent"] = "risk"
            return json.dumps(e).encode()
        bus.tamper = spoof
        tid = await bus.request()
        await bus.drain()
        task = await store.get(tid)
        assert "0:risk" not in task["retries"] and task["status"] == "AWAITING_APPROVAL"
        assert [a["status"] for a in task["agents"]] == ["timed_out", "published", "published"]
    run(t)


def test_round1_must_come_from_the_chair(run):
    async def t(store):
        bus = Bus(store, ("risk",))
        tid = await bus.request()
        task = await store.get(tid)
        env = create_envelope(event_type="debate.round.1", trace_id=task["trace_id"], actor_id="agent:matching", actor_type="agent",
                              entity_type="ai_task", entity_id=tid, payload={"challenges": []})
        bus.queue = [("debate.round.1", json.dumps(env).encode())]
        await bus.drain()
        assert len(bus.sent("debate.round.1.dlq")) == 1
    run(t)


def test_chair_topic_permissions():
    for topic in ("debate.round.1", "ai.results"):
        check_topic_allowed("chair", topic)
    with pytest.raises(PermissionError):
        check_topic_allowed("chair", "ai.approvals")
