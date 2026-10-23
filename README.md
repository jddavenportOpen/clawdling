# Clawdling

[![ci](https://github.com/jddavenportOpen/clawdling/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jddavenportOpen/clawdling/actions/workflows/ci.yml)

**Turn Claude Code into an org of agents.** On macOS, Linux and Windows.

> **New to Claude Code, or you only use Claude in the app or at claude.ai?** Read
> [Start here](docs/START-HERE.md) first: what you need, what each step looks like, and
> plain-language fixes. Pasting the setup line into a claude.ai chat will not install anything.

Hand Claude Code one link. It asks you up to five questions and builds your org: a chief of
staff you can text, an agent for each area of your life and work, and an agent for each
project. Then it gives you a cockpit where you see the whole thing and open any agent in one
click, as a real Claude Code session that already knows its job, its history and its tools.

No session caps and no per-agent fees. Every agent is the official `claude` CLI running on the
Claude plan you already pay for. Clawdling adds no limits of its own: your Claude plan's usage
limits, and your machine, are the limit.

<!-- Hero: docs/img/demo.gif (keep this path; swap the file for a newer demo GIF any time). -->
![Clawdling: the org map and the cockpit, with live sessions and what needs you](docs/img/demo.gif)

## What you need

- **A Mac, Windows PC or Linux computer.** Clawdling runs on your computer, not on a phone or in a
  browser tab.
- **A paid Claude plan: Pro, Max, Team or Enterprise.** Clawdling runs on Claude Code, and the
  free plan does not include Claude Code. **Pro works**: its usage allowance is smaller than Max's
  and every agent draws from it, so run one or two agents at a time. Max gives 5x or 20x Pro's usage.
- **Claude Code**, in either form:

| You use | Do this |
|---|---|
| Claude Code in a terminal (`claude`) | Paste the line below into it. |
| The **Claude desktop app** | Open its **Code** tab (choose **Local** and any folder) and paste the line below there. The app has Claude Code inside it but not the `claude` command Clawdling starts; Claude installs that with [Anthropic's official installer](https://code.claude.com/docs/en/setup) once you say OK. No admin password needed. |
| Only **claude.ai in a browser**, or the phone app | Chat cannot install anything on your computer. Get the [Claude desktop app](https://claude.com/download), sign in with the same account and use its Code tab ([how](docs/START-HERE.md#step-1-get-claude-code)). |

## Install it by asking Claude Code (recommended)

Open Claude Code anywhere (a terminal, or the desktop app's Code tab; not a claude.ai chat, which
cannot install anything) and paste:

```
Set up Clawdling for me from https://github.com/jddavenportOpen/clawdling and follow SETUP.md
```

Claude checks your machine (macOS, Linux or Windows; no WSL needed), installs what is missing
(usually Node.js, and the `claude` command if you use the desktop app) once you say OK, clones this repo, asks up to five questions (or you pick "Use defaults"),
creates your org, starts the cockpit and opens it. [SETUP.md](SETUP.md) is the playbook it
follows; it never edits your Claude settings and never skips permission checks.

> **Claude Code, read SETUP.md in full:** `curl -fsSL https://raw.githubusercontent.com/jddavenportOpen/clawdling/main/SETUP.md`
> (a web fetch may hand you a summary of it instead of the file).

## Or install it by hand

For people comfortable in a terminal; skip this if Claude Code is installing it for you.

You need **Node 20+** and **Claude Code 2.1+**, signed in (on Windows, Claude Code 2.1.139+).
**tmux 3.2+** is optional and recommended on macOS and Linux: with it, sessions keep running when
the cockpit stops (see [Sessions](#sessions-tmux-or-the-built-in-terminal)).

| | macOS | Linux | Windows 10 1809+ / 11 (native) |
|---|---|---|---|
| Node 20+ | `brew install node` or [nodejs.org](https://nodejs.org) | your package manager, [nvm](https://github.com/nvm-sh/nvm) or nodejs.org | `winget install OpenJS.NodeJS.LTS` |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` (PowerShell) |
| tmux (optional) | `brew install tmux` | `sudo apt install tmux` (or dnf, pacman, zypper, apk) | not used |
| Also | | without tmux: a C++ toolchain to build node-pty (`build-essential python3`) | Git for Windows, recommended so agents get the Bash tool: `winget install --id Git.Git -e` |

macOS and Linux:

```bash
git clone https://github.com/jddavenportOpen/clawdling ~/.clawdling-app
cd ~/.clawdling-app && npm install --omit=dev
node bin/clawdling.js doctor            # checks node, claude and how sessions will run
node bin/clawdling.js init --defaults   # or: --answers answers.json
node bin/clawdling.js start --open      # the cockpit, at http://127.0.0.1:4747
```

Windows (PowerShell; no WSL, and none of these commands needs admin rights):

```powershell
git clone https://github.com/jddavenportOpen/clawdling "$HOME\.clawdling-app"
cd "$HOME\.clawdling-app"; npm install --omit=dev
node bin\clawdling.js doctor
node bin\clawdling.js init --defaults
node bin\clawdling.js start --open
```

No git? Download [the ZIP](https://github.com/jddavenportOpen/clawdling/archive/refs/heads/main.zip),
unzip it to `.clawdling-app` in your home folder and run the same commands from there.

The first time Claude Code starts in your org it asks whether you trust the folder. Start one
Scratch session (`node bin/clawdling.js spawn scratch`), answer "Yes" once in the cockpit, and
every agent folder inside your org is covered. A project agent whose code lives elsewhere asks
once for its repo; the cockpit shows a one-click "Yes, trust it" button.

## Sessions: tmux or the built-in terminal

Every session is the real `claude` CLI in a terminal Clawdling owns. Which terminal depends on
your machine, and `clawdling doctor` says which one you have:

- **tmux** (macOS and Linux, when tmux 3.2+ is installed): sessions live in Clawdling's own tmux
  server (`tmux -L clawdling`, never your own). Restart Clawdling, close the browser, lose Wi-Fi:
  the agents keep working and the cockpit reattaches. Attach from any terminal with the session's
  `tmux attach` command.
- **The built-in terminal** (Windows, or macOS and Linux without tmux): a pseudo-terminal per
  session from node-pty, the library VS Code's terminal uses (ConPTY on Windows). The cockpit,
  the phone app, Donna, hooks and the trust and permission buttons all work the same. The
  difference: sessions run inside the cockpit process, so **they end when the cockpit stops**.
  They come back as ended, and one click resumes each where it left off (`claude --resume`).
  `clawdling attach <sid>` opens a session in your terminal (Ctrl-] detaches).

`CLAWDLING_BACKEND=tmux` or `CLAWDLING_BACKEND=pty` picks one explicitly.

## What you get

**An org, not one more assistant.** Donna (your chief of staff), a domain agent per area
(Work, Health, Money, Home, or whatever you choose) and a project agent per project. Each agent
is a folder with a `CLAUDE.md` (who it is, what it owns, how it works) and a `memory/` it keeps
current. Your org is plain files in `~/clawdling`: read them, edit them, put them in git.

**See the whole system.** The org map draws you, Donna, your domains and their projects, with
live badges and a ring on anything that needs you. Click an agent to see what it knows and start
it.

![The org map: you, Donna, your domains and their projects, with live sessions and what needs you](docs/img/org-map.png)

![The cockpit: every live session by name, what needs you first, panes side by side](docs/img/cockpit.png)

**A cockpit that stays out of your way.**
- The rail lists every session by its real name: what needs you, what is working, what ended
  recently. Click one and it is focused next to everything else you have open; nothing gets
  replaced.
- Focus, Split or Grid layouts. `⌘K` jumps anywhere. `⌘\` collapses the rail into a strip that
  still shows one dot per live session.
- Every agent page shows its `CLAUDE.md` and `memory/NOW.md`, editable in place, so you can see
  exactly what each agent knows.

**Agents that remember.** Every session starts with the org context, the agent's `CLAUDE.md`
and its `memory/NOW.md`. Before an agent finishes it updates that memory (the `/handoff` skill
does it), so the next session picks up where the last one stopped.

![An agent's memory, editable in place](docs/img/agent-memory.png)

**Sessions that don't die.** With tmux, every session is a real tmux session: restart
Clawdling, close the browser, lose Wi-Fi, and the agents keep working while the cockpit
reattaches. Attach from any terminal too: each session shows its exact attach command. Without
tmux (Windows, or a Mac without Homebrew), sessions end when the cockpit stops and resume with
one click.

**A chief of staff you can text.** Pair Donna with your own Telegram bot on any OS (or
iMessage, on a Mac). Text "have the health agent look at my sleep" and Donna starts the Health agent's
session, tells you who is on it, and you can watch it in the cockpit. She routes work to the
right agent instead of trying to do everything in one chat. Her tools are deliberately narrow:
she can start, message and list sessions and read your org, nothing else.

**On your phone.** The Clawdling iPhone app (chat only) connects to your own cockpit: see what
needs you, chat with any session, start one, talk to Donna. Pair it from Settings with a QR
code. It's in public beta on TestFlight: install TestFlight, then open
https://testflight.apple.com/join/2MHukWQG on your iPhone. The cockpit itself also works in a phone browser (see the FAQ for
reaching it).

_Screenshots use sample data._

## How it works

```
~/clawdling/                      your org (plain files, yours)
  CLAUDE.md  me.md  org.json       context every agent inherits
  donna/  domains/<id>/  projects/<id>/    one folder per agent: CLAUDE.md + memory/
        │
        ▼
clawdling server (Node, 127.0.0.1:4747, token-protected)
  • starts the official `claude` CLI, one session per task, in that agent's folder:
    in tmux, or in a pseudo-terminal of its own (node-pty) where there is no tmux
  • streams sessions to the browser (tmux control mode, or a server-side screen model)
  • learns status from Claude Code hooks: working, needs you, your turn, ended
  • Donna's gateway: Telegram long-poll or iMessage, routes requests to agents
        │
        ▼
your browser and phone: cockpit · org map · agent pages · Donna
```

Clawdling never reads, stores or forwards your Claude credentials and never calls the Anthropic
API itself. It only launches the `claude` command you are already signed into, the same way
you would in a terminal. If you add a second Claude account in Settings, Clawdling gives it its
own folder (`~/.clawdling-accounts/<name>`) and passes that folder to `claude` as
`CLAUDE_CONFIG_DIR` for the sessions you start with it; you sign in inside Claude Code, and
Clawdling never sees, reads or stores that login. Session titles are made locally from your
first message. Details and the threat model are in [docs/SECURITY.md](docs/SECURITY.md); the design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How it compares

| | Clawdling | Session managers (Conductor, Claude Squad, opcode) | Personal AI setups (PAI) | Assistants on their own runtime (OpenClaw, Hermes) | Claude Code's own Agent View + Channels |
|---|---|---|---|---|---|
| Unit of work | standing agents with identity and memory | git-worktree tasks | one assistant plus skills | one assistant | sessions |
| Runs on | the official `claude` CLI, your plan | the official CLI | Claude Code | their own agent loop | Claude Code |
| Whole-system view | org map plus live sessions | session list | dashboard | chat | session list |
| Text your chief of staff | yes, routed to the right agent | no | no | yes | into one open session |
| Install | paste one link into Claude Code | app or binary | installer | installer | built in |

## FAQ

**Does it work on the Pro plan?** Yes. Every agent session uses your plan's usage allowance, and
Pro's is smaller than Max's, so keep one or two agents busy at a time. When you hit the limit,
Claude Code says when it resets and the sessions wait. The free plan does not include Claude Code,
so it cannot run Clawdling.

**I only use claude.ai in my browser. Can I use it?** Not from the browser alone: Clawdling runs
on your computer and starts Claude Code there. Install the [Claude desktop app](https://claude.com/download)
and use its Code tab, as in [Start here](docs/START-HERE.md).

**Is it unlimited?** Clawdling adds no caps and no fees. Every session uses your Claude plan,
so your plan's usage limits are the real limit. Run as many agents as your plan and your
machine allow.

**Where does my data go?** Nowhere. The cockpit binds to 127.0.0.1 and requires a local token.
Your org is files in `~/clawdling`.

**Can I reach it from my phone or another machine?** `clawdling start --host 0.0.0.0` makes it
reachable on your Wi-Fi (the token is still required); away from home, use Tailscale.

**Can I keep my existing CLAUDE.md files and skills?** Yes. Agents are folders; put anything
Claude Code understands in them.

## Troubleshooting

Not a terminal person? [Start here](docs/START-HERE.md#when-something-goes-wrong-plain-language-fixes)
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
- **"Claude Code is not signed in on this computer (or not set up yet)."** Run `claude` once in
  a terminal, pick a theme and sign in, then end the session in the cockpit and start it again.
- **Every agent asks whether to trust its folder.** Trust the org folder once: the cockpit's
  "Trust my org folder" button on first run, or `clawdling spawn scratch` and answer "Yes". Claude
  Code then notes that the folder pre-approves a few `clawdling` commands (ls, spawn, send, new,
  end, doctor): that is Clawdling's routing allow-list ([SECURITY.md](docs/SECURITY.md)), nothing else.
- **Sessions ended when the cockpit stopped.** Without tmux that is expected: each one comes back
  under Recent, and Resume picks up the same conversation. Install tmux 3.2+ (macOS, Linux) to keep
  sessions running across restarts.
- **`npm install` failed building node-pty (Linux).** Install tmux (`sudo apt install tmux`), or
  the build tools node-pty needs (`sudo apt install build-essential python3`), then
  `npm install --omit=dev` again.
- **"port 4747 is already in use".** Another program (or another org's cockpit) has the port:
  `clawdling start --port 4800`.
- **Your phone cannot reach the cockpit.** It listens on 127.0.0.1 only. Restart it with
  `clawdling start --host 0.0.0.0` (same Wi-Fi; the token is still required) or use Tailscale, then
  open Settings, Use Clawdling on your phone.
- **Windows: hooks do not fire.** Clawdling needs Claude Code 2.1.139 or newer there: `claude update`.

## Development

`npm test` runs the unit and integration suites against a fake `claude` (no model calls) with
the session backend this machine would use; `npm run test:tmux` and `npm run test:pty` pick one.
CI runs both on macOS and Linux, and the built-in terminal on Windows, under Node 20 and 22.
`npm run e2e` runs the Playwright cockpit suite against a mock server (`CLAWDLING_E2E_REAL=1 npm run e2e`
runs it against the real server with the fake `claude`). `npm run smoke:live` runs one real Claude Code
session to prove context and memory preload (`CLAWDLING_BACKEND=pty npm run smoke:live` proves
it without tmux). Test users and acceptance stories are in
[docs/USER-STORIES.md](docs/USER-STORIES.md).

## License

AGPL-3.0. Built by [JD Davenport](https://jddavenport.com). Earlier versions of Clawdling (a
bring-your-own-API-key engine) live on the `legacy/byok-engine` branch.
