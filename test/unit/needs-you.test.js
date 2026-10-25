// "An agent needs you": the message, the channel it goes to, the delay and the rate limits
// (needs-you.js), and the browser notification's rules (web/lib/notify.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameSender } from '../../server/channels/imessage.js';
import { NeedsYouPinger, pingChannel, pingText, safeName } from '../../server/needs-you.js';

test('pingText: the agent and the kind of wait, nothing from the conversation', () => {
  assert.equal(pingText({ agentName: 'Health', waitingOn: 'permission_prompt', asking: { kind: 'question' } }), 'Clawdling: Health needs you (a question). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work', waitingOn: 'permission_prompt', asking: { kind: 'plan' } }), 'Clawdling: Work needs you (a plan to approve). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work', waitingOn: 'permission_prompt' }), 'Clawdling: Work needs you (a permission). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work', waitingOn: 'error' }), 'Clawdling: Work needs you (an error). Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work\nInjected', waitingOn: 'something-new' }), 'Clawdling: Work Injected needs you. Open the cockpit to answer.');
  assert.equal(pingText({ agentName: 'Work', waitingOn: 'constructor', asking: { kind: '__proto__' } }), 'Clawdling: Work needs you. Open the cockpit to answer.');
});

test('pingChannel: only the chat that sent the pairing code, or an iMessage handle that texted Donna; Telegram first', () => {
  const tg = { enabled: true, chat_id: 7 };
  const im = { enabled: true, handle: 'owner@example.test' };
  const both = { channels: { telegram: tg, imessage: im } };
  assert.deepEqual(pingChannel(both, { pairedChatId: 7, verifiedHandle: 'owner@example.test' }), { channel: 'telegram', to: 7 });
  // org.json says chat 8 (an agent could have written that): not the paired chat, so not Telegram.
  assert.deepEqual(pingChannel({ channels: { telegram: { enabled: true, chat_id: 8 }, imessage: im } }, { pairedChatId: 7, verifiedHandle: 'owner@example.test' }), { channel: 'imessage', to: 'owner@example.test' });
  assert.equal(pingChannel({ channels: { telegram: { enabled: true, chat_id: 8 } } }, { pairedChatId: 7 }), null);
  assert.equal(pingChannel({ channels: { telegram: tg } }, { pairedChatId: null }), null);
  assert.deepEqual(pingChannel(both, { pairedChatId: 7, verifiedHandle: 'owner@example.test', telegramReady: false }), { channel: 'imessage', to: 'owner@example.test' });
  // An iMessage handle that never texted Donna (a typo, or someone else's number) gets nothing.
  assert.equal(pingChannel({ channels: { imessage: im } }, { verifiedHandle: null }), null);
  assert.equal(pingChannel({ channels: { imessage: { enabled: true, handle: 'other@example.test' } } }, { verifiedHandle: 'owner@example.test' }), null);
  assert.equal(pingChannel({ channels: { telegram: { enabled: false, chat_id: 7 }, imessage: { enabled: true, handle: null } } }, { pairedChatId: 7 }), null);
  assert.equal(pingChannel({}), null);
});

test('safeName: plain words only, 40 characters', () => {
  assert.equal(safeName('Health'), 'Health');
  assert.equal(safeName('Q3 <b>secret</b> plan: http://x.example/?a=1'), 'Q3 b secret b plan http x example a 1', 'no link survives');
  assert.equal(safeName('My-Project'), 'My-Project');
  assert.equal(safeName('Zoë & Ana'), 'Zoë Ana');
  assert.equal(safeName('x'.repeat(90)).length, 40);
  assert.equal(safeName('\u202e\n'), 'An agent');
});

test('sameSender: the whole number with its country code (or the address), not just its last 10 digits', () => {
  assert.equal(sameSender('+12025550123', '202 555 0123'), false, 'a phone number needs its country code');
  assert.equal(sameSender('+442025550123', '2025550123'), false);
  assert.equal(sameSender('+12025550123', '+1 (202) 555-0123'), true);
  assert.equal(sameSender('+442025550123', '+1 202 555 0123'), false);
  assert.equal(sameSender('+12025550123', '+44 20 2555 0123'), false);
  assert.equal(sameSender('Owner@Example.test', 'owner@example.test'), true);
  assert.equal(sameSender('owner@example.test', 'other@example.test'), false);
});

function harness({ now = { t: 1000000 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ping-'));
  const paths = { notify: path.join(dir, 'notify.json') };
  const org = { channels: { telegram: { enabled: true, chat_id: 9 }, imessage: { enabled: false } } };
  const recs = new Map();
  const sent = [];
  let tgState = { paired_chat_id: 9 };
  const make = () => new NeedsYouPinger({
    paths,
    org: { read: () => org },
    sessions: { get: (sid) => recs.get(sid) || null },
    telegram: { token: () => 'x', blocked: null, state: () => tgState, saveState: (s) => { tgState = s; }, reply: async (to, text) => sent.push([to, text]) },
    imessage: { supported: () => false, verifiedHandle: () => null },
    now: () => now.t,
    delayMs: 0,
  });
  return { dir, paths, org, recs, sent, p: make(), make, now };
}

test('NeedsYouPinger: off by default, still waiting after the delay, once per session per 10 minutes, six an hour, across restarts', async () => {
  const h = harness();
  h.recs.set('a', { sid: 'a', agent: 'work', agent_name: 'Work', status: 'needs_you', waiting_on: 'permission_prompt' });
  assert.deepEqual(await h.p.check('a'), { sent: false, why: 'off' });
  h.p.setEnabled(true);
  assert.equal(JSON.parse(fs.readFileSync(h.paths.notify, 'utf8')).needs_you, true);
  assert.equal((await h.p.check('a')).sent, true);
  assert.deepEqual(h.sent, [[9, 'Clawdling: Work needs you (a permission). Open the cockpit to answer.']]);
  assert.equal((await h.p.check('a')).why, 'rate (session)');
  assert.equal((await h.make().check('a')).why, 'rate (session)', 'a restart keeps the limit');
  h.now.t += 10 * 60000;
  assert.equal((await h.p.check('a')).sent, true);
  h.recs.set('b', { sid: 'b', agent: 'work', status: 'working' });
  assert.equal((await h.p.check('b')).why, 'answered');
  for (let i = 0; i < 6; i++) h.recs.set(`s${i}`, { sid: `s${i}`, agent: 'work', status: 'needs_you' });
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await h.make().check(`s${i}`)).sent); // a new instance each time: a restart loop
  assert.deepEqual(results, [true, true, true, true, false, false]);
  // The pairing record is not the chat in org.json: nothing.
  h.org.channels.telegram.chat_id = 10;
  h.now.t += 2 * 3600000;
  assert.equal((await h.p.check('s5')).why, 'no paired channel');
  h.org.channels.telegram.chat_id = 9;
  h.p.setEnabled(false);
  h.p.onNeedsYou(h.recs.get('s5'));
  assert.equal(h.p.timers.size, 0);
  h.p.setEnabled(true);
  h.p.onNeedsYou(h.recs.get('s5'));
  h.p.onNeedsYou(h.recs.get('s5'));
  assert.equal(h.p.timers.size, 1);
  h.p.stop();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('fails closed where agents cannot be kept out of .clawdling (a folder path with ( ) or accents)', () => {
  const p = new NeedsYouPinger({ paths: { home: "/Users/O'Brien (Work)/org", notify: '/nonexistent/notify.json' }, org: { read: () => ({ channels: {} }) }, platform: 'darwin' });
  assert.equal(p.guarded(), false);
  assert.throws(() => p.setEnabled(true), (e) => e.status === 400);
  assert.equal(p.status().unprotected, true);
  assert.equal(new NeedsYouPinger({ paths: { home: '/Users/ada/org' }, org: { read: () => ({}) }, platform: 'darwin' }).guarded(), true);
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
  assert.deepEqual(shown[0], ['Health needs you', { body: 'Waiting on you. Open the cockpit to answer.', tag: 'clawdling-n1' }], 'never the question itself');
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
