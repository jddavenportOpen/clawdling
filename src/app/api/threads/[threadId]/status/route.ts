// ═══════════════════════════════════════════════════════════════════════════
// GET /api/threads/[threadId]/status
//
// chat-multi-agent-v1 — proxy to bridge GET /api/threads/{thread_id}/status.
// Returns the live status of an active turn from the per-thread ring buffer:
//   { thread_id, active, buffer_present, completed, started_at_ms,
//     completed_at_ms, elapsed_sec, current_tool, latest_seq,
//     last_event_preview, last_event_ts_ms }
//
// Used by the multi-session dashboard at /chat to render live cards.
// Auth: NextAuth session cookie. Bridge JWT minted server-side.
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { bridgeFetch } from '@/lib/bridge-client';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const email = session?.user?.email;
  if (!userId || !email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { threadId } = await params;
  if (!threadId) {
    return Response.json({ error: 'threadId required' }, { status: 400 });
  }

  try {
    const res = await bridgeFetch(
      `/api/threads/${encodeURIComponent(threadId)}/status`,
      { method: 'GET' },
      userId,
      email
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return Response.json(
        { error: `Bridge ${res.status}: ${text.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const body = await res.json();
    return Response.json(body, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return Response.json(
      { error: `Bridge unreachable: ${String(err)}` },
      { status: 502 }
    );
  }
}
