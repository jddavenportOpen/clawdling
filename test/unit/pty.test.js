// The pty backend: the server-side screen model, snapshots, resize, input, paste, kill, dialog
// detection, and the Windows command line. Most tests drive a fake pty child (no processes); the
// last group runs a real node script under the real node-pty, on every OS where it loads.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { parseWinCommandLine } from '../../server/platform.js';
import { PtyBackend, loadPtyModules, visibleText } from '../../server/pty.js';
import { dialogFromScreen, parseChoices } from '../../server/sessions.js';
import { ModeTracker } from '../../server/termfilter.js';
import { waitFor } from '../helpers.mjs';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

class FakeChild {
  constructor(file, args, opts) {
    Object.assign(this, { file, args, opts, pid: 4242, written: [], sizes: [], killed: null });
  }
  onData(cb) {
    this.dataCb = cb;
  }
  onExit(cb) {
    this.exitCb = cb;
  }
  write(d) {
    this.written.push(Buffer.isBuffer(d) ? d.toString('utf8') : String(d));
  }
  resize(c, r) {
    this.sizes.push([c, r]);
  }
  kill(sig) {
    this.killed = sig || 'default';
  }
  emit(data) {
    this.dataCb(data);
  }
  exit(code = 0) {
    this.exitCb({ exitCode: code, signal: 0 });
  }
}

function fakeBackend(platform = 'linux') {
  const spawned = [];
  const groupSignals = [];
  const pty = {
    spawn(file, args, opts) {
      const c = new FakeChild(file, args, opts);
      spawned.push(c);
      return c;
    },
  };
  const be = new PtyBackend({ pty, Terminal, SerializeAddon, version: 'test', platform, killGroup: (pid, sig) => groupSignals.push([pid, sig]) });
  return { be, spawned, groupSignals };
}

const LAUNCH = { cwd: process.cwd(), env: { PATH: process.env.PATH || '' }, argv: ['/usr/local/bin/claude', '--session-id', 'x'] };
const tick = () => new Promise((r) => setTimeout(r, 30));
const snapshotOf = (client, modes = null) => new Promise((r) => client.snapshot(modes, r));
const fitOf = (client, cols, rows) => new Promise((r) => client.fit(cols, rows, r));

/** Replay data into a fresh headless terminal of the same size: what a late viewer would see. */
async function render(data, cols, rows) {
  const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  await new Promise((r) => t.write(data, r));
  return { text: visibleText(t), cursor: [t.buffer.active.cursorX, t.buffer.active.cursorY], alt: t.buffer.active.type, modes: { ...t.modes } };
}

test('a session: argv spawned directly, tags, list/has, attach command', async () => {
  const { be, spawned } = fakeBackend();
  const r = await be.newSession({ name: 'cl-work-abc123', cols: 90, rows: 30, launch: LAUNCH });
  assert.deepEqual(r, { sessionId: 'cl-work-abc123', paneId: 'cl-work-abc123' });
  assert.equal(spawned[0].file, '/usr/local/bin/claude');
  assert.deepEqual(spawned[0].args, ['--session-id', 'x'], 'no shell: argv as an array');
  assert.equal(spawned[0].opts.cols, 90);
  assert.equal(spawned[0].opts.name, 'xterm-256color');
  await be.setOptions('cl-work-abc123', [['window-size', 'manual'], ['@clawdling_sid', '11111111-1111-4111-8111-111111111111'], ['@clawdling_agent', 'work']]);
  assert.deepEqual(await be.listSessions(), [{ name: 'cl-work-abc123', id: 'cl-work-abc123', pane: 'cl-work-abc123', sid: '11111111-1111-4111-8111-111111111111', agent: 'work' }]);
  assert.equal(await be.hasSession('cl-work-abc123'), true);
  assert.equal(await be.hasSession('nope'), false);
  await assert.rejects(be.newSession({ name: 'cl-work-abc123', cols: 90, rows: 30, launch: LAUNCH }), /duplicate/);
  assert.equal(be.attachCommand({ sid: '11111111-1111-4111-8111-111111111111' }), 'clawdling attach 11111111');
  assert.equal(be.persistent, false);
  assert.equal(be.launcher, false);
});

test('screen model: screenText joins wrapped rows, and dialogs are detected on it', async () => {
  const { be, spawned } = fakeBackend();
  await be.newSession({ name: 's', cols: 40, rows: 12, launch: LAUNCH });
  const c = spawned[0];
  c.emit('\x1b[2J\x1b[H Accessing workspace:\r\n\r\n /home/sam/org\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n');
  c.emit(' \u276f No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm \u00b7 Esc to cancel\r\n');
  const screen = await be.screenText('=s:');
  assert.match(screen, /Quick safety check: Is this a project you created or one you trust\?/, 'a wrapped line comes back as one line');
  assert.equal(dialogFromScreen(screen).waiting, 'trust');
  assert.deepEqual(parseChoices(screen), { labels: ['No, exit', 'Yes, I trust this folder'], selected: 0 });
  // The pointer moves (the app redraws two rows): the model follows.
  c.emit('\x1b[4A\r\x1b[J   No, exit\r\n \u276f Yes, I trust this folder\r\n\r\n Enter to confirm\r\n');
  assert.deepEqual(parseChoices(await be.screenText('s')), { labels: ['No, exit', 'Yes, I trust this folder'], selected: 1 });
  await assert.rejects(be.screenText('missing'), /no session/);
});

test('the model answers terminal queries (DA1, cursor position, DECRQM), like tmux does', async () => {
  const { be, spawned } = fakeBackend();
  await be.newSession({ name: 's', cols: 80, rows: 24, launch: LAUNCH });
  const c = spawned[0];
  c.emit('hello\x1b[c\x1b[6n\x1b[?2004$p');
  await be.screenText('s');
  const replies = c.written.join('');
  assert.ok(replies.includes('\x1b[?1;2c'), JSON.stringify(replies));
  assert.ok(replies.includes('\x1b[1;6R'), 'cursor position report');
  assert.ok(replies.includes('\x1b[?2004;2$y'), 'DECRQM');
});

test('snapshots: an exact cut of the stream, and a late viewer sees exactly the screen', async () => {
  const { be, spawned } = fakeBackend();
  await be.newSession({ name: 's', cols: 50, rows: 8, launch: LAUNCH });
  const c = spawned[0];
  const viewer = be.control('s');
  const seen = [];
  viewer.on('output', (t) => seen.push(t));
  for (let i = 0; i < 20; i++) c.emit(`line ${i} \x1b[1;3${i % 8}mcolour\x1b[0m\r\n`);
  c.emit('\x1b[?2004h\x1b[?1h> prompt here\x1b[3D');
  let streamedAtCut = -1;
  const snapP = new Promise((r) =>
    viewer.snapshot(new ModeTracker([1006]), (data) => {
      streamedAtCut = seen.length; // read inside the callback: this is the moment of the cut
      r(data);
    })
  );
  c.emit('AFTER THE CUT'); // arrives after the request: must not be in the snapshot, must stream live
  const snap = await snapP;
  assert.ok(snap.startsWith('\x1b[0m\x1b[H\x1b[2J\x1b[3J'), 'starts by clearing');
  assert.ok(!snap.includes('AFTER THE CUT'));
  assert.equal(streamedAtCut, 21, 'at the cut, every chunk before it had been streamed and none after it');
  await waitFor(() => seen.join('').includes('AFTER THE CUT'), { label: 'live output after the cut' });
  const model = await be.screenText('s');
  const late = await render(snap + 'AFTER THE CUT', 50, 8);
  assert.equal(late.text, model, 'snapshot + live output = the model, row for row');
  const s = be.sessions.get('s');
  assert.deepEqual(late.cursor, [s.term.buffer.active.cursorX, s.term.buffer.active.cursorY]);
  assert.equal(late.modes.bracketedPasteMode, true, 'bracketed paste replayed');
  assert.equal(late.modes.applicationCursorKeysMode, true, 'cursor keys mode replayed');
  assert.ok(snap.includes('\x1b[?1006h'), 'tracked modes (SGR mouse) replayed');
  assert.match(snap, /line 0 /, 'history above the screen is included');
  // The alternate screen comes back as the alternate screen.
  c.emit('\x1b[?1049h\x1b[Hfull-screen app');
  const alt = await render(await snapshotOf(viewer), 50, 8);
  assert.equal(alt.alt, 'alternate');
  assert.match(alt.text, /^full-screen app/);
});

test('resize: the pty at once, the model after what was already sent; same size is a no-op', async () => {
  const { be, spawned } = fakeBackend();
  await be.newSession({ name: 's', cols: 80, rows: 24, launch: LAUNCH });
  const c = spawned[0];
  const viewer = be.control('s');
  c.emit('x'.repeat(60) + '\r\n');
  assert.equal(await fitOf(viewer, 100, 30), true);
  assert.deepEqual(c.sizes, [[100, 30]]);
  const s = be.sessions.get('s');
  assert.deepEqual([s.term.cols, s.term.rows], [100, 30]);
  assert.equal(await fitOf(viewer, 100, 30), false, 'already that size');
  assert.deepEqual(c.sizes, [[100, 30]]);
  await be.resizeWindow('s', 40, 10);
  await tick();
  assert.deepEqual(c.sizes.at(-1), [40, 10]);
});

test('input and paste: raw bytes, CR for newlines, bracketed paste when the app asked for it', async () => {
  const { be, spawned } = fakeBackend();
  await be.newSession({ name: 's', cols: 80, rows: 24, launch: LAUNCH });
  const c = spawned[0];
  const viewer = be.control('s');
  viewer.sendBytes(Buffer.from('ü\x1b[A'));
  await be.sendKeysHex('s', Buffer.from('\r'));
  assert.deepEqual(c.written.slice(-2), ['ü\x1b[A', '\r']);
  await be.paste('s', 'one\ntwo');
  assert.equal(c.written.at(-1), 'one\rtwo', 'no bracketed paste until the app turns it on');
  c.emit('\x1b[?2004h');
  await be.paste('=s:', 'one\ntwo\x1b[201~evil');
  assert.equal(c.written.at(-1), '\x1b[200~one\rtwoevil\x1b[201~', 'wrapped, and a smuggled end marker is removed');
  // Windows: ConPTY may hide the app's mode switch; a multi-line paste is still one paste.
  const w = fakeBackend('win32');
  await w.be.newSession({ name: 'w', cols: 80, rows: 24, launch: { ...LAUNCH, argv: ['C:\\Tools\\claude.exe'] } });
  await w.be.paste('w', 'a\nb');
  assert.equal(w.spawned[0].written.at(-1), '\x1b[200~a\rb\x1b[201~');
  await w.be.paste('w', 'single line');
  assert.equal(w.spawned[0].written.at(-1), 'single line');
});

test('exit: viewers get every byte, then close; the session is gone', async () => {
  const { be, spawned } = fakeBackend();
  await be.newSession({ name: 's', cols: 80, rows: 24, launch: LAUNCH });
  const c = spawned[0];
  const viewer = be.control('s');
  let out = '';
  viewer.on('output', (t) => (out += t));
  const closed = new Promise((r) => viewer.once('close', r));
  c.emit('last words\r\n');
  c.exit(0);
  const info = await closed;
  assert.equal(info.code, 0);
  assert.equal(out, 'last words\r\n', 'output written before the exit still reached the viewer');
  assert.equal(await be.hasSession('s'), false);
  assert.deepEqual(await be.listSessions(), []);
  // A client for a session that is gone closes at once (sessions.js then marks it ended).
  const late = be.control('s');
  await new Promise((r) => late.once('close', r));
  assert.equal(late.closed, true);
  assert.equal(await snapshotOf(late), null);
});

test('kill: SIGHUP to the process group (SIGKILL later), ConPTY kill on Windows; shutdown waits', async () => {
  const { be, spawned, groupSignals } = fakeBackend('linux');
  await be.newSession({ name: 's', cols: 80, rows: 24, launch: LAUNCH });
  assert.equal(await be.killSession('s'), true);
  assert.deepEqual(groupSignals, [[4242, 'SIGHUP']]);
  assert.equal(await be.hasSession('s'), false, 'gone at once for the caller (end() then marks it ended)');
  assert.equal(await be.killSession('s'), false);
  spawned[0].exit(129);
  const w = fakeBackend('win32');
  await w.be.newSession({ name: 'w', cols: 80, rows: 24, launch: { ...LAUNCH, argv: ['C:\\Tools\\claude.exe'] } });
  const done = w.be.shutdown({ timeoutMs: 2000 });
  assert.equal(w.spawned[0].killed, 'default', 'pty.kill() with no signal on Windows');
  w.spawned[0].exit(1);
  await done;
  assert.equal(await w.be.hasSession('w'), false);
});

test('Windows: the command line is pre-quoted (node-pty would split "quoted words"), no shell', async () => {
  const { be, spawned } = fakeBackend('win32');
  const nasty = ['--name=Health: x', '"whole thing quoted"', 'tail\\', 'a "b" c', 'new\nline', '%PATH% & | < > ^ !'];
  await be.newSession({ name: 'w', cols: 80, rows: 24, launch: { cwd: 'C:\\org', env: {}, argv: ['C:\\Users\\Sam\\.local\\bin\\claude.exe', ...nasty] } });
  const c = spawned[0];
  assert.equal(c.file, 'C:\\Users\\Sam\\.local\\bin\\claude.exe');
  assert.equal(typeof c.args, 'string');
  assert.deepEqual(parseWinCommandLine(c.args), nasty);
});

// ------------------------------------------------------------------------------- the real node-pty

const mods = loadPtyModules();
const realPty = mods.ok ? false : `node-pty did not load here (${mods.error})`;

// A tiny TUI: draws, turns on bracketed paste, logs its size on resize, echoes lines.
const APP = `
process.stdout.write('\\x1b[1mREAL PTY\\x1b[0m ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
process.stdout.write('\\x1b[?2004h> ');
process.stdout.on('resize', () => process.stdout.write('[resized ' + process.stdout.columns + 'x' + process.stdout.rows + ']\\r\\n> '));
process.stdin.setRawMode(true);
let line = '';
process.stdin.on('data', (d) => {
  for (const ch of d.toString('utf8').replace(/\\x1b\\[20[01]~/g, '')) {
    if (ch === '\\r') { process.stdout.write('\\r\\necho: ' + line + '\\r\\n> '); if (line === 'bye') process.exit(7); line = ''; }
    else { line += ch; process.stdout.write(ch); }
  }
});
`;

test('real node-pty: spawn, screen, snapshot, resize, input, paste, exit', { skip: realPty }, async () => {
  const be = new PtyBackend({ pty: mods.pty, Terminal: mods.Terminal, SerializeAddon: mods.SerializeAddon, version: mods.version });
  try {
    await be.newSession({ name: 'real', cols: 70, rows: 20, launch: { cwd: process.cwd(), env: { ...process.env }, argv: [process.execPath, '-e', APP] } });
    const viewer = be.control('real');
    let out = '';
    viewer.on('output', (t) => (out += t));
    await waitFor(async () => /REAL PTY 70x20/.test(await be.screenText('real')), { label: 'the app drew its banner', timeout: 15000 });
    viewer.sendBytes(Buffer.from('hello pty\r'));
    await waitFor(async () => /echo: hello pty/.test(await be.screenText('real')), { label: 'input echoed', timeout: 10000 });
    await waitFor(() => be.sessions.get('real').term.modes.bracketedPasteMode, { label: 'bracketed paste seen by the model' });
    await be.paste('real', 'pasted text');
    await be.sendKeysHex('real', Buffer.from('\r'));
    await waitFor(async () => /echo: pasted text/.test(await be.screenText('real')), { label: 'paste echoed', timeout: 10000 });
    assert.equal(await fitOf(viewer, 90, 25), true);
    await waitFor(async () => /\[resized 90x25\]/.test(await be.screenText('real')), { label: 'the app saw the new size', timeout: 10000 });
    const snap = await snapshotOf(viewer);
    const late = await render(snap, 90, 25);
    assert.equal(late.text, await be.screenText('real'), 'a late viewer sees the same screen');
    assert.ok(out.includes('echo: hello pty'), 'viewers got the live stream');
    const closed = new Promise((r) => viewer.once('close', r));
    viewer.sendBytes(Buffer.from('bye\r'));
    const info = await closed;
    assert.equal(info.code, 7);
    assert.equal(await be.hasSession('real'), false);
  } finally {
    await be.shutdown({ timeoutMs: 3000 });
  }
});

test('real node-pty: killSession ends the process and its close event follows', { skip: realPty }, async () => {
  const be = new PtyBackend({ pty: mods.pty, Terminal: mods.Terminal, SerializeAddon: mods.SerializeAddon, version: mods.version });
  try {
    await be.newSession({ name: 'k', cols: 60, rows: 10, launch: { cwd: process.cwd(), env: { ...process.env }, argv: [process.execPath, '-e', 'process.stdout.write("up\\r\\n"); setInterval(() => {}, 1000)'] } });
    await waitFor(async () => /up/.test(await be.screenText('k')), { label: 'started', timeout: 15000 });
    const viewer = be.control('k');
    const closed = new Promise((r) => viewer.once('close', r));
    assert.equal(await be.killSession('k'), true);
    await closed;
    assert.equal(await be.hasSession('k'), false);
  } finally {
    await be.shutdown({ timeoutMs: 3000 });
  }
});
