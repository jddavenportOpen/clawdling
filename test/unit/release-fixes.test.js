// Defects found by the 1.1 release verification with the REAL Claude Code (2.1.283), each pinned.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionManager, parseChoices } from '../../server/sessions.js';
import { ControlClient } from '../../server/tmux.js';
import { OrgStore } from '../../server/org.js';
import { EventBus } from '../../server/events.js';
import { runtimePaths } from '../../server/paths.js';
import { rmrf, tempHome, waitFor } from '../helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('an AskUserQuestion list (numbered, with description lines) is read as choices', () => {
  const screen = fs.readFileSync(path.join(HERE, '..', 'fixtures', 'screen-askuserquestion-2.1.283.txt'), 'utf8');
  const c = parseChoices(screen);
  assert.ok(c, 'found the list');
  assert.equal(c.selected, 0);
  assert.equal(c.labels.length, 4);
  assert.match(c.labels[0], /^1\. I'll paste\/describe it here/);
  assert.match(c.labels[3], /^4\. Type something\./);
});

test('choices drawn after the Notification hook are still picked up (the hook can arrive first)', async () => {
  const home = tempHome();
  try {
    const paths = runtimePaths(home);
    fs.mkdirSync(paths.rt, { recursive: true });
    fs.writeFileSync(paths.orgJson, JSON.stringify({ version: 1, name: 'T', owner: 'T', chief: 'donna', channels: {} }));
    let calls = 0;
    const list = 'Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)\n';
    const backend = {
      kind: 'tmux', persistent: true, listSessions: async () => [], hasSession: async () => true,
      control: () => ({ on() {}, closed: false, close() {} }),
      // The first two looks see the screen before Claude Code has drawn the list.
      screenText: async () => (++calls <= 2 ? 'Bash(npm test)\n' : list),
    };
    const sm = new SessionManager({ paths, org: new OrgStore(paths), events: new EventBus({ file: paths.events }), backend, claudeBin: 'claude', socket: 's', shimDir: paths.bin, env: process.env, getPort: () => 1 });
    await sm.init();
    const sid = '0f0f0f0f-0000-4000-8000-000000000001';
    sm.records.set(sid, { sid, agent: 'scratch', status: 'working', tmux_name: 'cl-x', pane_id: '%1', title: null });
    sm.applyHook('Notification', sid, { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    const got = await waitFor(() => sm.get(sid).choices, { timeout: 8000, label: 'choices' });
    assert.deepEqual(got.map((c) => c.option), [1, 2]);
    assert.ok(calls >= 3, `looked again until the list was drawn (${calls} looks)`);
    await sm.shutdown();
  } finally {
    rmrf(home);
  }
});

test('stopping the server ends each tmux control client at once (an orphan keeps tmux alive)', () => {
  const proc = new EventEmitter();
  const signals = [];
  proc.stdin = { end() {}, write() {} };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (sig) => signals.push(sig);
  const c = Object.create(ControlClient.prototype);
  Object.assign(c, { proc, closed: false });
  c.close(true);
  assert.deepEqual(signals, ['SIGTERM'], 'killed now, not after an unref()ed timer the exiting process never runs');
});
