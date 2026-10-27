// Computed status (1.7): On track, At risk, Stalled or Quiet for each agent, from its receipts.
//
// Clawdling owns the label. The CTO seat reads it and may argue with it in one sentence (the review
// page shows that as "overridden by the CTO"), but it cannot change it. No model call: every rule is
// a comparison over the report card's own numbers, and every reason carries the receipt it rests on.
//
// Priority, highest first: At risk, Stalled, On track, Quiet. A project waiting on the owner for
// three days is "At risk: waiting on you", which says more than "Stalled". Domains are never
// Stalled: an area with nothing going on is Quiet (they are often quiet on purpose).

export const LABELS = ['at_risk', 'stalled', 'on_track', 'quiet'];
export const LABEL_TEXT = { at_risk: 'At risk', stalled: 'Stalled', on_track: 'On track', quiet: 'Quiet' };

// The owner may tune these in Settings (the rules themselves are fixed: that is what makes a label mean something).
export const DEFAULT_THRESHOLDS = Object.freeze({
  stalled_days: 7, // no Done entries, and NOW.md "Next" not touched, for this many days
  checkup_drop: 20, // check-up score points lost since the previous run
  cost_rise_pct: 50, // week-over-week cost rise while the Done count is flat or lower
  cost_min_usd: 1, // ...counted only once a week costs at least this much (cents doubling is noise)
  needs_hours: 48, // a needs-you item waiting this long
});

const LIMITS = {
  stalled_days: [1, 14],
  checkup_drop: [1, 100],
  cost_rise_pct: [5, 1000],
  cost_min_usd: [0, 1000],
  needs_hours: [1, 720],
};

/** Thresholds from a stored object: each known key a number in range, else the default. */
export function normalizeThresholds(raw) {
  const out = { ...DEFAULT_THRESHOLDS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Number(raw[k]);
    if (raw[k] !== undefined && raw[k] !== null && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

/** Validate a Settings change: throws a message naming the bad key. */
export function checkThresholds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('thresholds must be an object');
  for (const [k, v] of Object.entries(raw)) {
    if (!Object.hasOwn(LIMITS, k)) throw new Error(`unknown threshold "${k}"`);
    const [lo, hi] = LIMITS[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be a number from ${lo} to ${hi}`);
  }
  return normalizeThresholds(raw);
}

const HOUR = 3600000;
const DAY = 24 * HOUR;
const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : NaN;
};
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
const ago = (t, now) => {
  const d = Math.floor((now - t) / DAY);
  if (d >= 1) return `${days(d)} ago`;
  const h = Math.max(1, Math.floor((now - t) / HOUR));
  return `${h} hour${h === 1 ? '' : 's'} ago`;
};
const money = (x) => (x > 0 && x < 0.005 ? 'less than $0.01' : `$${(x || 0).toFixed(2)}`);

/**
 * The label and its reasons for one agent of the schema 2 report (report.js allReport):
 *   kind, sessions_ever, sessions_in_window, done[], needs[], cost{}, next{}, claims[], checks{last},
 *   checkup{last, previous}. Every item there carries `receipt`.
 * Returns {label, text, reasons: [{code, text, receipt}]}.
 */
export function computeStatus(a, { thresholds = DEFAULT_THRESHOLDS, now = Date.now() } = {}) {
  const t = normalizeThresholds(thresholds);
  const done = Array.isArray(a.done) ? a.done : [];
  const needs = Array.isArray(a.needs) ? a.needs : [];
  const claims = Array.isArray(a.claims) ? a.claims : [];
  const cost = a.cost || {};

  // ---- At risk: any one of these, each with its receipt.
  const risk = [];
  for (const c of claims) {
    if (c.label === 'contradicted' && c.open) risk.push({ code: 'contradicted', text: `A "done" claim was contradicted by a failed check (${c.title ? `"${c.title}"` : 'a session'})`, receipt: c.receipt });
  }
  const ship = a.checks && a.checks.last;
  if (ship && ship.ok === false) risk.push({ code: 'ship_failed', text: `The last ship check failed${ship.failed && ship.failed.length ? ` (${ship.failed.slice(0, 3).join(', ')})` : ''}`, receipt: ship.receipt });
  const up = a.checkup || {};
  if (up.last && up.previous && Number.isFinite(up.last.score) && Number.isFinite(up.previous.score)) {
    const drop = Math.round((up.previous.score - up.last.score) * 100);
    if (drop >= t.checkup_drop) risk.push({ code: 'checkup_drop', text: `The check-up score fell ${drop} points (${Math.round(up.previous.score * 100)}% to ${Math.round(up.last.score * 100)}%)`, receipt: up.last.receipt });
  }
  const wk = Number(cost.week_usd) || 0;
  const prev = Number(cost.prev_week_usd) || 0;
  const doneWk = Number(cost.done_week) || 0;
  const donePrev = Number(cost.done_prev_week) || 0;
  if (prev > 0 && wk >= t.cost_min_usd && wk >= prev * (1 + t.cost_rise_pct / 100) && doneWk <= donePrev) {
    risk.push({ code: 'cost_up', text: `Usage rose ${Math.round((wk / prev - 1) * 100)}% week over week (${money(prev)} to ${money(wk)}) while finished work did not (${donePrev} to ${doneWk})`, receipt: cost.receipt });
  }
  for (const n of needs) {
    const since = ms(n.since);
    if (Number.isFinite(since) && now - since >= t.needs_hours * HOUR) risk.push({ code: 'needs_old', text: `Waiting on you since ${ago(since, now)} (${n.title ? `"${n.title}"` : 'a session'})`, receipt: n.receipt });
  }
  if (risk.length) return { label: 'at_risk', text: LABEL_TEXT.at_risk, reasons: risk };

  // ---- Stalled (projects): nothing finished in the window, "Next" not touched, and it has worked before.
  const next = a.next || {};
  const nextAt = ms(next.updated_at);
  const nextOld = !Number.isFinite(nextAt) || now - nextAt > t.stalled_days * DAY;
  const doneRecent = done.filter((d) => {
    const w = ms(d.when);
    return Number.isFinite(w) && now - w <= t.stalled_days * DAY;
  });
  // The report covers 7 days and the 7 before them: a longer threshold also looks at last week.
  const doneEarlier = t.stalled_days > 7 && donePrev > 0;
  if (a.kind === 'project' && (a.sessions_ever || 0) > 0 && !doneRecent.length && !doneEarlier && nextOld) {
    return {
      label: 'stalled',
      text: LABEL_TEXT.stalled,
      reasons: [
        { code: 'no_done', text: `No work finished in ${days(t.stalled_days)}`, receipt: cost.receipt },
        { code: 'next_old', text: Number.isFinite(nextAt) ? `NOW.md "Next" last updated ${ago(nextAt, now)}` : 'NOW.md has no "Next" yet', receipt: next.receipt },
      ],
    };
  }

  // ---- On track: a Verified receipt or a Done entry in the window.
  const verified = claims.filter((c) => c.label === 'verified');
  if (verified.length || done.length) {
    const reasons = verified.slice(0, 2).map((c) => ({ code: 'verified', text: `A "done" claim was verified${c.title ? ` ("${c.title}")` : ''}`, receipt: c.receipt }));
    for (const d of done.slice(0, 3 - reasons.length)) reasons.push({ code: 'done', text: `Finished work: ${d.title ? `"${d.title}"` : 'a session'}`, receipt: d.receipt });
    return { label: 'on_track', text: LABEL_TEXT.on_track, reasons };
  }

  // ---- Quiet: nothing in the window and nothing open (or sessions that did no work).
  const active = (a.sessions_in_window || 0) > 0;
  return {
    label: 'quiet',
    text: LABEL_TEXT.quiet,
    reasons: [{ code: active ? 'idle' : 'no_sessions', text: active ? 'Sessions this week, but no finished work yet' : 'No sessions this week', receipt: cost.receipt }],
  };
}
