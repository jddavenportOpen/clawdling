// POST /api/sessions/:sid/answer: answer Claude Code's own questions (folder trust, permission
// prompts) safely from the cockpit or the phone, by moving the pointer like a person would.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, openViewer, readLog, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let srv;
let repo;
let fakeLog;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  repo = tempHome('cl-outside-repo-');
  fakeLog = path.join(home, 'fake-claude.log');
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, FAKE_CLAUDE_LOG: fakeLog });
  cli(['init', '--defaults'], { env, home });
  cli(['new', 'project', 'Store', '--goal', 'Ship the store', '--repo', repo], { env, home });
  fs.writeFileSync(path.join(repo, '.fake-claude-trust'), ''); // code outside the org: Claude Code asks
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
  rmrf(repo);
});

const get = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body;
const until = (sid, pred, label) =>
  waitFor(async () => {
    const s = await get(sid);
    return pred(s) ? s : null;
  }, { label, timeout: 15000 });

test('folder trust for a project whose repo is outside the org: plain notice, choices, answer 2 starts it', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'store' })).body;
  assert.equal(s.cwd, repo);
  const q = await until(s.sid, (x) => x.status === 'needs_you', 'trust question');
  assert.equal(q.waiting_on, 'trust');
  assert.ok(q.notification.includes(`trust ${repo}`), q.notification);
  assert.match(q.notification, /Answer 2 \("Yes, I trust this folder"\)/);
  assert.deepEqual(q.choices, [{ option: 1, label: 'No, exit' }, { option: 2, label: 'Yes, I trust this folder' }]);

  // Typed text (Donna, the CLI) can never land in the dialog: Enter would choose "No, exit".
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'hello' })).status, 409);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 3 })).status, 400);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 'yes' })).status, 400);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, {})).status, 400);

  const r = await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 2 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.answered, { option: 2, label: 'Yes, I trust this folder' });
  const ready = await until(s.sid, (x) => x.status === 'ready', 'ready after trusting');
  assert.equal(ready.choices, null);
  assert.equal(ready.notification, null);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 1 })).status, 409, 'nothing to answer now');
});

test('answering 1 ("No, exit") ends the session', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'store' })).body;
  await until(s.sid, (x) => x.status === 'needs_you' && x.waiting_on === 'trust', 'trust question');
  const r = await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.answered.label, 'No, exit');
  await until(s.sid, (x) => x.status === 'ended', 'ended');
});

test('permission prompts: numbered choices, answered by option', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  await until(s.sid, (x) => x.status === 'ready', 'ready');
  const v = await openViewer(srv, s.sid);
  try {
    await v.next((m) => m.t === 'snapshot');
    for (const [option, word] of [[1, 'yes'], [3, 'no']]) {
      v.send({ t: 'in', data: 'need permission?\r' });
      const q = await until(s.sid, (x) => x.status === 'needs_you' && Array.isArray(x.choices), 'permission choices');
      assert.equal(q.waiting_on, 'permission_prompt');
      assert.match(q.notification, /permission/);
      assert.deepEqual(q.choices.map((c) => c.option), [1, 2, 3]);
      assert.equal(q.choices[0].label, '1. Yes');
      const r = await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.status, 'working');
      const done = await until(s.sid, (x) => x.status === 'ready' && x.last_message === `permission answered (${word}), done`, `answered ${word}`);
      assert.equal(done.waiting_on, null);
    }
  } finally {
    v.close();
  }
});

test('a Claude Code that is not signed in: "login" at once, a plain notice, and nothing typed into it', async () => {
  const dir = path.join(home, 'domains', 'money');
  const marker = path.join(dir, '.fake-claude-login'); // the fake stops at "Select login method:"
  fs.writeFileSync(marker, '');
  try {
    const started = Date.now();
    const s = (await request(srv, 'POST', '/api/sessions', { agent: 'money', prompt: 'plan my budget' })).body;
    const q = await until(s.sid, (x) => x.status === 'needs_you' && x.waiting_on === 'login', 'login screen');
    assert.ok(Date.now() - started < 10000, 'seen long before the 20 s startup stall');
    assert.match(q.notification, /isn't signed in yet\. Click Sign in/);
    assert.doesNotMatch(q.notification, /Open a terminal/, 'no dead end for someone with no terminal (1.1.1)');
    assert.equal(q.choices, null, 'not answered with buttons');
    assert.equal(q.signed_in, false);
    // Enter would pick a login method: typed text must never reach that screen.
    const refused = await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'hello' });
    assert.equal(refused.status, 409);
    // The refusal says what to do (sign in), not "answer it in the cockpit", which is impossible here.
    assert.match(refused.body.error, /isn't signed in yet/);
    assert.doesNotMatch(refused.body.error, /answer it in the cockpit/);
    assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 1 })).status, 409);

    // 1.1.1: "Sign in" for the DEFAULT login opens a plain claude in the org folder for /login.
    const signin = await request(srv, 'POST', '/api/accounts/default/signin', {});
    assert.equal(signin.status, 201, signin.text);
    assert.equal(signin.body.purpose, 'signin');
    assert.equal(signin.body.account, null, 'the default login: no CLAUDE_CONFIG_DIR');
    assert.equal(signin.body.title, 'Sign in');
    assert.equal(signin.body.agent, 'scratch');
    await until(signin.body.sid, (x) => x.status === 'ready', 'the sign-in session is up');
    // Signing in there (Claude Code's auth_success) tells the stuck session it can start again.
    fs.rmSync(marker, { force: true });
    const ok = await request(srv, 'POST', '/api/hooks', { event: 'Notification', sid: signin.body.sid, payload: { notification_type: 'auth_success', message: 'Login successful' } });
    assert.equal(ok.status, 204);
    const told = await until(s.sid, (x) => x.signed_in === true, 'signed in elsewhere');
    assert.equal(told.waiting_on, 'login');
    assert.match(told.notification, /signed in now\. Start this session again/);
    // Start again: a new claude on the same session, which now gets past the sign-in.
    const again = await request(srv, 'POST', `/api/sessions/${s.sid}/restart`, {});
    assert.equal(again.status, 200, again.text);
    // That claude never started, so it starts fresh, with the first message it never got.
    const up = await until(s.sid, (x) => x.status === 'ready', 'ready after Start again');
    assert.equal(up.signed_in, false);
    assert.equal(up.sid, s.sid, 'the same session');
    assert.equal(up.last_message, 'plan my budget');
    // Only a session stuck on a sign-in (or a stalled start) can be started again.
    assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/restart`, {})).status, 409);
    await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
    await request(srv, 'DELETE', `/api/sessions/${signin.body.sid}`);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('Start again after a Resume that stopped at the sign-in resumes the conversation, and sends nothing twice (1.1.1)', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'home', prompt: 'first words' })).body;
  await until(s.sid, (x) => x.status === 'ready' && x.last_message === 'first words', 'ready');
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
  await until(s.sid, (x) => x.status === 'ended', 'ended');
  const marker = path.join(home, 'domains', 'home', '.fake-claude-login');
  fs.writeFileSync(marker, '');
  try {
    assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/resume`, {})).status, 200);
    await until(s.sid, (x) => x.status === 'needs_you' && x.waiting_on === 'login', 'the resumed claude is not signed in');
    fs.rmSync(marker, { force: true });
    assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/restart`, {})).status, 200);
    await until(s.sid, (x) => x.status === 'ready', 'ready after Start again');
    const runs = readLog(fakeLog).filter((e) => e.mode === 'interactive' && (e.opts.sessionId === s.sid || e.opts.resume === s.sid));
    const last = runs[runs.length - 1];
    assert.equal(runs.length, 3, 'spawn, resume, Start again');
    assert.equal(last.opts.resume, s.sid, 'resumed: the conversation exists, so not a fresh --session-id');
    assert.equal(last.prompt, '', 'the first message is not sent a second time');
  } finally {
    fs.rmSync(marker, { force: true });
    await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
  }
});

test('a turn that ends on an API error says why, and sending again retries (StopFailure, D11)', async () => {
  // The fake claude is 2.1.999, so the server registered StopFailure for it.
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.clawdling', 'hooks-settings.json'), 'utf8'));
  assert.ok(settings.hooks.StopFailure, 'StopFailure registered for a Claude Code that has it');
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  await until(s.sid, (x) => x.status === 'ready', 'ready');
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'fail: rate_limit' })).status, 204);
  const limited = await until(s.sid, (x) => x.status === 'needs_you', 'a usage limit');
  assert.equal(limited.waiting_on, 'error');
  assert.match(limited.notification, /usage or rate limit: You've hit your limit · resets 3pm\. Send your message again to retry\./);
  // Not a dialog: the composer can send again.
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'and now?' })).status, 204);
  const again = await until(s.sid, (x) => x.status === 'ready', 'ready after retrying');
  assert.equal(again.last_message, 'and now?');
  // Not signed in mid-session: the login state the cockpit already explains.
  await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'fail: authentication_failed' });
  const login = await until(s.sid, (x) => x.status === 'needs_you', 'not signed in');
  assert.equal(login.waiting_on, 'login');
  assert.match(login.notification, /isn't signed in yet/);
  assert.equal(login.last_message, 'Not logged in · Please run /login');
});

test('a hook from a claude the session has replaced never changes it (the old SessionEnd after a resume)', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health' })).body;
  await until(s.sid, (x) => x.status === 'ready', 'ready');
  assert.equal((await request(srv, 'DELETE', `/api/sessions/${s.sid}`)).status, 200);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/resume`, {})).status, 200);
  await until(s.sid, (x) => x.status === 'ready', 'ready after resume');
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(home, '.clawdling', 'sessions.json'), 'utf8')).sessions.find((r) => r.sid === s.sid)?.launch_id, { label: 'launch id saved' });
  const launch = JSON.parse(fs.readFileSync(path.join(home, '.clawdling', 'sessions.json'), 'utf8')).sessions.find((r) => r.sid === s.sid).launch_id;
  // Killing the old claude makes Claude Code run its SessionEnd hook; it can land after the resume.
  const stale = { event: 'SessionEnd', sid: s.sid, payload: { reason: 'other' }, ts: new Date().toISOString(), launch: 'old0launch01' };
  assert.equal((await request(srv, 'POST', '/api/hooks', stale)).status, 204);
  assert.equal((await get(s.sid)).status, 'ready', 'the old launch cannot end the new one');
  // The current launch's hooks still apply.
  await request(srv, 'POST', '/api/hooks', { event: 'UserPromptSubmit', sid: s.sid, payload: { prompt: 'x' }, ts: new Date().toISOString(), launch });
  assert.equal((await get(s.sid)).status, 'working');
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
});
