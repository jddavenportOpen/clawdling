# Starter profile

This is the default **profile** Clawdling ships with. A profile is the
personality layer on top of the engine: the domains you see in the cockpit and
the agent prompt that drives each one. The engine (chat, tools, memory, local
state) is the same for everyone; the profile is what makes an install *yours*.

## What's here

```
profiles/starter/
├── domains.yaml        # the 3 starter domains (work / personal / notes)
├── agents/
│   ├── assistant.md    # generic personal-assistant prompt
│   ├── tasks.md        # generic work/projects prompt
│   └── researcher.md   # generic research/notes prompt
└── README.md           # this file
```

## The 3 starter domains

| id | label | what it's for |
|----|-------|---------------|
| `work` | Work | Projects, tasks, and deadlines |
| `personal` | Personal | Life admin, errands, one-off todos |
| `notes` | Notes | Memory, recall, and reference notes |

## Make it yours

1. **Edit domains** — open `domains.yaml`, change/add rows. Each needs an `id`
   (stable lowercase slug), `label`, `color` (hex), `blurb`, and an `agent`
   pointing at a prompt file under `agents/`.
2. **Edit the agent prompts** — the `.md` files under `agents/` are plain prompts.
   Rewrite them in your own voice.
3. **Restart** — `make run`. `src/config/domains.ts` loads this file at boot. If
   it's missing or malformed, the engine falls back to the compiled starter
   domains so the cockpit always boots.

Select which profile is active with the `ADJUTANT_PROFILE` env var (default
`starter`). The hosted Clawdascended product ships its own profile; the OSS
engine ships this one.
