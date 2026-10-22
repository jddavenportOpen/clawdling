# Clawdling 1.0 — build spec

Owner: JD Davenport (CEO worker drafting). Date: 2026-10-22. Ship target: today.

## 0. One-line product

**Clawdling turns Claude Code into an org of agents.** Hand Claude Code one GitHub link; it interviews you (5 questions, or "use defaults") and builds your org: a chief of staff ("Donna") you can text on Telegram or iMessage, a domain agent for each area of your life/work, and a project agent for each project. A local cockpit shows the whole org and every live Claude Code session; every agent is one click from a fresh Claude Code session preloaded with its context, its memory and its tools. No session caps, no per-agent fees: every agent is the official `claude` CLI running on the Claude plan you already pay for (your plan's usage limits still apply).

### The edge (from today's market research — do not dilute)
1. **An organization, not an assistant.** Standing domain + project agents with persistent identity and memory, plus a chief of staff. Competitors are session lists (Conductor, Claude Squad, opcode) or one assistant (PAI, OpenClaw, Poke).
2. **100% Claude-Code-native.** Clawdling only ever spawns the unmodified `claude` binary the user is already signed into. It never reads, stores or forwards credentials or OAuth tokens and never calls the Anthropic API itself (no summarizer, no routing model, nothing). Titles are derived locally from text. This is a hard requirement — Anthropic enforces against token reuse since 2026-04-04.
3. **A visual cockpit over the whole org** — org map + live sessions + needs-you, in one local page.
4. **One-link, interview-driven install** of the whole org. Faster than hand-writing CLAUDE.md files.
5. **Donna routes.** A message to Donna on Telegram/iMessage goes to the right agent (she starts or continues that agent's session) and she reports back. Anthropic's native Channels can only inject into one already-open session.

### Failure modes we must not ship (bounce risks)
- Claiming "unlimited". Copy says "no session caps" and states that plan limits apply.
- An interview slower than writing a CLAUDE.md. Max 5 questions; `--defaults` path; working org in under 5 minutes.
- Agent amnesia. Every agent has a memory folder that every new session loads and every session is told to update. This must demonstrably work (live test).

## 1. Constraints

- Runtime: **Node.js >= 20**, plain **ESM JavaScript** (no TypeScript build step), JSDoc types where useful. One npm package. Runtime deps kept tiny: `ws` only on the server. Frontend libs vendored from npm and served from node_modules: `preact`, `htm`, `@xterm/xterm`, `@xterm/addon-fit` (+ optional `@xterm/addon-web-links`). **No bundler, no build step**: `web/index.html` uses an import map pointing at `/vendor/...` paths the server maps to node_modules files.
- External tools: **tmux >= 3.2** and the **`claude` CLI >= 2.1** (signed in). macOS and Linux. (Windows: WSL, documented, not tested.)
- Local-first: binds **127.0.0.1** by default. No cloud services, no database server, no telemetry. State = files.
- License: **AGPL-3.0-only** (matches the existing public repo).
- Default port **4747**. Default home **`~/clawdling`** (env `CLAWDLING_HOME` overrides; every test uses a temp home).
- Must work for a stranger: no references to JD's machine, accounts, paths or private repos anywhere in the shipped tree.

## 2. The org is a folder (source of truth = files)

```
$CLAWDLING_HOME/                  (default ~/clawdling)
  CLAUDE.md                       Org-wide context every agent inherits (who the owner is, how the org works, house rules, how memory works). Imports @me.md.
  me.md                           Owner context from the interview (role, priorities, people, preferences).
  org.json                        { "version":1, "name":"<Owner>'s org", "owner":"<Owner>", "chief":"donna",
                                    "channels": { "telegram": {"enabled":false,"chat_id":null},
                                                  "imessage": {"enabled":false,"handle":null} } }
  donna/                          The chief of staff (kind "chief")
    agent.json  CLAUDE.md  memory/
  domains/<id>/                   Domain agents (kind "domain")  e.g. health, family, work, money
    agent.json  CLAUDE.md  memory/
  projects/<id>/                  Project agents (kind "project")
    agent.json  CLAUDE.md  memory/
  .claude/
    settings.json                 Org-level Claude Code settings (permissions allow-list for clawdling CLI, etc.)
    skills/handoff/SKILL.md       "/handoff": write memory/NOW.md + append memory/LOG.md before ending
    skills/new-agent/SKILL.md     How to create a domain/project agent with the clawdling CLI
  .clawdling/                     Runtime state (never hand-edited; gitignore it)
    token                         Random 32-byte hex auth token (0600)
    sessions.json                 Session registry
    events.jsonl                  Append-only event log (spawn/end/status/rename/channel)
    hooks-settings.json           Generated Claude Code --settings file with Clawdling's hooks
    logs/
  .env                            Optional secrets: TELEGRAM_BOT_TOKEN (0600). Never committed, never logged.
```

`agent.json` schema:
```json
{ "id":"health", "kind":"domain|project|chief", "name":"Health", "mission":"one sentence",
  "icon":"heart", "color":"#E5484D",
  "repo": null,            // project agents only: absolute path of the code repo (optional)
  "domain": null,          // project agents only: optional parent domain id (for the map)
  "model": null,           // optional default model alias for this agent's sessions (e.g. "sonnet")
  "permission_mode": null, // optional: "default" | "acceptEdits" | "plan" (NEVER default to bypass)
  "created_at":"ISO" }
```
Agent ids: `^[a-z0-9][a-z0-9-]{0,39}$`. Reject anything else (path traversal guard). Names are free text.

### Memory (the anti-amnesia contract)
- Each agent has `memory/NOW.md` (current state, open threads, next steps — kept short) and `memory/LOG.md` (append-only dated entries).
- Each agent's `CLAUDE.md` ends with `@memory/NOW.md` (Claude Code @import) so **every new session starts with the agent's current state**.
- The org `CLAUDE.md` tells every agent: before you finish a piece of work, update `memory/NOW.md` and append one dated line to `memory/LOG.md` (the `/handoff` skill does exactly this).
- The cockpit shows each agent's NOW.md and the last LOG lines, and lets the user edit CLAUDE.md and NOW.md in the browser (so the user can SEE what each agent knows).

## 3. Sessions = real Claude Code in tmux

Dedicated tmux server: `tmux -L clawdling` (never touch the user's default tmux server). Users can attach from any terminal: `tmux -L clawdling attach -t <tmux_name>` (the CLI wraps this as `clawdling attach <sid>`).

### Spawn
`POST /api/sessions {agent, prompt?, model?, title?}`:
1. `sid` = crypto.randomUUID(). This is ALSO the Claude Code session id (passed as `--session-id`), so resume is exact and the transcript is `~/.claude/projects/<cwd-slug>/<sid>.jsonl`.
2. `tmux_name` = `cl-<agent>-<first 6 of sid>`.
3. cwd: the agent folder. Project agents with `repo`: cwd = repo, plus `--add-dir <agent folder>` and `--append-system-prompt-file <$CLAWDLING_HOME/.clawdling/ctx/<agent>.md>` where that generated file concatenates the org CLAUDE.md, me.md, the agent CLAUDE.md and memory/NOW.md (because the repo's ancestors don't include the org folder). Domain/chief agents need neither (Claude Code loads ancestor CLAUDE.md files from cwd upward, which includes the org CLAUDE.md).
4. Command (argv, never a shell string with user text interpolated):
   `claude --session-id <sid> --name "<Agent>: <title or 'new session'>" --settings <hooks-settings.json> [--model <m>] [--permission-mode <pm>] [<prompt>]`
   Launch via `tmux -L clawdling new-session -d -s <tmux_name> -x <cols> -y <rows> -c <cwd> -e CLAWDLING_SID=<sid> -e CLAWDLING_HOME=<home> -e CLAWDLING_PORT=<port> -- <argv...>` (tmux >= 3.2 accepts `--` then argv? If not, write a tiny per-session launcher script under .clawdling/run/<sid>.sh with properly shell-quoted args and exec it — verify on tmux 3.6). Set `remain-on-exit off`, `history-limit 50000`, `status off`, `window-size manual` on that session.
5. The `claude` binary path: env `CLAWDLING_CLAUDE_BIN` (tests point it at a fake), else `claude` on PATH.
6. Registry row written BEFORE launch returns.

### Streaming (tmux control mode — proven on tmux 3.6a)
Per open session the server keeps ONE control client: `spawn('tmux', ['-L','clawdling','-C','attach','-t',tmux_name], {stdio:'pipe'})`.
- Output: lines `%output %<pane> <data>` where bytes < 0x20 and backslash are escaped as `\ooo` octal. **Decode at the byte level** (split the Buffer on `\n`, then unescape, so UTF-8 sequences split across chunks are never corrupted). Fan out to every WebSocket viewer of that session. Keep a 256 KB ring buffer per session for late joiners.
- Input: `send-keys -t <tmux_name> -H <hex bytes...>\n` written to the control client's stdin. Batch keystrokes per 8 ms tick.
- Resize: `refresh-client -C <cols>x<rows>\n` (proven), and also `resize-window -t <name> -x <cols> -y <rows>` via a one-shot command.
- Snapshot on viewer connect: `tmux -L clawdling capture-pane -p -e -J -S -2000 -t <name>` → send as the first message so a new viewer sees current screen + recent history, then live output.
- When the tmux session exits, the control client gets `%exit`; mark the session ended (status "ended", ended_at) and tell viewers.
- Reattach: on server start, list `tmux -L clawdling ls -F '#{session_name}'`, reconcile with sessions.json: rows whose tmux session still exists are live (sessions survive Clawdling restarts — this is a feature, test it); rows whose tmux session is gone become "ended" (resumable).

### Resume
`POST /api/sessions/:sid/resume` → new tmux session running `claude --resume <sid> --settings ... ` in the same cwd/flags. Same sid (Claude keeps the id on resume; if the CLI prints a new id, record `resumed_from`).

### Status (from Claude Code hooks — no screen scraping as the primary signal)
`hooks-settings.json` (generated at server start) registers command hooks for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`, each running `node <pkg>/bin/clawdling-hook.js <Event>`. The hook script: reads the hook JSON from stdin, reads `CLAWDLING_SID`/`CLAWDLING_PORT`/`CLAWDLING_HOME` from env (set by tmux `-e`), reads the token file, POSTs `{event, sid, payload}` to `http://127.0.0.1:<port>/api/hooks` with a 1.5 s timeout, **always exits 0 quickly and prints nothing** (it must never block or alter Claude). If CLAWDLING_SID is absent (a normal non-Clawdling claude run inheriting settings) it exits 0 immediately.

Status machine: `starting` → (UserPromptSubmit) `working` → (Stop) `ready` (turn finished, waiting for you) ; (Notification) `needs_you` (permission prompt / question / idle-input notice — keep the notification message text) → (UserPromptSubmit) `working` ; (SessionEnd or tmux exit) `ended`. Output activity while `ready` for > 2 s with no hook does NOT change status (avoid flapping). Record `last_activity_at` on any output.

Titles: on the first UserPromptSubmit, if no title yet, derive one locally from the prompt text (first sentence, strip markdown/URLs, max 48 chars, sentence case). Users can rename (PATCH). Never call any model to title.

## 4. HTTP API (JSON; all routes require auth except `/` static assets and `/api/health`)

Auth: token from `.clawdling/token`. Accept header `x-clawdling-token: <t>` or cookie `cl_token=<t>`. `GET /?t=<token>` sets the cookie (HttpOnly, SameSite=Strict) and redirects to `/`. The CLI's `clawdling open` / `start --open` opens `http://127.0.0.1:4747/?t=<token>`. Reject cross-origin requests (check Origin on mutating requests and on WS upgrade). Constant-time token compare.

```
GET    /api/health                  -> {ok, version, tmux:{ok,version}, claude:{ok,version}, home}
GET    /api/org                     -> {org, agents:[Agent+{live:n, needs_you:n, last_activity_at}], channels}
POST   /api/agents                  {kind:"domain"|"project", name, mission, id?, repo?, domain?, model?} -> Agent (scaffolds from templates)
GET    /api/agents/:id              -> Agent + {claude_md, now_md, log_tail:[last 20 lines], sessions:[...]}
PUT    /api/agents/:id/context      {claude_md?, now_md?} -> 204   (writes files; size cap 200 KB)
DELETE /api/agents/:id              -> archives folder to $HOME/.archive/<id>-<ts>/ (refuse "donna")
GET    /api/sessions                -> [Session]   (newest activity first; includes ended from last 14 days)
POST   /api/sessions                {agent, prompt?, model?, title?} -> Session
PATCH  /api/sessions/:sid           {title} -> Session
DELETE /api/sessions/:sid           -> ends it (kill tmux session) -> Session(status ended)
POST   /api/sessions/:sid/resume    -> Session (live again)
POST   /api/sessions/:sid/send      {text, enter:true} -> 204   (types text into the session; used by Donna routing + CLI)
POST   /api/hooks                   (hook script only)
GET    /api/events                  Server-Sent Events: {type:"session"|"org"|"channel", data}
GET    /api/channels                -> {telegram:{configured, enabled, paired, chat_id_masked}, imessage:{supported, enabled, handle}}
POST   /api/channels/telegram       {token?, enabled?} -> stores token in .env (0600), returns pairing code
POST   /api/channels/imessage       {handle, enabled}
WS     /ws/term/:sid                terminal stream (below)
```
Session object: `{sid, agent, agent_name, kind, title, status, model, cwd, tmux_name, created_at, last_activity_at, ended_at, notification, resumable}`.

WebSocket `/ws/term/:sid` (auth via cookie or `?t=`):
- server→client: `{"t":"snapshot","data":"<string>"}` first, then `{"t":"out","data":"<string>"}`, `{"t":"status","status":"..."}`, `{"t":"ended"}`.
- client→server: `{"t":"in","data":"<string>"}`, `{"t":"resize","cols":N,"rows":N}`.

## 5. CLI (`bin/clawdling.js`, `"bin": {"clawdling": "bin/clawdling.js"}`)

```
clawdling doctor                         checks node, tmux, claude (signed in? `claude --version` + a hint), home, port; prints fixes
clawdling init [--home P] [--answers answers.json | --defaults] [--force]
                                         scaffold the org. answers.json = {owner, about, domains:[{name,mission}], projects:[{name,goal,repo?}], donna:{channel:"telegram"|"imessage"|"none"}}
clawdling start [--port 4747] [--host 127.0.0.1] [--open]     run the server (foreground)
clawdling open                           open the cockpit in the browser with the token
clawdling new domain "<Name>" --mission "..."
clawdling new project "<Name>" --goal "..." [--repo PATH] [--domain ID]
clawdling ls [--all] [--json]            list sessions
clawdling spawn <agent> ["first message"] [--model M]    (server must be running) prints sid + attach hint
clawdling send <sid> "text"              type into a session
clawdling attach <sid|tmux_name>         exec tmux -L clawdling attach
clawdling end <sid>
clawdling donna telegram --token <T>     configure + print pairing code ; clawdling donna status
clawdling service install|uninstall      macOS launchd plist (or print a systemd unit on Linux) so the cockpit starts at login
```
`clawdling spawn/send/ls/end` talk to the running server over HTTP with the token, so Donna (running inside Claude Code) can use them.

## 6. Donna — chief of staff on Telegram / iMessage

Donna is an agent (`donna/`) whose CLAUDE.md says: you are <Owner>'s chief of staff; you know the org (read `../org.json`, `../domains/*/agent.json`, `../projects/*/agent.json`, their memory/NOW.md); you never do domain work yourself — you ROUTE: decide which agent should handle a request, then run `clawdling spawn <agent> "<task>"` (or `clawdling send <sid> "<text>"` to continue a live session), and reply in 1-3 short lines saying who is on it and how to watch it. For status questions use `clawdling ls --json` and the agents' NOW.md. Phone-friendly, no markdown tables.

Channel gateway (inside the server process, `server/channels/`):
- Each inbound message from the paired owner → serial queue → run a headless Donna turn: `claude -p --output-format json --resume <donna_sid>` (first ever turn: `--session-id <new uuid>`, persisted in org.json as `donna_session`) with cwd `donna/`, `--allowedTools "Bash(clawdling *)" Read Glob Grep` (default — no arbitrary shell, no writes outside her memory; she may also get `Edit(memory/**)`/`Write(memory/**)` if supported), `--permission-mode dontAsk` if available else default with the allow-list, timeout 180 s. Parse `.result` from the JSON. Reply. On failure reply "Donna hit an error: <short reason>" and log it.
- **Telegram**: long-poll `getUpdates` (timeout 25 s) on `${TELEGRAM_API_BASE}/bot<token>/...` where TELEGRAM_API_BASE defaults to the official Bot API base URL but is overridable (tests run a local stub). Pairing: `POST /api/channels/telegram` returns a 6-digit code; the owner sends `/pair <code>` to the bot; the first chat to do so is stored as `chat_id` in org.json; every other chat is ignored (reply nothing). `sendChatAction typing` while Donna works; split replies at 4000 chars; plain text.
- **iMessage (macOS, experimental)**: poll `~/Library/Messages/chat.db` every 3 s via `/usr/bin/sqlite3 -json -readonly` for new rows (ROWID > last seen) where `is_from_me = 0` and the handle matches the configured owner handle; reply via `osascript` (AppleScript `send` to that participant on the iMessage service), with the text passed as an argv parameter to the script (never string-interpolated into AppleScript source). Requires Full Disk Access for the terminal running Clawdling and Automation permission for Messages; `doctor` explains. Document: the Mac should be signed into a different Apple ID than the owner's phone. **Tests must use a fixture sqlite DB and a stubbed osascript; the build/test agents must never send a real iMessage or a real Telegram message from this machine.**
- Routing is the differentiator: an end-to-end test proves "Telegram message → Donna turn → `clawdling spawn health ...` → a new live health session appears in the cockpit".

## 7. Templates (`templates/`) and the interview

`clawdling init --answers` renders: org `CLAUDE.md` (owner, how the org works, memory contract, house rules: confirm before destructive/outward actions), `me.md`, `donna/*`, one folder per domain/project, the skills, `.claude/settings.json` (allow `Bash(clawdling *)`), `.gitignore` (`.clawdling/`, `.env`). `--defaults` = owner from `$USER`, domains [Work, Health, Money, Home], no projects, Donna channel none.

Default domain CLAUDE.md template (filled from name + mission):
```
# <Name> agent
You are the <Name> agent in <Owner>'s org. Mission: <mission>.
## How you work
- Stay in your lane: <Name>. If a request belongs to another agent, say which one.
- Keep your memory current: before you finish, update memory/NOW.md (state, open threads, next steps; under 40 lines) and append one dated line to memory/LOG.md. The /handoff skill does this.
- Ask before anything irreversible or outward-facing (sending messages, spending money, deleting).
## Current state
@memory/NOW.md
```

**Agent-native install** — `SETUP.md` is a playbook addressed to Claude Code. README's first screen says:
> **Install by asking Claude Code:** open Claude Code anywhere and paste
> `Set up Clawdling for me from https://github.com/jddavenportOpen/clawdling — follow SETUP.md`

SETUP.md steps for Claude Code: (1) check prerequisites (`node -v` >= 20, `tmux -V`, `claude --version`; offer `brew install tmux node` on macOS with the user's OK); (2) `git clone https://github.com/jddavenportOpen/clawdling ~/.clawdling-app && cd ~/.clawdling-app && npm install --omit=dev`; (3) interview with AskUserQuestion — at most 5 questions: name + one line about you; which life/work areas (multi-select with defaults Work/Health/Money/Home/Family/Learning + other); active projects (0-3, name + goal + optional repo path); Donna channel (Telegram / iMessage / later); permission posture (ask before edits [default] / auto-accept edits) — offer "use defaults" as the first option; (4) write answers.json and run `node bin/clawdling.js init --answers answers.json`; (5) personalize: fill each agent's CLAUDE.md mission details and me.md from the interview (Claude writes prose, not the CLI); (6) `node bin/clawdling.js service install` (ask) or `start --open`; (7) Donna: Telegram → walk the user through @BotFather, `clawdling donna telegram --token`, send `/pair <code>`; iMessage → explain permissions; (8) verify: `clawdling doctor`, spawn one domain session, show the cockpit URL. Target: under 5 minutes of the user's time.

## 8. Web cockpit (`web/`) — no build step

Preact + htm + xterm.js via import map. Hash routes: `#/` cockpit, `#/map` org map, `#/agent/<id>` agent page, `#/donna` channels, `#/settings`. Dark theme by default, light via prefers-color-scheme; one accent colour; system font stack + a mono font for terminals. Keyboard: `⌘K`/`Ctrl+K` command palette (jump to session/agent, new session), `⌘\`/`Ctrl+\` toggle rail, `⌘1..9` focus pane N.

### Rail (left) — the lessons from JD's own cockpit, applied
- Header: **Cockpit** home button (always returns to `#/` with every open session restored) + live count + **collapse** button. The rail is collapsible by the user (button + `⌘\`), state persisted in localStorage. Collapsed = 56 px strip that is still useful: expand, home, new session, search, and one status dot/initial per live session (tooltip = name; click = focus).
- **+ New session** (agent picker: Donna, each domain, each project, "scratch") and **+ New agent**.
- Search box filters every section.
- Sections, in order: **Needs you** (amber; sessions in needs_you/ready waiting on the user — ready counts as "your turn"), **Live** (working + starting), **Recent** (ended in last 14 days, click = resume), **Agents** (Donna, domains, projects — row click = new session for that agent; shows live count). Every session row shows its **real name** (title or agent + "new session"), the agent, a status glyph, and relative time. Never a generic "worker" label when a title exists.
- **Clicking a session row FOCUSES it in the workspace**: if it is already open, it becomes the focused pane (scrolled into view, highlighted, keyboard focus in the terminal) and nothing else changes; if not open, it is added to the open set and focused. It never navigates away from the cockpit, never replaces the open set, never strands the user on a one-pane view. Rows open in the workspace show an "on screen" marker; the focused one shows the selection bar.
- Ending a session (rail kebab or pane X with confirm) leaves the user in the cockpit with the remaining panes.

### Workspace (main)
- Open sessions = an ordered list persisted in localStorage. Layout toggle: **Focus** (one big pane + tab strip of the others) / **Split 2** / **Grid** (auto 2x2, 3x2...). Default Grid when >1 open on wide screens.
- Pane header: status glyph, title (double-click to rename), agent chip, model, buttons: maximize, end (confirm), "attach in terminal" (copies the tmux command).
- Terminal: xterm.js + fit addon; resize → WS resize; copy/paste works; links clickable.
- Empty state: "Start your first session" with agent cards.

### Org map (`#/map`) — "see your whole system"
SVG, no chart library: Owner at center → Donna → domains on an inner ring → projects on an outer ring attached to their domain (or a "Projects" cluster). Node = icon + name + live-session badge; amber ring if any session needs you; pulse while working. Click a node → side panel (mission, NOW.md preview, live sessions, buttons: New session, Open agent page). Smooth, legible at 4 or 30 agents.

### Agent page (`#/agent/<id>`)
Mission, kind, sessions (live + recent, resume), **Context** tab with editable CLAUDE.md and **Memory** tab with editable NOW.md + LOG tail (save → PUT context). This is how users see what each agent knows.

### New agent wizard
Kind (domain/project) → name → mission/goal → (project) repo path + parent domain → Create → optional "Start a session to flesh this out" which spawns the new agent with a first prompt asking Claude to interview the user briefly and improve its own CLAUDE.md.

### Donna page (`#/donna`)
Channel cards (Telegram / iMessage) with setup steps, pairing code, status, last messages log (from events.jsonl), and Donna's own session link.

## 9. Tests (all must pass; zero real Claude/Telegram/iMessage traffic except the opt-in live smoke)

- `test/fake-claude.mjs`: a fake `claude` binary for tests. Parses `--session-id/--resume/--name/--settings/--model` and a positional prompt; prints a small TUI-like banner; echoes typed lines back as "assistant" text; invokes the configured hook commands from the --settings file with realistic JSON (SessionStart, UserPromptSubmit, Stop, Notification when the input contains "permission?", SessionEnd on "/exit"); supports `-p --output-format json` (Donna turns): reads the prompt, and if it contains "health" runs `clawdling spawn health "<rest>"` via the real CLI, then prints `{"type":"result","result":"Health agent is on it."}`.
- Unit (`node --test`): control-mode decoder (octal, split UTF-8, partial lines), title derivation, agent id validation + path traversal, template rendering, auth (token required, Origin check, constant-time compare), status machine, hooks ingestion, registry reconcile, Telegram gateway against a local stub Bot API (pairing, ignore strangers, chunking, typing), iMessage poller against a fixture chat.db + stubbed osascript argv (assert the text is passed as an argument, never interpolated).
- Integration: real server on a random port + temp home + **real tmux** + fake claude: spawn → WS snapshot/out → input echo → status transitions via hooks → rename → end → resume → **server restart keeps the tmux session live and reattaches** → Donna Telegram message routes to a new health session.
- E2E (Playwright, chromium, headless): cockpit loads with token; rail shows named sessions; clicking a row focuses that pane and keeps the others; collapse persists across reload; Cockpit button returns home with panes intact; org map renders all agents and clicking a node opens the panel; new domain agent via wizard creates the folder; agent page edits NOW.md; Donna page shows pairing code. Screenshots saved to `test/e2e/screenshots/`.
- Live smoke (opt-in `npm run smoke:live`, real `claude`, cheapest model): init a temp org with a domain whose mission contains a unique phrase, spawn it with prompt "In one sentence, what is your mission? Then say what memory/NOW.md says.", wait for Stop, read the transcript JSONL, assert the phrase and the NOW.md marker appear → proves context + memory preload.

## 10. Repo layout

```
README.md  SETUP.md  CLAUDE.md (dev guide for contributors' Claude)  LICENSE  CHANGELOG.md  package.json
bin/clawdling.js  bin/clawdling-hook.js
server/index.js (http+ws+static+auth)  server/sessions.js  server/tmux.js (control mode)  server/org.js  server/hooks.js
server/titles.js  server/events.js  server/channels/telegram.js  server/channels/imessage.js  server/channels/donna.js
templates/...   web/index.html  web/app.js  web/components/*.js  web/styles.css
test/unit/*.test.js  test/integration/*.test.js  test/e2e/*.spec.js  test/fake-claude.mjs  test/fixtures/
docs/ARCHITECTURE.md  docs/SECURITY.md (threat model: local token, Origin check, Donna tool allow-list, paired chat only, no credential handling)
```
`npm test` = unit + integration. `npm run e2e` = Playwright. `npm start` = `node bin/clawdling.js start`.

## Contract changes

Written by the core lane while implementing §4. Everything below is additive or a clarification;
no field or path in §4 was renamed or removed.

**Sessions**
- Session objects carry extra fields: `name` (`"<Agent>: <title or 'new session'>"`, ready to show),
  `permission_mode`, `last_message` (first 280 chars of Claude's last reply, from the Stop hook),
  `transcript_path` (Claude's JSONL transcript, once known), `attach_cmd` (the exact
  `tmux -L <socket> attach -t <name>` command; the socket name is configurable, so copy this).
- `GET /api/sessions/:sid` returns one Session.
- `POST /api/sessions` also accepts optional `cols`/`rows` (initial terminal size) and the
  pseudo-agent `"scratch"`: a session at the org root, not tied to an agent (`kind: "scratch"`,
  `agent_name: "Scratch"`). Trusting the org root once in a scratch session covers every agent folder.
- `POST /api/sessions/:sid/resume` accepts optional `{cols, rows}` and is idempotent (200 with the
  Session if it is already live).
- Status: `SessionStart` with no first prompt pending moves `starting` → `ready` (a fresh session is
  waiting for you). `needs_you` is also used when Claude Code's own folder-trust dialog is on screen
  (before any hook can run); `notification` then explains what to answer. After a permission
  prompt, typing Enter/1-9/Esc in the terminal moves `needs_you` → `working`.
- Agent `needs_you` counts sessions in `needs_you` **or** `ready` (both are "your turn"), matching the rail.
- `DELETE /api/sessions/:sid` returns the Session with `status: "ended"`, `resumable: true`.

**Terminal WebSocket**
- A `snapshot` message can arrive again later (after a resume, or after the control client
  reattaches). Treat every `snapshot` as a full repaint: `term.reset()` then `term.write(data)`.
- The server strips terminal *queries* (DA, DSR/CPR, DECRQM, XTVERSION, OSC colour queries...) from
  `out` data: tmux already answered them, and an xterm.js answer would be typed into the session.
  The snapshot replays the app's terminal modes (bracketed paste, mouse, focus, cursor keys).

**Org / agents**
- Agent objects include `dir` (absolute folder path).
- `DELETE /api/agents/:id` → `200 {ok:true, id, archived_to}`; `409` while the agent has live sessions.
- `GET /api/me` → `{ok:true, version}`. Errors everywhere are `{error: "<message>"}`.

**Channels**
- `GET /api/channels` → `{telegram:{configured, enabled, paired, chat_id_masked, bot_username,
  pairing_code, pairing_expires_at, polling, error}, imessage:{supported, enabled, handle, polling,
  error}, donna:{session, busy}, recent:[{ts, type:"channel", channel, direction:"in"|"out", text} |
  {ts, type:"channel", channel, event:"paired"|"error", ...}]}`. `pairing_code` is non-null only
  while a pairing is pending (30 minutes). `recent` is the Donna page's message log.
- `POST /api/channels/telegram` also accepts `{pair:true}` (issue a fresh pairing code) and returns
  the telegram status object plus `pairing_code`.

**SSE `/api/events`** (`data: {"type":..., "data":...}`)
- `session`: data = Session. `org`: data = the full `GET /api/org` payload plus `reason`
  (`agent_created` | `agent_archived` | `context_updated`) and `id`. `channel`: data =
  `{channel, direction, text, ts}` for a message, or `{channel, ...GET /api/channels}` for a status change.

**Running the server in tests (web lane e2e)**
- Set `CLAWDLING_TEST=1`, `CLAWDLING_CLAUDE_BIN=<repo>/test/fake-claude.mjs`, a unique
  `CLAWDLING_TMUX_SOCKET`, `CLAWDLING_HOME=<temp dir>` (run `clawdling init --defaults` first) and
  `TELEGRAM_API_BASE=http://127.0.0.1:9` (or a stub). In test mode the server refuses to start with
  the default socket or the real claude, and never calls the official Telegram API or osascript.
  `clawdling start --port 0` picks a free port; the actual port is in `.clawdling/server.json`.
  `CLAWDLING_WEB_DIR` overrides the static directory. `test/helpers.mjs` has `startServerProc()`.

**App API (iPhone app addendum, implemented)**. All need the token; native requests send
`x-clawdling-token` and no `Origin` (allowed, like the CLI). Requests from a foreign web origin are refused.
- `GET /api/sessions/:sid/messages?after=<n>&limit=<m>` → `{messages:[{n, role:"user"|"assistant",
  text, tools:[{name, summary}], ts}], next, more, status}`. Read from the session's Claude Code
  transcript (`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<session-id>.jsonl`; the hook-reported
  `transcript_path` is used when it matches). Kept: real user prompts (string content or text
  blocks) and assistant text/tool_use blocks. Dropped: tool_result-only user turns, `isMeta`,
  `isSidechain`, slash-command plumbing (`<command-name>`, `<local-command-stdout>`, ...),
  synthetic assistant lines, thinking blocks. One entry per transcript line (append-only, so `n`
  is stable: the 0-based index in the filtered list). `after` (default -1) returns `n > after`;
  `limit` 1-1000 (default 200); `next` = last returned `n` (or `after` when nothing is new);
  `more` = more entries exist past `next`. `summary` = first 80 chars of the tool input's
  command / file_path / pattern / url / description (then path, query, prompt).
- `POST /api/donna/chat {text}` → `{reply}` (one Donna headless turn through the same runner and
  tool allow-list as Telegram; on failure `{reply:"Donna hit an error: ...", error}`, still 200).
  Max 8000 chars. `GET /api/donna/messages?limit=50` → `{messages:[{role:"user"|"donna", text, ts,
  channel:"telegram"|"imessage"|"app", error?}]}`, oldest first, merged across channels, from
  `.clawdling/donna-chat.jsonl` (every Donna exchange on every channel is logged there).
- `GET /api/pair` → `{url, token, link:"clawdling://connect?url=<url-encoded url>&t=<token>", lan:
  ["http://<non-internal IPv4>:<port>", ...], bind}`. `url` = first `lan` entry when bound to
  0.0.0.0, `http://127.0.0.1:<port>` when bound to loopback, else `http://<bind host>:<port>`.
- `GET /api/pair/qr.svg` → `image/svg+xml` QR code of `link` (`Cache-Control: no-store`; it contains
  the token). Generated server-side with the MIT `qrcode-generator` package (new runtime dependency).
- `clawdling start --host 0.0.0.0` prints a LAN-exposure warning and suggests Tailscale.
