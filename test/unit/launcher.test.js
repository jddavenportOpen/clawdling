// User text never reaches a shell or tmux's command parser unquoted: prove it with /bin/sh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildClaudeArgs, buildLauncherScript, buildSnapshot, safePositional } from '../../server/sessions.js';
import { ModeTracker } from '../../server/termfilter.js';
import { shq } from '../../server/util.js';
import { rmrf, tempHome } from '../helpers.mjs';

const NASTY = [
  "it's",
  '"double" quotes',
  '$(touch /tmp/clawdling-pwned)',
  '`touch /tmp/clawdling-pwned`',
  '${HOME} $PATH',
  'semi; colon;',
  'back\\slash \\',
  'new\nline\n',
  'tab\there',
  'é中\u{1F680} unicode',
  '-p --dangerously-skip-permissions',
  "'; rm -rf ~; echo '",
  '!history !! \u0007',
  '',
];

// The /bin/sh launcher is the tmux backend's (macOS / Linux); Windows never runs a shell script.
const POSIX = process.platform === 'win32' ? 'POSIX shell only' : false;

test('shq round-trips every nasty string through /bin/sh', { skip: POSIX }, () => {
  for (const s of NASTY) {
    const out = spawnSync('/bin/sh', ['-c', `printf '%s' ${shq(s)}`], { encoding: 'utf8' }).stdout;
    assert.equal(out, s, JSON.stringify(s));
  }
  assert.throws(() => shq('nul\0byte'), /NUL/);
});

test('the launcher script delivers argv and env byte-for-byte and never evaluates them', { skip: POSIX }, () => {
  const dir = tempHome('cl-launch-');
  try {
    const dump = path.join(dir, 'dump.mjs');
    fs.writeFileSync(dump, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), env: process.env.CLAWDLING_TEST_VALUE}))\n', { mode: 0o755 });
    const cwd = path.join(dir, "it's a $(dir) `x`");
    fs.mkdirSync(cwd);
    const args = NASTY.filter(Boolean);
    const script = buildLauncherScript({ cwd, env: { CLAWDLING_TEST_VALUE: NASTY.join('|'), PATH: process.env.PATH }, argv: [dump, ...args], comment: 'test\nnewline in comment' });
    const file = path.join(dir, 'launch.sh');
    fs.writeFileSync(file, script, { mode: 0o700 });
    const r = spawnSync('/bin/sh', [file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.deepEqual(got.argv, args);
    assert.equal(fs.realpathSync(got.cwd), fs.realpathSync(cwd));
    assert.equal(got.env, NASTY.join('|'));
    assert.equal(fs.existsSync('/tmp/clawdling-pwned'), false);
    assert.equal(script.split('\n')[1], '# test newline in comment');
    assert.throws(() => buildLauncherScript({ cwd, env: { 'BAD-NAME': 'x' }, argv: ['x'] }), /invalid environment/);
  } finally {
    rmrf(dir);
  }
});

test('claude argv: session id, name, settings, model, permission mode, add-dir, context, prompt after --', () => {
  const sid = '99999999-9999-4999-8999-999999999999';
  const a = buildClaudeArgs({ sid, name: 'Health: -x', settingsPath: '/s.json', model: 'haiku', permissionMode: 'acceptEdits', addDirs: ['/org'], appendSystemPromptFile: '/ctx.md', prompt: '-p rm' });
  assert.deepEqual(a, ['--session-id', sid, '--name=Health: -x', '--settings', '/s.json', '--model=haiku', '--permission-mode', 'acceptEdits', '--add-dir', '/org', '--append-system-prompt-file', '/ctx.md', '--', '-p rm']);
  const r = buildClaudeArgs({ sid, resume: true, resumeId: sid, permissionMode: 'default' });
  assert.deepEqual(r, ['--resume', sid], '"default" permission mode passes no flag');
  assert.equal(safePositional('update'), 'update ', 'a bare word cannot become a claude subcommand');
  assert.equal(safePositional('doctor please'), 'doctor please');
});

test('snapshot: clear, CRLF lines, cursor position, replayed modes, hidden cursor', () => {
  const modes = new ModeTracker([2004]);
  const s = buildSnapshot(['line one', 'line two', ''], '4 1 80 24 0 0', modes);
  assert.ok(s.startsWith('\x1b[0m\x1b[H\x1b[2J\x1b[3J'));
  assert.ok(s.includes('line one\r\nline two\r\n'));
  assert.ok(s.includes('\x1b[2;5H'));
  assert.ok(s.includes('\x1b[?2004h'));
  assert.ok(s.endsWith('\x1b[?25l'));
  assert.ok(buildSnapshot(['x'], '0 0 80 24 1 1', null).includes('\x1b[?1049h'), 'alternate screen restored');
});
