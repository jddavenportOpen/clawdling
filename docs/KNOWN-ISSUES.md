# Known issues

## `next build` crashes on `/_global-error` with `useContext of null`

**Symptom.** `make build` compiles the whole app, then fails at the static-export
step:

```
TypeError: Cannot read properties of null (reading 'useContext')
Export encountered an error on /_global-error/page: /_global-error, exiting the build.
```

**Cause.** `NODE_ENV=development` is set in the shell running the build. Next then
runs the export with React's development bundle, the dispatcher is null, and
prerendering the framework's own `/_global-error` page throws.

**Fix.**

```bash
env -u NODE_ENV make build      # or: unset NODE_ENV
```

`next build` must run with `NODE_ENV` unset or set to `production`. This is not a
framework bug and it is not specific to Clawdling: any Next 16 app fails the same
way under a development `NODE_ENV`. Docker is unaffected, because the builder
stage in `Dockerfile` sets no `NODE_ENV`.

**History.** Earlier versions of this file blamed an open upstream Next.js 16 bug
and pointed at `vercel/next.js` issues #85668 / #86178. That diagnosis was wrong.
The builds that "confirmed" it, including the bare-layout and pristine-config
control tests, were all run inside the same shell that had `NODE_ENV=development`
exported, so every variation failed and the environment variable was never the
suspect. Re-tested 2026-09-16 on Next 16.2.3 / Node 26: identical tree, identical
command, `NODE_ENV=development` fails and `env -u NODE_ENV` produces
`.next/standalone/server.js`. The production build and the Docker image work.

## Some dashboards render empty on a fresh install

The chat and tools path (tasks + memory) works end to end on a clean clone. Some
domain dashboards are not yet wired to local state and will render empty until
they are. Chat, tasks and memory are the supported surface in this release.

## Cockpit mode: what is verified, and what is not

Verified end to end (2026-09-16): spawn a pane through `POST /api/sessions/cockpit-spawn`,
fetch stream metadata, send input, receive the echo over SSE straight from the
bridge, list sessions, delete, and confirm the child process is gone with no
orphans. Also verified: boot a bridge, spawn, send input, **kill the bridge
process**, boot a second one over the same state root, and get the session back
from `GET /api/sessions` with its output still readable from
`GET /api/sessions/{sid}/history` — including after a `kill -9` with no
graceful shutdown. 163 bridge tests and 490 web tests pass.

Not built yet, and the UI degrades rather than crashing on each:

- `/upload`, `/costs`, `/metadata`, `/title`, `/rehydrate` and `/stream-post`
  are not implemented and return 404.
- **No multi-user authorization.** Any valid token can reach any session, which
  is correct for a single-user local bridge and wrong for anything shared.
- `persistent: true` on a domain spawn is accepted and ignored; there are no
  persistent "continuity brains" in this release, so that badge stays dark.
- `PaneSwitcher` colors its status dot by comparing against the literal string
  `live`; the bridge reports `running`, so that one dot renders in the default
  color. Cosmetic.

### Transcript persistence: what it does and does not restore

Pane history now survives a bridge restart (`bridge/README.md`, "Persistence").
Three honest limits on top of that:

- **A restart still ends the `claude` processes.** The transcript and
  `--resume` bring the history and the model's context back under a NEW pane;
  you are not reattached to the old process. Nothing is resurrected on boot, on
  purpose — a bridge that adopted a terminal it does not hold would be
  guessing.
- **Nothing calls `resume_from` automatically yet.** The bridge accepts it on
  spawn and the plumbing is tested end to end, but no UI control asks for it,
  so today resuming a conversation is an API call, not a button.
- **A transcript is a verbatim PTY capture.** Anything a pane prints — secrets
  included — lands in plain text under `CLAWDLING_STATE_ROOT` until retention
  removes it. `CLAWDLING_TRANSCRIPTS=0` opts out.
