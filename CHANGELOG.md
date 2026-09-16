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
- **Three-command install** — `git clone` + `install.sh` + `make run` (dev mode).
  `make build` / `make start` and the Docker image all work.
- **AGPL-3.0-or-later** license; governance (CONTRIBUTING, SECURITY, CoC).
- **Cockpit transcript persistence** — pane history survives a bridge restart.
  Every session's PTY output is appended to
  `$CLAWDLING_STATE_ROOT/transcripts/<id>.log` with a JSON sidecar; buffering
  keeps the disk off the event loop, and a background flusher plus an exit hook
  mean a `kill -9` loses at most half a second. On boot the sidecars come back
  as session RECORDS (listed, readable, always `exited` — nothing is
  resurrected), `GET /api/sessions/{sid}/history` serves the log
  byte-addressably for the cockpit's mount-seed and catchup fetches, and a
  reattach whose cursor has fallen out of the in-memory ring is served from
  disk instead of reporting a gap. Retention is capped by count and age and
  never touches a live session.
- **`claude --resume` support** — spawns name their conversation with
  `--session-id`, and a spawn carrying `resume_from` continues it, so a
  restarted pane can get the model's context back and not just the text.
  Best-effort by design: `--resume` on an unknown id makes the CLI exit
  immediately, so the bridge probes first and otherwise spawns fresh with
  `resume_status: "unavailable"`.

### Fixed
- **Tools ON by default + task round-trip** — the core acting tools ship enabled
  (`ADJUTANT_TOOLS` defaults to `web,tasks,memory`) and `create_task` now writes
  an explicit `status:'open'` so a freshly created task appears in `list_tasks`
  on the local store (the JSON adapter applies no column defaults). Guarded by a
  new local-store round-trip vitest test.
- **App-page static-prerender crashes** — `/login`, `/login/verify`, and the new
  custom `not-found` no longer crash `next build` (root layout is `force-dynamic`;
  correct for a single-user auth-gated cockpit). The `/_global-error` crash that
  remained was a `NODE_ENV=development` build shell, not a framework bug — see
  Known issues.

### Not included (by design)
This is the **engine only**. The hosted Builder / self-modification pipeline,
billing/metering, hosted provisioning, and curated premium domain packs are part
of the managed Clawdascended product and are not in this repository.

### Known issues
- **`next build` requires a non-development `NODE_ENV`.** If `NODE_ENV=development`
  is exported in your build shell, `next build` crashes prerendering
  `/_global-error`. Use `env -u NODE_ENV make build`. This affects any Next 16 app,
  not just Clawdling. Detail: `docs/KNOWN-ISSUES.md`.
