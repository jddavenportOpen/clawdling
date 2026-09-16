"""Working-directory containment.

A spawn request names the directory the `claude` process will run in. That is
the single most dangerous field on the wire: an unchecked cwd turns a cockpit
into "read any file on the host". So every candidate is fully resolved (which
follows symlinks and collapses `..`) and then required to be inside
CLAWDLING_WORKSPACE_ROOT or an explicitly allowlisted root.

Resolving BOTH sides matters on macOS, where /tmp is a symlink to /private/tmp
and a naive string prefix test would reject a legitimate path.
"""

from __future__ import annotations

from pathlib import Path

from .config import Config


class WorkspaceError(ValueError):
    """Raised when a requested cwd is outside every allowed root."""


def _is_within(candidate: Path, root: Path) -> bool:
    return candidate == root or root in candidate.parents


def resolve_cwd(raw: str | None, config: Config) -> Path:
    """Resolve and contain a requested cwd.

    `None` or "" means "the workspace root itself", which is always allowed.
    Raises WorkspaceError (the route turns it into a 400) otherwise.
    """
    if raw is None or not str(raw).strip():
        return config.workspace_root

    text = str(raw).strip()
    if "\x00" in text:
        raise WorkspaceError("cwd contains a null byte")

    # expanduser first so "~/project" behaves the way a human expects, then
    # resolve() to follow every symlink and collapse every `..` segment. Both
    # happen BEFORE the containment test, so `../../etc` and a symlink pointing
    # out of the workspace are the same rejected case.
    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        candidate = config.workspace_root / candidate
    candidate = candidate.resolve()

    roots = config.allowed_roots
    if not any(_is_within(candidate, root) for root in roots):
        allowed = ", ".join(str(r) for r in roots)
        raise WorkspaceError(
            f"cwd {candidate} is outside the allowed workspace roots ({allowed}). "
            "Set CLAWDLING_WORKSPACE_ROOT, or add the path to "
            "CLAWDLING_WORKSPACE_ALLOWLIST, to permit it."
        )

    if not candidate.exists():
        raise WorkspaceError(f"cwd {candidate} does not exist")
    if not candidate.is_dir():
        raise WorkspaceError(f"cwd {candidate} is not a directory")

    return candidate
