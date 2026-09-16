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
  4. RESTART is not blank either. The same bytes are handed to a
     `TranscriptWriter` (see bridge/transcripts.py), which buffers them and
     lets one background thread do the disk I/O. The ring answers a reattach;
     the transcript answers a restart, and answers a reattach whose cursor has
     already fallen out of the ring.
  5. Nothing is orphaned. A separate waiter thread does the one blocking
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

from .transcripts import TranscriptStore, TranscriptWriter

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

#: How a spawn answered "did you restore the model's context, or only the text?"
#: Reported on the session record so a degraded resume is visible rather than
#: silent. `RESUME_NONE` is the ordinary fresh spawn and is never reported.
RESUME_NONE = "none"
RESUME_RESUMED = "resumed"
RESUME_UNAVAILABLE = "unavailable"
RESUME_DISABLED = "disabled"

#: Env vars the child must never inherit. The bridge secret in particular would
#: otherwise be readable by every agent the cockpit starts.
#:
#: The two CLAUDE_CODE_* entries are a different problem with the same fix. If
#: the bridge is itself started from inside a Claude Code session — which is a
#: normal thing for a developer to do — it inherits that session's lineage
#: markers and passes them to every pane. `CLAUDE_CODE_CHILD_SESSION` makes the
#: CLI treat the pane as a SUBAGENT and turn transcript saving OFF ("Transcript
#: saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker", reproduced on a
#: real PTY), which means no conversation is ever written and `--resume` can
#: never work for that pane. `CLAUDE_CODE_SESSION_ID` is another session's id,
#: which this pane is not. A cockpit pane is a top-level interactive session,
#: so it starts the way one launched from a plain shell would.
_STRIPPED_ENV = (
    "BRIDGE_SECRET",
    "SPINE_SECRET",
    "NEXTAUTH_SECRET",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
)
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
        transcript: TranscriptWriter | None = None,
        history_tail_bytes: int = 256 * 1024,
        claude_session_id: str | None = None,
        resume_status: str | None = None,
        resume_from: str | None = None,
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

        #: The `claude` conversation id this PTY is driving, when we set one.
        #: It is what a later spawn passes to `--resume`.
        self.claude_session_id = claude_session_id
        self.resume_status = resume_status or RESUME_NONE
        self.resume_from = resume_from

        self.transcript = transcript
        self._history_tail_bytes = max(0, int(history_tail_bytes))

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
        if self.transcript is not None:
            # The pid lands in the sidecar so a NEXT bridge can say something
            # honest about a process this one no longer owns.
            self.transcript.set_meta(
                status=STATUS_RUNNING, pid=pid, bridge_pid=os.getpid()
            )

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
        if self.transcript is not None:
            # Buffer only. Every syscall for this belongs to the flusher
            # thread, because this line runs on the event loop.
            self.transcript.append(data)
            self.transcript.touch(self.last_activity)
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
        if self.transcript is not None:
            # Stamped, not flushed-and-forgotten: the writer stays open so a
            # late chunk still lands, and the store closes it at shutdown.
            self.transcript.set_meta(
                status=STATUS_EXITED, exit_code=code, last_activity=self.last_activity
            )
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

    def _replay_bytes(self, last_event_id: int | None) -> tuple[bytes, bool]:
        """Choose a replay source and return (bytes, gapped).

        The ring and the transcript address the SAME byte space — both are fed
        from `_on_data`, so a `Last-Event-ID` cursor means the same thing to
        either one. Whichever can reach FURTHER BACK for this request wins; a
        tie goes to the ring, which costs no syscall. A `gap` is therefore
        emitted only when neither source still holds the cursor's bytes, which
        is what makes on-disk persistence close real gaps instead of just
        moving them.
        """
        if last_event_id is not None and last_event_id >= self._total_bytes:
            return b"", False  # caller is current

        ring_start = self._total_bytes - len(self._ring)
        ring_begin = ring_start if last_event_id is None else max(ring_start, last_event_id)

        read = self._read_transcript(last_event_id)
        if read is not None and read.start < ring_begin:
            return read.data, read.gapped

        data = bytes(self._ring)
        gapped = False
        if last_event_id is not None:
            if last_event_id >= ring_start:
                data = data[last_event_id - ring_start :]
            else:
                gapped = True  # cursor fell out of BOTH the ring and the log
        return data, gapped

    def _read_transcript(self, last_event_id: int | None):
        """Bounded tail off disk. None when there is no durable transcript.

        This is the one place the event loop touches the disk, and it happens
        once per SSE connect, not per chunk: `TranscriptWriter.read` flushes
        the pending buffer first so a reattach can never miss bytes that were
        written a few milliseconds ago.
        """
        if self.transcript is None or self._history_tail_bytes <= 0:
            return None
        try:
            return self.transcript.read(last_event_id, self._history_tail_bytes)
        except OSError:  # pragma: no cover - never fail a reattach over the disk
            return None

    def _replay_events(self, last_event_id: int | None) -> list[StreamEvent]:
        events: list[StreamEvent] = []
        data, gapped = self._replay_bytes(last_event_id)

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
        """The session shape the wire contract specifies.

        The persistence fields are ADDITIVE and are omitted when they have
        nothing to say, so a spawn that neither resumed nor could have resumed
        returns exactly the eight keys BRIDGE-CONTRACT.md pins. A v1 client
        never sees a field it does not know.
        """
        row = {
            "session_id": self.session_id,
            "name": self.name,
            "cwd": str(self.cwd),
            "domain": self.domain,
            "model": self.model,
            "status": self.status,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
        }
        if self.claude_session_id:
            row["claude_session_id"] = self.claude_session_id
        if self.resume_status and self.resume_status != RESUME_NONE:
            row["resume_status"] = self.resume_status
        if self.resume_from:
            row["resume_from"] = self.resume_from
        return row

    def sync_record(self) -> None:
        """Push the current record into the sidecar (persisted on next flush).

        The route stamps a default `name` AFTER `create()` returns, because the
        uuid it is built from does not exist until then. Without this the
        sidecar would keep the placeholder name forever and a restored pane
        would come back nameless.
        """
        if self.transcript is not None:
            self.transcript.set_meta(**self.record())

    def record(self) -> dict:
        """The snapshot plus everything the sidecar needs to outlive us."""
        row = self.snapshot()
        row.update(
            {
                "exit_code": self.exit_code,
                "cols": self.cols,
                "rows": self.rows,
                "pid": self.pid,
                "bridge_pid": os.getpid(),
            }
        )
        return row


class SessionManager:
    """Every session on this bridge: the live PTYs and the restored records.

    A "record" is a session this bridge never started — it was read back from
    a sidecar at boot. It has no process, no fd and no ring, it is always
    reported `exited`, and it exists so that a restart does not make a pane's
    history unreachable. Records are never resurrected into processes.
    """

    def __init__(
        self,
        *,
        max_sessions: int,
        scrollback_bytes: int,
        store: TranscriptStore | None = None,
        history_tail_bytes: int = 256 * 1024,
        retention_count: int = 200,
        retention_days: float = 14.0,
    ) -> None:
        self.max_sessions = max_sessions
        self.scrollback_bytes = scrollback_bytes
        self.store = store
        self.history_tail_bytes = history_tail_bytes
        self.retention_count = retention_count
        self.retention_days = retention_days
        self._sessions: dict[str, PtySession] = {}
        self._records: dict[str, dict] = {}

    # ── queries ──────────────────────────────────────────────────────────────

    def get(self, session_id: str) -> PtySession | None:
        return self._sessions.get(session_id)

    def get_record(self, session_id: str) -> dict | None:
        """A restored, process-less session record, or None."""
        if session_id in self._sessions:
            return None
        return self._records.get(session_id)

    def list(self) -> list[PtySession]:
        return list(self._sessions.values())

    def snapshots(self) -> list[dict]:
        """Every session the bridge can speak about, live rows first."""
        rows = [s.snapshot() for s in self._sessions.values()]
        rows += [
            _record_snapshot(r)
            for sid, r in self._records.items()
            if sid not in self._sessions
        ]
        return rows

    def live_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.status != STATUS_EXITED)

    def live_ids(self) -> set[str]:
        return {
            sid for sid, s in self._sessions.items() if s.status != STATUS_EXITED
        }

    # ── boot ─────────────────────────────────────────────────────────────────

    def restore_from_disk(self) -> int:
        """Load prior sessions as records, then enforce retention. No respawns."""
        if self.store is None:
            return 0
        for meta in self.store.load_records():
            sid = meta.get("session_id")
            if isinstance(sid, str) and sid not in self._sessions:
                self._records[sid] = meta
        self.prune_transcripts()
        return len(self._records)

    def prune_transcripts(self) -> int:
        """Enforce retention, protecting anything live. Safe to call anytime."""
        if self.store is None:
            return 0
        removed = self.store.prune(
            max_count=self.retention_count,
            max_age_days=self.retention_days,
            keep=self.live_ids(),
        )
        if removed:
            surviving = {m.name[: -len(".json")] for m in self.store.root.glob("*.json")}
            for sid in [s for s in self._records if s not in surviving]:
                self._records.pop(sid, None)
        return removed

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
        session_id: str | None = None,
        claude_session_id: str | None = None,
        resume_status: str | None = None,
        resume_from: str | None = None,
    ) -> PtySession:
        """Enforce the cap, fork the child, register the session."""
        if self.live_count() >= self.max_sessions:
            raise SessionError(
                f"session limit reached ({self.max_sessions} live sessions). "
                "End a session, or raise CLAWDLING_MAX_SESSIONS."
            )

        session = PtySession(
            session_id=session_id or str(uuid.uuid4()),
            name=name,
            cwd=cwd,
            argv=argv,
            env=env,
            domain=domain,
            model=model,
            cols=cols,
            rows=rows,
            scrollback_bytes=self.scrollback_bytes,
            history_tail_bytes=self.history_tail_bytes,
            claude_session_id=claude_session_id,
            resume_status=resume_status,
            resume_from=resume_from,
        )
        if self.store is not None:
            session.transcript = self.store.open(session.session_id, session.record())
        session.start()
        self._sessions[session.session_id] = session
        # A live session shadows any record with the same id (a resumed pane
        # gets a NEW id, so this only fires if a caller reused one).
        self._records.pop(session.session_id, None)
        self._prune_exited()
        # Retention on every spawn, not only on boot: a bridge that runs for
        # weeks would otherwise never enforce its own cap. One directory scan.
        self.prune_transcripts()
        return session

    def _prune_exited(self) -> None:
        exited = [s for s in self._sessions.values() if s.status == STATUS_EXITED]
        if len(exited) <= MAX_RETAINED_EXITED:
            return
        # dicts preserve insertion order, so the head of this list is oldest.
        for stale in exited[: len(exited) - MAX_RETAINED_EXITED]:
            self._sessions.pop(stale.session_id, None)
            if self.store is not None:
                # Drop the in-memory pane but KEEP the transcript: it becomes
                # a record on the next boot, and /history serves it now.
                self.store.release(stale.session_id)
                meta = self.store.read_meta(stale.session_id)
                if meta:
                    meta["restored"] = True
                    self._records[stale.session_id] = meta

    async def delete(self, session_id: str, grace: float = 5.0) -> tuple[bool, int | None]:
        """Terminate a session. Returns (existed, exit_code). Idempotent.

        On a RECORD (a prior session with no process) there is nothing to
        signal, so DELETE means the only other thing it can honestly mean:
        forget it. That is the one purge verb — terminating a LIVE session
        never removes its transcript, because reading a dead pane's output is
        the whole point of having one.
        """
        session = self._sessions.get(session_id)
        if session is not None:
            code = await session.terminate(grace=grace)
            return True, code

        record = self._records.pop(session_id, None)
        if record is None:
            return False, None
        if self.store is not None:
            self.store.forget(session_id)
        exit_code = record.get("exit_code")
        return True, exit_code if isinstance(exit_code, int) else None

    async def shutdown(self, grace: float = 5.0) -> None:
        """Kill every child. Called from the app lifespan on SIGTERM/SIGINT."""
        await asyncio.gather(
            *(s.terminate(grace=grace) for s in self.list()),
            return_exceptions=True,
        )
        if self.store is not None:
            # After the children are gone: one last stamp so every sidecar on
            # disk says `exited` with its real code, and every buffered byte
            # is written. This is the clean-shutdown path; the timer flush and
            # the atexit hook cover the unclean ones.
            for session in self.list():
                if session.transcript is not None:
                    session.transcript.set_meta(
                        status=session.status,
                        exit_code=session.exit_code,
                        last_activity=session.last_activity,
                    )
            self.store.shutdown()

    def kill_all_now(self) -> None:
        """Last-resort synchronous sweep for the atexit hook."""
        for session in self.list():
            session.kill_now()
        if self.store is not None:
            # atexit runs after the loop is gone, so this is the LAST chance
            # for buffered bytes. Losing a pane's final screen to a Ctrl-C is
            # exactly the failure transcripts exist to prevent.
            self.store.shutdown()


def _record_snapshot(meta: dict) -> dict:
    """The contract session shape, read back off a sidecar.

    Anything missing from an older or partially-written sidecar degrades to a
    null rather than raising: a corrupt record must not take out `GET
    /api/sessions` for every other pane.
    """
    row = {
        "session_id": meta.get("session_id"),
        "name": meta.get("name") or "session",
        "cwd": meta.get("cwd") or "",
        "domain": meta.get("domain"),
        "model": meta.get("model"),
        # Enforced here as well as at load: a record NEVER reports running.
        "status": STATUS_EXITED,
        "created_at": meta.get("created_at"),
        "last_activity": meta.get("last_activity") or meta.get("created_at"),
        "restored": True,
    }
    for key in ("claude_session_id", "resume_status", "resume_from"):
        value = meta.get(key)
        if value:
            row[key] = value
    return row


def build_child_env(base: Iterable[tuple[str, str]] | None = None, **overrides: str) -> dict[str, str]:
    """A child environment with the bridge's own secrets removed."""
    env = dict(base) if base is not None else dict(os.environ)
    for key in list(env):
        if key in _STRIPPED_ENV or key.startswith(_STRIPPED_PREFIXES):
            env.pop(key, None)
    env.update({k: v for k, v in overrides.items() if v is not None})
    return env
