'use client';

// ═══════════════════════════════════════════════════════════════════════════
// CleanComposer — send box for the clean transcript pane view.
//
// Features (2026-06-02):
//   • Queue — when a send is in flight, follow-ups stack with a "Queued · N"
//     pill and drain FIFO when the current turn completes.
//   • Attachments — Paperclip button uploads files to /api/uploads (requires
//     threadId prop from ChatGridPane). Disk paths are prepended as @-refs
//     so Claude Code can read them inline.
//   • Audio — hold-to-record mic via VoiceRecorder; transcript appended to
//     the text box.
//   • Auto-grow — textarea grows up to 8 rows then scrolls.
//   • Double-enter fix — refocus after send + ref-based in-flight guard so
//     rapid key presses never bypass the lock.
//
// Warm-Graphite v6: a crafted composer — sunken input well on the surface
// ladder, 1px translucent-white hairline, focus ring = accent at low alpha
// (the .focus-accent recipe, NOT a glow). Send is the pane's ONE filled
// accent CTA. Every emoji glyph is replaced by a Phosphor icon.
//
// Posts to /api/sessions/<sid>/input with `text + '\r'` (the trailing \r
// submits in Claude Code's bracketed-paste TUI).
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import VoiceRecorder from './VoiceRecorder';
import type { EchoState } from './CleanTranscript';
import { Icon } from '@/components/ds/Icon';
import {
  Paperclip,
  X,
  ArrowUp,
  CircleNotch,
} from '@phosphor-icons/react/dist/ssr';

interface Props {
  sessionId: string;
  /** Thread ID for file uploads. If absent, the attach button is hidden. */
  threadId?: string | null;
  /** Called when the message lands — lets the parent nudge a transcript poll. */
  onSent?: () => void;
  /** The /input route swapped the bridge sid (dead-sid resume). */
  onResumed?: (newSessionId: string) => void;
  /** Optimistic echo (cockpit-chat-ux #1): called the INSTANT a send starts
   *  with the user-visible text. Returns an echo id the parent uses to track
   *  the pending bubble. */
  onEcho?: (text: string) => number;
  /** Reports the echo's outcome: ok=true on a 2xx /input, false on failure. */
  onEchoResult?: (id: number, ok: boolean) => void;
  /** CAT-14: set an echo's lifecycle state directly (e.g. mark a just-created
   *  echo 'queued' while it waits behind an in-flight send, or 'failed' when
   *  JD clears the queue). Lets a queued message be VISIBLE + recoverable
   *  instead of an invisible string that silently vanishes on a clear tap. */
  onEchoState?: (id: number, state: EchoState) => void;
  disabled?: boolean;
}

interface PendingFile {
  file: File;
  key: string;
}

interface QueuedSend {
  text: string;
  diskPaths: string[];
  /** CAT-14: the optimistic-echo id created the INSTANT this message was
   *  queued, so a queued message is VISIBLE (state 'queued') and survivable —
   *  if JD clears the queue it's marked 'failed' (with Retry), never silently
   *  destroyed. `doSend` reuses this id at drain time instead of minting a
   *  second echo. -1 when the parent wired no `onEcho`. */
  echoId: number;
}

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_FILES = 5;

// Minimum rendered height of the composer textarea (cockpit-batch-a FIX 1).
// One line of `text-sm` (line-height ~1.25rem ≈ 20px) + the textarea's `py-2`
// vertical padding (8px top + 8px bottom = 16px) + the 1px top/bottom border
// ≈ 38px. We floor at 2.375rem (38px) so the "Message…" placeholder + the send
// affordance are ALWAYS fully visible on first paint, before any auto-grow
// measurement runs. Exported so the regression test asserts the floor exists.
export const COMPOSER_MIN_H = '2.375rem';

export default function CleanComposer({
  sessionId,
  threadId,
  onSent,
  onResumed,
  onEcho,
  onEchoResult,
  onEchoState,
  disabled,
}: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [queue, setQueue] = useState<QueuedSend[]>([]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Ref-based in-flight guard — state update is async, ref is synchronous.
  // Prevents two rapid sends from both passing the "is busy?" check.
  const inFlightRef = useRef(false);

  // CAT-10 (2026-06-12): autoFocus is DESKTOP-ONLY. On a phone, auto-focusing
  // the textarea raises the soft keyboard the instant /chat?panes=… opens —
  // covering the transcript before JD has read anything, and (pre-CAT-07)
  // shoving the composer under the keyboard. `autoFocus` only takes effect on
  // the initial mount, so the value is computed once via a lazy initializer
  // (SSR-safe: `matchMedia` is unavailable server-side → defaults to no
  // autofocus, which is the correct mobile behavior anyway). Keep-alive is
  // unaffected — autoFocus never re-fires on pane switches.
  const [desktopAutoFocus] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(min-width: 768px)').matches;
  });

  // Auto-grow textarea up to 8 rows. Measured AFTER layout (rAF) so a fresh
  // mount inside an absolute/flex container reads a correct scrollHeight on
  // the FIRST paint — fixes the new-chat glitch where the composer rendered
  // clipped until the box was focused (focus forced the reflow that should
  // have happened on mount). cockpit-chat-ux #4.
  //
  // BELT-AND-SUSPENDERS (cockpit-batch-a FIX 1): the rAF re-measure still
  // RACES on a fresh-chat first paint — if the container hasn't been laid out
  // when both `measure()` calls run, scrollHeight reads ~0 and the box paints
  // CLIPPED (zero-height) until the user types/focuses, which forces the
  // reflow. JS measurement timing can never be the ONLY thing standing between
  // JD and a visible input. So the textarea ALSO carries a CSS `min-height`
  // (COMPOSER_MIN_H — one line of text + the vertical padding). CSS min-height
  // FLOORS the inline `el.style.height` the auto-grow sets, so the box can
  // NEVER render below one full line regardless of when (or whether) the JS
  // measurement settles. Auto-grow still owns multi-line growth above the floor.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };
    // Run now AND on the next frame: 'now' covers the synchronous case, the
    // rAF covers the case where the container hasn't been laid out yet.
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [text]);

  const doSend = useCallback(
    async (content: string, diskPaths: string[], existingEchoId?: number) => {
      inFlightRef.current = true;
      setSending(true);
      setError(null);
      // Optimistic echo (cockpit-chat-ux #1): show JD's message in the
      // transcript the INSTANT the send starts — before the round-trip. The
      // echo bubble shows a "sending" affordance; CleanTranscript reconciles
      // it away when the real user turn lands in the JSONL poll. The echo text
      // is the user-visible content (attachments shown as compact @-labels,
      // not the full disk path).
      const echoText =
        diskPaths.length > 0
          ? `${diskPaths.map((p) => `[${p.split('/').pop()}]`).join('  ')}${
              content ? `\n${content}` : ''
            }`
          : content;
      // CAT-14: a QUEUED message already created its echo (state 'queued') the
      // instant JD hit Enter, so it was visible the whole time it waited. At
      // drain time we REUSE that echo id (flip it 'queued' → 'sending') instead
      // of minting a second bubble. A direct (non-queued) send mints a fresh
      // 'sending' echo as before.
      const echoId =
        existingEchoId !== undefined && existingEchoId >= 0
          ? (onEchoState?.(existingEchoId, 'sending'), existingEchoId)
          : onEcho?.(echoText) ?? -1;
      let ok = false;
      try {
        // Prepend @-refs so Claude Code can read attached files inline.
        const prefix = diskPaths.map((p) => `@${p}`).join('\n');
        const fullText = prefix ? `${prefix}\n\n${content}` : content;
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/input`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Trailing \r SUBMITS in the bracketed-paste TUI.
            body: JSON.stringify({ text: fullText + '\r' }),
          }
        );
        if (res.status === 401 && typeof window !== 'undefined') {
          const back = window.location.pathname + window.location.search;
          setError('Session expired — re-authenticating…');
          if (echoId >= 0) onEchoResult?.(echoId, false);
          window.location.assign(`/login?callbackUrl=${encodeURIComponent(back)}`);
          return;
        }
        if (!res.ok) {
          // CAT-03: humanize a dead-session send. A 404/410 from /input means
          // the bridge has no session for this sid (reaped / expired) — the raw
          // body was `404: {"error":"Session not found"}`, which reads as a
          // crash to JD. Surface a plain-English "this session has ended" so the
          // composer's error line is legible. (Once CAT-01 resolves the pane
          // dead the composer is disabled and this path is mostly unreachable;
          // this hardens the residual race where a live pane dies mid-type.)
          if (res.status === 404 || res.status === 410) {
            throw new Error(
              'This session has ended — resume it or start a new chat.'
            );
          }
          const txt = await res.text();
          throw new Error(`${res.status}: ${txt.slice(0, 160)}`);
        }
        let body: {
          new_session_id?: string;
          resumed?: boolean;
          // feat/read-receipts (2026-06-11): the bridge's verified-submit
          // outcome. true = the turn provably entered claude's composer AND
          // submitted (the receipt's "delivered"). false = the submit could
          // not be confirmed — warn JD to resend if no reply. Absent on an
          // older bridge → degrade to the previous 2xx-means-sent behavior.
          submitted?: boolean;
          input_ready?: boolean;
          warning?: string;
        } = {};
        try { body = await res.json(); } catch { /* empty on happy path */ }
        ok = true;
        if (echoId >= 0) onEchoResult?.(echoId, true);
        // Visible (never silent) cue when delivery is UNCONFIRMED: the bridge
        // accepted the bytes but couldn't verify the submit, or the agent was
        // still booting. The echo stays "delivered" (the bytes DID land and a
        // retry could double-send); the ✓✓ Read receipt simply never arrives,
        // and this inline warning tells JD why.
        if (body.warning) {
          setError(body.warning);
        } else if (body.submitted === false || body.input_ready === false) {
          setError(
            'Message may not have submitted — if the agent does not respond, resend it.'
          );
        }
        if (body.resumed && body.new_session_id) {
          onResumed?.(body.new_session_id);
          return;
        }
        onSent?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (echoId >= 0 && !ok) onEchoResult?.(echoId, false);
      } finally {
        inFlightRef.current = false;
        setSending(false);
        // Refocus so the user can keep typing without clicking.
        requestAnimationFrame(() => textRef.current?.focus());
      }
    },
    [sessionId, onSent, onResumed, onEcho, onEchoResult, onEchoState]
  );

  // Drain queue FIFO whenever the in-flight turn finishes.
  //
  // CAT-13 (2026-06-12) — double-send race. `doSend` sets `inFlightRef.current`
  // SYNCHRONOUSLY but `setSending(true)` is async. When `doSend` runs it also
  // calls `setQueue((q) => q.slice(1))` is NOT what fires it — the queue change
  // from `handleSend`/the drain itself re-runs this effect, and if we only
  // guarded on the async `sending` STATE the just-started send isn't yet
  // observable (sending still === false), so the effect would see a shorter-
  // but-nonempty queue and fire `doSend` for the NEXT item CONCURRENTLY — two
  // near-simultaneous `text+\r` writes interleave in the bracketed-paste TUI
  // and FIFO ordering collapses. The fix: also consult the SYNCHRONOUS
  // `inFlightRef.current`, which is already true the instant a send starts, so
  // the drain can never overlap an in-flight send regardless of state flush
  // timing. (We keep `sending` in the deps so the effect re-evaluates when a
  // send completes and `setSending(false)` re-renders.)
  useEffect(() => {
    if (inFlightRef.current || sending || queue.length === 0) return;
    const next = queue[0];
    setQueue((q) => q.slice(1));
    void doSend(next.text, next.diskPaths, next.echoId);
  }, [sending, queue, doSend]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    const current = [...pending];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_SIZE) { setError(`"${f.name}" is over 25MB`); continue; }
      if (current.length >= MAX_FILES) { setError(`Max ${MAX_FILES} files`); break; }
      current.push({ file: f, key: `${Date.now()}-${Math.random()}` });
    }
    setPending(current);
    if (fileRef.current) fileRef.current.value = '';
    requestAnimationFrame(() => textRef.current?.focus());
  }

  async function handleSend() {
    const content = text.trim();
    if (!content && pending.length === 0) return;
    if (uploading) return;
    setError(null);

    let diskPaths: string[] = [];
    if (pending.length > 0 && threadId) {
      setUploading(true);
      try {
        const form = new FormData();
        form.append('thread_id', threadId);
        for (const p of pending) form.append('files', p.file, p.file.name);
        const res = await fetch('/api/uploads', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        diskPaths = (data.uploads as Array<{ disk_path: string }>).map((u) => u.disk_path);
      } catch (err) {
        setError(`Upload failed: ${String(err instanceof Error ? err.message : err)}`);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    setText('');
    setPending([]);

    if (inFlightRef.current || queue.length > 0) {
      // CAT-14: echo the queued message IMMEDIATELY (state 'queued') so it's
      // visible the whole time it waits — never an invisible string that
      // vanishes without a trace when JD taps "clear". `doSend` reuses this
      // echo id at drain time (flips it to 'sending'), so there's no double
      // bubble. The echo text mirrors doSend's user-visible formatting
      // (attachments as compact @-labels).
      const echoText =
        diskPaths.length > 0
          ? `${diskPaths.map((p) => `[${p.split('/').pop()}]`).join('  ')}${
              content ? `\n${content}` : ''
            }`
          : content;
      const echoId = onEcho?.(echoText) ?? -1;
      if (echoId >= 0) onEchoState?.(echoId, 'queued');
      setQueue((q) => [...q, { text: content, diskPaths, echoId }]);
      return;
    }
    void doSend(content, diskPaths);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleTranscript(transcript: string) {
    setError(null);
    setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
    requestAnimationFrame(() => textRef.current?.focus());
  }

  const inputBusy = uploading;
  const queueLength = queue.length;
  const canAttach = !!threadId;

  return (
    // Mobile composer (chat-session mobile pass, 2026-06-10): pin to the bottom
    // edge with the iOS home-indicator safe-area inset reserved BELOW the input
    // so the send row never sits under the home bar. `.composer-safe-bottom`
    // adds env(safe-area-inset-bottom) on phones only (max-md), zero on desktop
    // — desktop padding (p-2) is byte-identical to before.
    <div className="composer-safe-bottom shrink-0 border-t border-hairline bg-surface-1 p-2">
      {error && (
        // Critic r1 FIX #2 — inline send/upload failures use the muted clay
        // danger token, not the saturated status red (no neon red competing
        // with the brand amber).
        <div className="mb-1 text-[11px] text-state-danger-muted mono px-1">{error}</div>
      )}

      {queueLength > 0 && (
        <div className="mb-1.5 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-tint-working px-2 py-0.5 text-state-working text-[11px] weight-label">
            <CircleNotch size={11} weight="bold" className="animate-spin" aria-hidden />
            <span className="tabular">Queued · {queueLength}</span>
          </span>
          <button
            type="button"
            data-testid="clean-composer-clear-queue"
            onClick={() => {
              // CAT-14: NEVER silently destroy queued input. Each queued
              // message has a visible echo (state 'queued'); mark them 'failed'
              // so they stay on screen with a Retry affordance, then drop them
              // from the FIFO. JD always sees what was "cleared" and can resend
              // with one tap — a fat-finger clear next to the pill is no longer
              // data loss.
              setQueue((q) => {
                for (const item of q) {
                  if (item.echoId >= 0) onEchoState?.(item.echoId, 'failed');
                }
                return [];
              });
            }}
            className="press text-3 hover:text-2 text-[11px] hover:underline"
          >
            clear
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {pending.map((p) => (
            <span
              key={p.key}
              className="inline-flex items-center gap-1.5 rounded-sm bg-surface-2 border border-hairline px-2.5 py-0.5 text-xs text-2"
            >
              <Icon glyph={Paperclip} size={13} className="text-3 shrink-0" aria-hidden />
              <span className="truncate max-w-[160px]">{p.file.name}</span>
              <button
                type="button"
                onClick={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}
                className="press text-3 hover:text-1"
                aria-label="Remove file"
              >
                <Icon glyph={X} size={13} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {canAttach && (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={inputBusy || disabled}
              // Mobile touch target ≥44px (h-11 w-11); desktop reverts to the
              // original compact 32px (md:h-8 md:w-8) so desktop chrome is
              // pixel-unchanged.
              className="press focus-accent shrink-0 h-11 w-11 md:h-8 md:w-8 rounded-md flex items-center justify-center border border-hairline bg-sunken text-3 hover:text-1 hover:bg-surface-3 lift disabled:opacity-40"
              aria-label="Attach files"
              title="Attach files (up to 5, 25MB each)"
            >
              <Icon glyph={Paperclip} size={16} aria-hidden />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.txt,.md,.csv,.json,.docx,.pptx,.xlsx"
              onChange={(e) => addFiles(e.target.files)}
              className="hidden"
            />
          </>
        )}

        <VoiceRecorder
          onTranscript={handleTranscript}
          onError={(err) => setError(err.message)}
          disabled={inputBusy || disabled}
          // Mobile touch target ≥44px; desktop reverts to the original 32px.
          className="w-11 h-11 md:w-8 md:h-8 shrink-0"
        />

        <textarea
          ref={textRef}
          data-testid="clean-composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || inputBusy}
          rows={1}
          // CAT-10: desktop-only autofocus — never pop the iOS keyboard on a
          // cold mobile load. Computed once at mount (see desktopAutoFocus).
          autoFocus={desktopAutoFocus}
          placeholder={uploading ? 'Uploading…' : 'Message…'}
          // min-height FLOOR (cockpit-batch-a FIX 1): set inline so it CANNOT
          // be purged by Tailwind and is read deterministically by the test.
          // The auto-grow effect sets `style.height`; CSS `min-height` floors
          // it, so the box never renders clipped even if measurement hasn't run.
          style={{ minHeight: COMPOSER_MIN_H }}
          // NO-ZOOM-ON-FOCUS (chat-session mobile pass, 2026-06-10): iOS Safari
          // auto-zooms when an input's font-size is < 16px. The composer text was
          // `text-sm` (14px), which forced a jarring zoom every time JD tapped to
          // type on his phone. Floor the font at 16px on mobile (`text-base`),
          // reverting to the original 14px (`md:text-sm`) on desktop so desktop
          // density is unchanged.
          className="focus-accent flex-1 min-w-0 resize-none rounded-md bg-sunken border border-hairline px-3 py-2 text-base md:text-sm text-1 placeholder:text-3 focus:outline-none max-h-40 disabled:opacity-60"
        />

        <button
          type="button"
          data-testid="clean-composer-send"
          onClick={() => void handleSend()}
          disabled={disabled || inputBusy || (!text.trim() && pending.length === 0)}
          // Mobile send is a ≥44px square touch target (h-11 min-w-11); desktop
          // reverts to the original auto-width px-3 py-2 pill so desktop chrome
          // is pixel-unchanged.
          className="press focus-accent shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md bg-accent hover:bg-accent-hover active:bg-accent-active text-on-accent disabled:bg-surface-3 disabled:text-4 text-sm weight-label h-11 min-w-11 px-3 md:h-auto md:min-w-0 md:py-2 transition-colors"
        >
          {uploading ? (
            <CircleNotch size={15} weight="bold" className="animate-spin" aria-hidden />
          ) : sending ? (
            'Queue'
          ) : (
            <Icon glyph={ArrowUp} size={15} weight="bold" aria-label="Send" />
          )}
        </button>
      </div>
    </div>
  );
}
