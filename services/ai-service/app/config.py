import os
from pathlib import Path

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9094")
KAFKA_ENABLED = os.getenv("KAFKA_ENABLED", "true").lower() == "true"
# false = in-memory task store (offline tests only: agents are separate processes and cannot see it)
MONGO_ENABLED = os.getenv("MONGO_ENABLED", "true").lower() == "true"
MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27018")
MONGO_DB = os.getenv("MONGO_DB", "airbnb")
CONFIG_VERSION = os.getenv("AI_CONFIG_VERSION", "matcher-v1")
JWT_SECRET = os.getenv("JWT_SECRET", "change-me-dev-secret")

# Below the gateway's 3 s proxy timeout, so a Kafka outage returns 503 from here
PUBLISH_TIMEOUT_S = float(os.getenv("PUBLISH_TIMEOUT_S", "2"))

# Debate deadlines (API doc §11)
ROUND0_DEADLINE_S = float(os.getenv("ROUND0_DEADLINE_S", "20"))
ROUND2_DEADLINE_S = float(os.getenv("ROUND2_DEADLINE_S", "15"))
MAX_OPEN_TASKS_PER_USER = int(os.getenv("MAX_OPEN_TASKS_PER_USER", "3"))

# Optional LLM (app/llm.py). "none" = deterministic, no model needed.
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "none").strip().lower()
LLM_MODEL = os.getenv("LLM_MODEL", "llama3.2:3b")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:11434")
LLM_TIMEOUT_S = float(os.getenv("LLM_TIMEOUT_S", "15"))  # on timeout the parser falls back to rules

# contracts/ lives at the repo root locally, /app/contracts in Docker
CONTRACTS_DIR = Path(os.getenv("CONTRACTS_DIR", Path(__file__).resolve().parents[3] / "contracts"))

# data/ lives at the repo root locally, /app/data in Docker
PROPERTY_POOL_PATH = Path(os.getenv("PROPERTY_POOL_PATH", CONTRACTS_DIR.parent / "data" / "property-pool-200.json"))
