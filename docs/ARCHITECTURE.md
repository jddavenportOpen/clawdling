# Clawdling architecture

Clawdling is one Node.js process (no database, no build step) that runs the unmodified `claude`
CLI in terminals it owns: tmux sessions when tmux is installed, otherwise pseudo-terminals of its
own (node-pty). The org is a folder; status comes from Claude Code hooks. It runs on macOS, Linux
and Windows (natively; no WSL).

```
 browser cockpit ──HTTP/SSE/WS──┐
 iPhone app ──HTTP──────────────┤        ┌──────────── tmux -L clawdling ─────────────┐
 clawdling CLI ──HTTP───────────┼─▶ server ──control mode──▶ cl-health-3f2a9c: claude ... │
 Telegram / iMessage ──poll─────┘   │   ◀──%output───────── cl-work-8b1e07:   claude ... │
                                    │                       └──────────────┬──────────────┘
                                    │◀──POST /api/hooks── bin/clawdling-hook.js (Claude Code hooks)
                                    └──▶ claude -p (Donna's headless turns) ──▶ clawdling spawn/send
```

## The org folder

`~/clawdling` (or `CLAWDLING_HOME`): `org.json`, `CLAUDE.md`, `me.md`, `donna/`, `domains/<id>/`,
`projects/<id>/`, `.claude/` (settings + skills), `.clawdling/` (runtime state), `.env` (secrets).
Every agent folder has `agent.json`, `CLAUDE.md` (ending with `@memory/NOW.md`), `memory/NOW.md`,
`memory/LOG.md` and `.claude/skills/{handoff,new-agent}`.

How an agent session gets its context:
- cwd is the agent folder, so Claude Code loads the org `CLAUDE.md` (an ancestor) and the agent's
  `CLAUDE.md` (which imports `memory/NOW.md`, inside the cwd).
- `me.md` is passed with `--append-system-prompt-file .clawdling/ctx/<agent>.md`, generated at every
  spawn. It is deliberately **not** an `@import` in the org `CLAUDE.md`: an import that points
  outside the session's folder makes Claude Code show an "allow external imports" dialog per folder.
- Project agents with a `repo` run in the repo; their context file also inlines the org
  `CLAUDE.md`, the agent `CLAUDE.md` and `NOW.md`, because none of those are ancestors of the repo.
- Every session gets `--add-dir <org home>`, so agents can read each other's state.

The live smoke test (`npm run smoke:live`) proves a brand-new agent answers with its mission and its
NOW.md content on the first turn without reading files.

## Session backends (server/backend.js)

`sessions.js` drives a *backend* through one surface (`listSessions`, `hasSession`,
`newSession`, `setOptions`, `killSession`, `screenText`, `paste`, `sendKeysHex`, `control()`), and
a control client per live session (`output`/`close` events, `sendBytes`, `fit`, `snapshot`).

| | tmux (`server/tmux.js`) | pty (`server/pty.js`) |
|---|---|---|
| Where a session lives | Clawdling's own tmux server (`tmux -L clawdling`) | a pseudo-terminal held by the *pty host*, a child process of the server (node-pty; ConPTY on Windows) |
| Survives a Clawdling restart | yes, reattached on start | no: ended (with a notice) and resumable with `claude --resume` |
| Screen model | tmux | one `@xterm/headless` terminal per session |
| Snapshot for a late viewer | `capture-pane` through the control client | `@xterm/addon-serialize` of the model |
| Input | `send-keys -H` in 8 ms batches | `pty.write` |
| Launch | a generated `/bin/sh` launcher | the argv directly (no shell on any OS) |
| Attach from a terminal | `tmux -L clawdling attach -t <name>` | `clawdling attach <sid>` (a WebSocket terminal client, Ctrl-] detaches) |

**Choice.** `CLAWDLING_BACKEND=tmux|pty` overrides. Otherwise tmux when tmux 3.2+ is on PATH and
this is not Windows, else pty when node-pty loads, else `clawdling start` and `doctor` stop with the
one-line fix for this OS. The choice is recorded in `server.json`, `sessions.json` and
`/api/health`.

**The pty host** (`server/pty-host.js`). node-pty runs in a child process, never in the server:
on Windows, node-pty 1.1.0's native ConPTY code can crash its whole process (an exit thread erases
a session from a global, unlocked list while the main thread reads it), and a crash in the host
ends only the host's sessions. The server marks them ended with a note ("Clawdling's terminal
process stopped unexpectedly…") and starts a new host for the next session. The host also never
kills or releases a ConPTY whose process has already exited. Output and input cross the IPC
channel; the screen model below stays in the server. `CLAWDLING_PTY_HOST=0` runs node-pty in the
server instead (debugging only). `test/stress/conpty-kill-exited.mjs` reproduces the crash.

**The pty screen model.** pty output is written into the session's headless terminal and reaches
viewers only from the write callback, after the model has parsed it. A snapshot is serialized in
a write barrier (`term.write('', cb)`), so it is an exact cut of the stream, as tmux's is: the
viewer gets everything before the cut in the snapshot and everything after it live. The model also
answers the app's terminal queries (DA1/DA2, cursor position, DECRQM, DECRQSS), which tmux does
for a tmux pane; the existing query filter still keeps those queries away from browsers. A resize
resizes the pty at once (the app redraws on SIGWINCH) and the model after the output it already
sent. Kill = SIGHUP to the session's process group, as a closing terminal would (SIGKILL after
3 s); ConPTY's kill on Windows.

**Windows.** `claude` is found like `where` finds it (PATH, then PATHEXT: the native
`claude.exe` before an npm `claude.cmd`). An npm `.cmd` shim is never run through cmd.exe: the
program it wraps is launched directly, so a prompt with quotes, `%` or newlines reaches Claude
intact; only an unrecognised `.cmd` goes through `cmd.exe /d /s /c` with every argument
caret-escaped. The command line is quoted by Clawdling (MSVC rules), not by node-pty. Hooks use
Claude Code's exec form (`command` + `args`, 2.1.139+), so no shell parses a path whether Claude
Code runs hooks in Git Bash or PowerShell. Every session gets `clawdling` as an sh shim (Git
Bash), a `.ps1` (PowerShell) and a `.cmd`, and the allow rules cover the PowerShell tool too.

## Sessions (server/sessions.js, server/tmux.js, server/pty.js)

**Spawn.** `sid = randomUUID()` is also Claude's `--session-id`. The registry row is written to
`.clawdling/sessions.json` first. With tmux, the server then writes `.clawdling/run/<sid>.sh`, a
`/bin/sh` launcher that `cd`s, exports `CLAWDLING_SID/HOME/PORT`, puts `.clawdling/bin` (a
`clawdling` shim) first on `PATH`, and `exec`s `claude` with every argument single-quoted. The pty
backend spawns `claude` with the same argv and environment directly. tmux only ever sees our
own safe strings (`new-session -d -s cl-<agent>-<sid6> -x C -y R /bin/sh <launcher>`), because
tmux's command parser strips a trailing `;` from any argument. The prompt goes after `--`, and a
one-word prompt gets a trailing space so `claude -- update` can never run `claude update`.

**Environment.** The server removes a parent Claude Code session's markers (`CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, ...) and `TMUX` from everything it spawns: the
agent-native install starts Clawdling from inside Claude Code, and spawned sessions must not think
they are nested in the installer.

**Streaming.** One `tmux -C attach-session -t =<name>` control client per live session. Output
lines (`%output %<pane> <data>`, bytes < 0x20 and `\` as `\ooo`) are split on 0x0a at the byte
level, unescaped, and decoded with a streaming UTF-8 decoder (tmux splits characters across
lines). Before fan-out, terminal *queries* (DA, DSR, DECRQM, XTVERSION, OSC colour queries, ...)
are removed: tmux already answered them as the pane's terminal, and xterm.js would answer again
into the session's input. Input from viewers becomes `send-keys -t %<pane> -H <hex>` in 8 ms
batches. Resize = `resize-window` (the window is `window-size manual`) plus `refresh-client -C`.

**Snapshots.** A viewer that connects gets `capture-pane -p -e -J -S -2000` plus the cursor
position, requested *through the control client*, so the snapshot is an exact cut of the output
stream (output before the cut goes only to existing viewers). The terminal modes the app enabled
(bracketed paste, mouse, focus, cursor keys) are tracked from the stream, persisted with the
session, and replayed after the snapshot.

**Status.** `--settings .clawdling/hooks-settings.json` registers `bin/clawdling-hook.js` for
SessionStart, UserPromptSubmit, Stop, Notification and SessionEnd. The hook POSTs to
`/api/hooks` and always exits 0 without output within 1.5 s; if the server is down it appends to
`.clawdling/hook-spool.jsonl`, which the server replays on start. Before the first hook, the server
reads the rendered screen (`capture-pane`) to recognise Claude Code's folder-trust dialog and shows
the session as `needs_you` with instructions and the choices. `POST /api/sessions/:sid/answer`
answers it (or a permission prompt) by moving the pointer with arrow keys and pressing Enter once
the pointer is on the chosen line: the trust dialog ignores digit keys.

**Start.** The server first refuses if `server.json` names a live server for this home, then
binds its port, and only then writes the hooks file, the shim and the registry; until it is ready
the API answers 503 and hooks spool. **Restart.** On start the server lists the backend's live
sessions (`tmux ls`; none for pty), reattaches every registry row whose session exists, marks the
rest `ended` (resumable), adopts tagged orphans (`@clawdling_sid`), then replays the hook spool.
Hooks read the current port from `.clawdling/server.json`, so sessions started before a restart
keep reporting to the new server. **Stop.** With pty, stopping the server ends its sessions
(SIGHUP, then marked ended with a notice); a crash leaves the same picture on the next start.

**Resume.** `claude --resume <id>` in the same cwd and tmux name (or `--session-id <sid>` again if the
session never had a prompt, so there is no transcript to resume).

## Donna (server/channels/)

Each message from the paired owner (Telegram chat, iMessage handle, or the app's `/api/donna/chat`)
joins a serial queue and becomes one headless turn: `claude -p --output-format json`
(`--session-id` the first time, `--resume` afterwards, persisted as `org.json` `donna_session`),
cwd `donna/`, `--permission-mode dontAsk`, `--setting-sources project,local --strict-mcp-config`
(the owner's own settings and MCP servers do not apply) and a narrow `--allowedTools` list
(`Bash(clawdling spawn|send|ls|new|end ...)`, `Read` of the org folder, `Edit(memory/**)`). The prompt
carries the message plus a roster of agents and live sessions. Donna routes by running the real
CLI, which talks to the server over HTTP like any other client. Every exchange is logged to
`.clawdling/donna-chat.jsonl`.

- Telegram: long-poll `getUpdates` against `TELEGRAM_API_BASE` (default the official Bot API).
  Pairing by a 6-digit code (30 minutes, private chats only, burned after 5 wrong tries).
- iMessage (macOS): `sqlite3 -json -readonly` on `chat.db` every 3 s for new rows from the owner's
  handle; replies via `osascript` with the text as an argv item.

## App API

`GET /api/sessions/:sid/messages` reads Claude Code's transcript JSONL incrementally
(`server/transcripts.js`) and returns an append-only chat view. `GET /api/pair` and
`/api/pair/qr.svg` hand a phone the URL and token. See SPEC.md "Contract changes".

## Discovery and import (server/stack.js, server/git.js, server/discover.js, server/importer.js)

`server/stack.js` reads a repo's manifests to name its language, frameworks, package manager,
install/test/dev/build/lint commands and monorepo packages, and pulls a short README excerpt. No
network, no `exec`.

`server/git.js` reads a repo's `.git` directly (`HEAD`, `config`, `logs/HEAD`) for its remote and
last-activity time, so finding repos never spawns a process. `server/discover.js` walks the
filesystem for git repos under `~/code` and similar roots (bounded depth and entry count,
skipping `node_modules`, `vendor`, dot-folders and the org's own home), reads Claude Code's
`projects/` folder for folders you've worked in before, and scans your Claude Code setup (skills,
subagents, commands, plugins, hooks, MCP server names) for the Settings card and the org map's
toggle. It is the only module that spawns anything, and the only thing it spawns is the user's own
`gh`: each call is bounded by a timeout and never fatal to the overall scan. Every string it
surfaces passes through `redactSecrets()` before it is returned.

`server/importer.js` turns a chosen candidate into a project agent: it drafts the agent's
`CLAUDE.md` and `NOW.md` deterministically from what `discover.js` found (no model call), clones
a not-cloned repo into a new folder under the user's `~/code`-style root (never into an existing
one), and writes `source: {remote, remote_key, github, imported_at}` into `agent.json` so
importing the same repo again is recognised and skipped. Everything it writes resolves under
`<org>/projects/<id>/`; it never writes into the repo itself.

New routes: `GET /api/discover`, `GET /api/setup`, `POST /api/import`, `POST
/api/setup/promote` (the same token auth as every other route). A successful import publishes the
`agent_created` org event, so every open cockpit updates live.

## Verified behaviour this design relies on

- tmux 3.6a: control mode over plain pipes works; `set -g window-size manual` in a config file
  crashes the server at start (so it is set per session); `set-option -t =name` fails while
  `=name:` works; each command written to a control client gets its own `%begin/%end` block
  (flags=1), and `cmd1 ; cmd2` gets two.
- claude 2.1.283: `--session-id`, `--resume`, `--name`, `--settings`, `--model`, `--permission-mode`
  (`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`; with no flag a session opens in
  auto mode, so "Ask before editing files" passes `manual`, or `default` on a claude whose
  `--help` lists that instead: `server/permissions.js`), `--add-dir`, `--append-system-prompt-file` (hidden in `--help` but supported), `-p`,
  `--output-format json`, `--allowedTools` (variadic, so it goes last). The folder-trust dialog
  defaults to "No, exit"; trust is inherited from a trusted parent folder.
