// ═══════════════════════════════════════════════════════════════════════════
// chat-dvh-gating.test.ts — CAT-08 regression (100dvh vs pb-20 tab-bar fight).
//
// `.chat-dvh` sets height:100dvh on phones. On the NON-cockpit /chat landing the
// parent (DashboardShell) STILL reserves pb-20 (80px) for the fixed MobileTabBar,
// so a full-100dvh surface there pushed the bottom ~80px (footer/composer) UNDER
// the tab bar with `overflow-hidden` clipping it. In gridMode the tab bar is
// suppressed (MobileTabBar returns null, DashboardShell drops the reserve to
// pb-0), so 100dvh is correct ONLY there.
//
// page.tsx is an async Server Component that imports auth/supabase and can't be
// rendered under vitest, so we assert the gating invariant via source: the
// `chat-dvh` class must be applied conditionally on `gridMode`, never bare.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(path.join(here, '..', 'page.tsx'), 'utf8');

describe('chat/page.tsx — chat-dvh gating (CAT-08)', () => {
  it('applies chat-dvh conditionally on gridMode, never unconditionally', () => {
    // It must appear gated behind gridMode (the cockpit-only height authority).
    expect(pageSrc).toMatch(/gridMode\s*\?\s*['"]chat-dvh['"]/);
  });

  it('does not hard-code a bare `chat-dvh ` literal in a static className', () => {
    // Guard against regressing to `className="chat-dvh flex h-full …"` which is
    // what fought the parent pb-20 reserve on the non-cockpit landing.
    expect(pageSrc).not.toMatch(/className="chat-dvh\s/);
    expect(pageSrc).not.toMatch(/className=\{`chat-dvh\s/);
  });
});
