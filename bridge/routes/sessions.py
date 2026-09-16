"""Session endpoints.

These are the seven calls pinned in BRIDGE-CONTRACT.md, plus a small set of
additive extras the shipped cockpit needs (documented in bridge/README.md under
"Extensions"). Nothing here changes the behaviour the contract specifies.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import Claims, require_auth
from ..config import Config
from ..profiles import DomainError, resolve_agent_prompt, resolve_domain
from ..pty import (
    STATUS_EXITED,
    PtySession,
    SessionError,
    SessionGoneError,
    SessionManager,
    StreamEvent,
    build_child_env,
)
from ..workspace import WorkspaceError, resolve_cwd

router = APIRouter()

#: Keepalive cadence. The contract pins 15s.
PING_INTERVAL_SECONDS = 15.0
#: Terminals larger than this are a typo or an attack, not a window.
MAX_DIMENSION = 1000
#: A model id is passed to the CLI as argv. No shell is involved, but a tight
#: charset keeps a malformed value from becoming a confusing CLI error.
MODEL_RE = re.compile(r"^[A-Za-z0-9._:\-\[\]]{1,80}$")
#: Cap a single input write so one request cannot pin the PTY.
MAX_INPUT_BYTES = 1 << 20


# ── request bodies ───────────────────────────────────────────────────────────


class SpawnBody(BaseModel):
    cwd: str | None = None
    initial_prompt: str | None = None
    domain: str | None = None
    agent: str | None = None
    model: str | None = None
    name: str | None = None
    cols: int | None = None
    rows: int | None = None


class InputBody(BaseModel):
    # The contract names this field `data`. `text` is accepted as an alias
    # because several shipped cockpit components post that shape.
    data: str | None = None
    text: str | None = None

    def payload(self) -> str:
        if self.data is not None:
            return self.data
        if self.text is not None:
            return self.text
        raise HTTPException(status_code=422, detail="body must carry a 'data' string")


class ResizeBody(BaseModel):
    cols: int = Field(..., ge=1, le=MAX_DIMENSION)
    rows: int = Field(..., ge=1, le=MAX_DIMENSION)


# ── helpers ──────────────────────────────────────────────────────────────────


def _config(request: Request) -> Config:
    return request.app.state.config


def _manager(request: Request) -> SessionManager:
    return request.app.state.sessions


def _require_session(request: Request, session_id: str) -> PtySession:
    session = _manager(request).get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")
    return session


def build_argv(
    *,
    claude_bin: str,
    model: str | None = None,
    prompt_file: Path | None = None,
    initial_prompt: str | None = None,
) -> list[str]:
    """Build the child argv. Exec'd directly; there is no shell in this path."""
    argv = [claude_bin]
    if model:
        argv += ["--model", model]
    if prompt_file is not None:
        argv += ["--append-system-prompt-file", str(prompt_file)]
    if initial_prompt:
        # Passed as a trailing positional, which is how the CLI seeds an
        # interactive session. Keeping it in argv (rather than typing it into
        # the PTY after a sleep) means there is no "was the TUI ready yet" race.
        argv.append(initial_prompt)
    return argv


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _default_name(domain: str | None, cwd: Path, session_id: str) -> str:
    base = domain or cwd.name or "session"
    return f"{base}-{session_id[:8]}"


def _parse_cursor(request: Request) -> int | None:
    """Read a Last-Event-ID resume cursor from the header or the query."""
    raw = request.headers.get("last-event-id") or request.query_params.get("last_event_id")
    if raw is None or not str(raw).strip():
        return None
    try:
        value = int(str(raw).strip())
    except ValueError:
        return None
    return value if value >= 0 else None


# ── endpoints ────────────────────────────────────────────────────────────────


@router.post("/api/sessions/spawn", status_code=status.HTTP_201_CREATED)
async def spawn_session(
    body: SpawnBody,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    config = _config(request)
    manager = _manager(request)

    try:
        cwd = resolve_cwd(body.cwd, config)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    prompt_file: Path | None = None
    domain_id: str | None = None
    if body.domain:
        try:
            spec = resolve_domain(body.domain, config)
        except DomainError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        domain_id = spec.id
        prompt_file = spec.agent_prompt
    if body.agent:
        # An explicit agent overrides whatever the domain row named.
        try:
            prompt_file = resolve_agent_prompt(body.agent, config)
        except DomainError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    model = body.model.strip() if body.model else None
    if model and not MODEL_RE.match(model):
        raise HTTPException(status_code=400, detail=f"invalid model id {model!r}")

    cols = body.cols or config.default_cols
    rows = body.rows or config.default_rows
    if not (1 <= cols <= MAX_DIMENSION) or not (1 <= rows <= MAX_DIMENSION):
        raise HTTPException(status_code=400, detail="cols/rows out of range")

    argv = build_argv(
        claude_bin=config.claude_bin,
        model=model,
        prompt_file=prompt_file,
        initial_prompt=body.initial_prompt,
    )
    env = build_child_env(
        TERM="xterm-256color",
        COLUMNS=str(cols),
        LINES=str(rows),
        CLAWDLING_SESSION_USER=claims.email,
    )

    requested_name = (body.name or "").strip()
    try:
        session = manager.create(
            name=requested_name or "session",
            cwd=cwd,
            argv=argv,
            env=env,
            domain=domain_id,
            model=model,
            cols=cols,
            rows=rows,
        )
    except SessionError as exc:
        # 429: the bridge is healthy, the caller is over the concurrency cap.
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to start PTY: {exc}") from exc

    if not requested_name:
        # The uuid is only known after create(), so the friendly default name
        # is stamped here, before the response snapshot is taken.
        session.name = _default_name(domain_id, cwd, session.session_id)

    return session.snapshot()


@router.get("/api/sessions")
@router.get("/api/sessions/list")
async def list_sessions(
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    return {"sessions": [s.snapshot() for s in _manager(request).list()]}


@router.api_route("/api/sessions/{session_id}/stream", methods=["GET", "POST"])
async def stream_session(
    session_id: str,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> StreamingResponse:
    """SSE. Replays scrollback, then live output, pinging every 15s.

    POST is accepted on the same path as GET with identical semantics: the
    shipped cockpit defaults to a POST+ReadableStream transport because some
    reverse proxies buffer long-lived GET bodies.
    """
    session = _require_session(request, session_id)
    cursor = _parse_cursor(request)
    subscriber, replay = session.subscribe(cursor)

    async def generate():
        try:
            for event in replay:
                yield event.encode()
            while True:
                try:
                    event = await asyncio.wait_for(
                        subscriber.queue.get(), timeout=PING_INTERVAL_SECONDS
                    )
                except (asyncio.TimeoutError, TimeoutError):
                    yield StreamEvent("ping", {"ts": _now()}).encode()
                    continue
                if event is None:
                    break
                if subscriber.take_dropped():
                    yield StreamEvent(
                        "gap", {"reason": "subscriber fell behind"}
                    ).encode()
                yield event.encode()
        finally:
            # Runs on normal end, on client disconnect (Starlette cancels the
            # generator), and on error. The subscriber never outlives the
            # response, so a closed tab cannot leak a queue.
            session.unsubscribe(subscriber)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Tells nginx and friends not to buffer the stream.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/api/sessions/{session_id}/input")
async def write_input(
    session_id: str,
    body: InputBody,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    session = _require_session(request, session_id)
    payload = body.payload().encode("utf-8")
    if len(payload) > MAX_INPUT_BYTES:
        raise HTTPException(status_code=413, detail="input too large")
    if session.status == STATUS_EXITED:
        raise HTTPException(status_code=409, detail="session has exited")
    try:
        # Off-loop: a full tty buffer blocks the writer, never the event loop.
        await asyncio.to_thread(session.write_bytes, payload)
    except SessionGoneError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/api/sessions/{session_id}/resize")
async def resize_session(
    session_id: str,
    body: ResizeBody,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    session = _require_session(request, session_id)
    if session.status == STATUS_EXITED:
        raise HTTPException(status_code=409, detail="session has exited")
    try:
        session.resize(body.cols, body.rows)
    except SessionGoneError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@router.delete("/api/sessions/{session_id}")
async def delete_session(
    session_id: str,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    """SIGTERM, then SIGKILL after 5s. Idempotent, including for unknown ids."""
    _, exit_code = await _manager(request).delete(session_id)
    return {"ok": True, "exit_code": exit_code}


__all__ = ["router", "build_argv"]
