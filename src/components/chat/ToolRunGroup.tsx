'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ToolRunGroup — a collapsible RUN of consecutive tool calls (cockpit-toolcards).
//
// A burst of tool calls used to render as a wall of identical fat boxes that
// buried the agent's actual reasoning/answers. JD: "the agent's words are the
// signal; tools are supporting detail." So:
//
//   • A run of ONE tool call renders the inline ToolCallCard directly (nothing
//     to collapse — and keeps single tool calls visible at a glance).
//   • A run of N≥2 collapses into one header row:  ✓ 8 commands ▸
//     Clicking it expands the full list of inline ToolCallCards. Each card still
//     expands individually for its full input/output.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { cn } from '@/lib/utils';
import ToolCallCard, { toolInlineSummary } from './ToolCallCard';
import type { TranscriptTurn } from './CleanTranscript';

export interface ToolRunGroupProps {
  tools: TranscriptTurn[];
  /** Start collapsed (true) by default for multi-tool runs. */
  defaultCollapsed?: boolean;
}

export default function ToolRunGroup({
  tools,
  defaultCollapsed = true,
}: ToolRunGroupProps) {
  const valid = tools.filter((t) => t.tool);

  // Hooks must run unconditionally — declare state before the early return.
  const [open, setOpen] = useState(!defaultCollapsed);

  if (valid.length === 0) return null;

  // Single tool call — no grouping, render the inline card directly.
  if (valid.length === 1) {
    const t = valid[0];
    return (
      <ToolCallCard
        name={t.tool!.name}
        input={t.tool!.input_summary}
        status="done"
      />
    );
  }

  // A one-line teaser of the first call so the collapsed header hints at content.
  const firstSummary = toolInlineSummary(valid[0].tool!.input_summary, 48);

  return (
    <div
      data-testid="tool-run-group"
      data-tool-count={valid.length}
      data-open={open ? 'true' : 'false'}
      className="rounded-md border border-neutral-800 bg-neutral-900/40"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="tool-run-toggle"
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1 text-left',
          'font-mono text-[11px] leading-tight text-neutral-300',
          'hover:bg-neutral-800/40 transition-colors',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-600'
        )}
      >
        <span className="shrink-0 text-emerald-400" aria-hidden>
          ✓
        </span>
        <span className="shrink-0 text-neutral-200">
          {valid.length} commands
        </span>
        {!open && firstSummary && (
          <>
            <span aria-hidden className="shrink-0 text-neutral-600">
              ·
            </span>
            <span className="min-w-0 flex-1 truncate text-neutral-500">
              {firstSummary}
            </span>
          </>
        )}
        <span
          aria-hidden
          className={cn(
            'ml-auto shrink-0 text-neutral-600 transition-transform duration-150',
            open ? 'rotate-90' : 'rotate-0'
          )}
        >
          ▸
        </span>
      </button>

      {open && (
        <div className="space-y-1 border-t border-neutral-800 p-1.5">
          {valid.map((t, i) => (
            <ToolCallCard
              key={`${t.id || 'tool'}-${i}`}
              name={t.tool!.name}
              input={t.tool!.input_summary}
              status="done"
            />
          ))}
        </div>
      )}
    </div>
  );
}
