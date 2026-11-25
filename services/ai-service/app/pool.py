"""The fixed property pool the agents rank (data/property-pool-200.json, made by
Slice 2). Loaded once and checked strictly: a bad pool should stop an agent at
startup, not produce odd recommendations later."""
import json
from functools import lru_cache
from pathlib import Path

from . import config

AMENITIES = ("wifi", "kitchen", "parking", "washer", "ac", "heating", "pool", "pet_friendly", "workspace", "self_checkin")


class PoolError(Exception):
    pass


def _number(value, lo, hi=float("inf")) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and lo <= value <= hi


def _problem(p) -> str | None:
    if not isinstance(p, dict):
        return "not an object"
    if not isinstance(p.get("property_id"), str) or not p["property_id"]:
        return "property_id is missing"
    for field in ("title", "city", "property_type"):
        if not isinstance(p.get(field), str) or not p[field]:
            return f"{field} is missing"
    if not isinstance(p.get("capacity"), int) or not _number(p["capacity"], 1):
        return "capacity must be a whole number, 1 or more"
    if not _number(p.get("nightly_price"), 0.01):
        return "nightly_price must be positive"
    if not isinstance(p.get("amenities"), list) or not set(p["amenities"]) <= set(AMENITIES):
        return "amenities has an unknown value"
    # New listings have no rating yet: null is valid, missing is not.
    if "rating" not in p or (p["rating"] is not None and not _number(p["rating"], 0, 5)):
        return "rating must be null or 0 to 5"
    if not isinstance(p.get("review_count"), int) or not _number(p["review_count"], 0):
        return "review_count must be 0 or more"
    return None


class PropertyPool:
    def __init__(self, data: dict):
        rows = data.get("properties") if isinstance(data, dict) else None
        if not isinstance(rows, list) or not rows:
            raise PoolError("pool has no properties list")
        for i, row in enumerate(rows):
            if problem := _problem(row):
                raise PoolError(f"properties[{i}]: {problem}")
        if data.get("count") != len(rows):
            raise PoolError(f"count is {data.get('count')} but there are {len(rows)} properties")
        self.ref = data.get("pool_ref")
        if not self.ref:
            raise PoolError("pool_ref is missing")
        self.properties: list[dict] = rows
        self.by_id = {p["property_id"]: p for p in rows}
        if len(self.by_id) != len(rows):
            raise PoolError("duplicate property_id")
        self.ids = frozenset(self.by_id)
        self.cities = sorted({p["city"] for p in rows})

    def city(self, name: str) -> str | None:
        """The pool's spelling of a city, or None when it has no listings there."""
        wanted = " ".join(name.lower().split())
        return next((c for c in self.cities if c.lower() == wanted), None)


def read_pool(path: Path) -> PropertyPool:
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise PoolError(f"cannot read property pool {path}: {exc}") from exc
    return PropertyPool(data)


@lru_cache(maxsize=1)
def load_pool() -> PropertyPool:
    return read_pool(config.PROPERTY_POOL_PATH)
