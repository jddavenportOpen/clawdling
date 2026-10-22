// Registry reconcile and hook-spool replay, with tmux replaced by a stub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { EventBus } from '../../server/events.js';
import { OrgStore, defaultAnswers, initOrg } from '../../server/org.js';
import { runtimePaths } from '../../server/paths.js';
import { SessionManager, reconcileRecords } from '../../server/sessions.js';
import { rmrf, tempHome } from '../helpers.mjs';

const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const row = (sid, over = {}) => ({ sid, agent: 'work', agent_name: 'Work', kind: 'domain', status: 'ready', tmux_name: `cl-work-${sid.slice(0, 6)}`, created_at: '2026-10-01T00:00:00.000Z', ...over });

test('reconcileRecords: alive rows are attached, gone rows end, tagged orphans are adopted', () => {
  const recs = [row(A), row(B, { status: 'working' }), row(C, { status: 'ended', ended_at: '2026-10-02T00:00:00.000Z' })];
  const live = [
    { name: `cl-work-${A.slice(0, 6)}`, pane: '%3', sid: A },
    { name: `cl-work-${C.slice(0, 6)}`, pane: '%9', sid: C },
    { name: 'cl-health-777777', pane: '%5', sid: '77777777-7777-4777-8777-777777777777', agent: 'health' },
    { name: 'someone-elses', pane: '%6', sid: null },
  ];
  const r = reconcileRecords(recs, live, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(r.attach.map((x) => x.sid), [A, C]);
  assert.equal(recs[0].pane_id, '%3');
  assert.equal(recs[2].status, 'ready', 'a row marked ended whose tmux session is alive is live again');
  assert.deepEqual(r.ended.map((x) => x.sid), [B]);
  assert.equal(recs[1].status, 'ended');
  assert.equal(recs[1].ended_at, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(r.orphans.map((x) => x.name), ['cl-health-777777']);
});

test('SessionManager.init: loads, reconciles against tmux, replays the hook spool in order', async () => {
  const home = tempHome();
  try {
    initOrg({ home, answers: defaultAnswers() });
    const paths = runtimePaths(home);
    fs.mkdirSync(paths.rt, { recursive: true });
    fs.writeFileSync(paths.sessions, JSON.stringify({ version: 1, sessions: [row(A, { status: 'working' }), row(B, { status: 'ready' }), row(C, { status: 'ended', ended_at: '2020-01-01T00:00:00.000Z' })] }));
    const lines = [
      { event: 'UserPromptSubmit', sid: A, payload: { prompt: 'while you were away' } },
      { event: 'Stop', sid: A, payload: { last_assistant_message: 'all done' } },
      { event: 'Stop', sid: '88888888-8888-4888-8888-888888888888', payload: {} },
    ];
    fs.writeFileSync(paths.hookSpool, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{torn');
    const attached = [];
    const tmux = {
      listSessions: async () => [{ name: `cl-work-${A.slice(0, 6)}`, pane: '%1', sid: A }],
      control: (name) => {
        attached.push(name);
        return { on() {}, closed: false, close() {} };
      },
      hasSession: async () => true,
    };
    const events = new EventBus({ file: paths.events });
    const sm = new SessionManager({ paths, org: new OrgStore(paths), events, tmux, claudeBin: 'claude', socket: 's', shimDir: paths.bin, env: process.env, getPort: () => 1 });
    await sm.init();
    assert.deepEqual(attached, [`cl-work-${A.slice(0, 6)}`]);
    const a = sm.get(A);
    assert.equal(a.status, 'ready');
    assert.equal(a.last_message, 'all done');
    assert.equal(a.title, 'While you were away');
    assert.equal(sm.get(B).status, 'ended', 'B was not in tmux');
    assert.equal(sm.get(C), null, 'ended rows older than 30 days are pruned');
    assert.equal(fs.existsSync(paths.hookSpool), false, 'spool consumed');
    const saved = JSON.parse(fs.readFileSync(paths.sessions, 'utf8'));
    assert.equal(saved.sessions.find((s) => s.sid === A).status, 'ready');
    const list = sm.list();
    assert.equal(list[0].sid, A, 'newest activity first');
    assert.equal(list[0].name, 'Work: While you were away');
    assert.equal(list[0].attach_cmd, `tmux -L s attach -t cl-work-${A.slice(0, 6)}`);
    await sm.shutdown();
  } finally {
    rmrf(home);
  }
});

test('replay never rolls a session back: spooled events older than the last applied hook are dropped', async () => {
  const home = tempHome();
  try {
    initOrg({ home, answers: defaultAnswers() });
    const paths = runtimePaths(home);
    fs.mkdirSync(paths.rt, { recursive: true });
    fs.writeFileSync(paths.sessions, JSON.stringify({ version: 1, sessions: [row(A, { status: 'ready' })] }));
    const tmux = { listSessions: async () => [{ name: `cl-work-${A.slice(0, 6)}`, pane: '%1', sid: A }], control: () => ({ on() {}, closed: false, close() {} }), hasSession: async () => true };
    const sm = new SessionManager({ paths, org: new OrgStore(paths), events: new EventBus({ file: paths.events }), tmux, claudeBin: 'claude', socket: 's', shimDir: paths.bin, env: process.env, getPort: () => 1 });
    await sm.init();
    // Live: the prompt (t=1s) and the Stop (t=5s) both arrived; the prompt's hook had timed out on
    // its side, so it was also spooled.
    sm.applyHook('UserPromptSubmit', A, { prompt: 'go' }, '2026-10-22T10:00:01.000Z');
    sm.applyHook('Stop', A, { last_assistant_message: 'finished' }, '2026-10-22T10:00:05.000Z');
    assert.equal(sm.get(A).status, 'ready');
    fs.writeFileSync(paths.hookSpool, JSON.stringify({ event: 'UserPromptSubmit', sid: A, payload: { prompt: 'go' }, ts: '2026-10-22T10:00:01.000Z' }) + '\n');
    assert.equal(sm.replaySpool(), 1);
    assert.equal(sm.get(A).status, 'ready', 'the stale prompt event did not flip it back to working');
    // A newer spooled event still applies.
    fs.writeFileSync(paths.hookSpool, JSON.stringify({ event: 'Notification', sid: A, payload: { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }, ts: '2026-10-22T10:01:05.000Z' }) + '\n');
    sm.replaySpool();
    assert.equal(sm.get(A).status, 'needs_you');
    assert.equal(JSON.parse(fs.readFileSync(paths.sessions, 'utf8')).socket, 's', 'the registry records its tmux socket');
    await sm.shutdown();
  } finally {
    rmrf(home);
  }
});
