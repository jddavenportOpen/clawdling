'use client';

import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

// ── Warm Graphite (v6) ───────────────────────────────────────────────────────
// Despite the legacy name, this is no longer glassmorphism — the blur/saturate
// glass + neon glow are retired. It renders a HAIRLINE-BORDERED warm surface
// where depth is luminance + a 1px translucent-white border (never a shadow on
// a card; shadows are reserved for true overlays). The API is unchanged so every
// consumer keeps working; `variant`/`glowColor` now map onto the surface ladder.
//   default → surface-1 + standard hairline
//   muted   → surface-1 + faint hairline (recedes)
//   glow    → surface-2 + a stronger hairline (emphasis via luminance, no glow)
type GlassVariant = 'default' | 'muted' | 'glow';

interface GlassPanelProps {
  id?: string;
  variant?: GlassVariant;
  /** Legacy prop — retained for source compatibility; no longer renders a glow. */
  glowColor?: string;
  className?: string;
  children: ReactNode;
  animate?: boolean;
  delay?: number;
}

const variantClasses: Record<GlassVariant, string> = {
  default: 'rounded-lg border border-border-default bg-surface-1',
  muted:   'rounded-lg border border-hairline bg-surface-1',
  glow:    'rounded-lg border border-border-strong bg-surface-2',
};

export default function GlassPanel({
  id,
  variant = 'default',
  className,
  children,
  animate = true,
  delay = 0,
}: GlassPanelProps) {
  if (!animate) {
    return (
      <div
        id={id}
        className={cn(variantClasses[variant], className)}
      >
        {children}
      </div>
    );
  }

  return (
    <motion.div
      id={id}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: 'spring',
        duration: 0.4,
        bounce: 0,
        delay,
      }}
      className={cn(variantClasses[variant], className)}
    >
      {children}
    </motion.div>
  );
}
