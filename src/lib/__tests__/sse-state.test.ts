// ═══════════════════════════════════════════════════════════════════════════
// sse-state.test.ts — table-test the SSE state machine (P0.6).
//
// Pure unit test of the reducer in src/lib/sse-state.ts. Asserts every
// documented (state × event) → state transition matches spec. Runs via
// Node 20+ built-in test runner with native TS-strip:
//
//   node --test --experimental-strip-types src/lib/__tests__/sse-state.test.ts
//
// The transition table here IS the contract. If you change the reducer,
// change this table to match — and read the diff carefully, because every
// row is a user-visible badge transition in the live pane.
// ═══════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  sseStateReducer,
  badgeForState,
  __setNowForTesting,
  __resetNowForTesting,
  type SseEvent,
  type SseState,
  type SseStateKind,
} from '../sse-state.ts';

// ── Deterministic clock ─────────────────────────────────────────────────────

let clockMs = 1_000_000;
test.beforeEach(() => {
  clockMs = 1_000_000;
  __setNowForTesting(() => clockMs);
});
test.afterEach(() => {
  __resetNowForTesting();
});
function tick(ms = 100) {
  clockMs += ms;
}

// ── Transition table ────────────────────────────────────────────────────────
//
// Each row: from-state, event, expected to-state. Order = the order the
// state-machine reducer code branches; keeping this aligned makes diff
// review faster when the reducer changes.

interface Row {
  from: SseStateKind;
  event: SseEvent;
  to: SseStateKind;
  /** Whether `since` should advance (true = real transition, false = no-op). */
  sinceAdvances: boolean;
  note?: string;
}

const TABLE: Row[] = [
  // INITIAL
  { from: 'INITIAL', event: { type: 'HISTORY_LOADED' }, to: 'SYNCING', sinceAdvances: true },
  { from: 'INITIAL', event: { type: 'FIRST_LIVE_EVENT' }, to: 'LIVE', sinceAdvances: true, note: 'fast path: live before history resolves' },
  { from: 'INITIAL', event: { type: 'SESSION_ENDED' }, to: 'ENDED', sinceAdvances: true },
  { from: 'INITIAL', event: { type: 'BRIDGE_ERROR', error: 'boom' }, to: 'ERROR', sinceAdvances: true },
  { from: 'INITIAL', event: { type: 'SSE_CLOSED' }, to: 'RECONNECT', sinceAdvances: true, note: 'never opened, bounce to retry loop' },
  { from: 'INITIAL', event: { type: 'SSE_RECONNECTED' }, to: 'INITIAL', sinceAdvances: false, note: 'unknown event = no-op' },
  { from: 'INITIAL', event: { type: 'MANUAL_RELOAD' }, to: 'INITIAL', sinceAdvances: false, note: 'no-op in healthy state' },

  // SYNCING
  { from: 'SYNCING', event: { type: 'FIRST_LIVE_EVENT' }, to: 'LIVE', sinceAdvances: true },
  { from: 'SYNCING', event: { type: 'SSE_CLOSED' }, to: 'RECONNECT', sinceAdvances: true },
  { from: 'SYNCING', event: { type: 'SESSION_ENDED' }, to: 'ENDED', sinceAdvances: true },
  { from: 'SYNCING', event: { type: 'BRIDGE_ERROR', error: 'oops' }, to: 'ERROR', sinceAdvances: true },
  { from: 'SYNCING', event: { type: 'HISTORY_LOADED' }, to: 'SYNCING', sinceAdvances: false, note: 'idempotent — don\'t flicker since' },
  { from: 'SYNCING', event: { type: 'SSE_RECONNECTED' }, to: 'SYNCING', sinceAdvances: false },
  { from: 'SYNCING', event: { type: 'MANUAL_RELOAD' }, to: 'SYNCING', sinceAdvances: false },

  // LIVE
  { from: 'LIVE', event: { type: 'SSE_CLOSED' }, to: 'RECONNECT', sinceAdvances: true },
  { from: 'LIVE', event: { type: 'SESSION_ENDED' }, to: 'ENDED', sinceAdvances: true },
  { from: 'LIVE', event: { type: 'BRIDGE_ERROR', error: 'boom' }, to: 'ERROR', sinceAdvances: true },
  { from: 'LIVE', event: { type: 'FIRST_LIVE_EVENT' }, to: 'LIVE', sinceAdvances: false, note: 'already live' },
  { from: 'LIVE', event: { type: 'HISTORY_LOADED' }, to: 'LIVE', sinceAdvances: false },
  { from: 'LIVE', event: { type: 'SSE_RECONNECTED' }, to: 'LIVE', sinceAdvances: false },
  { from: 'LIVE', event: { type: 'MANUAL_RELOAD' }, to: 'LIVE', sinceAdvances: false },

  // RECONNECT
  { from: 'RECONNECT', event: { type: 'SSE_RECONNECTED' }, to: 'LIVE', sinceAdvances: true },
  { from: 'RECONNECT', event: { type: 'FIRST_LIVE_EVENT' }, to: 'LIVE', sinceAdvances: true, note: 'first frame = self-heal' },
  { from: 'RECONNECT', event: { type: 'SESSION_ENDED' }, to: 'ENDED', sinceAdvances: true },
  { from: 'RECONNECT', event: { type: 'BRIDGE_ERROR', error: 'gave up' }, to: 'ERROR', sinceAdvances: true },
  { from: 'RECONNECT', event: { type: 'SSE_CLOSED' }, to: 'RECONNECT', sinceAdvances: false, note: 'preserve since for elapsed counter' },
  { from: 'RECONNECT', event: { type: 'HISTORY_LOADED' }, to: 'RECONNECT', sinceAdvances: false },
  { from: 'RECONNECT', event: { type: 'MANUAL_RELOAD' }, to: 'RECONNECT', sinceAdvances: false },

  // ENDED — terminal
  { from: 'ENDED', event: { type: 'MANUAL_RELOAD' }, to: 'INITIAL', sinceAdvances: true },
  { from: 'ENDED', event: { type: 'HISTORY_LOADED' }, to: 'ENDED', sinceAdvances: false },
  { from: 'ENDED', event: { type: 'FIRST_LIVE_EVENT' }, to: 'ENDED', sinceAdvances: false },
  { from: 'ENDED', event: { type: 'SSE_CLOSED' }, to: 'ENDED', sinceAdvances: false },
  { from: 'ENDED', event: { type: 'SSE_RECONNECTED' }, to: 'ENDED', sinceAdvances: false },
  { from: 'ENDED', event: { type: 'SESSION_ENDED' }, to: 'ENDED', sinceAdvances: false, note: 'already ended' },
  { from: 'ENDED', event: { type: 'BRIDGE_ERROR' }, to: 'ENDED', sinceAdvances: false, note: 'terminal wins over error' },

  // ERROR — recoverable
  { from: 'ERROR', event: { type: 'MANUAL_RELOAD' }, to: 'INITIAL', sinceAdvances: true },
  { from: 'ERROR', event: { type: 'SSE_RECONNECTED' }, to: 'LIVE', sinceAdvances: true, note: 'self-heal' },
  { from: 'ERROR', event: { type: 'FIRST_LIVE_EVENT' }, to: 'LIVE', sinceAdvances: true, note: 'self-heal' },
  { from: 'ERROR', event: { type: 'HISTORY_LOADED' }, to: 'SYNCING', sinceAdvances: true },
  { from: 'ERROR', event: { type: 'SESSION_ENDED' }, to: 'ENDED', sinceAdvances: true },
  { from: 'ERROR', event: { type: 'SSE_CLOSED' }, to: 'ERROR', sinceAdvances: false },

  // SESSION_CRASHED (cockpit-multi-session-v2 P1.4) — bridge died
  // mid-session. Transitions to ERROR with crashedAt set, from any
  // non-terminal state. Spec: "BRIDGE_ERROR → state ERROR" but distinct
  // badge (red + spawn-new) when crashedAt is present.
  { from: 'INITIAL', event: { type: 'SESSION_CRASHED', crashedAt: 1234 }, to: 'ERROR', sinceAdvances: true },
  { from: 'SYNCING', event: { type: 'SESSION_CRASHED', crashedAt: 1234 }, to: 'ERROR', sinceAdvances: true },
  { from: 'LIVE', event: { type: 'SESSION_CRASHED', crashedAt: 1234 }, to: 'ERROR', sinceAdvances: true },
  { from: 'RECONNECT', event: { type: 'SESSION_CRASHED', crashedAt: 1234 }, to: 'ERROR', sinceAdvances: true },
  { from: 'ERROR', event: { type: 'SESSION_CRASHED', crashedAt: 1234 }, to: 'ERROR', sinceAdvances: true, note: 'crash info upgrades a generic ERROR' },
];

// ── Table-driven test ──────────────────────────────────────────────────────

test('every (state × event) transition matches spec', () => {
  for (const row of TABLE) {
    const startSince = 500_000;
    const startState: SseState = { kind: row.from, since: startSince, error: 'prior-error' };
    tick(); // advance clock so any "advances" assertion is meaningful
    const result = sseStateReducer(startState, row.event);
    assert.equal(
      result.kind,
      row.to,
      `from=${row.from} event=${row.event.type} expected→${row.to} got→${result.kind}${row.note ? ` (${row.note})` : ''}`,
    );
    if (row.sinceAdvances) {
      assert.notEqual(
        result.since,
        startSince,
        `from=${row.from} event=${row.event.type}: since should advance on real transition`,
      );
    } else {
      // No-op transitions: state object identity should be preserved when
      // the reducer hits its early-return branches. We assert `since` is
      // exactly the same value (covers both `return state` and shallow
      // updates that don't touch since).
      assert.equal(
        result.since,
        startSince,
        `from=${row.from} event=${row.event.type}: since should NOT advance on no-op`,
      );
    }
  }
});

// ── Targeted property tests ────────────────────────────────────────────────

test('SESSION_ENDED wins from every non-terminal state', () => {
  const nonTerminals: SseStateKind[] = ['INITIAL', 'SYNCING', 'LIVE', 'RECONNECT', 'ERROR'];
  for (const kind of nonTerminals) {
    const s: SseState = { kind, since: 1 };
    const result = sseStateReducer(s, { type: 'SESSION_ENDED' });
    assert.equal(result.kind, 'ENDED', `${kind} should yield to SESSION_ENDED`);
  }
});

test('MANUAL_RELOAD escapes ENDED and ERROR back to INITIAL', () => {
  for (const kind of ['ENDED', 'ERROR'] as SseStateKind[]) {
    const s: SseState = { kind, since: 1 };
    const r = sseStateReducer(s, { type: 'MANUAL_RELOAD' });
    assert.equal(r.kind, 'INITIAL', `MANUAL_RELOAD should reset ${kind} to INITIAL`);
  }
});

test('RECONNECT preserves `since` across repeated SSE_CLOSED (retry storm)', () => {
  // Critical for the "reconnecting 30s" UX — if every retry reset the
  // clock, the user would never see escalating elapsed time.
  let s: SseState = { kind: 'LIVE', since: 1000 };
  tick(50);
  s = sseStateReducer(s, { type: 'SSE_CLOSED' });
  const reconnectSince = s.since;
  assert.equal(s.kind, 'RECONNECT');
  // Simulate 5 retry-loop closes
  for (let i = 0; i < 5; i++) {
    tick(2000);
    s = sseStateReducer(s, { type: 'SSE_CLOSED' });
  }
  assert.equal(s.kind, 'RECONNECT');
  assert.equal(s.since, reconnectSince, 'since must NOT advance across retry-loop closes');
});

test('ERROR re-error updates error text but preserves `since`', () => {
  let s: SseState = { kind: 'ERROR', since: 5000, error: 'first' };
  __setNowForTesting(() => 9999);
  s = sseStateReducer(s, { type: 'BRIDGE_ERROR', error: 'second' });
  assert.equal(s.kind, 'ERROR');
  assert.equal(s.since, 5000, '`since` preserved so elapsed counter is honest');
  assert.equal(s.error, 'second', 'error text updated to latest');
});

test('initialState() returns INITIAL with deterministic since=0', () => {
  const s = initialState();
  assert.equal(s.kind, 'INITIAL');
  assert.equal(s.since, 0, 'since=0 so SSR + first render match deterministically');
});

// ── Badge metadata smoke test ──────────────────────────────────────────────

test('badgeForState covers all 6 states with the spec colors', () => {
  const expected: Record<SseStateKind, { color: string; showReload: boolean; showElapsed: boolean }> = {
    INITIAL: { color: 'gray', showReload: false, showElapsed: false },
    SYNCING: { color: 'cyan', showReload: false, showElapsed: false },
    LIVE: { color: 'green', showReload: false, showElapsed: false },
    RECONNECT: { color: 'amber', showReload: false, showElapsed: true },
    ENDED: { color: 'gray', showReload: false, showElapsed: false },
    ERROR: { color: 'magenta', showReload: true, showElapsed: false },
  };
  for (const [kind, want] of Object.entries(expected) as [SseStateKind, typeof expected[SseStateKind]][]) {
    const badge = badgeForState({ kind, since: 0 });
    assert.equal(badge.color, want.color, `${kind} badge color`);
    assert.equal(badge.showReload, want.showReload, `${kind} showReload`);
    assert.equal(badge.showElapsed, want.showElapsed, `${kind} showElapsed`);
  }
});

// ── cockpit-multi-session-v2 P1.4 — SESSION_CRASHED + crashed badge ─────────

test('SESSION_CRASHED transitions LIVE → ERROR with crashedAt set', () => {
  const s: SseState = { kind: 'LIVE', since: 1000 };
  const r = sseStateReducer(s, { type: 'SESSION_CRASHED', crashedAt: 5000 });
  assert.equal(r.kind, 'ERROR');
  assert.equal(r.crashedAt, 5000);
  assert.equal(r.error, 'agent crashed (bridge restart)');
});

test('SESSION_CRASHED upgrades a generic ERROR with crash info', () => {
  // Common race: connection drops → BRIDGE_ERROR → ERROR. Then the
  // bridge restarts and the crashed event arrives via /history. The
  // crash info is strictly more useful than the generic error, so the
  // reducer must update.
  const s: SseState = { kind: 'ERROR', since: 1000, error: 'connect failed' };
  const r = sseStateReducer(s, { type: 'SESSION_CRASHED', crashedAt: 5000 });
  assert.equal(r.kind, 'ERROR');
  assert.equal(r.crashedAt, 5000);
  assert.equal(r.error, 'agent crashed (bridge restart)');
});

test('SESSION_CRASHED is idempotent for the same crashedAt', () => {
  // Same crash replayed on /history catchup → no state churn (the badge
  // would flicker on every redundant replay otherwise).
  let s: SseState = { kind: 'ERROR', since: 1000, error: 'agent crashed (bridge restart)', crashedAt: 5000 };
  const before = s;
  tick(500);
  s = sseStateReducer(s, { type: 'SESSION_CRASHED', crashedAt: 5000 });
  assert.equal(s, before, 'same crashedAt → identity-preserved');
});

test('SESSION_ENDED wins over a SESSION_CRASHED state', () => {
  // If the bridge somehow emits both (e.g. crashed event in catchup
  // followed by a clean exit frame on live stream — unlikely but
  // possible during a fast restart-and-rejoin), the explicit exit
  // wins. Per the existing "SESSION_ENDED is the hard truth" invariant.
  const s: SseState = { kind: 'ERROR', since: 1000, crashedAt: 5000 };
  const r = sseStateReducer(s, { type: 'SESSION_ENDED' });
  assert.equal(r.kind, 'ENDED');
});

test('MANUAL_RELOAD from crashed-ERROR resets back to INITIAL', () => {
  const s: SseState = { kind: 'ERROR', since: 1000, error: 'agent crashed (bridge restart)', crashedAt: 5000 };
  const r = sseStateReducer(s, { type: 'MANUAL_RELOAD' });
  assert.equal(r.kind, 'INITIAL');
});

test('badgeForState ERROR-crashed: red color + spawn-new button + crash time label', () => {
  // Use a fixed UTC midnight so the HH:MM:SS rendering is deterministic
  // across whatever TZ the test runs in (only the format matters, not
  // the exact local hour).
  const crashedAt = new Date(2026, 4, 23, 14, 32, 7).getTime();
  const badge = badgeForState({ kind: 'ERROR', since: 0, crashedAt });
  assert.equal(badge.color, 'red');
  assert.equal(badge.showSpawnNew, true);
  assert.equal(badge.showReload, false, 'spawn-new replaces reload, not appends');
  assert.match(badge.label, /^agent crashed at \d{2}:\d{2}:\d{2}$/);
});

test('badgeForState ERROR without crashedAt: magenta + reload button (unchanged)', () => {
  const badge = badgeForState({ kind: 'ERROR', since: 0 });
  assert.equal(badge.color, 'magenta');
  assert.equal(badge.showSpawnNew, false);
  assert.equal(badge.showReload, true);
});

// v3-cosmetic-batch (2026-05-28): the PR #97 audit drift fix — ENDED state
// (clean exit / kill button) now offers the same one-click "spawn new" button
// as the CRASHED ERROR state, instead of forcing the user to type into the
// composer placeholder. Both ENDED and CRASHED paths advertise showSpawnNew=true;
// the SessionTerminal renders the button only when a threadId is available
// (no thread → no place to attach the new session, so the button is hidden).
test('badgeForState ENDED: gray check + spawn-new button (v3 cosmetic-batch)', () => {
  const badge = badgeForState({ kind: 'ENDED', since: 0 });
  assert.equal(badge.color, 'gray');
  assert.equal(badge.label, 'ended');
  assert.equal(badge.icon, 'check');
  assert.equal(badge.showSpawnNew, true, 'clean-exit gets the one-click spawn-new affordance');
  assert.equal(badge.showReload, false);
  assert.equal(badge.showElapsed, false);
});
