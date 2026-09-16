"""Session endpoints.

These are the seven calls pinned in BRIDGE-CONTRACT.md, plus a small set of
additive extras the shipped cockpit needs (documented in bridge/README.md under
"Extensions"). Nothing here changes the behaviour the contract specifies.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from ..auth import Claims, require_auth
from ..config import Config
from ..profiles import DomainError, resolve_agent_prompt, resolve_domain
from ..pty import (
    RESUME_DISABLED,
    RESUME_NONE,
    RESUME_RESUMED,
    RESUME_UNAVAILABLE,
    STATUS_EXITED,
    PtySession,
    SessionError,
    SessionGoneError,
    SessionManager,
    StreamEvent,
    build_child_env,
)
from ..resume import conversation_exists
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
#: Ceiling on one /history read, whatever the caller asks for. The shipped
#: cockpit asks for 50KB on mount and 512KB on catchup; this stops a caller
#: turning a 32MB transcript into a 32MB response.
MAX_HISTORY_BYTES = 4 << 20


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
    #: Additive: a PRIOR bridge session id to continue. The new pane gets its
    #: own id (and its own transcript); what carries over is the `claude`
    #: conversation, via --resume.
    resume_from: str | None = None


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
    """The live PTY for this id, or an HTTP error that says which kind of no.

    A restored record is a session the bridge KNOWS about but cannot type
    into, so it is a 409 ("has exited") rather than a 404 ("never heard of
    it"). The shipped cockpit latches "stop reconnecting" on exactly that
    distinction.
    """
    manager = _manager(request)
    session = manager.get(session_id)
    if session is not None:
        return session
    if manager.get_record(session_id) is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"session {session_id} has exited (restored from disk after a "
                "bridge restart; its transcript is readable at /history)"
            ),
        )
    raise HTTPException(status_code=404, detail=f"unknown session {session_id}")


def build_argv(
    *,
    claude_bin: str,
    model: str | None = None,
    prompt_file: Path | None = None,
    initial_prompt: str | None = None,
    session_id: str | None = None,
    resume_session_id: str | None = None,
) -> list[str]:
    """Build the child argv. Exec'd directly; there is no shell in this path.

    `session_id` and `resume_session_id` are mutually exclusive by
    construction: `--resume` continues the ORIGINAL conversation under its own
    id (that is what `--fork-session` exists to opt out of), so naming a new
    id at the same time would be a contradiction. Resume wins.
    """
    argv = [claude_bin]
    if model:
        argv += ["--model", model]
    if resume_session_id:
        argv += ["--resume", resume_session_id]
    elif session_id:
        argv += ["--session-id", session_id]
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


def _positive_int(raw: str | None, default: int | None) -> int | None:
    """A non-negative query int, or the default. Garbage is the default too.

    A malformed `?bytes=` must not 400: this endpoint is called on every pane
    mount and every alt-tab return, and failing the whole history fetch over a
    typo'd query string would blank a pane for a cosmetic reason.
    """
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(str(raw).strip())
    except ValueError:
        return default
    return value if value >= 0 else default


def _default_name(domain: str | None, cwd: Path, session_id: str) -> str:
    base = domain or cwd.name or "session"
    return f"{base}-{session_id[:8]}"


def _plan_resume(
    body: SpawnBody, request: Request, config: Config, cwd: Path, session_id: str
) -> tuple[str | None, str | None, str, str | None]:
    """Decide what the child is told about conversation continuity.

    Returns (own_session_id, resume_session_id, resume_status, resume_from).
    Never raises and never fails a spawn: the worst outcome is a fresh pane
    that SAYS it is fresh.
    """
    if not config.resume_enabled:
        return None, None, RESUME_DISABLED if body.resume_from else RESUME_NONE, None

    wanted = (body.resume_from or "").strip()
    if not wanted:
        # Every ordinary spawn still NAMES its conversation, which is the only
        # reason a later restart has anything to resume.
        return session_id, None, RESUME_NONE, None

    manager = _manager(request)
    prior = manager.get(wanted)
    if prior is not None:
        claude_id = prior.claude_session_id
    else:
        record = manager.get_record(wanted) or {}
        claude_id = record.get("claude_session_id")

    if claude_id and conversation_exists(cwd, str(claude_id)):
        return None, str(claude_id), RESUME_RESUMED, wanted
    # Known but unresumable (never named, conversation pruned, different
    # machine): start a real conversation and report the degradation.
    return session_id, None, RESUME_UNAVAILABLE, wanted


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


_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # Tells nginx and friends not to buffer the stream.
    "X-Accel-Buffering": "no",
}


async def _replay_record(manager: SessionManager, session_id: str, cursor: int | None):
    """SSE for a session that only exists as a transcript. Replays, then ends."""
    record = manager.get_record(session_id) or {}
    exit_code = record.get("exit_code")
    exit_code = exit_code if isinstance(exit_code, int) else None

    read = None
    if manager.store is not None:
        read = manager.store.read(
            session_id, start=cursor, max_bytes=manager.history_tail_bytes
        )
    if read is not None:
        if read.gapped:
            yield StreamEvent("gap", {"reason": "transcript truncated"}).encode()
        if read.data:
            text = read.data.decode("utf-8", errors="replace")
            yield StreamEvent("output", {"chunk": text, "text": text}, read.total).encode()
    yield StreamEvent("status", {"status": STATUS_EXITED, "exit_code": exit_code}).encode()
    yield StreamEvent(
        "exit",
        {
            "status": STATUS_EXITED,
            "exit_code": exit_code,
            "message": record.get("ended_reason") or f"exit {exit_code}",
        },
    ).encode()


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

    # The id is minted HERE rather than inside create(), because it is also
    # the name the child's conversation is given (--session-id) and therefore
    # has to exist before argv does.
    session_id = str(uuid.uuid4())
    own_id, resume_id, resume_status, resume_from = _plan_resume(
        body, request, config, cwd, session_id
    )

    argv = build_argv(
        claude_bin=config.claude_bin,
        model=model,
        prompt_file=prompt_file,
        initial_prompt=body.initial_prompt,
        session_id=own_id,
        resume_session_id=resume_id,
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
            session_id=session_id,
            claude_session_id=resume_id or own_id,
            resume_status=resume_status,
            resume_from=resume_from,
        )
    except SessionError as exc:
        # 429: the bridge is healthy, the caller is over the concurrency cap.
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to start PTY: {exc}") from exc

    if not requested_name:
        # The friendly default name is stamped here, before the response
        # snapshot is taken.
        session.name = _default_name(domain_id, cwd, session.session_id)
    # Push the final record (name included) into the sidecar, so a restart
    # brings the pane back under the name the user actually saw.
    session.sync_record()

    return session.snapshot()


@router.get("/api/sessions")
@router.get("/api/sessions/list")
async def list_sessions(
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    """Live panes AND sessions restored from disk after a restart.

    A restored row always reads `exited`: this bridge holds no terminal for
    it, so calling it running would be a lie the UI would act on.
    """
    return {"sessions": _manager(request).snapshots()}


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
    manager = _manager(request)
    cursor = _parse_cursor(request)

    if manager.get(session_id) is None and manager.get_record(session_id) is not None:
        # A session this bridge did not start. There is nothing to subscribe
        # to, so serve the durable transcript and close. Without this a pane
        # reattaching after a restart gets a 404 and shows an error, which is
        # exactly the blank-history symptom the transcript was written for.
        return StreamingResponse(
            _replay_record(manager, session_id, cursor),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )

    session = _require_session(request, session_id)
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
        generate(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


@router.get("/api/sessions/{session_id}/history")
async def session_history(
    session_id: str,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> Response:
    """The durable transcript, byte-addressable.

    Shape verified by reading the shipped consumer
    (`src/components/chat/SessionTerminal.tsx`), which is the only client that
    matters here:

      * `GET ...?bytes=51200` on mount — the RAW body is written straight into
        xterm (`await res.text()`), so this returns text/plain, never JSON.
      * `GET ...?bytes=524288&start=<cursor>` on focus/visibility return —
        only the bytes appended since the cursor.
      * `X-Session-Log-Total-Bytes` is read off EVERY response and becomes the
        next cursor. If it is missing the component falls back to counting the
        bytes it received, which drifts; so it is always set.
      * 404 is a defined answer, not a failure: the component treats it as
        "no prior history, this pane is fresh" and still opens the stream.

    `start` beyond the end returns 200 with an empty body, which is what makes
    the catchup poll cheap when nothing has happened.
    """
    manager = _manager(request)
    if manager.get(session_id) is None and manager.get_record(session_id) is None:
        # Serve an orphan transcript too: the file outliving the record is the
        # normal state between a prune of the in-memory list and the next boot.
        if manager.store is None or manager.store.read_meta(session_id) is None:
            raise HTTPException(status_code=404, detail=f"unknown session {session_id}")

    params = request.query_params
    max_bytes = _positive_int(params.get("bytes"), manager.history_tail_bytes)
    max_bytes = min(max_bytes, MAX_HISTORY_BYTES)
    start = _positive_int(params.get("start"), None)

    read = None
    if manager.store is not None:
        read = manager.store.read(session_id, start=start, max_bytes=max_bytes)
    if read is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no transcript for session {session_id}"
                if manager.store is not None and manager.store.enabled
                else "transcripts are disabled on this bridge (CLAWDLING_TRANSCRIPTS=0)"
            ),
        )

    headers = {
        "X-Session-Log-Total-Bytes": str(read.total),
        "X-Session-Log-Start-Byte": str(read.start),
        "Cache-Control": "no-store",
    }
    if read.gapped:
        # The caller's cursor pointed at bytes that have been trimmed. It is
        # getting the oldest bytes we still have, not the ones it asked for.
        headers["X-Session-Log-Gap"] = "true"
    return Response(
        content=read.data,
        media_type="text/plain; charset=utf-8",
        headers=headers,
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
