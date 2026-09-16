// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/cockpit-spawn — ad-hoc / project spawn.
//
// BRIDGE-CONTRACT.md: "-> bridge spawn (ad-hoc/project; { cwd?,
// initial_prompt? })". Narrower than the generic /api/sessions/spawn route:
// only cwd + initial_prompt are accepted here, everything else is dropped
// before forwarding to the SAME bridge endpoint.
//
// Consumer: NewSessionPicker.spawnCockpit(). It hard-requires the response
// to carry a truthy `thread_id` (`if (!res.ok || !data.session_id ||
// !data.thread_id) { setError(...); return; }` — a MISSING thread_id is
// treated as a FAILED spawn and onLaunched() is never called, even though
// the bridge successfully created the session). v1 has no separate thread
// concept, so withCompatAliases() aliases thread_id -> session_id. See
// _lib.ts and the build report for the full writeup.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  parseJsonObject,
  withCompatAliases,
} from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const raw = await parseJsonObject(request);
  const body: { cwd?: string; initial_prompt?: string } = {};
  if (typeof raw.cwd === 'string' && raw.cwd) body.cwd = raw.cwd;
  if (typeof raw.initial_prompt === 'string' && raw.initial_prompt) {
    body.initial_prompt = raw.initial_prompt;
  }

  let bridgeRes: Response;
  try {
    bridgeRes = await bridgeFetch(
      '/api/sessions/spawn',
      { method: 'POST', body: JSON.stringify(body) },
      session.userId,
      session.email
    );
  } catch (err) {
    return bridgeUnreachable(err);
  }

  if (!bridgeRes.ok) return relayBridgeError(bridgeRes);

  const data = (await bridgeRes.json().catch(() => ({}))) as Record<string, unknown>;
  return Response.json(withCompatAliases(data), { status: bridgeRes.status });
}
