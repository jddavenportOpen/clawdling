'use client';

// ═══════════════════════════════════════════════════════════════════════════
// /tasks — the task list.
//
// This route used to `redirect('/backlog')`, and /backlog does not exist in
// this repo, so every Tasks link 404'd: the mobile tab bar, the sidebar, and
// the command palette all point here. It is a headline feature of the app
// (the `tasks` agent tool ships ON by default), so it now renders the real
// list instead of bouncing.
//
// Source of truth is GET /api/tasks -> public.user_tasks, the SAME store the
// assistant writes through create_task / complete_task (src/lib/engine/tools.ts).
// So a task created in chat shows up here, and completing it here is visible to
// the next list_tasks call. One store, two surfaces.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { motion } from 'framer-motion';
import { ArrowCounterClockwise, Check, ListChecks } from '@phosphor-icons/react/dist/ssr';
// HudStat is typed to LucideIcon, so its stat icons stay on the Lucide set the
// other pages use; all other chrome uses the bespoke ds/Icon (Phosphor).
import { CheckCircle2, Inbox, Zap } from 'lucide-react';
import { Icon } from '@/components/ds/Icon';
import { StatePill } from '@/components/ds/StatePill';
import HudStat from '@/components/HudStat';
import NeonBadge from '@/components/NeonBadge';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  status: string;
  due: string | null;
  created_at: string | null;
  completed_at: string | null;
}

interface TasksResponse {
  tasks: Task[];
  stats: { total: number; open: number; done: number };
}

// ── Data ──────────────────────────────────────────────────────────────────────

const fetcher = async (url: string): Promise<TasksResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    // Surface the route's own message ("Could not read tasks: ...") rather than
    // a bare status, so a misconfigured store is diagnosable from the screen.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `API error: ${res.status}`);
  }
  return (await res.json()) as TasksResponse;
};

// ── Row ───────────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  busy,
  onToggle,
}: {
  task: Task;
  busy: boolean;
  onToggle: (task: Task) => void;
}) {
  const done = task.status === 'done';
  return (
    <li
      data-testid={`task-row-${task.id}`}
      className="flex items-start gap-3 px-4 py-3 border-b border-hairline last:border-b-0"
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => onToggle(task)}
        data-testid={`task-toggle-${task.id}`}
        aria-label={done ? `Reopen "${task.title}"` : `Complete "${task.title}"`}
        className="mt-0.5 shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center border border-hairline bg-surface-2 text-3 press hover:bg-surface-3 hover:text-1 focus-accent disabled:opacity-50"
      >
        <Icon
          glyph={done ? ArrowCounterClockwise : Check}
          state="idle"
          size={14}
          aria-hidden
        />
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={
            done
              ? 'text-sm text-3 line-through decoration-1 break-words'
              : 'text-sm text-1 break-words'
          }
        >
          {task.title}
        </p>
        {task.due && (
          <p className="mt-1 text-[11px] font-mono text-3">due {task.due}</p>
        )}
      </div>

      <StatePill tone={done ? 'ready' : 'idle'} size="sm">
        {done ? 'DONE' : 'OPEN'}
      </StatePill>
    </li>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

function Section({
  title,
  tasks,
  emptyLabel,
  testId,
  busyId,
  onToggle,
}: {
  title: string;
  tasks: Task[];
  emptyLabel: string;
  testId: string;
  busyId: string | null;
  onToggle: (task: Task) => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="overline">{title}</h2>
        <span className="text-[11px] font-mono tabular text-3">{tasks.length}</span>
      </div>

      <div className="rounded-lg border border-hairline bg-surface-1 overflow-hidden">
        {tasks.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm font-mono text-3">{emptyLabel}</p>
        ) : (
          <ul data-testid={testId}>
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                busy={busyId === t.id}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { data, error, isLoading, mutate } = useSWR<TasksResponse>(
    '/api/tasks',
    fetcher,
    { refreshInterval: 60_000 }
  );

  const [busyId, setBusyId] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const onToggle = useCallback(
    async (task: Task) => {
      if (busyId) return; // one write at a time; the list is small
      setBusyId(task.id);
      setWriteError(null);
      const next = task.status === 'done' ? 'open' : 'done';
      try {
        const res = await fetch('/api/tasks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: task.id, status: next }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        await mutate();
      } catch (err) {
        setWriteError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, mutate]
  );

  const tasks = data?.tasks ?? [];
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  const stats = data?.stats ?? { total: 0, open: 0, done: 0 };

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex items-center gap-4"
      >
        <div className="w-10 h-10 rounded-md flex items-center justify-center border border-hairline bg-surface-2">
          <Icon glyph={ListChecks} state="domain" size={20} className="text-2" />
        </div>
        <div>
          <h1 className="text-2xl font-display weight-strong tracking-tight text-1 display">
            Tasks
          </h1>
          <p className="overline mt-0.5">Your list — open and completed</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <NeonBadge color="green" size="sm">{stats.open} OPEN</NeonBadge>
        </div>
      </motion.div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-3">
        <HudStat label="Total" value={String(stats.total)} icon={Inbox} color="cyan" delay={0.05} />
        <HudStat label="Open" value={String(stats.open)} icon={Zap} color="amber" delay={0.1} />
        <HudStat label="Done" value={String(stats.done)} icon={CheckCircle2} color="green" delay={0.15} />
      </div>

      {isLoading && (
        <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center">
          <p className="text-sm font-mono text-3">Loading tasks…</p>
        </div>
      )}

      {error && !isLoading && (
        <div
          role="alert"
          data-testid="tasks-error"
          className="rounded-lg border border-hairline bg-surface-1 p-8 text-center"
        >
          <p className="text-sm font-mono text-state-danger-muted">
            Failed to load tasks: {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      )}

      {writeError && (
        <div
          role="alert"
          data-testid="tasks-write-error"
          className="rounded-lg border border-hairline bg-surface-1 px-4 py-3"
        >
          <p className="text-sm font-mono text-state-danger-muted">{writeError}</p>
        </div>
      )}

      {!isLoading && !error && (
        <div className="space-y-6">
          <Section
            title="Open"
            tasks={open}
            emptyLabel="Nothing open. Ask the assistant to add something."
            testId="tasks-open-list"
            busyId={busyId}
            onToggle={onToggle}
          />
          <Section
            title="Done"
            tasks={done}
            emptyLabel="No completed tasks yet."
            testId="tasks-done-list"
            busyId={busyId}
            onToggle={onToggle}
          />
        </div>
      )}
    </div>
  );
}
