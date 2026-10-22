# Clawdling

**Turn Claude Code into an org of agents.**

Hand Claude Code one link. It asks you up to five questions and builds your org: a chief of
staff you can text, an agent for each area of your life and work, and an agent for each
project. Then it gives you a cockpit where you see the whole thing and open any agent in one
click, as a real Claude Code session that already knows its job, its history and its tools.

No session caps and no per-agent fees. Every agent is the official `claude` CLI running on the
Claude plan you already pay for, so your plan's own usage limits are the only limit.

![The cockpit: every live session by name, what needs you first, panes side by side](docs/img/cockpit.png)

## Install it by asking Claude Code (recommended)

Open Claude Code anywhere and paste:

```
Set up Clawdling for me from https://github.com/jddavenportOpen/clawdling and follow SETUP.md
```

Claude checks your machine, clones this repo, asks up to five questions (or you pick "Use
defaults"), creates your org, starts the cockpit and opens it. [SETUP.md](SETUP.md) is the
playbook it follows; it never edits your Claude settings and never skips permission checks.

## Or install it by hand

You need **Node 20+**, **tmux 3.2+** and **Claude Code 2.1+**, signed in. macOS and Linux
(Windows through WSL).

```bash
git clone https://github.com/jddavenportOpen/clawdling ~/.clawdling-app
cd ~/.clawdling-app && npm install --omit=dev
node bin/clawdling.js doctor            # checks node, tmux and claude
node bin/clawdling.js init --defaults   # or: --answers answers.json
node bin/clawdling.js start --open      # the cockpit, at http://127.0.0.1:4747
```

The first time Claude Code starts in your org it asks whether you trust the folder. Start one
Scratch session (`node bin/clawdling.js spawn scratch`), answer "Yes" once in the cockpit, and
every agent folder inside is covered.

## What you get

**An org, not one more assistant.** Donna (your chief of staff), a domain agent per area
(Work, Health, Money, Home, or whatever you choose) and a project agent per project. Each agent
is a folder with a `CLAUDE.md` (who it is, what it owns, how it works) and a `memory/` it keeps
current. Your org is plain files in `~/clawdling`: read them, edit them, put them in git.

**See the whole system.** The org map draws you, Donna, your domains and their projects, with
live badges and a ring on anything that needs you. Click an agent to see what it knows and start
it.

![The org map](docs/img/org-map.png)

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

**Sessions that don't die.** Every session is a real tmux session. Restart Clawdling, close the
browser, lose Wi-Fi: the agents keep working and the cockpit reattaches. Attach from any
terminal too: each session shows its exact `tmux attach` command.

**A chief of staff you can text.** Pair Donna with your own Telegram bot (or iMessage on a
Mac). Text "have the health agent look at my sleep" and Donna starts the Health agent's
session, tells you who is on it, and you can watch it in the cockpit. She routes work to the
right agent instead of trying to do everything in one chat. Her tools are deliberately narrow:
she can start, message and list sessions and read your org, nothing else.

**On your phone.** The Clawdling iPhone app (chat only) connects to your own cockpit: see what
needs you, chat with any session, start one, talk to Donna. Pair it from Settings with a QR
code. The App Store listing is pending Apple's review.

## How it works

```
~/clawdling/                      your org (plain files, yours)
  CLAUDE.md  me.md  org.json       context every agent inherits
  donna/  domains/<id>/  projects/<id>/    one folder per agent: CLAUDE.md + memory/
        │
        ▼
clawdling server (Node, 127.0.0.1:4747, token-protected)
  • starts the official `claude` CLI in tmux, one session per task, in that agent's folder
  • streams sessions to the browser over tmux control mode
  • learns status from Claude Code hooks: working, needs you, your turn, ended
  • Donna's gateway: Telegram long-poll or iMessage, routes requests to agents
        │
        ▼
your browser and phone: cockpit · org map · agent pages · Donna
```

Clawdling never reads, stores or forwards your Claude credentials and never calls the Anthropic
API itself. It only launches the `claude` command you are already signed into, the same way
you would in a terminal. Session titles are made locally from your first message. Details and
the threat model are in [docs/SECURITY.md](docs/SECURITY.md); the design is in
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

**Is it unlimited?** Clawdling adds no caps and no fees. Every session uses your Claude plan,
so your plan's usage limits are the real limit. Run as many agents as your plan and your
machine allow.

**Where does my data go?** Nowhere. The cockpit binds to 127.0.0.1 and requires a local token.
Your org is files in `~/clawdling`.

**Can I reach it from my phone or another machine?** `clawdling start --host 0.0.0.0` makes it
reachable on your Wi-Fi (the token is still required); away from home, use Tailscale.

**Can I keep my existing CLAUDE.md files and skills?** Yes. Agents are folders; put anything
Claude Code understands in them.

## Development

`npm test` runs the unit and integration suites against a fake `claude` and a private tmux
socket (no model calls). `npm run e2e` runs the Playwright cockpit suite. `npm run smoke:live`
runs one real Claude Code session to prove context and memory preload. Test users and acceptance
stories are in [docs/USER-STORIES.md](docs/USER-STORIES.md).

## License

AGPL-3.0. Built by [JD Davenport](https://jddavenport.com). Earlier versions of Clawdling (a
bring-your-own-API-key engine) live on the `legacy/byok-engine` branch.
