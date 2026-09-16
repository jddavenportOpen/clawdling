// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/spawn — thin proxy to the bridge's generic spawn
// endpoint (BRIDGE-CONTRACT.md). Body: { cwd?, initial_prompt?, domain?,
// agent?, model?, name?, cols?, rows? }.
//
// Called directly by SessionTerminal's "spawn a new pane with the same
// context" affordance (dead sid → respawn). cockpit-spawn/ and
// spawn-domain/ are narrower UI-facing wrappers around this SAME bridge
// call — see their route files for the field-shaping each one does.
// ═══════════════════════════════════════════════════════════════════════════

import { bridgeFetch } from '@/lib/bridge-client';
import {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  pickSpawnFields,
  parseJsonObject,
  withCompatAliases,
} from '../_lib';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  const raw = await parseJsonObject(request);
  const body = pickSpawnFields(raw);

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
