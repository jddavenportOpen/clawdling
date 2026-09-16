// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sessions/history — a flat list of past/recent sessions.
//
// STUB (v1), same reasoning as recent-cwds/route.ts: BRIDGE-CONTRACT.md has
// no bridge endpoint for this (only 6 exist), and the contract marks it
// Next-local ("may be a stub").
//
// ⚠ NOT the same thing as `/api/sessions/[sid]/history?bytes=&start=`,
// which SessionTerminal.tsx's seedHistoryTail/catchupHistory call (a
// per-session on-disk PTY log tail, byte-cursor based, returning raw text
// with an X-Session-Log-Total-Bytes header). That's a DIFFERENT,
// upstream-cockpit-era endpoint that BRIDGE-CONTRACT.md does not define
// either, and it is intentionally NOT built here — it's outside both the
// contract and this task's route list. Its callers already degrade
// gracefully on a 404 (explicitly: "leave cursor as null... graceful: live
// stream still opens" / "treat as fresh"), so the pane still works, it
// just never replays scrollback from a prior connection. Flagged in the
// build report.
// ═══════════════════════════════════════════════════════════════════════════

import { requireSessionAuth, unauthorized } from '../_lib';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await requireSessionAuth();
  if (!session) return unauthorized();

  return Response.json({ sessions: [] }, { headers: { 'Cache-Control': 'no-store' } });
}
