// ═══════════════════════════════════════════════════════════════════════════
// ds — Warm Graphite design-system foundation barrel.
//
// The single import surface for the v6 cockpit restyle. The tokens live in
// globals.css (CSS custom properties + Tailwind @theme wiring); this barrel
// exposes the component + data layer:
//
//   Wordmark / Logomark / Eyebrow  — the bespoke modular brand assets
//   Icon                           — Phosphor wrapper (weight encodes state)
//   StatusGlyph                    — the signature ring/pie state machine
//   DOMAIN_GLYPHS / AGENT_GLYPHS   — the bespoke duotone glyph maps (no emoji)
//   motion tokens + reduced-motion guard
// ═══════════════════════════════════════════════════════════════════════════

export { Wordmark, Logomark, Eyebrow, default as WordmarkDefault } from './Wordmark';
export type { WordmarkProps, LogomarkProps } from './Wordmark';

export { Icon } from './Icon';
export type { IconState, IconWrapperProps } from './Icon';

export { StatusGlyph } from './StatusGlyph';
export type { GlyphState, StatusGlyphProps } from './StatusGlyph';

export { StatePill } from './StatePill';
export type { StateTone, StatePillProps } from './StatePill';

export {
  DOMAIN_GLYPHS,
  AGENT_GLYPHS,
  FALLBACK_GLYPH,
  domainGlyph,
  agentGlyph,
} from './glyphMap';
export type { GlyphDef } from './glyphMap';

export {
  EASING,
  EASING_CSS,
  DURATION,
  DURATION_MS,
  SPRING,
  ENTER,
  usePrefersReducedMotion,
} from './motion';
