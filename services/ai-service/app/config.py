import os
from pathlib import Path

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9094")
KAFKA_ENABLED = os.getenv("KAFKA_ENABLED", "true").lower() == "true"
MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27018")
MONGO_DB = os.getenv("MONGO_DB", "airbnb")
CONFIG_VERSION = os.getenv("AI_CONFIG_VERSION", "matcher-v1")
JWT_SECRET = os.getenv("JWT_SECRET", "change-me-dev-secret")

# Debate deadlines (API doc §11)
ROUND0_DEADLINE_S = float(os.getenv("ROUND0_DEADLINE_S", "20"))
ROUND2_DEADLINE_S = float(os.getenv("ROUND2_DEADLINE_S", "15"))
MAX_OPEN_TASKS_PER_USER = int(os.getenv("MAX_OPEN_TASKS_PER_USER", "3"))

# contracts/ lives at the repo root locally, /app/contracts in Docker
CONTRACTS_DIR = Path(os.getenv("CONTRACTS_DIR", Path(__file__).resolve().parents[3] / "contracts"))
