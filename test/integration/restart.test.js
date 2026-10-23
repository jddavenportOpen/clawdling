// tmux: sessions outlive the Clawdling server: stop it, keep using the session, start it again.
// pty: sessions end with the server, say so, come back as ended and resume with claude --resume.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, launches, onlyPty, onlyTmux, openViewer, readJsonFile, request, rmrf, sessionRunning, startServerProc, tempHome, testEnv, tmux, tmuxHas, uniqueSocket, waitFor, waitGone } from '../helpers.mjs';

let home;
let socket;
let env;
let fakeLog;
const servers = [];

before(() => {
  home = tempHome();
  socket = uniqueSocket();
  fakeLog = path.join(home, 'fake-claude.log');
  env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, FAKE_CLAUDE_LOG: fakeLog });
  cli(['init', '--defaults'], { env, home });
});

after(async () => {
  for (const s of servers) await s.stop();
  killTmux(socket);
  rmrf(home);
});

async function start() {
  const s = await startServerProc({ home, env });
  servers.push(s);
  return s;
}

const status = async (srv, sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body;

test('a server restart keeps tmux sessions live and reattaches them', { skip: onlyTmux }, async () => {
  const a = await start();
  const keep = (await request(a, 'POST', '/api/sessions', { agent: 'work', title: 'Survivor' })).body;
  const other = (await request(a, 'POST', '/api/sessions', { agent: 'health', prompt: 'first' })).body;
  await waitFor(async () => (await status(a, keep.sid)).status === 'ready', { label: 'keep ready' });
  await waitFor(async () => (await status(a, other.sid)).status === 'ready', { label: 'other ready' });

  await a.stop();
  assert.ok(tmuxHas(socket, keep.tmux_name), 'session survives the server');
  assert.equal(readJsonFile(path.join(home, '.clawdling', 'server.json')), null, 'server.json removed on clean stop');

  // Use the session while Clawdling is down: its hooks cannot reach a server and are spooled.
  tmux(socket, 'send-keys', '-t', `=${keep.tmux_name}:`, 'typed while down', 'Enter');
  await waitFor(() => /typed while down/.test(tmux(socket, 'capture-pane', '-p', '-t', `=${keep.tmux_name}:`)), { label: 'echo while down' });
  const spool = path.join(home, '.clawdling', 'hook-spool.jsonl');
  await waitFor(() => fs.existsSync(spool) && fs.readFileSync(spool, 'utf8').includes('"event":"Stop"'), { label: 'hook spooled while down' });
  // Kill the other session while down: it must come back as ended, not live.
  tmux(socket, 'kill-session', '-t', `=${other.tmux_name}`);

  const b = await start();
  const k = await status(b, keep.sid);
  assert.equal(k.status, 'ready', 'live again after restart');
  assert.equal(k.title, 'Survivor');
  assert.equal(k.last_message, 'typed while down', 'hook events spooled while down were replayed');
  const o = await status(b, other.sid);
  assert.equal(o.status, 'ended');
  assert.equal(o.resumable, true);

  const v = await openViewer(b, keep.sid);
  try {
    const snap = await v.next((m) => m.t === 'snapshot');
    assert.match(snap.data, /Fake Claude Code/);
    assert.match(snap.data, /typed while down/);
    v.send({ t: 'in', data: 'after restart\r' });
    await v.waitOutput(/assistant: after restart/);
    // Hooks find the new server through server.json even though CLAWDLING_PORT is stale.
    await waitFor(async () => (await status(b, keep.sid)).last_message === 'after restart', { label: 'hooks reach the new server' });
  } finally {
    v.close();
  }

  // Ending it from the new server works and the tmux session is gone.
  await request(b, 'DELETE', `/api/sessions/${keep.sid}`);
  assert.equal(tmuxHas(socket, keep.tmux_name), false);
  // The ended session is resumable from yet another server instance.
  await b.stop();
  const c = await start();
  assert.equal((await status(c, keep.sid)).status, 'ended');
  const r = await request(c, 'POST', `/api/sessions/${keep.sid}/resume`);
  assert.equal(r.status, 200, r.text);
  await waitFor(async () => (await status(c, keep.sid)).status === 'ready', { label: 'resumed on third server' });
});

test('pty: stopping the server ends its sessions honestly; they come back ended and resume', { skip: onlyPty }, async () => {
  const a = await start();
  const keep = (await request(a, 'POST', '/api/sessions', { agent: 'work', title: 'Survivor' })).body;
  await waitFor(async () => (await status(a, keep.sid)).status === 'ready', { label: 'ready' });
  assert.match(keep.attach_cmd, /attach [0-9a-f]{8}$/, 'attach goes through the CLI, not tmux');
  const v = await openViewer(a, keep.sid);
  v.send({ t: 'in', data: 'before the stop\r' });
  await v.waitOutput(/assistant: before the stop/);
  const closed = new Promise((r) => v.ws.once('close', (code, reason) => r({ code, reason: String(reason) })));
  await a.stop();
  const c = await closed;
  assert.equal(c.code, 1001);
  assert.match(c.reason, /resume/, 'viewers are told the session ended, not that it keeps running');
  await waitGone({ socket, fakeLog }, keep);

  const reg = readJsonFile(path.join(home, '.clawdling', 'sessions.json'));
  assert.equal(reg.backend, 'pty');
  const row = reg.sessions.find((r) => r.sid === keep.sid);
  assert.equal(row.status, 'ended');
  assert.match(row.notification, /Clawdling stopped/);

  const b = await start();
  assert.equal(readJsonFile(path.join(home, '.clawdling', 'server.json')).backend, 'pty');
  const k = await status(b, keep.sid);
  assert.equal(k.status, 'ended');
  assert.equal(k.resumable, true);
  assert.equal(k.title, 'Survivor');
  assert.match(k.notification, /Resume it/);
  const r = await request(b, 'POST', `/api/sessions/${keep.sid}/resume`);
  assert.equal(r.status, 200, r.text);
  await waitFor(async () => (await status(b, keep.sid)).status === 'ready', { label: 'resumed' });
  assert.ok(launches(fakeLog, keep.sid).some((e) => e.opts.resume === keep.sid), 'relaunched with --resume <sid>');
  const v2 = await openViewer(b, keep.sid);
  try {
    v2.send({ t: 'in', data: 'after the restart\r' });
    await v2.waitOutput(/assistant: after the restart/);
  } finally {
    v2.close();
  }

  // A crash (no clean stop) leaves no ghost: the next start shows the session as ended.
  b.child.kill('SIGKILL');
  await new Promise((res) => (b.child.exitCode !== null ? res() : b.child.once('exit', res)));
  await waitGone({ socket, fakeLog }, keep, 'the session died with the crashed server');
  const c2 = await start();
  const after = await status(c2, keep.sid);
  assert.equal(after.status, 'ended');
  assert.match(after.notification, /Clawdling stopped/);
  assert.equal(sessionRunning({ socket, fakeLog }, keep), false);
});
