# Clawdling

**Clawdling** is a personal AI OS you run yourself. It has two modes, and you can
use either or both.

**Chat mode.** A clean web cockpit around an agent that can **act** — manage
tasks, remember facts, recall them across sessions — backed by local state on
your own machine. Bring your own Anthropic API key, own your data, done. This
needs nothing but Node.

**Cockpit mode.** Many real **Claude Code** sessions at once, side by side in
one screen. Each pane is an actual `claude` process on your machine, scoped to a
domain of your life with its own agent prompt and its own working directory.
Spawn them, tile them, drive them from your phone. This needs the local bridge
(`make bridge`) and the Claude Code CLI.

**Workers.** Same bridge, opposite posture. A pane is a conversation you sit in;
a worker is a job you hand off. You give it an objective, it runs headless in
its own git branch with a deadline, and you read the outcome later. See
[Background workers](#background-workers).

It is the free, open-source, self-hostable engine behind the hosted
**Clawdascended** product. Same engine; the hosted product adds the managed
extras (see [What Clawdling is not](#what-clawdling-is-not)).

> Status: alpha, and verified end to end: chat + tools; a cockpit pane spawned,
> typed into, streamed over SSE and killed without orphaning its child; pane
> history surviving a bridge restart (including `kill -9`), with `--resume`
> restoring the model's own context; a headless worker dispatched to its own git
> worktree and reaped on timeout; and voice into the composer. Some domain
> dashboards are not yet wired for a fresh install and render empty. See
> docs/KNOWN-ISSUES.md for the honest gaps.

## Install (3 commands)

```bash
git clone https://github.com/jddavenportOpen/clawdling.git && cd clawdling
./install.sh          # checks Node 24, writes .env, prompts for your Anthropic key, installs deps
make run              # → http://localhost:3000
```

`install.sh` is executable; if your clone dropped the exec bit, run
`bash install.sh` instead.

`make run` starts the cockpit in dev mode (`next dev`). On first boot it seeds a
welcome thread that walks you through the tools and how to customize your
domains. The core acting tools (tasks + memory) are ON out of the box, so the
very first "create a task, then list tasks" run works with zero extra config.

### Add the Claude Code panes (optional)

```bash
make bridge-install          # once: a Python 3.10+ venv with the bridge's dependencies
make bridge                  # in a second terminal, next to `make run`
```

`install.sh` already wrote a random `BRIDGE_SECRET` into `.env`, and `make bridge`
reads it from that same file, so the cockpit and the bridge agree with nothing to
copy. It loads only the bridge's own settings (`BRIDGE_*`, `CLAWDLING_*`): your
chat API key never reaches a pane, so the panes stay on your Claude plan. (An `.env` from before that change has an empty one: run
`openssl rand -hex 32` and paste the result after `BRIDGE_SECRET=`.)

Requires the [Claude Code CLI](https://claude.com/claude-code) on your PATH,
signed in (run `claude` once and log in). Each pane is that CLI on your own
Claude plan, so the panes need no API key. A new pane opens on the real Claude
Code screen; the first time a folder is used, Claude Code asks whether you
trust it. Answer with the arrow and Enter buttons under the terminal.
With the bridge running, the session picker can spawn real `claude` panes: one
per domain, an ad-hoc pane, a pane per project, or all your domains at once.
Without it, chat mode works exactly as before — the panes are simply unavailable.

To create a new domain agent:

```bash
make domain ID=health LABEL=Health BLURB="Training, food, and sleep"
```

That writes the profile row plus an agent prompt template under
`profiles/<profile>/agents/`. Edit the template to give the agent its real
scope. The picker hydrates from the server, so it shows up on next open with no
rebuild.

To use it from your phone, see [docs/REMOTE-ACCESS.md](./docs/REMOTE-ACCESS.md).
Read the lockdown section before you expose it: the bridge can run commands on
your machine.

**Who can reach it.** `make run` and `make bridge` listen on `127.0.0.1` only.
Single-user mode has no login, so anyone who can reach the cockpit's port can
drive your panes. `CLAWDLING_HOST=0.0.0.0 make run` opens it to your network;
do that only behind the tunnel and access lock in REMOTE-ACCESS.md.

## Background workers

A pane and a worker are the same engine pointed in opposite directions.

|  | Pane (`/chat`) | Worker (`/workers`) |
| --- | --- | --- |
| You are | attached, typing | gone |
| It runs | in a terminal | headless |
| It stops when | you close it | it finishes, or hits its deadline |
| It writes in | the directory you chose | its own git worktree, on its own branch |
| It remembers the task via | the conversation | a `WORKPLAN.md` on disk |

Open `/workers`, type what you want done, pick a domain agent, and dispatch.
The run appears in the list with its status, its elapsed time against its
ceiling, and its log.

What a worker does on dispatch, and why:

- **Its own git worktree**, on `clawdling/worker-<id>`. Two workers writing files
  in one checkout share an index and a `HEAD`; the second one to switch branches
  destroys the first one's work. If the directory is not a git repo it runs there
  anyway and the run says `isolation: none` with the reason - it never claims an
  isolation it did not get.
- **A `WORKPLAN.md`** holding the objective and the run id. An unattended run
  outlives its own context window, so the task has to exist on disk. It never
  overwrites a `WORKPLAN.md` you already had.
- **A wall-clock ceiling** (30 minutes by default). Unattended plus no deadline
  is how you end up with a process nobody remembers starting.
- **The worktree is kept when the run ends** - the work is the point. Cleanup is
  an explicit ask, and it refuses whenever the branch still holds commits that
  exist nowhere else, or uncommitted changes.

Nothing about a worker is free: it is a real `claude` process metering against
your own key, and four can run at once by default
(`CLAWDLING_MAX_WORKERS`). Workers need the same bridge as the panes.

Full endpoint and env reference: [bridge/README.md](./bridge/README.md#workers).

## Who it's for, and how it's different

You want an assistant that **does things**, not another chat window. You want the
data on your own disk. You want to pay Anthropic directly instead of a
subscription layered on top.

Open WebUI, LibreChat and AnythingLLM are chat front-ends: good UIs over a model,
usually with RAG. OpenHands and similar are coding agents pointed at a repo. Dify
is a workflow builder for teams.

Clawdling is a **personal operations cockpit**. Two things follow from that.
Its tools act on *your* task list and *your* memory, stored as plain JSON on your
machine, with no database to run and no account to create. And in cockpit mode it
runs many real Claude Code sessions at once, partitioned by domain of your life
rather than ganged onto one repo, each with its own prompt and its own directory.

Single user, by design. If you want a hosted multi-tenant version with a managed
builder and billing, that's Clawdascended, and this is the engine underneath it.

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
- An **Anthropic API key** (`sk-ant-api03-...`) from <https://console.anthropic.com>,
  for chat mode. (No key yet? `ADJUTANT_MOCK=1` in `.env` streams a canned reply
  at zero cost so you can look around.)
- For the Claude Code panes: **Python 3.10+** (macOS ships 3.9, which cannot run
  the bridge: `brew install python@3.12`) and the **Claude Code CLI**, signed in.

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
| `ADJUTANT_ENGINE` | `sdk` | `sdk` | Chat calls the Anthropic API with your key. This build has no other chat engine; the panes reach Claude through the `claude` CLI instead (see below) |
| `ADJUTANT_MOCK` | `1` | unset | Chat streams a canned reply and spends nothing, for demos |
| `ADJUTANT_PROFILE` | profile name | `starter` | Which profile under `profiles/` supplies the domains |
| `ADJUTANT_STATE` | `local` \| `supabase` | `local` | `local` = JSON files under `ADJUTANT_STATE_ROOT`; `supabase` = hosted Postgres |
| `ADJUTANT_AUTH` | `single` \| `magic-link` | `single` | `single` = one implicit local user, no login; `magic-link` = email sign-in |
| `ADJUTANT_STATE_ROOT` | path | `./.adjutant` | Where local data lives |
| `ADJUTANT_MODEL` | model id | `claude-sonnet-4-6` | Which Claude model to use |
| `ADJUTANT_EFFORT` | `low`..`max` | `medium` | Reasoning effort / latency tradeoff |

### Which account pays for what

- **Chat** meters against the Anthropic API key in `.env`.
- **Panes and workers** run the `claude` CLI on your machine, signed in with
  your own Claude plan. That is ordinary use of Claude Code by you. Do **not**
  use Clawdling to give other people access to your subscription or to resell
  it; Anthropic's terms do not allow that. For anything beyond your own
  single-user install, use API keys.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
