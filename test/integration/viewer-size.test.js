// The first snapshot is cut at the viewer's size, and a viewer that changes size gets a fresh one.
// Regression: a session started at 200x60 (CLI / Donna) opened in an 80x24 pane showed a blank
// screen, because the 60-row snapshot pushed the real content into scrollback.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { stripAnsi } from '../../server/util.js';
import path from 'node:path';
import { BACKEND, cli, killTmux, openViewer, request, rmrf, sleep, startServerProc, tempHome, terminalSize, testEnv, uniqueSocket, waitFor } from '../helpers.mjs';

let home;
let socket;
let env;
let srv;
let fakeLog;

before(async () => {
  home = tempHome();
  socket = uniqueSocket();
  fakeLog = path.join(home, 'fake-claude.log');
  env = testEnv({ CLAWDLING_TMUX_SOCKET: socket, FAKE_CLAUDE_LOG: fakeLog });
  cli(['init', '--defaults'], { env, home });
  srv = await startServerProc({ home, env });
});

after(async () => {
  await srv?.stop();
  killTmux(socket);
  rmrf(home);
});

// The session's terminal size. tmux: read at once from tmux (the resize must be done before the
// snapshot goes out). pty: what the fake claude logged when SIGWINCH reached it, a moment later.
const sizeNow = (s) => terminalSize({ socket, fakeLog }, s);
const windowSize = async (s) => (BACKEND === 'tmux' ? sizeNow(s) : waitFor(() => sizeNow(s), { label: 'terminal size', timeout: 5000 }));
const sizeBecomes = async (s, want) => {
  if (BACKEND === 'tmux') return sizeNow(s);
  return waitFor(() => sizeNow(s) === want, { label: `size ${want}`, timeout: 5000 }).then(() => want, () => sizeNow(s));
};

/**
 * Lay the snapshot out the way a cols x rows terminal would: capture-pane -J joins soft-wrapped
 * rows, so one line can take several rows, and everything above the last `rows` rows is
 * scrollback. Returns what is on screen and where the last non-empty row lands.
 */
function layout(snapshot, cols, rows) {
  const out = [];
  for (const line of stripAnsi(snapshot).split('\r\n')) {
    const chars = [...line];
    if (!chars.length) out.push('');
    for (let i = 0; i < chars.length; i += cols) out.push(chars.slice(i, i + cols).join(''));
  }
  let last = -1;
  out.forEach((r, i) => {
    if (r.trim()) last = i;
  });
  return { total: out.length, fromBottom: out.length - 1 - last, screen: out.slice(-rows).join('\n') };
}

test('a 200x60 session opened in an 80x24 viewer: snapshot cut at 80x24, content on screen', async () => {
  const out = cli(['spawn', 'work', 'hello from the cli', '--cols', '200', '--rows', '60'], { env, home });
  const sid = out.match(/session ([0-9a-f-]{36})/)[1];
  const s = (await request(srv, 'GET', `/api/sessions/${sid}`)).body;
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${sid}`)).body.status === 'ready', { label: 'ready' });
  assert.equal(await windowSize(s), '200x60');

  const v = await openViewer(srv, sid, { query: 'cols=80&rows=24' });
  try {
    const snap = await v.next((m) => m.t === 'snapshot');
    assert.equal(v.messages.indexOf(snap), 0, 'the snapshot is the first message');
    const l = layout(snap.data, 80, 24);
    assert.ok(l.fromBottom < 24, `last non-empty row is ${l.fromBottom} rows above the bottom of ${l.total}: off screen in a 24-row terminal`);
    assert.match(l.screen, /assistant: hello from the cli/, 'the conversation is on screen, not in scrollback');
    assert.match(l.screen, /^> ?$/m, 'the prompt line is on screen');
    assert.equal(await sizeBecomes(s, '80x24'), '80x24', 'the window was resized before the snapshot');

    // An explicit resize to a new size → a fresh snapshot cut at the new size.
    v.send({ t: 'resize', cols: 100, rows: 30 });
    const snap2 = await v.next((m) => m.t === 'snapshot' && m !== snap);
    assert.equal(await sizeBecomes(s, '100x30'), '100x30');
    const l2 = layout(snap2.data, 100, 30);
    assert.ok(l2.fromBottom < 30);
    assert.match(l2.screen, /assistant: hello from the cli/);

    // The same size again (clients resend on every layout pass): no new snapshot.
    const count = v.messages.filter((m) => m.t === 'snapshot').length;
    v.send({ t: 'resize', cols: 100, rows: 30 });
    await sleep(600);
    assert.equal(v.messages.filter((m) => m.t === 'snapshot').length, count);

    // Live output keeps flowing after the fresh snapshot.
    v.send({ t: 'in', data: 'still here\r' });
    await v.waitOutput(/assistant: still here/);
  } finally {
    v.close();
  }

  // Out-of-range sizes are ignored: the snapshot is cut at the current window size.
  const v2 = await openViewer(srv, sid, { query: 'cols=5&rows=9999' });
  try {
    const snap = await v2.next((m) => m.t === 'snapshot');
    assert.equal(await windowSize(s), '100x30');
    assert.match(layout(snap.data, 100, 30).screen, /assistant: hello from the cli/);
  } finally {
    v2.close();
  }
});

test('a late SessionStart does not flip a resumed, working session to ready', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'money', prompt: 'first' })).body;
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status === 'ready', { label: 'ready' });
  await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
  const r = await request(srv, 'POST', `/api/sessions/${s.sid}/resume`);
  assert.equal(r.status, 200, r.text);
  await waitFor(async () => (await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status === 'ready', { label: 'resumed and ready' });
  const hook = (event, payload) => request(srv, 'POST', '/api/hooks', { event, sid: s.sid, payload });
  assert.equal((await hook('UserPromptSubmit', { prompt: 'keep going' })).status, 204);
  assert.equal((await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status, 'working');
  assert.equal((await hook('SessionStart', { source: 'resume' })).status, 204);
  assert.equal((await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status, 'working', 'still working');
  await hook('Stop', { last_assistant_message: 'done' });
  assert.equal((await request(srv, 'GET', `/api/sessions/${s.sid}`)).body.status, 'ready');
});
