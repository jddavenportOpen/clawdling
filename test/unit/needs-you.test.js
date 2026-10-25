// "An agent needs you": the message, the channel it goes to, the delay and the rate limits
// (needs-you.js), and the browser notification's rules (web/lib/notify.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NeedsYouPinger, pingChannel, pingText } from '../../server/needs-you.js';

test('pingText: the agent and the kind of wait, nothing from the conversation', () => {
  assert.equal(pingText({ agentName: 'Health', waitingOn: 'permission_prompt', asking: { kind: 'question' } }), 'Clawdling: Health needs you (a question). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work', waitingOn: 'permission_prompt', asking: { kind: 'plan' } }), 'Clawdling: Work needs you (a plan to approve). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work', waitingOn: 'permission_prompt' }), 'Clawdling: Work needs you (a permission). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work', waitingOn: 'error' }), 'Clawdling: Work needs you (an error). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work\nInjected', waitingOn: 'something-new' }), 'Clawdling: Work Injected needs you. Open the cockpit to answer.');
});

test('pingChannel: only a paired, enabled channel; Telegram first', () => {
  const tg = { enabled: true, chat_id: 7 };
  const im = { enabled: true, handle: 'owner@example.test' };
  assert.deepEqual(pingChannel({ channels: { telegram: tg, imessage: im } }), { channel: 'telegram', to: 7 });
  assert.deepEqual(pingChannel({ channels: { telegram: { enabled: true, chat_id: null }, imessage: im } }), { channel: 'imessage', to: 'owner@example.test' });
  assert.deepEqual(pingChannel({ channels: { telegram: tg, imessage: im } }, { telegramReady: false }), { channel: 'imessage', to: 'owner@example.test' });
  assert.equal(pingChannel({ channels: { telegram: { enabled: false, chat_id: 7 }, imessage: { enabled: true, handle: null } } }), null);
  assert.equal(pingChannel({}), null);
});

function harness({ enabled = true, now = { t: 1000000 } } = {}) {
  const org = { notify: { needs_you: enabled }, channels: { telegram: { enabled: true, chat_id: 9 }, imessage: { enabled: false } } };
  const recs = new Map();
  const sent = [];
  const p = new NeedsYouPinger({
    org: { read: () => org, update: (fn) => fn(org) },
    sessions: { get: (sid) => recs.get(sid) || null },
    telegram: { token: () => 'x', blocked: null, reply: async (to, text) => sent.push([to, text]) },
    imessage: { supported: () => false },
    now: () => now.t,
    delayMs: 0,
  });
  return { org, recs, sent, p, now };
}

test('NeedsYouPinger: off by default, still waiting after the delay, once per session per 10 minutes, six an hour', async () => {
  const h = harness({ enabled: false });
  h.recs.set('a', { sid: 'a', agent: 'work', agent_name: 'Work', status: 'needs_you', waiting_on: 'permission_prompt' });
  assert.deepEqual(await h.p.check('a'), { sent: false, why: 'off' });
  h.p.setEnabled(true);
  assert.equal(h.org.notify.needs_you, true);
  assert.equal((await h.p.check('a')).sent, true);
  assert.deepEqual(h.sent, [[9, 'Clawdling: Work needs you (a permission). Open the cockpit to answer.']]);
  assert.equal((await h.p.check('a')).why, 'rate (session)');
  h.now.t += 10 * 60000;
  assert.equal((await h.p.check('a')).sent, true);
  // Answered before the check: nothing.
  h.recs.set('b', { sid: 'b', agent: 'work', status: 'working' });
  assert.equal((await h.p.check('b')).why, 'answered');
  // Six an hour in all.
  for (let i = 0; i < 6; i++) h.recs.set(`s${i}`, { sid: `s${i}`, agent: 'work', status: 'needs_you' });
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await h.p.check(`s${i}`)).sent);
  assert.deepEqual(results, [true, true, true, true, false, false]);
  assert.equal((await h.p.check('s5')).why, 'rate (hour)');
  // onNeedsYou does nothing while off, and schedules one check while on.
  h.p.setEnabled(false);
  h.p.onNeedsYou(h.recs.get('s5'));
  assert.equal(h.p.timers.size, 0);
  h.p.setEnabled(true);
  h.p.onNeedsYou(h.recs.get('s5'));
  h.p.onNeedsYou(h.recs.get('s5'));
  assert.equal(h.p.timers.size, 1);
  h.p.stop();
});

test('browser notification: only when the tab is hidden, the setting is on, and the session just started needing you', async () => {
  const shown = [];
  const store = new Map();
  globalThis.window = {
    Notification: class { constructor(title, opts) { shown.push([title, opts]); } static permission = 'granted'; },
    focus() {},
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  };
  globalThis.document = { hidden: true };
  const { maybeNotify } = await import('../../web/lib/notify.js');
  const prefs = await import('../../web/lib/prefs.js');
  prefs.save('notifyNeedsYou', true);
  const next = { sid: 'n1', agent: 'health', agent_name: 'Health', status: 'needs_you', notification: 'Claude asks: Which color?' };
  assert.equal(maybeNotify({ ...next, status: 'working' }, next), true);
  assert.deepEqual(shown[0], ['Health needs you', { body: 'Claude asks: Which color?', tag: 'clawdling-n1' }]);
  assert.equal(maybeNotify({ ...next, status: 'working' }, next), false, 'once a minute per session');
  assert.equal(maybeNotify(next, { ...next, sid: 'n2' }), false, 'already needing you: no new notification');
  globalThis.document.hidden = false;
  assert.equal(maybeNotify({ sid: 'n3', status: 'ready' }, { ...next, sid: 'n3' }), false, 'the tab is in front');
  globalThis.document.hidden = true;
  prefs.save('notifyNeedsYou', false);
  assert.equal(maybeNotify({ sid: 'n4', status: 'ready' }, { ...next, sid: 'n4' }), false, 'off');
  delete globalThis.window;
  delete globalThis.document;
});
