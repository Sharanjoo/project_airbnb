"""Kafka producer for the AI API. Key = trace_id so one debate stays on one
partition (trace isolation, API doc §11). KAFKA_ENABLED=false keeps tests offline."""
import json

from aiokafka import AIOKafkaProducer

from . import config
from .envelope import validate_envelope


class InvalidEnvelope(Exception):
    pass


class Bus:
    def __init__(self):
        self.producer = None
        self.sent: list[tuple[str, dict]] = []  # used when Kafka is disabled (tests)

    async def start(self):
        if config.KAFKA_ENABLED and self.producer is None:
            self.producer = AIOKafkaProducer(bootstrap_servers=config.KAFKA_BROKERS, enable_idempotence=True)
            await self.producer.start()

    async def stop(self):
        if self.producer:
            await self.producer.stop()

    async def publish(self, topic: str, env: dict):
        problems = validate_envelope(env, topic)
        if problems:
            raise InvalidEnvelope("; ".join(problems))
        if not config.KAFKA_ENABLED:
            self.sent.append((topic, env))
            return
        await self.producer.send_and_wait(topic, json.dumps(env).encode(), key=env["trace_id"].encode())
