// ═══════════════════════════════════════════════════════════════════════════
// POST /api/chat/[threadId]/cancel
//
// Thin proxy to the Mac Mini bridge `POST /api/chat/{threadId}/cancel`.
// Cancels an in-flight Claude turn for the given thread. Used by the
// SessionSidebar "Cancel" action.
//
// Response (from bridge): { cancelled: boolean, thread_id: string }
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { bridgeFetch } from '@/lib/bridge-client';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const email = (session?.user as { email?: string } | undefined)?.email;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { threadId } = await params;
  if (!threadId) {
    return Response.json({ error: 'threadId is required' }, { status: 400 });
  }

  const bridgePath = `/api/chat/${encodeURIComponent(threadId)}/cancel`;

  let bridgeResp: Response;
  try {
    bridgeResp = await bridgeFetch(
      bridgePath,
      { method: 'POST' },
      userId,
      email || 'unknown@local'
    );
  } catch (err) {
    return Response.json(
      { error: `Failed to reach bridge: ${String(err)}` },
      { status: 502 }
    );
  }

  const body = await bridgeResp.text();
  return new Response(body, {
    status: bridgeResp.status,
    headers: {
      'Content-Type':
        bridgeResp.headers.get('content-type') || 'application/json',
    },
  });
}
