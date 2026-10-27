# Clawdling 1.0 to 1.5 - test users and user stories

Every story below is an acceptance test. The release gate is: every P0 story passes
for every persona it names, run from a clean home directory with no prior state.

## Test users (personas)

Each persona is a real, isolated install: its own `CLAWDLING_HOME`, its own tmux
socket (`CLAWDLING_TMUX_SOCKET`) when tmux is used, its own port. No persona can see another's org.

| Persona | Who | Setup | What they care about |
|---|---|---|---|
| **Sam - the stranger** | A Claude Code user who has never heard of Clawdling. Has only the GitHub link. | Fresh home, nothing installed but `node`, `tmux`, `claude`. | "Does the link actually work? How fast am I useful?" |
| **Maya - solo founder** | Runs 3 projects (an app, a newsletter, consulting). Lives in Claude Code. | `--answers` with 3 projects + domains Work, Money, Health. Donna on Telegram. | Parallel project agents, never losing a session, a status view on her phone. |
| **Dev - MBA student + parent** | Juggling school, family, a job search, health. Not a coder. | `--defaults` then adds School and Family domains in the UI. Donna on iMessage. | Domain agents that remember, a chief of staff he can text. |
| **Rin - the skeptic** | Power user who has tried Conductor, Claude Squad, PAI. | Fresh home, reads SECURITY.md first. | Token handling, "unlimited" claims, what happens on restart, can she attach from her own terminal. |
| **Wes - Windows, no WSL** (1.1) | Claude Code user on Windows 11 in PowerShell; no WSL, no admin rights, no tmux. | Fresh user profile, `node`, `claude`, maybe Git for Windows. | "Does it work on my machine without WSL? What do I lose without tmux?" |
| **Ana - Mac without Homebrew** (1.1) | Uses Claude Code on a work Mac where she cannot install Homebrew. | `node` from nvm, `claude`, no tmux. | "Do I need Homebrew? Is anything worse than with tmux?" |
| **Priya - MBA student, desktop app only** (1.1) | Uses Claude only through the Claude desktop app on her Mac; has never opened a terminal. Pro or Max plan. | Fresh Mac user, Claude desktop app signed in, no `claude` command, no Node, no tmux, no Homebrew. | "Can I do this from the app I already use? Will it ask for my Mac password? What do I click?" |
| **Tom - small-business owner on Pro** (1.1) | Runs a small shop; pays for Claude Pro; uses Claude Code a little. | `--defaults`, one or two domains, Pro plan, desktop app or terminal. | "Is Pro enough? What happens when I hit my limit? Does Clawdling cost anything extra?" |
| **Lena - claude.ai chat only** (1.1) | Uses Claude in a browser tab and on her phone; has never installed Claude Code. | No desktop app, no `claude`; arrives with only the GitHub link. | "Can I use this from claude.ai? If not, what is the shortest path?" |
| **Lou - the owner** (1.5) | Runs a small company; three software projects that Claude Code agents build for him. A contractor set up his Clawdling; he never opens a terminal. Max plan. Checks in from his phone twice a day. | An org with project agents imported from his repos; the cockpit on his phone. | "Is it moving? Does it work? What is it costing me? What do they need from me?" |
| **Hal - the builder dad** (1.2) | Retired engineer. About ten repos on GitHub from side projects over the years, some cloned locally, some not. `gh` installed and signed in. | Fresh home, `node`, `claude`, `git`, `gh`; 10 repos on GitHub. | "Can I get an agent per project, linked to my GitHub, without doing it ten times by hand?" |

## User stories

Priority: **P0** = release-blocking, **P1** = must work before the launch post, **P2** = nice.

### Install
- **US-01 (P0, Sam)** As a stranger, I paste `Set up Clawdling for me from https://github.com/jddavenportOpen/clawdling and follow SETUP.md` (in a terminal or the desktop app's Code tab) into Claude Code and, after answering at most 5 questions (or picking "use defaults"), I have a running cockpit with my agents in under 5 minutes of my time.
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
- **US-08b (P0, Wes, Ana; 1.1)** Without tmux, every session feature works the same (cockpit, phone, Donna, hooks, trust and permission buttons). When the cockpit stops or crashes, my sessions show as ended with a notice saying why, and Resume brings each one back where it was; `clawdling attach <sid>` opens one in my terminal. Accept: `npm run test:pty` on all three OSes in CI, and `CLAWDLING_BACKEND=pty npm run smoke:live`. Detail in US-30 to US-32.
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
  - 1.1: an added Claude account is only a folder passed as `CLAUDE_CONFIG_DIR` (US-29); the chat view reads Claude Code's transcripts under `~/.claude/projects` (or `<account folder>/projects`), never a credential. Test: `test/integration/features.test.js` "accounts: only the default login until one is added; an added one is passed as CLAUDE_CONFIG_DIR".
- **US-20 (P0, Rin)** As a skeptic, the cockpit refuses requests without the local token and refuses cross-origin writes; it binds to 127.0.0.1 by default.
  - 1.1: `--host 0.0.0.0` (what phone pairing needs, US-36) is opt-in, serves plain http with the token, and only logs a warning.
- **US-21 (P0, everyone)** The README never claims "unlimited": it says no session caps and that plan usage limits still apply.
  - 1.1: README, START-HERE and SETUP.md say Pro works with a smaller shared allowance (one or two agents busy at a time) and the free plan cannot run Claude Code.

## New in 1.1

Each acceptance check names the automated test that covers it, or says `manual` when none does. "Gap" is what the code or the tests do not cover yet.

### Clean chat view and the Raw toggle
- **US-22 (P0, Maya, Dev; 1.1)** As a founder, when I open a session pane I see the conversation as chat by default: my messages and Claude's replies with markdown (code blocks, tables), each tool call as one line I can expand, updating live, with a message box at the bottom that sends.
  - Accept: A pane with a transcript opens in chat (data-view=chat) and renders messages, a code block and a table; a tool call expands to its detail; the composer sends and the reply appears live.
  - Tests: `test/e2e/chat.spec.js:42` "a session with a transcript opens in chat: messages, code block, table, safe text"; `test/e2e/chat.spec.js:81` "a tool call is one line and expands to its detail"; `test/e2e/chat.spec.js:100` "the chat composer sends and the reply appears live"; `test/e2e/chat.spec.js:160` "chat with the composer, 16 px field, 44 px toggles, no sideways scroll"
  - Gap: All chat e2e specs run against the mock server (test/e2e/mock-server.mjs) with a fixture transcript; no automated test parses a transcript written by real Claude Code into the cockpit's chat view end to end.
- **US-23 (P0, Rin, Maya; 1.1)** As a skeptic, one click on Raw in a pane's header shows the real terminal (xterm) and Chat brings the chat back; the choice is remembered per pane across a reload, and a brand-new session with no transcript yet shows the terminal with the note 'Chat appears once Claude Code starts.' and switches to chat by itself once the transcript appears.
  - Accept: Raw sets aria-pressed, hides chat-view and shows .xterm-rows; after page.reload the pane is still Raw; Chat restores the messages; a session with no transcript shows chat-pending-note plus the terminal, then flips to chat when the transcript arrives.
  - Tests: `test/e2e/chat.spec.js:117` "Raw shows the terminal, is remembered per pane across a reload, and Chat comes back"; `test/e2e/chat.spec.js:140` "a session with no transcript yet shows the raw terminal and a note"
  - Gap: The view is stored in the browser's localStorage under view.<sid> (web/components/pane.js:39,46), so it is per browser, not shared between the desktop and the phone.

### Model and effort chips
- **US-24 (P1, Maya, Rin; 1.1)** As a founder, the new-session dialog has optional Model and Effort pickers that pass claude's own --model and --effort; if I leave them blank no flag is passed and my Claude Code defaults stay mine, and an unknown effort is refused.
  - Accept: POST /api/sessions with model opus, effort high launches claude with --effort=high and model opus; with neither, argv has no --model or --effort and CLAUDE_CONFIG_DIR is the user's own; effort 'ultra' returns 400.
  - Tests: `test/integration/features.test.js:36` "spawn passes the chosen model and effort to claude as its own flags; nothing when unset"; `test/e2e/chips.spec.js:64` "model and effort pickers; the account picker appears only with a second login"; `test/unit/accounts.test.js:48` "effort levels are the CLI's own"
  - Gap: The model picker offers a fixed list (5 options including the default, per chips.spec.js:68); a model id outside it cannot be picked in the UI.
- **US-25 (P1, Maya, Rin; 1.1)** As a founder, the model and effort chips in a pane's header show what the session runs and let me change either only when it is my turn: Clawdling ends that session's claude and resumes the same conversation with the new flags, for that session only, without typing /model into the chat or saving a new default.
  - Accept: While Claude is working the chips are aria-disabled with a 'wait until it's your turn' title; with a question on screen POST /api/sessions/:sid/settings returns 409; when ready it returns 200 and claude is relaunched with resume=<sid> and the new model/effort, no '/' message appears in the transcript, an unchanged setting is kept on the next switch; an ended session's chips are static.
  - Tests: `test/integration/features.test.js:57` "chips: model/effort change only between turns, by resuming that session with the new flags"; `test/e2e/chips.spec.js:17` "chips show the session model and effort, and switch them between turns"
  - Gap: Not a live change: each switch restarts that session's claude (end plus --resume). Static chips on an ended session (web/components/chips.js:69) have no test.
- **US-26 (P0, Rin, Wes, Ana; 1.1)** As a skeptic, when a session is relaunched (Resume, or a chip switch that ends and resumes in one step), the old claude's late SessionEnd hook never ends the new launch: each launch gets its own id (CLAWDLING_LAUNCH, saved as launch_id) and the server ignores hook events from any other launch.
  - Accept: After end plus resume, a stale SessionEnd carrying the old launch id leaves the session ready, and hooks from the current launch still apply; runs on both tmux and pty backends.
  - Tests: `test/integration/answer.test.js:142` "a hook from a claude the session has replaced never changes it (the old SessionEnd after a resume)"
  - Gap: Hooks without a launch id (from older spools) still apply, by design.

### Voice input
- **US-27 (P1, Dev, Maya; 1.1)** As a parent on my phone, the mic button in the message box dictates with the browser's own speech recognition (SpeechRecognition or webkitSpeechRecognition, in my browser's language); the words fill the box for me to check, append to anything I typed, and are never sent by themselves; a one-time note says it uses the browser's own speech service.
  - Accept: With a fake webkitSpeechRecognition the mic (44 px, aria-label Dictate) fills the box with 'hello from voice', a second dictation appends after 'Note:', nothing is posted, the note shows once. With no recognition API the mic is not rendered.
  - Tests: `test/e2e/chips.spec.js:113` "the mic fills the box, notes the speech service once, and never sends"; `test/e2e/chips.spec.js:107` "no speech recognition in the browser: no mic"; `test/unit/voice.test.js:7` "speechCtor: standard, webkit-prefixed, or none"; `test/unit/voice.test.js:16` "transcriptOf: every result in order, best guess only, spaces tidied"; `test/unit/voice.test.js:24` "joinDictation: appends with one space, never drops what was typed"
  - Gap: Only a fake recognizer is tested; no real browser engine. Firefox (no API) hides the mic. A blocked mic permission shows a toast 'The microphone is blocked...' (web/components/composer.js:59-62) but no test covers it; a missing microphone (error audio-capture) or no-speech just stops listening with no message. In Chrome the browser's speech service is a network service, which the one-time note discloses.

### Extra Claude accounts (hidden until added)
- **US-28 (P1, Sam, Dev; 1.1)** As a stranger with one Claude login, I never see account choices: Settings -> Accounts shows only 'Your Claude login' (Default, no Sign in button) and the new-session dialog has no account picker until I add a second account.
  - Accept: GET /api/accounts returns only 'default'; the Accounts card has one row with no account-signin button; ns-account is absent until a second account exists.
  - Tests: `test/e2e/accounts.spec.js:11` "the card shows only your own Claude login by default, with no Sign in on it"; `test/e2e/chips.spec.js:64` "model and effort pickers; the account picker appears only with a second login"; `test/integration/features.test.js:89` "accounts: only the default login until one is added; an added one is passed as CLAUDE_CONFIG_DIR"
  - Gap: The Accounts card itself is always visible in Settings (with the 'Add another Claude account' button); only the extra rows and the dialog picker are hidden.
- **US-29 (P0, Rin, Maya; 1.1)** As a skeptic, 'Add another Claude account' only creates a private folder (~/.clawdling-accounts/<name>, mode 0700); 'Sign in' opens a Claude Code session with CLAUDE_CONFIG_DIR set to it so I run /login myself, and sessions started on that account get only that CLAUDE_CONFIG_DIR; Clawdling never writes, reads or forwards the login and never switches accounts automatically.
  - Accept: POST /api/accounts {name:'Work'} returns 201 id work, a duplicate 409, '../work' and 'default' refused; POST /api/accounts/work/signin starts a 'Sign in: work' scratch session whose claude env has CLAUDE_CONFIG_DIR=<dir>; a session on account work gets that env; the folder contains no credential, settings or .claude.json file written by Clawdling.
  - Tests: `test/integration/features.test.js:89` "accounts: only the default login until one is added; an added one is passed as CLAUDE_CONFIG_DIR"; `test/unit/accounts.test.js:10` "account ids: a name becomes a short slug; "default" and empty are refused"; `test/unit/accounts.test.js:19` "accounts: the default login always comes first; added accounts are private folders"; `test/e2e/accounts.spec.js:24` "adding "work" lists it with its folder and a Sign in button; an empty name adds nothing"; `test/e2e/accounts.spec.js:61` "Sign in starts a sign-in session for that account and opens it in the workspace"
  - Gap: 'Never reads its files' is true for the login, not the whole folder: the chat view reads session transcripts from <account dir>/projects/ (server/transcripts.js:1-13,77-78), the same way it reads ~/.claude/projects for the default login. The card shows no signed-in or not-signed-in state for an added account (web/components/settings-page.js:223-228), and there is no way to remove an account in the UI. The no-credential check uses the fake claude, not a real /login.

### No tmux (built-in terminal) and native Windows
- **US-30 (P0, Ana, Wes, Rin; 1.1)** As a Mac user without Homebrew (or on Windows), I start Clawdling with no tmux and it picks the built-in terminal by itself (tmux 3.2+ only off Windows, else node-pty, else it stops with the one-line fix for my OS), and `clawdling doctor` and the start banner tell me which one runs my sessions; `CLAWDLING_BACKEND=tmux|pty` overrides it.
  - Accept: doctor prints `ok sessions: built-in terminal (node-pty ...)` without tmux; with neither backend, start/doctor stop with the OS fix (e.g. `sudo apt install -y tmux`); /api/health marks tmux optional under pty so no banner is raised.
  - Tests: `test/unit/platform.test.js:146` "backend choice: CLAWDLING_BACKEND wins, then tmux 3.2+ off Windows, then node-pty, else the fix"; `test/integration/cli.test.js:124` "doctor, donna status, open --print, service --dry-run"; `test/unit/auth.test.js:80` "API needs the token; /api/health does not (line 97)"
  - Gap: The Settings "Sessions" line (web/components/settings-page.js:34-37: "built-in terminal ... end when Clawdling stops; resume any time") has no e2e assertion.
- **US-31 (P0, Ana, Wes; 1.1)** As a user on the built-in terminal, when I stop the cockpit (or it crashes) my sessions end and open viewers are told so; on the next start each one shows as ended with a "Clawdling stopped ... Resume it" notice, keeps its title, and Resume relaunches it with `claude --resume <id>` where it left off.
  - Accept: Viewer WebSocket closes 1001 with a reason that mentions resume; sessions.json row is `ended` with a "Clawdling stopped" notification; after restart `resumable: true`, POST /resume brings it back to ready on the same conversation; after a SIGKILL crash no ghost process stays and the row is ended.
  - Tests: `test/integration/restart.test.js:90` "pty: stopping the server ends its sessions honestly; they come back ended and resume"
  - Gap: This is the designed limit of the pty backend, not a bug: sessions do not survive a cockpit stop, so `service install` (start at login) matters more for these users; no test covers Resume of many sessions at once after a reboot.
- **US-32 (P1, Rin, Ana, Wes; 1.1)** As a power user without tmux, I run `clawdling attach <short id>` (or copy the attach command from a pane) and get the live session in my own terminal over the cockpit's WebSocket, type into it, and detach with Ctrl-] while the session keeps running.
  - Accept: Attach prints the current screen, input reaches claude, Ctrl-] exits 0 with "Detached" and the session is not ended; the pane's Copy attach button copies the server's `attach_cmd` (`clawdling attach <8 chars>` under pty).
  - Tests: `test/integration/cli.test.js:192` "pty: attach is a terminal client over the cockpit WebSocket (snapshot, input, detach with Ctrl-])"; `test/e2e/cockpit.spec.js:304` "copy attach command puts the server's attach line on the clipboard"
  - Gap: Unlike tmux attach, it only works while the cockpit runs (it is a client of the cockpit, not of the session).
- **US-33 (P0, Wes; 1.1)** As a Windows user with no WSL and no admin rights, `clawdling doctor` names my OS and how sessions will run, gives exact fix commands (winget for Node, Anthropic's PowerShell installer for Claude Code), shows tmux as not used, and fails with `claude update` if my Claude Code is older than 2.1.139, which hooks need on Windows.
  - Accept: Install hints per package manager and per OS are correct; versionAtLeast rejects 2.1.120 and accepts 2.1.139+; Windows hooks are written in exec form (command + args, forward slashes) with PowerShell allow rules.
  - Tests: `test/unit/platform.test.js:126` "per-OS install hints: package manager, tmux / node / build tools, Claude Code"; `test/unit/cli.test.js:85` "versionAtLeast compares major.minor.patch (Windows needs Claude Code 2.1.139+)"; `test/unit/platform.test.js:177` "Windows hooks: exec form (no shell parses a path), forward slashes; PowerShell allow rules"
  - Gap: The 2.1.139 check lives only in doctor (bin/clawdling.js:753-756). The cockpit's /api/health (server/index.js:400-411) checks only that `claude --version` runs, so a Windows user who skips doctor with an older Claude Code gets no banner, and hooks (status, Needs you) may silently not fire. No test runs doctor end to end against an old claude on Windows.

### First-run org trust
- **US-34 (P0, Sam, Dev, Ana; 1.1)** As a first-time user, the empty cockpit shows "First, trust your org folder" with one "Trust my org folder" button; it opens a Scratch session in ~/clawdling whose trust banner names the folder and says "No, exit" ends the session, and once I answer "Yes, trust it" no agent inside the org asks again.
  - Accept: After trusting from the card, a Work session goes straight to ready with no trust dialog; without that step a Work session asks about ~/clawdling/domains/work; the same card works from the phone list.
  - Tests: `test/e2e/firstrun.spec.js:75` "trust the org folder once from the empty state, then agents start without asking"; `test/e2e/firstrun.spec.js:107` "without that step, each agent asks about its own folder (what the step saves you)"; `test/e2e/mobile.spec.js:93` "first run on the phone: trust the org folder from the list (P0-4)"
  - Gap: All three tests run only against the mock server (test.skip unless isMock), which simulates Claude Code's trust; the real inheritance of trust is Claude Code's behavior and is not checked by an automated test. The card shows whenever the session list is empty (web/components/workspace.js:117-119, web/components/rail.js:65), not from Claude Code's actual trust state. START-HERE says to choose "Yes, I trust this folder" (docs/START-HERE.md:93) but the cockpit button reads "Yes, trust it".

### The health banner
- **US-35 (P0, Sam, Ana, Dev; 1.1)** As a stranger whose `claude` (or, on the tmux backend, tmux 3.2+) is missing or broken, every screen including Settings and the phone shows one persistent alert that names the fix for my OS and disables every start control, and it goes away once I fix it and press "Check again" (or within 30 seconds by itself).
  - Accept: Banner has role=alert, says "Clawdling can't find the claude command, so no agent can start." with `which claude` and `<cli> service install`; agent cards, New session and Trust my org folder are disabled with "Fix the problem above first"; it survives navigation and reload; the tmux line uses the server's platform (apt on Linux, brew on macOS); any other failed non-optional check shows the server's text plus `<cli> doctor`; optional checks stay quiet.
  - Tests: `test/e2e/firstrun.spec.js:14` "claude missing: a persistent alert that names the fix, and nothing offers to start"; `test/e2e/firstrun.spec.js:45` "tmux missing: the install command matches the server platform"; `test/e2e/firstrun.spec.js:58` "a check the cockpit has no words for shows the server text; optional checks stay quiet"; `test/e2e/mobile.spec.js:82` "a missing claude is on the phone screen too (P0-1)"; `test/unit/web-model.test.js:42` "healthProblems: every failed check in /api/health, unless it is optional"
  - Gap: The 30 s automatic recheck (web/components/health-banner.js:52-62) has no test. The e2e checks are mock-only. The banner does not cover a claude that is installed but not signed in (that shows per pane, test/e2e/firstrun.spec.js:119) or an old Claude Code version on Windows (see US-33). The banner's tmux hint has no Windows wording (tmux is never used there, so it should not appear).

### Phone browser pairing
- **US-36 (P1, Maya, Rin; 1.1)** As a founder, Settings "Use Clawdling on your phone" tells me, while the cockpit is on 127.0.0.1, to restart with `<cli> start --host 0.0.0.0` (or my Tailscale address) instead of showing a QR that cannot work; once reachable it shows a QR and a masked link that open the cockpit in my phone's browser already signed in, warns that the link carries my private token, and marks the iPhone app "coming soon" (waiting on App Store review) with its pairing code folded away.
  - Accept: Loopback: no QR, no LAN address, the --host fix and Tailscale hint; reachable: QR src /api/pair/qr.svg?target=browser, token masked on screen, Copy copies the real browser_link, app QR hidden until expanded; the browser link signs a fresh browser in and strips ?t= from the URL; /api/pair and the QR need the token.
  - Tests: `test/e2e/org.spec.js:265` "loopback: no QR and no LAN address, just how to make the phone reach it (P0-2)"; `test/e2e/org.spec.js:287` "reachable: the QR opens the cockpit in the phone browser, signed in; the app code is folded away"; `test/e2e/org.spec.js` "the browser link really signs a new browser in"; `test/e2e/mobile.spec.js:107` "phone card at 390: loopback shows the fix, not a QR that cannot work (P0-2)"; `test/integration/app-api.test.js:81` "GET /api/pair and /api/pair/qr.svg (auth required)"; `test/unit/cli.test.js:61` "pairing info: LAN URL when bound to all interfaces, loopback otherwise"
  - Gap: No way to revoke a paired phone: there is no button, command or API to rotate the token. The only path is deleting .clawdling/token and restarting (server/auth.js:11-27 then makes a new one), which is undocumented and signs out every browser and the CLI hooks' callers too. The LAN link is plain http (no TLS), so the token crosses the Wi-Fi in clear; the server only logs a warning when bound off loopback (server/index.js:724). The reachable-QR e2e is mock-only (binding is simulated).

### Newcomers: desktop app only, Pro plan, claude.ai only
- **US-37 (P1, Priya; 1.1)** As someone who only uses the Claude desktop app, I open its Code tab (Local, any folder), paste the one setup line, and Claude explains that the app lacks the `claude` command Clawdling starts, installs it with Anthropic's official installer only after I say yes (no admin password), gets it signed in with my same account, offers start-at-login because a background command may stop with the conversation, and opens the cockpit.
  - Accept: manual: on a Mac with only the desktop app and no Node, follow docs/START-HERE.md steps 1-3: paste the line from README.md:42 into the Code tab, confirm each install is explained and asked first (SETUP.md:23-28, 44-65), confirm no admin prompt appears, confirm `service install` is offered (SETUP.md:207-212), then trust the org folder and get a reply from an agent. Partly covered: a not-signed-in claude is reported in the pane at once by.
  - Tests: `test/e2e/firstrun.spec.js:119` "not signed in: the pane says so at once, with what to do and no buttons (P1-13)"
  - Gap: The whole path is the SETUP.md playbook followed by Claude, which landed after the v1.1.0 tag and has no automated test. The pane's not-signed-in notice (server/hooks.js:25 LOGIN_NOTICE) tells the user to "Open a terminal, run claude", which a desktop-app-only user may not know how to do. START-HERE's trust answer label differs from the cockpit button (see US-34).
- **US-38 (P1, Tom; 1.1)** As a small-business owner on the Pro plan, the README, START-HERE and setup tell me plainly that Pro works but every agent shares its small allowance (run one or two at a time), and when I hit the limit the session turns "Needs you" with "Claude Code stopped: your Claude plan hit a usage or rate limit: <reset time>. Send your message again to retry."
  - Accept: Docs: README.md:26-28 and 201-204, docs/START-HERE.md:25-29, SETUP.md:67-70. Cockpit: a StopFailure with error rate_limit sets needs_you / waiting_on error with that notice, and the next prompt clears it.
  - Tests: `test/unit/status.test.js:205` "a turn that ends on an API error (StopFailure) says why instead of Working forever (D11)"; `test/unit/status.test.js:242` "StopFailure is registered only for a Claude Code that has it (2.1.229+)"
  - Gap: The docs say the sessions "wait" until the limit resets, but nothing resumes them: the user must send the message again after the reset. The notice needs Claude Code 2.1.229+ (server/hooks.js:10-14); older versions show no limit notice. Clawdling shows no usage meter. No e2e test renders the limit notice in a pane.
- **US-39 (P1, Lena; 1.1)** As someone who only uses claude.ai in a browser (or the phone app), when I paste the setup line into a chat Claude does not pretend to install anything: it tells me Clawdling needs a Mac, Windows or Linux computer, a Pro/Max/Team/Enterprise plan and Claude Code, points me to the desktop app's Code tab and links Start here.
  - Accept: manual: paste the line from README.md:42 into a claude.ai chat; confirm the reply matches SETUP.md:15-21 (no fake install steps, names the plan requirement, links https://claude.com/download and docs/START-HERE.md); also confirm README.md:35 and 206-208 and docs/START-HERE.md:44-49 give the same path.
  - Gap: Untested and only partly in our control: it relies on the chat model fetching SETUP.md in full (a web fetch may return a summary, SETUP.md:12-13) and obeying its first paragraph. The cockpit itself can later be used from a phone browser (US-36), but only after it is set up on a computer.

## New in 1.2

Bring in your projects, and Your Claude Code setup.

### Bring in your projects
- **US-40 (P0, Hal; 1.2)** As a builder dad with ten repos on GitHub, I click "Bring in your
  projects" on the first-run card, see all ten in the import screen, tick them, and get ten
  project agents in under two minutes.
  - Accept: `GET /api/discover` returns his repos sourced from `github` (and his own folders);
    ticking them and clicking "Create N project agents" creates one agent per repo with per-row
    status, in under two minutes. Measured on real GitHub (2026-10-24, the jddavenportOpen
    account): 10 repos, 9 of them cloned during the import, became 10 agents in about 23 s.
- **US-41 (P0, Hal; 1.2)** As Hal, ticking a repo I haven't cloned yet clones it under my own
  `gh` login into `~/code/<name>` and creates its agent, in one tick and one click.
  - Accept: an item with `github` set and no `path` needs `clone: true`; it imports with `gh repo
    clone <owner/name> <dest>` when `gh` is signed in, else `git clone <url> <dest>`; the new
    agent's repo is the cloned path.
- **US-42 (P0, Hal; 1.2)** As Hal, the first session on any imported agent already knows what the
  project is and how to run its tests, because its CLAUDE.md names the repo's install, test, dev
  and build commands and its NOW.md lists the repo's recent commits and open issues and pull
  requests.
  - Accept: the drafted CLAUDE.md's "How to run it" section lists one line per command the stack
    scan found, labelled by kind; the seeded NOW.md's "Recent commits" has up to 15 entries from
    `git log`; a fresh session's first answer, seconds in, says what the project is and names
    the test command from those notes (on real repos it sometimes glances at one file to
    confirm; it never has to go looking).
- **US-43 (P1, Hal; 1.2)** As Hal, running import again on a repo I already imported skips it
  instead of making a second agent.
  - Accept: importing a repo whose path or remote already belongs to an agent returns `{skipped:
    true, reason}` instead of creating one; the import screen marks that row "Already an agent:
    <name>" and its checkbox is disabled.
- **US-44 (P1, Hal; 1.2)** As Hal, a monorepo becomes one agent, not one per package inside it,
  and when I pick several small repos myself, "One agent for these N" makes one agent that covers
  all of them.
  - Accept: a Claude Code folder or git root found inside a monorepo collapses to one candidate
    marked `monorepo: true`; checking 2 to 12 local repos and clicking "One agent for these N"
    creates one agent whose CLAUDE.md lists each repo with its own stack and commands.
- **US-45 (P1, Hal; 1.2)** As Hal, Deep onboard tells me up front that it spends my own Claude
  plan, not something free or separate.
  - Accept: the result view's Deep onboard button reads "Starts a Claude Code session that reads
    the repo and improves this agent's notes. Uses your Claude plan."; clicking it starts a
    session for that agent running `/onboard-project`.
- **US-46 (P1, Sam; 1.2)** As a newcomer with no `gh` installed, the import screen still works:
  it shows the folders it found on this computer, says plainly that GitHub isn't connected and
  how to fix that, and I can still create agents from what it found locally.
  - Accept: with `gh` missing, `GET /api/discover`'s `sources.github.installed` is `false` and the
    candidate list still has the `claude` and `local` ones; the import screen's banner reads
    "GitHub: not connected. Install GitHub CLI and run `gh auth login` to see repos you haven't
    cloned. Showing folders on this computer."; creating agents from the local list still works.
- **US-47 (P0, Hal; 1.2)** As Hal, I can ask Donna to look at my projects: she can run `clawdling
  discover` and tell me in plain words what she'd import, but she cannot create the agents
  herself; only the cockpit, or my own `clawdling import --yes`, does that.
  - Accept: a Donna turn (`CLAWDLING_DONNA=1`) may run `clawdling discover` (its table only:
    names, folders, dates; not `--json` or `--setup`, so no descriptions or README text reach her)
    and `clawdling import` without `--yes`; `clawdling import --yes` inside a Donna turn is
    refused, the same refusal class as `init`/`start`/`service`/`donna`/`attach`.

### Safety and honesty
- **US-48 (P0, Rin; 1.2)** As a skeptic, discovery is read-only and local: it never sends
  anything off my machine and never reads a secret. MCP servers show as names only, never their
  env, headers, args or command; hooks show as event names and counts, never their command text;
  a remote URL on screen never carries a token.
  - Accept: a planted secret-shaped env var, MCP header value, or hook command string placed in
    `~/.claude.json`, a repo's `.mcp.json` or its `.claude/settings.json` does not appear anywhere
    in `GET /api/discover` or `GET /api/setup`'s response; `sanitizeRemote` strips userinfo from
    every remote shown or stored; the only process discovery ever runs is the user's own `gh`.
- **US-49 (P0, Rin; 1.2)** As a skeptic, importing a project never writes into the repo:
  everything an import creates lives under my org folder, and cloning a not-cloned repo only ever
  creates a new folder, never overwrites one.
  - Accept: before and after an import, the repo's own `git status` and the mtimes of its tracked
    files are unchanged; every path `importProject` writes resolves under
    `<org>/projects/<id>/`; `cloneRepo`'s destination is never an existing folder with different
    contents (it gets `-2`, `-3`, ... instead).

### Your Claude Code setup
- **US-50 (P1, Dev; 1.2)** As a non-coder, Settings' "Your Claude Code setup" card and the org
  map's matching toggle show the skills, subagents, MCP servers and hooks every agent inherits,
  plus what my project's own repo adds, and clicking "Make it a standing agent" on a subagent
  creates a domain agent with a note on where it came from.
  - Accept: `GET /api/setup` lists skills, subagents, commands, plugins, hooks and MCP servers by
    name and description only; `POST /api/setup/promote {scope, repo?, name, as?}` creates a domain
    agent whose CLAUDE.md carries "Copied from ~/.claude/agents/<file> on <date>. Editing this
    file does not change the original."

### Setup
- **US-51 (P1, Sam; 1.2)** As a stranger just after init, Claude offers "Bring in your projects
  now?" as a separate, optional question, not one of the five interview questions; answering no
  creates zero project agents, and answering yes still only imports what I pick.
  - Accept: the interview in SETUP.md stays at five questions or fewer; "Bring in your projects"
    is asked after init, as one yes/no question plus a pick, and `clawdling import --yes` never
    runs without a name or selection the user gave.

## New in 1.3: Use from anywhere

Optional and off by default. The cockpit stays on `127.0.0.1`; a Tailscale Serve entry or a
Cloudflare Tunnel behind Cloudflare Access is the one door in. Hal is the dad, Sam and Dev the
newcomers, Rin the skeptic, Maya the phone-only check.

- **US-52 (P0, Sam, Dev; 1.3)** As a newcomer, Settings has a "Use from anywhere" card that is Off
  by default and says in plain words what it is for ("Open your cockpit from your phone or another
  computer"), offers two choices, "Just my devices" (Tailscale, recommended) and "A web address
  with a sign-in" (Cloudflare, beta), each with what it needs, and says why there is no cloud copy.
  - Accept: a fresh org has no `.clawdling/remote.json`; `clawdling remote list` says
    "Use from anywhere: off"; a request with any non-localhost `Host` is refused; the card shows
    Off, both choices (Tailscale pre-selected) and one "Set it up with an agent" button.
- **US-53 (P0, Hal; 1.3)** As the dad, "Set it up with an agent" first shows a sheet that says it
  opens a setup chat, the agent asks before it installs or changes anything, it uses my Claude
  plan, and I sign in to Tailscale (or Cloudflare) myself in my browser, which Clawdling never
  sees; it shows the exact first message. "Start setup" opens that chat.
  - Accept: Cancel and Escape start nothing; Start setup creates one Scratch session at the org
    root whose first message is exactly the prompt shown (`/remote-access tailscale` or
    `/remote-access cloudflare`); the org has the `remote-access` skill at `.claude/skills/`.
- **US-54 (P0, Hal, Rin; 1.3)** As the dad, the setup agent explains the plan in three lines,
  asks before each install or command, works around the macOS Tailscale symlink crash, tells me
  exactly where to enable HTTPS certificates if they are off, never touches other serve entries,
  and registers the address only once it is private; Settings then shows it as "Private to your
  devices ✓".
  - Accept: on a real Mac with Tailscale, the agent's commands are only the app binary's `status`
    (and `serve --https=<port> off` to remove), and `clawdling remote ...` (`serve`, `serve-status`,
    `add`, `check`); the private serve path never appears in the chat; `clawdling remote add`
    refuses an address with Funnel on, another app on it, or one that does not reach this
    Clawdling, and leaves `remote.json` unchanged; the server itself only ever runs
    `tailscale serve status --json`.
- **US-55 (P0, Maya; 1.3)** As a founder, "Add a device" shows a QR code I scan with my phone's
  camera; my phone opens the cockpit, I press "Sign in this device", and from then on I use the
  cockpit on my phone, on cellular, as on the computer. The card says when my phone signed in and
  lists it so I can sign it out.
  - Accept: the link is `https://<address>/?pair=<code>`, works once, for 10 minutes, and never
    contains the token; the phone gets a `Secure; HttpOnly; SameSite=Strict` device cookie; the
    cockpit (agents, chat, terminal WebSocket, live updates) works through the remote address; a
    signed-out device can sign out from Settings.
- **US-56 (P0, Rin, Dev; 1.3)** As a skeptic, "Turn off" stops answering every remote address at
  once, signs out every device, and offers "Remove the tunnel too", which opens a chat
  (`/remote-access off`) that removes only what setup added.
  - Accept: after Turn off, open remote WebSockets and event streams close within a second, every
    remote request answers "Use from anywhere is turned off on this computer.", old device cookies
    stay signed out after turning it on again, and after `/remote-access off` the
    `tailscale serve status` output is the same as before setup.
- **US-57 (P0, Rin; 1.3)** As a skeptic, I can check that the long-lived token never leaves my
  computer and that nothing is public: SECURITY.md has the threat model, and the code backs it.
  - Accept: through a remote address the token is refused as a header, a cookie, a `/?t=` link and
    a WebSocket `?t=`; `/api/pair` is refused; only the exact registered `Host` and port are
    answered and only an `https://` same origin may write; ten bad credentials in five minutes
    give `429`; a localhost `Host` with proxy headers is refused; a Cloudflare address that
    answers without Access is never registered, and every request through one needs a valid
    Access token; a malformed `remote.json` turns remote off.
- **US-58 (P1, Hal; 1.3)** As the dad with a domain on Cloudflare, "A web address with a sign-in"
  walks me through `cloudflared tunnel login`, the tunnel, the Access application with my email,
  and the service, and registers the address only after a signed-out visitor is sent to the
  Access sign-in; Settings shows "Behind Cloudflare Access ✓". (Beta.)
  - Accept: against a fake edge, `remote add` needs the owner's `--team-domain` and
    `--access-aud`; a redirect to exactly that team and app passes, a redirect to another team or
    app, a plain 200 or Clawdling's own page is refused as "Not behind Cloudflare Access ✗", and
    a later check that finds Access gone or pointed elsewhere stops the address, signs its devices
    out, and never changes the pins.
- **US-59 (P1, Maya; 1.3)** As a founder checking from my phone alone, Settings on the phone says
  which address I came through, shows each address's last check, lists my devices with this one
  marked, and lets me turn it off, but not turn it on or add devices (those need the computer).
  - Accept: through a remote address, `POST /api/remote/pairing`, adding or removing addresses
    and `{enabled: true}` answer 403 "Only the computer Clawdling runs on…"; `{enabled: false}`
    works; the phone viewport shows the card without horizontal scrolling.

## New in 1.4: answer in the chat, Watching, and pings

The core stories every cockpit on this spec shares are in [CORE-STORIES.md](CORE-STORIES.md)
(CS-01 to CS-30; the end-to-end tests carry their ids). These are 1.4's, with their personas.

- **US-60 (P0, Maya, Dev; 1.4)** As someone working from the chat view, when Claude asks me a
  question (AskUserQuestion) I see the question, its options and their descriptions as a card, I
  pick one (or several, when it asks for any that apply) or type my own answer, and Send; the
  card then shows what I answered, after a reload too. (CS-14, CS-15)
  - Accept: the card comes from Claude Code's PreToolUse hook (the transcript has no line for it
    until it is answered, verified with 2.1.283); answering presses keys only after the screen
    shows that very question with those options; a permission prompt never becomes a card;
    `test/live/questions-live.mjs` passes against the real CLI.
- **US-61 (P0, Maya; 1.4)** As someone who plans first, when Claude has a plan I read it in a
  card and approve it with Claude Code's own choices, or send it back with what to change. (CS-16)
  - Accept: the card names its plan; nothing is pressed unless that plan's approval is on screen;
    a plan sent back followed by a tool permission in the same turn shows the permission's own
    buttons, not a plan card.
- **US-62 (P0, Rin, Maya; 1.4)** As someone who leaves agents running watchers and background
  jobs, a session whose turn is over but whose background work still runs reads "Watching · N",
  not Ready, and a click lists each task's kind, purpose and age. A session that needs me still
  says so, and Watching is never counted as needing me. (CS-19, CS-20)
  - Accept: background shells, async agents, workflows and Monitors from the transcript and its
    sub-agents' files; ends matched by id; only tasks from the session's current process; the CLI's
    own process record (only `<pid>.json`, five fields) decides for shells and watchers; unknown
    is null, never zero.
- **US-63 (P1, Dev, Tom; 1.4)** As someone who switches tabs, I can turn on a browser
  notification for when a session starts waiting on me; it names the agent and the kind of wait,
  never what was asked. (CS-21)
- **US-64 (P1, Dev, Maya; 1.4)** As someone away from the computer, I can turn on one line to the
  chat I paired with Donna when an agent needs me; it is off by default, at most one per session
  every 10 minutes and six an hour, never includes what was asked, and only ever goes to my own
  paired chat or the iMessage handle I saved and texted from. (CS-22)
  - Accept: consent, the paired chat, the proven handle and the send history live in
    `.clawdling/` (agents cannot edit them); an org.json edit never redirects or turns it on; on a
    folder path where agents cannot be kept out of `.clawdling/`, it stays off and says why;
    agent names in messages are the ones shown when it was turned on.


## New in 1.5: the report card

The build brief numbered these US-60 to US-69; 1.4 already uses those numbers, so here they are
US-65 to US-74, in the same order (brief US-60 = US-65 ... US-69 = US-74).

- **US-65 (P0, Lou; 1.5)** Opening a project agent lands on an **Overview** tab with four blocks:
  Done, Needs you, Cost, Next. The Sessions, Context and Memory tabs stay.
  - Accept: Overview is the default tab; each block has an empty state that says what will appear
    there; the page works at 375 px wide; every number has a plain-language label ("about $4.10 of
    usage at list price").
- **US-66 (P0, Lou; 1.5)** **Done** lists, newest first, what each session got done in the chosen
  window (today, 7 days, 30 days): its title, one line of what it did (the agent's own final
  message, trimmed), the files changed, the commits made in the agent's repo, and when it ended.
  - Accept: built from the transcript plus `git log` only; no model call.
- **US-67 (P0, Lou; 1.5)** **Needs you** shows every open question, permission prompt, failed turn
  and finished turn waiting on a reply for this agent, and each opens that session.
  - Accept: the count matches the rail's needs-you badges for this agent.
- **US-68 (P0, Lou, Tom; 1.5)** **Cost** shows the agent's usage in the window as a list-price
  equivalent, by day, with the model split and the top three sessions.
  - Accept: the label always reads "List-price equivalent, not a bill. On Pro and Max, usage is
    included in your plan."; a one-line note says Pro's limits are smaller (shown to everyone:
    Clawdling cannot know your plan without reading your account); the numbers match a
    hand-computed fixture to the cent.
- **US-69 (P1, Lou; 1.5)** **Next** shows the "Next" section of the agent's `memory/NOW.md` (or its
  first five lines), with when it was last updated; a note over 7 days old says so.
- **US-70 (P0, Maya; 1.5)** Every session has a **Timeline** tab beside Chat and Raw: each prompt,
  each tool call (name, one line, duration, worked or failed), subagents nested under their parent,
  and the cost of each turn.
  - Accept: built from the transcript alone; works for a session that has ended; a 2,000-turn
    transcript renders in under a second.
- **US-71 (P1, Dev; 1.5)** The **org map** shows each agent's usage over 7 days and when it last
  finished work, and the org's usage today and over 7 days.
- **US-72 (P1, Maya; 1.5)** **Monday report** (opt-in): one message a week, Monday 08:00 local by
  default, to the Telegram chat or iMessage handle paired with Donna: per agent, sessions done,
  needs-you count and usage over 7 days, plus the most and least used agents.
  - Accept: off by default; turned on in Settings with a preview of the exact text; one a week; no
    file content, prompt text or session title is sent, only counts, approved agent names and
    dollar figures.
- **US-73 (P2, Rin; 1.5)** **Detailed timeline** (beta, off by default): Clawdling also collects
  Claude Code's own OpenTelemetry, and the Timeline shows who approved each tool and API request
  times.
  - Accept: never turned on when the user (or their organization) already has telemetry settings;
    never sends anything off the computer; the report card works the same with it off.
- **US-74 (P0, Sam; 1.5)** **Honest gaps:** when Claude Code deleted a transcript, the report card
  keeps what Clawdling recorded and marks the session "Transcript gone, kept summary only"; a format
  Clawdling has not seen is reported by `clawdling doctor`, never shown as zero.

## New in 1.6: verified done

The build brief numbered these US-70 to US-79; 1.5 already uses those numbers, so here they are
US-75 to US-84, in the same order (brief US-70 = US-75 ... US-79 = US-84).

- **US-75 (P0, Lou; 1.6)** When a session's last message claims completion ("done", "finished",
  "fixed", "implemented", "tests pass", "all green", "builds", "works now", "deployed", "shipped"),
  the message gets a receipt badge in the chat view, and the session's row in the report card's
  Done block shows the same label.
  - **Verified:** a check ran after the agent's last file change and passed; the badge names it
    ("`npm test` passed at 14:02, after the last edit").
  - **Not verified:** no check ran after the last change. The default; not an accusation.
  - **Contradicted:** a check ran after the last change and failed; the badge quotes the first error
    line.
  - Accept: deterministic, no model call; fixture tests cover all three labels and "edit after the
    passing test" (Not verified).
- **US-76 (P0, Lou; 1.6)** A Contradicted claim also appears in **Needs you**, with "Ask the agent to
  fix it", which sends one message into the session: "Your last check failed: `<command>` → `<first
  error line>`. Please fix it and re-run the check." The message is shown before sending.
- **US-77 (P0, Hal; 1.6)** **Ship check setup:** on a project agent, "Set up a ship check" proposes the
  commands detected in the repo (test, build, lint scripts, Makefile and justfile targets), each
  shown exactly with what it does; the owner ticks the ones to allow.
  - Accept: nothing runs until approved; the approved list is saved in `<agent folder>/checks.yaml`;
    changing a command needs approval again.
- **US-78 (P0, Hal, Lou; 1.6)** **Run ship check:** a scratch worktree of the repo (with uncommitted
  changes to tracked files), the approved setup then each check with timeouts, pass or fail, the
  exit code, the duration and the last 40 lines of output, then the worktree is removed. The result
  is the project's newest receipt and can turn a Not verified claim into Verified.
  - Accept: the live repo is byte-identical before and after; the worktree is always removed, even
    after a crash (a sweeper on start).
- **US-79 (P0, Dev; 1.6)** **Agent check-up, drafting:** "Give this agent a check-up" shows the cost
  first; one `claude -p` call drafts five cases from the agent's CLAUDE.md and NOW.md (knows its job,
  its next step, declines out-of-scope work, follows its house rules, remembers its last handoff) in
  plugin-eval format under `<agent folder>/evals/`; the owner reads and edits them in the browser
  before the first run.
  - Accept: the draft never runs by itself; the files use only plugin eval's documented frontmatter
    keys.
- **US-80 (P0, Dev; 1.6)** **Agent check-up, running:** before the run, "This starts N Claude Code runs on
  your plan, about $X list-price equivalent, capped at $Y"; runs in a scratch copy with the agent's
  real context; graders run; the result shows the score, pass or fail per case, the judge's reasons,
  the cost and each run's Timeline.
  - Accept: the cap is enforced (checked before each launch, plus `--max-budget-usd` per run); the
    live agent folder and repo are unchanged; a note for Pro (shown to everyone).
- **US-81 (P0, Rin; 1.6)** **Judge controls on every run:** the judge also grades an empty answer and
  each case's `reference.md`; if it passes the empty answer or fails the reference, the suite shows
  "judge unreliable" instead of a score.
  - Accept: a fixture with a deliberately lenient rubric triggers "judge unreliable".
- **US-82 (P1, Maya; 1.6)** **Try a cheaper model:** the matrix defaults to the agent's model and
  effort, the same model one effort lower, and one cheaper family at medium; the cost is shown
  first; score and cost per cell; the cheapest cell within noise of the current one is recommended
  (at most one case worse at k=1, within the pass^k interval at k=3). "Use this" writes the agent's
  default model and effort to Clawdling's own config (the agent's `agent.json`), never to Claude
  Code's settings.
- **US-83 (P1, Dev; 1.6)** The **org map** shows each agent's last check-up score, its age and its cost
  per run. The report card shows a **Verified** block: the last ship check, the last check-up, and
  the last 7 days' claims by label.
- **US-84 (P2, Rin; 1.6)** `clawdling check <agent>` and `clawdling checkup <agent> [--models a,b]
  [--max-cost 2]` run the same from the CLI, with `--json` and exit codes: 0 pass, 1 fail, 2 the cost
  cap was hit or the judge was unreliable.

## New in 1.7: your CTO

The build brief numbered these US-80 to US-85; 1.6 already uses US-80 to US-84, so here they are
US-85 to US-90, in the same order (brief US-80 = US-85 ... US-85 = US-90).

- **US-85 (P0, Lou; 1.7)** **The CTO seat:** "Add a CTO" on the org map creates a `cto` agent from
  `templates/cto/`: its folder (`<org>/cto/`), CLAUDE.md, `memory/`, `reviews/` and its own narrow
  settings. It sits beside Donna, linked to you, above domains and projects. Starting it is a normal
  Claude Code session.
  - Accept: one click, under 30 seconds; it appears on the map and in the New session list; one per
    org (a second "Add a CTO" is refused, and the id `cto` is reserved for other agents); its
    CLAUDE.md is editable in the Context tab like any agent's, and the CTO itself cannot edit it; the
    seat starts with its own settings file, without your user-level settings or MCP servers, in the
    ask-first mode, and without the org folder added.
- **US-86 (P0, Lou; 1.7)** **"Run this week's review"** on the CTO's Reviews tab first shows the cost
  estimate (a range, list-price equivalent: from the CTO's past sessions, else from its prompt's
  size). Then one CTO session:
  - (a) reads `clawdling report --all --json --window 7d` (schema 2: each agent's computed status
    with its reasons, and every item with a receipt id and a link);
  - (b) writes `cto/reviews/<ISO-week>.md` in the fixed format (title, `Headline:`, one
    `## <agent>: <label>` section per agent with cited bullets, `## Decisions`);
  - (c) asks up to three decisions in one AskUserQuestion call, shown as question cards in the chat
    and in Needs you.
  - Accept (real run): the file exists; it has a section per agent in the report; every bullet cites
    a receipt id; the lint is clean ("N findings, all cited") and every section's label equals
    Clawdling's computed one. A second press while a review runs opens that review instead.
- **US-87 (P0, Rin; 1.7)** **Receipts or it didn't happen:** the review page renders each `[R-…]`
  citation as a link to its receipt (a session, a claim, a ship check, a check-up, a week's usage,
  a needs-you item, NOW.md, a cheaper-model run), and the lint result shows at the top.
  - A bullet with no citation is marked "uncited"; a citation to an id Clawdling does not know for
    that week is marked "no such receipt".
  - A label that differs from Clawdling's, with an `Override:` bullet, shows "Overridden by the CTO,
    here is why: …" beside Clawdling's computed label; without one, it is flagged as a label
    Clawdling did not compute.
  - A citation made early in the week still resolves later that week (the weekly receipt index), and
    the label compared is the one in force when the review was written.
  - Accept: lint fixtures cover cited, uncited, unknown-id and overridden bullets, a missing section
    and an unexplained label change; the review is rendered as text, never HTML.
- **US-88 (P0, Lou; 1.7)** **Decisions become instructions:** when the owner answers a decision card,
  the CTO drafts one short message to the named agent and delivers it with the existing CLI:
  `clawdling send <sid> "<message>"` to its live session (found with `clawdling ls --json`), or
  `clawdling spawn <agent> "<message>"` when it has none.
  - Both are **ask** rules in the seat's settings, so Claude Code's own permission prompt appears
    every time, even if another settings layer or a saved "don't ask again" would allow them. The
    cockpit shows the exact pending command beside the prompt.
  - The review page lists each message and what became of it (sent, declined, did not go through,
    waiting for your yes or no), read from the seat's own transcripts; the CTO also writes
    `Declined: <message>` under Decisions.
  - Accept: no message reaches another agent without that approval; a declined spawn starts no
    session; a declined send is noted in the review.
- **US-89 (P1, Maya; 1.7)** **Optional schedule:** Settings gives "Run the CTO review every Monday at
  08:00" (day, hour and a weekly cap, $2.00 by default), off by default, with the estimated cost of
  one review shown before it is turned on. A separate switch, also off by default, adds the CTO's
  line to the Monday report (1.5): "CTO: <headline>. 3 decisions waiting in Clawdling.", previewed
  exactly, with links removed from the headline.
  - Accept: no scheduled run happens without the opt-in; at most one run per ISO week, counted
    before it starts; turned on after this week's time, the first run is next week; a run whose
    estimate's high end plus the CTO's spend this week would exceed the weekly cap is skipped, once,
    with a notice on the CTO page and in Settings; if Clawdling was not running at the time, the
    review runs at its next start that week. Turning any of this on works only on the computer
    itself.
- **US-90 (P1, Dev; 1.7)** **Ask the CTO anything:** "Ask the CTO something…" (or a new session with
  the CTO) is a normal chat ("should I keep going on the newsletter project?"); it answers from the
  same report, citing receipts, and says "no receipts for that" when there are none.
