import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemoClient, SAMPLE, deriveTitle, materialize } from '../../src/demo/demo';
import { SESSION_STATUSES } from '../../src/types';

const NOW = Date.parse('2026-10-22T18:00:00.000Z');

/** Runs scheduled callbacks only when asked, so tests control "later". */
function manualClock() {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => void queue.push(fn),
    flush: () => {
      while (queue.length) queue.shift()?.();
    },
  };
}

describe('demo data integrity', () => {
  it('every session belongs to a known agent and has a real title', () => {
    const ids = new Set(SAMPLE.agents.map((a) => a.id));
    for (const s of SAMPLE.sessions) {
      assert.ok(ids.has(s.agent), `unknown agent ${s.agent}`);
      assert.ok(s.title.trim().length > 3, `untitled session ${s.sid}`);
      assert.ok((SESSION_STATUSES as readonly string[]).includes(s.status), `bad status ${s.status}`);
      assert.match(s.sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      if (s.status === 'ended') assert.equal(typeof s.endedMinutesAgo, 'number', `${s.sid} ended without a time`);
      if (s.status === 'needs_you') assert.ok(s.notification, `${s.sid} needs you without saying why`);
      assert.ok(s.messages.length > 0);
      assert.equal(s.messages[0].role, 'user', 'a session starts with the task');
    }
    assert.equal(new Set(SAMPLE.sessions.map((s) => s.sid)).size, SAMPLE.sessions.length, 'session ids are unique');
  });

  it('covers every screen state: needs you, ready, working and ended', () => {
    const statuses = new Set(SAMPLE.sessions.map((s) => s.status));
    for (const st of ['needs_you', 'ready', 'working', 'ended']) assert.ok(statuses.has(st as never), `no ${st} session`);
    assert.equal(SAMPLE.agents.filter((a) => a.kind === 'chief').length, 1, 'exactly one chief of staff');
    assert.ok(SAMPLE.agents.some((a) => a.kind === 'project'));
    assert.ok(SAMPLE.donna.some((d) => d.channel === 'telegram'), 'shows Donna on another channel');
  });

  it('project agents point at a real domain', () => {
    const domains = new Set(SAMPLE.agents.filter((a) => a.kind === 'domain').map((a) => a.id));
    for (const a of SAMPLE.agents.filter((x) => x.kind === 'project')) assert.ok(!a.domain || domains.has(a.domain));
  });

  it('message times move forward and never sit in the future', () => {
    const st = materialize(NOW);
    for (const s of st.sessions) {
      const msgs = st.messages[s.sid];
      for (let i = 1; i < msgs.length; i++) {
        assert.ok(Date.parse(msgs[i].ts ?? '') >= Date.parse(msgs[i - 1].ts ?? ''), `${s.sid} messages out of order`);
        assert.equal(msgs[i].n, msgs[i - 1].n + 1);
      }
      assert.ok(Date.parse(s.last_activity_at ?? '') <= NOW);
    }
  });

  it('contains no personal data: generic owner, no paths outside the org', () => {
    const text = JSON.stringify(SAMPLE);
    assert.ok(!/davenport|jddavenport|\/Users\/|@gmail/i.test(text));
  });
});

describe('DemoClient', () => {
  it('answers a sent message after a moment and goes back to ready', async () => {
    const clock = manualClock();
    const c = new DemoClient({ now: () => NOW, schedule: clock.schedule });
    const sid = SAMPLE.sessions.find((s) => s.status === 'ready')!.sid;
    const before = await c.messages(sid);
    await c.send(sid, 'Add a stretching day');
    let page = await c.messages(sid, { after: before.next });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].role, 'user');
    assert.equal(page.status, 'working');
    clock.flush();
    page = await c.messages(sid, { after: before.next });
    assert.equal(page.messages.length, 2);
    assert.equal(page.messages[1].role, 'assistant');
    assert.match(page.messages[1].text, /demo/i);
    assert.equal(page.status, 'ready');
  });

  it('refuses to type into a permission prompt, like the server', async () => {
    const c = new DemoClient({ now: () => NOW, schedule: () => {} });
    const sid = SAMPLE.sessions.find((s) => s.status === 'needs_you')!.sid;
    const s = await c.session(sid);
    assert.equal(s.waiting_on, 'permission_prompt');
    await assert.rejects(c.send(sid, 'yes'), /answer it in the cockpit/);
  });

  it('pages messages like the server: from the start, with more', async () => {
    const c = new DemoClient({ now: () => NOW, schedule: () => {} });
    const sid = SAMPLE.sessions.find((s) => s.status === 'working')!.sid;
    const first = await c.messages(sid, { limit: 2 });
    assert.deepEqual(first.messages.map((m) => m.n), [0, 1]);
    assert.equal(first.more, true);
    const rest = await c.messages(sid, { after: first.next, limit: 50 });
    assert.equal(rest.more, false);
    assert.equal(rest.messages[0].n, 2);
  });

  it('refuses to send to an ended session until it is resumed', async () => {
    const c = new DemoClient({ now: () => NOW, schedule: () => {} });
    const ended = SAMPLE.sessions.find((s) => s.status === 'ended')!.sid;
    await assert.rejects(c.send(ended, 'hi'), /resume/);
    const s = await c.resume(ended);
    assert.equal(s.status, 'ready');
    await c.send(ended, 'hi');
  });

  it('starts a titled session from a first message', async () => {
    const clock = manualClock();
    const c = new DemoClient({ now: () => NOW, schedule: clock.schedule });
    const s = await c.createSession({ agent: 'money', prompt: 'Find every subscription I pay for. Then rank them.' });
    assert.equal(s.title, 'Find every subscription I pay for');
    assert.equal(s.status, 'working');
    const all = await c.sessions();
    assert.equal(all[0].sid, s.sid);
    await assert.rejects(c.createSession({ agent: 'nope' }), /No such agent/);
  });

  it('Donna routes a request to the agent it names', async () => {
    const clock = manualClock();
    const c = new DemoClient({ now: () => NOW, schedule: clock.schedule });
    const reply = c.donnaChat('Ask health to book a physio appointment');
    clock.flush();
    const r = await reply;
    assert.match(r.reply, /^Health is on it/);
    const sessions = await c.sessions();
    assert.equal(sessions[0].agent, 'health');
    const log = await c.donnaMessages();
    assert.deepEqual(log.slice(-2).map((m) => m.role), ['user', 'donna']);
  });

  it('org counts live and needs-you sessions per agent', async () => {
    const c = new DemoClient({ now: () => NOW, schedule: () => {} });
    const o = await c.org();
    const money = o.agents.find((a) => a.id === 'money')!;
    assert.equal(money.live, 1);
    assert.equal(money.needs_you, 1);
    assert.equal(o.org.name, "Alex's org");
  });

  it('derives titles the way the server does', () => {
    assert.equal(deriveTitle('fix the **login** bug. it 500s'), 'Fix the login bug');
    assert.equal(deriveTitle('see https://example.com now'), 'See now');
    assert.ok(deriveTitle('a'.repeat(80)).length <= 48);
    assert.equal(deriveTitle('   '), '');
  });
});
