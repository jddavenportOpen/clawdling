// Use from anywhere (1.3) against a real server process: default off, the Host allowlist, the
// long-lived token never working through a remote address, pairing links, device cookies,
// WebSocket and SSE on a remote address, the throttle, turning off (which closes live
// connections), remote.json integrity, and the Cloudflare "never without Access" rule.
//
// A local "tunnel" stands in for Tailscale Serve and the Cloudflare edge: the server's own checks
// reach it through CLAWDLING_REMOTE_PROBE (test mode only), and it forwards to Clawdling with the
// remote name as Host, exactly as `tailscale serve` and cloudflared do. Requests from the "phone"
// are sent straight to the server with that Host header.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { ROOT, cli, cliResult, killTmux, readJsonFile, request, rmrf, sleep, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';
import { fakeAccess } from '../fixtures/fake-access.mjs';

const TS_URL = 'https://box.example.ts.net:8743';
const TS_HOST = 'box.example.ts.net:8743';
const CF_URL = 'https://cockpit.example.com';
const CF_HOST = 'cockpit.example.com';
const FAKE_TS = path.join(ROOT, 'test', 'fixtures', 'fake-tailscale.mjs');

let home;
let socket;
let srv;
let env;
let serveFile;
let tsLog;
let tunnel;
const access = fakeAccess();

/** The fake tunnel / Cloudflare edge the server's checks reach, in its own process. */
function startTunnel(dir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'fake-tunnel.mjs')], { env: { ...process.env, FAKE_TUNNEL_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)\n/.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.once('exit', (code) => reject(new Error(`fake tunnel exited ${code}`)));
  });
}

let tunnelDir;
function setMode(mode) {
  fs.writeFileSync(path.join(tunnelDir, 'mode'), mode);
}

const OWNER = 'owner@example.com';

/**
 * A request as it arrives through the door: any Host, any headers. Through the Tailscale address
 * it carries the owner's Tailscale-User-Login, as Tailscale Serve adds it (pass login: null for none).
 */
function raw(method, p, { host = TS_HOST, headers = {}, body, login = host === TS_HOST ? OWNER : null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { host, ...(login ? { 'tailscale-user-login': login } : {}), ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers: h, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const phone = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const origin = (url = TS_URL) => ({ origin: url });

async function pairDevice({ host = TS_HOST, url = TS_URL, extra = {} } = {}) {
  const p = await request(srv, 'POST', '/api/remote/pairing', {});
  assert.equal(p.status, 201, p.text);
  const code = new URL(p.body.links.find((l) => l.url === url).link).searchParams.get('pair');
  const r = await raw('POST', '/api/remote/pair', { host, headers: { ...phone, ...origin(url), ...extra }, body: { code } });
  assert.equal(r.status, 201, r.text);
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  return { cookie, code, set: r.headers['set-cookie'], device: r.body.device };
}

function writeServe(config) {
  fs.writeFileSync(serveFile, JSON.stringify(config));
}

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  serveFile = path.join(home, 'serve.json');
  tsLog = path.join(home, 'ts.log');
  tunnelDir = path.join(home, 'tunnel');
  fs.mkdirSync(tunnelDir);
  fs.writeFileSync(path.join(tunnelDir, 'certs.json'), JSON.stringify(access.certs));
  fs.writeFileSync(path.join(tunnelDir, 'aud'), access.aud);
  setMode('forward');
  tunnel = await startTunnel(tunnelDir);
  const tport = tunnel.port;
  env = testEnv({
    CLAWDLING_TMUX_SOCKET: socket,
    FAKE_CLAUDE_LOG: path.join(home, 'fake.log'),
    CLAWDLING_TAILSCALE_BIN: FAKE_TS,
    FAKE_TS_SERVE: serveFile,
    FAKE_TS_LOG: tsLog,
    CLAWDLING_REMOTE_PROBE: `http://127.0.0.1:${tport}`,
    CLAWDLING_CF_CERTS_URL: `http://127.0.0.1:${tport}/certs`,
  });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
  fs.writeFileSync(path.join(tunnelDir, 'target'), String(srv.port));
});

after(async () => {
  await srv?.stop();
  tunnel?.child.kill();
  killTmux(socket);
  rmrf(home);
});

test('default off: no remote.json, no remote host answered, the CLI says off', async () => {
  const v = await request(srv, 'GET', '/api/remote');
  assert.equal(v.status, 200);
  assert.equal(v.body.enabled, false);
  assert.deepEqual(v.body.hosts, []);
  assert.equal(v.body.here.remote, false);
  assert.equal(fs.existsSync(path.join(home, '.clawdling', 'remote.json')), false);
  const r = await raw('GET', '/api/health');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'unexpected Host header');
  assert.match(cli(['remote', 'list'], { env, home }), /Use from anywhere: off\. Nothing outside this computer can reach the cockpit\./);
  // The skill the setup agent runs is installed at the org root.
  assert.match(fs.readFileSync(path.join(home, '.claude', 'skills', 'remote-access', 'SKILL.md'), 'utf8'), /^---\nname: remote-access\n/);
});

test('remote add refuses http, a non-Tailscale name, an unreachable address and a public (Funnel) one', async () => {
  assert.match(cliResult(['remote', 'add', 'http://box.example.ts.net:8743', '--kind', 'tailscale'], { env, home }).stderr, /must start with https:\/\//);
  assert.match(cliResult(['remote', 'add', 'https://cockpit.example.com', '--kind', 'tailscale'], { env, home }).stderr, /ends in \.ts\.net/);
  assert.match(cliResult(['remote', 'add', TS_URL], { env, home }).stderr, /--kind/);
  setMode('down');
  const down = cliResult(['remote', 'add', TS_URL, '--kind', 'tailscale'], { env, home });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /Not added: Could not reach this Clawdling/);
  setMode('forward');
  // Funnel cannot be confirmed off (the Tailscale command fails): refused, it fails closed.
  fs.writeFileSync(serveFile, 'not json');
  const bad = await request(srv, 'POST', '/api/remote/hosts', { url: TS_URL, kind: 'tailscale' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.status, 'unconfirmed');
  assert.match(bad.body.error, /could not confirm Tailscale Funnel is off/);
  // Requests from this computer carry no Tailscale login (a tagged device): refused too.
  fs.writeFileSync(path.join(tunnelDir, 'login'), '');
  writeServe({});
  const tagged = await request(srv, 'POST', '/api/remote/hosts', { url: TS_URL, kind: 'tailscale' });
  assert.equal(tagged.status, 422);
  assert.match(tagged.body.error, /did not say which account/);
  fs.writeFileSync(path.join(tunnelDir, 'login'), OWNER);
  writeServe({ AllowFunnel: { [`${TS_HOST}`]: true } });
  const pub = await request(srv, 'POST', '/api/remote/hosts', { url: TS_URL, kind: 'tailscale' });
  assert.equal(pub.status, 422);
  assert.equal(pub.body.status, 'public');
  assert.match(pub.body.error, /Funnel is on/);
  assert.deepEqual((await request(srv, 'GET', '/api/remote')).body.hosts, [], 'nothing was stored');
  assert.equal(readJsonFile(path.join(home, '.clawdling', 'remote.json')).enabled, false);
});

test('remote add (Tailscale): checked, private, on; Clawdling only ever ran `serve status --json`', async () => {
  writeServe({ Web: { [TS_HOST]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${srv.port}` } } } } });
  const out = cli(['remote', 'add', TS_URL, '--kind', 'tailscale'], { env, home });
  assert.match(out, /Added https:\/\/box\.example\.ts\.net:8743\. Use from anywhere is on\./);
  assert.match(out, /Private to your devices ✓/);
  const v = (await request(srv, 'GET', '/api/remote')).body;
  assert.equal(v.enabled, true);
  assert.equal(v.hosts[0].status, 'private');
  assert.equal(v.hosts[0].answering, true);
  assert.equal(readJsonFile(path.join(home, '.clawdling', 'remote.json')).hosts[0].login, OWNER, 'the owner\'s Tailscale login, from the check\'s own request');
  const calls = fs.readFileSync(tsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.join(' '));
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((c) => c === 'serve status --json'), calls.join(' | '));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, '.clawdling', 'remote.json')).mode & 0o777, 0o600);
});

test('Host allowlist: exactly the registered host and port; the hello check answers only its own nonce', async () => {
  assert.equal((await raw('GET', '/api/org')).status, 401, 'registered: answered, but not signed in');
  assert.equal((await raw('GET', '/api/org', { host: 'box.example.ts.net' })).status, 403, 'port missing');
  assert.equal((await raw('GET', '/api/org', { host: 'box.example.ts.net:8744' })).status, 403, 'other port');
  assert.equal((await raw('GET', '/api/org', { host: 'evil.example.com' })).status, 403);
  const other = await raw('GET', '/api/org', { login: 'someone-else@example.com' });
  assert.equal(other.status, 403, 'another account on the tailnet');
  assert.match(other.body.error, /only for your own Tailscale account/);
  assert.equal((await raw('GET', '/api/org', { login: null })).status, 403, 'no Tailscale login (Funnel, a tagged device, or not through Serve)');
  assert.equal((await raw('GET', '/api/remote/hello?nonce=abc')).status, 403);
  assert.equal((await request(srv, 'GET', '/api/remote/hello?nonce=abc')).status, 404, 'never on the local host');
  const health = await raw('GET', '/api/health');
  assert.deepEqual(health.body, { ok: true, remote: true, signed_in: false }, 'a signed-out device learns nothing about this computer');
  assert.match(health.headers['strict-transport-security'], /max-age=/);
  const page = await raw('GET', '/');
  assert.equal(page.status, 200, 'the sign-in page itself is public');
  assert.match(page.text, /<html|<!doctype/i);
});

test('the long-lived token never works through a remote address (header, cookie, ?t= link, WebSocket)', async () => {
  assert.equal((await raw('GET', '/api/org', { headers: { 'x-clawdling-token': srv.token } })).status, 401);
  assert.equal((await raw('GET', '/api/org', { headers: { cookie: `cl_token=${srv.token}` } })).status, 401);
  const link = await raw('GET', `/?t=${srv.token}`);
  assert.equal(link.status, 302);
  assert.equal(link.headers['set-cookie'], undefined, 'no cookie for the token link');
  const local = await request(srv, 'GET', `/?t=${srv.token}`);
  assert.match(String(local.headers.get('set-cookie')), /cl_token=/, 'locally it still signs in');
  assert.equal((await raw('GET', '/api/pair', { headers: { 'x-clawdling-token': srv.token } })).status, 401);
});

test('pairing: local-only links, single use, https origin only, Secure HttpOnly SameSite=Strict cookie', async () => {
  assert.equal((await raw('POST', '/api/remote/pairing', { headers: origin(), body: {} })).status, 401, 'a remote request cannot make links');
  const p = await request(srv, 'POST', '/api/remote/pairing', {});
  assert.equal(p.status, 201);
  assert.equal(p.body.minutes, 10);
  const link = p.body.links[0];
  assert.equal(link.url, TS_URL);
  assert.match(link.link, /^https:\/\/box\.example\.ts\.net:8743\/\?pair=[A-Za-z0-9_-]{32}$/);
  assert.ok(!link.link.includes(srv.token) && !link.qr_svg.includes(srv.token), 'the token is never in the link or the QR');
  assert.match(link.qr_svg, /<svg/);
  const code = new URL(link.link).searchParams.get('pair');
  assert.equal((await request(srv, 'POST', '/api/remote/pair', { code })).status, 403, 'never on the local host');
  assert.equal((await raw('POST', '/api/remote/pair', { headers: { ...phone, origin: 'http://box.example.ts.net:8743' }, body: { code } })).status, 403, 'an http origin');
  assert.equal((await raw('POST', '/api/remote/pair', { headers: { ...phone, origin: 'https://evil.example' }, body: { code } })).status, 403, 'another site');
  assert.equal((await raw('POST', '/api/remote/pair', { headers: { ...phone, ...origin() }, body: { code: 'A'.repeat(32) } })).status, 401, 'wrong code');
  const ok = await raw('POST', '/api/remote/pair', { headers: { ...phone, ...origin() }, body: { code } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.device.label, 'iPhone · Safari');
  assert.equal(ok.body.device_token, undefined, 'a browser gets a cookie, not a token in the body');
  const set = String(ok.headers['set-cookie']);
  for (const flag of ['cl_device=cld_', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(set.includes(flag), flag);
  assert.equal((await raw('POST', '/api/remote/pair', { headers: { ...phone, ...origin() }, body: { code } })).status, 401, 'used once');
  const cookie = set.split(';')[0];
  const org = await raw('GET', '/api/org', { headers: { cookie } });
  assert.equal(org.status, 200);
  assert.ok(org.body.agents.length > 0);
  const health = await raw('GET', '/api/health', { headers: { cookie } });
  assert.equal(health.body.remote, true);
  assert.equal(health.body.home, home, 'a signed-in device sees the full health');
  const v = (await raw('GET', '/api/remote', { headers: { cookie } })).body;
  assert.equal(v.here.remote, true);
  assert.equal(v.here.url, TS_URL);
  assert.equal(v.devices.length, 1);
  assert.equal(v.here.device, v.devices[0].id);
  const disk = fs.readFileSync(path.join(home, '.clawdling', 'remote-devices.json'), 'utf8');
  assert.ok(!disk.includes(cookie.split('_').pop()), 'the device secret is not on disk');
});

test('a paired device drives the cockpit, but cannot reach the token, add addresses or turn it on', async () => {
  const { cookie } = await pairDevice();
  const h = { cookie, ...origin() };
  assert.equal((await raw('GET', '/api/sessions', { headers: { cookie } })).status, 200);
  for (const [m, p, body] of [
    ['GET', '/api/pair'],
    ['GET', '/api/pair/qr.svg'],
    ['POST', '/api/shutdown', {}],
    ['POST', '/api/hooks', { sid: '00000000-0000-4000-8000-000000000000', event: 'Stop' }],
    ['POST', '/api/remote/hosts', { url: 'https://other.example.ts.net', kind: 'tailscale' }],
    ['POST', '/api/remote/remove', { all: true }],
    ['POST', '/api/remote/pairing', {}],
  ]) {
    const r = await raw(m, p, { headers: h, body });
    assert.equal(r.status, 403, `${m} ${p}: ${r.text}`);
    assert.ok(!r.text.includes(srv.token));
  }
  const on = await raw('POST', '/api/remote/enabled', { headers: h, body: { enabled: true } });
  assert.equal(on.status, 403);
  assert.match(on.body.error, /Only the computer Clawdling runs on/);
  const csrf = await raw('POST', '/api/sessions', { headers: { cookie, origin: 'https://evil.example' }, body: { agent: 'work' } });
  assert.equal(csrf.status, 403, 'cross-origin');
  const httpOrigin = await raw('POST', '/api/sessions', { headers: { cookie, origin: 'http://box.example.ts.net:8743' }, body: { agent: 'work' } });
  assert.equal(httpOrigin.status, 403, 'http origin on a remote address');
  const check = await raw('POST', '/api/remote/check', { headers: h, body: {} });
  assert.equal(check.status, 200, 'checking is fine from anywhere');
});

test('the app pairs with a code and gets its own device token for the header', async () => {
  const p = await request(srv, 'POST', '/api/remote/pairing', {});
  const code = new URL(p.body.links[0].link).searchParams.get('pair');
  const r = await raw('POST', '/api/remote/pair', { headers: { 'user-agent': 'Clawdling/1.0 (iPhone)' }, body: { code, client: 'app' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.headers['set-cookie'], undefined);
  assert.match(r.body.device_token, /^cld_/);
  assert.equal((await raw('GET', '/api/org', { headers: { 'x-clawdling-token': r.body.device_token } })).status, 200);
});

test('pairing links expire', async () => {
  // A second server for this one, with a 300 ms pairing life (test mode only).
  const h2 = tempHome();
  const s2env = { ...env, CLAWDLING_PAIRING_TTL_MS: '300', CLAWDLING_TMUX_SOCKET: uniqueSocket() };
  try {
    cli(['init', '--defaults'], { env: s2env, home: h2 });
    const s2 = await startServerProc({ home: h2, env: s2env });
    try {
      fs.writeFileSync(path.join(h2, '.clawdling', 'remote.json'), JSON.stringify({ version: 1, enabled: true, hosts: [{ url: TS_URL, kind: 'tailscale', status: 'private', added_at: new Date().toISOString(), checked_at: null, detail: null, login: OWNER }] }));
      const p = await request(s2, 'POST', '/api/remote/pairing', {});
      assert.equal(p.status, 201, p.text);
      const code = new URL(p.body.links[0].link).searchParams.get('pair');
      await sleep(450);
      const r = await new Promise((resolve) => {
        const data = JSON.stringify({ code });
        const req = http.request({ host: '127.0.0.1', port: s2.port, path: '/api/remote/pair', method: 'POST', headers: { host: TS_HOST, 'tailscale-user-login': OWNER, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.end(data);
      });
      assert.equal(r, 401);
    } finally {
      await s2.stop();
      killTmux(s2env.CLAWDLING_TMUX_SOCKET);
    }
  } finally {
    rmrf(h2);
  }
});

test('proxy headers on a localhost Host, and Tailscale Funnel requests, are refused', async () => {
  const r = await raw('GET', '/api/health', { host: `127.0.0.1:${srv.port}`, headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /proxy/);
  assert.equal((await raw('GET', '/api/health', { host: `localhost:${srv.port}`, headers: { 'tailscale-user-login': 'x@example.com' } })).status, 403);
  assert.equal((await raw('GET', '/api/health', { headers: { 'tailscale-funnel-request': '?1' } })).status, 403);
});

function openWs({ cookie, originUrl = TS_URL, query = '' }, sid) {
  return new Promise((resolve) => {
    const headers = { Host: TS_HOST, 'Tailscale-User-Login': OWNER, ...(originUrl ? { Origin: originUrl } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/term/${sid}${query}`, { headers });
    ws.once('open', () => resolve({ ws, open: true }));
    ws.once('unexpected-response', (req, res) => resolve({ ws, open: false, status: res.statusCode }));
    ws.once('error', () => resolve({ ws, open: false, status: 0 }));
  });
}

function openSse(cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/events', headers: { host: TS_HOST, 'tailscale-user-login': OWNER, cookie }, agent: false }, (res) => {
      const st = { status: res.statusCode, closed: false, res };
      res.on('close', () => (st.closed = true));
      res.on('data', () => {});
      resolve(st);
    });
    req.on('error', reject);
    req.end();
  });
}

test('WebSocket and SSE through a remote address; Turn off closes them at once and signs every device out', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  const { cookie } = await pairDevice();
  const noCookie = await openWs({}, s.sid);
  assert.equal(noCookie.status, 401);
  const tokenQuery = await openWs({ query: `?t=${srv.token}` }, s.sid);
  assert.equal(tokenQuery.status, 401, 'the long-lived token in the URL does not work remotely');
  const httpOrigin = await openWs({ cookie, originUrl: 'http://box.example.ts.net:8743' }, s.sid);
  assert.equal(httpOrigin.status, 403);
  const evil = await openWs({ cookie, originUrl: 'https://evil.example' }, s.sid);
  assert.equal(evil.status, 403);
  const good = await openWs({ cookie }, s.sid);
  assert.equal(good.open, true);
  let wsClosed = false;
  good.ws.on('close', () => (wsClosed = true));
  const sse = await openSse(cookie);
  assert.equal(sse.status, 200);

  const off = await request(srv, 'POST', '/api/remote/enabled', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.deepEqual(off.body.devices, []);
  await waitFor(() => wsClosed && sse.closed, { label: 'remote connections closed', timeout: 3000 });
  const after = await raw('GET', '/api/org', { headers: { cookie } });
  assert.equal(after.status, 403);
  assert.equal(after.body.error, 'Use from anywhere is turned off on this computer.');
  assert.equal(after.headers['x-clawdling-refused'], '1');
  assert.equal((await request(srv, 'GET', '/api/org')).status, 200, 'the local cockpit is unaffected');
  assert.match(cli(['remote', 'list'], { env, home }), /Use from anywhere: off/);
  assert.equal((await request(srv, 'POST', '/api/remote/pairing', {})).status, 409, 'no links while off');

  const on = await request(srv, 'POST', '/api/remote/enabled', { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal((await raw('GET', '/api/org', { headers: { cookie } })).status, 401, 'turning on again does not bring old devices back');
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
});

test('signing a device out from the device itself clears its cookie', async () => {
  const { cookie, device } = await pairDevice();
  const r = await raw('DELETE', `/api/remote/devices/${device.id}`, { headers: { cookie, ...origin() } });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['set-cookie']), /cl_device=; .*Max-Age=0/);
  assert.equal((await raw('GET', '/api/org', { headers: { cookie } })).status, 401);
});

test('remote.json integrity: a hand-edited or broken file turns everything off within seconds', async () => {
  const { cookie } = await pairDevice();
  const sse = await openSse(cookie);
  assert.equal(sse.status, 200);
  const file = path.join(home, '.clawdling', 'remote.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, hosts: [{ url: 'http://box.example.ts.net:8743', kind: 'tailscale', status: 'private' }] }));
  await waitFor(() => sse.closed, { label: 'sse closed after a bad remote.json', timeout: 5000 });
  assert.equal((await raw('GET', '/api/org', { headers: { cookie } })).status, 403);
  const v = (await request(srv, 'GET', '/api/remote')).body;
  assert.equal(v.enabled, false);
  assert.match(v.invalid, /not valid/);
  // A host someone slipped in by hand, marked as checked: still only an exact, valid entry counts.
  fs.writeFileSync(file, good);
  await waitFor(async () => (await raw('GET', '/api/org', { headers: { cookie } })).status === 200, { label: 'back', timeout: 5000 });
});

// Last of the Tailscale tests: it leaves that address locked for five minutes.
test('throttle: ten bad credentials lock new attempts on that address; signed-in devices and the local cockpit keep working', async () => {
  const { cookie } = await pairDevice();
  let last;
  for (let i = 0; i < 11; i++) last = await raw('GET', '/api/org', { headers: { cookie: `cl_device=cld_000000000000_${'A'.repeat(43)}` } });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
  const p = await request(srv, 'POST', '/api/remote/pairing', {});
  const code = new URL(p.body.links[0].link).searchParams.get('pair');
  assert.equal((await raw('POST', '/api/remote/pair', { headers: { ...phone, ...origin() }, body: { code } })).status, 429, 'pairing waits too');
  assert.equal((await raw('GET', '/api/org', { headers: { cookie } })).status, 200, 'a paired device is not locked out');
  assert.equal((await request(srv, 'GET', '/api/org')).status, 200, 'the local cockpit is never throttled');
  assert.equal((await raw('GET', '/api/org')).status, 401, 'no credential at all is not a failed attempt');
});

test('Cloudflare: refused when it answers without Access; registered behind Access; every request needs a valid Access token', async () => {
  setMode('plain200');
  const plain = await request(srv, 'POST', '/api/remote/hosts', { url: CF_URL, kind: 'cloudflare' });
  assert.equal(plain.status, 422);
  assert.equal(plain.body.status, 'unprotected');
  setMode('forward'); // a tunnel straight to Clawdling, no Access in front
  const open = cliResult(['remote', 'add', CF_URL, '--kind', 'cloudflare'], { env, home });
  assert.equal(open.code, 1);
  assert.match(open.stderr, /answers without a Cloudflare Access sign-in/);
  assert.ok(!(await request(srv, 'GET', '/api/remote')).body.hosts.some((h) => h.url === CF_URL));

  setMode('access');
  const out = cli(['remote', 'add', CF_URL, '--kind', 'cloudflare'], { env, home });
  assert.match(out, /Behind Cloudflare Access ✓/);
  const stored = readJsonFile(path.join(home, '.clawdling', 'remote.json')).hosts.find((h) => h.url === CF_URL);
  assert.deepEqual(stored.access, { team_domain: 'https://team.cloudflareaccess.com', aud: access.aud });

  const jwt = access.sign({});
  assert.equal((await raw('GET', '/', { host: CF_HOST })).status, 403, 'no Access token: refused, even the page');
  assert.equal((await raw('GET', '/', { host: CF_HOST, headers: { 'cf-access-jwt-assertion': 'x.y.z' } })).status, 403);
  assert.equal((await raw('GET', '/', { host: CF_HOST, headers: { 'cf-access-jwt-assertion': access.sign({ aud: ['0'.repeat(64)] }) } })).status, 403, 'another application');
  assert.equal((await raw('GET', '/', { host: CF_HOST, headers: { 'cf-access-jwt-assertion': jwt } })).status, 200);
  const api401 = await raw('GET', '/api/org', { host: CF_HOST, headers: { 'cf-access-jwt-assertion': jwt } });
  assert.equal(api401.status, 401, 'Access is the first lock; a paired device is the second');
  const { cookie } = await pairDevice({ host: CF_HOST, url: CF_URL, extra: { 'cf-access-jwt-assertion': jwt } });
  assert.equal((await raw('GET', '/api/org', { host: CF_HOST, headers: { cookie, 'cf-access-jwt-assertion': jwt } })).status, 200);
  assert.equal((await raw('GET', '/api/org', { host: CF_HOST, headers: { cookie } })).status, 403, 'a device cookie alone is not enough');

  // Access removed later: the next check finds a page that answers, and the address stops.
  setMode('plain200');
  const check = cliResult(['remote', 'check'], { env, home });
  assert.equal(check.code, 1);
  assert.match(check.stdout, /Not behind Cloudflare Access ✗/);
  assert.equal((await raw('GET', '/api/org', { host: CF_HOST, headers: { cookie, 'cf-access-jwt-assertion': jwt } })).status, 403);
  setMode('forward');
});

test('remote remove and remote off; Donna cannot run `clawdling remote`', async () => {
  const donna = cliResult(['remote', 'list'], { env: { ...env, CLAWDLING_DONNA: '1' }, home });
  assert.equal(donna.code, 1);
  assert.match(donna.stderr, /not available to Donna/);
  const rm = cli(['remote', 'remove', CF_URL], { env, home });
  assert.match(rm, /Removed https:\/\/cockpit\.example\.com\./);
  assert.match(cliResult(['remote', 'remove', CF_URL], { env, home }).stderr, /not a remote address/);
  assert.match(cli(['remote', 'off'], { env, home }), /Use from anywhere is off/);
  assert.equal((await raw('GET', '/api/org')).status, 403);
  const all = cli(['remote', 'remove', '--all'], { env, home });
  assert.match(all, /Removed every remote address\. Use from anywhere is off\./);
  assert.deepEqual(readJsonFile(path.join(home, '.clawdling', 'remote.json')), { version: 1, enabled: false, hosts: [] });
  assert.match(cli(['remote', 'list'], { env, home }), /Use from anywhere: off\. Nothing outside/);
});
