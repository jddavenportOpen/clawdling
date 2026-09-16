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
| `CLAWDLING_SCROLLBACK_BYTES` | `262144` | Per-session IN-MEMORY replay buffer (256KB). |
| `CLAWDLING_STATE_ROOT` | `~/.clawdling` | Where transcripts live (`<root>/transcripts/`). Deliberately outside the workspace root — see Security. |
| `CLAWDLING_TRANSCRIPTS` | `1` | `0`/`false`/`no`/`off` turns on-disk persistence off; scrollback stays in memory only. |
| `CLAWDLING_HISTORY_TAIL_BYTES` | `262144` | How much transcript a reattach or a `/history` call replays by default. |
| `CLAWDLING_TRANSCRIPT_MAX_FILE_BYTES` | `33554432` | Per-session cap (32MB). Over it, the OLDEST bytes are dropped. |
| `CLAWDLING_TRANSCRIPT_RETENTION` | `200` | Keep at most N transcripts ON DISK — a live session occupies a slot but is never deleted. `0` = no count limit. |
| `CLAWDLING_TRANSCRIPT_MAX_AGE_DAYS` | `14` | Delete transcripts older than this. `0` = no age limit. |
| `CLAWDLING_RESUME` | `1` | Pass `--session-id` on spawn and `--resume` when continuing a prior session. Turn off if `CLAWDLING_CLAUDE_BIN` is a stub that rejects those flags. |
| `CLAWDLING_DEFAULT_COLS` / `_ROWS` | `120` / `32` | Terminal size when a spawn does not ask for one. |
| `CLAWDLING_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Origins allowed to open the stream from a browser. Never `*`. |
| `CLAWDLING_REPO_ROOT` | the repo | Where `profiles/` lives. |
| `ADJUTANT_PROFILE` | `starter` | Which `profiles/<name>/domains.yaml` supplies the domain rows. |
| `BRIDGE_LOG_LEVEL` | `INFO` | Log level for `python -m bridge`. |

Background workers add four more knobs (`CLAWDLING_MAX_WORKERS`,
`CLAWDLING_WORKER_MAX_RUNTIME`, `CLAWDLING_WORKER_ROOT`, `CLAWDLING_GIT_BIN`) -
see [Workers](#workers).

## Endpoints

`BRIDGE-CONTRACT.md` is the spec. In short:

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/sessions/spawn` | `201` with the session record. `400` on a bad cwd / unknown domain / bad model, `429` at the session cap. |
| `GET` | `/api/sessions` | Every session, live and exited. |
| `GET` `POST` | `/api/sessions/{sid}/stream` | SSE. Scrollback replay, then live output, `ping` every 15s. |
| `POST` | `/api/sessions/{sid}/input` | `{"data": "..."}` written verbatim. The caller appends `\r` to submit. |
| `POST` | `/api/sessions/{sid}/resize` | `{"cols", "rows"}` via `TIOCSWINSZ`. |
| `GET` | `/api/sessions/{sid}/history` | The durable transcript. `?bytes=` tail, `?start=` byte cursor. RAW text body. |
| `DELETE` | `/api/sessions/{sid}` | SIGTERM, then SIGKILL after 5s. Idempotent. |
| `GET` | `/api/health` | Unauthenticated liveness. No secrets, no session content. |

The worker endpoints (`/api/workers*`) are additive to the v1 contract and are
documented under [Workers](#workers).

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
10. **`GET /api/sessions/{sid}/history`** — the durable transcript, described
    below. A `404` from it is a real answer ("no transcript, this pane is
    fresh"), not a failure.
11. **`resume_from` on spawn**, and the additive session keys
    `claude_session_id` / `resume_status` / `resume_from` / `restored`. Each is
    omitted when it has nothing to say, so an ordinary spawn still returns
    exactly the eight keys the contract pins.

## Persistence — what survives a restart

The in-memory ring makes a REATTACH non-blank. It cannot make a RESTART
non-blank, because it dies with the process. So every byte also goes to
`$CLAWDLING_STATE_ROOT/transcripts/<session-id>.log`, with a
`<session-id>.json` sidecar carrying the session record (name, cwd, domain,
model, timestamps, status, exit code, pid, and the `claude` conversation id).

- **The disk never stalls a pane.** `append()` is a memcpy into a buffer under
  a short lock, on the event-loop thread; one background flusher thread does
  every syscall, every 500ms. A `kill -9` of the bridge loses at most one
  flush interval — verified by killing one and reading the log back.
- **Boot reads the sidecars back as RECORDS.** They are listed by
  `GET /api/sessions` with `restored: true` and status `exited`. Nothing is
  restarted. A sidecar left saying `running` by an unclean kill is still
  reported `exited`: this bridge holds no terminal for that process, so
  anything else would be a lie the UI would act on. If the recorded pid is
  somehow still alive, that gets a line in the log.
- **Byte cursors are monotonic across a trim.** A capped log drops its oldest
  bytes; `X-Session-Log-Total-Bytes` still counts every byte ever written, and
  a cursor pointing into the dropped part comes back with
  `X-Session-Log-Gap: true` rather than silently shifted data.
- **Replay picks the source that reaches further back.** A `Last-Event-ID`
  older than the in-memory ring is served from the transcript instead of
  producing a `gap`; a `gap` now means neither store still holds those bytes.
- **Retention is bounded by count AND age**, enforced on boot and on each
  spawn. A live session's transcript is never a candidate.

### `--resume` — restoring the model's context, not just the text

A transcript restores the TEXT. Replaying 50KB of ANSI into a fresh pane shows
you a photograph of a conversation the agent no longer remembers. With
`CLAWDLING_RESUME=1` (the default):

- every spawn passes `--session-id <bridge session id>`, so the conversation
  has a name the bridge knows and stores;
- a spawn carrying `resume_from: <prior session id>` looks that name up and
  passes `--resume <conversation id>`.

It is best-effort **because the CLI is unforgiving here**: `--resume` on an id
it does not know prints `No conversation found with session ID: …` and exits
immediately — no picker, no fallback, just a pane that dies in under a second
(measured on a real PTY, CLI 2.1.273). So the bridge probes the CLI's own
session store first (`bridge/resume.py`) and, on a miss, spawns a real fresh
session reporting `resume_status: "unavailable"`. A miss costs you the model's
memory; it never costs you the pane.

## Workers

A **session** is a pane: a PTY you type into, alive only while somebody is
watching. A **worker** is the other half: you hand it an objective, it runs
headless and unattended, and it reports when it is done. Nothing types into a
worker.

```bash
# dispatch
curl -s localhost:8787/api/workers -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{"objective":"rewrite the README intro","cwd":"~/clawdling-workspaces/notes","domain":"work"}'

curl -s localhost:8787/api/workers -H "Authorization: Bearer $JWT"            # list
curl -s localhost:8787/api/workers/$RUN -H "Authorization: Bearer $JWT"       # one run
curl -s "localhost:8787/api/workers/$RUN/log?tail=50" -H "Authorization: Bearer $JWT"
curl -sN "localhost:8787/api/workers/$RUN/log?follow=1" -H "Authorization: Bearer $JWT"
curl -sX DELETE "localhost:8787/api/workers/$RUN?reap=true" -H "Authorization: Bearer $JWT"
```

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/workers` | `201` with the run record. `400` on a bad cwd / unknown domain / bad model / unlisted permission mode, `429` at the worker cap. |
| `GET` | `/api/workers` | Every run, live and finished, plus `running` and `max_workers`. |
| `GET` | `/api/workers/{run_id}` | One run. `404` if unknown. |
| `GET` | `/api/workers/{run_id}/log` | `?stream=events\|stderr`, `?tail=N`. `?follow=1` upgrades it to SSE (`line`, `status`, `ping`, `end`). |
| `DELETE` | `/api/workers/{run_id}` | SIGTERM the process group, SIGKILL after 5s. Idempotent. `?reap=true` also asks to delete the worktree. |

Same Bearer JWT as every session route, and the same `cwd` containment: a
worker's working directory must resolve inside `CLAWDLING_WORKSPACE_ROOT` or an
allowlisted root.

### What a dispatch actually does

1. Mints a **run id** (uuid4). It is the primary key, the CLI `--session-id`,
   the run's directory name, and the branch name, so one string traces a list
   row to a process to a commit.
2. Gives the run **its own git worktree** on `clawdling/worker-<short>`, checked
   out from `HEAD`. Parallel workers write files; without a worktree two of them
   share one index and one `HEAD`, and the second to run `git checkout` rips the
   tree out from under the first. A spawn pointed at a subdirectory lands in the
   same subdirectory of the worktree.
   **If the target is not a git repo** (or the repo has no commits), the run
   goes ahead in a plain directory and the record says so:
   `isolation: "none"` with `isolation_note` naming the reason. It never claims
   an isolation it did not get.
3. Writes a **`WORKPLAN.md`** into that directory with the objective and the run
   id, and points the dispatch prompt at it. An unattended run outlives its own
   context window, so the objective has to exist on disk. If a `WORKPLAN.md` is
   already there, the run writes `WORKPLAN-<short>.md` instead — it never
   overwrites a file it did not create.
4. Execs `claude --session-id <run_id> -p --output-format stream-json --verbose
   <prompt>` with `stdin` on `/dev/null` and its own process group. argv is
   exec'd directly; there is no shell in this path.
5. Captures stdout to `events.jsonl` and stderr to `stderr.log`, under
   `CLAWDLING_WORKER_ROOT/runs/<run_id>/`. They are **separate files** because
   stdout is a JSONL stream the outcome is parsed from, and interleaving a stack
   trace into it would corrupt the only machine-readable record of the run.
6. Enforces a **wall-clock ceiling** (`max_runtime_sec`, default 30 min). An
   unattended process with no deadline is a leak. On expiry the group is
   SIGTERMed, then SIGKILLed.

### Status, and where it comes from

`running` -> `done` | `failed` | `timeout` | `killed`. A finished run never
re-enters `running`.

The exit code alone cannot tell "finished the job" from "gave up politely", so
the CLI's own final `{"type":"result"}` frame decides and the exit code breaks
ties: a kill or a timeout wins outright; then `is_error: true` means `failed`
even on a zero exit; then a zero exit is `done`. A run that exits `0` without
ever emitting a result frame is reported `done` **with `detail` saying the
verdict came from the exit code alone** — that is a weaker claim, and it is
labelled as one.

### Worktrees are kept, and reaping refuses to lose work

A finished run **keeps** its worktree by default. The work is the point.

`DELETE ...?reap=true` asks to delete it, and the request is advisory. The reap
refuses, and says why, when:

- the run is still going;
- the path is not under `CLAWDLING_WORKER_ROOT/worktrees` (never overridable —
  this service does not delete outside its own tree);
- git cannot answer whether the branch holds unpublished commits (blind is a
  refusal, never a pass);
- the branch holds commits reachable from **no other ref**;
- the worktree has uncommitted changes.

The last two are overridable only from Python (`reap(run_id, force=True)`),
never from the HTTP surface: throwing away commits should not be something a
query parameter can do.

One deliberate deviation worth knowing: the motivating rule is "refuse if it
holds commits not reachable from any remote", but that exact test makes a
local-only repo permanently unreapable, since every commit is unreachable from
the empty set of remotes. The implemented question is the generalisation that
still cannot lose a commit — *is anything reachable from this branch and from no
other ref, remote or local?* A commit already merged into `main` is reachable,
and therefore safe to reap.

### Worker environment

| Variable | Default | What it does |
| --- | --- | --- |
| `CLAWDLING_MAX_WORKERS` | `4` | Concurrent RUNNING workers. Finished runs stay listed and do not consume a slot. |
| `CLAWDLING_WORKER_MAX_RUNTIME` | `1800` | Default wall-clock ceiling in seconds. A request may override it up to 24h. |
| `CLAWDLING_WORKER_ROOT` | `$CLAWDLING_WORKSPACE_ROOT/.clawdling-workers` | Holds `runs/<run_id>/` (logs) and `worktrees/<run_id>/`. If your workspace root is itself a git repo, add this directory to its `.gitignore`. |
| `CLAWDLING_GIT_BIN` | `git` | The git binary used for worktree operations. |

These four are read in `bridge/workers.py` rather than `bridge/config.py`. The
worker surface is additive to the v1 session contract, and keeping its env reads
local means adding a worker knob never touches the file every session route
depends on. Everything shared (the claude binary, the workspace roots) still
comes from the one `Config`.

### Deliberate limits

- **`permission_mode` accepts `default`, `acceptEdits` or `plan` only.**
  `bypassPermissions` is not reachable over the wire on purpose: an unattended
  run with nobody in the loop is the worst place to pre-approve every tool call.
  A self-hoster who wants that posture can set it in their own Claude Code
  settings, where it is visible.
- **Runs live in memory**, like sessions. Restart the bridge and the list is
  empty — though the worktrees and the `runs/<run_id>/` logs are still on disk,
  so no work is lost, only the index of it.
- **Any valid token can reach any worker**, exactly as for sessions. See
  Security posture.

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
  its oldest frames rather than growing, a single input write is capped, and
  transcripts are capped per file, per response, per count and per age.
- **Transcripts live OUTSIDE the workspace.** Every session's cwd is inside
  `CLAWDLING_WORKSPACE_ROOT`, so a transcript kept there would be a file the
  agent can read and rewrite — including its own. `CLAWDLING_STATE_ROOT`
  defaults to `~/.clawdling` for that reason.
- **A session id becomes a filename, so it is validated, not sanitised.**
  Anything outside `[A-Za-z0-9-_]` (or over 128 chars) gets no transcript at
  all; quietly rewriting an id would let two sessions share one log.
- **A transcript is a verbatim PTY capture.** If an agent prints a secret, the
  secret is on disk in plain text under your state root. Retention bounds how
  long, not whether. Set `CLAWDLING_TRANSCRIPTS=0` if that is not a trade you
  want to make.

What this does NOT do: multi-user authorization. Any valid token can reach any
session. The contract scopes v1 to one user on one machine. If you put several
people behind one bridge, add an owner check before you do anything else.

## Tests

```bash
make bridge-test              # or: .venv/bin/python -m pytest bridge/tests -q
```

163 tests, about 23 seconds, no network and no credentials. `CLAWDLING_CLAUDE_BIN`
is pointed at `/bin/cat`, a three-line script, or (for the worker suite) a fake
binary generated into `tmp_path` that emits stream-json and exits, so the suite
**never invokes the real `claude`** and never spends anything. The worker tests
also build real throwaway git repos under `tmp_path`, so the worktree and reap
paths are exercised against real git rather than a mock of it.
163 tests, about 20 seconds, no network and no credentials. `CLAWDLING_CLAUDE_BIN`
is pointed at `/bin/cat` or a three-line script, so the suite **never invokes the
real `claude`** and never spends anything. Transcripts are written to a
`tmp_path`, never to a developer's real `~/.clawdling`.

The restart tests build a SECOND app object over the same state root after the
first one's lifespan has closed, which is the only honest way to test this in
process: nothing is shared in memory between them.

The general fixture runs with `resume_enabled=False`, because `/bin/cat`
rejects `--session-id` and would exit before echoing anything. `test_resume.py`
uses a flag-tolerant stub instead.

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
  surfaces are out of scope for v1. Worker RUNS are also in-memory, but their
  logs and worktrees are on disk, so a restart loses the index, not the work.
- **A restart ends the processes.** Transcripts and `--resume` bring back the
  history and the model's context under a NEW pane; they do not reattach you to
  the old `claude` process, which died with the bridge. Nothing is resurrected
  on boot, deliberately.
- **Resume is not automatic.** A restored record is not respawned, and nothing
  in this repo calls `resume_from` on its own yet — the bridge supports it, and
  a UI action has to ask for it.
- **The resume probe reads the CLI's own on-disk layout.** If a future CLI
  moves its session store, the probe stops finding conversations and resume
  quietly stops happening. That is the intended direction to fail in
  (transcripts keep working, no pane breaks), but it is a heuristic, not an API.
- **A `kill -9` can lose up to one flush interval** (500ms) of pane output.
  Everything older is on disk.
- **A pane that produces output faster than the flusher drains it** grows the
  in-memory buffer until the next tick. Bounded in practice by PTY throughput;
  there is no hard cap on that buffer.
- **A running `claude` started by a killed bridge can survive it.** PTY children
  get their own process group, so an unclean bridge death can leave one behind.
  The next boot names that pid in a log line and still reports the session
  `exited` — it will not adopt it.
- Any valid token can reach any session (see Security).
- `initial_prompt` is passed as a trailing argv positional. That is how the CLI
  seeds an interactive session, and it avoids a "was the TUI ready yet" race,
  but it does mean the prompt shows up in `ps` output for the child.
