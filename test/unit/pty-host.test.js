// The pty host (issue #4): node-pty runs in a child process, so a native crash ends only the host.
// The guard tests use a fake ConPTY child; the host tests run real processes under the real
// node-pty, on every OS where it loads.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { HOST_LOST, PtyHostClient, guardPty, runHost } from '../../server/pty-host.js';
import { PtyBackend, loadPtyModules } from '../../server/pty.js';
import { pidAlive, waitFor } from '../helpers.mjs';

/** A node-pty WindowsTerminal as far as the guard can see: its agent learns of the exit first. */
class FakeConpty {
  constructor() {
    this.pid = 77;
    this.kills = 0;
    this.disposed = 0;
    this.exitCbs = [];
    this._agent = { exitCode: undefined, _conoutSocketWorker: { dispose: () => this.disposed++ } };
  }
  onData() {}
  onExit(cb) {
    this.exitCbs.push(cb);
  }
  write() {}
  resize() {}
  kill() {
    this.kills++;
  }
  nativeExit(code = 0) {
    this._agent.exitCode = code; // node-pty's exit thread ran; 'exit' comes about 1 s later
  }
  exit(code = 0) {
    this.nativeExit(code);
    for (const cb of this.exitCbs) cb({ exitCode: code, signal: 0 });
  }
}

test('guard: a ConPTY that already exited is never killed (the AttachConsole / 0xC0000005 path)', () => {
  // killed while its exit is still in flight: no kill(), only the output worker is released
  const a = new FakeConpty();
  const ga = guardPty(a, { platform: 'win32' });
  a.nativeExit(0);
  ga.kill();
  assert.equal(a.kills, 0, 'no kill after the native exit');
  assert.equal(a.disposed, 1);
  a.exit(0);
  assert.equal(a.disposed, 1, 'released once, not again at the exit event');

  // killed after the exit event
  const b = new FakeConpty();
  const gb = guardPty(b, { platform: 'win32' });
  b.exit(3);
  assert.equal(b.disposed, 1, 'a process that exits on its own has its worker released');
  gb.kill();
  gb.kill();
  assert.equal(b.kills, 0);
  assert.equal(b.disposed, 1);

  // a live one is killed exactly once
  const c = new FakeConpty();
  const gc = guardPty(c, { platform: 'win32' });
  gc.kill();
  gc.kill();
  assert.equal(c.kills, 1);
  c.exit(1);
  assert.equal(c.disposed, 0, 'kill() already closed it: nothing is released twice');

  // other platforms: the child itself, unchanged
  const d = new FakeConpty();
  assert.equal(guardPty(d, { platform: 'linux' }), d);
});

test('host protocol: spawn, data, input, resize, kill, exit; the server going away ends it', async () => {
  const proc = new EventEmitter();
  proc.connected = true;
  proc.platform = 'linux';
  const sent = [];
  proc.send = (m) => sent.push(m);
  let exitCode = null;
  proc.exit = (c) => (exitCode = c);
  const children = [];
  const fakePty = {
    spawn(file, args, opts) {
      if (file === 'missing') throw new Error('no such file');
      const c = { pid: 900 + children.length, file, args, opts, writes: [], sizes: [], kills: [], dataCb: null, exitCb: null };
      c.onData = (cb) => (c.dataCb = cb);
      c.onExit = (cb) => (c.exitCb = cb);
      c.write = (d) => c.writes.push(d);
      c.resize = (x, y) => c.sizes.push([x, y]);
      c.kill = (s) => c.kills.push(s || 'default');
      children.push(c);
      return c;
    },
  };
  const { sessions } = runHost({ proc, loadPty: () => ({ ok: true, pty: fakePty }) });
  proc.emit('message', { t: 'spawn', id: 1, file: '/bin/app', args: ['-x'], opts: { cols: 80, rows: 24 } });
  assert.deepEqual(sent.shift(), { t: 'spawned', id: 1, pid: 900 });
  proc.emit('message', { t: 'spawn', id: 2, file: 'missing', args: [], opts: {} });
  assert.deepEqual(sent.shift(), { t: 'spawn-error', id: 2, error: 'no such file' });
  const c = children[0];
  c.dataCb('hello');
  assert.deepEqual(sent.shift(), { t: 'data', id: 1, data: 'hello' });
  proc.emit('message', { t: 'write', id: 1, data: 'typed' });
  proc.emit('message', { t: 'write', id: 1, b64: Buffer.from('\x1b[A').toString('base64') });
  assert.equal(c.writes[0], 'typed');
  assert.deepEqual(c.writes[1], Buffer.from('\x1b[A'));
  proc.emit('message', { t: 'resize', id: 1, cols: 100, rows: 30 });
  assert.deepEqual(c.sizes, [[100, 30]]);
  proc.emit('message', { t: 'kill', id: 1, signal: 'SIGHUP' });
  assert.deepEqual(c.kills, ['SIGHUP']);
  c.exitCb({ exitCode: 129, signal: 1 });
  assert.deepEqual(sent.shift(), { t: 'exit', id: 1, exitCode: 129, signal: 1 });
  assert.equal(sessions.size, 0);
  proc.emit('message', { t: 'write', id: 1, data: 'late' }); // unknown id: ignored
  // the server disconnects: every session is killed and the host exits
  proc.emit('message', { t: 'spawn', id: 3, file: '/bin/app', args: [], opts: {} });
  proc.emit('disconnect');
  assert.deepEqual(children[1].kills, ['default']);
  await waitFor(() => exitCode === 0, { label: 'host exits after the server goes away', timeout: 3000 });
});

// ------------------------------------------------------------------------------- the real node-pty

const mods = loadPtyModules();
const realPty = mods.ok ? false : `node-pty did not load here (${mods.error})`;
const LIVE = 'process.stdin.setRawMode(true); process.stdout.write("up " + process.pid + "\\r\\n"); process.stdin.on("data", (d) => { if (String(d).includes("q")) process.exit(5); process.stdout.write("got " + d); }); setInterval(() => {}, 1000)';

function hostBackend() {
  const host = new PtyHostClient();
  const be = new PtyBackend({ pty: host, Terminal: mods.Terminal, SerializeAddon: mods.SerializeAddon, version: mods.version });
  return { host, be };
}

const launchNode = (code) => ({ cwd: process.cwd(), env: { ...process.env }, argv: [process.execPath, '-e', code] });

test('real host: a session runs in the host, not in this process', { skip: realPty }, async () => {
  const { host, be } = hostBackend();
  try {
    await be.newSession({ name: 'h', cols: 70, rows: 12, launch: launchNode(LIVE) });
    assert.ok(host.pid && host.pid !== process.pid, 'the host is a separate process');
    assert.equal(be.describe().isolated, true);
    await waitFor(async () => /up \d+/.test(await be.screenText('h')), { label: 'started', timeout: 15000 });
    const viewer = be.control('h');
    viewer.sendBytes(Buffer.from('hi'));
    await waitFor(async () => /got hi/.test(await be.screenText('h')), { label: 'input reached it through the host', timeout: 10000 });
    const closed = new Promise((r) => viewer.once('close', r));
    viewer.sendBytes(Buffer.from('q'));
    const info = await closed;
    assert.equal(info.code, 5, 'the exit code comes back through the host');
    assert.equal(info.reason, '');
    assert.equal(await be.hasSession('h'), false);
  } finally {
    await be.shutdown({ timeoutMs: 3000 });
  }
  assert.equal(host.pid, null, 'shutdown stops the host');
});

test('real host: when the host dies, its sessions end with a reason and the next session starts a new host', { skip: realPty }, async () => {
  const { host, be } = hostBackend();
  try {
    await be.newSession({ name: 'a', cols: 60, rows: 10, launch: launchNode(LIVE) });
    await be.newSession({ name: 'b', cols: 60, rows: 10, launch: launchNode(LIVE) });
    await waitFor(async () => /up/.test(await be.screenText('a')) && /up/.test(await be.screenText('b')), { label: 'both started', timeout: 15000 });
    const appPid = Number((await be.screenText('a')).match(/up (\d+)/)[1]);
    const first = host.pid;
    const closes = ['a', 'b'].map((n) => new Promise((r) => be.control(n).once('close', r)));
    process.kill(first, 'SIGKILL'); // what a native crash looks like from here
    const infos = await Promise.all(closes);
    for (const info of infos) assert.ok(info.reason.startsWith(HOST_LOST), `reason: ${info.reason}`);
    assert.equal(await be.hasSession('a'), false);
    assert.equal(host.losses, 1);
    await waitFor(() => !pidAlive(appPid), { label: 'the app went with its terminal', timeout: 10000 });
    await be.newSession({ name: 'c', cols: 60, rows: 10, launch: launchNode(LIVE) });
    assert.ok(host.pid && host.pid !== first, 'a new host');
    assert.equal(host.starts, 2);
    await waitFor(async () => /up/.test(await be.screenText('c')), { label: 'a session on the new host', timeout: 15000 });
  } finally {
    await be.shutdown({ timeoutMs: 3000 });
  }
});

// Issue #4's trigger: ending sessions whose process has just exited, many at once. On Windows this
// is the kill that ran node-pty's console-list helper against a dead shell and then crashed the
// server with 0xC0000005. The host must survive it (no loss), and so must this process.
test('real host: killing shells that already exited, many times over, never loses the host', { skip: realPty }, async () => {
  const { host, be } = hostBackend();
  try {
    for (let round = 0; round < 4; round++) {
      const names = Array.from({ length: 6 }, (_, i) => `x${round}-${i}`);
      await Promise.all(names.map((n) => be.newSession({ name: n, cols: 40, rows: 8, launch: launchNode('process.stdout.write("bye\\r\\n"); setTimeout(() => process.exit(0), 50)') })));
      const closes = names.map((n) => new Promise((r) => be.control(n).once('close', r)));
      await new Promise((r) => setTimeout(r, 400)); // the processes exit; node-pty's 'exit' is still pending on Windows
      for (const n of names) await be.killSession(n);
      await Promise.all(closes);
    }
    assert.equal(host.losses, 0, 'the host never died');
    assert.equal(host.starts, 1);
    await be.newSession({ name: 'after', cols: 60, rows: 10, launch: launchNode(LIVE) });
    await waitFor(async () => /up/.test(await be.screenText('after')), { label: 'still starts sessions', timeout: 15000 });
  } finally {
    await be.shutdown({ timeoutMs: 3000 });
  }
});
