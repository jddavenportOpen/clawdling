# Changelog

All notable changes to Clawdling are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — unreleased

The first open-source release of the Clawdling engine — the bring-your-own-key,
self-hostable personal AI OS engine behind Clawdascended.

### Added
- **BYOK chat engine** — persistent, streaming assistant driven by the Anthropic
  Messages API using **your own** `sk-ant-api03-` key. Every call meters against
  your key; nothing is marked up or proxied.
- **Acting tools** — the assistant can `create_task` / `list_tasks` /
  `complete_task` and `remember` / `recall`, backed by local JSON state.
- **Local-first state** — `ADJUTANT_STATE=local` stores everything under
  `ADJUTANT_STATE_ROOT` (default `./.adjutant`). No cloud accounts required.
  Optional `ADJUTANT_STATE=supabase` for a hosted Postgres backend.
- **Starter profile** — three generic starter domains (work / personal / notes)
  so a fresh install is usable out of the box; edit to make it yours.
- **Three-command install** — `install.sh` + `make run`, plus a Docker path.
- **AGPL-3.0-or-later** license; governance (CONTRIBUTING, SECURITY, CoC).

### Fixed
- **Tools ON by default + task round-trip** — the core acting tools ship enabled
  (`ADJUTANT_TOOLS` defaults to `web,tasks,memory`) and `create_task` now writes
  an explicit `status:'open'` so a freshly created task appears in `list_tasks`
  on the local store (the JSON adapter applies no column defaults). Guarded by a
  new local-store round-trip vitest test.
- **App-page static-prerender crashes** — `/login`, `/login/verify`, and the new
  custom `not-found` no longer crash `next build` (root layout is `force-dynamic`;
  correct for a single-user auth-gated cockpit). The remaining `/_global-error`
  crash is upstream — see Known issues.

### Not included (by design)
This is the **engine only**. The hosted Builder / self-modification pipeline,
billing/metering, hosted provisioning, and curated premium domain packs are part
of the managed Clawdascended product and are not in this repository.

### Known issues
- **Production build blocked upstream.** `make build` / `make start` (and the
  Docker image) do not complete: Next.js 16.2.x crashes prerendering its own
  `/_global-error` page (React 19 null-dispatcher; vercel/next.js #85668 /
  #86178). Not Node-version specific, not sidestepped by Docker. Self-host via
  `make run` (dev) until the upstream fix lands. Detail: `docs/KNOWN-ISSUES.md`.
