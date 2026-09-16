"""FastAPI application for the Clawdling cockpit bridge.

  uvicorn bridge.main:app --host 127.0.0.1 --port 8787
  python -m bridge
  make bridge

Boot refuses to proceed without a real BRIDGE_SECRET, and the default bind is
loopback. See bridge/README.md for the full security posture.
"""

from __future__ import annotations

import atexit
import logging
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Config, ConfigError
from .pty import SessionManager
from .routes.sessions import router as sessions_router

log = logging.getLogger("bridge")


@asynccontextmanager
async def lifespan(app: FastAPI):
    config: Config = app.state.config
    log.info(
        "clawdling bridge %s listening on %s:%s | workspace=%s | max_sessions=%s | claude_bin=%s",
        __version__,
        config.host,
        config.port,
        config.workspace_root,
        config.max_sessions,
        config.claude_bin,
    )
    try:
        yield
    finally:
        # Every PTY child dies with the bridge. Without this a stranger's
        # Ctrl-C leaves N orphaned `claude` processes holding their plan quota.
        manager: SessionManager = app.state.sessions
        live = manager.live_count()
        if live:
            log.info("shutting down: terminating %d live session(s)", live)
        await manager.shutdown()


def create_app(config: Config | None = None) -> FastAPI:
    """Build the app. `config` is injectable so tests never touch the process env."""
    cfg = config or Config.from_env()

    app = FastAPI(
        title="Clawdling cockpit bridge",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.config = cfg
    app.state.sessions = SessionManager(
        max_sessions=cfg.max_sessions,
        scrollback_bytes=cfg.scrollback_bytes,
    )

    if cfg.cors_origins:
        # The browser opens the SSE stream straight at the bridge (the Next.js
        # route only mints the token), so the bridge is a cross-origin target
        # and needs CORS. Origins are an explicit allowlist; never "*".
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cfg.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "Last-Event-ID"],
        )

    app.include_router(sessions_router)

    @app.get("/api/health")
    async def health() -> dict:
        """Unauthenticated liveness. Carries no secrets and no session content."""
        manager: SessionManager = app.state.sessions
        return {
            "ok": True,
            "version": __version__,
            "sessions": len(manager.list()),
            "live": manager.live_count(),
            "max_sessions": cfg.max_sessions,
        }

    atexit.register(app.state.sessions.kill_all_now)
    return app


def _boot() -> FastAPI:
    try:
        return create_app()
    except ConfigError as exc:
        print(f"\nbridge: refusing to start.\n\n{exc}\n", file=sys.stderr)
        raise SystemExit(2) from exc


_APP: FastAPI | None = None


def __getattr__(name: str):
    """Build the app lazily on `bridge.main:app`.

    uvicorn resolves the import string with getattr, so it gets a booted app.
    Importing this module for its helpers (as the tests do) does NOT read the
    process environment, so a test run cannot be poisoned by, or depend on, the
    developer's own BRIDGE_SECRET.
    """
    if name == "app":
        global _APP
        if _APP is None:
            _APP = _boot()
        return _APP
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def main() -> None:
    """`python -m bridge` entrypoint."""
    import uvicorn

    logging.basicConfig(
        level=os.environ.get("BRIDGE_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    booted = _boot()
    cfg: Config = booted.state.config
    uvicorn.run(booted, host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    main()
