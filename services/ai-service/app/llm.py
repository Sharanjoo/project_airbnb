"""Optional LLM, chosen by LLM_PROVIDER. Nothing else in the service knows which
provider is used: to switch, add a class with complete_json() and list it in
PROVIDERS. With LLM_PROVIDER=none the system is fully deterministic."""
import json

import httpx

from . import config


class LLMError(Exception):
    """The provider is down, slow, or returned something that is not JSON."""


class OllamaProvider:
    name = "ollama"

    async def complete_json(self, system: str, user: str, schema: dict) -> dict:
        body = {"model": config.LLM_MODEL, "stream": False, "format": schema, "options": {"temperature": 0, "seed": 42},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        try:
            async with httpx.AsyncClient(timeout=config.LLM_TIMEOUT_S) as client:
                r = await client.post(f"{config.LLM_BASE_URL.rstrip('/')}/api/chat", json=body)
                r.raise_for_status()
                data = json.loads(r.json()["message"]["content"])
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError, TypeError) as exc:
            raise LLMError(f"{type(exc).__name__}: {exc}") from exc
        if not isinstance(data, dict):
            raise LLMError("response is not a JSON object")
        return data


PROVIDERS = {"ollama": OllamaProvider}


def get_provider():
    """The configured provider, or None for deterministic mode."""
    name = config.LLM_PROVIDER
    if name in ("", "none", "mock", "deterministic"):
        return None
    if name not in PROVIDERS:
        raise ValueError(f"unknown LLM_PROVIDER {name!r}, use none or one of {sorted(PROVIDERS)}")
    return PROVIDERS[name]()
