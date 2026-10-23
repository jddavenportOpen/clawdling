# Clawdling 1.0 / 1.1 — test users and user stories

Every story below is an acceptance test. The release gate is: every P0 story passes
for every persona it names, run from a clean home directory with no prior state.

## Test users (personas)

Each persona is a real, isolated install: its own `CLAWDLING_HOME`, its own tmux
socket (`CLAWDLING_TMUX_SOCKET`), its own port. No persona can see another's org.

| Persona | Who | Setup | What they care about |
|---|---|---|---|
| **Sam — the stranger** | A Claude Code user who has never heard of Clawdling. Has only the GitHub link. | Fresh home, nothing installed but `node`, `tmux`, `claude`. | "Does the link actually work? How fast am I useful?" |
| **Maya — solo founder** | Runs 3 projects (an app, a newsletter, consulting). Lives in Claude Code. | `--answers` with 3 projects + domains Work, Money, Health. Donna on Telegram. | Parallel project agents, never losing a session, a status view on her phone. |
| **Dev — MBA student + parent** | Juggling school, family, a job search, health. Not a coder. | `--defaults` then adds School and Family domains in the UI. Donna on iMessage. | Domain agents that remember, a chief of staff he can text. |
| **Rin — the skeptic** | Power user who has tried Conductor, Claude Squad, PAI. | Fresh home, reads SECURITY.md first. | Token handling, "unlimited" claims, what happens on restart, can she attach from her own terminal. |
| **Wes — Windows, no WSL** (1.1) | Claude Code user on Windows 11 in PowerShell; no WSL, no admin rights, no tmux. | Fresh user profile, `node`, `claude`, maybe Git for Windows. | "Does it work on my machine without WSL? What do I lose without tmux?" |
| **Ana — Mac without Homebrew** (1.1) | Uses Claude Code on a work Mac where she cannot install Homebrew. | `node` from nvm, `claude`, no tmux. | "Do I need Homebrew? Is anything worse than with tmux?" |

## User stories

Priority: **P0** = release-blocking, **P1** = must work before the launch post, **P2** = nice.

### Install
- **US-01 (P0, Sam)** As a stranger, I paste `Set up Clawdling for me from https://github.com/jddavenportOpen/clawdling — follow SETUP.md` into Claude Code and, after answering at most 5 questions (or picking "use defaults"), I have a running cockpit with my agents in under 5 minutes of my time.
  - Accept: SETUP.md is reachable from the README; prerequisites are checked; `clawdling init` creates the org; `clawdling start` prints a working URL; `clawdling doctor` passes.
- **US-02 (P0, Rin)** As a skeptic, I can install manually with `git clone` + `npm install` + `node bin/clawdling.js init --defaults` + `start`, with no network calls besides npm.

### See the whole system
- **US-03 (P0, Maya)** As a founder, I open the cockpit and see my whole org at a glance: Donna, my domains, my projects, and every live Claude Code session by name, with which ones need me.
- **US-04 (P1, Dev)** As a non-coder, the org map shows my agents as a picture (me → Donna → domains → projects) and clicking one shows what it knows and lets me start it.

### Sessions
- **US-05 (P0, Maya)** As a founder, one click on an agent starts a real Claude Code session in that agent's folder, preloaded with the org context, the agent's CLAUDE.md and its memory/NOW.md.
  - Accept (live smoke): the agent answers with its mission phrase and its NOW.md marker.
- **US-06 (P0, Maya)** As a founder, I can run 5+ sessions at once; Clawdling adds no cap.
- **US-07 (P0, Maya)** As a founder, clicking a session in the rail focuses it in my workspace and every other open pane stays open. The Cockpit control always returns me to all of my open sessions.
- **US-08 (P0, Rin)** As a skeptic with tmux, when I restart Clawdling (or it crashes) my sessions are still running and reattach; I can `tmux -L clawdling attach -t <name>` from my own terminal.
- **US-08b (P0, Wes, Ana; 1.1)** Without tmux, every session feature works the same (cockpit, phone, Donna, hooks, trust and permission buttons). When the cockpit stops or crashes, my sessions show as ended with a notice saying why, and Resume brings each one back where it was; `clawdling attach <sid>` opens one in my terminal. Accept: `npm run test:pty` on all three OSes in CI, and `CLAWDLING_BACKEND=pty npm run smoke:live`.
- **US-08c (P0, Wes; 1.1)** On native Windows, the install link, `clawdling doctor` (with fix commands for this OS), `init`, `start` and a live session work without WSL or admin rights; a prompt with quotes, `%` or newlines reaches Claude Code intact.
- **US-09 (P1, Maya)** As a founder, an ended session appears under Recent and Resume brings the same Claude conversation back (`claude --resume <id>`).
- **US-10 (P1, Dev)** As a parent, a session that needs my input (a permission prompt or a finished turn) shows as "Needs you" in the rail and on the map within seconds.
- **US-11 (P1, Maya)** As a founder, I can rename a session, end it with a confirm, and collapse the rail (⌘\), and the rail remembers.

### Agents
- **US-12 (P0, Dev)** As a parent, I create a new domain agent ("Family") from the UI in under a minute; its folder, CLAUDE.md and memory/ exist and it appears on the map.
- **US-13 (P1, Maya)** As a founder, I create a project agent pointing at an existing repo; its sessions run in that repo with the org + agent context appended.
- **US-14 (P1, Dev)** As a parent, I can read and edit an agent's CLAUDE.md and NOW.md in the browser, so I can see exactly what it knows.
- **US-15 (P1, Dev)** As a parent, an agent remembers across sessions: what it wrote to memory/NOW.md in one session is in the next session's context.

### Donna (chief of staff)
- **US-16 (P0, Maya)** As a founder, I pair my Telegram bot with a 6-digit code; only my chat is answered; strangers get nothing.
- **US-17 (P0, Maya)** As a founder, I text Donna "have the health agent look at my sleep" and she starts (or continues) the Health agent's session and tells me in one or two lines who is on it; the new session is visible in the cockpit.
- **US-18 (P1, Dev)** As a parent on a Mac, I can point Donna at iMessage; she reads only my handle's messages and replies through Messages. (Experimental; needs Full Disk Access.)

### Safety and honesty
- **US-19 (P0, Rin)** As a skeptic, I can verify Clawdling never reads or stores Claude credentials and never calls the Anthropic API itself (SECURITY.md + code search).
- **US-20 (P0, Rin)** As a skeptic, the cockpit refuses requests without the local token and refuses cross-origin writes; it binds to 127.0.0.1 by default.
- **US-21 (P0, everyone)** The README never claims "unlimited": it says no session caps and that plan usage limits still apply.
