"""Base Kafka agent: consume, validate envelope, drop other debates' traffic,
call handle(), publish replies with the same trace_id. Each agent runs as its
own process / container: python -m agents <name>."""
import asyncio
import json
import logging

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

from app import config
from app.envelope import create_envelope, validate_envelope

from .harness import check_topic_allowed

log = logging.getLogger("agents")


class BaseAgent:
    name = "base"
    subscribe: list[str] = []

    def __init__(self):
        self.producer: AIOKafkaProducer | None = None

    async def handle(self, env: dict, topic: str) -> None:
        raise NotImplementedError

    async def publish(self, topic: str, *, trace_id: str, task_id: str, payload: dict, idem: str):
        check_topic_allowed(self.name, topic)
        env = create_envelope(event_type=topic, trace_id=trace_id, actor_id=f"agent:{self.name}",
                              actor_type="agent", entity_type="ai_task", entity_id=task_id,
                              payload={"agent": self.name, **payload}, idempotency_key=idem)
        problems = validate_envelope(env, topic)
        if problems:
            raise ValueError("; ".join(problems))
        await self.producer.send_and_wait(topic, json.dumps(env).encode(), key=trace_id.encode())

    async def run(self):
        consumer = AIOKafkaConsumer(*self.subscribe, bootstrap_servers=config.KAFKA_BROKERS,
                                    group_id=f"agent-{self.name}-cg", enable_auto_commit=False)
        self.producer = AIOKafkaProducer(bootstrap_servers=config.KAFKA_BROKERS)
        await consumer.start()
        await self.producer.start()
        log.info("agent %s consuming %s", self.name, self.subscribe)
        try:
            async for msg in consumer:
                try:
                    env = json.loads(msg.value)
                    problems = validate_envelope(env, msg.topic)
                    if problems:
                        # TODO (slice 5): forward to <topic>.dlq with failure headers
                        log.warning("rejected envelope on %s: %s", msg.topic, problems)
                    else:
                        await self.handle(env, msg.topic)
                except Exception:  # noqa: BLE001
                    log.exception("agent %s failed on %s offset %s", self.name, msg.topic, msg.offset)
                await consumer.commit()
        finally:
            await consumer.stop()
            await self.producer.stop()


def main(agent_cls):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    asyncio.run(agent_cls().run())
