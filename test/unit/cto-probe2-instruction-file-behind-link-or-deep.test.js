// Probe (round 2, Low): the round-1 fix for Low-6 added a launch check (server/cto.js launchSettings,
// `instructions`) that refuses a CLAUDE.md or CLAUDE.local.md anywhere in the seat's folder other
// than its own CLAUDE.md. docs/SECURITY.md now says a start is refused "when there is any instruction
// file besides its own CLAUDE.md (a CLAUDE.local.md, or a CLAUDE.md further down)". Two gaps:
//   - the walk skips every link to a folder (`!e.isSymbolicLink()`), and only the seat's folder,
//     reviews/ and .claude/ are refused as links, so <cto>/notes -> <elsewhere> with a CLAUDE.md
//     inside starts fine (Claude Code loads a nested CLAUDE.md when the seat reads under notes/, and
//     the seat's `Read(<cto>/**)` allow rule covers that path);
//   - the walk stops at depth 4, so <cto>/memory/a/b/c/d/CLAUDE.md is never looked at.
// Only the owner, a command the owner approved, or an agent whose shell runs unprompted can put
// these there, so this is Low; but the check does not do what the doc says it does.
//
// Fails on 10aba82 (both starts go ahead); passes once a linked folder anywhere in the seat's folder
// is refused (or followed and checked), and the walk has no depth gap (or refuses folders deeper than
// it looks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cto } from '../../server/cto.js';

// A folder path Claude Code's file rules can express (no underscores, as macOS temp dirs often have).
const root = /^\/[A-Za-z0-9._/ -]+$/.test(os.tmpdir()) ? os.tmpdir() : '/tmp';

function seat() {
  const home = fs.mkdtempSync(path.join(root, 'clawdling-probe-'));
  const dir = path.join(home, 'cto');
  const rt = path.join(home, '.clawdling');
  for (const d of [path.join(dir, 'reviews'), path.join(dir, '.claude'), rt]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# The CTO\n');
  const cto = new Cto({ paths: { rt, home }, org: { cto: () => ({ id: 'cto', dir }), refreshCtoSettings: () => false }, sessions: {}, reports: {} });
  const start = () => cto.launchSettings({ sid: 'x' }, { dir }, { nodePath: '/usr/local/bin/node', hookScript: '/opt/clawdling/bin/clawdling-hook.js', stopFailure: false });
  return { home, dir, start };
}

test('control: a CLAUDE.local.md in the seat folder is refused', () => {
  const s = seat();
  try {
    fs.writeFileSync(path.join(s.dir, 'CLAUDE.local.md'), 'extra rules\n');
    assert.throws(s.start, (err) => /CLAUDE\.local\.md/.test(String(err && err.message)));
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('a CLAUDE.md behind a linked folder in the seat folder is refused', () => {
  const s = seat();
  try {
    const elsewhere = path.join(s.home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'CLAUDE.md'), 'extra rules\n');
    fs.symlinkSync(elsewhere, path.join(s.dir, 'notes'));
    assert.throws(s.start, (err) => /notes/.test(String(err && err.message)));
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('a CLAUDE.md five folders down in the seat folder is refused', () => {
  const s = seat();
  try {
    const deep = path.join(s.dir, 'memory', 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'CLAUDE.md'), 'extra rules\n');
    assert.throws(s.start, (err) => /memory/.test(String(err && err.message)));
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});
