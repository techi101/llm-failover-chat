"""All configuration comes from environment variables."""
import os
from dataclasses import dataclass, field


def _csv(name: str, default: str = "") -> list[str]:
    return [p.strip() for p in os.getenv(name, default).split(",") if p.strip()]


def _bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class KeySlot:
    """One entry of the key pool. The secret never leaves this object."""
    key_id: str
    model: str
    api_key: str = field(repr=False)


@dataclass(frozen=True)
class Settings:
    database_url: str
    allowed_origins: list[str]
    enable_failure_simulation: bool
    default_model: str
    default_system_prompt: str
    cache_ttl_seconds: float
    request_timeout: float
    max_output_tokens: int
    key_pool: list[KeySlot]

    @property
    def sqlite_path(self) -> str:
        # sqlite:////data/app.db -> /data/app.db ; sqlite:///./app.db -> ./app.db
        url = self.database_url
        if url.startswith("sqlite:///"):
            return url[len("sqlite:///"):]
        if url.startswith("sqlite://"):
            return url[len("sqlite://"):]
        return url


def load_settings() -> Settings:
    model = os.getenv("LLM_MODEL", "gemini/gemini-2.5-flash").strip()
    keys = _csv("LLM_API_KEYS")
    # Optional: give each key its own model (same order as LLM_API_KEYS).
    per_key_models = _csv("LLM_KEY_MODELS")
    pool = [
        KeySlot(
            key_id=f"key_{i + 1}",
            model=per_key_models[i] if i < len(per_key_models) else model,
            api_key=k,
        )
        for i, k in enumerate(keys)
    ]
    return Settings(
        database_url=os.getenv("DATABASE_URL", "sqlite:///./data/app.db"),
        allowed_origins=_csv("ALLOWED_ORIGINS", "http://localhost:3000"),
        enable_failure_simulation=_bool("ENABLE_FAILURE_SIMULATION"),
        default_model=model,
        default_system_prompt=os.getenv(
            "DEFAULT_SYSTEM_PROMPT",
            "You are a helpful, concise assistant. Answer clearly and keep replies short unless asked for detail.",
        ),
        cache_ttl_seconds=float(os.getenv("LLM_CACHE_TTL_SECONDS", "86400")),
        request_timeout=float(os.getenv("LLM_TIMEOUT_SECONDS", "30")),
        max_output_tokens=int(os.getenv("LLM_MAX_OUTPUT_TOKENS", "1024")),
        key_pool=pool,
    )
