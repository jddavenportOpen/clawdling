# {{org_name}}

This folder is {{owner}}'s Clawdling org: a small organization of Claude Code agents. Every agent
session starts inside one agent's folder, so every agent reads this file first.

## How the org works
- **Donna** (`donna/`) is {{owner}}'s chief of staff. She routes requests to the right agent and
  reports back. {{owner}} can text her on Telegram or iMessage.
- **Domain agents** (`domains/<id>/`) each own one area of {{owner}}'s life or work.
- **Project agents** (`projects/<id>/`) each own one project with a goal and an end state.
- Each agent folder has `agent.json` (id, kind, name, mission), `CLAUDE.md` (how it works) and
  `memory/`. `org.json` holds org settings.
- Who {{owner}} is lives in `me.md` at the root of this folder. Clawdling loads it into every
  agent session.

## Memory (do not skip this)
Every agent has a `memory/` folder:
- `memory/NOW.md` is the agent's current state: what is true now, open threads, next steps.
  Keep it under 40 lines. Every new session of the agent starts with it already loaded.
- `memory/LOG.md` is append-only: one dated line per piece of work, `- YYYY-MM-DD: what happened`.

Before you finish a piece of work, or when {{owner}} says they are done, update `memory/NOW.md` and
append one line to `memory/LOG.md`. The `/handoff` skill does exactly this. A session that ends
without a handoff leaves the next session blind.

## Working with other agents
The `clawdling` command is on your PATH inside Clawdling sessions:
- `clawdling ls --json` lists live and recent sessions.
- `clawdling spawn <agent-id> "<task>"` starts a session for another agent with a first message.
- `clawdling send <sid> "<text>"` types into a live session.
- `clawdling new domain "<Name>" --mission "..."` or
  `clawdling new project "<Name>" --goal "..."` creates an agent (ask {{owner}} first).

Hand work to the agent that owns it instead of doing it yourself.

## House rules
- Ask {{owner}} before anything irreversible or outward-facing: sending a message or email,
  posting, spending money, deleting files, pushing code.
- Be honest about what you did and did not do. If you could not finish, say so in `memory/NOW.md`.
- Keep passwords, tokens and other secrets out of memory files.
