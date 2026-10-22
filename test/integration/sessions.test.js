// Real server + real tmux + fake claude: spawn, stream, input, hooks → status, rename, send, end, resume.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  cli,
  killTmux,
  openViewer,
  readLog,
  request,
  rmrf,
  startServerProc,
  tempHome,
  testEnv,
  tmux,
  tmuxHas,
  uniqueSocket,
  waitFor,
} from '../helpers.mjs';

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

const getSession = async (sid) => (await request(srv, 'GET', `/api/sessions/${sid}`)).body;

test('spawn with a first prompt: title, hooks drive starting -> working -> ready', async () => {
  const r = await request(srv, 'POST', '/api/sessions', { agent: 'health', prompt: 'check my **sleep** data. then rest' });
  assert.equal(r.status, 201, r.text);
  const s = r.body;
  assert.match(s.sid, /^[0-9a-f-]{36}$/);
  assert.equal(s.agent, 'health');
  assert.equal(s.agent_name, 'Health');
  assert.equal(s.kind, 'domain');
  assert.equal(s.title, 'Check my sleep data');
  assert.equal(s.tmux_name, `cl-health-${s.sid.slice(0, 6)}`);
  assert.ok(tmuxHas(socket, s.tmux_name), 'tmux session exists');
  const ready = await waitFor(async () => {
    const cur = await getSession(s.sid);
    return cur.status === 'ready' ? cur : null;
  }, { label: 'ready' });
  assert.equal(ready.last_message, 'check my **sleep** data. then rest');
  const inter = readLog(fakeLog).find((e) => e.mode === 'interactive' && e.opts.sessionId === s.sid);
  assert.ok(inter, 'fake claude was launched');
  assert.equal(inter.opts.name, 'Health: Check my sleep data');
  assert.equal(inter.prompt, 'check my **sleep** data. then rest');
  assert.equal(inter.cwd, path.join(home, 'domains', 'health'));
  assert.equal(inter.env.CLAWDLING_SID, s.sid);
  assert.equal(inter.env.CLAUDECODE, null, 'parent Claude Code markers are scrubbed');
  assert.equal(inter.env.PATH0, path.join(home, '.clawdling', 'bin'), 'clawdling shim is first on PATH');
  assert.ok(inter.opts.settings.endsWith('hooks-settings.json'));
  assert.deepEqual(inter.opts.addDir, [home]);
  assert.ok(fs.readFileSync(inter.opts.appendSystemPromptFile, 'utf8').includes('About '), 'context file includes me.md');
  const statuses = readLog(fakeLog).filter((e) => e.mode === 'hook').map((e) => e.event);
  assert.deepEqual(statuses.slice(0, 3), ['SessionStart', 'UserPromptSubmit', 'Stop']);
  assert.ok(readLog(fakeLog).filter((e) => e.mode === 'hook').every((e) => e.stdout === ''), 'hook prints nothing');
});

test('viewer: snapshot first, live output, input echo, permission -> needs_you, resize', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'work' })).body;
  await waitFor(async () => (await getSession(s.sid)).status === 'ready', { label: 'ready (no prompt)' });
  const v = await openViewer(srv, s.sid);
  try {
    const first = await v.next(() => true);
    assert.equal(first.t, 'snapshot');
    assert.match(first.data, /Fake Claude Code/);
    assert.match(first.data, /\x1b\[\?2004h/, 'bracketed paste mode replayed for a late viewer');
    v.send({ t: 'in', data: 'hello there ü\u{1F600}\r' });
    await v.waitOutput(/assistant: hello there ü\u{1F600}/u);
    await waitFor(async () => (await getSession(s.sid)).title === 'Hello there ü\u{1F600}', { label: 'auto title' });
    v.send({ t: 'in', data: 'need permission?\r' });
    const nu = await waitFor(async () => {
      const cur = await getSession(s.sid);
      return cur.status === 'needs_you' ? cur : null;
    }, { label: 'needs_you' });
    assert.match(nu.notification, /permission/);
    await v.next((m) => m.t === 'status' && m.status === 'needs_you');
    assert.equal(nu.waiting_on, 'permission_prompt');
    const typed = await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'yes' });
    assert.equal(typed.status, 409, 'the API (and Donna) can never answer a permission prompt');
    v.send({ t: 'in', data: '1\r' });
    await waitFor(async () => (await getSession(s.sid)).status === 'ready', { label: 'ready after permission' });
    v.send({ t: 'resize', cols: 101, rows: 33 });
    await waitFor(() => tmux(socket, 'display-message', '-p', '-t', `=${s.tmux_name}:`, '#{pane_width}x#{pane_height}').trim() === '101x33', { label: 'resize' });
  } finally {
    v.close();
  }
});

test('rename, send, end, resume', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'money', prompt: 'budget' })).body;
  assert.equal(s.title, 'Budget');
  await waitFor(async () => (await getSession(s.sid)).status === 'ready', { label: 'ready' });
  const ren = await request(srv, 'PATCH', `/api/sessions/${s.sid}`, { title: '  Q4 budget \n review ' });
  assert.equal(ren.status, 200);
  assert.equal(ren.body.title, 'Q4 budget review');
  assert.equal(ren.body.name, 'Money: Q4 budget review');

  const v = await openViewer(srv, s.sid);
  try {
    await v.next((m) => m.t === 'snapshot');
    const sent = await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'typed by the api', enter: true });
    assert.equal(sent.status, 204, sent.text);
    await v.waitOutput(/assistant: typed by the api/);

    const ended = await request(srv, 'DELETE', `/api/sessions/${s.sid}`);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.status, 'ended');
    assert.equal(ended.body.resumable, true);
    assert.ok(ended.body.ended_at);
    await v.next((m) => m.t === 'ended');
    assert.equal(tmuxHas(socket, s.tmux_name), false);
    const blocked = await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'x' });
    assert.equal(blocked.status, 409);

    const res = await request(srv, 'POST', `/api/sessions/${s.sid}/resume`);
    assert.equal(res.status, 200, res.text);
    assert.notEqual(res.body.status, 'ended');
    assert.ok(tmuxHas(socket, s.tmux_name));
    const resumed = await waitFor(() => readLog(fakeLog).filter((e) => e.mode === 'interactive' && e.opts.resume === s.sid).length === 1, { label: 'relaunched with --resume <sid>' });
    assert.ok(resumed);
    await waitFor(async () => (await getSession(s.sid)).status === 'ready', { label: 'ready after resume' });
    await waitFor(() => v.messages.filter((m) => m.t === 'snapshot').length >= 2, { label: 'fresh snapshot after resume' });
  } finally {
    v.close();
  }
  const list = (await request(srv, 'GET', '/api/sessions')).body;
  assert.ok(list.some((x) => x.sid === s.sid));
  const org = (await request(srv, 'GET', '/api/org')).body;
  const money = org.agents.find((a) => a.id === 'money');
  assert.ok(money.live >= 1);
});

test('nasty prompts and titles reach claude byte-for-byte', async () => {
  const nasty = `it's "quoted" $(touch /tmp/pwned-clawdling) \`id\` ; rm -rf ~ \\ ${'é中\u{1F680}'}\nsecond line;`;
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'home', prompt: nasty, title: `-- $(boom) 'x';` })).body;
  await waitFor(() => readLog(fakeLog).find((e) => e.mode === 'interactive' && e.opts.sessionId === s.sid), { label: 'launch' });
  const e = readLog(fakeLog).find((x) => x.mode === 'interactive' && x.opts.sessionId === s.sid);
  assert.equal(e.prompt, nasty);
  assert.equal(e.opts.name, `Home: -- $(boom) 'x';`);
  assert.equal(fs.existsSync('/tmp/pwned-clawdling'), false);
  const bare = (await request(srv, 'POST', '/api/sessions', { agent: 'home', prompt: 'update' })).body;
  await waitFor(() => readLog(fakeLog).find((x) => x.mode === 'interactive' && x.opts.sessionId === bare.sid), { label: 'launch bare' });
  const b = readLog(fakeLog).find((x) => x.mode === 'interactive' && x.opts.sessionId === bare.sid);
  const dd = b.argv.indexOf('--');
  assert.ok(dd > 0, 'prompt comes after --');
  assert.equal(b.argv[dd + 1], 'update ', 'a one-word prompt can never be dispatched as a claude subcommand');
});

test('scratch sessions run at the org root; unknown agents are rejected', async () => {
  const s = (await request(srv, 'POST', '/api/sessions', { agent: 'scratch' })).body;
  assert.equal(s.kind, 'scratch');
  assert.equal(s.cwd, home);
  assert.equal((await request(srv, 'POST', '/api/sessions', { agent: 'nobody' })).status, 404);
  assert.equal((await request(srv, 'POST', '/api/sessions', { agent: '../etc' })).status, 400);
  assert.equal((await request(srv, 'POST', '/api/sessions', { agent: 'health', model: 'x;rm' })).status, 400);
});

test("Claude Code's folder-trust dialog is surfaced as needs_you and answered like a user would", async () => {
  fs.writeFileSync(path.join(home, 'domains', 'health', '.fake-claude-trust'), '');
  try {
    const s = (await request(srv, 'POST', '/api/sessions', { agent: 'health' })).body;
    const nu = await waitFor(async () => {
      const cur = await getSession(s.sid);
      return cur.status === 'needs_you' ? cur : null;
    }, { label: 'trust needs_you' });
    assert.match(nu.notification, /trust this folder/);
    const sent = await request(srv, 'POST', `/api/sessions/${s.sid}/send`, { text: 'hello' });
    assert.equal(sent.status, 409, 'Donna/CLI text is never typed into the trust dialog');
    const v = await openViewer(srv, s.sid);
    try {
      await v.next((m) => m.t === 'snapshot');
      v.send({ t: 'in', data: '\x1b[B' }); // move to "Yes, I trust this folder"
      await v.waitOutput(/❯ Yes, I trust this folder/u);
      v.send({ t: 'in', data: '\r' });
      const ready = await waitFor(async () => {
        const cur = await getSession(s.sid);
        return cur.status === 'ready' ? cur : null;
      }, { label: 'ready after trust' });
      assert.equal(ready.notification, null);
    } finally {
      v.close();
    }
    // Choosing the default ("No, exit") ends the session with a useful notice.
    const s2 = (await request(srv, 'POST', '/api/sessions', { agent: 'health' })).body;
    await waitFor(async () => (await getSession(s2.sid)).status === 'needs_you', { label: 'trust again' });
    const v2 = await openViewer(srv, s2.sid);
    try {
      await v2.next((m) => m.t === 'snapshot');
      v2.send({ t: 'in', data: '\r' });
      const ended = await waitFor(async () => {
        const cur = await getSession(s2.sid);
        return cur.status === 'ended' ? cur : null;
      }, { label: 'ended after No' });
      assert.match(ended.notification, /exited right after starting/);
      assert.equal(ended.resumable, true);
    } finally {
      v2.close();
    }
  } finally {
    fs.unlinkSync(path.join(home, 'domains', 'health', '.fake-claude-trust'));
  }
});
