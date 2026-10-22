# Clawdling security model

Clawdling drives real Claude Code sessions on your machine. Anyone who can talk to the Clawdling
server can type into those sessions, so the server is built to be reachable only by you.

## What Clawdling never does

- It never reads, stores or forwards Claude credentials or OAuth tokens, and never calls the
  Anthropic API. It only starts the unmodified `claude` binary you are signed into. `clawdling
  doctor` asks `claude auth status` for an exit code and discards its output.
- It never edits `~/.claude.json` or your Claude Code settings. Claude Code's own dialogs (folder
  trust) are shown to you and answered by you.
- It never builds a shell command or a tmux command from your text. Sessions start from a generated
  launcher script in which every value is single-quoted; Donna's replies to iMessage are an argv
  item of `osascript`, never part of the AppleScript source.
- No telemetry, no cloud service, no database server.

## Who can reach the server

- **Bound to 127.0.0.1** by default. `--host 0.0.0.0` prints a warning; prefer Tailscale for
  remote use.
- **A random 32-byte token** (`.clawdling/token`, mode 600) is required on every API route, the
  SSE stream and the terminal WebSocket (header `x-clawdling-token`, cookie `cl_token`, or `?t=` for
  WebSockets only). Compared in constant time. `/api/health` and the static cockpit files are public;
  they contain no secrets.
- **Browser login:** `clawdling open` opens `/?t=<token>`, which sets an `HttpOnly; SameSite=Strict`
  cookie and redirects to `/` (with `Referrer-Policy: no-referrer`), so the token does not linger in
  the address bar.
- **Cross-site requests:** mutating requests and WebSocket upgrades with an `Origin` header must be
  same-origin; `Origin: null` is refused. Requests without `Origin` (the CLI, the hook script, the
  iPhone app) are allowed with the token.
- **DNS rebinding:** while bound to loopback, requests whose `Host` is not `127.0.0.1`, `localhost`
  or `[::1]` on our port are refused. (When bound elsewhere, list extra names in
  `CLAWDLING_ALLOWED_HOSTS`.)
- Pages are served with `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- The pairing QR code and `/api/pair` contain the token; both require the token to view.

## Donna

- Only one Telegram chat is paired: a **private** chat that sent the current 6-digit code within
  30 minutes. Five wrong codes burn the code. Every other chat, including groups, gets no reply and
  never reaches Donna. iMessage only answers the configured handle.
- Each turn is `claude -p --permission-mode dontAsk` with an allow-list: `clawdling spawn`, `send`,
  `ls`, `new` and `end`, reading files inside the org folder, and editing her own `memory/`. No
  arbitrary shell, no writes elsewhere, no network tools. `clawdling init`, `start`, `service`,
  `donna` and `attach` refuse to run inside a Donna turn.
- Text messages are untrusted input to a model. The allow-list bounds what a confused or tricked
  Donna can do: start, message or end your own agents' sessions, which then run under Claude Code's
  normal permission prompts in the cockpit.
- The Telegram bot token lives in `.env` (mode 600). It is never logged, echoed by the API, or put
  in an error message.

## Agents

Agent sessions are ordinary interactive Claude Code sessions: Claude Code's permission system
applies. Clawdling pre-approves only `clawdling ls/spawn/send/new/end/doctor` (in the generated
`--settings` file and the org `.claude/settings.json`). Agents can read the whole org folder
(`--add-dir`). Permission mode defaults to Claude Code's normal "ask"; `acceptEdits` is opt-in and
`bypassPermissions` is never offered.

Agent ids must match `^[a-z0-9][a-z0-9-]{0,39}$` before any path is built from them; session ids
must be UUIDs. Static files are served only from inside `web/`.

## Files

`.clawdling/` is mode 700: token, session registry, events log (includes Donna's message text),
hook spool, launcher scripts (include first prompts), generated context files. Transcripts are
Claude Code's own (`~/.claude/projects/`); Clawdling reads them for the chat view and never writes
them.

## Tests

With `CLAWDLING_TEST=1` the server refuses to start with the default tmux socket or the real
`claude`, never calls the official Telegram API, and never runs the real `osascript` or reads the
real Messages database. Tests use a fake `claude`, a stub Bot API, a fixture `chat.db` and a stub
`osascript`.

## Not in scope

Malware running as your user (it can read the token file, as it could read anything else you own);
anyone you give the token or the pairing QR code to; what your agents do with permissions you grant
them in Claude Code.

Report vulnerabilities privately via GitHub security advisories on the repository.
