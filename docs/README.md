# Clawdling — docs

Clawdling is a self-hostable personal AI OS engine: a chat interface with
acting tools (task management + durable memory + web search) and local-first
state, running on your own Anthropic API key (BYOK).

This `docs/` directory is served by the in-app `/docs` route.

## Documentation map

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the pieces connect (engine, tools,
  state, profile).
- [LOCAL-MODE-LIMITATIONS.md](./LOCAL-MODE-LIMITATIONS.md) — what works today in
  a fresh self-host install, and what is on the roadmap.

## Stack

- **Next.js 16** App Router, React 19, TypeScript, Tailwind 4
- **@anthropic-ai/sdk** for the server-side tool loop (the engine)
- **Local JSON** state by default (`ADJUTANT_STATE=local`); optional Supabase
  for the hosted path
- **NextAuth v5** for sign-in (single-user local mode needs no login)

## Quickstart

See the top-level `README.md` for the 3-command install. In short:

```bash
git clone <this-repo>
cd clawdascended
make install   # copies .env.example -> .env, installs deps, prompts for your key
make run       # starts the app at http://localhost:3000
```

The only required value is your Anthropic API key (`sk-ant-api03-...`), set in
`.env` as `ANTHROPIC_API_KEY`. Every model call meters against your key.
