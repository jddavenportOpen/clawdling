"""Worker endpoints.

The dispatch half of the bridge. A session is a PTY you type into; a worker is
a job you hand off. These five calls mirror the session routes' shape and reuse
their machinery wholesale - the SAME JWT dependency (`bridge.auth.require_auth`),
the SAME cwd containment (`bridge.workspace.resolve_cwd`), the SAME domain/agent
prompt resolution (`bridge.profiles`) and the SAME SSE frame encoder
(`bridge.pty.StreamEvent`). There is no second auth path and no second notion of
where a job may run.

  POST   /api/workers              dispatch
  GET    /api/workers              list
  GET    /api/workers/{run_id}     one run
  GET    /api/workers/{run_id}/log tail, or SSE with ?follow=1
  DELETE /api/workers/{run_id}     kill (optionally reap the worktree)
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import Claims, require_auth
from ..config import Config
from ..profiles import DomainError, resolve_agent_prompt, resolve_domain
from ..pty import StreamEvent, build_child_env
from ..workers import (
    DEFAULT_LOG_TAIL_LINES,
    MAX_LOG_TAIL_LINES,
    MAX_OBJECTIVE_CHARS,
    RUNTIME_CEILING_SECONDS,
    WorkerError,
    WorkerLimitError,
    WorkerManager,
    WorkerRun,
)
from ..workspace import WorkspaceError, resolve_cwd
from .sessions import MODEL_RE

router = APIRouter()

#: Keepalive cadence for the follow stream. Matches the session stream's 15s.
PING_INTERVAL_SECONDS = 15.0
#: How often the follow stream checks the log file for new bytes.
FOLLOW_POLL_SECONDS = 0.4
#: Bytes a single follow read may pull off the file at once.
FOLLOW_CHUNK_BYTES = 64 * 1024


# ── request bodies ───────────────────────────────────────────────────────────


class DispatchBody(BaseModel):
    objective: str = Field(..., min_length=1, max_length=MAX_OBJECTIVE_CHARS)
    cwd: str | None = None
    domain: str | None = None
    agent: str | None = None
    model: str | None = None
    name: str | None = None
    max_runtime_sec: int | None = Field(default=None, ge=1, le=RUNTIME_CEILING_SECONDS)
    permission_mode: str | None = None


# ── helpers ──────────────────────────────────────────────────────────────────


def _config(request: Request) -> Config:
    return request.app.state.config


def _manager(request: Request) -> WorkerManager:
    manager = getattr(request.app.state, "workers", None)
    if manager is None:  # pragma: no cover - create_app always wires this
        raise HTTPException(status_code=503, detail="worker manager is not configured")
    return manager


def _require_run(request: Request, run_id: str) -> WorkerRun:
    run = _manager(request).get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"unknown worker run {run_id}")
    return run


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _resolve_prompt_file(body: DispatchBody, config: Config) -> tuple[str | None, Path | None]:
    """Domain row -> agent template, with an explicit `agent` overriding it."""
    domain_id: str | None = None
    prompt_file: Path | None = None
    if body.domain:
        try:
            spec = resolve_domain(body.domain, config)
        except DomainError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        domain_id = spec.id
        prompt_file = spec.agent_prompt
    if body.agent:
        try:
            prompt_file = resolve_agent_prompt(body.agent, config)
        except DomainError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return domain_id, prompt_file


# ── endpoints ────────────────────────────────────────────────────────────────


@router.post("/api/workers", status_code=status.HTTP_201_CREATED)
async def dispatch_worker(
    body: DispatchBody,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    """Dispatch a background worker. 201 with the run record."""
    config = _config(request)
    manager = _manager(request)

    try:
        cwd = resolve_cwd(body.cwd, config)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    domain_id, prompt_file = _resolve_prompt_file(body, config)

    model = body.model.strip() if body.model else None
    if model and not MODEL_RE.match(model):
        raise HTTPException(status_code=400, detail=f"invalid model id {model!r}")

    env = build_child_env(CLAWDLING_WORKER_USER=claims.email)

    try:
        # git worktree add touches the disk and can take a moment on a large
        # repo, so the whole dispatch runs off the event loop. A slow spawn must
        # never stall the streams the cockpit already has open.
        run = await asyncio.to_thread(
            manager.spawn,
            objective=body.objective,
            cwd=cwd,
            domain=domain_id,
            agent=body.agent,
            model=model,
            prompt_file=prompt_file,
            name=body.name,
            max_runtime_sec=body.max_runtime_sec,
            permission_mode=body.permission_mode,
            env=env,
        )
    except WorkerLimitError as exc:
        # 429: the bridge is healthy, the caller is over the concurrency cap.
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except WorkerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=500, detail=f"failed to start the worker process: {exc}"
        ) from exc

    return run.snapshot()


@router.get("/api/workers")
async def list_workers(
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    manager = _manager(request)
    return {
        "workers": [r.snapshot() for r in manager.list()],
        "running": manager.running_count(),
        "max_workers": manager.config.max_workers,
    }


@router.get("/api/workers/{run_id}")
async def get_worker(
    run_id: str,
    request: Request,
    claims: Claims = Depends(require_auth),
) -> dict:
    return _require_run(request, run_id).snapshot()


@router.get("/api/workers/{run_id}/log")
async def worker_log(
    run_id: str,
    request: Request,
    claims: Claims = Depends(require_auth),
    stream: str = Query(default="events"),
    tail: int = Query(default=DEFAULT_LOG_TAIL_LINES, ge=1, le=MAX_LOG_TAIL_LINES),
    follow: bool = Query(default=False),
):
    """The tail of a run's log, or an SSE follow when `?follow=1`.

    `stream=events` is the CLI's stream-json stdout (the JSONL the outcome is
    read from); `stream=stderr` is everything the child wrote to stderr. They
    are separate files on purpose - interleaving them would corrupt the JSONL.
    """
    run = _require_run(request, run_id)
    manager = _manager(request)
    try:
        path = manager.log_path(run, stream)
    except WorkerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not follow:
        return manager.log_tail(run, stream=stream, lines=tail)

    snapshot = manager.log_tail(run, stream=stream, lines=tail)
    return StreamingResponse(
        _follow(run, path, snapshot),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _follow(run: WorkerRun, path: Path, snapshot: dict):
    """Replay the tail, then stream new lines until the run ends.

    One `line` frame per log line, a `status` frame whenever the run's status
    changes (and once at the end), and a `ping` every 15s so an idle worker's
    stream is not mistaken for a dead connection.
    """
    for line in snapshot["lines"]:
        yield StreamEvent("line", {"line": line}).encode()
    yield StreamEvent("status", _status_payload(run)).encode()

    offset = int(snapshot["offset"])
    pending = b""
    last_status = run.status
    last_ping = asyncio.get_running_loop().time()

    while True:
        chunk = await asyncio.to_thread(_read_at, path, offset)
        if chunk:
            offset += len(chunk)
            pending += chunk
            *complete, pending = pending.split(b"\n")
            for raw in complete:
                yield StreamEvent(
                    "line", {"line": raw.decode("utf-8", errors="replace")}
                ).encode()
            continue

        if run.status != last_status:
            last_status = run.status
            yield StreamEvent("status", _status_payload(run)).encode()

        if run.finished:
            # One last drain: the child can write its result frame between the
            # read above and the process actually exiting.
            trailing = await asyncio.to_thread(_read_at, path, offset)
            if trailing:
                offset += len(trailing)
                pending += trailing
                *complete, pending = pending.split(b"\n")
                for raw in complete:
                    yield StreamEvent(
                        "line", {"line": raw.decode("utf-8", errors="replace")}
                    ).encode()
            if pending.strip():
                yield StreamEvent(
                    "line", {"line": pending.decode("utf-8", errors="replace")}
                ).encode()
            if run.status != last_status:
                # Only if the drain above raced a status change; the check
                # further up already emitted the terminal status otherwise, and
                # `end` carries the same payload. Two identical frames would
                # just be noise a client has to de-duplicate.
                yield StreamEvent("status", _status_payload(run)).encode()
            yield StreamEvent("end", _status_payload(run)).encode()
            return

        now = asyncio.get_running_loop().time()
        if now - last_ping >= PING_INTERVAL_SECONDS:
            last_ping = now
            yield StreamEvent("ping", {"ts": _now()}).encode()
        await asyncio.sleep(FOLLOW_POLL_SECONDS)


def _read_at(path: Path, offset: int) -> bytes:
    """Read whatever has been appended past `offset`. Never blocks on a writer."""
    try:
        with open(path, "rb") as fh:
            fh.seek(offset)
            return fh.read(FOLLOW_CHUNK_BYTES)
    except OSError:
        return b""


def _status_payload(run: WorkerRun) -> dict:
    return {
        "run_id": run.run_id,
        "status": run.status,
        "exit_code": run.exit_code,
        "elapsed_sec": run.elapsed_sec,
        "summary": run.summary,
        "detail": run.detail,
    }


@router.delete("/api/workers/{run_id}")
async def kill_worker(
    run_id: str,
    request: Request,
    claims: Claims = Depends(require_auth),
    reap: bool = Query(default=False),
) -> dict:
    """SIGTERM the run's process group, then SIGKILL after 5s. Idempotent.

    `?reap=1` additionally asks the manager to delete the run's git worktree
    once it has stopped. That request is ADVISORY: the manager refuses whenever
    the worktree still holds work, and the refusal is reported here rather than
    swallowed. There is no force flag on this route on purpose - throwing away
    commits is not something an HTTP query parameter should be able to do.
    """
    manager = _manager(request)
    run = manager.get(run_id)
    if run is None:
        # Idempotent, exactly like DELETE /api/sessions/{sid}: an id we have
        # never heard of is already in the state the caller wanted.
        return {
            "ok": True,
            "run_id": run_id,
            "status": None,
            "exit_code": None,
            "reaped": False,
            "reap_refused": None,
        }

    run = await asyncio.to_thread(manager.kill, run_id)
    payload = {
        "ok": True,
        "run_id": run_id,
        "status": run.status if run else None,
        "exit_code": run.exit_code if run else None,
        "reaped": False,
        "reap_refused": None,
    }
    if reap:
        result = await asyncio.to_thread(manager.reap, run_id)
        payload["reaped"] = result.ok
        payload["reap_refused"] = None if result.ok else result.reason
        if result.ok and result.reason:
            payload["reap_note"] = result.reason
    return payload


__all__ = ["router"]
