// ═══════════════════════════════════════════════════════════════════════════
// GET    /api/workers/[runId] — one worker run's record.
// DELETE /api/workers/[runId] — stop it (SIGTERM the process group, SIGKILL
//                               after 5s). Idempotent on the bridge side.
//
// DELETE forwards `?reap=1`, which asks the bridge to ALSO delete the run's
// git worktree. That request is advisory: the bridge refuses whenever the
// worktree still holds commits reachable from no other ref, or uncommitted
// changes, and the refusal comes back in `reap_refused` rather than being
// swallowed. There is deliberately no force flag on this route.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  bridgeWorkerPath,
} from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { runId } = await params;
  if (!runId) return Response.json({ error: 'runId required' }, { status: 400 });

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      bridgeWorkerPath(runId),
      { method: 'GET' },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const data = await bridgeRes.json().catch(() => ({}));
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { runId } = await params;
  if (!runId) return Response.json({ error: 'runId required' }, { status: 400 });

  const reap = new URL(request.url).searchParams.get('reap') === 'true';
  const path = bridgeWorkerPath(runId, reap ? '?reap=true' : '');

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      path,
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
