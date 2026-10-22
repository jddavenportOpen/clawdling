# Clawdling architecture

Clawdling is one Node.js process (no database, no build step) that sits next to tmux and the
unmodified `claude` CLI. The org is a folder; sessions are tmux sessions; status comes from Claude
Code hooks.

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

## Sessions (server/sessions.js, server/tmux.js)

**Spawn.** `sid = randomUUID()` is also Claude's `--session-id`. The registry row is written to
`.clawdling/sessions.json` first. Then the server writes `.clawdling/run/<sid>.sh`, a `/bin/sh`
launcher that `cd`s, exports `CLAWDLING_SID/HOME/PORT`, puts `.clawdling/bin` (a `clawdling` shim)
first on `PATH`, and `exec`s `claude` with every argument single-quoted. tmux only ever sees our
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
the session as `needs_you` with instructions.

**Restart.** On start the server lists `tmux ls`, reattaches every registry row whose tmux session
exists, marks the rest `ended` (resumable), adopts tagged orphans (`@clawdling_sid`), then replays
the hook spool. Hooks read the current port from `.clawdling/server.json`, so sessions started
before a restart keep reporting to the new server.

**Resume.** `claude --resume <id>` in the same cwd and tmux name (or `--session-id <sid>` again if the
session never had a prompt, so there is no transcript to resume).

## Donna (server/channels/)

Each message from the paired owner (Telegram chat, iMessage handle, or the app's `/api/donna/chat`)
joins a serial queue and becomes one headless turn: `claude -p --output-format json`
(`--session-id` the first time, `--resume` afterwards, persisted as `org.json` `donna_session`),
cwd `donna/`, `--permission-mode dontAsk` and a narrow `--allowedTools` list
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

## Verified behaviour this design relies on

- tmux 3.6a: control mode over plain pipes works; `set -g window-size manual` in a config file
  crashes the server at start (so it is set per session); `set-option -t =name` fails while
  `=name:` works; each command written to a control client gets its own `%begin/%end` block
  (flags=1), and `cmd1 ; cmd2` gets two.
- claude 2.1.283: `--session-id`, `--resume`, `--name`, `--settings`, `--model`, `--permission-mode`
  (`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`; Clawdling passes no flag for
  "default"), `--add-dir`, `--append-system-prompt-file` (hidden in `--help` but supported), `-p`,
  `--output-format json`, `--allowedTools` (variadic, so it goes last). The folder-trust dialog
  defaults to "No, exit"; trust is inherited from a trusted parent folder.
