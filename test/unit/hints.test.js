// server/hints.js: how the cockpit and the CLI spell commands for the person at this computer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliInvocation, displayPath, tmuxInstallHint } from '../../server/hints.js';

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

test('by-hand install (no clawdling on PATH): node + the script path, home as ~', () => {
  const b = sandbox();
  try {
    fs.symlinkSync(b.nodeBin, path.join(b.bin, 'node'));
    const got = cliInvocation({ home: path.join(b.homedir, 'clawdling'), envPath: b.bin, homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin });
    assert.equal(got, 'node ~/clawdling-app/bin/clawdling.js');
  } finally {
    b.done();
  }
});

test('`npm link` or a global install: plain `clawdling`, but only when it is THIS install', () => {
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

test('an org away from ~/clawdling gets --home; node not on PATH is written in full', () => {
  const b = sandbox();
  try {
    const got = cliInvocation({ home: path.join(b.homedir, 'orgs', 'acme'), envPath: '', homedir: b.homedir, cliJs: b.cliJs, nodeBin: b.nodeBin });
    assert.equal(got, `${b.nodeBin} ~/clawdling-app/bin/clawdling.js --home ~/orgs/acme`);
  } finally {
    b.done();
  }
});

test('displayPath quotes only when a shell needs it', () => {
  assert.equal(displayPath('/Users/ada/x', '/Users/ada'), '~/x');
  assert.equal(displayPath('/Users/ada', '/Users/ada'), '~');
  assert.equal(displayPath('/opt/app/bin/clawdling.js', '/Users/ada'), '/opt/app/bin/clawdling.js');
  assert.equal(displayPath('/Users/ada/My Org', '/Users/ada'), "'/Users/ada/My Org'");
  assert.equal(displayPath("/tmp/it's", '/Users/ada'), `'/tmp/it'\\''s'`);
});

test('tmux install hint follows the platform (P2-22)', () => {
  assert.equal(tmuxInstallHint('darwin'), 'brew install tmux');
  assert.match(tmuxInstallHint('linux'), /^sudo apt install tmux/);
  assert.doesNotMatch(tmuxInstallHint('linux'), /brew/);
  assert.match(tmuxInstallHint('win32'), /brew install tmux.*sudo apt install tmux/);
});
