"""Test setup: temp SQLite + in-memory cache, and LiteLLM calls answered by LiteLLM's mock mode.

No network or real keys are used. Failures injected through X-Simulate-Failure still go
through the real `litellm.acompletion` path (as `mock_response=<exception>`).
"""
import asyncio
import importlib
import os
import sys

import litellm
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

_real_acompletion = litellm.acompletion
CALLS: list[dict] = []


async def fake_acompletion(**kwargs):
    CALLS.append(kwargs)
    mock = kwargs.get("mock_response")
    if isinstance(mock, Exception):
        return await _real_acompletion(**kwargs)  # LiteLLM raises the provider-style error
    await asyncio.sleep(0.05)  # a live call is never instant
    last_user = kwargs["messages"][-1]["content"]
    kwargs["mock_response"] = f"echo[{len(kwargs['messages'])}]: {last_user}"
    return await _real_acompletion(**kwargs)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'app.db'}")
    monkeypatch.setenv("LLM_API_KEYS", "test-key-one,test-key-two")
    monkeypatch.setenv("LLM_MODEL", "gemini/gemini-2.5-flash")
    monkeypatch.setenv("ENABLE_FAILURE_SIMULATION", "true")
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://localhost:3000")
    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    CALLS.clear()
    import app.main as main

    main = importlib.reload(main)
    with TestClient(main.app) as c:
        yield c
