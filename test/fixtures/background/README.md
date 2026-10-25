# Transcript fixtures for the background-task detector (`server/background.js`)

Each `.jsonl` file is Claude Code transcript lines in file order (CLI 2.1.283). Most are
redacted excerpts of real transcripts: only the fields the detector reads are kept, and every
description, command, output, path, name and address was replaced with neutral text. A few are
synthetic, built from the real line shapes.

- `monitor-rearm.jsonl`: four 30-minute Monitors, each expiring (`[Monitor expired after 30m …]`)
  and re-armed, with ordinary Monitor events between. The fifth is running.
- `monitor-ended-and-early-notice.jsonl`: two Monitors whose source ended at once. In the second,
  the end notice is logged BEFORE the launch's own tool_result line.
- `monitor-taskstop-events.jsonl`: a Monitor stopped with TaskStop, then a second Monitor with
  several events and a `stream ended` completion.
- `async-agents-and-shell.jsonl`: two Agents with no `run_in_background` (async by default) and a
  `run_in_background` Bash, all completing.
- `agent-run-in-background-true-string.jsonl`: an Agent whose input has `run_in_background: "true"`.
- `agent-rest-then-resume.jsonl`: an agent that came to rest, was resumed by SendMessage
  (`resumedAgentId`), and finished again.
- `shell-killed-then-stopped.jsonl`: a foreground Bash moved to the background by its timeout,
  later `killed`, then reported `stopped` by the next session.
- `workflow-async.jsonl`: a Workflow launched in the background and completed.
- `subagent-shells.sub.jsonl` + `subagent-shells.main.jsonl`: two background shells a sub-agent
  launched (its own `subagents/agent-<id>.jsonl`, every line `isSidechain: true`), whose ends the CLI
  wrote to the MAIN transcript.
- Synthetic: `shells-orphaned-by-restart.jsonl` (one notice naming several task ids),
  `monitor-persistent.jsonl` (a `persistent: true` Monitor), `negatives.jsonl` (what must not
  count: a foreground Bash, a synchronous Agent, a Monitor that failed to start, a sidechain shell
  in a main file, an assistant quoting a notification, a person mentioning the tag, bad lines).
