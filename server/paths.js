// Paths, binaries and environment-derived configuration.
// Everything that depends on the environment is read here so the rest of the
// server can be tested with explicit values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 4747;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_SOCKET = 'clawdling';

// The official Telegram Bot API. Overridable with TELEGRAM_API_BASE (tests point it at a local stub).
export const TELEGRAM_OFFICIAL_BASE = 'https://api.telegram.org';

const SOCKET_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve the org home: explicit value, then CLAWDLING_HOME, then ~/clawdling. */
export function resolveHome(explicit, env = process.env) {
  const raw = explicit || env.CLAWDLING_HOME || path.join(os.homedir(), 'clawdling');
  return path.resolve(expandHome(String(raw)));
}

/** Every file Clawdling reads or writes inside an org home. */
export function runtimePaths(home) {
  const rt = path.join(home, '.clawdling');
  return {
    home,
    rt,
    orgJson: path.join(home, 'org.json'),
    meMd: path.join(home, 'me.md'),
    orgClaudeMd: path.join(home, 'CLAUDE.md'),
    env: path.join(home, '.env'),
    archive: path.join(home, '.archive'),
    token: path.join(rt, 'token'),
    sessions: path.join(rt, 'sessions.json'),
    events: path.join(rt, 'events.jsonl'),
    hooksSettings: path.join(rt, 'hooks-settings.json'),
    logs: path.join(rt, 'logs'),
    run: path.join(rt, 'run'),
    ctx: path.join(rt, 'ctx'),
    bin: path.join(rt, 'bin'),
    server: path.join(rt, 'server.json'),
    tmuxConf: path.join(rt, 'tmux.conf'),
    hookSpool: path.join(rt, 'hook-spool.jsonl'),
    telegramState: path.join(rt, 'telegram.json'),
    imessageState: path.join(rt, 'imessage.json'),
    donnaChat: path.join(rt, 'donna-chat.jsonl'),
  };
}

/** tmux socket name for Clawdling's dedicated tmux server (never the user's default server). */
export function tmuxSocketName(env = process.env) {
  const s = env.CLAWDLING_TMUX_SOCKET || DEFAULT_SOCKET;
  if (!SOCKET_RE.test(s)) throw new Error(`invalid CLAWDLING_TMUX_SOCKET ${JSON.stringify(s)} (use letters, digits, . _ -)`);
  return s;
}

export function telegramApiBase(env = process.env) {
  return String(env.TELEGRAM_API_BASE || TELEGRAM_OFFICIAL_BASE).replace(/\/+$/, '');
}

export function isTestMode(env = process.env) {
  return env.CLAWDLING_TEST === '1';
}

/** Find an executable on PATH (or check an explicit path). Returns an absolute path or null. */
export function which(cmd, envPath = process.env.PATH || '') {
  if (!cmd) return null;
  if (cmd.includes('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return path.resolve(cmd);
    } catch {
      return null;
    }
  }
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

// Variables a parent Claude Code session sets for its own child processes. If Clawdling is
// started from inside Claude Code (the agent-native install does exactly that), these must not
// leak into the sessions Clawdling spawns: a child claude that sees them believes it is nested
// inside the installer session. TMUX/TMUX_PANE would make our tmux client refuse to attach.
export const SCRUBBED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'TMUX',
  'TMUX_PANE',
  'CLAWDLING_SID',
];

/** A copy of the environment that is safe to hand to tmux and claude child processes. */
export function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of SCRUBBED_ENV) delete out[k];
  return out;
}
