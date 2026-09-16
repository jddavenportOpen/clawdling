// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/[sid]/input — write text to the PTY.
//
// ⚠ LOAD-BEARING TRANSLATION — read before touching this file.
// BRIDGE-CONTRACT.md's documented body is `{ "data": "<text>" }`. The
// SHIPPED UI never sends that key: SessionTerminal.submitInput,
// ChatGridPane's echo-retry, CleanComposer and AskUserQuestionCard — every
// caller in this codebase, verified by reading all four — POST
// `{ "text": "<text>" }`. This route accepts EITHER key from the browser
// (text preferred, since that's what's actually shipped; data accepted for
// contract fidelity / any future caller) and always forwards `{ data }` to
// the bridge, since that's the key the Python half was built against. This
// is the single highest-traffic spot in the whole contract — every
// keystroke goes through it — so the translation is deliberate and
// explicit, not a silent guess. See the build report for the full finding.
//
// The caller appends "\r" itself for submit (contract note, matches
// SessionTerminal: `text + '\r'`) — this route writes the value through
// verbatim, it doesn't append anything itself.
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
  const value =
    typeof raw.text === 'string'
      ? raw.text
      : typeof raw.data === 'string'
        ? raw.data
        : undefined;
  if (value === undefined) {
    return Response.json({ error: '"text" (or "data") is required' }, { status: 400 });
  }

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      `/api/sessions/${encodeURIComponent(sid)}/input`,
      { method: 'POST', body: JSON.stringify({ data: value }) },
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
