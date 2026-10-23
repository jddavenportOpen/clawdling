// The cockpit's pure helpers (web/lib): what "needs you" means, what health problems block a
// session, how folders and commands are written.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentStats, countNeedsYou, groupSessions, healthProblems, isBlocked, isYourTurn, needsYou, ok, statusText,
} from '../../web/lib/model.js';
import { cliCmd, paneKey, tildify } from '../../web/lib/util.js';

const s = (status, extra = {}) => ({ sid: `${status}-${Math.random()}`, agent: 'work', status, created_at: new Date().toISOString(), ...extra });

test('needs you = Claude asked something, or it finished a turn; a session you just opened is neither', () => {
  const asked = s('needs_you', { notification: 'Allow Bash?' });
  const turn = s('ready', { last_message: 'Done, three options.' });
  const fresh = s('ready', { last_message: null });
  assert.equal(isBlocked(asked), true);
  assert.equal(isYourTurn(turn), true);
  assert.equal(needsYou(fresh), false);
  assert.equal(needsYou(s('working')), false);
  assert.equal(needsYou(null), false);
  assert.equal(statusText(fresh), 'Ready for your first message');
  assert.match(statusText(turn), /^Your turn · Done/);
  assert.equal(countNeedsYou([asked, turn, fresh, s('working'), s('ended')]), 2);
});

test('groupSessions: a fresh ready session is Live (after working ones), not Needs you', () => {
  const asked = s('needs_you');
  const turn = s('ready', { last_message: 'x' });
  const fresh = s('ready');
  const working = s('working');
  const g = groupSessions([fresh, turn, working, asked]);
  assert.deepEqual(g.needs, [asked, turn]);
  assert.deepEqual(g.live, [working, fresh]);
});

test('agentStats splits blocked from your turn, and needs is their sum', () => {
  const list = [s('needs_you'), s('ready', { last_message: 'x' }), s('ready'), s('starting'), s('ended'), { ...s('needs_you'), agent: 'home' }];
  assert.deepEqual(agentStats('work', list), { live: 4, blocked: 1, turn: 1, needs: 2, working: 1 });
  assert.deepEqual(agentStats('nobody', list), { live: 0, blocked: 0, turn: 0, needs: 0, working: 0 });
});

test('healthProblems: every failed check in /api/health, unless it is optional', () => {
  const health = {
    ok: true,
    version: '1.0.0',
    home: '/Users/ada/clawdling',
    cli: 'clawdling',
    tmux: { ok: true, version: 'tmux 3.5a' },
    claude: { ok: false, version: null, error: 'claude not found on PATH' },
    backend: { ok: false, error: 'neither tmux nor the PTY backend is available' },
    extra: { ok: false, optional: true },
    list: [{ ok: false }],
  };
  assert.deepEqual(healthProblems(health).map((p) => p.id), ['claude', 'backend']);
  assert.equal(healthProblems(health)[0].error, 'claude not found on PATH');
  assert.deepEqual(healthProblems(null), []);
  assert.deepEqual(healthProblems({ tmux: { ok: true }, claude: { ok: 'true' } }), []);
  assert.equal(ok({ ok: true }), true);
  assert.equal(ok({ ok: false }), false);
  assert.equal(ok(undefined), false);
});

test('tildify writes the home folder as ~ on macOS, Linux and Windows', () => {
  assert.equal(tildify('/Users/ada/clawdling/domains/work'), '~/clawdling/domains/work');
  assert.equal(tildify('/home/ada/clawdling'), '~/clawdling');
  assert.equal(tildify('/Users/ada'), '~');
  assert.equal(tildify('C:\\Users\\ada\\clawdling'), '~\\clawdling');
  assert.equal(tildify('/opt/clawdling'), '/opt/clawdling');
  assert.equal(tildify('/Users/adam2x'), '~');
  assert.equal(tildify(''), '');
  assert.equal(tildify(null), '');
});

test('cliCmd spells commands the way the server says this computer runs Clawdling', () => {
  assert.equal(cliCmd('open', { cli: 'node ~/clawdling/bin/clawdling.js' }), 'node ~/clawdling/bin/clawdling.js open');
  assert.equal(cliCmd('open', { cli: 'clawdling --home ~/org' }), 'clawdling --home ~/org open');
  assert.equal(cliCmd('open', null), 'clawdling open'); // no server answer yet: the documented default
  assert.equal(cliCmd('', { cli: 'clawdling' }), 'clawdling');
  assert.match(paneKey(2), /^(⌥2|Alt\+2)$/);
});
