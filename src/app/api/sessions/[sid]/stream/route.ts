// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sessions/[sid]/stream — SSE METADATA ONLY.
//
// Per BRIDGE-CONTRACT.md: never proxy the SSE body through Next — a
// serverless function timeout would sever every long-lived stream. Mint a
// short-lived bridge JWT server-side (BRIDGE_SECRET never reaches the
// browser) and hand back the fully-qualified bridge stream URL; the
// browser opens EventSource DIRECTLY against the bridge from there
// (SessionTerminal.connectViaGet, the GET/EventSource transport — see the
// build report for why this is the transport that matters for v1).
//
// No bridge call happens in this route at all — reused bridgeStreamUrl()
// + signBridgeJWT() just mint a token and build a URL string. That's
// deliberate (metadata-only should be fast and synchronous), but it also
// means there's no "bridge unreachable" case to detect HERE — the actual
// bridge reachability check happens when the browser's EventSource opens
// stream_url directly, which SessionTerminal already has reconnect/error
// handling for.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeStreamUrl } from '@/lib/bridge-client';
import { signBridgeJWT } from '@/lib/bridge-jwt';
import { requireSessionAuth, unauthorized } from '../../_lib';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sid: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { sid } = await params;
  if (!sid) {
    return Response.json({ error: 'sid required' }, { status: 400 });
  }

  const token = await signBridgeJWT(session.userId, session.email);

  return Response.json(
    {
      stream_url: bridgeStreamUrl(sid, token),
      session_id: sid,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
