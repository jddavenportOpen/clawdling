// ═══════════════════════════════════════════════════════════════════════════
// Wordmark — bespoke, hand-built SVG wordmark for the product brand.
//
// Critic round-3 FIX #6: the prior mark rendered an oversized outline-caps
// "CLAWDLING" with a decorative lightning-bolt stroke and a clipped final
// "R" — AND it duplicated the mono "CLAWDLING" eyebrow that sits right above
// it (a redundant double-wordmark). The design system (brand section) calls for
// the opposite hierarchy: a lowercase **`clawd`** wordmark carrying ONE bespoke
// letterform notch, sitting BELOW a single mono UPPERCASE "CLAWDLING" eyebrow.
//
// WHY an SVG (not a paid display face like PP Neue Montreal): a custom SVG
// wordmark is more premium AND license-clean — it ships nothing we have to pay
// to license, and it carries ONE bespoke letterform detail (the Anthropic `\`
// move) that a stock font can't. Here the signature detail is the **`a`**: its
// bowl is cut by a small "claw notch" — a clipped bracket where the bowl meets
// the stem — tying the mark to "clawd". The `c` doubles as the standalone claw
// logomark (see <Logomark/>), so the system is modular.
//
// Three independent assets, per the design system:
//   <Wordmark/>  — the lowercase "clawd" lockup (default)
//   <Logomark/>  — the single-stroke c / claw curve for favicons / tight avatars
//   <Eyebrow/>   — the mono-uppercase metadata eyebrow ("CLAWDLING")
//
// All strokes are drawn with `currentColor`, so a single `color:` tints the
// whole mark. Default tint is --text-1; pass `accent` to draw ONLY the signature
// "claw notch" detail in the clay-amber accent (the accent stays rationed — it
// is a single hairline letterform tick, never a filled element).
// ═══════════════════════════════════════════════════════════════════════════

import type { CSSProperties } from 'react';

export interface WordmarkProps {
  /** Rendered height in px; width scales to the mark's aspect ratio. */
  height?: number;
  /** Tint the signature "claw notch" detail with the clay-amber accent. */
  accent?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Accessible label; set "" to mark decorative when a sibling label exists. */
  title?: string;
}

// The wordmark "clawd" is authored on a 0 0 132 32 grid. Geometric humanist-
// grotesque letterforms drawn at a 2.2px stroke (sharp/premium, between Lucide 2
// and a display weight), round joins. Baseline y=25, x-height top y=11,
// ascender top y=5. Single-story a/d: the bowl is a circle and the stem rides
// the bowl's RIGHT edge (so the stem never bisects the bowl). Optical (not
// mathematical) spacing between glyphs.
const VB_W = 132;
const VB_H = 32;

export function Wordmark({
  height = 18,
  accent = false,
  className,
  style,
  title = 'Clawdling',
}: WordmarkProps) {
  const width = (height * VB_W) / VB_H;
  return (
    <svg
      role="img"
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      width={width}
      height={height}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      fill="none"
      className={className}
      style={{ color: 'var(--text-1)', display: 'block', ...style }}
    >
      {title ? <title>{title}</title> : null}
      <g
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {/* ── c ── open bowl, the claw curve (mirrors the Logomark) ───────── */}
        <path d="M18 14 a7 7 0 1 0 0 8" />

        {/* ── l ── ascender stem ─────────────────────────────────────────── */}
        <path d="M27 5 V25" />

        {/* ── a ── single-story: bowl circle (centre x=40) + a stem riding the
            bowl's RIGHT edge, with the signature CLAW NOTCH. The notch is a
            small amber tick biting the joint where the bowl meets the stem — the
            ONE bespoke letterform detail (the Anthropic `\` move). When `accent`
            is set, only this tick is drawn in the clay-amber accent; everything
            else stays currentColor, so the accent remains a single hairline. */}
        <circle cx="40" cy="18.5" r="6.5" />
        <path d="M46.5 11 V25" />
        <path
          d="M43.5 13 L46.5 13.6"
          stroke={accent ? 'var(--accent)' : 'currentColor'}
        />

        {/* ── w ── two valleys ───────────────────────────────────────────── */}
        <path d="M54 11 L58 25 L63 14 L68 25 L72 11" />

        {/* ── d ── single-story: bowl circle (centre x=86) + an ascender stem
            on the bowl's RIGHT edge (full height to the ascender line). ─────── */}
        <circle cx="86" cy="18.5" r="6.5" />
        <path d="M92.5 5 V25" />
      </g>
    </svg>
  );
}

// ── Logomark ────────────────────────────────────────────────────────────────
// A single continuous stroke "c" that doubles as a claw curve (Resend's
// single-stroke approach). Works independently of the wordmark — favicon,
// avatar, tight contexts. The open mouth of the c is the claw.
export interface LogomarkProps {
  size?: number;
  accent?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export function Logomark({
  size = 24,
  accent = false,
  className,
  style,
  title = 'Clawdling',
}: LogomarkProps) {
  return (
    <svg
      role="img"
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ color: accent ? 'var(--accent)' : 'var(--text-1)', display: 'block', ...style }}
    >
      {title ? <title>{title}</title> : null}
      {/* Continuous c/claw — a near-closed ring with a beveled "talon" tip at
          the mouth, drawn in one stroke so it reads as a single gesture. */}
      <path
        d="M18.5 6.4 A8 8 0 1 0 18.5 17.6"
        stroke="currentColor"
        strokeWidth={2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* the talon notch — the one bespoke detail that makes it a claw, not a c */}
      <path
        d="M18.5 17.6 L15.6 14.9"
        stroke="currentColor"
        strokeWidth={2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// ── Eyebrow ─────────────────────────────────────────────────────────────────
// The mono-uppercase product/surface eyebrow. Pure text (uses the .overline
// utility from globals.css) — pairs ABOVE the lowercase `clawd` wordmark for the
// "brand wordmark + mono metadata eyebrow" hierarchy that reads "real product".
export function Eyebrow({
  children = 'CLAWDLING',
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <span className={`overline${className ? ` ${className}` : ''}`}>{children}</span>;
}

export default Wordmark;
