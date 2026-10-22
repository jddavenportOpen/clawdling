// A second `clawdling start` must exit at once with a clear message and touch nothing: not the
// registry, not the hooks file, not the shim, and no duplicate tmux control clients.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CLI, cli, killTmux, readJsonFile, request, rmrf, startServerProc, tempHome, testEnv, tmux, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let other;
let socket;
let env;
let srv;

before(async () => {
  home = tempHome();
  other = tempHome();
  socket = uniqueSocket();
  env = testEnv({ CLAWDLING_TMUX_SOCKET: socket });
  cli(['init', '--defaults'], { env, home });
  cli(['init', '--defaults'], { env, home: other });
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
  rmrf(other);
});

/** Run `clawdling start` and wait for it to exit (fails the test if it lingers). */
function startOnce(args, h) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'start', ...args], { env: { ...env, CLAWDLING_HOME: h }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`clawdling start did not exit within 10 s: ${out}`));
    }, 10000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

const stamp = (files) => Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? fs.statSync(f).mtimeMs : null]));
const clients = () => tmux(socket, 'list-clients', '-F', '#{client_name}').split('\n').filter(Boolean).length;

test('already running for this home: exit 1, nothing touched', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status === 'ready', { label: 'ready' });
  const rt = path.join(home, '.clawdling');
  const files = ['sessions.json', 'hooks-settings.json', 'tmux.conf', 'server.json', 'bin/clawdling'].map((f) => path.join(rt, f));
  const before = stamp(files);
  const clientsBefore = clients();
  const serverJson = readJsonFile(path.join(rt, 'server.json'));

  const r = await startOnce(['--port', '0'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /already running for .* \(pid \d+, port \d+\)/);
  assert.deepEqual(stamp(files), before, 'no state file was rewritten');
  assert.equal(clients(), clientsBefore, 'no duplicate tmux control clients');
  assert.deepEqual(readJsonFile(path.join(rt, 'server.json')), serverJson);
  assert.equal((await request(srv, 'GET', '/api/me')).status, 200, 'the running server is unaffected');
});

test('port busy: exit 1 with a clear message before any state exists', async () => {
  const rt = path.join(other, '.clawdling');
  const r = await startOnce(['--port', String(srv.port)], other);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`port ${srv.port} .*already in use`));
  for (const f of ['sessions.json', 'hooks-settings.json', 'tmux.conf', 'server.json', 'bin/clawdling']) {
    assert.equal(fs.existsSync(path.join(rt, f)), false, `${f} was not created`);
  }
});

test('a stale server.json (crashed server) does not block a fresh start', async () => {
  fs.writeFileSync(path.join(other, '.clawdling', 'server.json'), JSON.stringify({ pid: 999999, port: 1, home: other }));
  const s2 = await startServerProc({ home: other, env });
  try {
    assert.equal((await request(s2, 'GET', '/api/me')).status, 200);
  } finally {
    await s2.stop();
  }
});
