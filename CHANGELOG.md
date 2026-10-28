# Changelog

## 1.8.0 (TBD)

**Clawdling 1.8: safe to hand over. Before you hand your agents the keys, Clawdling checks your Claude
Code setup for the lethal trifecta, offline, by name only.**

- **Setup safety.** Settings' "Your Claude Code setup" opens with a Safety section: every agent
  (Donna, the CTO, domains, projects) and "Everything (user level)", each with three chips, private
  data, untrusted input and sends out, that name what gives each one and the file it comes from. An
  agent with all three shows **Lethal trifecta** (Simon Willison's term), one sentence of what could
  happen, and up to three fixes as text from the leg that is cheapest to cut. Clawdling changes
  nothing. Accept a risk with a reason (kept on your computer, shown amber), or say what an unknown
  MCP server or plugin does.
- **Exactly what each agent loads.** Your settings, managed settings, the session folder's own
  `.claude/settings.json` and `settings.local.json` (Claude Code reads no other folder's), your MCP
  servers and the repo's `.mcp.json`, your plugins, and the permission mode Clawdling starts it in:
  your own auto mode does not reach an agent that asks first, and the audit knows. Donna's text
  turns load none of your setup and only your paired chat reaches them; the sessions you open with
  her in the cockpit load it like any agent's. Her row covers both, and says so.
- **Tools that skills grant themselves.** A skill's or command's `allowed-tools` and a subagent's
  `permissionMode` count like allow rules and modes, from their frontmatter only; a repo's own
  skill, command or subagent that grants tools is a setup risk.
- **Setup risks, each with its file:** a SessionStart hook in a repo's own settings (the npm-worm
  vector), bypass permissions or auto mode, an MCP server a repo defines, a `settings.local.json` no
  `.gitignore` covers, a plugin from a marketplace other than Anthropic's official one.
- **Names only, and nothing else.** Rule text redacted before it is classified or shown, MCP server
  keys with their command basename, first package and URL host, plugin names; never an `env` value,
  a header, a hook command, an API key helper or a URL past its host. No socket, no process (not even
  `gh`), a few milliseconds; 200 agents well under 3 seconds. Unknown names are "unknown: review",
  never green; green means "no trifecta found by name", never "secure".
- **Shields.** Green, amber or red on every org-map node (the owner's carries the user level), in its
  side panel and on each report card. The CTO's schema 2 report gains `agents[].safety` with an
  `R-safety-…` receipt (an additive field).
- **`clawdling discover --setup --safety [--json]`**: the same audit in a terminal, offline.
- **The update guard: `clawdling doctor --contract`.** Checks the installed Claude Code against
  `server/claude-compat.json` with no model call: the version range, every flag Clawdling passes
  (including the two `--help` hides, through the argument parser), the hook events it registers
  (`claude doctor`'s own settings check of a probe file, which a made-up event proves ran), the
  newest transcript, and the `-p` flags check-ups use. `--live` runs one haiku session (about $0.01,
  shown first) with Clawdling-style hooks, checks the events, the transcript and its cost, then
  `claude purge` deletes it.
- **Checked against every Claude Code release.** A workflow, twice a day, installs the newest Claude Code
  on Linux, macOS and Windows runners and runs the contract: a pass opens a pull request that bumps
  `maxChecked`, a break opens "Claude Code <ver> breaks <check>". Dry-run on 2026-10-27: 2.1.312
  passed on all three; a planted break opened its issue. The README badge reads the compat file.
- **"Newer than the last version checked."** When your Claude Code is newer than `maxChecked`, the
  cockpit says so once per version, dismissibly, and never blocks a start.

- **Tests.** 770 unit and integration tests on each backend (tmux: 762 pass, 8 skipped; built-in
  terminal: 763 pass, 7 skipped), 193 e2e against the mock server (2 skipped) and 64 against the real
  server, 0 failing. New: `test/unit/safety.test.js` (the table, every scope and risk, planted secrets
  in every field, the audit with sockets, DNS and child_process stubbed to throw, a 200-agent org,
  a hostile `.gitignore`, hundreds of linked skill folders), `test/unit/claude-contract.test.js` (help,
  parser and doctor fixtures from 2.1.283, 2.1.304 and 2.1.308, doctored breaks, the live check),
  `test/integration/safety.test.js`, `test/e2e/safety.spec.js`.
- **Real run** (a throwaway home, a leased plan, the real Claude Code 2.1.308): a repo with a
  SessionStart hook and `Bash(curl:*)`, `WebFetch` allowed and a mail MCP server with a fake secret
  in its env: the project agent is red with all three chips and the SessionStart risk, the CTO's
  report carries the same verdict, the fake secret is in no output, log or file, and the first audit
  arrived 0.6 s after start. `doctor --contract --live`: every line ok, nothing left behind.
- **Stand-in adversarial review** (in place of the GPT review, quota): a fresh `claude -p --effort
  xhigh` with a security-and-correctness brief wrote a probe test for each finding. Round 1 found 4
  Mediums (a repo hiding its settings, `.mcp.json` or skill grants by making them too big to read; rules
  past the 300th dropped; a repo of subagent grants stalling the server; terminal escapes in file names
  reaching the CLI) and 4 Lows; all fixed at the root, and its 8 probes are now permanent tests
  (`test/unit/safety-probe-*.test.js`).
- **Reviews.** The audit had the top tier: thirteen rounds of a fresh `claude -p --effort xhigh`
  reviewer, each Medium fixed, until it passed; the update guard had a `high` reviewer (passed in
  round 4). The second-model (GPT) review is still owed: both ChatGPT plans were out of quota. The
  open Lows are issues #55 to #63. A third-party visual review passed US-91 to US-94 and US-98.

## 1.7.0 (2026-10-27)

**Clawdling 1.7: your CTO. Every Monday it reads your projects' receipts and asks you three questions.**

- **The CTO seat.** "Add a CTO" on the org map makes a seat beside Donna, from `templates/cto/`: its
  folder, its CLAUDE.md (editable like any agent's; the CTO cannot change it), `reviews/` and its own
  narrow settings. Starting it is a normal Claude Code session on your plan.
- **Run this week's review.** The cost first (a range, list-price equivalent, from the CTO's past
  sessions or its prompt's size), then one session that reads `clawdling report --all --json`,
  writes `cto/reviews/<ISO-week>.md` in a fixed format (a headline, a section per agent with cited
  bullets, the decisions), and asks up to three decisions as question cards, in the chat and in
  Needs you.
- **Computed status.** On track, At risk, Stalled or Quiet for every domain and project, worked out
  by Clawdling from receipts with fixed rules, never by the model. Priority: At risk (an open
  Contradicted claim, a failed ship check, a check-up score down 20 points, usage up 50% while
  finished work is not, something waiting on you 48 hours), then Stalled (projects only), then On
  track, then Quiet. Each label carries its reasons, each with a receipt. Five thresholds are tunable
  in Settings, including a $1 a week floor so cents doubling is not "usage up".
- **Receipts or it didn't happen.** Every item in the new report has a stable id,
  `R-<kind>-<8 hex>`, hashed from what the item is. The review page turns each citation into a link
  to that session, claim, ship check, check-up or usage row; marks a line with no citation
  "uncited" and an id that does not exist "no such receipt"; and shows a label the CTO changed as
  "Overridden by the CTO, here is why: …" beside Clawdling's own. The lint result sits on top ("14
  findings, all cited"). Each report adds its receipts and labels to a weekly index, so a Monday
  citation still resolves on Thursday.
- **Decisions become instructions.** After you answer, the CTO drafts one message per agent and
  delivers it with `clawdling send` (a live session) or `clawdling spawn`. Both are ask rules in the
  seat's settings, and the seat's own PreToolUse hook answers "ask" for any command but the report
  and the session list and for any write outside its reviews, so Claude Code's own prompt shows
  every time, even over an allow rule from another settings layer or a saved "don't ask again"; the
  cockpit shows the exact pending command beside it. What was sent, declined or failed is read from the seat's own transcripts, and the CTO
  notes a declined message in the review.
- **Ask the CTO anything.** A normal chat answers from the same report, citing receipts, or says
  "no receipts for that".
- **`clawdling report --all [--json]`**: the whole org as `"schema": 2`, each agent's
  computed status and every item with a receipt id and a cockpit link (`#/s/<sid>` opens a session).
  Agent-written text in it (titles, last lines, NOW.md) is capped, one line, stripped of control
  characters, and cannot look like a citation. Its shape has a golden file,
  `test/fixtures/report-schema2.golden.json`.
- **Optional, off by default:** a weekly review (Monday 08:00 by default, at most once per ISO week,
  skipped with a notice when the CTO's spend this week plus the estimate's high end would pass your
  weekly cap, $2.00 by default; turned on after this week's time, it starts next week; while it runs
  unattended its spend is checked every minute, and it is ended, resumable, past the cap or when its
  spend cannot be counted, until you act in it), and the
  CTO's line in the Monday report, its own switch, previewed exactly, with links removed from the
  headline.
- **How the seat is locked down.** It starts with its own `--settings` file written into
  `.clawdling/` (out of agents' reach), `--setting-sources project` (neither your user-level
  settings nor a saved "don't ask again" load), `--strict-mcp-config` (no MCP servers), always the
  ask-first mode, and without the org folder added. Its own hook check lets it run only plain
  `clawdling report` and `clawdling ls` (exact options, never `--home` or `--port`) and write only
  `reviews/<week>.md` without asking; it takes instructions from you only, and its words go only to you (agents and Donna cannot start, message, answer for or read it, nor touch its folder; the cockpit offers one-tap answers only for one plain message); the web, its own CLAUDE.md and its settings are denied; everything else asks.
  Its hooks report every tool call, and the hook script forwards only the tool's name and id, plus
  the command of a `clawdling send|spawn`. Adding the seat, starting a review and every CTO setting
  work only on the computer itself; a paired phone can read reviews and answer the CTO's prompts.

Reviews: top tier, because the seat can message other agents and the schedule spends your plan.
A fresh Claude reviewer at `xhigh` failed rounds 1 to 12, every Medium fixed, and passed round 13
(no Medium or higher; its Lows are issues #51 and #52). The normal-tier reviewer (Claude, `high`)
passed round 7 (Lows: issues #47 to #50). A third-party visual review of the real run's screenshots
passed round 2. The GPT (Codex) second-model review could not run (both ChatGPT plans out of
quota), so a fresh Claude `xhigh` reviewer with an adversarial brief stood in for it, writing a
probe test for each finding: rounds 1 and 2 failed (a Medium each, both padding tricks in seat
commands, plus Lows; all fixed, and its 14 probes are now permanent tests), round 3 passed (Lows:
issues #64 to #68). The GPT review is still owed and will follow.

Tests: 730 per backend (tmux: 722 pass, 8 skipped; pty: 723 pass, 7 skipped; 0 failed); end to
end 179 pass against the mock server and 61 against the real one. New unit suites `status-rules` (every rule, its window edges, flat cost, a new agent,
At risk over Stalled, domains never Stalled) and `cto` (receipt ids, agent text, the index, the
lint, the seat's permissions on POSIX and Windows, the launch settings, the transcript scan, the
Monday line); integration `cto` (an org in every state, the schema 2 golden shape, Add a CTO, the
seat's launch flags, a full review with one approved send and one declined spawn, the lint's flags,
the schedule and its cap). Real run, on Claude Code 2.1.308 in a fresh home with three agents: Add a
CTO in under 30 s; a review with 6 findings, all cited, its labels equal to Clawdling's (notes-app
At risk on a failed ship check, ar-justify On track on a verified claim, Health Quiet); one decision
answered, one bound message approved and delivered, nothing sent unasked; about 2 minutes and
$0.38 list-price. Also fixed: the iMessage poller now waits out a chat.db write lock instead of
failing (it was a macOS CI flake).

## 1.6.0 (2026-10-27)

**Verified done: when an agent says it is done, you see whether its record backs that up.**

- **Claim receipts.** Under an agent's "done", "fixed", "tests pass" or "builds", one label read from
  the session's own record: **Verified** (a plain run of the check, `npm test` or your approved
  command, passed after the agent's last change, and nothing after it could have changed the work),
  **Contradicted** (a plain run failed after the last change, with output showing checks that ran and
  failed), **Not verified** (the default: no check, or a record that cannot tell, such as a piped or
  chained run, only some tests, or a script that ran afterwards), or **No changes made**. A
  Contradicted claim waits in **Needs you**, and **Ask the agent to fix it** sends one message you
  see first. No model is asked whether the work is done, and nothing runs to label a claim.
- **The ship check.** Pick, once, the commands that prove a project works. Each is shown exactly,
  with what it does, and runs only after you approve it, in a scratch git worktree of the repo (your
  live repo is never touched), with credentials and the org `.env` kept out, every git filter and
  hook switched off, and a private temp folder. A pass can verify a claim the session left
  unchecked; a failure keeps claims Not verified (the copy is not the agent's environment, so it
  never marks a claim Contradicted on its own).
- **Agent check-ups.** Five questions drafted from the agent's own files (its job, its next step,
  what is not its job, its house rules, its last handoff), in the format of `claude plugin eval`.
  You read and approve them first; each runs with `claude -p` in a scratch copy of the agent with
  read-only tools, on your plan, with the cost shown first and a hard cap. A judge model grades
  answers three times, and before any agent run it must fail an empty answer and pass each reference
  answer, or the suite says "judge unreliable" and spends nothing more.
- **Try a cheaper model.** The same cases on cheaper models and efforts, scored and priced; the
  cheapest that holds is recommended, and "Use this" changes only the agent's own `agent.json`.
- **Everywhere:** a Verified block on the report card, each agent's last check-up on the org map,
  and `clawdling check` / `clawdling checkup` for scripts (exit codes 0, 1, 2).

Reviewed in fifteen rounds by Claude (`xhigh`) and sixteen by GPT Codex, then by a third-party visual
review of US-75 to US-83 on a real run. The claim rules lean to Not verified whenever the record
cannot tell; known limits are tracked as GitHub issues.

Tests: unit + integration on both backends (tmux 636 passed, pty 637 passed, 0 failed), 187 e2e
(desktop and phone WebKit), CI green on Ubuntu, macOS and Windows (node 20 and 22). Real run with
Claude Code 2.1.308 on a public repo: Verified, Not verified and Contradicted where they should be,
a check-up result 3 minutes 21 seconds after Run, and the live repo byte-identical throughout.
## 1.5.2 (2026-10-26)

**Two fixes for what a viewer sees first: the org map and the report card.**

- **The org map no longer draws a lone project over "You"** (issue #29). With exactly one project,
  the map's layout never gave it an angle, so the project, its name and its usage line ("$0.16 ·
  just now", or "nothing done in 7 days" on a new org) were drawn at the centre, over your own
  disc. It now sits on the outer ring like any other project. New e2e checks, at 1440 and 390 wide
  in dark and light, on a new org and a busy one: nothing on the map overlaps your disc.
- **The report card leads with the outcome, and a tool error along the way is no longer a warning**
  (issue #31). A session that searched for a file that wasn't there, read one that didn't exist
  yet, then passed its tests showed amber "2 steps hit an error along the way", and the closing
  line was cut before "go test ./... passed". Now:
  - a check result in the agent's closing message (the last sentence that says tests, a build or
    a lint passed or failed; not a plan, an instruction or a check it did not run) is the row's
    first line, in the agent's own words and whole up to 300 characters; the rest of the closing
    line follows it, without repeating it;
  - the count of tool calls that came back with an error (a search that matched nothing, a
    permission you declined) reads "2 hiccups along the way", in the same quiet grey as the file
    count. A failed check still says so in the outcome line, and the Timeline lists each error.

  Sessions already counted before 1.5.2 keep their saved closing line; the outcome line shows for
  sessions that end from now on.

## 1.5.1 (2026-10-26)

**Two fixes found while filming the 1.5 demo with Claude Code 2.1.308.**

- **The plan card shows the plan again** (issue #21). Claude Code 2.1.308 calls `ExitPlanMode` with
  an empty input and keeps the plan in its own plan file, `<config folder>/plans/<name>.md`, which it
  writes (and rewrites) just before. The card now reads the plan from there: the session's last write
  to that file, read only inside that `plans` folder (a `.md` file whose real path is in it; a link
  that leads out of it is not followed). The 2.1.283 shape, with the plan in the input, works as before. New contract
  fixtures: a real 2.1.308 plan session (scrubbed) and the empty-input shape; the live check
  `test/live/questions-live.mjs` now also fails on an empty plan card.
- **Donna answers "what got done today, and what needs me?" from the report card.** Her text-message
  turns could not run `clawdling report` (added in 1.5 for agents' sessions, not for her), and her
  prompt carried only the live sessions, so she said not much was finished and that her access was
  denied. Now `clawdling report` (read-only) is on her allow-list, and each turn carries "today so
  far" from the report card: per agent, the sessions with work done (title and the agent's own last
  line), what waits on you, and the usage. Nothing she can change or send grew: no new write, remote
  or channel command. New live check `test/live/donna-live.mjs` asks her exactly that question with
  the real Claude Code (it failed on 1.5.0 and passes now).

## 1.5.0 (2026-10-25)

**The report card: what got done, what it cost, what needs you. In plain words, on your own machine.**

- **Overview, the new first tab of every agent.** Four blocks, for today, 7 days or 30 days:
  **Done** (each session that did some work, in the agent's own closing words, with the files it
  changed and the commits it made in the repo), **Needs you** (exactly what the rail counts; one tap
  opens the session), **Cost** (a list-price equivalent by day and by model, with the top sessions,
  always labelled "not a bill", and a note for Pro) and **Next** (the agent's next steps from its
  `memory/NOW.md`, and how fresh they are). It works on a 375 px phone. No model is called: it is
  read from Claude Code's own transcripts, `git log` and the agent's memory.
- **Timeline**, a tab beside Chat and Raw on every session: each prompt, each tool call with how
  long it took and whether it worked, subagents indented under the call that started them, and
  what each turn used. Works for ended sessions; a 2,000-turn session shows its first page at once.
- **The org map** shows each agent's last 7 days and when it last finished work, and the org's
  usage today and over 7 days.
- **Honest numbers.** Usage is counted once per API message (one message is often split over
  several transcript records). Claude Code's own `cost-state` total wins when it is current;
  otherwise the usage is repriced with a dated price table bundled in `server/prices.json` (checked
  against the CLI's own figures; CI fails when it is over 120 days old). A model the table does not
  know is "cost unknown", never 0. When Claude Code deletes an old transcript, a small summary in
  `.clawdling/ledger/` keeps the card true ("transcript gone, kept summary only").
- **`clawdling report [agent] [--window today|7d|30d] [--json]`**: the same card in the terminal;
  its JSON is versioned (`"schema": 1`) for scripts and the coming CTO seat. Agents may run it
  without a prompt. `clawdling doctor` gains a "transcript format" line.
- **Monday report** (off by default): Settings shows the exact message first; once a week it goes
  to the Telegram chat or iMessage handle you paired with Donna, through the same sender and rules
  as the needs-you ping. Counts, approved agent names and dollar figures only: never a session
  title (titles come from first prompts), a prompt or a file.
- **Detailed timeline** (beta, off by default): Claude Code's own OpenTelemetry, sent only to
  Clawdling on `127.0.0.1`, adds who approved each tool and each turn's request times to the
  Timeline. It never turns on where your Claude Code (or your organization) already has telemetry
  settings: a preflight reads setting names, never values. The ingest takes only this computer,
  with a secret made when you turn it on, and drops account identifiers and prompt or response
  fields (see SECURITY.md).
- **Tests.** 502 unit and integration tests on each backend (tmux, built-in terminal), 153 e2e
  tests against the mock and 60 against the real server on each backend. New unit suites `ledger`,
  `contract` (synthetic transcripts with hand-worked totals),
  `otel` (a real 2.1.308 telemetry capture, scrubbed) and `digest`; integration `report` and `otel`
  on both backends (the `/otlp` rules: no secret, wrong secret, remote address, proxy, Origin, too
  large, too fast); e2e `report.spec.js` (desktop) and a 375 px phone check, against the mock and the
  real server. The e2e real server now runs with its own `CLAUDE_CONFIG_DIR`.
- **Reviews.** The `/otlp` ingest and the Monday report had the top tier, a fresh `claude -p --effort
  xhigh` reviewer and a second-model (GPT) reviewer, for eight rounds until both passed with no
  Medium or higher open. What they changed: each session gets its own telemetry credential and its
  own `--settings` file; the preflight runs before every launch, reads only key names, never follows
  a link and covers every agent folder and the exact Claude folder of the launch; the tmux launcher
  clears telemetry variables a long-lived tmux server may carry; uploads are bounded in size, count,
  time and rate; enabling the Monday report is bound to the names the owner saw. The rest had a
  `high` reviewer for thirteen rounds (cost that is unknown never reads as \$0; receipts survive
  `/clear` and `/resume` without double counting; commits are credited only to the session that ran
  `git commit`). A third-party visual reviewer judged the ten new stories, and the plain-language
  check, from screenshots as Lou, until all passed. Open Lows are GitHub issues.
- **Real run.** A throwaway home, a leased plan and the real Claude Code 2.1.308 on a public repo
  (golang/example): the folder-trust question answered, only `go test` approved; the card showed
  the session in Done with its file change, and a cost equal to Claude Code's own `cost-state`
  total; with the detailed timeline on, the records arrived under Clawdling's session id and the
  Timeline said "you allowed it once".

## 1.4.0 (2026-10-25)

**Answer Claude in the chat, know when "Ready" really means done, and hear when an agent needs you.**

- **Question cards.** When Claude asks you something (AskUserQuestion), the chat view shows the
  question and its options, with their descriptions, as a card: pick one, tick several when it asks
  for any that apply, or type your own answer, then Send. Several questions go in one Send. When
  Claude has a plan ready, the plan shows as a card with Claude Code's own choices: approve it, or
  send it back with what to change. Cards keep what you answered (after a reload too) and work on a
  phone. Answers go through the same route as the trust and permission buttons, and are typed the
  way you would: the screen must show that very question (or plan) before any key is pressed.
  Tool permissions answer exactly as before; a card can never approve one.
  - Found with a real Claude Code 2.1.283: the question's line reaches the transcript only after
    it is answered, and a plan sent back fires no PostToolUse. Sessions therefore register
    PreToolUse and PostToolUse for `AskUserQuestion|ExitPlanMode` only, and the card is taken from
    there. `test/live/questions-live.mjs` checks a question, a typed answer that starts with a
    digit, and a plan sent back, against the real CLI.
- **Watching · N.** A session whose turn is over but whose background work is still running
  (Monitor watchers, background commands, background agents, workflows, including ones a
  sub-agent started) reads **Watching · N** on its pane, the rail and the phone, not Ready. Click it
  for the list: kind, what it is for, when it started, when a watcher ends by itself. A session
  that needs you still says so, Ready means nothing is running, and Watching never counts as
  needing you. Read from the session's transcript and Claude Code's own per-process record (only
  `~/.claude/sessions/<pid>.json`, five fields); unknown is shown as nothing, never as zero.
- **An agent needs you.** Settings, "When an agent needs you": a browser notification while the
  cockpit is in the background, and, optionally, one line to the Telegram chat (or iMessage
  handle) you paired with Donna: "Clawdling: Health needs you (a question). Open the cockpit to
  answer." Both are off by default and never say what was asked. The message goes only to the
  chat that sent the pairing code, or the iMessage handle you saved and texted from; at most one
  per session every 10 minutes and six an hour. Its switch, the pairing proof and the send
  history live in `.clawdling/`, where agents cannot edit them (see SECURITY.md). Telegram
  pairings from before 1.4 pair once more to use it.
- **Docs.** [docs/CORE-STORIES.md](docs/CORE-STORIES.md): 30 core user stories (CS-01 to CS-30)
  that the end-to-end tests carry in their titles. [docs/PARITY.md](docs/PARITY.md): which core
  features Clawdling and its sibling cockpit each have.
- **Fixes.** `clawdling doctor` and `clawdling donna status` no longer print the Telegram pairing
  code; the iMessage send script takes `--` before its arguments, and a handle can no longer start
  with `-`.
- **Tests.** New: `test/unit/questions.test.js` (real 2.1.283 screens), `background.test.js`
  (redacted real transcripts), `needs-you.test.js`; `test/integration/questions.test.js` and
  `needs-you.test.js` on both backends; `test/e2e/cards.spec.js` (desktop and phone). Reviews: the
  question cards and Watching each had an independent review at high effort (their High and
  Medium findings fixed and re-verified); the ping had the top tier, a fresh `claude -p --effort
  xhigh` reviewer and a second-model reviewer, until both passed with no Medium or higher open.
- **Not yet in the iPhone app** (#10): it still shows the generic needs-you banner and Ready.

## 1.3.1 (2026-10-25)

**Windows: the cockpit no longer crashes when a session ends** (#4).

- **The crash.** On Windows (the built-in terminal, node-pty 1.1.0), ending a session whose
  Claude Code had just exited could take the whole Clawdling server down with an access violation
  (`0xC0000005`), after node-pty printed "AttachConsole failed". Every open session went with it.
  The cause is in node-pty's native ConPTY code: each session's exit thread removes the session
  from a shared list with no lock while the main thread reads the same list, and a kill sent after
  the shell exited runs a helper against a console that is gone.
- **The fix.** node-pty now runs in its own child process, the *pty host*. If it ever crashes,
  only the host goes: Clawdling keeps running, marks the sessions it held as ended with a note
  ("Clawdling's terminal process stopped unexpectedly…"), and the next session starts a new host.
  Resume picks each one up where it left off. The host also never kills or releases a ConPTY
  whose process has already exited.
- **Evidence.** A new Windows CI job (`test/stress/conpty-kill-exited.mjs`, 30 rounds of six
  sessions ended right after they exit) shows the 1.3.0 behaviour dying, and the pty host
  surviving every round. node-pty's bundled `conpty.dll` option was tried and crashed faster, so it
  is not used.
- **Tests.** The guard, the host protocol, a host that dies (its sessions end with a reason, the
  next session gets a new host), and ending sessions whose claude just exited, at the server level.
- tmux sessions, and the built-in terminal's behaviour on macOS and Linux, are unchanged.

## 1.3.0 (2026-10-25)

**Use from anywhere.** Open your cockpit from your phone or another computer, away from home. Off
until you turn it on, in Settings.

- **Two ways, both private.** "Just my devices" (recommended) uses Tailscale, free for personal
  use: a private network between your own devices, nothing on the public internet. "A web address
  with a sign-in" (beta) uses a Cloudflare Tunnel on your own domain with a Cloudflare Access
  email sign-in in front. There is no cloud copy: the cockpit has to run on the computer where your
  Claude Code and files live. Clawdling still listens on `127.0.0.1` only.
- **Set it up with an agent.** One button opens a setup chat (a Claude Code session on your own
  plan) whose first message you see before it starts: `/remote-access tailscale`. The new
  `/remote-access` skill explains the plan, asks before each install or change, leaves every
  sign-in to you in your browser, never turns on Tailscale Funnel or touches other serve entries,
  and handles the macOS Homebrew symlink crash, the tailnet's HTTPS certificate switch and the
  Linux operator setting. `/remote-access off` removes only what it set up.
- **Only your own devices.** Tailscale requests must carry your own Tailscale login and arrive
  through the serve entry's private path (`clawdling remote serve` sets it up without ever
  printing it), so another person on a shared tailnet, or a program connecting to the cockpit's port
  directly, gets nothing; the cockpit must also be the only thing served on its address.
  Cloudflare is pinned to the Access team and application you give at `remote add`; a sign-in
  redirect anywhere else stops the address and signs its devices out.
  Cloudflare pins your Access email the same way.
- **Never public.** `clawdling remote add` registers an address only after a check passes:
  Tailscale Funnel off and the address reaching this cockpit, or, for Cloudflare, a signed-out
  visitor sent to the Access sign-in. Every request through a Cloudflare address must also carry a
  valid Cloudflare Access token, so removing Access later cannot expose the cockpit.
- **Pair a device.** "Add a device" shows a QR code with a one-time link (10 minutes, one use).
  It never holds the cockpit's private token: through a remote address that token is refused in
  every form. The phone gets its own sign-in (a `__Host-` cookie that is `Secure`, `HttpOnly` and
  `SameSite=Strict`, plus a key in the page's own storage, 30 days), listed in Settings with a
  Sign out button. Ten failed sign-ins in five minutes pause
  new attempts on that address.
- **Status and Turn off.** Settings shows each address with its last check: "Private to your
  devices ✓", "Behind Cloudflare Access ✓" or "Not reachable". Turn off stops answering at once
  (open terminals and live updates through it close), signs out every device, and offers "Remove
  the tunnel too".
- **CLI:** `clawdling remote list|check`, `clawdling remote tailscale-name`, `clawdling remote serve
  <https-url>`, `clawdling remote serve-status`, `clawdling remote add <https-url> --kind tailscale|cloudflare [--email
  you@example.com --team-domain <team>.cloudflareaccess.com --access-aud <tag>]`,
  `clawdling remote remove <url>|--all`, `clawdling remote off`. Donna's
  text-message turns cannot run them.
- **Safer by default, for everyone:** a request with a localhost `Host` that came through a proxy
  (proxy headers present) is refused, so a tunnel that rewrites the `Host` header can never make
  a remote request look local.
- API: `GET /api/remote`, `POST /api/remote/hosts`, `/remove`, `/check`, `/enabled`, `/pairing`,
  `/pair`, `DELETE /api/remote/devices[/<id>]`. The iPhone app is unchanged in this release; the
  server already accepts an app's device sign-in (`{client: "app"}`), and pairing the app through
  a remote address is the follow-up.
- Tests: 51 new (address rules, remote.json integrity, devices, pairing, throttle, the Tailscale
  and Cloudflare checks, Access tokens, the setup chat's guard, end to end against a real server
  behind a fake tunnel and Cloudflare edge) and 17 new browser tests. The suite is 363 tests under
  each session backend, plus 137 browser tests. Also run for real on a Mac with Tailscale: a
  Claude Code setup agent driven through Settings set up, checked and removed the serve entry
  (serve status identical before and after), and a desktop browser and a phone-sized one
  (Chromium and WebKit) paired and used the cockpit over the tailnet. Two independent security
  reviews (Claude and GPT) pass, and every 1.3 user story passed a third-party visual review.

## 1.2.0 (2026-10-24)

**Bring in your projects.** Clawdling finds the projects you already have and turns the ones you
pick into project agents with real starting context.

- **Discovery, read-only and local.** `clawdling discover` (and the cockpit's new "Bring in your
  projects" card) looks at folders where you've used Claude Code before, git repos under `~/code`
  and similar folders, and your GitHub repos through your own `gh`, if it's signed in. Nothing
  leaves your computer; GitHub is reached only through your own `gh` command, and Clawdling never
  reads, stores or passes a GitHub token. The setup scan behind it (also `clawdling discover
  --setup`) returns names and descriptions only: never an MCP server's env, headers, args or
  command, never a hook's command, never a credential.
- **Real starting context, not an empty folder.** An imported project agent's `CLAUDE.md` is
  drafted from the repo's README and its install/test/dev/build commands; its `NOW.md` is seeded
  from the repo's recent commits and its open issues and pull requests. Sessions run in the repo
  itself. Importing never writes into the repo: everything Clawdling writes lives under the org
  folder, and cloning a not-cloned repo only ever creates a new folder.
- **The import screen.** Tick the projects you want (recent ones on this computer are
  pre-checked), pick a domain, and click **Create N project agents**. A repo you haven't cloned gets a one-click clone into
  `~/code/<name>`. Pick several small repos and **One agent for these N** makes one agent that
  covers all of them. A repo that already has an agent is skipped.
- **Deep onboard.** After an import, **Deep onboard** starts a real Claude Code session, on your
  own plan, that reads the repo and rewrites the agent's notes properly.
- **Your Claude Code setup, visible.** Settings has a new "Your Claude Code setup" card, and the
  org map has a matching toggle: the skills, subagents, MCP servers and hooks every agent
  inherits, by name only, plus what each project's own repo adds. **Make it a standing agent**
  turns any of your Claude Code subagents into a domain agent, with a note on where it came from.
- **Donna** can run `clawdling discover` and propose an import from a text message, but cannot
  create the agents herself: that still needs the cockpit, or your own `clawdling import --yes`.
- **CLI:** `clawdling discover [--json] [--no-github] [--setup]`; `clawdling import
  <name|path|owner/repo>... [--recent] [--domain <id>] [--clone] [--group "Name"] [--yes]`.
  Without `--yes`, `import` prints the plan and creates nothing.
- **Safe with other people's repos.** Inside a repo, Clawdling reads a file only if it really
  lives in the repo (a `README.md` symlinked to `~/.netrc` is not read). Text anyone can write on
  a public repo (commit subjects, issue titles, the README, the GitHub description) goes into an
  agent's notes as data: one line each, no backticks, every `@` made harmless so nothing becomes
  a CLAUDE.md file import, and an agent's mission is never taken from it. `git log` runs with
  signatures, pagers and fsmonitor off, so a repo's own `.git/config` cannot make it run a
  program. Remote URLs never carry an embedded token. Imports in one org take a lock.
- Discovery runs in a worker thread, so a big home folder never stalls your terminals; its answer
  is cached for 30 seconds and cleared whenever the org changes.
- Agent icons match whole words ("readiness" is not about reading).
- API: `GET /api/discover`, `GET /api/setup`, `POST /api/import`, `POST /api/setup/promote`.
  Agents carry `source` (where an import or a promoted subagent came from) and `repos` (one
  agent for several repos).
- Tests: 111 new (discovery 46, including planted-secret and symlink tests; import 35; stack
  detection 11; git metadata 8; end to end against the real server and the CLI 11) and 22 new
  browser tests. The suite is 312 tests under each session backend, plus 120 browser tests. Also
  run for real: 10 GitHub repos imported as 10 agents in about 23 s, a Claude Code session in an
  imported repo answering "what is this and how do I run its tests" from its notes, and Deep
  onboard; every 1.2 user story passed a third-party visual review.

## 1.1.1 (2026-10-23)

Fixes from the first strangers and newcomers to install 1.1.0.

- **"Ask before editing files" now asks.** A Claude Code started with no `--permission-mode`
  opens in auto mode (2.1.283 and newer), so every 1.1.0 session ran in auto mode whatever the
  interview said. Every choice now passes the mode it names, by the name the installed `claude`
  lists in `--help` (`manual`, or `default` on older versions). This fixes orgs made by 1.1.0
  too: nothing to redo. The agent page says what each agent may do without asking. A new opt-in,
  `inherit`, passes no mode, so your own Claude Code setting applies.
- **Not signed in is no longer a dead end.** The session says "Claude Code isn't signed in yet.
  Click Sign in, then follow the browser steps." **Sign in** opens a session where Claude Code
  runs its own browser sign-in, for your own login or a second account. **Start again** then
  restarts the stuck session with the new login, and keeps a first message it never got to. The
  terminal (`claude auth login`) is still mentioned, second.
- **The trust card stays until your org folder is trusted.** A reload used to hide it. If Claude
  Code is already asking, the card says so and answers it in one click.
- **Plain first-run words:** "Every agent is a real Claude Code session that already knows its
  job and remembers what it did."
- **A first message is no longer lost** when an agent card's session opened behind the New
  session dialog and you pressed Escape: the keyboard now goes to the new session.
- **Agents' file tools can't read or edit `<org>/.clawdling/`**, where the owner token lives
  (deny rules in every session's settings and Donna's turns). See SECURITY.md for what an
  approved shell command can still do.
- `init` accepts `"later"` for `donna.channel` (the same as `none`). `permission_mode` is `ask`,
  `acceptEdits` or `inherit`; `default` and `manual` still mean ask.
- API: `POST /api/sessions/:sid/restart`; `POST /api/accounts/default/signin`; sessions carry
  `live_mode` and `signed_in`; `/api/org` carries `org_trusted`; `/api/health` carries
  `permission_modes`.
- Tests: two CI flakes fixed (a pty echo race in the test's own program, and a reused kept-alive
  socket on Windows). The live smoke test fails if a session runs in auto mode.

## 1.1.0 (2026-10-23)

**Launch features**

- **Clean chat view, the default.** Each pane shows the conversation as chat: your messages and
  Claude's replies with markdown (code blocks, tables), each tool call as one line you can expand,
  live as the transcript grows, with a message box at the bottom. The terminal is one click away
  (Chat | Raw, remembered per pane). A brand-new session shows the terminal until Claude Code has
  started; permission and trust questions keep their one-tap buttons.
- **Model and effort per pane.** The new-session dialog has optional Model and Effort choices
  (claude's own `--model` and `--effort`); nothing is forced, so your Claude Code defaults stay
  yours. The chips in a pane's header show what the session runs and change it between turns:
  that session's `claude` is resumed on the same conversation with the new flags, for that
  session only (a typed `/model` would also save it as your default for new sessions).
- **Voice input.** A mic button in the message box uses the browser's own speech recognition
  (hidden where the browser has none, such as Firefox). It fills the box for you to check; it
  never sends by itself.
- **Another Claude account, if you want one.** Settings -> Accounts -> "Add another Claude
  account" gives it its own folder (`~/.clawdling-accounts/<name>`); "Sign in" opens Claude Code
  with that folder so you can `/login`. The new-session dialog then lets you pick the account. It
  is only `CLAUDE_CONFIG_DIR` for that session's `claude`: no automatic switching, and Clawdling
  never reads, stores or forwards the login. With one account, none of this shows.
- API: `POST /api/sessions` takes `effort` and `account`; `POST /api/sessions/:sid/settings`;
  `GET/POST /api/accounts`, `POST /api/accounts/:id/signin`; chat tool calls carry `detail`.
  CLI: `clawdling spawn --effort E --account A`.

**Cross-platform**

Clawdling now works for a stranger on any OS: macOS, Linux and **native Windows** (no WSL), with
or without tmux.

- **tmux is optional.** Without tmux 3.2+ (always on Windows, and on a Mac without Homebrew),
  sessions run in Clawdling's built-in terminal: a pseudo-terminal per session from node-pty (the
  library VS Code's terminal uses; ConPTY on Windows) with a server-side screen model
  (`@xterm/headless`). The cockpit, the phone app, Donna, hooks, snapshots for late viewers, and
  the folder-trust and permission buttons work the same. The honest difference: these sessions
  end when the cockpit stops; they come back as ended with a notice and resume where they left
  off with one click (`claude --resume`). With tmux, nothing changes: sessions keep running.
- **Backend choice:** tmux when tmux 3.2+ is installed (not on Windows), else the built-in
  terminal, else `clawdling start` and `doctor` stop with the one-line fix for your OS.
  `CLAWDLING_BACKEND=tmux|pty` overrides. The choice is in `/api/health`, `server.json`,
  `sessions.json`, `clawdling start`'s banner and the cockpit's Settings.
- **`clawdling doctor` per OS:** names the OS and how sessions will run, with exact fix commands
  for brew, apt, dnf, pacman, zypper, apk and winget; tmux shown as optional; Git for Windows as
  recommended; Claude Code's own installer per OS.
- **Windows:** `claude` is found like `where` finds it (`claude.exe` before an npm `claude.cmd`);
  an npm `.cmd` shim is bypassed for the program it wraps, so prompts with quotes, `%` or newlines
  reach Claude intact; hooks use Claude Code's exec form (2.1.139+), so they run whether Claude
  Code uses Git Bash or PowerShell; `clawdling` is on PATH inside sessions for Git Bash, PowerShell
  and cmd; allow rules cover the PowerShell tool; `service install` adds a Startup-folder launcher
  (no admin rights). iMessage stays macOS-only and the cockpit says so.
- **`clawdling attach` without tmux:** a terminal client over the cockpit's own WebSocket
  (Ctrl-] detaches). **`clawdling stop`** stops the cockpit cleanly on every OS.
- **Fixes:** the CLI did nothing when run natively on Windows (its entry check compared a
  `/C:/...` URL path); a folder-trust dialog drawn before tmux's control client attached was not
  detected until the 20 s stall notice.
- **Install and setup:** README and SETUP.md (the playbook Claude Code follows) now cover each OS,
  install missing prerequisites only after you agree, and never set up WSL. README has a
  troubleshooting section.
- **First run and honest status (from a UX review):**
  - A persistent banner (phone included) when `claude` or tmux is missing, with the fix and a
    "Check again" button; start controls are disabled while it shows. tmux is never flagged
    when sessions run in the built-in terminal.
  - "Trust my org folder" on first run, so agents inside the org never ask again; the trust
    banner names the folder and says what "No, exit" does.
  - A Claude Code that is not signed in (or not set up yet) is recognised at once, not after a
    20 s stall.
  - "Needs you" counts what is blocked plus what is your turn; a session you just opened is
    neither, and a finished turn stays green "Your turn".
  - Every command the cockpit and the CLI print is spelled the way this computer runs this
    install (`node ~/.clawdling-app/bin/clawdling.js ...` when `clawdling` is not on PATH).
  - "Use Clawdling on your phone": a browser link and QR that sign a phone in (when the cockpit
    is reachable), the iPhone app marked as coming soon.
  - Phone: 44 px targets, 16 px fields, no keyboard on open, one-tap answers to permission
    prompts and questions, a message composer, safe areas; contrast fixes; Alt+1-9 for panes.
- **Fixes found with real Claude Code 2.1.283:** answer buttons for a permission prompt or a
  question that Claude Code draws after its notification; `clawdling stop` no longer leaves tmux
  control clients behind; `clawdling new` no longer posts to another org's cockpit on the same
  port.
- **CI:** GitHub Actions on Ubuntu, macOS and Windows, Node 20 and 22, with the unit and
  integration suites under both backends, the Playwright cockpit suite (desktop and phone,
  Chromium and WebKit), and the same suite against the real server on Linux and Windows.

## 1.0.0 (2026-10-22)

First release of the rebuilt Clawdling: an org of Claude Code agents with a cockpit and a chief of
staff you can text.

- **The org is a folder.** `clawdling init --answers answers.json` (or `--defaults`) creates
  `~/clawdling` with an org `CLAUDE.md`, `me.md`, Donna (chief of staff), one folder per domain and
  project agent, the `/handoff` and `/new-agent` skills, and Claude Code settings that pre-approve
  the `clawdling` routing commands.
- **Memory that sticks.** Every agent has `memory/NOW.md` (loaded into every new session through
  its `CLAUDE.md`) and `memory/LOG.md`; agents are told to update both before they finish.
- **Real Claude Code sessions in tmux** on a dedicated socket (`tmux -L clawdling`). Sessions
  survive a Clawdling restart and are reattached; ended sessions resume with `claude --resume`.
  `clawdling attach` opens any session in a terminal.
- **Live status from Claude Code hooks:** starting, working, ready, needs you, ended, with the
  notification text, plus local session titles (never generated by a model). Claude Code's
  folder-trust dialog shows up as "needs you".
- **Cockpit server** on 127.0.0.1:4747: JSON API, terminal WebSockets over tmux control mode with
  exact snapshots for late viewers, Server-Sent Events, token + cookie auth, Origin and Host checks.
- **Donna on Telegram** (pair with `/pair <code>`) and **iMessage** (macOS, experimental): every
  message becomes a headless Donna turn that routes the work to the right agent with
  `clawdling spawn` / `clawdling send`, then replies in a few lines.
- **App API** for the Clawdling iPhone app: chat view of any session from its transcript, Donna
  chat and history, pairing link and QR code.
- **CLI:** `doctor`, `init`, `start`, `open`, `new`, `ls`, `spawn`, `send`, `attach`, `end`,
  `resume`, `donna`, `service install` (macOS LaunchAgent; systemd unit on Linux).
- **Agent-native install:** `SETUP.md` is a playbook Claude Code follows to install Clawdling and
  interview you in at most five questions.
- **Answer Claude Code's questions from the cockpit:** `POST /api/sessions/:sid/answer {option}`
  answers folder trust, external imports and permission prompts the way a person would (arrow keys
  onto the chosen line, then Enter). Sessions waiting on a question carry `choices` in screen order,
  and the cockpit's buttons follow those labels (Claude Code 2.1.283 lists "No, exit" first).
- **Donna runs isolated:** her text-message turns use `--setting-sources project,local
  --strict-mcp-config`, so your own allow rules, hooks, plugins and MCP servers never apply to her.
- **One server per org:** a second `clawdling start` exits at once instead of hanging, and hooks
  that miss the server are queued and replayed in order.
