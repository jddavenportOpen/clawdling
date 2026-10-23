// server/hints.js: how the cockpit and the CLI spell commands for the person at this computer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliInvocation, cliParts, displayPath, stopMessage, tmuxInstallHint } from '../../server/hints.js';

const POSIX = { skip: process.platform === 'win32' && 'symlinks and extensionless executables are POSIX' };

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-hints-')));
  const homedir = path.join(root, 'home', 'ada');
  const app = path.join(homedir, 'clawdling-app');
  const cliJs = path.join(app, 'bin', 'clawdling.js');
  fs.mkdirSync(path.dirname(cliJs), { recursive: true });
  fs.writeFileSync(cliJs, '#!/usr/bin/env node\n', { mode: 0o755 });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const nodeBin = path.join(root, 'node-real');
  fs.writeFileSync(nodeBin, '#!/bin/sh\n', { mode: 0o755 });
  return { root, homedir, app, cliJs, bin, nodeBin, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('by-hand install (no clawdling on PATH): node + the script path, home as ~', POSIX, () => {
  const b = sandbox();
  try {
    fs.symlinkSync(b.nodeBin, path.join(b.bin, 'node'));
    const got = cliInvocation({ home: path.join(b.homedir, 'clawdling'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin });
    assert.equal(got, 'node ~/clawdling-app/bin/clawdling.js');
  } finally {
    b.done();
  }
});

test('`npm link` or a global install: plain `clawdling`, but only when it is THIS install', POSIX, () => {
  const b = sandbox();
  try {
    fs.symlinkSync(b.nodeBin, path.join(b.bin, 'node'));
    fs.symlinkSync(b.cliJs, path.join(b.bin, 'clawdling'));
    assert.equal(cliInvocation({ home: path.join(b.homedir, 'clawdling'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin }), 'clawdling');
    // A different clawdling on PATH (an old global install) is not this one: spell out this install.
    const other = path.join(b.root, 'other.js');
    fs.writeFileSync(other, '', { mode: 0o755 });
    fs.unlinkSync(path.join(b.bin, 'clawdling'));
    fs.symlinkSync(other, path.join(b.bin, 'clawdling'));
    assert.equal(cliInvocation({ home: path.join(b.homedir, 'clawdling'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin }), 'node ~/clawdling-app/bin/clawdling.js');
  } finally {
    b.done();
  }
});

test('an org away from ~/clawdling gets --home; node not on PATH is written in full', POSIX, () => {
  const b = sandbox();
  try {
    const got = cliInvocation({ home: path.join(b.homedir, 'orgs', 'acme'), envPath: '', homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin });
    assert.equal(got, `${b.nodeBin} ~/clawdling-app/bin/clawdling.js --home ~/orgs/acme`);
  } finally {
    b.done();
  }
});

test('displayPath quotes only when a shell needs it', () => {
  assert.equal(displayPath('/Users/ada/x', '/Users/ada', 'darwin'), '~/x');
  assert.equal(displayPath('/Users/ada', '/Users/ada', 'darwin'), '~');
  assert.equal(displayPath('/Users/adam/x', '/Users/ada', 'darwin'), '/Users/adam/x');
  assert.equal(displayPath('/opt/app/bin/clawdling.js', '/Users/ada', 'linux'), '/opt/app/bin/clawdling.js');
  assert.equal(displayPath('/Users/ada/My Org', '/Users/ada', 'darwin'), "'/Users/ada/My Org'");
  assert.equal(displayPath("/tmp/it's", '/Users/ada', 'darwin'), `'/tmp/it'\\''s'`);
});

test('displayPath on Windows: full paths (no ~ for node), double quotes when needed', () => {
  const home = 'C:\\Users\\Wes';
  assert.equal(displayPath('C:\\Users\\Wes\\clawdling-app\\bin\\clawdling.js', home, 'win32'), 'C:\\Users\\Wes\\clawdling-app\\bin\\clawdling.js');
  assert.equal(displayPath('C:\\Program Files\\nodejs\\node.exe', home, 'win32'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(displayPath('C:\\Users\\Wes Smith\\org', 'C:\\Users\\Wes Smith', 'win32'), '"C:\\Users\\Wes Smith\\org"');
});

test('cliParts splits the command and --home (the attach hint puts the subcommand between them)', POSIX, () => {
  const b = sandbox();
  try {
    fs.symlinkSync(b.nodeBin, path.join(b.bin, 'node'));
    const parts = cliParts({ home: path.join(b.homedir, 'orgs', 'acme'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin });
    assert.deepEqual(parts, { cli: 'node ~/clawdling-app/bin/clawdling.js', homeFlag: ' --home ~/orgs/acme' });
    assert.equal(cliParts({ home: path.join(b.homedir, 'clawdling'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin }).homeFlag, '');
  } finally {
    b.done();
  }
});

test('Windows: an npm .cmd shim on PATH that runs THIS install means plain `clawdling`', { skip: process.platform !== 'win32' && 'needs Windows paths' }, () => {
  const b = sandbox();
  try {
    const shim = path.join(b.bin, 'clawdling.cmd');
    const rel = path.relative(b.bin, b.cliJs);
    fs.writeFileSync(shim, `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\${rel}" %*\r\n`);
    assert.equal(cliInvocation({ home: path.join(b.homedir, 'clawdling'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin }), 'clawdling');
    // A shim for some other install is not this one.
    fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\other\\clawdling.js" %*\r\n');
    assert.notEqual(cliInvocation({ home: path.join(b.homedir, 'clawdling'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin }), 'clawdling');
  } finally {
    b.done();
  }
});

test('tmux install hint follows the platform (P2-22)', () => {
  assert.equal(tmuxInstallHint('darwin'), 'brew install tmux');
  assert.match(tmuxInstallHint('linux'), /^sudo apt install tmux/);
  assert.doesNotMatch(tmuxInstallHint('linux'), /brew/);
  assert.match(tmuxInstallHint('win32'), /brew install tmux.*sudo apt install tmux/);
});

test('`clawdling stop` says what happened to the sessions, in the right number (D6)', () => {
  const start = 'node ~/.clawdling-app/bin/clawdling.js start';
  // No live session: nothing about sessions at all (it used to say they "keep running in tmux").
  assert.equal(stopMessage({ live: 0, keepsRunning: true, start }), 'Stopped the cockpit.');
  assert.equal(stopMessage({ live: 0, keepsRunning: false, start }), 'Stopped the cockpit.');
  // Built-in terminal: the sessions ended with the cockpit.
  assert.equal(stopMessage({ live: 1, keepsRunning: false, start }), `Stopped the cockpit. Its session ended; resume it from the cockpit after \`${start}\`.`);
  assert.equal(stopMessage({ live: 3, keepsRunning: false, start }), `Stopped the cockpit. Its 3 sessions ended; resume them from the cockpit after \`${start}\`.`);
  // tmux: they keep running.
  assert.equal(stopMessage({ live: 1, keepsRunning: true, start }), `Stopped the cockpit. Your session keeps running in tmux; \`${start}\` reconnects to it.`);
  assert.equal(stopMessage({ live: 2, keepsRunning: undefined, start }), `Stopped the cockpit. Your 2 sessions keep running in tmux; \`${start}\` reconnects to them.`);
});
