// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/[sid]/resize — tell the bridge PTY the pane's new
// cols/rows (so the Claude Code TUI re-renders for the actual display
// width). Body: { cols, rows }. Matches the shipped caller exactly
// (SessionTerminal's debounced postResize) and the contract.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  parseJsonObject,
} from '../../_lib';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sid: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { sid } = await params;
  if (!sid) {
    return Response.json({ error: 'sid required' }, { status: 400 });
  }

  const raw = await parseJsonObject(request);
  const cols = typeof raw.cols === 'number' ? raw.cols : undefined;
  const rows = typeof raw.rows === 'number' ? raw.rows : undefined;
  if (!cols || !rows) {
    return Response.json({ error: '"cols" and "rows" (numbers) are required' }, { status: 400 });
  }

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      `/api/sessions/${encodeURIComponent(sid)}/resize`,
      { method: 'POST', body: JSON.stringify({ cols, rows }) },
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
