// Which session backend runs this org's Claude Code sessions.
//
//   tmux  sessions live in Clawdling's own tmux server and survive Clawdling restarts.
//   pty   sessions live in a pseudo-terminal inside the Clawdling server (node-pty): no tmux
//         needed, so native Windows and a Mac without Homebrew work. They end when it stops.
//
// CLAWDLING_BACKEND=tmux|pty overrides. Otherwise: tmux when tmux >= 3.2 is on PATH and this is
// not Windows; else pty when node-pty loads; else `clawdling start` and `doctor` fail with the
// one-line fix for this OS.
import { spawnSync } from 'node:child_process';
import { PKG_ROOT, which } from './paths.js';
import { installCommand, packageManager } from './platform.js';
import { createPtyBackend, loadPtyModules } from './pty.js';
import { Tmux } from './tmux.js';

export const BACKEND_KINDS = ['tmux', 'pty'];
export const BACKEND_LABEL = {
  tmux: 'tmux (sessions keep running when Clawdling stops)',
  pty: 'built-in terminal, node-pty (sessions end when Clawdling stops; resume them any time)',
};

/** {major, minor} from `tmux -V` output ("tmux 3.6a", "tmux next-3.7"), or null. */
export function parseTmuxVersion(text) {
  const m = String(text || '').match(/tmux\s+(?:next-)?(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

export function tmuxRecent(text) {
  const v = parseTmuxVersion(text);
  return !!v && (v.major > 3 || (v.major === 3 && v.minor >= 2));
}

/** Look for tmux: {found, ok, version, path, error}. Never used on Windows. */
export function probeTmux({ bin = 'tmux', env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return { found: false, ok: false, version: null, error: 'tmux is not used on Windows' };
  const p = which(bin, env.PATH || '');
  if (!p) return { found: false, ok: false, version: null, error: 'tmux is not installed' };
  const r = spawnSync(p, ['-V'], { encoding: 'utf8', env, timeout: 5000 });
  const version = (r.stdout || '').trim() || null;
  if (!tmuxRecent(version)) return { found: true, ok: false, version, path: p, error: `${version || 'tmux'} is older than 3.2` };
  return { found: true, ok: true, version, path: p };
}

/** Can node-pty run sessions here? {ok, version} or {ok: false, error}. */
export function probePty() {
  const m = loadPtyModules();
  return m.ok ? { ok: true, version: m.version } : { ok: false, error: m.error };
}

/** The exact one-line fixes, for this OS and its package manager. */
export function backendFixes({ platform = process.platform, pm = null, pkgRoot = PKG_ROOT } = {}) {
  const reinstall = platform === 'win32' ? `cd "${pkgRoot}"; npm install` : `cd "${pkgRoot}" && npm install`;
  const tmux = installCommand('tmux', pm) || (platform === 'darwin' ? 'install Homebrew (https://brew.sh), then: brew install tmux' : 'install tmux 3.2 or newer with your package manager');
  const build = installCommand('buildTools', pm);
  if (platform === 'win32') return { tmux: null, pty: reinstall, any: `${reinstall}   (installs node-pty, prebuilt for Windows)` };
  if (platform === 'darwin') return { tmux, pty: reinstall, any: `${reinstall}   (installs node-pty, prebuilt for macOS), or: ${tmux}` };
  return { tmux, pty: build ? `${build} && ${reinstall}` : reinstall, any: tmux };
}

/**
 * Pure choice. `tmux` and `pty` are probe results; returns {kind, reason} or {error, fix}.
 */
export function chooseBackend({ requested, platform = process.platform, tmux, pty, fixes }) {
  const req = String(requested || '').trim().toLowerCase();
  if (req && !BACKEND_KINDS.includes(req)) return { error: `CLAWDLING_BACKEND must be "tmux" or "pty" (it is "${requested}")`, fix: 'unset CLAWDLING_BACKEND' };
  if (req === 'tmux') {
    if (platform === 'win32') return { error: 'tmux sessions are not available on Windows', fix: 'unset CLAWDLING_BACKEND (Windows uses the built-in terminal)' };
    if (!tmux.ok) return { error: `CLAWDLING_BACKEND=tmux, but ${tmux.error}`, fix: fixes.tmux };
    return { kind: 'tmux', reason: 'CLAWDLING_BACKEND=tmux' };
  }
  if (req === 'pty') {
    if (!pty.ok) return { error: `CLAWDLING_BACKEND=pty, but node-pty did not load (${pty.error})`, fix: fixes.pty };
    return { kind: 'pty', reason: 'CLAWDLING_BACKEND=pty' };
  }
  if (platform !== 'win32' && tmux.ok) return { kind: 'tmux', reason: `${tmux.version} is installed` };
  if (pty.ok) {
    const why = platform === 'win32' ? 'Windows' : tmux.found ? `${tmux.version} is older than 3.2` : 'tmux is not installed';
    return { kind: 'pty', reason: why };
  }
  const why = platform === 'win32' ? `node-pty did not load (${pty.error})` : `${tmux.error}, and node-pty did not load (${pty.error})`;
  return { error: `no way to run sessions: ${why}`, fix: fixes.any };
}

/** Probe this machine and choose (shared by `clawdling start` and `clawdling doctor`). */
export function selectBackend({ env = process.env, childEnv = env, platform = process.platform } = {}) {
  const requested = env.CLAWDLING_BACKEND;
  const tmux = probeTmux({ bin: env.CLAWDLING_TMUX_BIN || 'tmux', env: childEnv, platform });
  // Load node-pty only where it may run sessions: a tmux machine never needs it.
  const wantPty = String(requested || '').toLowerCase() === 'pty' || platform === 'win32' || (!requested && !tmux.ok);
  const pty = wantPty ? probePty() : { ok: false, error: 'not needed: tmux runs the sessions', skipped: true };
  const pm = packageManager({ platform, has: (b) => !!which(b, childEnv.PATH || '') });
  const fixes = backendFixes({ platform, pm });
  return { ...chooseBackend({ requested, platform, tmux, pty, fixes }), tmux, pty, pm, fixes };
}

/** The backend instance the server uses. Throws (code ENOBACKEND) with the fix when there is none. */
export async function createBackend({ env, childEnv, paths, socket, logger, attachPrefix, platform = process.platform }) {
  const choice = selectBackend({ env, childEnv, platform });
  if (choice.error) {
    const e = new Error(`${choice.error}. Fix: ${choice.fix}`);
    e.code = 'ENOBACKEND';
    throw e;
  }
  let backend;
  if (choice.kind === 'tmux') {
    backend = new Tmux({ bin: env.CLAWDLING_TMUX_BIN || 'tmux', socket, conf: paths.tmuxConf, env: childEnv });
  } else {
    const r = createPtyBackend({ logger, attachPrefix, platform });
    if (r.error) {
      const e = new Error(`node-pty did not load (${r.error}). Fix: ${choice.fixes.pty}`);
      e.code = 'ENOBACKEND';
      throw e;
    }
    backend = r.backend;
  }
  backend.reason = choice.reason;
  backend.tmuxProbe = choice.tmux;
  await backend.init();
  return backend;
}
