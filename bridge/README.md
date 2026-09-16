# Clawdling cockpit bridge

The cockpit UI (`/chat`) drives real `claude` CLI processes. This is the piece
that runs them: a small FastAPI service that puts each session on its own
pseudo-terminal, streams the output to as many attached panes as you like, and
takes keystrokes back.

The wire format is pinned in [`../BRIDGE-CONTRACT.md`](../BRIDGE-CONTRACT.md).
The Next.js half talks to this service and never holds `BRIDGE_SECRET`.

```
browser  ──EventSource / fetch──>  bridge :8787  ──PTY──>  claude
   |                                   ^
   └──> Next.js :3000 ──mints JWT──────┘
```

## Quick start

```bash
make bridge-install                       # .venv + pip install -r bridge/requirements.txt
export BRIDGE_SECRET="$(openssl rand -base64 32)"   # same value the cockpit uses
make bridge                               # http://127.0.0.1:8787
```

Then point the cockpit at it (in your `.env`):

```
BRIDGE_URL=http://localhost:8787
BRIDGE_SECRET=<the same value>
```

Sanity check without the UI:

```bash
curl -s localhost:8787/api/health
```

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `BRIDGE_SECRET` | none, **required** | HS256 secret shared with the cockpit. The bridge refuses to boot without it, and refuses a placeholder or a value under 32 chars. |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address. Loopback on purpose. See Security. |
| `BRIDGE_PORT` | `8787` | Listen port. |
| `CLAWDLING_WORKSPACE_ROOT` | `~/clawdling-workspaces` | Every session `cwd` must resolve inside this tree. Created on boot if missing. |
| `CLAWDLING_WORKSPACE_ALLOWLIST` | empty | Extra roots a `cwd` may live under, separated by `:` or `,`. |
| `CLAWDLING_MAX_SESSIONS` | `12` | Concurrent LIVE sessions. Exited sessions stay listed and do not consume a slot. |
| `CLAWDLING_CLAUDE_BIN` | `claude` | The binary to exec. Point it at a script to test without spending anything. |
| `CLAWDLING_SCROLLBACK_BYTES` | `262144` | Per-session replay buffer (256KB). |
| `CLAWDLING_DEFAULT_COLS` / `_ROWS` | `120` / `32` | Terminal size when a spawn does not ask for one. |
| `CLAWDLING_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Origins allowed to open the stream from a browser. Never `*`. |
| `CLAWDLING_REPO_ROOT` | the repo | Where `profiles/` lives. |
| `ADJUTANT_PROFILE` | `starter` | Which `profiles/<name>/domains.yaml` supplies the domain rows. |
| `BRIDGE_LOG_LEVEL` | `INFO` | Log level for `python -m bridge`. |

## Endpoints

`BRIDGE-CONTRACT.md` is the spec. In short:

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/sessions/spawn` | `201` with the session record. `400` on a bad cwd / unknown domain / bad model, `429` at the session cap. |
| `GET` | `/api/sessions` | Every session, live and exited. |
| `GET` `POST` | `/api/sessions/{sid}/stream` | SSE. Scrollback replay, then live output, `ping` every 15s. |
| `POST` | `/api/sessions/{sid}/input` | `{"data": "..."}` written verbatim. The caller appends `\r` to submit. |
| `POST` | `/api/sessions/{sid}/resize` | `{"cols", "rows"}` via `TIOCSWINSZ`. |
| `DELETE` | `/api/sessions/{sid}` | SIGTERM, then SIGKILL after 5s. Idempotent. |
| `GET` | `/api/health` | Unauthenticated liveness. No secrets, no session content. |

Auth is a Bearer JWT on every route except `/api/health`. The stream also
accepts `?token=<jwt>` because `EventSource` cannot set headers.

### Extensions beyond the v1 contract

All of these are additive. A client that implements only the contract sees
exactly the contract's behaviour.

1. **`POST` on `/stream`**, same semantics as `GET`. The shipped cockpit
   defaults to a POST + ReadableStream transport (some reverse proxies buffer
   long-lived GET bodies), so GET alone would leave the default UI blank.
2. **`id:` on every output frame**, carrying the session's total byte count.
3. **`Last-Event-ID`** (header or `?last_event_id=`) replays only the bytes
   after that cursor, and emits a `gap` frame if the cursor has fallen out of
   the ring buffer.
4. **`text` mirrored alongside `chunk`** in the output payload. The contract
   names `chunk`; the shipped xterm pane unwraps `text`. Both keys carry the
   same string.
5. **`exit` event** on top of the contract's `status` event when a session
   ends. The shipped UI latches "this session is dead, stop reconnecting" on
   `exit`; without it a closed pane reconnects to a dead session forever.
6. **`gap` event** when a subscriber falls too far behind and the oldest queued
   frames are dropped. Silence would be a lie.
7. **CORS**, because the browser opens the stream directly at this service.
8. **`GET /api/sessions/list`** as an alias for `GET /api/sessions`.
9. **`text` accepted as an alias for `data`** on the input route.

## Security posture

This is a local service that executes a program and hands its terminal to
whoever holds a token. Treat it that way.

- **Loopback by default.** `BRIDGE_HOST` defaults to `127.0.0.1`. If you expose
  it, put it behind TLS and an authenticating proxy. Do not bind `0.0.0.0` on a
  shared network.
- **No boot without a real secret.** A missing, short (under 32 chars),
  placeholder, or no-entropy `BRIDGE_SECRET` aborts startup with exit code 2.
  The template value `change-me-shared-secret` is explicitly refused.
- **HS256 only.** The verifier passes a single-algorithm allowlist, which is
  what stops `alg: none` and RS256 key-confusion. `exp` is required; an expired
  token is a 401 on every route, including the stream.
- **cwd containment.** Every `cwd` is `expanduser`d and fully resolved (symlinks
  followed, `..` collapsed) and must then be inside `CLAWDLING_WORKSPACE_ROOT`
  or an allowlisted root. A symlink inside the workspace that points outside it
  is rejected, and so is a path with a null byte.
- **No shell, ever.** The child is started with `execvpe` on an argv list. No
  `shell=True`, no string interpolation into a command. A `cwd`, `model`, or
  prompt containing `; rm -rf /` is just an odd-looking argument.
- **Agent templates cannot escape the profile.** `domains.yaml` is user-editable,
  so a resolved `--append-system-prompt-file` path is required to stay inside
  `profiles/<profile>/`.
- **The child never sees the secret.** `BRIDGE_SECRET`, `SPINE_SECRET`,
  `NEXTAUTH_SECRET` and anything prefixed `BRIDGE_` are stripped from the
  environment the agent inherits.
- **Nothing is orphaned.** SIGTERM or Ctrl-C runs the lifespan shutdown, which
  terminates every live PTY; signals go to the child's process GROUP, so an
  agent's own subprocesses go with it.
- **Bounded by construction.** `CLAWDLING_MAX_SESSIONS` caps live sessions,
  scrollback is a fixed-size ring, each subscriber queue is bounded and drops
  its oldest frames rather than growing, and a single input write is capped.

What this does NOT do: multi-user authorization. Any valid token can reach any
session. The contract scopes v1 to one user on one machine. If you put several
people behind one bridge, add an owner check before you do anything else.

## Tests

```bash
make bridge-test              # or: .venv/bin/python -m pytest bridge/tests -q
```

108 tests, about 13 seconds, no network and no credentials. `CLAWDLING_CLAUDE_BIN`
is pointed at `/bin/cat` or a three-line script, so the suite **never invokes the
real `claude`** and never spends anything.

The SSE tests run against a real uvicorn server on an ephemeral port. Neither
Starlette's `TestClient` nor httpx's `ASGITransport` can read a stream that
stays open: both run the ASGI app to completion and hand back a buffered body.

## How it works

- One **reader thread** per session does the blocking `os.read` on the PTY
  master, so a read never touches the event loop. Bytes are handed to the loop
  with `call_soon_threadsafe`, which is also the only thread that mutates
  session state.
  The reader is also the only thread that closes the PTY master: closing a
  descriptor under a blocked reader does not wake it on macOS or Linux, and a
  recycled fd number would then deliver another session's bytes to this one.
- One **waiter thread** per session does the single blocking `waitpid`. Having
  exactly one waiter means a child is reaped exactly once, whether it exited on
  its own, was deleted, or was caught by shutdown.
- Output fans out to a **bounded queue per subscriber**, so N panes can watch
  one session and a stalled viewer cannot slow the PTY or anybody else.
- Scrollback is a **byte** ring, not a string ring, so a multi-byte character
  split across two PTY reads survives. Decoding happens at the edge with
  `errors="replace"`.
- `os.forkpty()` creates the child. It calls `setsid`, which is what makes the
  child a process group leader and lets teardown signal the whole group. The
  child does `chdir` then `execvpe` and nothing else: no Python runs in the
  forked child, which is what makes forking from a threaded process safe here.

## Known limits

- Sessions live in memory. Restart the bridge and the panes are gone. There is
  no on-disk transcript and no `--resume`, so the cockpit's history and rehydrate
  surfaces are out of scope for v1.
- Any valid token can reach any session (see Security).
- `initial_prompt` is passed as a trailing argv positional. That is how the CLI
  seeds an interactive session, and it avoids a "was the TUI ready yet" race,
  but it does mean the prompt shows up in `ps` output for the child.
