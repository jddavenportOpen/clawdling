# Contributing to Clawdling

Thanks for your interest in Clawdling — the open-source, bring-your-own-key
personal AI OS engine.

## How this repo is maintained

Clawdling is developed on a private trunk and **published here as versioned,
squashed release exports** (fresh git history per release). That keeps the
public history clean and lets us ship the same engine across our open and
hosted tiers. Practically, this means:

- The `main` branch here is the canonical **public** engine.
- Releases are tagged (`v0.1.0`, …) and correspond to an export of the trunk.
- Community changes flow **public PR → review → private trunk → next export**.
  Your merged change ships in the next release export with attribution.

## Ground rules

1. **Keep it engine-generic.** This repo is the *engine* — chat, acting tools,
   memory, local state, BYOK. It intentionally does **not** contain the hosted
   Builder / self-modification pipeline, billing, provisioning, or premium
   domain packs. PRs that add those are out of scope and will be declined.
2. **No secrets, ever.** A leak-scan gate (`make leak-scan`) runs in CI on every
   PR and blocks merges on any detected key/token. Never commit real keys,
   `.env`, or personal data. See `SECURITY.md`.
3. **Node 24.** This project pins Node `>=24 <26` (Vercel parity). Node 26 has a
   known prerender build failure — use Node 24 (`nvm use`).
4. **Tests + types must pass.** `make test` (vitest) and `npm run typecheck`
   are required. Add tests for behavior changes.
5. **No emoji in source/UI strings** — `npm run lint:no-emoji` enforces it.

## Developer Certificate of Origin (DCO)

By contributing, you certify the [DCO](https://developercertificate.org/).
Sign off every commit:

```bash
git commit -s -m "your message"
```

The trailer `Signed-off-by: Your Name <you@example.com>` must be present.

## Getting started

```bash
git clone <this-repo> clawdling && cd clawdling
nvm use                 # Node 24
./install.sh            # writes .env, prompts for your Anthropic key, installs deps
make dev                # http://localhost:3000
make test               # vitest
make leak-scan          # the same gate CI runs
```

## Reporting bugs / requesting features

Open an issue. For **security** vulnerabilities, do NOT open a public issue —
follow `SECURITY.md`.

## License of contributions

Contributions are licensed under this project's license (AGPL-3.0-or-later).
Do not submit code you cannot license under those terms.
