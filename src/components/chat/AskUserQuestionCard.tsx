'use client';

// ═══════════════════════════════════════════════════════════════════════════
// AskUserQuestionCard — a real, ANSWERABLE question in the clean transcript.
//
// feat/cockpit-askuserquestion (2026-06-02, JD-reported bug). When an agent
// calls the AskUserQuestion tool it is ASKING JD a question with selectable
// options. The clean transcript used to render that tool call as a raw JSON
// ToolCallCard marked "✓ done" — so JD couldn't tell it was waiting on him, and
// typing an answer into the composer did NOT reach the live prompt (the agent
// timed out to its DEFAULT). This card fixes both halves:
//
//   (a) RENDER — header + question in plain text; each option as a TAPPABLE
//       button (single-select) or a checkbox + Submit (multiSelect); plus an
//       "Other / type your own" affordance (AskUserQuestion permits custom
//       text). No JSON.
//
//   (b) ANSWER-ROUTING — the critical half. Tapping an option delivers that
//       answer to the LIVE prompt in the PTY so it is SELECTED, never defaulted.
//       It reuses the EXACT proven path the /model choice buttons use:
//         • single-select  → POST /api/sessions/<sid>/key { bytes:"<n>" } then
//           { key:"enter" } — the digit jump + confirm. Routes by ABSOLUTE
//           option number, so it does NOT depend on reading the live cursor
//           (which the clean view can't see — that's xterm-only). This is why
//           the digit strategy (keystrokesForOption) is the robust choice here.
//         • multiSelect    → for each checked option: digit-jump + space-toggle;
//           then a final Enter to confirm.
//         • custom text    → POST /api/sessions/<sid>/input { text:"<typed>\r" }
//           (verified-submit) — AskUserQuestion accepts a free-text answer.
//
// STATE: a question whose answer hasn't landed yet AND that is the LATEST live
// turn renders as 🟡 "Needs your answer" with active controls. Once answered (a
// tool_result stamped the chosen answer) — or no longer live — it renders
// read-only: "Asked: <question> → <answer | defaulted>". Clean, never JSON.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { AskPayload, AskQuestion } from './CleanTranscript';

export interface AskUserQuestionCardProps {
  sessionId: string;
  ask: AskPayload;
  /** Chosen answer once a tool_result has landed (read-only state). */
  answer?: string | null;
  /** True when this question is the LIVE pending one — the agent is waiting on
   *  JD's answer right now (answer not yet landed AND it's the latest tool turn
   *  AND the session is live/waiting). Only then are the controls active. */
  isLive: boolean;
}

/** Build the key sequence for a single-select option (1-based number → digit +
 *  Enter). Mirrors keystrokesForOption's digit strategy. Exported for tests. */
export function singleSelectKeys(
  optionNumber: number
): Array<{ key?: string; bytes?: string }> {
  if (optionNumber >= 1 && optionNumber <= 9) {
    return [{ bytes: String(optionNumber) }, { key: 'enter' }];
  }
  // >9 options: arrow down from the top (selectedIndex 0) to the target, Enter.
  const steps: Array<{ key?: string; bytes?: string }> = [];
  for (let n = 1; n < optionNumber; n++) steps.push({ key: 'down' });
  steps.push({ key: 'enter' });
  return steps;
}

/** Build the key sequence for a multiSelect answer: jump to each checked
 *  option's row (digit) + toggle it (space), then a final Enter to confirm.
 *  `checkedNumbers` are 1-based option numbers, ascending. Exported for tests. */
export function multiSelectKeys(
  checkedNumbers: number[]
): Array<{ key?: string; bytes?: string }> {
  const steps: Array<{ key?: string; bytes?: string }> = [];
  for (const n of checkedNumbers) {
    if (n >= 1 && n <= 9) steps.push({ bytes: String(n) });
    steps.push({ key: 'space' });
  }
  steps.push({ key: 'enter' });
  return steps;
}

async function postKey(
  sessionId: string,
  payloads: Array<{ key?: string; bytes?: string }>
): Promise<void> {
  for (const p of payloads) {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`key ${res.status}: ${txt.slice(0, 160)}`);
    }
    // Gap so a digit-then-Enter (or space sequence) isn't coalesced into one
    // PTY read — the menu must register each keystroke in order.
    if (payloads.length > 1) await new Promise((r) => setTimeout(r, 80));
  }
}

async function postCustomText(sessionId: string, text: string): Promise<void> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/input`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Trailing '\r' = verified submit (same as the composer's send path).
      body: JSON.stringify({ text: text + '\r' }),
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`input ${res.status}: ${txt.slice(0, 160)}`);
  }
}

function SingleSelect({
  sessionId,
  q,
  disabled,
  onSending,
}: {
  sessionId: string;
  q: AskQuestion;
  disabled: boolean;
  onSending: (busy: boolean) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const pick = async (label: string, optionNumber: number) => {
    if (disabled) return;
    setErr(null);
    setChosen(label);
    onSending(true);
    try {
      await postKey(sessionId, singleSelectKeys(optionNumber));
    } catch (e) {
      setErr(String(e));
      setChosen(null);
    } finally {
      onSending(false);
    }
  };

  const submitCustom = async () => {
    const t = custom.trim();
    if (!t || disabled) return;
    setErr(null);
    setChosen(t);
    onSending(true);
    try {
      await postCustomText(sessionId, t);
    } catch (e) {
      setErr(String(e));
      setChosen(null);
    } finally {
      onSending(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5" data-testid="ask-options-single">
        {q.options.map((o, i) => (
          <button
            key={`${o.label}-${i}`}
            type="button"
            data-testid={`ask-option-${i + 1}`}
            disabled={disabled}
            onClick={() => void pick(o.label, i + 1)}
            title={o.description || o.label}
            className={cn(
              'inline-flex items-center gap-1.5 max-w-full px-2.5 py-1.5 rounded-md text-[12px] border transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              chosen === o.label
                ? 'border-cyan-500/60 text-cyan-200 bg-cyan-500/10'
                : 'border-neutral-700 text-neutral-100 bg-neutral-900/60 hover:border-cyan-500/40 hover:text-cyan-200'
            )}
          >
            <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-sm bg-white/10 text-[10px] font-bold">
              {i + 1}
            </span>
            <span className="truncate">{o.label}</span>
          </button>
        ))}
      </div>
      {!showCustom ? (
        <button
          type="button"
          data-testid="ask-other-toggle"
          disabled={disabled}
          onClick={() => setShowCustom(true)}
          className="text-[11px] text-neutral-400 hover:text-cyan-300 underline disabled:opacity-40"
        >
          Other / type your own…
        </button>
      ) : (
        <div className="flex items-end gap-1.5" data-testid="ask-custom-row">
          <input
            type="text"
            value={custom}
            disabled={disabled}
            data-testid="ask-custom-input"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitCustom();
              }
            }}
            placeholder="Type your answer…"
            className="flex-1 min-w-0 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-100 focus:border-cyan-500/60 focus:outline-none"
          />
          <button
            type="button"
            data-testid="ask-custom-submit"
            disabled={disabled || !custom.trim()}
            onClick={() => void submitCustom()}
            className="shrink-0 rounded-md border border-cyan-600/60 bg-cyan-600/20 px-2.5 py-1 text-[12px] text-cyan-200 hover:bg-cyan-600/30 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      )}
      {err && <p className="text-[11px] text-red-400">{err}</p>}
    </div>
  );
}

function MultiSelect({
  sessionId,
  q,
  disabled,
  onSending,
}: {
  sessionId: string;
  q: AskQuestion;
  disabled: boolean;
  onSending: (busy: boolean) => void;
}) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const toggle = (n: number) => {
    if (disabled) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  const submit = async () => {
    if (disabled || checked.size === 0) return;
    setErr(null);
    setSubmitted(true);
    onSending(true);
    try {
      const nums = [...checked].sort((a, b) => a - b);
      await postKey(sessionId, multiSelectKeys(nums));
    } catch (e) {
      setErr(String(e));
      setSubmitted(false);
    } finally {
      onSending(false);
    }
  };

  return (
    <div className="space-y-1.5" data-testid="ask-options-multi">
      <div className="space-y-1">
        {q.options.map((o, i) => {
          const n = i + 1;
          const on = checked.has(n);
          return (
            <button
              key={`${o.label}-${i}`}
              type="button"
              data-testid={`ask-checkbox-${n}`}
              aria-pressed={on}
              disabled={disabled}
              onClick={() => toggle(n)}
              title={o.description || o.label}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] border text-left transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                on
                  ? 'border-cyan-500/60 text-cyan-200 bg-cyan-500/10'
                  : 'border-neutral-700 text-neutral-100 bg-neutral-900/60 hover:border-cyan-500/40'
              )}
            >
              <span
                className={cn(
                  'shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-sm border text-[10px] font-bold',
                  on
                    ? 'bg-cyan-500/30 border-cyan-400 text-cyan-100'
                    : 'border-neutral-600 text-transparent'
                )}
              >
                ✓
              </span>
              <span className="truncate">{o.label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="ask-multi-submit"
        disabled={disabled || checked.size === 0 || submitted}
        onClick={() => void submit()}
        className="rounded-md border border-cyan-600/60 bg-cyan-600/20 px-3 py-1 text-[12px] text-cyan-200 hover:bg-cyan-600/30 disabled:opacity-40"
      >
        Submit {checked.size > 0 ? `(${checked.size})` : ''}
      </button>
      {err && <p className="text-[11px] text-red-400">{err}</p>}
    </div>
  );
}

export default function AskUserQuestionCard({
  sessionId,
  ask,
  answer,
  isLive,
}: AskUserQuestionCardProps) {
  const [sending, setSending] = useState(false);
  const answered = typeof answer === 'string' && answer.length > 0;

  // ── ANSWERED / NO-LONGER-LIVE → read-only summary ────────────────────────
  // "Asked: <question> → <answer or 'defaulted'>". Clean, not JSON. A question
  // that's no longer the live turn but never got an answer reads "defaulted"
  // (the agent moved on with its default).
  if (answered || !isLive) {
    return (
      <div
        data-testid="ask-card"
        data-state={answered ? 'answered' : 'defaulted'}
        className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 space-y-1"
      >
        {ask.questions.map((q, qi) => (
          <div key={qi} className="text-[12px] leading-snug">
            <span className="text-neutral-500">Asked: </span>
            <span className="text-neutral-300">{q.question}</span>
            <span className="text-neutral-500"> → </span>
            <span
              data-testid="ask-answer"
              className={answered ? 'text-cyan-300' : 'text-amber-400/80'}
            >
              {answered ? answer : 'defaulted'}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // ── LIVE → needs-your-answer card with active controls ───────────────────
  return (
    <div
      data-testid="ask-card"
      data-state="needs-answer"
      className="rounded-lg border border-amber-500/40 bg-amber-500/[0.05] px-3 py-2.5 space-y-2.5"
    >
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        <span
          data-testid="ask-needs-answer"
          className="text-[11px] font-semibold uppercase tracking-wide text-amber-300"
        >
          Needs your answer
        </span>
        {sending && (
          <span className="text-[11px] text-neutral-400">· sending…</span>
        )}
      </div>
      {ask.questions.map((q, qi) => (
        <div key={qi} className="space-y-1.5">
          {q.header && (
            <div className="text-[11px] font-medium text-neutral-400">
              {q.header}
            </div>
          )}
          <div className="text-[13px] text-neutral-100 leading-snug">
            {q.question}
          </div>
          {q.multiSelect ? (
            <MultiSelect
              sessionId={sessionId}
              q={q}
              disabled={sending}
              onSending={setSending}
            />
          ) : (
            <SingleSelect
              sessionId={sessionId}
              q={q}
              disabled={sending}
              onSending={setSending}
            />
          )}
        </div>
      ))}
    </div>
  );
}
