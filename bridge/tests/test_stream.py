"""SSE: scrollback replay, live fan-out, keepalives, and clean teardown.

These run against a REAL uvicorn server (the `live` fixture) because neither
Starlette's TestClient nor httpx's ASGITransport can read a stream that stays
open: both run the app to completion first. See conftest for the detail.
"""

from __future__ import annotations

import json

import pytest

from bridge.pty import StreamEvent

from .conftest import make_token, wait_for


@pytest.fixture(autouse=True)
def fast_ping(monkeypatch):
    """Ping every 200ms so a frame read can never hang a test."""
    monkeypatch.setattr("bridge.routes.sessions.PING_INTERVAL_SECONDS", 0.2)


def frames_of(resp):
    """One line iterator per response. httpx refuses a second pass."""
    return resp.iter_lines()


def read_frames(lines, count: int) -> list[dict]:
    """Parse `count` SSE frames off a live line iterator.

    Terminates even on a quiet session because the keepalive counts as a frame.
    """
    frames: list[dict] = []
    current: dict = {}
    for line in lines:
        line = line.rstrip("\r")
        if line == "":
            if current:
                frames.append(current)
                current = {}
            if len(frames) >= count:
                break
            continue
        if line.startswith("event: "):
            current["event"] = line[len("event: ") :]
        elif line.startswith("id: "):
            current["id"] = line[len("id: ") :]
        elif line.startswith("data: "):
            current["data"] = line[len("data: ") :]
    return frames


def collect_output(lines, needle: str, max_frames: int = 12) -> str:
    seen = ""
    for frame in read_frames(lines, max_frames):
        if frame.get("event") == "output":
            seen += json.loads(frame["data"])["chunk"]
        if needle in seen:
            break
    return seen


def feed(live, sid: str, text: str) -> None:
    """Write to the PTY, wait for the bytes back, then wait for quiet.

    A PTY echoes the input AND the program writes its own copy, so the stream
    settles a beat after the first sighting. Tests that snapshot a byte cursor
    need the settled value, not the first one.
    """
    assert live.client.post(f"/api/sessions/{sid}/input", json={"data": text}).status_code == 200
    session = live.session(sid)
    probe = text.strip().encode()
    assert wait_for(lambda: probe in bytes(session._ring)), bytes(session._ring)
    settle(session)


def settle(session, quiet: float = 0.3, timeout: float = 5.0) -> None:
    """Block until the session has produced no new bytes for `quiet` seconds."""
    import time as _time

    deadline = _time.monotonic() + timeout
    last = -1
    stable_since = _time.monotonic()
    while _time.monotonic() < deadline:
        current = session._total_bytes
        if current != last:
            last = current
            stable_since = _time.monotonic()
        elif _time.monotonic() - stable_since >= quiet:
            return
        _time.sleep(0.02)


# ── framing ──────────────────────────────────────────────────────────────────


def test_stream_event_encoding_is_sse():
    assert StreamEvent("output", {"chunk": "hi"}, 12).encode() == (
        'event: output\nid: 12\ndata: {"chunk": "hi"}\n\n'
    )
    assert StreamEvent("ping", {}).encode() == "event: ping\ndata: {}\n\n"


def test_stream_headers(live):
    sid = live.spawn()["session_id"]
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["cache-control"].startswith("no-cache")
        assert resp.headers["x-accel-buffering"] == "no"


def test_stream_requires_auth(live):
    sid = live.spawn()["session_id"]
    resp = live.client.get(f"/api/sessions/{sid}/stream", headers={"Authorization": ""})
    assert resp.status_code == 401


def test_stream_unknown_session_is_404(live):
    assert live.client.get("/api/sessions/nope/stream").status_code == 404


def test_stream_accepts_a_query_token(live):
    sid = live.spawn()["session_id"]
    url = f"/api/sessions/{sid}/stream?token={make_token()}"
    with live.client.stream("GET", url, headers={"Authorization": ""}) as resp:
        assert resp.status_code == 200


def test_post_transport_is_accepted(live):
    """The shipped cockpit defaults to POST on this same path."""
    sid = live.spawn()["session_id"]
    with live.client.stream("POST", f"/api/sessions/{sid}/stream") as resp:
        assert resp.status_code == 200
        frames = read_frames(frames_of(resp), 1)
    assert frames[0]["event"] in {"output", "status"}


# ── replay ───────────────────────────────────────────────────────────────────


def test_a_fresh_stream_reports_status(live):
    sid = live.spawn()["session_id"]
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        frames = read_frames(frames_of(resp), 1)
    assert frames[0]["event"] == "status"
    assert json.loads(frames[0]["data"])["status"] == "live"


def test_reattach_replays_scrollback(live):
    """The reason a reattaching pane is not blank."""
    sid = live.spawn()["session_id"]
    feed(live, sid, "scrollback-proof\r")

    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        frames = read_frames(frames_of(resp), 2)

    assert frames[0]["event"] == "output", frames  # replay precedes the badge
    assert "scrollback-proof" in json.loads(frames[0]["data"])["chunk"]
    assert frames[1]["event"] == "status"


def test_output_payload_carries_both_keys(live):
    """`chunk` is the contract; `text` is what the shipped xterm pane reads."""
    sid = live.spawn()["session_id"]
    feed(live, sid, "both-keys\r")
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        frames = read_frames(frames_of(resp), 1)
    payload = json.loads(frames[0]["data"])
    assert payload["chunk"] == payload["text"]
    assert "both-keys" in payload["chunk"]


def test_replay_frames_carry_a_monotonic_id(live):
    sid = live.spawn()["session_id"]
    feed(live, sid, "cursor\r")
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        frames = read_frames(frames_of(resp), 1)
    assert int(frames[0]["id"]) == live.session(sid)._total_bytes


def test_last_event_id_skips_already_seen_bytes(live):
    sid = live.spawn()["session_id"]
    feed(live, sid, "already-seen\r")
    cursor = live.session(sid)._total_bytes

    with live.client.stream(
        "GET", f"/api/sessions/{sid}/stream", headers={"Last-Event-ID": str(cursor)}
    ) as resp:
        frames = read_frames(frames_of(resp), 1)
    # Nothing new since the cursor, so the first frame is the status rather
    # than a re-delivery of bytes the client already painted.
    assert frames[0]["event"] == "status"


def test_a_cursor_older_than_the_ring_reports_a_gap(live):
    sid = live.spawn()["session_id"]
    feed(live, sid, "x\r")
    session = live.session(sid)
    # Pretend history has rolled past this client's cursor. Both stores have
    # to roll: since transcripts landed, the on-disk log covers a cursor the
    # ring has dropped, and a `gap` is only honest when NEITHER still holds
    # it. Trimming the transcript head is exactly what a capped log does.
    rolled = session._ring_cap * 2
    session._total_bytes += rolled
    if session.transcript is not None:
        session.transcript._trimmed += rolled

    with live.client.stream(
        "GET", f"/api/sessions/{sid}/stream", headers={"Last-Event-ID": "0"}
    ) as resp:
        frames = read_frames(frames_of(resp), 1)
    assert frames[0]["event"] == "gap"


# ── live ─────────────────────────────────────────────────────────────────────


def test_live_output_reaches_an_attached_client(live):
    sid = live.spawn()["session_id"]
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        lines = frames_of(resp)
        read_frames(lines, 1)  # drain the status frame
        live.client.post(f"/api/sessions/{sid}/input", json={"data": "live-bytes\r"})
        assert "live-bytes" in collect_output(lines, "live-bytes")


def test_two_clients_both_receive_live_output(live):
    """A second viewer on one pane is a first-class case, not a fallback."""
    sid = live.spawn()["session_id"]
    session = live.session(sid)
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as first:
        first_lines = frames_of(first)
        read_frames(first_lines, 1)
        with live.client.stream("GET", f"/api/sessions/{sid}/stream") as second:
            second_lines = frames_of(second)
            read_frames(second_lines, 1)
            assert wait_for(lambda: session.subscriber_count == 2)
            live.client.post(f"/api/sessions/{sid}/input", json={"data": "fanout\r"})
            assert "fanout" in collect_output(first_lines, "fanout")
            assert "fanout" in collect_output(second_lines, "fanout")


def test_ping_keepalive_is_emitted(live):
    sid = live.spawn()["session_id"]
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        frames = read_frames(frames_of(resp), 3)
    assert any(f["event"] == "ping" for f in frames)


def test_disconnect_unsubscribes(live):
    sid = live.spawn()["session_id"]
    session = live.session(sid)
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        read_frames(frames_of(resp), 1)
        assert wait_for(lambda: session.subscriber_count == 1)
    assert wait_for(lambda: session.subscriber_count == 0), "subscriber leaked"


# ── exit ─────────────────────────────────────────────────────────────────────


def test_attaching_to_an_exited_session_reports_exit(live):
    sid = live.spawn()["session_id"]
    live.client.delete(f"/api/sessions/{sid}")
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        frames = read_frames(frames_of(resp), 2)
    events = {f["event"] for f in frames}
    assert "status" in events
    status_frame = next(f for f in frames if f["event"] == "status")
    assert json.loads(status_frame["data"])["status"] == "exited"
    # `exit` is the extra frame the shipped cockpit latches "dead" on.
    assert "exit" in events


def test_exit_is_announced_to_a_live_stream(live):
    """A pane watching a session that dies gets told, without polling."""
    sid = live.spawn()["session_id"]
    with live.client.stream("GET", f"/api/sessions/{sid}/stream") as resp:
        lines = frames_of(resp)
        read_frames(lines, 1)
        live.client.delete(f"/api/sessions/{sid}")
        events = [f["event"] for f in read_frames(lines, 8)]
    assert "exit" in events
