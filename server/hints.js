// How a person at this computer should type Clawdling commands. The cockpit prints commands
// (open the cockpit, connect Telegram, restart with --host, attach to a session), and a by-hand
// install has no `clawdling` on PATH (README: `node bin/clawdling.js ...`; `npm link` is opt-in),
// so a bare `clawdling open` would fail with "command not found". The server knows how it is
// installed, and on which OS, so it spells the command for this computer's shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PKG_ROOT, which } from './paths.js';
import { parseCmdShim } from './platform.js';

const SHELL_SAFE = /^[\w./~@%+=:,-]+$/;
const WIN_SAFE = /^[\w.\\/:@+=,-]+$/;

/**
 * A path as a person would type it in this OS's shell.
 * macOS / Linux: `~` for the home folder, single quotes only when needed.
 * Windows: the full path (neither cmd.exe nor PowerShell expands `~` for node), double quotes
 * only when needed (both shells take them).
 */
export function displayPath(p, homedir = os.homedir(), platform = process.platform) {
  const s = String(p);
  if (platform === 'win32') return WIN_SAFE.test(s) ? s : `"${s}"`;
  const t = s === homedir ? '~' : s.startsWith(homedir + '/') ? `~${s.slice(homedir.length)}` : s;
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

/** Is `found` (a PATH hit for `clawdling`) this very install? Follows npm's .cmd shim on Windows. */
function isThisInstall(found, cliJs, platform) {
  if (sameFile(found, cliJs)) return true;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(found)) return false;
  try {
    const shim = parseCmdShim(fs.readFileSync(found, 'utf8'), found);
    return !!shim?.js && sameFile(shim.js, cliJs);
  } catch {
    return false;
  }
}

/**
 * The two halves of the command that runs THIS install's CLI from a terminal:
 * `cli` is `clawdling` when that name on PATH is this very install, else `node <bin/clawdling.js>`
 * (the absolute node when `node` on PATH is a different binary); `homeFlag` is ` --home <org>`
 * when the org is not the default ~/clawdling, so a terminal without CLAWDLING_HOME reaches the
 * same org. Subcommands go between them: `${cli} attach <sid>${homeFlag}`.
 */
export function cliParts({
  home,
  envPath = process.env.PATH || '',
  homedir = os.homedir(),
  cliJs = path.join(PKG_ROOT, 'bin', 'clawdling.js'),
  nodeBin = process.execPath,
  platform = process.platform,
} = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  let cli;
  const onPath = which('clawdling', envPath, { platform });
  if (onPath && isThisInstall(onPath, cliJs, platform)) cli = 'clawdling';
  else {
    const nodeOnPath = which('node', envPath, { platform });
    const node = nodeOnPath && sameFile(nodeOnPath, nodeBin) ? 'node' : displayPath(nodeBin, homedir, platform);
    cli = `${node} ${displayPath(cliJs, homedir, platform)}`;
  }
  const homeFlag = home && P.resolve(home) !== P.join(homedir, 'clawdling') ? ` --home ${displayPath(P.resolve(home), homedir, platform)}` : '';
  return { cli, homeFlag };
}

/** The command prefix that runs THIS install's CLI, --home included; append the subcommand. */
export function cliInvocation(opts = {}) {
  const { cli, homeFlag } = cliParts(opts);
  return cli + homeFlag;
}

/** How to install tmux on this platform, for error messages. */
export function tmuxInstallHint(platform = process.platform) {
  if (platform === 'darwin') return 'brew install tmux';
  if (platform === 'linux') return 'sudo apt install tmux (or your distribution\'s package manager)';
  return 'brew install tmux on macOS, sudo apt install tmux on Linux';
}
