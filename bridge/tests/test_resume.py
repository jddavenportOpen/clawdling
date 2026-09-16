"""`--resume`: naming the conversation, probing for it, and degrading loudly.

What the CLI actually does, measured before any of this was wired (CLI
2.1.273, on a real PTY):

  * `--session-id <uuid>` on a fresh id starts a conversation under that id.
  * `--resume <uuid>` on a known id restores the conversation.
  * `--resume <uuid>` on an UNKNOWN id prints "No conversation found with
    session ID: <uuid>" and exits immediately — it does not fall back to a
    fresh session and it does not open the picker.

The third point is why `conversation_exists` is a precondition rather than an
optimisation, and it is what these tests are mostly about: every path where
the conversation is missing must produce a working pane that SAYS it is fresh.

The general suite runs with `resume_enabled=False`, because `/bin/cat` rejects
the flags. These tests use a stub that accepts them.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bridge.main import create_app
from bridge.pty import build_child_env
from bridge.resume import claude_home, conversation_exists
from bridge.routes.sessions import build_argv

from .conftest import spawn


@pytest.fixture
def resume_home(tmp_path: Path, monkeypatch) -> Path:
    """A fake `claude` config dir, so no test reads the developer's real one."""
    home = tmp_path / "claude-home"
    (home / "projects").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))
    return home


@pytest.fixture
def rconfig(config, flag_tolerant_bin: str):
    return dataclasses.replace(config, claude_bin=flag_tolerant_bin, resume_enabled=True)


def _boot(cfg) -> TestClient:
    app = create_app(cfg)
    client = TestClient(app)
    client.app_ref = app  # type: ignore[attr-defined]
    return client


def _plant_conversation(home: Path, cwd: Path, session_id: str) -> Path:
    """Write the JSONL the CLI would have written for this conversation."""
    encoded = "".join("-" if c in "/." else c for c in str(cwd))
    path = home / "projects" / encoded / f"{session_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"type":"user"}\n', encoding="utf-8")
    return path


# ── argv ─────────────────────────────────────────────────────────────────────


def test_build_argv_names_the_conversation():
    argv = build_argv(claude_bin="claude", session_id="6f1c9f10-0000-4000-8000-000000000004")
    assert argv == ["claude", "--session-id", "6f1c9f10-0000-4000-8000-000000000004"]


def test_build_argv_resume_replaces_session_id():
    """`--resume` continues the ORIGINAL id; naming a second one is incoherent."""
    argv = build_argv(
        claude_bin="claude",
        session_id="6f1c9f10-0000-4000-8000-000000000005",
        resume_session_id="6f1c9f10-0000-4000-8000-000000000006",
    )
    assert argv == ["claude", "--resume", "6f1c9f10-0000-4000-8000-000000000006"]
    assert "--session-id" not in argv


def test_build_argv_keeps_the_prompt_last():
    argv = build_argv(
        claude_bin="claude",
        model="claude-opus-5",
        session_id="6f1c9f10-0000-4000-8000-000000000007",
        prompt_file="/p/agents/tasks.md",
        initial_prompt="go",
    )
    assert argv[-1] == "go"
    assert argv[:5] == [
        "claude",
        "--model",
        "claude-opus-5",
        "--session-id",
        "6f1c9f10-0000-4000-8000-000000000007",
    ]


# ── the probe ────────────────────────────────────────────────────────────────


def test_claude_home_honours_the_cli_override(resume_home):
    assert claude_home() == resume_home


def test_conversation_exists_finds_a_planted_conversation(resume_home, tmp_path):
    cwd = tmp_path / "work" / "proj.v2"
    cwd.mkdir(parents=True)
    _plant_conversation(resume_home, cwd, "6f1c9f10-0000-4000-8000-000000000008")
    assert conversation_exists(cwd, "6f1c9f10-0000-4000-8000-000000000008")


def test_conversation_exists_is_false_when_absent(resume_home, tmp_path):
    assert not conversation_exists(tmp_path, "6f1c9f10-0000-4000-8000-000000000009")


def test_conversation_exists_is_false_for_an_empty_file(resume_home, tmp_path):
    """A zero-byte JSONL is not a conversation the CLI can restore."""
    path = _plant_conversation(resume_home, tmp_path, "6f1c9f10-0000-4000-8000-00000000000a")
    path.write_text("", encoding="utf-8")
    assert not conversation_exists(tmp_path, "6f1c9f10-0000-4000-8000-00000000000a")


def test_conversation_probe_refuses_path_traversal(resume_home, tmp_path):
    assert not conversation_exists(tmp_path, "../../../../etc/passwd")
    assert not conversation_exists(tmp_path, "")


# ── spawn ────────────────────────────────────────────────────────────────────


def test_every_spawn_names_its_conversation(rconfig, auth, resume_home):
    """Nothing is resumable later unless the conversation is named NOW."""
    with _boot(rconfig) as client:
        body = spawn(client, auth)
        session = client.app_ref.state.sessions.get(body["session_id"])
        assert session.argv[1:3] == ["--session-id", body["session_id"]]
        assert body["claude_session_id"] == body["session_id"]
        # A plain spawn neither resumed nor failed to, so it says nothing.
        assert "resume_status" not in body


def test_resume_is_off_when_disabled(config, auth, flag_tolerant_bin):
    off = dataclasses.replace(config, claude_bin=flag_tolerant_bin, resume_enabled=False)
    with _boot(off) as client:
        body = spawn(client, auth)
        session = client.app_ref.state.sessions.get(body["session_id"])
        assert "--session-id" not in session.argv
        assert "claude_session_id" not in body


def test_resume_from_a_live_session_passes_the_flag(rconfig, auth, resume_home):
    with _boot(rconfig) as client:
        first = spawn(client, auth)
        _plant_conversation(resume_home, rconfig.workspace_root, first["claude_session_id"])

        second = spawn(client, auth, resume_from=first["session_id"])
        session = client.app_ref.state.sessions.get(second["session_id"])
        assert session.argv[1:3] == ["--resume", first["claude_session_id"]]
        assert second["resume_status"] == "resumed"
        assert second["resume_from"] == first["session_id"]
        # A new pane, a new transcript — the CONVERSATION is what carried over.
        assert second["session_id"] != first["session_id"]


def test_resume_survives_a_restart(rconfig, auth, resume_home):
    """The whole point: the conversation id outlives the bridge process."""
    with _boot(rconfig) as first_boot:
        first = spawn(first_boot, auth)
        claude_id = first["claude_session_id"]
        _plant_conversation(resume_home, rconfig.workspace_root, claude_id)

    with _boot(rconfig) as second_boot:
        resumed = spawn(second_boot, auth, resume_from=first["session_id"])
        session = second_boot.app_ref.state.sessions.get(resumed["session_id"])
        assert session.argv[1:3] == ["--resume", claude_id]
        assert resumed["resume_status"] == "resumed"


def test_a_missing_conversation_spawns_fresh_and_says_so(rconfig, auth, resume_home):
    """The CLI would die on `--resume` here. The bridge must not hand that over."""
    with _boot(rconfig) as client:
        first = spawn(client, auth)
        # Deliberately plant NOTHING: the conversation was pruned, or the
        # session never saved a transcript.
        second = spawn(client, auth, resume_from=first["session_id"])
        session = client.app_ref.state.sessions.get(second["session_id"])

        assert "--resume" not in session.argv
        assert session.argv[1:3] == ["--session-id", second["session_id"]]
        assert second["resume_status"] == "unavailable"
        assert second["resume_from"] == first["session_id"]
        assert second["status"] == "running"  # a working pane, not a 500


def test_resume_from_an_unknown_id_still_spawns(rconfig, auth, resume_home):
    with _boot(rconfig) as client:
        body = spawn(client, auth, resume_from="6f1c9f10-0000-4000-8000-00000000000b")
        assert body["status"] == "running"
        assert body["resume_status"] == "unavailable"


def test_resume_from_is_refused_when_resume_is_disabled(config, auth, flag_tolerant_bin):
    """Asking to resume on a bridge that cannot must be visible, not silent."""
    off = dataclasses.replace(config, claude_bin=flag_tolerant_bin, resume_enabled=False)
    with _boot(off) as client:
        first = spawn(client, auth)
        body = spawn(client, auth, resume_from=first["session_id"])
        assert body["resume_status"] == "disabled"


def test_the_conversation_id_is_persisted_to_the_sidecar(rconfig, auth, resume_home):
    with _boot(rconfig) as client:
        body = spawn(client, auth)
        client.app_ref.state.transcripts.flush_all()
        meta = json.loads(
            (rconfig.transcript_dir / f"{body['session_id']}.json").read_text()
        )
    assert meta["claude_session_id"] == body["claude_session_id"]


def test_an_inherited_child_session_marker_is_stripped():
    """A bridge started INSIDE a Claude Code session must not hand its panes
    that session's lineage: `CLAUDE_CODE_CHILD_SESSION` makes the CLI treat the
    pane as a subagent and turn transcript saving OFF, and a session with no
    saved transcript can never be resumed."""
    env = build_child_env(
        base=[
            ("CLAUDE_CODE_CHILD_SESSION", "1"),
            ("CLAUDE_CODE_SESSION_ID", "6f1c9f10-0000-4000-8000-00000000000e"),
            ("PATH", "/usr/bin"),
        ],
        TERM="xterm-256color",
    )
    assert "CLAUDE_CODE_CHILD_SESSION" not in env
    assert "CLAUDE_CODE_SESSION_ID" not in env
    assert env["PATH"] == "/usr/bin"  # everything else is untouched


def test_a_restored_record_reports_its_resume_lineage(rconfig, auth, resume_home):
    with _boot(rconfig) as first_boot:
        first = spawn(first_boot, auth)
    with _boot(rconfig) as second_boot:
        row = next(
            r
            for r in second_boot.get("/api/sessions", headers=auth).json()["sessions"]
            if r["session_id"] == first["session_id"]
        )
        assert row["claude_session_id"] == first["claude_session_id"]
