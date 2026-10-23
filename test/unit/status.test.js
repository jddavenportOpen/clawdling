import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOOK_EVENTS, LOGIN_NOTICE, applyHookEvent, buildHooksSettings, stopFailureNotice, supportsStopFailure } from '../../server/hooks.js';

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

test('auth_success and idle notices on a finished turn do not change status; a question does', () => {
  const r = rec({ status: 'ready', last_message: 'done' });
  assert.equal(applyHookEvent(r, 'Notification', { notification_type: 'auth_success', message: 'ok' }).statusChanged, false);
  // Real Claude Code sends this a minute after every finished turn: it is still "your turn".
  assert.equal(applyHookEvent(r, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).statusChanged, false);
  assert.equal(r.status, 'ready');
  assert.equal(r.waiting_on ?? null, null);
  applyHookEvent(r, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(r.status, 'needs_you');
  // An idle notice while working (no Stop seen) still says Claude is waiting on you.
  const w = rec({ status: 'working' });
  applyHookEvent(w, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.equal(w.status, 'needs_you');
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

test('a Claude Code that is not signed in is recognised at startup, not after a 20 s stall (P1-13)', async () => {
  const { dialogFromScreen, LOGIN_NOTICE, STALL_NOTICE } = await import('../../server/sessions.js');
  // Claude Code 2.1.283's own strings: first-run setup, the login list, and the sign-in errors.
  const login = ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.\n\n Select login method:\n\n ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise\n   2. Anthropic Console account · API usage billing';
  for (const screen of [login, " Let's get started.\n\n Choose the text style that looks best with your terminal", '> hi\n  ⎿  Not logged in · Please run /login', 'Invalid API key · Please run /login']) {
    const d = dialogFromScreen(screen);
    assert.equal(d && d.waiting, 'login', screen);
    assert.equal(d.notice, LOGIN_NOTICE);
  }
  assert.match(LOGIN_NOTICE, /isn't signed in yet\. Click Sign in/);
  assert.doesNotMatch(LOGIN_NOTICE, /Open a terminal/, 'the cockpit Sign in comes first (1.1.1)');
  assert.match(STALL_NOTICE, /sign in/);
  assert.equal(dialogFromScreen('Welcome to Claude Code\n> how do I log in to my bank?'), null);
});

test('signing in from the pane clears the login wait once Claude Code starts', () => {
  const r = rec({ status: 'needs_you', waiting_on: 'login', notification: 'not signed in' });
  applyHookEvent(r, 'SessionStart', { source: 'startup' });
  assert.equal(r.status, 'ready');
  assert.equal(r.waiting_on, null);
});

test('a turn that ends on an API error (StopFailure) says why instead of Working forever (D11)', () => {
  // Not signed in: the payload real Claude Code 2.1.283 sends (captured 2026-10-23).
  const a = rec({ status: 'working' });
  applyHookEvent(a, 'StopFailure', { hook_event_name: 'StopFailure', error: 'authentication_failed', last_assistant_message: 'Not logged in · Please run /login' });
  assert.equal(a.status, 'needs_you');
  assert.equal(a.waiting_on, 'login');
  assert.equal(a.notification, LOGIN_NOTICE);
  assert.equal(a.last_message, 'Not logged in · Please run /login');
  // A minute later Claude Code's idle notice must not replace the reason.
  applyHookEvent(a, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.equal(a.waiting_on, 'login');
  assert.equal(a.notification, LOGIN_NOTICE);
  // Signed in from inside the session (/login): your turn again.
  applyHookEvent(a, 'Notification', { notification_type: 'auth_success', message: 'Login successful' });
  assert.equal(a.status, 'ready');
  assert.equal(a.waiting_on, null);

  // A usage limit: what failed, the details, and that sending again retries.
  const r = rec({ status: 'working' });
  applyHookEvent(r, 'StopFailure', { error: 'rate_limit', error_details: "You've hit your limit · resets 3pm" });
  assert.equal(r.status, 'needs_you');
  assert.equal(r.waiting_on, 'error');
  assert.equal(r.notification, "Claude Code stopped: your Claude plan hit a usage or rate limit: You've hit your limit · resets 3pm. Send your message again to retry.");
  applyHookEvent(r, 'UserPromptSubmit', { prompt: 'try again' });
  assert.equal(r.status, 'working');
  assert.equal(r.notification, null);
  // An error Clawdling has no words for still says what it was.
  assert.equal(stopFailureNotice('something_new'), 'Claude Code stopped: the turn failed (something_new). Send your message again to retry.');
});

test('an idle notice never replaces an open question (its buttons stay)', () => {
  const r = rec({ status: 'needs_you', waiting_on: 'permission_prompt', notification: 'Claude needs your permission to use Bash' });
  assert.equal(applyHookEvent(r, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).statusChanged, false);
  assert.equal(r.waiting_on, 'permission_prompt');
  assert.equal(r.notification, 'Claude needs your permission to use Bash');
});

test('StopFailure is registered only for a Claude Code that has it (2.1.229+)', () => {
  assert.ok(HOOK_EVENTS.includes('StopFailure'), 'the server accepts it');
  for (const v of ['2.1.229 (Claude Code)', '2.1.283 (Claude Code)', '2.2.0', '3.0.1 (Claude Code)']) assert.equal(supportsStopFailure(v), true, v);
  for (const v of ['2.1.228 (Claude Code)', '2.0.999', '1.9.0', '', null, 'claude: command not found']) assert.equal(supportsStopFailure(v), false, String(v));
  const args = { nodePath: '/usr/bin/node', hookScript: '/app/bin/clawdling-hook.js', platform: 'linux' };
  assert.deepEqual(Object.keys(buildHooksSettings(args).hooks), ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']);
  const withIt = buildHooksSettings({ ...args, stopFailure: true }).hooks;
  assert.ok(withIt.StopFailure[0].hooks[0].command.endsWith(" 'StopFailure'") || withIt.StopFailure[0].hooks[0].command.endsWith(' StopFailure'), withIt.StopFailure[0].hooks[0].command);
});
