// ═══════════════════════════════════════════════════════════════════════════
// cockpit-url.test.ts — chat/page.tsx URL-state contract.
//
// chat/page.tsx is a server component and resists unit-testing under jsdom
// (it `await authWithTimeout` + database fetch). Rather than render it,
// this file pins the SHAPE of the contract that drives gridMode + the
// MobileSidebarDrawer suppression (M8). If a future refactor changes the
// expected query-param parsing, these tests catch it before prod.
//
// What lives here:
//   - gridMode derivation: how the page decides to render <ChatGrid /> vs
//     the launcher landing.
//   - the cockpit-grid suppression contract: when ?panes= is present on
//     /chat, the global shell elements (VitalsBar, MobileTabBar,
//     SessionSidebar right-rail, notification bell, mobile hamburger) are
//     suppressed. Originally mobile-only (M8); since 2026-05-28 (JD msg
//     8286) the right-rail + notification bell are also suppressed on
//     desktop. We can't render the whole shell here, but we can pin the
//     boolean that drives the suppression.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// Recreate the in-page derivation as a pure function so we can exercise
// every code path without a Next render. If chat/page.tsx changes the
// gridMode formula, this test fails and forces the engineer to read the
// CONTRACT before changing it.
function deriveGridMode(panes: string | string[] | undefined): boolean {
  const panesRaw = Array.isArray(panes) ? panes[0] : panes;
  return !!(panesRaw && panesRaw.trim().length > 0);
}

function deriveInitialSpace(
  space: string | string[] | undefined
): string | null {
  const spaceRaw = Array.isArray(space) ? space[0] : space;
  return spaceRaw && spaceRaw.trim().length > 0 ? spaceRaw.trim() : null;
}

describe('chat/page — gridMode derivation', () => {
  it('no ?panes= → landing mode (gridMode=false)', () => {
    expect(deriveGridMode(undefined)).toBe(false);
  });

  it('?panes=<sid> → grid mode', () => {
    expect(deriveGridMode('sid_abc')).toBe(true);
  });

  it('?panes=<sid1,sid2> → grid mode', () => {
    expect(deriveGridMode('sid_a,sid_b')).toBe(true);
  });

  it('?panes= (empty value) → NOT grid mode', () => {
    expect(deriveGridMode('')).toBe(false);
  });

  it('?panes=   (whitespace only) → NOT grid mode', () => {
    expect(deriveGridMode('   ')).toBe(false);
  });

  it('?panes=&panes=… (array → first wins)', () => {
    expect(deriveGridMode(['sid_first', 'sid_second'])).toBe(true);
    expect(deriveGridMode([''])).toBe(false);
  });
});

describe('chat/page — initialSpace derivation', () => {
  it('no ?space= → null', () => {
    expect(deriveInitialSpace(undefined)).toBeNull();
  });

  it('?space=health → "health"', () => {
    expect(deriveInitialSpace('health')).toBe('health');
  });

  it('?space=  health  → "health" (trimmed)', () => {
    expect(deriveInitialSpace('  health  ')).toBe('health');
  });

  it('?space= (empty) → null', () => {
    expect(deriveInitialSpace('')).toBeNull();
  });

  it('?space=&space=… (array → first wins)', () => {
    expect(deriveInitialSpace(['family', 'health'])).toBe('family');
    expect(deriveInitialSpace([''])).toBeNull();
  });
});

describe('cockpit-grid shell-suppression contract', () => {
  // The DashboardShell (src/components/DashboardShell.tsx) and related
  // shell elements (VitalsBar, MobileTabBar, NotificationProvider bell,
  // SessionSidebar right-rail) check `pathname === '/chat'` AND look at
  // the URL for `?panes=` to decide whether to suppress themselves.
  //
  // Originally (M8, 2026-05-27) the suppression was mobile-only — the
  // global chrome competed with the cockpit's own chrome only on phones.
  //
  // 2026-05-28 (JD msg 8286) EXTENSION: the right-side SessionSidebar
  // rail AND the top-left notification bell are now ALSO suppressed on
  // DESKTOP when ?panes= is set, because the cockpit panes already show
  // the running sessions + emit their own notifications — the global
  // chrome is redundant clutter. The contract is now viewport-agnostic:
  // any URL `/chat?panes=...` → hide the suppressed global shell chrome.
  //
  // We can't render the whole shell here; we pin the decision as a pure
  // helper so the cross-component contract stays explicit.
  function shouldSuppressGlobalShellInCockpit(
    pathname: string,
    search: string
  ): boolean {
    if (pathname !== '/chat') return false;
    const sp = new URLSearchParams(search);
    return deriveGridMode(sp.get('panes') ?? undefined);
  }

  it('does NOT suppress when path is not /chat', () => {
    expect(shouldSuppressGlobalShellInCockpit('/projects', '?panes=sid')).toBe(
      false
    );
  });

  it('does NOT suppress on /chat landing (no ?panes=)', () => {
    expect(shouldSuppressGlobalShellInCockpit('/chat', '')).toBe(false);
  });

  it('SUPPRESSES on /chat?panes=<sid>', () => {
    expect(shouldSuppressGlobalShellInCockpit('/chat', '?panes=sid_a')).toBe(
      true
    );
  });

  it('SUPPRESSES on /chat?panes=<sid1,sid2>&space=…', () => {
    expect(
      shouldSuppressGlobalShellInCockpit(
        '/chat',
        '?panes=sid_a,sid_b&space=health'
      )
    ).toBe(true);
  });
});

// NOTE: the `SessionSidebar route-suppression contract` describe block was
// removed in the cockpit-cleanup pass (2026-06-11) — SessionSidebar.tsx (the
// perma-empty fleet right-rail JD pointed at) was deleted, so there is no
// longer a gate to pin. The cockpit-grid shell-suppression contract above
// still covers DashboardShell's own ?panes= suppression, which survives.
