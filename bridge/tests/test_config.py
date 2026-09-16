"""Boot-time refusals and the PTY engine's own invariants."""

from __future__ import annotations

import asyncio
import os

import pytest

from bridge.config import Config, ConfigError, validate_secret
from bridge.profiles import DomainError, load_domains, resolve_agent_prompt, resolve_domain
from bridge.pty import PtySession, SessionError, SessionManager

from .conftest import TEST_SECRET, process_alive


# ── secret ───────────────────────────────────────────────────────────────────


def test_a_real_secret_is_accepted():
    assert validate_secret(TEST_SECRET) == TEST_SECRET


@pytest.mark.parametrize(
    "secret",
    [
        None,
        "",
        "short",
        "change-me-shared-secret",  # the value in .env.example
        "changeme-changeme-changeme-changeme",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",  # no entropy
        "your-secret-here-your-secret-here",
    ],
)
def test_weak_secrets_are_refused(secret):
    with pytest.raises(ConfigError):
        validate_secret(secret)


def test_from_env_refuses_to_boot_without_a_secret(monkeypatch):
    monkeypatch.delenv("BRIDGE_SECRET", raising=False)
    with pytest.raises(ConfigError) as exc:
        Config.from_env()
    assert "BRIDGE_SECRET" in str(exc.value)


def test_from_env_defaults(monkeypatch, tmp_path):
    monkeypatch.setenv("BRIDGE_SECRET", TEST_SECRET)
    monkeypatch.setenv("CLAWDLING_WORKSPACE_ROOT", str(tmp_path / "ws"))
    cfg = Config.from_env()
    assert cfg.host == "127.0.0.1"  # loopback unless told otherwise
    assert cfg.port == 8787
    assert cfg.max_sessions == 12
    assert cfg.claude_bin == "claude"
    assert cfg.workspace_root.is_dir()  # created for a first-run self-hoster


def test_from_env_reads_the_documented_knobs(monkeypatch, tmp_path):
    monkeypatch.setenv("BRIDGE_SECRET", TEST_SECRET)
    monkeypatch.setenv("CLAWDLING_WORKSPACE_ROOT", str(tmp_path / "ws"))
    monkeypatch.setenv("CLAWDLING_MAX_SESSIONS", "3")
    monkeypatch.setenv("CLAWDLING_CLAUDE_BIN", "/bin/cat")
    monkeypatch.setenv("CLAWDLING_WORKSPACE_ALLOWLIST", str(tmp_path / "extra"))
    (tmp_path / "extra").mkdir()
    cfg = Config.from_env()
    assert cfg.max_sessions == 3
    assert cfg.claude_bin == "/bin/cat"
    assert (tmp_path / "extra").resolve() in cfg.allowed_roots


def test_non_integer_knob_is_refused(monkeypatch, tmp_path):
    monkeypatch.setenv("BRIDGE_SECRET", TEST_SECRET)
    monkeypatch.setenv("CLAWDLING_WORKSPACE_ROOT", str(tmp_path / "ws"))
    monkeypatch.setenv("CLAWDLING_MAX_SESSIONS", "lots")
    with pytest.raises(ConfigError):
        Config.from_env()


# ── profiles ─────────────────────────────────────────────────────────────────


def test_starter_profile_domains_load(config):
    ids = {row["id"] for row in load_domains(config)}
    assert {"work", "personal", "notes"} <= ids


def test_resolve_domain_finds_the_agent_prompt(config):
    spec = resolve_domain("personal", config)
    assert spec.label == "Personal"
    assert spec.agent_prompt.name == "assistant.md"


def test_resolve_domain_rejects_the_unknown(config):
    with pytest.raises(DomainError):
        resolve_domain("does-not-exist", config)


def test_agent_reference_may_be_a_bare_name(config):
    assert resolve_agent_prompt("tasks", config).name == "tasks.md"


def test_agent_reference_cannot_escape_the_profile(config):
    with pytest.raises(DomainError):
        resolve_agent_prompt("../../../../etc/passwd", config)


# ── PtySession ───────────────────────────────────────────────────────────────


async def test_ring_buffer_is_bounded(tmp_path):
    session = PtySession(
        session_id="ring-test",
        name="ring",
        cwd=tmp_path,
        argv=["/bin/cat"],
        env={"TERM": "dumb"},
        scrollback_bytes=1024,
    )
    session.start()
    try:
        for _ in range(40):
            await asyncio.to_thread(session.write_bytes, b"0123456789" * 10 + b"\r")
        await asyncio.sleep(0.6)
        assert len(session._ring) <= session._ring_cap
        # The cap is a window on a longer stream, not the whole stream.
        assert session._total_bytes > session._ring_cap
    finally:
        await session.terminate(grace=2.0)


async def test_terminate_is_safe_to_call_twice(tmp_path):
    session = PtySession(
        session_id="term-test",
        name="term",
        cwd=tmp_path,
        argv=["/bin/cat"],
        env={"TERM": "dumb"},
    )
    session.start()
    pid = session.pid
    assert await session.terminate(grace=2.0) is not None or session.status == "exited"
    again = await session.terminate(grace=2.0)
    assert session.status == "exited"
    assert again == session.exit_code
    assert not process_alive(pid)


async def test_sigkill_takes_a_process_that_ignores_sigterm(tmp_path):
    """The 5s escalation is the difference between tidy and orphaned."""
    script = tmp_path / "stubborn.py"
    script.write_text(
        "import signal, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\n"
        "time.sleep(300)\n"
    )
    session = PtySession(
        session_id="kill-test",
        name="kill",
        cwd=tmp_path,
        argv=[os.sys.executable, str(script)],
        env={"TERM": "dumb", "PATH": os.environ.get("PATH", "")},
    )
    session.start()
    pid = session.pid
    await asyncio.sleep(0.5)
    await session.terminate(grace=0.5)  # SIGTERM ignored, SIGKILL lands
    assert session.status == "exited"
    assert not process_alive(pid)


async def test_write_to_a_dead_session_raises(tmp_path):
    session = PtySession(
        session_id="dead-write",
        name="dead",
        cwd=tmp_path,
        argv=["/bin/cat"],
        env={"TERM": "dumb"},
    )
    session.start()
    await session.terminate(grace=2.0)
    with pytest.raises(SessionError):
        session.write_bytes(b"anyone there")


async def test_manager_enforces_the_cap(tmp_path):
    manager = SessionManager(max_sessions=2, scrollback_bytes=4096)
    try:
        for _ in range(2):
            manager.create(name="s", cwd=tmp_path, argv=["/bin/cat"], env={"TERM": "dumb"})
        with pytest.raises(SessionError):
            manager.create(name="s", cwd=tmp_path, argv=["/bin/cat"], env={"TERM": "dumb"})
        assert manager.live_count() == 2
    finally:
        await manager.shutdown(grace=2.0)


async def test_manager_shutdown_reaps_everything(tmp_path):
    manager = SessionManager(max_sessions=4, scrollback_bytes=4096)
    sessions = [
        manager.create(name=f"s{i}", cwd=tmp_path, argv=["/bin/cat"], env={"TERM": "dumb"})
        for i in range(3)
    ]
    pids = [s.pid for s in sessions]
    await manager.shutdown(grace=2.0)
    assert all(s.status == "exited" for s in sessions)
    assert not any(process_alive(p) for p in pids)


async def test_a_child_that_exits_on_its_own_is_observed(tmp_path):
    session = PtySession(
        session_id="self-exit",
        name="exit",
        cwd=tmp_path,
        argv=["/bin/sh", "-c", "exit 3"],
        env={"TERM": "dumb"},
    )
    session.start()
    for _ in range(200):
        if session.status == "exited":
            break
        await asyncio.sleep(0.02)
    assert session.status == "exited"
    assert session.exit_code == 3
