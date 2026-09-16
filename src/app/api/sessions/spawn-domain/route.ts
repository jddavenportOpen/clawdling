// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sessions/spawn-domain — domain-agent spawn.
//
// BRIDGE-CONTRACT.md: "-> bridge spawn ({ domain, initial_prompt? })".
// `domain` is required; forwarded to the bridge's generic spawn endpoint,
// which loads that domain's profile row and injects its agent prompt
// (bridge-side behavior — see BRIDGE-CONTRACT.md's POST /api/sessions/spawn
// section, "domain loads profiles/<profile>/domains.yaml row").
//
// The shipped NewSessionPicker also sends `persistent: true` on this call
// (a an upstream "domain continuity brain" concept — see
// railModel.ts / ThreadSidebar's brainDomainByThread). v1's bridge contract
// has no persistent/ephemeral distinction at all (non-goal: "no domain-seat
// rendering from ~/clawd") — every session is just a session, so
// `persistent` is accepted from the browser and silently dropped rather
// than forwarded to a bridge field that doesn't exist. Flagged in the
// build report as a real feature gap (the 🧠 persistent-brain badge in the
// rail won't light up under v1), not something this route can paper over.
//
// Same response-shape note as cockpit-spawn/route.ts: withCompatAliases()
// adds thread_id (= session_id) because NewSessionPicker.spawnDomain()
// hard-requires a truthy thread_id or it reports the spawn as failed.
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
  const domain = typeof raw.domain === 'string' ? raw.domain : '';
  if (!domain) {
    return Response.json({ error: '"domain" is required' }, { status: 400 });
  }
  const body: { domain: string; initial_prompt?: string } = { domain };
  if (typeof raw.initial_prompt === 'string' && raw.initial_prompt) {
    body.initial_prompt = raw.initial_prompt;
  }
  // `raw.persistent` deliberately ignored — see header comment.

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
