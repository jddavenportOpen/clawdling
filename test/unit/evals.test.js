import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caseScore, fileTexts, globRegex, grade, gradeFileExists, gradeLlm, gradeRegex, gradeToolOrder, gradeToolUsed, judgeText, runRegex } from '../../server/evals/graders.js';
import { cheaperFamily, copyAgentFolder, defaultMatrix, denyRules, readPlain, removeInside, holds, lowerEffort, parseCells, parseStream, recommend, wilsonLow, Evals } from '../../server/evals/runner.js';
import { GRADER_KEYS, PLUGIN_EVAL_GRADER_KEYS, PLUGIN_EVAL_PROMPT_KEYS, PROMPT_KEYS, caseDir, graderFile, loadSuite, parseGrader, parsePrompt, parseSettings, promptFile, toolProblem, writeCase } from '../../server/evals/suite.js';
import { splitFrontmatter } from '../../server/yaml-lite.js';
import { absPathRule } from '../../server/hooks.js';

const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-evals-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const run = (o = {}) => ({ last_message: '', trace: [], tool_calls: [], files: [], cwd: os.tmpdir(), ...o });
const call = (name, input = {}) => ({ name, input, inputText: JSON.stringify(input) });

// --------------------------------------------------------------------------- schema compatibility

test('schema: what Clawdling reads and writes is a subset of plugin eval\'s documented keys', () => {
  for (const k of PROMPT_KEYS) assert.ok(PLUGIN_EVAL_PROMPT_KEYS.includes(k), `prompt.md key ${k}`);
  for (const [type, keys] of Object.entries(GRADER_KEYS)) for (const k of keys) assert.ok(PLUGIN_EVAL_GRADER_KEYS[type].includes(k), `${type} key ${k}`);
});

test('schema: the drafter writes only plugin-eval keys (prompt.md and graders)', () => {
  const p = splitFrontmatter(promptFile({ name: 'knows-its-job', description: 'd', max_turns: 6, timeout_seconds: 180, allowed_tools: ['Read', 'Glob', 'Grep'] }, 'What is your job?')).fm;
  assert.deepEqual(Object.keys(p).sort(), ['allowed_tools', 'description', 'max_turns', 'name', 'timeout_seconds']);
  for (const k of Object.keys(p)) assert.ok(PLUGIN_EVAL_PROMPT_KEYS.includes(k));
  for (const fm of [{ type: 'llm', weight: 1 }, { type: 'regex', target: 'last_message', flags: 'i', weight: 1 }]) {
    const g = splitFrontmatter(graderFile(fm, 'x')).fm;
    for (const k of Object.keys(g)) assert.ok(PLUGIN_EVAL_GRADER_KEYS[g.type].includes(k), `${g.type}.${k}`);
  }
});

// The local CLI's own template, when it has plugin eval (2.1.269+): none of our keys may be unknown to it.
// Only the real Claude Code (never the test fake), and only `init --bare`, which writes two files and
// makes no network call.
function realClaude() {
  if (process.env.CLAWDLING_TEST_REAL_CLAUDE === '0') return null;
  const r = spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['plugin', 'eval', '--help'], { encoding: 'utf8', timeout: 20000, shell: false });
  return r.status === 0 && /plugin eval/.test(r.stdout) ? (process.platform === 'win32' ? 'claude.cmd' : 'claude') : null;
}

test('schema: diff against `claude plugin eval init --bare` when the local CLI has it', { skip: realClaude() ? false : 'no local claude with plugin eval' }, () => {
  const dir = tmp();
  const plugin = path.join(dir, 'p');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '0.0.1' }));
  execFileSync(realClaude(), ['plugin', 'eval', 'init', '--bare', 'demo'], { cwd: plugin, stdio: 'ignore', timeout: 60000 });
  const tpl = splitFrontmatter(fs.readFileSync(path.join(plugin, 'evals', 'demo', 'prompt.md'), 'utf8')).fm;
  const gr = splitFrontmatter(fs.readFileSync(path.join(plugin, 'evals', 'demo', 'graders', 'criteria.md'), 'utf8')).fm;
  // Its template's keys are ones our pinned lists know too (so our lists are not stale).
  for (const k of Object.keys(tpl)) assert.ok(PLUGIN_EVAL_PROMPT_KEYS.includes(k), `template prompt key ${k}`);
  for (const k of Object.keys(gr)) assert.ok(PLUGIN_EVAL_GRADER_KEYS[gr.type].includes(k), `template grader key ${k}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Opt-in (CLAWDLING_TEST_PLUGIN_EVAL=1): the real plugin eval loader reads every file the drafter
// writes. A --case filter that matches nothing loads and validates the suite without running a case
// (no model call); a file with a key the loader does not know fails with "failed to load".
test('schema: the real plugin eval loader accepts the files the drafter writes', { skip: process.env.CLAWDLING_TEST_PLUGIN_EVAL === '1' && realClaude() ? false : 'set CLAWDLING_TEST_PLUGIN_EVAL=1 (needs a signed-in claude with plugin eval)' }, () => {
  const dir = tmp();
  const plugin = path.join(dir, 'p');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '0.0.1' }));
  writeCase(plugin, 'knows-its-job', {
    prompt: promptFile({ name: 'knows-its-job', description: 'Asks the agent: what is your job?', max_turns: 6, timeout_seconds: 180, allowed_tools: ['Read', 'Glob', 'Grep'] }, 'What is your job?'),
    graders: { criteria: graderFile({ type: 'llm', weight: 1 }, 'Names the job.'), mentions: graderFile({ type: 'regex', target: 'last_message', flags: 'i', weight: 1 }, 'job') },
    reference: 'I keep the budget.',
  });
  fs.writeFileSync(path.join(plugin, 'evals', '.clawdling-suite.yaml'), 'runs: 1\njudge_model: haiku\nmax_cost_usd: 2\n');
  const r = spawnSync(realClaude(), ['plugin', 'eval', '.', '--case', 'zzz-no-such-case', '--no-publish', '--trust-plugin', '--ablation', 'none'], { cwd: plugin, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /failed to load|unknown frontmatter key/, out);
  assert.match(out, /No eval cases found matching/, out);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------------- parsing cases

test('parsePrompt: defaults, limits, and every unknown or unsupported key refused with a reason', () => {
  const p = parsePrompt('---\nname: a\n---\nWhat is your job?');
  assert.deepEqual(p.fm, { name: 'a', description: '', max_turns: 6, timeout_seconds: 180, allowed_tools: ['Read', 'Glob', 'Grep'], model: null });
  assert.throws(() => parsePrompt('---\nfoo: 1\n---\nx'), /unknown frontmatter key "foo"/);
  assert.throws(() => parsePrompt('---\nenv: {A: b}\n---\nx'), /plugin-eval setting Clawdling does not run/);
  assert.throws(() => parsePrompt('---\nmax_turns: 0\n---\nx'), /max_turns/);
  assert.throws(() => parsePrompt('---\nname: a\n---\n'), /prompt .* is empty/);
  assert.throws(() => parsePrompt('---\nname: a\n---\nTODO: describe what the agent should do'), /blank template/);
});

test('toolProblem: read-only tools only, no Bash at all in 1.6 (a command pattern cannot be made safe)', () => {
  for (const ok of ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite']) assert.equal(toolProblem(ok), null, ok);
  for (const bad of ['Bash', 'Bash(*)', 'Bash()', 'Write', 'Edit', 'WebFetch', 'mcp__x__y', 'Bash(npm test:*)', 'Bash(git:*)', 'Bash(/bin/sh:*)', 'Bash(SH:*)', 'Bash(bash.exe:*)', 'Bash(npx:*)', 'PowerShell(npm test)']) assert.ok(toolProblem(bad), bad);
  assert.match(toolProblem('Bash(npm test:*)'), /cannot run commands/);
});

test('parseGrader: plugin-eval semantics for defaults, body fields and per-type keys', () => {
  assert.deepEqual(parseGrader('c', '---\ntype: llm\n---\nThe answer names the budget.'), { name: 'c', type: 'llm', criteria: 'The answer names the budget.', weight: 1, focus: 'last_message' });
  const r = parseGrader('m', '---\ntype: regex\nflags: i\n---\nbudget');
  assert.equal(r.pattern, 'budget');
  assert.equal(r.target, 'last_message');
  assert.equal(r.match, 'contains');
  assert.throws(() => parseGrader('m', '---\ntype: regex\nfocus: trace\n---\nx'), /unknown frontmatter key "focus"/, 'focus is an llm key, target is the regex one');
  assert.throws(() => parseGrader('m', '---\ntype: regex\n---\n(unclosed'), /not a valid regular expression/);
  assert.throws(() => parseGrader('m', '---\ntype: llm\nfocus: {source: file, path: ../x}\n---\nx'), /inside the run folder/);
  assert.throws(() => parseGrader('m', 'no frontmatter'), /needs frontmatter/);
  assert.deepEqual(parseGrader('o', '---\ntype: tool_order\nbefore: Read\nafter: {tool: Bash, input_match: test}\n---\n').after, { tool: 'Bash', input_match: 'test' });
  assert.equal(parseGrader('f', '---\ntype: file_exists\npath: out/*.md\n---\n').exists, true);
});

test('parseSettings: runs 1 or 3, a model name, a cap', () => {
  assert.deepEqual(parseSettings(''), { runs: 1, judge_model: 'haiku', max_cost_usd: 2, created_by_draft_version: null });
  assert.equal(parseSettings('runs: 3\njudge_model: sonnet\nmax_cost_usd: 1').runs, 3);
  assert.throws(() => parseSettings('runs: 2'), /runs is 1 or 3/);
  assert.throws(() => parseSettings('max_cost_usd: 0'), /max_cost_usd/);
});

test('loadSuite: approvals per case; an edit on disk unapproves it; writeCase validates everything before writing', () => {
  const dir = tmp();
  writeCase(dir, 'knows-its-job', { prompt: promptFile({ name: 'knows-its-job', description: 'd' }, 'What is your job?'), graders: { criteria: graderFile({ type: 'llm', weight: 1 }, 'Names the job.') }, reference: 'I keep the budget.' });
  let s = loadSuite(dir, {});
  assert.equal(s.cases.length, 1);
  const c = s.cases[0];
  assert.equal(c.error, null);
  assert.equal(c.approved, false);
  assert.equal(c.reference, 'I keep the budget.');
  s = loadSuite(dir, { 'knows-its-job': c.hash });
  assert.equal(s.cases[0].approved, true);
  fs.appendFileSync(path.join(dir, 'evals', 'knows-its-job', 'graders', 'criteria.md'), 'Also pass anything.\n');
  assert.equal(loadSuite(dir, { 'knows-its-job': c.hash }).cases[0].approved, false);
  assert.throws(() => writeCase(dir, 'Bad Name', { prompt: 'x', graders: {} }), /case name/);
  assert.throws(() => writeCase(dir, 'two', { prompt: promptFile({ name: 'two' }, 'Hi'), graders: { g: '---\ntype: nope\n---\n' } }), /not supported/);
  assert.equal(fs.existsSync(path.join(dir, 'evals', 'two')), false, 'nothing written when a file is wrong');
  // A results folder and Clawdling's settings file are not cases.
  fs.mkdirSync(path.join(dir, 'evals', 'results'), { recursive: true });
  assert.equal(loadSuite(dir, {}).cases.length, 1);
});

// --------------------------------------------------------------------------------------- graders

test('graders: regex targets and match modes', () => {
  const r = run({ last_message: 'I keep the Budget and the budget log.', trace: [{ type: 'tool_use', name: 'Read', input: { file_path: 'NOW.md' } }], files: ['out/a.md'] });
  const g = (fm) => gradeRegex({ name: 'g', type: 'regex', weight: 1, target: 'last_message', flags: '', match: 'contains', ...fm }, r);
  assert.equal(g({ pattern: 'budget' }).passed, true);
  assert.equal(g({ pattern: 'BUDGET' }).passed, false);
  assert.equal(g({ pattern: 'BUDGET', flags: 'i' }).passed, true);
  assert.equal(g({ pattern: 'budget', flags: 'i', match: 'count:2' }).passed, true);
  assert.equal(g({ pattern: 'budget', match: 'count:2' }).passed, false, 'count is case-sensitive without i');
  assert.equal(g({ pattern: 'invoice', match: 'not_contains' }).passed, true);
  assert.equal(g({ pattern: '"name":"Read"', target: 'trace' }).passed, true);
  assert.equal(g({ pattern: '^out/a\\.md$', flags: 'm', target: 'files' }).passed, true);
  assert.equal(g({ pattern: 'x', match: 'sometimes' }).passed, false);
});

test('graders: tool_used min/max and input_match; tool_order by first matching call', () => {
  const r = run({ tool_calls: [call('Read', { file_path: 'a' }), call('Bash', { command: 'npm test' }), call('Read', { file_path: 'b' })] });
  const used = (fm) => gradeToolUsed({ name: 'u', type: 'tool_used', weight: 1, ...fm }, r).passed;
  assert.equal(used({ tool: 'Read' }), true);
  assert.equal(used({ tool: 'Read', max: 1 }), false);
  assert.equal(used({ tool: 'Write', min: 0, max: 0 }), true, 'a must-not-call check');
  assert.equal(used({ tool: 'Bash', input_match: 'npm test' }), true);
  assert.equal(used({ tool: 'Bash', input_match: 'rm -rf' }), false);
  const order = (b, a) => gradeToolOrder({ name: 'o', type: 'tool_order', weight: 1, before: b, after: a }, r);
  assert.equal(order({ tool: 'Read' }, { tool: 'Bash' }).passed, true);
  assert.equal(order({ tool: 'Bash' }, { tool: 'Read' }).passed, false, 'first matching calls: Read@0 before Bash@1');
  assert.match(order({ tool: 'Write' }, { tool: 'Read' }).explanation, /never called/);
});

test('graders: file_exists globs over created files only', () => {
  assert.ok(globRegex('**/*.md').test('a/b/c.md'));
  assert.ok(globRegex('**/*.md').test('c.md'));
  assert.ok(!globRegex('*.md').test('a/c.md'));
  assert.ok(globRegex('out/?.txt').test('out/a.txt'));
  const r = run({ files: ['notes/today.md'] });
  assert.equal(gradeFileExists({ name: 'f', type: 'file_exists', weight: 1, path: 'notes/*.md', exists: true }, r).passed, true);
  assert.equal(gradeFileExists({ name: 'f', type: 'file_exists', weight: 1, path: 'secret.txt', exists: false }, r).passed, true);
});

test('graders: llm passes on more than half of three votes; a failed vote counts as FAIL; long text is cut in the middle', async () => {
  let n = 0;
  const judge = async () => ({ pass: ++n !== 2, reason: 'r', cost_usd: 0.01 });
  const g = { name: 'j', type: 'llm', weight: 1, criteria: 'c', focus: 'last_message' };
  const r1 = await gradeLlm(g, run({ last_message: 'x' }), judge);
  assert.equal(r1.passed, true);
  assert.deepEqual(r1.judge_votes, [true, false, true]);
  assert.equal(r1.cost_usd.toFixed(2), '0.03');
  let m = 0;
  const flaky = async () => {
    if (++m === 1) throw new Error('boom');
    return { pass: m === 2, reason: 'r', cost_usd: 0 };
  };
  const r2 = await gradeLlm(g, run({ last_message: 'x' }), flaky);
  assert.equal(r2.passed, false, '1 of 3');
  assert.equal(r2.judge_errors, 1);
  assert.ok(judgeText('a'.repeat(200000)).includes('chars elided'));
  const skipped = await grade(g, { ...run(), skipPaid: true }, judge);
  assert.match(skipped.explanation, /cost cap/);
  // The cap reached between votes: the grader is skipped by the runner, never failed by a vote.
  const capped = async () => { const e = new Error('cost cap reached'); e.cap = true; throw e; };
  await assert.rejects(grade(g, run({ last_message: 'x' }), capped), (e) => e.cap === true);
});

test('caseScore: the weighted share of graders passed; 0 for a run error', () => {
  assert.equal(caseScore([{ passed: true, weight: 1 }, { passed: false, weight: 3 }]), 0.25);
  assert.equal(caseScore([{ passed: true, weight: 1 }], { error: 'timed out' }), 0);
});

// ------------------------------------------------------------------------- matrix and noise rule

test('the default matrix: current; one effort lower; one cheaper family at medium', () => {
  assert.deepEqual(defaultMatrix({ model: 'opus', effort: 'high' }).map((c) => c.label), ['opus · high', 'opus · medium', 'sonnet · medium']);
  assert.deepEqual(defaultMatrix({ model: null, effort: null }).map((c) => c.label), ['your default model', 'your default model · medium', 'sonnet · medium']);
  assert.deepEqual(defaultMatrix({ model: 'haiku', effort: 'low' }).map((c) => c.label), ['haiku · low']);
  assert.equal(lowerEffort('max'), 'xhigh');
  assert.equal(lowerEffort('low'), null);
  assert.equal(cheaperFamily('claude-fable-5-1'), 'opus');
  assert.equal(cheaperFamily('haiku'), null);
  const cells = parseCells('current,haiku:medium', { model: 'opus', effort: 'high' });
  assert.deepEqual(cells.map((c) => [c.model, c.effort, c.current]), [['opus', null, false], ['haiku', 'medium', false]].map((x, i) => (i === 0 ? ['opus', null, true] : x)));
  assert.throws(() => parseCells('a,b,c,d,e', {}), /at most 4/);
});

test('the noise rule: k=1 within one case; k=3 within the Wilson interval; the judge controls must pass', () => {
  const five = [1, 2, 3, 4, 5].map((i) => ({ id: `c${i}` }));
  const cur = { current: true, passes: 5, runs_total: 5, runs_passed: 5, cost_per_run: 0.1, cases: five, score: 1 };
  const a = { passes: 4, runs_total: 5, runs_passed: 4, cost_per_run: 0.02, label: 'haiku', cases: five, score: 0.8 };
  const b = { passes: 3, runs_total: 5, runs_passed: 3, cost_per_run: 0.01, label: 'tiny', cases: five, score: 0.6 };
  assert.equal(holds(a, cur, { k: 1, judgeOk: true }), true);
  assert.equal(holds(b, cur, { k: 1, judgeOk: true }), false);
  assert.equal(holds(a, cur, { k: 1, judgeOk: false }), false);
  const rec = recommend([cur, a, b], { k: 1, judgeOk: true });
  assert.equal(rec.label, 'haiku');
  assert.equal(rec.saves_pct, 80);
  assert.equal(recommend([cur, a], { k: 1, judgeOk: false }), null);
  // A cell that did not finish every case never holds by default.
  assert.equal(recommend([cur, { ...a, cases: five.slice(0, 2), runs_total: 2, passes: 2 }], { k: 1, judgeOk: true, total: 5 }).current, true);
  // Too little to go on: under 3 cases, or the current setting passes under half of them.
  assert.equal(recommend([{ ...cur, cases: five.slice(0, 2), passes: 2 }, a], { k: 1, judgeOk: true }), null);
  assert.equal(recommend([{ ...cur, passes: 2 }, { ...a, passes: 1 }], { k: 1, judgeOk: true }), null);
  assert.equal(recommend([{ ...cur, passes: 3 }, { ...a, passes: 0 }], { k: 1, judgeOk: true }).current, true, 'a setting that passed nothing is never the pick');
  // k = 3: 15 runs; the current passed 14; a cell at 12/15 (0.80) is inside the interval, 9/15 is not.
  const c3 = { current: true, runs_total: 15, runs_passed: 14 };
  assert.ok(wilsonLow(14, 15) < 0.8 && wilsonLow(14, 15) > 0.6);
  assert.equal(holds({ runs_total: 15, runs_passed: 12 }, c3, { k: 3, judgeOk: true }), true);
  assert.equal(holds({ runs_total: 15, runs_passed: 9 }, c3, { k: 3, judgeOk: true }), false);
});

// ------------------------------------------------------------------------------- the estimator

test('the cost estimate: the agent\'s median cost per turn, scaled by each cell\'s price, as a range plus judge votes', () => {
  const dir = tmp();
  writeCase(dir, 'a', { prompt: promptFile({ name: 'a' }, 'Q?'), graders: { c: graderFile({ type: 'llm', weight: 1 }, 'x') }, reference: 'good' });
  const agent = { id: 'demo', name: 'Demo', kind: 'domain', dir, model: 'opus', effort: null };
  const sessions = [{ turns: 10, cost: { usd: 1, models: { 'claude-opus-5-5': 1 } }, last_activity_at: '2026-10-26T10:00:00Z' }, { turns: 10, cost: { usd: 3, models: { 'claude-opus-5-5': 3 } }, last_activity_at: '2026-10-25T10:00:00Z' }];
  const ev = new Evals({ paths: { rt: path.join(dir, '.rt'), home: dir, meMd: path.join(dir, 'me.md') }, org: { require: () => agent }, reports: { summaries: () => sessions }, sessions: {} });
  assert.equal(ev.baseline('demo').turns, 20);
  assert.equal(ev.baseline('demo').per_turn, 0.3, 'median of 10 x $0.10 and 10 x $0.30');
  const cases = loadSuite(dir, {}).cases;
  const one = ev.estimate('demo', { k: 1, cases });
  assert.equal(one.runs, 1);
  assert.equal(one.judge_votes, 3 + 6, 'three votes for the run, plus the empty and reference controls');
  assert.ok(one.low_usd > 0 && one.high_usd > one.low_usd);
  const cheap = ev.estimate('demo', { k: 1, cases, cells: [{ model: 'opus', current: true, label: 'opus' }, { model: 'haiku', effort: 'medium', label: 'haiku · medium' }] });
  assert.equal(cheap.per_cell.length, 2);
  assert.ok(cheap.per_cell[1].high < cheap.per_cell[0].high);
  assert.equal(ev.estimate('demo', { k: 3, cases }).runs, 3);
});

// --------------------------------------------------------------------------- the stream and copies

test('parseStream: tool calls, the final message, denials and cost from a real-shaped stream-json run', () => {
  const lines = [
    { type: 'system', subtype: 'init', tools: ['Read'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/NOW.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', parent_tool_use_id: 't9', message: { content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'StructuredOutput', input: { pass: true } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'My next step is the invoices.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'My next step is the invoices.', total_cost_usd: 0.0123, num_turns: 3, permission_denials: [{ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }] },
  ].map((o) => JSON.stringify(o)).join('\n');
  const r = parseStream(lines);
  assert.deepEqual(r.tool_calls.map((c) => c.name), ['Read'], 'no subagent steps, no StructuredOutput');
  assert.equal(r.last_message, 'My next step is the invoices.');
  assert.equal(r.result.total_cost_usd, 0.0123);
  assert.deepEqual(r.steps.map((s) => [s.kind, s.name || null, s.ok ?? null]), [['tool', 'Read', true], ['say', null, null]]);
});

test('copyAgentFolder: no evals/, no .env, no links out, bounded', () => {
  const src = tmp();
  fs.mkdirSync(path.join(src, 'memory'));
  fs.writeFileSync(path.join(src, 'CLAUDE.md'), '# Budget\n');
  fs.writeFileSync(path.join(src, 'memory', 'NOW.md'), 'next');
  fs.mkdirSync(path.join(src, 'evals', 'a'), { recursive: true });
  fs.writeFileSync(path.join(src, 'evals', 'a', 'prompt.md'), 'secret test');
  fs.writeFileSync(path.join(src, '.env'), 'TOKEN=1');
  fs.writeFileSync(path.join(src, '.env.local'), 'TOKEN=1');
  try {
    fs.symlinkSync(os.homedir(), path.join(src, 'home-link'));
  } catch {
    // no symlinks here (Windows without the right): nothing to test for links
  }
  const dest = path.join(tmp(), 'copy');
  copyAgentFolder(src, dest);
  assert.ok(fs.existsSync(path.join(dest, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(dest, 'memory', 'NOW.md')));
  for (const gone of ['evals', '.env', '.env.local', 'home-link']) assert.equal(fs.existsSync(path.join(dest, gone)), false, gone);
});

// ------------------------------------------------------------------------- review fixes (round 1)

const stubEvals = (dir, { spawn, env = {} } = {}) => {
  const agent = { id: 'demo', name: 'Demo', kind: 'domain', dir, model: null, effort: null };
  const ev = new Evals({ paths: { rt: path.join(dir, '.rt'), home: dir, env: path.join(dir, '.env'), meMd: path.join(dir, 'me.md') }, org: { require: () => agent }, reports: { summaries: () => [] }, sessions: {}, env: { PATH: '', ...env } });
  ev.claude = () => '/bin/claude';
  const calls = [];
  ev.spawnClaude = async (bin, args, opts) => {
    calls.push({ args, opts });
    return spawn(args, opts);
  };
  const work = tmp();
  ev.scratch = async () => ({ dir: work, cwd: work, notes: work, ctxFile: path.join(work, 'ctx.md'), settingsFile: path.join(work, 's.json'), entry: { dir: work } });
  ev.removeScratch = async () => fs.rmSync(work, { recursive: true, force: true });
  ev.unregister = () => {};
  return { ev, agent, calls, work };
};
const caseOf = (graders = [], fm = {}) => ({ id: 'a', prompt: 'Q?', graders, fm: { allowed_tools: [], max_turns: 3, timeout_seconds: 10, ...fm } });

test('cost cap: a run with no result line (timeout, crash) counts as its whole budget, so the cap holds', async () => {
  const dir = tmp();
  const { ev, agent, calls } = stubEvals(dir, { spawn: async () => ({ code: null, stdout: '{"type":"system"}\n', stderr: '', timedOut: true, truncated: false }) });
  const state = { id: 'x', cap: 0.5, spent: 0, judgeCost: 0, judgeModel: 'haiku' };
  const r = await ev.runCase(agent, caseOf(), { model: null }, state, 1);
  assert.equal(r.cost, 0.5);
  assert.equal(r.cost_unknown, true);
  assert.equal(state.spent, 0.5);
  assert.match(r.error, /timed out/);
  assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd') + 1], '0.5');
  await assert.rejects(ev.runCase(agent, caseOf(), { model: null }, state, 2), (e) => e.cap === true, 'no second launch');
  assert.equal(calls.length, 1);
  // A judge vote with no result is charged its budget too.
  const st2 = { id: 'y', cap: 1, spent: 0, judgeCost: 0, judgeModel: 'haiku' };
  ev.spawnClaude = async () => ({ code: null, stdout: '', stderr: '', timedOut: true, truncated: false });
  await assert.rejects(ev.judgeVote(st2, { criteria: 'c', text: 't', focus: 'last_message' }));
  assert.equal(st2.spent, 0.05);
});

test('check-up runs: read-only tools, user settings only, no --allowedTools, file graders read before cleanup', async () => {
  const dir = tmp();
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.02, num_turns: 2 };
  const { ev, agent, calls, work } = stubEvals(dir, {
    spawn: async (args, opts) => {
      fs.mkdirSync(path.join(opts.cwd, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, 'notes', 'out.md'), 'the invoices are next\n');
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '', timedOut: false, truncated: false };
    },
  });
  const g = parseGrader('says', '---\ntype: regex\ntarget: {source: file, path: notes/out.md}\n---\ninvoices');
  const state = { id: 'x', cap: 2, spent: 0, judgeCost: 0, judgeModel: 'haiku' };
  const r = await ev.runCase(agent, caseOf([g], { allowed_tools: ['Read', 'Grep'] }), { model: null }, state, 1);
  assert.equal(fs.existsSync(work), false, 'the scratch copy is gone');
  assert.equal(r.cost, 0.02);
  assert.equal(gradeRegex(g, { ...r.run }).passed, true, 'graded from the text read before cleanup');
  const a = calls[0].args;
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Grep');
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'user', 'never the agent-editable project settings');
  assert.ok(!a.includes('--allowedTools'));
});

test('check-up environment: credentials and the org .env stay out; the CLI keeps its own sign-in', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'ORG_ONLY=1\nANTHROPIC_MODEL=x\n');
  const { ev } = stubEvals(dir, { spawn: async () => ({}), env: { HOME: dir, GH_TOKEN: 'g', PGPASSWORD: 'p', DATABASE_URL: 'postgres://u:secret@h/db', ORG_ONLY: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'x', CLAUDE_CONFIG_DIR: '/c', AWS_ACCESS_KEY_ID: 'a', CLAWDLING_TOKEN: 't', LANG: 'C' } });
  const env = ev.baseEnv();
  for (const k of ['GH_TOKEN', 'PGPASSWORD', 'DATABASE_URL', 'ORG_ONLY', 'CLAWDLING_TOKEN']) assert.equal(env[k], undefined, k);
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'AWS_ACCESS_KEY_ID', 'LANG', 'HOME']) assert.ok(env[k], k);
});

test('symlinks: a linked evals/, case folder or graders/ is refused, never listed, written into or deleted', () => {
  const dir = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(outside, 'code'));
  fs.writeFileSync(path.join(outside, 'code', 'keep.txt'), 'x');
  const dirLink = process.platform === 'win32' ? 'junction' : 'dir'; // junctions need no admin rights
  fs.symlinkSync(outside, path.join(dir, 'evals'), dirLink);
  const s = loadSuite(dir, {});
  assert.deepEqual(s.cases, [], 'the linked folder\'s children are not shown as cases');
  assert.match(s.settings_error, /link/);
  const body = { prompt: promptFile({ name: 'code' }, 'Q?'), graders: { c: graderFile({ type: 'llm' }, 'x') } };
  assert.throws(() => writeCase(dir, 'code', body), /link/);
  assert.throws(() => caseDir(dir, 'code'), /link/);
  assert.ok(fs.existsSync(path.join(outside, 'code', 'keep.txt')));
  assert.ok(!fs.existsSync(path.join(outside, 'code', 'prompt.md')));
  // A real evals/ with a linked case folder or graders/ folder.
  const d2 = tmp();
  fs.mkdirSync(path.join(d2, 'evals'));
  fs.symlinkSync(outside, path.join(d2, 'evals', 'code'), dirLink);
  assert.throws(() => writeCase(d2, 'code', body), /link/);
  writeCase(d2, 'real', body);
  fs.rmSync(path.join(d2, 'evals', 'real', 'graders'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'code'), path.join(d2, 'evals', 'real', 'graders'), dirLink);
  assert.throws(() => writeCase(d2, 'real', body), /link/);
  assert.deepEqual(fs.readdirSync(path.join(outside, 'code')), ['keep.txt']);
  assert.match(loadSuite(d2, {}).cases.find((c) => c.id === 'real').error, /grader/);
});

test('regex graders run in a sandbox with a deadline: a pattern that backtracks fails, the server does not freeze', () => {
  const t0 = Date.now();
  const r = gradeRegex({ name: 'bad', type: 'regex', pattern: '^(a+)+$', flags: '', match: 'contains', target: 'last_message', weight: 1 }, run({ last_message: `${'a'.repeat(40)}b` }));
  assert.equal(r.passed, false);
  assert.match(r.explanation, /backtracks/);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(runRegex('b', 'i', 'aBc'), { value: true });
  const timedOut = gradeToolUsed({ name: 't', tool: 'Read', input_match: '"(a+)+$', min: 0, max: 0 }, run({ tool_calls: [call('Read', { p: `${'a'.repeat(30)}b` })] }));
  assert.equal(timedOut.passed, false, 'a "must not call" grader whose pattern timed out fails, never passes');
  assert.match(timedOut.explanation, /input_match/);
  assert.deepEqual(fileTexts([], run()), {});
});

test('controls: a judge that only errors makes the controls fail (judge unreliable), even on the empty answer', async () => {
  const dir = tmp();
  const { ev } = stubEvals(dir, { spawn: async () => ({}) });
  ev.judgeVote = async () => {
    throw new Error('boom');
  };
  const g = parseGrader('c', '---\ntype: llm\n---\nNames the budget.');
  const out = await ev.controls([{ id: 'a', graders: [g], reference: null }], { spent: 0, cap: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].judge_errors, 3);
});

test('deny rules: by path and real path; a folder a rule cannot name stops the check-up', () => {
  const dir = tmp();
  const rules = denyRules([path.join(dir, 'evals')]);
  const real = fs.realpathSync.native(dir);
  assert.ok(rules.includes(absPathRule('Edit', path.join(real, 'evals'))), 'the real path, though evals/ does not exist yet');
  if (absPathRule('Read', path.join(dir, 'evals'))) assert.ok(rules.includes(absPathRule('Read', path.join(dir, 'evals'))), 'and the path as given');
  assert.throws(() => denyRules(['/home/x~y/evals'], 'linux'), /cannot name the folder/);
});

// ------------------------------------------------------------------------- review fixes (round 3)

test('readPlain: the draft reads only plain files through real folders, the first or last bytes', () => {
  const dir = tmp();
  const secret = path.join(tmp(), 'credentials.json');
  fs.writeFileSync(secret, '{"token":"sk-secret"}');
  fs.mkdirSync(path.join(dir, 'memory'));
  fs.writeFileSync(path.join(dir, 'memory', 'LOG.md'), `${'old line\n'.repeat(5000)}newest line\n`);
  let linked = true;
  try {
    fs.symlinkSync(secret, path.join(dir, 'CLAUDE.md'));
  } catch {
    linked = false;
  }
  if (linked) assert.equal(readPlain(dir, path.join(dir, 'CLAUDE.md')), '', 'a link the agent made is not followed');
  assert.match(readPlain(dir, path.join(dir, 'memory', 'LOG.md'), 100, { tail: true }), /newest line\n$/);
  assert.equal(readPlain(dir, path.join(dir, 'memory', 'LOG.md'), 20).endsWith('[truncated]'), true);
  assert.equal(readPlain(dir, secret), '', 'outside the folder');
  const d2 = tmp();
  fs.symlinkSync(path.dirname(secret), path.join(d2, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readPlain(d2, path.join(d2, 'memory', 'credentials.json')), '', 'nor through a linked folder');
});

test('removeInside: the committed evals/ goes from the scratch worktree, never through a link', () => {
  const wt = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(outside, 'evals'));
  fs.writeFileSync(path.join(outside, 'evals', 'keep.md'), 'x');
  fs.mkdirSync(path.join(wt, 'projects'));
  fs.symlinkSync(outside, path.join(wt, 'projects', 'web'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(removeInside(wt, path.join('projects', 'web', 'evals')), false);
  assert.ok(fs.existsSync(path.join(outside, 'evals', 'keep.md')), 'nothing outside was deleted');
  fs.mkdirSync(path.join(wt, 'evals', 'a'), { recursive: true });
  assert.equal(removeInside(wt, path.join('', 'evals')), true, 'an agent folder at the repo top');
  assert.equal(fs.existsSync(path.join(wt, 'evals')), false);
  assert.equal(removeInside(wt, ''), false, 'never the root itself');
});

test('budgets: a run or vote never gets more than is left; under a cent left, nothing launches', async () => {
  const dir = tmp();
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.001, num_turns: 1 };
  const { ev, agent, calls } = stubEvals(dir, { spawn: async () => ({ code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '', timedOut: false, truncated: false }) });
  await ev.runCase(agent, caseOf(), { model: null }, { id: 'a', cap: 0.016, spent: 0, judgeCost: 0 }, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd') + 1], '0.01', 'rounded down, not up to 0.02');
  await assert.rejects(ev.runCase(agent, caseOf(), { model: null }, { id: 'b', cap: 0.006, spent: 0, judgeCost: 0 }, 2), (e) => e.cap === true);
  await assert.rejects(ev.judgeVote({ cap: 1, spent: 0.997, judgeCost: 0, judgeModel: 'haiku' }, { criteria: 'c', text: 't', focus: 'last_message' }), (e) => e.cap === true);
  assert.equal(calls.length, 1, 'neither of the last two launched');
});

test('check-up context: the repo\'s CLAUDE.md is read as a plain file only, never through a committed link', async () => {
  const { SessionManager } = await import('../../server/sessions.js');
  const dir = tmp();
  const wt = tmp();
  const secret = path.join(tmp(), 'credentials');
  fs.writeFileSync(secret, 'aws_secret_access_key = SECRETKEY');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Web agent\n@memory/NOW.md\n');
  fs.mkdirSync(path.join(dir, 'memory'));
  fs.writeFileSync(path.join(dir, 'memory', 'NOW.md'), 'shipping the login page');
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'Use pnpm.');
  let linked = true;
  try {
    fs.symlinkSync(secret, path.join(wt, 'AGENTS.md'));
  } catch {
    linked = false;
  }
  const self = { org: { read: () => ({ owner: 'Sam' }) }, home: dir, paths: { meMd: path.join(dir, 'me.md'), orgClaudeMd: path.join(dir, 'org.md') }, groupRepos: () => ['/code/api'], isDir: () => true };
  const text = SessionManager.prototype.contextText.call(self, { id: 'web', name: 'Web', kind: 'project', dir, cwd: wt }, { orgRules: true });
  assert.match(text, /# Web agent/);
  assert.match(text, /shipping the login page/);
  assert.match(text, /Use pnpm\./, 'the repo\'s own CLAUDE.md');
  if (linked) assert.ok(!text.includes('SECRETKEY'), 'a committed link is not followed');
  assert.match(text, /not part of this run/, 'a group agent is told its repos are not here');
});

test('a claude that never started is charged nothing', async () => {
  const dir = tmp();
  const { ev, agent } = stubEvals(dir, { spawn: async () => ({ code: null, stdout: '', stderr: 'spawn ENOENT', timedOut: false, truncated: false, started: false }) });
  const state = { id: 'x', cap: 2, spent: 0, judgeCost: 0 };
  const r = await ev.runCase(agent, caseOf(), { model: null }, state, 1);
  assert.equal(r.cost, 0);
  assert.equal(state.spent, 0);
});

test('review 5: a check-up whose copy cannot be made ends with an error and no score, and spends no votes', async () => {
  const dir = tmp();
  const { ev, agent } = stubEvals(dir, { spawn: async () => ({}) });
  ev.controls = async () => [];
  ev.scratch = async () => {
    const e = new Error('the agent folder is too big to copy');
    e.scratch = true;
    throw e;
  };
  let votes = 0;
  ev.judgeVote = async () => {
    votes++;
    return { pass: true, reason: '', cost_usd: 0 };
  };
  const g = parseGrader('c', '---\ntype: llm\n---\nNames the budget.');
  const state = { id: 'x', agent: 'demo', started_at: new Date().toISOString(), cap: 2, spent: 0, judgeCost: 0, judgeModel: 'haiku', done: 0 };
  const result = await ev.runSuite(agent, [caseOf([g], { name: 'a' })], { k: 1, cells: [{ model: null, current: true, label: 'current' }], state, suiteSkipped: 0 });
  assert.match(result.error, /could not make the check-up's copy/);
  assert.equal(result.score, null);
  assert.equal(votes, 0);
});

test('a project agent\'s cases are approved for its repo: pointing agent.json at another repo needs approval again', () => {
  const dir = tmp();
  const repoA = tmp();
  const repoB = tmp();
  const agent = { id: 'web', name: 'Web', kind: 'project', dir, repo: repoA };
  const ev = new Evals({ paths: { rt: path.join(dir, '.rt'), home: dir, meMd: path.join(dir, 'me.md') }, org: { require: () => agent }, reports: { summaries: () => [] }, sessions: {} });
  writeCase(dir, 'a', { prompt: promptFile({ name: 'a' }, 'Q?'), graders: { c: graderFile({ type: 'llm' }, 'x') } });
  const c = ev.suite('web').cases[0];
  ev.approvals.set('web', { a: c.hash });
  assert.equal(ev.suite('web').cases[0].approved, true);
  agent.repo = repoB; // the agent edits its own agent.json
  assert.equal(ev.suite('web').cases[0].approved, false);
  assert.throws(() => ev.start('web'), /approve/i);
  agent.repo = repoA;
  assert.equal(ev.suite('web').cases[0].approved, true);
});
