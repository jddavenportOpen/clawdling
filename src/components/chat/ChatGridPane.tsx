'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ChatGridPane — single pane wrapper inside ChatGrid.
//
// Composition: header bar (title, status pill, X close) + body with the
// existing SessionTerminal. SessionTerminal owns its own SSE connection,
// history replay, input box, kill button — we don't reach inside it. The
// pane just provides chrome and a "remove from grid" affordance.
//
// Closing a pane (X) calls onRemove(sid) — the parent ChatGrid removes
// it from the panes array and updates the URL. The bridge process keeps
// running. To actually KILL the session, the user clicks the existing
// kill button INSIDE SessionTerminal.
//
// V3.2 (2026-05-28, JD msgs 8280+8285): the header chrome adapts to the
// cockpit's render mode. In PANE mode the existing Maximize toggle (⤢/⤡)
// is shown. In CHAT mode the Maximize is hidden (no meaning — the visible
// chat already fills the canvas) and an "Add to pane" affordance (⊞) is
// shown so a user can pull a chat into the multi-agent grid view.
//
// (see docs/ARCHITECTURE.md)
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import SessionTerminal from './SessionTerminal';
import CleanTranscript, { type PendingEcho } from './CleanTranscript';
import CleanComposer from './CleanComposer';
import { StatusGlyph, type GlyphState } from '@/components/ds/StatusGlyph';
import { Icon } from '@/components/ds/Icon';
import {
  ArrowsOut,
  ArrowsIn,
  SquaresFour,
  X,
} from '@phosphor-icons/react/dist/ssr';

// ── Agent STATE pill model (cockpit-chat-ux #2) ─────────────────────────────
// Pure mapping from bridge-truth (status + activity) → the pill JD reads.
// Exported for unit tests so the state→label contract is regression-guarded.
//
// Warm-Graphite v6: the pill's COLOR is now carried by the bespoke StatusGlyph
// (the ring/pie state machine — the cockpit's "custom emoji"), not a raw dot.
// `glyph` selects the GlyphState; `tintClass`/`textClass`/`dotClass` are
// semantic-token classes (state tint fill + state text) — never raw palette hex.
export interface PaneStatePill {
  tone: 'thinking' | 'done' | 'stopped' | 'starting';
  /** The StatusGlyph state this tone renders as (the custom-emoji ring). */
  glyph: GlyphState;
  label: string;
  /** Semantic-token classes (state tint pill fill + state text/dot). */
  tintClass: string;
  textClass: string;
  dotClass: string;
  animate: boolean;
}

/** A status is "dead/terminal" — no agent on the other end. */
function isDeadStatusValue(s: string | undefined): boolean {
  return s !== undefined && s !== 'live' && s !== 'starting';
}

// ── Single status authority per pane (CAT-16 / CODE-STATE BUG-5, 2026-06-12) ──
// Two truths feed the pane: `sseStatus` — SessionTerminal's SSE-driven status,
// bubbled instantly on the `exit`/`status` frame (event-driven, authoritative,
// monotonic to 'exited') — and `pollStatus` — ChatGrid's 3.5s /api/sessions/list
// poll (a slow correction). The pill used to read `pollStatus ?? sseStatus`,
// preferring the 3.5s poll, so on a clean exit SSE latched 'exited' instantly
// while the poll still reported 'live' for up to 3.5s → a green "Done · your
// turn" pill above an ENDED badge.
//
// The rule: EVENT-DRIVEN SSE WINS, and a TERMINAL signal from EITHER source is
// authoritative the instant it lands.
//   1. If SSE has declared the session dead → dead (instant clean-exit truth;
//      SSE is monotonic to 'exited', so this never flaps back).
//   2. Else if the poll reports dead → dead (the poll caught a reap SSE hasn't
//      seen yet — e.g. a bridge-side kill; the inverse correction).
//   3. Else prefer SSE's live status (instant) over the lagging poll, falling
//      back to the poll only when SSE hasn't reported yet.
// Either source reaching a dead state wins, so the pill can never show a green
// "Done" over a session the stream already knows is gone — and vice-versa.
export function resolveEffStatus(
  sseStatus: string | undefined,
  pollStatus: string | undefined
): string | undefined {
  if (isDeadStatusValue(sseStatus)) return sseStatus;
  if (isDeadStatusValue(pollStatus)) return pollStatus;
  // Both live-ish (or unknown): SSE is the instant, event-driven truth; the
  // poll is only a fallback for a pane SSE hasn't reported a status for yet.
  return sseStatus ?? pollStatus;
}

// ── Activity hysteresis (CAT-16 / CODE-STATE BUG-15, 2026-06-12) ──────────────
// A transient feed tick can report `live:true, activity:null` (a race between
// bridge state updates). derivePill maps live + null-activity → "Done · your
// turn", so the pill flapped Done↔Thinking every 3.5s while the agent was
// actually working but the bridge intermittently nulled activity. Treat a
// live+null-activity tick as UNKNOWN — hold the last NON-NULL activity instead
// of immediately collapsing to "Done". Pure so it can be unit-pinned.
//   - live + a real activity → that activity (and remember it).
//   - live + null activity   → the last remembered non-null activity (hold).
//   - not live               → null (a dead session has no activity; the dead
//                              branch of derivePill owns the label).
export function holdActivity(
  effStatus: string | undefined,
  rawActivity: string | null | undefined,
  lastNonNull: string | null | undefined
): string | null {
  const live = effStatus === 'live' || effStatus === 'starting';
  if (!live) return null;
  if (rawActivity != null && rawActivity !== '') return rawActivity;
  return lastNonNull ?? null;
}

export function derivePill(
  status: string | undefined,
  activity: string | null | undefined,
  inFlight: boolean
): PaneStatePill {
  // A turn we just fired (unresolved optimistic echo) means we're waiting on
  // the agent — show Thinking even before the activity poll catches up.
  if (inFlight) {
    return {
      tone: 'thinking',
      glyph: 'working',
      label: 'Thinking…',
      tintClass: 'bg-tint-working',
      textClass: 'text-state-working',
      dotClass: 'bg-state-working',
      animate: true,
    };
  }
  if (status === 'starting') {
    return {
      tone: 'starting',
      glyph: 'queued',
      label: 'Starting…',
      tintClass: 'bg-tint-idle',
      textClass: 'text-3',
      dotClass: 'bg-state-idle',
      animate: true,
    };
  }
  const live = status === 'live' || status === 'starting';
  if (!live) {
    // Dead / ended / never-live → no agent on the other end.
    return {
      tone: 'stopped',
      glyph: 'error',
      label: 'Stopped — no response',
      tintClass: 'bg-tint-error',
      textClass: 'text-state-error',
      dotClass: 'bg-state-error',
      animate: false,
    };
  }
  // Live. Activity is the bridge waiting-signal.
  const act = (activity ?? '').toLowerCase();
  if (act === 'running' || act === 'working' || act === 'busy') {
    return {
      tone: 'thinking',
      glyph: 'working',
      label: 'Thinking…',
      tintClass: 'bg-tint-working',
      textClass: 'text-state-working',
      dotClass: 'bg-state-working',
      animate: true,
    };
  }
  // waiting / idle / unknown-but-live → the agent finished its turn; it's
  // JD's move. "Done" with the your-turn semantics JD described.
  return {
    tone: 'done',
    glyph: 'done',
    label: 'Done · your turn',
    tintClass: 'bg-tint-ready',
    textClass: 'text-state-ready',
    dotClass: 'bg-state-ready',
    animate: false,
  };
}

interface Props {
  sessionId: string;
  /** Display title (cwd basename + time, set at spawn). */
  initialTitle: string;
  /** Initial status from the descriptor (sourced from /api/sessions/list,
   *  /api/threads/[id]/session, or the launcher/spawn response). MUST be the
   *  REAL session status — `seedHistoryTail` in SessionTerminal reads this
   *  ONCE via useRef on mount to gate the /history-replay branch. A wrong
   *  value here silently drops the dead-session transcript paint (audit
   *  HIGH #1 / JD msg 8136). ChatGrid guarantees this by not mounting
   *  ChatGridPane until the descriptor's `metaResolved` flag is true. */
  initialStatus: string;
  /** Supabase chat_sessions.thread_id for this session. Hoisted into
   *  PaneDescriptor (audit HIGH #2 root-cause fix, 2026-05-27) so the
   *  "Spawn new with same prompt" recovery button is wired SYNCHRONOUSLY
   *  on first render — no per-pane /api/sessions/list fetch race against
   *  the user's first interaction. Null when the descriptor's lookup
   *  failed (sid older than the feed's 30-row cap) or the pane was
   *  launched without a backing thread; SessionTerminal hides the
   *  recovery button in that case (same behavior as pre-fix). */
  threadId?: string | null;
  /** Live, re-polled session status from ChatGrid's shared activity poll
   *  (cockpit-chat-ux, 2026-06-02). Unlike `initialStatus` (read once by
   *  SessionTerminal), this updates every poll tick. Drives the agent STATE
   *  pill. 'live' | 'starting' | 'exited' | other. */
  liveStatus?: string;
  /** Live bridge waiting-signal: 'working' | 'running' | 'waiting' | 'idle' |
   *  null. From /api/sessions/list per-session `activity`. Re-polled. The
   *  STATE pill reads this: running/working → Thinking…; waiting → Done (your
   *  turn); null while live but long-idle / not-live → Stopped. */
  liveActivity?: string | null;
  /** True if this is the focused pane — gets a cyan border. */
  isActive: boolean;
  /** User clicked the pane body — promote to active. */
  onFocus: () => void;
  /** User clicked X — remove from grid (does NOT kill the session). */
  onRemove: () => void;
  /** A dead session in this pane resumed into a new bridge sid. Bubbled up
   *  from SessionTerminal so ChatGrid can swap the pane's sid in place
   *  (cockpit overhaul 2026-05-26). */
  onResumed?: (oldSid: string, newSid: string) => void;
  /** True when this pane is maximized to fill the Stage (Focus mode, PR-D).
   *  In V3.2 chat mode, this prop ALSO doubles as "this is the visible chat"
   *  so the font-size tier picks the focus-class bigger size; ChatGrid wires
   *  it that way. */
  isFocused?: boolean;
  /** Toggle Focus mode for this pane (maximize / restore to grid). */
  onToggleFocus?: () => void;
  /** v3 pane-readability — xterm font size in px. ChatGrid passes a tier
   *  based on pane count (1-2: 13, 3-4: 12, 5+: 11). Optional; default 12. */
  fontSize?: number;
  /** V3.2 (2026-05-28): the cockpit's current render mode. Drives header
   *  chrome:
   *    'pane' (default) — show Maximize ⤢/⤡ + hide Add-to-pane button.
   *    'chat'           — hide Maximize (canvas is already one pane) +
   *                       show Add-to-pane ⊞ button.
   *  Backwards-compat: undefined defaults to 'pane' so the existing grid
   *  UX (Maximize visible, no Add-to-pane) is preserved if a caller
   *  doesn't pass this prop. */
  cockpitMode?: 'chat' | 'pane';
  /** V3.2: user clicked "Add to pane" in chat mode. ChatGrid handles the
   *  side-effect (currently a toast offering mode switch — see push-back
   *  in ChatGrid render path). No-op if undefined. */
  onAddToPane?: () => void;
}

export default function ChatGridPane({
  sessionId,
  initialTitle,
  initialStatus,
  liveStatus,
  liveActivity,
  threadId = null,
  isActive,
  onFocus,
  onRemove,
  onResumed,
  isFocused = false,
  onToggleFocus,
  fontSize,
  cockpitMode = 'pane',
  onAddToPane,
}: Props) {
  // 2026-05-03: dropped the /api/sessions/{sid} polling timer. Polling +
  // SessionTerminal's own SSE-driven status would drift on transitions
  // (live → exited) — the dot would stay green for up to 10s after the
  // SSE 'exit' event fired. SessionTerminal now bubbles status up via
  // onStatusChange so the header dot updates instantly with the stream.
  const [paneStatus, setPaneStatus] = useState<string>(initialStatus);
  const handleStatus = useCallback((next: string) => setPaneStatus(next), []);

  // ── Optimistic echo (cockpit-chat-ux #1, 2026-06-02) ──────────────────────
  // The INSTANT JD hits Enter his message must appear in the transcript — don't
  // wait the /input round-trip + the next transcript poll (4s). CleanComposer
  // emits the sent text here via onEcho; we hold it as a pending bubble passed
  // to CleanTranscript, which renders it (greyed, with a "sending" / "failed"
  // "failed" affordance) until the real user turn lands in the JSONL poll —
  // then CleanTranscript drops the matching echo (dedup on text). Kills the
  // "did it even send?" anxiety. Retry re-posts the same text.
  const [echoes, setEchoes] = useState<PendingEcho[]>([]);
  const echoSeq = useRef(0);
  const addEcho = useCallback((text: string): number => {
    echoSeq.current += 1;
    const id = echoSeq.current;
    setEchoes((prev) => [...prev, { id, text, state: 'sending', ts: Date.now() }]);
    return id;
  }, []);
  const markEcho = useCallback((id: number, state: PendingEcho['state']) => {
    setEchoes((prev) =>
      prev.map((e) => (e.id === id ? { ...e, state } : e))
    );
  }, []);
  const dropEcho = useCallback((id: number) => {
    setEchoes((prev) => prev.filter((e) => e.id !== id));
  }, []);
  const setEchoState = useCallback(
    (id: number, state: PendingEcho['state']) => markEcho(id, state),
    [markEcho]
  );

  // ── Echoes are SESSION-SCOPED (CAT-17, 2026-06-12) ────────────────────────
  // The optimistic-echo list lives on ChatGridPane, which does NOT remount on a
  // resume sid-swap (the swap flips the clean view to raw + repoints the bridge
  // sid in place — ChatGridPane keeps its React identity). Without this, echoes
  // pending against the OLD sid would survive the swap and try to reconcile
  // against the NEW session's transcript turns — a cross-session match that
  // drops a bubble or stamps a Read receipt on the wrong turn. Clear all
  // pending echoes the instant the pane's `sessionId` changes so cross-session
  // reconciliation is structurally impossible, not merely ordering-dependent.
  const echoSidRef = useRef(sessionId);
  useEffect(() => {
    if (echoSidRef.current === sessionId) return;
    echoSidRef.current = sessionId;
    setEchoes([]);
  }, [sessionId]);

  // ── Echo TTL safety net (cockpit-chat-ux #1 follow-up, 2026-06-07) ─────────
  // An optimistic echo's ONLY removal path is a text-match reconciliation
  // against the transcript poll (CleanTranscript → onEchoReconciled). When that
  // match never lands the bubble is otherwise IMMORTAL — it renders after every
  // real turn, pinned to the very bottom forever, masquerading as the newest
  // message (JD 2026-06-07: "messages persist at the bottom even though they
  // were way long ago"). The match silently misses whenever: a resume sid-swap
  // routes the real user turn into a different cc-session JSONL than the one
  // being polled, the bridge records the turn in a form normForMatch can't fold,
  // or the turn outruns the poll window. A 'sent' echo means the /input POST
  // already SUCCEEDED — the message is confirmed in the system and the
  // transcript is now authoritative — so after a generous grace window we drop
  // the orphan; the real turn shows via the normal poll, no duplicate, no loss.
  // 'sending' (still in-flight — could yet resolve) and 'failed' (needs the
  // Retry affordance) echoes are NEVER swept. This gives the optimistic element
  // the fallback removal path its original design lacked.
  const ECHO_TTL_MS = 30_000;
  const hasSentEcho = echoes.some((e) => e.state === 'sent');
  useEffect(() => {
    if (!hasSentEcho) return;
    const sweep = setInterval(() => {
      setEchoes((prev) =>
        prev.filter(
          (e) => e.state !== 'sent' || Date.now() - e.ts < ECHO_TTL_MS
        )
      );
    }, 5_000);
    return () => clearInterval(sweep);
  }, [hasSentEcho]);

  // ── Agent STATE pill (cockpit-chat-ux #2 — JD's #1 ask) ───────────────────
  // "I want to know if it's still thinking or stopped thinking — did it die,
  // is it done." Driven by the bridge's LIVE session activity (liveStatus +
  // liveActivity from ChatGrid's shared /api/sessions/list poll) — never faked.
  //   running/working → working glyph (warm sweep) · Thinking…
  //   waiting/idle (live, turn done) → done glyph (green ring+check) · Done
  //   not live / exited / dead → error glyph (red ring+X) · Stopped
  // While a turn is in flight from THIS pane's composer (an unresolved echo),
  // we optimistically show Thinking… even before the poll flips activity, so
  // the pill reacts the instant JD sends.
  // CAT-16: ONE status authority per pane. `paneStatus` is SessionTerminal's
  // SSE-driven status (instant, event-driven, monotonic to 'exited');
  // `liveStatus` is ChatGrid's 3.5s poll (a slow correction). resolveEffStatus
  // lets a terminal signal from EITHER source win the instant it lands, so the
  // pill can't show green "Done" over a session the SSE already ENDED.
  const effStatus = resolveEffStatus(paneStatus, liveStatus);
  const hasInFlightEcho = echoes.some((e) => e.state === 'sending');
  // CAT-16: hold the last non-null activity so a transient live+null-activity
  // poll tick doesn't flap the pill Done↔Thinking every 3.5s while the agent is
  // really working. The ref is the memory; effActivity is what the pill reads.
  const lastActivityRef = useRef<string | null>(null);
  const effActivity = holdActivity(effStatus, liveActivity, lastActivityRef.current);
  if (effActivity != null) lastActivityRef.current = effActivity;
  const pill = derivePill(effStatus, effActivity, hasInFlightEcho);

  // ── Dead-pane composer gate (CAT-01 / CODE-STATE BUG-13, 2026-06-12) ───────
  // When the resolved status is dead (not 'live'/'starting'), there is no agent
  // on the other end — typing routes to a 404 /input that silently fails and
  // looks "sent" (the box clears). Disable the composer so the pane is honestly
  // non-interactive: the pill already reads "Stopped — no response" and the
  // dead-state transcript empty-state offers Resume / Spawn-new. We DON'T gate
  // on 'starting' (a booting session is about to accept input) and we keep the
  // composer live the instant a real send is in flight (an optimistic echo)
  // so an in-flight turn isn't yanked mid-send. This is the input half of the
  // spine: once status resolves dead, the "looks ready, type, nothing happens"
  // path is unreachable.
  const isDeadStatus = isDeadStatusValue(effStatus);
  const composerDisabled = isDeadStatus && !hasInFlightEcho;

  // ── Clean-render (2026-06-01): clean chat bubbles vs the raw terminal ──────
  // 'clean' (default) renders CleanTranscript (structured CC JSONL → bubbles)
  // + a thin CleanComposer. 'raw' renders the full interactive SessionTerminal
  // (xterm + composer + the /model menu + choice buttons + raw-key controls).
  // The toggle keeps the interactive surface ALWAYS one tap away so JD never
  // loses the ability to answer a menu — non-negotiable per the centerpiece
  // spec. A resume-swap from the clean composer auto-flips to raw (which owns
  // the full sid-swap + reload).
  const [view, setView] = useState<'clean' | 'raw'>('clean');
  // Bumped on every clean-composer send so CleanTranscript can re-poll
  // promptly (don't wait the full refresh interval to show JD's bubble).
  const [sendTick, setSendTick] = useState(0);
  const nudgeTranscript = useCallback(() => setSendTick((n) => n + 1), []);
  const handleCleanResume = useCallback(() => {
    // The /input route swapped the sid — drop into raw so SessionTerminal
    // completes the swap (reload to the new sid).
    setView('raw');
  }, []);

  // ── threadId now arrives as a prop (audit HIGH #2 root-cause fix, 2026-05-27) ─
  // PR #97 originally fetched threadId in a per-pane useEffect that raced
  // against the user's first interaction (the spawn-new button could be
  // silently unwired on a sub-second window). That fetch is DELETED here —
  // ChatGrid hoists thread_id into PaneDescriptor and we receive it via
  // props. Closes the race + drops N redundant /api/sessions/list calls
  // (one per pane) on cockpit mount.

  // Warm-Graphite v6: the header status is now the bespoke StatusGlyph ring —
  // the cockpit's "custom emoji" — not a raw colored dot. Map the descriptor
  // status to a GlyphState; the ring's color+motion is the design-system's.
  const headerGlyph: GlyphState =
    paneStatus === 'live'
      ? 'done'
      : paneStatus === 'starting'
      ? 'queued'
      : paneStatus === 'exited'
      ? 'idle'
      : 'error';

  return (
    <div
      onMouseDown={onFocus}
      data-active={isActive ? 'true' : undefined}
      className={`lift flex flex-col min-w-0 min-h-0 h-full overflow-hidden border rounded-lg bg-surface-2 ${
        isActive ? 'border-accent-border' : 'border-hairline'
      }`}
    >
      <header className="shrink-0 flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-hairline bg-surface-1">
        <div className="flex items-center gap-2 min-w-0">
          {/* The bespoke StatusGlyph (the custom-emoji ring) — descriptor-status
              encoded as ring shape + state color + motion. Replaces the raw dot. */}
          <StatusGlyph
            state={headerGlyph}
            size={14}
            className="shrink-0"
            title={`Status: ${paneStatus}`}
          />
          <span
            className="mono text-xs text-2 truncate weight-label"
            title={`${initialTitle} · ${sessionId}`}
          >
            {initialTitle}
          </span>
          {/* Agent STATE pill (cockpit-chat-ux #2) — Thinking… / Done / Stopped.
              Bridge-truth (liveStatus + liveActivity). The clearest "is it
              alive / thinking / done / dead" signal, right on the chat header.
              Warm-Graphite: the live state is carried by the StatusGlyph ring
              (the working sweep animates while Thinking…); the label is a
              ~14%-alpha state-tint pill, never the brand accent. */}
          <span
            data-testid="agent-state-pill"
            data-tone={pill.tone}
            className={`shrink-0 inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[10px] leading-none weight-label ${pill.tintClass} ${pill.textClass}`}
            title={`Agent state: ${pill.label}`}
          >
            <StatusGlyph state={pill.glyph} size={11} />
            {pill.label}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Clean-render (2026-06-01): toggle clean bubbles ⇄ raw terminal.
              Default is clean (readable chat); RAW gives the full interactive
              Claude Code surface (the /model menu, choice buttons, raw-key
              controls). Always one tap away so a menu is never unanswerable. */}
          <button
            type="button"
            data-testid="pane-toggle-view"
            onClick={(e) => {
              e.stopPropagation();
              setView((v) => (v === 'clean' ? 'raw' : 'clean'));
            }}
            className={`press focus-accent mono text-[10px] leading-none px-1.5 py-1 rounded-sm border lift weight-label ${
              view === 'clean'
                ? 'text-2 border-hairline hover:bg-surface-3'
                : 'text-state-working border-border-strong hover:bg-surface-3'
            }`}
            aria-label={
              view === 'clean'
                ? 'Switch to raw terminal (for menus / interactive prompts)'
                : 'Switch to clean chat view'
            }
            title={
              view === 'clean'
                ? 'Raw terminal — for the /model menu, choice prompts, raw-key controls'
                : 'Clean chat view'
            }
          >
            {view === 'clean' ? 'clean' : 'raw'}
          </button>
          {/* V3.2 (2026-05-28): in chat mode, show "Add to pane" (⊞) instead
              of Maximize because the canvas is already one pane — there's
              nothing to maximize. ChatGrid's onAddToPane currently fires a
              toast offering a mode switch (single-membership model — see the
              push-back note in ChatGrid). In pane mode the original Maximize
              toggle is preserved. */}
          {cockpitMode === 'chat' && onAddToPane ? (
            <button
              type="button"
              data-testid="pane-add-to-pane"
              onClick={(e) => {
                e.stopPropagation();
                onAddToPane();
              }}
              className="press focus-accent text-3 hover:text-accent-text leading-none p-1 rounded-sm lift hover:bg-surface-3"
              aria-label="Add to pane view"
              title="Add to pane view"
            >
              <Icon glyph={SquaresFour} size={15} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              data-testid="pane-toggle-focus"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFocus?.();
              }}
              className="press focus-accent text-3 hover:text-1 leading-none p-1 rounded-sm lift hover:bg-surface-3"
              aria-label={isFocused ? 'Exit focus' : 'Focus pane'}
              title={isFocused ? 'Exit focus (Esc)' : 'Focus this pane (maximize)'}
            >
              <Icon glyph={isFocused ? ArrowsIn : ArrowsOut} size={15} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="press focus-accent text-3 hover:text-1 leading-none p-1 rounded-sm lift hover:bg-surface-3"
            aria-label="Remove pane"
            title="Remove pane (session keeps running on bridge)"
          >
            <Icon glyph={X} size={15} aria-hidden />
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {/* SessionTerminal stays MOUNTED in both views so its SSE connection +
            status reporting (onStatusChange → the header dot) keep flowing and
            so the FULL interactive surface (the /model menu, choice buttons,
            raw-key controls) is instantly live the moment JD flips to raw. In
            clean mode it's visually hidden behind the clean overlay; in raw
            mode the clean overlay is not rendered. */}
        <div
          className={view === 'clean' ? 'absolute inset-0 invisible' : 'h-full'}
          aria-hidden={view === 'clean'}
        >
          <SessionTerminal
            sessionId={sessionId}
            initialStatus={initialStatus}
            threadId={threadId}
            onStatusChange={handleStatus}
            onResumed={onResumed}
            fontSize={fontSize}
          />
        </div>
        {view === 'clean' && (
          // Opaque canvas base on the overlay (cockpit-chat-ux #4): the raw
          // SessionTerminal behind paints a black xterm canvas. On a fresh-chat
          // first paint, a sub-frame layout race let that black bleed through,
          // reading as "mostly black, input clipped." An opaque overlay base
          // (bg-canvas) guarantees the clean surface is fully painted from
          // frame one regardless of measurement timing.
          <div className="absolute inset-0 flex flex-col min-h-0 bg-canvas">
            <div className="flex-1 min-h-0 overflow-hidden">
              <CleanTranscript
                sessionId={sessionId}
                refetchKey={sendTick}
                liveStatus={effStatus}
                // CAT-16: pass the hysteresis-held activity (not the raw poll
                // value) so the clean view reads the same single authority as
                // the pill — no Done↔Thinking flap on a live+null-activity tick.
                liveActivity={effActivity}
                // CAT-04: when the pane is resolved-dead, a transcript 404 is a
                // gone session (not a transient flap) → render the "session
                // ended" empty-state with Resume / Spawn-new instead of the
                // "switch to raw" dead-end (raw is also empty on a dead sid).
                isDead={isDeadStatus}
                onResume={() => setView('raw')}
                echoes={echoes}
                onEchoReconciled={dropEcho}
                onRetryEcho={(id, text) => {
                  // Re-arm the echo and re-fire via the same /input path the
                  // composer uses. Mark sending, repost, reconcile/fail.
                  markEcho(id, 'sending');
                  void (async () => {
                    try {
                      const res = await fetch(
                        `/api/sessions/${encodeURIComponent(sessionId)}/input`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ text: text + '\r' }),
                        }
                      );
                      if (!res.ok) throw new Error(String(res.status));
                      nudgeTranscript();
                    } catch {
                      markEcho(id, 'failed');
                    }
                  })();
                }}
              />
            </div>
            <CleanComposer
              sessionId={sessionId}
              threadId={threadId}
              onSent={nudgeTranscript}
              onResumed={handleCleanResume}
              onEcho={addEcho}
              onEchoResult={(id, ok) => markEcho(id, ok ? 'sent' : 'failed')}
              // CAT-14: lets the composer mark a queued echo 'queued' (visible
              // while it waits) and 'failed' (with Retry) on a queue-clear,
              // instead of silently destroying typed input.
              onEchoState={setEchoState}
              // CAT-01 / BUG-13: a resolved-dead pane has no agent to receive
              // input — disable the composer so JD can't type into the void.
              disabled={composerDisabled}
            />
          </div>
        )}
      </div>
    </div>
  );
}
