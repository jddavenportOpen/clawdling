// ═══════════════════════════════════════════════════════════════════════════
// chatChrome.test.ts — CAT-23 regression (chat top-bar z-stack + reserve owner).
//
// The hamburger trigger was z-40 — BELOW the bottom tab bar (z-50) and several
// overlays — and ChatGrid reserved a magic `pl-14` hand-tied to the hamburger's
// `left-2 + w-11` geometry, so a hamburger resize would silently clip the
// "N chats" label. These assertions lock the invariants the shared token owns.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { Z, HAMBURGER } from '../chatChrome';

/** Pull the numeric tier out of a Tailwind z class (`z-50`, `z-[55]`). */
function zValue(cls: string): number {
  const m = cls.match(/z-(?:\[)?(\d+)(?:\])?/);
  expect(m, `"${cls}" must be a z-index class`).toBeTruthy();
  return Number(m![1]);
}

describe('chatChrome Z stack — CAT-23', () => {
  it('hamburger is at least the tab-bar tier (never below passive chrome)', () => {
    expect(zValue(Z.hamburger)).toBeGreaterThanOrEqual(zValue(Z.tabBar));
  });

  it('drawer overlay sits ABOVE the hamburger so its X owns the open action', () => {
    expect(zValue(Z.drawer)).toBeGreaterThan(zValue(Z.hamburger));
  });

  it('More overlay is the top-most chat surface', () => {
    expect(zValue(Z.more)).toBeGreaterThanOrEqual(zValue(Z.drawer));
  });

  it('base chrome is below every interactive overlay', () => {
    expect(zValue(Z.chrome)).toBeLessThan(zValue(Z.hamburger));
  });
});

describe('chatChrome hamburger reserve — CAT-23', () => {
  it('reserves enough left padding to clear the hamburger on mobile', () => {
    // left-2 (8px) + w-11 (44px) = 52px right edge → pl-14 (56px) clears it.
    expect(HAMBURGER.contentReserveClass).toContain('pl-14');
  });

  it('drops the reserve on desktop (no hamburger there)', () => {
    expect(HAMBURGER.contentReserveClass).toContain('md:pl-3');
  });
});
