"""Base Kafka agent: consume, validate envelope, drop other debates' traffic,
call handle(), publish replies with the same trace_id. Each agent runs as its
own process / container: python -m agents <name>.

Delivery rules (API doc §10): commit only after handle() finished or the message
is in <topic>.dlq; transient errors retry 3 times; permanent errors go to the DLQ
at once. handle() can see a message twice and must be idempotent."""
import asyncio
import json
import logging
import random
from datetime import datetime, timezone

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.errors import CommitFailedError

from app import config
from app.envelope import create_envelope, validate_envelope
from app.store import OPEN_STATUSES, MongoTaskStore

from .harness import check_topic_allowed

log = logging.getLogger("agents")

MAX_RETRIES = 3
BASE_DELAY_S = 0.2
SCHEMA_VERSION = 1


class PermanentError(Exception):
    """Retrying cannot help: send the message straight to the DLQ."""


class BaseAgent:
    name = "base"
    group: str | None = None  # consumer group, agent-<name>-cg unless set (API doc §11)
    subscribe: list[str] = []

    def __init__(self, store=None, producer=None):
        self.store = store
        self.producer = producer

    @property
    def group_id(self) -> str:
        return self.group or f"agent-{self.name}-cg"

    async def handle(self, env: dict, topic: str) -> None:
        raise NotImplementedError

    async def open_task(self, env: dict) -> dict | None:
        """The task this message belongs to, or None to drop it (trace isolation, §11)."""
        task = await self.store.get(env["entity"]["entity_id"])
        if task and task["trace_id"] == env["trace_id"] and task["status"] in OPEN_STATUSES:
            return task
        log.info("cross_trace_dropped agent=%s trace_id=%s task_id=%s", self.name, env["trace_id"], env["entity"]["entity_id"])
        return None

    async def publish(self, topic: str, *, trace_id: str, task_id: str, payload: dict, idem: str):
        check_topic_allowed(self.name, topic)
        env = create_envelope(event_type=topic, trace_id=trace_id, actor_id=f"agent:{self.name}",
                              actor_type="agent", entity_type="ai_task", entity_id=task_id,
                              payload={**payload, "agent": self.name}, idempotency_key=idem)
        problems = validate_envelope(env, topic)
        if problems:
            raise PermanentError("; ".join(problems))
        await self.producer.send_and_wait(topic, json.dumps(env).encode(), key=trace_id.encode())

    async def send_to_dlq(self, msg, reason: str):
        headers = {"failure_reason": reason[:1000], "failed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                   "consumer_group": self.group_id, "source_topic": msg.topic,
                   "source_partition": str(msg.partition), "source_offset": str(msg.offset)}
        await self.producer.send_and_wait(f"{msg.topic}.dlq", msg.value, key=msg.key,
                                          headers=[(k, v.encode()) for k, v in headers.items()])
        log.warning("agent %s sent %s offset %s to DLQ: %s", self.name, msg.topic, msg.offset, reason)

    async def process(self, msg) -> str:
        """One message, start to finish. Returns 'ok' or 'dlq'."""
        try:
            env = json.loads(msg.value)
        except (ValueError, TypeError):
            await self.send_to_dlq(msg, "malformed JSON")
            return "dlq"
        problems = validate_envelope(env, msg.topic)
        if not problems and env["schema_version"] != SCHEMA_VERSION:
            problems = [f"unknown schema_version {env['schema_version']}"]
        if problems:
            await self.send_to_dlq(msg, f"invalid envelope: {'; '.join(problems)}")
            return "dlq"
        for attempt in range(MAX_RETRIES + 1):
            try:
                await self.handle(env, msg.topic)
                return "ok"
            except Exception as exc:  # noqa: BLE001
                log.exception("agent %s failed on %s trace_id=%s attempt=%s", self.name, msg.topic, env["trace_id"], attempt)
                if isinstance(exc, (PermanentError, PermissionError)) or attempt == MAX_RETRIES:
                    await self.send_to_dlq(msg, f"{type(exc).__name__}: {exc}")
                    return "dlq"
                await asyncio.sleep(BASE_DELAY_S * 2 ** attempt + random.uniform(0, BASE_DELAY_S))

    async def run(self):
        if self.store is None:
            self.store = MongoTaskStore(config.MONGO_URL, config.MONGO_DB)
        await self.store.start()
        # earliest: a request published before this group first joined is still
        # handled. Old tasks are closed by then and dropped by open_task().
        consumer = AIOKafkaConsumer(*self.subscribe, bootstrap_servers=config.KAFKA_BROKERS, group_id=self.group_id,
                                    enable_auto_commit=False, auto_offset_reset="earliest")
        self.producer = AIOKafkaProducer(bootstrap_servers=config.KAFKA_BROKERS, enable_idempotence=True)
        try:
            await self.producer.start()
            await consumer.start()
            log.info("agent %s consuming %s as %s", self.name, self.subscribe, self.group_id)
            async for msg in consumer:
                await self.process(msg)
                try:
                    await consumer.commit()
                except CommitFailedError:
                    log.warning("agent %s rebalanced before commit; the message will be redelivered", self.name)
        finally:
            await consumer.stop()
            await self.producer.stop()
            await self.store.stop()


def main(agent_cls):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    asyncio.run(agent_cls().run())
