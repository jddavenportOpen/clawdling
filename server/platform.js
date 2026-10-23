// Cross-platform plumbing: finding executables (PATH x PATHEXT on Windows, like `where`), how to
// launch one (a real .exe, an npm .cmd shim, or cmd.exe /d /s /c as a last resort), Windows
// command-line quoting, and the per-OS install commands `clawdling doctor` prints.
//
// Every function takes the platform and environment as arguments, so the Windows paths are unit
// tested on any OS (path.win32 does the joining).
import fs from 'node:fs';
import path from 'node:path';

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function defaultIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read an environment variable by name, case-insensitively on Windows (Path, PATHEXT, ComSpec). */
export function envGet(env, name, platform = process.platform) {
  if (!env) return undefined;
  if (platform !== 'win32') return env[name];
  if (env[name] !== undefined) return env[name];
  const want = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) return env[k];
  return undefined;
}

/** A copy of env whose PATH is under the one key `PATH` (Windows spells it `Path`). */
export function normalizePathKey(env, platform = process.platform) {
  const out = { ...env };
  if (platform !== 'win32') return out;
  const value = envGet(env, 'PATH', platform);
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k];
  if (value !== undefined) out.PATH = value;
  return out;
}

/** env with `dir` put first on PATH, using the OS's separator. */
export function prependPath(env, dir, platform = process.platform) {
  const out = normalizePathKey(env, platform);
  const cur = envGet(env, 'PATH', platform) || (platform === 'win32' ? '' : '/usr/bin:/bin');
  out.PATH = cur ? `${dir}${platform === 'win32' ? ';' : ':'}${cur}` : dir;
  return out;
}

/** The executable extensions Windows tries, in order (PATHEXT). */
export function pathExts(env = process.env, platform = process.platform) {
  const raw = (platform === 'win32' && envGet(env, 'PATHEXT', platform)) || '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((e) => e.trim().toUpperCase())
    .filter((e) => e.startsWith('.'));
}

/**
 * Find an executable the way the OS shell would. On Windows that is `where`'s order: every PATH
 * directory in turn, and in each one the name with every PATHEXT extension (claude.exe before
 * claude.cmd); an extensionless file is never a match, because Windows cannot run it.
 * Returns an absolute path or null.
 */
export function findExecutable(cmd, { envPath, env = process.env, platform = process.platform, isFile = defaultIsFile, cwd = process.cwd() } = {}) {
  if (!cmd) return null;
  const p = pathFor(platform);
  const searchPath = envPath ?? envGet(env, 'PATH', platform) ?? '';
  if (platform !== 'win32') {
    const candidates = cmd.includes('/') ? [p.resolve(cwd, cmd)] : searchPath.split(':').filter(Boolean).map((d) => p.join(d, cmd));
    for (const c of candidates) {
      if (!isFile(c)) continue;
      try {
        fs.accessSync(c, fs.constants.X_OK);
        return c;
      } catch {
        // not executable: keep looking
      }
    }
    return null;
  }
  const exts = pathExts(env, platform).map((e) => e.toLowerCase()); // claude.exe, as `where` shows it
  const variants = (base) => {
    const ext = p.extname(base);
    return ext ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e);
  };
  const explicit = /[\\/]/.test(cmd) || /^[A-Za-z]:/.test(cmd);
  const dirs = explicit ? [''] : searchPath.split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    const base = explicit ? p.resolve(cwd, cmd) : p.join(dir, cmd);
    for (const c of variants(base)) if (isFile(c)) return c;
  }
  return null;
}

/** Quote one argument for a Windows command line (the MSVC / CommandLineToArgvW rules). */
export function quoteWinArg(arg, { always = false } = {}) {
  const s = String(arg);
  if (s && !always && !/[\s"]/.test(s)) return s;
  let out = '"';
  let bs = 0;
  for (const ch of s) {
    if (ch === '\\') {
      bs++;
      continue;
    }
    if (ch === '"') out += '\\'.repeat(bs * 2 + 1) + '"';
    else out += '\\'.repeat(bs) + ch;
    bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

/** Split a Windows command line the way the MSVC runtime does (for tests of quoteWinArg). */
export function parseWinCommandLine(line) {
  const args = [];
  let cur = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i] === '\\') {
        n++;
        i++;
      }
      if (line[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) {
          cur += '"';
          i++;
        }
      } else cur += '\\'.repeat(n);
      started = true;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      started = true;
      i++;
      continue;
    }
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (started) args.push(cur);
      cur = '';
      started = false;
      i++;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  if (started) args.push(cur);
  return args;
}

// cmd.exe metacharacters (cross-spawn's set, after https://qntm.org/cmd).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escape one argument for `cmd.exe /d /s /c "..."`: quote it for the program's own parser, then
 * caret-escape every cmd metacharacter, quotes included, so cmd.exe never sees a quoted region
 * and expands nothing (https://qntm.org/cmd). Twice when a .cmd file re-parses it through %*.
 */
export function escapeCmdArg(arg, doubleEscape = true) {
  // cmd.exe ends the command at a line break, so a newline cannot be passed through it.
  const a = quoteWinArg(String(arg).replace(/\r?\n|\r/g, ' '), { always: true }).replace(CMD_META, '^$1');
  return doubleEscape ? a.replace(CMD_META, '^$1') : a;
}

/**
 * The real program behind an npm-style .cmd shim (npm, nvm-windows and pnpm all write the target
 * as "%dp0%\<path>" or "%~dp0\<path>" right before %*). {exe} for a native target, {js, node} for
 * a script npm runs with node, or null when the file is not a shim we understand.
 */
export function parseCmdShim(text, shimPath, { isFile = defaultIsFile } = {}) {
  const src = String(text || '');
  const dir = path.win32.dirname(shimPath);
  const hits = [...src.matchAll(/"%~?dp0%?\\([^"%\r\n]+)"\s+%\*/gi)];
  if (!hits.length) return null;
  const target = path.win32.resolve(dir, hits[hits.length - 1][1]);
  if (!isFile(target)) return null;
  const ext = path.win32.extname(target).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { exe: target };
  const progs = [...src.matchAll(/SET\s+"_prog=([^"]+)"/gi)].map((m) => m[1].trim().toLowerCase());
  const nodeScript = ['.js', '.mjs', '.cjs'].includes(ext) || (progs.length && progs[progs.length - 1] === 'node');
  if (!nodeScript) return null;
  const local = path.win32.join(dir, 'node.exe');
  return { js: target, node: isFile(local) ? local : null };
}

/**
 * How to run `resolved args...` as a child process: {file, args, verbatim, kind, commandLine}.
 * - macOS / Linux: the file itself (a script with a shebang is fine).
 * - Windows: an .exe directly; a .js/.mjs with node; an npm .cmd shim as the program it wraps
 *   (so prompts with quotes, % or newlines reach claude intact); any other .cmd/.bat through
 *   `cmd.exe /d /s /c` with every argument escaped (newlines become spaces there).
 * `commandLine` is the Windows command line after the program (node-pty takes it pre-quoted).
 */
export function commandFor(resolved, args = [], { platform = process.platform, env = process.env, nodePath = process.execPath, isFile = defaultIsFile, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const list = args.map(String);
  if (platform !== 'win32') return { file: resolved, args: list, verbatim: false, kind: 'exec' };
  const winLine = (a) => a.map(quoteWinArg).join(' ');
  const ext = path.win32.extname(resolved).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const all = [resolved, ...list];
    return { file: nodePath, args: all, verbatim: false, kind: 'node', commandLine: winLine(all) };
  }
  if (ext === '.cmd' || ext === '.bat') {
    let shim = null;
    try {
      shim = parseCmdShim(readFile(resolved), resolved, { isFile });
    } catch {
      shim = null;
    }
    if (shim?.exe) return { file: shim.exe, args: list, verbatim: false, kind: 'shim-exe', via: resolved, commandLine: winLine(list) };
    if (shim?.js) {
      const all = [shim.js, ...list];
      return { file: shim.node || nodePath, args: all, verbatim: false, kind: 'shim-node', via: resolved, commandLine: winLine(all) };
    }
    const comspec = envGet(env, 'ComSpec', platform) || 'cmd.exe';
    const line = [path.win32.normalize(resolved).replace(CMD_META, '^$1'), ...list.map((a) => escapeCmdArg(a, true))].join(' ');
    const cmdArgs = ['/d', '/s', '/c', `"${line}"`];
    return { file: comspec, args: cmdArgs, verbatim: true, kind: 'cmd', via: resolved, commandLine: cmdArgs.join(' ') };
  }
  return { file: resolved, args: list, verbatim: false, kind: 'exe', commandLine: winLine(list) };
}

/** child_process options for a commandFor() result (no console window flashes on Windows). */
export function spawnOptions(spec, opts = {}) {
  return { ...opts, windowsHide: true, ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}) };
}

// ------------------------------------------------------------------------------- install hints

/** The package manager doctor should suggest: brew, winget, or the Linux one that is present. */
export function packageManager({ platform = process.platform, has }) {
  if (platform === 'darwin') return has('brew') ? 'brew' : null;
  if (platform === 'win32') return has('winget') ? 'winget' : null;
  for (const [bin, pm] of [['apt-get', 'apt'], ['dnf', 'dnf'], ['yum', 'yum'], ['pacman', 'pacman'], ['zypper', 'zypper'], ['apk', 'apk']]) {
    if (has(bin)) return pm;
  }
  return null;
}

const INSTALL = {
  tmux: {
    brew: 'brew install tmux',
    apt: 'sudo apt install -y tmux',
    dnf: 'sudo dnf install -y tmux',
    yum: 'sudo yum install -y tmux',
    pacman: 'sudo pacman -S --noconfirm tmux',
    zypper: 'sudo zypper install -y tmux',
    apk: 'sudo apk add tmux',
  },
  node: {
    brew: 'brew install node',
    winget: 'winget install OpenJS.NodeJS.LTS',
    apt: 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs',
    dnf: 'sudo dnf install -y nodejs',
    yum: 'sudo yum install -y nodejs',
    pacman: 'sudo pacman -S --noconfirm nodejs npm',
    zypper: 'sudo zypper install -y nodejs22',
    apk: 'sudo apk add nodejs npm',
  },
  buildTools: {
    apt: 'sudo apt install -y build-essential python3',
    dnf: 'sudo dnf install -y gcc-c++ make python3',
    yum: 'sudo yum install -y gcc-c++ make python3',
    pacman: 'sudo pacman -S --noconfirm base-devel python',
    zypper: 'sudo zypper install -y gcc-c++ make python3',
    apk: 'sudo apk add build-base python3',
  },
};

/** The one-line install command for `what` (tmux, node, buildTools) on this machine, or null. */
export function installCommand(what, pm) {
  return (pm && INSTALL[what]?.[pm]) || null;
}

/** Claude Code's own installer, per OS (from code.claude.com/docs/en/setup). */
export function claudeInstallCommand(platform = process.platform, pm = null) {
  if (platform === 'win32') return 'irm https://claude.ai/install.ps1 | iex   (PowerShell; or: winget install Anthropic.ClaudeCode)';
  if (platform === 'darwin' && pm === 'brew') return 'brew install --cask claude-code   (or: curl -fsSL https://claude.ai/install.sh | bash)';
  return 'curl -fsSL https://claude.ai/install.sh | bash';
}

/** Git Bash on Windows (Claude Code's Bash tool needs it; without it Claude uses PowerShell). */
export function findGitBash({ env = process.env, isFile = defaultIsFile } = {}) {
  const explicit = envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH', 'win32');
  if (explicit && isFile(explicit)) return explicit;
  const roots = [envGet(env, 'ProgramFiles', 'win32'), envGet(env, 'ProgramW6432', 'win32'), envGet(env, 'LOCALAPPDATA', 'win32') && path.win32.join(envGet(env, 'LOCALAPPDATA', 'win32'), 'Programs')].filter(Boolean);
  for (const root of roots) {
    const p = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (isFile(p)) return p;
  }
  const git = findExecutable('git', { env, platform: 'win32', isFile });
  if (git) {
    // ...\Git\cmd\git.exe -> ...\Git\bin\bash.exe
    const p = path.win32.join(path.win32.dirname(path.win32.dirname(git)), 'bin', 'bash.exe');
    if (isFile(p)) return p;
  }
  return null;
}

/** A path for a generated config file or hook command: forward slashes on Windows. */
export function portablePath(p, platform = process.platform) {
  return platform === 'win32' ? String(p).replace(/\\/g, '/') : String(p);
}
