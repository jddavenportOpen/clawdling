// ═══════════════════════════════════════════════════════════════════════════
// StatusGlyph — THE signature deliverable. The bespoke geometric status-glyph
// state machine: a 16px ring/pie that encodes an agent/session state.
//
// This IS the cockpit's "custom emoji" — it replaces ALL Unicode emoji status
// (the trophy/fire/etc. AI clipart). One coherent geometric mark, six states,
// exact color + motion per state (Linear's pie-ring + SF Symbols variable-draw):
//
//   idle      — hollow ring, 1.5px stroke, grey (--state-idle), no motion
//   queued    — dashed ring, tertiary text, slow 8s clockwise rotate
//   working   — accent arc sweeping clockwise (pie fill), warm amber, 1.2s
//   attention — filled dot, hotter amber (--state-attention), 1.4s pulse
//   done       — filled ring + check, green (--state-ready), single draw-on
//   error     — filled ring + X, red (--state-error), STATIC (errors don't flash)
//
// Motion is transform/opacity (+ a stroke-dashoffset draw) ONLY, ease-out, no
// snap/bounce; all of it is killed under prefers-reduced-motion (globals.css),
// where each state still reads via its end-state color/shape.
//
// `progress` (0..1) optionally drives the working arc to a determinate fill;
// omit it for the default indeterminate sweep.
// ═══════════════════════════════════════════════════════════════════════════

import type { CSSProperties } from 'react';

export type GlyphState = 'idle' | 'queued' | 'working' | 'attention' | 'done' | 'error';

export interface StatusGlyphProps {
  state: GlyphState;
  /** px size — default 16 (the spec size). */
  size?: number;
  /** Optional 0..1 determinate fill for `working`. Omit for indeterminate sweep. */
  progress?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible label; defaults to the state name. */
  title?: string;
}

const STATE_COLOR: Record<GlyphState, string> = {
  idle: 'var(--state-idle)',
  queued: 'var(--text-3)',
  working: 'var(--state-working)',
  attention: 'var(--state-attention)',
  done: 'var(--state-ready)',
  error: 'var(--state-error)',
};

const STATE_LABEL: Record<GlyphState, string> = {
  idle: 'Idle',
  queued: 'Queued',
  working: 'Working',
  attention: 'Needs attention',
  done: 'Done',
  error: 'Error',
};

// 24x24 authoring grid; ring radius 9 → circumference ≈ 56.55.
const R = 9;
const CIRC = 2 * Math.PI * R;

export function StatusGlyph({
  state,
  size = 16,
  progress,
  className,
  style,
  title,
}: StatusGlyphProps) {
  const color = STATE_COLOR[state];
  const label = title ?? STATE_LABEL[state];

  // working arc: determinate from `progress`, else a fixed ~30% sweep that the
  // CSS rotate animation spins around the ring (reads as a moving pie fill).
  const sweepFrac = state === 'working'
    ? (typeof progress === 'number' ? Math.max(0.04, Math.min(1, progress)) : 0.3)
    : 0;
  const sweepDash = `${(CIRC * sweepFrac).toFixed(2)} ${(CIRC * (1 - sweepFrac)).toFixed(2)}`;

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ color, display: 'block', ...style }}
    >
      <title>{label}</title>

      {/* faint track ring — present under every state for visual anchoring */}
      {state !== 'attention' && (
        <circle
          cx="12"
          cy="12"
          r={R}
          stroke="currentColor"
          strokeWidth={state === 'idle' ? 1.5 : 1.75}
          opacity={state === 'idle' ? 0.55 : 0.18}
          fill="none"
        />
      )}

      {/* ── queued — dashed ring, slow rotate ──────────────────────────── */}
      {state === 'queued' && (
        <circle
          className="glyph-queued"
          cx="12"
          cy="12"
          r={R}
          stroke="currentColor"
          strokeWidth={1.75}
          strokeDasharray="2 3"
          strokeLinecap="round"
          fill="none"
        />
      )}

      {/* ── working — accent arc sweeping clockwise (pie fill) ─────────── */}
      {state === 'working' && (
        <circle
          className={typeof progress === 'number' ? undefined : 'glyph-working'}
          cx="12"
          cy="12"
          r={R}
          stroke="currentColor"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeDasharray={sweepDash}
          // start the arc at 12 o'clock
          transform="rotate(-90 12 12)"
          fill="none"
          // Critic round-3 FIX #2 — the working arc dropped its drop-shadow glow.
          // A neon halo around a muted-cyan ring is the exact "instrument turns
          // into AI-HUD" tell; the ring now reads as quiet telemetry, no bloom.
        />
      )}

      {/* ── attention — filled dot, pulse (the one eye-demand) ─────────── */}
      {state === 'attention' && (
        <circle className="glyph-attention" cx="12" cy="12" r={5.5} fill="currentColor" />
      )}

      {/* ── done — filled ring + draw-on check ─────────────────────────── */}
      {state === 'done' && (
        <>
          <circle cx="12" cy="12" r={R} fill="currentColor" opacity={0.16} />
          <path
            className="glyph-done-draw"
            d="M8 12.2 L11 15 L16 9"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            pathLength={64}
            strokeDasharray={64}
            style={{ ['--glyph-dash' as string]: '64' }}
          />
        </>
      )}

      {/* ── error — filled ring + static X (no pulse) ──────────────────── */}
      {state === 'error' && (
        <>
          <circle cx="12" cy="12" r={R} fill="currentColor" opacity={0.16} />
          <path
            d="M9 9 L15 15 M15 9 L9 15"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            fill="none"
          />
        </>
      )}
    </svg>
  );
}

export default StatusGlyph;
