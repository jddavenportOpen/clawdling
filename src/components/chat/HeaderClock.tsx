'use client';

// ═══════════════════════════════════════════════════════════════════════════
// HeaderClock — the top-bar live clock for the /chat cockpit (Warm Graphite).
//
// The design system's top bar pairs the bespoke wordmark with a clock; this is
// that clock. It is deliberately QUIET — tertiary text, mono, no accent (the
// surface's one hero accent is already spent on the "+ CEO agent" CTA). The
// craft signal lives in the numerals: Geist Mono with `tabular-nums` +
// `slashed-zero` (via the `.tabular` utility), so the digits never reflow as
// the seconds tick and the zero reads as the quiet "real instrument" tell.
//
// Hydration: the server can't know the client's wall-clock, so we render a
// stable placeholder until mount, then tick. `suppressHydrationWarning` guards
// the one text node that legitimately differs server↔client. The interval is
// aligned to the top of each second so the display doesn't drift visibly.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';

function fmt(d: Date): string {
  // 24h HH:MM — dense, unambiguous, instrument-panel. Seconds are intentionally
  // omitted from the visible string (a per-second relayout is noise); the live
  // tick keeps the minute honest without demanding the eye.
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function HeaderClock({ className }: { className?: string }) {
  // Empty until mount → server and first client render agree (no mismatch).
  const [label, setLabel] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      setLabel(fmt(new Date()));
      // Re-arm aligned to the next whole second so the minute rolls cleanly.
      const ms = 1000 - (Date.now() % 1000);
      timer.current = setTimeout(tick, ms);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <time
      // Reserve a fixed box up-front (tabular figures + min-width) so the
      // wordmark never shifts when the clock paints post-hydration. `tabular`
      // carries the mono + slashed-zero + tabular figures from globals.css.
      className={`tabular inline-block min-w-[38px] text-right text-[12px] leading-none tracking-tight text-3${
        className ? ` ${className}` : ''
      }`}
      suppressHydrationWarning
      aria-label={label ? `Local time ${label}` : undefined}
      title="Local time"
    >
      {label || ' '}
    </time>
  );
}
