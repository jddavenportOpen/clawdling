// Cross-platform plumbing, with Windows tested through stubs on any OS: finding claude like
// `where` does, launching an .exe / npm .cmd shim / other .cmd, quoting for Windows command lines
// and cmd.exe, per-OS install hints, Windows hook settings and shims, and backend selection.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { backendFixes, chooseBackend, parseTmuxVersion, tmuxRecent } from '../../server/backend.js';
import { donnaAllowedTools } from '../../server/channels/donna.js';
import { buildHooksSettings, cliAllow } from '../../server/hooks.js';
import { cliShims } from '../../server/index.js';
import {
  claudeInstallCommand,
  commandFor,
  envGet,
  escapeCmdArg,
  findExecutable,
  installCommand,
  normalizePathKey,
  packageManager,
  parseCmdShim,
  parseWinCommandLine,
  prependPath,
  quoteWinArg,
} from '../../server/platform.js';
import { IS_WIN, rmrf, tempHome } from '../helpers.mjs';

const W = path.win32;
const files = (list) => {
  const set = new Set(list.map((f) => f.toLowerCase()));
  return (p) => set.has(String(p).toLowerCase());
};

// The shims npm (cmd-shim) writes for `npm i -g @anthropic-ai/claude-code`: the current package
// links a native claude.exe; older ones ran cli.js with node.
const NPM_SHIM_EXE = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', '',
].join('\r\n');
const NPM_SHIM_JS = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', '',
].join('\r\n');

const NASTY = ['plain', 'two words', '"quoted whole"', 'say "hi"', 'trailing\\', 'tr ail\\\\', 'a\\"b', '', 'tab\there', 'new\nline', 'é中🚀', '%PATH% & | < > ^ ! ( ) ;', "it's"];

test('findExecutable on Windows: PATH order, then PATHEXT order (where), never an extensionless file', () => {
  const env = { Path: 'C:\\Users\\Sam\\.local\\bin;"C:\\Program Files\\nodejs";C:\\Users\\Sam\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const isFile = files([
    'C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude', // the sh shim npm writes for Git Bash
    'C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Users\\Sam\\.local\\bin\\claude.exe',
    'C:\\Program Files\\nodejs\\node.exe',
  ]);
  const find = (cmd, extra = {}) => findExecutable(cmd, { env, platform: 'win32', isFile, cwd: 'C:\\org', ...extra });
  assert.equal(find('claude'), 'C:\\Users\\Sam\\.local\\bin\\claude.exe', 'the native install comes first on PATH');
  assert.equal(find('claude', { env: { ...env, Path: 'C:\\Users\\Sam\\AppData\\Roaming\\npm' } }), 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd', 'not the extensionless sh shim');
  assert.equal(find('node'), 'C:\\Program Files\\nodejs\\node.exe', 'a quoted PATH entry');
  assert.equal(find('C:\\Users\\Sam\\.local\\bin\\claude.exe'), 'C:\\Users\\Sam\\.local\\bin\\claude.exe');
  assert.equal(find('C:\\Users\\Sam\\.local\\bin\\claude'), 'C:\\Users\\Sam\\.local\\bin\\claude.exe', 'explicit path, PATHEXT added');
  assert.equal(find('tmux'), null);
  assert.equal(find(''), null);
});

test('PATH under any case on Windows: envGet, normalizePathKey, prependPath', () => {
  const env = { Path: 'C:\\a;C:\\b', Other: '1' };
  assert.equal(envGet(env, 'PATH', 'win32'), 'C:\\a;C:\\b');
  assert.equal(envGet(env, 'PATH', 'linux'), undefined, 'case-sensitive elsewhere');
  assert.deepEqual(normalizePathKey(env, 'win32'), { PATH: 'C:\\a;C:\\b', Other: '1' });
  assert.deepEqual(prependPath(env, 'C:\\org\\.clawdling\\bin', 'win32'), { PATH: 'C:\\org\\.clawdling\\bin;C:\\a;C:\\b', Other: '1' });
  assert.deepEqual(prependPath({ PATH: '/usr/bin' }, '/org/.clawdling/bin', 'darwin'), { PATH: '/org/.clawdling/bin:/usr/bin' });
});

test('quoteWinArg round-trips every nasty string through the MSVC command-line rules', () => {
  for (const s of NASTY) assert.deepEqual(parseWinCommandLine(quoteWinArg(s)), [s], JSON.stringify(s));
  assert.deepEqual(parseWinCommandLine(NASTY.map((s) => quoteWinArg(s)).join(' ')), NASTY);
  assert.equal(quoteWinArg('simple'), 'simple');
  assert.equal(quoteWinArg(''), '""');
});

test('parseCmdShim: npm shims for a native exe and for a node script; anything else is not a shim', () => {
  const shim = 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd';
  const exe = 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const js = 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  assert.deepEqual(parseCmdShim(NPM_SHIM_EXE, shim, { isFile: files([exe]) }), { exe });
  assert.deepEqual(parseCmdShim(NPM_SHIM_JS, shim, { isFile: files([js]) }), { js, node: null });
  assert.deepEqual(parseCmdShim(NPM_SHIM_JS, shim, { isFile: files([js, 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\node.exe']) }), { js, node: 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\node.exe' });
  assert.equal(parseCmdShim(NPM_SHIM_EXE, shim, { isFile: files([]) }), null, 'a shim whose target is missing');
  assert.equal(parseCmdShim('@echo off\r\nC:\\real\\claude.exe %*\r\n', shim, { isFile: () => true }), null);
  // pnpm / older npm style: "%~dp0\..\pkg\x.exe" %*
  assert.deepEqual(parseCmdShim('@"%~dp0\\..\\tools\\claude.exe" %*\r\n', 'C:\\pnpm\\bin\\claude.cmd', { isFile: files(['C:\\pnpm\\tools\\claude.exe']) }), { exe: 'C:\\pnpm\\tools\\claude.exe' });
});

test('commandFor: how each kind of claude is launched on Windows, and as-is elsewhere', () => {
  const args = ['--session-id', 'abc', '--', 'say "hi"\nthen 100% done'];
  assert.deepEqual(commandFor('/usr/local/bin/claude', args, { platform: 'darwin' }), { file: '/usr/local/bin/claude', args, verbatim: false, kind: 'exec' });
  const exe = commandFor('C:\\Users\\Sam\\.local\\bin\\claude.exe', args, { platform: 'win32' });
  assert.equal(exe.kind, 'exe');
  assert.deepEqual(parseWinCommandLine(exe.commandLine), args);
  const mjs = commandFor('C:\\repo\\test\\fake-claude.mjs', args, { platform: 'win32', nodePath: 'C:\\node\\node.exe' });
  assert.deepEqual([mjs.kind, mjs.file, mjs.args[0]], ['node', 'C:\\node\\node.exe', 'C:\\repo\\test\\fake-claude.mjs']);
  const shimExe = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const viaShim = commandFor('C:\\npm\\claude.cmd', args, { platform: 'win32', isFile: files([shimExe]), readFile: () => NPM_SHIM_EXE });
  assert.deepEqual([viaShim.kind, viaShim.file, viaShim.verbatim], ['shim-exe', shimExe, false], 'the npm shim is bypassed: no cmd.exe, newlines survive');
  assert.deepEqual(viaShim.args, args);
  const shimJs = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const viaJs = commandFor('C:\\npm\\claude.cmd', args, { platform: 'win32', isFile: files([shimJs]), readFile: () => NPM_SHIM_JS, nodePath: 'C:\\node\\node.exe' });
  assert.deepEqual([viaJs.kind, viaJs.file, viaJs.args[0]], ['shim-node', 'C:\\node\\node.exe', shimJs]);
  const other = commandFor('C:\\Tools\\My Claude\\claude.cmd', args, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, readFile: () => '@echo off\r\nC:\\x\\y.exe %*\r\n' });
  assert.deepEqual([other.kind, other.file, other.verbatim], ['cmd', 'C:\\Windows\\system32\\cmd.exe', true]);
  assert.deepEqual(other.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(other.args[3].startsWith('"C:\\Tools\\My^ Claude\\claude.cmd '), other.args[3]);
  assert.ok(!/[\r\n]/.test(other.args[3]), 'cmd.exe cannot carry a newline: it becomes a space');
  assert.ok(other.args[3].includes('^^^%'), 'percent signs are escaped twice (the .cmd re-parses %*)');
});

test('escapeCmdArg: every cmd.exe metacharacter is caret-escaped, quotes included', () => {
  assert.equal(escapeCmdArg('a b', false), '^"a^ b^"');
  assert.equal(escapeCmdArg('100%', false), '^"100^%^"');
  assert.equal(escapeCmdArg('x&y', true), '^^^"x^^^&y^^^"');
  assert.ok(!/[\r\n]/.test(escapeCmdArg('two\nlines')));
});

test('per-OS install hints: package manager, tmux / node / build tools, Claude Code', () => {
  const has = (list) => (b) => list.includes(b);
  assert.equal(packageManager({ platform: 'darwin', has: has(['brew']) }), 'brew');
  assert.equal(packageManager({ platform: 'darwin', has: has([]) }), null);
  assert.equal(packageManager({ platform: 'win32', has: has(['winget']) }), 'winget');
  assert.equal(packageManager({ platform: 'linux', has: has(['dnf']) }), 'dnf');
  assert.equal(packageManager({ platform: 'linux', has: has(['apt-get', 'dnf']) }), 'apt');
  assert.equal(packageManager({ platform: 'linux', has: has(['pacman']) }), 'pacman');
  assert.equal(installCommand('tmux', 'brew'), 'brew install tmux');
  assert.equal(installCommand('tmux', 'apt'), 'sudo apt install -y tmux');
  assert.equal(installCommand('tmux', 'dnf'), 'sudo dnf install -y tmux');
  assert.equal(installCommand('tmux', 'pacman'), 'sudo pacman -S --noconfirm tmux');
  assert.equal(installCommand('node', 'winget'), 'winget install OpenJS.NodeJS.LTS');
  assert.equal(installCommand('tmux', 'winget'), null);
  assert.match(installCommand('buildTools', 'apt'), /build-essential/);
  assert.match(claudeInstallCommand('win32'), /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.match(claudeInstallCommand('linux'), /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(claudeInstallCommand('darwin', 'brew'), /brew install --cask claude-code/);
});

test('backend choice: CLAWDLING_BACKEND wins, then tmux 3.2+ off Windows, then node-pty, else the fix', () => {
  const tmuxOk = { found: true, ok: true, version: 'tmux 3.6a' };
  const tmuxOld = { found: true, ok: false, version: 'tmux 3.1c', error: 'tmux 3.1c is older than 3.2' };
  const noTmux = { found: false, ok: false, error: 'tmux is not installed' };
  const ptyOk = { ok: true, version: '1.1.0' };
  const noPty = { ok: false, error: 'Cannot find module node-pty' };
  const fixes = backendFixes({ platform: 'linux', pm: 'apt', pkgRoot: '/app' });
  const pick = (o) => chooseBackend({ fixes, ...o });
  assert.deepEqual(pick({ platform: 'linux', tmux: tmuxOk, pty: ptyOk }), { kind: 'tmux', reason: 'tmux 3.6a is installed' });
  assert.equal(pick({ platform: 'darwin', tmux: noTmux, pty: ptyOk }).kind, 'pty', 'a Mac without Homebrew');
  assert.equal(pick({ platform: 'darwin', tmux: tmuxOld, pty: ptyOk }).reason, 'tmux 3.1c is older than 3.2');
  assert.deepEqual(pick({ platform: 'win32', tmux: tmuxOk, pty: ptyOk }), { kind: 'pty', reason: 'Windows' }, 'never tmux on Windows');
  assert.deepEqual(pick({ platform: 'linux', tmux: tmuxOk, pty: ptyOk, requested: 'pty' }), { kind: 'pty', reason: 'CLAWDLING_BACKEND=pty' });
  assert.deepEqual(pick({ platform: 'linux', tmux: tmuxOk, pty: ptyOk, requested: 'TMUX' }), { kind: 'tmux', reason: 'CLAWDLING_BACKEND=tmux' });
  assert.match(pick({ platform: 'linux', tmux: noTmux, pty: ptyOk, requested: 'tmux' }).fix, /sudo apt install -y tmux/);
  assert.match(pick({ platform: 'win32', tmux: noTmux, pty: ptyOk, requested: 'tmux' }).error, /not available on Windows/);
  assert.match(pick({ platform: 'linux', tmux: tmuxOk, pty: noPty, requested: 'pty' }).fix, /build-essential python3 && cd "\/app" && npm install/);
  assert.match(pick({ platform: 'linux', tmux: tmuxOk, pty: ptyOk, requested: 'screen' }).error, /must be "tmux" or "pty"/);
  const none = pick({ platform: 'linux', tmux: noTmux, pty: noPty });
  assert.match(none.error, /no way to run sessions/);
  assert.equal(none.fix, 'sudo apt install -y tmux', 'the one-line fix for this OS');
  assert.match(chooseBackend({ platform: 'win32', tmux: noTmux, pty: noPty, fixes: backendFixes({ platform: 'win32', pkgRoot: 'C:\\app' }) }).fix, /cd "C:\\app"; npm install/);
  assert.match(chooseBackend({ platform: 'darwin', tmux: noTmux, pty: noPty, fixes: backendFixes({ platform: 'darwin', pm: null, pkgRoot: '/app' }) }).fix, /npm install .*brew\.sh/);
  assert.deepEqual(parseTmuxVersion('tmux 3.6a'), { major: 3, minor: 6 });
  assert.deepEqual(parseTmuxVersion('tmux next-3.7'), { major: 3, minor: 7 });
  assert.equal(tmuxRecent('tmux 3.2'), true);
  assert.equal(tmuxRecent('tmux 3.1c'), false);
  assert.equal(tmuxRecent('tmux 2.9'), false);
  assert.equal(tmuxRecent(''), false);
});

test('Windows hooks: exec form (no shell parses a path), forward slashes; PowerShell allow rules', () => {
  const s = buildHooksSettings({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', hookScript: 'C:\\Users\\Sam O\'Neil\\app\\bin\\clawdling-hook.js', platform: 'win32' });
  const h = s.hooks.Stop[0].hooks[0];
  assert.deepEqual(h, { type: 'command', command: 'C:/Program Files/nodejs/node.exe', args: ["C:/Users/Sam O'Neil/app/bin/clawdling-hook.js", 'Stop'], timeout: 5 });
  assert.ok(s.permissions.allow.includes('PowerShell(clawdling spawn *)'));
  assert.ok(s.permissions.allow.includes('Bash(clawdling spawn *)'));
  assert.deepEqual(cliAllow('linux').filter((r) => r.startsWith('PowerShell')), [], 'unchanged off Windows');
  const unix = buildHooksSettings({ nodePath: '/usr/bin/node', hookScript: '/app/bin/clawdling-hook.js', platform: 'linux' });
  assert.equal(unix.hooks.Stop[0].hooks[0].command, "'/usr/bin/node' '/app/bin/clawdling-hook.js' Stop");
  const tools = donnaAllowedTools('C:\\Users\\Sam\\clawdling', 'win32');
  assert.ok(tools.includes('PowerShell(clawdling send *)'));
  assert.ok(tools.includes('Read(//c/Users/Sam/clawdling/**)'), 'Windows paths match in POSIX form');
});

test('Windows shims: sh for Git Bash, .ps1 for PowerShell, .cmd for the rest', () => {
  const shims = cliShims({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: "C:\\Users\\O'Neil\\app\\bin\\clawdling.js", platform: 'win32' });
  assert.deepEqual(Object.keys(shims).sort(), ['clawdling', 'clawdling.cmd', 'clawdling.ps1']);
  assert.match(shims.clawdling, /^#!\/bin\/sh\n/);
  assert.ok(shims.clawdling.includes("exec 'C:/Program Files/nodejs/node.exe' 'C:/Users/O'\\''Neil/app/bin/clawdling.js' \"$@\""));
  assert.ok(shims['clawdling.ps1'].includes("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\O''Neil\\app\\bin\\clawdling.js' @args"));
  assert.ok(shims['clawdling.cmd'].includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\O\'Neil\\app\\bin\\clawdling.js" %*'));
  assert.deepEqual(Object.keys(cliShims({ nodePath: '/n', cliPath: '/c', platform: 'linux' })), ['clawdling']);
});

// ------------------------------------------------------------------------------ real Windows only

test('Windows: quoted arguments reach a real program intact (no shell)', { skip: !IS_WIN && 'Windows only' }, () => {
  // The exact command line node-pty gets on Windows, handed to a real program (node) to parse.
  const cmd = commandFor(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...NASTY], { platform: 'win32' });
  const r = spawnSync(process.execPath, [cmd.commandLine], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), NASTY);
});

test('Windows: a .cmd that is not an npm shim runs through cmd.exe with every argument intact', { skip: !IS_WIN && 'Windows only' }, () => {
  const dir = tempHome('cl-cmd-');
  try {
    const dump = path.join(dir, 'dump.js');
    fs.writeFileSync(dump, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const bat = path.join(dir, 'my claude.cmd');
    fs.writeFileSync(bat, `@echo off\r\n"${process.execPath}" "${dump}" %*\r\n`);
    const args = NASTY.filter((s) => s && !s.includes('\n') && !s.includes('!'));
    const cmd = commandFor(bat, args, { platform: 'win32' });
    assert.equal(cmd.kind, 'cmd');
    const r = spawnSync(cmd.file, cmd.args, { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args);
  } finally {
    rmrf(dir);
  }
});
