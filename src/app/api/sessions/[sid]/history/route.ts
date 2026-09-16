// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sessions/[sid]/history — the durable transcript, byte-addressable.
//
// ⚠ THE BODY IS RAW TEXT, NOT JSON. Read the consumer before changing that:
// SessionTerminal.seedHistoryTail does `await res.text()` and writes the
// result straight into xterm, ANSI and all. Wrapping it in `{ data: ... }`
// would paint a JSON envelope into the terminal.
//
// What the shipped component actually needs from this route, all four
// verified by reading it (src/components/chat/SessionTerminal.tsx):
//
//   1. `?bytes=51200` on mount — the tail seed.
//   2. `?bytes=524288&start=<cursor>` on visibility/focus return — only what
//      was appended since the cursor. This is the "out of sight is not out of
//      mind" path and it runs on every alt-tab, so it must stay cheap.
//   3. `X-Session-Log-Total-Bytes` on EVERY response, which becomes the next
//      cursor. When the header is missing the component falls back to
//      counting the bytes it received, which drifts on multi-byte characters
//      — so the header is forwarded verbatim, never recomputed here.
//   4. A 404 that MEANS something: the component treats it as "no prior
//      history, this pane is fresh", sets historyChecked, and still opens the
//      live stream. So a 404 is relayed as a 404 and is not an error state.
//
// Unlike /stream this route IS proxied rather than handed to the browser: it
// is a bounded one-shot blob, not a long-lived connection, so it does not hit
// the serverless function timeout that forced the stream to go browser-direct.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
} from '../../_lib';

export const dynamic = 'force-dynamic';

/** Headers the bridge owns and the browser needs. Nothing else is forwarded. */
const PASSTHROUGH_HEADERS = [
  'X-Session-Log-Total-Bytes',
  'X-Session-Log-Start-Byte',
  'X-Session-Log-Gap',
] as const;

/** A non-negative integer query value, or undefined. Garbage is dropped
 *  rather than relayed: the bridge would ignore it anyway, and forwarding a
 *  bad value only makes the failure harder to read. */
function nonNegative(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return String(n);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sid: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { sid } = await params;
  if (!sid) return Response.json({ error: 'sid required' }, { status: 400 });

  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  const bytes = nonNegative(incoming.get('bytes'));
  const start = nonNegative(incoming.get('start'));
  if (bytes !== undefined) query.set('bytes', bytes);
  if (start !== undefined) query.set('start', start);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      `/api/sessions/${encodeURIComponent(sid)}/history${suffix}`,
      { method: 'GET' },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  // 404 included: the component reads it as "fresh pane", which is a real
  // answer, so it is relayed with its own status rather than flattened.
  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  for (const name of PASSTHROUGH_HEADERS) {
    const value = bridgeRes.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  return new Response(await bridgeRes.text(), { status: 200, headers });
}
