import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { atsProblem, connectProblem } from '../../src/connect-errors';
import { ApiError } from '../../src/api';
import {
  clockTime,
  groupHome,
  hostLabel,
  isPermissionPrompt,
  maskToken,
  previewText,
  relativeTime,
  relativeTimeLong,
  sessionTitle,
  statusMeta,
} from '../../src/format';
import { parseServerUrl, type ServerAddress } from '../../src/links';
import type { Agent, Session } from '../../src/types';

const NOW = Date.parse('2026-10-22T18:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function session(over: Partial<Session>): Session {
  return {
    sid: over.sid ?? Math.random().toString(36).slice(2),
    agent: 'work',
    agent_name: 'Work',
    kind: 'domain',
    title: null,
    status: 'ready',
    model: null,
    created_at: ago(60),
    last_activity_at: ago(10),
    ended_at: null,
    notification: null,
    resumable: false,
    last_message: null,
    ...over,
  };
}

function agent(id: string, kind: Agent['kind']): Agent {
  return { id, kind, name: id, mission: '', icon: null, color: null, domain: null, live: 0, needs_you: 0, last_activity_at: null };
}

describe('session names and status', () => {
  it('uses the title, else "<Agent>: new session" (never a generic worker label)', () => {
    assert.equal(sessionTitle({ title: 'Plan the week', agent_name: 'Health', agent: 'health' }), 'Plan the week');
    assert.equal(sessionTitle({ title: '  ', agent_name: 'Health', agent: 'health' }), 'Health: new session');
    assert.equal(sessionTitle({ title: null, agent_name: '', agent: 'money' }), 'money: new session');
  });

  it('labels every status', () => {
    assert.equal(statusMeta('needs_you').label, 'Needs you');
    assert.equal(statusMeta('needs_you').tone, 'needs');
    assert.equal(statusMeta('working').tone, 'working');
    assert.equal(statusMeta('starting').tone, 'working');
    assert.equal(statusMeta('ready').tone, 'ready');
    assert.equal(statusMeta('ended').tone, 'ended');
  });

  it('spots permission prompts', () => {
    assert.equal(isPermissionPrompt('Claude needs your permission to use Bash'), true);
    assert.equal(isPermissionPrompt('Permission needed to run a script (Bash)'), true);
    assert.equal(isPermissionPrompt('Claude is waiting for your input'), false);
    assert.equal(isPermissionPrompt(null), false);
  });
});

describe('time', () => {
  it('formats compact relative times', () => {
    assert.equal(relativeTime(ago(0.2), NOW), 'now');
    assert.equal(relativeTime(ago(4), NOW), '4m');
    assert.equal(relativeTime(ago(180), NOW), '3h');
    assert.equal(relativeTime(ago(60 * 24 * 2), NOW), '2d');
    assert.match(relativeTime(ago(60 * 24 * 30), NOW), /^Sep 2[123]$/);
    assert.equal(relativeTime(null, NOW), '');
    assert.equal(relativeTime('not a date', NOW), '');
  });

  it('formats long relative times', () => {
    assert.equal(relativeTimeLong(ago(0.1), NOW), 'just now');
    assert.equal(relativeTimeLong(ago(5), NOW), '5 min ago');
    assert.equal(relativeTimeLong(ago(60 * 24), NOW), 'yesterday');
  });

  it('formats clock times', () => {
    const d = new Date(2026, 9, 22, 9, 5);
    assert.equal(clockTime(d.toISOString()), '9:05 AM');
    const e = new Date(2026, 9, 22, 0, 30);
    assert.equal(clockTime(e.toISOString()), '12:30 AM');
    const f = new Date(2026, 9, 22, 13, 0);
    assert.equal(clockTime(f.toISOString()), '1:00 PM');
  });
});

describe('home sections', () => {
  it('groups needs-you (needs_you first, then ready), live, recent (14 days) and agents', () => {
    const list = [
      session({ sid: 'r1', status: 'ready', last_activity_at: ago(1) }),
      session({ sid: 'n1', status: 'needs_you', last_activity_at: ago(30) }),
      session({ sid: 'w1', status: 'working', last_activity_at: ago(2) }),
      session({ sid: 's1', status: 'starting', last_activity_at: ago(0) }),
      session({ sid: 'e1', status: 'ended', ended_at: ago(60 * 24), last_activity_at: ago(60 * 24) }),
      session({ sid: 'e2', status: 'ended', ended_at: ago(60 * 24 * 20), last_activity_at: ago(60 * 24 * 20) }),
    ];
    const agents = [agent('proj', 'project'), agent('work', 'domain'), agent('donna', 'chief')];
    const g = groupHome(list, agents, NOW);
    assert.deepEqual(g.needsYou.map((s) => s.sid), ['n1', 'r1']);
    assert.deepEqual(g.live.map((s) => s.sid), ['s1', 'w1']);
    assert.deepEqual(g.recent.map((s) => s.sid), ['e1']);
    assert.deepEqual(g.agents.map((a) => a.id), ['donna', 'work', 'proj']);
  });
});

describe('small helpers', () => {
  it('masks tokens and labels hosts', () => {
    assert.equal(maskToken('abcdef0123456789'), '••••••••6789');
    assert.equal(maskToken(''), '');
    assert.equal(hostLabel('http://192.168.1.20:4747/'), '192.168.1.20:4747');
  });

  it('previews replies as one plain line', () => {
    assert.equal(previewText('**Done.** See [the PR](https://x.y)\n\n```js\ncode()\n```'), 'Done. See the PR [code]');
    assert.equal(previewText('x'.repeat(200), 20).length, 20);
  });
});

function addr(url: string): ServerAddress {
  const r = parseServerUrl(url);
  if (!r.ok) throw new Error(url);
  return r.address;
}

describe('connect problems', () => {
  const net = new ApiError('network', "Can't reach your computer.");
  it('explains 127.0.0.1 on a phone', () => {
    const p = connectProblem(addr('http://127.0.0.1:4747'), { ok: false, version: null, step: 'health', error: net });
    assert.match(p?.title ?? '', /127\.0\.0\.1/);
    assert.match(p?.message ?? '', /--host 0\.0\.0\.0/);
  });

  it('gives LAN and Tailscale hints', () => {
    assert.match(connectProblem(addr('http://192.168.1.5:4747'), { ok: false, version: null, step: 'health', error: net })?.message ?? '', /same Wi-Fi/);
    assert.match(connectProblem(addr('http://100.80.1.2:4747'), { ok: false, version: null, step: 'health', error: net })?.message ?? '', /Tailscale/);
  });

  it('says when the code is wrong, or the server is not Clawdling', () => {
    const auth = new ApiError('auth', 'x', { status: 401 });
    assert.match(connectProblem(addr('http://10.0.0.5:4747'), { ok: false, version: null, step: 'me', error: auth })?.title ?? '', /not accepted/);
    const html = new ApiError('bad_response', 'x');
    assert.match(connectProblem(addr('http://10.0.0.5:4747'), { ok: false, version: null, step: 'health', error: html })?.title ?? '', /isn't a Clawdling server/);
    assert.equal(connectProblem(addr('http://10.0.0.5:4747'), { ok: true, version: '1' }), null);
  });

  it('warns about iOS needing https for internet names', () => {
    assert.ok(atsProblem(addr('http://mac.tail1234.ts.net:4747')));
    assert.equal(atsProblem(addr('https://mac.tail1234.ts.net')), null);
    assert.equal(atsProblem(addr('http://192.168.1.5:4747')), null);
  });
});
