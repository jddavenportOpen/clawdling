"""PTY session engine.

One `PtySession` owns one real child process running on a pseudo-terminal. The
design constraints, in the order they mattered:

  1. Many panes at once. Every session gets its own reader thread, so a PTY
     read NEVER runs on the asyncio event loop. The loop only ever receives
     already-read bytes via call_soon_threadsafe.
  2. Many viewers per pane. Output fans out to a per-subscriber asyncio.Queue,
     so a slow SSE client cannot stall the PTY or any other viewer. A queue
     that overflows drops its oldest frames and raises a `gap` marker instead
     of growing without bound.
  3. Reattach is not blank. Every byte also lands in a bounded ring buffer
     (256KB by default) that is replayed to a new subscriber before live data.
  4. Nothing is orphaned. A separate waiter thread does the one blocking
     waitpid, so a child is reaped exactly once no matter which path (EOF,
     DELETE, shutdown) noticed it first.

Note on the module name: this file is `bridge.pty`, which does NOT shadow the
stdlib `pty` for anything here. Under Python 3 absolute imports, the child
process is created with `os.forkpty`, so the stdlib module is never needed.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import signal
import struct
import termios
import threading
import time
import uuid
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

# Python 3.12 warns when a process with live threads forks. Our child calls
# execvpe as its very first action, which is the documented safe shape (it is
# what subprocess and pty.fork do); the deadlock risk the warning describes
# comes from running Python in the child, which we never do.
warnings.filterwarnings(
    "ignore",
    message=r".*multi-threaded.*",
    category=DeprecationWarning,
)

READ_CHUNK = 64 * 1024
#: Frames a single SSE subscriber may fall behind by before we drop the oldest.
SUBSCRIBER_QUEUE_MAX = 4096
#: Exited sessions we keep listed (they hold a scrollback buffer each).
MAX_RETAINED_EXITED = 50

STATUS_STARTING = "starting"
STATUS_RUNNING = "running"
STATUS_EXITED = "exited"

#: Env vars the child must never inherit. The bridge secret in particular would
#: otherwise be readable by every agent the cockpit starts.
_STRIPPED_ENV = ("BRIDGE_SECRET", "SPINE_SECRET", "NEXTAUTH_SECRET")
_STRIPPED_PREFIXES = ("BRIDGE_",)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class SessionError(RuntimeError):
    """Raised when an operation cannot be served by this session."""


class SessionGoneError(SessionError):
    """Raised when the PTY is already closed."""


@dataclass
class StreamEvent:
    """One SSE frame, before serialization."""

    event: str
    payload: dict
    event_id: int | None = None

    def encode(self) -> str:
        parts = [f"event: {self.event}"]
        if self.event_id is not None:
            parts.append(f"id: {self.event_id}")
        parts.append(f"data: {json.dumps(self.payload, ensure_ascii=False)}")
        return "\n".join(parts) + "\n\n"


class Subscriber:
    """One SSE viewer attached to one session."""

    def __init__(self) -> None:
        self.queue: asyncio.Queue[StreamEvent | None] = asyncio.Queue(
            maxsize=SUBSCRIBER_QUEUE_MAX
        )
        self._dropped = False

    def push(self, event: StreamEvent | None) -> None:
        """Enqueue a frame. Drops the OLDEST frame when the viewer is behind."""
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover - race with the reader
                pass
            self._dropped = True
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover - drop above made room
            self._dropped = True

    def take_dropped(self) -> bool:
        """Read-and-clear the overflow flag."""
        was, self._dropped = self._dropped, False
        return was


class PtySession:
    """A single `claude` (or any argv) process on a PTY."""

    def __init__(
        self,
        *,
        session_id: str,
        name: str,
        cwd: Path,
        argv: list[str],
        env: dict[str, str],
        domain: str | None = None,
        model: str | None = None,
        cols: int = 120,
        rows: int = 32,
        scrollback_bytes: int = 256 * 1024,
    ) -> None:
        self.session_id = session_id
        self.name = name
        self.cwd = cwd
        self.argv = list(argv)
        self.env = dict(env)
        self.domain = domain
        self.model = model
        self.cols = max(1, int(cols))
        self.rows = max(1, int(rows))
        self.status = STATUS_STARTING
        self.exit_code: int | None = None
        self.created_at = _now_iso()
        self.last_activity = self.created_at

        self.pid: int | None = None
        self._master_fd: int | None = None
        self._fd_lock = threading.Lock()

        # Scrollback: raw bytes, so a multi-byte character split across two PTY
        # reads is stored intact and only decoded at the edge.
        self._ring = bytearray()
        self._ring_cap = max(1024, int(scrollback_bytes))
        self._total_bytes = 0

        self._subscribers: set[Subscriber] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._exited: asyncio.Event | None = None
        self._exit_published = False
        self._threads: list[threading.Thread] = []

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """Fork the child onto a new PTY and start the reader/waiter threads."""
        if self.pid is not None:
            raise SessionError("session already started")

        self._loop = loop or asyncio.get_running_loop()
        self._exited = asyncio.Event()

        # argv is exec'd directly. There is no shell anywhere in this path, so
        # no amount of quoting in a user-supplied field can become a command.
        argv = self.argv
        cwd = str(self.cwd)
        child_env = self.env

        pid, master_fd = os.forkpty()
        if pid == 0:  # pragma: no cover - the child never returns to pytest
            # CHILD. Do the minimum and exec. No Python-level cleanup, no
            # allocation-heavy work, no exceptions that unwind: any of those
            # can deadlock on a lock another thread held at fork time.
            try:
                os.chdir(cwd)
                os.execvpe(argv[0], argv, child_env)
            except BaseException:
                try:
                    os.write(2, b"bridge: failed to exec child process\r\n")
                except BaseException:
                    pass
            os._exit(127)

        self.pid = pid
        self._master_fd = master_fd
        self.status = STATUS_RUNNING
        self._apply_winsize(self.cols, self.rows)

        reader = threading.Thread(
            target=self._read_loop, name=f"pty-read-{self.session_id[:8]}", daemon=True
        )
        waiter = threading.Thread(
            target=self._wait_loop, name=f"pty-wait-{self.session_id[:8]}", daemon=True
        )
        self._threads = [reader, waiter]
        reader.start()
        waiter.start()

    def _read_loop(self) -> None:
        """Blocking PTY reads, off the event loop, for the life of the child."""
        while True:
            with self._fd_lock:
                fd = self._master_fd
            if fd is None:
                break
            try:
                data = os.read(fd, READ_CHUNK)
            except InterruptedError:  # pragma: no cover - signal race
                continue
            except OSError:
                # EIO is how a PTY master reports "the slave side is gone" on
                # macOS and Linux; EBADF means teardown closed it under us.
                # Either way the stream is over.
                break
            if not data:
                break
            self._dispatch(self._on_data, data)
        self._close_fd()

    def _wait_loop(self) -> None:
        """The one and only waitpid. Publishes the exit status to the loop."""
        code: int | None = None
        pid = self.pid
        if pid is not None:
            while True:
                try:
                    _, raw_status = os.waitpid(pid, 0)
                except InterruptedError:  # pragma: no cover - signal race
                    continue
                except ChildProcessError:  # pragma: no cover - already reaped
                    break
                try:
                    code = os.waitstatus_to_exitcode(raw_status)
                except ValueError:  # pragma: no cover - stopped, not exited
                    continue
                break
        self._dispatch(self._on_exit, code)

    def _dispatch(self, fn, *args) -> None:
        """Hop onto the event loop thread. All shared state is touched there."""
        loop = self._loop
        if loop is None or loop.is_closed():  # pragma: no cover - shutdown race
            return
        try:
            loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:  # pragma: no cover - loop died mid-flight
            pass

    # ── loop-thread state transitions ────────────────────────────────────────

    def _on_data(self, data: bytes) -> None:
        self._ring.extend(data)
        self._total_bytes += len(data)
        overflow = len(self._ring) - self._ring_cap
        if overflow > 0:
            del self._ring[:overflow]
        self.last_activity = _now_iso()
        text = data.decode("utf-8", errors="replace")
        self._publish(
            StreamEvent("output", {"chunk": text, "text": text}, self._total_bytes)
        )

    def _on_exit(self, code: int | None) -> None:
        if self._exit_published:
            return
        self._exit_published = True
        self.status = STATUS_EXITED
        self.exit_code = code
        self.last_activity = _now_iso()
        self._publish(
            StreamEvent("status", {"status": STATUS_EXITED, "exit_code": code}, None)
        )
        # `exit` is not in the v1 contract. It is emitted because the shipped
        # cockpit latches its "this session is dead, stop reconnecting" flag on
        # it; without the frame the UI reconnects to a dead sid forever.
        self._publish(
            StreamEvent(
                "exit",
                {"status": STATUS_EXITED, "exit_code": code, "message": f"exit {code}"},
                None,
            )
        )
        if self._exited is not None:
            self._exited.set()

    def _publish(self, event: StreamEvent) -> None:
        for sub in tuple(self._subscribers):
            sub.push(event)

    # ── fd operations ────────────────────────────────────────────────────────

    def _close_fd(self) -> None:
        """Close the PTY master. Called ONLY by the reader thread, which is the
        only thread that can know nobody is blocked reading it."""
        with self._fd_lock:
            fd, self._master_fd = self._master_fd, None
        if fd is not None:
            try:
                os.close(fd)
            except OSError:  # pragma: no cover
                pass

    def _apply_winsize(self, cols: int, rows: int) -> None:
        with self._fd_lock:
            fd = self._master_fd
            if fd is None:
                raise SessionGoneError("session is not running")
            packed = struct.pack("HHHH", rows, cols, 0, 0)
            try:
                fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
            except OSError as exc:  # pragma: no cover - fd raced with teardown
                raise SessionGoneError(f"resize failed: {exc}") from exc

    def write_bytes(self, data: bytes) -> int:
        """Write to the PTY. Call from a worker thread, never from the loop.

        The fd lock is held for the whole write so the reader thread cannot
        close (and the OS cannot recycle) the descriptor mid-write.
        """
        with self._fd_lock:
            fd = self._master_fd
            if fd is None:
                raise SessionGoneError("session is not running")
            written = 0
            view = memoryview(data)
            while written < len(data):
                try:
                    written += os.write(fd, view[written:])
                except InterruptedError:  # pragma: no cover
                    continue
                except BlockingIOError:  # pragma: no cover - fd is blocking
                    time.sleep(0.005)
                except OSError as exc:
                    raise SessionGoneError(f"write failed: {exc}") from exc
            return written

    def resize(self, cols: int, rows: int) -> None:
        self.cols = max(1, int(cols))
        self.rows = max(1, int(rows))
        self._apply_winsize(self.cols, self.rows)
        self.last_activity = _now_iso()

    # ── subscribers ──────────────────────────────────────────────────────────

    def subscribe(self, last_event_id: int | None = None) -> tuple[Subscriber, list[StreamEvent]]:
        """Attach a viewer and get its scrollback replay.

        Registration and the replay snapshot happen in one synchronous block on
        the loop thread, so no chunk can land between them: nothing is lost and
        nothing is delivered twice.
        """
        sub = Subscriber()
        replay = self._replay_events(last_event_id)
        self._subscribers.add(sub)
        return sub, replay

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def _replay_events(self, last_event_id: int | None) -> list[StreamEvent]:
        events: list[StreamEvent] = []
        ring_start = self._total_bytes - len(self._ring)
        data = bytes(self._ring)
        gapped = False

        if last_event_id is not None:
            if last_event_id >= self._total_bytes:
                data = b""  # caller is current
            elif last_event_id >= ring_start:
                data = data[last_event_id - ring_start :]
            else:
                gapped = True  # cursor fell out of the ring

        if gapped:
            events.append(
                StreamEvent("gap", {"reason": "scrollback truncated"}, None)
            )
        if data:
            text = data.decode("utf-8", errors="replace")
            events.append(
                StreamEvent("output", {"chunk": text, "text": text}, self._total_bytes)
            )
        events.append(
            StreamEvent(
                "status",
                {"status": self.status, "exit_code": self.exit_code},
                None,
            )
        )
        if self.status == STATUS_EXITED:
            events.append(
                StreamEvent(
                    "exit",
                    {
                        "status": STATUS_EXITED,
                        "exit_code": self.exit_code,
                        "message": f"exit {self.exit_code}",
                    },
                    None,
                )
            )
        return events

    # ── teardown ─────────────────────────────────────────────────────────────

    def _signal_group(self, sig: int) -> None:
        pid = self.pid
        if pid is None:
            return
        try:
            # forkpty calls setsid, so the child leads its own process group.
            # Signalling the GROUP also reaches anything the agent spawned.
            os.killpg(os.getpgid(pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, sig)
            except OSError:
                pass

    async def terminate(self, grace: float = 5.0) -> int | None:
        """SIGTERM, then SIGKILL after `grace` seconds. Safe to call twice."""
        if self.status == STATUS_EXITED or self.pid is None:
            return self.exit_code
        assert self._exited is not None

        self._signal_group(signal.SIGTERM)
        try:
            await asyncio.wait_for(self._exited.wait(), timeout=grace)
        except (asyncio.TimeoutError, TimeoutError):
            self._signal_group(signal.SIGKILL)
            try:
                await asyncio.wait_for(self._exited.wait(), timeout=grace)
            except (asyncio.TimeoutError, TimeoutError):  # pragma: no cover
                return self.exit_code
        # Deliberately NOT closing the master fd here. The reader thread may be
        # blocked in os.read on it, and closing a descriptor out from under a
        # blocked reader does not wake that reader on macOS or Linux: the fd
        # number can then be recycled by the next openpty and the stale read
        # would deliver ANOTHER session's bytes to this session's subscribers.
        # The reader is the only closer; the child is gone, so its EOF/EIO is
        # already on its way.
        return self.exit_code

    def kill_now(self) -> None:
        """Best-effort synchronous SIGKILL. Used by the process-exit fallback."""
        if self.status != STATUS_EXITED:
            self._signal_group(signal.SIGKILL)

    # ── views ────────────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        """The session shape the wire contract specifies."""
        return {
            "session_id": self.session_id,
            "name": self.name,
            "cwd": str(self.cwd),
            "domain": self.domain,
            "model": self.model,
            "status": self.status,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
        }


class SessionManager:
    """Every live session on this bridge, keyed by uuid4."""

    def __init__(self, *, max_sessions: int, scrollback_bytes: int) -> None:
        self.max_sessions = max_sessions
        self.scrollback_bytes = scrollback_bytes
        self._sessions: dict[str, PtySession] = {}

    # ── queries ──────────────────────────────────────────────────────────────

    def get(self, session_id: str) -> PtySession | None:
        return self._sessions.get(session_id)

    def list(self) -> list[PtySession]:
        return list(self._sessions.values())

    def live_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.status != STATUS_EXITED)

    # ── mutation ─────────────────────────────────────────────────────────────

    def create(
        self,
        *,
        name: str,
        cwd: Path,
        argv: list[str],
        env: dict[str, str],
        domain: str | None = None,
        model: str | None = None,
        cols: int = 120,
        rows: int = 32,
    ) -> PtySession:
        """Enforce the cap, fork the child, register the session."""
        if self.live_count() >= self.max_sessions:
            raise SessionError(
                f"session limit reached ({self.max_sessions} live sessions). "
                "End a session, or raise CLAWDLING_MAX_SESSIONS."
            )

        session = PtySession(
            session_id=str(uuid.uuid4()),
            name=name,
            cwd=cwd,
            argv=argv,
            env=env,
            domain=domain,
            model=model,
            cols=cols,
            rows=rows,
            scrollback_bytes=self.scrollback_bytes,
        )
        session.start()
        self._sessions[session.session_id] = session
        self._prune_exited()
        return session

    def _prune_exited(self) -> None:
        exited = [s for s in self._sessions.values() if s.status == STATUS_EXITED]
        if len(exited) <= MAX_RETAINED_EXITED:
            return
        # dicts preserve insertion order, so the head of this list is oldest.
        for stale in exited[: len(exited) - MAX_RETAINED_EXITED]:
            self._sessions.pop(stale.session_id, None)

    async def delete(self, session_id: str, grace: float = 5.0) -> tuple[bool, int | None]:
        """Terminate a session. Returns (existed, exit_code). Idempotent."""
        session = self._sessions.get(session_id)
        if session is None:
            return False, None
        code = await session.terminate(grace=grace)
        return True, code

    async def shutdown(self, grace: float = 5.0) -> None:
        """Kill every child. Called from the app lifespan on SIGTERM/SIGINT."""
        await asyncio.gather(
            *(s.terminate(grace=grace) for s in self.list()),
            return_exceptions=True,
        )

    def kill_all_now(self) -> None:
        """Last-resort synchronous sweep for the atexit hook."""
        for session in self.list():
            session.kill_now()


def build_child_env(base: Iterable[tuple[str, str]] | None = None, **overrides: str) -> dict[str, str]:
    """A child environment with the bridge's own secrets removed."""
    env = dict(base) if base is not None else dict(os.environ)
    for key in list(env):
        if key in _STRIPPED_ENV or key.startswith(_STRIPPED_PREFIXES):
            env.pop(key, None)
    env.update({k: v for k, v in overrides.items() if v is not None})
    return env
