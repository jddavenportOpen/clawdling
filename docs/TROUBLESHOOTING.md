# Troubleshooting

Back to the [README](../README.md).

Not a terminal person? [Start here](START-HERE.md#when-something-goes-wrong-plain-language-fixes)
has the same fixes in plain language, each one a sentence you can paste into Claude Code.

- **Claude says it cannot run commands or install software.** You pasted the line into a chat
  (claude.ai, or the desktop app's Chat tab). Use Claude Code: the desktop app's **Code** tab, or
  `claude` in a terminal.
- **`claude: command not found`, and you use the desktop app.** Expected: the app has Claude Code
  inside it but does not install the `claude` command. Install it with Anthropic's official
  installer (`curl -fsSL https://claude.ai/install.sh | bash` on macOS and Linux,
  `irm https://claude.ai/install.ps1 | iex` in Windows PowerShell; no admin rights, no Node), open
  a new terminal, check `claude --version`, and sign in once with `claude auth login`. It lands in
  `~/.local/bin`; if your terminal still cannot find it, see Anthropic's
  [Fix your PATH](https://code.claude.com/docs/en/troubleshoot-install).

`node ~/.clawdling-app/bin/clawdling.js doctor` (or `clawdling doctor`) checks everything below
and prints the fix for this computer. The cockpit and the CLI spell every command the way your
install runs it.

- **`clawdling: command not found`.** A by-hand install is not on your PATH: run
  `node ~/.clawdling-app/bin/clawdling.js <command>` (Windows: `node "$HOME\.clawdling-app\bin\clawdling.js"`),
  or run `npm link` once in `~/.clawdling-app`.
- **"Clawdling can't find the `claude` command"** (a banner in the cockpit). The server's PATH
  cannot see Claude Code, usually because it was started at login. Start it from a terminal where
  `which claude` (Windows: `where claude`) prints a path, or run `service install` from there.
- **"Claude Code isn't signed in yet."** Click **Sign in** on that session: a Sign in session
  opens and Claude Code walks you through its own sign-in in your browser. Then click **Start
  again** on the first session. (In a terminal, `claude auth login` does the same.)
- **Every agent asks whether to trust its folder.** Trust the org folder once: the cockpit's
  "Trust my org folder" button on first run, or `clawdling spawn scratch` and answer "Yes". Claude
  Code then notes that the folder pre-approves a few `clawdling` commands: the routing commands
  (ls, spawn, send, new, end), `discover` and `doctor`, and the read-only `remote list`,
  `remote serve-status` and `remote tailscale-name`. Sessions Clawdling starts also get the
  read-only `report`. That is Clawdling's allow-list ([SECURITY.md](SECURITY.md#agents)), nothing else.
- **Sessions ended when the cockpit stopped.** Without tmux that is expected: each one comes back
  under Recent, and Resume picks up the same conversation. Install tmux 3.2+ (macOS, Linux) to keep
  sessions running across restarts.
- **`npm install` failed building node-pty (Linux).** Install tmux (`sudo apt install tmux`), or
  the build tools node-pty needs (`sudo apt install build-essential python3`), then
  `npm install --omit=dev` again.
- **"port 4747 is already in use".** Another program (or another org's cockpit) has the port:
  `clawdling start --port 4800`.
- **Your phone cannot reach the cockpit.** It listens on 127.0.0.1 only. Turn on **Settings → Use
  from anywhere** (works from any network, see [REMOTE.md](REMOTE.md)), or on the same Wi-Fi restart it with `clawdling start
  --host 0.0.0.0` (the token is still required) and open Settings, Use Clawdling on your phone.
- **Use from anywhere says "Not reachable".** The computer may be asleep, offline, or signed out
  of Tailscale (`clawdling remote check` says why). "Public: Tailscale Funnel is on" or "Not
  behind Cloudflare Access" means Clawdling has stopped answering that address on purpose: turn
  Funnel off, or put Cloudflare Access back in front, then press Check again.
- **The phone says "Pair this device".** Each phone signs in once with a code from Settings, Use
  from anywhere, Add a device. Turning it off signs every device out; pair again after turning it
  back on.
- **Windows: hooks do not fire.** Clawdling needs Claude Code 2.1.139 or newer there: `claude update`.
