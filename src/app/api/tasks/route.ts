// ═══════════════════════════════════════════════════════════════════════════
// /api/tasks — the signed-in user's task list (public.user_tasks).
//
// WHY THIS WAS REPOINTED (2026-09-16). The previous implementation read a
// "unified backlog" (public.backlog_items_v) through @/lib/backlog-db. That
// source does not exist in this repo, in either storage mode:
//   - db/migrations/ defines user_tasks / user_memory / user_integrations and
//     NO backlog_items_v view and no backlog_* RPC, so a Supabase install has
//     nothing to select from.
//   - @/lib/local-store (the ADJUTANT_STATE=local self-host default) implements
//     no .range() and no .rpc(); backlog-db's listItems() pages with .range(),
//     so the call threw TypeError, the route's own catch swallowed it, and the
//     endpoint answered { data: [], _degraded: true } forever.
// It had no callers, so nothing depended on the old shape. The store this app
// genuinely reads and writes is user_tasks: src/lib/engine/tools.ts create_task
// / list_tasks / complete_task write it on every turn, and it is ON by default
// (DEFAULT_TOOLS = 'web,tasks,memory'). Pointing the page at anything else
// would have shipped a surface that is empty by construction.
//
// GET   -> { tasks, stats }         every task for the caller, newest first
// PATCH -> { task }                 { id, status: 'open' | 'done' }
//
// Both are scoped with an explicit .eq('user_id', ...) on every query, the same
// multi-tenant discipline the agent tools use (service key bypasses RLS, so the
// filter IS the boundary).
// ═══════════════════════════════════════════════════════════════════════════

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { getServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/** A row of public.user_tasks as the UI consumes it. */
export interface UserTask {
  id: string;
  title: string;
  status: string; // 'open' | 'done'
  due: string | null;
  created_at: string | null;
  completed_at: string | null;
}

export interface TaskStats {
  total: number;
  open: number;
  done: number;
}

/** The statuses a client may PATCH a task into. */
const WRITABLE_STATUS = new Set(['open', 'done']);

/** Hard ceiling on a single read. A personal task list is tens of rows. */
const MAX_ROWS = 500;

function row(r: Record<string, unknown>): UserTask {
  return {
    id: String(r.id ?? ''),
    title: typeof r.title === 'string' ? r.title : '(untitled)',
    // The local store applies no column defaults, so a row written by an older
    // build can legitimately carry no status. Treat that as open rather than
    // dropping the task off every surface (the 2026-07-07 local-store P0).
    status: typeof r.status === 'string' && r.status ? r.status : 'open',
    due: typeof r.due === 'string' && r.due ? r.due : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : null,
    completed_at: typeof r.completed_at === 'string' ? r.completed_at : null,
  };
}

function statsFor(tasks: UserTask[]): TaskStats {
  let open = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.status === 'done') done++;
    else open++;
  }
  return { total: tasks.length, open, done };
}

export async function GET(): Promise<Response> {
  const session = await auth({ label: 'GET /api/tasks' });
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await getServerClient()
    .from('user_tasks')
    .select('id,title,status,due,created_at,completed_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    // Say which store failed. An opaque 500 here reads as "tasks are broken"
    // when the real answer is usually "this install has no user_tasks table".
    return Response.json(
      { error: `Could not read tasks: ${error.message}` },
      { status: 500 }
    );
  }

  const tasks = ((data as Record<string, unknown>[]) || []).map(row);
  return Response.json({ tasks, stats: statsFor(tasks) });
}

export async function PATCH(request: Request): Promise<Response> {
  const session = await auth({ label: 'PATCH /api/tasks' });
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  if (!id) {
    return Response.json({ error: 'A task id is required.' }, { status: 400 });
  }
  if (!WRITABLE_STATUS.has(status)) {
    return Response.json(
      { error: 'status must be "open" or "done".' },
      { status: 400 }
    );
  }

  const { data, error } = await getServerClient()
    .from('user_tasks')
    .update({
      status,
      // Reopening clears the completion stamp so the row cannot claim to be
      // both open and completed.
      completed_at: status === 'done' ? new Date().toISOString() : null,
    })
    .eq('user_id', userId)
    .eq('id', id)
    .select('id,title,status,due,created_at,completed_at')
    .maybeSingle();

  if (error) {
    return Response.json(
      { error: `Could not update the task: ${error.message}` },
      { status: 500 }
    );
  }
  if (!data) {
    return Response.json({ error: 'No matching task.' }, { status: 404 });
  }

  return Response.json({ task: row(data as Record<string, unknown>) });
}
