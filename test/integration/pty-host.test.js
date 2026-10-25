// Issue #4, end to end on the real server (pty backend): ending a session whose claude has just
// exited never takes the server down, and when the pty host itself dies the server keeps running,
// marks that host's sessions ended with a note, and starts the next session on a new host.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HOST_LOST_NOTICE } from '../../server/sessions.js';
import { cli, launches, onlyPty, pidAlive, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let env;
let fakeLog;
let srv;

before(async () => {
  if (onlyPty) return;
  home = tempHome();
  fakeLog = path.join(home, 'fake-claude.log');
  env = testEnv({ FAKE_CLAUDE_LOG: fakeLog, CLAWDLING_BACKEND: 'pty', CLAWDLING_TMUX_SOCKET: uniqueSocket() });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
});

after(async () => {
  if (onlyPty) return;
  await srv?.stop();
  rmrf(home);
});

const status = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body;
const ready = (sid) => waitFor(async () => (await status(sid)).status === 'ready', { label: 'ready', timeout: 20000 });
const lastLaunch = (sid) => launches(fakeLog, sid).pop();

test('ending sessions whose claude just exited, over and over: the server stays up', { skip: onlyPty }, async () => {
  for (let round = 0; round < 3; round++) {
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await request(srv, 'POST', '/api/sessions', { agent: 'work', title: `exit ${round}.${i}` })).body);
    for (const s of made) await ready(s.sid);
    for (const s of made) await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: '/exit' });
    // Each claude is gone, but its pty may not have reported the exit yet: end it now.
    for (const s of made) await waitFor(() => !pidAlive(lastLaunch(s.sid).pid), { label: 'claude exited', timeout: 10000 });
    for (const s of made) await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
    for (const s of made) await waitFor(async () => (await status(s.sid)).status === 'ended', { label: 'ended', timeout: 10000 });
  }
  assert.equal(srv.child.exitCode, null, 'the server is still running');
  assert.equal((await request(srv, 'GET', '/api/sessions')).status, 200);
  assert.doesNotMatch(srv.log(), /AttachConsole failed/, 'no kill ever reached a shell that had exited');
  assert.doesNotMatch(srv.log(), /pty host stopped/);
});

test('the pty host dies: the server survives, its sessions end with a note, a new session works', { skip: onlyPty }, async () => {
  const a = (await request(srv, 'POST', '/api/sessions', { agent: 'work', title: 'on the host' })).body;
  await ready(a.sid);
  const fake = lastLaunch(a.sid);
  assert.ok(fake.ppid && fake.ppid !== srv.child.pid, 'claude runs under the pty host, not the server');
  process.kill(fake.ppid, 'SIGKILL'); // the host, as a native crash would end it
  await waitFor(async () => (await status(a.sid)).status === 'ended', { label: 'marked ended', timeout: 15000 });
  const s = await status(a.sid);
  assert.equal(s.notification, HOST_LOST_NOTICE);
  assert.equal(s.resumable, true);
  assert.equal(srv.child.exitCode, null, 'the server is still running');
  assert.match(srv.log(), /pty host stopped/);

  const b = (await request(srv, 'POST', '/api/sessions', { agent: 'work', title: 'new host' })).body;
  await ready(b.sid);
  assert.notEqual(lastLaunch(b.sid).ppid, fake.ppid, 'a new host');
  // And the ended one resumes on it.
  await request(srv, 'POST', `/api/sessions/${a.sid}/resume`, {});
  await ready(a.sid);
  await request(srv, 'DELETE', `/api/sessions/${a.sid}`);
  await request(srv, 'DELETE', `/api/sessions/${b.sid}`);
});
