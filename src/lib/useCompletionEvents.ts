// ═══════════════════════════════════════════════════════════════════════════
// useCompletionEvents — emits CompletionEvent objects when a thread transitions
// active→inactive. Layers on top of useActiveThreads (Phase 1).
//
// In-app notification bell + toast. (see docs/ARCHITECTURE.md)
//
// Behaviour:
//   1. Subscribe to useActiveThreads() — a Set<string> of currently-busy
//      thread_ids polled every 5s.
//   2. On each render, diff the previous active set against the current one.
//      Any thread_id that was active LAST tick and ISN'T this tick has just
//      finished a turn → emit a CompletionEvent for it.
//   3. To enrich the event we need (a) the thread's metadata (title, agent,
//      project) and (b) the most-recent assistant message text. We fetch:
//        - GET /api/threads/meta?ids=<id>  → title / kind / ref_id / project
//        - GET /api/chat/<id>?before=<5min ago iso>  → recent messages, take
//          the last assistant one's content for the preview.
//   4. Persist events to localStorage under `cockpit.notifications` (FIFO
//      capped at 50). Read receipts kept on each event (`read: boolean`).
//
// Graceful degradation:
//   - If /api/threads/active 404s, useActiveThreads returns an empty set
//     forever → no transitions → no events. Bell shows 0. No errors.
//   - If /api/threads/meta or /api/chat fails, we still emit the event with
//     fallback labels ("Agent" / preview = "(no preview available)") so the
//     bell still ticks up.
//
// Important: the hook must be SSR-safe. localStorage access is gated on
// `typeof window !== 'undefined'`.
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useActiveThreads } from './useActiveThreads';

export interface CompletionEvent {
  id: string; // generated UUID — used as React key
  thread_id: string;
  thread_title: string;
  agent_id: string | null; // for kind='agent' threads
  agent_label: string | null; // pretty label e.g. "CEO"
  project_slug: string | null;
  preview: string; // first 120 chars of last assistant message
  completed_at: string; // ISO
  read: boolean;
}

const STORAGE_KEY = 'cockpit.notifications';
const MAX_EVENTS = 50;

// Mirror of ThreadSidebar's AGENT_LABEL — kept in sync manually.
// Agents.json is the source of truth; this map is a tiny pretty-print fallback
// so notifications don't have to bundle the registry.
const AGENT_LABEL: Record<string, string> = {
  clawd: 'CEO',
  chief_of_staff: 'COS',
  health_coach: 'Coach',
  researcher: 'Researcher',
  counselor: 'Examiner',
  counselor_ai_foundry: 'Foundry',
  professor: 'Professor',
  quanta: 'Quanta',
  analytics_suite: 'Analytics',
  qa_agent: 'QA',
  ops: 'DevOps',
};

function prettyAgentLabel(agentId: string | null): string | null {
  if (!agentId) return null;
  return AGENT_LABEL[agentId] || agentId;
}

function genId(): string {
  // crypto.randomUUID is widely available in modern browsers + node 19+.
  // Fall back to a low-quality timestamp+random in environments missing it.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadFromStorage(): CompletionEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is CompletionEvent => {
      return (
        e &&
        typeof e === 'object' &&
        typeof e.id === 'string' &&
        typeof e.thread_id === 'string' &&
        typeof e.completed_at === 'string'
      );
    });
  } catch {
    return [];
  }
}

function saveToStorage(events: CompletionEvent[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // quota exceeded / private mode — silent
  }
}

interface ThreadMeta {
  id: string;
  title: string;
  kind: string;
  ref_id: string | null;
  project_slug: string | null;
}

async function fetchThreadMeta(threadId: string): Promise<ThreadMeta | null> {
  try {
    const res = await fetch(`/api/threads/meta?ids=${encodeURIComponent(threadId)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { threads?: ThreadMeta[] };
    const list = Array.isArray(body.threads) ? body.threads : [];
    return list.find((t) => t.id === threadId) || null;
  } catch {
    return null;
  }
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

async function fetchLatestAssistantPreview(threadId: string): Promise<{
  preview: string;
  completed_at: string;
} | null> {
  try {
    // Look back 10 minutes — turns longer than that are extremely rare.
    const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const res = await fetch(
      `/api/chat/${encodeURIComponent(threadId)}?before=${encodeURIComponent(sinceIso)}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { messages?: ChatMessage[] };
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    // Find the last assistant message.
    let last: ChatMessage | null = null;
    for (const m of msgs) {
      if (m.role === 'assistant' && typeof m.content === 'string') {
        last = m;
      }
    }
    if (!last) return null;
    const text = last.content.replace(/\s+/g, ' ').trim();
    const preview = text.length > 120 ? text.slice(0, 120).trimEnd() + '…' : text;
    return {
      preview: preview || '(empty reply)',
      completed_at: last.created_at,
    };
  } catch {
    return null;
  }
}

export interface UseCompletionEventsResult {
  events: CompletionEvent[];
  unreadCount: number;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clearAll: () => void;
  /**
   * Bumps when a NEW event is appended (not on initial load / mark-read).
   * Consumers (toast, audio) subscribe to this rather than `events.length`
   * so refresh-rehydration of stored events doesn't fire a chime.
   */
  newEventTick: number;
  /** The most recently-emitted new event (or null on initial load). */
  latestNew: CompletionEvent | null;
}

export function useCompletionEvents(): UseCompletionEventsResult {
  const activeSet = useActiveThreads();
  const prevActiveRef = useRef<Set<string>>(new Set());
  const [events, setEvents] = useState<CompletionEvent[]>(() => loadFromStorage());
  const [newEventTick, setNewEventTick] = useState(0);
  const [latestNew, setLatestNew] = useState<CompletionEvent | null>(null);
  // Guard against duplicate emits if a thread flickers active→inactive→active
  // within the same poll cycle — extremely unlikely but cheap to defend.
  const inFlightRef = useRef<Set<string>>(new Set());

  // Persist events whenever they change.
  useEffect(() => {
    saveToStorage(events);
  }, [events]);

  // Detect active→inactive transitions on every change to activeSet.
  useEffect(() => {
    const prev = prevActiveRef.current;
    const finished: string[] = [];
    for (const id of prev) {
      if (!activeSet.has(id)) {
        finished.push(id);
      }
    }
    prevActiveRef.current = new Set(activeSet);

    if (finished.length === 0) return;

    let cancelled = false;

    (async () => {
      for (const threadId of finished) {
        if (inFlightRef.current.has(threadId)) continue;
        inFlightRef.current.add(threadId);

        const [meta, latest] = await Promise.all([
          fetchThreadMeta(threadId),
          fetchLatestAssistantPreview(threadId),
        ]);
        if (cancelled) {
          inFlightRef.current.delete(threadId);
          return;
        }

        const agentId = meta?.kind === 'agent' ? meta.ref_id : null;
        const event: CompletionEvent = {
          id: genId(),
          thread_id: threadId,
          thread_title: meta?.title || 'Thread',
          agent_id: agentId,
          agent_label: prettyAgentLabel(agentId),
          project_slug: meta?.project_slug || null,
          preview: latest?.preview || '(no preview available)',
          completed_at: latest?.completed_at || new Date().toISOString(),
          read: false,
        };

        setEvents((prevEvents) => {
          // Prepend (newest first), cap at MAX_EVENTS.
          const next = [event, ...prevEvents].slice(0, MAX_EVENTS);
          return next;
        });
        setLatestNew(event);
        setNewEventTick((n) => n + 1);
        inFlightRef.current.delete(threadId);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSet]);

  const markAllRead = useCallback(() => {
    setEvents((prev) => prev.map((e) => (e.read ? e : { ...e, read: true })));
  }, []);

  const markRead = useCallback((id: string) => {
    setEvents((prev) =>
      prev.map((e) => (e.id === id ? { ...e, read: true } : e))
    );
  }, []);

  const clearAll = useCallback(() => {
    setEvents([]);
  }, []);

  const unreadCount = events.reduce((n, e) => (e.read ? n : n + 1), 0);

  return {
    events,
    unreadCount,
    markAllRead,
    markRead,
    clearAll,
    newEventTick,
    latestNew,
  };
}
