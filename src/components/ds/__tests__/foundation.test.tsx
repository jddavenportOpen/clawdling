// ═══════════════════════════════════════════════════════════════════════════
// Warm Graphite foundation — regression guards for the design-system primitives.
//
// These tests pin the anti-AI-slop invariants the foundation exists to enforce:
//   • the glyph maps cover every domain + agent and contain ZERO Unicode emoji
//   • StatusGlyph renders the correct shape + motion class per state
//   • the Icon wrapper maps semantic state → the correct Phosphor weight
//   • the bespoke Wordmark/Logomark render as SVG (not a paid font, not text)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { StatusGlyph, type GlyphState } from '@/components/ds/StatusGlyph';
import { Icon } from '@/components/ds/Icon';
import { Wordmark, Logomark, Eyebrow } from '@/components/ds/Wordmark';
import {
  DOMAIN_GLYPHS,
  AGENT_GLYPHS,
  domainGlyph,
  agentGlyph,
  FALLBACK_GLYPH,
} from '@/components/ds/glyphMap';
import { Gear } from '@phosphor-icons/react/dist/ssr';

// Matches emoji / pictographic codepoints — the AI-slop tell we ban from chrome.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;

describe('glyphMap — bespoke glyphs, zero emoji', () => {
  // Each glyph must be a real, mountable component that renders an <svg>
  // (Phosphor's SSR icons are forwardRef objects, not plain functions, so we
  // verify by rendering rather than a typeof check).
  const rendersSvg = (Glyph: (typeof DOMAIN_GLYPHS)[string]['glyph']) => {
    const { container, unmount } = render(<Glyph size={16} />);
    const ok = !!container.querySelector('svg');
    unmount();
    return ok;
  };

  it('covers the starter domains', () => {
    for (const id of [
      'work',
      'personal',
      'notes',
    ]) {
      expect(DOMAIN_GLYPHS[id], `domain ${id}`).toBeTruthy();
      expect(rendersSvg(DOMAIN_GLYPHS[id].glyph), `domain ${id} renders svg`).toBe(true);
    }
  });

  it('covers every agent role from agents.json', () => {
    for (const id of [
      'assistant',
      'researcher',
      'tasks',
    ]) {
      expect(AGENT_GLYPHS[id], `agent ${id}`).toBeTruthy();
      expect(rendersSvg(AGENT_GLYPHS[id].glyph), `agent ${id} renders svg`).toBe(true);
    }
  });

  it('contains NO unicode emoji in any label or tint', () => {
    for (const def of [...Object.values(DOMAIN_GLYPHS), ...Object.values(AGENT_GLYPHS)]) {
      expect(EMOJI_RE.test(def.label), `label "${def.label}"`).toBe(false);
      expect(EMOJI_RE.test(def.tint), `tint "${def.tint}"`).toBe(false);
    }
  });

  it('resolves unknown ids to the non-emoji fallback glyph', () => {
    expect(domainGlyph('does-not-exist')).toBe(FALLBACK_GLYPH);
    expect(agentGlyph(undefined)).toBe(FALLBACK_GLYPH);
    expect(EMOJI_RE.test(FALLBACK_GLYPH.label)).toBe(false);
    // an agent id missing from AGENT_GLYPHS but present as a domain falls through
    expect(agentGlyph('notes')).toBe(DOMAIN_GLYPHS.notes);
  });
});

describe('StatusGlyph — the signature state machine', () => {
  const states: GlyphState[] = ['idle', 'queued', 'working', 'attention', 'done', 'error'];

  it('renders an accessible SVG for every state with the right label', () => {
    const labels: Record<GlyphState, string> = {
      idle: 'Idle',
      queued: 'Queued',
      working: 'Working',
      attention: 'Needs attention',
      done: 'Done',
      error: 'Error',
    };
    for (const s of states) {
      const { getByRole, unmount } = render(<StatusGlyph state={s} />);
      const svg = getByRole('img');
      expect(svg.getAttribute('aria-label')).toBe(labels[s]);
      unmount();
    }
  });

  it('applies the working sweep animation class (indeterminate)', () => {
    const { container } = render(<StatusGlyph state="working" />);
    expect(container.querySelector('.glyph-working')).toBeTruthy();
  });

  it('drives a determinate arc (no sweep class) when progress is given', () => {
    const { container } = render(<StatusGlyph state="working" progress={0.5} />);
    expect(container.querySelector('.glyph-working')).toBeNull();
  });

  it('pulses on attention and stays static (no animation class) on error', () => {
    const att = render(<StatusGlyph state="attention" />);
    expect(att.container.querySelector('.glyph-attention')).toBeTruthy();
    const err = render(<StatusGlyph state="error" />);
    expect(err.container.querySelector('[class*="glyph-"]')).toBeNull();
  });

  it('draws on the done check', () => {
    const { container } = render(<StatusGlyph state="done" />);
    expect(container.querySelector('.glyph-done-draw')).toBeTruthy();
  });
});

describe('Icon — weight encodes state', () => {
  // Phosphor consumes `weight` to pick the path set; it does NOT render a
  // `weight` DOM attribute. The wrapper surfaces it as data-icon-weight. We
  // also assert the duotone path actually renders its 0.16-alpha second layer.
  it('maps idle → regular, active → fill, domain → duotone', () => {
    const idle = render(<Icon glyph={Gear} state="idle" />);
    expect(idle.container.querySelector('svg')?.getAttribute('data-icon-weight')).toBe('regular');

    const active = render(<Icon glyph={Gear} state="active" />);
    expect(active.container.querySelector('svg')?.getAttribute('data-icon-weight')).toBe('fill');

    const domain = render(<Icon glyph={Gear} state="domain" />);
    const dSvg = domain.container.querySelector('svg')!;
    expect(dSvg.getAttribute('data-icon-weight')).toBe('duotone');
    // duotone renders two paths, one carrying the background opacity layer
    expect(dSvg.querySelectorAll('path').length).toBeGreaterThan(1);
    expect(dSvg.querySelector('path[opacity]')).toBeTruthy();
  });

  it('lets an explicit weight override the state mapping', () => {
    const { container } = render(<Icon glyph={Gear} state="idle" weight="bold" />);
    expect(container.querySelector('svg')?.getAttribute('data-icon-weight')).toBe('bold');
  });

  it('is decorative (aria-hidden) by default, labelled when given aria-label', () => {
    const dec = render(<Icon glyph={Gear} />);
    expect(dec.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const lab = render(<Icon glyph={Gear} aria-label="Settings" />);
    expect(lab.container.querySelector('svg')?.getAttribute('aria-label')).toBe('Settings');
  });
});

describe('Wordmark — bespoke SVG brand assets', () => {
  it('renders the wordmark as an accessible SVG (not text, not a font)', () => {
    const { getByRole } = render(<Wordmark />);
    const svg = getByRole('img');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('aria-label')).toBe('Clawdling');
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(5);
  });

  it('renders the standalone claw logomark', () => {
    const { getByRole } = render(<Logomark />);
    expect(getByRole('img').tagName.toLowerCase()).toBe('svg');
  });

  it('renders the mono eyebrow with the overline class', () => {
    const { container } = render(<Eyebrow />);
    const el = container.querySelector('.overline');
    expect(el).toBeTruthy();
    expect(el?.textContent).toBe('CLAWDLING');
  });
});
