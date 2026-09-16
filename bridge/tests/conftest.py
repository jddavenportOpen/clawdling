"""Shared fixtures.

Every test runs against a CHEAP fake binary (`/bin/cat` or a three-line python
script), never the real `claude`, so the suite costs nothing and needs no
credentials. The workspace root is a tmp_path, so nothing here can read or
write a developer's real files.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient

from bridge.config import Config
from bridge.main import create_app

#: `validate_secret` only requires >=32 chars and no placeholder marker, so this
#: is deliberately LOW entropy: a random-looking literal here is indistinguishable
#: from a real leaked credential to a secret scanner, and this file is public.
TEST_SECRET = "clawdling-unit-test-secret-aaaaaaaaaaaa"

FAKE_CLAUDE = "/bin/cat"


def make_token(
    *,
    secret: str = TEST_SECRET,
    sub: str = "local@adjutant.localhost",
    ttl: int = 900,
    algorithm: str = "HS256",
    extra: dict | None = None,
) -> str:
    """Mint a token shaped exactly like src/lib/bridge-jwt.ts mints."""
    now = int(time.time())
    payload = {
        "sub": sub,
        "email": sub,
        "user_id": "user-1",
        "iat": now,
        "exp": now + ttl,
    }
    if extra:
        payload.update(extra)
        for key, value in list(extra.items()):
            if value is None:
                payload.pop(key, None)
    return jwt.encode(payload, secret, algorithm=algorithm)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspaces"
    (root / "project-a").mkdir(parents=True)
    return root.resolve()


@pytest.fixture
def outside_dir(tmp_path: Path) -> Path:
    """A real directory that is NOT inside the workspace root."""
    d = tmp_path / "elsewhere" / "secrets"
    d.mkdir(parents=True)
    return d.resolve()


@pytest.fixture
def config(workspace: Path) -> Config:
    return Config(
        secret=TEST_SECRET,
        workspace_root=workspace,
        max_sessions=4,
        scrollback_bytes=8 * 1024,
        claude_bin=FAKE_CLAUDE,
        repo_root=Path(__file__).resolve().parents[2],
        profile="starter",
        cors_origins=("http://localhost:3000",),
    )


@pytest.fixture
def client(config: Config):
    """A TestClient with the app lifespan running (so shutdown kills PTYs)."""
    app = create_app(config)
    with TestClient(app) as test_client:
        test_client.app_ref = app  # type: ignore[attr-defined]
        yield test_client


@pytest.fixture
def auth() -> dict:
    return {"Authorization": f"Bearer {make_token()}"}


def spawn(client: TestClient, auth: dict, **body) -> dict:
    """POST a spawn and return the parsed body, failing loudly on non-201."""
    resp = client.post("/api/sessions/spawn", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


def wait_for(predicate, timeout: float = 5.0, interval: float = 0.02) -> bool:
    """Poll a predicate. Returns False on timeout instead of hanging a test."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # pragma: no cover - exists, owned by someone else
        return True
    return True


# ── live server ──────────────────────────────────────────────────────────────
#
# Starlette's TestClient and httpx's ASGITransport BOTH run the ASGI app to
# completion and then hand back a buffered body, so neither can read an SSE
# stream that stays open. Streaming tests therefore run against a real uvicorn
# server on an ephemeral port. That is also the honest test: it exercises the
# same server, chunked encoding and socket teardown that production uses.


class LiveServer:
    def __init__(self, url: str, app, client: "httpx.Client") -> None:
        self.url = url
        self.app = app
        self.client = client

    def session(self, session_id: str):
        return self.app.state.sessions.get(session_id)

    def spawn(self, **body) -> dict:
        resp = self.client.post("/api/sessions/spawn", json=body)
        assert resp.status_code == 201, resp.text
        return resp.json()


@pytest.fixture
def live(config):
    import threading

    import httpx
    import uvicorn

    from bridge.main import create_app as _create_app

    app = _create_app(config)
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="on")
    )
    thread = threading.Thread(target=server.run, name="uvicorn-test", daemon=True)
    thread.start()

    deadline = time.monotonic() + 15
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, "uvicorn did not start"

    port = server.servers[0].sockets[0].getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    client = httpx.Client(
        base_url=url,
        headers={"Authorization": f"Bearer {make_token()}"},
        timeout=httpx.Timeout(15.0),
    )
    try:
        yield LiveServer(url, app, client)
    finally:
        client.close()
        server.should_exit = True
        thread.join(timeout=15)
