'use client';

// ═══════════════════════════════════════════════════════════════════════════
// /workers — dispatch and watch background worker runs.
//
// A pane (/chat) is a conversation: you type, it answers, you stay. A worker is
// a hand-off: you give it an objective, it runs headless in its own git
// worktree with a wall-clock ceiling, and it reports when it is done. Nothing
// on this screen types into anything.
//
// Reuses the existing design system wholesale — GlassPanel surfaces, StatePill
// for state, the ds Icon wrapper (Phosphor, weight-encodes-state), the accent
// button treatment from /projects. No new tokens, no new primitives.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import useSWR from 'swr';
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Lightning,
  ListBullets,
  Stop,
  TreeStructure,
  Warning,
} from '@phosphor-icons/react/dist/ssr';

import GlassPanel from '@/components/GlassPanel';
import { Icon } from '@/components/ds/Icon';
import { StatePill, type StateTone } from '@/components/ds/StatePill';
import { DOMAINS } from '@/config/domains';

// ── Types ───────────────────────────────────────────────────────────────────

interface WorkerRun {
  run_id: string;
  name: string;
  objective: string;
  status: 'running' | 'done' | 'failed' | 'timeout' | 'killed';
  exit_code: number | null;
  cwd: string;
  base_cwd: string;
  isolation: 'worktree' | 'none';
  isolated: boolean;
  isolation_note: string | null;
  worktree: string | null;
  branch: string | null;
  workplan: string | null;
  domain: string | null;
  model: string | null;
  max_runtime_sec: number;
  elapsed_sec: number;
  created_at: string;
  ended_at: string | null;
  summary: string | null;
  detail: string | null;
}

interface WorkersPayload {
  workers: WorkerRun[];
  running: number;
  max_workers: number | null;
}

interface LogPayload {
  lines: string[];
  stream: string;
  truncated: boolean;
}

// ── Data ────────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

// ── Presentation helpers ────────────────────────────────────────────────────

const STATUS_TONE: Record<WorkerRun['status'], StateTone> = {
  running: 'working',
  done: 'ready',
  failed: 'error',
  timeout: 'attention',
  killed: 'idle',
};

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Pull something human out of a stream-json line for the log view. A frame we
 *  do not recognise is shown raw rather than hidden — silence would be a lie. */
function describeEventLine(line: string): string {
  try {
    const frame = JSON.parse(line) as Record<string, unknown>;
    const type = typeof frame.type === 'string' ? frame.type : 'frame';
    if (type === 'result') {
      const result = typeof frame.result === 'string' ? frame.result : '';
      return `result (${String(frame.subtype ?? 'unknown')}) ${result}`.trim();
    }
    if (type === 'assistant' || type === 'user') {
      const message = frame.message as { content?: unknown } | undefined;
      const content = message?.content;
      if (typeof content === 'string') return `${type}: ${content}`;
      if (Array.isArray(content)) {
        const text = content
          .map((part) => {
            const p = part as { type?: string; text?: string; name?: string };
            if (p.type === 'text' && p.text) return p.text;
            if (p.type === 'tool_use') return `[tool: ${p.name ?? 'unknown'}]`;
            if (p.type === 'tool_result') return '[tool result]';
            return '';
          })
          .filter(Boolean)
          .join(' ');
        return `${type}: ${text}`;
      }
      return type;
    }
    if (type === 'system') return `system (${String(frame.subtype ?? 'event')})`;
    return type;
  } catch {
    return line;
  }
}

// ── Dispatch form ───────────────────────────────────────────────────────────

function DispatchForm({ onDispatched }: { onDispatched: () => void }) {
  const [objective, setObjective] = useState('');
  const [domain, setDomain] = useState('');
  const [cwd, setCwd] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!objective.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { objective: objective.trim() };
      if (domain) payload.domain = domain;
      if (cwd.trim()) payload.cwd = cwd.trim();
      const runtime = Number(minutes);
      if (Number.isFinite(runtime) && runtime > 0) {
        payload.max_runtime_sec = Math.trunc(runtime * 60);
      }
      const res = await fetch('/api/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Dispatch failed (${res.status})`);
      }
      setObjective('');
      onDispatched();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [objective, domain, cwd, minutes, busy, onDispatched]);

  return (
    <GlassPanel id="worker-dispatch" variant="glow" className="p-5 space-y-4">
      <div className="space-y-1">
        <label htmlFor="worker-objective" className="overline block">
          Objective
        </label>
        <textarea
          id="worker-objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          placeholder="What should this worker get done while you are not watching?"
          className="w-full px-3 py-2.5 text-sm rounded-md outline-none resize-y bg-surface-1 border border-hairline text-1 placeholder:text-4 focus:border-accent-border focus-accent transition-colors"
        />
        <p className="text-[11px] font-mono text-3">
          It runs headless in its own git worktree. Nobody can answer a question
          mid-run, so say what &ldquo;done&rdquo; looks like.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <label htmlFor="worker-domain" className="overline block">
            Agent
          </label>
          <select
            id="worker-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="w-full px-3 py-2 text-xs font-mono rounded-md outline-none bg-surface-1 border border-hairline text-1 focus:border-accent-border focus-accent"
          >
            <option value="">No domain agent</option>
            {DOMAINS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="worker-cwd" className="overline block">
            Working directory
          </label>
          <input
            id="worker-cwd"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="workspace root"
            className="w-full px-3 py-2 text-xs font-mono rounded-md outline-none bg-surface-1 border border-hairline text-1 placeholder:text-4 focus:border-accent-border focus-accent"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="worker-minutes" className="overline block">
            Ceiling (minutes)
          </label>
          <input
            id="worker-minutes"
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="30"
            className="w-full px-3 py-2 text-xs font-mono tabular rounded-md outline-none bg-surface-1 border border-hairline text-1 placeholder:text-4 focus:border-accent-border focus-accent"
          />
        </div>
      </div>

      {error && (
        <p
          data-testid="worker-dispatch-error"
          className="flex items-start gap-2 text-xs font-mono text-state-error"
        >
          <Icon glyph={Warning} size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !objective.trim()}
          data-testid="worker-dispatch-submit"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-mono weight-label bg-accent text-on-accent press lift hover:bg-accent-hover focus-accent disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent"
        >
          <Icon glyph={Lightning} size={14} />
          {busy ? 'Dispatching…' : 'Dispatch worker'}
        </button>
      </div>
    </GlassPanel>
  );
}

// ── Log view ────────────────────────────────────────────────────────────────

function WorkerLog({ run }: { run: WorkerRun }) {
  const [stream, setStream] = useState<'events' | 'stderr'>('events');
  const [raw, setRaw] = useState(false);
  const { data, error, isLoading } = useSWR<LogPayload>(
    `/api/workers/${encodeURIComponent(run.run_id)}/log?stream=${stream}&tail=200`,
    fetchJson,
    { refreshInterval: run.status === 'running' ? 2_000 : 0 }
  );

  const lines = data?.lines ?? [];

  return (
    <div className="mt-3 rounded-md border border-hairline bg-surface-2">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-hairline">
        {(['events', 'stderr'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setStream(key)}
            className={`px-2 py-1 rounded-pill text-[10px] font-mono weight-label border press focus-accent ${
              stream === key
                ? 'bg-accent-subtle border-accent-border text-accent-text'
                : 'bg-transparent border-hairline text-3 hover:bg-surface-3 hover:text-2'
            }`}
          >
            {key}
          </button>
        ))}
        {stream === 'events' && (
          <button
            type="button"
            onClick={() => setRaw((v) => !v)}
            className="px-2 py-1 rounded-pill text-[10px] font-mono weight-label border border-hairline text-3 hover:bg-surface-3 hover:text-2 press focus-accent"
          >
            {raw ? 'readable' : 'raw json'}
          </button>
        )}
        <span className="ml-auto text-[10px] font-mono text-3 tabular">
          {lines.length} line{lines.length === 1 ? '' : 's'}
          {data?.truncated ? ' (tail)' : ''}
        </span>
      </div>

      <div className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {isLoading && !data && <p className="text-3">Loading log…</p>}
        {error && (
          <p className="text-state-error">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {!error && !isLoading && lines.length === 0 && (
          <p className="text-3">
            Nothing on {stream} yet.
          </p>
        )}
        {lines.map((line, i) => (
          <pre
            key={`${i}-${line.slice(0, 24)}`}
            className="whitespace-pre-wrap break-words text-2"
          >
            {stream === 'events' && !raw ? describeEventLine(line) : line}
          </pre>
        ))}
      </div>
    </div>
  );
}

// ── Run row ─────────────────────────────────────────────────────────────────

function WorkerRow({
  run,
  expanded,
  onToggle,
  onStop,
  stopping,
}: {
  run: WorkerRun;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  const live = run.status === 'running';
  return (
    <GlassPanel variant="default" className="p-4" animate={false}>
      <div className="flex items-start gap-3" data-testid={`worker-row-${run.run_id}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Hide log for ${run.name}` : `Show log for ${run.name}`}
          className="mt-0.5 p-1 rounded-sm text-3 hover:text-1 hover:bg-surface-3 press focus-accent"
        >
          <Icon glyph={expanded ? CaretDown : CaretRight} size={14} />
        </button>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm weight-strong text-1 truncate">{run.name}</span>
            <StatePill tone={STATUS_TONE[run.status]} dot={live} size="sm">
              {run.status}
            </StatePill>
            <span className="text-[10px] font-mono tabular text-3">
              {formatElapsed(run.elapsed_sec)} / {formatElapsed(run.max_runtime_sec)}
            </span>
            {run.domain && (
              <span className="text-[10px] font-mono text-3">agent: {run.domain}</span>
            )}
          </div>

          <p className="text-xs text-2 line-clamp-2 break-words">{run.objective}</p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono text-3">
            {run.isolated ? (
              <span className="inline-flex items-center gap-1">
                <Icon glyph={TreeStructure} size={12} />
                {run.branch}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-state-attention">
                <Icon glyph={Warning} size={12} />
                no worktree isolation
                {run.isolation_note ? ` - ${run.isolation_note}` : ''}
              </span>
            )}
            <span className="truncate max-w-full">{run.cwd}</span>
            {run.exit_code !== null && <span className="tabular">exit {run.exit_code}</span>}
          </div>

          {(run.summary || run.detail) && (
            <p className="text-[11px] font-mono text-2 break-words">
              {run.summary || run.detail}
            </p>
          )}
        </div>

        {live && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            data-testid={`worker-stop-${run.run_id}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-mono weight-label border border-hairline text-2 hover:text-state-error hover:border-state-error/30 hover:bg-tint-error press focus-accent disabled:opacity-40"
          >
            <Icon glyph={Stop} size={12} />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>

      {expanded && <WorkerLog run={run} />}
    </GlassPanel>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function WorkersPage() {
  const { data, error, isLoading, mutate } = useSWR<WorkersPayload>(
    '/api/workers',
    fetchJson,
    { refreshInterval: 4_000 }
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  const workers = useMemo(() => {
    const rows = data?.workers ?? [];
    // Live runs first, then most recently dispatched.
    return [...rows].sort((a, b) => {
      const aLive = a.status === 'running' ? 0 : 1;
      const bLive = b.status === 'running' ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }, [data]);

  const stop = useCallback(
    async (runId: string) => {
      setStopping(runId);
      try {
        await fetch(`/api/workers/${encodeURIComponent(runId)}`, { method: 'DELETE' });
      } finally {
        setStopping(null);
        mutate();
      }
    },
    [mutate]
  );

  const running = data?.running ?? 0;

  return (
    <div
      data-testid="workers-page"
      className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6 relative z-10"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex items-center gap-4"
      >
        <div className="w-10 h-10 rounded-md flex items-center justify-center border border-hairline bg-surface-2">
          <Icon glyph={Lightning} state="domain" size={20} className="text-2" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-display weight-strong tracking-tight text-1 display">
            Workers
          </h1>
          <p className="overline mt-0.5">Background runs - dispatched, unattended</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <StatePill tone={running > 0 ? 'working' : 'idle'} dot={running > 0} size="sm">
            {running}
            {data?.max_workers ? ` / ${data.max_workers}` : ''} running
          </StatePill>
          <button
            type="button"
            onClick={() => mutate()}
            aria-label="Refresh worker list"
            className="p-2 rounded-md border border-hairline text-3 hover:text-1 hover:bg-surface-2 press focus-accent"
          >
            <Icon glyph={ArrowClockwise} size={14} />
          </button>
        </div>
      </motion.div>

      <DispatchForm onDispatched={() => mutate()} />

      {error && (
        <div className="rounded-lg border border-hairline bg-surface-1 p-6 text-center">
          <p className="text-sm font-mono text-state-error">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      )}

      {isLoading && !data && (
        <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center">
          <p className="text-sm font-mono text-3">Loading worker runs…</p>
        </div>
      )}

      {!error && data && workers.length === 0 && (
        <div className="rounded-lg border border-hairline bg-surface-1 p-8 text-center space-y-2">
          <Icon glyph={ListBullets} state="domain" size={24} className="text-3 mx-auto" />
          <p className="text-sm font-mono text-3">
            No workers yet. Dispatch one above and it will appear here.
          </p>
        </div>
      )}

      {workers.length > 0 && (
        <div className="space-y-3">
          {workers.map((run) => (
            <WorkerRow
              key={run.run_id}
              run={run}
              expanded={expanded === run.run_id}
              onToggle={() => setExpanded((cur) => (cur === run.run_id ? null : run.run_id))}
              onStop={() => stop(run.run_id)}
              stopping={stopping === run.run_id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure internals, exported for unit tests only. Same pattern as
// ChatGrid's `__chatGridInternals__` — the resolvers are testable without
// standing up a bridge, and the test names the contract they hold.
// ═══════════════════════════════════════════════════════════════════════════
export const __workersInternals__ = {
  formatElapsed,
  describeEventLine,
  STATUS_TONE,
};
