import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OtelState, RateLimit, TraceStore, droppedKey, enrich, envBlock, managedSettingsPaths, normalize, preflight, sourceText, telemetryKey } from '../../server/otel.js';
import { buildHooksSettings } from '../../server/hooks.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'otlp');
const SID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clawdling-otel-'));
const writeSettings = (dir, obj) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(obj));
};

test('telemetry keys: the names that mean the user already decided', () => {
  for (const k of ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'otel_logs_exporter', 'DISABLE_TELEMETRY', 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA']) assert.ok(telemetryKey(k), k);
  for (const k of ['PATH', 'HOME', 'ANTHROPIC_MODEL', 'MOTEL']) assert.ok(!telemetryKey(k), k);
});

test('preflight matrix: none, user env, a project, managed, a managed drop-in, the launch env, a device profile', () => {
  const root = tmp();
  const user = path.join(root, 'claude');
  const repo = path.join(root, 'repo');
  const managedDir = path.join(root, 'managed');
  const managed = path.join(managedDir, 'managed-settings.json');
  const base = { env: { PATH: '/bin' }, configDirs: [user], projectDirs: [repo], managed: [managed], profiles: [] };
  assert.deepEqual(preflight(base), { clear: true, found: [] }, 'nothing anywhere');
  writeSettings(user, { env: { ANTHROPIC_MODEL: 'x' }, model: 'opus' });
  assert.equal(preflight(base).clear, true, 'other settings are fine');
  writeSettings(user, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com', SECRET_VALUE: 'never-read' } });
  const u = preflight(base);
  assert.equal(u.clear, false);
  assert.deepEqual(u.found.map((f) => [f.where, f.key]), [['your Claude Code settings', 'OTEL_EXPORTER_OTLP_ENDPOINT']]);
  assert.ok(!JSON.stringify(u).includes('collector.example.com'), 'names only, never values');
  writeSettings(user, { otelHeadersHelper: '/usr/local/bin/helper' });
  assert.equal(preflight(base).found[0].key, 'otelHeadersHelper');
  fs.rmSync(user, { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ env: { DISABLE_TELEMETRY: '1' } }));
  assert.equal(preflight(base).found[0].where, "a project's Claude Code settings");
  fs.rmSync(repo, { recursive: true });
  fs.mkdirSync(path.join(managedDir, 'managed-settings.d'), { recursive: true });
  fs.writeFileSync(path.join(managedDir, 'managed-settings.d', '10-otel.json'), JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }));
  assert.equal(preflight(base).found[0].where, 'managed settings on this computer');
  fs.rmSync(managedDir, { recursive: true });
  fs.mkdirSync(managedDir);
  fs.writeFileSync(managed, '{ not json');
  assert.equal(preflight(base).clear, false, 'a managed file that cannot be read keeps it off');
  fs.rmSync(managedDir, { recursive: true });
  assert.equal(preflight({ ...base, env: { OTEL_SERVICE_NAME: 'x' } }).found[0].where, "Clawdling's own environment");
  const profile = path.join(root, 'com.anthropic.claudecode.plist');
  fs.writeFileSync(profile, 'binary');
  assert.equal(preflight({ ...base, profiles: [profile] }).clear, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('managed settings paths per OS', () => {
  assert.deepEqual(managedSettingsPaths('darwin'), ['/Library/Application Support/ClaudeCode/managed-settings.json']);
  assert.deepEqual(managedSettingsPaths('linux'), ['/etc/claude-code/managed-settings.json']);
  assert.equal(managedSettingsPaths('win32', { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' })[0], 'C:\\Program Files\\ClaudeCode\\managed-settings.json');
});

test("the env block goes into Clawdling's own --settings file, endpoint on 127.0.0.1, content gates unset", () => {
  const env = envBlock({ port: 4747, secret: 'a'.repeat(64) });
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4747/otlp');
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, `x-clawdling-otlp=${'a'.repeat(64)}`);
  for (const gate of ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT']) assert.ok(!(gate in env), gate);
  const s = buildHooksSettings({ nodePath: '/n', hookScript: '/h', platform: 'linux', env });
  assert.equal(s.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.ok(!('env' in buildHooksSettings({ nodePath: '/n', hookScript: '/h', platform: 'linux' })), 'off: no env block at all');
});

test('normalize: the real 2.1.308 payloads, scrubbed; identity and content attributes dropped', () => {
  const all = [];
  for (const f of fs.readdirSync(FIX)) {
    const kind = f.split('-')[0];
    all.push(...normalize(kind, JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'))));
  }
  assert.ok(all.length > 10);
  assert.ok(all.every((x) => x.sid === SID), 'every record carries session.id');
  const keys = new Set(all.flatMap((x) => Object.keys(x.rec.attrs)));
  for (const k of ['user.id', 'prompt', 'prompt_text', 'response', 'user_prompt', 'llm_request.context']) assert.ok(!keys.has(k), `dropped ${k}`);
  assert.ok(!JSON.stringify(all).includes('REDACTED'));
  const decision = all.find((x) => x.rec.k === 'log' && x.rec.name === 'tool_decision');
  assert.equal(decision.rec.attrs.source, 'config');
  assert.equal(decision.rec.attrs.tool_name, 'Read');
  assert.match(decision.rec.attrs.tool_use_id, /^toolu_/);
  const api = all.find((x) => x.rec.name === 'api_request');
  assert.ok(api.rec.attrs.duration_ms > 0);
  assert.ok(all.some((x) => x.rec.k === 'metric' && x.rec.name === 'claude_code.cost.usage'));
  const span = all.find((x) => x.rec.k === 'span' && x.rec.name === 'tool.execution');
  assert.ok(Number.isFinite(span.rec.dur_ms));
  assert.ok(!span.rec.attrs['session.id'], 'session.id moves to the file name');
});

test('normalize: junk, a missing session id, big and nested values', () => {
  assert.deepEqual(normalize('logs', null), []);
  assert.deepEqual(normalize('logs', { resourceLogs: 'x' }), []);
  assert.deepEqual(normalize('logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [{ key: 'event.name', value: { stringValue: 'x' } }] }] }] }] }), [], 'no session.id: dropped');
  const r = normalize('logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1792975000000000000', attributes: [
    { key: 'session.id', value: { stringValue: SID } }, { key: 'event.name', value: { stringValue: 'tool_decision' } },
    { key: 'big', value: { stringValue: 'x'.repeat(5000) } }, { key: 'nested', value: { kvlistValue: { values: [] } } },
    { key: 'user.email', value: { stringValue: 'someone@example.com' } }, { key: 'tool.content', value: { stringValue: 'secret' } }, { key: 'n', value: { intValue: '42' } },
  ] }] }] }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].rec.attrs.big.length, 300);
  assert.ok(!('nested' in r[0].rec.attrs));
  assert.ok(!('user.email' in r[0].rec.attrs) && !('tool.content' in r[0].rec.attrs));
  assert.equal(r[0].rec.attrs.n, 42);
  assert.equal(r[0].rec.ts, new Date(1792975000000).toISOString());
  assert.ok(droppedKey('organization.id') && droppedKey('gen_ai.prompt') && !droppedKey('prompt.id') && !droppedKey('prompt_length'));
});

test('the secret: made when turned on, compared in constant time, forgotten when turned off', () => {
  const dir = tmp();
  const st = new OtelState(path.join(dir, 'otel.json'));
  assert.equal(st.read().enabled, false);
  assert.equal(st.check('anything'), false);
  const on = st.set(true);
  assert.match(on.secret, /^[0-9a-f]{64}$/);
  assert.equal(st.check(on.secret), true);
  assert.equal(st.check(on.secret.slice(0, 63)), false);
  assert.equal(st.check(undefined), false);
  assert.equal((fs.statSync(path.join(dir, 'otel.json')).mode & 0o777).toString(8), process.platform === 'win32' ? (fs.statSync(path.join(dir, 'otel.json')).mode & 0o777).toString(8) : '600');
  const again = st.set(true);
  assert.notEqual(again.secret, on.secret, 'a new secret each time');
  st.set(false);
  assert.equal(st.check(again.secret), false);
  assert.equal(st.read().secret, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rate limit: at most 50 a second', () => {
  let t = 1000;
  const rl = new RateLimit(50, () => t);
  let ok = 0;
  for (let i = 0; i < 60; i++) if (rl.allow()) ok++;
  assert.equal(ok, 50);
  t += 1000;
  assert.equal(rl.allow(), true);
});

test('trace store: per session, append-only, capped and pruned', () => {
  const dir = tmp();
  const ts = new TraceStore(dir, { maxBytes: 400 });
  ts.append([{ sid: SID, rec: { k: 'log', name: 'a', pad: 'x'.repeat(100) } }]);
  ts.append([{ sid: SID, rec: { k: 'log', name: 'b' } }]);
  assert.deepEqual(ts.read(SID).map((r) => r.name), ['a', 'b']);
  assert.throws(() => ts.file('../x'));
  const other = '77777777-7777-4777-8777-777777777777';
  const old = (Date.now() - 20 * 86400000) / 1000;
  fs.utimesSync(ts.file(SID), old, old);
  ts.append([{ sid: other, rec: { k: 'log', name: 'c', pad: 'y'.repeat(300) } }]);
  assert.equal(fs.existsSync(ts.file(SID)), false, 'over the cap: the oldest went first');
  assert.equal(ts.read(other).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enrich: who approved each tool (by tool_use_id), and each turn\'s API requests', () => {
  const entries = [
    { kind: 'prompt', depth: 0, ts: '2026-10-25T10:00:00.000Z' },
    { kind: 'tool', id: 'toolu_1', depth: 0 },
    { kind: 'prompt', depth: 0, ts: '2026-10-25T10:05:00.000Z' },
    { kind: 'tool', id: 'toolu_2', depth: 0 },
  ];
  enrich(entries, [
    { k: 'log', name: 'tool_decision', attrs: { tool_use_id: 'toolu_1', decision: 'accept', source: 'user_temporary' } },
    { k: 'log', name: 'api_request', ts: '2026-10-25T10:00:01.000Z', attrs: { duration_ms: 1500 } },
    { k: 'log', name: 'api_request', ts: '2026-10-25T10:00:09.000Z', attrs: { duration_ms: 500 } },
    { k: 'log', name: 'api_request', ts: '2026-10-25T10:05:01.000Z', attrs: { duration_ms: 700 } },
  ]);
  assert.deepEqual(entries[1].approval, { decision: 'accept', source: 'user_temporary', text: 'you allowed it once' });
  assert.equal(entries[3].approval, undefined);
  assert.deepEqual(entries[0].api, { requests: 2, ms: 2000 });
  assert.deepEqual(entries[2].api, { requests: 1, ms: 700 });
  assert.equal(sourceText('config'), 'your settings allowed it');
});
