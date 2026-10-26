process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerReader, LedgerStore, PRICES, lastLine, priceFor, summarize, timeline, usageCost } from '../../server/ledger.js';
import { Reports, mergeParts, needKind, needsYouView, nextOf, windowRange, dollars, COST_LABEL } from '../../server/report.js';
import { needsYou } from '../../web/lib/model.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-ledger-'));

test('the price table is dated, sourced, and no more than 120 days old (a reminder, never a runtime fetch)', () => {
  assert.match(PRICES.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(PRICES.source, /^https:\/\/platform\.claude\.com\//);
  const age = (Date.now() - Date.parse(`${PRICES.date}T00:00:00Z`)) / 86400000;
  assert.ok(age <= 120, `server/prices.json is ${Math.floor(age)} days old: check ${PRICES.source} and update it (and its date)`);
  for (const m of PRICES.models) for (const k of ['input', 'output', 'cache_read']) assert.ok(Number.isFinite(m[k]) && m[k] > 0, `${m.match}.${k}`);
});

test('priceFor: exact ids, dated ids and Bedrock-style prefixes match; a newer model is unknown, never priced as an older one', () => {
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('claude-opus-5').input, 5);
  assert.equal(priceFor('claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceFor('claude-sonnet-4-20250514').input, 3);
  assert.equal(priceFor('claude-sonnet-4-6').input, 3);
  assert.equal(priceFor('us.anthropic.claude-opus-4-8').input, 5);
  assert.equal(priceFor('claude-opus-4-6[1m]').input, 5);
  assert.equal(priceFor('claude-fable-5-1').cache_read, 0.25);
  assert.equal(priceFor('us.anthropic.claude-sonnet-4-5-20250929-v1:0').input, 3, 'a Bedrock id with a version after its date');
  assert.equal(priceFor('claude-opus-5-6'), null);
  assert.equal(priceFor('claude-sonnet-6'), null);
  assert.equal(priceFor('fake'), null);
  assert.equal(priceFor(''), null);
  assert.equal(priceFor(null), null);
});

test('usageCost: the 5-minute and 1-hour cache writes, and the CLI-verified haiku case', () => {
  // A real 2.1.283 session's haiku usage repriced to exactly the CLI's own costUSD (0.1003767).
  const u = { input_tokens: 18, output_tokens: 1540, cache_read_input_tokens: 56437, cache_creation_input_tokens: 69612, cache_creation: { ephemeral_5m_input_tokens: 69612, ephemeral_1h_input_tokens: 0 } };
  assert.equal(usageCost('claude-haiku-4-5-20251001', u).toFixed(7), '0.1003767');
  assert.equal(usageCost('claude-sonnet-5', { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } }), 4);
  assert.equal(usageCost('claude-sonnet-5', { cache_creation_input_tokens: 1e6 }), 2.5);
  assert.equal(usageCost('nope', u), null);
  assert.equal(usageCost('claude-sonnet-5', { input_tokens: -5, output_tokens: 'x' }), 0);
});

test('lastLine: cut at a sentence end within 160 characters, else at a word', () => {
  assert.equal(lastLine('Short.'), 'Short.');
  assert.equal(lastLine('**Done.** I fixed `it`.'), 'Done. I fixed it.');
  const long = `${'word '.repeat(60)}end`;
  const l = lastLine(long);
  assert.ok(l.length <= 160 && l.endsWith('…'));
  assert.equal(lastLine(`First sentence that is long enough to count here, really. ${'x'.repeat(200)}`), 'First sentence that is long enough to count here, really.');
  // Seen in a real 2.1.308 session: "./..." is not the end of a sentence.
  const real = 'I created hello/README.md with a "Running the tests" section (it was missing), and cd hello && go test ./... passed: hello/reverse is ok and the root package has no test files.';
  assert.equal(lastLine(real), 'I created hello/README.md with a "Running the tests" section (it was missing), and cd hello && go test ./... passed: hello/reverse is ok and the root package…');
});

test('LedgerReader reads only what was appended, and waits for a line to finish', () => {
  const dir = tmp();
  const f = path.join(dir, '33333333-3333-4333-8333-333333333333.jsonl');
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(f, line({ type: 'user', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Hi' } }));
  const r = new LedgerReader();
  assert.equal(summarize(r.session(f)).turns, 1);
  const half = line({ type: 'assistant', timestamp: '2026-10-20T10:00:01.000Z', requestId: 'r1', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 1e6 }, content: [{ type: 'text', text: 'Hello.' }] } });
  fs.appendFileSync(f, half.slice(0, 40));
  assert.equal(summarize(r.session(f)).cost.usd, 0, 'a partial line is not parsed');
  fs.appendFileSync(f, half.slice(40));
  const s = summarize(r.session(f));
  assert.equal(s.cost.usd, 2);
  assert.equal(s.last_line, 'Hello.');
  // Rewritten smaller (a new file): read from the start again.
  fs.writeFileSync(f, line({ type: 'user', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Again' } }));
  const s2 = summarize(r.session(f));
  assert.equal(s2.cost.usd, 0);
  assert.equal(s2.turns, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a transcript in a format this version has not seen says so (doctor), never a silent zero', () => {
  const dir = tmp();
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ kind: 'turn', body: 'new shape' })}\nnot json\n`);
  const s = summarize(new LedgerReader().session(f));
  assert.equal(s.format.ok, false);
  assert.ok(s.format.issues.some((i) => /not JSON/.test(i)));
  assert.ok(s.format.issues.some((i) => /no record/.test(i)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 2,000-turn transcript parses and builds its Timeline well under a second', () => {
  const dir = tmp();
  const f = path.join(dir, '44444444-4444-4444-8444-444444444444.jsonl');
  const lines = [];
  for (let i = 0; i < 2000; i++) {
    const ts = new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString();
    lines.push(JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: `Step ${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `r${i}`, message: { id: `m${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: 'text', text: 'Running it.' }, { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } }));
    lines.push(JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } }));
  }
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  const t0 = performance.now();
  const d = new LedgerReader().session(f);
  const tl = timeline(d);
  const s = summarize(d);
  const ms = performance.now() - t0;
  assert.equal(s.turns, 2000);
  assert.equal(tl.length, 6000);
  assert.ok(ms < 1000, `took ${ms} ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LedgerStore: write, read back, prune past 180 days and past the size cap (oldest first)', () => {
  const dir = tmp();
  const st = new LedgerStore(dir, { maxBytes: 600 });
  const sids = ['a', 'b', 'c', 'd'].map((c) => `${c.repeat(8)}-aaaa-4aaa-8aaa-${c.repeat(12)}`);
  sids.forEach((sid, i) => {
    st.write({ sid, agent: 'demo', ended_at: `2026-10-2${i}T00:00:00.000Z`, pad: 'x'.repeat(100) });
    const t = (Date.now() - (sids.length - i) * 1000) / 1000;
    fs.utimesSync(st.file(sid), t, t);
  });
  assert.equal(st.read(sids[0]).agent, 'demo');
  assert.equal(st.list({ agent: 'demo' })[0].sid, sids[3], 'newest first');
  assert.throws(() => st.file('../../etc/passwd'));
  // Make the oldest 200 days old.
  const old = (Date.now() - 200 * 86400000) / 1000;
  fs.utimesSync(st.file(sids[0]), old, old);
  const removed = st.prune();
  assert.ok(removed >= 1);
  assert.equal(st.read(sids[0]), null);
  const left = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(left <= 600);
  assert.ok(st.read(sids[3]), 'the newest is kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('windowRange: today, 7 days and 30 days from local midnight', () => {
  const now = Date.parse('2026-10-25T15:30:00.000Z');
  const t = windowRange('today', now);
  assert.equal(new Date(t.start).toISOString(), '2026-10-25T00:00:00.000Z');
  assert.deepEqual(t.list, ['2026-10-25']);
  const w = windowRange('7d', now);
  assert.equal(new Date(w.start).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(w.list.length, 7);
  assert.equal(w.list[6], '2026-10-25');
  assert.equal(windowRange('30d', now).list[0], '2026-09-26');
  assert.throws(() => windowRange('1y', now), /window must be/);
});

test('nextOf: the "Next" section of NOW.md, else its first five lines; stale after 7 days', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const md = '# NOW: Demo\n_Last updated: 2026-10-24_\n\n## State\n- Shipped v2.\n\n## Next steps\n- Write the launch post.\n- Fix the flaky test.\n\n### Detail\nsub-note\n\n## Open threads\n- none\n';
  const n = nextOf(md, now - 86400000, now);
  assert.equal(n.heading, 'Next steps');
  assert.equal(n.text, '- Write the launch post.\n- Fix the flaky test.\n\n### Detail\nsub-note');
  assert.equal(n.stale, false);
  const plain = nextOf('one\n\ntwo\nthree\nfour\nfive\nsix', now - 8 * 86400000, now);
  assert.equal(plain.heading, null);
  assert.equal(plain.text, 'one\ntwo\nthree\nfour\nfive');
  assert.equal(plain.stale, true);
  assert.equal(nextOf('', NaN, now).empty, true);
  assert.equal(nextOf('# x\n## **Next**\n- a', now, now).text, '- a');
});

test('needs-you on the report card is exactly the rail\'s needs-you (web/lib/model.js)', () => {
  const cases = [
    { status: 'needs_you', waiting_on: 'permission_prompt' },
    { status: 'needs_you', waiting_on: 'error', notification: 'Claude Code stopped' },
    { status: 'ready', last_message: 'Done' },
    { status: 'ready', last_message: null },
    { status: 'ready', last_message: 'Done', background: { count: 2 } },
    { status: 'ready', last_message: 'Done', background: { count: 0 } },
    { status: 'working' },
    { status: 'starting' },
    { status: 'ended', last_message: 'x' },
  ];
  for (const c of cases) assert.equal(needsYouView(c), needsYou(c), JSON.stringify(c));
  assert.equal(needKind({ status: 'needs_you', waiting_on: 'permission_prompt', asking: { kind: 'plan' } }), 'plan');
  assert.equal(needKind({ status: 'needs_you', waiting_on: 'permission_prompt' }), 'permission');
  assert.equal(needKind({ status: 'needs_you', waiting_on: 'error' }), 'error');
  assert.equal(needKind({ status: 'ready', last_message: 'x' }), 'reply');
});

test('dollar copy always reads as an equivalent, never a bill', () => {
  assert.equal(dollars(4.1), 'about $4.10');
  assert.equal(dollars(0.001), 'less than $0.01');
  assert.equal(dollars(null), 'unknown');
  assert.equal(dollars(0), '$0.00');
  assert.match(COST_LABEL, /list-price equivalent, not a bill/);
  assert.doesNotMatch(COST_LABEL, /\b(spend|spent|charged)\b/i);
});

test('NOW.md: a heading inside a code fence is text; control characters never reach the terminal', () => {
  const now = Date.now();
  const md = '# NOW\n## Next steps\n- Run this:\n```sh\n# not a heading\nmake test\n```\n- Then ship \u001b]8;;http://evil\u0007it\n## Done\n- x';
  const n = nextOf(md, now, now);
  assert.match(n.text, /# not a heading/);
  assert.match(n.text, /Then ship ]8;;http:\/\/evilit/);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(n.text));
});

test('cost: a session whose only usage has no price is "unknown", never a quiet $0', () => {
  const day = windowRange('7d', Date.now()).list[6];
  const rep = new Reports({ paths: { rt: os.tmpdir(), ledger: path.join(os.tmpdir(), `cl-led-${process.pid}`) }, org: {}, sessions: { records: new Map() } });
  const s = { sid: 'x', turns: 2, status: 'ended', last_at: new Date().toISOString(), days: {}, unknown_days: { [day]: ['claude-nova-9'] }, cost: { usd: 0, source: 'repriced', complete: false, unknown_models: ['claude-nova-9'], models: {} } };
  const c = rep.costOf([s], windowRange('7d', Date.now()));
  assert.equal(c.total_usd, 0);
  assert.equal(c.complete, false);
  assert.deepEqual(c.unknown_models, ['claude-nova-9']);
  const today = rep.costOf([{ ...s, unknown_days: {} }], windowRange('today', Date.now()));
  assert.equal(today.complete, false, 'an active session with unknown usage still makes the window incomplete');
});

test('parts (/clear starts a new transcript): the session\'s figures add up across them', () => {
  const p1 = { turns: 3, tools: 10, tool_errors: 1, files_changed: 2, subagents: 0, cost: { usd: 4, source: 'cli', complete: true, unknown_models: [], models: { a: 4 } }, days: { '2026-10-20': 4 }, unknown_days: {}, commit_times: ['2026-10-20T10:00:00.000Z'], last_line: 'first', last_line_at: '2026-10-20T10:00:00.000Z', started_at: '2026-10-20T09:00:00.000Z', last_at: '2026-10-20T10:00:00.000Z', format: { ok: true, issues: [] } };
  const p2 = { ...p1, turns: 1, cost: { usd: 1, source: 'repriced', complete: true, unknown_models: [], models: { a: 1 } }, days: { '2026-10-21': 1 }, commit_times: [], last_line: 'second', last_line_at: '2026-10-21T10:00:00.000Z', started_at: '2026-10-21T09:00:00.000Z', last_at: '2026-10-21T10:00:00.000Z' };
  const m = mergeParts([p1, p2]);
  assert.equal(m.turns, 4);
  assert.equal(m.cost.usd, 5);
  assert.equal(m.cost.source, 'mixed');
  assert.deepEqual(m.days, { '2026-10-20': 4, '2026-10-21': 1 });
  assert.equal(m.last_line, 'second');
  assert.equal(m.started_at, '2026-10-20T09:00:00.000Z');
  assert.equal(m.commit_times.length, 1);
});
