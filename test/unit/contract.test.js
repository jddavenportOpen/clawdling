// Contract fixtures (SPEC-1.5 3.6): scrubbed, synthetic transcripts in the shapes Claude Code
// 2.1.283 writes. Each one is parsed and its totals checked against numbers worked out by hand,
// so a Claude Code release that changes a record shape fails here, not on the owner's report card.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerReader, summarize, timeline } from '../../server/ledger.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'transcripts');
const read = (name) => new LedgerReader().session(path.join(DIR, name));
const cents = (x) => Math.round(x * 100) / 100;

// Worked by hand from prices.json (per million tokens):
//   msg_01 claude-sonnet-5 ($2 in, $10 out, $0.20 cache read, 5m write 1.25x, 1h write 2x):
//     100,000 x 2 + 200,000 x 10 + 1,000,000 x 0.2 + 400,000 x 2.5 + 100,000 x 4 = $3.80
//   msg_02 claude-opus-5-5 ($4, $20, $0.20; no 5m/1h split, so all writes at 5m = $5):
//     50,000 x 4 + 150,000 x 20 + 2,000,000 x 0.2 + 200,000 x 5 = $4.60
//   msg_01 is split over three records with the same usage: counted once.
test('repriced: de-duplicated usage, by day and by model, to the cent', () => {
  const s = summarize(read('repriced.jsonl'));
  assert.equal(s.cost.source, 'repriced');
  assert.equal(cents(s.cost.usd), 8.4);
  assert.equal(s.cost.complete, true);
  assert.deepEqual(Object.fromEntries(Object.entries(s.days).map(([d, v]) => [d, cents(v)])), { '2026-10-20': 3.8, '2026-10-21': 4.6 });
  assert.equal(cents(s.cost.models['claude-sonnet-5']), 3.8);
  assert.equal(cents(s.cost.models['claude-opus-5-5']), 4.6);
  assert.equal(s.turns, 2, 'slash-command plumbing and meta lines are not prompts');
  assert.equal(s.tools, 6);
  assert.equal(s.tool_errors, 2, 'is_error: "Exit code 1" and a failed edit');
  assert.equal(s.files_changed, 2, 'a.js twice and b.js; the failed edit of c.js does not count');
  assert.equal(s.format.ok, true);
  assert.equal(s.started_at, '2026-10-20T09:59:00.000Z');
  assert.match(s.last_line, /^Done\. I fixed the off-by-one in the parser and all 12 tests pass now\.$/);
  assert.ok(s.last_line.length <= 160);
});

test("cli-cost: the CLI's own cost-state total wins when it is current", () => {
  const s = summarize(read('cli-cost.jsonl'));
  assert.equal(s.cost.source, 'cli');
  assert.equal(s.cost.usd, 8.4);
  assert.deepEqual(s.cost.models, { 'claude-sonnet-5': 3.8, 'claude-opus-5-5': 4.6 });
  assert.equal(cents(Object.values(s.days).reduce((a, b) => a + b, 0)), 8.4, 'days add up to the total');
  assert.equal(s.cli.lines_added, 12);
});

test('stale-cost: usage after the last cost-state is repriced, never dropped', () => {
  const s = summarize(read('stale-cost.jsonl'));
  assert.equal(s.cost.source, 'repriced');
  // + msg_05 sonnet: 10,000 x 2 + 20,000 x 10 + 100,000 x 0.2 + 40,000 x 2.5 + 10,000 x 4 = $0.38
  assert.equal(cents(s.cost.usd), 8.78);
  assert.equal(s.turns, 3);
});

test('unknown-model: cost unknown for that model, never 0', () => {
  const s = summarize(read('unknown-model.jsonl'));
  assert.equal(s.cost.source, 'repriced', 'hasUnknownModelCost: the CLI total is not used');
  assert.equal(s.cost.complete, false);
  assert.deepEqual(s.cost.unknown_models, ['claude-nova-9']);
  assert.equal(cents(s.cost.usd), 8.4, 'the known part is still counted');
});

test('inline sidechain (older versions): nested under the Task call, haiku priced', () => {
  const d = read('inline-sidechain.jsonl');
  const s = summarize(d);
  // sonnet 2 x (1,000 x 2 + 1,000 x 10) = $0.024; haiku (2,000 + 5,000) + (1,000 + 5,000) = $0.013
  assert.equal(s.cost.usd.toFixed(6), '0.037000');
  assert.equal(s.turns, 1, 'the subagent prompt is not a turn');
  assert.equal(s.last_line, 'The helper says the docs are fine.');
  const tl = timeline(d);
  const task = tl.find((e) => e.name === 'Task');
  const readTool = tl.find((e) => e.name === 'Read');
  assert.equal(task.depth, 0);
  assert.equal(readTool.depth, 1);
  assert.equal(readTool.parent, 'toolu_10');
  assert.equal(task.ms, 5000);
  assert.equal(task.ok, true);
});

test('subagent files: nested under their Agent call; workflow agents by start time; all priced', () => {
  const d = read('22222222-3333-4444-8555-666666666666.jsonl');
  const s = summarize(d);
  assert.equal(s.subagents, 2);
  // main sonnet $0.024 + subagent haiku $0.013 + workflow sonnet $0.012
  assert.equal(s.cost.usd.toFixed(6), '0.049000');
  const tl = timeline(d);
  const kinds = tl.map((e) => `${e.depth}:${e.kind}${e.name ? `:${e.name}` : ''}`);
  assert.deepEqual(kinds, ['0:prompt', '0:tool:Agent', '1:subagent', '1:tool:Read', '1:say', '0:say', '0:subagent', '1:tool:Grep']);
  assert.equal(tl.find((e) => e.kind === 'subagent').description, 'Check the docs');
  assert.equal(tl.filter((e) => e.kind === 'subagent')[1].description, 'audit:todos');
  assert.deepEqual(tl.map((e) => e.n), tl.map((_, i) => i));
  // The turn's cost includes its subagent: main $0.024 + haiku $0.013
  assert.equal(tl[0].cost.toFixed(6), '0.037000');
});

test('timeline of the repriced fixture: prompts carry their turn cost, tools their duration and result', () => {
  const tl = timeline(read('repriced.jsonl'));
  const prompts = tl.filter((e) => e.kind === 'prompt');
  assert.deepEqual(prompts.map((p) => cents(p.cost)), [3.8, 4.6]);
  const bash = tl.find((e) => e.id === 'toolu_01');
  assert.deepEqual([bash.name, bash.summary, bash.ms, bash.ok], ['Bash', 'npm test', 5000, false]);
  assert.equal(tl.find((e) => e.id === 'toolu_04').ok, true);
  assert.ok(tl.every((e) => !String(e.text || '').includes('No response requested')), 'synthetic messages are skipped');
});
