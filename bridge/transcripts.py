"""On-disk transcript persistence.

The in-memory scrollback ring in `bridge.pty` is what makes a REATTACH
non-blank. It is not what makes a RESTART non-blank: the ring dies with the
process. This module is the durable half — one append-only byte log plus one
JSON sidecar per session, under a state root the operator chooses.

Design constraints, in the order they mattered:

  1. **A slow disk must never stall a pane.** Bytes arrive on the event-loop
     thread (see `PtySession._on_data`), so `append()` is a memcpy into a
     buffer under a short lock and nothing else. One background flusher thread
     does every syscall. The buffer lock and the I/O lock are separate on
     purpose: holding one lock across the write would put the event loop
     behind the disk, which is the exact failure this is written to avoid.

  2. **An unclean kill must not lose the file.** Appends are `write` +
     (optionally) `fsync`-free O_APPEND on a handle that stays open, flushed
     on a timer and again on close/exit. `kill -9` of the bridge loses at most
     one flush interval. `kill -9` of the whole machine loses whatever the
     page cache held; we do not fsync every chunk, because a TUI emits
     thousands of chunks a second and fsync-per-chunk would be the stall in
     point 1 wearing a different hat.

  3. **Byte cursors stay monotonic across a head trim.** A transcript is
     capped, and the cap is enforced by dropping the OLDEST bytes. The public
     `total` therefore counts bytes *ever written*, and `trimmed` counts bytes
     dropped off the head — exactly the `ring_start = total - len(ring)` shape
     the in-memory ring already uses. A client cursor is never invalidated by
     a trim; it is merely reported as `gapped` when it points into the part
     that is gone.

  4. **Retention is bounded by count AND age.** This runs on a stranger's
     machine. A transcript directory that only grows is a bug, not a feature.
     A live session's transcript is never a retention candidate.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("bridge.transcripts")

LOG_SUFFIX = ".log"
META_SUFFIX = ".json"

#: How often the flusher thread drains every open buffer to disk.
DEFAULT_FLUSH_SECONDS = 0.5
#: When a log exceeds its cap, drop this fraction off the head. Trimming one
#: byte at a time would rewrite the whole file on every chunk.
TRIM_FRACTION = 0.25
#: A session id reaches the filesystem as a filename, so it is constrained to
#: the shape the bridge itself mints (uuid4) plus a little slack. Anything else
#: is refused rather than sanitised: silently rewriting a caller's id would
#: make two different sessions share one transcript.
_SAFE_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
MAX_ID_LENGTH = 128


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def is_safe_session_id(session_id: str) -> bool:
    """True when this id can be used as a filename without escaping anything."""
    if not session_id or len(session_id) > MAX_ID_LENGTH:
        return False
    return all(c in _SAFE_ID_CHARS for c in session_id)


@dataclass(frozen=True)
class TranscriptRead:
    """One served slice of a transcript."""

    data: bytes
    #: Bytes ever appended to this transcript. The caller's next cursor.
    total: int
    #: Byte offset of the first byte in `data`.
    start: int
    #: True when the requested cursor pointed at bytes that have been trimmed.
    gapped: bool


class TranscriptWriter:
    """The durable log + sidecar for ONE live session."""

    def __init__(
        self,
        *,
        root: Path,
        session_id: str,
        max_file_bytes: int,
        meta: dict | None = None,
    ) -> None:
        self.session_id = session_id
        self.log_path = root / f"{session_id}{LOG_SUFFIX}"
        self.meta_path = root / f"{session_id}{META_SUFFIX}"
        self.max_file_bytes = max(4096, int(max_file_bytes))

        # Guards the pending buffer and the counters. Held for microseconds by
        # append(), which runs on the event loop.
        self._buf_lock = threading.Lock()
        # Guards the file handle and every syscall. Held across disk I/O.
        self._io_lock = threading.Lock()
        # Serialises whole flush OPERATIONS — the buffer swap and the write
        # that follows it. Without this, two flushers can each take a chunk
        # and then race for the io lock, writing the SECOND chunk first and
        # scrambling the transcript. `append` never touches this lock, so
        # serialising flushes still cannot put the event loop behind the disk.
        self._flush_lock = threading.RLock()

        self._buf = bytearray()
        self._total = 0
        self._trimmed = 0
        self._handle = None
        self._closed = False
        self._degraded: str | None = None

        self._meta: dict = dict(meta or {})
        self._meta_dirty = True

    # ── hot path ─────────────────────────────────────────────────────────────

    def append(self, data: bytes) -> None:
        """Buffer bytes. Called from the event loop; does no I/O."""
        if not data:
            return
        with self._buf_lock:
            if self._closed:
                return
            self._buf += data
            self._total += len(data)

    def touch(self, last_activity: str) -> None:
        """Record the session's newest activity stamp for the next sidecar write."""
        with self._buf_lock:
            if self._meta.get("last_activity") != last_activity:
                self._meta["last_activity"] = last_activity
                self._meta_dirty = True

    def set_meta(self, **fields) -> None:
        """Merge fields into the sidecar. Persisted by the next flush."""
        with self._buf_lock:
            for key, value in fields.items():
                if self._meta.get(key) != value:
                    self._meta[key] = value
                    self._meta_dirty = True

    @property
    def meta(self) -> dict:
        with self._buf_lock:
            return dict(self._meta)

    @property
    def total(self) -> int:
        with self._buf_lock:
            return self._total

    @property
    def trimmed(self) -> int:
        with self._buf_lock:
            return self._trimmed

    @property
    def degraded(self) -> str | None:
        return self._degraded

    # ── flushing ─────────────────────────────────────────────────────────────

    def flush(self) -> None:
        """Write the pending buffer and any dirty sidecar."""
        with self._flush_lock:
            with self._buf_lock:
                chunk = bytes(self._buf)
                self._buf.clear()
                meta = dict(self._meta) if self._meta_dirty else None
                self._meta_dirty = False
                meta_snapshot = dict(self._meta)
                total, trimmed = self._total, self._trimmed

            if chunk:
                self._write(chunk)
            if meta is not None:
                meta_snapshot["log_bytes"] = total
                meta_snapshot["bytes_trimmed"] = trimmed
                if self._degraded:
                    meta_snapshot["transcript_error"] = self._degraded
                self._write_meta(meta_snapshot)

    def _write(self, chunk: bytes) -> None:
        with self._io_lock:
            if self._degraded:
                return
            try:
                handle = self._open()
                handle.write(chunk)
                handle.flush()
                if handle.tell() > self.max_file_bytes:
                    self._trim_head_locked(handle)
            except OSError as exc:
                # One line, once. A transcript that cannot be written is a
                # degraded bridge, not a dead one: panes keep working.
                self._degraded = f"{type(exc).__name__}: {exc}"
                log.warning(
                    "transcript %s: write failed, persistence off for this session (%s)",
                    self.session_id,
                    exc,
                )
                self._close_handle_locked()

    def ensure_log(self) -> None:
        """Create the log file now, before there is anything to put in it.

        Without this, "has a transcript" and "has a sidecar" disagree for any
        session that has not produced a byte yet, and `/history` answers 404
        (which the shipped UI reads as "this pane is fresh") for a pane that
        is merely quiet.
        """
        with self._io_lock:
            if self._degraded:
                return
            try:
                self._open()
            except OSError as exc:
                self._degraded = f"{type(exc).__name__}: {exc}"
                log.warning(
                    "transcript %s: cannot create %s (%s)",
                    self.session_id,
                    self.log_path,
                    exc,
                )

    def _open(self):
        if self._handle is None:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._handle = open(self.log_path, "ab", buffering=0)
        return self._handle

    def _trim_head_locked(self, handle) -> None:
        """Drop the oldest slab so the log stays under its cap.

        The tail is copied to a sibling and renamed over the original, so a
        crash mid-trim leaves either the old file or the new one, never a
        half-rewritten log.
        """
        keep = int(self.max_file_bytes * (1.0 - TRIM_FRACTION))
        size = handle.tell()
        if size <= keep:
            return
        drop = size - keep
        tmp = self.log_path.with_suffix(f"{LOG_SUFFIX}.trim")
        try:
            with open(self.log_path, "rb") as src, open(tmp, "wb") as dst:
                src.seek(drop)
                while True:
                    block = src.read(1 << 20)
                    if not block:
                        break
                    dst.write(block)
            os.replace(tmp, self.log_path)
        except OSError:
            tmp.unlink(missing_ok=True)
            raise
        self._close_handle_locked()
        self._open()
        with self._buf_lock:
            self._trimmed += drop
            self._meta_dirty = True

    def _write_meta(self, meta: dict) -> None:
        tmp = self.meta_path.with_suffix(f"{META_SUFFIX}.tmp")
        try:
            self.meta_path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.meta_path)
        except OSError as exc:  # pragma: no cover - disk full / permissions
            log.warning("transcript %s: sidecar write failed (%s)", self.session_id, exc)
            tmp.unlink(missing_ok=True)

    # ── reading ──────────────────────────────────────────────────────────────

    def read(self, start: int | None, max_bytes: int) -> TranscriptRead:
        """Flush, then serve a bounded slice. Safe to call from the loop.

        The flush, the `trimmed` snapshot and the file read happen as ONE
        operation. A trim landing between them would move the head under us
        and the seek offset (`begin - trimmed`) would then be computed from a
        stale base — serving bytes shifted by however much was dropped.
        """
        with self._flush_lock:
            self.flush()
            with self._buf_lock:
                trimmed = self._trimmed
            return _read_file(self.log_path, trimmed, start, max_bytes)

    # ── teardown ─────────────────────────────────────────────────────────────

    def close(self, **final_meta) -> None:
        """Final flush, final sidecar, close the handle. Idempotent."""
        if final_meta:
            self.set_meta(**final_meta)
        with self._buf_lock:
            self._meta_dirty = True
        self.flush()
        with self._buf_lock:
            self._closed = True
        with self._io_lock:
            self._close_handle_locked()

    def _close_handle_locked(self) -> None:
        handle, self._handle = self._handle, None
        if handle is not None:
            try:
                handle.close()
            except OSError:  # pragma: no cover
                pass


def _read_file(
    path: Path, trimmed: int, start: int | None, max_bytes: int
) -> TranscriptRead:
    """Serve a slice of an on-disk log in the session's byte-cursor space."""
    max_bytes = max(0, int(max_bytes))
    try:
        size = path.stat().st_size
    except OSError:
        return TranscriptRead(b"", trimmed, trimmed, False)

    total = trimmed + size
    gapped = False
    if start is None:
        # "The last N bytes" — a truncated view is what was asked for, so it
        # is not a gap.
        begin = max(trimmed, total - max_bytes)
    else:
        begin = int(start)
        if begin < trimmed:
            gapped = True
            begin = trimmed
        elif begin > total:
            # A cursor ahead of us: the caller has seen bytes we do not have
            # (log rotated out from under it, or a restarted session). Serve
            # nothing rather than re-sending the tail.
            return TranscriptRead(b"", total, total, False)
        if total - begin > max_bytes:
            # The caller asked for more than one response may carry. Serve the
            # TAIL of the range, not the head: the caller advances its cursor
            # to `total` either way, so serving the head would silently lose
            # everything after it — and for a terminal the recent bytes are
            # the ones that reconstruct the screen. The skip is declared.
            begin = total - max_bytes
            gapped = True

    count = min(max_bytes, total - begin)
    if count <= 0:
        return TranscriptRead(b"", total, begin, gapped)
    try:
        with open(path, "rb") as fh:
            fh.seek(begin - trimmed)
            data = fh.read(count)
    except OSError:  # pragma: no cover - raced with a trim/unlink
        return TranscriptRead(b"", total, begin, gapped)
    return TranscriptRead(data, total, begin, gapped)


class TranscriptStore:
    """Every transcript on this bridge: the live writers and the dead files."""

    def __init__(
        self,
        root: Path,
        *,
        enabled: bool = True,
        max_file_bytes: int = 32 * 1024 * 1024,
        flush_interval: float = DEFAULT_FLUSH_SECONDS,
    ) -> None:
        self.root = Path(root)
        self.enabled = enabled
        self.max_file_bytes = max_file_bytes
        self.flush_interval = flush_interval

        self._writers: dict[str, TranscriptWriter] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

        if self.enabled:
            try:
                self.root.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                log.warning(
                    "transcripts: %s is not writable (%s); persistence is OFF", self.root, exc
                )
                self.enabled = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the single flusher thread. Idempotent."""
        if not self.enabled or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._flush_loop, name="transcript-flush", daemon=True
        )
        self._thread.start()

    def _flush_loop(self) -> None:
        while not self._stop.wait(self.flush_interval):
            self.flush_all()

    def flush_all(self) -> None:
        with self._lock:
            writers = list(self._writers.values())
        for writer in writers:
            try:
                writer.flush()
            except Exception:  # pragma: no cover - never kill the flusher
                log.exception("transcript %s: flush failed", writer.session_id)

    def shutdown(self) -> None:
        """Stop the flusher and drain every open writer. Idempotent."""
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=5)
        with self._lock:
            writers = list(self._writers.values())
            self._writers.clear()
        for writer in writers:
            try:
                writer.close()
            except Exception:  # pragma: no cover
                log.exception("transcript %s: close failed", writer.session_id)

    # ── writers ──────────────────────────────────────────────────────────────

    def open(self, session_id: str, meta: dict) -> TranscriptWriter | None:
        """Start persisting a session. Returns None when transcripts are off."""
        if not self.enabled or not is_safe_session_id(session_id):
            return None
        writer = TranscriptWriter(
            root=self.root,
            session_id=session_id,
            max_file_bytes=self.max_file_bytes,
            meta=meta,
        )
        with self._lock:
            self._writers[session_id] = writer
        # Stamp the sidecar and create the log immediately: a session that
        # dies in its first millisecond still has to be listable, and
        # readable, after a restart.
        writer.ensure_log()
        writer.flush()
        return writer

    def writer(self, session_id: str) -> TranscriptWriter | None:
        with self._lock:
            return self._writers.get(session_id)

    def release(self, session_id: str) -> None:
        """Drop a finished session's writer after a final flush."""
        with self._lock:
            writer = self._writers.pop(session_id, None)
        if writer is not None:
            writer.close()

    def live_ids(self) -> set[str]:
        with self._lock:
            return set(self._writers)

    # ── reading ──────────────────────────────────────────────────────────────

    def read(
        self, session_id: str, *, start: int | None, max_bytes: int
    ) -> TranscriptRead | None:
        """Serve a slice for any session, live or long dead. None = no log."""
        if not self.enabled or not is_safe_session_id(session_id):
            return None
        writer = self.writer(session_id)
        if writer is not None:
            return writer.read(start, max_bytes)
        path = self.root / f"{session_id}{LOG_SUFFIX}"
        if not path.exists():
            return None
        meta = self.read_meta(session_id) or {}
        trimmed = int(meta.get("bytes_trimmed") or 0)
        return _read_file(path, trimmed, start, max_bytes)

    def read_meta(self, session_id: str) -> dict | None:
        if not self.enabled or not is_safe_session_id(session_id):
            return None
        path = self.root / f"{session_id}{META_SUFFIX}"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    # ── boot ─────────────────────────────────────────────────────────────────

    def load_records(self) -> list[dict]:
        """Every sidecar on disk, as records of sessions that are NOT running.

        A sidecar naming a `running` session is a sidecar from a previous
        bridge. The process it named is either gone or an orphan we no longer
        hold a PTY for; in both cases we cannot stream it or type into it, so
        reporting it as running would be a lie. It is reported `exited`.
        Nothing is restarted here.
        """
        if not self.enabled:
            return []
        records: list[dict] = []
        try:
            entries = sorted(self.root.glob(f"*{META_SUFFIX}"))
        except OSError:  # pragma: no cover
            return []
        for path in entries:
            session_id = path.name[: -len(META_SUFFIX)]
            if not is_safe_session_id(session_id):
                continue
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                log.warning("transcripts: skipping unreadable sidecar %s", path.name)
                continue
            if not isinstance(meta, dict) or meta.get("session_id") != session_id:
                continue
            if meta.get("status") != "exited":
                stale_pid = meta.get("pid")
                if isinstance(stale_pid, int) and _pid_alive(stale_pid):
                    # Worth one line in the log: the operator has a real
                    # process on their machine that no bridge owns any more.
                    log.warning(
                        "session %s was %s at last write and pid %s is still alive; "
                        "listing it as exited (this bridge does not own its terminal)",
                        session_id,
                        meta.get("status"),
                        stale_pid,
                    )
                meta["status"] = "exited"
                meta["exit_code"] = None
                meta["ended_reason"] = "bridge restarted"
            meta["restored"] = True
            records.append(meta)
        return records

    def forget(self, session_id: str) -> None:
        """Delete one dead session's transcript. Refuses a live session."""
        if not self.enabled or not is_safe_session_id(session_id):
            return
        if self.writer(session_id) is not None:
            return
        (self.root / f"{session_id}{LOG_SUFFIX}").unlink(missing_ok=True)
        (self.root / f"{session_id}{META_SUFFIX}").unlink(missing_ok=True)

    # ── retention ────────────────────────────────────────────────────────────

    def prune(self, *, max_count: int, max_age_days: float, keep: set[str] | None = None) -> int:
        """Enforce the retention cap. Returns how many transcripts were removed.

        `max_count` is a cap on the transcripts ON DISK, not on the prunable
        ones: a protected session still occupies a slot. Counting only the
        prunable ones would let N live panes push the real total to N + cap,
        which is not the promise the knob makes.

        A live session is NEVER a candidate, whatever its age: the cap exists
        to stop a disk filling up, not to delete the pane someone is watching.
        """
        if not self.enabled:
            return 0
        protected = set(keep or set()) | self.live_ids()
        try:
            metas = list(self.root.glob(f"*{META_SUFFIX}"))
        except OSError:  # pragma: no cover
            return 0

        candidates: list[tuple[float, str]] = []
        occupied = 0
        for path in metas:
            session_id = path.name[: -len(META_SUFFIX)]
            if not is_safe_session_id(session_id):
                continue
            occupied += 1
            if session_id in protected:
                continue
            try:
                mtime = path.stat().st_mtime
            except OSError:  # pragma: no cover
                continue
            candidates.append((mtime, session_id))

        candidates.sort(reverse=True)  # newest first
        doomed: list[str] = []
        if max_age_days > 0:
            cutoff = time.time() - max_age_days * 86400
            doomed += [sid for mtime, sid in candidates if mtime < cutoff]
        if max_count > 0 and occupied > max_count:
            # Protected rows spend the budget too, so `budget` can be 0 (or
            # negative) — in which case every prunable transcript goes.
            budget = max(0, max_count - (occupied - len(candidates)))
            doomed += [sid for _, sid in candidates[budget:]]

        removed = 0
        for session_id in dict.fromkeys(doomed):
            self.forget(session_id)
            removed += 1
        if removed:
            log.info("transcripts: pruned %d old session(s) from %s", removed, self.root)
        return removed


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # pragma: no cover - exists, owned by someone else
        return True
    except OSError:  # pragma: no cover
        return False
    return True


__all__ = [
    "TranscriptRead",
    "TranscriptStore",
    "TranscriptWriter",
    "is_safe_session_id",
]
