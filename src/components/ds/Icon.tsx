// ═══════════════════════════════════════════════════════════════════════════
// Icon — the Warm Graphite icon wrapper where WEIGHT encodes state.
//
// Base library: Phosphor (@phosphor-icons/react, MIT) — ~1,250 icons in 6
// weights (thin/light/regular/bold/fill/duotone). The cockpit's edge is that
// a single icon expresses state by switching WEIGHT, never by redrawing:
//
//     regular  → idle / default
//     fill     → active / live / selected
//     duotone  → domain glyphs, empty-states (the "premium" weight)
//     bold     → emphasis (rare)
//
// Usage:
//     import { Icon } from '@/components/ds/Icon';
//     import { Gear } from '@phosphor-icons/react/dist/ssr';
//     <Icon glyph={Gear} state="active" size={16} />
//
// `state` is the semantic input; it maps to a Phosphor IconWeight. You can also
// pass `weight` directly to override. ZERO Unicode emoji anywhere — every glyph
// is a vector component. Duotone is driven off a single `color`, so one token
// tints the whole glyph (foreground + 0.16-alpha background layer).
// ═══════════════════════════════════════════════════════════════════════════

import type { CSSProperties } from 'react';
import type { Icon as PhosphorIcon, IconProps, IconWeight } from '@phosphor-icons/react';

/** Semantic icon state — maps to a Phosphor weight. */
export type IconState = 'idle' | 'active' | 'domain' | 'emphasis';

const STATE_WEIGHT: Record<IconState, IconWeight> = {
  idle: 'regular',
  active: 'fill',
  domain: 'duotone',
  emphasis: 'bold',
};

export interface IconWrapperProps extends Omit<IconProps, 'weight'> {
  /** The Phosphor icon component (import from '@phosphor-icons/react/dist/ssr'). */
  glyph: PhosphorIcon;
  /** Semantic state → weight. Default 'idle' (regular). */
  state?: IconState;
  /** Override the resolved weight directly (escape hatch). */
  weight?: IconWeight;
  /** px size — render at 14 / 16 / 20 / 24. Default 16. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({
  glyph: Glyph,
  state = 'idle',
  weight,
  size = 16,
  className,
  style,
  color,
  ...rest
}: IconWrapperProps) {
  const resolved = weight ?? STATE_WEIGHT[state];
  return (
    <Glyph
      size={size}
      weight={resolved}
      // Default to currentColor so a parent `color:` / Tailwind text-* tints it;
      // duotone's background layer derives from the same color automatically.
      color={color ?? 'currentColor'}
      className={className}
      style={style}
      // Phosphor renders a bare <svg> with no role; mark decorative unless an
      // explicit aria-label is given. Also surface the resolved weight as a
      // data attribute so the restyle layer / tests can target it (Phosphor
      // does NOT pass `weight` through to the DOM).
      aria-hidden={rest['aria-label'] ? undefined : true}
      data-icon-weight={resolved}
      data-icon-state={weight ? undefined : state}
      {...rest}
    />
  );
}

export default Icon;
