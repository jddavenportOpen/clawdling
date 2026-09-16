# Architecture

Clawdling is a single Next.js application. The chat runtime, acting tools,
memory, auth, and state drivers all live in one codebase; a few environment
switches produce the different deployment shapes (local self-host vs hosted).

---

## The engine

The core is a server-side agentic tool loop (`src/lib/engine/`):

- **`sdk-engine.ts`** — a serverless turn runner against the Anthropic Messages
  API. It streams UI-shaped SSE events, emits per-turn `usage` events, and takes
  BYOK params (`apiKey`, `model`, `effort`). This is the default runtime in both
  local and hosted modes.
- **`tools.ts`** — the acting tools the model can call: `create_task`,
  `list_tasks`, `complete_task`, `remember`, `recall`, plus web search/fetch.
  Tools are per-user scoped and gated by `ADJUTANT_TOOLS`.

A chat turn flows: browser → `POST /api/chat/[threadId]` → `sdk-engine` →
streamed SSE back to the browser, with tool calls executed server-side and
results persisted.

---

## State

State access goes through one backend, selected by `ADJUTANT_STATE`:

- **`local`** (default) — local JSON files under `ADJUTANT_STATE_ROOT`
  (default `./.adjutant`). No cloud account required.
- **`supabase`** — Postgres with per-user tables and RLS (the hosted path).

The engine reads only from `ADJUTANT_STATE_ROOT` for local files — there are no
absolute personal paths anywhere in the tree.

---

## Profile

The domains, agents, and their prompts are data, not hardcoded product surface.
`src/config/domains.ts` and `src/config/agents.json` ship the generic starter
profile (three domains: Work / Personal / Notes; three agents:
assistant / researcher / tasks). Nav, the chat domain picker, and agent runtime
personas all derive from these. A future release resolves them from a swappable
profile (`ADJUTANT_PROFILE`).

---

## Auth

`NextAuth v5`. Local single-user mode (`ADJUTANT_AUTH=single`) needs no login;
multi-user mode uses magic-link email. The Supabase service-role key (hosted
mode) never reaches the browser — only the anon key is `NEXT_PUBLIC_`.

---

## Layout on disk

```
clawdascended/
├── docs/                  # in-app /docs content (this directory)
├── public/                # static assets
├── scripts/               # engine-generic build helpers
├── src/
│   ├── app/               # Next.js App Router pages + api/ route handlers
│   ├── components/        # UI
│   ├── config/            # domains.ts + agents.json (the starter profile)
│   └── lib/               # engine, tools, state, auth, supabase, utils
├── db/migrations/         # schema (only used when ADJUTANT_STATE=supabase)
└── test/                  # engine tests (vitest)
```
