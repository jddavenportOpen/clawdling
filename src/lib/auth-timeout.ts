// ═══════════════════════════════════════════════════════════════════════════
// auth-timeout.ts — wrap NextAuth's `auth()` with a hard wall-clock budget
//
// 2026-05-03: Reproduced via curl that `GET /chat` with an expired/rejected
// `__Secure-authjs.session-token` cookie hangs server-side for 30s+ before
// returning anything. The browser tab spins, the user sees "errors when I go
// back and forth between chats," and a 10-pane fleet that loses any one
// session degrades to "everything looks dead." The actual SupabaseAdapter
// session-validation path is somewhere between NextAuth core and the adapter
// retrying against Supabase — root cause not yet pinned, but the user-facing
// fix is a hard timeout: validate fast OR give up and redirect to /login.
//
// Use this anywhere a Server Component or route handler would call `auth()`
// directly. Default budget 1500ms — well below Vercel's 10s function timeout
// and below the typical "page feels broken" threshold (~2s).
//
// Behavior on timeout:
//   - Resolves to null (caller treats as "not signed in")
//   - Logs a single-line WARN with elapsed_ms — track these to find the
//     underlying hang.
//
// On success: returns whatever `auth()` returned (Session | null).
// ═══════════════════════════════════════════════════════════════════════════

import type { Session } from 'next-auth';
import { auth } from '@/auth';
import { isSingleUserAuth, singleUserSession } from '@/lib/local-auth';

const DEFAULT_BUDGET_MS = 1500;

interface TimeoutOptions {
  /** Override the default 1500ms budget. */
  budgetMs?: number;
  /** Optional label for the WARN log (e.g. route path) so we can attribute
   *  hangs to specific call sites. */
  label?: string;
}

export async function authWithTimeout(
  opts: TimeoutOptions = {},
): Promise<Session | null> {
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const label = opts.label ?? 'unspecified';
  const started = Date.now();

  // ── Single-user local auth (ADJUTANT_AUTH=single) ───────────────────────
  // Self-host default: one implicit local user, no SupabaseAdapter, no
  // magic-link. This is the single chokepoint wrapping all auth() call sites,
  // so returning here gives every Server Component + route handler the fixed
  // local session without touching auth.ts's Supabase-backed database sessions.
  if (isSingleUserAuth()) {
    return singleUserSession();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      const elapsed = Date.now() - started;
      // Single-line WARN — pipe through Vercel logs to track frequency +
      // attribute to a call site.
      console.warn(
        `[auth-timeout] auth() exceeded ${budget}ms budget at "${label}" ` +
          `(elapsed=${elapsed}ms) — falling back to null session.`,
      );
      resolve(null);
    }, budget);
  });

  try {
    const result = await Promise.race([auth(), timeoutPromise]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
