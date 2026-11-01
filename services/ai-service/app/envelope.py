"""Shared Kafka envelope, validated against contracts/envelope.schema.json
(the same file the Node services use)."""
import json
import uuid
from datetime import datetime, timedelta, timezone

from jsonschema import Draft7Validator

from .config import CONTRACTS_DIR

_SCHEMA = json.loads((CONTRACTS_DIR / "envelope.schema.json").read_text())
_VALIDATOR = Draft7Validator(_SCHEMA)
MAX_FUTURE = timedelta(minutes=5)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_envelope(*, event_type, trace_id, actor_id, actor_type, entity_type, entity_id,
                    payload, idempotency_key=None, schema_version=1) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "schema_version": schema_version,
        "trace_id": trace_id,
        "timestamp": utc_now_iso(),
        "actor_id": actor_id,
        "actor_type": actor_type,
        "entity": {"entity_type": entity_type, "entity_id": entity_id},
        "payload": payload,
        "idempotency_key": idempotency_key or str(uuid.uuid4()),
    }


def validate_envelope(env, topic: str | None = None) -> list[str]:
    """Return a list of problems; empty list means valid."""
    errors = [f"/{'/'.join(map(str, e.path))} {e.message}" for e in _VALIDATOR.iter_errors(env)]
    if errors:
        return errors
    ts = datetime.fromisoformat(env["timestamp"].replace("Z", "+00:00"))
    if ts - datetime.now(timezone.utc) > MAX_FUTURE:
        errors.append("/timestamp is more than 5 minutes in the future")
    if topic and env["event_type"] != topic.removesuffix(".dlq"):
        errors.append(f'/event_type "{env["event_type"]}" does not match topic "{topic}"')
    return errors
