// ═══════════════════════════════════════════════════════════════════════════
// NotificationToast — top-left toast that slides in for each new completion
// event. Auto-dismiss after 8s, paused on hover. Click → navigate to the
// originating chat thread. Stacks up to 3 visible at once; queued behind.
//
// (see docs/ARCHITECTURE.md)
//
// We deliberately render to a fixed-position container ourselves rather than
// using a library — the tail of the design (top-left, always-fire, 3-deep
// stack) is small enough that owning it keeps the bundle clean.
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { CompletionEvent } from '@/lib/useCompletionEvents';
// Warm Graphite: the toast agent avatar is now a bespoke Phosphor glyph
// (ds/Icon + agentGlyph), NEVER a Unicode emoji. The "done" cue is the
// signature StatusGlyph ring, not a neon emerald check.
import { Icon } from '@/components/ds/Icon';
import { StatusGlyph } from '@/components/ds/StatusGlyph';
import { agentGlyph } from '@/components/ds/glyphMap';

const AUTO_DISMISS_MS = 8_000;
const MAX_VISIBLE = 3;

interface Props {
  /** Bumps each time a new event lands. Used to know when to enqueue. */
  newEventTick: number;
  /** The most-recently-emitted new event. Null on first mount / hydrate. */
  latestNew: CompletionEvent | null;
  onDismiss?: (id: string) => void;
}

interface ActiveToast {
  event: CompletionEvent;
  /** Internal toast key — separate from event.id so re-firing the same event
   *  (re-mount edge case) gives a fresh toast. */
  key: string;
}

export default function NotificationToast({
  newEventTick,
  latestNew,
  onDismiss,
}: Props) {
  const [queue, setQueue] = useState<ActiveToast[]>([]);
  const lastSeenTickRef = useRef(0);

  // Append to the queue every time newEventTick increments.
  useEffect(() => {
    if (newEventTick === 0) return; // initial mount, nothing to show
    if (newEventTick === lastSeenTickRef.current) return;
    lastSeenTickRef.current = newEventTick;
    if (!latestNew) return;
    setQueue((prev) => [
      ...prev,
      { event: latestNew, key: `${latestNew.id}-${newEventTick}` },
    ]);
  }, [newEventTick, latestNew]);

  function handleDismiss(key: string, eventId: string) {
    setQueue((prev) => prev.filter((t) => t.key !== key));
    onDismiss?.(eventId);
  }

  // Render up to MAX_VISIBLE — older toasts in the queue wait.
  const visible = queue.slice(0, MAX_VISIBLE);

  return (
    <div
      // The NotificationBell was removed from the chrome (JD's request), so the
      // toast stack can start near the top-left edge. top-3 keeps a small inset.
      className="fixed top-3 left-3 z-[75] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {visible.map((t) => (
          <ToastCard
            key={t.key}
            toast={t}
            onDismiss={() => handleDismiss(t.key, t.event.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ActiveToast;
  onDismiss: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef<number>(AUTO_DISMISS_MS);
  const lastStartRef = useRef<number>(Date.now());

  // Start / pause auto-dismiss based on hover.
  useEffect(() => {
    if (hovered) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        remainingRef.current = Math.max(
          0,
          remainingRef.current - (Date.now() - lastStartRef.current)
        );
      }
      return;
    }
    lastStartRef.current = Date.now();
    timerRef.current = setTimeout(onDismiss, remainingRef.current);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [hovered, onDismiss]);

  const e = toast.event;
  const glyphDef = agentGlyph(e.agent_id);
  const label = e.agent_label || 'Thread';
  const project = e.project_slug || 'general';
  // First line of preview only (toast space is tight).
  const firstLine = e.preview.split('\n')[0]?.trim() || e.preview;

  return (
    <motion.div
      initial={{ opacity: 0, x: -32, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -32, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="pointer-events-auto w-[340px] sm:w-[380px] rounded-lg border border-border-default bg-surface-2 shadow-popover overflow-hidden"
    >
      <Link
        href={`/chat/${e.thread_id}`}
        onClick={onDismiss}
        className="block p-3 transition-colors hover:bg-surface-3"
      >
        <div className="flex items-start gap-2">
          <StatusGlyph state="done" size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="mb-1 flex items-center gap-1.5 text-xs">
              <Icon
                glyph={glyphDef.glyph}
                state="domain"
                size={14}
                style={{ color: glyphDef.tint }}
                className="shrink-0"
              />
              <span className="truncate font-medium text-1">
                {label}
              </span>
              <span className="text-3">finished</span>
              <span className="truncate font-mono text-[11px] text-2">
                {project}
              </span>
            </div>
            <p className="line-clamp-2 text-[11px] leading-snug text-2">
              {firstLine}
            </p>
          </div>
          <button
            type="button"
            onClick={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              onDismiss();
            }}
            className="shrink-0 rounded p-0.5 text-3 hover:bg-surface-4 hover:text-1"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </Link>
    </motion.div>
  );
}
