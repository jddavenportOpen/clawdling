# Self-host: what works today

Clawdling is in alpha. Set expectations honestly so a fresh self-host
install is not confusing.

## Works
- **Chat** — the core experience. Streaming replies, thread history, and web
  search/fetch (the assistant can look up current information).
- **Acting tools** — the assistant can manage your task list (create, list,
  complete tasks) and remember/recall durable facts you share.
- **Sign-in** — single-user local mode needs no login; magic-link for multi-user.
- **Docs** and **Settings** (manage your key, model, effort, and budget).

## Not wired yet
- **Projects** and the **Agents** roster are not carved into this release and are
  not reachable from a fresh install.

The starter profile ships three generic domains (Work, Personal, Notes). Domain
dashboards are declarative and on the roadmap; today the value is in Chat plus
the task and memory tools. Nothing crashes — surfaces that are not yet populated
show an empty or "coming soon" state.

## Roadmap
- Profile-driven domain dashboards fed from your own data.
- Client-side tools (read/edit files, run commands) for the self-host path,
  where you have a real machine to act on.
