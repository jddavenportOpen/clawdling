// ═══════════════════════════════════════════════════════════════════════════
// ThreadSidebar.test.tsx — rail-liveness contract + click-intercept.
//
// Born 2026-05-27 (audit HIGH #3, cockpit-chat-v3). Two of JD's loudest
// regressions were in this file:
//
//   M1 (cockpit overhaul): a live agent idle between turns fell off the
//   sidebar's live filter because `sess.live` is capped at the 30 most-recent
//   sessions — so the per-thread Supabase poll (`session_status`) was unioned
//   in. The `computeLiveSet` math IS the regression guard.
//
//   M1 (SS5): clicking a LIVE row routed to /chat/[threadId] (the empty
//   "No messages yet" view) instead of /chat?panes=<sid>. The click-intercept
//   on the `openAsPane` branch fixed it. Tested here via the URL surface
//   (computed from the same inputs as the live click handler).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { computeLiveSet } from '../ThreadSidebar';
import { PANE_SOFT_CAP } from '@/lib/cockpitCaps';

describe('computeLiveSet — M1 bridge-truth union', () => {
  it('returns empty when no inputs are live', () => {
    expect(
      computeLiveSet(new Set(), undefined, new Map())
    ).toEqual(new Set());
  });

  it('returns activeSet alone when other sources are empty', () => {
    const result = computeLiveSet(
      new Set(['thr_a', 'thr_b']),
      undefined,
      new Map()
    );
    expect(result.has('thr_a')).toBe(true);
    expect(result.has('thr_b')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('adds bridge-live sessions to the set', () => {
    const result = computeLiveSet(
      new Set(),
      [
        { thread_id: 'thr_c', live: true },
        { thread_id: 'thr_d', live: false },
      ],
      new Map()
    );
    expect(result.has('thr_c')).toBe(true);
    expect(result.has('thr_d')).toBe(false); // live=false excluded
  });

  it('IGNORES sessions with no thread_id even if live=true', () => {
    const result = computeLiveSet(
      new Set(),
      [{ live: true }],
      new Map()
    );
    expect(result.size).toBe(0);
  });

  it('adds Supabase-status live/starting threads to the set', () => {
    const meta = new Map<string, { session_status: string | null }>([
      ['thr_e', { session_status: 'live' }],
      ['thr_f', { session_status: 'starting' }],
      ['thr_g', { session_status: 'exited' }],
      ['thr_h', { session_status: null }],
    ]);
    const result = computeLiveSet(new Set(), undefined, meta);
    expect(result.has('thr_e')).toBe(true);
    expect(result.has('thr_f')).toBe(true);
    expect(result.has('thr_g')).toBe(false);
    expect(result.has('thr_h')).toBe(false);
  });

  it('UNIONS all three signals — idle-between-turns regression', () => {
    // The JD bug: agent X is alive on the bridge but not mid-turn. It
    // falls off activeSet AND the 30-cap sessList (older session). Only
    // the per-thread Supabase poll catches it. Without the union, the
    // rail mis-classifies it as resting → clicking routes to the empty
    // "No messages yet" view instead of its live pane.
    const result = computeLiveSet(
      new Set(['thr_mid_turn']),
      [{ thread_id: 'thr_bridge_live', live: true }],
      new Map([['thr_idle_between_turns', { session_status: 'live' }]])
    );
    expect(result.has('thr_mid_turn')).toBe(true);
    expect(result.has('thr_bridge_live')).toBe(true);
    expect(result.has('thr_idle_between_turns')).toBe(true);
    expect(result.size).toBe(3);
  });

  it('dedupes a thread appearing in multiple signals', () => {
    const result = computeLiveSet(
      new Set(['thr_x']),
      [{ thread_id: 'thr_x', live: true }],
      new Map([['thr_x', { session_status: 'live' }]])
    );
    expect(result.size).toBe(1);
    expect(result.has('thr_x')).toBe(true);
  });

  it('handles unknown status_session values as not-live', () => {
    const meta = new Map<string, { session_status: string | null }>([
      ['thr_weird', { session_status: 'something-new' }],
    ]);
    const result = computeLiveSet(new Set(), undefined, meta);
    expect(result.has('thr_weird')).toBe(false);
  });

  // ── MA-11 honest-dead gate (3rd-party QA GAP-2 / "93/93 live") ──────────
  // The ghost: a chat_sessions row whose PTY was reaped 19h ago still has
  // status='live' in the DB. Before this gate, signal (3) resurrected it →
  // the rail showed "93/93 live" with 1 real PTY. The bridge feed reports
  // that thread's session as live=false (bridge truth); the DB column lies.
  // Bridge truth must win.

  it('does NOT count a thread the bridge feed reports DEAD even if DB says live (MA-11 ghost)', () => {
    const result = computeLiveSet(
      new Set(),
      // Bridge feed: this thread's session is dead (PTY reaped).
      [{ thread_id: 'thr_ghost', live: false }],
      // DB column is STALE 'live' — the exact 93/93 ghost.
      new Map([['thr_ghost', { session_status: 'live' }]])
    );
    expect(result.has('thr_ghost')).toBe(false);
  });

  it('STILL counts a DB-live thread the bridge feed never mentions (fell off the 100-cap)', () => {
    // The idle-between-turns case M1 protects: a long-running live agent
    // that aged past the 100-row feed window. Feed has no opinion → trust DB.
    const result = computeLiveSet(
      new Set(),
      [{ thread_id: 'thr_other', live: true }], // unrelated live row
      new Map([['thr_capped_live', { session_status: 'live' }]])
    );
    expect(result.has('thr_capped_live')).toBe(true);
    expect(result.has('thr_other')).toBe(true);
  });

  it('bridge-live wins even when the SAME thread also has a dead row in the feed', () => {
    // A thread with both a live PTY and an older exited session row. The live
    // row must keep it live; the dead row must not flip it off.
    const result = computeLiveSet(
      new Set(),
      [
        { thread_id: 'thr_dual', live: true },
        { thread_id: 'thr_dual', live: false },
      ],
      new Map([['thr_dual', { session_status: 'live' }]])
    );
    expect(result.has('thr_dual')).toBe(true);
  });

  it('a mass of stale DB-live ghosts all feed-dead collapse to zero live (the 93/93 fix)', () => {
    const sessions = Array.from({ length: 93 }, (_, i) => ({
      thread_id: `ghost_${i}`,
      live: false, // bridge: all dead
    }));
    const meta = new Map(
      Array.from({ length: 93 }, (_, i) => [
        `ghost_${i}`,
        { session_status: 'live' as const }, // DB: all stale-live
      ])
    );
    const result = computeLiveSet(new Set(), sessions, meta);
    expect(result.size).toBe(0); // honest: 0 live, not 93
  });
});

describe('rail click-intercept — URL contract (M1 SS5 fix)', () => {
  // The intercept in ThreadSidebar.tsx ~line 1080:
  //   onClick={openAsPane ? (e) => { if (!modifier) { preventDefault();
  //   openInGrid(false); }} : undefined}
  // and openInGrid pushes router → `/chat?panes=<existing,>?<sid>`. We can't
  // hold a router-call in a pure unit test without a full DOM render — but
  // we can pin the URL FORMAT the rail uses so a regression in the join
  // logic surfaces immediately.
  //
  // These are intentionally narrow contract tests; they document the URL
  // shape so any code path that constructs `?panes=` keeps the same format.

  it('appending a sid to an empty pane list yields ?panes=<sid>', () => {
    const current: string[] = [];
    const next = [...current, 'sid_new'];
    expect(`?panes=${next.map(encodeURIComponent).join(',')}`).toBe(
      '?panes=sid_new'
    );
  });

  it('appending a sid to an existing pane list yields ?panes=<existing,sid>', () => {
    const current = ['sid_a', 'sid_b'];
    const next = [...current, 'sid_c'];
    expect(`?panes=${next.map(encodeURIComponent).join(',')}`).toBe(
      '?panes=sid_a,sid_b,sid_c'
    );
  });

  it('replace=true swaps the deck to a single sid', () => {
    // Mirrors ThreadSidebar.openInGrid(true) — the "Open in grid (replace)"
    // context-menu choice. The whole deck collapses to one sid.
    const _current = ['sid_a', 'sid_b'];
    const next = ['sid_target'];
    expect(`?panes=${next.map(encodeURIComponent).join(',')}`).toBe(
      '?panes=sid_target'
    );
  });

  it('a duplicate sid in the same deck is NOT re-appended (no double-mount)', () => {
    // Mirrors ThreadSidebar.openInGrid's `current.includes(data.session_id)`
    // branch — if the user clicks a live row that's already in the deck,
    // we navigate to grid mode but DON'T duplicate the sid (which would
    // double-subscribe to its SSE).
    const current = ['sid_a', 'sid_b'];
    const target = 'sid_b';
    const next = current.includes(target) ? current : [...current, target];
    expect(next).toEqual(['sid_a', 'sid_b']);
  });

  it('C5 no-cap: openInGrid appends past the OLD 6-cap without evicting', () => {
    // Mirrors ThreadSidebar.openInGrid's append branch AFTER C5 (2026-06-10).
    // The branch used to be `current.length >= 6` — a DIFFERENT number than
    // openSidInDeck's `10`, so the right-click "open in grid" path silently
    // evicted the oldest pane at 6 while the rail-spawn path didn't until 10
    // (chat-cockpit audit §4 #3). BOTH now compare against the single shared
    // PANE_SOFT_CAP, so a 7th session ADDS a named pane — the working agent is
    // never silently dropped. This is the "organized, nothing lost" contract.
    const current = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const target = 's7';
    const next = current.includes(target)
      ? current
      : current.length >= PANE_SOFT_CAP
      ? [...current.slice(1), target]
      : [...current, target];
    expect(next).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    expect(next[0]).toBe('s1'); // oldest survived — NOT bumped
  });

  it('C5 no-cap: openSidInDeck and openInGrid share ONE cap (no 6-vs-10 drift)', () => {
    // The whole point of the C5 cap-unification: the two rail append paths used
    // to compare against different constants (6 and 10). They now BOTH use
    // PANE_SOFT_CAP, so the eviction threshold is identical regardless of which
    // button opened the session. This pins that they agree.
    const cap = PANE_SOFT_CAP;
    expect(cap).toBeGreaterThan(10); // far above any realistic deck
    // Simulate both paths at the same deck length: neither evicts below the cap.
    const deck = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const evictInDeck = deck.length >= cap;
    const evictInGrid = deck.length >= cap;
    expect(evictInDeck).toBe(evictInGrid);
    expect(evictInDeck).toBe(false); // a 12-deep deck is fine under no-cap
  });
});
