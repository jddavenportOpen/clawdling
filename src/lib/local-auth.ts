// ═══════════════════════════════════════════════════════════════════════════
// local-auth.ts — single-user local auth for the self-host build
//
// When ADJUTANT_AUTH=single (the OSS self-host default), the cockpit runs for
// ONE implicit local user with no magic-link, no email allowlist, and no
// Supabase SupabaseAdapter/database session. Every `auth()` call site reads
// session.user.id; in single mode that id is a fixed, valid UUIDv4 so it
// survives isUuid() guards and any residual uuid-typed columns / Claude CLI
// session-id constraints.
//
// It produces the standard NextAuth session shape so downstream code needs
// zero changes.
//
// Wired in at two chokepoints:
//   - src/lib/auth-timeout.ts  → returns singleUserSession() before real auth()
//   - src/proxy.ts             → allows every request through the edge gate
// ═══════════════════════════════════════════════════════════════════════════

import type { Session } from 'next-auth';

/** Fixed local user id. Valid UUIDv4 (variant/version bits set) so it passes
 *  isUuid() and any uuid-typed column without a 22P02. Recognizable all-zero
 *  prefix + "…001" suffix so it's grep-able in logs. */
export const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';

/** Local user email — cosmetic; overridable so a self-hoster can see their own
 *  address in the UI. Defaults to a non-routable .localhost address. */
export const LOCAL_USER_EMAIL = (
  process.env.ADJUTANT_LOCAL_EMAIL || 'local@adjutant.localhost'
).trim();

/** True when single-user local auth is active. */
export function isSingleUserAuth(): boolean {
  return process.env.ADJUTANT_AUTH === 'single';
}

/**
 * Build the synthetic Session for the single local user. Same shape NextAuth's
 * session callback would produce for a real signed-in user (see auth.ts), so
 * every session.user.id / session.user.email reader works unchanged.
 */
export function singleUserSession(): Session {
  // 1-year expiry — the self-host cockpit never signs out.
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  return {
    user: {
      id: LOCAL_USER_ID,
      email: LOCAL_USER_EMAIL,
      name: 'Local User',
    } as Session['user'],
    expires,
  };
}
