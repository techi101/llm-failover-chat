"""FastAPI app: GET /health, POST /chat, GET /sessions/{session_id}/messages."""
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import load_settings
from .db import Database
from .llm import AllProvidersUnavailable, Gateway, parse_simulation_header

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = load_settings()
db = Database(settings.sqlite_path)
gateway = Gateway(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()  # schema created automatically on startup
    yield


app = FastAPI(title="LLM Chatbot with Key Failover and Response Caching", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Simulate-Failure"],
)


# ---- errors: always JSON with a `detail` field, never a stack trace -----------
@app.exception_handler(StarletteHTTPException)
async def _http_error(_: Request, exc: StarletteHTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError):
    errors = [{k: v for k, v in e.items() if k in ("type", "loc", "msg")} for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


@app.exception_handler(Exception)
async def _unhandled(_: Request, exc: Exception):
    logging.getLogger("app").exception("unhandled error")
    return JSONResponse({"detail": "internal server error"}, status_code=500)


# ---- schemas -------------------------------------------------------------------
class ChatRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=128)
    message: str
    system_prompt: str | None = Field(default=None, max_length=4000)

    @field_validator("session_id")
    @classmethod
    def _sid(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("session_id must not be blank")
        return v

    @field_validator("message")
    @classmethod
    def _msg(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("message must not be empty")
        if len(v) > 4000:
            raise ValueError("message must be at most 4000 characters")
        return v


# ---- routes --------------------------------------------------------------------
@app.get("/health")
def health():
    db_ok = db.ping()
    keys = len(settings.key_pool)
    body = {
        "status": "ok",
        "keys_configured": keys,
        "cache_enabled": gateway.cache_enabled,
        # extra (allowed) field: ids and models only, never the secret
        "keys": [{"key_id": s.key_id, "model": s.model} for s in settings.key_pool],
        "failure_simulation": settings.enable_failure_simulation,
    }
    if not db_ok or keys == 0:
        body["status"] = "degraded"
        body["detail"] = "database unreachable" if not db_ok else "no API keys configured"
        return JSONResponse(body, status_code=503)
    return body


@app.post("/chat")
async def chat(req: ChatRequest, x_simulate_failure: str | None = Header(default=None)):
    started = time.perf_counter()

    custom_prompt = req.system_prompt.strip() if req.system_prompt and req.system_prompt.strip() else None
    system_prompt = custom_prompt or db.get_system_prompt(req.session_id) or settings.default_system_prompt
    messages = [{"role": "system", "content": system_prompt}]
    messages += [{"role": m["role"], "content": m["content"]} for m in db.history(req.session_id)]
    messages.append({"role": "user", "content": req.message})

    simulate = parse_simulation_header(x_simulate_failure) if settings.enable_failure_simulation else {}
    try:
        result = await gateway.complete(messages, simulate)
    except AllProvidersUnavailable:
        # Nothing is written to history for a failed request.
        return JSONResponse({"detail": "all providers unavailable"}, status_code=503)

    metadata = {
        "resolution_source": result.resolution_source,
        "model": result.model,
        "latency_ms": int(round((time.perf_counter() - started) * 1000)),
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "key_id": result.key_id,
        "fallback_attempts": result.fallback_attempts,
    }
    db.save_turn(req.session_id, req.message, result.reply, metadata, custom_prompt)
    return {"session_id": req.session_id, "reply": result.reply, "metadata": metadata}


@app.get("/sessions/{session_id}/messages")
def session_messages(session_id: str):
    if not db.session_exists(session_id):
        return JSONResponse({"detail": "session not found"}, status_code=404)
    return {"session_id": session_id, "messages": db.history(session_id)}
