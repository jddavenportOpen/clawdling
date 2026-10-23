// The hook script must never block or break Claude: no stdout, exit 0, done within 1.5 s.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HOOK_EVENTS, buildHooksSettings } from '../../server/hooks.js';
import { HOOK, rmrf, tempHome } from '../helpers.mjs';

const SID = '33333333-3333-4333-8333-333333333333';
let home;

before(() => {
  home = tempHome();
  fs.mkdirSync(path.join(home, '.clawdling'), { recursive: true });
  fs.writeFileSync(path.join(home, '.clawdling', 'token'), 'f'.repeat(64) + '\n');
});
after(() => rmrf(home));

function runHook(event, payload, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, event], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('generated settings register all five hooks with safely quoted paths (macOS / Linux shell form)', () => {
  const s = buildHooksSettings({ nodePath: "/opt/my node/bin/node", hookScript: "/Users/o'brien/app/bin/clawdling-hook.js", platform: 'linux' });
  assert.deepEqual(Object.keys(s.hooks), HOOK_EVENTS);
  for (const ev of HOOK_EVENTS) {
    const h = s.hooks[ev][0].hooks[0];
    assert.equal(h.type, 'command');
    assert.equal(h.command, `'/opt/my node/bin/node' '/Users/o'\\''brien/app/bin/clawdling-hook.js' ${ev}`);
    assert.ok(h.timeout >= 2);
  }
  // The quoting survives a real shell.
  if (process.platform !== 'win32') {
    const out = spawnSync('/bin/sh', ['-c', `printf '%s\\n' ${s.hooks.Stop[0].hooks[0].command}`], { encoding: 'utf8' }).stdout;
    assert.equal(out, "/opt/my node/bin/node\n/Users/o'brien/app/bin/clawdling-hook.js\nStop\n");
  }
  assert.ok(s.permissions.allow.includes('Bash(clawdling spawn *)'));
  assert.ok(!s.permissions.allow.includes('Bash(clawdling *)'), 'agents cannot run init/service/donna without a prompt');
});

test('outside a Clawdling session (no CLAWDLING_SID) the hook does nothing', async () => {
  const r = await runHook('Stop', { session_id: 'x' }, { CLAWDLING_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(home, '.clawdling', 'hook-spool.jsonl')), false);
});

test('posts the event with the token, trimmed payload, and prefers server.json over CLAWDLING_PORT', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      got.push({ url: req.url, method: req.method, token: req.headers['x-clawdling-token'], body: JSON.parse(b) });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, '.clawdling', 'server.json'), JSON.stringify({ port: server.address().port }));
  try {
    const r = await runHook('UserPromptSubmit', { session_id: SID, prompt: 'p'.repeat(5000), cwd: '/x', extra: 'dropped' }, { CLAWDLING_HOME: home, CLAWDLING_SID: SID, CLAWDLING_PORT: '1' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(got.length, 1);
    assert.equal(got[0].url, '/api/hooks');
    assert.equal(got[0].method, 'POST');
    assert.equal(got[0].token, 'f'.repeat(64));
    assert.equal(got[0].body.event, 'UserPromptSubmit');
    assert.equal(got[0].body.sid, SID);
    assert.equal(got[0].body.payload.prompt.length, 2000);
    assert.equal(got[0].body.payload.extra, undefined);
  } finally {
    fs.unlinkSync(path.join(home, '.clawdling', 'server.json'));
    await new Promise((r) => server.close(r));
  }
});

test('server down: exits 0 at once and spools the event for replay', async () => {
  const r = await runHook('Stop', { session_id: SID, last_assistant_message: 'done' }, { CLAWDLING_HOME: home, CLAWDLING_SID: SID, CLAWDLING_PORT: '9' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  const spooled = fs.readFileSync(path.join(home, '.clawdling', 'hook-spool.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(spooled.at(-1).event, 'Stop');
  assert.equal(spooled.at(-1).sid, SID);
  assert.equal(spooled.at(-1).payload.last_assistant_message, 'done');
});

test('a server error (5xx, or 503 while it starts) spools the event for replay', async () => {
  const spoolFile = path.join(home, '.clawdling', 'hook-spool.jsonl');
  try {
    fs.unlinkSync(spoolFile);
  } catch {
    // none yet
  }
  for (const code of [500, 503]) {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end('{"error":"x"}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await runHook('Stop', { session_id: SID, last_assistant_message: `after ${code}` }, { CLAWDLING_HOME: home, CLAWDLING_SID: SID, CLAWDLING_PORT: String(server.address().port) });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
  const spooled = fs.readFileSync(spoolFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(spooled.map((e) => e.payload.last_assistant_message), ['after 500', 'after 503']);
  assert.ok(spooled.every((e) => typeof e.ts === 'string'), 'events carry their time, for ordered replay');
});

test('a hanging server cannot hold Claude up: the hook gives up within the deadline', async () => {
  const sockets = [];
  const server = http.createServer(() => {}); // never answers
  server.on('connection', (s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const spoolFile = path.join(home, '.clawdling', 'hook-spool.jsonl');
    const before = fs.existsSync(spoolFile) ? fs.readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean).length : 0;
    const r = await runHook('Stop', { session_id: SID, last_assistant_message: 'slow server' }, { CLAWDLING_HOME: home, CLAWDLING_SID: SID, CLAWDLING_PORT: String(server.address().port) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 3000, `took ${r.ms} ms`);
    const lines = fs.readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, before + 1, 'a timed-out Stop is spooled, so the session cannot stay stuck on working');
    assert.equal(JSON.parse(lines.at(-1)).payload.last_assistant_message, 'slow server');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

test('garbage on stdin is ignored', async () => {
  const child = spawnSync(process.execPath, [HOOK, 'Notification'], { input: 'not json{', env: { PATH: process.env.PATH, CLAWDLING_HOME: home, CLAWDLING_SID: SID, CLAWDLING_PORT: '9' }, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
});
