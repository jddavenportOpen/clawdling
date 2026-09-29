"""Session lifecycle over the wire: spawn, list, input, resize, delete."""

from __future__ import annotations

import dataclasses
import os

import pytest
from fastapi.testclient import TestClient

from bridge.main import create_app
from bridge.pty import build_child_env
from bridge.routes.sessions import build_argv

from .conftest import FAKE_CLAUDE, process_alive, spawn, wait_for


def _session(client: TestClient, sid: str):
    return client.app_ref.state.sessions.get(sid)


# ── spawn ────────────────────────────────────────────────────────────────────


def test_spawn_returns_the_contract_shape(client, auth, config):
    body = spawn(client, auth)
    assert set(body) == {
        "session_id",
        "name",
        "cwd",
        "domain",
        "model",
        "status",
        "created_at",
        "last_activity",
    }
    assert body["status"] == "live"
    assert body["cwd"] == str(config.workspace_root)
    assert len(body["session_id"]) == 36  # uuid4


def test_spawn_requires_auth(client):
    assert client.post("/api/sessions/spawn", json={}).status_code == 401


def test_spawn_actually_starts_a_process(client, auth):
    body = spawn(client, auth)
    session = _session(client, body["session_id"])
    assert session.pid is not None
    assert process_alive(session.pid)


def test_spawn_honours_a_requested_name(client, auth):
    assert spawn(client, auth, name="my pane")["name"] == "my pane"


def test_spawn_generates_a_name_when_absent(client, auth):
    body = spawn(client, auth)
    assert body["name"].startswith(body["cwd"].rsplit("/", 1)[-1])


def test_spawn_rejects_a_bogus_model(client, auth):
    resp = client.post("/api/sessions/spawn", json={"model": "opus; rm -rf /"}, headers=auth)
    assert resp.status_code == 400


def test_spawn_rejects_an_unknown_domain(client, auth):
    resp = client.post("/api/sessions/spawn", json={"domain": "nope"}, headers=auth)
    assert resp.status_code == 400
    assert "unknown domain" in resp.json()["detail"]
    assert "work" in resp.json()["detail"]  # names the known ids


def test_spawn_with_a_known_domain_injects_the_agent_prompt(client, auth, config):
    body = spawn(client, auth, domain="work")
    assert body["domain"] == "work"
    session = _session(client, body["session_id"])
    assert "--append-system-prompt-file" in session.argv
    prompt = session.argv[session.argv.index("--append-system-prompt-file") + 1]
    assert prompt == str(config.repo_root / "profiles/starter/agents/tasks.md")
    assert os.path.isfile(prompt)


def test_spawn_rejects_an_agent_outside_the_profile(client, auth):
    resp = client.post(
        "/api/sessions/spawn",
        json={"agent": "../../../../etc/passwd"},
        headers=auth,
    )
    assert resp.status_code == 400


# ── max sessions ─────────────────────────────────────────────────────────────


def test_max_sessions_is_enforced(client, auth, config):
    for _ in range(config.max_sessions):
        spawn(client, auth)
    resp = client.post("/api/sessions/spawn", json={}, headers=auth)
    assert resp.status_code == 429
    assert "session limit reached" in resp.json()["detail"]


def test_an_exited_session_frees_a_slot(config, auth):
    tight = dataclasses.replace(config, max_sessions=1)
    with TestClient(create_app(tight)) as client:
        client.app_ref = client.app  # type: ignore[attr-defined]
        first = spawn(client, auth)
        assert client.post("/api/sessions/spawn", json={}, headers=auth).status_code == 429

        client.delete(f"/api/sessions/{first['session_id']}", headers=auth)
        assert client.post("/api/sessions/spawn", json={}, headers=auth).status_code == 201


# ── list ─────────────────────────────────────────────────────────────────────


def test_list_reports_every_session(client, auth):
    a = spawn(client, auth, name="a")
    b = spawn(client, auth, name="b")
    rows = client.get("/api/sessions", headers=auth).json()["sessions"]
    assert {r["session_id"] for r in rows} == {a["session_id"], b["session_id"]}
    assert all(r["status"] == "live" for r in rows)


def test_list_alias_matches(client, auth):
    spawn(client, auth)
    canonical = client.get("/api/sessions", headers=auth).json()
    alias = client.get("/api/sessions/list", headers=auth).json()
    assert canonical == alias


def test_list_shows_exited_after_delete(client, auth):
    body = spawn(client, auth)
    client.delete(f"/api/sessions/{body['session_id']}", headers=auth)
    rows = client.get("/api/sessions", headers=auth).json()["sessions"]
    assert rows[0]["status"] == "exited"


# ── input ────────────────────────────────────────────────────────────────────


def test_input_round_trips_through_the_pty(client, auth):
    """spawn -> write -> read. /bin/cat echoes, so the bytes come back."""
    body = spawn(client, auth)
    session = _session(client, body["session_id"])

    resp = client.post(
        f"/api/sessions/{body['session_id']}/input",
        json={"data": "hello-bridge\r"},
        headers=auth,
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    assert wait_for(lambda: b"hello-bridge" in bytes(session._ring)), bytes(session._ring)


def test_input_accepts_the_text_alias(client, auth):
    body = spawn(client, auth)
    session = _session(client, body["session_id"])
    resp = client.post(
        f"/api/sessions/{body['session_id']}/input",
        json={"text": "alias-path\r"},
        headers=auth,
    )
    assert resp.status_code == 200
    assert wait_for(lambda: b"alias-path" in bytes(session._ring))


def test_input_without_a_payload_is_422(client, auth):
    body = spawn(client, auth)
    resp = client.post(f"/api/sessions/{body['session_id']}/input", json={}, headers=auth)
    assert resp.status_code == 422


def test_input_to_an_unknown_session_is_404(client, auth):
    resp = client.post("/api/sessions/does-not-exist/input", json={"data": "x"}, headers=auth)
    assert resp.status_code == 404


def test_input_to_an_exited_session_is_409(client, auth):
    body = spawn(client, auth)
    sid = body["session_id"]
    client.delete(f"/api/sessions/{sid}", headers=auth)
    resp = client.post(f"/api/sessions/{sid}/input", json={"data": "x"}, headers=auth)
    assert resp.status_code == 409


def test_input_updates_last_activity(client, auth):
    body = spawn(client, auth)
    session = _session(client, body["session_id"])
    before = session.last_activity
    client.post(f"/api/sessions/{body['session_id']}/input", json={"data": "tick\r"}, headers=auth)
    assert wait_for(lambda: session.last_activity >= before)


# ── resize ───────────────────────────────────────────────────────────────────


def test_resize_applies_to_the_tty(client, auth):
    import fcntl
    import struct
    import termios

    body = spawn(client, auth)
    session = _session(client, body["session_id"])

    resp = client.post(
        f"/api/sessions/{body['session_id']}/resize",
        json={"cols": 100, "rows": 40},
        headers=auth,
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert (session.cols, session.rows) == (100, 40)

    packed = fcntl.ioctl(session._master_fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    rows, cols, _, _ = struct.unpack("HHHH", packed)
    assert (cols, rows) == (100, 40)


def test_spawn_dimensions_reach_the_tty(client, auth):
    import fcntl
    import struct
    import termios

    body = spawn(client, auth, cols=90, rows=24)
    session = _session(client, body["session_id"])
    packed = fcntl.ioctl(session._master_fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    rows, cols, _, _ = struct.unpack("HHHH", packed)
    assert (cols, rows) == (90, 24)


@pytest.mark.parametrize("payload", [{"cols": 0, "rows": 10}, {"cols": 10, "rows": 99999}, {"cols": 10}])
def test_resize_rejects_bad_dimensions(client, auth, payload):
    body = spawn(client, auth)
    resp = client.post(f"/api/sessions/{body['session_id']}/resize", json=payload, headers=auth)
    assert resp.status_code == 422


def test_resize_unknown_session_is_404(client, auth):
    resp = client.post("/api/sessions/nope/resize", json={"cols": 80, "rows": 24}, headers=auth)
    assert resp.status_code == 404


# ── delete ───────────────────────────────────────────────────────────────────


def test_delete_kills_the_process(client, auth):
    body = spawn(client, auth)
    session = _session(client, body["session_id"])
    pid = session.pid

    resp = client.delete(f"/api/sessions/{body['session_id']}", headers=auth)
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert session.status == "exited"
    assert not process_alive(pid)


def test_delete_is_idempotent(client, auth):
    body = spawn(client, auth)
    sid = body["session_id"]
    first = client.delete(f"/api/sessions/{sid}", headers=auth).json()
    second = client.delete(f"/api/sessions/{sid}", headers=auth).json()
    assert first["ok"] is True and second["ok"] is True
    assert first["exit_code"] == second["exit_code"]


def test_delete_of_an_unknown_session_is_ok(client, auth):
    resp = client.delete("/api/sessions/never-existed", headers=auth)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "exit_code": None}


def test_delete_requires_auth(client, auth):
    body = spawn(client, auth)
    assert client.delete(f"/api/sessions/{body['session_id']}").status_code == 401


def test_shutdown_kills_every_child(config, auth):
    """The lifespan teardown is what stops a Ctrl-C orphaning agents."""
    app = create_app(config)
    with TestClient(app) as client:
        client.app_ref = app  # type: ignore[attr-defined]
        pids = [
            app.state.sessions.get(spawn(client, auth)["session_id"]).pid for _ in range(3)
        ]
        assert all(process_alive(p) for p in pids)
    assert not any(process_alive(p) for p in pids)


# ── argv and env ─────────────────────────────────────────────────────────────


def test_build_argv_is_exec_shaped():
    argv = build_argv(
        claude_bin="claude",
        model="claude-opus-5",
        prompt_file="/p/agents/tasks.md",
        initial_prompt="hi there",
    )
    assert argv == [
        "claude",
        "--model",
        "claude-opus-5",
        "--append-system-prompt-file",
        "/p/agents/tasks.md",
        "hi there",
    ]


def test_build_argv_omits_absent_options():
    assert build_argv(claude_bin=FAKE_CLAUDE) == [FAKE_CLAUDE]


def test_child_env_never_carries_the_bridge_secret():
    env = build_child_env(
        base=[("BRIDGE_SECRET", "s3cret"), ("BRIDGE_PORT", "8787"), ("ANTHROPIC_API_KEY", "sk-x")],
        TERM="xterm-256color",
    )
    assert "BRIDGE_SECRET" not in env
    assert "BRIDGE_PORT" not in env
    assert env["ANTHROPIC_API_KEY"] == "sk-x"
    assert env["TERM"] == "xterm-256color"


def test_spawned_child_env_is_scrubbed(client, auth):
    session = _session(client, spawn(client, auth)["session_id"])
    assert "BRIDGE_SECRET" not in session.env
    assert session.env["TERM"] == "xterm-256color"
