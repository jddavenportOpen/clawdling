// ═══════════════════════════════════════════════════════════════════════════
// GET /api/threads/meta?ids=<id1>,<id2>,... — return thread metadata for the
// given IDs.
//
// Original use: the in-app notifications hook (useCompletionEvents)
// enriches CompletionEvents with title / kind / ref_id / project_slug at
// the moment a thread transitions active→inactive.
// (see docs/ARCHITECTURE.md)
//
// Extended: each thread row now
// also carries its latest chat_sessions row so ThreadSidebar can poll a
// single endpoint at 5s cadence and render per-row liveness pills WITHOUT
// depending on whichever pane happens to be open. Threads with no backing
// session (kind=agent / ad-hoc, or project-session that hasn't spawned yet)
// get session_status=null and the UI treats that as "no session" / unknown.
// (see docs/ARCHITECTURE.md)
//
// Auth: requires a signed-in user. Only returns rows owned by that user.
// Empty body when no ids passed or none found — never 4xx for empty inputs.
// IDs are capped to MAX_IDS (100) per request; excess are silently dropped.
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import {
  getServerClient,
  type ChatSessionStatus,
  type DbChatThread,
} from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const MAX_IDS = 100;

interface ThreadMetaResponse {
  threads: Array<{
    id: string;
    title: string;
    kind: string;
    ref_id: string | null;
    project_slug: string | null;
    // Latest chat_sessions row for this thread, or null if none exists.
    // Sidebar uses this for status-pill rendering independent of any open
    // SSE stream. Source of truth: Supabase (P1.1 keeps it accurate).
    session_id: string | null;
    session_status: ChatSessionStatus | null;
    exited_at: string | null;
    exit_code: number | null;
    // cwd of the latest session — lets the rail derive its Space/domain
    // (<state-root>/domains/<id>/) without a schema change.
    cwd: string | null;
    // Human rail identity set at spawn (Cockpit V3 M5): "Health · weekly
    // summary", "find old logo", or a project slug. Null falls back to the
    // thread title in the rail.
    agent_name: string | null;
  }>;
}

interface SessionRow {
  id: string;
  thread_id: string;
  status: ChatSessionStatus;
  started_at: string;
  exited_at: string | null;
  exit_code: number | null;
  cwd: string | null;
  agent_name: string | null;
}

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ threads: [] } as ThreadMetaResponse, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const url = new URL(request.url);
  const idsRaw = url.searchParams.get('ids') || '';
  const ids = idsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_IDS);

  if (ids.length === 0) {
    return Response.json({ threads: [] } as ThreadMetaResponse, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  try {
    const supabase = getServerClient();
    // Fetch thread metadata (with ownership filter) and ALL chat_sessions
    // rows for those threads in parallel. We sort sessions by started_at
    // DESC and pick the first per thread to find the "latest" — matches
    // how /api/threads/[threadId]/session works (prefer most-recent;
    // status='live' is the natural top because exited rows have older
    // started_at relative to a fresh live one, and the bridge only marks
    // one row live at a time per thread).
    const [threadRes, sessionRes] = await Promise.all([
      supabase
        .from('chat_threads')
        .select('id, title, kind, ref_id, project_slug')
        .eq('user_id', userId)
        .in('id', ids),
      supabase
        .from('chat_sessions')
        .select('id, thread_id, status, started_at, exited_at, exit_code, cwd, agent_name')
        .in('thread_id', ids)
        .order('started_at', { ascending: false }),
    ]);

    if (threadRes.error) {
      return Response.json({ threads: [] } as ThreadMetaResponse, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const threadRows =
      (threadRes.data as Array<
        Pick<DbChatThread, 'id' | 'title' | 'kind' | 'ref_id' | 'project_slug'>
      >) || [];

    // Build thread_id → latest session map. If sessionRes failed we just
    // get an empty map (graceful — every thread shows session_status=null).
    const latestByThread = new Map<string, SessionRow>();
    const sessionRows = (sessionRes.error ? [] : (sessionRes.data as SessionRow[])) || [];
    // Prefer status='live' over an older exited row even if started_at
    // would push the exited row first (edge case: clock skew, or a respawn
    // that landed with a slightly-earlier timestamp due to retries).
    for (const row of sessionRows) {
      const existing = latestByThread.get(row.thread_id);
      if (!existing) {
        latestByThread.set(row.thread_id, row);
        continue;
      }
      if (existing.status !== 'live' && row.status === 'live') {
        latestByThread.set(row.thread_id, row);
      }
      // Otherwise keep existing (it's earlier in the DESC-sorted list, so
      // it's more recent by started_at).
    }

    const merged = threadRows.map((t) => {
      const s = latestByThread.get(t.id) || null;
      return {
        id: t.id,
        title: t.title,
        kind: t.kind,
        ref_id: t.ref_id,
        project_slug: t.project_slug,
        session_id: s?.id ?? null,
        session_status: s?.status ?? null,
        exited_at: s?.exited_at ?? null,
        exit_code: s?.exit_code ?? null,
        cwd: s?.cwd ?? null,
        agent_name: s?.agent_name ?? null,
      };
    });

    return Response.json(
      { threads: merged } as ThreadMetaResponse,
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return Response.json({ threads: [] } as ThreadMetaResponse, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
