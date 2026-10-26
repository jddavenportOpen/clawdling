import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caseScore, globRegex, grade, gradeFileExists, gradeLlm, gradeRegex, gradeToolOrder, gradeToolUsed, judgeText } from '../../server/evals/graders.js';
import { cheaperFamily, copyAgentFolder, defaultMatrix, holds, lowerEffort, parseCells, parseStream, recommend, wilsonLow, Evals } from '../../server/evals/runner.js';
import { GRADER_KEYS, PLUGIN_EVAL_GRADER_KEYS, PLUGIN_EVAL_PROMPT_KEYS, PROMPT_KEYS, graderFile, loadSuite, parseGrader, parsePrompt, parseSettings, promptFile, toolProblem, writeCase } from '../../server/evals/suite.js';
import { splitFrontmatter } from '../../server/yaml-lite.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-evals-'));
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

test('toolProblem: read-only tools and listed Bash commands only', () => {
  for (const ok of ['Read', 'Glob', 'Grep', 'LS', 'Bash(npm test:*)', 'Bash(go test ./...)', 'Bash(git status)']) assert.equal(toolProblem(ok), null, ok);
  for (const bad of ['Bash', 'Bash(*)', 'Bash()', 'Write', 'Edit', 'WebFetch', 'mcp__x__y', 'Bash(sh -c:*)', 'Bash(curl:*)', 'Bash(python:*)', 'Bash(npm test && rm -rf /)', 'Bash(rm -rf ~;:*)']) assert.ok(toolProblem(bad), bad);
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
  const cur = { current: true, passes: 5, runs_total: 5, runs_passed: 5, cost_per_run: 0.1 };
  const a = { passes: 4, runs_total: 5, runs_passed: 4, cost_per_run: 0.02, label: 'haiku' };
  const b = { passes: 3, runs_total: 5, runs_passed: 3, cost_per_run: 0.01, label: 'tiny' };
  assert.equal(holds(a, cur, { k: 1, judgeOk: true }), true);
  assert.equal(holds(b, cur, { k: 1, judgeOk: true }), false);
  assert.equal(holds(a, cur, { k: 1, judgeOk: false }), false);
  const rec = recommend([cur, a, b], { k: 1, judgeOk: true });
  assert.equal(rec.label, 'haiku');
  assert.equal(rec.saves_pct, 80);
  assert.equal(recommend([cur, a], { k: 1, judgeOk: false }), null);
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
