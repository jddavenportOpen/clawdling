// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sessions/list — thin proxy to the bridge's GET /api/sessions.
//
// Polled by ChatGrid (~3.5s enrichment poll + mount-time sid validation),
// ThreadSidebar (5s SWR), NeedsYouNotifier and LiveProjectSessions. Every
// one of those consumers already checks `res.ok` before touching the body
// and degrades gracefully (keep previous state / empty set / best-effort)
// on anything non-2xx — verified by reading all four call sites. So this
// route returns a normal diagnosable error on bridge failure (same pattern
// as every other route here) rather than a special soft-200; nothing
// downstream needs the softened shape.
//
// Response fields: passes the bridge's per-session objects through
// unmodified (session_id, name, cwd, domain, model, status, created_at,
// last_activity per BRIDGE-CONTRACT.md) plus withCompatAliases()'s additive
// `id` / `thread_id` / `live` — several ported components key off those
// instead of the contract's names (verified: ChatGrid.fetchSessionMeta and
// the enrichment poll both do `s.id`; ThreadSidebar/railModel/
// LiveProjectSessions read `.live`). See _lib.ts for the full reasoning.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  withCompatAliases,
} from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      '/api/sessions',
      { method: 'GET' },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const data = (await bridgeRes.json().catch(() => ({ sessions: [] }))) as {
    sessions?: Array<Record<string, unknown>>;
  };
  const sessions = Array.isArray(data.sessions) ? data.sessions.map(withCompatAliases) : [];
  return Response.json({ sessions }, { headers: { 'Cache-Control': 'no-store' } });
}
