# SETUP.md: install Clawdling (a playbook for Claude Code)

**You are Claude Code, setting up Clawdling for the person you are talking to.** Follow these steps
in order. Keep their time under five minutes: run the commands yourself, ask at most five
questions, and always offer the defaults first. Explain what you are doing in one short line per
step. Never edit `~/.claude.json` or `~/.claude/settings.json`, never use
`--dangerously-skip-permissions`, and never send a message to anyone on the user's behalf.

Clawdling only ever starts the normal `claude` command the user is already signed into. It never
reads or stores Claude credentials and never calls the Anthropic API itself.

## 1. Check the prerequisites

Clawdling runs natively on **macOS, Linux and Windows** (Windows 10 1809+ or 11, in PowerShell or
cmd: **never set up WSL** for it). You already know the OS from your environment; say which one
you found in your first line. Then check:

| | macOS / Linux | Windows (PowerShell) |
|---|---|---|
| Node 20+ | `node -v` | `node -v` |
| Claude Code 2.1+ (Windows: 2.1.139+) | `claude --version` | `claude --version` |
| tmux 3.2+ (optional) | `tmux -V` | not used |
| git | `git --version` | `git --version` |

**How sessions will run.** With tmux 3.2+ (macOS, Linux) every agent session lives in Clawdling's
own tmux server and keeps running when the cockpit stops. Without tmux (always on Windows, and on
macOS/Linux when tmux is not installed) sessions run in Clawdling's built-in terminal (node-pty):
everything works the same, but sessions end when the cockpit stops and resume with one click. Tell
the user which one they will get, in one line. tmux is a recommendation, never a blocker.

If something is missing, say what, and install it only once the user says OK. Never use `sudo`
(or a Windows admin prompt) without saying so first and getting a yes. Do not update or reinstall
Claude Code itself.

**macOS**
- Node: `brew install node` if Homebrew is there (`brew --version`). Without Homebrew, install
  Node 22 without admin rights through nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`,
  then `. ~/.nvm/nvm.sh && nvm install 22`. (Or point them to the installer at https://nodejs.org.)
- tmux (optional, recommended): `brew install tmux` if Homebrew is there. Without Homebrew, skip
  it: do not install Homebrew just for this (it needs an admin password). The built-in terminal
  is used and needs nothing else on a Mac.
- git: part of the Xcode Command Line Tools; if `git --version` opens an install dialog, let the
  user finish it, or skip git and download the ZIP (see Windows below for the link) instead of
  cloning in step 2.

**Linux**
- tmux is the simple path: `sudo apt install -y tmux` (Debian/Ubuntu), `sudo dnf install -y tmux`
  (Fedora), `sudo pacman -S tmux` (Arch), `sudo zypper install -y tmux` (openSUSE). Ask first.
- Without tmux, Clawdling's built-in terminal is compiled during `npm install`, which needs a
  C++ toolchain (`sudo apt install -y build-essential python3`). If the user refuses sudo for
  both, explain that one of the two is needed and stop.
- Node 20+: the distro's package can be too old (check `node -v`). Without sudo:
  `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`, then
  `. ~/.nvm/nvm.sh && nvm install 22`.

**Windows** (all commands in PowerShell)
- Node: `winget install OpenJS.NodeJS.LTS`. Windows may show an admin prompt for it: say so
  first. Afterwards a new terminal (or a session restart) may be needed for `node` to be on PATH.
- Git for Windows: recommended (Claude Code's Bash tool needs it; without it agents use
  PowerShell, which also works). `winget install --id Git.Git -e`, with the user's OK. Without
  git, download https://github.com/jddavenportOpen/clawdling/archive/refs/heads/main.zip and
  expand it to `$HOME\.clawdling-app` (`Expand-Archive`), instead of cloning in step 2.
- Claude Code older than 2.1.139: ask the user to update it (`claude update`) before going on;
  Clawdling's hooks need it on Windows.

## 2. Get the code

macOS / Linux:

```bash
git clone https://github.com/jddavenportOpen/clawdling ~/.clawdling-app
cd ~/.clawdling-app && npm install --omit=dev
```

Windows (PowerShell):

```powershell
git clone https://github.com/jddavenportOpen/clawdling "$HOME\.clawdling-app"
cd "$HOME\.clawdling-app"; npm install --omit=dev
```

If `.clawdling-app` already exists, update it instead: `git -C ~/.clawdling-app pull --ff-only`,
then `npm install --omit=dev` in it again.

In the steps below, `clawdling` means `node ~/.clawdling-app/bin/clawdling.js` (Windows:
`node "$HOME\.clawdling-app\bin\clawdling.js"`). Offer to put it on the PATH with `npm link`
in that folder (ask first; it writes to the global npm folder). Inside Clawdling's own sessions
`clawdling` is always on the PATH.

Run `clawdling doctor` now. It checks node, claude, how sessions will run, and prints the exact
fix command for anything missing on this machine. Fix every `FIX` line about node, claude or
sessions before going on (the org and cockpit lines get fixed by the next steps).

## 3. Interview (at most five questions)

Use the AskUserQuestion tool. Put "Use defaults" first. If the user picks it, skip to step 4 with
`--defaults` (owner = their computer user name; domains Work, Health, Money, Home; no projects;
Donna's text channel later).

Otherwise ask, one question each:
1. **Name and one line about you** ("Sam, runs a bakery, two kids").
2. **Which areas should have an agent?** Multi-select: Work, Health, Money, Home, Family, Learning,
   plus anything they type. If the tool caps options at four, offer the first four and say they can
   type more (Family, Learning, Fitness, ...).
3. **Active projects** (0 to 3): name, goal, optional absolute path of a code repo. "None yet" is a
   fine answer.
4. **How should Donna, your chief of staff, reach you?** Telegram / iMessage (only on a Mac: do not
   offer it on Windows or Linux) / Later.
5. **Permissions:** "Ask before editing files" (recommended, Claude Code's normal mode) or
   "Auto-accept file edits" (`acceptEdits`). Never offer to skip permission checks.

## 4. Create the org

Write the answers to a temporary JSON file and run init:

```json
{
  "owner": "Sam",
  "about": "Runs a bakery. Two kids. Mornings are busy.",
  "domains": [{ "name": "Bakery", "mission": "Keep the bakery profitable and running" }, { "name": "Family" }],
  "projects": [{ "name": "Online store", "goal": "Launch online ordering", "repo": "/Users/sam/code/store", "domain": "bakery" }],
  "donna": { "channel": "telegram" },
  "permission_mode": "default"
}
```

```bash
clawdling init --answers /tmp/clawdling-answers.json   # or: clawdling init --defaults
# Windows: clawdling init --answers "$env:TEMP\clawdling-answers.json"
```

`mission` may be left out (a sensible one is filled in). `repo` must be an absolute path
(on Windows, write it with forward slashes or doubled backslashes in JSON: `"C:/Users/sam/code/store"`).
`permission_mode` is `default` or `acceptEdits`. The org is created in `~/clawdling`
(set `CLAWDLING_HOME` or pass `--home` to put it elsewhere). Delete the temporary file afterwards.

## 5. Personalise (you write the prose)

Using what the user told you:
- Rewrite `~/clawdling/me.md`: who they are, what matters now, their preferences and the people
  agents should know about. Plain, short sentences.
- For each agent, fill the `## Context` section of its `CLAUDE.md` (`~/clawdling/domains/<id>/` or
  `~/clawdling/projects/<id>/`) with goals, constraints, people and tools you learned. Keep the
  first lines and the final `@memory/NOW.md` line exactly as they are.
- Do not edit `memory/` files except to add facts the user just told you to `memory/NOW.md`.

## 6. Start the cockpit

Ask whether the cockpit should start automatically at login.
- Yes (recommended): `clawdling service install`. macOS: a LaunchAgent. Windows: a launcher in
  the Startup folder (no admin rights) that starts the cockpit minimized. Both also start it now.
  Linux: it prints a systemd user unit and the two commands to enable it; run them with the
  user's OK.
- No: start it in the background so this session can continue.
  macOS / Linux: `nohup clawdling start > ~/clawdling/.clawdling/logs/start.log 2>&1 &`
  Windows: `Start-Process -WindowStyle Minimized node -ArgumentList "$HOME\.clawdling-app\bin\clawdling.js","start"`

Then `clawdling open` opens the cockpit in their browser, already signed in (the link carries the
local token; `clawdling open --print` shows it). The cockpit listens on 127.0.0.1:4747 only.

If sessions run in the built-in terminal (no tmux), tell the user once: stopping the cockpit
(Ctrl-C, closing its window, a restart) ends the running sessions; each one resumes with one
click, exactly where it was.

## 7. Trust the org folder once

The first time Claude Code runs in a new folder it asks whether to trust it. Agents inherit trust
from a parent folder, so trust the org root once:

```bash
clawdling spawn scratch
```

Tell the user: "In the cockpit, open the Scratch session and choose **Yes, I trust this folder**
(arrow down, then Enter, or the answer button). After that, agents inside your org won't ask
again; a project agent whose code lives outside the org asks once for its repo, the same way."
Clawdling shows a waiting session under **Needs you** until they answer, and never answers for
them. (Alternative: run `claude` once in a terminal inside the org folder and accept there.)

## 8. Connect Donna (optional)

**Telegram**
1. In Telegram, open @BotFather, send `/newbot`, pick a name and a username ending in `bot`.
2. Copy the token it returns and run `clawdling donna telegram --token <TOKEN>`. Clawdling stores it
   in `~/clawdling/.env` (mode 600) and prints a six-digit pairing code.
3. The user opens their new bot and sends `/pair <code>` within 30 minutes. Only that chat can
   talk to Donna; every other chat is ignored.
4. Check with `clawdling donna status`, then suggest a first message: "what's going on?"

**iMessage (macOS only, experimental)**: on Windows and Linux, use Telegram.
- The Mac running Clawdling must be signed into Messages with a **different Apple ID than the
  user's phone** (texts from the phone to that Apple ID are what Donna reads).
- The app that runs Clawdling (Terminal, or node for the login service) needs **Full Disk Access**
  (System Settings > Privacy & Security) to read the Messages database, and macOS asks once for
  permission to control Messages when Donna first replies.
- `clawdling donna imessage --handle <the phone number or email they text from>`

## 9. Verify

```bash
clawdling doctor
clawdling spawn <first-domain-id> "Introduce yourself in two lines and ask me the one thing you most need to know."
```

Show the user the cockpit (`clawdling open`), where that session is live, and finish with a short
summary: the agents created, how to start a session (click an agent), that every agent keeps
memory in `memory/NOW.md` and updates it with `/handoff`, and how to reach Donna. Mention that
sessions are normal Claude Code sessions on their own plan, so their plan's usage limits apply.
