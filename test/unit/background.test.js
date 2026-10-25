// The background-task detector (server/background.js) over real-shaped transcript excerpts
// (test/fixtures/background/README.md says which are real and which are synthetic).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROCESS_START_SLACK_MS, WATCHER_EXPIRY_GRACE_MS, activeTasks, activeTasksAcross, applyCliStatus, ingestLine, newTaskState } from '../../server/background.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'background');

/** Every key of `want` equals the same key of `got` (vitest's toMatchObject, one level). */
function assertMatch(got, want) {
  assert.ok(got, 'expected a task');
  for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, k);
}
const lines = (name) =>
  fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter((l) => l.length > 0);

/** Ingest the first `n` lines of a fixture (all of them when n is omitted). */
function load(name, n) {
  const st = newTaskState();
  for (const l of lines(name).slice(0, n)) ingestLine(st, l);
  return st;
}
const T = (iso) => Date.parse(iso);
const ids = (st, now, start) =>
  activeTasks(st, { nowMs: T(now), processStartMs: T(start) }).map((t) => t.id);

describe('Monitor watchers (a session that watched build jobs all morning)', () => {
  const START = '2026-10-24T09:50:58Z'; // the session's process start
  const F = 'monitor-rearm.jsonl';

  it('a launched Monitor is active, with its description and expiry', () => {
    const [t] = activeTasks(load(F, 2), { nowMs: T('2026-10-24T11:40:00Z'), processStartMs: T(START) });
    assertMatch(t, {
      id: 'bswxsv7ij',
      kind: 'watcher',
      description: 'Build job: done, exit, or failure',
      started_at: '2026-10-24T11:37:48.646Z',
      expires_at: '2026-10-24T12:07:48.646Z',
    });
  });

  it('an ordinary Monitor event (no <status>) does not end it', () => {
    assert.deepEqual(ids(load(F, 4), '2026-10-24T11:40:00Z', START), ['bswxsv7ij']);
  });

  it('the "[Monitor expired after …]" event ends it', () => {
    assert.deepEqual(ids(load(F, 5), '2026-10-24T12:07:49Z', START), []);
  });

  it('after four expiries and re-arms, exactly the fifth Monitor is running', () => {
    assert.deepEqual(ids(load(F), '2026-10-24T13:40:00Z', START), ['bq5z2hrtp']);
  });

  it('a watcher past its timeout (plus grace) is over even with no expiry notice', () => {
    const st = load(F);
    const expiry = T('2026-10-24T13:38:12.746Z') + 30 * 60_000;
    assert.equal((activeTasks(st, { nowMs: expiry + WATCHER_EXPIRY_GRACE_MS - 1, processStartMs: T(START) })).length, 1);
    assert.equal((activeTasks(st, { nowMs: expiry + WATCHER_EXPIRY_GRACE_MS + 1, processStartMs: T(START) })).length, 0);
  });

  it('a task launched before the pane\'s CURRENT process started is not running', () => {
    assert.deepEqual(ids(load(F), '2026-10-24T13:40:00Z', '2026-10-24T13:39:00Z'), []);
    // ...but the start comparison has a few seconds of slack for clock skew.
    const launched = T('2026-10-24T13:38:12.746Z');
    const st = load(F);
    assert.equal((activeTasks(st, { nowMs: T('2026-10-24T13:40:00Z'), processStartMs: launched + PROCESS_START_SLACK_MS - 1 })).length, 1);
  });

  it('a persistent Monitor has no expiry', () => {
    const [t] = activeTasks(load('monitor-persistent.jsonl'), {
      nowMs: T('2026-10-24T20:00:00Z'),
      processStartMs: T('2026-10-24T07:00:00Z'),
    });
    assertMatch(t, { id: 'bpersist1', kind: 'watcher', expires_at: null });
  });
});

describe('ends are matched by id, never by order', () => {
  const START = '2026-10-06T17:00:00Z';

  it('a Monitor whose end notice is logged BEFORE its own tool_result is not counted', () => {
    const F = 'monitor-ended-and-early-notice.jsonl';
    // line 6 = the end notice, line 7 = the launch result
    assert.deepEqual(ids(load(F, 6), '2026-10-06T17:48:30Z', START), []);
    assert.deepEqual(ids(load(F, 7), '2026-10-06T17:48:30Z', START), []);
    assert.deepEqual(ids(load(F), '2026-10-06T17:48:30Z', START), []);
  });

  it('a "stream ended" completion ends a Monitor', () => {
    assert.deepEqual(ids(load('monitor-ended-and-early-notice.jsonl', 2), '2026-10-06T17:48:08Z', START), ['b7g3ymyc5']);
    assert.deepEqual(ids(load('monitor-ended-and-early-notice.jsonl', 3), '2026-10-06T17:48:08Z', START), []);
  });
});

describe('TaskStop, async agents, shells, workflows', () => {
  it('TaskStop ends a Monitor; the next Monitor runs through its events to completion', () => {
    const F = 'monitor-taskstop-events.jsonl';
    const S = '2026-10-06T18:00:00Z';
    assert.deepEqual(ids(load(F, 4), '2026-10-06T18:59:25Z', S), ['bt4uy0wvq']);
    assert.deepEqual(ids(load(F, 6), '2026-10-06T18:59:28Z', S), []);
    assert.deepEqual(ids(load(F, 14), '2026-10-06T19:00:40Z', S), ['bimdob4pl']);
    assert.deepEqual(ids(load(F), '2026-10-06T19:01:10Z', S), []);
  });

  it('an Agent with no run_in_background is async by default and counts until it finishes', () => {
    const F = 'async-agents-and-shell.jsonl';
    const S = '2026-10-10T17:00:00Z';
    const two = activeTasks(load(F, 4), { nowMs: T('2026-10-10T17:25:00Z'), processStartMs: T(S) });
    assert.deepEqual(two.map((t) => [t.kind, t.description]), [
      ['agent', 'Desk one: audit'],
      ['agent', 'Desk two: review'],
    ]);
    assert.deepEqual(ids(load(F, 5), '2026-10-10T17:30:00Z', S), ['a403af9dd10478068']);
    assert.deepEqual(ids(load(F, 8), '2026-10-10T17:32:00Z', S), []);
  });

  it('a run_in_background Bash is a shell until its completion notice', () => {
    const F = 'async-agents-and-shell.jsonl';
    const S = '2026-10-10T17:00:00Z';
    const [t] = activeTasks(load(F, 10), { nowMs: T('2026-10-10T17:46:00Z'), processStartMs: T(S) });
    assertMatch(t, { id: 'bb08sqk4e', kind: 'shell', description: 'Run a live test question', expires_at: null });
    assert.deepEqual(ids(load(F), '2026-10-10T17:48:00Z', S), []);
  });

  it('run_in_background: "true" (a string) still launches an async agent', () => {
    const F = 'agent-run-in-background-true-string.jsonl';
    assert.deepEqual(ids(load(F, 2), '2026-10-06T18:00:00Z', '2026-10-06T17:00:00Z'), ['abf84f236f5e360f9']);
    assert.deepEqual(ids(load(F), '2026-10-06T18:12:00Z', '2026-10-06T17:00:00Z'), []);
  });

  it('a rested agent resumed by SendMessage counts again until its next end', () => {
    const F = 'agent-rest-then-resume.jsonl';
    const S = '2026-10-15T23:00:00Z';
    assert.deepEqual(ids(load(F, 2), '2026-10-15T23:11:00Z', S), ['a1f1548fe3d13eebc']);
    assert.deepEqual(ids(load(F, 3), '2026-10-15T23:14:00Z', S), []);
    const [resumed] = activeTasks(load(F, 6), { nowMs: T('2026-10-15T23:19:00Z'), processStartMs: T(S) });
    assertMatch(resumed, { id: 'a1f1548fe3d13eebc', kind: 'agent', started_at: '2026-10-15T23:18:27.991Z' });
    assert.deepEqual(ids(load(F, 7), '2026-10-15T23:20:00Z', S), []);
  });

  it('a foreground Bash moved to the background by its timeout is a shell from that moment', () => {
    const F = 'shell-killed-then-stopped.jsonl';
    const S = '2026-10-22T02:00:00Z';
    const [t] = activeTasks(load(F, 2), { nowMs: T('2026-10-22T04:00:00Z'), processStartMs: T(S) });
    assertMatch(t, { id: 'blgkgv2s7', kind: 'shell', started_at: '2026-10-22T03:06:23.014Z' });
    assert.deepEqual(ids(load(F, 3), '2026-10-22T09:13:13Z', S), []); // killed
  });

  it('a background Workflow is named by its workflow, and ends on completion', () => {
    const F = 'workflow-async.jsonl';
    const [t] = activeTasks(load(F, 2), { nowMs: T('2026-10-23T12:05:00Z'), processStartMs: T('2026-10-23T12:00:00Z') });
    assertMatch(t, { id: 'w1zaqy5w4', kind: 'workflow', description: 'docs-claims-audit' });
    assert.deepEqual(ids(load(F), '2026-10-23T12:10:00Z', '2026-10-23T12:00:00Z'), []);
  });

  it('one notice naming several task ids ends all of them', () => {
    const F = 'shells-orphaned-by-restart.jsonl';
    assert.deepEqual(ids(load(F, 4), '2026-10-23T16:10:00Z', '2026-10-23T15:00:00Z'), ['bshellaa1', 'bshellbb2']);
    assert.deepEqual(ids(load(F), '2026-10-23T16:30:00Z', '2026-10-23T15:00:00Z'), []);
  });
});

describe('what must not count', () => {
  it('foreground calls, sync agents, failed starts, sub-agent shells and quoted notices', () => {
    const tasks = activeTasks(load('negatives.jsonl'), {
      nowMs: T('2026-10-24T09:10:00Z'),
      processStartMs: T('2026-10-24T08:00:00Z'),
    });
    // Only the shell whose end was merely QUOTED by the assistant is running.
    assert.deepEqual(tasks.map((t) => [t.id, t.kind]), [['bquoted01', 'shell']]);
  });

  it('a notification in a user turn\'s text block counts', () => {
    const st = load('negatives.jsonl');
    ingestLine(st, JSON.stringify({
      type: 'user',
      timestamp: '2026-10-24T09:08:00Z',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>bquoted01</task-id>\n<status>failed</status>\n</task-notification>' }] },
    }));
    assert.deepEqual(activeTasks(st, { nowMs: T('2026-10-24T09:10:00Z'), processStartMs: T('2026-10-24T08:00:00Z') }), []);
  });

  it('a long description is clipped to 120 characters', () => {
    const st = newTaskState();
    ingestLine(st, JSON.stringify({ type: 'assistant', timestamp: '2026-10-24T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { description: 'x'.repeat(300), run_in_background: true } }] } }));
    ingestLine(st, JSON.stringify({ type: 'user', timestamp: '2026-10-24T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] }, toolUseResult: { backgroundTaskId: 'b1' } }));
    const [t] = activeTasks(st, { nowMs: T('2026-10-24T10:01:00Z'), processStartMs: T('2026-10-24T09:00:00Z') });
    assert.equal((t.description).length, 120);
    assert.equal(t.description.endsWith('…'), true);
  });

  it('a task with no description gets a plain label for its kind', () => {
    const st = newTaskState();
    ingestLine(st, JSON.stringify({ type: 'assistant', timestamp: '2026-10-24T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Monitor', input: {} }] } }));
    ingestLine(st, JSON.stringify({ type: 'user', timestamp: '2026-10-24T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] }, toolUseResult: { taskId: 'm1' } }));
    assert.equal(activeTasks(st, { nowMs: T('2026-10-24T10:01:00Z'), processStartMs: T('2026-10-24T09:00:00Z') })[0].description, 'Watcher');
  });
});

describe('only the notice HEADER can end a task', () => {
  const S = '2026-10-24T09:00:00Z';
  const launchShell = (st, id, tu, ts) => {
    ingestLine(st, JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: tu, name: 'Bash', input: { description: id, run_in_background: true } }] } }));
    ingestLine(st, JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: tu, content: 'bg' }] }, toolUseResult: { backgroundTaskId: id } }));
  };
  const notice = (body) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-24T10:00:00Z', content: `<task-notification>\n${body}\n</task-notification>` });

  it('an agent result that QUOTES another task\'s id and status does not end it', () => {
    const st = newTaskState();
    launchShell(st, 'bwatch001', 'tu-w', '2026-10-24T09:30:00Z');
    ingestLine(st, notice('<task-id>aother0001</task-id>\n<tool-use-id>tu-other</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n<result>I saw <task-id>bwatch001</task-id> and <status>completed</status> in the log.</result>'));
    assert.deepEqual(ids(st, '2026-10-24T10:01:00Z', S), ['bwatch001']);
  });

  it('a Monitor event whose OUTPUT contains a status tag is not an end', () => {
    const st = newTaskState();
    launchShell(st, 'bwatch002', 'tu-w2', '2026-10-24T09:30:00Z');
    ingestLine(st, notice('<task-id>bwatch002</task-id>\n<summary>Monitor event: "tail"</summary>\n<event>build <status>completed</status></event>'));
    assert.deepEqual(ids(st, '2026-10-24T10:01:00Z', S), ['bwatch002']);
  });
});

describe('a resumed agent and its old completion', () => {
  const S = '2026-10-15T23:00:00Z';
  const F = 'agent-rest-then-resume.jsonl';

  it('the first run\'s completion delivered AGAIN after the resume does not end the resumed run', () => {
    const all = lines(F);
    const st = newTaskState();
    for (const l of all.slice(0, 6)) ingestLine(st, l); // launch, completion (x2), resume
    // The first run's completion, delivered as a user turn after the resume:
    const first = JSON.parse(all[2]);
    ingestLine(st, JSON.stringify({ type: 'user', timestamp: '2026-10-15T23:18:40Z', message: { role: 'user', content: first.content } }));
    assert.deepEqual(ids(st, '2026-10-15T23:19:00Z', S), ['a1f1548fe3d13eebc']);
  });

  it('an end logged between the resume\'s call and its result belongs to the resumed run', () => {
    const all = lines(F);
    const st = newTaskState();
    for (const l of all.slice(0, 5)) ingestLine(st, l); // ... up to the SendMessage tool_use
    ingestLine(st, all[6]); // the resumed run's completion, logged early
    ingestLine(st, all[5]); // then the SendMessage result
    assert.deepEqual(ids(st, '2026-10-15T23:20:00Z', S), []);
  });
});

describe('the CLI process status gate', () => {
  const shell = { id: 'b1', kind: 'shell', description: 's', started_at: null, expires_at: null };
  const watcher = { ...shell, id: 'b2', kind: 'watcher' };
  const agent = { ...shell, id: 'a1', kind: 'agent' };
  const cli = (status, version = '2.1.283') => ({ status, statusUpdatedAtMs: Date.parse('2026-10-24T10:00:00Z'), version });

  it('"idle" keeps agents and workflows, drops shells and watchers', () => {
    assert.deepEqual(applyCliStatus([shell, watcher, agent], cli('idle')).map((t) => t.id), ['a1']);
  });
  it('"shell" with none in the transcript adds one generic background command', () => {
    assert.deepEqual(applyCliStatus([agent], cli('shell')), [
      agent,
      { id: 'cli-local-bash', kind: 'shell', description: 'Background command', started_at: '2026-10-24T10:00:00.000Z', expires_at: null },
    ]);
    assert.deepEqual(applyCliStatus([watcher], cli('shell')), [watcher]);
  });
  it('"busy", no record, or an older CLI leaves the transcript alone', () => {
    assert.deepEqual(applyCliStatus([shell], cli('busy')), [shell]);
    assert.deepEqual(applyCliStatus([shell], null), [shell]);
    assert.deepEqual(applyCliStatus([shell], cli('idle', '2.1.99')), [shell]);
    assert.deepEqual(applyCliStatus([shell], cli('idle', '2.2.0')), []);
    assert.deepEqual(applyCliStatus([shell], cli('idle', 'garbage')), [shell]);
  });
});

describe('a sub-agent\'s background work (its own transcript, ends often in the main one)', () => {
  const S = '2026-10-24T11:00:00Z';
  const sub = (n) => {
    const st = newTaskState({ sidechain: true });
    for (const l of lines('subagent-shells.sub.jsonl').slice(0, n)) ingestLine(st, l);
    return st;
  };
  const main = (n) => load('subagent-shells.main.jsonl', n);

  it('a main-file state ignores sidechain lines; a sub-agent state reads them', () => {
    const asMain = newTaskState();
    for (const l of lines('subagent-shells.sub.jsonl')) ingestLine(asMain, l);
    assert.deepEqual(activeTasks(asMain, { nowMs: T('2026-10-24T11:50:00Z'), processStartMs: T(S) }), []);
    assert.deepEqual(activeTasks(sub(), { nowMs: T('2026-10-24T11:50:00Z'), processStartMs: T(S) }).map((t) => t.kind), ['shell', 'shell']);
  });

  it('both shells run until the MAIN transcript records their ends', () => {
    const opts = { nowMs: T('2026-10-24T12:00:00Z'), processStartMs: T(S) };
    assert.deepEqual(activeTasksAcross([main(0), sub()], opts).map((t) => t.id).sort(), ['b8qbq0fs5', 'bni9ihn5p']);
    assert.deepEqual(activeTasksAcross([main(1), sub()], { ...opts, nowMs: T('2026-10-24T12:10:00Z') }).map((t) => t.id), ['b8qbq0fs5']);
    assert.deepEqual(activeTasksAcross([main(), sub()], { ...opts, nowMs: T('2026-10-24T12:13:00Z') }), []);
  });
});
