// ═══════════════════════════════════════════════════════════════════════════
// glyphMap — the bespoke per-domain + per-agent glyph map (kills ALL emoji).
//
// This is the data layer that replaces the Unicode-emoji "AI clipart" on the
// agent tiles and the rail. Each DOMAIN maps to a Phosphor DUOTONE glyph (the
// premium weight — a foreground stroke + a 0.16-alpha background fill, both
// driven off one color) plus a per-domain tint hue. Each AGENT role maps to a
// function-appropriate glyph rendered `regular` when idle → `fill` when active.
//
// All glyphs are SSR-safe Phosphor components (import path .../dist/ssr) so
// they render on the server without a "use client" boundary.
//
// Consume via <Icon glyph={DOMAIN_GLYPHS[id].glyph} state="domain" .../> for the
// duotone rail treatment, or DOMAIN_GLYPHS[id].tint for the per-domain accent.
// `ceo` is an alias of the Clawd CEO agent for the prompt's domain vocabulary.
// ═══════════════════════════════════════════════════════════════════════════

import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import {
  Briefcase,
  Compass,
  Notebook,
  // agent-role glyphs
  Sparkle,
  Microscope,
  Checks,
  Cube,
} from '@phosphor-icons/react/dist/ssr';

export interface GlyphDef {
  glyph: PhosphorIcon;
  /** Per-domain tint — a muted, warm-leaning accent (NOT a saturated chip). */
  tint: string;
  /** Human label (for a11y / tooltips). */
  label: string;
}

// ── Per-domain duotone glyphs (the rail) ────────────────────────────────────
// Keys match src/config/domains.ts ids. Any unknown id falls back to
// FALLBACK_GLYPH, so a custom profile's domains render fine without editing
// this map.
export const DOMAIN_GLYPHS: Record<string, GlyphDef> = {
  work:     { glyph: Briefcase, tint: 'oklch(72% 0.13 275)', label: 'Work' },
  personal: { glyph: Compass,   tint: 'oklch(80% 0.14 75)',  label: 'Personal' },
  notes:    { glyph: Notebook,  tint: 'oklch(74% 0.14 145)', label: 'Notes' },
};

// ── Per-agent role glyphs (the picker tiles) ────────────────────────────────
// Keys match src/config/agents.json ids. Rendered `regular` (idle) →
// `fill` (active/hovered) by the Icon wrapper at the call-site; tinted
// --text-2 by default, --accent-text when active.
export const AGENT_GLYPHS: Record<string, GlyphDef> = {
  assistant:  { glyph: Sparkle,    tint: 'var(--text-2)',       label: 'Assistant' },
  researcher: { glyph: Microscope, tint: 'oklch(78% 0.12 230)', label: 'Researcher' },
  tasks:      { glyph: Checks,     tint: 'oklch(74% 0.14 145)', label: 'Task Manager' },
};

/** Fallback glyph for any unknown domain/agent id (never an emoji). */
export const FALLBACK_GLYPH: GlyphDef = { glyph: Cube, tint: 'var(--text-3)', label: 'Agent' };

/** Resolve a domain id → glyph def, with a safe fallback. */
export function domainGlyph(id: string | null | undefined): GlyphDef {
  if (id && DOMAIN_GLYPHS[id]) return DOMAIN_GLYPHS[id];
  return FALLBACK_GLYPH;
}

/** Resolve an agent id → glyph def, with a safe fallback. */
export function agentGlyph(id: string | null | undefined): GlyphDef {
  if (id && AGENT_GLYPHS[id]) return AGENT_GLYPHS[id];
  if (id && DOMAIN_GLYPHS[id]) return DOMAIN_GLYPHS[id];
  return FALLBACK_GLYPH;
}
