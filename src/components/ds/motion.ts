'use client';

// ═══════════════════════════════════════════════════════════════════════════
// motion — Warm Graphite motion tokens (JS mirror of the CSS tokens) + a
// reduced-motion guard hook.
//
// The CSS custom properties in globals.css (--ease-out-strong, --dur-base, …)
// are the source of truth for CSS-driven motion. This module mirrors them as
// JS values for Motion / Framer Motion (`motion/react`) configs and exposes a
// `usePrefersReducedMotion()` hook so JS animations honor the same guard the
// CSS @media query enforces.
//
// Rules baked in: transform/opacity only, ease-OUT (never ease-in for UI),
// no snap/bounce by default, exit faster than enter, :active scale(0.97).
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';

/** Cubic-bezier easing curves — match globals.css exactly. */
export const EASING = {
  /** DEFAULT — enter/exit, hovers, most UI. */
  outStrong: [0.23, 1, 0.32, 1] as const,
  /** on-screen movement / shared-element morph. */
  inOutStrong: [0.77, 0, 0.175, 1] as const,
  /** trays, bottom sheets, the thread drawer. */
  drawer: [0.32, 0.72, 0, 1] as const,
} as const;

/** CSS easing strings (for inline style / className-free usage). */
export const EASING_CSS = {
  outStrong: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOutStrong: 'cubic-bezier(0.77, 0, 0.175, 1)',
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;

/** Durations in seconds (Motion/Framer take seconds). */
export const DURATION = {
  micro: 0.12, // hover, press
  fast: 0.15, // tooltips, small popovers
  base: 0.2, // dropdowns, pills, selects
  pane: 0.28, // pane / inspector slide
  modal: 0.32, // modal / drawer reveal
} as const;

/** Durations in ms (for setTimeout / CSS-string parity). */
export const DURATION_MS = {
  micro: 120,
  fast: 150,
  base: 200,
  pane: 280,
  modal: 320,
} as const;

/** Spring configs (Motion's 2-param perceptual model). */
export const SPRING = {
  /** panels, pane spawn — a touch of life, no real overshoot. */
  snappy: { type: 'spring' as const, duration: 0.5, bounce: 0.2 },
  /** text / opacity — no overshoot. */
  smooth: { type: 'spring' as const, duration: 0.4, bounce: 0 },
  /** rare / delight ONLY. */
  playful: { type: 'spring' as const, duration: 0.5, bounce: 0.3 },
} as const;

/** Canonical enter transition for cards/panes (scale 0.95 → 1, opacity 0 → 1). */
export const ENTER = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97 },
  transition: { duration: DURATION.base, ease: EASING.outStrong },
} as const;

/**
 * usePrefersReducedMotion — true when the user asked the OS to reduce motion.
 * Use to gate JS-driven animation (the CSS @media query handles CSS animations;
 * the browser does NOT auto-skip JS ones). SSR-safe (defaults to false).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    // addEventListener is the modern API; fall back for older Safari.
    if (mq.addEventListener) {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);
  return reduced;
}
