"""Transcript persistence: the durable half of "reattach is not blank".

The suite's default `config` fixture keeps transcripts ON, so every other test
file already exercises the write path incidentally. These tests are about the
part that only matters across a process boundary: what survives a restart,
what `GET /history` serves, and what retention is allowed to delete.

The restart is simulated the only honest way — a SECOND app object built over
the SAME state root, after the first one's lifespan has closed. Nothing is
shared in memory between them.
"""

from __future__ import annotations

import dataclasses
import json
import os
import threading
import time

from fastapi.testclient import TestClient

from bridge.main import create_app
from bridge.transcripts import TranscriptStore, is_safe_session_id

from .conftest import live_server, process_alive, spawn, wait_for
from .test_stream import read_frames, settle


def _session(client: TestClient, sid: str):
    return client.app_ref.state.sessions.get(sid)


def _feed(client: TestClient, auth: dict, sid: str, text: str) -> None:
    """Write to the PTY, wait for the echo, then wait for QUIET.

    A PTY echoes the input and the program writes its own copy, so bytes keep
    landing for a beat after the first sighting. Any test that then snapshots
    a byte cursor needs the settled value — otherwise the "nothing new" read
    is really "the rest of the echo".
    """
    resp = client.post(f"/api/sessions/{sid}/input", json={"data": text}, headers=auth)
    assert resp.status_code == 200, resp.text
    session = _session(client, sid)
    assert wait_for(lambda: text.strip().encode() in bytes(session._ring)), bytes(session._ring)
    settle(session)


def _flush(client: TestClient) -> None:
    """Force the pending buffer to disk without waiting for the flush timer."""
    client.app_ref.state.transcripts.flush_all()


def _boot(config) -> TestClient:
    """A fresh app over the same config — i.e. a bridge restart."""
    app = create_app(config)
    client = TestClient(app)
    client.app_ref = app  # type: ignore[attr-defined]
    return client


# ── writing ──────────────────────────────────────────────────────────────────


def test_a_spawn_writes_a_log_and_a_sidecar(client, auth, config):
    body = spawn(client, auth, name="pane-one")
    sid = body["session_id"]
    _flush(client)

    log = config.transcript_dir / f"{sid}.log"
    meta_path = config.transcript_dir / f"{sid}.json"
    assert log.exists(), "no transcript written"
    assert meta_path.exists(), "no sidecar written"

    meta = json.loads(meta_path.read_text())
    assert meta["session_id"] == sid
    assert meta["name"] == "pane-one"
    assert meta["cwd"] == str(config.workspace_root)
    assert meta["status"] == "live"
    assert meta["pid"] == _session(client, sid).pid
    assert meta["bridge_pid"] == os.getpid()


def test_output_bytes_reach_the_log(client, auth, config):
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "to-disk\r")
    _flush(client)
    assert b"to-disk" in (config.transcript_dir / f"{sid}.log").read_bytes()


def test_the_generated_name_reaches_the_sidecar(client, auth, config):
    """The route names a pane AFTER create(); the sidecar must catch up."""
    body = spawn(client, auth)
    _flush(client)
    meta = json.loads((config.transcript_dir / f"{body['session_id']}.json").read_text())
    assert meta["name"] == body["name"] != "session"


def test_exit_is_recorded_in_the_sidecar(client, auth, config):
    sid = spawn(client, auth)["session_id"]
    client.delete(f"/api/sessions/{sid}", headers=auth)
    _flush(client)
    meta = json.loads((config.transcript_dir / f"{sid}.json").read_text())
    assert meta["status"] == "exited"


def test_transcripts_can_be_turned_off(config, auth):
    off = dataclasses.replace(config, transcripts_enabled=False)
    with _boot(off) as client:
        sid = spawn(client, auth)["session_id"]
        _feed(client, auth, sid, "not-persisted\r")
        assert client.get(f"/api/sessions/{sid}/history", headers=auth).status_code == 404
    assert not off.transcript_dir.exists()


def test_a_session_id_that_is_not_filename_safe_is_refused():
    """The id becomes a path. Traversal is refused, never sanitised."""
    assert is_safe_session_id("6f1c9f10-0000-4000-8000-000000000001")
    assert not is_safe_session_id("../../etc/passwd")
    assert not is_safe_session_id("a/b")
    assert not is_safe_session_id("")
    assert not is_safe_session_id("x" * 200)


def test_a_write_failure_degrades_instead_of_killing_the_pane(tmp_path, auth, config):
    """A transcript that cannot be written must not take the bridge with it."""
    store = TranscriptStore(tmp_path / "ro", enabled=True)
    writer = store.open("6f1c9f10-0000-4000-8000-000000000002", {"session_id": "x"})
    assert writer is not None
    # Drop the open handle, then make the path unopenable: the next write has
    # to reopen and will fail, which is the shape a disk going read-only takes.
    writer._close_handle_locked()
    writer.log_path.unlink(missing_ok=True)
    writer.log_path.mkdir()
    writer.append(b"never lands")
    writer.flush()
    assert writer.degraded is not None
    writer.append(b"still accepted")  # does not raise
    store.shutdown()


# ── GET /history ─────────────────────────────────────────────────────────────


def test_history_serves_the_tail_with_a_cursor_header(client, auth):
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "history-tail\r")
    _flush(client)

    resp = client.get(f"/api/sessions/{sid}/history?bytes=51200", headers=auth)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert "history-tail" in resp.text
    # The header the shipped SessionTerminal reads and turns into its cursor.
    assert int(resp.headers["X-Session-Log-Total-Bytes"]) == len(
        (client.app_ref.state.config.transcript_dir / f"{sid}.log").read_bytes()
    )


def test_history_from_a_cursor_returns_only_what_is_new(client, auth):
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "first-half\r")
    _flush(client)
    cursor = int(
        client.get(f"/api/sessions/{sid}/history", headers=auth).headers[
            "X-Session-Log-Total-Bytes"
        ]
    )

    _feed(client, auth, sid, "second-half\r")
    _flush(client)
    resp = client.get(f"/api/sessions/{sid}/history?start={cursor}", headers=auth)
    assert resp.status_code == 200
    assert "second-half" in resp.text
    assert "first-half" not in resp.text


def test_history_at_the_end_of_the_log_is_an_empty_200(client, auth):
    """The catchup poll runs on every alt-tab. Nothing new must be cheap."""
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "quiet\r")
    _flush(client)
    total = client.get(f"/api/sessions/{sid}/history", headers=auth).headers[
        "X-Session-Log-Total-Bytes"
    ]
    resp = client.get(f"/api/sessions/{sid}/history?start={total}", headers=auth)
    assert resp.status_code == 200
    assert resp.text == ""
    assert resp.headers["X-Session-Log-Total-Bytes"] == total


def test_history_honours_the_byte_cap(client, auth):
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "x" * 400 + "\r")
    _flush(client)
    resp = client.get(f"/api/sessions/{sid}/history?bytes=64", headers=auth)
    assert resp.status_code == 200
    assert len(resp.content) <= 64


def test_a_capped_cursor_read_serves_the_TAIL_and_declares_the_skip(client, auth):
    """A cursor read bigger than the cap must not silently drop the newest bytes.

    The caller advances its cursor to X-Session-Log-Total-Bytes whatever we
    return, so serving the HEAD of an oversized range would lose everything
    after it — invisibly.
    """
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "OLDEST-MARKER\r")
    _feed(client, auth, sid, "q" * 500 + "\r")
    _feed(client, auth, sid, "NEWEST-MARKER\r")
    _flush(client)

    resp = client.get(f"/api/sessions/{sid}/history?start=0&bytes=64", headers=auth)
    assert resp.status_code == 200
    assert len(resp.content) <= 64
    assert "NEWEST-MARKER" in resp.text
    assert "OLDEST-MARKER" not in resp.text
    assert resp.headers.get("X-Session-Log-Gap") == "true"


def test_history_ignores_a_malformed_query_instead_of_400ing(client, auth):
    """Blanking a pane over a typo'd query string would be a cosmetic outage."""
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "robust\r")
    _flush(client)
    resp = client.get(f"/api/sessions/{sid}/history?bytes=abc&start=-9", headers=auth)
    assert resp.status_code == 200
    assert "robust" in resp.text


def test_history_of_an_unknown_session_is_404(client, auth):
    resp = client.get("/api/sessions/never-existed/history", headers=auth)
    assert resp.status_code == 404


def test_history_requires_auth(client, auth):
    sid = spawn(client, auth)["session_id"]
    assert client.get(f"/api/sessions/{sid}/history").status_code == 401


def test_history_reports_a_gap_when_the_head_was_trimmed(config, auth):
    """A capped log drops its oldest bytes; a stale cursor must be TOLD."""
    tight = dataclasses.replace(config, transcript_max_file_bytes=4096)
    with _boot(tight) as client:
        sid = spawn(client, auth)["session_id"]
        for _ in range(8):
            _feed(client, auth, sid, "y" * 900 + "\r")
        _flush(client)

        resp = client.get(f"/api/sessions/{sid}/history?start=0", headers=auth)
        assert resp.status_code == 200
        assert resp.headers.get("X-Session-Log-Gap") == "true"
        # Cursors stay monotonic across a trim: the total still counts every
        # byte ever written, not just the bytes still on disk.
        total = int(resp.headers["X-Session-Log-Total-Bytes"])
        assert total > len((tight.transcript_dir / f"{sid}.log").read_bytes())
        assert int(resp.headers["X-Session-Log-Start-Byte"]) > 0


# ── restart ──────────────────────────────────────────────────────────────────


def test_a_session_survives_a_restart_as_a_record(config, auth):
    with _boot(config) as first:
        body = spawn(first, auth, name="survivor")
        sid = body["session_id"]
        _feed(first, auth, sid, "before-the-restart\r")
        pid = _session(first, sid).pid
    assert not process_alive(pid), "the first bridge left an orphan"

    with _boot(config) as second:
        rows = second.get("/api/sessions", headers=auth).json()["sessions"]
        row = next(r for r in rows if r["session_id"] == sid)
        assert row["name"] == "survivor"
        assert row["status"] == "exited"  # never "live"
        assert row["restored"] is True

        history = second.get(f"/api/sessions/{sid}/history", headers=auth)
        assert history.status_code == 200
        assert "before-the-restart" in history.text


def test_a_restart_does_not_resurrect_a_process(config, auth):
    with _boot(config) as first:
        sid = spawn(first, auth)["session_id"]
    with _boot(config) as second:
        assert second.app_ref.state.sessions.live_count() == 0
        assert second.get("/api/health").json()["live"] == 0
        # Nothing to type into: a KNOWN-but-dead session is 409, not 404.
        resp = second.post(f"/api/sessions/{sid}/input", json={"data": "x"}, headers=auth)
        assert resp.status_code == 409
        assert "restored from disk" in resp.json()["detail"]


def test_a_restored_session_streams_its_transcript_then_ends(config, auth):
    """A pane reattaching after a restart gets its history, not a 404."""
    with _boot(config) as first:
        sid = spawn(first, auth)["session_id"]
        _feed(first, auth, sid, "replay-me\r")

    with _boot(config) as second:
        resp = second.get(f"/api/sessions/{sid}/stream", headers=auth)
        assert resp.status_code == 200
        assert "replay-me" in resp.text
        assert "event: status" in resp.text
        assert "event: exit" in resp.text  # the UI's "stop reconnecting" latch


def test_a_sidecar_left_saying_running_is_reported_exited(config, auth, state_root):
    """An unclean kill leaves `running` on disk. It is still not running."""
    with _boot(config) as first:
        sid = spawn(first, auth)["session_id"]
        _flush(first)
        path = config.transcript_dir / f"{sid}.json"
        meta = json.loads(path.read_text())
        assert meta["status"] == "live"
        # Skip the clean-shutdown stamp entirely, the way SIGKILL would.
        first.app_ref.state.transcripts.shutdown()
        first.app_ref.state.sessions.kill_all_now()

    assert json.loads(path.read_text())["status"] == "live"
    with _boot(config) as second:
        row = next(
            r
            for r in second.get("/api/sessions", headers=auth).json()["sessions"]
            if r["session_id"] == sid
        )
        assert row["status"] == "exited"


def test_a_corrupt_sidecar_does_not_break_the_list(config, auth):
    with _boot(config) as first:
        good = spawn(first, auth)["session_id"]
    (config.transcript_dir / "6f1c9f10-0000-4000-8000-000000000003.json").write_text(
        "{not json", encoding="utf-8"
    )
    with _boot(config) as second:
        ids = {
            r["session_id"] for r in second.get("/api/sessions", headers=auth).json()["sessions"]
        }
        assert good in ids


# ── delete ───────────────────────────────────────────────────────────────────


def test_deleting_a_live_session_keeps_its_transcript(client, auth, config):
    """Reading a dead pane's last screen is the point of having a transcript."""
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "post-mortem\r")
    client.delete(f"/api/sessions/{sid}", headers=auth)
    _flush(client)
    resp = client.get(f"/api/sessions/{sid}/history", headers=auth)
    assert resp.status_code == 200
    assert "post-mortem" in resp.text


def test_deleting_a_restored_record_purges_it(config, auth):
    """DELETE on a process-less record is the one purge verb there is."""
    with _boot(config) as first:
        sid = spawn(first, auth)["session_id"]

    with _boot(config) as second:
        assert second.delete(f"/api/sessions/{sid}", headers=auth).json()["ok"] is True
        assert not (config.transcript_dir / f"{sid}.log").exists()
        ids = {
            r["session_id"] for r in second.get("/api/sessions", headers=auth).json()["sessions"]
        }
        assert sid not in ids

    with _boot(config) as third:  # and it stays gone across the next restart
        ids = {
            r["session_id"] for r in third.get("/api/sessions", headers=auth).json()["sessions"]
        }
        assert sid not in ids


# ── replay-from-disk in the SSE stream ───────────────────────────────────────


def test_a_cursor_older_than_the_ring_is_served_from_disk(config):
    """The gap the ring would have reported, the transcript closes.

    A LIVE session's stream never ends, so this needs the real-uvicorn
    fixture: TestClient would run the generator to completion and hang.
    """
    # A ring so small it cannot hold what we write; the log holds all of it.
    tiny_ring = dataclasses.replace(config, scrollback_bytes=1024, history_tail_bytes=1 << 20)
    with live_server(tiny_ring) as live:
        sid = live.spawn()["session_id"]
        session = live.session(sid)
        live.client.post(f"/api/sessions/{sid}/input", json={"data": "oldest-line\r"})
        assert wait_for(lambda: b"oldest-line" in bytes(session._ring))
        for _ in range(4):
            live.client.post(f"/api/sessions/{sid}/input", json={"data": "z" * 600 + "\r"})
        assert wait_for(lambda: len(session._ring) >= session._ring_cap), "ring did not roll"
        live.app.state.transcripts.flush_all()

        with live.client.stream(
            "GET", f"/api/sessions/{sid}/stream", headers={"Last-Event-ID": "0"}
        ) as resp:
            frames = read_frames(resp.iter_lines(), 2)
    events = [f["event"] for f in frames]
    assert "gap" not in events, frames
    assert events[0] == "output"
    assert "oldest-line" in json.loads(frames[0]["data"])["chunk"]


# ── retention ────────────────────────────────────────────────────────────────


def test_retention_prunes_by_count_on_boot(config, auth):
    keep_two = dataclasses.replace(config, retention_count=2, max_sessions=8)
    with _boot(keep_two) as first:
        sids = [spawn(first, auth)["session_id"] for _ in range(4)]
        # Distinct mtimes so "oldest" is well defined.
        for offset, sid in enumerate(sids):
            path = keep_two.transcript_dir / f"{sid}.json"
            stamp = time.time() - (len(sids) - offset) * 60
            os.utime(path, (stamp, stamp))

    with _boot(keep_two) as second:
        surviving = {
            r["session_id"] for r in second.get("/api/sessions", headers=auth).json()["sessions"]
        }
        assert surviving == set(sids[-2:])
        for gone in sids[:-2]:
            assert not (keep_two.transcript_dir / f"{gone}.log").exists()


def test_retention_prunes_by_age_on_boot(config, auth):
    one_day = dataclasses.replace(config, retention_days=1, retention_count=0)
    with _boot(one_day) as first:
        fresh = spawn(first, auth)["session_id"]
        stale = spawn(first, auth)["session_id"]
    old = time.time() - 3 * 86400
    for suffix in (".json", ".log"):
        os.utime(one_day.transcript_dir / f"{stale}{suffix}", (old, old))

    with _boot(one_day) as second:
        surviving = {
            r["session_id"] for r in second.get("/api/sessions", headers=auth).json()["sessions"]
        }
        assert fresh in surviving
        assert stale not in surviving


def test_retention_never_deletes_a_live_sessions_transcript(client, auth, config):
    """The cap exists to bound a disk, not to delete the pane you are watching."""
    sid = spawn(client, auth)["session_id"]
    _feed(client, auth, sid, "still-running\r")
    _flush(client)
    # Ask for a cap of zero retained transcripts and an age cutoff of "now".
    removed = client.app_ref.state.transcripts.prune(
        max_count=0, max_age_days=0.0000001, keep=set()
    )
    assert removed == 0
    assert (config.transcript_dir / f"{sid}.log").exists()
    assert client.get(f"/api/sessions/{sid}/history", headers=auth).status_code == 200


def test_retention_is_enforced_on_spawn_too_not_only_on_boot(config, auth):
    """A bridge that runs for weeks must still honour its own cap."""
    keep_one = dataclasses.replace(config, retention_count=1, max_sessions=8)
    with _boot(keep_one) as client:
        first = spawn(client, auth)["session_id"]
        client.delete(f"/api/sessions/{first}", headers=auth)
        # Age the first one so it is unambiguously the oldest.
        stamp = time.time() - 600
        os.utime(keep_one.transcript_dir / f"{first}.json", (stamp, stamp))
        # Evict it from the live map, so retention is allowed to consider it.
        client.app_ref.state.sessions._sessions.pop(first, None)
        client.app_ref.state.transcripts.release(first)

        spawn(client, auth)  # this spawn is what triggers the prune
        assert not (keep_one.transcript_dir / f"{first}.log").exists()


def test_prune_is_a_no_op_when_both_caps_are_off(config, auth):
    unbounded = dataclasses.replace(config, retention_count=0, retention_days=0)
    with _boot(unbounded) as first:
        sids = [spawn(first, auth)["session_id"] for _ in range(3)]
    with _boot(unbounded) as second:
        surviving = {
            r["session_id"] for r in second.get("/api/sessions", headers=auth).json()["sessions"]
        }
        assert set(sids) <= surviving


# ── concurrency ──────────────────────────────────────────────────────────────


def test_concurrent_flush_and_read_preserve_byte_order(tmp_path):
    """Two flushers racing must not write the SECOND chunk first.

    `append` (event loop) hands bytes to a buffer; the flusher thread drains
    it; a `/history` or reattach read ALSO drains it so the caller cannot miss
    bytes written a moment ago. Without a lock around the whole
    swap-then-write, two drainers can each take a chunk and then race for the
    file, and the transcript comes out scrambled with nothing logged.
    """
    session_id = "6f1c9f10-0000-4000-8000-00000000000c"
    store = TranscriptStore(tmp_path / "race", enabled=True, flush_interval=0.005)
    writer = store.open(session_id, {"session_id": session_id})
    assert writer is not None
    store.start()

    errors: list[Exception] = []

    def reader() -> None:
        for _ in range(300):
            try:
                writer.read(None, 1 << 20)
            except Exception as exc:  # pragma: no cover - the failure we guard
                errors.append(exc)

    thread = threading.Thread(target=reader, name="transcript-race-reader")
    thread.start()
    expected = bytearray()
    for i in range(3000):
        chunk = f"[{i:05d}]".encode()
        writer.append(chunk)
        expected += chunk
    thread.join(timeout=30)
    store.shutdown()

    assert not errors, errors
    assert writer.log_path.read_bytes() == bytes(expected)


def test_a_trim_keeps_the_stream_contiguous(tmp_path):
    """After a head trim the file must still be a SUFFIX of what was written."""
    session_id = "6f1c9f10-0000-4000-8000-00000000000d"
    store = TranscriptStore(tmp_path / "trim", enabled=True, max_file_bytes=4096)
    writer = store.open(session_id, {"session_id": session_id})
    assert writer is not None

    expected = bytearray()
    for i in range(4000):
        chunk = f"<{i:05d}>".encode()
        writer.append(chunk)
        expected += chunk
        if i % 200 == 0:
            writer.flush()
    writer.flush()

    on_disk = writer.log_path.read_bytes()
    assert on_disk, "everything was trimmed"
    assert bytes(expected).endswith(on_disk)
    # total counts bytes EVER written; trimmed accounts for the difference.
    assert writer.total == len(expected)
    assert writer.trimmed + len(on_disk) == writer.total
    store.shutdown()


def test_forget_refuses_a_live_session(client, auth, config):
    sid = spawn(client, auth)["session_id"]
    _flush(client)
    client.app_ref.state.transcripts.forget(sid)
    assert (config.transcript_dir / f"{sid}.log").exists()
