import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Digest, digestText, isoWeek, weekSendTime } from '../../server/digest.js';

const ORG = {
  totals: { week_usd: 12.5, today_usd: 1 },
  agents: [
    { id: 'donna', name: 'Donna', done: 0, needs: 0, cost_usd: 0, cost_complete: true },
    { id: 'site', name: 'Site', done: 3, needs: 1, cost_usd: 9.4, cost_complete: true },
    { id: 'shop', name: 'Shop', done: 1, needs: 0, cost_usd: 3.1, cost_complete: false },
    { id: 'blog', name: 'Blog', done: 0, needs: 2, cost_usd: 0, cost_complete: true },
    { id: 'quiet', name: 'Quiet', done: 0, needs: 0, cost_usd: 0, cost_complete: true },
  ],
};

test('ISO weeks (Monday first), including the year boundary', () => {
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
  assert.equal(isoWeek(at(2026, 1, 1)), '2026-W01'); // a Thursday
  assert.equal(isoWeek(at(2027, 1, 1)), '2026-W53'); // a Friday
  assert.equal(isoWeek(at(2026, 10, 25)), '2026-W43'); // Sunday
  assert.equal(isoWeek(at(2026, 10, 26)), '2026-W44'); // Monday
  assert.equal(isoWeek(at(2026, 12, 28)), '2026-W53');
});

test('send time: this ISO week\'s Monday 08:00 by default; any day and hour', () => {
  const sun = new Date(2026, 9, 25, 23, 0).getTime();
  assert.deepEqual(new Date(weekSendTime(sun)).toString(), new Date(2026, 9, 19, 8, 0).toString(), 'Sunday belongs to the week that started on Monday the 19th');
  const tue = new Date(2026, 9, 27, 7, 0).getTime();
  assert.equal(weekSendTime(tue, { day: 5, hour: 17 }), new Date(2026, 9, 30, 17, 0).getTime(), 'Friday 17:00');
  assert.equal(weekSendTime(tue, { day: 0, hour: 9 }), new Date(2026, 10, 1, 9, 0).getTime(), 'Sunday is the end of the ISO week');
});

test('the text: counts, approved names and dollars; the most and least used; no titles', () => {
  const t = digestText(ORG, { labels: { site: 'Site', shop: 'Shop', blog: 'Blog' } });
  assert.equal(t, [
    'Clawdling: your week, the last 7 days.',
    '- Site: 3 done, 1 needs you, about $9.40',
    '- Shop: 1 done, 0 need you, about $3.10 (part unknown)',
    '- Blog: 0 done, 2 need you, about $0.00',
    '2 other agents were quiet.',
    'Most usage: Site (about $9.40). Least: Shop (about $3.10).',
    'Total: about $12.50. Usage is a list-price equivalent, not a bill: on Pro and Max it is included in your plan. Open the cockpit for the details.',
  ].join('\n'));
  const unapproved = digestText(ORG, { labels: { site: 'Site' } });
  assert.match(unapproved, /- Another agent: 1 done/);
  assert.match(digestText({ totals: { week_usd: 0 }, agents: [] }), /No agent did any work this week/);
  // A name an agent gave itself is shown only as its approved label, cleaned like the needs-you ping.
  assert.match(digestText(ORG, { labels: { site: 'Site <script>http://evil.example' } }), /- Site script http evil example: 3 done/);
  assert.doesNotMatch(t, /\bspen[dt]\b|\bcharged\b/i);
});

function harness({ now, guarded = true, channel = 'telegram', fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-digest-'));
  const sent = [];
  const pinger = {
    guarded: () => guarded,
    channelFor: () => (channel ? { channel, to: 1 } : null),
    deliver: async (text) => {
      if (fail) throw new Error('telegram down');
      if (!channel) return { sent: false, why: 'no paired channel' };
      sent.push(text);
      return { sent: true, channel };
    },
  };
  const clock = { t: now };
  const d = new Digest({
    paths: { digest: path.join(dir, 'digest.json') },
    org: { read: () => ({}), agents: () => ORG.agents.map(({ id, name }) => ({ id, name })) },
    reports: { orgReport: () => ORG },
    pinger,
    now: () => clock.t,
  });
  return { d, sent, clock, dir };
}

test('off by default; turning it on approves today\'s names and shows the exact text first', async () => {
  const { d, sent, dir } = harness({ now: new Date(2026, 9, 26, 9).getTime() });
  const st = d.status();
  assert.equal(st.enabled, false);
  assert.match(st.preview, /^Clawdling: your week/);
  assert.deepEqual(Object.keys(st.preview_labels).sort(), ['blog', 'donna', 'quiet', 'shop', 'site']);
  assert.deepEqual(await d.check(), { sent: false, why: 'off' });
  assert.equal(sent.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one a week: sends once the send time has passed, never twice in an ISO week; next week again', async () => {
  const monday7 = new Date(2026, 9, 26, 7, 0).getTime();
  const { d, sent, clock, dir } = harness({ now: monday7 });
  d.configure({ enabled: true });
  assert.deepEqual(await d.check(), { sent: false, why: 'not yet' });
  clock.t = new Date(2026, 9, 26, 8, 5).getTime();
  const r = await d.check();
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], r.text);
  clock.t = new Date(2026, 9, 28, 12).getTime();
  assert.deepEqual(await d.check(), { sent: false, why: 'sent this week' });
  clock.t = new Date(2026, 10, 2, 8, 30).getTime();
  assert.equal((await d.check()).sent, true);
  assert.equal(sent.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('not running on Monday morning: sends at the next start in the same ISO week', async () => {
  const { d, sent, clock, dir } = harness({ now: new Date(2026, 9, 26, 7).getTime() });
  d.configure({ enabled: true }); // before Monday 08:00: this week's report is still due
  clock.t = new Date(2026, 9, 29, 15).getTime(); // Clawdling starts again on Thursday
  assert.equal((await d.check()).sent, true);
  assert.equal(sent.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turned on mid-week after the send time: the first report waits for next Monday', async () => {
  const { d, sent, clock, dir } = harness({ now: new Date(2026, 9, 28, 12).getTime() });
  const st = d.configure({ enabled: true });
  assert.equal(new Date(st.next_at).getTime(), new Date(2026, 10, 2, 8).getTime());
  assert.deepEqual(await d.check(), { sent: false, why: 'sent this week' });
  clock.t = new Date(2026, 10, 2, 8, 1).getTime();
  assert.equal((await d.check()).sent, true);
  assert.equal(sent.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refused without a paired channel or where agents cannot be kept out; a failed send is not retried that week', async () => {
  const a = harness({ now: Date.now(), channel: null });
  assert.throws(() => a.d.configure({ enabled: true }), /Pair Telegram or iMessage/);
  const b = harness({ now: Date.now(), guarded: false });
  assert.throws(() => b.d.configure({ enabled: true }), /keep agents out/);
  const c = harness({ now: new Date(2026, 9, 26, 7).getTime(), fail: true });
  c.d.configure({ enabled: true });
  c.clock.t = new Date(2026, 9, 26, 9).getTime();
  const r = await c.d.check();
  assert.equal(r.sent, false);
  assert.match(c.d.status().last_error, /telegram down/);
  assert.deepEqual(await c.d.check(), { sent: false, why: 'sent this week' });
  assert.throws(() => c.d.configure({ day: 9 }), /day must be/);
  assert.throws(() => c.d.configure({ hour: 24 }), /hour must be/);
  assert.equal(c.d.configure({ day: 5, hour: 17 }).day_name, 'Friday');
  c.d.configure({ enabled: false });
  assert.deepEqual(c.d.state().labels, {}, 'off forgets the approved names');
  for (const h of [a, b, c]) fs.rmSync(h.dir, { recursive: true, force: true });
});
