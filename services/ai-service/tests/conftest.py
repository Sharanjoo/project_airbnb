"""Unit tests run offline. Set before any test imports app.config."""
import os

os.environ["KAFKA_ENABLED"] = "false"
os.environ["MONGO_ENABLED"] = "false"
