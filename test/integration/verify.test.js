// Verified done (1.6) against a real server and the fake claude: claim receipts on real runs of a
// project's test command, the ship check in a scratch worktree (the live repo untouched, a crash
// swept on restart), and agent check-ups (draft, approve, run, the judge controls, the cost cap,
// Try a cheaper model), and the CLI's exit codes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cliResult, cli, killTmux, readJsonFile, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let srv;
let repo;
let env;

const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });

/** Every file under a folder (not .git), with its bytes: a change anywhere changes the hash. */
function treeHash(dir, { skip = [] } = {}) {
  const h = crypto.createHash('sha256');
  const visit = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || skip.includes(rel ? `${rel}/${e.name}` : e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(d, e.name), r);
      else {
        h.update(r);
        h.update(fs.readFileSync(path.join(d, e.name)));
      }
    }
  };
  visit(dir, '');
  return h.digest('hex');
}

const leftovers = (prefix) => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix));
const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
const status = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body.status;
// After a synchronous CLI call (which blocks this process past the server's 5 s keep-alive), a GET
// first: request() retries a read on a dead socket, never a write.
const wake = () => request(srv, 'GET', '/api/health');
const claims = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}/claims`)).body.claims;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  repo = path.join(home, 'demo-repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node test.js', build: 'node -e "console.log(\'built\')"', lint: 'node -e "process.exit(0)"' } }, null, 2));
  fs.writeFileSync(path.join(repo, 'test.js'), "const v = require('./v.js');\nif (v !== 2) { console.error('Error: expected 2, got ' + v); console.error('# fail 1'); process.exit(1); }\nconsole.log('ok 1 - value is 2');\n");
  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 2;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'), FAKE_CLAUDE_LOG: path.join(home, 'fake.log') });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
  const a = await request(srv, 'POST', '/api/agents', { kind: 'project', name: 'Demo', repo });
  assert.equal(a.status, 201, a.text);
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

async function turn(sid, text) {
  const before = (await claims(sid)).length;
  const r = await request(srv, 'POST', `/api/sessions/${sid}/send`, { text });
  assert.equal(r.status, 204, r.text);
  await waitFor(async () => (await status(sid)) === 'ready' && (await claims(sid)).length > before, { label: `turn "${text}"`, timeout: 30000 });
  const list = await claims(sid);
  return list[list.length - 1];
}

test('claim receipts: a passing test is Verified, a failing one Contradicted, an edit after the pass Not verified', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'demo' })).body;
  await waitFor(async () => (await status(s.sid)) === 'ready', { label: 'ready', timeout: 20000 });

  const v = await turn(s.sid, 'verify: npm test | Done. All tests pass.');
  assert.equal(v.label, 'verified', JSON.stringify(v));
  assert.equal(v.kind, 'tests');
  assert.equal(v.check.cmd, 'npm test');
  assert.match(v.badge, /^Verified: `npm test` passed at .+, after the last edit$/);

  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 3;\n');
  const c = await turn(s.sid, "verify: npm test | Fixed. It's working now.");
  assert.equal(c.label, 'contradicted', JSON.stringify(c));
  assert.match(c.check.first_error_line, /expected 2, got 3/);
  assert.equal(c.fix, 'Your last check failed: `npm test` → `Error: expected 2, got 3`. Please fix it and re-run the check.');

  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 2;\n');
  const n = await turn(s.sid, 'verify-edit: npm test | Done, all tests pass.');
  assert.equal(n.label, 'not_verified', 'the edit after the passing test makes it stale');

  const r = (await request(srv, 'GET', '/api/agents/demo/report?window=today')).body;
  const row = r.done.find((d) => d.sid === s.sid);
  assert.equal(row.claim.label, 'not_verified', 'the Done row shows the session\'s last claim');
  assert.deepEqual(r.verified.claims_7d, { verified: 1, not_verified: 1, contradicted: 1, no_changes: 0 });
  // The receipt keeps the evidence, never the output.
  const receipt = readJsonFile(path.join(home, '.clawdling', 'ledger', `${s.sid}.json`));
  assert.ok(receipt === null || !JSON.stringify(receipt).includes('ok 1 - value is 2'));
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
});

test('a contradicted claim waits in Needs you; "Ask the agent to fix it" sends exactly the text shown', async () => {
  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 5;\n');
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'demo' })).body;
  await waitFor(async () => (await status(s.sid)) === 'ready', { label: 'ready', timeout: 20000 });
  const c = await turn(s.sid, 'verify: npm test | Done.');
  assert.equal(c.label, 'contradicted');
  const r = (await request(srv, 'GET', '/api/agents/demo/report?window=today')).body;
  const need = r.needs.find((x) => x.sid === s.sid);
  assert.equal(need.kind, 'contradicted');
  assert.equal(need.fix, c.fix);
  const org = (await request(srv, 'GET', '/api/org')).body;
  assert.equal(org.agents.find((a) => a.id === 'demo').needs_you, r.needs.length, 'the same count as the rail');
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/fix`, { text: 'something else' })).status, 409);
  const sent = await request(srv, 'POST', `/api/sessions/${s.sid}/fix`, { text: c.fix });
  assert.equal(sent.status, 200, sent.text);
  await waitFor(async () => /Please fix it and re-run the check\./.test((await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.last_message || ''), { label: 'the session got the message', timeout: 20000 });
  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 2;\n');
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
});

test('ship check: proposals, approval with the shown commands, a run in a scratch worktree; the live repo is byte-identical', async () => {
  let v = (await request(srv, 'GET', '/api/agents/demo/checks')).body;
  assert.equal(v.available, true);
  assert.equal(v.exists, false);
  const runs = v.proposals.map((p) => p.run);
  assert.ok(runs.includes('npm test') && runs.includes('npm run build'), runs.join(', '));
  assert.match(v.proposals.find((p) => p.run === 'npm test').what, /Runs the "test" script from package.json: node test\.js/);
  assert.match(v.notes.untracked, /New files the agent has not added to git are not included/);
  assert.equal((await request(srv, 'POST', '/api/agents/demo/checks/run')).status, 409, 'nothing runs before approval');

  const body = { checks: [{ name: 'tests', run: 'npm test', timeout: 120 }, { name: 'build', run: 'npm run build', timeout: 120 }] };
  assert.equal((await request(srv, 'PUT', '/api/agents/demo/checks', body)).status, 400, 'the shown commands must be echoed');
  assert.equal((await request(srv, 'PUT', '/api/agents/demo/checks', { ...body, shown: ['npm test', 'npm run lint'] })).status, 400);
  v = (await request(srv, 'PUT', '/api/agents/demo/checks', { ...body, shown: ['npm test', 'npm run build'] })).body;
  assert.equal(v.approved, true);
  const yaml = fs.readFileSync(path.join(home, 'projects', 'demo', 'checks.yaml'), 'utf8');
  assert.match(yaml, /run: npm test/);

  // An uncommitted change to a tracked file is checked; an untracked file is not carried over.
  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked\n');
  const before = treeHash(repo);
  const porcelain = git('status', '--porcelain');
  const started = await request(srv, 'POST', '/api/agents/demo/checks/run');
  assert.equal(started.status, 202, started.text);
  v = await waitFor(async () => {
    const x = (await request(srv, 'GET', '/api/agents/demo/checks')).body;
    return !x.running && x.last ? x : null;
  }, { label: 'ship check done', timeout: 60000 });
  assert.equal(v.last.ok, false);
  assert.deepEqual(v.last.results.map((r) => [r.name, r.ok]), [['tests', false], ['build', true]], JSON.stringify(v.last.results.map((r) => ({ name: r.name, exit: r.exit, timed_out: r.timed_out, err1: r.err1, tail: r.tail.slice(-8) }))));
  assert.match(v.last.results[0].err1, /expected 2, got 3/);
  assert.ok(v.last.results[0].tail.length <= 40);
  assert.equal(treeHash(repo), before, 'the live repo is byte-identical');
  assert.equal(git('status', '--porcelain'), porcelain);
  assert.equal(worktrees(), 1, 'the scratch worktree is gone');
  assert.deepEqual(leftovers('clawdling-check-demo-'), []);

  // An edit to checks.yaml (by anyone, the agent included) needs approval again.
  fs.appendFileSync(path.join(home, 'projects', 'demo', 'checks.yaml'), '  - name: extra\n    run: "node -e 1"\n');
  assert.equal((await request(srv, 'GET', '/api/agents/demo/checks')).body.approved, false);
  assert.equal((await request(srv, 'POST', '/api/agents/demo/checks/run')).status, 409);
  v = (await request(srv, 'PUT', '/api/agents/demo/checks', { ...body, shown: ['npm test', 'npm run build'] })).body;
  assert.equal(v.approved, true);
  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 2;\n');
  fs.rmSync(path.join(repo, 'notes.txt'));
});

test('a ship check after the last edit turns Not verified into Verified', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'demo' })).body;
  await waitFor(async () => (await status(s.sid)) === 'ready', { label: 'ready', timeout: 20000 });
  const n = await turn(s.sid, 'verify-edit: npm test | Done.');
  assert.equal(n.label, 'not_verified');
  await request(srv, 'POST', '/api/agents/demo/checks/run');
  await waitFor(async () => {
    const x = (await request(srv, 'GET', '/api/agents/demo/checks')).body;
    return !x.running && x.last && x.last.ok ? x : null;
  }, { label: 'a passing ship check', timeout: 60000 });
  const after = (await claims(s.sid)).pop();
  assert.equal(after.label, 'verified');
  assert.equal(after.check.ship, true);
  assert.match(after.badge, /\(ship check\)$/);
  const r = (await request(srv, 'GET', '/api/agents/demo/report?window=today')).body;
  assert.equal(r.verified.ship.last.ok, true);
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
});

test('CLI: clawdling check runs the approved ship check, with --json and exit codes', async () => {
  const ok = cliResult(['check', 'demo', '--json'], { env, home, timeout: 90000 });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 4;\n');
  const bad = cliResult(['check', 'demo'], { env, home, timeout: 90000 });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /FAIL {2}tests: npm test/);
  fs.writeFileSync(path.join(repo, 'v.js'), 'module.exports = 2;\n');
  assert.notEqual(cliResult(['check', 'health'], { env, home }).code, 0, 'a domain agent has no ship check');
  await wake();
});

test('a crash in the middle of a ship check leaves no worktree once Clawdling starts again', async () => {
  const slow = { checks: [{ name: 'slow', run: 'node -e "setTimeout(() => {}, 4000)"', timeout: 60 }] };
  await request(srv, 'PUT', '/api/agents/demo/checks', { ...slow, shown: [slow.checks[0].run] });
  await request(srv, 'POST', '/api/agents/demo/checks/run');
  await waitFor(() => worktrees() === 2, { label: 'the scratch worktree exists', timeout: 20000 });
  const active = readJsonFile(path.join(home, '.clawdling', 'checks', 'active.json'));
  assert.equal(active.runs.length, 1);
  srv.child.kill('SIGKILL');
  await waitFor(() => srv.child.exitCode !== null || srv.child.signalCode !== null, { label: 'server gone' });
  await new Promise((r) => setTimeout(r, 5000)); // the orphaned check finishes (Windows keeps a running process's folder)
  assert.equal(worktrees(), 2, 'still there after the crash');
  srv = await startServerProc({ home, env });
  await waitFor(() => worktrees() === 1, { label: 'swept on start', timeout: 20000 });
  assert.deepEqual(leftovers('clawdling-check-demo-'), []);
  assert.deepEqual(readJsonFile(path.join(home, '.clawdling', 'checks', 'active.json')).runs, []);
  const back = { checks: [{ name: 'tests', run: 'npm test', timeout: 120 }] };
  await request(srv, 'PUT', '/api/agents/demo/checks', { ...back, shown: ['npm test'] });
});

// ------------------------------------------------------------------------------------- check-ups

const evalsDir = () => path.join(home, 'domains', 'health', 'evals');

async function runCheckup(body = {}) {
  const r = await request(srv, 'POST', '/api/agents/health/evals/run', body);
  assert.equal(r.status, 202, r.text);
  const v = await waitFor(async () => {
    const x = (await request(srv, 'GET', '/api/agents/health/evals')).body;
    return !x.active && x.last_run && x.last_run.id === r.body.id ? x : null;
  }, { label: 'check-up done', timeout: 120000, interval: 200 });
  return { view: v, result: v.history.find((h) => h.id === r.body.id) };
}

test('check-up: draft five cases, nothing runs until they are approved, then a run in a scratch copy', async () => {
  let v = (await request(srv, 'GET', '/api/agents/health/evals')).body;
  assert.equal(v.cases.length, 0);
  assert.equal((await request(srv, 'POST', '/api/agents/health/evals/run', {})).status, 409);
  const d = await request(srv, 'POST', '/api/agents/health/evals/draft');
  assert.equal(d.status, 200, d.text);
  v = d.body;
  assert.deepEqual(v.cases.map((c) => c.id).sort(), ['declines-out-of-scope', 'follows-house-rules', 'knows-its-job', 'knows-its-next-step', 'remembers-last-handoff']);
  assert.ok(v.cases.every((c) => !c.approved && !c.error), 'drafted cases wait for the owner');
  assert.equal(v.runnable, 0);
  assert.equal((await request(srv, 'POST', '/api/agents/health/evals/run', {})).status, 409, 'the draft never runs by itself');
  const prompt = fs.readFileSync(path.join(evalsDir(), 'knows-its-job', 'prompt.md'), 'utf8');
  assert.match(prompt, /^---\nname: knows-its-job\ndescription: .+\nmax_turns: 6\ntimeout_seconds: 180\nallowed_tools: \[Read, Glob, Grep\]\n---/);
  assert.ok(fs.existsSync(path.join(evalsDir(), 'knows-its-job', 'graders', 'mentions.md')));

  // Approve exactly what was read.
  const stale = await request(srv, 'POST', '/api/agents/health/evals/approve', { cases: [{ id: 'knows-its-job', hash: 'nope' }] });
  assert.equal(stale.status, 409);
  v = (await request(srv, 'POST', '/api/agents/health/evals/approve', { cases: v.cases.map((c) => ({ id: c.id, hash: c.hash })) })).body;
  assert.equal(v.runnable, 5);
  assert.ok(v.estimate.low_usd > 0 && v.estimate.high_usd >= v.estimate.low_usd);
  assert.equal(v.estimate.runs, 5);

  const live = treeHash(path.join(home, 'domains', 'health'), { skip: ['evals'] });
  fs.writeFileSync(path.join(home, 'domains', 'health', '.env'), 'SECRET_THING=1\n');
  fs.rmSync(path.join(home, 'fake.log'), { force: true });
  const { result } = await runCheckup({});
  assert.equal(result.judge_unreliable, false);
  assert.equal(result.capped, false, JSON.stringify({ cost: result.cost_usd, error: result.error, runs: result.cells?.map((c) => c.cases.map((x) => x.runs.map((r) => r.error))) }));
  assert.equal(result.score, 1, JSON.stringify(result.cells?.[0]?.cases?.map((c) => [c.id, c.runs.map((r) => r.graders.map((g) => `${g.name}:${g.passed}:${g.explanation}`))])));
  assert.ok(result.controls.length >= 10 && result.controls.every((x) => x.ok), 'an empty answer failed and every reference passed');
  // 30 control votes + 5 runs + 15 run votes, at the fake's prices.
  assert.equal(result.cost_usd.toFixed(2), (30 * 0.01 + 5 * 0.05 + 15 * 0.01).toFixed(2));
  const run = result.cells[0].cases[0].runs[0];
  assert.ok(run.steps.some((s) => s.kind === 'tool' && s.name === 'Read'), 'each run keeps its steps for the Timeline');
  fs.rmSync(path.join(home, 'domains', 'health', '.env'));
  assert.equal(treeHash(path.join(home, 'domains', 'health'), { skip: ['evals'] }), live, 'the live agent folder is unchanged');

  const logs = fs.readFileSync(path.join(home, 'fake.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const runs = logs.filter((l) => l.mode === 'checkup-run');
  assert.equal(runs.length, 5);
  for (const r of runs) {
    assert.match(path.basename(path.dirname(r.cwd)), /^clawdling-eval-health-/, 'in a scratch copy');
    assert.equal(r.evalsHere, false, 'the agent cannot read its own test');
    assert.equal(r.envFile, false, 'no .env in the scratch copy');
    assert.equal(r.hasCtx, true);
    assert.equal(r.tools, 'Read,Glob,Grep');
    assert.deepEqual(r.allowedTools, []);
    assert.match(r.claudeMd, /Health/);
    assert.equal(r.settingSources, 'user', 'never the agent-editable project settings');
    assert.equal(r.agentFileInCtx, true, 'its CLAUDE.md reaches it through the context, since no project CLAUDE.md loads');
  }
  const settings = runs[0].settings;
  assert.ok(settings && !fs.existsSync(settings), 'the run settings file went with the scratch copy');
  const printed = logs.filter((l) => l.mode === 'print' || l.mode === 'checkup-print' || l.mode === 'checkup-run');
  assert.ok(printed.every((l) => !l.argv || (l.argv.includes('--no-session-persistence') && l.argv.includes('--strict-mcp-config'))));
  assert.deepEqual(leftovers('clawdling-eval-health-'), []);
  // Results live in Clawdling's own folder, out of the agent's reach.
  assert.ok(fs.readdirSync(path.join(home, '.clawdling', 'evals', 'health', 'results')).length >= 1);
  assert.ok(!fs.existsSync(path.join(evalsDir(), 'results')), 'not in the agent folder');
});

test('check-up: the cost cap is checked before every launch and each run carries --max-budget-usd', async () => {
  fs.rmSync(path.join(home, 'fake.log'), { force: true });
  const { result } = await runCheckup({ maxCostUsd: 0.4 });
  assert.equal(result.capped, true);
  assert.equal(result.score, null, 'no score from a run the cap cut short');
  assert.ok(result.cells[0].agent_runs < 5, `stopped launching: ${result.cells[0].agent_runs} runs`);
  assert.ok(result.cost_usd <= 0.4 + 1e-9, `${result.cost_usd}`);
  const logs = fs.readFileSync(path.join(home, 'fake.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.mode === 'checkup-run');
  assert.ok(logs.every((l) => l.maxBudget > 0 && l.maxBudget <= 0.1 + 1e-9), JSON.stringify(logs.map((l) => l.maxBudget)));
  const cli1 = cliResult(['checkup', 'health', '--max-cost', '0.4', '--json'], { env, home, timeout: 120000 });
  assert.equal(cli1.code, 2, 'exit 2 when the cap was hit');
  await wake();
});

test('check-up: a deliberately lenient rubric makes the judge unreliable, and no score is shown', async () => {
  const body = {
    prompt: '---\nname: lenient-case\ndescription: A rubric that passes anything\nmax_turns: 3\ntimeout_seconds: 60\nallowed_tools: [Read]\n---\n\nSay something.\n',
    graders: { loose: '---\ntype: llm\nweight: 1\n---\n\nAnything is fine.\n' },
  };
  const saved = await request(srv, 'PUT', '/api/agents/health/evals/lenient-case', body);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.cases.find((c) => c.id === 'lenient-case').approved, true, 'written in the cockpit: approved as written');
  const { result } = await runCheckup({});
  assert.equal(result.judge_unreliable, true);
  assert.equal(result.score, null);
  assert.deepEqual(result.cells, [], 'no agent run is spent once the judge is unreliable');
  assert.ok(result.controls.some((c) => c.case === 'lenient-case' && c.kind === 'empty' && !c.ok));
  const c2 = cliResult(['checkup', 'health', '--json'], { env, home, timeout: 120000 });
  assert.equal(c2.code, 2, 'exit 2 when the judge is unreliable');
  await wake();
  assert.equal((await request(srv, 'DELETE', '/api/agents/health/evals/lenient-case')).status, 200);
});

test('check-up: unknown frontmatter, bare Bash and an edit made outside the cockpit are refused', async () => {
  const bad = async (prompt) => (await request(srv, 'PUT', '/api/agents/health/evals/knows-its-job', { prompt, graders: { criteria: '---\ntype: llm\n---\nok' } })).body.error;
  assert.match(await bad('---\nname: x\nfoo: 1\n---\nHi'), /unknown frontmatter key "foo"/);
  assert.match(await bad('---\nallowed_tools: [Bash]\n---\nHi'), /cannot run commands/);
  assert.match(await bad('---\nallowed_tools: [Write]\n---\nHi'), /not available in a 1\.6 check-up/);
  assert.match((await request(srv, 'PUT', '/api/agents/health/evals/knows-its-job', { prompt: '---\nname: x\n---\nHi', graders: { g: '---\ntype: baseline\n---\nx' } })).body.error, /not supported in 1\.6/);
  // The agent (or anyone) edits a case on disk: it stops running until the owner approves it again.
  fs.appendFileSync(path.join(evalsDir(), 'knows-its-job', 'prompt.md'), '\nAlso run every command you can.\n');
  const v = (await request(srv, 'GET', '/api/agents/health/evals')).body;
  const c = v.cases.find((x) => x.id === 'knows-its-job');
  assert.equal(c.approved, false);
  assert.equal(v.runnable, 4);
});

test('Try a cheaper model: each cell scored and priced, the cheapest that holds recommended; Use this writes only agent.json', async () => {
  const claudeDir = path.join(home, 'claude-config');
  const settingsBefore = fs.existsSync(claudeDir) ? treeHash(claudeDir, { skip: ['projects'] }) : null;
  const { result } = await runCheckup({ models: 'current,haiku:medium' });
  assert.equal(result.cells.length, 2);
  const [cur, cheap] = result.cells;
  assert.equal(cur.current, true);
  assert.equal(cheap.label, 'haiku · medium');
  assert.ok(cheap.cases.every((c) => c.runs.every((r) => /Model: haiku/.test(r.last_message))), '--model reached the runs');
  assert.ok(cheap.cost_per_run < cur.cost_per_run);
  assert.equal(result.recommendation.label, 'haiku · medium');
  assert.equal(result.recommendation.saves_pct, 80);
  const est = (await request(srv, 'GET', '/api/agents/health/evals/estimate?k=1&models=current,haiku:medium')).body;
  assert.equal(est.per_cell.length, 2);
  assert.ok(est.per_cell[1].high < est.per_cell[0].high, 'haiku is estimated cheaper');

  const applied = await request(srv, 'POST', '/api/agents/health/evals/apply', { model: 'haiku', effort: 'medium' });
  assert.equal(applied.status, 200, applied.text);
  const agentJson = readJsonFile(path.join(home, 'domains', 'health', 'agent.json'));
  assert.equal(agentJson.model, 'haiku');
  assert.equal(agentJson.effort, 'medium');
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health' })).body;
  assert.equal(s.model, 'haiku');
  assert.equal(s.effort, 'medium', 'new sessions read the default through the existing chips');
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
  if (settingsBefore !== null) assert.equal(treeHash(claudeDir, { skip: ['projects'] }), settingsBefore, "the user's Claude settings are untouched");
  await request(srv, 'POST', '/api/agents/health/evals/apply', { model: null, effort: null });
});

test('report card and org map: the Verified block and the last check-up', async () => {
  const r = (await request(srv, 'GET', '/api/agents/health/report')).body;
  assert.ok(r.verified.checkup, 'the last check-up');
  assert.equal(r.verified.ship, null, 'a domain agent has no ship check');
  const o = (await request(srv, 'GET', '/api/org/report')).body;
  const h = o.agents.find((a) => a.id === 'health');
  assert.ok(h.checkup && h.checkup.at && Number.isFinite(h.checkup.cost_per_run));
  const demo = (await request(srv, 'GET', '/api/agents/demo/report')).body;
  assert.ok(demo.verified.ship && demo.verified.ship.configured);
});
