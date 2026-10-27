// 1.5.2: a done row on the report card leads with the outcome the agent reported ("tests passed"),
// whole, and a tool call that errored along the way is neutral detail, not a warning (#31).
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerReader, lastLine, outcomeLine, summarize } from '../../server/ledger.js';
import { mergeParts } from '../../server/report.js';
import { restLine } from '../../web/lib/model.js';

// The closing message of a real Claude Code 2.1.308 run (one README section, then go test).
const REAL = 'I created `hello/README.md` with a short "Running the tests" section (it didn\'t exist). `cd hello && go test ./...` passed: `hello/reverse` is `ok`, and the root `hello` package has no test files. Glob wasn\'t available in this session, so I read the README path directly instead.';
const REAL_OUTCOME = 'cd hello && go test ./... passed: hello/reverse is ok, and the root hello package has no test files.';

test('outcomeLine: the sentence that reports a check result, whole, even past the 160-character line', () => {
  assert.equal(outcomeLine(REAL), REAL_OUTCOME);
  assert.ok(!lastLine(REAL).includes('passed'), 'the closing line alone drops it: the bug this fixes');
  assert.equal(outcomeLine('All 12 tests pass. I also updated the README.'), 'All 12 tests pass.');
  assert.equal(outcomeLine('The build failed: 2 type errors in src/a.ts. Nothing was committed.'), 'The build failed: 2 type errors in src/a.ts.');
  assert.equal(outcomeLine('Tests failed at first. After the fix, all tests pass now.'), 'After the fix, all tests pass now.', 'the last result wins');
  assert.equal(outcomeLine('**Done.** `npm test` is green'), 'npm test is green', 'markdown is stripped, a last sentence without a stop counts');
  assert.equal(outcomeLine('The test command failed, so the tests need a look.'), 'The test command failed, so the tests need a look.');
  const long = `The tests passed ${'and so did everything else '.repeat(20)}today.`;
  assert.ok(outcomeLine(long).length <= 300 && outcomeLine(long).startsWith('The tests passed'));
});

test('outcomeLine: plans, instructions, conditions and questions are not results', () => {
  for (const t of [
    'Done.',
    'I updated the README.',
    "I didn't run the tests.",
    'Run npm test to check it passes.',
    'You can run the tests to confirm they pass.',
    'If the tests fail, tell me.',
    'Should I run the tests to see if they pass?',
    'Next, the build needs to pass on Windows.',
    'Let me check whether the tests pass.',
    'Here is the plan: 1. Fix the failing tests. 2. Ship.',
    "I didn't run the tests because they fail on main.",
    'I fixed the broken build script.',
    'I fixed the failing tests.',
    'Add a check that fails on empty input.',
    '',
    null,
  ]) assert.equal(outcomeLine(t), null, String(t));
});

test('a seeded session (no-match search, read of a missing file, then passing tests): outcome first, errors counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-row-'));
  const f = path.join(dir, '44444444-4444-4444-8444-444444444444.jsonl');
  let n = 0;
  const at = () => new Date(Date.UTC(2026, 9, 26, 7, 0, n++)).toISOString();
  const rec = (o) => `${JSON.stringify({ timestamp: at(), ...o })}\n`;
  const call = (id, name, input) => rec({ type: 'assistant', requestId: `r${id}`, message: { id: `m${id}`, model: 'claude-sonnet-5', usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id, content, error) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] } });
  fs.writeFileSync(f, [
    rec({ type: 'user', message: { role: 'user', content: 'Add a Running the tests section to hello/README.md, then run the tests.' } }),
    call('t1', 'Glob', { pattern: 'hello/**' }), result('t1', 'No files found', true),
    call('t2', 'Read', { file_path: '/repo/hello/README.md' }), result('t2', 'File does not exist.', true),
    call('t3', 'Write', { file_path: '/repo/hello/README.md', content: '# hello' }), result('t3', 'File created', false),
    call('t4', 'Bash', { command: 'cd hello && go test ./...' }), result('t4', 'ok  hello/reverse 0.01s', false),
    rec({ type: 'assistant', requestId: 'r5', message: { id: 'm5', model: 'claude-sonnet-5', usage: { input_tokens: 10 }, content: [{ type: 'text', text: REAL }] } }),
  ].join(''));
  const s = summarize(new LedgerReader().session(f));
  assert.equal(s.tool_errors, 2);
  assert.equal(s.files_changed, 1);
  assert.equal(s.outcome, REAL_OUTCOME);
  assert.equal(s.last_line, 'I created hello/README.md with a short "Running the tests" section (it didn\'t exist).');
  assert.equal(restLine(s.last_line, s.outcome), s.last_line, 'the line does not hold the outcome, so it stays whole');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parts: the outcome goes with the closing message it came from', () => {
  const p = (line, outcome, at) => ({ turns: 1, cost: { usd: 0, source: 'repriced', complete: true, unknown_models: [], models: {} }, last_line: line, outcome, last_line_at: at });
  assert.equal(mergeParts([p('a', 'Tests pass.', '2026-10-20T10:00:00.000Z'), p('b', null, '2026-10-21T10:00:00.000Z')]).outcome, null, 'a later message that reports no result clears it');
  assert.equal(mergeParts([p('a', null, '2026-10-20T10:00:00.000Z'), p('b', 'The build failed.', '2026-10-21T10:00:00.000Z')]).outcome, 'The build failed.');
  assert.equal(mergeParts([{ turns: 1, cost: { usd: 0, source: 'repriced', complete: true }, last_line: 'old receipt' }]).outcome, null, 'a receipt from before 1.5.2 has no outcome');
});

test('restLine: the closing line without the outcome the row already shows', () => {
  assert.equal(restLine('I added a README section. The test command failed, so the tests need a look.', 'The test command failed, so the tests need a look.'), 'I added a README section.');
  assert.equal(restLine('All 12 tests pass.', 'All 12 tests pass.'), null, 'nothing left');
  assert.equal(restLine('I fixed it.', null), 'I fixed it.');
  assert.equal(restLine('I fixed it.', 'The build failed.'), 'I fixed it.');
  assert.equal(restLine(null, 'Tests pass.'), null);
  assert.equal(restLine('✅', null), '✅', 'a closing line without letters is still a closing line');
});

test('restLine: a closing line cut inside the outcome never repeats it', () => {
  const long = `All 24 tests pass across the ${'api, web and worker packages and '.repeat(6)}docs.`;
  const text = `Done. ${long}`;
  const line = lastLine(text);
  const outcome = outcomeLine(text);
  assert.ok(line.endsWith('…') && !line.includes(outcome), 'the line is cut inside the outcome sentence');
  assert.equal(outcome, long);
  assert.equal(restLine(line, outcome), 'Done.');
  const only = lastLine(long);
  assert.equal(restLine(only, outcomeLine(long)), null, 'nothing but the outcome: no second line');
  assert.equal(restLine('I fixed the parser and the build pass…', 'All 24 tests pass.'), 'I fixed the parser and the build pass…', 'a cut line that is not the outcome stays');
});
