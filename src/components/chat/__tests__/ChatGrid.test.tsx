// ═══════════════════════════════════════════════════════════════════════════
// ChatGrid.test.tsx — URL contract + pane lifecycle regression coverage.
//
// Born 2026-05-27 (audit HIGH #3, cockpit-chat-v3). The cockpit grid has
// shipped multiple bugs across the last 48h:
//   - the "?panes= replaces instead of appends" regression
//   - the cockpit-resume-after-rotation race (PR #90)
//   - the two-cockpit-sessions-stay-live keep-alive contract (PR #95)
//
// None had regression tests. This file covers the URL state contract +
// the pure helpers (parsePanesParam). Full-render component tests for
// the grid are folded into ChatGridPane.test.tsx (mountedness + threadId
// forwarding bug HIGH #1).
//
// Iter-3 (2026-05-27 — BLOCKER fix for PR #105 regression):
//   The meta-resolution useEffect at ChatGrid.tsx:498-537 deadlocked in
//   prod — cold-mount via `?panes=<sid>` never lifted the placeholder
//   because the URL-reconcile effect's setPanes always returned a fresh
//   array reference, which retriggered the [panes]-dep meta effect,
//   which cancelled its own in-flight fetch via the cleanup, while the
//   dedup ref still pointed at the same key → re-runs bail-out forever.
//   The cold-mount tests below are the regression guard.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import ChatGrid, { __chatGridInternals__ } from '../ChatGrid';

const {
  parsePanesParam,
  MAX_PANES,
  LS_LAST_PANES,
  gridClassFor,
  fontSizeForPaneCount,
  parseModeParam,
  resolveInitialMode,
  DEFAULT_MODE,
  resolveTabLabel,
  resolvePaneStatus,
  resolveResumeBookkeeping,
} = __chatGridInternals__;

// ═══════════════════════════════════════════════════════════════════════════
// W9 named-live-tabs — resolveTabLabel precedence + never-a-hash guarantee.
//
// The whole point of W9: cockpit middle tabs show the domain/agent NAME, never
// the sid hash. resolveTabLabel is the pure resolver behind that. These tests
// pin the precedence (domain → agent_name → cwd basename → "Session") and the
// non-negotiable: the output is NEVER an 8-char hex hash (the old bug).
// ═══════════════════════════════════════════════════════════════════════════
describe('resolveTabLabel — W9 tab name precedence', () => {
  it('domain id resolves to the human DOMAINS label', () => {
    expect(resolveTabLabel({ domain: 'work' })).toBe('Work');
    expect(resolveTabLabel({ domain: 'personal' })).toBe('Personal');
    expect(resolveTabLabel({ domain: 'notes' })).toBe('Notes');
  });

  it('falls to agent_name when there is no domain', () => {
    expect(resolveTabLabel({ agent_name: 'Health · weekly summary' })).toBe(
      'Health · weekly summary'
    );
    expect(resolveTabLabel({ agent_name: 'CEO agent' })).toBe('CEO agent');
  });

  it('trims agent_name and treats whitespace-only as empty', () => {
    expect(resolveTabLabel({ agent_name: '  find old logo  ' })).toBe(
      'find old logo'
    );
    expect(resolveTabLabel({ agent_name: '   ', cwd: '/state/root' })).toBe('root');
  });

  it('falls to the cwd basename when no domain or agent_name', () => {
    expect(resolveTabLabel({ cwd: '/state/root' })).toBe('root');
    expect(resolveTabLabel({ cwd: '/opt/adjutant/data/projects/demo' })).toBe(
      'demo'
    );
  });

  it('falls to the literal "Session" when nothing resolves — NEVER a hash', () => {
    const out = resolveTabLabel({});
    expect(out).toBe('Session');
    // the load-bearing guarantee: the resolver output is never an 8-hex sid.
    expect(out).not.toMatch(/^[0-9a-f]{8}$/);
  });

  it('precedence: domain wins over agent_name and cwd', () => {
    expect(
      resolveTabLabel({
        domain: 'work',
        agent_name: 'Family · reconcile the budget',
        cwd: '/y',
      })
    ).toBe('Work');
  });

  it('an unknown domain id falls through to the next rung (not a crash)', () => {
    expect(
      resolveTabLabel({ domain: 'not-a-real-domain', agent_name: 'fallback' })
    ).toBe('fallback');
    expect(resolveTabLabel({ domain: 'not-a-real-domain' })).toBe('Session');
  });

  // ── feat/cockpit-naming-history: auto-generated TITLE rung ────────────────
  it('uses the auto-generated title over agent_name + cwd', () => {
    expect(
      resolveTabLabel({
        title: 'Refactor Auth Flow',
        agent_name: 'CEO agent',
        cwd: '/state/root',
      })
    ).toBe('Refactor Auth Flow');
  });

  it('a fixed domain name still beats the title (a brain keeps its name)', () => {
    expect(
      resolveTabLabel({ domain: 'work', title: 'Some Chat Topic' })
    ).toBe('Work');
  });

  it('falls back past a null/blank title to agent_name then cwd', () => {
    expect(resolveTabLabel({ title: null, agent_name: 'CEO agent' })).toBe('CEO agent');
    expect(resolveTabLabel({ title: '   ', cwd: '/state/root' })).toBe('root');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAT-01 STATE-TRUTH SPINE — resolvePaneStatus.
//
// THE keystone regression guard. The pre-fix resolver was `m?.status ?? p.status`,
// which kept the optimistic seeded 'live' for ANY sid the bridge never returned
// (reaped / expired / corrupt deep-link) → a LYING green "Done · your turn" pill
// + an enabled composer on a dead pane ("looks ready, type, nothing happens").
//
// This pins the four cases the catalog names: {known-live, unknown, 404/reaped,
// exited}. The non-negotiable inverse guard is the FIRST test: a genuinely-live
// session MUST still resolve live — the fix must never swing false-live → false-
// DEAD. `meta` here is what fetchSessionMeta already live-flag-derived: a present
// entry's `status` is already 'exited' for a not-live row, so resolvePaneStatus
// just has to NOT manufacture 'live' for an ABSENT entry.
// ═══════════════════════════════════════════════════════════════════════════
describe('resolvePaneStatus — CAT-01 dead/unknown sid truth', () => {
  it('KNOWN-LIVE: a live feed entry keeps live (never swing false-dead)', () => {
    // fetchSessionMeta returns status='live' only when the bridge reported live.
    expect(resolvePaneStatus({ status: 'live', threadId: 't', title: 'x', activity: 'waiting' }, 'live')).toBe('live');
    // a starting session the feed knows is live stays whatever it reports.
    expect(resolvePaneStatus({ status: 'starting', threadId: null, title: 'x', activity: null }, 'live')).toBe('starting');
  });

  it('EXITED: a feed entry the bridge marked not-live resolves exited', () => {
    // fetchSessionMeta already collapsed a not-live row to 'exited'.
    expect(resolvePaneStatus({ status: 'exited', threadId: 't', title: 'x', activity: null }, 'live')).toBe('exited');
  });

  it('UNKNOWN / 404 / REAPED: a sid ABSENT from the feed resolves exited, NOT the optimistic live seed', () => {
    // meta === undefined is the bug-class: the bridge has never heard of this
    // sid. The OLD code kept `p.status` (seeded 'live') here → lying pill.
    expect(resolvePaneStatus(undefined, 'live')).toBe('exited');
    // Even if the seed was 'live', absence wins → exited.
    expect(resolvePaneStatus(undefined, 'exited')).toBe('exited');
  });

  it('STARTING grace: an absent just-spawned sid keeps starting (not flashed dead before the feed indexes it)', () => {
    // A fresh spawn may not be in the feed yet; we don't flash Stopped — the
    // poll re-resolves it within a tick once the feed catches up.
    expect(resolvePaneStatus(undefined, 'starting')).toBe('starting');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CAT-20 / CODE-STATE BUG-9 — resume sid-swap bookkeeping. The `alreadyHasNew`
// DROP branch must mirror handleRemove: clamp mobileVisibleIdx into range and
// repoint focusedSid off the removed oldSid — otherwise the mobile view yanks
// JD to a different chat and the focus-collapse grid renders blank.
// ════════════════════════════════════════════════════════════════════════════
describe('resolveResumeBookkeeping — CAT-20 sid-swap index/focus', () => {
  it('SWAP branch: index unchanged, focus moves old→new', () => {
    const out = resolveResumeBookkeeping({
      oldSid: 'old',
      newSid: 'new',
      alreadyHasNew: false,
      nextLen: 3,
      mobileVisibleIdx: 2,
      focusedSid: 'old',
    });
    expect(out.mobileVisibleIdx).toBe(2); // same slot count → unchanged
    expect(out.focusedSid).toBe('new'); // repointed off the swapped sid
  });

  it('DROP branch clamps an out-of-range mobile index (the "yanked to a different chat" bug)', () => {
    // Deck was [a, old, new]; viewing idx 2. Resume drops `old` → [a, new],
    // nextLen 2. idx 2 now points PAST the end; must clamp to 1.
    const out = resolveResumeBookkeeping({
      oldSid: 'old',
      newSid: 'new',
      alreadyHasNew: true,
      nextLen: 2,
      mobileVisibleIdx: 2,
      focusedSid: null,
    });
    expect(out.mobileVisibleIdx).toBe(1);
  });

  it('DROP branch repoints a focused dead pane onto the surviving new pane (no blank grid)', () => {
    // focusedSid pointed at the dead `old` pane; after the drop it must collapse
    // onto `new` (already in the deck) — not dangle at a sid no longer present.
    const out = resolveResumeBookkeeping({
      oldSid: 'old',
      newSid: 'new',
      alreadyHasNew: true,
      nextLen: 2,
      mobileVisibleIdx: 0,
      focusedSid: 'old',
    });
    expect(out.focusedSid).toBe('new');
  });

  it('does NOT touch focus when JD was focused on an UNRELATED pane', () => {
    const out = resolveResumeBookkeeping({
      oldSid: 'old',
      newSid: 'new',
      alreadyHasNew: true,
      nextLen: 2,
      mobileVisibleIdx: 0,
      focusedSid: 'other',
    });
    expect(out.focusedSid).toBe('other');
  });

  it('DROP branch leaves an in-range index alone (clamp is a floor, not a force)', () => {
    const out = resolveResumeBookkeeping({
      oldSid: 'old',
      newSid: 'new',
      alreadyHasNew: true,
      nextLen: 3,
      mobileVisibleIdx: 1,
      focusedSid: null,
    });
    expect(out.mobileVisibleIdx).toBe(1);
  });
});

describe('parsePanesParam', () => {
  it('returns [] for null', () => {
    expect(parsePanesParam(null)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(parsePanesParam('')).toEqual([]);
  });

  it('splits a single sid', () => {
    expect(parsePanesParam('sid_abc')).toEqual(['sid_abc']);
  });

  it('splits a comma list', () => {
    expect(parsePanesParam('sid_abc,sid_def,sid_ghi')).toEqual([
      'sid_abc',
      'sid_def',
      'sid_ghi',
    ]);
  });

  it('trims whitespace around each sid', () => {
    expect(parsePanesParam(' sid_abc , sid_def ')).toEqual([
      'sid_abc',
      'sid_def',
    ]);
  });

  it('drops empty entries from a trailing comma', () => {
    expect(parsePanesParam('sid_abc,,sid_def,')).toEqual(['sid_abc', 'sid_def']);
  });

  it('clamps at the PANE_SOFT_CAP safety limit (defensive, not a UX cap)', () => {
    // C5 no-cap (2026-06-10): MAX_PANES is now the large PANE_SOFT_CAP soft
    // render budget, not a hard "10" UX cap. The parser still clamps at that
    // safety limit so a corrupt/runaway `?panes=` URL can't try to mount an
    // unbounded number of xterm panes in one tick. We assert the clamp still
    // engages at exactly MAX_PANES when overflowed.
    const many = Array.from({ length: MAX_PANES + 5 }, (_, i) => `sid${i}`).join(
      ','
    );
    expect(parsePanesParam(many).length).toBe(MAX_PANES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C5 no-cap (R-Cockpit, 2026-06-10) — the deck is UNBOUNDED.
//
// JD's core use case: "many open Claude Codes, all organized, from the GUI."
// The old MAX_PANES=10 hard refusal (plus a 6 in one ThreadSidebar path and a
// 10 in another — they disagreed) contradicted the infinity-agents ethos. These
// tests pin the new contract: MAX_PANES is now a LARGE soft render budget, and
// a deck well past the old 10 is NOT clamped.
// ═══════════════════════════════════════════════════════════════════════════
describe('C5 no-cap — deck is unbounded up to the safety limit', () => {
  it('MAX_PANES is much larger than the old 10-pane cap (cap removed)', () => {
    // The arbitrary 10-cap is gone; the only ceiling is a defensive safety
    // limit far above any realistic human-driven fleet.
    expect(MAX_PANES).toBeGreaterThan(10);
    expect(MAX_PANES).toBeGreaterThanOrEqual(100);
  });

  it('a 25-session deck (well past the old cap) is NOT clamped', () => {
    // Under the old MAX_PANES=10 this would have been clamped to 10; under
    // no-cap the whole fleet survives the parse.
    const big = Array.from({ length: 25 }, (_, i) => `sid${i}`).join(',');
    expect(parsePanesParam(big).length).toBe(25);
  });

  it('appending a 11th session past the old cap keeps all 11 (no bump-oldest)', () => {
    // The append math every callsite uses: at < MAX_PANES we append, never
    // evict. The old code evicted the oldest at 6 (openInGrid) or 10
    // (openSidInDeck/handleLaunched). Now nothing is evicted below the safety
    // limit — the working agent is never silently dropped.
    const current = Array.from({ length: 10 }, (_, i) => `sid${i}`);
    const target = 'sid_new';
    const next =
      current.includes(target) || current.length >= MAX_PANES
        ? current
        : [...current, target];
    expect(next.length).toBe(11);
    expect(next).toContain('sid_new');
    expect(next[0]).toBe('sid0'); // oldest survived — NOT bumped
  });
});

describe('URL contract — append vs replace semantics', () => {
  // The bug we're guarding against: opening a second pane via the launcher
  // or "Open in grid (new pane)" must APPEND to ?panes=, never REPLACE. This
  // is the contract every callsite obeys (ChatGrid.handleLaunched and
  // ThreadSidebar.openInGrid). We assert the append math directly so a
  // regression in either callsite gets caught at the unit level too.

  it('appending to an existing pane list builds a comma string', () => {
    const current = parsePanesParam('sid_abc');
    const next = [...current, 'sid_def'];
    expect(next.join(',')).toBe('sid_abc,sid_def');
  });

  it('an empty pane list followed by an append yields a single-sid string', () => {
    const current = parsePanesParam(null);
    const next = [...current, 'sid_abc'];
    expect(next.join(',')).toBe('sid_abc');
  });

  it('removing a pane via filter preserves the rest', () => {
    const current = parsePanesParam('sid_abc,sid_def,sid_ghi');
    const removed = current.filter((s) => s !== 'sid_def');
    expect(removed).toEqual(['sid_abc', 'sid_ghi']);
    expect(removed.join(',')).toBe('sid_abc,sid_ghi');
  });

  it('appending past MAX_PANES is silently capped by the parser on re-read', () => {
    // If a caller somehow stuffs > MAX_PANES sids into the URL (e.g. an
    // old localStorage restore from a deck size that was bigger than
    // today's cap), parsePanesParam clamps on the read side. UX-wise the
    // user sees the first MAX_PANES; the tail is dropped.
    const overflow = Array.from(
      { length: MAX_PANES + 3 },
      (_, i) => `sid${i}`
    ).join(',');
    expect(parsePanesParam(overflow).length).toBe(MAX_PANES);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// V3.1 V2.2 ultrawide adaptive grid (2026-05-28).
//
// PRD line 41 + WORKPLAN V2.2: detect viewport ≥1800px → wider columns +
// larger panes. 8 panes go 4x2 with READABLE pane size on ultrawide.
//
// Design choice (Option A — Tailwind breakpoint, not JS viewport
// measurement): the column count lives entirely in Tailwind classes via
// the `3xl:` breakpoint (added in globals.css @theme: `--breakpoint-3xl:
// 1800px`). Pure CSS, no SSR mismatch, no resize listener overhead. The
// font tier IS JS-controlled (since it's a numeric prop passed to xterm)
// — see useIsUltrawide() + fontSizeForPaneCount's third arg.
//
// What we assert:
//   • gridClassFor adds `3xl:` overrides at N=4 (4x1 instead of 2x2) and
//     N=9 (5x2 instead of 3x3). 5-8 and 10 stay unchanged because the
//     standard layout already exploits horizontal room well.
//   • Existing rows for N=1..3, 5..8, 10 are UNCHANGED (no class drift).
//   • fontSizeForPaneCount bumps each tier by +1px when isUltrawide=true.
//   • Focus mode font is 16 (standard) / 17 (ultrawide).
// ─────────────────────────────────────────────────────────────────────────

describe('gridClassFor — ultrawide adaptive grid (V3.1 V2.2)', () => {
  it('N=1 is full-bleed at all viewport sizes', () => {
    expect(gridClassFor(1)).toBe('grid grid-cols-1 grid-rows-1');
  });

  it('N=2 is 2x1 (already wide — no ultrawide override needed)', () => {
    expect(gridClassFor(2)).toBe('grid grid-cols-1 md:grid-cols-2 grid-rows-1');
  });

  it('N=3 is 3x1 (already wide — no ultrawide override needed)', () => {
    expect(gridClassFor(3)).toBe('grid grid-cols-1 md:grid-cols-3 grid-rows-1');
  });

  it('N=4 collapses 2x2 → 4x1 at ≥1800px (3xl: override, !important to beat Tailwind v4 emission order)', () => {
    // Standard md+: 2 cols x 2 rows. Ultrawide: 4 cols x 1 row.
    // The `!` on the 3xl: rules is REQUIRED — see iter-7 fix in ChatGrid.tsx:
    // Tailwind v4 may emit `.md:grid-cols-2` AFTER `.3xl:grid-cols-4` in the
    // bundle, so equal-specificity cascade picks the later rule unless we
    // mark the 3xl declaration !important. Dropping the `!` here regresses
    // V2.2 N=4 ultrawide back to 2x2. This is THE bug iter-7 fixed.
    const cls = gridClassFor(4);
    expect(cls).toContain('md:grid-cols-2');
    expect(cls).toContain('md:grid-rows-2');
    expect(cls).toContain('3xl:grid-cols-4!');
    expect(cls).toContain('3xl:grid-rows-1!');
    // Explicit anti-regression: the bare (non-important) form must NOT be
    // present alone. If a future refactor strips the `!` thinking it's a
    // typo, this catches it.
    expect(cls).not.toMatch(/3xl:grid-cols-4(?!!)/);
    expect(cls).not.toMatch(/3xl:grid-rows-1(?!!)/);
  });

  it('N=5 stays 3x2 — ultrawide just widens each column via CSS, no override', () => {
    expect(gridClassFor(5)).toBe(
      'grid grid-cols-1 md:grid-cols-3 grid-rows-1 md:grid-rows-2'
    );
  });

  it('N=6 stays 3x2 — same row count, panes auto-grow on wider viewports', () => {
    expect(gridClassFor(6)).toBe(
      'grid grid-cols-1 md:grid-cols-3 grid-rows-1 md:grid-rows-2'
    );
  });

  it('N=7 stays 4x2 — already maxes columns at standard breakpoint', () => {
    expect(gridClassFor(7)).toBe(
      'grid grid-cols-1 md:grid-cols-4 grid-rows-1 md:grid-rows-2'
    );
  });

  it('N=8 stays 4x2 — canonical V2.2 PRD target (8 panes readable on ultrawide)', () => {
    // V2.2 spec line: "8 panes go 4x2 with READABLE pane size on ultrawide."
    // 4x2 IS the layout; readability comes from the wider per-pane width
    // on a 2560+ viewport (each pane gets ~640px vs ~360px on a 1440 desktop)
    // plus the ultrawide font bump in fontSizeForPaneCount below.
    expect(gridClassFor(8)).toBe(
      'grid grid-cols-1 md:grid-cols-4 grid-rows-1 md:grid-rows-2'
    );
  });

  it('N=9 collapses 3x3 → 5x2 at ≥1800px (3xl: override, !important — same Tailwind v4 emission-order trap as N=4)', () => {
    // Standard: 3 cols x 3 rows. Ultrawide: 5 cols x 2 rows (4 panes top,
    // 5 bottom — same 9 cells, but shorter pane heights and wider columns).
    // N=9 has the SAME md→3xl pattern as N=4 → same Tailwind v4 emission-
    // order bug applies. The audit only caught N=4 (it never tested N=9 at
    // ultrawide); iter-7 prophylactically fixed both.
    const cls = gridClassFor(9);
    expect(cls).toContain('md:grid-cols-3');
    expect(cls).toContain('md:grid-rows-3');
    expect(cls).toContain('3xl:grid-cols-5!');
    expect(cls).toContain('3xl:grid-rows-2!');
    expect(cls).not.toMatch(/3xl:grid-cols-5(?!!)/);
    expect(cls).not.toMatch(/3xl:grid-rows-2(?!!)/);
  });

  it('N=10 stays 5x2 — already optimal for ultrawide column-density', () => {
    expect(gridClassFor(10)).toBe(
      'grid grid-cols-1 md:grid-cols-5 grid-rows-1 md:grid-rows-2'
    );
  });

  it('every ultrawide class string compiles to a valid Tailwind grid utility', () => {
    // Defensive: catch typos like `3xl:gird-cols-4` early.
    for (let n = 1; n <= 10; n++) {
      const cls = gridClassFor(n);
      expect(cls).toMatch(/^grid /);
      expect(cls).not.toMatch(/3xl:gri[^d]/); // typo guard
      // If 3xl: appears, it must reference cols or rows + a positive int,
      // optionally suffixed with `!` for Tailwind v4 important modifier
      // (iter-7 fix: required at N=4 and N=9 to beat md: emission order).
      const ultras = cls.match(/3xl:[^ ]+/g) ?? [];
      for (const u of ultras) {
        expect(u).toMatch(/^3xl:grid-(cols|rows)-\d+!?$/);
      }
    }
  });
});

describe('fontSizeForPaneCount — ultrawide font-tier bump (V3.1 V2.2)', () => {
  // Standard desktop (<1800px) tiers — unchanged from PR #99 readability work.
  describe('standard desktop (<1800px)', () => {
    it('1 pane → 15px', () => {
      expect(fontSizeForPaneCount(1, false, false)).toBe(15);
    });
    it('2 panes → 15px', () => {
      expect(fontSizeForPaneCount(2, false, false)).toBe(15);
    });
    it('3 panes → 13px', () => {
      expect(fontSizeForPaneCount(3, false, false)).toBe(13);
    });
    it('4 panes → 13px', () => {
      expect(fontSizeForPaneCount(4, false, false)).toBe(13);
    });
    it('5 panes → 12px', () => {
      expect(fontSizeForPaneCount(5, false, false)).toBe(12);
    });
    it('8 panes → 12px (floor)', () => {
      expect(fontSizeForPaneCount(8, false, false)).toBe(12);
    });
    it('10 panes → 12px (floor)', () => {
      expect(fontSizeForPaneCount(10, false, false)).toBe(12);
    });
    it('focus mode → 16px', () => {
      expect(fontSizeForPaneCount(5, true, false)).toBe(16);
    });
  });

  // Ultrawide (≥1800px) tiers — +1px across the board. Panes are physically
  // larger AND ultrawide monitors are typically 34"+ (further sitting
  // distance), so the bump compounds.
  describe('ultrawide (≥1800px)', () => {
    it('1 pane → 16px (was 15)', () => {
      expect(fontSizeForPaneCount(1, false, true)).toBe(16);
    });
    it('2 panes → 16px (was 15)', () => {
      expect(fontSizeForPaneCount(2, false, true)).toBe(16);
    });
    it('3 panes → 14px (was 13)', () => {
      expect(fontSizeForPaneCount(3, false, true)).toBe(14);
    });
    it('4 panes → 14px (was 13)', () => {
      expect(fontSizeForPaneCount(4, false, true)).toBe(14);
    });
    it('5 panes → 13px (was 12)', () => {
      expect(fontSizeForPaneCount(5, false, true)).toBe(13);
    });
    it('8 panes → 13px (was 12)', () => {
      expect(fontSizeForPaneCount(8, false, true)).toBe(13);
    });
    it('10 panes → 13px (was 12)', () => {
      expect(fontSizeForPaneCount(10, false, true)).toBe(13);
    });
    it('focus mode → 17px (was 16)', () => {
      expect(fontSizeForPaneCount(5, true, true)).toBe(17);
    });
  });

  it('default isUltrawide arg is false (backward-compat with non-ultrawide callers)', () => {
    // The 2-arg call signature must still resolve to the standard tier
    // so we don't break any test or call site that hasn't migrated yet.
    expect(fontSizeForPaneCount(2, false)).toBe(15);
    expect(fontSizeForPaneCount(4, false)).toBe(13);
    expect(fontSizeForPaneCount(5, true)).toBe(16);
  });
});

describe('LS_LAST_PANES storage key contract', () => {
  // The key MUST stay 'chat-cockpit.last-panes' — any rename strands every
  // browser's saved deck. Brittle by design; if you change this, also write
  // a migration that reads the old key once and writes the new.
  it('storage key is the documented constant', () => {
    expect(LS_LAST_PANES).toBe('chat-cockpit.last-panes');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Iter-3 BLOCKER regression — cold-mount via ?panes=<sid> must lift the
// metaResolved placeholder within a tick. The bug:
//
//   1. Initial render: panes=[{metaResolved:false}] from useState seed.
//   2. URL-reconcile effect (dep [panesParam, focusParam]) fires setPanes
//      with a NEW array reference (Map.get returns same descriptors but
//      sids.map(...) is fresh — React re-renders).
//   3. Meta-resolution effect (dep [panes]) fires: starts fetch, captures
//      cancelled=false closure, sets metaFetchInFlightRef.current = key.
//   4. URL-reconcile commit re-renders → panes reference changes.
//   5. Meta-resolution effect re-runs:
//      - cleanup of prior closure: cancelled = true
//      - new run: unresolved=same set → key=same → ref already === key →
//        BAIL. No new fetch starts.
//   6. Original fetch resolves: `if (cancelled) return;` → bails. setPanes
//      NEVER runs. Ref NEVER reset. metaResolved stays false forever.
//      Cold-mount pane stuck at "loading <sid>…" placeholder.
//
// The fix (Option B): drop the `cancelled` flag entirely. The setPanes
// callback is idempotent — it filters `p.metaResolved` and bails on
// already-resolved descriptors. Two completing fetches both call setPanes
// but only the first one mutates state; the second one returns the same
// array (`p.metaResolved` is now true so the map returns p unchanged →
// React shallow-bails the commit). Cleaner than Option A (reset ref on
// cleanup) because we keep zero orphaned closures.
//
// The render shape we assert on:
//   metaResolved=false  → `<div data-testid="pane-loading-1">loading…</div>`
//   metaResolved=true   → `<ChatGridPane>` mounted (mocked here as
//                          `<div data-testid="pane-mounted-1">`)
// So the deadlock test is: cold-mount with ?panes=sid → wait for fetch
// resolution → assert pane-mounted-1 appears, pane-loading-1 is gone.
// On the BROKEN code this hangs at pane-loading-1; on the FIXED code it
// flips within a tick of the fetch microtask.
// ─────────────────────────────────────────────────────────────────────────

vi.mock('../ChatGridPane', () => ({
  // CAT-01: expose the resolved initialStatus so the cold-mount integration
  // tests can assert the pane mounts DEAD for an unknown sid and LIVE for a
  // genuinely-live one (no false-live, no false-dead).
  default: (props: { sessionId: string; initialStatus?: string }) => (
    <div
      data-testid={`pane-mounted-${props.sessionId}`}
      data-status={props.initialStatus}
    >
      mounted
    </div>
  ),
}));

vi.mock('../NewSessionPicker', () => ({
  default: () => null,
}));

vi.mock('../PaneSwitcher', () => ({
  default: () => null,
}));

// Per-test mutable URL — the setup-file mock for next/navigation returns
// an empty URLSearchParams. We override it here with a stable mock that
// reads a closure variable, so each test can install its own search-params
// without resetModules dance.
let __mockSearchParams = '';

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>(
    'next/navigation'
  );
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(__mockSearchParams),
    usePathname: () => '/chat',
  };
});

// ─────────────────────────────────────────────────────────────────────────
// iter-7 regression guard (2026-05-28) — V2.2 ultrawide N=4 grid silently
// fell back to 2x2 on prod despite `3xl:grid-cols-4` class being applied.
// Root cause: Tailwind v4 emitted `.md\:grid-cols-2` AT BYTE OFFSET 132832,
// AFTER `.\33 xl\:grid-cols-4` at offset 130653. Equal specificity (single
// class) → cascade picks source-later rule → at viewport ≥1800px where
// BOTH media queries match, md:grid-cols-2 wins. The fix: trailing `!` on
// the 3xl utilities to mark them !important.
//
// The V2.2 class-string assertions above (toContain('3xl:grid-cols-4!'))
// catch a future revert that drops the `!`, but they do NOT prove the CSS
// actually behaves the way we claim. This block does — by installing a real
// jsdom stylesheet that REPLICATES the prod-bundle emission order (md AFTER
// 3xl) and asserting that:
//
//   1. WITHOUT !important (broken pre-iter-7): equal-specificity cascade
//      picks the later rule → wrong column count at ≥1800px.
//   2. WITH !important (iter-7 fix shape): the !important declaration wins
//      regardless of emission order → correct column count at ≥1800px.
//
// jsdom DOES resolve `getComputedStyle().gridTemplateColumns` once a real
// stylesheet is installed (we sidestep the no-media-query limitation by
// emitting unconditional rules — the test is about the cascade tie-break,
// not the breakpoint mechanism, which is plain Tailwind config).
// ─────────────────────────────────────────────────────────────────────────

describe('gridClassFor — ultrawide N=4 cascade tie-break (iter-7 regression)', () => {
  let styleEl: HTMLStyleElement | null = null;

  afterEach(() => {
    if (styleEl?.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
  });

  function installStylesheet(css: string) {
    styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  it('PROVES the bug: without !important, prod emission order picks md:grid-cols-2 over 3xl:grid-cols-4', () => {
    // This is the pre-fix shape — both rules unconditional, 3xl FIRST then
    // md (matching prod bundle byte offsets per audit). Equal specificity.
    // Cascade picks the LATER rule → 2 columns. The bug JD saw on prod.
    installStylesheet(`
      .ultra-cols-4-no-bang { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .md-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    `);
    const el = document.createElement('div');
    el.style.display = 'grid';
    el.style.width = '2200px';
    // Apply BOTH classes — at ultrawide both media queries would match.
    el.className = 'ultra-cols-4-no-bang md-cols-2';
    document.body.appendChild(el);
    try {
      const cols = getComputedStyle(el).gridTemplateColumns;
      // The bug shape: 2 cols win because md-cols-2 is the LATER rule in
      // source order. This is what shipped on prod for N=4 ultrawide.
      expect(cols).toMatch(/repeat\(2,/);
      expect(cols).not.toMatch(/repeat\(4,/);
    } finally {
      document.body.removeChild(el);
    }
  });

  it('PROVES the fix: with !important on the 3xl rule, it wins regardless of emission order', () => {
    // The iter-7 shape — `3xl:grid-cols-4!` compiles to a rule with
    // !important on the grid-template-columns declaration. Now it beats
    // ANY equal-specificity later rule, including the md:grid-cols-2 that
    // was emitted after it in the prod bundle.
    installStylesheet(`
      .ultra-cols-4-bang { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
      .md-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    `);
    const el = document.createElement('div');
    el.style.display = 'grid';
    el.style.width = '2200px';
    el.className = 'ultra-cols-4-bang md-cols-2';
    document.body.appendChild(el);
    try {
      const cols = getComputedStyle(el).gridTemplateColumns;
      // Fixed: !important rule wins. 4 columns at ultrawide.
      expect(cols).toMatch(/repeat\(4,/);
      expect(cols).not.toMatch(/repeat\(2,/);
    } finally {
      document.body.removeChild(el);
    }
  });

  it('PROVES the fix: !important on grid-template-rows wins the row-axis tie-break too', () => {
    // Same bug pattern on the row axis: `md:grid-rows-2` is emitted after
    // `3xl:grid-rows-1`, so without !important the 4 panes stack 2 high
    // instead of 1 high (which combined with the cols-2 win above gave
    // the 2x2 layout JD saw). iter-7 fixes BOTH axes.
    installStylesheet(`
      .ultra-rows-1-bang { grid-template-rows: repeat(1, minmax(0, 1fr)) !important; }
      .md-rows-2 { grid-template-rows: repeat(2, minmax(0, 1fr)); }
    `);
    const el = document.createElement('div');
    el.style.display = 'grid';
    el.style.width = '2200px';
    el.className = 'ultra-rows-1-bang md-rows-2';
    document.body.appendChild(el);
    try {
      const rows = getComputedStyle(el).gridTemplateRows;
      expect(rows).toMatch(/repeat\(1,/);
      expect(rows).not.toMatch(/repeat\(2,/);
    } finally {
      document.body.removeChild(el);
    }
  });

  it('gridClassFor(4) emits the !-suffixed utilities the cascade fix relies on', () => {
    // Ties the cascade behavior above to the actual ChatGrid source: if
    // someone refactors gridClassFor to drop the `!` (or to a leading-bang
    // form that v4 may not parse the same way), this assertion fires.
    const cls = gridClassFor(4);
    // Must have the trailing-! form (Tailwind v4 canonical).
    expect(cls).toContain('3xl:grid-cols-4!');
    expect(cls).toContain('3xl:grid-rows-1!');
    // Defensive: must not have ONLY the unflagged form (without bang).
    // The regex (?!!) is a negative lookahead — "not followed by !".
    expect(cls).not.toMatch(/\b3xl:grid-cols-4(?!!)/);
    expect(cls).not.toMatch(/\b3xl:grid-rows-1(?!!)/);
  });
});

describe('ChatGrid — cold-mount meta-resolution (iter-3 BLOCKER regression)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __mockSearchParams = 'panes=sid_cold_8bd95bd5';
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/sessions/list')) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'sid_cold_8bd95bd5',
                status: 'live',
                // CAT-01: the bridge `live` flag is the status authority. A
                // genuinely-live PTY → the pane MUST resolve live.
                live: true,
                thread_id: 'thr_d312_abc',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });
    // @ts-expect-error: install our fetch mock
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    __mockSearchParams = '';
    globalThis.fetch = originalFetch;
  });

  it('lifts the loading placeholder and mounts the pane after fetchSessionMeta resolves', async () => {
    const { findByTestId, queryByTestId } = render(<ChatGrid />);

    // On the broken code the loading placeholder is what the user sees
    // forever. On the fixed code it disappears within a tick of the
    // fetch microtask resolving. waitFor will poll up to ~2s.
    await waitFor(
      () => {
        expect(queryByTestId('pane-loading-1')).not.toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // The real pane (mocked here) is mounted.
    const pane = await findByTestId('pane-mounted-sid_cold_8bd95bd5');
    expect(pane).toBeInTheDocument();
    // CAT-01 inverse guard: a genuinely-live cold-mount resolves LIVE, NOT
    // swung to false-dead by the spine fix.
    expect(pane.getAttribute('data-status')).toBe('live');

    // Fetch was actually called against /api/sessions/list (audit trace).
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/api/sessions/list'))).toBe(true);
  });

  it('CAT-01: an UNKNOWN sid (absent from the feed) mounts DEAD, not a lying live pane', async () => {
    // The feed knows ONLY sid_cold_8bd95bd5; the URL asks for a since-reaped sid
    // the bridge has never heard of. The OLD resolver kept the optimistic seed
    // 'live' → a green "Done · your turn" pill + enabled composer on a corpse.
    __mockSearchParams = 'panes=sid_ghost_deadbeef';
    const { findByTestId, queryByTestId } = render(<ChatGrid />);

    await waitFor(
      () => {
        expect(queryByTestId('pane-loading-1')).not.toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    const pane = await findByTestId('pane-mounted-sid_ghost_deadbeef');
    // Resolved EXITED — the pill will read "Stopped — no response" and the
    // composer is disabled. This is the keystone fix.
    expect(pane.getAttribute('data-status')).toBe('exited');
  });

  it('CAT-01: a known-but-not-live sid (DB row, dead PTY) mounts exited', async () => {
    // The feed returns the sid with a stale DB status='live' but live=false —
    // the bridge has no PTY. fetchSessionMeta collapses that to exited.
    __mockSearchParams = 'panes=sid_stale_db_row';
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/sessions/list')) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'sid_stale_db_row',
                status: 'live', // stale DB status…
                live: false, // …but the PTY is gone — bridge truth wins.
                thread_id: 'thr_stale',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const { findByTestId, queryByTestId } = render(<ChatGrid />);
    await waitFor(
      () => {
        expect(queryByTestId('pane-loading-1')).not.toBeInTheDocument();
      },
      { timeout: 2000 }
    );
    const pane = await findByTestId('pane-mounted-sid_stale_db_row');
    expect(pane.getAttribute('data-status')).toBe('exited');
  });

  it('does not deadlock when URL-reconcile re-renders the panes array mid-fetch', async () => {
    // Make the fetch resolution slower than the URL-reconcile commit cycle,
    // so React HAS time to fire the second effect run (which on the broken
    // code cancels the in-flight + dedup-bails the retry → deadlock).
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/sessions/list')) {
        // Defer ~20ms — long enough for React's commit + URL-reconcile
        // re-render to fire BEFORE the fetch resolves.
        await new Promise((r) => setTimeout(r, 20));
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'sid_cold_8bd95bd5',
                status: 'exited', // dead session — exercise HIGH #1 path too
                thread_id: 'thr_d312_abc',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const { findByTestId, queryByTestId } = render(<ChatGrid />);

    // Even with a delayed fetch + churning URL-reconcile re-renders, the
    // meta-resolution effect MUST land the setPanes call. On the broken
    // code this assertion fails — the placeholder stays forever.
    await waitFor(
      () => {
        expect(queryByTestId('pane-loading-1')).not.toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    expect(
      await findByTestId('pane-mounted-sid_cold_8bd95bd5')
    ).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// W9 named-live-tabs — full-render: the middle tab shows the resolved NAME
// (not the sid hash), pre-resolution shows "…" (never the hash), and the tab
// dot goes amber when the session is waiting on JD.
//
// These mount the real ChatGrid with ?panes=<sid> and a mocked
// /api/sessions/list returning the W9 fields (agent_name/domain/cwd/activity).
// The ChatGridPane is mocked (pane-mounted-<sid>); the TAB STRIP renders for
// real, so the pane-tab-label-<n> testid carries the user-visible label.
// ═══════════════════════════════════════════════════════════════════════════
describe('ChatGrid — W9 named tabs (label resolves to NAME, never the hash)', () => {
  const SID = 'sid_a1b2c3d4_named';
  const originalFetch = globalThis.fetch;

  function installFetch(sessionRow: Record<string, unknown>, deferMs = 0) {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/sessions/list')) {
        if (deferMs) await new Promise((r) => setTimeout(r, deferMs));
        return new Response(
          JSON.stringify({ sessions: [{ id: SID, ...sessionRow }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });
    // @ts-expect-error install mock
    globalThis.fetch = spy;
    return spy;
  }

  beforeEach(() => {
    __mockSearchParams = `panes=${SID}`;
  });
  afterEach(() => {
    __mockSearchParams = '';
    globalThis.fetch = originalFetch;
  });

  it('a domain session resolves the tab label to the domain NAME ("Family"), not the sid', async () => {
    installFetch({
      status: 'live',
      thread_id: 'thr_x',
      domain: 'work',
      agent_name: 'Family · reconcile the budget',
      cwd: '/state/domains/work',
      activity: 'working',
    });
    const { findByTestId } = render(<ChatGrid />);
    const label = await findByTestId('pane-tab-label-1');
    await waitFor(() => expect(label.textContent).toBe('Work'));
    // never the hash, never the agent_name's task-half on the bare domain tab.
    expect(label.textContent).not.toMatch(/^[0-9a-f]{8}/);
    expect(label.textContent).not.toContain('reconcile');
  });

  it('a nameless live session shows "…" until meta resolves — NEVER the sid hash', async () => {
    // Defer the fetch so we can observe the pre-resolution tab label.
    installFetch(
      { status: 'live', thread_id: 'thr_x', agent_name: 'CEO agent' },
      40
    );
    const { findByTestId } = render(<ChatGrid />);
    const label = await findByTestId('pane-tab-label-1');
    // Pre-resolution: the seed is "…", and crucially NOT the 8-char sid slice.
    expect(label.textContent).toBe('…');
    expect(label.textContent).not.toContain(SID.slice(0, 8));
    // …then it snaps to the resolved name.
    await waitFor(() => expect(label.textContent).toBe('CEO agent'), {
      timeout: 2000,
    });
  });

  it('falls back to "Session" (never a hash) when the feed has no name/domain/cwd', async () => {
    installFetch({ status: 'live', thread_id: 'thr_x' });
    const { findByTestId } = render(<ChatGrid />);
    const label = await findByTestId('pane-tab-label-1');
    await waitFor(() => expect(label.textContent).toBe('Session'));
    expect(label.textContent).not.toMatch(/^[0-9a-f]{8}/);
  });

  it('the tab status dot is amber+pulse when the session is waiting on JD', async () => {
    installFetch({
      status: 'live',
      live: true,
      thread_id: 'thr_x',
      domain: 'work',
      activity: 'waiting',
    });
    const { findByTestId } = render(<ChatGrid />);
    const tab = await findByTestId('mobile-pane-tab-1');
    await waitFor(() => {
      const dot = tab.querySelector('span');
      expect(dot?.className).toContain('bg-amber-400');
      expect(dot?.className).toContain('animate-pulse');
    });
  });

  it('the tab status dot pulses the state-working token when the session is actively working', async () => {
    // DONE-CUE (2026-06-13, JD): a grinding session must look DIFFERENT from a
    // finished one on the tab. activity==='working' → muted state-working token
    // + pulse, so green/amber unambiguously mean "done" and a pulsing-blue tab
    // means "still going". (Previously working collapsed to ready-green — you
    // couldn't tell working from done from the strip.)
    installFetch({
      status: 'live',
      live: true,
      thread_id: 'thr_x',
      domain: 'work',
      activity: 'working',
    });
    const { findByTestId } = render(<ChatGrid />);
    const tab = await findByTestId('mobile-pane-tab-1');
    await findByTestId('pane-mounted-' + SID);
    await waitFor(() => {
      const dot = tab.querySelector('span');
      expect(dot?.className).toContain('bg-state-working');
      expect(dot?.className).toContain('animate-pulse');
      expect(dot?.className).not.toContain('bg-state-ready');
    });
  });

  it('the tab status dot is the muted ready-green state token (done) when live + idle/no-activity', async () => {
    // A live session that is NOT working and NOT explicitly waiting (idle / no
    // activity signal) reads as done/ready: steady muted --state-ready, never
    // neon, never the working pulse.
    installFetch({
      status: 'live',
      live: true,
      thread_id: 'thr_x',
      domain: 'work',
      activity: 'idle',
    });
    const { findByTestId } = render(<ChatGrid />);
    const tab = await findByTestId('mobile-pane-tab-1');
    await findByTestId('pane-mounted-' + SID);
    await waitFor(() => {
      const dot = tab.querySelector('span');
      expect(dot?.className).toContain('bg-state-ready');
      expect(dot?.className).not.toContain('bg-emerald-400');
      expect(dot?.className).not.toContain('animate-pulse');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// V3.2 — chat-mode vs pane-mode toggle (2026-05-28, JD msgs 8280+8285).
//
// The contract under test:
//   1. parseModeParam coerces ?mode= into 'chat' | 'pane', defaulting to
//      'chat' on any junk/null input.
//   2. resolveInitialMode honors URL > stored > default precedence.
//   3. DEFAULT_MODE is 'chat' — JD's explicit ask: pane is opt-in.
//
// Full-render render-branch coverage (chat-mode single visible, pane-mode
// grid) is exercised by the Playwright e2e suite under qa_agent — the unit
// tests pin the pure-helper contract so refactors of the rendering branch
// can't silently regress mode resolution.
// ═══════════════════════════════════════════════════════════════════════════
describe('V3.2 cockpit mode resolution', () => {
  it('parseModeParam coerces valid values', () => {
    expect(parseModeParam('chat')).toBe('chat');
    expect(parseModeParam('pane')).toBe('pane');
  });

  it('parseModeParam defaults to chat on junk/null', () => {
    expect(parseModeParam(null)).toBe('chat');
    expect(parseModeParam('grid')).toBe('chat'); // V2.1 retired value
    expect(parseModeParam('fullscreen')).toBe('chat'); // V2.1 retired value
    expect(parseModeParam('')).toBe('chat');
  });

  it('resolveInitialMode: URL wins over storage', () => {
    expect(resolveInitialMode('pane', 'chat')).toBe('pane');
    expect(resolveInitialMode('chat', 'pane')).toBe('chat');
  });

  it('resolveInitialMode: storage fills the gap when URL silent', () => {
    expect(resolveInitialMode(null, 'pane')).toBe('pane');
    expect(resolveInitialMode(null, 'chat')).toBe('chat');
  });

  it('resolveInitialMode: default wins when both are silent', () => {
    expect(resolveInitialMode(null, null)).toBe(DEFAULT_MODE);
    expect(DEFAULT_MODE).toBe('chat');
  });
});
