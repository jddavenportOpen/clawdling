'use client';

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

interface HudStatProps {
  label: string;
  value: string;
  icon: LucideIcon;
  trend?: 'up' | 'down' | 'flat';
  color?: 'cyan' | 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'magenta';
  delay?: number;
}

// ── Warm Graphite (v6) ───────────────────────────────────────────────────────
// A hairline-bordered warm surface — no glass blur, no neon glow. The metric
// VALUE reads in calm primary white (tabular + slashed-zero), so the row of
// stats is quiet telemetry, not a wall of competing neon. The legacy `color`
// prop now tints only the small ICON, mapped to a muted state hue (never the
// brand accent, never a saturated neon). The trend caret is a muted state hue.
const iconColorMap: Record<string, string> = {
  cyan:    'text-state-working',
  green:   'text-state-ready',
  amber:   'text-state-attention',
  red:     'text-state-error',
  blue:    'text-state-working',
  purple:  'text-3',
  magenta: 'text-state-attention',
};

const trendCarets: Record<string, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

const trendColors: Record<string, string> = {
  up: 'text-state-ready',
  down: 'text-state-error',
  flat: 'text-3',
};

export default function HudStat({ label, value, icon: Icon, trend, color = 'cyan', delay = 0 }: HudStatProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: 'spring',
        duration: 0.4,
        bounce: 0,
        delay,
      }}
      className="rounded-lg border border-hairline bg-surface-1 px-5 py-4 flex items-center gap-4 min-w-[160px]"
    >
      <div className={cn(
        'w-10 h-10 rounded-md flex items-center justify-center shrink-0',
        'bg-surface-2 border border-border-micro'
      )}>
        <Icon className={cn('w-5 h-5', iconColorMap[color])} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-mono uppercase tracking-widest text-3 mb-0.5">
          {label}
        </p>
        <div className="flex items-baseline gap-2">
          <p className="text-xl weight-strong tracking-tight text-1 tabular">
            {value}
          </p>
          {trend && (
            <span className={cn('text-xs font-mono', trendColors[trend])}>
              {trendCarets[trend]}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
