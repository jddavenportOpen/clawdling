// ═══════════════════════════════════════════════════════════════════════════
// GET /api/threads/[threadId]/session
//
// Returns the live chat_sessions row for a thread (kind=project-session)
// so the Chat Cockpit context menu can map a sidebar thread → session_id
// → /chat?panes=<sid>.
//
// Reply: { session_id, status, cwd, pid } | { error }
// 404 if no live session exists for the thread.
//
// (see docs/ARCHITECTURE.md)
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { getServerClient } from '@/lib/supabase';
import { getThreadById } from '@/lib/chat';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { threadId } = await params;
  if (!threadId) {
    return Response.json({ error: 'threadId required' }, { status: 400 });
  }

  // Ownership check.
  let thread;
  try {
    thread = await getThreadById(threadId, userId);
  } catch (err) {
    return Response.json(
      { error: `Thread lookup failed: ${String(err)}` },
      { status: 500 }
    );
  }
  if (!thread) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  try {
    const supabase = getServerClient();
    // Most recent live session for this thread. Threads can outlive
    // sessions (kill + respawn), so prefer status=live, fall back to
    // most-recent if none live.
    const { data, error } = await supabase
      .from('chat_sessions')
      // NB: the column is `started_at`, NOT `created_at` — chat_sessions has
      // no created_at, so selecting/ordering by it 500s the route and silently
      // breaks every "open in grid" / live-row click. (Found 2026-05-27.)
      .select('id, status, cwd, pid, started_at')
      .eq('thread_id', threadId)
      .order('started_at', { ascending: false })
      .limit(5);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return Response.json(
        { error: 'No session found for this thread' },
        { status: 404 }
      );
    }
    // Prefer a live row if present.
    const live = data.find((r) => r.status === 'live');
    const chosen = live || data[0];
    return Response.json({
      session_id: chosen.id,
      status: chosen.status,
      cwd: chosen.cwd,
      pid: chosen.pid,
    });
  } catch (err) {
    return Response.json(
      { error: `Session lookup failed: ${String(err)}` },
      { status: 500 }
    );
  }
}
