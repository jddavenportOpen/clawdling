# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report privately through one of:

1. **GitHub Private Vulnerability Reporting** (preferred) — use the
   **Security → Report a vulnerability** button on this repository. This opens
   a private advisory visible only to the maintainers.
2. **Email** — `security@clawdascended.app`. If you do not receive an
   acknowledgement within 5 business days, fall back to the GitHub channel
   above (it is the guaranteed path).

Please include: affected version/commit, a description, reproduction steps, and
impact. If you have a suggested fix, include it.

## Scope

This repository is the **Clawdling engine** — BYOK, single-tenant, self-hosted.
The most relevant classes of issue:

- Handling of the user's `ANTHROPIC_API_KEY` (it is stored only in the
  gitignored `.env` or encrypted at rest via `src/lib/crypto-key.ts`).
- Local state under `ADJUTANT_STATE_ROOT`.
- Auth (`ADJUTANT_AUTH=single|magic-link`) and, when
  `ADJUTANT_STATE=supabase`, tenant isolation / RLS.

The hosted, managed product (Builder pipeline, billing, provisioning) is a
separate offering and out of scope for this repository's advisories.

## What to expect

- Acknowledgement within 5 business days.
- A fix or mitigation plan for confirmed issues, and a coordinated disclosure
  timeline. Credit is given to reporters who want it.

## Supported versions

Only the latest tagged release (`main`) receives security fixes during this
early phase.
