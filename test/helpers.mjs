// Shared test helpers. Every test gets a temp CLAWDLING_HOME, a unique tmux socket that is killed
// in teardown, a random port, and the fake claude. Nothing here can reach Telegram, iMessage or
// the real claude: CLAWDLING_TEST=1 makes the server refuse the official endpoints and binaries.
//
// The suites run under either session backend (CLAWDLING_BACKEND=tmux|pty, see test/run.mjs).
// Assertions about a session's process use sessionRunning() / terminalSize(): tmux itself for the
// tmux backend, the fake claude's own pid and its logged terminal size for the pty backend.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { selectBackend } from '../server/backend.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_CLAUDE = path.join(ROOT, 'test', 'fake-claude.mjs');
export const FAKE_OSASCRIPT = path.join(ROOT, 'test', 'fixtures', 'fake-osascript.mjs');
export const CLI = path.join(ROOT, 'bin', 'clawdling.js');
export const HOOK = path.join(ROOT, 'bin', 'clawdling-hook.js');

const PARENT_CLAUDE_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'TMUX', 'TMUX_PANE',
  'CLAWDLING_SID', 'CLAWDLING_PORT', 'CLAWDLING_HOME',
];

let counter = 0;
export function uniqueSocket() {
  return `clawdling-test-${process.pid}-${++counter}-${crypto.randomBytes(2).toString('hex')}`;
}

export function tempHome(prefix = 'cl-test-') {
  // .native: on Windows it also turns 8.3 short names (C:\Users\RUNNER~1) into the real ones.
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** The session backend the servers in these tests use (CLAWDLING_BACKEND, else the server's pick). */
export const BACKEND = selectBackend({ env: process.env }).kind || 'none';
export const IS_WIN = process.platform === 'win32';
export const onlyTmux = BACKEND === 'tmux' ? false : `tmux backend only (this run uses ${BACKEND})`;
export const onlyPty = BACKEND === 'pty' ? false : `pty backend only (this run uses ${BACKEND})`;
export const notWindows = IS_WIN ? 'not on Windows' : false;

export function testEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of PARENT_CLAUDE_VARS) delete env[k];
  return {
    ...env,
    CLAWDLING_TEST: '1',
    CLAWDLING_CLAUDE_BIN: FAKE_CLAUDE,
    TELEGRAM_API_BASE: 'http://127.0.0.1:9',
    CLAWDLING_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    CLAWDLING_CHATDB_PATH: path.join(os.tmpdir(), 'clawdling-test-no-chat.db'),
    ...extra,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 50, label = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export function cli(args, { env, home, timeout = 30000 } = {}) {
  return execFileSync(process.execPath, [CLI, ...args], { env: { ...env, CLAWDLING_HOME: home }, encoding: 'utf8', timeout });
}

export function cliResult(args, { env, home, timeout = 30000 } = {}) {
  try {
    return { code: 0, stdout: cli(args, { env, home, timeout }), stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Run `clawdling start` as a child process; resolves once server.json names it. */
export async function startServerProc({ home, env, port = 0 }) {
  const child = spawn(process.execPath, [CLI, 'start', '--port', String(port), '--home', home], { env: { ...env, CLAWDLING_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const serverJson = path.join(home, '.clawdling', 'server.json');
  const info = await waitFor(
    () => {
      if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${out}`);
      const j = readJsonFile(serverJson);
      return j && j.pid === child.pid ? j : null;
    },
    { timeout: 20000, label: 'server start' }
  );
  const token = fs.readFileSync(path.join(home, '.clawdling', 'token'), 'utf8').trim();
  const srv = {
    child,
    port: info.port,
    token,
    url: `http://127.0.0.1:${info.port}`,
    log: () => out,
    /** A clean stop: SIGTERM, or on Windows (where that would be TerminateProcess) the API. */
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      if (IS_WIN) {
        await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { 'x-clawdling-token': token } }).catch(() => {});
      } else child.kill('SIGTERM');
      await Promise.race([exited, sleep(10000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
  return srv;
}

export async function request(srv, method, p, body, headers = {}) {
  const res = await fetch(srv.url + p, {
    method,
    headers: { 'x-clawdling-token': srv.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

export function tmux(socket, ...args) {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function tmuxHas(socket, name) {
  try {
    tmux(socket, 'has-session', '-t', `=${name}`);
    return true;
  } catch {
    return false;
  }
}

export function killTmux(socket) {
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // not running
  }
  // A tmux server stuck behind orphaned control clients can outlive kill-server; once its socket
  // file is gone nothing could reach it again. The socket name is unique to this test: end both.
  if (process.platform !== 'win32') {
    try {
      execFileSync('pkill', ['-KILL', '-f', `tmux -L ${socket} `], { stdio: 'ignore' });
    } catch {
      // nothing left
    }
  }
  try {
    fs.unlinkSync(`${process.env.TMUX_TMPDIR || '/tmp'}/tmux-${process.getuid()}/${socket}`);
  } catch {
    // gone
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The fake claude's launches for one session (first start and resumes), oldest first. */
export function launches(fakeLog, sid) {
  return readLog(fakeLog).filter((e) => e.mode === 'interactive' && (e.opts?.sessionId === sid || e.opts?.resume === sid));
}

/** Is the session's claude running? tmux: its tmux session exists. pty: the fake's process is alive. */
export function sessionRunning({ socket, fakeLog }, s) {
  if (BACKEND === 'tmux') return tmuxHas(socket, s.tmux_name);
  const last = launches(fakeLog, s.sid).pop();
  return !!last && pidAlive(last.pid);
}

/** Wait until the session's claude is gone (a pty session takes a moment to exit after SIGHUP). */
export async function waitGone(ctx, s, label = 'session process gone') {
  await waitFor(() => !sessionRunning(ctx, s), { label, timeout: 8000 });
}

/** The terminal size the session's claude has, "COLSxROWS" (tmux's pane, or the fake's own log). */
export function terminalSize({ socket, fakeLog }, s) {
  if (BACKEND === 'tmux') return tmux(socket, 'display-message', '-p', '-t', `=${s.tmux_name}:`, '#{pane_width}x#{pane_height}').trim();
  const last = readLog(fakeLog).filter((e) => e.mode === 'size' && e.sid === s.sid).pop();
  return last ? `${last.cols}x${last.rows}` : null;
}

export function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** A WebSocket viewer that records every message. */
export async function openViewer(srv, sid, { origin, query } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/term/${sid}?t=${srv.token}${query ? `&${query}` : ''}`, origin ? { headers: { Origin: origin } } : {});
  const messages = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(String(raw)));
    } catch {
      // ignore
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => reject(new Error(`ws rejected: ${res.statusCode}`)));
  });
  const viewer = {
    ws,
    messages,
    send: (m) => ws.send(JSON.stringify(m)),
    output: () => messages.filter((m) => m.t === 'out' || m.t === 'snapshot').map((m) => m.data).join(''),
    async next(pred, timeout = 10000) {
      return waitFor(() => messages.find(pred), { timeout, label: 'ws message' });
    },
    async waitOutput(re, timeout = 10000) {
      return waitFor(() => re.test(viewer.output()), { timeout, label: `output ${re}` });
    },
    close: () => ws.close(),
  };
  return viewer;
}

export function readLog(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
