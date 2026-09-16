// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/[sid]/key — send a RAW keystroke to the PTY.
//
// This is what makes a Claude Code pane usable rather than merely alive.
// Claude Code drives permission prompts, plan mode and AskUserQuestion as
// arrow-key menus, and answering one needs a bare Up/Down/digit/Enter/Esc
// with NO "\r" appended and none of /input's submit machinery.
//
// Callers (both verified by reading them):
//   SessionTerminal.sendKey        — menu navigation off the live PTY scan
//   AskUserQuestionCard            — digit-jump then Enter, or space-toggle
//                                    then Enter for multi-select
// Both POST `{ key?: string; bytes?: string }`, sometimes as a short
// sequence (digit, then enter).
//
// There is no bridge-side `/key`: the bridge's /input already writes bytes
// through verbatim, so this route resolves the key NAME to its escape
// sequence here and forwards the raw bytes. Keeping the name table in one
// place means the bridge stays a dumb, auditable byte pipe.
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

/** Named key -> the bytes a terminal actually expects. */
const KEYS: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  space: ' ',
  backspace: '\x7f',
  delete: '\x1b[3~',
  escape: '\x1b',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-u': '\x15',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sid: string }> }
): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const { sid } = await params;
  if (!sid) return Response.json({ error: 'sid required' }, { status: 400 });

  const raw = await parseJsonObject(request);

  // `bytes` wins when present: it is the literal the caller wants on the wire
  // (a digit, a character). `key` is the named-key path.
  let value: string | undefined;
  if (typeof raw.bytes === 'string' && raw.bytes.length > 0) {
    value = raw.bytes;
  } else if (typeof raw.key === 'string' && raw.key.length > 0) {
    const name = raw.key.trim().toLowerCase();
    value = KEYS[name];
    if (value === undefined) {
      // A single printable character is a legitimate `key` too (e.g. "1").
      if ([...raw.key].length === 1) value = raw.key;
      else {
        return Response.json(
          { error: `unknown key "${raw.key}"`, known: Object.keys(KEYS) },
          { status: 400 }
        );
      }
    }
  }

  if (value === undefined) {
    return Response.json({ error: '"key" or "bytes" is required' }, { status: 400 });
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
