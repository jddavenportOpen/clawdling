'use client';

// ═══════════════════════════════════════════════════════════════════════════
// CleanTranscript — read-only CLEAN chat-bubble view of a session.
//
// Centerpiece clean-render (2026-06-01). Renders a domain/agent conversation
// as readable chat bubbles instead of the raw Claude Code terminal (box-chars,
// status lines). It fetches the bridge's structured-transcript endpoint
// (GET /api/sessions/<sid>/transcript) — which parses Claude Code's own
// session JSONL (~/.claude/projects/<enc-cwd>/<cc>.jsonl) into normalized
// turns — and paints them with the existing, production-tested bubble parts:
// MarkdownBubble (assistant text), ToolCallCard (tool calls), plain user
// bubbles (TranscriptMessage styling).
//
// READ-ONLY. It owns no input box and no PTY connection. Interaction (the
// composer, the /model menu, choice buttons, raw-key controls) stays on the
// raw SessionTerminal surface — the pane toggles between this clean view and
// that raw surface (ChatGridPane). This component cannot break any interactive
// feature because it never touches the PTY.
//
// Live new turns: SWR polls the transcript endpoint on a short interval
// (paused when the tab is hidden). Turns are coarse-grained (one per
// user/assistant/tool message), so polling is plenty responsive without a
// second SSE channel. Auto-scrolls to the newest turn when near the bottom.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import MarkdownBubble from './MarkdownBubble';
import ToolCallCard from './ToolCallCard';
import { PLUMBING_PATTERNS, isPlumbingText } from '@/lib/plumbing';
import ToolRunGroup from './ToolRunGroup';
import AskUserQuestionCard from './AskUserQuestionCard';
import { Icon } from '@/components/ds/Icon';
import { ArrowDown, CircleNotch, Check, Checks } from '@phosphor-icons/react/dist/ssr';

/** Structured AskUserQuestion payload (feat/cockpit-askuserquestion). The
 *  bridge transcript attaches this to the tool turn so the cockpit can render a
 *  real, answerable question card instead of a raw JSON tool blob. */
export interface AskOption {
  label: string;
  description: string;
}
export interface AskQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
}
export interface AskPayload {
  questions: AskQuestion[];
}

export interface TranscriptTurn {
  kind: 'user' | 'assistant' | 'tool_use';
  ts: string | null;
  id: string;
  text?: string;
  tool?: {
    name: string;
    input_summary: string;
    /** Present only for AskUserQuestion turns — the structured questions. */
    ask?: AskPayload;
    /** The chosen answer once a tool_result has landed; null/undefined while
     *  the question is still awaiting JD's answer (→ live card). */
    answer?: string | null;
  };
}

/** True if a turn is a renderable AskUserQuestion (has a structured ask with at
 *  least one question). These render as a dedicated question CARD, never folded
 *  into a tool_run group. */
export function isAskTurn(turn: TranscriptTurn): boolean {
  return (
    turn.kind === 'tool_use' &&
    turn.tool?.name === 'AskUserQuestion' &&
    !!turn.tool.ask &&
    Array.isArray(turn.tool.ask.questions) &&
    turn.tool.ask.questions.length > 0
  );
}

// ── Plumbing filter (cockpit-batch-a FIX 3) ───────────────────────────────────
// Claude Code's session JSONL records internal system/command bookkeeping as
// ordinary user/assistant turns: task-notification blocks, local-command
// caveats, the /compact command + its <local-command-stdout> compaction dump,
// and "No response requested." sentinels. These are NOT conversation — they're
// plumbing the bridge transcript parser passes through verbatim. JD should only
// see real turns, so we drop any turn whose text is ONLY one of these markers.
//
// We are deliberately CONSERVATIVE: a turn is dropped only when its (trimmed)
// text is dominated by a known wrapper/marker, never when a real message merely
// MENTIONS one. We never touch tool_use turns (those are real tool cards) and
// never drop a turn that also carries substantive prose alongside the marker.
//
// The marker set lives in @/lib/plumbing (single source of truth, shared with
// MarkdownBubble's inline stripPlumbing). Re-exported here for back-compat with
// callers/tests that import it from this module.
export { PLUMBING_PATTERNS };

/** True if a turn is internal plumbing noise that must be hidden from the clean
 *  transcript (cockpit-batch-a FIX 3). Detects by the wrapping tags / known
 *  sentinels. Pure + exported for unit tests. tool_use turns are NEVER dropped
 *  (they render as real tool cards); only user/assistant text turns qualify. */
export function isPlumbingTurn(turn: TranscriptTurn): boolean {
  if (turn.kind === 'tool_use') return false;
  return isPlumbingText(turn.text);
}

/** Drop internal plumbing turns, keeping every real user/assistant/tool turn.
 *  Applied before grouping so a hidden turn never starts/breaks a tool run. */
export function filterPlumbing(turns: TranscriptTurn[]): TranscriptTurn[] {
  return turns.filter((t) => !isPlumbingTurn(t));
}

/** A rendered block: either a single non-tool turn, or a RUN of consecutive
 *  tool_use turns grouped together so a burst of tool calls doesn't bury the
 *  agent's actual text (cockpit-toolcards). */
export type TranscriptBlock =
  | { kind: 'turn'; turn: TranscriptTurn; index: number }
  | { kind: 'tool_run'; tools: TranscriptTurn[]; index: number };

/**
 * Fold a flat turn list into render blocks. Consecutive `tool_use` turns
 * collapse into one `tool_run` block; every other turn is its own `turn`
 * block. Pure — unit-tested in CleanTranscript.test.tsx.
 */
export function groupTurns(turns: TranscriptTurn[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let run: TranscriptTurn[] = [];
  let runStart = 0;
  const flush = () => {
    if (run.length > 0) {
      blocks.push({ kind: 'tool_run', tools: run, index: runStart });
      run = [];
    }
  };
  turns.forEach((turn, i) => {
    // AskUserQuestion is a QUESTION, not a background tool call — it must never
    // be buried inside a "5 commands" collapse. Break the run and give it its
    // own block so it renders as a dedicated, answerable question card.
    if (turn.kind === 'tool_use' && turn.tool && !isAskTurn(turn)) {
      if (run.length === 0) runStart = i;
      run.push(turn);
    } else {
      flush();
      blocks.push({ kind: 'turn', turn, index: i });
    }
  });
  flush();
  return blocks;
}

/** Optimistic-echo lifecycle (cockpit-chat-ux #1, +CAT-14 'queued').
 *  'queued'  — typed while a send was in flight; waiting its FIFO turn. Visible
 *              (dimmed, "queued") so it can never be silently lost on a clear.
 *  'sending' — the /input POST is in flight.
 *  'sent'    — 2xx /input (verified-submit) — Telegram's single ✓ delivered.
 *  'failed'  — the send failed OR the queue was cleared; offers Retry. */
export type EchoState = 'queued' | 'sending' | 'sent' | 'failed';

/** Optimistic echo bubble (cockpit-chat-ux #1). Held by ChatGridPane, rendered
 *  here below the real turns until the matching user turn lands in the poll. */
export interface PendingEcho {
  id: number;
  text: string;
  state: EchoState;
  ts: number;
}

/** Normalize for echo↔real-turn reconciliation: collapse whitespace, trim,
 *  drop the leading @disk-path / 📎 attachment lines so an echo with file
 *  labels still matches the agent's recorded user turn body. */
function normForMatch(s: string): string {
  return s
    .split('\n')
    .filter((line) => !/^\s*(?:@\S+|📎\s)/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

interface TranscriptResponse {
  sid: string;
  cc_session_id: string | null;
  exists: boolean;
  count: number;
  turns: TranscriptTurn[];
}

interface Props {
  sessionId: string;
  /** Poll interval in ms for new turns. Default 4000. 0 disables polling. */
  pollMs?: number;
  /** Changes to this value force an immediate re-fetch — the parent bumps it
   *  right after a send so JD's bubble + the reply appear without waiting the
   *  full poll interval. */
  refetchKey?: number;
  /** Optimistic echo bubbles (cockpit-chat-ux #1). Rendered after the real
   *  turns; reconciled away when a matching user turn appears in the poll. */
  echoes?: PendingEcho[];
  /** Called with an echo id once its text matches a real user turn — the
   *  parent drops it so we don't show the message twice. */
  onEchoReconciled?: (id: number) => void;
  /** Retry a failed echo — re-posts the same text. */
  onRetryEcho?: (id: number, text: string) => void;
  /** Live bridge status (from ChatGrid's shared poll) — drives whether an
   *  AskUserQuestion card is LIVE (answerable) vs read-only. A 'live'/'starting'
   *  session with an unanswered ask as the last turn = parked on the prompt. */
  liveStatus?: string;
  /** Bridge per-session activity. Retained for call-site compatibility but NO
   *  longer gates the live-ask card — while parked on an AskUserQuestion the
   *  bridge reports 'working', which used to wrongly disable the option buttons
   *  (cockpit-ask-working-gate fix). The structural gate handles liveness. */
  liveActivity?: string | null;
  /** CAT-04: the pane resolved to a DEAD session (not live/starting). When the
   *  transcript fetch then 404s, render a "session ended" empty-state with a
   *  Resume action instead of the transient "switch to raw" message (raw is
   *  ALSO empty on a dead sid, so that was a dead-end). */
  isDead?: boolean;
  /** CAT-04: user clicked "Resume / open raw" on the dead empty-state. The
   *  parent flips to the raw SessionTerminal which owns the resume sid-swap. */
  onResume?: () => void;
}

const fetcher = async (url: string): Promise<TranscriptResponse> => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`transcript ${res.status}`);
  }
  return res.json();
};

function formatTime(ts: string | null): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function CleanTranscript({
  sessionId,
  pollMs = 4000,
  refetchKey = 0,
  echoes = [],
  onEchoReconciled,
  onRetryEcho,
  liveStatus,
  isDead = false,
  onResume,
}: Props) {
  const { data, error, isLoading, mutate } = useSWR<TranscriptResponse>(
    sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/transcript` : null,
    fetcher,
    {
      refreshInterval: pollMs,
      revalidateOnFocus: true,
      // Hold the last-good transcript through a transient bridge flap so the
      // clean view doesn't blank out mid-conversation.
      keepPreviousData: true,
    }
  );

  // Force a re-fetch when the parent bumps refetchKey (right after a send).
  // A brief delay lets the agent's reply start landing in the JSONL.
  useEffect(() => {
    if (refetchKey <= 0) return;
    void mutate();
    const t = setTimeout(() => void mutate(), 1200);
    return () => clearTimeout(t);
  }, [refetchKey, mutate]);

  // Drop internal plumbing (task-notification / command-caveat / /compact
  // stdout / "No response requested.") BEFORE anything downstream — grouping,
  // live-Ask detection, echo reconciliation, auto-scroll counting — so JD only
  // ever sees real conversation (cockpit-batch-a FIX 3).
  const turns = useMemo(() => filterPlumbing(data?.turns ?? []), [data]);
  // Fold consecutive tool calls into runs for compact, ungrouped rendering.
  const blocks = useMemo(() => groupTurns(turns), [turns]);

  // ── Live AskUserQuestion (feat/cockpit-askuserquestion) ───────────────────
  // A question is LIVE (answerable) when: it has no recorded answer, it is the
  // LAST turn of the transcript, AND the bridge says the session is live. The
  // "last turn + no answer" pair IS the airtight parked-on-prompt signal: an
  // AskUserQuestion tool call cannot return until JD answers, so the agent
  // physically cannot have emitted a later turn while it's pending. If a later
  // turn exists, it already moved on (answered elsewhere / defaulted) → read-
  // only. We answer ONLY the single newest unanswered question.
  //
  // We deliberately do NOT gate on bridge `activity` here. While Claude Code is
  // parked on an AskUserQuestion prompt the bridge reports activity='working'
  // (the menu render / spinner churns the PTY), so the old `act === 'working'`
  // exclusion wrongly flipped the live card to read-only "defaulted" and JD
  // couldn't select an option — while the raw view (which ignores activity and
  // detects the menu straight off the xterm buffer) worked fine. The structural
  // gate above mirrors raw and is sufficient. (cockpit-ask-working-gate fix)
  const liveAskId = useMemo<string | null>(() => {
    const last = turns[turns.length - 1];
    if (!last || !isAskTurn(last)) return null;
    if (last.tool?.answer) return null;
    const live = liveStatus === 'live' || liveStatus === 'starting';
    if (!live) return null;
    return last.id;
  }, [turns, liveStatus]);

  // ── Echo reconciliation (cockpit-chat-ux #1 + CAT-17 1:1 pairing) ──────────
  // When a real user turn whose normalized text matches a pending echo lands in
  // the poll, drop that echo (so JD's message isn't shown twice) and mark THAT
  // turn ✓✓ Read.
  //
  // CAT-17 (2026-06-12) — the old reconcile matched on a `Set` of norms with NO
  // consumed-marking, and a `norm → LAST turn id` map. Both broke duplicate-
  // text sends: send "ok" twice and both echoes saw `set.has('ok')===true` the
  // instant ONE real turn landed → BOTH echoes reconciled against the single
  // turn (a bubble silently dropped before its own turn persisted); and the
  // receipt always stamped the NEWEST twin, mis-attributing Read. The fix pairs
  // echoes to real turns 1:1 by CONSUMING matched turn ids, oldest-echo-first
  // against oldest-unconsumed-turn-first, so N echoes need N real turns and the
  // ✓✓ lands on the turn that actually paired.
  const realUserTurns = useMemo(
    () =>
      turns
        .filter((t): t is TranscriptTurn & { id: string } =>
          t.kind === 'user' && !!t.id
        )
        .map((t) => ({ id: t.id, norm: normForMatch(t.text ?? '') })),
    [turns]
  );

  // ── Telegram-style READ receipts (feat/read-receipts, JD 2026-06-11) ───────
  // "When a message gets sent can we have it say read when the agent sees it
  // like telegram." The reconcile moment IS the read event: the user turn now
  // exists in the agent's own session JSONL — the agent has provably consumed
  // the message. We remember WHICH real turn reconciled an echo (by turn id)
  // and render a ✓✓ "Read" line under that user bubble. Session-local by design
  // (a reload shows no receipts on history — same as a fresh Telegram login).
  const [readTurnIds, setReadTurnIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (echoes.length === 0 || !onEchoReconciled) return;
    // Pair 1:1 (CAT-17). Walk echoes oldest-first (echoes arrive in id order);
    // for each, consume the FIRST unconsumed real user turn with a matching
    // norm. A 'queued' echo has not been sent yet (no JSONL turn can exist for
    // it) and 'failed' echoes are kept for Retry — neither reconciles.
    const consumed = new Set<number>(); // indices into realUserTurns
    const nowRead: string[] = [];
    const ordered = [...echoes].sort((a, b) => a.id - b.id);
    for (const e of ordered) {
      if (e.state === 'failed' || e.state === 'queued') continue;
      const n = normForMatch(e.text);
      if (!n) continue;
      const idx = realUserTurns.findIndex(
        (t, i) => !consumed.has(i) && t.norm === n
      );
      if (idx === -1) continue; // no unconsumed twin yet — keep the echo
      consumed.add(idx);
      nowRead.push(realUserTurns[idx].id);
      onEchoReconciled(e.id);
    }
    if (nowRead.length) {
      setReadTurnIds((old) => {
        const merged = new Set(old);
        for (const id of nowRead) merged.add(id);
        return merged;
      });
    }
  }, [realUserTurns, echoes, onEchoReconciled]);

  // Pane reused for a DIFFERENT session (sid-swap) → receipts don't carry
  // over. Ref-guarded to actual changes only: a bare [sessionId] effect also
  // fires on mount AFTER the reconcile effect above, wiping a receipt recorded
  // in the same first pass (caught by the unit test).
  const receiptSidRef = useRef(sessionId);
  useEffect(() => {
    if (receiptSidRef.current === sessionId) return;
    receiptSidRef.current = sessionId;
    setReadTurnIds(new Set());
  }, [sessionId]);

  // ── Auto-scroll (cockpit-chat-ux #3) ───────────────────────────────────────
  // Requirements: scroll to newest (a) when the chat first opens/mounts, and
  // (b) when new turns/echoes arrive — UNLESS the user has scrolled up to read
  // history, in which case show a "Jump to latest" affordance instead of
  // yanking them down.
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCountRef = useRef(0);
  const didInitialScrollRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    // scrollTo isn't implemented in jsdom; fall back to scrollTop so tests
    // (and any browser without smooth-scroll) don't throw.
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    setShowJump(false);
  }, []);

  // Total "rows" that can grow the transcript: real turns + pending echoes.
  const liveCount = turns.length + echoes.length;

  // (a) Initial scroll on first content paint — fires once the first non-empty
  //     transcript (or an echo) lands. Pin to bottom with no animation so the
  //     chat opens already showing the newest message (JD shouldn't scroll).
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (liveCount === 0) return;
    didInitialScrollRef.current = true;
    lastCountRef.current = liveCount;
    // Defer one frame so the bubbles are laid out before we measure height.
    requestAnimationFrame(() => scrollToBottom('auto'));
  }, [liveCount, scrollToBottom]);

  // (b) Subsequent growth — stick to bottom if already near it; else surface
  //     the jump affordance so JD knows new output arrived while reading up.
  useEffect(() => {
    if (!didInitialScrollRef.current) return;
    const grew = liveCount > lastCountRef.current;
    lastCountRef.current = liveCount;
    if (!grew) return;
    if (isNearBottom()) {
      requestAnimationFrame(() => scrollToBottom('auto'));
    } else {
      setShowJump(true);
    }
  }, [liveCount, isNearBottom, scrollToBottom]);

  // Reset the initial-scroll latch when the session changes (pane reused /
  // sid-swap) so the new conversation also opens pinned to the bottom.
  useEffect(() => {
    didInitialScrollRef.current = false;
    lastCountRef.current = 0;
    setShowJump(false);
  }, [sessionId]);

  // Hide the jump pill the moment the user scrolls back to the bottom on
  // their own.
  const onScroll = useCallback(() => {
    if (isNearBottom()) setShowJump(false);
  }, [isNearBottom]);

  return (
    <div className="relative h-full min-h-0">
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="clean-transcript"
      // `momentum-scroll` (chat-session mobile pass, 2026-06-10): iOS momentum
      // (-webkit-overflow-scrolling: touch) + overscroll-behavior: contain so a
      // flick scrolls the transcript with inertia and never rubber-bands the
      // page underneath. Inert on desktop (those properties are no-ops there).
      className="momentum-scroll h-full overflow-y-auto px-3 py-3 space-y-2.5 bg-canvas"
    >
      {isLoading && !data && (
        <div className="text-xs text-3 mono px-1">
          loading conversation…
        </div>
      )}

      {/* CAT-04: a dead session whose transcript 404s gets an honest "ended"
          empty-state with a recovery affordance — NOT the "switch to raw"
          dead-end (raw is also empty on a dead sid). `isDead` (the resolved
          pane status) gates this so a transient bridge flap on a LIVE session
          still shows the soft "couldn't load" message below, not a false
          "ended" card. We show it whenever the pane is dead and we have no
          renderable turns (404 → no data, or an empty last-good cache). */}
      {isDead && turns.length === 0 && echoes.length === 0 && (
        <div className="flex flex-col items-start gap-2 px-1 py-2">
          <div className="text-xs text-2 mono">
            This session has ended — there’s no agent on the other end.
          </div>
          {onResume && (
            <button
              type="button"
              data-testid="clean-transcript-resume"
              onClick={onResume}
              className="press focus-accent rounded-md bg-surface-3 hover:bg-surface-4 border border-hairline px-3 py-1 text-xs text-1"
            >
              Resume or start a new chat
            </button>
          )}
        </div>
      )}

      {error && !data && !isDead && (
        // Critic r1 FIX #2 — a transient load failure is NOT a destructive
        // action; render it in the muted clay danger token, never the saturated
        // status red that would compete with the brand amber on screen.
        <div className="text-xs text-state-danger-muted mono px-1">
          couldn’t load the clean transcript — switch to the raw terminal to
          read this session.
        </div>
      )}

      {data && data.exists && turns.length === 0 && echoes.length === 0 && (
        <div className="text-xs text-3 mono px-1">
          No conversation yet. Send a message to get started.
        </div>
      )}

      {data && !data.exists && echoes.length === 0 && !isDead && (
        <div className="text-xs text-3 mono px-1">
          No structured transcript for this session — switch to the raw
          terminal to view it.
        </div>
      )}

      {/* Group consecutive tool calls into a collapsible run so a burst of
          them doesn't bury the agent's actual text (cockpit-toolcards). */}
      {blocks.map((block) => {
        if (block.kind === 'tool_run') {
          return (
            <div key={`run-${block.index}`} className="flex justify-start">
              <div className="max-w-[85%] w-full">
                <ToolRunGroup tools={block.tools} />
              </div>
            </div>
          );
        }
        const turn = block.turn;
        const key = `${turn.id || 'turn'}-${block.index}`;
        // AskUserQuestion → dedicated answerable question card (not a bubble).
        if (isAskTurn(turn) && turn.tool?.ask) {
          return (
            <div key={key} className="flex justify-start">
              <div className="max-w-[90%] w-full">
                <AskUserQuestionCard
                  sessionId={sessionId}
                  ask={turn.tool.ask}
                  answer={turn.tool.answer}
                  isLive={turn.id === liveAskId}
                />
              </div>
            </div>
          );
        }
        if (turn.kind === 'user') {
          const isRead = !!turn.id && readTurnIds.has(turn.id);
          return (
            <div key={key} className="flex flex-col items-end">
              {/* JD's turn: a warm RAISED surface (surface-4, the top of the
                  luminance ladder) — distinct from the agent's recessed bubble
                  without a jarring pure-white default. Asymmetric corner marks
                  authorship; no card-in-card, no one-side colored border. */}
              <div className="max-w-[80%] rounded-lg rounded-br-sm bg-surface-4 text-1 px-4 py-2 text-sm whitespace-pre-wrap break-words">
                {turn.text}
              </div>
              {/* feat/read-receipts: ✓✓ Read — this turn reconciled an
                  optimistic echo this session, so the agent's session JSONL
                  provably contains the message. Mirrors the echo footer's
                  10px mono style so nothing jumps at the echo→real swap. */}
              {isRead && (
                <div
                  data-testid="receipt-read"
                  className="mt-1 inline-flex items-center gap-1 text-[10px] leading-none mono text-state-ready"
                >
                  <Checks size={12} weight="bold" aria-hidden /> Read
                </div>
              )}
            </div>
          );
        }
        // assistant text (lone tool_use turns are handled by the tool_run path)
        return (
          <div key={key} className="flex justify-start">
            <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-surface-2 border border-hairline px-4 py-2 text-sm text-1 break-words">
              <MarkdownBubble content={turn.text ?? ''} />
              {formatTime(turn.ts) && (
                <div className="mt-2 text-[11px] text-3 mono tabular">
                  {formatTime(turn.ts)}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Optimistic echoes (cockpit-chat-ux #1) — JD's just-sent messages,
          shown instantly. A "sending" echo is dimmed with a spinning glyph; a
          "failed" echo takes the error tint with a Retry. Reconciled (removed)
          once the matching real user turn lands in the poll. */}
      {echoes.map((e) => (
        <div key={`echo-${e.id}`} className="flex justify-end">
          <div
            data-testid={`echo-bubble-${e.state}`}
            className={`max-w-[80%] rounded-lg rounded-br-sm px-4 py-2 text-sm whitespace-pre-wrap break-words ${
              e.state === 'failed'
                ? 'bg-tint-error border border-state-error/40 text-1'
                : 'bg-surface-4 text-1 opacity-70'
            }`}
          >
            {e.text}
            <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] leading-none mono">
              {e.state === 'queued' && (
                // CAT-14: a queued message is VISIBLE while it waits its FIFO
                // turn behind an in-flight send — so a "clear" tap can never
                // silently lose it.
                <span className="inline-flex items-center gap-1 text-3">
                  <CircleNotch size={11} className="animate-spin" aria-hidden /> queued…
                </span>
              )}
              {e.state === 'sending' && (
                <span className="inline-flex items-center gap-1 text-3">
                  <CircleNotch size={11} className="animate-spin" aria-hidden /> sending…
                </span>
              )}
              {e.state === 'sent' && (
                // feat/read-receipts: single ✓ = DELIVERED (the bridge accepted
                // + verified-submitted the message into the agent's composer).
                // The ✓✓ Read mark appears on the persisted bubble once the
                // turn lands in the agent's JSONL (reconcile above).
                <span
                  className="inline-flex items-center gap-1 text-3"
                  data-testid="receipt-delivered"
                >
                  delivered <Check size={11} weight="bold" aria-hidden />
                </span>
              )}
              {e.state === 'failed' && (
                <>
                  <span className="text-state-error">failed</span>
                  {onRetryEcho && (
                    <button
                      type="button"
                      data-testid={`echo-retry-${e.id}`}
                      onClick={() => onRetryEcho(e.id, e.text)}
                      className="press text-state-error underline hover:text-1"
                    >
                      retry
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Scroll sentinel — auto-scroll targets the bottom of this container. */}
      <div ref={bottomRef} />
    </div>

    {/* Jump-to-latest affordance (cockpit-chat-ux #3) — only while the user
        has scrolled UP and new output has arrived. Clicking smooth-scrolls
        to the newest turn. Respects "don't yank them down" — it's opt-in. */}
    {showJump && (
      <button
        type="button"
        data-testid="jump-to-latest"
        onClick={() => scrollToBottom('smooth')}
        style={{ boxShadow: 'var(--shadow-popover)' }}
        className="press focus-accent absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 rounded-pill bg-surface-3 hover:bg-surface-4 text-1 text-xs weight-label px-3 py-1.5 border border-border-default transition-colors"
      >
        <Icon glyph={ArrowDown} size={13} weight="bold" aria-hidden /> Jump to latest
      </button>
    )}
    </div>
  );
}
