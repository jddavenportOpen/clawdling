// ═══════════════════════════════════════════════════════════════════════════
// GET /api/chat/[threadId]/resume-stream
//
// chat-multi-agent-v1 — metadata endpoint for the resume EventSource.
//
// Same pattern as /api/sessions/[sid]/stream: we don't proxy SSE through
// Next.js (Vercel timeouts would kill long resumes). Instead, this route
// authenticates the user, verifies thread ownership, mints a 15-min bridge
// JWT, and returns { stream_url, token } so the browser can open
// EventSource directly at the Mac Mini bridge.
//
// The frontend (ChatView.tsx → SSEReconnect) calls this on mount when the
// thread is remotely active, then opens EventSource at:
//   `${stream_url}?token=<jwt>&since_seq=<lastSeq>`
// (The old `useResumeStream` hook that also called this was dead code —
// ChatView reimplemented the resume inline via SSEReconnect — and was deleted
// 2026-06-12, ADV-4.)
//
// Bridge endpoint: GET /api/chat/turn/{thread_id}/stream — see
// bridge/routes/chat.py.
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { getThreadById } from '@/lib/chat';
import { signBridgeJWT } from '@/lib/bridge-jwt';
import { BRIDGE_URL } from '@/lib/bridge-client';

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
    return Response.json({ error: 'threadId is required' }, { status: 400 });
  }

  // Ownership check.
  const thread = await getThreadById(threadId, userId);
  if (!thread) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const token = await signBridgeJWT(userId, email);
  // Direct-to-bridge URL. Browser will append ?token=…&since_seq=… on use.
  const streamUrl = `${BRIDGE_URL}/api/chat/turn/${encodeURIComponent(threadId)}/stream`;

  return new Response(
    JSON.stringify({
      stream_url: streamUrl,
      token,
      expires_in: 15 * 60,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    }
  );
}
