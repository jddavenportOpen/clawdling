"""`claude --resume` support: knowing the conversation id, and probing for it.

A transcript restores the TEXT. It does not restore the model's context — a
restarted pane that replays 50KB of ANSI is showing you a photograph of a
conversation the agent no longer remembers. `--resume` is the other half.

Two facts about the CLI shape everything here, both verified against
`claude --help` and by running it (2026-09-16, CLI 2.1.273):

  * `--session-id <uuid>` lets the CALLER choose the conversation id. That is
    what makes this tractable: the bridge names the conversation at spawn time
    and stores the name, instead of trying to scrape an id the CLI picked out
    of a TUI byte stream.

  * `--resume <id>` on an id the CLI does not know prints
    "No conversation found with session ID: <id>" and EXITS IMMEDIATELY. It
    does not fall back to a fresh session and it does not open the picker.
    So a bridge that passes `--resume` optimistically does not degrade — it
    hands the user a pane that dies in under a second.

Hence `conversation_exists()`. It is a probe of the CLI's own on-disk session
store, and it is deliberately CONSERVATIVE: a miss means "spawn fresh and say
so", never "spawn something that will die". If a future CLI moves that store,
this probe stops finding conversations and resume quietly stops happening —
transcripts keep working and no pane ever breaks. That is the correct
direction for a heuristic to fail in.
"""

from __future__ import annotations

import os
from pathlib import Path

#: The CLI writes one JSONL per conversation under
#: <config-dir>/projects/<encoded-cwd>/<session-id>.jsonl
_PROJECTS_DIR = "projects"
_CONVERSATION_SUFFIX = ".jsonl"


def claude_home() -> Path:
    """The CLI's config directory, honouring its own override."""
    override = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".claude"


def _encodings(cwd: Path) -> tuple[str, ...]:
    """Candidate directory names the CLI may have used for this cwd.

    Observed encoding is "replace every `/` and every `.` with `-`" — e.g.
    `/Users/x/repo/.claude/worktrees/w` becomes
    `-Users-x-repo--claude-worktrees-w`. The slash-only variant is tried too,
    so a CLI that only ever rewrote separators is still found. Two stat calls,
    and a miss is safe.
    """
    text = str(cwd)
    both = "".join("-" if c in "/." else c for c in text)
    slashes = text.replace("/", "-")
    return (both,) if both == slashes else (both, slashes)


def conversation_exists(cwd: Path, claude_session_id: str, home: Path | None = None) -> bool:
    """True when the CLI still holds a conversation with this id for this cwd."""
    if not claude_session_id:
        return False
    # The id becomes a path segment. Refuse anything that could escape.
    if "/" in claude_session_id or "\\" in claude_session_id or ".." in claude_session_id:
        return False
    root = (home or claude_home()) / _PROJECTS_DIR
    for name in _encodings(cwd):
        candidate = root / name / f"{claude_session_id}{_CONVERSATION_SUFFIX}"
        try:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return True
        except OSError:  # pragma: no cover - unreadable config dir
            continue
    return False


__all__ = ["claude_home", "conversation_exists"]
