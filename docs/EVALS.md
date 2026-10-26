# Agent check-ups: writing cases

A check-up asks an agent a few questions, runs each one as the agent really lives (its folder,
its CLAUDE.md, its NOW.md and memory, the same context a real session gets) and grades the
answers. Clawdling can draft five cases for you from the agent's own files (Check-up tab, "Give
this agent a check-up"); this page is for reading, editing or writing them by hand.

The files use the format of Anthropic's `claude plugin eval`, so **these files also work with
`claude plugin eval` for skills and plugins**. Clawdling writes only keys that plugin eval's loader
accepts, and keeps its own settings in separate files plugin eval ignores.

## Where they live

```
<agent folder>/evals/
  knows-its-job/prompt.md            the question, with a little frontmatter
  knows-its-job/graders/criteria.md  how the answer is graded (one file per grader)
  knows-its-job/reference.md         optional: a good answer (Clawdling only, see "Controls")
  .clawdling-suite.yaml              Clawdling only: runs per case, judge model, cost cap
  results/<time>.json                Clawdling's results
```

A case is a folder whose name is lower-case letters, numbers and `-`. The agent folder is
`domains/<id>/` or `projects/<id>/` inside your org folder.

## prompt.md

```md
---
name: knows-its-job
description: Asks the agent what it is for
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep]
---

In two sentences, what is your job, and who do you work for?
```

| Key | What it does | Default |
|---|---|---|
| `name`, `description` | shown in the cockpit | the folder name, empty |
| `max_turns` | how many agent turns the run may take (1 to 50) | 6 |
| `timeout_seconds` | how long the run may take (10 to 1800); a timeout scores 0 | 180 |
| `allowed_tools` | the tools the agent may use | `[Read, Glob, Grep]` |
| `model` | a model for this case (Try a cheaper model overrides it) | the agent's |
| `tags` | labels, for your own use | none |

The text under the frontmatter is the prompt: what the owner types to the agent.

**Tools.** A check-up's tools are read-only: `Read`, `Glob`, `Grep`, `LS` (and `TodoWrite`). There
is no Bash and no write tool in 1.6: a check-up asks how the agent answers, and your test commands
run in the ship check. Anything else the agent tries is denied (and listed on the run), never
asked. Other plugin-eval keys (`env`, `append_system_prompt`, `disallowed_tools`, ...) are refused
with a reason rather than ignored.

## graders/*.md

One file per grader; the file name is the grader's name. The frontmatter says its `type`; for `llm`
the body is the criteria, for `regex` the body is the pattern. `weight` (default 1) sets its share of
the case's score.

| Type | Frontmatter | Body | Passes when |
|---|---|---|---|
| `llm` | `focus`, `weight` | the criteria | a judge model says so in at least two of three votes |
| `regex` | `target`, `match`, `flags`, `weight` | a JavaScript regular expression | `match` holds over `target` |
| `tool_used` | `tool`, `input_match`, `min`, `max`, `weight` | none | the agent called `tool` between `min` and `max` times |
| `tool_order` | `before`, `after`, `weight` | none | the first matching `before` call comes before the first matching `after` call |
| `file_exists` | `path`, `exists`, `weight` | none | a file the run created matches the glob `path` (or none does, with `exists: false`) |

- `target` (regex) and `focus` (llm): `last_message` (the agent's final answer, the default),
  `trace` (every message and tool call of the run, one JSON object a line), `files` (the paths the
  run created, one a line; files that existed before the run never appear) or
  `{source: file, path: notes/out.md}` (a file in the run folder).
- `match`: `contains` (default), `not_contains`, or `count:N` (exactly N matches).
- `flags`: JavaScript regular-expression flags, such as `i` for case-insensitive. A pattern that
  takes more than a second on the run's text (one that backtracks badly) fails its grader.
- `input_match` (tool_used, and `{tool, input_match}` in tool_order): a regular expression over the
  call's input as JSON.
- `min` defaults to 1. For "must not call X", use `min: 0` and `max: 0`.
- `path` (file_exists) is a glob: `*` stays in one folder, `**` crosses folders, `?` is one
  character.
- `baseline` graders (comparing against a saved trajectory) are not run by Clawdling in 1.6.

An `llm` grader with concrete, checkable criteria grades much better than a vague one:

```md
---
type: llm
weight: 2
---

The answer names the household budget as the job.
It says the owner approves any payment before it is made.
```

A `regex` grader for a word the answer must contain:

```md
---
type: regex
target: last_message
flags: i
---

budget
```

## Scores

A case's score is the weighted share of its graders that passed; a run that errored (a timeout,
the agent trying to ask a question, a crash) scores 0. The suite's score is the mean of the case
scores. With 3 runs per case, a case also shows pass@3 (at least one run passed) and pass^3 (all
three passed), and the cockpit marks a case that flip-flops.

## Controls: is the judge any good?

Before any agent run, the judge grades two things it should get right: an empty answer, which must
fail every `llm` grader, and the case's `reference.md`, which must pass. If the judge passes the
empty answer or fails the reference, or a judge call fails, the suite says **judge unreliable** instead of a score, and no
agent run is spent. A criterion like "any answer is fine" trips it. The fix is concrete criteria.

## .clawdling-suite.yaml

```yaml
runs: 1              # runs per case: 1 or 3
judge_model: haiku   # the model that grades llm graders
max_cost_usd: 2      # the hard cap for one check-up, list-price equivalent
```

A run that ends without reporting its cost (a timeout, a crash) counts as the whole budget it was
given, so a check-up of slow runs stops at the cap instead of running past it.

## Running

- In the cockpit: the agent's **Check-up** tab. Cases you wrote or changed by hand show "Needs your
  review" until you approve them there; a case changed on disk after you approved it needs your
  approval again. The cost is shown before every run.
- From a terminal: `clawdling checkup <agent> [--k 1|3] [--max-cost 2] [--models current,haiku:medium]
  [--threshold 1] [--json]`. Exit codes: 0 when the score reaches the threshold (default 1, every
  grader passed), 1 when it does not, 2 when the cost cap stopped it or the judge was unreliable.

## Running these files with `claude plugin eval`

`claude plugin eval` tests a plugin or a skill in an empty sandbox: your settings, hooks,
CLAUDE.md files, MCP servers and memory are absent. That is what you want for a plugin, and it is
why Clawdling runs agent check-ups itself: an agent *is* its CLAUDE.md, its NOW.md and its folder.
The case files are the same, so a case you wrote for a skill can be run with plugin eval as it is:
put the `evals/` folder inside the plugin and run `claude plugin eval <plugin>` (Claude Code
2.1.269 or newer). plugin eval ignores `reference.md` and `.clawdling-suite.yaml`.
