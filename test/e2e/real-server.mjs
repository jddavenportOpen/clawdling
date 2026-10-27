// Boot the REAL Clawdling server (bin/clawdling.js) in test mode for the E2E suite:
// temp CLAWDLING_HOME, `clawdling init --defaults`, the fake claude, a private tmux socket,
// a dead Telegram base and a fake osascript. Nothing can reach Claude, Telegram or iMessage.
// Teardown stops the server, kills the private tmux server and deletes the temp home.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Variables a parent Claude Code / tmux would leak into the server and its sessions.
const PARENT_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'TMUX', 'TMUX_PANE', 'CLAWDLING_SID', 'CLAWDLING_PORT', 'CLAWDLING_HOME'];

export async function startRealServer({ repo = process.env.CLAWDLING_E2E_REPO || ROOT } = {}) {
  const cli = path.join(repo, 'bin', 'clawdling.js');
  const fakeClaude = path.join(repo, 'test', 'fake-claude.mjs');
  for (const f of [cli, fakeClaude]) {
    if (!fs.existsSync(f)) throw new Error(`CLAWDLING_E2E_REAL needs ${f} (set CLAWDLING_E2E_REPO to a checkout with the server)`);
  }
  // .native: on Windows it also turns 8.3 short names (C:\Users\RUNNER~1) into the real ones, which
  // Claude Code's file rules can express (the CTO seat refuses a folder they cannot).
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-web-e2e-')));
  const socket = `clawdling-webe2e-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const env = { ...process.env };
  for (const k of PARENT_VARS) delete env[k];
  Object.assign(env, {
    CLAWDLING_TEST: '1',
    CLAWDLING_HOME: home,
    CLAWDLING_CLAUDE_BIN: fakeClaude,
    CLAWDLING_TMUX_SOCKET: socket,
    TELEGRAM_API_BASE: 'http://127.0.0.1:9',
    CLAWDLING_OSASCRIPT_BIN: path.join(repo, 'test', 'fixtures', 'fake-osascript.mjs'),
    CLAWDLING_CHATDB_PATH: path.join(home, 'no-chat.db'),
    CLAWDLING_WEB_DIR: path.join(ROOT, 'web'), // always test THIS cockpit
    // Claude Code's own folder for this run: the fake claude writes its transcripts there (the
    // report card and Timeline read them), and nothing reads the real ~/.claude.
    CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'),
    CLAWDLING_MANAGED_SETTINGS: '',
  });
  // CLAWDLING_E2E_OWNER=<name>: the same default org under a placeholder owner name instead of this
  // computer's user name (for screenshots that may be shown to someone else).
  const owner = process.env.CLAWDLING_E2E_OWNER;
  const answers = path.join(home, 'answers.json');
  if (owner) fs.writeFileSync(answers, JSON.stringify({ owner, domains: ['Work', 'Health', 'Money', 'Home'], donna: { channel: 'none' } }));
  execFileSync(process.execPath, [cli, 'init', ...(owner ? ['--answers', answers] : ['--defaults'])], { env, stdio: 'ignore', timeout: 30000 });

  const proc = spawn(process.execPath, [cli, 'start', '--port', '0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-16000); });
  // A server that dies mid-run fails every later test with "fetch failed": say why, in the log
  // and in test-results (uploaded by CI), instead of leaving nothing behind.
  let closing = false;
  proc.on('exit', (code, signal) => {
    if (closing) return;
    let log = '';
    try { log = fs.readFileSync(path.join(home, '.clawdling', 'logs', 'server.log'), 'utf8').slice(-16000); } catch { /* none */ }
    const text = `real server exited unexpectedly (code ${code}, signal ${signal})\n--- stderr ---\n${stderr}\n--- server.log ---\n${log}\n`;
    console.error(text);
    try {
      const dir = path.join(ROOT, 'test', 'e2e', 'test-results');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'real-server-crash.log'), text);
    } catch { /* best effort */ }
  });
  const serverJson = path.join(home, '.clawdling', 'server.json');
  const until = Date.now() + 20000;
  let info = null;
  while (Date.now() < until && !info) {
    if (proc.exitCode !== null) break;
    try {
      const j = JSON.parse(fs.readFileSync(serverJson, 'utf8'));
      if (j && j.port && j.pid === proc.pid) info = j;
    } catch { /* not written yet */ }
    if (!info) await new Promise((r) => setTimeout(r, 100));
  }
  const cleanup = () => {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no sessions left */ }
    // A tmux server held up by an orphaned control client can outlive kill-server, and once its
    // socket file is gone nothing reaches it again: the socket name is unique to this run, end it all.
    if (process.platform !== 'win32') {
      try { execFileSync('pkill', ['-KILL', '-f', `tmux -L ${socket} `], { stdio: 'ignore' }); } catch { /* nothing left */ }
    }
    try { fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket), { force: true }); } catch { /* not there */ }
    // Windows: a session process that is still exiting can hold its folder for a moment (EBUSY).
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (e) { console.warn(`could not remove ${home}: ${e.message}`); }
  };
  if (!info) {
    closing = true;
    proc.kill('SIGKILL');
    cleanup();
    throw new Error(`real server did not start:\n${stderr}`);
  }
  const token = fs.readFileSync(path.join(home, '.clawdling', 'token'), 'utf8').trim();
  return {
    url: `http://127.0.0.1:${info.port}`,
    token,
    home,
    socket,
    close: async () => {
      closing = true;
      // A clean stop first (`clawdling stop`): it ends pty sessions and their processes, which a
      // signal cannot do on Windows (there it is TerminateProcess, and children are orphaned).
      if (proc.exitCode === null) {
        await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { 'x-clawdling-token': token } }).catch(() => {});
        await new Promise((r) => {
          const t = setTimeout(r, 8000);
          proc.once('exit', () => { clearTimeout(t); r(); });
        });
      }
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        await new Promise((r) => {
          const t = setTimeout(() => { proc.kill('SIGKILL'); r(); }, 5000);
          proc.once('exit', () => { clearTimeout(t); r(); });
        });
      }
      cleanup();
    },
  };
}
