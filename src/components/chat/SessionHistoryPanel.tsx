'use client';

// ═══════════════════════════════════════════════════════════════════════════
// SessionHistoryPanel — the reopen-dead-chat history view (feat/cockpit-naming-
// history, 2026-06-02).
//
// JD's ask (ChatGPT/Claude-style): a list of past/ended chats you can click to
// revive. This panel renders the GOING-FORWARD history (live + ended/parked
// sessions from the last N days, newest-first) from /api/sessions/history,
// each row showing the auto-generated TITLE + last-activity + a live/parked
// badge. Clicking:
//   - a PARKED row → POST /api/sessions/{sid}/rehydrate (r-cockpit C3): the spine
//     REHYDRATES a real resumable session from the durable agent_runs (resolving
//     the `claude --resume <cc>` key + proving no re-spawn), then the bridge
//     brings the live PTY up. Opens the returned LIVE sid in the deck. The route
//     soft-degrades to a bridge-only revive when the spine has no durable run, so
//     it is always at least as good as the old /revive — never a dead transcript.
//   - a LIVE row   → reconnects by opening the existing sid in the deck (NO
//     duplicate spawn — JD's rule: rail-click reconnects, "+ CEO agent" spawns).
//
// "Dive right into an old session" (the C3 capability): a rehydratable row (one
// the spine has a durable run for) is badged ⟳ so JD knows the click re-enters a
// LIVE session, not a read-only transcript.
//
// Self-contained + collapsible so it adds zero risk to the existing rail
// sections — it mounts at the bottom of ThreadSidebar and owns its own fetch.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';
import { History, Loader2, RefreshCw } from 'lucide-react';

export interface HistorySession {
  sid: string;
  thread_id: string;
  cc_session_id: string | null;
  title: string | null;
  /** Resolved display label (title → agent_name → cwd basename → "Session"). */
  label: string;
  domain: string | null;
  project_slug: string | null;
  cwd: string | null;
  live: boolean;
  status: string;
  last_activity: number | null; // unix seconds
  agent_name: string | null;
  /** r-cockpit C3: the spine has a durable run (agent_runs) for this sid, so a
   *  dive-in REHYDRATES a live resumable session — not a dead transcript. The
   *  history route sets this from the spine's durable-session list; absent/false
   *  ⇒ the dive-in still works via the bridge-only revive fallback. */
  rehydratable?: boolean;
}

interface HistoryResp {
  sessions?: HistorySession[];
}

export interface SessionHistoryPanelProps {
  /** Open a sid in the cockpit deck (append + focus). Shared with the rail. */
  openSidInDeck: (sid: string) => void;
  /** Poll cadence for the history feed (ms). Default 15s. */
  refreshMs?: number;
}

function relativeTime(ts: number | null): string {
  if (!ts) return '';
  const deltaSec = Math.max(0, Date.now() / 1000 - ts);
  if (deltaSec < 60) return 'just now';
  const m = Math.floor(deltaSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function SessionHistoryPanel({
  openSidInDeck,
  refreshMs = 15_000,
}: SessionHistoryPanelProps) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [open, setOpen] = useState(false);
  const [reviving, setReviving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions/history?days=30', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as HistoryResp;
      setSessions(data.sessions ?? []);
    } catch {
      /* network blip — keep last-known list */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  // Click a row (r-cockpit C3 "dive right into an old session"):
  //   live   → reconnect (open the existing sid — no spawn).
  //   parked → REHYDRATE via POST /api/sessions/{sid}/rehydrate. The spine
  //            rehydrates a live resumable session from the durable agent_runs
  //            (resolving the --resume key, proving no re-spawn) and the bridge
  //            brings the PTY up; we then open the returned LIVE sid in the deck.
  //            The route soft-degrades to a bridge-only revive when the spine has
  //            no durable run, so this is always ≥ the old /revive — never worse,
  //            never a dead transcript.
  const onRowClick = useCallback(
    async (s: HistorySession) => {
      if (s.live) {
        openSidInDeck(s.sid);
        return;
      }
      if (reviving) return;
      setReviving(s.sid);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(s.sid)}/rehydrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = (await res.json()) as { session_id?: string };
        if (res.ok && data.session_id) {
          openSidInDeck(data.session_id);
          void load(); // refresh so the row flips to live
        }
      } catch {
        /* leave the row parked; user can click again */
      } finally {
        setReviving(null);
      }
    },
    [openSidInDeck, reviving, load]
  );

  if (sessions.length === 0) return null;

  return (
    <section data-testid="rail-history" className="mt-1 border-t border-neutral-800 pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2 pb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
        aria-expanded={open}
        data-testid="rail-history-toggle"
      >
        <History size={11} aria-hidden="true" />
        <span>History</span>
        <span className="text-neutral-600 normal-case tracking-normal">({sessions.length})</span>
        <span className="ml-auto text-neutral-600">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <ul className="space-y-0.5" data-testid="rail-history-list">
          {sessions.map((s) => (
            <li key={s.sid}>
              <button
                type="button"
                onClick={() => onRowClick(s)}
                disabled={reviving === s.sid}
                data-testid="rail-history-row"
                data-sid={s.sid}
                data-live={s.live ? 'true' : 'false'}
                data-rehydratable={!s.live && s.rehydratable ? 'true' : 'false'}
                className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800/70 disabled:opacity-60"
                title={`${s.label} — ${
                  s.live
                    ? 'live (reconnect)'
                    : s.rehydratable
                      ? 'rehydrate (resume the live session)'
                      : 'parked (revive)'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    s.live ? 'bg-emerald-400' : 'bg-neutral-600'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {/* C3: a rehydratable parked row dives in as a LIVE session, not a
                    transcript — badge it so JD knows the click re-enters. */}
                {!s.live && s.rehydratable && reviving !== s.sid && (
                  <RefreshCw
                    size={10}
                    aria-hidden="true"
                    data-testid="rail-history-rehydrate-badge"
                    className="shrink-0 text-sky-500/70"
                  />
                )}
                {reviving === s.sid ? (
                  <Loader2 size={11} className="shrink-0 animate-spin text-neutral-400" />
                ) : (
                  <span className="shrink-0 text-[10px] text-neutral-600">
                    {relativeTime(s.last_activity)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
