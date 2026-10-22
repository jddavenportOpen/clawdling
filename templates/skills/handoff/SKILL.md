---
name: handoff
description: Save this agent's memory before a piece of work ends. Rewrites memory/NOW.md (current state, open threads, next steps) and appends one dated line to memory/LOG.md. Use when the user says they are done, before ending a session, or right after finishing a task.
---

# Handoff

1. Find your agent folder: the folder that holds your `agent.json`. It is your working directory,
   or (for a project agent working in a code repo) the agent folder named in your system prompt.
2. Rewrite `memory/NOW.md` in that folder, under 40 lines, with these sections:
   - `## State`: what is true right now.
   - `## Open threads`: what is in flight and who or what it waits on.
   - `## Next steps`: the next one to three concrete actions.
   Update the `_Last updated:` line at the top with today's date.
3. Append exactly one line to `memory/LOG.md`: `- YYYY-MM-DD: <what happened, one sentence>`.
   Never rewrite or delete earlier log lines.
4. Tell the user in one line that memory is saved.

Keep secrets (passwords, tokens, card numbers) out of both files.
