// The API surface the iPhone app uses: chat view of a session, Donna chat, pairing (+ QR),
// and native-style requests (token header, no Origin) on every JSON route.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, readJsonFile, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let srv;
let configDir;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  configDir = path.join(home, 'claude-config');
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: configDir, FAKE_CLAUDE_LOG: path.join(home, 'fake.log') });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

test('GET /api/sessions/:sid/messages reads the Claude transcript as chat', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health', prompt: 'how did I sleep' })).body;
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status === 'ready', { label: 'ready' });
  const r = await request(srv, 'GET', `/api/sessions/${s.sid}/messages`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'ready');
  assert.deepEqual(r.body.messages.map((m) => [m.n, m.role, m.text]), [[0, 'user', 'how did I sleep'], [1, 'assistant', 'assistant: how did I sleep']]);
  assert.equal(r.body.next, 1);
  assert.equal(r.body.more, false);
  assert.ok(r.body.messages[0].ts);
  assert.deepEqual(r.body.messages[1].tools, []);

  await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'need permission?' });
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status === 'needs_you', { label: 'needs_you' });
  const later = await request(srv, 'GET', `/api/sessions/${s.sid}/messages?after=${r.body.next}`);
  assert.deepEqual(later.body.messages.map((m) => m.n), [2, 3]);
  assert.equal(later.body.messages[0].text, 'need permission?');
  assert.deepEqual(later.body.messages[1].tools, [{ name: 'Bash', summary: 'echo hi' }]);
  assert.equal(later.body.status, 'needs_you');
  const paged = await request(srv, 'GET', `/api/sessions/${s.sid}/messages?after=-1&limit=1`);
  assert.equal(paged.body.messages.length, 1);
  assert.equal(paged.body.more, true);
  assert.equal((await request(srv, 'GET', `/api/sessions/${s.sid}/messages?after=x`)).status, 400);

  const fresh = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  const none = await request(srv, 'GET', `/api/sessions/${fresh.sid}/messages`);
  assert.deepEqual(none.body.messages, []);
  assert.equal(none.body.next, -1);
});

test('POST /api/donna/chat runs one Donna turn; GET /api/donna/messages shows both sides', async () => {
  const r = await request(srv, 'POST', '/api/donna/chat', { text: 'what is going on?' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.reply, 'Noted: what is going on?');
  const bad = await request(srv, 'POST', '/api/donna/chat', { text: 'please explode' });
  assert.equal(bad.status, 200);
  assert.match(bad.body.reply, /^Donna hit an error: /);
  assert.ok(bad.body.error);
  const h = await request(srv, 'GET', '/api/donna/messages?limit=10');
  assert.equal(h.status, 200);
  const m = h.body.messages;
  assert.deepEqual(m.slice(0, 2).map((x) => [x.role, x.text, x.channel]), [['user', 'what is going on?', 'app'], ['donna', 'Noted: what is going on?', 'app']]);
  assert.equal(m[3].role, 'donna');
  assert.equal(m[3].error, true);
  assert.ok(m.every((x) => x.ts));
  assert.ok(fs.existsSync(path.join(home, '.clawdling', 'donna-chat.jsonl')));
  assert.equal((await request(srv, 'POST', '/api/donna/chat', { text: '' })).status, 400);
});

test('GET /api/pair and /api/pair/qr.svg (auth required)', async () => {
  const noauth = await fetch(`${srv.url}/api/pair`);
  assert.equal(noauth.status, 401);
  const p = (await request(srv, 'GET', '/api/pair')).body;
  assert.equal(p.url, `http://127.0.0.1:${srv.port}`, 'bound to loopback: the local URL');
  assert.equal(p.token, srv.token);
  assert.equal(p.bind, '127.0.0.1');
  assert.ok(Array.isArray(p.lan));
  assert.ok(p.lan.every((u) => /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(u)));
  assert.equal(p.link, `clawdling://connect?url=${encodeURIComponent(p.url)}&t=${srv.token}`);
  const qr = await fetch(`${srv.url}/api/pair/qr.svg`, { headers: { 'x-clawdling-token': srv.token } });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(qr.headers.get('cache-control'), 'no-store');
  const svg = await qr.text();
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  assert.equal((await fetch(`${srv.url}/api/pair/qr.svg`)).status, 401);
});

test('native-app style requests (token header, no Origin) work on every JSON route', async () => {
  const native = (method, p, body) => request(srv, method, p, body, {});
  assert.equal((await native('GET', '/api/me')).status, 200);
  assert.equal((await native('GET', '/api/org')).status, 200);
  assert.equal((await native('GET', '/api/channels')).status, 200);
  const created = await native('POST', '/api/agents', { kind: 'domain', name: 'Garden', mission: 'Grow tomatoes' });
  assert.equal(created.status, 201);
  assert.equal((await native('GET', '/api/agents/garden')).status, 200);
  assert.equal((await native('PUT', '/api/agents/garden/context', { now_md: '# NOW\n' })).status, 204);
  const s = await native('POST', '/api/sessions', { agent: 'garden' });
  assert.equal(s.status, 201);
  assert.equal((await native('GET', '/api/sessions')).status, 200);
  assert.equal((await native('PATCH', `/api/sessions/${s.body.sid}`, { title: 'Tomatoes' })).status, 200);
  await waitFor(async () => (await native('GET', `/api/sessions/${s.body.sid}`)).body.status === 'ready', { label: 'ready' });
  assert.equal((await native('POST', `/api/sessions/${s.body.sid}/send`, { text: 'hi' })).status, 204);
  assert.equal((await native('GET', `/api/sessions/${s.body.sid}/messages`)).status, 200);
  assert.equal((await native('DELETE', `/api/sessions/${s.body.sid}`)).status, 200);
  assert.equal((await native('POST', `/api/sessions/${s.body.sid}/resume`)).status, 200);
  assert.equal((await native('GET', '/api/donna/messages')).status, 200);
  assert.equal((await native('GET', '/api/pair')).status, 200);
  // The same requests from a foreign web page are refused.
  assert.equal((await request(srv, 'POST', '/api/sessions', { agent: 'garden' }, { Origin: 'https://evil.example' })).status, 403);
  assert.ok(readJsonFile(path.join(home, 'org.json')));
});
