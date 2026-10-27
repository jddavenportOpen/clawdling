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
- No telemetry of its own, no cloud service, no database server. (The opt-in detailed timeline,
  below, receives Claude Code's own telemetry, on `127.0.0.1` only, and keeps it on your computer.)

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
  Those headers can be written by anything that can open a connection to `127.0.0.1` (a
  container, another account on the computer), so the serve entry also forwards to a private
  path: `http://127.0.0.1:<port>/_clawdling/<32 characters>`, an HMAC of the address under the
  org's token, which only the serve config and this org know. `clawdling remote serve <url>` (run
  only when the owner approves it) points the serve entry at it itself, and it and `clawdling
  remote serve-status` print Tailscale's output with the path hidden, so it never appears in a
  terminal or an agent's transcript (a setup chat's guard refuses raw `tailscale serve` adds and
  status). A request through a Tailscale address without that path is refused
  before anything else, and the server strips it so the cockpit sees its normal paths. What lock
  1 admits, then, is the owner's own devices, including this computer: a process on any of them
  (another account on this Mac, a container) can open the address like the owner's browser does.
  Against those, lock 2 is the guard.
  Cloudflare: Cloudflare Access makes every visitor sign in (an email policy) before Cloudflare
  forwards anything; Clawdling then checks the `Cf-Access-Jwt-Assertion` header Access adds on
  every request (RS256, signed by the team's keys at `<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  the application's AUD tag, the team as issuer, not expired). A request without a valid one is
  refused, even for the sign-in page, so removing Access later cannot quietly expose the cockpit.
  If the keys cannot be fetched, requests are refused (fail closed). The owner's email is pinned
  (`clawdling remote add --email`, or the first pairing through the address) and every later
  request must carry exactly that email, so an Access policy that lets others in (one-time PINs
  for "Everyone", a team-wide app) still does not let them reach the cockpit.
- **Lock 2, a paired device.** Each device signs in once with a pairing link made in Settings on
  the computer itself: a random one-time code (192 bits), valid for 10 minutes, kept only in the
  server's memory and voided by a restart or by turning remote off. Opening the link shows a
  "Sign in this device" button; only that POST uses the code (so a link preview cannot burn it).
  The device then holds its own random credential (`cld_<id>_<secret>`, 256-bit secret) in a
  cookie named `__Host-cl_device` (host-only: since `ts.net` is a public suffix, every machine on
  a tailnet is the same site, and without the prefix another one could plant a cookie for the
  whole tailnet; an app on another port of the same host name still can replace it, which signs
  the phone out but never signs anything in) that is `Secure` (https only), `HttpOnly`
  (page scripts cannot read it) and
  `SameSite=Strict` (a link from another site opens the page signed out for one load, and the
  page's own same-origin calls carry it). Browsers send a cookie to every port of a host name,
  so another service on the same Tailscale name (say a NAS app on port 443) would receive it; the
  cookie alone therefore signs nothing in. The browser also holds a second random key in its own
  `localStorage`, which is scoped to this exact origin, port included, and sends it as a header
  (and as `k=` on the event stream and terminal sockets, which cannot send headers). The app
  holds a single device token instead and sends it as a header; it never uses the cookie. Each
  device works only through the address it paired through. It lasts 30 days.
  `remote-devices.json` stores only hashes. Each device can be signed out from Settings.
- **The long-lived token never leaves the computer.** Through a remote address the token is not
  accepted in any form (header, cookie, `/?t=` link, WebSocket `?t=`), the pairing QR codes and
  links never hold it, and `/api/pair` (which returns it) is refused. Things only the computer
  itself may do: make pairing links, add or remove addresses, turn remote on, stop the server, and
  post hook events. Turning it off works from anywhere.
- **Only through the door.** A remote name is answered only on a connection from this computer
  itself (the serve or tunnel process connects from `127.0.0.1`). With `--host 0.0.0.0`, a
  computer on the Wi-Fi sending a remote `Host` is refused.
- **Only its own scripts.** Remote pages are sent with a Content-Security-Policy whose
  `script-src` lists only the cockpit's own script paths (`/app.js`, `/components/`, `/lib/`,
  `/vendor/`) and the import map's hash, and whose `connect-src` is the address itself, so a
  script an edge adds to the page (for example Cloudflare's `/cdn-cgi/` features) does not run.
  The skill also has the owner turn those features off for the hostname.
- **Exact Host, https origin.** A remote request is matched on its exact `Host`, port included
  (`box.example.ts.net:8743` is not `box.example.ts.net`), against the registered addresses. A
  mutating request or WebSocket upgrade with an `Origin` must be exactly `https://<that address>`
  (every machine on a tailnet counts as the same "site" to a browser, so this check, not
  SameSite, is what stops cross-site requests between them).
  SSE and WebSockets go through the same checks as every API call. Remote responses carry
  `Strict-Transport-Security`.
- **Never public.** `clawdling remote add` checks an address before it is registered and leaves
  `remote.json` unchanged when the check fails. Tailscale: Funnel (Tailscale's public mode) must be
  off for that address (read with `tailscale serve status --json`, the only Tailscale command the
  server runs; the CLI's `remote serve` and `remote serve-status` run `serve --bg` and `serve
  status` on the owner's say-so; if Clawdling cannot read it, the address is not answered), no Tailscale TCP
  forward may land on the cockpit's port (a raw TCP connection carries whatever headers its
  sender writes, including a Tailscale login), and the address must reach this Clawdling (a
  one-time nonce through the address) with a Tailscale login on it. Cloudflare: the owner gives their Access team domain and
  application AUD tag at `remote add` (`--team-domain`, `--access-aud`), and a signed-out request
  must be redirected to exactly that team (and, when the link names one, that application). The
  pins come only from the owner and no check ever changes them: whoever controls the hostname
  could point its sign-in at their own Access team, whose identity provider could claim the
  owner's email, so a redirect to any other team or application stops the address and signs its
  devices out. A page that answers (any 2xx, or Clawdling's own refusal,
  marked with `X-Clawdling-Refused`) means the address is public, and it is refused. A first add
  needs that redirect: a bare 401/403 could be a firewall rule in front of a public page, so it
  only keeps an address that passed before. The cockpit must be the only thing on its address:
  a Tailscale address whose serve entry also has another handler (`--set-path`, another proxy)
  is not answered, since an app on the same origin could read the page's storage. The skill
  gives a Cloudflare hostname exactly one ingress rule with no `path:`; keep it that way. Later checks
  (Settings' Check again, `clawdling remote check`, and an automatic check every 10 minutes while
  it is on) apply the same rules: an address found public or unprotected is not answered until a
  check passes again, and every device paired through it is signed out (whatever reached it in
  the meantime may have seen a device's cookie and key). The Tailscale serve config itself is
  read every minute while it is on, so a Funnel, a TCP forward or another app added later is
  caught within a minute. Other local forwarders Clawdling cannot see (ngrok, socat) are out of
  its reach: do not point one at the cockpit's port. A request marked `Tailscale-Funnel-Request` is always refused.
- **Throttle.** Per remote address, signed-in Tailscale login or Access email, and source
  address (the tailnet IP Tailscale Serve reports, or Cloudflare's client IP), 10 failed sign-ins
  (a wrong device credential or pairing code) in 5 minutes make new attempts answer `429` for
  the rest of the window, so another device or process failing on purpose fills only its own
  bucket. A cookie whose key arrives only in a URL (`k=`, which any same-site page could add to
  an `<img>`) is refused without counting. A valid pairing code always pairs, even while its
  bucket is full: only failures are throttled. Paired
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
- **Removing one address** signs out every device paired through it. A Turn off that happens
  while an address is still being checked wins: the add is dropped, nothing turns back on.
- **`remote.json` integrity.** `.clawdling/remote.json` (mode 600) is re-read whenever it changes
  and validated strictly: https addresses with a DNS name and no path, a known kind and status,
  well-formed Access settings. Anything malformed turns remote off and says why in Settings; a
  change made outside the server closes remote connections within two seconds. Agents' file tools
  are denied in `.clawdling/`, so `clawdling remote ...` is the way to change it, and that command
  asks for permission inside a session (only the read-only `clawdling remote list`, `remote serve-status` and `remote tailscale-name`
are pre-approved). Donna's
  text-message turns cannot run `clawdling remote` at all.

**The setup agent.** "Set it up with an agent" starts an ordinary Claude Code session on the
owner's plan, at the org root, whose first message is the visible `/remote-access <path>`. The
skill is marked `disable-model-invocation`, so only that guarded chat runs it, never a chat that
merely mentions remote access. The skill's file is rewritten from this version's text when the server starts and before each such
session (an edited copy is kept as `SKILL.md.old`), so the sheet's promises hold, and a personal
skill or command named `remote-access` in the user's own Claude Code folder (which Claude Code
would run instead) blocks the setup chat until it is renamed. The owner runs `cloudflared tunnel
login` in their own terminal, so its sign-in link never reaches the agent. The
skill tells it to explain the plan, to ask before every install or change, and to leave every
sign-in to the owner in their browser. It never asks for, reads, prints or stores a credential
(no auth keys, no `cert.pem` or tunnel credentials file, nothing in `.clawdling/`), never turns on
Funnel, never runs `tailscale serve reset` or touches serve entries it did not create, never
restarts Clawdling with `--host`, and never registers a Cloudflare address before Access is in
front. Those "never" rules are also enforced in code: a setup chat runs with a PreToolUse hook
(`bin/clawdling-guard.js`, only in that session's `--settings`) that refuses turning Funnel on,
`serve reset`, TCP forwards, auth keys, `tailscale up/down/logout/login/set/switch`, `sudo`,
`cloudflared tunnel login`, `tailscale status` (it lists everyone on the tailnet: `clawdling
remote tailscale-name` prints only this computer's address), `clawdling spawn/send/new/end`, raw
`tailscale serve` adds and status (the CLI's redacted `remote
serve` and `remote serve-status` instead), and any access to `cert.pem`, `~/.cloudflared/` (but
its `config.yml`) or `.clawdling/`. In this one session it allows one command at a time (no chains or pipes), written plainly (no
quotes, escapes, variables, wildcards or redirects), only the setup steps' `cloudflared` commands
(never `tunnel token`, `tunnel run --token` or `access token/login`), and refuses the
scripts, interpreters and command runners it recognises, and handing work to another session; its
settings file sets `disableAllHooks: false`. It is a pattern guard, defence in depth for the case
where the session was fed other instructions (an edited `CLAUDE.md` or rule file), not a
sandbox: the session's own permission prompt, which the owner answers for every command, stays
the gate, and the server's checks hold even if an agent ignored the skill entirely.

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
  `report` (the read-only report card, since 1.5.1), `new`, `end`, `discover` and `import` (without
  `--yes`), reading files inside the org folder,
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
- Each turn's prompt also carries "today so far" from the report card (per agent: sessions with work
  done, with their titles and the agent's own last line, what waits on you, and the usage figure), so
  "what got done today?" is answered from the record. It goes only to your own Claude Code, in the
  turn, and its reply only to your own paired chat, like every Donna reply.
- Text messages are untrusted input to a model. The allow-list bounds what a confused or tricked
  Donna can do: start, message or end your own agents' sessions, which then run under Claude Code's
  normal permission prompts in the cockpit.
- The Telegram bot token lives in `.env` (mode 600). It is never logged, echoed by the API, or put
  in an error message.
- Neither `clawdling doctor` (which agents may run) nor `clawdling donna status` prints the pairing
  code: whoever sends it first is paired, so it is shown only in the cockpit.

## "An agent needs you" (1.4)

- **Off by default.** Turned on in Settings (`POST /api/notify`, which takes only `{needs_you}`),
  it sends one line when a session starts waiting on its owner, a few seconds later (an answer in
  the meantime sends nothing): "Clawdling: Health needs you (a question). Open the cockpit to answer."
- **No conversation in it.** The kind of wait is one of a fixed set of words; the question, the
  title, prompts and tool input are never used. The agent's name is the one shown in Settings when
  it was turned on (letters, digits, spaces and hyphens, 40 at most): an agent that renames itself
  later never reaches a message, and a new agent reads "An agent".
- **Only to the owner.** Telegram: only the chat that sent the pairing code (recorded in
  `.clawdling/telegram.json` at pairing; a new bot token drops it; pairings from before 1.4 pair once
  more). iMessage: only the handle saved in the cockpit, and only after a message from that exact
  handle (every digit) has been seen (`.clawdling/imessage.json`). org.json alone never decides,
  because agents can edit it; the switch and the send history are in `.clawdling/notify.json`.
- **Rate-limited, across restarts:** one per session per 10 minutes, six an hour in all.
- **Fail closed.** If the org folder's path has characters that Claude Code's file rules cannot
  express (so agents could not be kept out of `.clawdling/`), it stays off and Settings says why.
- The browser notification (also off until turned on) uses the same fixed words and approved
  names, so a lock screen never shows what was asked.

## The report card (1.5)

- **Read-only, local, no model call.** The report card and the Timeline are built from Claude Code's
  own transcripts (the session file and its `subagents/` files under `projects/`), the session
  registry, the agent's `memory/NOW.md` and `git log`. Nothing is summarized by a model and nothing
  leaves the computer. The cost is a list-price equivalent: Claude Code's own `cost-state` number
  when it is current, else the de-duplicated usage repriced with `server/prices.json`, which is
  bundled and dated (CI fails when it is more than 120 days old) and never fetched at runtime.
- **`git log` only, hardened.** One `git log --since=<window> --format=%H%x1f%s%x1f%cI -n 200` per
  repo of the agent (paths from OrgStore), arguments as an array through `execFile` (no shell), a
  5-second timeout, and `-c log.showSignature=false -c core.fsmonitor=false -c core.pager=cat`,
  `--no-show-signature`, `GIT_OPTIONAL_LOCKS=0`: a repo's own config cannot make it start a
  signature checker, a pager or an fsmonitor. `-c protocol.allow=never` plus
  `-c protocol.<ext|file|ssh|git|http|https>.allow=never` (a command-line value beats the repo's own)
  and `GIT_NO_LAZY_FETCH=1`: a partial clone whose config names a promisor remote cannot make it
  fetch, so it never starts a transport the repo chose. No diffs are read. Domain agents (no repo)
  run nothing. A commit is shown under a session only when that session ran a successful
  `git commit` within two minutes of it, and under one session at most.
- **Receipts.** `.clawdling/ledger/<sid>.json` (mode 600) keeps one small summary per session so the
  card stays honest after Claude Code deletes old transcripts: title, agent, times, counts of turns,
  tools, errors and files changed, the cost and its split by model and day, the agent's last line
  (160 characters) and the transcript path. No prompt, no file content, no file paths changed. 180
  days, 20 MB at most, oldest first.
- **API**: `GET /api/agents/:id/report`, `GET /api/org/report`, `GET /api/sessions/:sid/timeline`,
  with the same token, Host and remote-device rules as every route. `clawdling report` (read-only)
  is on the agents' allow-list, so the 1.7 CTO seat can read it.

## The Monday report (1.5)

- **Off by default**, turned on in Settings, which shows the exact text first. `POST /api/digest`
  takes `{enabled, day, hour}` only. Once per ISO week (counted before sending, so a failed send is
  not retried in a loop), at the chosen day and hour, or at the next start that week.
- **Counts, names and dollars only**: per agent, how many sessions got work done, how many need
  the owner and the usage over 7 days, plus the most and least used agents. **No session titles**
  (they are made from first prompts), no prompts, no file names. Agent names are the ones shown when
  it was turned on, cleaned like the needs-you ping's (an agent that renames itself, or a new one,
  reads "Another agent").
- **Same sender and rules as the needs-you ping**: only the Telegram chat that sent the pairing
  code or the proven iMessage handle (server-only state in `.clawdling/`), never decided by
  org.json; refused where agents cannot be kept out of `.clawdling/`. State: `.clawdling/digest.json`.

## The detailed timeline: `/otlp` (1.5, beta)

- **Off by default.** `POST /api/otel {enabled}` works only from the computer itself (refused
  through Use from anywhere, or from the Wi-Fi with `--host 0.0.0.0`). While it is on, each session
  that passes its own preflight at launch is started with its own `--settings` file
  (`.clawdling/run/<sid>.<random>.settings.json`, mode 600, removed when the session ends) holding Clawdling's
  hooks plus the OpenTelemetry block; the shared `.clawdling/hooks-settings.json` never carries it,
  and nothing is ever written into your Claude Code settings. Sessions pick a change up at their next
  start. The remote-access setup chat never gets it.
- **Never where you already have telemetry settings.** A preflight reads key **names** only, never
  values, from: Clawdling's own launch environment, your Claude Code `settings.json` (and each extra
  login's), the `.claude/settings.json` and `settings.local.json` of the org folder and of every
  agent's repo (a `--settings` env block would override those too), and the managed settings for
  your OS (with their `managed-settings.d/` folder; on macOS, a device-level or user-level
  configuration profile for Claude Code keeps it off too). Any of `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`, `DISABLE_TELEMETRY`,
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` or `otelHeadersHelper` keeps it off, so it never redirects
  your organization's telemetry or turns on what you turned off. Not checked: Windows registry
  policies (Clawdling does not read the registry) and settings an organization pushes from the
  Claude.ai admin console (Clawdling cannot see them). If your Claude Code is managed that way, leave
  the detailed timeline off.
- **The ingest** (`POST /otlp/v1/logs|metrics|traces` on the same server): loopback peer and
  loopback `Host` only; refused through every remote address (Tailscale, Cloudflare, paired
  devices), through a proxy, with a browser `Origin`, and while the switch is off. It needs the
  `x-clawdling-otlp` header: each session's own credential, `<session id>.<HMAC-SHA256 of it>` under
  a 32-byte secret made when you turn it on and forgotten when you turn it off (`.clawdling/otel.json`,
  mode 600), checked in constant time. The credential is put in that session's own environment at
  launch (Clawdling's shared settings file carries no header), and only records for that session are
  kept, so one session cannot write another's. JSON only, 1 MB, at most 50 requests a second per
  session, at most 4 uploads in flight, each within 10 seconds; at most 5,000 records a request; a
  malformed payload gets a 400 and is not logged. The preflight runs again before every launch and
  resume, so a setting you add later keeps new sessions out. Where agents cannot be kept out of
  `.clawdling/` (an org path with characters like `( ) '` or accents), it stays off.
- **What is kept**: `.clawdling/traces/<sid>.jsonl` (mode 600), 14 days (enforced hourly, record by
  record), 50 MB in all. The content
  gates (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`) stay unset, so
  Claude Code sends prompts and responses as "<REDACTED>"; Clawdling drops those attributes anyway,
  with `user.id`, `user.email`, `user.account_uuid`, `organization.id` and any `*.prompt`,
  `*.content` or `*.response`.
- **Known limit**: a session's credential is in its environment, and a shell command you approve
  runs as you: it can read that environment, other sessions' environments (`ps eww`,
  `/proc/<pid>/environ`) or `.clawdling/otel.json`, and post made-up telemetry for those sessions.
  That can only change what your own Timeline shows (a wrong "approved by" label); it reaches
  nothing else, and an approved arbitrary command can do far more than that already (see Not in
  scope).

## Verified done (1.6)

Three parts, cheapest first. The first uses no model and runs nothing; the second runs commands
you approved; the third spends your plan, capped.

### Claim receipts: read-only, no model

When an agent's final message says it is done ("fixed", "tests pass", "builds"), Clawdling reads
the session's own transcript and labels the claim **Verified** (a check ran after the last file
change and passed), **Contradicted** (one ran and failed), **Not verified** (none ran: the default)
or **No changes made**. The claim patterns are a tested list of English phrases
(`server/claims-patterns.json`); the checks are the project's approved ship-check commands, the
commands found in its manifests, and a short generic list (`npm test`, `pytest`, `go test`...).
"The last change" is the last edit to a file in the session's folder (the agent's memory notes do
not count) or the last shell command that writes files. Nothing is executed and no model is called:
a model deciding "is this really done" would be one more claim. Only a plain run of a check (one
command, harmless flags, its exit code visible) can verify or contradict; a declined or
hook-blocked command is not a check, and any other command line that shows a failure (piped,
chained, `|| true`, only some tests) keeps the claim Not verified. Receipts keep the
command line and the first error line of a check, never its output. "Ask the agent to fix it" sends
one fixed message, shown first, and the server checks that what it sends is still the text shown.

### The ship check: commands you approve, in a scratch copy

**What it runs.** The commands you ticked in the Check-up tab, for one project repo, through the
platform shell (`/bin/sh -c` on macOS and Linux, PowerShell on Windows), one after the other, each
with a timeout that ends its whole process tree. Optional setup commands (`npm ci`, `pip install`)
run first, but only when you ticked them: they usually download code from the internet, and the
cockpit says so next to them.

**It runs your project's own scripts, as you.** `npm test` runs whatever the repo's `package.json`
says `test` is, today. A script's contents can change without the command line changing, so
approve ship checks only for projects you trust; the cockpit says this next to the approve button.
To limit the damage a hostile script could do:

- **The approval model.** Nothing runs until you approve the list. The cockpit proposes commands
  detected from the repo, each shown exactly with what it does (the script's own text, from
  `package.json`, or the target's recipe lines). The approve request must echo the exact command
  strings shown, or it is refused; a command with control or invisible characters (bidi overrides,
  zero-width) is refused, so what you tick is what the shell runs. The list is written to
  `<agent folder>/checks.yaml`, and a fingerprint of it (commands, names, timeouts and the repo's
  real path) to `.clawdling/checks/<agent>/approved.json`, which agents' file tools are denied.
  Agents can edit their own folder, so a run starts only when
  `checks.yaml` still matches that fingerprint: any change, by anyone, needs your approval again,
  and so does pointing the agent at another repo.
- **Never the live repo.** `git stash create` snapshots the tracked files, uncommitted changes
  included, as a commit object without changing your files or what is staged (git may refresh the
  index's cached file times); `git worktree add --detach` puts that snapshot in a scratch folder
  under the system temp folder; the checks run there, in the agent's repo folder (a monorepo's
  `apps/web`, not its top); the worktree is removed with `git worktree remove --force` (never `git
  worktree prune`, which would also drop records of your own worktrees on an unplugged drive).
  Untracked files are not copied (they can be secrets or build junk), submodules are checked out
  empty and filtered files (LFS, encryption) stay as git stores them; the cockpit says so, and a run
  that left any of these out is shown with the counts and does not count for claim receipts. The
  worktree is made without its checkout, then checked out with every filter named in the repo's
  config or the worktree's (an `includeIf "gitdir:"` can apply only there) switched off, inside a
  private (0700) temp folder. Every
  git call carries `core.hooksPath` pointed at an empty folder, `core.fsmonitor=false`, every
  clean/smudge/process filter named in the git config switched off (LFS included),
  `protocol.allow=never` and `GIT_NO_LAZY_FETCH=1`, so the repo's own config cannot make git run a
  program or fetch. The scratch worktree still shares the repo's object store, branches and config:
  a check's own script that runs `git config` or `git stash` acts on the live repo, as it would if
  you ran it yourself.
- **A scrubbed environment.** The checks get Clawdling's child environment without the variables a
  parent Claude Code session sets, without anything that looks like a credential (names with
  `TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `PWD`, `DSN`, `KEY`, `API_KEY`, `AUTH`...; `ANTHROPIC_*`,
  `AWS_*`, `GH_*`, `GITHUB_*`, `SSH_AUTH_SOCK`, `CLAUDE_CONFIG_DIR` and similar; any value that is a
  URL with a password in it), without any variable named in the org's `.env`,
  and with `CI=true` so test runners run once instead of watching.
- **Bounded.** A step is over when its shell exits (a background child holding the output open
  gets half a second). On macOS and Linux anything the step left running in its process group is
  then ended; on Windows a process the step started and left running is not ended (a known gap).
  One ship check per org at a time; output capped at 256 KB per command, of which the last 40 lines
  are kept, for 90 days, in `.clawdling/checks/<agent>/`. Scratch worktrees in use are
  listed in `.clawdling/checks/active.json`, and Clawdling removes any a crash left behind when it
  starts.
- **One way.** A ship check's pass can verify a claim the session left unchecked; its failure only
  keeps claims Not verified. The copy has no `.env` and a scrubbed environment, so a failure there
  may be the copy's, not the work's: it never marks a claim Contradicted or sends the agent after it.
- **The shell itself.** On Windows the steps run through PowerShell by its full path
  (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`), so a `powershell.exe`
  committed to the repo is never run instead.
- **Never automatic.** A ship check runs only when you press Run (or run `clawdling check`); it never
  runs on its own when a session ends.

### Agent check-ups: your plan, a scratch copy, a cap

- **Only the official CLI.** Drafting the cases, each run and each judge vote are `claude -p` calls
  to the `claude` you are signed into, on your plan (Anthropic's support article allows `claude -p`
  on a subscription). Clawdling never calls the Anthropic API and never reads a credential. Every
  call passes `--no-session-persistence`, `--strict-mcp-config` (no MCP server starts) and a
  `--settings` file with `disableAllHooks`, so your own hooks and MCP servers do not run inside a
  check-up. The run's `claude` loads your user settings (your sign-in, default model and deny rules)
  but not the scratch copy's project or local settings (`--setting-sources user`): the agent can
  edit those, and print mode shows no trust dialog. Its environment has no Clawdling variables,
  nothing from the org `.env` and nothing credential-looking, except what the CLI itself may sign in
  with (`ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, and the AWS and Google Cloud variables
  Bedrock and Vertex use). A check-up has no tool that can read its environment.
- **Drafting** is one call with no tools (`--tools ""`), a JSON schema and `--max-budget-usd 0.50`,
  given the agent's CLAUDE.md, NOW.md, the end of LOG.md and the org's me.md. It writes the cases
  unapproved; nothing runs until you have read them.
- **The cases you approved, as written.** Like `checks.yaml`, each case's files are fingerprinted
  in `.clawdling/evals/<agent>/approved.json` when you approve or save them in the cockpit; a case
  changed on disk (by the agent, say) does not run until you approve it again. A project agent's
  cases are approved for its repo, by real path: an agent that points its `agent.json` at another
  repo runs nothing until you approve again.
- **The sandbox.** Each run copies the agent folder into a scratch folder under the temp folder,
  without `evals/` (so the agent cannot read its own test), `.env` files, links,
  `node_modules` and `.git` (a project agent also gets a detached worktree of its repo at HEAD).
  The run gets the context a real session gets (the org rules, the agent's CLAUDE.md and NOW.md, and
  a repo agent's repo CLAUDE.md/AGENTS.md), as text read only from plain files (a link committed to
  the repo, say `AGENTS.md -> ~/.aws/credentials`, is not followed), and runs in that copy with `--permission-mode default`. Its tools are read-only (Read,
  Glob, Grep, LS): no Bash and no write tools in 1.6, because a command pattern such as
  `Bash(npm test:*)` cannot be made safe here (allow rules merge from every settings layer, and
  `git`, `npx` or `/bin/sh` run anything). Your test commands run in the ship check instead. In
  print mode anything not allowed is denied, not asked. Reading outside the copy is denied by Claude
  Code's own rules, unless your own user settings allow it (as they would in a live session), and
  the live agent's `evals/` folder and Clawdling's `.clawdling/` are denied
  even by absolute path, by path and by real path; if a rule cannot name one of those folders (a
  path with characters Claude Code rules cannot express), the check-up refuses to run. The copy is
  removed after each run, and on start if a crash left one.
- **Links.** Clawdling reads and writes check-ups only in real folders: a link at `evals/`, at a
  case folder or at `graders/` is refused, never listed, written into or deleted through. Results
  are kept in `.clawdling/evals/<agent>/results/`, out of the agent's reach, so an agent cannot
  forge a score.
- **The judge** has no tools, gets only the criterion and the answer (between two random markers,
  with an instruction to treat the answer as data), answers through a JSON schema, and votes three
  times; a case passes on two of three. A steered judge can only mis-score, never act. Before any
  agent run, the judge also grades an empty answer (it must fail) and each case's `reference.md`
  (it must pass); if either goes wrong, or any judge call fails, the suite shows "judge unreliable"
  and no agent run is spent. `regex` graders run in a separate V8 context with a one-second
  deadline, so a pattern that backtracks badly fails its grader instead of stalling Clawdling.
- **Plan burn.** The cost is estimated and shown before every run ("This starts N Claude Code runs on
  your plan, about $X, capped at $Y"); the cap (default $2.00, list-price equivalent) is checked
  before each launch, and each run carries `--max-budget-usd` with what is left (never more). A run
  or judge vote that ends without reporting its cost (a timeout, a crash) counts as its whole
  budget, so the cap holds even when costs are unknown. Claude Code stops a run after the model call
  that crosses its budget, so the last run can end above the cap by part of one call. One run per case
  by default, one check-up per org at a time, never scheduled.
- **Try a cheaper model** runs the same cases with other `--model` and `--effort` values. "Use this"
  writes the agent's default model and effort to its own `agent.json` (Clawdling's config); it never
  touches your Claude Code settings.

### Who can start them

Approving commands, running a ship check, drafting, editing and approving cases, running a
check-up and "Use this" work only from the computer Clawdling runs on (`403` through a remote
address, like turning on the detailed timeline; served on a LAN address with `--host`, the token
alone is not enough: the request must come from the computer itself). A paired phone can read the results and use "Ask
the agent to fix it", which only sends the shown message into a session it could already type into.
Donna's text-message turns cannot run `clawdling check` or `clawdling checkup`.

## The CTO seat (1.7)

The CTO is a normal interactive Claude Code session on your plan, in `<org>/cto/`. It reads one
thing, `clawdling report --all --json`, writes one thing, its own `reviews/`, and asks you before
any message reaches another agent. Its status labels are computed by Clawdling, not by the model.

### What it may run: allow, ask, deny

`ctoPermissions` (`server/org.js`) builds the lists from `templates/cto/settings.json`. For an org
in `/home/lou/org` (paths are absolute-path rules, `//` plus the path):

| List | Rules |
|---|---|
| **allow** | `Bash(clawdling report --all --json --window 7d)`, `Bash(clawdling report --all --json)`, `Bash(clawdling ls --json)`, `Bash(clawdling ls)` (exact commands, no wildcard), `Read(//home/lou/org/cto/**)`, `Write(//home/lou/org/cto/reviews/*.md)`, `Edit(//home/lou/org/cto/reviews/*.md)` |
| **ask** | `Bash(clawdling send *)`, `Bash(clawdling spawn *)` |
| **deny** | `WebFetch`, `WebSearch`, `Write(//home/lou/org/cto/CLAUDE.md)`, `Edit(//home/lou/org/cto/CLAUDE.md)`, `Write(//home/lou/org/cto/.claude/**)`, `Edit(//home/lou/org/cto/.claude/**)`, `Read(//home/lou/org/.clawdling/**)`, `Edit(//home/lou/org/.clawdling/**)` |

On Windows each `Bash(...)` rule in allow and ask also comes as the same `PowerShell(...)` rule
(the agent's shell may be PowerShell), and paths are matched in POSIX form (`C:\Users\lou\org` is
`//c/Users/lou/org`). If the org's path has characters Claude Code's rules cannot express (like
`( ) '` or accents), Clawdling neither adds nor starts a CTO there: it fails closed, like the
needs-you ping, rather than run the seat without its file rules.

No command rule has a wildcard: options such as `--home` (read another folder's server address and
token) or `--port` (send the owner token to another local port) can never ride along on an allowed
command. The seat's allow-list is narrower than every other agent's: `clawdling new`, `end`,
`doctor`, `discover`, `send`, `spawn` and the remote commands are not on it.

**Why ask rules, not just "not allowed".** In Claude Code an ask rule beats an allow rule from any
settings layer. A command merely missing from the seat's allow-list could still run without a
prompt if an allow rule in another layer matched it (a file like the org's `.claude/settings.json`,
which pre-approves `clawdling send` and `spawn` for every other agent). With `clawdling send *` and
`clawdling spawn *` as ask rules, a cross-agent message shows Claude Code's own prompt with the
exact command. The rules match those words at the start of a command, so a second check covers
every other spelling.

**The seat's own check (its PreToolUse hook).** The seat's PreToolUse hook runs with an extra
argument, `cto`, and answers before Claude Code's permission rules (`server/seat-policy.js`). A hook
answer of "ask" makes Claude Code ask whatever allow rules exist; "allow" lets the call through. It
answers:

- **allow** for one plain read its template uses, with only these options in any order:
  `report --all [--json] [--window 7d]` (the whole-org report, whose agent-written text is cleaned)
  and `ls [--all] [--json]` (no other option, no per-agent report, no pipes, lists, redirection,
  substitution, quotes or line breaks);
- **ask** for any command that runs clawdling's `send` or `spawn` in any spelling (the shim,
  `clawdling.cmd`, `clawdling.ps1`, the script by path, inside `sh -c` or after `&&`), with the
  reason "the CTO wants to message another agent";
- **ask** for every other Bash or PowerShell command;
- **ask** for any Write, Edit, MultiEdit or NotebookEdit other than `<org>/cto/reviews/<YYYY-Www>.md`
  itself, for this ISO week or last week (no other name, no subfolder, no week in the future, which
  would sort as "the latest review"; the CTO page also ignores a future week);
- **ask** for a tool call it cannot read (no tool name, unreadable input), even with no session.

So the seat runs exactly two things without a prompt, the report and the session list, and writes
only its weekly review file; everything else shows Claude Code's own prompt, every time. On a
cross-agent prompt Claude Code then offers only Yes and No (seen on 2.1.308), never "don't ask
again".

**One-tap answers only for one plain message.** In the cockpit, the CTO's prompts get Yes and No
buttons only when the prompt is for exactly one plain `clawdling send|spawn` message (below). Any
other prompt from the seat (another command, a file outside its reviews, a message in an unusual
spelling) shows what it is, with the command when it is a shell command, and is answered in the
terminal ("Show the terminal"). The hook prints its answer first, even when the Clawdling server is not running. If the hook
cannot run at all, the exact allow rules, the ask rules and the ask-first mode still apply.

**It takes instructions from you only, and its words go only to you.** The `clawdling` CLI, which
every other agent and Donna may run without a prompt, talks to the server with the token in a
header; the cockpit uses its cookie, a paired device its own key. With the CLI's header, the server
refuses (`403`) to add the seat, start or change its schedule, start a CTO session, type into one,
answer its prompts, restart, resume, rename, re-model or end it, attach to its terminal, or read its
transcript, Timeline, claims or report; and it hands out CTO sessions without what the CTO wrote or
is asking (last message, notification, question, choices, pending command). Donna's "today so far"
leaves the CTO out. Every other agent's settings (and Donna's) deny reading and writing anywhere in
`<org>/cto/`. So no agent and not Donna can start the CTO, put words in front of it, press Yes for
it, plant files in its folder, or take its words as their own instructions. (This tells the CLI
apart from the cockpit; anyone who holds the token itself, by a command you approved, is you.)

### How it starts

- **Its own settings file, out of agents' reach.** Every start writes
  `.clawdling/cto-launch-settings.json` (mode 600) and passes it as `--settings`: Clawdling's hooks,
  `disableAllHooks: false` (no other layer can switch its hooks off), and the lists above.
  `.clawdling/` is denied to agents' file tools, so the seat cannot edit what it starts with. The
  folder's `.claude/settings.json` holds the same lists for you to read; at every server start and
  every seat start it is rewritten from this version's template if it differs (an edited copy is
  kept as `settings.json.old`, never written through a link), and the seat is denied writing
  anywhere in its `.claude/`.
- **Its folder holds only what Clawdling wrote.** A start is refused (`409`, saying what it found)
  when the seat's folder, its `reviews/` or its `.claude/` is a link, or when `.claude/` holds
  anything but `settings.json` (and its `.old`): no skills, commands, subagents or local settings
  can load into it. Its CLAUDE.md does not import its memory files.
- **`--setting-sources project`**: neither your user-level Claude Code settings nor the seat
  folder's `settings.local.json` load into it (their allow rules, hooks, environment, default model;
  a saved "don't ask again" has no effect). Managed (policy) settings still apply, as Claude Code
  always applies them.
- **`--strict-mcp-config`** with no MCP config: no MCP server starts in it.
- **Always ask first.** The seat starts in Claude Code's ask-before-editing mode
  (`--permission-mode manual`, or `default`), whatever its `agent.json` says, at every start and
  resume; it is never started in bypass or auto mode.
- **No `--add-dir` of the org folder.** Other agents can read the org folder; the seat reads the
  report instead, and reading other agents' folders asks.
- It gets the org's context file like any agent, and no skills.

### What its hooks forward

The seat's hooks report every tool call (PreToolUse and PostToolUse with no matcher) so the cockpit
can show what a prompt is for. The hook script (`bin/clawdling-hook.js`) forwards only the tool's
name and its call id (100 characters each), and for the seat the command of each Bash or PowerShell
call (4,001 characters at most). No file path or other tool input leaves the hook, and an ordinary
session's hooks never see a shell call. The server keeps that command until any other tool call, the matching
PostToolUse, the end of the turn or a new prompt, and shows it only while the session waits on a
permission prompt (Claude Code runs a command on its own: its hook, then its prompt, then the call,
so the prompt on screen belongs to the newest tool call). Only exactly one
`clawdling send|spawn [options] <target> "<message>"` counts as a plain message: a session or agent
id, only the CLI's own options with plain values, the message in quotes with nothing a shell would
expand, and not starting with `-` (the CLI would read it as an option). Through PowerShell, any
backslash, quote (curly ones too), backtick or `$` in the message makes it not plain. The parsers are
built so a long run of options cannot make them backtrack without end, and every command is capped
at 4,001 characters before it is matched. For anything else (more than one command, a `$` or backtick in the message, a cut at 4,000
characters) the cockpit shows the command, says to read it in the terminal, and offers no one-tap
Yes: you answer it in the terminal. Apart from the seat's own check (above),
the hooks decide nothing: the prompt, and the answer to it, are Claude Code's own.

### Prompt injection through the report

Session titles, the agents' last lines, NOW.md and claim badges are written by agents, and an agent
can be steered by what it reads. A hostile title could try to steer the CTO. Mitigations:

- The report carries no file contents and no prompts; every agent-written string is capped, made
  one line, stripped of control, bidi and zero-width characters, and cannot look like a citation
  (`[R-` and receipt-shaped ids are broken up), so it cannot plant a fake receipt. The report's `note` and the CTO's CLAUDE.md
  both say to treat that text as data, never as instructions.
- The CTO has no web, no MCP servers, and can write only its own reviews without asking. Nothing it
  writes reaches another agent or Donna except a message you said yes to (see "It takes instructions
  from you only, and its words go only to you").
- Two files reach the CTO as instructions, not as report data: the org's `CLAUDE.md` (which every
  agent loads from the parent folder) and `me.md` (in every agent's context). They are your files,
  and agents can edit them in ask-first mode only with your yes. Treat them as trusted inputs you
  own: anything steered through them still meets the seat's own check and your yes on every message.
- A message to another agent always shows Claude Code's prompt with the exact text; the receiving
  agent then runs under its own permission mode.
- It cannot fake a status: labels are computed, a changed label is shown as an override beside
  Clawdling's own, and the lint marks uncited lines and ids that do not exist.
- The review page renders the review as text, never HTML, and every link comes from Clawdling's
  receipt index, not from the review.
- The worst a steered CTO can do unasked is write a misleading review, which shows its citations,
  and ask you for things you can refuse.

### Deliveries and decisions on the review page

Whether a message was sent, declined, failed or is waiting, and what you answered on a decision
card, are read from the seat's own Claude Code transcripts (`scanTranscript`), not from what the
model wrote: "declined" only for Claude Code's own rejection text at the start of an error result.
A send or spawn written as its own command (in any case, after options, across continued lines) is
listed under "Messages to agents"; every other shell command the CTO asked to run, including a send
in a spelling the page cannot read as one, is listed under "Other commands it asked to run", with
whether you said yes. A message that is not one plain message is listed as its whole command, never
as an extracted text the agent may not have received. Final states are also
kept per week in `.clawdling/cto/activity/<week>.json`, written when a CTO turn ends (Stop,
StopFailure, SessionEnd, or a "No" that stops it, whether answered in the cockpit or typed in the
terminal: the typed digit of a No choice, or Esc; only Claude Code's own "⎿ Interrupted" line counts) and whenever the page is read, so the record outlives the sessions and their transcripts. Review sessions are
marked by the server when it starts them, not by their title.
The CTO also notes a declined message in the review (`Declined: ...`) when it can (a "No" in
Claude Code 2.1.308 often stops its turn), but the page does not depend on it.

### The schedule

- **Off by default.** Settings shows the estimated cost of one review before you turn it on.
- **Once per ISO week** at the day and hour you pick (Monday 08:00 by default), or at the next start
  that week; the week is counted before the run starts, so a failure never retries. Turned on after
  this week's time, the first run is next week.
- **A weekly cap** (default $2.00, list-price equivalent): before a run, the CTO's spend this ISO
  week from its receipts plus the high end of the estimate must fit under it, or the week is skipped
  once, with a notice on the CTO page and in Settings. If the spend cannot be fully counted, the week
  is skipped too. The cap governs the schedule only; a review or chat you start yourself is yours.
- It starts the same seat with the same settings; it can only start a review, never anything else.
  It reads the schedule again after building the estimate, so turning it off (or lowering the cap)
  while a check is under way wins.

### The Monday report line

Off by default and separate from the Monday report's own switch; Settings shows the exact line
first. When on, the Monday report adds one line, `CTO, week <N>: <headline>. N decisions waiting in
Clawdling.`, from this week's or last week's review only: one line, 160 characters, any `scheme:`
link replaced by `[link removed]`, every dot-like character inside a word (`.`, and the full-width
and ideographic ones) turned into a one-dot leader so no chat app makes a domain or address
tappable, the `@`, `/` or `#` in front of a word dropped (no Telegram user, bot command or tag), a
phone-number-like run of seven or more digits replaced by `[number removed]`, invisible characters
and `<` `>` dropped.
Nothing else from a review leaves the computer, and it goes through the Monday report's sender and
rules.

### From a paired device

A phone or browser paired through Use from anywhere can read the CTO page and its reviews
(`GET /api/cto`, `/api/cto/reviews/:week`, `/api/cto/estimate`, `/api/report/all`), and, like any
session, open the CTO's chat, answer its decision cards and say yes or no to its messages (it is
your device). Adding
the seat, the "Run this week's review" button and every CTO setting (the schedule, the cap, the
thresholds, the Monday line) work only from the computer Clawdling runs on (`403` through a remote
address; on a LAN address with `--host` the token alone is not enough). Starting a chat with the CTO
is open to a paired device like any agent's session, and closed to the CLI (see above).

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
hook spool, launcher scripts (include first prompts), generated context files, `notify.json`,
and since 1.5 `ledger/` (session summaries), `digest.json`, `otel.json` and `traces/`, and since 1.6
`checks/` (approval fingerprints, ship-check results, the scratch worktrees in use) and `evals/`
(case approvals, the scratch copies in use), and since 1.7 `cto.json` (the CTO's schedule),
`cto/receipts/` (the weekly receipt index) and `cto-launch-settings.json` (see above). An agent's
`checks.yaml` and `evals/` (cases and results) live in its own folder; the CTO's reviews live in
`<org>/cto/reviews/`.
Transcripts are Claude Code's own (`~/.claude/projects/`); Clawdling reads them for the chat view,
question cards and Watching, and never writes them. For a plan card (since 1.5.1) it also reads
Claude Code's plan file, `<config folder>/plans/<name>.md`, the one the session wrote: only a `.md`
file whose real path is in that `plans` folder. For Watching it also reads Claude Code's
per-process records, `~/.claude/sessions/<pid>.json`: only files with that name, only five fields
(`sessionId`, `startedAt`, `status`, `statusUpdatedAt`, `version`); never anything else in that
folder. Hooks: besides the lifecycle events, PreToolUse and PostToolUse are registered for
`AskUserQuestion|ExitPlanMode` only, and forward those two tools' input (the question or plan) to
the local server; they never decide anything, except the CTO seat's PreToolUse (1.7), which can
only make Claude Code ask (never allow). The seat registers them for every tool, and forwards only
each tool's name and id, plus the command of a `clawdling send|spawn` (see above).

## Tests

With `CLAWDLING_TEST=1` the server refuses to start with the default tmux socket or the real
`claude`, never calls the official Telegram API, and never runs the real `osascript` or reads the
real Messages database. Tests use a fake `claude`, a stub Bot API, a fixture `chat.db` and a stub
`osascript`.

## Not in scope

Malware running as your user (it can read the token file, as it could read anything else you own);
anyone you give the token or the pairing QR code to; what your agents do with permissions you grant
them in Claude Code (an arbitrary shell command you approve can do anything you can, including
reading the token). To sign out every device paired through Use from anywhere, press Turn off
(or run `clawdling remote off`). To revoke every phone and browser paired on the same Wi-Fi with
the token link or QR code, stop Clawdling, delete `.clawdling/token` and start it again: a new
token is made and each one pairs again.

Report vulnerabilities privately via GitHub security advisories on the repository.
