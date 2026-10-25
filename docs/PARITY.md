# Parity ledger

Clawdling's core is shared, as a spec, with a second cockpit by the same author that is not open
source. The two are separate shells around the same idea; they share user stories, test fixtures
and, where it pays, small modules (copied with provenance, never by sharing a build). This ledger
answers one question: for each core feature, do the two match?

- **Core:** the features any Clawdling-style cockpit should have. Only core features are listed.
- **Clawdling / Sibling:** ✓ has it · ◐ partly · — not yet. The version is when Clawdling got it.
- **Story:** the [core user story](CORE-STORIES.md) the feature is tested against.

Features that only make sense for one private setup (its hosting, its accounts, its own agents)
are not core and are not listed.

## Sessions

| Feature | Story | Clawdling | Sibling | Notes |
|---|---|---|---|---|
| Start a session in an agent's folder | CS-01 | ✓ 1.0 | ✓ | |
| Resume an ended session | CS-02 | ✓ 1.0 | ✓ | |
| End a session (asks first; hiding keeps it running) | CS-03 | ✓ 1.0 | ✓ | |
| Rename a session | CS-04 | ✓ 1.0 | ✓ | |
| Several panes, keyboard focus | CS-05 | ✓ 1.0 | ✓ | The sibling also keeps layouts on the server, across devices |
| Rail of real names, collapsible | CS-06 | ✓ 1.1 | ✓ | |
| Sessions across a cockpit restart | CS-07 | ✓ 1.0 (tmux) | ✓ | Different mechanisms, same promise; the built-in terminal (1.3.1) isolates its terminal process |
| Attach from a terminal | — | ✓ 1.1 | — | |
| A board of every session | — | — | ✓ | Candidate for the core |

## Chat

| Feature | Story | Clawdling | Sibling | Notes |
|---|---|---|---|---|
| Clean chat view from the transcript, Raw toggle | CS-08, CS-11 | ✓ 1.1 | ✓ | Same source in both: Claude Code's transcript JSONL |
| Tool calls folded to one line | CS-09 | ✓ 1.1 | ✓ | |
| Composer sends, reply appears live | CS-10 | ✓ 1.1 | ✓ | |
| Chat on a phone | CS-12 | ✓ 1.1 | ✓ | |
| Question cards (AskUserQuestion) | CS-14, CS-15 | ✓ 1.4 | ✓ | Clawdling takes the question from Claude Code's PreToolUse hook and answers it on screen |
| Plan approval card | CS-16 | ✓ 1.4 | ✓ | |
| A composer that never loses a message (queue, drafts, offline outbox) | — | — | ✓ | Next |
| Attachments and pasted images | — | — | ✓ | Next |
| History search | — | — | ◐ | |

## Status and attention

| Feature | Story | Clawdling | Sibling | Notes |
|---|---|---|---|---|
| Status from Claude Code's hooks | CS-13 | ✓ 1.0 | ◐ | The sibling reads the terminal and the transcript instead; a hooks signal is planned there |
| Turn failed, with the reason | CS-13 | ✓ 1.1 | ◐ | |
| Permission prompts as buttons | CS-17 | ✓ 1.1 | ✓ | |
| Folder trust as buttons | CS-18 | ✓ 1.1 | ✓ | |
| Not signed in: sign in, then start again | CS-23 | ✓ 1.1.1 | ◐ | |
| Watching · N (background work after the turn) | CS-19, CS-20 | ✓ 1.4 | ✓ | Same detector rules and fixtures; Clawdling's is a plain-JS rewrite |
| One honest "needs you" count | CS-24 | ✓ 1.1 | ✓ | |
| Browser notification when the tab is hidden | CS-21 | ✓ 1.4 | ✓ | |
| A message to your own chat when an agent needs you | CS-22 | ✓ 1.4 | ◐ | The sibling uses phone push |

## Chips and voice

| Feature | Story | Clawdling | Sibling | Notes |
|---|---|---|---|---|
| Model and effort chips | CS-25 | ✓ 1.1 | ✓ | |
| Dictation | CS-26 | ✓ 1.1 | ✓ | Clawdling uses the browser's speech service; a local option is a candidate |
| Cost per session | — | — | ✓ | From transcript token counts, no credential needed; candidate |

## Org, memory and import

| Feature | Story | Clawdling | Sibling | Notes |
|---|---|---|---|---|
| Bring in your projects | CS-27 | ✓ 1.2 | — | Candidate for the sibling |
| Claude Code setup view (names only) | CS-28 | ✓ 1.2 | ◐ | |
| Agent page edits CLAUDE.md and memory | CS-29 | ✓ 1.0 | ◐ | The sibling reads them; editing is planned |
| Chief of staff by text, paired chat only | CS-30 | ✓ 1.0 | ✓ | |
| Org map | — | ✓ 1.0 | ✓ | |

## How a feature moves

1. It gets a core story (CS-NN) with a test in each cockpit.
2. One cockpit builds it; the other ports it by rewriting, with the same fixtures where they apply
   (scrubbed of personal data), and a note of where it came from.
3. This ledger marks both ✓ once both tests pass.
