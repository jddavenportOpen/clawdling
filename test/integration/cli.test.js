// The CLI against a running server: what agents and Donna actually call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { BACKEND, CLI, cli, cliResult, killTmux, onlyPty, onlyTmux, request, rmrf, startServerProc, tempHome, testEnv, tmux, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let env;
let srv;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  env = testEnv({ CLAWDLING_TMUX_SOCKET: socket });
  const out = cli(['init', '--defaults'], { env, home });
  assert.match(out, /Created .*'s org at/);
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

test('init refuses to overwrite an org; --version and help', () => {
  const r = cliResult(['init', '--defaults'], { env, home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists/);
  assert.match(cli(['--version'], { env, home }), /^\d+\.\d+\.\d+/);
  assert.match(cli(['help'], { env, home }), /clawdling spawn <agent>/);
  assert.match(cliResult(['frobnicate'], { env, home }).stderr, /unknown command/);
});

test('spawn / ls / send / end / resume by short id', async () => {
  const out = cli(['spawn', 'work', 'draft', 'the', 'weekly', 'update'], { env, home });
  const m = out.match(/Started work session ([0-9a-f-]{36}) \(Draft the weekly update\)/);
  assert.ok(m, out);
  const sid = m[1];
  const short = sid.slice(0, 8);
  assert.match(out, new RegExp(`clawdling attach ${short}`));
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${sid}`)).body.status === 'ready', { label: 'ready' });
  const list = JSON.parse(cli(['ls', '--json'], { env, home }));
  assert.ok(list.some((s) => s.sid === sid && s.status === 'ready'));
  assert.match(cli(['ls'], { env, home }), new RegExp(`${short}\\s+work\\s+ready\\s+Draft the weekly update`));
  assert.match(cli(['send', short, 'and', 'the', 'monthly', 'one'], { env, home }), /Sent to work session/);
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${sid}`)).body.last_message === 'and the monthly one', { label: 'send landed' });
  assert.match(cli(['end', short], { env, home }), /Ended work session/);
  assert.equal((await request(srv, 'GET', `/api/sessions/${sid}`)).body.status, 'ended');
  assert.ok(!JSON.parse(cli(['ls', '--json'], { env, home })).some((s) => s.sid === sid), 'ls hides ended sessions');
  assert.ok(JSON.parse(cli(['ls', '--all', '--json'], { env, home })).some((s) => s.sid === sid));
  assert.match(cli(['resume', short], { env, home }), /Resumed work session/);
  assert.match(cliResult(['send', 'zzzzzzzz', 'x'], { env, home }).stderr, /no session matches/);
  const json = JSON.parse(cli(['spawn', 'health', '--json', '--model', 'haiku'], { env, home }));
  assert.equal(json.model, 'haiku');
});

test('new domain / new project, through the API when the server runs', async () => {
  assert.match(cli(['new', 'domain', 'Garden Club', '--mission', 'Grow tomatoes'], { env, home }), /Created domain agent "Garden Club" \(id garden-club\)/);
  const repo = tempHome('cl-cli-repo-');
  try {
    const p = JSON.parse(cli(['new', 'project', 'New Site', '--goal', 'Launch it', '--repo', repo, '--domain', 'work', '--json'], { env, home }));
    assert.equal(p.repo, repo);
    assert.equal(p.domain, 'work');
    const s = (await request(srv, 'POST', '/api/sessions', { agent: 'new-site' })).body;
    assert.equal(s.cwd, repo, 'project agents with a repo work in the repo');
    const ctx = fs.readFileSync(path.join(home, '.clawdling', 'ctx', 'new-site.md'), 'utf8');
    assert.match(ctx, /Org rules/);
    assert.match(ctx, /Current state \(memory\/NOW.md\)/);
    assert.match(ctx, /Launch it/);
  } finally {
    rmrf(repo);
  }
  const org = (await request(srv, 'GET', '/api/org')).body;
  assert.ok(org.agents.some((a) => a.id === 'garden-club'));
  assert.match(cliResult(['new', 'domain', 'Garden Club'], { env, home }).stderr, /already exists/);
});

test('doctor, donna status, open --print, service --dry-run', () => {
  const d = cliResult(['doctor'], { env, home });
  assert.equal(d.code, 0, d.stdout + d.stderr);
  if (BACKEND === 'tmux') assert.match(d.stdout, /ok\s+sessions: tmux \d/);
  else assert.match(d.stdout, /ok\s+sessions: built-in terminal \(node-pty/);
  assert.match(d.stdout, /ok\s+claude 2\.1/);
  assert.match(d.stdout, /cockpit running/);
  assert.match(cli(['donna', 'status'], { env, home }), /Telegram: not set up/);
  assert.equal(cli(['open', '--print'], { env, home }).trim(), `http://127.0.0.1:${srv.port}/?t=${srv.token}`);
  if (process.platform === 'darwin') {
    const plist = cli(['service', 'install', '--dry-run'], { env, home });
    assert.match(plist, /would write .*com\.clawdling\.cockpit\.plist/);
    assert.match(plist, /<string>start<\/string>/);
  }
});

test('Donna turns cannot run admin commands through the CLI', () => {
  const denv = { ...env, CLAWDLING_DONNA: '1' };
  for (const cmd of [['init', '--force'], ['service', 'install'], ['donna', 'telegram', '--token', 'x'], ['start']]) {
    const r = cliResult(cmd, { env: denv, home });
    assert.equal(r.code, 1, cmd.join(' '));
    assert.match(r.stderr, /not available to Donna/);
  }
});

test('helpful error when the server is not running', () => {
  const other = tempHome();
  try {
    cli(['init', '--defaults'], { env, home: other });
    const r = cliResult(['spawn', 'work'], { env: { ...env, CLAWDLING_PORT: '9' }, home: other });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /isn't running .*clawdling start/);
  } finally {
    rmrf(other);
  }
});

test('attach uses the tmux socket the sessions live on (server.json / registry), not the default', { skip: onlyTmux }, async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'home' })).body;
  const logFile = path.join(home, 'fake-tmux.log');
  const fakeTmux = path.join(home, 'fake-tmux.sh');
  fs.writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$@" > '${logFile}'\n`, { mode: 0o755 });
  const noSocketEnv = { ...env, CLAWDLING_TMUX_BIN: fakeTmux };
  delete noSocketEnv.CLAWDLING_TMUX_SOCKET;
  cli(['attach', s.sid.slice(0, 8)], { env: noSocketEnv, home });
  const argv = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.deepEqual(argv, ['-L', socket, 'attach-session', '-t', `=${s.tmux_name}`]);
});

test('the tmux config turns focus events on (Claude Code asks for them)', { skip: onlyTmux }, () => {
  assert.match(fs.readFileSync(path.join(home, '.clawdling', 'tmux.conf'), 'utf8'), /^set -g focus-events on$/m);
  assert.match(tmux(socket, 'show-options', '-g', 'focus-events'), /focus-events on/);
});

test('doctor fails (no "All good") when the cockpit is not running', () => {
  const down = tempHome();
  try {
    cli(['init', '--defaults'], { env, home: down });
    const r = cliResult(['doctor'], { env: { ...env, CLAWDLING_PORT: '9' }, home: down });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FIX\s+the cockpit is not running/);
    assert.doesNotMatch(r.stdout, /All good/);
  } finally {
    rmrf(down);
  }
});

test('pty: attach is a terminal client over the cockpit WebSocket (snapshot, input, detach with Ctrl-])', { skip: onlyPty }, async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'home', prompt: 'hello attach' })).body;
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status === 'ready', { label: 'ready' });
  const child = spawn(process.execPath, [CLI, 'attach', s.sid.slice(0, 8)], { env: { ...env, CLAWDLING_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  try {
    await waitFor(() => /assistant: hello attach/.test(out), { label: `snapshot in the attached terminal (${err})` });
    child.stdin.write('typed in the terminal\r');
    await waitFor(() => /assistant: typed in the terminal/.test(out), { label: 'live output after input' });
    await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.last_message === 'typed in the terminal', { label: 'input reached claude' });
    child.stdin.write('\x1d'); // Ctrl-] detaches
    assert.equal(await exited, 0);
    assert.match(err, /Detached/);
    assert.notEqual((await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status, 'ended', 'detaching leaves the session running');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
