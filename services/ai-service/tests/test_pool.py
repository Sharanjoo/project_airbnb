import copy
import json

import pytest

from app import config
from app.pool import PoolError, PropertyPool, load_pool, read_pool

RAW = json.loads(config.PROPERTY_POOL_PATH.read_text())


def test_loads_the_200_property_pool():
    pool = load_pool()
    assert pool.ref == "active-pool-v1" and len(pool.ids) == 200 and len(pool.cities) == 10
    assert pool.city("  san   JOSE ") == "San Jose" and pool.city("Paris") is None
    assert any(p["rating"] is None for p in pool.properties)  # new listings are valid


@pytest.mark.parametrize("field,value", [("property_id", ""), ("capacity", 0), ("capacity", "2"), ("nightly_price", -1),
                                         ("rating", 6), ("review_count", -1), ("amenities", ["sauna"]), ("city", None)])
def test_bad_rows_are_rejected(field, value):
    bad = copy.deepcopy(RAW)
    bad["properties"][0][field] = value
    with pytest.raises(PoolError):
        PropertyPool(bad)


def test_bad_files_are_rejected(tmp_path):
    f = tmp_path / "pool.json"
    for text in ("{", "[]", "{}", json.dumps({**RAW, "count": 5}),
                 json.dumps({**RAW, "properties": RAW["properties"][:1] * 200})):
        f.write_text(text)
        with pytest.raises(PoolError):
            read_pool(f)
    with pytest.raises(PoolError):
        read_pool(tmp_path / "missing.json")
