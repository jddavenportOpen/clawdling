// POST /api/sessions/:sid/answer: answer Claude Code's own questions (folder trust, permission
// prompts) safely from the cockpit or the phone, by moving the pointer like a person would.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cli, killTmux, openViewer, request, rmrf, startServerProc, tempHome, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let srv;
let repo;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  repo = tempHome('cl-outside-repo-');
  const env = testEnv({ CLAWDLING_TMUX_SOCKET: socket });
  cli(['init', '--defaults'], { env, home });
  cli(['new', 'project', 'Store', '--goal', 'Ship the store', '--repo', repo], { env, home });
  fs.writeFileSync(path.join(repo, '.fake-claude-trust'), ''); // code outside the org: Claude Code asks
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
  rmrf(repo);
});

const get = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body;
const until = (sid, pred, label) =>
  waitFor(async () => {
    const s = await get(sid);
    return pred(s) ? s : null;
  }, { label, timeout: 15000 });

test('folder trust for a project whose repo is outside the org: plain notice, choices, answer 2 starts it', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'store' })).body;
  assert.equal(s.cwd, repo);
  const q = await until(s.sid, (x) => x.status === 'needs_you', 'trust question');
  assert.equal(q.waiting_on, 'trust');
  assert.ok(q.notification.includes(`trust ${repo}`), q.notification);
  assert.match(q.notification, /Answer 2 \("Yes, I trust this folder"\)/);
  assert.deepEqual(q.choices, [{ option: 1, label: 'No, exit' }, { option: 2, label: 'Yes, I trust this folder' }]);

  // Typed text (Donna, the CLI) can never land in the dialog: Enter would choose "No, exit".
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'hello' })).status, 409);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 3 })).status, 400);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 'yes' })).status, 400);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, {})).status, 400);

  const r = await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 2 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.answered, { option: 2, label: 'Yes, I trust this folder' });
  const ready = await until(s.sid, (x) => x.status === 'ready', 'ready after trusting');
  assert.equal(ready.choices, null);
  assert.equal(ready.notification, null);
  assert.equal((await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 1 })).status, 409, 'nothing to answer now');
});

test('answering 1 ("No, exit") ends the session', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'store' })).body;
  await until(s.sid, (x) => x.status === 'needs_you' && x.waiting_on === 'trust', 'trust question');
  const r = await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.answered.label, 'No, exit');
  await until(s.sid, (x) => x.status === 'ended', 'ended');
});

test('permission prompts: numbered choices, answered by option', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  await until(s.sid, (x) => x.status === 'ready', 'ready');
  const v = await openViewer(srv, s.sid);
  try {
    await v.next((m) => m.t === 'snapshot');
    for (const [option, word] of [[1, 'yes'], [3, 'no']]) {
      v.send({ t: 'in', data: 'need permission?\r' });
      const q = await until(s.sid, (x) => x.status === 'needs_you' && Array.isArray(x.choices), 'permission choices');
      assert.equal(q.waiting_on, 'permission_prompt');
      assert.match(q.notification, /permission/);
      assert.deepEqual(q.choices.map((c) => c.option), [1, 2, 3]);
      assert.equal(q.choices[0].label, '1. Yes');
      const r = await request(srv, 'POST', `/api/sessions/${s.sid}/answer`, { option });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.status, 'working');
      const done = await until(s.sid, (x) => x.status === 'ready' && x.last_message === `permission answered (${word}), done`, `answered ${word}`);
      assert.equal(done.waiting_on, null);
    }
  } finally {
    v.close();
  }
});
