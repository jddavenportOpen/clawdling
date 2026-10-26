// The report card (1.5) against a real server: a project agent with a git repo, a session that
// works (the fake claude's "work?" turn: split records, a command, an edit, a failed command, a
// subagent, a commit), then /api/agents/:id/report, /api/org/report and the Timeline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let srv;
let repo;
let env;

// What one "work?" turn uses, repriced by hand (claude-sonnet-5: $2 in, $10 out, $0.20 cache
// read, 1.25x for a 5-minute cache write), per million tokens:
//   msg a (split over two records, counted once): 100 x 2 + 50 x 10 + 200 x 2.5 + 1000 x 0.2 = 1,400
//   msg b: 10 x 2 + 400 x 10 + 1500 x 0.2 = 4,320;  the subagent: 20 x 2 + 30 x 10 = 340
const TURN_USD = (1400 + 4320 + 340) / 1e6;

const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: new Date(Date.now() - 10 * 60000).toISOString(), GIT_COMMITTER_DATE: new Date(Date.now() - 10 * 60000).toISOString() } });

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  repo = path.join(home, 'demo-repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit'); // 10 minutes ago: before any session
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

const status = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body.status;

test('a fresh agent has an empty report card with every block present', async () => {
  const r = await request(srv, 'GET', '/api/agents/demo/report?window=7d');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.schema, 1);
  assert.deepEqual(r.body.done, []);
  assert.deepEqual(r.body.needs, []);
  assert.equal(r.body.cost.total_usd, 0);
  assert.match(r.body.cost.label, /list-price equivalent, not a bill/);
  assert.equal(r.body.cost.by_day.length, 7);
  assert.equal(r.body.agent.has_repo, true);
  assert.deepEqual(r.body.repo_commits.other.map((c) => c.subject), ['First commit'], 'a commit made outside any session');
  assert.equal(r.body.next.heading, 'Next steps', 'the scaffolded NOW.md has a Next steps section');
  assert.equal(r.body.next.stale, false);
});

test('Done, Needs you, Cost and the Timeline after one working session; receipts outlive the transcript', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'demo', prompt: 'please do some work? and commit' })).body;
  await waitFor(async () => (await status(s.sid)) === 'ready', { label: 'ready', timeout: 20000 });

  let r = (await request(srv, 'GET', '/api/agents/demo/report?window=today')).body;
  assert.equal(r.done.length, 1);
  const d = r.done[0];
  assert.equal(d.sid, s.sid);
  assert.equal(d.line, 'I added a README section. The test command failed, so the tests need a look.');
  assert.equal(d.files_changed, 1);
  assert.equal(d.tool_errors, 1);
  assert.equal(d.live, true);
  assert.deepEqual(d.commits.map((c) => c.subject), ['Add a README section']);
  assert.ok(!r.repo_commits.other.some((c) => c.subject === 'Add a README section'), 'a commit is listed once');
  // Needs you = the rail's: a finished turn with a reply waiting.
  assert.deepEqual(r.needs.map((n) => [n.sid, n.kind]), [[s.sid, 'reply']]);
  const org = (await request(srv, 'GET', '/api/org')).body;
  assert.equal(org.agents.find((a) => a.id === 'demo').needs_you, r.needs.length);
  // Cost: repriced while it runs (no cost-state yet), to the cent and beyond.
  assert.equal(r.cost.total_usd.toFixed(6), TURN_USD.toFixed(6));
  assert.equal(r.cost.complete, true);
  assert.deepEqual(r.cost.by_model.map((m) => m.model), ['claude-sonnet-5']);
  assert.equal(r.cost.top_sessions[0].sid, s.sid);

  const tl = (await request(srv, 'GET', `/api/sessions/${s.sid}/timeline`)).body;
  assert.equal(tl.transcript, 'ok');
  const names = tl.entries.filter((e) => e.kind === 'tool').map((e) => `${e.depth}:${e.name}:${e.ok}`);
  assert.deepEqual(names, ['0:Bash:true', '0:Edit:true', '0:Bash:false', '0:Agent:true', '1:Read:true', '0:Bash:true']);
  assert.equal(tl.entries[0].kind, 'prompt');
  assert.equal(tl.entries[0].cost.toFixed(6), TURN_USD.toFixed(6));
  const page = (await request(srv, 'GET', `/api/sessions/${s.sid}/timeline?after=1&limit=2`)).body;
  assert.deepEqual(page.entries.map((e) => e.n), [2, 3]);
  assert.equal(page.more, true);
  assert.equal((await request(srv, 'GET', `/api/sessions/${s.sid}/timeline?after=no`)).status, 400);

  // A second turn, then the session exits on its own: Claude Code's cost-state is written and wins.
  await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'more work?' });
  await waitFor(async () => (await request(srv, 'GET', '/api/agents/demo/report?window=today')).body.cost.total_usd.toFixed(6) === (2 * TURN_USD).toFixed(6), { label: 'second turn counted', timeout: 15000 });
  await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: '/exit' });
  await waitFor(async () => (await status(s.sid)) === 'ended', { label: 'ended', timeout: 15000 });
  const receipt = path.join(home, '.clawdling', 'ledger', `${s.sid}.json`);
  await waitFor(() => fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt, 'utf8')).cost?.source === 'cli', { label: 'receipt written with the CLI total' });
  const kept = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(kept.turns, 2);
  assert.equal(kept.cost.usd.toFixed(6), (2 * TURN_USD).toFixed(6));
  assert.ok(!JSON.stringify(kept).includes('please do some work'), 'no prompt text in the receipt');

  r = (await request(srv, 'GET', '/api/agents/demo/report?window=today')).body;
  assert.equal(r.done[0].live, false);
  assert.deepEqual(r.needs, [], 'an ended session needs nothing');

  // Claude Code's retention cleanup deletes the transcript: the receipt keeps the report honest.
  fs.rmSync(kept.transcript_path);
  r = (await request(srv, 'GET', '/api/agents/demo/report?window=today')).body;
  assert.equal(r.done[0].transcript, 'gone');
  assert.equal(r.done[0].line, 'I added a README section. The test command failed, so the tests need a look.');
  assert.equal(r.cost.total_usd.toFixed(6), (2 * TURN_USD).toFixed(6));
  const gone = (await request(srv, 'GET', `/api/sessions/${s.sid}/timeline`)).body;
  assert.equal(gone.transcript, 'gone');
  assert.equal(gone.summary.turns, 2);

  const o = (await request(srv, 'GET', '/api/org/report')).body;
  assert.equal(o.schema, 1);
  assert.equal(o.totals.today_usd.toFixed(6), (2 * TURN_USD).toFixed(6));
  assert.equal(o.totals.week_usd.toFixed(6), (2 * TURN_USD).toFixed(6));
  const demo = o.agents.find((a) => a.id === 'demo');
  assert.equal(demo.done, 1);
  assert.ok(demo.last_done_at);
  assert.equal(o.agents.find((a) => a.id === 'donna').cost_usd, 0);
});

test('a domain agent has no commits block; bad input is refused', async () => {
  const r = (await request(srv, 'GET', '/api/agents/health/report')).body;
  assert.equal(r.agent.has_repo, false);
  assert.equal(r.repo_commits, null);
  assert.equal((await request(srv, 'GET', '/api/agents/demo/report?window=1y')).status, 400);
  assert.equal((await request(srv, 'GET', '/api/agents/nobody/report')).status, 404);
  assert.equal((await request(srv, 'GET', '/api/agents/demo/report', undefined, { 'x-clawdling-token': 'wrong' })).status, 401);
});

test('clawdling report prints the four blocks, and --json is the versioned contract', async () => {
  const out = cli(['report', 'demo', '--window', '7d'], { env, home });
  assert.match(out, /Done/);
  assert.match(out, /Needs you/);
  assert.match(out, /Cost/);
  assert.match(out, /list-price equivalent, not a bill/);
  assert.match(out, /Next/);
  const j = JSON.parse(cli(['report', 'demo', '--json'], { env, home }));
  assert.equal(j.schema, 1);
  assert.equal(j.agent.id, 'demo');
  const all = JSON.parse(cli(['report', '--json'], { env, home }));
  assert.equal(all.schema, 1);
  assert.ok(Array.isArray(all.agents));
});
