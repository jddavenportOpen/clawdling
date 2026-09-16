// ═══════════════════════════════════════════════════════════════════════════
// GET /api/workers/[runId]/log — the tail of a worker run's log.
//
// Query: `stream` (`events` | `stderr`) and `tail` (line count). `events` is
// the CLI's stream-json stdout, which is the artifact the run's outcome is read
// from; `stderr` is everything the child wrote to stderr. They are separate
// files on the bridge on purpose — interleaving a stack trace into the JSONL
// would corrupt the one parseable record of the run.
//
// This route deliberately does NOT proxy the bridge's `?follow=1` SSE variant.
// Long-lived streams are the exact thing the session family routes AROUND (a
// serverless function ceiling severs them mid-stream), which is why the pane
// stream is a metadata endpoint that hands the browser a direct bridge URL.
// A polled tail is honest here: a worker is a minutes-to-hours job, not a
// keystroke loop. The bridge's follow stream is still there for a CLI client.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  bridgeWorkerPath,
} from '../../_lib';

export const dynamic = 'force-dynamic';

const STREAMS = new Set(['events', 'stderr']);
const DEFAULT_TAIL = 200;
const MAX_TAIL = 2000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { runId } = await params;
  if (!runId) return Response.json({ error: 'runId required' }, { status: 400 });

  const url = new URL(request.url);
  const stream = url.searchParams.get('stream') || 'events';
  if (!STREAMS.has(stream)) {
    return Response.json(
      { error: `unknown stream '${stream}'. Use 'events' or 'stderr'.` },
      { status: 400 }
    );
  }

  const rawTail = Number(url.searchParams.get('tail'));
  const tail = Number.isFinite(rawTail) && rawTail > 0
    ? Math.min(Math.trunc(rawTail), MAX_TAIL)
    : DEFAULT_TAIL;

  const query = `?stream=${encodeURIComponent(stream)}&tail=${tail}`;

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      bridgeWorkerPath(runId, `/log${query}`),
      { method: 'GET' },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const data = (await bridgeRes.json().catch(() => ({ lines: [] }))) as Record<string, unknown>;
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
