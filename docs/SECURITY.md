# Clawdling security model

Clawdling drives real Claude Code sessions on your machine. Anyone who can talk to the Clawdling
server can type into those sessions, so the server is built to be reachable only by you.

## What Clawdling never does

- It never reads, stores or forwards Claude credentials or OAuth tokens, and never calls the
  Anthropic API. It only starts the unmodified `claude` binary you are signed into. `clawdling
  doctor` asks `claude auth status` for an exit code and discards its output. A second Claude
  account added in Settings is only a folder (`~/.clawdling-accounts/<name>`) that Clawdling passes
  to `claude` as `CLAUDE_CONFIG_DIR` for the sessions started with it; you sign in inside Claude
  Code, and Clawdling never sees, reads or stores that login. It never switches accounts on its own.
- It never edits `~/.claude.json` or your Claude Code settings. Claude Code's own dialogs (folder
  trust) are shown to you and answered by you.
- It never builds a shell command or a tmux command from your text. tmux sessions start from a
  generated launcher script in which every value is single-quoted; sessions in the built-in
  terminal (node-pty) are spawned with their argv directly, with no shell on any OS. On Windows the
  command line is quoted by Clawdling (MSVC rules), an npm `.cmd` shim is bypassed for the program
  it wraps, and only an unrecognised `.cmd` goes through `cmd.exe /d /s /c` with every argument
  caret-escaped (no variable expansion, no `&`, `|` or redirection). Donna's replies to iMessage are
  an argv item of `osascript`, never part of the AppleScript source.
- No telemetry, no cloud service, no database server.

## Who can reach the server

- **Bound to 127.0.0.1** by default, including with Use from anywhere on (below). `--host
  0.0.0.0` prints a warning; for use away from home, prefer Use from anywhere.
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
- The Wi-Fi pairing QR code and `/api/pair` contain the token; both require the token to view,
  and neither is ever served through a remote address.
- **Proxies:** while bound to loopback, a request with a localhost `Host` that carries a proxy's
  headers (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Cf-Connecting-Ip`, `Tailscale-User-Login`
  and similar) is refused: it came through a tunnel that rewrote the `Host` header, which would
  otherwise make a remote request look local. Register the address with `clawdling remote add`.

## Use from anywhere

Off by default. It lets the owner open the cockpit from their own phone or another computer
through one of two doors on this computer: a **Tailscale Serve** entry (private to the owner's
tailnet) or a **Cloudflare Tunnel** with **Cloudflare Access** in front (beta). The server still
listens on `127.0.0.1` only; the serve entry or tunnel forwards to it.

**What is exposed.** With it on, the cockpit (every agent, every session's terminal, Donna's chat)
is reachable at the registered `https://` address, to whoever passes both locks below. That is
the same power as sitting at the computer, so it is guarded as such.

**What protects it.**
- **Lock 1, the door.** Tailscale: only the owner's own devices get through. Tailscale Serve
  adds a `Tailscale-User-Login` header for a request from a signed-in user's device (it strips any
  copy a client sent, and never sets it for Funnel or tagged devices). The check records the
  owner's login from its own request through the address, and every later request must carry
  exactly that login, so another person on a shared tailnet is refused before they see a page.
  Cloudflare: Cloudflare Access makes every visitor sign in (an email policy) before Cloudflare
  forwards anything; Clawdling then checks the `Cf-Access-Jwt-Assertion` header Access adds on
  every request (RS256, signed by the team's keys at `<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  the application's AUD tag, the team as issuer, not expired). A request without a valid one is
  refused, even for the sign-in page, so removing Access later cannot quietly expose the cockpit.
  If the keys cannot be fetched, requests are refused (fail closed).
- **Lock 2, a paired device.** Each device signs in once with a pairing link made in Settings on
  the computer itself: a random one-time code (192 bits), valid for 10 minutes, kept only in the
  server's memory and voided by a restart or by turning remote off. Opening the link shows a
  "Sign in this device" button; only that POST uses the code (so a link preview cannot burn it).
  The device then holds its own random credential (`cld_<id>_<secret>`, 256-bit secret) in a
  cookie that is `Secure` (https only), `HttpOnly` (page scripts cannot read it) and
  `SameSite=Strict` (another site cannot send it or embed the cockpit; a link from elsewhere opens
  the page signed out for one load, and the page's own same-origin calls carry it). It lasts 30
  days. `remote-devices.json` stores only `sha256(secret)`. Each device can be signed out from
  Settings.
- **The long-lived token never leaves the computer.** Through a remote address the token is not
  accepted in any form (header, cookie, `/?t=` link, WebSocket `?t=`), the pairing QR codes and
  links never hold it, and `/api/pair` (which returns it) is refused. Things only the computer
  itself may do: make pairing links, add or remove addresses, turn remote on, stop the server, and
  post hook events. Turning it off works from anywhere.
- **Only through the door.** A remote name is answered only on a connection from this computer
  itself (the serve or tunnel process connects from `127.0.0.1`). With `--host 0.0.0.0`, a
  computer on the Wi-Fi sending a remote `Host` is refused.
- **Exact Host, https origin.** A remote request is matched on its exact `Host`, port included
  (`box.example.ts.net:8743` is not `box.example.ts.net`), against the registered addresses. A
  mutating request or WebSocket upgrade with an `Origin` must be exactly `https://<that address>`.
  SSE and WebSockets go through the same checks as every API call. Remote responses carry
  `Strict-Transport-Security`.
- **Never public.** `clawdling remote add` checks an address before it is registered and leaves
  `remote.json` unchanged when the check fails. Tailscale: Funnel (Tailscale's public mode) must be
  off for that address (read with `tailscale serve status --json`, the only Tailscale command
  Clawdling runs; if Clawdling cannot read it, the address is not answered) and the address must
  reach this Clawdling (a one-time nonce through the address) with a Tailscale login on it. Cloudflare: a signed-out request must be redirected to `<team>.cloudflareaccess.com`
  (which also gives the AUD tag); a page that answers (any 2xx, or Clawdling's own refusal,
  marked with `X-Clawdling-Refused`) means the address is public, and it is refused. Later checks
  (Settings' Check again, `clawdling remote check`) apply the same rules: an address found public
  or unprotected is not answered until a check passes again. A request marked `Tailscale-Funnel-Request` is always refused.
- **Throttle.** Per remote address and per signed-in Tailscale login or Access email, 10 failed
  sign-ins (a wrong device credential or pairing code) in 5 minutes make new attempts answer
  `429` for the rest of the window, so nobody else can hold pairing shut for the owner. Paired
  devices keep working, and the computer itself is never throttled. A request with no credential
  is not counted. (The secrets are 192 and 256 bits, so this is defence in depth, not what
  stops guessing.)
- **Turn off means off.** Settings' Turn off (or `clawdling remote off`) stops answering every
  remote address at once, closes their open terminal WebSockets and event streams, signs out
  every device and voids every pairing link. Turning it on again (from Settings, or a
  `clawdling remote add` while it is off) signs out every device again, so each one pairs again.
  `clawdling remote off` and `remove` go through the running server whenever one owns the org;
  if it does not answer, the change is written to disk and the server re-reads both files. The serve entry or tunnel stays until removed (`/remote-access off`, which removes only
  what setup added).
- **`remote.json` integrity.** `.clawdling/remote.json` (mode 600) is re-read whenever it changes
  and validated strictly: https addresses with a DNS name and no path, a known kind and status,
  well-formed Access settings. Anything malformed turns remote off and says why in Settings; a
  change made outside the server closes remote connections within two seconds. Agents' file tools
  are denied in `.clawdling/`, so `clawdling remote ...` is the way to change it, and that command
  asks for permission inside a session (only `clawdling remote list` is pre-approved). Donna's
  text-message turns cannot run `clawdling remote` at all.

**The setup agent.** "Set it up with an agent" starts an ordinary Claude Code session on the
owner's plan, at the org root, whose first message is the visible `/remote-access <path>`. The
skill tells it to explain the plan, to ask before every install or change, and to leave every
sign-in to the owner in their browser. It never asks for, reads, prints or stores a credential
(no auth keys, no `cert.pem` or tunnel credentials file, nothing in `.clawdling/`), never turns on
Funnel, never runs `tailscale serve reset` or touches serve entries it did not create, never
restarts Clawdling with `--host`, and never registers a Cloudflare address before Access is in
front. The session's own permission prompts apply to every command on top of that, and the
server's checks hold even if an agent ignored the skill.

**Why never a public URL without Access.** Anyone on the internet could then reach the pairing
endpoint and the cockpit's sign-in page, and a single leaked or phished pairing link or device
cookie would be the only thing between them and a shell on your computer. Access (or a tailnet)
makes the attacker first be you.

**Not in scope here.** Anyone the owner adds to their Access policy passes Cloudflare's lock 1
(they still need a paired device); on Tailscale only the owner's own login does. A stolen,
unlocked, paired phone is the owner's device until it is signed out in Settings (or remote is
turned off).

## Donna

- Only one Telegram chat is paired: a **private** chat that sent the current 6-digit code within
  30 minutes. Five wrong codes burn the code. Every other chat, including groups, gets no reply and
  never reaches Donna. iMessage only answers the configured handle.
- Each turn is `claude -p --permission-mode dontAsk --setting-sources project,local
  --strict-mcp-config --allowedTools ...`. The allow-list is `clawdling spawn`, `send`, `ls`,
  `new`, `end`, `discover` and `import` (without `--yes`), reading files inside the org folder,
  and editing her own `memory/`; under `dontAsk` everything else is refused without a prompt. No
  arbitrary shell, no writes elsewhere, no network tools. `clawdling init`, `start`, `service`,
  `donna`, `attach` and `import --yes` refuse to run inside a Donna turn: creating agents is the
  owner's call, made from the cockpit or by running `import --yes` themselves.
- **Your own Claude Code setup does not apply to Donna's turns.** `--setting-sources project,local`
  skips your user settings (`~/.claude/settings.json`: your allow rules, hooks, plugins), so a
  personal rule such as `Bash(git *)` cannot widen what a text message can make Donna run. Only
  settings files in `donna/.claude/` would load, and Clawdling creates none. `--strict-mcp-config`
  without `--mcp-config` loads no MCP servers at all, so your connected services (mail, Slack,
  files...) are out of reach of a text message. Enterprise managed policy still applies, and Claude
  Code still signs in the usual way (Clawdling never handles the credentials).
- Interactive agent sessions are different on purpose: they are your normal Claude Code sessions
  with your settings, MCP servers and permission prompts, shown in the cockpit.
- Text messages are untrusted input to a model. The allow-list bounds what a confused or tricked
  Donna can do: start, message or end your own agents' sessions, which then run under Claude Code's
  normal permission prompts in the cockpit.
- The Telegram bot token lives in `.env` (mode 600). It is never logged, echoed by the API, or put
  in an error message.

## Agents

Agent sessions are ordinary interactive Claude Code sessions: Claude Code's permission system
applies. Clawdling never answers a permission prompt or a folder-trust question on its own: typed
text (Donna, the CLI, the `/send` API) is refused while one is on screen. A choice is picked only
by someone holding the token: an explicit `POST /api/sessions/:sid/answer` (the cockpit's and
the phone's buttons), or keys typed into the session's own terminal (`/ws/term`, the cockpit's
terminal or `clawdling attach`). Clawdling pre-approves only `clawdling ls/spawn/send/new/end/doctor` (in the generated
`--settings` file and the org `.claude/settings.json`). Agents can read the whole org folder
(`--add-dir`) except Clawdling's own runtime folder: the same settings deny agents' file tools
(Read, Edit) on `<org>/.clawdling/`, which holds the token, and Donna's turns get the same rule as
`--disallowedTools`. A shell command you approve runs as you and can still read it, so treat an
approved arbitrary command as owner-level (1.2 plans a separate, narrower token for agents). Permission mode defaults to "Ask before editing files", passed by name
(`--permission-mode manual`, or `default` on a Claude Code that calls it that; the names are read
from `claude --help` at startup), because a Claude Code started with no mode now opens in auto
mode. `acceptEdits` is opt-in, `inherit` (no flag: your own Claude Code setting) is opt-in, and
`bypassPermissions` and `auto` are never offered.

Agent ids must match `^[a-z0-9][a-z0-9-]{0,39}$` before any path is built from them; session ids
must be UUIDs. Static files are served only from inside `web/`.

## Discovery and import

`clawdling discover` (and the cockpit's "Bring in your projects") is **read-only and local**: it
never sends anything anywhere and never writes anything. The only program it runs is your own
`gh`, with your own environment, exactly as if you typed it (`gh repo list`, `gh api user`). It
never reads `GH_TOKEN` or gh's `hosts.yml` itself and never passes a token anywhere. In the
cockpit it runs in a worker thread.

What it reads:
- folder names under the Claude Code config's `projects/` folder, and the `cwd` line of the
  newest transcript in each (nothing else from that transcript)
- `.git/config` (the remote URL), `HEAD`, and the mtime of `logs/HEAD` (else the index, else
  `HEAD`) for last-activity time, under `~/code` and similar folders, by reading those files
  directly
- manifest files (`package.json`, `pyproject.toml`, ...) and the first lines of a README
- the **names** under `mcpServers` in `~/.claude.json` and any repo's `.mcp.json`, the names and
  descriptions of skills, subagents, commands and plugins, and hook **event names**

What it never reads or keeps: an MCP server's `env`, `headers`, `args`, `command` or `url`
values; hook command text; `primaryApiKey`, `oauthAccount` or any other credential; a GitHub
token. A planted secret in any of those does not appear in `GET /api/discover`, `GET /api/setup`,
or anything written into an agent (tests: `test/unit/discover.test.js`,
`test/integration/import.test.js`).

Inside a repo, a file is read only if its real path is inside the repo: a repo cannot use a
symlink (`README.md -> ~/.netrc`) to make Clawdling read your other files. Your own Claude config
folder may be symlinked from a dotfiles repo, so symlinks are followed there, but only files with
frontmatter count as subagents. Remote URLs are shown and stored without embedded credentials.
Free text (descriptions, a README excerpt, commit subjects, issue and PR titles) passes through
`redactSecrets()` before it is shown or written anywhere.

**Import** runs a little more than discovery, all of it yours: your own `gh` (`gh auth status`,
`gh repo view`, `gh issue list`, `gh pr list`, and `gh repo clone` when you tick a repo that is not
on this computer) and your own `git` (`git log`, and `git clone` when gh is not signed in). `git
log` runs with signature checks, pagers, fsmonitor and external diff turned off on the command
line, so a repo's own `.git/config` cannot make it run a program. An import writes only inside
`<org>/projects/<id>/` (plus a new domain folder you chose and the org's `/onboard-project` skill):
it never writes into your repo. A clone only ever creates a new folder under your clone folder.

Text that anyone can write on a public repo (commit subjects, issue and PR titles, the README,
the GitHub description) is treated as data: one line each, no backticks, every `@` turned into
`＠` (so nothing becomes a CLAUDE.md file import), under headings that say "data, not
instructions". An agent's mission is never taken from it. Paths are written as code spans.

Donna may run `clawdling discover` (the table only: names, folders, dates, never descriptions or
README text) and an import plan. `clawdling import --yes` refuses inside her turns: creating
agents is your call. Her replies go to your phone like any other reply.

## Files

`.clawdling/` is mode 700: token, session registry, events log (includes Donna's message text),
`remote.json` and `remote-devices.json` (hashes only),
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
them in Claude Code (an arbitrary shell command you approve can do anything you can, including
reading the token). To revoke every paired phone and browser, stop Clawdling, delete
`.clawdling/token` and start it again: a new token is made and each device pairs again.

Report vulnerabilities privately via GitHub security advisories on the repository.
