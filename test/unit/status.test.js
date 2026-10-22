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

test('startup dialogs are recognised from the rendered screen, whatever the spacing', async () => {
  const { dialogFromScreen } = await import('../../server/sessions.js');
  const real = ` Accessing workspace:\n\n /private/var/folders/T/cl-smoke/domains/archive\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from\n your team). If not, take a moment to review what's in this folder first.\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel`;
  assert.equal(dialogFromScreen(real).waiting, 'trust');
  assert.equal(dialogFromScreen('Yes,I  trust\nthis   folder').waiting, 'trust');
  assert.equal(dialogFromScreen('Allow external CLAUDE.md file imports?').waiting, 'imports');
  assert.equal(dialogFromScreen('> hello\nassistant: hi'), null);
});

test('SessionStart only moves a starting session to ready; working/ready/waiting sessions keep their status', () => {
  for (const status of ['working', 'ready']) {
    const r = rec({ status });
    assert.equal(applyHookEvent(r, 'SessionStart', { source: 'resume' }).statusChanged, false, status);
    assert.equal(r.status, status);
  }
  const p = rec({ status: 'needs_you', waiting_on: 'permission_prompt', notification: 'Allow Bash?' });
  applyHookEvent(p, 'SessionStart', { source: 'resume' });
  assert.equal(p.status, 'needs_you', 'a pending permission prompt is not cleared');
  assert.equal(p.notification, 'Allow Bash?');
  const resumed = rec({ status: 'starting' });
  applyHookEvent(resumed, 'SessionStart', { source: 'resume' });
  assert.equal(resumed.status, 'ready');
  // Resumed, then the owner typed before the (late) SessionStart arrived: stays working.
  const late = rec({ status: 'starting' });
  applyHookEvent(late, 'UserPromptSubmit', { prompt: 'keep going' });
  applyHookEvent(late, 'SessionStart', { source: 'resume' });
  assert.equal(late.status, 'working');
});

test('parseChoices reads Claude Code select lists from the rendered screen', async () => {
  const { parseChoices, trustNotice } = await import('../../server/sessions.js');
  // Captured from claude 2.1.283's folder-trust dialog.
  const trust = [
    ' Accessing workspace:',
    '',
    ' /private/tmp/cl-digitprobe-jM4E',
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');
  assert.deepEqual(parseChoices(trust), { labels: ['No, exit', 'Yes, I trust this folder'], selected: 0 });
  const moved = trust.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust', ' ❯ Yes, I trust');
  assert.deepEqual(parseChoices(moved), { labels: ['No, exit', 'Yes, I trust this folder'], selected: 1 });
  const perm = [
    ' Bash command',
    '   echo hi',
    '',
    ' Do you want to proceed?',
    '   1. Yes',
    " ❯ 2. Yes, and don't ask again for echo commands in",
    '      /Users/sam/projects/a-very-long-folder-name',
    '   3. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  const p = parseChoices(perm);
  assert.equal(p.selected, 1);
  assert.equal(p.labels.length, 3);
  assert.equal(p.labels[1], "2. Yes, and don't ask again for echo commands in /Users/sam/projects/a-very-long-folder-name");
  assert.equal(p.labels[2], '3. No, and tell Claude what to do differently (esc)');
  assert.equal(parseChoices('> just a prompt\nassistant: hi'), null);
  assert.equal(parseChoices(' ❯ only one choice'), null);
  const n = trustNotice('/Users/sam/code/store');
  assert.match(n, /trust \/Users\/sam\/code\/store/);
  assert.match(n, /Answer 2 \("Yes, I trust this folder"\)/);
  assert.match(n, /1 \("No, exit"\) ends it/);
  assert.match(n, /a project agent whose code lives elsewhere asks once for its repo/);
  assert.doesNotMatch(n, /no agent will ask again/);
});

test('parseChoices takes the live (lowest) list, not an answered one or a past prompt line', async () => {
  const { parseChoices } = await import('../../server/sessions.js');
  const screen = [
    '❯ need permission?',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, always',
    '   3. No',
    '',
    'assistant: permission answered (yes), done',
    ' Do you want to proceed?',
    '   1. Yes',
    '   2. Yes, always',
    ' ❯ 3. No',
  ].join('\n');
  assert.deepEqual(parseChoices(screen), { labels: ['1. Yes', '2. Yes, always', '3. No'], selected: 2 });
});
