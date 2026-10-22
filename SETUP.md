# SETUP.md: install Clawdling (a playbook for Claude Code)

**You are Claude Code, setting up Clawdling for the person you are talking to.** Follow these steps
in order. Keep their time under five minutes: run the commands yourself, ask at most five
questions, and always offer the defaults first. Explain what you are doing in one short line per
step. Never edit `~/.claude.json` or `~/.claude/settings.json`, never use
`--dangerously-skip-permissions`, and never send a message to anyone on the user's behalf.

Clawdling only ever starts the normal `claude` command the user is already signed into. It never
reads or stores Claude credentials and never calls the Anthropic API itself.

## 1. Check the prerequisites

```bash
node -v          # needs v20 or newer
tmux -V          # needs 3.2 or newer
claude --version # needs 2.1 or newer
```

If something is missing, say what and offer to install it. With the user's OK:
- macOS: `brew install node tmux` (if Homebrew is missing, point them to https://brew.sh first).
- Debian/Ubuntu: `sudo apt install -y tmux nodejs npm` (check the node version afterwards).
- Windows: Clawdling needs WSL (Ubuntu); run everything inside it.

Do not update or reinstall Claude Code itself.

## 2. Get the code

```bash
git clone https://github.com/jddavenportOpen/clawdling ~/.clawdling-app
cd ~/.clawdling-app && npm install --omit=dev
```

If `~/.clawdling-app` already exists, update it instead:
`git -C ~/.clawdling-app pull --ff-only && (cd ~/.clawdling-app && npm install --omit=dev)`.

In the steps below, `clawdling` means `node ~/.clawdling-app/bin/clawdling.js`. Offer to put it on
the PATH with `cd ~/.clawdling-app && npm link` (ask first; it writes to the global npm folder).
Inside Clawdling's own sessions `clawdling` is always on the PATH.

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
4. **How should Donna, your chief of staff, reach you?** Telegram / iMessage (macOS) / Later.
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
```

`mission` may be left out (a sensible one is filled in). `repo` must be an absolute path.
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
- Yes (recommended): `clawdling service install` (macOS LaunchAgent; on Linux it prints a systemd
  user unit and the two commands to enable it).
- No: start it in the background so this session can continue:
  `nohup clawdling start > ~/clawdling/.clawdling/logs/start.log 2>&1 &`

Then `clawdling open` opens the cockpit in their browser, already signed in (the link carries the
local token; `clawdling open --print` shows it). The cockpit listens on 127.0.0.1:4747 only.

## 7. Trust the org folder once

The first time Claude Code runs in a new folder it asks whether to trust it. Agents inherit trust
from a parent folder, so trust the org root once:

```bash
clawdling spawn scratch
```

Tell the user: "In the cockpit, open the Scratch session and choose **Yes, I trust this folder**
(arrow down, then Enter). After that no agent will ask again." Clawdling shows the waiting session
under **Needs you** until they answer. (Alternative: run `cd ~/clawdling && claude` once in a
terminal and accept there.)

## 8. Connect Donna (optional)

**Telegram**
1. In Telegram, open @BotFather, send `/newbot`, pick a name and a username ending in `bot`.
2. Copy the token it returns and run `clawdling donna telegram --token <TOKEN>`. Clawdling stores it
   in `~/clawdling/.env` (mode 600) and prints a six-digit pairing code.
3. The user opens their new bot and sends `/pair <code>` within 30 minutes. Only that chat can
   talk to Donna; every other chat is ignored.
4. Check with `clawdling donna status`, then suggest a first message: "what's going on?"

**iMessage (macOS, experimental)**
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
