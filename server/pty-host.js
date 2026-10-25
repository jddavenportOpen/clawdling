// The pty host: node-pty runs in a child process of the Clawdling server, never in the server.
//
// Why: node-pty's native ConPTY code can take its whole process down (Windows, node-pty 1.1.0).
// Each ConPTY session has an exit thread that erases the session from a global, unlocked
// std::vector, while the main thread reads the same vector for every spawn, resize and kill. The
// result is an access violation (0xC0000005) that no JavaScript can catch (issue #4). In a child
// process that crash ends only the host: the server sees it, marks the sessions it held ended with
// a note, and starts a new host for the next session.
//
// The split: the host owns the pseudo-terminals (spawn, input, resize, kill) and forwards output
// and exits; the server keeps everything else (the @xterm/headless screen model, snapshots,
// dialogs), so pty.js works the same over a host as over node-pty itself.
//
// Messages (JSON over the IPC channel), server -> host:
//   {t:'spawn', id, file, args, opts}  {t:'write', id, data | b64}  {t:'resize', id, cols, rows}
//   {t:'kill', id, signal?}
// host -> server:
//   {t:'spawned', id, pid}  {t:'spawn-error', id, error}  {t:'data', id, data}
//   {t:'exit', id, exitCode, signal}
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLine } from './util.js';

const HOST_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-host-main.js');

/**
 * Windows: never kill or close a ConPTY whose process has already exited.
 *
 * node-pty learns of the exit on a native thread and emits 'exit' about a second later, once the
 * output pipe drains. A kill() in that window forks node-pty's console-list helper against a shell
 * that is gone ("AttachConsole failed") and closes a pseudoconsole the exit thread has already
 * dropped. So: a kill after the exit (seen or native) only releases node-pty's output worker, and
 * nothing is killed or released twice. Other platforms are returned unchanged.
 */
export function guardPty(child, { platform = process.platform } = {}) {
  if (platform !== 'win32') return child;
  let exited = false;
  let done = false; // killed or released: never touch the pseudoconsole again
  let pendingKill = false; // asked to kill before node-pty was ready (it would defer the kill)
  const exitedNatively = () => {
    try {
      return exited || child._agent?.exitCode !== undefined; // node-pty 1.1.0 (pinned) internals
    } catch {
      return exited;
    }
  };
  const release = () => {
    try {
      child._agent?._conoutSocketWorker?.dispose?.();
    } catch {
      // already gone
    }
  };
  // node-pty defers kill() until the terminal's first output. Defer it here instead, so the exit
  // check runs again at that moment rather than against a shell that may have exited meanwhile.
  child.onData(() => {
    if (!pendingKill) return;
    pendingKill = false;
    if (exitedNatively()) release();
    else child.kill();
  });
  child.onExit(() => {
    exited = true;
    if (!done || pendingKill) {
      done = true;
      pendingKill = false;
      release(); // a process that exited on its own leaves node-pty's output worker behind
    }
  });
  return {
    get pid() {
      return child.pid;
    },
    onData: (cb) => child.onData(cb),
    onExit: (cb) => child.onExit(cb),
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
    get exited() {
      return exitedNatively();
    },
    kill() {
      if (done) return;
      done = true;
      if (exitedNatively()) {
        release();
        return;
      }
      if (child._isReady === false) {
        pendingKill = true;
        return;
      }
      child.kill(); // ConPTY: closes the console and kills every process attached to it
    },
  };
}

/** The pty host process itself (run by pty-host-main.js). */
export function runHost({ proc = process, loadPty } = {}) {
  // Ctrl+C in the terminal that runs `clawdling start`, or that terminal closing, reaches this
  // process too (same process group or console). The server decides when sessions end: it
  // disconnects, and this process follows (below).
  for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM', 'SIGBREAK']) {
    try {
      proc.on(sig, () => {});
    } catch {
      // not a signal on this OS
    }
  }
  const mods = loadPty();
  const sessions = new Map();
  const send = (msg) => {
    try {
      if (proc.connected) proc.send(msg);
    } catch {
      // the server is gone; 'disconnect' ends this process
    }
  };
  const handlers = {
    spawn({ id, file, args, opts }) {
      if (!mods.ok) {
        send({ t: 'spawn-error', id, error: `node-pty did not load (${mods.error})` });
        return;
      }
      let child;
      try {
        child = guardPty(mods.pty.spawn(file, args, opts), { platform: proc.platform || process.platform });
      } catch (err) {
        send({ t: 'spawn-error', id, error: oneLine(err.message, 300) });
        return;
      }
      sessions.set(id, child);
      child.onData((data) => send({ t: 'data', id, data }));
      child.onExit(({ exitCode, signal }) => {
        sessions.delete(id);
        send({ t: 'exit', id, exitCode: exitCode ?? null, signal: signal ?? null });
      });
      send({ t: 'spawned', id, pid: child.pid });
    },
    write({ id, data, b64 }) {
      try {
        sessions.get(id)?.write(b64 !== undefined ? Buffer.from(b64, 'base64') : data);
      } catch {
        // the pty closed under us; its exit follows
      }
    },
    resize({ id, cols, rows }) {
      try {
        sessions.get(id)?.resize(cols, rows);
      } catch {
        // exited between the check and the call
      }
    },
    kill({ id, signal }) {
      try {
        const s = sessions.get(id);
        if (s) signal ? s.kill(signal) : s.kill();
      } catch {
        // gone
      }
    },
  };
  proc.on('message', (msg) => {
    const h = msg && handlers[msg.t];
    if (h) h(msg);
  });
  // The server went away (stopped, or crashed): end every session, then this process.
  proc.on('disconnect', () => {
    for (const s of sessions.values()) {
      try {
        s.kill();
      } catch {
        // gone
      }
    }
    setTimeout(() => proc.exit(0), 500).unref?.();
  });
  return { sessions };
}

/** One pty, as the server sees it: node-pty's IPty surface, backed by the host. */
class RemotePty {
  constructor(host, id) {
    this.host = host;
    this.id = id;
    this.pid = null;
    this.dataCbs = [];
    this.exitCbs = [];
    this.held = [];
    this.exitInfo = null;
    this.exited = false;
  }

  // Output and an exit can arrive in the same IPC batch as `spawned`, before the caller of spawn()
  // has subscribed: keep them until it does.
  onData(cb) {
    this.dataCbs.push(cb);
    const held = this.held;
    this.held = [];
    for (const d of held) cb(d);
  }

  onExit(cb) {
    this.exitCbs.push(cb);
    if (this.exitInfo) queueMicrotask(() => cb(this.exitInfo));
  }

  write(data) {
    if (this.exited) return;
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) this.host.send({ t: 'write', id: this.id, b64: Buffer.from(data).toString('base64') });
    else this.host.send({ t: 'write', id: this.id, data: String(data) });
  }

  resize(cols, rows) {
    if (!this.exited) this.host.send({ t: 'resize', id: this.id, cols, rows });
  }

  kill(signal) {
    if (!this.exited) this.host.send({ t: 'kill', id: this.id, ...(signal ? { signal } : {}) });
  }

  _data(data) {
    if (!this.dataCbs.length) this.held.push(data);
    for (const cb of this.dataCbs) cb(data);
  }

  _exit(info) {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = info;
    for (const cb of this.exitCbs) cb(info);
  }
}

/** Why a session ended when its host did (sessions.js shows a note for it). */
export const HOST_LOST = 'pty host stopped';

/**
 * The server's side: a node-pty-like `spawn()` (async) that runs every pty in the host, starting
 * the host on demand and again after it dies.
 */
export class PtyHostClient {
  constructor({ logger = null, hostMain = HOST_MAIN, env = process.env, forkFn = fork, spawnOpts = {}, spawnTimeoutMs = 30000, execPath = process.execPath } = {}) {
    Object.assign(this, { logger, hostMain, env, forkFn, spawnOpts, spawnTimeoutMs, execPath });
    this.proc = null;
    this.nextId = 1;
    this.ptys = new Map();
    this.pending = new Map();
    this.starts = 0;
    this.losses = 0;
    this.stopping = false;
  }

  get pid() {
    return this.proc?.pid ?? null;
  }

  ensure() {
    if (this.proc) return this.proc;
    const proc = this.forkFn(this.hostMain, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: this.env, execArgv: [], execPath: this.execPath, windowsHide: true });
    this.proc = proc;
    this.starts++;
    proc.on('message', (msg) => this.onMessage(msg));
    proc.on('error', (err) => {
      this.logger?.warn?.(`pty host: ${err.message}`);
      // It never started (node moved, no memory for a process): no 'exit' follows.
      if (proc.pid === undefined) this.onLost(proc, null, err.code || 'could not start');
    });
    proc.once('exit', (code, signal) => this.onLost(proc, code, signal));
    let buf = '';
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) this.logger?.warn?.(`pty host: ${oneLine(l, 300)}`);
    });
    return proc;
  }

  send(msg) {
    const proc = this.proc;
    if (!proc || !proc.connected) return;
    try {
      proc.send(msg);
    } catch {
      // the host died; its 'exit' ends the sessions
    }
  }

  /** node-pty's spawn(), resolved once the host started the process. */
  async spawn(file, args, opts) {
    try {
      return await this.spawnOnce(file, args, opts);
    } catch (err) {
      // The host died under this spawn (not because of it, as far as we know): once more on a new one.
      if (!err.hostLost || this.stopping) throw err;
      return this.spawnOnce(file, args, opts);
    }
  }

  spawnOnce(file, args, opts) {
    const proc = this.ensure();
    const id = this.nextId++;
    const pty = new RemotePty(this, id);
    return new Promise((resolve, reject) => {
      // A host that never answers is as good as dead: stop it (its sessions end) and fail this spawn.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.logger?.warn?.(`pty host did not start a session within ${Math.round(this.spawnTimeoutMs / 1000)} s; restarting it`);
        try {
          proc.kill('SIGKILL');
        } catch {
          // gone
        }
      }, this.spawnTimeoutMs);
      timer.unref?.();
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { pty, resolve: done(resolve), reject: done(reject), proc });
      if (!proc.connected && proc.pid === undefined) return; // 'error' rejects it
      this.send({ t: 'spawn', id, file, args, opts: { ...opts, ...this.spawnOpts } });
    });
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.t === 'spawned' || msg.t === 'spawn-error') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.t === 'spawn-error') {
        p.reject(new Error(msg.error));
        return;
      }
      p.pty.pid = msg.pid;
      this.ptys.set(msg.id, p.pty);
      p.resolve(p.pty);
    } else if (msg.t === 'data') {
      this.ptys.get(msg.id)?._data(msg.data);
    } else if (msg.t === 'exit') {
      const pty = this.ptys.get(msg.id);
      this.ptys.delete(msg.id);
      pty?._exit({ exitCode: msg.exitCode, signal: msg.signal });
    }
  }

  /** The host is gone: every session it held has ended. The next spawn starts a new host. */
  onLost(proc, code, signal) {
    if (this.proc !== proc) return;
    this.proc = null;
    const reason = `${HOST_LOST} (${signal || `exit code ${code}`})`;
    if (!this.stopping) {
      this.losses++;
      this.logger?.warn?.(`${reason}; ${this.ptys.size} session(s) ended. The next session starts a new one.`);
    }
    for (const [id, p] of this.pending) {
      if (p.proc === proc) {
        this.pending.delete(id);
        p.reject(Object.assign(new Error(reason), { hostLost: true }));
      }
    }
    const ptys = [...this.ptys.values()];
    this.ptys.clear();
    for (const pty of ptys) pty._exit({ exitCode: null, signal: null, reason: this.stopping ? '' : reason });
  }

  /** Stop the host (the server is stopping, after its sessions ended). */
  async stop({ timeoutMs = 2000 } = {}) {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    const gone = new Promise((r) => proc.once('exit', r));
    try {
      proc.disconnect();
    } catch {
      // already disconnected
    }
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL'); // it ignores the polite signals (runHost)
      } catch {
        // gone
      }
    }, timeoutMs);
    await gone;
    clearTimeout(t);
    this.stopping = false;
  }
}
