// ═══════════════════════════════════════════════════════════════════════════
// /api/tasks — DONNA Phase 0: reads the UNIFIED backlog on the spine.
//
// The standalone /tasks page is gone (redirects to /backlog). Tasks were merged
// into ONE backlog (`spine.backlog_items`). DECOUPLE: this route now reads that
// backlog DIRECTLY from Supabase (public.backlog_items_v, service key,
// server-side) — NO bridge — and projects the spine rows into the legacy task
// shape the remaining consumer (the sidebar badge count) reads, so the count
// reflects the real unified backlog instead of the now-tombstoned `tasks` table.
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { listItems, type BacklogItemShape } from '@/lib/backlog-db';

export const dynamic = 'force-dynamic';

type SpineItem = Pick<
  BacklogItemShape,
  'id' | 'title' | 'body' | 'state' | 'priority' | 'domain' | 'due_date' | 'created_at' | 'updated_at'
>;

interface TaskShape {
  id: string;
  domain_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const STATE_TO_STATUS: Record<string, string> = {
  next: 'open', triaged: 'open', captured: 'open', snoozed: 'open',
  in_progress: 'in_progress', waiting: 'blocked',
  done: 'done', cancelled: 'cancelled', archived: 'cancelled',
};

function toTask(it: SpineItem): TaskShape {
  const p = Math.max(0, Math.min(3, it.priority ?? 2));
  return {
    id: String(it.id),
    domain_id: it.domain ?? 'life-ops',
    title: it.title ?? '(untitled)',
    description: it.body ?? null,
    status: STATE_TO_STATUS[it.state] ?? 'open',
    priority: `p${p}`,
    due_date: it.due_date ?? null,
    created_at: it.created_at ?? null,
    updated_at: it.updated_at ?? null,
  };
}

export async function GET(request: Request) {
  const session = await auth({ label: 'GET /api/tasks' });
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const domain = searchParams.get('domain') || undefined;
  // The default surface is the PULL set (open/in_progress/blocked); the sidebar
  // asks for status=open,in_progress,blocked → same set.
  let spineItems: SpineItem[];
  try {
    spineItems = (await listItems({
      pullOnly: true,
      limit: 2000,
      domain,
    })) as SpineItem[];
  } catch {
    return Response.json({ data: [], stats: emptyStats(), _degraded: true });
  }

  const tasks = spineItems.map(toTask);

  const stats = {
    total: tasks.length,
    byDomain: {} as Record<string, number>,
    byPriority: {} as Record<string, number>,
    byStatus: {} as Record<string, number>,
    overdue: 0,
  };
  const now = new Date();
  for (const t of tasks) {
    stats.byDomain[t.domain_id] = (stats.byDomain[t.domain_id] || 0) + 1;
    stats.byPriority[t.priority] = (stats.byPriority[t.priority] || 0) + 1;
    stats.byStatus[t.status] = (stats.byStatus[t.status] || 0) + 1;
    if (t.due_date && !['completed', 'cancelled', 'done'].includes(t.status) && new Date(t.due_date) < now) {
      stats.overdue++;
    }
  }

  return Response.json({ data: tasks, stats, generated_at: new Date().toISOString() });
}

function emptyStats() {
  return { total: 0, byDomain: {}, byPriority: {}, byStatus: {}, overdue: 0 };
}
