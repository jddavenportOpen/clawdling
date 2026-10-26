// The detailed timeline (1.5, beta) and the Monday report against a real server: the /otlp ingest's
// rules (secret, loopback only, never through a remote address or a proxy, no browser Origin, JSON
// only, 1 MB, 50 a second, only while on), the preflight that keeps it off where the user already
// has telemetry settings, what reaches the Timeline, and the Monday report's API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { cli, killTmux, readJsonFile, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';
import { servePath } from '../../server/remote.js';
import { sessionCredential } from '../../server/otel.js';
import { readLog } from '../helpers.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'otlp');
const FIX_SID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const TS_URL = 'https://box.example.ts.net:8743';
const TS_HOST = 'box.example.ts.net:8743';
const OWNER = 'owner@example.com';

let home;
let socket;
let srv;
let configDir;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  configDir = path.join(home, 'claude-config');
  // No managed settings from the computer running the tests (CLAWDLING_MANAGED_SETTINGS, test mode only).
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, CLAUDE_CONFIG_DIR: configDir, FAKE_CLAUDE_LOG: path.join(home, 'fake.log'), CLAWDLING_MANAGED_SETTINGS: '' });
  for (const k of Object.keys(env)) if (/^OTEL_|TELEMETRY/.test(k)) delete env[k];
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

/** A raw POST, so the test controls Host, Origin and every header. */
function post(p, body, { host = `127.0.0.1:${srv.port}`, headers = {} } = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'POST', headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const payload = (file, sid) => JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8').replaceAll(FIX_SID, sid));
const secret = () => readJsonFile(path.join(home, '.clawdling', 'otel.json'))?.secret;
const hooksEnv = () => readJsonFile(path.join(home, '.clawdling', 'hooks-settings.json'))?.env;

test('off by default: no env block, and /otlp answers 404', async () => {
  const st = (await request(srv, 'GET', '/api/otel')).body;
  assert.equal(st.enabled, false);
  assert.equal(st.blocked, false);
  assert.equal(hooksEnv(), undefined);
  assert.equal((await post('/otlp/v1/logs', {})).status, 404);
});

test('on: the env block lands in our own --settings file; the ingest rules; records reach the Timeline', async () => {
  const on = await request(srv, 'POST', '/api/otel', { enabled: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.active, true);
  const env = hooksEnv();
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, `http://127.0.0.1:${srv.port}/otlp`);
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, undefined, 'the header is per session, not in the shared settings file');
  assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false, "the user's Claude settings are never written");

  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health', prompt: 'some work?' })).body;
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status === 'ready', { label: 'ready', timeout: 20000 });
  const tl0 = (await request(srv, 'GET', `/api/sessions/${s.sid}/timeline`)).body;
  const editId = tl0.entries.find((e) => e.name === 'Edit').id;
  const logs = payload('logs-2.json', s.sid);
  // Point the fixture's tool_decision at this session's Edit call.
  for (const r of logs.resourceLogs) for (const sc of r.scopeLogs) for (const l of sc.logRecords) for (const a of l.attributes) if (a.key === 'tool_use_id') a.value = { stringValue: editId };
  const good = { 'x-clawdling-otlp': sessionCredential(secret(), s.sid) };
  // The session's own credential reached its claude, in its environment.
  const launched = readLog(path.join(home, 'fake.log')).filter((e) => e.mode === 'interactive' && e.opts?.sessionId === s.sid).pop();
  assert.equal(launched.env.OTEL_EXPORTER_OTLP_HEADERS, `x-clawdling-otlp=${good['x-clawdling-otlp']}`);

  assert.equal((await post('/otlp/v1/logs', logs)).status, 401, 'no secret');
  assert.equal((await post('/otlp/v1/logs', logs, { headers: { 'x-clawdling-otlp': 'f'.repeat(64) } })).status, 401, 'wrong secret');
  assert.equal((await post('/otlp/v1/logs', logs, { headers: { 'x-clawdling-otlp': secret() } })).status, 401, "the org's secret itself is not a session credential");
  assert.equal((await post('/otlp/v1/logs', logs, { headers: { 'x-clawdling-otlp': sessionCredential(secret(), '12345678-1234-4234-8234-123456789012') } })).status, 401, 'a credential for a session this org does not have');
  assert.equal((await post('/otlp/v1/logs', logs, { headers: { ...good, origin: 'http://evil.example' } })).status, 403, 'a browser page');
  assert.equal((await post('/otlp/v1/logs', logs, { headers: { ...good, 'x-forwarded-for': '203.0.113.9' } })).status, 403, 'through a proxy');
  assert.equal((await post('/otlp/v1/logs', logs, { host: 'collector.example.com', headers: good })).status, 403, 'a name Clawdling does not know');
  assert.equal((await post('/otlp/v1/logs', 'x', { headers: { ...good, 'content-type': 'application/x-protobuf' } })).status, 415, 'protobuf');
  assert.equal((await post('/otlp/v1/logs', `{"pad":"${'x'.repeat(1024 * 1024)}"}`, { headers: good })).status, 413, 'over 1 MB');
  assert.equal((await post('/otlp/v1/nope', logs, { headers: good })).status, 404);
  const ok = await post('/otlp/v1/logs', logs, { headers: good });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await post('/otlp/v1/metrics', payload('metrics-1.json', s.sid), { headers: good })).status, 200);
  assert.equal((await post('/otlp/v1/traces', payload('traces-1.json', s.sid), { headers: good })).status, 200);
  // Records for another session, sent with this session's credential: accepted, never stored.
  const other = (await request(srv, 'POST', '/api/sessions', { agent: 'money' })).body;
  assert.equal((await post('/otlp/v1/logs', payload('logs-1.json', other.sid), { headers: good })).status, 200);
  assert.equal(fs.existsSync(path.join(home, '.clawdling', 'traces', `${other.sid}.jsonl`)), false);
  await request(srv, 'DELETE', `/api/sessions/${other.sid}`);

  const stored = fs.readFileSync(path.join(home, '.clawdling', 'traces', `${s.sid}.jsonl`), 'utf8');
  assert.ok(!/user\.id|REDACTED|"prompt"/.test(stored), 'identity and content dropped at ingest');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, '.clawdling', 'traces', `${s.sid}.jsonl`)).mode & 0o777, 0o600);
  const tl = (await request(srv, 'GET', `/api/sessions/${s.sid}/timeline`)).body;
  assert.equal(tl.detailed, true);
  assert.deepEqual(tl.entries.find((e) => e.id === editId).approval, { decision: 'accept', source: 'config', text: 'your settings allowed it' });

  // A malformed payload: 400, never a 500 in the server log.
  const evil = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: { toString: 0 }, attributes: [{ key: 'session.id', value: { stringValue: s.sid } }] }] }] }] };
  assert.equal((await post('/otlp/v1/logs', evil, { headers: good })).status, 200, 'hostile values are ignored');
  assert.equal((await post('/otlp/v1/logs', '{"resourceLogs": [', { headers: good })).status, 400);
  // Uploads that never finish: at most 4 in flight; the next is refused at once.
  const hanging = [];
  for (let i = 0; i < 4; i++) {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/otlp/v1/logs', method: 'POST', headers: { host: `127.0.0.1:${srv.port}`, 'content-type': 'application/json', 'content-length': 1000, ...good } });
    r.on('error', () => {});
    r.write('{"resourceLogs": [');
    hanging.push(r);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post('/otlp/v1/metrics', { resourceMetrics: [] }, { headers: good })).status, 429, 'too many in flight');
  for (const r of hanging) r.destroy();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post('/otlp/v1/metrics', { resourceMetrics: [] }, { headers: good })).status, 200, 'slots come back when uploads end');
  // Too fast: at most 50 a second.
  const burst = await Promise.all(Array.from({ length: 70 }, () => post('/otlp/v1/metrics', { resourceMetrics: [] }, { headers: good })));
  assert.ok(burst.some((r) => r.status === 429), 'some refused');
  assert.ok(burst.filter((r) => r.status === 200).length <= 50);
});

test('every remote path is refused, even with the right secret', async () => {
  const file = path.join(home, '.clawdling', 'remote.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, hosts: [{ url: TS_URL, kind: 'tailscale', status: 'private', added_at: new Date().toISOString(), checked_at: null, detail: null, login: OWNER, path: servePath(srv.token, TS_URL) }] }));
  try {
    const sid = (await request(srv, 'GET', '/api/sessions')).body.find((x) => x.agent === 'health').sid;
    const good = { 'x-clawdling-otlp': sessionCredential(secret(), sid), 'tailscale-user-login': OWNER };
    const r = await post(`${servePath(srv.token, TS_URL)}/otlp/v1/logs`, { resourceLogs: [] }, { host: TS_HOST, headers: good });
    assert.equal(r.status, 403, r.text);
    assert.equal((await post('/otlp/v1/logs', { resourceLogs: [] }, { host: TS_HOST, headers: good })).status, 403, 'without the private path');
    assert.equal((await post('/otlp/v1/logs', { resourceLogs: [] }, { headers: { ...good, 'tailscale-funnel-request': '?1' } })).status, 403, 'Funnel');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('turned off: the env block goes, the secret is forgotten, /otlp refuses', async () => {
  const sid = (await request(srv, 'GET', '/api/sessions')).body.find((x) => x.agent === 'health').sid;
  const old = sessionCredential(secret(), sid);
  const off = await request(srv, 'POST', '/api/otel', { enabled: false });
  assert.equal(off.body.enabled, false);
  assert.equal(hooksEnv(), undefined);
  assert.equal((await post('/otlp/v1/logs', { resourceLogs: [] }, { headers: { 'x-clawdling-otlp': old } })).status, 404);
  // On again: a new secret, so a credential from before is refused.
  await request(srv, 'POST', '/api/otel', { enabled: true });
  assert.equal((await post('/otlp/v1/logs', { resourceLogs: [] }, { headers: { 'x-clawdling-otlp': old } })).status, 401);
  await request(srv, 'POST', '/api/otel', { enabled: false });
});

test('the preflight runs again before every launch: settings added later turn it off for new sessions', async () => {
  await request(srv, 'POST', '/api/otel', { enabled: true });
  assert.ok(hooksEnv());
  // An agent's own folder (where its sessions run) gets a project setting that turns telemetry off.
  const dir = path.join(home, 'domains', 'money', '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ env: { DISABLE_TELEMETRY: '1' } }));
  try {
    const s = (await request(srv, 'POST', '/api/sessions', { agent: 'money' })).body;
    await waitFor(() => readLog(path.join(home, 'fake.log')).some((e) => e.mode === 'interactive' && e.opts?.sessionId === s.sid), { label: 'launched' });
    const launched = readLog(path.join(home, 'fake.log')).filter((e) => e.mode === 'interactive' && e.opts?.sessionId === s.sid).pop();
    assert.equal(launched.env.OTEL_EXPORTER_OTLP_HEADERS, null, 'no credential for a session started after the user said no');
    assert.equal(hooksEnv(), undefined, 'and the settings file lost its env block');
    assert.equal((await request(srv, 'GET', '/api/otel')).body.blocked, true);
    await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
  } finally {
    fs.rmSync(path.join(dir, 'settings.local.json'), { force: true });
    await request(srv, 'POST', '/api/otel', { enabled: false });
  }
});

test("never turned on where the user's Claude Code already has telemetry settings", async () => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ env: { OTEL_METRICS_EXPORTER: 'none', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com' } }));
  try {
    const st = (await request(srv, 'GET', '/api/otel')).body;
    assert.equal(st.blocked, true);
    assert.match(st.reason, /already has telemetry settings, so the detailed timeline stays off/);
    assert.deepEqual(st.found.map((f) => f.key).sort(), ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRICS_EXPORTER']);
    assert.ok(!JSON.stringify(st).includes('collector.example.com'), 'names, never values');
    const r = await request(srv, 'POST', '/api/otel', { enabled: true });
    assert.equal(r.status, 409);
    assert.equal(secret(), undefined);
    assert.equal(hooksEnv(), undefined);
  } finally {
    fs.rmSync(path.join(configDir, 'settings.json'), { force: true });
  }
  assert.equal((await request(srv, 'POST', '/api/otel', 'nope')).status, 400);
});

test('the Monday report: off by default, the exact text first, refused without a paired channel', async () => {
  const st = (await request(srv, 'GET', '/api/digest')).body;
  assert.equal(st.enabled, false);
  assert.equal(st.day_name, 'Monday');
  assert.equal(st.hour, 8);
  assert.match(st.preview, /^Clawdling: your week, the last 7 days\./);
  assert.match(st.preview, /list-price equivalent, not a bill/);
  assert.ok(!st.preview.includes('some work'), 'no prompt text, no titles');
  const r = await request(srv, 'POST', '/api/digest', { enabled: true, labels: st.preview_labels });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Pair Telegram or iMessage/);
  assert.equal((await request(srv, 'POST', '/api/digest', { hour: 99 })).status, 400);
});
