---
name: new-agent
description: Create a new domain agent or project agent in this Clawdling org with the clawdling CLI. Use when the user wants a new area of life or work covered, or a new project tracked, by its own agent.
---

# New agent

Ask the user before creating an agent. Then:

- **Domain agent** (an ongoing area such as Fitness, Kids or Taxes):
  `clawdling new domain "<Name>" --mission "<one sentence: what this agent owns>"`
- **Project agent** (a goal with an end state):
  `clawdling new project "<Name>" --goal "<one sentence>" [--repo /absolute/path/to/code] [--domain <domain-id>]`

The command prints the new agent's id and folder. Afterwards:

1. Open the new agent's `CLAUDE.md` and fill in the `## Context` section with what you know:
   goals, constraints, people, tools, links. Keep it short and concrete.
2. Write a first `memory/NOW.md` (State / Open threads / Next steps).
3. Offer to start it: `clawdling spawn <id> "<first task>"`.

Ids are lowercase letters, digits and dashes. Names can be anything.
