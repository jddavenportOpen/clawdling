// Clawdling 1.1 launch features against the fake claude: spawn flags (--model, --effort), the
// model/effort chips' between-turns gate, and extra accounts (CLAUDE_CONFIG_DIR, passed through).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, launches, readLog, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let srv;
let configDir;
let accountsDir;
let fakeLog;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  configDir = path.join(home, 'claude-config');
  accountsDir = path.join(home, 'accounts');
  fakeLog = path.join(home, 'fake.log');
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: configDir, CLAWDLING_ACCOUNTS_DIR: accountsDir, FAKE_CLAUDE_LOG: fakeLog });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

const status = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body.status;
const launched = (sid) => launches(fakeLog, sid)[0];

test('spawn passes the chosen model and effort to claude as its own flags; nothing when unset', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health', model: 'opus', effort: 'high' })).body;
  assert.equal(s.model, 'opus');
  assert.equal(s.effort, 'high');
  assert.equal(s.account, null);
  await waitFor(() => launched(s.sid), { label: 'launched' });
  assert.equal(launched(s.sid).opts.model, 'opus');
  assert.equal(launched(s.sid).opts.effort, 'high');
  assert.ok(launched(s.sid).argv.includes('--effort=high'));

  const plain = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  await waitFor(() => launched(plain.sid), { label: 'launched' });
  assert.equal(plain.effort, null);
  assert.ok(!launched(plain.sid).argv.some((a) => a.startsWith('--effort') || a.startsWith('--model')), 'the user\'s own defaults: no forced model or effort');
  assert.equal(launched(plain.sid).env.CLAUDE_CONFIG_DIR, configDir, 'the default login: the user\'s own config dir, untouched');

  const bad = await request(srv, 'POST', '/api/sessions', { agent: 'health', effort: 'ultra' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /effort/);
});

test('chips: /model and /effort are typed only between turns; mid-question is a 409', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health', prompt: 'need permission?' })).body;
  await waitFor(async () => (await status(s.sid)) === 'needs_you', { label: 'needs_you' });
  const busy = await request(srv, 'POST', `/api/sessions/${s.sid}/settings`, { model: 'sonnet' });
  assert.equal(busy.status, 409, 'a question is on screen: typing would answer it');
  assert.match(busy.body.error, /your turn/);

  await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 1 });
  await waitFor(async () => (await status(s.sid)) === 'ready', { label: 'ready' });
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/settings`, { effort: 'ultra' })).status, 400);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/settings`, {})).status, 400);
  const ok = await request(srv, 'POST', `/api/sessions/${s.sid}/settings`, { model: 'sonnet', effort: 'low' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.model, 'sonnet');
  assert.equal(ok.body.effort, 'low');
  // The fake records what was typed into it as user turns, in order.
  await waitFor(async () => {
    const msgs = (await request(srv, 'GET', `/api/sessions/${s.sid}/messages`)).body.messages;
    return msgs.filter((m) => m.role === 'user').map((m) => m.text).join('|') === 'need permission?|/model sonnet|/effort low';
  }, { label: 'slash commands typed' });
  assert.equal((await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.effort, 'low', 'remembered on the session');
});

test('accounts: only the default login until one is added; an added one is passed as CLAUDE_CONFIG_DIR', async () => {
  const none = await request(srv, 'GET', '/api/accounts');
  assert.deepEqual(none.body.accounts.map((a) => a.id), ['default']);
  const made = await request(srv, 'POST', '/api/accounts', { name: 'Work' });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.id, 'work');
  const dir = path.join(accountsDir, 'work');
  assert.equal(made.body.dir, dir);
  assert.equal((await request(srv, 'POST', '/api/accounts', { name: 'work' })).status, 409);
  assert.deepEqual((await request(srv, 'GET', '/api/accounts')).body.accounts.map((a) => a.id), ['default', 'work']);

  assert.equal((await request(srv, 'POST', '/api/sessions', { agent: 'health', account: 'nope' })).status, 404);

  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health', account: 'work', prompt: 'hello from work' })).body;
  assert.equal(s.account, 'work');
  await waitFor(async () => (await status(s.sid)) === 'ready', { label: 'ready' });
  assert.equal(launched(s.sid).env.CLAUDE_CONFIG_DIR, dir, 'that session alone gets the account folder');
  // Its transcript lives under the account's folder, and the chat view still finds it.
  const msgs = (await request(srv, 'GET', `/api/sessions/${s.sid}/messages`)).body.messages;
  assert.deepEqual(msgs.map((m) => m.text), ['hello from work', 'assistant: hello from work']);
  assert.ok(fs.readdirSync(path.join(dir, 'projects')).length > 0);

  const signin = await request(srv, 'POST', '/api/accounts/work/signin', {});
  assert.equal(signin.status, 201, signin.text);
  assert.equal(signin.body.agent, 'scratch');
  assert.equal(signin.body.account, 'work');
  assert.equal(signin.body.purpose, 'signin');
  assert.equal(signin.body.title, 'Sign in: work');
  await waitFor(() => launched(signin.body.sid), { label: 'launched' });
  assert.equal(launched(signin.body.sid).env.CLAUDE_CONFIG_DIR, dir);
  assert.equal((await request(srv, 'POST', '/api/accounts/nope/signin', {})).status, 404);

  // Clawdling only made the folder: it never wrote a login or settings file into it.
  const own = fs.readdirSync(dir).filter((f) => f !== 'projects');
  assert.ok(!own.some((f) => /credential|settings|\.claude\.json/i.test(f)), `unexpected files: ${own.join(', ')}`);
  void readLog;
});
