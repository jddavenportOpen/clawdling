// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sessions/recent-cwds — recently-used working directories, for
// NewSessionPicker's "Projects" section.
//
// STUB (v1), and deliberately so: BRIDGE-CONTRACT.md's "Bridge endpoints
// (Python, port 8787)" section lists exactly six routes (spawn, list,
// stream, input, resize, DELETE) — there is no bridge endpoint for this at
// all, so there's nothing to proxy to. The contract itself marks this
// Next-local ("may be a stub").
//
// A local source DOES technically exist: the pre-existing chat_sessions
// table (src/lib/local-store.ts / src/lib/supabase.ts) that the OLDER
// turn-based /api/chat/[threadId] feature persists `cwd` to. Deliberately
// NOT wired here — that table keys off Supabase-assigned thread ids from
// the unrelated turn-based chat engine, while this route is about the NEW
// bridge-spawned PTY sessions the contract keeps Supabase-free on purpose
// ("Non-goals for v1: ... no Supabase"). Cross-wiring two unrelated session
// concepts to half-populate one list read as a worse outcome than an
// honest empty stub. Flagged in the build report rather than silently
// wired up.
//
// Consumer (NewSessionPicker) already treats this as best-effort — it
// only ever shows the default "." row when `cwds` is empty, never errors.
// ═══════════════════════════════════════════════════════════════════════════

import { requireSessionAuth, unauthorized } from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  return Response.json({ cwds: [] }, { headers: { 'Cache-Control': 'no-store' } });
}
