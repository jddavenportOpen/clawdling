# Clawdling cockpit bridge — wire contract (v1)

The Next.js UI (already shipped) talks to a local Python bridge that drives real
`claude` CLI processes in PTYs. This file is the interface both halves build to.

## Auth
Every Next->bridge call carries `Authorization: Bearer <HS256 JWT>` signed with
`BRIDGE_SECRET`. Claims: `sub` = user email, `email`, `iat`, `exp` (15 min TTL).
The browser never holds `BRIDGE_SECRET`; it gets a short-lived token from the
Next metadata route and opens SSE straight at the bridge.

Env: `BRIDGE_URL` (default `http://localhost:8787`), `BRIDGE_SECRET` (required),
`CLAWDLING_WORKSPACE_ROOT` (default `~/clawdling-workspaces`),
`CLAWDLING_MAX_SESSIONS` (default 12), `CLAWDLING_CLAUDE_BIN` (default `claude`).

## Bridge endpoints (Python, port 8787)

### POST /api/sessions/spawn
Body: `{ cwd?, initial_prompt?, domain?, agent?, model?, name?, cols?, rows? }`
- `cwd` must resolve inside `CLAWDLING_WORKSPACE_ROOT` or an allowlisted root; else 400.
- `domain` loads `profiles/<profile>/domains.yaml` row and injects its agent prompt
  via `--append-system-prompt-file`.
Returns 201: `{ session_id, name, cwd, domain, model, status, created_at }`

### GET /api/sessions
Returns `{ sessions: [ {session_id, name, cwd, domain, model, status, created_at, last_activity} ] }`
`status` one of `starting|running|exited`.

### GET /api/sessions/{sid}/stream  (SSE)
`text/event-stream`. Events:
- `event: output` / `data: {"chunk": "<utf8>"}` — PTY output
- `event: status` / `data: {"status": "running|exited", "exit_code": n|null}`
- `event: ping` every 15s (keepalive)
On connect, replays the session's scrollback buffer first so a reattaching pane
is not blank. Accepts `?token=<jwt>` since EventSource cannot set headers.

### POST /api/sessions/{sid}/input
Body: `{ "data": "<text>" }` — written verbatim to the PTY. Returns `{ ok: true }`.
Caller appends "\r" itself for submit.

### POST /api/sessions/{sid}/resize
Body: `{ cols, rows }`. Returns `{ ok: true }`.

### DELETE /api/sessions/{sid}
SIGTERM, then SIGKILL after 5s. Returns `{ ok: true, exit_code }`. Idempotent.

## Next.js routes (thin proxies, server-only)
- `POST /api/sessions/spawn`          -> bridge spawn
- `POST /api/sessions/cockpit-spawn`  -> bridge spawn (ad-hoc/project; `{cwd?, initial_prompt?}`)
- `POST /api/sessions/spawn-domain`   -> bridge spawn (`{domain, initial_prompt?}`)
- `GET  /api/sessions/list`           -> bridge list
- `GET  /api/sessions/{sid}/stream`   -> METADATA ONLY, returns
  `{ stream_url: "<BRIDGE_URL>/api/sessions/<sid>/stream?token=<jwt>", session_id }`
  (the browser then opens EventSource at stream_url directly)
- `POST /api/sessions/{sid}/input`    -> bridge input
- `POST /api/sessions/{sid}/resize`   -> bridge resize
- `DELETE /api/sessions/{sid}`        -> bridge delete
- `GET  /api/sessions/recent-cwds`    -> `{ cwds: [] }` (may be a stub)
- `GET  /api/sessions/history`        -> `{ sessions: [] }` (may be a stub)

## Non-goals for v1
No multi-account routing, no shard balancing, no domain-seat rendering from
~/clawd, no Supabase. Single user, local machine, N panes.
