# Receipts: the report card and Verified done

What Clawdling shows for each project, and how it decides whether an agent's "done" is backed by a check. Back to the [README](../README.md).

## The report card

**Every project gets a report card: what got done, what it cost, what needs you. In plain words,
on your own machine.** Open any agent and its Overview answers four questions, for the last day,
7 days or 30 days, from your phone too:

![An agent's report card: Done, Needs you, Cost and Next](img/report-card.png)

- **Done.** Each session that did some work, with the agent's own closing words, how many files
  it changed and the commits it made in the project's repo. A check result it reports ("All 24
  tests pass.") comes first. No AI summary on top: just what the agent said and what git
  recorded.
- **Needs you.** Every question, permission, failed turn and finished turn waiting on your reply,
  the same ones the rail counts. One tap opens that session.
- **Cost.** Usage as a list-price equivalent, by day, by model, and the top sessions. It is not
  a bill: on Pro and Max your usage is included in your plan. Clawdling prefers Claude Code's own
  number, and never calls a model to work it out.
- **Next.** What the agent wrote it will do next, from its `memory/NOW.md`, and how fresh that is.

Every session also gets a **Timeline** tab beside Chat and Raw: each prompt, each tool call with
how long it took and whether it worked, subagents under the call that started them, and what each
turn used.

![A session's Timeline: prompts, tool calls with results and durations, a subagent, cost per turn](img/timeline.png)

The org map shows each agent's last 7 days and when it last finished work. `clawdling
report [agent] --json` prints the same card for scripts. Optional, and off until you turn them on:
a **Monday report** to the Telegram or iMessage chat you paired with Donna (counts, agent names and
dollar figures only), and a **detailed timeline** (beta) that also shows who approved each tool,
from Claude Code's own telemetry, sent only to Clawdling on `127.0.0.1`.

Everything comes from files already on your computer: Claude Code's own session transcripts, your
repo's `git log` and the agent's memory. When Claude Code cleans up an old transcript, Clawdling
keeps a small summary, so the card stays honest ("transcript gone, kept summary only").

## Verified done

**When an agent says "done", Clawdling shows the receipt, or says "not verified".** A developer can
read the diff; an owner needs a receipt. Under every message where an agent claims it finished
("done", "fixed", "tests pass", "builds"), Clawdling checks the session's own record and adds one
of three labels:

- **Verified**: a check ran after the agent's last change and passed ("`npm test` passed at
  14:02, after the last edit"), and every check that ran passed.
- **Not verified**: no check ran after the last change, or the record cannot tell (only some tests
  ran, the exit code was hidden, or a failure showed in a command line with other commands). Only a
  plain run of the check (`npm test`, `pytest`, your approved command) can verify or contradict.
  This is the default, and it is not an accusation: it just
  means there is no receipt yet.
- **Contradicted**: a check ran after the last change and failed, and the same check did not pass
  after it. The label quotes the first error line, the claim waits in **Needs you**, and **Ask the agent to fix it** sends one message,
  which you see before it goes.

![A receipt under an agent's "Done": Contradicted, quoting the failed test, with Ask the agent to fix it](img/verified-done.png)

No model decides the label: it is a fact from Claude Code's own transcript, so it is free and
instant. To get more receipts:

- **A ship check per project.** Pick, once, the commands that prove the project works (tests,
  build, lint); Clawdling shows each one exactly, with what it does, and runs only what you ticked.
  Press Run (or `clawdling check <agent>`) and they run in a scratch copy of the repo, never in the
  live one. A pass after the agent's last change turns "Not verified" into "Verified"; a failure
  keeps a claim Not verified (the copy has no `.env` or secrets, so it never marks a claim
  Contradicted on its own).
- **Agent check-ups.** Five questions drafted from the agent's own CLAUDE.md and NOW.md: does it
  know its job, its next step, what is not its job, its house rules, its last handoff? You read and
  edit them first; each run uses the agent's real folder and memory (in a scratch copy) on your
  plan, with the cost shown before it starts and a hard cap. A built-in control catches a judge
  that would pass anything. The files use the format of Anthropic's `claude plugin eval`
  ([writing cases](EVALS.md)).
- **Try a cheaper model.** The same check-up across models and effort levels; Clawdling recommends
  the cheapest one that holds up, and changes nothing until you click "Use this".

![An agent's Check-up tab: the check-up score, case by case, and the approved cases](img/checkup.png)

The report card gets a **Verified** block (the week's claims by label, the last ship check and the
last check-up), and the org map shows each agent's last check-up. Everything stays on your computer:
receipts, approved commands and check-up results are files in the agent's folder and in
`.clawdling/`. What a ship check runs, and how check-ups are sandboxed: [SECURITY.md](SECURITY.md#verified-done-16).
