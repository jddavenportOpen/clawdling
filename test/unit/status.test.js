import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHookEvent } from '../../server/hooks.js';

const rec = (over = {}) => ({ sid: '11111111-1111-4111-8111-111111111111', status: 'starting', title: null, pending_prompt: false, prompted: false, notification: null, waiting_on: null, ...over });
const SID2 = '22222222-2222-4222-8222-222222222222';

test('fresh session: SessionStart -> ready (waiting for you)', () => {
  const r = rec();
  assert.deepEqual(applyHookEvent(r, 'SessionStart', { source: 'startup' }), { statusChanged: true, titleChanged: false });
  assert.equal(r.status, 'ready');
});

test('session with a first prompt: starting -> working -> ready, title derived once', () => {
  const r = rec({ pending_prompt: true });
  applyHookEvent(r, 'SessionStart', { source: 'startup' });
  assert.equal(r.status, 'starting');
  const res = applyHookEvent(r, 'UserPromptSubmit', { prompt: 'plan my week. thanks' });
  assert.equal(r.status, 'working');
  assert.equal(res.titleChanged, true);
  assert.equal(r.title, 'Plan my week');
  applyHookEvent(r, 'Stop', { last_assistant_message: 'Here is your plan.' });
  assert.equal(r.status, 'ready');
  assert.equal(r.last_message, 'Here is your plan.');
  applyHookEvent(r, 'UserPromptSubmit', { prompt: 'something else entirely' });
  assert.equal(r.title, 'Plan my week', 'title is only derived when there is none');
});

test('Notification -> needs_you keeps the message; next prompt clears it', () => {
  const r = rec({ status: 'working' });
  applyHookEvent(r, 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
  assert.equal(r.status, 'needs_you');
  assert.equal(r.notification, 'Claude needs your permission to use Bash');
  assert.equal(r.waiting_on, 'permission_prompt');
  applyHookEvent(r, 'UserPromptSubmit', { prompt: 'ok' });
  assert.equal(r.status, 'working');
  assert.equal(r.notification, null);
});

test('auth_success notifications do not change status; idle notices do', () => {
  const r = rec({ status: 'ready' });
  assert.equal(applyHookEvent(r, 'Notification', { notification_type: 'auth_success', message: 'ok' }).statusChanged, false);
  applyHookEvent(r, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.equal(r.status, 'needs_you');
});

test('SessionEnd ends the session except for /clear; ended sessions ignore hooks', () => {
  const r = rec({ status: 'ready' });
  applyHookEvent(r, 'SessionEnd', { reason: 'clear' });
  assert.equal(r.status, 'ready');
  applyHookEvent(r, 'SessionEnd', { reason: 'prompt_input_exit' });
  assert.equal(r.status, 'ended');
  assert.ok(r.ended_at);
  assert.equal(applyHookEvent(r, 'UserPromptSubmit', { prompt: 'x' }).statusChanged, false);
  assert.equal(r.status, 'ended');
});

test('a new Claude session id (e.g. after /clear) is recorded for resume', () => {
  const r = rec({ status: 'ready', claude_session_id: '11111111-1111-4111-8111-111111111111' });
  applyHookEvent(r, 'SessionStart', { source: 'clear', session_id: SID2, transcript_path: '/tmp/t.jsonl' });
  assert.equal(r.claude_session_id, SID2);
  assert.equal(r.resumed_from, '11111111-1111-4111-8111-111111111111');
  assert.equal(r.transcript_path, '/tmp/t.jsonl');
  applyHookEvent(r, 'Stop', { session_id: 'not-a-uuid' });
  assert.equal(r.claude_session_id, SID2);
});

test('compaction does not reset a working session', () => {
  const r = rec({ status: 'working' });
  applyHookEvent(r, 'SessionStart', { source: 'compact' });
  assert.equal(r.status, 'working');
});

test('trust dialog wait is cleared once Claude actually starts', () => {
  const r = rec({ status: 'needs_you', waiting_on: 'trust', notification: 'trust?' });
  applyHookEvent(r, 'SessionStart', { source: 'startup' });
  assert.equal(r.status, 'ready');
  assert.equal(r.notification, null);
});
