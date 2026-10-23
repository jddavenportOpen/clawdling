// How a person at this computer should type Clawdling commands. The cockpit prints commands
// (open the cockpit, connect Telegram, restart with --host), and a by-hand install has no
// `clawdling` on PATH (README: `node bin/clawdling.js ...`; `npm link` is opt-in), so a bare
// `clawdling open` would fail with "command not found". The server knows how it is installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PKG_ROOT, which } from './paths.js';

const SHELL_SAFE = /^[\w./\\~@%+=:,-]+$/;

/** A path as a person would type it: `~` for the home folder, single quotes only when needed. */
export function displayPath(p, homedir = os.homedir()) {
  const s = String(p);
  const t = s === homedir ? '~' : s.startsWith(homedir + path.sep) ? `~${s.slice(homedir.length)}` : s;
  if (SHELL_SAFE.test(t)) return t;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sameFile(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The command prefix that runs THIS install's CLI from a terminal: `clawdling` when that name on
 * PATH is this very install, else `node <path to bin/clawdling.js>` (the absolute node when `node`
 * on PATH is a different binary). Adds `--home <org>` when the org is not the default ~/clawdling,
 * so a terminal without CLAWDLING_HOME reaches the same org. Append the subcommand after it.
 */
export function cliInvocation({
  home,
  envPath = process.env.PATH || '',
  homedir = os.homedir(),
  cliJs = path.join(PKG_ROOT, 'bin', 'clawdling.js'),
  nodeBin = process.execPath,
} = {}) {
  let cmd;
  const onPath = which('clawdling', envPath);
  if (onPath && sameFile(onPath, cliJs)) cmd = 'clawdling';
  else {
    const nodeOnPath = which('node', envPath);
    const node = nodeOnPath && sameFile(nodeOnPath, nodeBin) ? 'node' : displayPath(nodeBin, homedir);
    cmd = `${node} ${displayPath(cliJs, homedir)}`;
  }
  if (home && path.resolve(home) !== path.join(homedir, 'clawdling')) cmd += ` --home ${displayPath(path.resolve(home), homedir)}`;
  return cmd;
}

/** How to install tmux on this platform, for error messages. */
export function tmuxInstallHint(platform = process.platform) {
  if (platform === 'darwin') return 'brew install tmux';
  if (platform === 'linux') return 'sudo apt install tmux (or your distribution\'s package manager)';
  return 'brew install tmux on macOS, sudo apt install tmux on Linux';
}
