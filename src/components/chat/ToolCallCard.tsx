'use client';

// ═══════════════════════════════════════════════════════════════════════════
// ToolCallCard — COMPACT, command-inline row for a single tool invocation.
//
// (cockpit-toolcards, 2026-06) JD: "the label `Bash` is the least useful part;
// the COMMAND is the useful part, and it was hidden behind a fat collapsed box."
// So each tool call is now ONE dense row:
//
//     ✓ Bash · git push origin main
//     ✓ Read · src/lib/auth.ts
//     ✓ Edit · Composer.tsx
//
// The salient argument (command first-line / file path / query) is shown INLINE,
// truncated with an ellipsis. A small status affordance (✓ done / pulsing dot
// running / ✕ error) leads the row. Clicking the row still expands the full
// input/output — the detail isn't lost, just folded by default.
//
// Bursts of consecutive tool calls are GROUPED upstream in CleanTranscript into
// a collapsible run so they don't bury the agent's actual text.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { cn } from '@/lib/utils';

export type ToolCallStatus = 'running' | 'done' | 'error';

export interface ToolCallCardProps {
  name: string;
  /** Tool input — raw object or the bridge's pre-summarized string. */
  input: unknown;
  /** Tool output. When present, rendered in the expanded detail. */
  output?: unknown;
  status: ToolCallStatus;
  className?: string;
}

// Salient field per common tool, in priority order — mirrors the bridge's
// _summarize_tool_input so the inline summary is meaningful even when we're
// handed a raw input object (e.g. from a non-bridge caller).
const SALIENT_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
] as const;

export function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Extract the one-line inline summary for a tool input.
 *  - string  → first non-empty line, whitespace-collapsed (the bridge already
 *              hands us a collapsed summary string; this also handles a raw
 *              multi-line command).
 *  - object  → the first present salient key's value (command/file_path/…),
 *              else a compact JSON blob.
 * Truncated to `max` chars with an ellipsis. Pure — unit-tested.
 */
export function toolInlineSummary(input: unknown, max = 96): string {
  let val: string;
  if (typeof input === 'string') {
    val = input;
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    let picked: string | undefined;
    for (const k of SALIENT_KEYS) {
      if (typeof obj[k] === 'string' && (obj[k] as string).length > 0) {
        picked = obj[k] as string;
        break;
      }
    }
    val = picked ?? safeStringify(obj);
  } else {
    val = input == null ? '' : String(input);
  }
  // First non-empty line, then collapse internal whitespace.
  const firstLine =
    val
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length > max) return collapsed.slice(0, max - 1) + '…';
  return collapsed;
}

function StatusGlyph({ status }: { status: ToolCallStatus }) {
  if (status === 'running') {
    return (
      <span
        aria-label="running"
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400 animate-pulse"
      />
    );
  }
  if (status === 'error') {
    return (
      <span aria-label="error" className="shrink-0 text-red-400">
        ✕
      </span>
    );
  }
  return (
    <span aria-label="done" className="shrink-0 text-emerald-400">
      ✓
    </span>
  );
}

export default function ToolCallCard({
  name,
  input,
  output,
  status,
  className,
}: ToolCallCardProps) {
  // Errors auto-expand so the failure is readable without a click.
  const [open, setOpen] = useState(status === 'error');
  const summary = toolInlineSummary(input);

  return (
    <div
      data-testid="tool-card"
      data-tool-name={name}
      data-status={status}
      className={cn(
        'rounded-md border bg-neutral-900/50',
        status === 'error' ? 'border-red-500/40' : 'border-neutral-800',
        className
      )}
    >
      {/* Dense one-row header — click to expand the full input/output. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1 text-left',
          'font-mono text-[11px] leading-tight',
          'hover:bg-neutral-800/40 transition-colors',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-600'
        )}
      >
        <StatusGlyph status={status} />
        <span className="shrink-0 text-neutral-400">{name}</span>
        <span aria-hidden className="shrink-0 text-neutral-600">
          ·
        </span>
        <span className="min-w-0 flex-1 truncate text-neutral-200">
          {summary || <span className="text-neutral-500">(no args)</span>}
        </span>
        <span
          aria-hidden
          className={cn(
            'shrink-0 text-neutral-600 transition-transform duration-150',
            open ? 'rotate-90' : 'rotate-0'
          )}
        >
          ▸
        </span>
      </button>

      {open && (
        <div className="border-t border-neutral-800 bg-neutral-950/40">
          <div className="px-2.5 py-1.5">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
              input
            </div>
            <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-300">
              {safeStringify(input)}
            </pre>
          </div>
          {output !== undefined && (
            <div className="border-t border-neutral-800 px-2.5 py-1.5">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                output
              </div>
              <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-300">
                {safeStringify(output)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
