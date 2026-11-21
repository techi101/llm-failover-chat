"""LiteLLM gateway: ordered key-pool failover plus LiteLLM's built-in response cache."""
import logging
from dataclasses import dataclass

import httpx
import litellm
from litellm.caching.caching import Cache

from .config import KeySlot, Settings

log = logging.getLogger("gateway")
litellm.suppress_debug_info = True
litellm.drop_params = True  # ignore params a provider does not support

SIMULATABLE = {429, 500, 502, 503}


class AllProvidersUnavailable(Exception):
    """Every key in the pool failed for this request."""


@dataclass
class Completion:
    reply: str
    model: str
    input_tokens: int
    output_tokens: int
    resolution_source: str  # LIVE_INFERENCE | LLM_CACHE
    key_id: str | None
    fallback_attempts: int


def parse_simulation_header(value: str | None) -> dict[str, int]:
    """'key_1=429,key_2=500' or '*=429' -> {'key_1': 429, ...}. Bad pairs are ignored."""
    rules: dict[str, int] = {}
    if not value:
        return rules
    for part in value.split(","):
        if "=" not in part:
            continue
        key_id, _, status = part.partition("=")
        key_id, status = key_id.strip(), status.strip()
        if key_id and status.isdigit() and int(status) in SIMULATABLE:
            rules[key_id] = int(status)
    return rules


def simulated_error(status: int, slot: KeySlot) -> Exception:
    """Build the same exception LiteLLM raises when a provider returns `status`."""
    provider = slot.model.split("/")[0] if "/" in slot.model else "openai"
    msg = f"simulated HTTP {status} for {slot.key_id}"
    resp = httpx.Response(status, request=httpx.Request("POST", "https://simulated.local"))
    kwargs = dict(message=msg, llm_provider=provider, model=slot.model, response=resp)
    if status == 429:
        return litellm.RateLimitError(**kwargs)
    if status == 502:
        return litellm.BadGatewayError(**kwargs)
    if status == 503:
        return litellm.ServiceUnavailableError(**kwargs)
    return litellm.InternalServerError(**kwargs)


class Gateway:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.pool = settings.key_pool
        # LiteLLM in-memory cache (this LiteLLM release no longer ships a disk cache).
        self.cache = Cache(type="local", default_in_memory_ttl=settings.cache_ttl_seconds)
        self.cache_enabled = True

    # ---- cache ---------------------------------------------------------------
    def cache_key(self, model: str, messages: list[dict]) -> str:
        # Key = model + full message list (system + history + new message).
        # The API key is deliberately NOT part of it, so any key's answer can be reused.
        return self.cache.get_cache_key(model=model, messages=messages)

    def _cache_get(self, model: str, messages: list[dict]) -> dict | None:
        hit = self.cache.get_cache(cache_key=self.cache_key(model, messages))
        return hit if isinstance(hit, dict) and hit.get("reply") else None

    def _cache_put(self, model: str, messages: list[dict], entry: dict) -> None:
        self.cache.cache.set_cache(self.cache_key(model, messages), entry)

    # ---- inference -----------------------------------------------------------
    async def complete(self, messages: list[dict], simulate: dict[str, int] | None = None) -> Completion:
        simulate = simulate or {}

        # A simulated-failure request must exercise the key pool, so it skips the cache read.
        if not simulate:
            for model in dict.fromkeys(s.model for s in self.pool):
                hit = self._cache_get(model, messages)
                if hit:
                    return Completion(
                        reply=hit["reply"],
                        model=hit["model"],
                        input_tokens=int(hit["input_tokens"]),
                        output_tokens=int(hit["output_tokens"]),
                        resolution_source="LLM_CACHE",
                        key_id=None,
                        fallback_attempts=0,
                    )

        failures = 0
        for slot in self.pool:
            status = simulate.get(slot.key_id, simulate.get("*"))
            try:
                resp = await litellm.acompletion(
                    model=slot.model,
                    messages=messages,
                    api_key=slot.api_key,
                    timeout=self.settings.request_timeout,
                    max_tokens=self.settings.max_output_tokens,
                    num_retries=0,  # fail over to the next key instead of retrying this one
                    mock_response=simulated_error(status, slot) if status else None,
                )
                reply = (resp.choices[0].message.content or "").strip()
                if not reply:
                    raise ValueError("empty completion")
            except Exception as exc:  # 429 / quota / 5xx / timeout / bad key -> next key
                failures += 1
                log.warning("key %s failed (%s): %s", slot.key_id, type(exc).__name__, str(exc)[:200])
                continue

            usage = getattr(resp, "usage", None)
            input_tokens = getattr(usage, "prompt_tokens", None)
            output_tokens = getattr(usage, "completion_tokens", None)
            if input_tokens is None:
                input_tokens = litellm.token_counter(model=slot.model, messages=messages)
            if output_tokens is None:
                output_tokens = litellm.token_counter(model=slot.model, text=reply)

            entry = {
                "reply": reply,
                "model": slot.model,
                "input_tokens": int(input_tokens),
                "output_tokens": int(output_tokens),
            }
            self._cache_put(slot.model, messages, entry)
            return Completion(
                **entry,
                resolution_source="LIVE_INFERENCE",
                key_id=slot.key_id,
                fallback_attempts=failures,
            )

        raise AllProvidersUnavailable()
