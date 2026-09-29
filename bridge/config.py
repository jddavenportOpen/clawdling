"""Environment configuration and boot-time validation.

Every knob the bridge reads lives here, so `bridge/README.md` has exactly one
place to stay honest about. Validation is deliberately fail-fast: this process
hands a stranger's machine to a shell-less exec of the `claude` binary, so a
misconfigured bridge must refuse to boot rather than start in a weak state.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_MAX_SESSIONS = 12
DEFAULT_SCROLLBACK_BYTES = 256 * 1024
DEFAULT_WORKSPACE_ROOT = "~/clawdling-workspaces"
# State, not project content. Deliberately NOT under the workspace root: every
# session's cwd is inside that tree, so a transcript kept there would be a file
# the agent can read and rewrite — including its own.
DEFAULT_STATE_ROOT = "~/.clawdling"
DEFAULT_HISTORY_TAIL_BYTES = 256 * 1024
DEFAULT_TRANSCRIPT_MAX_FILE_BYTES = 32 * 1024 * 1024
DEFAULT_RETENTION_COUNT = 200
DEFAULT_RETENTION_DAYS = 14
DEFAULT_PROFILE = "starter"
DEFAULT_CLAUDE_BIN = "claude"
DEFAULT_COLS = 120
DEFAULT_ROWS = 32
# With CLAWDLING_CORS_ORIGINS unset, a loopback origin on ANY port may open the
# stream. A fixed :3000 list broke the moment the cockpit ran anywhere else, and
# install.sh itself tells people to `PORT=3001 make run` when 3000 is taken: the
# browser was refused the stream and every pane sat blank. CORS is not the lock
# here; every stream still needs a token only the cockpit can mint. Set
# CLAWDLING_CORS_ORIGINS to an explicit list (e.g. a tunnel origin) and only
# that list is allowed.
DEFAULT_CORS_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"

# A shared HMAC secret shorter than this is not a secret. 32 bytes is the same
# floor `openssl rand -base64 32` produces and the floor install.sh already
# meets for NEXTAUTH_SECRET.
MIN_SECRET_LENGTH = 32

# Placeholder values that ship in templates and blog posts. A bridge booted on
# one of these is open to anyone who has read the repo.
_PLACEHOLDER_SECRETS = frozenset(
    {
        "change-me-shared-secret",
        "change-me",
        "changeme",
        "your-secret-here",
        "your-secret",
        "replace-me",
        "placeholder",
        "bridge-secret",
        "shared-secret",
        "secret",
        "password",
        "test",
        "testtesttesttesttesttesttesttest",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0123456789012345678901234567890123456789",
    }
)

# Substrings that mean "this was copied out of a template and never edited".
_PLACEHOLDER_MARKERS = ("change-me", "changeme", "your-secret", "replace-me", "xxxxxxxx")


class ConfigError(RuntimeError):
    """Raised when the environment cannot produce a safe running bridge."""


def _env(name: str, default: str | None = None) -> str | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    return raw if raw else default


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        floor = "positive" if minimum == 1 else f"at least {minimum}"
        raise ConfigError(f"{name} must be {floor}, got {value}")
    return value


#: Values a human writes when they mean "off". Anything else is on, so a typo
#: never silently disables persistence.
_FALSEY = frozenset({"0", "false", "no", "off"})


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    return raw.strip().lower() not in _FALSEY


def validate_secret(secret: str | None) -> str:
    """Return the secret, or raise ConfigError explaining why it is unusable."""
    if not secret:
        raise ConfigError(
            "BRIDGE_SECRET is not set. The bridge signs nothing and trusts "
            "nothing without it, so it refuses to boot.\n"
            "  Generate one:  openssl rand -base64 32\n"
            "  Then set the SAME value for the Next.js cockpit and the bridge."
        )
    secret = secret.strip()
    if len(secret) < MIN_SECRET_LENGTH:
        raise ConfigError(
            f"BRIDGE_SECRET is {len(secret)} chars; the minimum is "
            f"{MIN_SECRET_LENGTH}. Generate one: openssl rand -base64 32"
        )
    lowered = secret.lower()
    if lowered in _PLACEHOLDER_SECRETS or any(m in lowered for m in _PLACEHOLDER_MARKERS):
        raise ConfigError(
            "BRIDGE_SECRET is a known placeholder value. Anyone who has read "
            "this repo can mint tokens for your bridge. Generate a real one: "
            "openssl rand -base64 32"
        )
    if len(set(secret)) <= 4:
        raise ConfigError(
            "BRIDGE_SECRET has almost no entropy (4 or fewer distinct "
            "characters). Generate one: openssl rand -base64 32"
        )
    return secret


def _split_paths(raw: str | None) -> tuple[Path, ...]:
    if not raw:
        return ()
    parts = [p.strip() for chunk in raw.split(os.pathsep) for p in chunk.split(",")]
    out: list[Path] = []
    for part in parts:
        if not part:
            continue
        out.append(Path(part).expanduser().resolve())
    return tuple(out)


@dataclass(frozen=True)
class Config:
    """Resolved, validated runtime configuration."""

    secret: str
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    workspace_root: Path = field(default_factory=lambda: Path(DEFAULT_WORKSPACE_ROOT).expanduser())
    extra_roots: tuple[Path, ...] = ()
    max_sessions: int = DEFAULT_MAX_SESSIONS
    scrollback_bytes: int = DEFAULT_SCROLLBACK_BYTES
    state_root: Path = field(default_factory=lambda: Path(DEFAULT_STATE_ROOT).expanduser())
    transcripts_enabled: bool = True
    history_tail_bytes: int = DEFAULT_HISTORY_TAIL_BYTES
    transcript_max_file_bytes: int = DEFAULT_TRANSCRIPT_MAX_FILE_BYTES
    retention_count: int = DEFAULT_RETENTION_COUNT
    retention_days: int = DEFAULT_RETENTION_DAYS
    #: Pass `--session-id` on spawn and `--resume` on a resumed spawn. On by
    #: default for the real CLI; a bridge pointed at a stub binary that does
    #: not take those flags turns it off.
    resume_enabled: bool = True
    claude_bin: str = DEFAULT_CLAUDE_BIN
    repo_root: Path = field(default_factory=lambda: Path(__file__).resolve().parent.parent)
    profile: str = DEFAULT_PROFILE
    default_cols: int = DEFAULT_COLS
    default_rows: int = DEFAULT_ROWS
    cors_origins: tuple[str, ...] = ()
    #: Used only when no explicit list is configured ("" = none).
    cors_origin_regex: str = ""

    @property
    def allowed_roots(self) -> tuple[Path, ...]:
        """Every directory tree a session cwd may live under."""
        return (self.workspace_root, *self.extra_roots)

    @property
    def profile_dir(self) -> Path:
        return self.repo_root / "profiles" / self.profile

    @property
    def transcript_dir(self) -> Path:
        """Where per-session logs and sidecars live."""
        return self.state_root / "transcripts"

    @classmethod
    def from_env(cls) -> "Config":
        secret = validate_secret(os.environ.get("BRIDGE_SECRET"))

        workspace_root = (
            Path(_env("CLAWDLING_WORKSPACE_ROOT", DEFAULT_WORKSPACE_ROOT) or DEFAULT_WORKSPACE_ROOT)
            .expanduser()
        )
        # Create it before resolving so a first-run self-hoster is not told
        # their default workspace does not exist. resolve() after mkdir also
        # collapses the symlinks macOS puts in front of /tmp and /var.
        try:
            workspace_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ConfigError(
                f"CLAWDLING_WORKSPACE_ROOT {workspace_root} cannot be created: {exc}"
            ) from exc
        workspace_root = workspace_root.resolve()

        repo_root = Path(
            _env("CLAWDLING_REPO_ROOT") or str(Path(__file__).resolve().parent.parent)
        ).expanduser().resolve()

        # Not created here: TranscriptStore creates it, and degrades to
        # "persistence off" with one log line if it cannot. A bridge must
        # still boot and run panes on a read-only or full disk.
        state_root = Path(
            _env("CLAWDLING_STATE_ROOT", DEFAULT_STATE_ROOT) or DEFAULT_STATE_ROOT
        ).expanduser()

        origins_raw = _env("CLAWDLING_CORS_ORIGINS") or ""
        cors_origins = tuple(o.strip() for o in origins_raw.split(",") if o.strip())
        cors_origin_regex = "" if cors_origins else DEFAULT_CORS_ORIGIN_REGEX

        return cls(
            secret=secret,
            host=_env("BRIDGE_HOST", DEFAULT_HOST) or DEFAULT_HOST,
            port=_env_int("BRIDGE_PORT", DEFAULT_PORT),
            workspace_root=workspace_root,
            extra_roots=_split_paths(_env("CLAWDLING_WORKSPACE_ALLOWLIST")),
            max_sessions=_env_int("CLAWDLING_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
            scrollback_bytes=_env_int("CLAWDLING_SCROLLBACK_BYTES", DEFAULT_SCROLLBACK_BYTES),
            state_root=state_root,
            transcripts_enabled=_env_bool("CLAWDLING_TRANSCRIPTS", True),
            history_tail_bytes=_env_int(
                "CLAWDLING_HISTORY_TAIL_BYTES", DEFAULT_HISTORY_TAIL_BYTES
            ),
            transcript_max_file_bytes=_env_int(
                "CLAWDLING_TRANSCRIPT_MAX_FILE_BYTES",
                DEFAULT_TRANSCRIPT_MAX_FILE_BYTES,
                minimum=4096,
            ),
            # 0 disables that half of retention, so each cap can be used alone.
            retention_count=_env_int(
                "CLAWDLING_TRANSCRIPT_RETENTION", DEFAULT_RETENTION_COUNT, minimum=0
            ),
            retention_days=_env_int(
                "CLAWDLING_TRANSCRIPT_MAX_AGE_DAYS", DEFAULT_RETENTION_DAYS, minimum=0
            ),
            resume_enabled=_env_bool("CLAWDLING_RESUME", True),
            claude_bin=_env("CLAWDLING_CLAUDE_BIN", DEFAULT_CLAUDE_BIN) or DEFAULT_CLAUDE_BIN,
            repo_root=repo_root,
            profile=_env("ADJUTANT_PROFILE", DEFAULT_PROFILE) or DEFAULT_PROFILE,
            default_cols=_env_int("CLAWDLING_DEFAULT_COLS", DEFAULT_COLS),
            default_rows=_env_int("CLAWDLING_DEFAULT_ROWS", DEFAULT_ROWS),
            cors_origins=cors_origins,
            cors_origin_regex=cors_origin_regex,
        )
