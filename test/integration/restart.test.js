// Sessions outlive the Clawdling server: stop it, keep using the session, start it again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, openViewer, readJsonFile, request, rmrf, startServerProc, tempHome, testEnv, tmux, tmuxHas, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let env;
const servers = [];

before(() => {
  home = tempHome();
  socket = uniqueSocket();
  env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, FAKE_CLAUDE_LOG: path.join(home, 'fake-claude.log') });
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

test('a server restart keeps tmux sessions live and reattaches them', async () => {
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
