# Known Issues

## Production build (`next build`) fails on `/_global-error` (Next.js 16.2.x)

**Status:** open, upstream framework bug. Tracked — not a Clawdling code bug.

**Symptom.** `make build` (`next build`) compiles the whole app, then fails at
the static-export step with:

```
Error occurred prerendering page "/_global-error".
TypeError: Cannot read properties of null (reading 'useContext')
Export encountered an error on /_global-error/page: /_global-error, exiting the build.
```

**What it is.** A Next.js 16 regression: the framework crashes while statically
prerendering its own internal `/_global-error` page under React 19. It is **not**
caused by anything in this repo. We reproduced it with:

- the **default** framework global error page (our custom `global-error.tsx`
  removed entirely) — still fails;
- a **bare-minimum** root layout (`<html><body>{children}</body></html>`, no
  client providers) — still fails;
- `export const dynamic = 'force-dynamic'` on the error page — ignored by Next
  for framework pages, no effect;
- React pinned to `19.1.0`, and Next bumped `16.2.3 → 16.2.10 → 16.3.0-preview.5`
  — the crash persists on every combination.

It is **not** Node-version specific. It fails identically on Node 24 and Node 26,
and on Linux inside Docker (same `next build`). Earlier README wording that
framed this as "a Node 26 quirk that Node 24 / Docker sidesteps" was wrong and
has been corrected.

**Upstream:** vercel/next.js
[#85668](https://github.com/vercel/next.js/issues/85668),
[#86178](https://github.com/vercel/next.js/issues/86178),
[#84994](https://github.com/vercel/next.js/issues/84994).
No released fix as of Next 16.2.10 / 16.3.0-preview.5 (July 2026).

**Impact.** The production build (`make build` / `make start`, and therefore the
Docker image which runs the standalone output of that build) does not complete.

**What works today.** Development mode is the supported self-host path and is
fully functional:

```bash
make run        # next dev — http://localhost:3000
```

`next dev` does not run the static export step, so the `/_global-error` crash
never occurs. The chat + acting tools + local-store round-trip all work in dev.

**What we fixed while chasing this.** Several *app* pages (`/login`,
`/login/verify`, the custom `not-found`) were also crashing during static
prerender for the same React-19 null-dispatcher reason. Those are resolved:
the root layout is now `force-dynamic` (correct for a single-user, auth-gated
cockpit that gains nothing from SSG), and a custom `not-found.tsx` ships. After
those fixes, **`/_global-error` is the only page that still fails** — and that
one is unreachable from app code.

**When this clears upstream**, re-enabling the prod build is a no-op: drop this
note, and `make build` / `make start` / the Docker image will work as written.
