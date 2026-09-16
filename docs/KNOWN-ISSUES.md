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
