'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

// ── Warm Graphite (v6) ───────────────────────────────────────────────────────
// Despite the legacy name, this is now a MUTED STATE PILL — the neon glow is
// gone. It renders colored text + an optional dot on a ~14%-alpha tint of the
// SAME muted state hue (never a saturated full-bleed chip, never a glow). The
// `color` prop is kept for source compatibility but maps onto the warm-graphite
// state palette: live/working → instrument grey-cyan, ready → muted green,
// attention → amber-orange, error → muted red, idle/neutral → grey. The brand
// clay-amber accent is NEVER spent here (status ≠ brand). Pulse drives the
// bespoke attention pulse on the dot only (killed under prefers-reduced-motion
// via globals.css `.glyph-attention`).
type BadgeColor = 'cyan' | 'green' | 'amber' | 'red' | 'purple' | 'blue' | 'magenta';

interface NeonBadgeProps {
  color?: BadgeColor;
  pulse?: boolean;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  className?: string;
}

// Legacy neon color name → warm-graphite muted state pill (tint fill + text).
const colorStyles: Record<BadgeColor, string> = {
  cyan:    'bg-tint-working text-state-working border-transparent',
  green:   'bg-tint-ready text-state-ready border-transparent',
  amber:   'bg-tint-attention text-state-attention border-transparent',
  red:     'bg-tint-error text-state-error border-transparent',
  blue:    'bg-tint-working text-state-working border-transparent',
  purple:  'bg-tint-idle text-2 border-transparent',
  magenta: 'bg-tint-attention text-state-attention border-transparent',
};

const dotColors: Record<BadgeColor, string> = {
  cyan:    'bg-state-working',
  green:   'bg-state-ready',
  amber:   'bg-state-attention',
  red:     'bg-state-error',
  blue:    'bg-state-working',
  purple:  'bg-text-3',
  magenta: 'bg-state-attention',
};

const sizeClasses: Record<string, string> = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-2.5 py-0.5 text-xs',
  lg: 'px-3 py-1 text-sm',
};

export default function NeonBadge({
  color = 'cyan',
  pulse = false,
  size = 'md',
  className,
  children,
}: NeonBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill font-mono weight-label border',
        colorStyles[color],
        sizeClasses[size],
        className
      )}
    >
      {pulse && (
        <span className={cn('w-1.5 h-1.5 rounded-full glyph-attention', dotColors[color])} />
      )}
      {children}
    </span>
  );
}
