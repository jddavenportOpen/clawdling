# Clawdling

**Clawdling** is a personal AI OS engine you run yourself. It's a clean web
cockpit around a chat agent that can **act** — manage tasks, remember facts, and
recall them across sessions — backed by local state on your own machine. Bring
your own Anthropic API key, own your data, done.

It is the free, open-source, self-hostable engine behind the hosted
**Clawdascended** product. Same engine; the hosted product adds the managed
extras (see [What Clawdling is not](#what-clawdling-is-not)).

> Status: alpha. The chat + tools experience works end to end. Some domain
> dashboards are not yet wired for a fresh install and render empty for now.

## Install (3 commands)

```bash
git clone https://github.com/JDDavenport/clawdling.git && cd clawdling
./install.sh          # checks Node 24, writes .env, prompts for your Anthropic key, installs deps
make run              # → http://localhost:3000
```

`install.sh` is executable; if your clone dropped the exec bit, run
`bash install.sh` instead.

`make run` starts the cockpit in dev mode (`next dev`) — the **primary,
supported self-host path**. On first boot it seeds a welcome thread that walks
you through the tools and how to customize your domains. The core acting tools
(tasks + memory) are ON out of the box, so the very first "create a task, then
list tasks" run works with zero extra config.

## Who it's for, and how it's different

You want an assistant that **does things**, not another chat window. You want the
data on your own disk. You want to pay Anthropic directly instead of a
subscription layered on top.

Open WebUI, LibreChat and AnythingLLM are chat front-ends: good UIs over a model,
usually with RAG. OpenHands and similar are coding agents. Dify is a workflow
builder for teams. Clawdling is a **personal operations cockpit**: the agent holds
durable tools against *your* task list and *your* memory, stored as plain JSON on
your machine, with no database to run and no account to create. Single user, by
design. If you want a hosted multi-tenant version with a managed builder and
billing, that's Clawdascended, and this is the engine underneath it.

## What it is

A single-user cockpit backed by a local JSON store, driven by the Anthropic API
with **your own key**:

- **Chat** with streaming replies and persistent thread history.
- **Acting tools** — the assistant doesn't just talk, it does things. Five tools
  ship built in and **on by default** (`ADJUTANT_TOOLS` defaults to
  `web,tasks,memory`; implemented in `src/lib/engine/tools.ts`):
  - `create_task` — add to your task list
  - `list_tasks` — list what's open / done
  - `complete_task` — mark a task done
  - `remember` — save a durable fact or preference
  - `recall` — search back through what you've saved

  So a fresh install can act immediately — no config needed for the first
  "create a task, then list tasks" run.

  (Optional Google Calendar + Gmail tools also exist but are OFF by default;
  add `google` to `ADJUTANT_TOOLS` once you supply your own OAuth client.)
- **Memory + local state** — everything lives in JSON files under
  `ADJUTANT_STATE_ROOT`. No database, no accounts, no cloud.
- **Domains** — three starter workspaces (Work / Personal / Notes) you can
  rename, recolor, or extend by editing `profiles/starter/` (see
  [Customize](#customize-your-profile)).

### Cost honesty (BYOK)

Every model call — chat, tool use, everything — meters against **your own
Anthropic key**. There is no free or infinite output: you pay Anthropic directly
for what you use, and you control the model and effort (`ADJUTANT_MODEL`,
`ADJUTANT_EFFORT`). Get a key at <https://console.anthropic.com>.

## What Clawdling is not

Clawdling is the engine only. It does **not** include, and never phones home for:

- **The Builder / self-modification pipeline** — the "describe it, it builds and
  ships it" loop.
- **Billing, usage metering, or subscriptions.**
- **Hosted provisioning** — no managed multi-tenant hosting, magic-link SaaS, or
  zero-setup accounts.
- **Premium domain packs** — curated, ready-made domain bundles.

Those are the managed layer of the hosted **Clawdascended** product
(<https://clawdascended.app>). Clawdling gives you the same core engine to run on
your own terms.

## Requirements

- **Node.js 24.** This is the pinned version (`.nvmrc`, `engines.node: ">=24 <26"`).
  `nvm install 24 && nvm use 24` is the easiest path. Dev mode (`make run`) runs
  cleanly on Node 24, and `make build` produces a standalone production server.
- An **Anthropic API key** (`sk-ant-api03-...`) from <https://console.anthropic.com>.

## Production build

```bash
make build     # next build -> .next/standalone
make start     # serves the standalone server on :3000
```

If `next build` crashes while prerendering `/_global-error` with
`Cannot read properties of null (reading 'useContext')`, you have `NODE_ENV=development`
set in your shell. `next build` must run with `NODE_ENV` unset or `production`.
Fix it with `env -u NODE_ENV make build`. This is not specific to Clawdling; any
Next 16 app fails the same way under a dev `NODE_ENV`.

## Run with Docker

```bash
docker run -e ANTHROPIC_API_KEY=sk-ant-api03-... -p 3000:3000 -v clawdling-data:/data clawdling
```

Or build + run in one step from a clone: `make docker-run`
(reads `ANTHROPIC_API_KEY` from your environment). State persists in the
`clawdling-data` volume mounted at `/data`.

## Customize your profile

A **profile** is the personality layer on top of the engine — the domains you
see and the agent prompt behind each. The starter profile lives at
`profiles/starter/`:

- `domains.yaml` — the domain list (id, label, color, blurb, agent prompt ref).
- `agents/*.md` — the prompt for each domain agent.

Edit those, then `make run`. `src/config/domains.ts` loads the active profile
(`ADJUTANT_PROFILE`, default `starter`) at boot and falls back to the compiled
starter domains if the file is missing or invalid. See
`profiles/starter/README.md` for details.

## Configuration

`install.sh` creates `.env` from `.env.example`. The switches:

| Env var | Values | Default | What it does |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | required | The key every model call meters against |
| `ADJUTANT_ENGINE` | `sdk` \| `cli` \| `mock` | `sdk` | `sdk` calls the Anthropic API with your key; `cli` uses your local Claude Code / Max subscription (see note); `mock` streams a canned reply (zero cost, for demos) |
| `ADJUTANT_PROFILE` | profile name | `starter` | Which profile under `profiles/` supplies the domains |
| `ADJUTANT_STATE` | `local` \| `supabase` | `local` | `local` = JSON files under `ADJUTANT_STATE_ROOT`; `supabase` = hosted Postgres |
| `ADJUTANT_AUTH` | `single` \| `magic-link` | `single` | `single` = one implicit local user, no login; `magic-link` = email sign-in |
| `ADJUTANT_STATE_ROOT` | path | `./.adjutant` | Where local data lives |
| `ADJUTANT_MODEL` | model id | `claude-sonnet-4-6` | Which Claude model to use |
| `ADJUTANT_EFFORT` | `low`..`max` | `medium` | Reasoning effort / latency tradeoff |

### `ADJUTANT_ENGINE=cli` — a note on Anthropic's Terms

The `cli` engine drives replies through your **own** locally-installed Claude
Code against your **own** Claude subscription (e.g. a Max plan), on your **own**
machine. That is a personal-use configuration only. Do **not** use it to resell
access or to serve other people — that would violate Anthropic's Terms of
Service. For anything beyond your own single-user install, use `sdk` mode with a
metered API key.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
