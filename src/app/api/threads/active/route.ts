// ═══════════════════════════════════════════════════════════════════════════
// GET /api/threads/active — proxy to the local bridge for the
// sidebar pulse-dot UI (see docs/ARCHITECTURE.md).
//
// The bridge tracks per-thread asyncio locks. A locked thread = a claude
// subprocess is currently running for that thread_id. The sidebar polls this
// endpoint every 5s when the tab is visible (30s when hidden) and renders a
// green pulsing dot on each active thread row.
//
// Auth: forwards the user's NextAuth session to bridgeFetch (same pattern as
// the chat routes). When the user is not signed in we return an empty result
// rather than 401 — the sidebar may poll while auth state is in transition,
// and a 401 would spam the console without giving the user any signal.
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { bridgeFetch } from '@/lib/bridge-client';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const userEmail = (session?.user as { email?: string } | undefined)?.email;

  // Unauthenticated → empty result (don't 401; sidebar polls during sign-in).
  if (!userId) {
    return Response.json(
      { active_thread_ids: [], as_of: null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const res = await bridgeFetch(
      '/api/threads/active',
      { method: 'GET' },
      userId,
      userEmail || 'unknown@local'
    );

    if (!res.ok) {
      // Bridge unhealthy or auth failed — degrade to empty rather than break
      // the sidebar render loop.
      return Response.json(
        { active_thread_ids: [], as_of: null },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const body = await res.json();
    return Response.json(body, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    // Network / tunnel hiccup — same fallback.
    return Response.json(
      { active_thread_ids: [], as_of: null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
