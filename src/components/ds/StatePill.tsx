// ═══════════════════════════════════════════════════════════════════════════
// StatePill — the Warm Graphite muted status pill (replaces NeonBadge).
//
// The single page-level primitive for "this thing is live / ready / needs
// attention / errored / idle". It is the muted counterpart to the old neon
// badge: a ~14%-alpha state TINT fill behind muted state-color TEXT on a 1px
// hairline border, radius-sm, mono + tabular-nums so any embedded count reads
// as crafted telemetry. NEVER a neon glow, NEVER a saturated chip.
//
// The vocabulary mirrors the canonical /chat surface (ChatGridPane + the
// CapacityPill): each tone resolves to a (bg-tint-*, text-state-*) pair wired
// in globals.css. `idle`/`neutral` is a quiet surface tile in tertiary text so
// it never competes for attention. ZERO new tokens — every class already
// exists in the @theme layer.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Semantic state tone — maps to a (tint, state-text) token pair. */
export type StateTone =
  | 'working'   // live / streaming / in-flight — muted instrument grey-cyan
  | 'ready'     // ready / done / converted / complete — muted green
  | 'attention' // needs attention / warning / pending — amber-orange (≠ brand)
  | 'error'     // blocked / failed / churned — muted red
  | 'idle'      // dormant / unknown / neutral — grey, NO color
  | 'accent';   // the ONE rationed brand-amber tint (use at most once / screen)

const TONE_CLS: Record<StateTone, string> = {
  working:   'border-border-default bg-tint-working text-state-working',
  ready:     'border-border-default bg-tint-ready text-state-ready',
  attention: 'border-border-default bg-tint-attention text-state-attention',
  error:     'border-border-default bg-tint-error text-state-error',
  idle:      'border-hairline bg-surface-2 text-3',
  accent:    'border-accent-border bg-accent-subtle text-accent-text',
};

export interface StatePillProps {
  tone?: StateTone;
  children: ReactNode;
  /** Optional leading dot (live indicator). Breathes only on `working`. */
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}

const SIZE_CLS: Record<'sm' | 'md', string> = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-2.5 py-0.5 text-[11px]',
};

export function StatePill({
  tone = 'idle',
  children,
  dot = false,
  size = 'md',
  className,
  title,
}: StatePillProps) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border font-mono tabular leading-none whitespace-nowrap weight-label',
        SIZE_CLS[size],
        TONE_CLS[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 rounded-full bg-current',
            tone === 'working' && 'live-breathe',
          )}
        />
      )}
      {children}
    </span>
  );
}

export default StatePill;
