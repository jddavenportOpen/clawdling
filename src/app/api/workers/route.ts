// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/workers — list every worker run the bridge knows about.
// POST /api/workers — dispatch a new background worker.
//
// Thin proxies to the bridge's own /api/workers endpoints. A *session* is a
// pane you type into; a *worker* is a job you hand off — it gets an objective,
// its own git worktree, and a wall-clock ceiling, and it reports when it is
// done. See bridge/README.md "Workers".
//
// Both verbs live in one file because the bridge exposes both on the same
// path, and Next.js routes a collection by exporting one handler per method.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  parseJsonObject,
  pickWorkerFields,
} from './_lib';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      '/api/workers',
      { method: 'GET' },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const data = (await bridgeRes.json().catch(() => ({ workers: [] }))) as {
    workers?: Array<Record<string, unknown>>;
    running?: number;
    max_workers?: number;
  };
  return Response.json(
    {
      workers: Array.isArray(data.workers) ? data.workers : [],
      running: typeof data.running === 'number' ? data.running : 0,
      max_workers: typeof data.max_workers === 'number' ? data.max_workers : null,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: Request): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const raw = await parseJsonObject(request);
  const body = pickWorkerFields(raw);
  if (!body.objective || !body.objective.trim()) {
    // Caught here so the operator gets the real reason instead of the bridge's
    // pydantic 422 relayed as an opaque "Bridge 422".
    return Response.json({ error: 'objective is required' }, { status: 400 });
  }

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      '/api/workers',
      { method: 'POST', body: JSON.stringify(body) },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const data = (await bridgeRes.json().catch(() => ({}))) as Record<string, unknown>;
  return Response.json(data, { status: bridgeRes.status });
}
