process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { badgeText, checkOf, detectClaim, fixMessage, labelClaim, resultInfo, segments, sentences } from '../../server/claims.js';
import { LedgerReader, summarize } from '../../server/ledger.js';

// ------------------------------------------------------------------------------- claim patterns

const POSITIVE = [
  ['Done. The login page now redirects correctly.', 'completion'],
  ['Fixed the failing test; all tests pass now.', 'tests'],
  ['Fixed the crash when saving an empty list.', 'completion'],
  ["I've implemented the dark mode toggle.", 'completion'],
  ['All 42 tests pass.', 'tests'],
  ['The build succeeds and lint is clean.', 'tests'],
  ['Tests pass ✅', 'tests'],
  ['It works now.', 'completion'],
  ['✅ Done!', 'completion'],
  ['Everything is working.', 'completion'],
  ['The bug is fixed.', 'completion'],
  ['Deployed to production.', 'completion'],
  ['Shipped.', 'completion'],
  ['I fixed the off-by-one error in the pager.', 'completion'],
  ['Implemented the CSV export. 12 tests passed.', 'tests'],
  ['Changes are complete: I added a retry and updated the README.', 'completion'],
  ['npm test passes.', 'tests'],
  ['All green.', 'tests'],
  ['Builds cleanly without errors.', 'tests'],
  ['No type errors.', 'tests'],
  ['Ready for review.', 'completion'],
  ['The fix is in place and the page loads.', 'completion'],
  ['Fixed two failing tests and the build error.', 'completion'],
  ['**Summary**\n- Added the `--json` flag\n- Updated the docs\n\nAll tests pass.', 'tests'],
];
const NEGATIVE = [
  'Is it done?',
  'Not done yet: the tests still fail.',
  'Tests are still failing on Windows.',
  'Once the tests pass, I will merge it.',
  'I will fix it next.',
  'Should I run the tests?',
  'The build failed with 3 errors.',
  'Let me run the tests.',
  'I could not fix it.',
  'If the build succeeds, it is done.',
  'I think it works now.',
  'Here is the plan: first fix the parser, then add tests.',
  'Tests pass except one flaky test.',
  'Most tests pass.',
  'I have not changed anything yet.',
  'It was working before the refactor.',
  'Can you check whether the tests pass?',
  'I need to fix the import before the build succeeds.',
  'Fixed the bug. One test still fails.',
  'Fixed the crash, but the error page still shows.',
  'Do you want me to deploy it?',
  '',
];
const OTHER_LANGUAGES = ['Hecho. Las pruebas pasan.', 'Fertig, alle Tests bestanden.', 'Terminé, tout fonctionne.', '完成了，所有测试都通过了。', 'Готово, все тесты проходят.'];

test('claim patterns: completion and test claims are found, with the kind they need', () => {
  for (const [text, kind] of POSITIVE) {
    const c = detectClaim(text);
    assert.ok(c, `should be a claim: ${JSON.stringify(text)}`);
    assert.equal(c.kind, kind, `${JSON.stringify(text)} is a ${kind} claim`);
  }
  assert.deepEqual(detectClaim('The build succeeds and lint is clean.').needs, ['build', 'lint']);
  assert.deepEqual(detectClaim('All 42 tests pass.').needs, ['test']);
  assert.deepEqual(detectClaim('Done.').needs, []);
});

test('claim patterns: questions, negations, plans, hedges and admitted failures are not claims', () => {
  for (const text of NEGATIVE) assert.equal(detectClaim(text), null, `not a claim: ${JSON.stringify(text)}`);
});

test('claim patterns: other languages give no label, never a wrong one', () => {
  for (const text of OTHER_LANGUAGES) assert.equal(detectClaim(text), null, text);
});

test('claim patterns: only the last 600 characters count, and pasted code is not a claim', () => {
  assert.equal(detectClaim(`All tests pass. ${'Then some long explanation without any claim in it at all. '.repeat(15)}`), null);
  assert.ok(detectClaim(`${'Background explanation without claims. '.repeat(30)}Done.`));
  assert.equal(detectClaim('Here is the output:\n```\nTests: 12 passed\n```\nWhat should I look at next?'), null);
  assert.deepEqual(sentences('Done. Is it?').map((s) => s.question), [false, true]);
});

// ---------------------------------------------------------------------------- shell commands

test('checkOf: test, build and lint commands, wrappers, and the generic list', () => {
  const cases = {
    'npm test': 'test', 'npm run test': 'test', 'pnpm test': 'test', 'yarn test': 'test', pytest: 'test', 'go test ./...': 'test',
    'cargo test': 'test', 'make test': 'test', 'make check': 'test', 'npm run build': 'build', tsc: 'build', 'ruff check .': 'lint', 'eslint .': 'lint',
    'cd app && npm test': 'test', 'CI=1 npx vitest run': 'test', 'python -m pytest tests/': 'test', 'uv run pytest -q': 'test', 'tsc --noEmit': 'lint',
    './node_modules/.bin/jest --ci': 'test', 'node --test test/': 'test', 'bun test': 'test', 'pnpm lint': 'lint', 'yarn build': 'build', './gradlew test': 'test',
    'bundle exec rspec': 'test', 'go vet ./...': 'lint', 'cargo clippy': 'lint', 'deno test': 'test',
  };
  for (const [cmd, kind] of Object.entries(cases)) assert.equal(checkOf(cmd)?.kind, kind, cmd);
  for (const cmd of ['git status', 'ls -la', 'npm ci', 'npm install', 'cat package.json', 'echo npm test', 'git commit -m "npm test"']) assert.equal(checkOf(cmd), null, cmd);
});

test('checkOf: a check whose exit code cannot reach the result is masked', () => {
  assert.equal(checkOf('npm test').masked, false);
  assert.equal(checkOf('npm test 2>&1 | tail -20').masked, true);
  assert.equal(checkOf('set -o pipefail; npm test | tail').masked, false);
  assert.equal(checkOf('npm test || true').masked, true);
  assert.equal(checkOf('npm test; echo done').masked, true);
  assert.equal(checkOf('set -e; npm test; echo done').masked, false);
  assert.equal(checkOf('npm test && npm run build').kind, 'test');
  assert.deepEqual(segments('a && b | c; d').map((s) => s.op), ['&&', '|', ';', null]);
});

test('checkOf: the approved checks.yaml commands (exact or the same first two words) and the detected stack', () => {
  const approved = [{ name: 'tests', run: './scripts/ci.sh --fast' }, { name: 'smoke', run: 'node smoke.mjs' }];
  assert.equal(checkOf('./scripts/ci.sh --fast', { approved }).kind, 'test');
  assert.equal(checkOf('./scripts/ci.sh --fast --verbose', { approved }).kind, 'test', 'same first two words');
  assert.equal(checkOf('node smoke.mjs', { approved }).kind, 'check');
  assert.equal(checkOf('./scripts/ci.sh', { approved }), null, 'one word is not enough to match');
  assert.equal(checkOf('just verify-all', { detected: [{ kind: 'test', cmd: 'just verify-all' }] }).kind, 'test');
});

test('resultInfo: exit codes, the first error line, denials and hook blocks', () => {
  const fail = resultInfo('Exit code 1\n> x@1.0.0 test\n> node --test\n\nnot ok 1 - adds\n  error: expected 3 got 4\n# fail 1', true);
  assert.equal(fail.exit, 1);
  assert.equal(fail.err1, 'not ok 1 - adds');
  assert.equal(fail.denied, false);
  assert.equal(resultInfo("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit...)", true).denied, true);
  assert.equal(resultInfo('<tool_use_error>Blocked: hook said no</tool_use_error>', true).blocked, true);
  const pass = resultInfo('> test\n\n# pass 5\n# fail 0', false);
  assert.equal(pass.fail, false);
  assert.equal(pass.pass, true);
  assert.equal(resultInfo('Tests:  2 failed, 5 passed', false).fail, true);
  assert.equal(resultInfo([{ type: 'text', text: 'Exit code 2\n\u001b[31mError: boom\u001b[0m' }], true).err1, 'Error: boom', 'ANSI removed, text blocks read');
});

// ------------------------------------------------------------------------- evidence and labels

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-claims-'));
let clock = Date.parse('2026-10-26T10:00:00Z');
const ts = () => new Date((clock += 1000)).toISOString();
const say = (text) => ({ type: 'assistant', timestamp: ts(), message: { id: `m${clock}`, model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
const prompt = (text) => ({ type: 'user', timestamp: ts(), message: { role: 'user', content: text } });
let n = 0;
const call = (name, input, result, isError = false) => {
  const id = `toolu_${++n}`;
  return [
    { type: 'assistant', timestamp: ts(), message: { id: `m${clock}`, model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } },
  ];
};
const edit = (file = '/repo/a.js') => call('Edit', { file_path: file, old_string: 'a', new_string: 'b' }, 'The file was updated.');
const bash = (command, result = '# pass 3\n# fail 0', isError = false, extra = {}) => call('Bash', { command, ...extra }, result, isError);

function claimsOf(records) {
  const dir = tmp();
  const f = path.join(dir, 'projects', 'p', '6f1d2c4e-1111-4222-8333-444455556666.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, records.flat().map((r) => JSON.stringify(r)).join('\n') + '\n');
  return summarize(new LedgerReader().session(f)).claims;
}

test('labels: a passing check after the last edit is Verified, and the badge names it', () => {
  const [c] = claimsOf([prompt('add it'), edit(), bash('npm test'), say('Done. All tests pass.')]);
  assert.equal(c.kind, 'tests');
  const l = labelClaim(c);
  assert.equal(l.label, 'verified');
  assert.equal(l.check.cmd, 'npm test');
  assert.match(badgeText(l, { time: () => '14:02' }), /^Verified: `npm test` passed at 14:02, after the last edit$/);
});

test('labels: a failing check after the last edit is Contradicted, quoting the first error line', () => {
  const [c] = claimsOf([prompt('fix it'), edit(), bash('npm test', 'Exit code 1\nnot ok 1 - parses dates\n# fail 1', true), say("Fixed. It's done.")]);
  const l = labelClaim(c);
  assert.equal(l.label, 'contradicted');
  assert.equal(l.check.first_error_line, 'not ok 1 - parses dates');
  assert.equal(fixMessage(l.check), 'Your last check failed: `npm test` → `not ok 1 - parses dates`. Please fix it and re-run the check.');
});

test('labels: no check after the last edit is Not verified (the default), including an edit after the passing test', () => {
  assert.equal(labelClaim(claimsOf([prompt('x'), edit(), say('Done.')])[0]).label, 'not_verified');
  const [c] = claimsOf([prompt('x'), edit(), bash('npm test'), edit('/repo/b.js'), say('Done, all tests pass.')]);
  assert.equal(labelClaim(c).label, 'not_verified', 'the edit after the passing test makes the pass stale');
});

test('labels: a tests claim needs a test check; a build check does not verify it, but verifies a completion claim', () => {
  const [t] = claimsOf([prompt('x'), edit(), bash('npm run build', 'built in 2s'), say('All tests pass.')]);
  assert.equal(labelClaim(t).label, 'not_verified');
  const [c] = claimsOf([prompt('x'), edit(), bash('npm run build', 'built in 2s'), say('Done.')]);
  assert.equal(labelClaim(c).label, 'verified');
  const [b] = claimsOf([prompt('x'), edit(), bash('npm test'), bash('npm run build', 'Exit code 2\nERROR: missing export', true), say('The build succeeds and all tests pass.')]);
  assert.equal(labelClaim(b).label, 'contradicted', 'each thing it names must have passed');
});

test('labels: the latest check decides; a declined or blocked check is not a check; background runs are not a check', () => {
  const [late] = claimsOf([prompt('x'), edit(), bash('npm test', 'Exit code 1\nFAIL x', true), bash('npm test'), say('Fixed; tests pass.')]);
  assert.equal(labelClaim(late).label, 'verified');
  const [denied] = claimsOf([prompt('x'), edit(), bash('npm test', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true), say('Done.')]);
  assert.equal(labelClaim(denied).label, 'not_verified', 'declining the test is not a failed test');
  const [blocked] = claimsOf([prompt('x'), edit(), bash('npm test', '<tool_use_error>Blocked by hook</tool_use_error>', true), say('Done.')]);
  assert.equal(labelClaim(blocked).label, 'not_verified');
  const [bg] = claimsOf([prompt('x'), edit(), bash('npm test', 'Command running in background with ID: b1', false, { run_in_background: true }), say('Done.')]);
  assert.equal(labelClaim(bg).label, 'not_verified');
});

test('labels: a masked check counts only when its output says pass or fail', () => {
  const [ok] = claimsOf([prompt('x'), edit(), bash('npm test 2>&1 | tail -5', 'Tests: 4 passed, 4 total'), say('Done.')]);
  assert.equal(labelClaim(ok).label, 'verified');
  const [bad] = claimsOf([prompt('x'), edit(), bash('npm test 2>&1 | tail -5', 'Tests: 1 failed, 3 passed'), say('Done.')]);
  assert.equal(labelClaim(bad).label, 'contradicted', 'the pipe hid the exit code; the output did not');
  const [unclear] = claimsOf([prompt('x'), edit(), bash('npm test | tail -1', 'Done in 2.1s'), say('Done.')]);
  assert.equal(labelClaim(unclear).label, 'not_verified');
});

test('labels: a session with no edits and a completion claim made no changes; each turn gets its own claim', () => {
  assert.equal(labelClaim(claimsOf([prompt('what is this?'), say('Done: it is a parser.')])[0]).label, 'no_changes');
  const both = claimsOf([prompt('a'), edit(), say('Done.'), prompt('b'), bash('npm test'), say('All tests pass now.')]);
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((c) => labelClaim(c).label), ['not_verified', 'verified']);
  assert.deepEqual(claimsOf([prompt('a'), edit(), say('Should I run the tests?')]), []);
});

test('labels: a ship check after the last edit counts, and can turn Not verified into Verified', () => {
  const [c] = claimsOf([prompt('x'), edit(), say('Done.')]);
  const after = new Date(Date.parse(c.last_edit_at) + 60000).toISOString();
  const before = new Date(Date.parse(c.last_edit_at) - 60000).toISOString();
  const run = (at, ok) => ({ at, results: [{ name: 'tests', cmd: 'npm test', kind: 'test', ok, err1: ok ? null : 'FAIL a' }] });
  assert.equal(labelClaim(c, { shipRuns: [run(before, true)] }).label, 'not_verified', 'a ship check before the edit says nothing about it');
  const v = labelClaim(c, { shipRuns: [run(after, true)] });
  assert.equal(v.label, 'verified');
  assert.equal(v.check.ship, true);
  assert.equal(labelClaim(c, { shipRuns: [run(after, false)] }).label, 'contradicted');
});

test('labels: the approved checks.yaml commands count as checks for that project', () => {
  const [c] = claimsOf([prompt('x'), edit(), bash('./scripts/ci.sh --fast', 'all good'), say('Done.')]);
  assert.equal(labelClaim(c).label, 'not_verified', 'an unknown script is not a check by itself');
  assert.equal(labelClaim(c, { approved: [{ name: 'tests', run: './scripts/ci.sh --fast' }] }).label, 'verified');
});

test('receipts keep the command and the first error line only, never the output', () => {
  const [c] = claimsOf([prompt('x'), edit(), bash('npm test', `Exit code 1\nnot ok 1 - secret-looking line\n${'output '.repeat(5000)}`, true), say('Done.')]);
  const json = JSON.stringify(c);
  assert.ok(json.length < 2000, `small: ${json.length}`);
  assert.ok(!json.includes('output output'));
});
