# LLM Chatbot with Key Failover and Response Caching

[![ci](https://github.com/techi101/llm-failover-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/techi101/llm-failover-chat/actions/workflows/ci.yml)

A small full-stack AI chat app: **React** frontend, **FastAPI** backend, **LiteLLM** gateway with a key pool and automatic failover, LiteLLM's built-in **response cache**, and **SQLite** session storage. Every reply shows where it came from (`LIVE_INFERENCE` or `LLM_CACHE`), the model, the latency and the input/output tokens of that request only.

```
React (Vite)  ──POST /chat──▶  FastAPI ──▶ LiteLLM Cache (model + full message list)
                                  │            │ miss
                                  │            ▼
                                  │      key_1 ──429/quota/5xx──▶ key_2 ──▶ ... ──▶ 503
                                  ▼
                               SQLite (/data/app.db): sessions + messages
```

## 1. Live URLs

| Tier | URL |
|---|---|
| Frontend | https://llm-failover-chat.vercel.app |
| Backend | https://llm-failover-chat-api.vercel.app |
| Health | https://llm-failover-chat-api.vercel.app/health |
| API docs (Swagger) | https://llm-failover-chat-api.vercel.app/docs |
| Repository | https://github.com/techi101/llm-failover-chat |
| Demo video | https://llm-failover-chat-demo.vercel.app (MP4 also on the v1.0 release) |

`ENABLE_FAILURE_SIMULATION=true` is set on the deployed backend, so the `X-Simulate-Failure` hook works live.

**Deployed key pool** (two keys on two providers, so failover also survives a whole-provider outage):

| Key id | LiteLLM model | Provider |
|---|---|---|
| `key_1` | `gemini/gemini-3.1-flash-lite` | Google AI Studio |
| `key_2` | `groq/openai/gpt-oss-120b` | Groq |

key_1 was picked after timing current Gemini models: flash-lite is a stable release that answers in about 1–3 s. A per-key timeout of 12 s means a hanging provider fails over quickly instead of making the user wait.

## 2. Run locally: with Docker and without

### With Docker (recommended)

```bash
cp .env.example .env        # put at least 2 keys in LLM_API_KEYS
make up                     # builds both images and starts them
# frontend: http://localhost:3000   backend: http://localhost:8000
make down
```

`make up` copies `.env.example` to `.env` if you forgot. The SQLite file lives in the named volume `chat_data` mounted at `/data` (`DATABASE_URL=sqlite:////data/app.db`), so history survives `make down && make up`.

Both Dockerfiles are multi-stage:
- **backend**: `python:3.12-slim` builder creates a virtualenv; the runtime stage copies only the venv and `app/`, runs as a non-root user, and has a `HEALTHCHECK` on `/health`.
- **frontend**: `node:22-alpine` builds the Vite bundle; the runtime stage is `nginx:alpine` serving static files on port 3000. The backend URL comes from the `API_URL` env var at container start (written to `/config.js`), so one image works against any backend.

**Verified in CI** (`.github/workflows/ci.yml`, every push): on a clean Ubuntu runner it runs `make up`, then checks backend `:8000/health` (2 keys, cache on), a 422 and a 404, the frontend on `:3000` and its runtime `config.js`. It confirms `/data/app.db` sits in the `chat_data` volume and survives `make down && make up`. Image sizes: frontend 74 MB (nginx:alpine), backend about 700 MB, almost all of it LiteLLM's own dependencies.

### Without Docker

```bash
# backend
cd backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
export LLM_API_KEYS=key-one,key-two DATABASE_URL=sqlite:///./data/app.db ENABLE_FAILURE_SIMULATION=true
uvicorn app.main:app --port 8000
pytest -q                                         # 26 tests, no network or real keys needed

# frontend (new terminal)
cd frontend
npm install
VITE_API_URL=http://localhost:8000 npm run dev    # http://localhost:5173
```

### Environment variables

| Variable | Meaning |
|---|---|
| `LLM_API_KEYS` | Comma-separated key pool (at least 2). Ids are `key_1`, `key_2`, ... in this order. |
| `LLM_MODEL` | LiteLLM model name, default `gemini/gemini-3.1-flash-lite`. |
| `LLM_KEY_MODELS` | Optional, one model per key (same order) to mix models or providers in one pool. |
| `DATABASE_URL` | SQLite location, e.g. `sqlite:////data/app.db`. |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins. |
| `ENABLE_FAILURE_SIMULATION` | `true` enables the `X-Simulate-Failure` hook. |
| `DEFAULT_SYSTEM_PROMPT`, `LLM_CACHE_TTL_SECONDS`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_OUTPUT_TOKENS` | Optional tuning. |
| `PUBLIC_API_URL` / `VITE_API_URL` | Backend URL for the frontend (Docker runtime / static build). |

## 3. Design decisions

### Key fallback

- The pool is built from `LLM_API_KEYS`; each entry becomes a `KeySlot(key_id, model, api_key)`. The secret never leaves that object: responses, logs and `/health` only ever show `key_1`, `key_2`, ...
- `backend/app/llm.py` builds a **LiteLLM `Router`** with one deployment per key (`model_name` = `key_1`, `key_2`, ...; `model_info.id` = the key id) and a fallback chain `key_1 → key_2 → ... → key_n`. Settings: `num_retries=0` (never retry a key that just failed; move on) and `disable_cooldowns=True` (every request starts on key_1, so the order is deterministic and a simulated failure never leaks into later requests). A per-key `timeout` (12 s) turns a hanging provider into a quick failover.
- LiteLLM normalises every provider's errors into typed exceptions (`RateLimitError` for 429 and quota exhaustion, `InternalServerError`, `BadGatewayError`, `ServiceUnavailableError`, timeouts, connection and auth errors). The Router falls back on any of them. The answering key comes from `response._hidden_params["model_id"]`.
- `fallback_attempts` counts the keys that failed before the one that answered. The chain is ordered, so that is the answering key's position in the pool. If every key fails, the API returns `503 {"detail": "all providers unavailable"}` and **nothing is written** to history: the user and assistant messages are saved together in one transaction only after a successful reply.
- **Failover test hook.** With `ENABLE_FAILURE_SIMULATION=true`, `X-Simulate-Failure: key_1=429,key_2=500` (or `*=429`) is parsed per request, and a short-lived Router is built for that request in which each listed key's deployment carries LiteLLM's `mock_response=<RateLimitError | InternalServerError | BadGatewayError | ServiceUnavailableError>` with the exact status. LiteLLM raises it *inside its own call path*, exactly where a real provider error would surface, and the Router's normal fallback logic handles it. Keys not listed make real calls, so a simulated request always returns a real answer. Invalid pairs are ignored, and the header is ignored when the switch is off. (Checked: building these Routers adds no global LiteLLM callbacks, so nothing leaks between requests.)
- A request carrying a simulation header **skips the cache read** (it still writes the cache). Otherwise a previously cached message would answer with `key_id: null` and the failover could not be demonstrated.
- Every error is JSON with a `detail` field: validation (422), unknown session (404), all keys down (503), and a catch-all handler (500) that logs the trace server-side and never returns it.

### Caching

- LiteLLM's built-in `litellm.caching.Cache` (in-memory, TTL configurable) is used through its own API: `cache.get_cache_key(model=..., messages=...)`, `get_cache`, `set_cache`.
- The cache key is **model + the full message list sent to the LLM** (system prompt + stored history + new message). The same first message in a new session therefore hits the cache, while a different message, different history or different system prompt never does.
- The key is built explicitly instead of turning on `litellm.cache` globally, because LiteLLM's automatic key includes request params such as `api_key`. A reply produced by `key_1` would then be invisible to a request routed to `key_2`, which breaks the "same first message returns `LLM_CACHE`" rule after a failover.
- The cache entry stores the reply text, the model and the usage of the original call. A hit returns the **identical text**, the **stored tokens**, `key_id: null`, `fallback_attempts: 0`, and is a local memory lookup, so it is far faster than a live call.
- Pool with several models: the lookup checks each distinct model in pool order.
- LiteLLM 1.110 no longer ships the disk cache type, so the in-memory cache is used. The spec allows either. On a restart the cache is empty but the SQLite history is kept.

### SQLite session storage

- `DATABASE_URL` points at the SQLite file; the schema is created on startup (`CREATE TABLE IF NOT EXISTS`). `messages` follows the required data model exactly, with an index on `(session_id, id)`. A small `sessions` table remembers a custom system prompt per session.
- Multi-turn: the client sends only the new message. The backend loads the session history from SQLite, prepends the system prompt and appends the new message.
- `GET /sessions/{id}/messages` returns the history oldest-first without the system prompt; assistant messages carry their metadata. Unknown ids return `404 {"detail": "session not found"}`.
- `system_prompt` on `/chat` overrides the default and is stored for the session, so later turns keep it without resending.
- Each request opens a short-lived connection (WAL mode), which keeps the code simple and safe under FastAPI's threadpool.
- Hosting note: the live backend runs on Vercel's Python runtime, whose filesystem is per-instance, so the live SQLite file is in `/tmp` and lasts while the instance is warm. The Docker setup is the durable one, with the named volume at `/data`.

### Validation

`session_id` 1–128 chars (not blank), `message` 1–4000 chars **after trimming**, optional `system_prompt`. Malformed JSON, missing fields and blank values return FastAPI's 422 shape.

## 4. Verification

```bash
B=https://llm-failover-chat-api.vercel.app

curl $B/health
# {"status":"ok","keys_configured":2,"cache_enabled":true}

# Cache: same first message in two new sessions
curl -s -X POST $B/chat -H 'Content-Type: application/json' -d '{"session_id":"s-a1","message":"What is the capital of France?"}'
curl -s -X POST $B/chat -H 'Content-Type: application/json' -d '{"session_id":"s-b2","message":"What is the capital of France?"}'
# 1st: "resolution_source":"LIVE_INFERENCE", key_id "key_1"
# 2nd: "resolution_source":"LLM_CACHE", identical reply, same tokens, key_id null, much lower latency_ms

# Failover
curl -s -X POST $B/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: key_1=429' -d '{"session_id":"s-c3","message":"Name a planet"}'
# 200, "key_id":"key_2", "fallback_attempts":1
curl -s -X POST $B/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: key_1=500' -d '{"session_id":"s-c3","message":"Another one"}'
# 200, "key_id":"key_2"
curl -s -i -X POST $B/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: *=429' -d '{"session_id":"s-c3","message":"And one more"}'
# 503 {"detail":"all providers unavailable"}, not added to history

# Multi-turn history
curl -s $B/sessions/s-c3/messages
# 4 messages: the 503 turn is not there

# Validation
curl -s -X POST $B/chat -H 'Content-Type: application/json' -d '{"session_id":"x","message":"   "}'   # 422
curl -s $B/sessions/unknown/messages                                                             # 404
```

**In the UI**: every assistant reply shows the source badge (blue `LIVE_INFERENCE`, green `LLM_CACHE`), model, latency in ms, input and output tokens, the key id, and a "failover" badge when `fallback_attempts > 0`. Open **Settings → Failover lab** to attach `X-Simulate-Failure` to the next messages. **View stored history** calls `GET /sessions/{id}/messages`. Reload the page for a new session and send the same first message to see a cache hit. Errors (422/503/network) appear as a readable red message in the chat.

**Tokens** are per request, as reported by the provider that answered (Gemini and Groq tokenise differently, so a reply served by key_2 after a failover reports that provider's counts): `input_tokens` is the prompt of that call (system + history + new message) and grows as the conversation grows; `output_tokens` is that reply only. Two equal-length first messages in new sessions report about the same `input_tokens`.

**Tests**: `cd backend && pytest -q` runs 26 tests covering the contract shape, cache hit/miss rules (history and system prompt in the key, identical reply, stored tokens, faster hit), multi-turn and session isolation, per-request tokens, every failover case including 502/503 and `*`, a real (non-simulated) provider quota error, 503 writes nothing, simulation off, all 422 cases, 404 and CORS. LiteLLM runs in mock mode, so no network or real keys are needed.

## 5. Setup Used

- Editor: VS Code
- AI tools: Claude Code (Claude Opus) for scaffolding, code and tests, reviewed and run locally
- Libraries: FastAPI, LiteLLM 1.110, SQLite (stdlib `sqlite3`), React 19 + Vite, marked + DOMPurify
- Hosting: Vercel (frontend and the FastAPI backend on Vercel's Python runtime)

## 6. Bonus features

- **Failover lab in the UI**: radio buttons that attach `X-Simulate-Failure` to the next request, so failover and the 503 path can be shown without curl.
- **Stored history viewer**: shows the raw `GET /sessions/{id}/messages` response from SQLite inside the app.
- **Per-session stats**: replies, cache hits and failovers for the current session; live backend health (key count, cache on/off) in the header.
- **Mixed-model pools**: `LLM_KEY_MODELS` lets each key use a different model or provider (for example Gemini plus Groq), so failover also works across providers.
- **System prompt per session**: stored in SQLite and part of the cache key.
- **Safe markdown rendering** of replies (marked + DOMPurify), dark mode, and a mobile layout with a slide-over settings panel.
- **Runtime-configurable frontend image** (`API_URL` → `/config.js`), non-root backend container with a healthcheck.
