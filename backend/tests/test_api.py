import uuid

from app.llm import parse_simulation_header
from tests.conftest import CALLS


def sid() -> str:
    return f"s-{uuid.uuid4().hex[:8]}"


def chat(client, session_id, message, headers=None, **extra):
    return client.post("/chat", json={"session_id": session_id, "message": message, **extra}, headers=headers or {})


# ---- health -------------------------------------------------------------------
def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert {k: body[k] for k in ("status", "keys_configured", "cache_enabled")} == {"status": "ok", "keys_configured": 2, "cache_enabled": True}
    assert [k["key_id"] for k in body["keys"]] == ["key_1", "key_2"]
    assert "test-key" not in r.text


# ---- contract shape -----------------------------------------------------------
def test_chat_contract(client):
    s = sid()
    r = chat(client, s, "What is the capital of France?")
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"] == s
    assert body["reply"]
    m = body["metadata"]
    assert m["resolution_source"] == "LIVE_INFERENCE"
    assert m["model"] == "gemini/gemini-3.1-flash-lite"
    assert isinstance(m["latency_ms"], int)
    assert isinstance(m["input_tokens"], int) and isinstance(m["output_tokens"], int)
    assert m["key_id"] == "key_1"
    assert m["fallback_attempts"] == 0
    assert "test-key" not in r.text  # the secret is never returned


# ---- caching ------------------------------------------------------------------
def test_same_first_message_in_new_session_hits_cache(client):
    first = chat(client, sid(), "Tell me a fun fact about owls").json()
    second = chat(client, sid(), "Tell me a fun fact about owls").json()
    assert first["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert second["metadata"]["resolution_source"] == "LLM_CACHE"
    assert second["reply"] == first["reply"]
    assert second["metadata"]["key_id"] is None
    assert second["metadata"]["fallback_attempts"] == 0
    assert second["metadata"]["input_tokens"] == first["metadata"]["input_tokens"]
    assert second["metadata"]["output_tokens"] == first["metadata"]["output_tokens"]
    assert second["metadata"]["latency_ms"] < first["metadata"]["latency_ms"]


def test_different_message_never_from_cache(client):
    chat(client, sid(), "message A")
    r = chat(client, sid(), "message B").json()
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"


def test_cache_key_includes_history(client):
    s1, s2 = sid(), sid()
    chat(client, s1, "hello")
    chat(client, s1, "and then?")
    r = chat(client, s2, "and then?").json()  # same text, different history
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"


def test_cache_key_includes_system_prompt(client):
    chat(client, sid(), "hi there", system_prompt="You are a pirate.")
    r = chat(client, sid(), "hi there", system_prompt="You are a poet.").json()
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"


# ---- multi-turn ---------------------------------------------------------------
def test_multi_turn_history_sent_and_stored(client):
    s = sid()
    chat(client, s, "My name is Asha.")
    chat(client, s, "What is my name?")
    sent = CALLS[-1]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    assert sent[1]["content"] == "My name is Asha."

    h = client.get(f"/sessions/{s}/messages").json()
    assert h["session_id"] == s
    assert [m["role"] for m in h["messages"]] == ["user", "assistant", "user", "assistant"]
    assert "metadata" in h["messages"][1] and "metadata" not in h["messages"][0]
    assert all(m["role"] != "system" for m in h["messages"])


def test_sessions_are_isolated(client):
    a, b = sid(), sid()
    chat(client, a, "secret word is mango")
    chat(client, b, "what is the secret word?")
    assert len(CALLS[-1]["messages"]) == 2  # system + new message only


def test_tokens_are_per_request_not_running_total(client):
    a = chat(client, sid(), "x" * 40).json()["metadata"]["input_tokens"]
    b = chat(client, sid(), "y" * 40).json()["metadata"]["input_tokens"]
    assert abs(a - b) <= 2


def test_system_prompt_persists_for_session(client):
    s = sid()
    chat(client, s, "hi", system_prompt="Always answer in French.")
    chat(client, s, "how are you?")
    assert CALLS[-1]["messages"][0]["content"] == "Always answer in French."


def test_unknown_session_404(client):
    r = client.get("/sessions/does-not-exist/messages")
    assert r.status_code == 404
    assert r.json() == {"detail": "session not found"}


# ---- failover -----------------------------------------------------------------
def test_failover_on_429(client):
    r = chat(client, sid(), "failover 429", headers={"X-Simulate-Failure": "key_1=429"})
    assert r.status_code == 200
    m = r.json()["metadata"]
    assert m["key_id"] == "key_2" and m["fallback_attempts"] == 1
    assert m["resolution_source"] == "LIVE_INFERENCE"
    assert r.json()["reply"].startswith("echo")  # a real answer, not an error in a 200


def test_failover_on_500(client):
    r = chat(client, sid(), "failover 500", headers={"X-Simulate-Failure": "key_1=500"})
    assert r.status_code == 200
    assert r.json()["metadata"]["key_id"] == "key_2"


def test_failover_502_and_503(client):
    for code in (502, 503):
        r = chat(client, sid(), f"failover {code}", headers={"X-Simulate-Failure": f"key_1={code}"})
        assert r.json()["metadata"]["key_id"] == "key_2"


def test_simulation_bypasses_cache_read(client):
    chat(client, sid(), "cached question")
    r = chat(client, sid(), "cached question", headers={"X-Simulate-Failure": "key_1=429"}).json()
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert r["metadata"]["key_id"] == "key_2"


def test_all_keys_fail_503_and_nothing_stored(client):
    s = sid()
    chat(client, s, "first")
    r = chat(client, s, "second", headers={"X-Simulate-Failure": "*=429"})
    assert r.status_code == 503
    assert r.json() == {"detail": "all providers unavailable"}
    msgs = client.get(f"/sessions/{s}/messages").json()["messages"]
    assert [m["content"] for m in msgs if m["role"] == "user"] == ["first"]


def test_all_keys_listed_fail_503(client):
    r = chat(client, sid(), "both", headers={"X-Simulate-Failure": "key_1=429,key_2=500"})
    assert r.status_code == 503


def test_503_on_new_session_creates_nothing(client):
    s = sid()
    chat(client, s, "nope", headers={"X-Simulate-Failure": "*=503"})
    assert client.get(f"/sessions/{s}/messages").status_code == 404


def test_simulation_ignored_when_disabled(client, monkeypatch):
    import app.main as main
    from dataclasses import replace

    monkeypatch.setattr(main, "settings", replace(main.settings, enable_failure_simulation=False))
    r = chat(client, sid(), "no sim", headers={"X-Simulate-Failure": "*=429"})
    assert r.status_code == 200 and r.json()["metadata"]["key_id"] == "key_1"


def test_parse_header():
    assert parse_simulation_header("key_1=429, key_2=500") == {"key_1": 429, "key_2": 500}
    assert parse_simulation_header("*=429") == {"*": 429}
    assert parse_simulation_header("key_1=418,garbage") == {}
    assert parse_simulation_header(None) == {}


# ---- validation ---------------------------------------------------------------
def test_422_cases(client):
    cases = [
        {"session_id": "s", "message": ""},
        {"session_id": "s", "message": "   "},
        {"session_id": "", "message": "hi"},
        {"session_id": "x" * 129, "message": "hi"},
        {"message": "hi"},
        {"session_id": "s"},
        {"session_id": "s", "message": "a" * 4001},
    ]
    for body in cases:
        r = client.post("/chat", json=body)
        assert r.status_code == 422, body
        assert "detail" in r.json()


def test_422_malformed_json(client):
    r = client.post("/chat", content="{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert "detail" in r.json()


def test_4000_chars_after_trim_is_ok(client):
    r = chat(client, sid(), "  " + "a" * 4000 + "  ")
    assert r.status_code == 200


def test_failed_validation_not_stored(client):
    s = sid()
    client.post("/chat", json={"session_id": s, "message": ""})
    assert client.get(f"/sessions/{s}/messages").status_code == 404


def test_cors_allows_frontend_origin(client):
    r = client.options(
        "/chat",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-simulate-failure",
        },
    )
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"


def test_real_provider_error_fails_over(client, monkeypatch):
    """Not simulated: key_1's provider itself returns 429 (quota), the Router moves to key_2."""
    import litellm
    import httpx
    from tests import conftest

    async def flaky(**kwargs):
        if kwargs.get("api_key") == "test-key-one":
            raise litellm.RateLimitError(
                message="RESOURCE_EXHAUSTED: quota exceeded", llm_provider="gemini", model=kwargs["model"],
                response=httpx.Response(429, request=httpx.Request("POST", "https://x")),
            )
        return await conftest.fake_acompletion(**kwargs)

    monkeypatch.setattr(litellm, "acompletion", flaky)
    r = chat(client, sid(), "quota test")
    assert r.status_code == 200
    assert r.json()["metadata"]["key_id"] == "key_2"
    assert r.json()["metadata"]["fallback_attempts"] == 1
