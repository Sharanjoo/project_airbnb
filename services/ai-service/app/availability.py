"""Plan step 6: is the recommended home still free? Read-only call to the Property
Service (it owns the calendar). Any failure means "unknown", never "free"."""
import httpx

from . import config


async def is_available(property_id: str, check_in: str, check_out: str, user_id: str, trace_id: str) -> bool | None:
    """True / False, or None when it could not be checked."""
    if not config.PROPERTY_SERVICE_URL:
        return None
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            r = await client.post(f"{config.PROPERTY_SERVICE_URL.rstrip('/')}/properties/availability",
                                  headers={"X-User-Id": user_id, "X-User-Role": "guest", "X-Trace-Id": trace_id},
                                  json={"property_id": property_id, "start_date": check_in, "end_date": check_out})
            if r.status_code == 410:
                return False
            r.raise_for_status()
            blocks = r.json()["data"]["unavailable"]
            # [start, end) ranges, like the client's calendar check.
            return not any(b["start_date"] < check_out and check_in < b["end_date"] for b in blocks)
    except (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError, TypeError):
        return None
