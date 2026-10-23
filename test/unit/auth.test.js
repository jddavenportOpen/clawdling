// Auth, Origin/Host checks, static + vendor serving, against an in-process server (no sessions spawned).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { allowedHosts, extractToken, hostAllowed, originAllowed, parseCookies, tokenEquals } from '../../server/auth.js';
import { startServer } from '../../server/index.js';
import { initOrg, defaultAnswers } from '../../server/org.js';
import { BACKEND, ROOT, killTmux, rmrf, tempHome, testEnv, uniqueSocket } from '../helpers.mjs';

test('tokenEquals is exact and length-safe', () => {
  const t = 'a'.repeat(64);
  assert.equal(tokenEquals(t, t), true);
  assert.equal(tokenEquals('a'.repeat(63), t), false);
  assert.equal(tokenEquals('b' + 'a'.repeat(63), t), false);
  assert.equal(tokenEquals(undefined, t), false);
  assert.equal(tokenEquals('', ''), false);
  assert.equal(tokenEquals(t, ''), false);
});

test('cookies, header and query tokens', () => {
  assert.deepEqual(parseCookies('a=1; cl_token=abc; b=%20x'), { a: '1', cl_token: 'abc', b: ' x' });
  const req = (headers) => ({ headers });
  const url = new URL('http://h/ws?t=q');
  assert.equal(extractToken(req({ 'x-clawdling-token': 'h' }), url), 'h');
  assert.equal(extractToken(req({ cookie: 'cl_token=c' }), url), 'c');
  assert.equal(extractToken(req({}), url), null, 'query token only where allowed');
  assert.equal(extractToken(req({}), url, { allowQuery: true }), 'q');
});

test('origin and host checks', () => {
  const req = (headers) => ({ headers });
  assert.equal(originAllowed(req({ host: '127.0.0.1:4747' })), true, 'no Origin (CLI) is fine');
  assert.equal(originAllowed(req({ host: '127.0.0.1:4747', origin: 'http://127.0.0.1:4747' })), true);
  assert.equal(originAllowed(req({ host: '127.0.0.1:4747', origin: 'http://evil.example' })), false);
  assert.equal(originAllowed(req({ host: '127.0.0.1:4747', origin: 'null' })), false);
  assert.equal(originAllowed(req({ host: '127.0.0.1:4747', origin: 'http://localhost:4747' })), false);
  const allowed = allowedHosts({ host: '127.0.0.1', port: 4747 });
  assert.equal(hostAllowed(req({ host: 'localhost:4747' }), allowed), true);
  assert.equal(hostAllowed(req({ host: 'evil.example:4747' }), allowed), false, 'DNS rebinding guard');
  assert.equal(allowedHosts({ host: '0.0.0.0', port: 1 }), null);
  assert.ok(allowedHosts({ host: '0.0.0.0', port: 1, extra: ['mybox.ts.net'] }).has('mybox.ts.net:1'));
});

let home;
let socket;
let srv;
before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  initOrg({ home, answers: defaultAnswers() });
  const webDir = path.join(home, 'webroot');
  fs.mkdirSync(path.join(webDir, 'components'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>fixture</title>');
  fs.writeFileSync(path.join(webDir, 'components', 'x.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(home, 'secret.txt'), 'nope');
  srv = await startServer({ home, port: 0, quiet: true, env: testEnv({ CLAWDLING_TMUX_SOCKET: socket }), webDir });
});
after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

function raw(method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('API needs the token; /api/health does not', async () => {
  assert.equal((await raw('GET', '/api/org')).status, 401);
  assert.equal((await raw('GET', '/api/me')).status, 401);
  assert.equal((await raw('GET', '/api/me', { 'x-clawdling-token': 'wrong' })).status, 401);
  const me = await raw('GET', '/api/me', { 'x-clawdling-token': srv.token });
  assert.equal(me.status, 200);
  assert.equal(JSON.parse(me.body).ok, true);
  assert.equal((await raw('GET', '/api/me', { cookie: `cl_token=${srv.token}` })).status, 200);
  const health = await raw('GET', '/api/health');
  assert.equal(health.status, 200);
  const h = JSON.parse(health.body);
  assert.equal(h.ok, true);
  assert.equal(h.home, home);
  assert.equal(h.claude.ok, true, 'fake claude answers --version');
  assert.equal(h.backend.kind, BACKEND, 'the session backend in use');
  assert.equal(h.backend.persistent, BACKEND === 'tmux');
  if (BACKEND === 'tmux') assert.ok(h.tmux.version.startsWith('tmux'));
  else assert.equal(h.tmux.optional, true, 'with the built-in terminal tmux is optional');
});

test('/?t=<token> sets an HttpOnly SameSite=Strict cookie and redirects; a wrong token does not', async () => {
  const ok = await raw('GET', `/?t=${srv.token}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/');
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, new RegExp(`^cl_token=${srv.token};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const bad = await raw('GET', '/?t=nope');
  assert.equal(bad.status, 302);
  assert.equal(bad.headers['set-cookie'], undefined);
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
});

test('cross-origin mutations are refused, same-origin and no-Origin are allowed', async () => {
  const body = JSON.stringify({ kind: 'domain', name: 'Garden', mission: 'Grow tomatoes' });
  const h = { 'x-clawdling-token': srv.token, 'content-type': 'application/json' };
  assert.equal((await raw('POST', '/api/agents', { ...h, origin: 'http://evil.example' }, body)).status, 403);
  const created = await raw('POST', '/api/agents', { ...h, origin: `http://127.0.0.1:${srv.port}` }, body);
  assert.equal(created.status, 201, created.body);
  assert.equal(JSON.parse(created.body).id, 'garden');
  assert.equal((await raw('POST', '/api/agents', { ...h }, JSON.stringify({ kind: 'domain', name: 'Pets' }))).status, 201);
  assert.equal((await raw('POST', '/api/agents', { 'x-clawdling-token': srv.token, 'content-type': 'text/plain' }, body)).status, 415);
});

test('DNS rebinding: unexpected Host headers are refused', async () => {
  assert.equal((await raw('GET', '/', { host: 'attacker.example:80' })).status, 403);
  assert.equal((await raw('GET', '/api/health', { host: 'attacker.example' })).status, 403);
});

test('path traversal: agent ids and static paths', async () => {
  const h = { 'x-clawdling-token': srv.token };
  assert.equal((await raw('GET', '/api/agents/..%2F..%2Fetc', h)).status, 400);
  assert.equal((await raw('GET', '/api/agents/Health', h)).status, 400);
  assert.equal((await raw('GET', '/api/agents/nope', h)).status, 404);
  assert.equal((await raw('GET', '/api/sessions/not-a-uuid', h)).status, 400);
  // URL parsing collapses dot segments (404 inside the web root) or the server refuses them (400).
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/components/../../secret.txt', '/components/%2e%2e/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%00']) {
    const r = await raw('GET', p);
    assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /nope/, p);
  }
});

test('static files are public with the right content types', async () => {
  const index = await raw('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.body, /fixture/);
  const js = await raw('GET', '/components/x.js');
  assert.match(js.headers['content-type'], /text\/javascript/);
  assert.equal((await raw('GET', '/missing.js')).status, 404);
  assert.equal(index.headers['x-frame-options'], 'DENY');
});

test('vendor modules resolve from node_modules', async () => {
  const want = {
    '/vendor/preact.mjs': /javascript/,
    '/vendor/preact-hooks.mjs': /javascript/,
    '/vendor/htm.mjs': /javascript/,
    '/vendor/xterm.mjs': /javascript/,
    '/vendor/xterm.css': /text\/css/,
    '/vendor/addon-fit.mjs': /javascript/,
    '/vendor/addon-web-links.mjs': /javascript/,
  };
  for (const [p, ct] of Object.entries(want)) {
    const r = await raw('GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], ct, p);
    assert.ok(r.body.length > 100, p);
  }
  const up = await raw('GET', '/vendor/../package.json');
  assert.ok(up.status === 400 || up.status === 404);
  assert.doesNotMatch(up.body, /"dependencies"/);
  assert.equal((await raw('GET', '/vendor/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await raw('GET', '/vendor/nope.mjs')).status, 404);
  assert.ok(fs.existsSync(path.join(ROOT, 'node_modules', 'preact')));
});

test('terminal WebSocket upgrade needs the token and a same-origin (or no) Origin', async () => {
  const sid = '00000000-0000-4000-8000-000000000000';
  const tryWs = (q, headers = {}) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/term/${sid}${q}`, { headers });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('error', () => resolve('error'));
    });
  assert.equal(await tryWs(''), 401);
  assert.equal(await tryWs('?t=wrong'), 401);
  assert.equal(await tryWs(`?t=${srv.token}`, { Origin: 'http://evil.example' }), 403);
  assert.equal(await tryWs(`?t=${srv.token}`), 404, 'authorised, but no such session');
  assert.equal(await tryWs('', { Cookie: `cl_token=${srv.token}` }), 404);
});

test('SSE stream requires auth and sends org events', async () => {
  assert.equal((await raw('GET', '/api/events')).status, 401);
  const got = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/api/events', headers: { 'x-clawdling-token': srv.token } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const m = buf.match(/data: (\{.*\})\n\n/);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(async () => {
      await raw('PUT', '/api/agents/work/context', { 'x-clawdling-token': srv.token, 'content-type': 'application/json' }, JSON.stringify({ now_md: '# NOW\n- updated from the test\n' }));
    }, 100);
  });
  assert.equal(got.type, 'org');
  assert.equal(got.data.reason, 'context_updated');
  assert.ok(Array.isArray(got.data.agents));
});

test('agent context round trip, size cap, archive', async () => {
  const h = { 'x-clawdling-token': srv.token, 'content-type': 'application/json' };
  const put = await raw('PUT', '/api/agents/health/context', h, JSON.stringify({ claude_md: '# Health agent\nhello\n@memory/NOW.md\n', now_md: '# NOW\n- marker-123\n' }));
  assert.equal(put.status, 204);
  const a = JSON.parse((await raw('GET', '/api/agents/health', h)).body);
  assert.match(a.claude_md, /hello/);
  assert.match(a.now_md, /marker-123/);
  assert.ok(Array.isArray(a.log_tail) && a.log_tail.length >= 1);
  assert.ok(Array.isArray(a.sessions));
  assert.equal((await raw('PUT', '/api/agents/health/context', h, JSON.stringify({ now_md: 'x'.repeat(210 * 1024) }))).status, 413);
  assert.equal((await raw('DELETE', '/api/agents/donna', h)).status, 400);
  const del = await raw('DELETE', '/api/agents/garden', h);
  assert.equal(del.status, 200, del.body);
  assert.ok(fs.existsSync(JSON.parse(del.body).archived_to));
  assert.equal(fs.existsSync(path.join(home, 'domains', 'garden')), false);
  const org = JSON.parse((await raw('GET', '/api/org', h)).body);
  assert.ok(!org.agents.some((x) => x.id === 'garden'));
  assert.equal(org.agents[0].id, 'donna');
  assert.equal(org.org.chief, 'donna');
  assert.ok('telegram' in org.channels);
});
