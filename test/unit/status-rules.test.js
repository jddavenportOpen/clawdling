// Computed status (1.7): every rule, its edge cases, and the receipt on every reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_THRESHOLDS, LABEL_TEXT, checkThresholds, computeStatus, normalizeThresholds } from '../../server/status-rules.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const H = 3600000;
const D = 24 * H;
const iso = (ago) => new Date(NOW - ago).toISOString();

/** A project with fresh notes and nothing else: the base each test changes one thing in. */
function agent(over = {}) {
  return {
    kind: 'project',
    sessions_ever: 1,
    sessions_in_window: 1,
    done: [],
    needs: [],
    claims: [],
    cost: { receipt: 'R-cost-00000001', week_usd: 0, prev_week_usd: 0, done_week: 0, done_prev_week: 0 },
    next: { receipt: 'R-next-00000001', updated_at: iso(1 * D) },
    checks: { last: null },
    checkup: { last: null, previous: null },
    ...over,
  };
}
const st = (a, t) => computeStatus(a, { now: NOW, thresholds: t });

test('On track: a Done entry in the window, or a Verified claim, and nothing at risk', () => {
  const a = st(agent({ done: [{ receipt: 'R-session-aaaaaaaa', title: 'Ship the page', when: iso(2 * D) }] }));
  assert.equal(a.label, 'on_track');
  assert.equal(a.text, 'On track');
  assert.deepEqual(a.reasons.map((r) => r.receipt), ['R-session-aaaaaaaa']);
  const v = st(agent({ claims: [{ receipt: 'R-claim-bbbbbbbb', label: 'verified', title: 'Tests' }] }));
  assert.equal(v.label, 'on_track');
  assert.equal(v.reasons[0].code, 'verified');
});

test('At risk: an open Contradicted claim (a closed one does not count)', () => {
  const open = st(agent({ claims: [{ receipt: 'R-claim-cccccccc', label: 'contradicted', open: true, title: 'Fix login' }], done: [{ receipt: 'R-session-1', when: iso(D) }] }));
  assert.equal(open.label, 'at_risk');
  assert.equal(open.reasons[0].code, 'contradicted');
  assert.equal(open.reasons[0].receipt, 'R-claim-cccccccc');
  const closed = st(agent({ claims: [{ receipt: 'R-claim-cccccccc', label: 'contradicted', open: false }], done: [{ receipt: 'R-session-1', when: iso(D) }] }));
  assert.equal(closed.label, 'on_track');
});

test('At risk: the last ship check failed (a pass, or none, does not)', () => {
  assert.equal(st(agent({ checks: { last: { receipt: 'R-check-dddddddd', ok: false, failed: ['test'] } } })).reasons[0].text, 'The last ship check failed (test)');
  assert.equal(st(agent({ checks: { last: { receipt: 'R-check-dddddddd', ok: true } }, done: [{ receipt: 'R-session-1', when: iso(D) }] })).label, 'on_track');
});

test('At risk: the check-up score fell by the threshold or more (19 points is not enough)', () => {
  const drop = (prev, last) => st(agent({ checkup: { previous: { score: prev, receipt: 'R-checkup-p' }, last: { score: last, receipt: 'R-checkup-eeeeeeee' } }, done: [{ receipt: 'R-session-1', when: iso(D) }] }));
  assert.equal(drop(0.8, 0.6).label, 'at_risk');
  assert.equal(drop(0.8, 0.6).reasons[0].receipt, 'R-checkup-eeeeeeee');
  assert.equal(drop(0.8, 0.61).label, 'on_track');
  assert.equal(drop(0.6, 0.9).label, 'on_track', 'a rise is fine');
  // No previous run: nothing to compare.
  assert.equal(st(agent({ checkup: { last: { score: 0.1, receipt: 'R-checkup-x' }, previous: null }, done: [{ receipt: 'R-session-1', when: iso(D) }] })).label, 'on_track');
  assert.equal(drop(0.8, 0.7).label, 'on_track');
  assert.equal(computeStatus(agent({ checkup: { previous: { score: 0.8 }, last: { score: 0.7, receipt: 'R-checkup-x' } } }), { now: NOW, thresholds: { checkup_drop: 10 } }).label, 'at_risk', 'the threshold is tunable');
});

test('At risk: cost up 50% or more week over week while Done is flat or lower; noise floor; a new agent', () => {
  const cost = (prev, wk, donePrev, doneWk) => st(agent({ cost: { receipt: 'R-cost-ffffffff', prev_week_usd: prev, week_usd: wk, done_prev_week: donePrev, done_week: doneWk }, done: doneWk ? [{ receipt: 'R-session-1', when: iso(D) }] : [] }));
  assert.equal(cost(2, 3, 2, 2).label, 'at_risk', '+50%, Done flat');
  assert.equal(cost(2, 3, 2, 2).reasons[0].receipt, 'R-cost-ffffffff');
  assert.equal(cost(2, 2.99, 2, 2).label, 'on_track', 'just under +50%');
  assert.equal(cost(2, 4, 2, 3).label, 'on_track', 'more Done: the spend bought work');
  assert.equal(cost(2, 4, 3, 1).label, 'at_risk', 'more spend, less Done');
  assert.equal(cost(0.2, 0.9, 1, 1).label, 'on_track', 'below the $1 floor: cents doubling is noise');
  assert.equal(cost(0, 5, 0, 1).label, 'on_track', 'a new agent has no last week to compare');
});

test('At risk: a needs-you item waiting 48 hours or more (47 hours is not)', () => {
  const need = (ago) => st(agent({ needs: [{ receipt: 'R-needs-12345678', since: iso(ago), title: 'Approve the plan' }], done: [{ receipt: 'R-session-1', when: iso(D) }] }));
  assert.equal(need(48 * H).label, 'at_risk');
  assert.match(need(50 * H).reasons[0].text, /^Waiting on you since 2 days ago \("Approve the plan"\)$/);
  assert.equal(need(47 * H).label, 'on_track');
});

test('Stalled: no Done in 7 days AND "Next" older than 7 days AND at least one session ever', () => {
  const base = { done: [], next: { receipt: 'R-next-99999999', updated_at: iso(10 * D) } };
  const s = st(agent(base));
  assert.equal(s.label, 'stalled');
  assert.deepEqual(s.reasons.map((r) => [r.code, r.receipt]), [['no_done', 'R-cost-00000001'], ['next_old', 'R-next-99999999']]);
  assert.match(s.reasons[1].text, /last updated 10 days ago/);
  assert.equal(st(agent({ ...base, next: { receipt: 'R-next-1', updated_at: iso(6 * D) } })).label, 'quiet', 'fresh notes: not stalled');
  assert.equal(st(agent({ ...base, sessions_ever: 0, sessions_in_window: 0 })).label, 'quiet', 'a new agent never worked: not stalled');
  assert.equal(st(agent({ ...base, done: [{ receipt: 'R-session-1', when: iso(6 * D) }] })).label, 'on_track', 'Done 6 days ago');
  // Window boundary: exactly 7 days is still inside; a moment past is outside.
  assert.equal(st(agent({ ...base, next: { receipt: 'R-next-1', updated_at: iso(7 * D) } })).label, 'quiet');
  assert.equal(st(agent({ ...base, next: { receipt: 'R-next-1', updated_at: iso(7 * D + 1000) } })).label, 'stalled');
  assert.equal(st(agent({ ...base, next: { receipt: 'R-next-1', updated_at: null } })).reasons[1].text, 'NOW.md has no "Next" yet');
});

test('a domain is never Stalled: an idle area is Quiet', () => {
  const s = st(agent({ kind: 'domain', sessions_in_window: 0, next: { receipt: 'R-next-1', updated_at: iso(30 * D) } }));
  assert.equal(s.label, 'quiet');
  assert.equal(s.reasons[0].code, 'no_sessions');
});

test('At risk beats Stalled: a stalled project waiting on the owner says so', () => {
  const s = st(agent({ next: { receipt: 'R-next-1', updated_at: iso(20 * D) }, needs: [{ receipt: 'R-needs-1', since: iso(3 * D) }] }));
  assert.equal(s.label, 'at_risk');
});

test('Quiet: no sessions in the window and nothing open; sessions with no finished work say so', () => {
  assert.equal(st(agent({ sessions_in_window: 0 })).reasons[0].text, 'No sessions this week');
  assert.equal(st(agent({ sessions_in_window: 2 })).reasons[0].text, 'Sessions this week, but no finished work yet');
});

test('every reason carries a receipt (the CTO can only cite what is there)', () => {
  const cases = [
    agent({ done: [{ receipt: 'R-session-1', when: iso(D) }] }),
    agent({ claims: [{ receipt: 'R-claim-1', label: 'contradicted', open: true }] }),
    agent({ next: { receipt: 'R-next-1', updated_at: iso(9 * D) } }),
    agent({ sessions_in_window: 0 }),
  ];
  for (const a of cases) for (const r of st(a).reasons) assert.match(r.receipt, /^R-/);
});

test('thresholds: defaults, tuning in range, and a clear error out of range', () => {
  assert.deepEqual(normalizeThresholds(null), { ...DEFAULT_THRESHOLDS });
  assert.equal(normalizeThresholds({ needs_hours: 24 }).needs_hours, 24);
  assert.equal(normalizeThresholds({ needs_hours: 0 }).needs_hours, 48, 'out of range falls back');
  assert.throws(() => checkThresholds({ needs_hours: 0 }), /needs_hours must be a number from 1 to 720/);
  assert.throws(() => checkThresholds({ nope: 1 }), /unknown threshold "nope"/);
  assert.equal(st(agent({ needs: [{ receipt: 'R-needs-1', since: iso(25 * H) }], done: [{ receipt: 'R-session-1', when: iso(D) }] }), { needs_hours: 24 }).label, 'at_risk');
  // A 14-day stalled threshold looks at last week too.
  const longer = agent({ next: { receipt: 'R-next-1', updated_at: iso(15 * D) }, cost: { receipt: 'R-cost-1', week_usd: 0, prev_week_usd: 0, done_week: 0, done_prev_week: 1 } });
  assert.equal(st(longer, { stalled_days: 14 }).label, 'quiet');
  assert.equal(st(longer, { stalled_days: 7 }).label, 'stalled');
  assert.deepEqual(Object.values(LABEL_TEXT), ['At risk', 'Stalled', 'On track', 'Quiet']);
});
