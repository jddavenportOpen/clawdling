// Probe: Claude Code's idle_prompt Notification (sent about a minute after a finished turn) wipes the
// hook-reported idle state of a "ready" session (server/sessions.js applyHook sets rec.idle_hook = null
// for any event that is not Stop or a needs_you wait). So a scheduled CTO review that finished its turn
// is no longer "idle as a hook reported it", and Cto.watchSpend ends it as soon as the CTO's week spend
// passes the cap (e.g. through the owner's own CTO chats), with a "stopped: past its weekly cap" notice.
// docs/SECURITY.md: "While it sits idle on you as Claude Code's own hooks reported it (its turn over,
// ...), it spends nothing and is not ended, so your own chats with the CTO passing the cap cannot close it".
//
// Fails on 49723e2; passes once a Notification that does not change the status (idle_prompt on a ready
// session) keeps rec.idle_hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../server/sessions.js';
import { Cto } from '../../server/cto.js';

/** A SessionManager with only what applyHook/view/onStatusChange touch; no tmux, no claude, no timers kept. */
function manager(rec) {
  const m = Object.create(SessionManager.prototype);
  m.records = new Map([[rec.sid, rec]]);
  m.runtime = new Map();
  m.events = { record() {}, publish() {} };
  m.backend = {};
  m.socket = 'probe';
  m.home = '/nonexistent-clawdling-probe-org';
  m.scheduleSave = () => {};
  m.save = () => {};
  m.refreshBackground = () => {};
  return m;
}

function reviewRecord() {
  const created = new Date(Date.now() - 20 * 60000).toISOString();
  return { sid: crypto.randomUUID(), agent: 'cto', agent_name: 'CTO', kind: 'cto', title: 'CTO review, 2026-W44', review_week: '2026-W44', status: 'working', waiting_on: null, created_at: created, launched_at: created, last_activity_at: created, tmux_name: 'cl-cto-probe0' };
}

test('a finished turn stays idle-by-hook through the idle_prompt notification', () => {
  const rec = reviewRecord();
  const m = manager(rec);
  m.applyHook('Stop', rec.sid, { last_assistant_message: 'The review is written.' }, new Date(Date.now() - 61000).toISOString());
  assert.equal(rec.status, 'ready');
  assert.equal(m.idleByHook(rec), true, 'precondition: Stop is a hook-reported idle state');
  m.applyHook('Notification', rec.sid, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, new Date().toISOString());
  assert.equal(rec.status, 'ready');
  assert.equal(m.idleByHook(rec), true, 'idle_prompt changed nothing, yet the session no longer counts as idle');
});

test('so the spend watch does not end a finished scheduled review when the week passes the cap', async () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-idle-probe-'));
  try {
    const rec = reviewRecord();
    const m = manager(rec);
    const ended = [];
    m.end = async (sid) => {
      ended.push(sid);
    };
    m.applyHook('Stop', rec.sid, { last_assistant_message: 'The review is written.' }, new Date(Date.now() - 61000).toISOString());
    m.applyHook('Notification', rec.sid, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, new Date().toISOString());
    // The owner's own CTO chats this week took the spend to $5 against a $2 cap.
    const reports = { summaries: () => [], costOf: () => ({ total_usd: 5, complete: true, unknown_models: [], sessions_partly_unknown: 0, sessions_counting: 0, sessions_without_cost: 0 }) };
    const cto = new Cto({ paths: { rt, home: rt }, org: { cto: () => ({ id: 'cto', dir: rt }) }, sessions: m, reports });
    cto.save({ enabled: true, weekly_cap_usd: 2, watch_sid: rec.sid });
    await cto.watchSpend();
    assert.deepEqual(ended, [], 'the finished, idle scheduled review was ended');
  } finally {
    fs.rmSync(rt, { recursive: true, force: true });
  }
});
