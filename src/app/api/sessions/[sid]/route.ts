// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/sessions/[sid] — kill a session (SIGTERM, then SIGKILL after
// 5s, per BRIDGE-CONTRACT.md). Idempotent on the bridge side; this route
// just relays whatever the bridge reports (including a 404 for an already-
// gone sid — that's real information, not swallowed here).
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import { requireSessionAuth, unauthorized, bridgeUnreachable, relayBridgeError } from '../_lib';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ sid: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { sid } = await params;
  if (!sid) {
    return Response.json({ error: 'sid required' }, { status: 400 });
  }

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      `/api/sessions/${encodeURIComponent(sid)}`,
      { method: 'DELETE' },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const data = await bridgeRes.json().catch(() => ({ ok: true }));
  return Response.json(data, { status: bridgeRes.status });
}
