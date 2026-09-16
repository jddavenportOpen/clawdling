"""Background worker runs.

A cockpit **pane** is a PTY you type into: interactive, attended, alive only
while somebody is watching. A **worker** is the other half of that story. You
hand it an objective, it runs headless and unattended, and it reports when it
is done. Nobody types into a worker.

The shape, and why each piece is load-bearing:

  1. **A run id (uuid4).** It is the primary key, the CLI `--session-id`, the
     name of the run's directory, and the name of its git branch, so a run can
     be traced from a list row to a process to a commit.
  2. **Its own git worktree.** Parallel workers write files. Without a worktree
     two of them share one index and one HEAD, and the second one to run
     `git checkout` silently rips the tree out from under the first. If the
     target is NOT a git repo we run in a plain directory and say so in the
     record (`isolation: "none"` plus the reason) rather than implying an
     isolation we did not get.
  3. **A WORKPLAN.md in that worktree.** An unattended run outlives its own
     context window. The objective has to exist on disk, inside the working
     directory, or a compaction loses the task. The dispatch prompt points at
     the file so re-reading it is the obvious recovery move.
  4. **Headless, not a PTY.** `claude --session-id <run_id> -p --output-format
     stream-json --verbose <prompt>`, stdout captured to a JSONL events file.
     There is no terminal because there is no typist.
  5. **A wall-clock ceiling.** An unattended process with no deadline is a leak
     wearing a hat. Every run carries one and is reaped on expiry.
  6. **Outcome read from the events file.** The exit code alone cannot tell
     "finished the job" from "gave up politely", so the final `result` frame
     decides, with the exit code as the tiebreak.

Security notes that mirror bridge/pty.py: argv is exec'd directly (no shell,
ever), the child's environment has the bridge's own secrets stripped, the child
gets its own process group so teardown reaches its grandchildren, and stdin is
`/dev/null` so a headless CLI can never block waiting on a human.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .config import Config, ConfigError
from .pty import build_child_env

# ── status vocabulary ────────────────────────────────────────────────────────

STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_TIMEOUT = "timeout"
STATUS_KILLED = "killed"

#: A run in any of these is finished forever. Nothing re-enters `running`.
TERMINAL_STATUSES = frozenset(
    {STATUS_DONE, STATUS_FAILED, STATUS_TIMEOUT, STATUS_KILLED}
)

# ── defaults ─────────────────────────────────────────────────────────────────

DEFAULT_MAX_WORKERS = 4
DEFAULT_MAX_RUNTIME_SECONDS = 30 * 60
#: Nothing may ask for a longer ceiling than this. A run that needs more than a
#: day is a pipeline, not a worker.
RUNTIME_CEILING_SECONDS = 24 * 60 * 60
DEFAULT_WORKER_DIRNAME = ".clawdling-workers"
DEFAULT_GIT_BIN = "git"

#: argv has an OS length limit and a 100KB "objective" is a mistake, not a task.
MAX_OBJECTIVE_CHARS = 16_000
#: Tail reads never slurp a whole log; this is the window we look back over.
LOG_TAIL_WINDOW_BYTES = 512 * 1024
DEFAULT_LOG_TAIL_LINES = 200
MAX_LOG_TAIL_LINES = 5_000

#: Git calls are bounded so a wedged git (a stale index.lock, a network remote)
#: cannot hang a request thread forever.
GIT_TIMEOUT_SECONDS = 60.0

#: Permission modes a caller may request. `bypassPermissions` is deliberately
#: NOT here: an unattended run with no human in the loop is the worst possible
#: place to pre-approve every tool call, and a caller who genuinely wants that
#: posture can set it in their own Claude Code settings where it is visible.
ALLOWED_PERMISSION_MODES = ("default", "acceptEdits", "plan")

#: Branch/dir components are derived from a uuid4, but the name is also built
#: from caller-supplied text, so it is filtered rather than trusted.
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")

_STREAMS = ("events", "stderr")


class WorkerError(RuntimeError):
    """A worker request that cannot be served (cap reached, bad input)."""


class WorkerLimitError(WorkerError):
    """The concurrency cap is full. The bridge is healthy; the caller is over."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _is_within(candidate: Path, root: Path) -> bool:
    return candidate == root or root in candidate.parents


def _safe_component(text: str, fallback: str) -> str:
    cleaned = _SAFE_NAME_RE.sub("-", str(text or "").strip()).strip("-.")
    return cleaned[:48] or fallback


# ── configuration ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WorkerConfig:
    """Worker-only knobs.

    These live here rather than in bridge/config.py on purpose: the worker
    surface is additive to the v1 session contract, and keeping its env reads
    local means adding a worker knob never touches the file every session route
    already depends on. `Config` still supplies everything shared (the claude
    binary, the workspace root), so there is exactly one source for those.
    """

    root: Path
    max_workers: int = DEFAULT_MAX_WORKERS
    default_runtime_sec: int = DEFAULT_MAX_RUNTIME_SECONDS
    git_bin: str = DEFAULT_GIT_BIN

    @property
    def runs_dir(self) -> Path:
        return self.root / "runs"

    @property
    def worktrees_dir(self) -> Path:
        return self.root / "worktrees"

    @classmethod
    def from_env(cls, config: Config) -> "WorkerConfig":
        raw_root = os.environ.get("CLAWDLING_WORKER_ROOT", "").strip()
        root = (
            Path(raw_root).expanduser()
            if raw_root
            else config.workspace_root / DEFAULT_WORKER_DIRNAME
        )
        # Resolved so the paths a run reports match the resolved cwd the session
        # routes already report. On macOS /tmp is a symlink to /private/tmp, so
        # an unresolved root would print two spellings of the same directory.
        try:
            root.mkdir(parents=True, exist_ok=True)
            root = root.resolve()
        except OSError as exc:
            raise ConfigError(
                f"CLAWDLING_WORKER_ROOT {root} cannot be created: {exc}"
            ) from exc
        return cls(
            root=root,
            max_workers=_env_int("CLAWDLING_MAX_WORKERS", DEFAULT_MAX_WORKERS),
            default_runtime_sec=_env_int(
                "CLAWDLING_WORKER_MAX_RUNTIME", DEFAULT_MAX_RUNTIME_SECONDS
            ),
            git_bin=os.environ.get("CLAWDLING_GIT_BIN", "").strip() or DEFAULT_GIT_BIN,
        )


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        # ConfigError, not WorkerError: this is read at boot, where main.py's
        # handler turns it into a readable refusal instead of a traceback.
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if value <= 0:
        raise ConfigError(f"{name} must be positive, got {value}")
    return value


# ── isolation ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Isolation:
    """Where a run will actually execute, and how isolated that really is."""

    cwd: Path
    kind: str  # "worktree" | "none"
    note: str | None = None
    repo_root: Path | None = None
    worktree: Path | None = None
    branch: str | None = None

    @property
    def isolated(self) -> bool:
        return self.kind == "worktree"


@dataclass(frozen=True)
class ReapResult:
    ok: bool
    reason: str | None = None
    removed: Path | None = None


# ── a single run ─────────────────────────────────────────────────────────────


@dataclass
class WorkerRun:
    run_id: str
    name: str
    objective: str
    base_cwd: Path
    cwd: Path
    events_path: Path
    stderr_path: Path
    max_runtime_sec: int
    isolation: str = "none"
    isolation_note: str | None = None
    repo_root: Path | None = None
    worktree: Path | None = None
    branch: str | None = None
    workplan: Path | None = None
    domain: str | None = None
    agent: str | None = None
    model: str | None = None
    permission_mode: str | None = None

    status: str = STATUS_RUNNING
    exit_code: int | None = None
    pid: int | None = None
    created_at: str = field(default_factory=_now_iso)
    ended_at: str | None = None

    #: Filled from the final `result` frame once the run ends.
    summary: str | None = None
    result_subtype: str | None = None
    num_turns: int | None = None
    detail: str | None = None
    worktree_reaped: bool = False

    # Internals (never serialized).
    _proc: subprocess.Popen | None = field(default=None, repr=False, compare=False)
    _started_monotonic: float = field(default_factory=time.monotonic, repr=False)
    _ended_monotonic: float | None = field(default=None, repr=False, compare=False)
    _kill_requested: bool = field(default=False, repr=False, compare=False)
    _thread: threading.Thread | None = field(default=None, repr=False, compare=False)

    @property
    def finished(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def elapsed_sec(self) -> float:
        end = self._ended_monotonic if self._ended_monotonic is not None else time.monotonic()
        return round(max(0.0, end - self._started_monotonic), 3)

    def snapshot(self) -> dict:
        """The wire shape. Paths become strings; nothing internal leaks."""
        return {
            "run_id": self.run_id,
            "name": self.name,
            "objective": self.objective,
            "status": self.status,
            "exit_code": self.exit_code,
            "cwd": str(self.cwd),
            "base_cwd": str(self.base_cwd),
            "isolation": self.isolation,
            "isolated": self.isolation == "worktree",
            "isolation_note": self.isolation_note,
            "worktree": str(self.worktree) if self.worktree else None,
            "branch": self.branch,
            "workplan": str(self.workplan) if self.workplan else None,
            "worktree_reaped": self.worktree_reaped,
            "domain": self.domain,
            "agent": self.agent,
            "model": self.model,
            "permission_mode": self.permission_mode,
            "max_runtime_sec": self.max_runtime_sec,
            "elapsed_sec": self.elapsed_sec,
            "created_at": self.created_at,
            "ended_at": self.ended_at,
            "pid": self.pid,
            "summary": self.summary,
            "result_subtype": self.result_subtype,
            "num_turns": self.num_turns,
            "detail": self.detail,
        }


# ── prompt + argv construction ───────────────────────────────────────────────


WORKPLAN_TEMPLATE = """# WORKPLAN - {name}

- run id: `{run_id}`
- dispatched: {created_at}
- working directory: `{cwd}`
- isolation: {isolation}

## Objective

{objective}

## How to use this file

You are a background worker. Nobody is attached to this run and nobody will
answer a question, so this file is your memory of the job. Re-read it whenever
you lose the thread (after a compaction, after a long tool result, before you
decide you are finished). Keep notes and a checklist under the section below
so a later loop can see what the earlier one already did.

Finish by leaving the work in this directory. Commit it if this run has its own
branch. Do not push, and do not touch anything outside this directory.

## Progress
"""


def build_workplan(run_id: str, name: str, objective: str, cwd: Path, isolation: Isolation) -> str:
    if isolation.isolated:
        iso = f"git worktree on branch `{isolation.branch}`"
    else:
        iso = f"NONE (plain directory) - {isolation.note or 'no reason recorded'}"
    return WORKPLAN_TEMPLATE.format(
        name=name,
        run_id=run_id,
        created_at=_now_iso(),
        cwd=cwd,
        isolation=iso,
        objective=objective.strip(),
    )


def build_dispatch_prompt(objective: str, workplan: Path | None, run_id: str) -> str:
    """The prompt the CLI actually receives.

    The objective verbatim, plus one footer pointing at the on-disk WORKPLAN.
    The pointer is the whole reason the file exists: the run outlives its own
    context, so the recovery move has to be named in the prompt itself.
    """
    text = objective.strip()
    if workplan is None:
        return f"{text}\n\n---\nYou are an unattended background worker (run {run_id})."
    return (
        f"{text}\n\n---\n"
        f"You are an unattended background worker (run {run_id}). Your objective "
        f"is also written to {workplan.name} in this directory; re-read that file "
        f"whenever you need to re-establish what you are doing. Nobody is "
        f"watching this session, so do not ask questions - decide, act, and "
        f"record what you did."
    )


def build_worker_argv(
    *,
    claude_bin: str,
    run_id: str,
    prompt: str,
    model: str | None = None,
    prompt_file: Path | None = None,
    permission_mode: str | None = None,
) -> list[str]:
    """Headless argv. Exec'd directly; no shell is involved anywhere."""
    argv = [
        claude_bin,
        "--session-id",
        run_id,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    if model:
        argv += ["--model", model]
    if prompt_file is not None:
        argv += ["--append-system-prompt-file", str(prompt_file)]
    if permission_mode:
        argv += ["--permission-mode", permission_mode]
    argv.append(prompt)
    return argv


# ── events-file outcome reading ──────────────────────────────────────────────


#: How far back from the end of an events file we look for the result frame.
#: The frame is the last thing the CLI writes, so a bounded tail read is both
#: correct and safe on a multi-hour run that produced a very large log.
RESULT_SCAN_BYTES = 1 << 20


def read_result_frame(events_path: Path) -> dict | None:
    """Find the CLI's final `{"type": "result", ...}` frame.

    Scanned from the END because the frame is the last thing the CLI writes and
    a long run's events file can be large. A non-JSON line (a fake binary, a
    crash message) is skipped, not fatal: the caller falls back to the exit
    code, which is the honest answer when the stream never said anything.
    """
    try:
        size = events_path.stat().st_size
        with open(events_path, "rb") as fh:
            start = max(0, size - RESULT_SCAN_BYTES)
            fh.seek(start)
            raw = fh.read()
        if start > 0:
            # The window almost certainly cut the first line in half; a half
            # line is not JSON and would be skipped anyway, but dropping it
            # keeps the scan honest about what it is looking at.
            _, _, raw = raw.partition(b"\n")
    except OSError:
        return None
    for line in reversed(raw.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            frame = json.loads(stripped.decode("utf-8", errors="replace"))
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(frame, dict) and frame.get("type") == "result":
            return frame
    return None


def classify_outcome(
    *,
    exit_code: int | None,
    result: dict | None,
    killed: bool,
    timed_out: bool,
) -> tuple[str, str | None]:
    """Decide the terminal status. Returns (status, detail).

    Order matters. A killed or timed-out run is that, whatever the process
    said on the way out. Otherwise the CLI's own verdict (`is_error`) beats a
    zero exit code, because "I could not do this" exits 0.
    """
    if killed:
        return STATUS_KILLED, "terminated by request"
    if timed_out:
        return STATUS_TIMEOUT, "exceeded its wall-clock ceiling"
    if result is not None and bool(result.get("is_error")):
        subtype = result.get("subtype")
        return STATUS_FAILED, f"the run reported an error ({subtype or 'unspecified'})"
    if exit_code == 0:
        if result is None:
            # Exited clean but never emitted a result frame. Report it as done
            # and SAY that the verdict came from the exit code alone, rather
            # than quietly implying the agent confirmed success.
            return STATUS_DONE, "exit code 0; no result frame in the event stream"
        return STATUS_DONE, None
    return STATUS_FAILED, f"exited {exit_code}"


# ── the manager ──────────────────────────────────────────────────────────────


class WorkerManager:
    """Every worker run this bridge has dispatched, keyed by run id."""

    def __init__(self, *, config: WorkerConfig, claude_bin: str) -> None:
        self.config = config
        self.claude_bin = claude_bin
        self._runs: dict[str, WorkerRun] = {}
        self._lock = threading.RLock()
        self._shutting_down = False
        #: Slots claimed by an in-flight spawn. A dispatch does real work (git
        #: worktree add, fork) outside the lock, so without a reservation two
        #: concurrent dispatches could both pass the cap check and both win.
        self._reserved = 0

    # ── queries ──────────────────────────────────────────────────────────────

    def get(self, run_id: str) -> WorkerRun | None:
        with self._lock:
            return self._runs.get(run_id)

    def list(self) -> list[WorkerRun]:
        with self._lock:
            return list(self._runs.values())

    def running_count(self) -> int:
        with self._lock:
            return sum(1 for r in self._runs.values() if not r.finished)

    def _claimed(self) -> int:
        """Running runs plus in-flight dispatches. The number the cap governs."""
        with self._lock:
            return self.running_count() + self._reserved

    # ── git plumbing ─────────────────────────────────────────────────────────

    def _git(
        self, cwd: Path, *args: str, stdin_text: str | None = None
    ) -> subprocess.CompletedProcess:
        """Run one git command. argv list, never a shell string."""
        return subprocess.run(  # noqa: S603 - argv list, no shell
            [self.config.git_bin, "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            input=stdin_text,
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )

    def _repo_root(self, base: Path) -> Path | None:
        try:
            proc = self._git(base, "rev-parse", "--show-toplevel")
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode != 0:
            return None
        text = proc.stdout.strip()
        if not text:
            return None
        try:
            return Path(text).resolve()
        except OSError:  # pragma: no cover - unresolvable toplevel
            return None

    def prepare_isolation(self, base: Path, run_id: str) -> Isolation:
        """Give the run its own worktree, or say plainly why it could not have one."""
        repo_root = self._repo_root(base)
        if repo_root is None:
            return Isolation(cwd=base, kind="none", note="the working directory is not a git repository")

        try:
            head = self._git(repo_root, "rev-parse", "--verify", "HEAD")
        except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover
            return Isolation(cwd=base, kind="none", note=f"git is not usable here: {exc}")
        if head.returncode != 0:
            return Isolation(
                cwd=base,
                kind="none",
                note="the repository has no commits yet, so it has nothing to branch from",
            )

        worktree = self.config.worktrees_dir / run_id
        branch = f"clawdling/worker-{run_id[:8]}"
        try:
            self.config.worktrees_dir.mkdir(parents=True, exist_ok=True)
            added = self._git(
                repo_root, "worktree", "add", "-b", branch, str(worktree), "HEAD"
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return Isolation(cwd=base, kind="none", note=f"could not create a worktree: {exc}")
        if added.returncode != 0:
            detail = (added.stderr or added.stdout or "").strip().splitlines()
            return Isolation(
                cwd=base,
                kind="none",
                note=f"git worktree add failed: {detail[-1] if detail else 'unknown error'}",
            )

        # Run in the worktree's copy of whatever subdirectory was requested, so
        # a spawn pointed at repo/services/api lands in the same place.
        run_cwd = worktree
        note = None
        try:
            rel = base.resolve().relative_to(repo_root)
        except ValueError:  # pragma: no cover - base outside its own toplevel
            rel = Path(".")
        if str(rel) not in ("", "."):
            candidate = worktree / rel
            if candidate.is_dir():
                run_cwd = candidate
            else:
                note = (
                    f"{rel} is not tracked at HEAD, so the run starts at the "
                    "worktree root instead"
                )

        return Isolation(
            cwd=run_cwd,
            kind="worktree",
            note=note,
            repo_root=repo_root,
            worktree=worktree,
            branch=branch,
        )

    # ── spawn ────────────────────────────────────────────────────────────────

    def spawn(
        self,
        *,
        objective: str,
        cwd: Path,
        domain: str | None = None,
        agent: str | None = None,
        model: str | None = None,
        prompt_file: Path | None = None,
        name: str | None = None,
        max_runtime_sec: int | None = None,
        permission_mode: str | None = None,
        env: dict[str, str] | None = None,
    ) -> WorkerRun:
        """Dispatch one worker. Returns as soon as the child is running."""
        text = (objective or "").strip()
        if not text:
            raise WorkerError("objective is required")
        if len(text) > MAX_OBJECTIVE_CHARS:
            raise WorkerError(
                f"objective is {len(text)} characters; the limit is {MAX_OBJECTIVE_CHARS}"
            )
        if permission_mode and permission_mode not in ALLOWED_PERMISSION_MODES:
            raise WorkerError(
                f"permission_mode {permission_mode!r} is not allowed. "
                f"Allowed: {', '.join(ALLOWED_PERMISSION_MODES)}"
            )

        runtime = int(max_runtime_sec or self.config.default_runtime_sec)
        if runtime <= 0:
            raise WorkerError("max_runtime_sec must be positive")
        if runtime > RUNTIME_CEILING_SECONDS:
            raise WorkerError(
                f"max_runtime_sec {runtime} exceeds the ceiling of "
                f"{RUNTIME_CEILING_SECONDS} seconds"
            )

        with self._lock:
            if self._shutting_down:
                raise WorkerError("the bridge is shutting down")
            if self._claimed() >= self.config.max_workers:
                raise WorkerLimitError(
                    f"worker limit reached ({self.config.max_workers} running). "
                    "Wait for one to finish, or raise CLAWDLING_MAX_WORKERS."
                )
            self._reserved += 1

        try:
            return self._spawn_reserved(
                objective=text,
                cwd=cwd,
                domain=domain,
                agent=agent,
                model=model,
                prompt_file=prompt_file,
                name=name,
                runtime=runtime,
                permission_mode=permission_mode,
                env=env,
            )
        finally:
            # Released only after the run is registered, so the count never dips
            # between "reservation gone" and "run visible".
            with self._lock:
                self._reserved -= 1

    def _spawn_reserved(
        self,
        *,
        objective: str,
        cwd: Path,
        domain: str | None,
        agent: str | None,
        model: str | None,
        prompt_file: Path | None,
        name: str | None,
        runtime: int,
        permission_mode: str | None,
        env: dict[str, str] | None,
    ) -> WorkerRun:
        """The body of spawn(), running with a concurrency slot already held."""
        text = objective
        run_id = str(uuid.uuid4())
        run_dir = self.config.runs_dir / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        events_path = run_dir / "events.jsonl"
        stderr_path = run_dir / "stderr.log"

        isolation = self.prepare_isolation(cwd, run_id)
        display_name = _safe_component(
            name or f"{domain or cwd.name or 'worker'}-{run_id[:8]}", f"worker-{run_id[:8]}"
        )

        workplan_path = self._write_workplan(
            isolation.cwd, run_id, display_name, text, isolation
        )

        run = WorkerRun(
            run_id=run_id,
            name=display_name,
            objective=text,
            base_cwd=cwd,
            cwd=isolation.cwd,
            events_path=events_path,
            stderr_path=stderr_path,
            max_runtime_sec=runtime,
            isolation=isolation.kind,
            isolation_note=isolation.note,
            repo_root=isolation.repo_root,
            worktree=isolation.worktree,
            branch=isolation.branch,
            workplan=workplan_path,
            domain=domain,
            agent=agent,
            model=model,
            permission_mode=permission_mode,
        )

        argv = build_worker_argv(
            claude_bin=self.claude_bin,
            run_id=run_id,
            prompt=build_dispatch_prompt(text, workplan_path, run_id),
            model=model,
            prompt_file=prompt_file,
            permission_mode=permission_mode,
        )
        child_env = dict(env) if env is not None else build_child_env()
        child_env.setdefault("CLAWDLING_WORKER_RUN_ID", run_id)

        try:
            proc = self._launch(argv, isolation.cwd, child_env, events_path, stderr_path)
        except OSError:
            # The worktree is dead weight if the child never started. Remove it
            # before the record exists, so no orphan survives a failed spawn.
            self._discard_worktree(isolation)
            raise

        run._proc = proc
        run.pid = proc.pid
        run._started_monotonic = time.monotonic()

        with self._lock:
            self._runs[run_id] = run

        watcher = threading.Thread(
            target=self._watch,
            args=(run, proc, runtime),
            name=f"worker-{run_id[:8]}",
            daemon=True,
        )
        run._thread = watcher
        watcher.start()
        return run

    def _write_workplan(
        self, cwd: Path, run_id: str, name: str, objective: str, isolation: Isolation
    ) -> Path | None:
        """Write the WORKPLAN, never over an existing file.

        In the non-isolated fallback the target is a directory the user owns, so
        clobbering their WORKPLAN.md would destroy real work. A run-suffixed
        name is used whenever the plain one is taken, in a worktree too, so the
        rule has exactly one behaviour to reason about.
        """
        target = cwd / "WORKPLAN.md"
        if target.exists():
            target = cwd / f"WORKPLAN-{run_id[:8]}.md"
        try:
            cwd.mkdir(parents=True, exist_ok=True)
            target.write_text(
                build_workplan(run_id, name, objective, cwd, isolation), encoding="utf-8"
            )
        except OSError:
            # A read-only cwd is a real possibility. The run can still proceed;
            # it just loses its on-disk memory, and the record says so by
            # carrying a null workplan.
            return None
        return target

    def _launch(
        self,
        argv: list[str],
        cwd: Path,
        env: dict[str, str],
        events_path: Path,
        stderr_path: Path,
    ) -> subprocess.Popen:
        """Start the child with its own process group and no stdin.

        stdout and stderr go to SEPARATE files on purpose: stdout is a JSONL
        stream that a parser reads, and interleaving a stack trace into it would
        corrupt the one artifact the outcome is read from.
        """
        events_fh = open(events_path, "ab", buffering=0)
        try:
            stderr_fh = open(stderr_path, "ab", buffering=0)
        except OSError:
            events_fh.close()
            raise
        try:
            return subprocess.Popen(  # noqa: S603 - argv list, no shell
                argv,
                cwd=str(cwd),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=events_fh,
                stderr=stderr_fh,
                close_fds=True,
                # setsid: the child leads its own process group, so a SIGTERM to
                # the group also reaches whatever the agent itself spawned.
                start_new_session=True,
            )
        finally:
            # The child holds its own dups. Ours would otherwise leak one pair
            # of descriptors per dispatched run.
            events_fh.close()
            stderr_fh.close()

    # ── lifecycle ────────────────────────────────────────────────────────────

    def _watch(self, run: WorkerRun, proc: subprocess.Popen, runtime: int) -> None:
        """One watcher thread per run: waits, enforces the ceiling, finalizes."""
        timed_out = False
        try:
            proc.wait(timeout=runtime)
        except subprocess.TimeoutExpired:
            timed_out = True
            self._terminate(proc)
        except Exception:  # pragma: no cover - defensive; never leave a run hung
            pass
        try:
            exit_code = proc.wait(timeout=30)
        except Exception:  # pragma: no cover
            exit_code = proc.returncode
        self._finalize(run, exit_code, timed_out=timed_out)

    def _terminate(self, proc: subprocess.Popen, grace: float = 5.0) -> None:
        """SIGTERM the group, then SIGKILL it. Safe to call on a dead child."""
        self._signal_group(proc, signal.SIGTERM)
        try:
            proc.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            pass
        self._signal_group(proc, signal.SIGKILL)

    @staticmethod
    def _signal_group(proc: subprocess.Popen, sig: int) -> None:
        if proc.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.send_signal(sig)
            except (ProcessLookupError, OSError, ValueError):  # pragma: no cover
                pass

    def _finalize(self, run: WorkerRun, exit_code: int | None, *, timed_out: bool) -> None:
        result = read_result_frame(run.events_path)
        with self._lock:
            if run.finished:  # pragma: no cover - two finalizers raced
                return
            status, detail = classify_outcome(
                exit_code=exit_code,
                result=result,
                killed=run._kill_requested,
                timed_out=timed_out,
            )
            run.status = status
            run.exit_code = exit_code
            run.detail = detail
            run.ended_at = _now_iso()
            run._ended_monotonic = time.monotonic()
            if result is not None:
                raw_summary = result.get("result")
                if isinstance(raw_summary, str) and raw_summary.strip():
                    run.summary = raw_summary.strip()[:4000]
                subtype = result.get("subtype")
                run.result_subtype = subtype if isinstance(subtype, str) else None
                turns = result.get("num_turns")
                run.num_turns = turns if isinstance(turns, int) else None

    def kill(self, run_id: str, grace: float = 5.0) -> WorkerRun | None:
        """Stop a run. Idempotent; a finished run is returned untouched."""
        run = self.get(run_id)
        if run is None:
            return None
        with self._lock:
            if run.finished:
                return run
            run._kill_requested = True
        proc = run._proc
        if proc is not None:
            self._terminate(proc, grace=grace)
        thread = run._thread
        if thread is not None:
            thread.join(timeout=grace + 30)
        return run

    def shutdown(self, grace: float = 5.0) -> None:
        """Kill every live run. Called from the app lifespan on SIGTERM/SIGINT."""
        with self._lock:
            self._shutting_down = True
            live = [r for r in self._runs.values() if not r.finished]
        for run in live:
            run._kill_requested = True
            if run._proc is not None:
                self._terminate(run._proc, grace=grace)
        for run in live:
            if run._thread is not None:
                run._thread.join(timeout=grace + 5)

    def kill_all_now(self) -> None:
        """Last-resort synchronous sweep for the atexit hook."""
        for run in self.list():
            if run.finished or run._proc is None:
                continue
            self._signal_group(run._proc, signal.SIGKILL)

    # ── logs ─────────────────────────────────────────────────────────────────

    def log_path(self, run: WorkerRun, stream: str) -> Path:
        if stream not in _STREAMS:
            raise WorkerError(f"unknown stream {stream!r}. Use one of: {', '.join(_STREAMS)}")
        return run.events_path if stream == "events" else run.stderr_path

    def log_tail(
        self, run: WorkerRun, *, stream: str = "events", lines: int = DEFAULT_LOG_TAIL_LINES
    ) -> dict:
        """The last N lines of a run's log, without reading the whole file."""
        count = max(1, min(int(lines), MAX_LOG_TAIL_LINES))
        path = self.log_path(run, stream)
        try:
            size = path.stat().st_size
        except OSError:
            return {
                "run_id": run.run_id,
                "stream": stream,
                "size_bytes": 0,
                "offset": 0,
                "truncated": False,
                "lines": [],
            }
        start = max(0, size - LOG_TAIL_WINDOW_BYTES)
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                data = fh.read()
        except OSError:  # pragma: no cover - raced with a delete
            data = b""
        text_lines = data.decode("utf-8", errors="replace").splitlines()
        if start > 0 and text_lines:
            # The window almost certainly cut the first line in half.
            text_lines = text_lines[1:]
        truncated = start > 0 or len(text_lines) > count
        return {
            "run_id": run.run_id,
            "stream": stream,
            "size_bytes": size,
            "offset": size,
            "truncated": truncated,
            "lines": text_lines[-count:],
        }

    # ── reaping ──────────────────────────────────────────────────────────────

    def _discard_worktree(self, isolation: Isolation) -> None:
        """Remove a worktree created for a run that never started."""
        if not isolation.isolated or isolation.worktree is None or isolation.repo_root is None:
            return
        try:
            self._git(isolation.repo_root, "worktree", "remove", "--force", str(isolation.worktree))
            if isolation.branch:
                self._git(isolation.repo_root, "branch", "-D", isolation.branch)
        except (OSError, subprocess.SubprocessError):  # pragma: no cover
            pass

    def reap(self, run_id: str, *, force: bool = False) -> ReapResult:
        """Delete a finished run's worktree, refusing whenever work could be lost.

        Refusals, in the order they are checked:
          - the run is still going;
          - the path is not under the configured worktree root (this is the one
            rule that is never overridable: we do not delete outside our tree);
          - git cannot answer whether the branch holds unpublished commits
            (BLIND is a refusal, never a pass);
          - it holds commits reachable from no other ref;
          - it holds uncommitted changes.

        The last two are what `force=True` overrides. `force` is deliberately
        NOT reachable from the HTTP surface - a caller who wants to throw work
        away can say so in Python, where it is visible in a diff.
        """
        run = self.get(run_id)
        if run is None:
            return ReapResult(False, f"unknown run {run_id}")
        if not run.finished:
            return ReapResult(False, "the run is still going; kill it first")
        if run.worktree is None:
            return ReapResult(True, "this run had no worktree to reap")
        if run.worktree_reaped:
            return ReapResult(True, "already reaped")

        worktree = run.worktree
        root = self.config.worktrees_dir.resolve()
        try:
            resolved = worktree.resolve()
        except OSError:  # pragma: no cover
            resolved = worktree
        if not _is_within(resolved, root):
            return ReapResult(
                False,
                f"{resolved} is outside the configured worktree root ({root}); refusing to delete it",
            )

        if not resolved.exists():
            run.worktree_reaped = True
            return ReapResult(True, "the worktree directory was already gone", removed=resolved)

        if not force:
            refusal = self._unsafe_to_reap(run, resolved)
            if refusal is not None:
                return ReapResult(False, refusal)

        repo_root = run.repo_root or resolved
        try:
            removed = self._git(repo_root, "worktree", "remove", "--force", str(resolved))
        except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover
            return ReapResult(False, f"git worktree remove failed: {exc}")
        if removed.returncode != 0 and resolved.exists():
            return ReapResult(
                False,
                f"git worktree remove failed: {(removed.stderr or '').strip()[:300]}",
            )
        if resolved.exists():  # pragma: no cover - git said ok but left the dir
            shutil.rmtree(resolved, ignore_errors=True)
        if run.branch:
            # Reaping the branch too, so a reap does not leave an ancient local
            # ref behind for a future `worktree add -b` to collide with.
            self._git(repo_root, "branch", "-D", run.branch)
        self._git(repo_root, "worktree", "prune")
        run.worktree_reaped = True
        return ReapResult(True, removed=resolved)

    def _unsafe_to_reap(self, run: WorkerRun, worktree: Path) -> str | None:
        """Return a refusal reason, or None when the worktree is safe to delete.

        The rule the design asks for is "holds commits not reachable from any
        remote". That exact test makes a repo with NO remote permanently
        unreapable (every commit is unreachable from the empty set), which would
        make this feature useless on the local-only repos self-hosters actually
        have. So the question asked is the generalisation that still cannot lose
        a commit: is anything reachable from THIS branch and from no other ref -
        remote or local? A commit already merged to main, or already pushed, is
        reachable and therefore safe.

        The refs are enumerated explicitly rather than written as
        `rev-list HEAD --not --exclude=<ours> --all`, because `--all` also
        pretends HEAD is listed - and inside this worktree HEAD *is* our branch,
        so that spelling silently excludes the very commits it is meant to find.
        It reports "clean" for a worktree full of unpushed work. Revs go over
        stdin so a repo with thousands of refs cannot overflow argv.
        """
        try:
            listed = self._git(worktree, "for-each-ref", "--format=%(refname)")
        except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover
            return f"could not enumerate refs ({exc}); refusing to delete"
        if listed.returncode != 0:  # pragma: no cover
            return "could not enumerate refs; refusing to delete"

        own = f"refs/heads/{run.branch}" if run.branch else None
        all_refs = [r.strip() for r in listed.stdout.splitlines() if r.strip()]
        others = [r for r in all_refs if r != own]

        revs = ["HEAD"]
        if own and own in all_refs:
            revs.append(own)
        revs.extend(f"^{ref}" for ref in others)

        try:
            unreachable = self._git(
                worktree, "rev-list", "--stdin", stdin_text="\n".join(revs) + "\n"
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return f"could not check for unpublished commits ({exc}); refusing to delete"
        if unreachable.returncode != 0:
            return (
                "could not check for unpublished commits "
                f"({(unreachable.stderr or '').strip()[:200]}); refusing to delete"
            )
        shas = [s for s in unreachable.stdout.split() if s]
        if shas:
            return (
                f"the worktree holds {len(shas)} commit(s) reachable from no other ref "
                f"(e.g. {shas[0][:12]}). Merge or push the branch {run.branch!r} first."
            )

        try:
            dirty = self._git(worktree, "status", "--porcelain")
        except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover
            return f"could not check for uncommitted changes ({exc}); refusing to delete"
        if dirty.returncode != 0:  # pragma: no cover
            return "could not check for uncommitted changes; refusing to delete"
        workplan_name = run.workplan.name if run.workplan else None
        leftovers = [
            line
            for line in dirty.stdout.splitlines()
            if line.strip() and not (workplan_name and line.strip().endswith(workplan_name))
        ]
        if leftovers:
            return (
                f"the worktree has {len(leftovers)} uncommitted change(s) "
                f"(e.g. {leftovers[0].strip()[:80]}). Commit or discard them first."
            )
        return None


__all__ = [
    "ALLOWED_PERMISSION_MODES",
    "DEFAULT_LOG_TAIL_LINES",
    "Isolation",
    "MAX_LOG_TAIL_LINES",
    "MAX_OBJECTIVE_CHARS",
    "ReapResult",
    "RUNTIME_CEILING_SECONDS",
    "STATUS_DONE",
    "STATUS_FAILED",
    "STATUS_KILLED",
    "STATUS_RUNNING",
    "STATUS_TIMEOUT",
    "TERMINAL_STATUSES",
    "WorkerConfig",
    "WorkerError",
    "WorkerLimitError",
    "WorkerManager",
    "WorkerRun",
    "build_dispatch_prompt",
    "build_workplan",
    "build_worker_argv",
    "classify_outcome",
    "read_result_frame",
]
