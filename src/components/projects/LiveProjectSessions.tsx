'use client';

// ═══════════════════════════════════════════════════════════════════════════
// LiveProjectSessions — "your alive chat sessions" strip for /projects.
//
// life-os-v1 F2 (2026-05-22): JD's multi-project promise — "I should see
// where each one's at" — when he has N parallel Claude Code sessions open.
//
// F4 (2026-05-22): added Resume button for dead-but-resumable sessions.
//   Bridge replays the full transcript via claude --resume <sid> and the
//   session goes back to live without losing context.
//
// Data: /api/sessions/list (user-scoped chat_sessions × bridge running set
// + resumable set + per-session cost). Polls every 5s while the tab is
// foregrounded.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import { Terminal, Circle, DollarSign, RotateCw, Loader2 } from 'lucide-react';
// Warm Graphite: the persistent-continuity badge is a bespoke Phosphor Brain
// glyph (ds/Icon), never the 🧠 emoji.
import { Icon } from '@/components/ds/Icon';
import { Brain } from '@phosphor-icons/react/dist/ssr';

interface SessionRow {
  id: string;
  thread_id: string;
  project_slug: string | null;
  cwd: string;
  started_at: string;
  status: string;
  live: boolean;
  resumable: boolean;
  elapsed_sec: number;
  cost_today_usd: number;
  turns: number;
  model_family: string | null;
  ai_title: string | null;
  // persistent-domain-agents: true iff this live session is its domain's
  // continuity brain (vs a disposable worker). domain names which of the 8.
  persistent?: boolean;
  domain?: string | null;
}

interface ListResp {
  sessions: SessionRow[];
  cost_meta: { date?: string; total_usd?: number; stale?: boolean } | null;
  server_time: string;
}

const fetcher = async (url: string): Promise<ListResp> => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ListResp;
};

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function fmtUsd(n: number): string {
  if (n < 0.01) return '<$0.01';
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function SessionCard({
  s,
  onResumed,
}: {
  s: SessionRow;
  onResumed: () => void;
}) {
  const router = useRouter();
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const href = s.project_slug
    ? `/projects/${encodeURIComponent(s.project_slug)}/sessions/${encodeURIComponent(s.id)}`
    : `/chat/${encodeURIComponent(s.thread_id)}`;

  async function handleResume(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/resume`, {
        method: 'POST',
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${res.status} ${txt.slice(0, 200)}`);
      }
      onResumed();
      router.push(href);
    } catch (err) {
      setResumeError(String(err instanceof Error ? err.message : err));
      setResuming(false);
    }
  }

  return (
    <Link
      href={href}
      className={`group rounded-lg border p-2.5 transition-all hover:scale-[1.01] block ${
        s.live
          ? 'border-border-default bg-tint-ready hover:border-border-strong'
          : s.resumable
          ? 'border-border-default bg-tint-attention hover:border-border-strong'
          : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <Terminal
          className={`w-3 h-3 ${
            s.live
              ? 'text-state-ready'
              : s.resumable
              ? 'text-state-attention'
              : 'text-neutral-500'
          }`}
        />
        <span className="text-xs font-semibold truncate flex-1">
          {s.project_slug ?? '(no project)'}
        </span>
        {s.live && s.persistent && (
          <span
            data-testid="persistent-brain-badge"
            className="flex-shrink-0 leading-none text-state-working"
            title={`Persistent ${s.domain ?? ''} continuity brain — survives restarts, never reaped`}
            aria-label="persistent brain"
          >
            <Icon glyph={Brain} state="domain" size={12} />
          </span>
        )}
        {s.live && (
          <Circle className="w-1.5 h-1.5 fill-state-working stroke-state-working glyph-attention flex-shrink-0" />
        )}
        {!s.live && s.resumable && (
          <button
            onClick={handleResume}
            disabled={resuming}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono border border-accent-border text-accent-text hover:bg-accent-subtle disabled:opacity-50 flex-shrink-0"
            title="Resume this session with full transcript"
          >
            {resuming ? (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
              <RotateCw className="w-2.5 h-2.5" />
            )}
            {resuming ? '…' : 'Resume'}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] font-mono text-text-muted">
        <span>{fmtElapsed(s.elapsed_sec)}</span>
        {s.turns > 0 && <span>· {s.turns} turns</span>}
        {s.cost_today_usd > 0 && (
          <span className="text-2">· {fmtUsd(s.cost_today_usd)}</span>
        )}
      </div>
      {s.ai_title && (
        <div className="text-[10px] text-neutral-400 line-clamp-1 mt-0.5">
          {s.ai_title}
        </div>
      )}
      {resumeError && (
        <div className="text-[10px] text-state-danger-muted mt-0.5 line-clamp-1">
          resume: {resumeError}
        </div>
      )}
    </Link>
  );
}

export default function LiveProjectSessions() {
  const { data, error, mutate } = useSWR<ListResp>('/api/sessions/list', fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: true,
  });

  if (error || !data) return null;

  // Sort: live first, then resumable, then by elapsed_sec ascending.
  const sorted = [...data.sessions].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.resumable !== b.resumable) return a.resumable ? -1 : 1;
    return a.elapsed_sec - b.elapsed_sec;
  });

  // Show: all live + all resumable + last 3 dead-and-gone.
  const live = sorted.filter((s) => s.live);
  const resumable = sorted.filter((s) => !s.live && s.resumable);
  const exited = sorted.filter((s) => !s.live && !s.resumable).slice(0, 3);
  const display = [...live, ...resumable, ...exited];

  if (display.length === 0) return null;

  const totalToday = data.cost_meta?.total_usd ?? 0;
  const todayDate = data.cost_meta?.date ?? '';

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3 text-xs font-mono uppercase tracking-widest">
        <span className="inline-flex items-center gap-1.5 text-state-ready">
          <Circle className="w-2 h-2 fill-state-working stroke-state-working glyph-attention" />
          Live Sessions ({live.length})
        </span>
        {resumable.length > 0 && (
          <span className="inline-flex items-center gap-1 text-2 normal-case tracking-normal text-[11px]">
            <RotateCw className="w-3 h-3" />
            {resumable.length} resumable
          </span>
        )}
        {totalToday > 0 && (
          <span className="text-text-muted normal-case tracking-normal text-[11px]">
            <DollarSign className="w-3 h-3 inline -mt-0.5" />
            {fmtUsd(totalToday)} spent today{todayDate ? ` (${todayDate})` : ''}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {display.map((s) => (
          <SessionCard key={s.id} s={s} onResumed={() => mutate()} />
        ))}
      </div>
    </section>
  );
}
