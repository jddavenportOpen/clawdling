// The pty session backend: Clawdling without tmux (native Windows, a Mac without Homebrew).
//
// One pseudo-terminal per session from node-pty (Microsoft's, the one VS Code uses; ConPTY on
// Windows), plus one @xterm/headless terminal per session as the server-side screen model. The
// model is what tmux is for the tmux backend:
// - it answers the terminal queries Claude Code sends at startup (DA, cursor position, DECRQM...),
// - screenText() reads its visible buffer (trust and permission dialogs, parseChoices),
// - snapshots for late viewers are serialized from it (@xterm/addon-serialize), and
// - output reaches viewers only after the model has parsed it, so a snapshot is an exact cut of
//   the stream: everything before it is in the snapshot, everything after it is sent live.
//
// Sessions live inside the Clawdling server process. They end when it stops and show as ended
// (resumable with `claude --resume`) when it starts again. tmux is the backend for sessions that
// outlive the server.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { commandFor, quoteWinArg } from './platform.js';
import { CLEAR } from './termfilter.js';
import { oneLine, sleep } from './util.js';

const requireHere = createRequire(import.meta.url);
const SNAPSHOT_HISTORY = 2000; // rows of scrollback in a snapshot, like capture-pane -S -2000

/**
 * node-pty's prebuilt macOS helper ships without its executable bit (node-pty 1.1.0), which makes
 * every spawn fail with "posix_spawnp failed". Set it, best effort, before the first spawn.
 */
export function ensureSpawnHelper(pkgDir, { platform = process.platform, arch = process.arch } = {}) {
  const fixed = [];
  for (const dir of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    const helper = path.join(pkgDir, dir, 'spawn-helper');
    try {
      const st = fs.statSync(helper);
      if ((st.mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, st.mode | 0o755);
        fixed.push(helper);
      }
    } catch {
      // not there, or not ours to change
    }
  }
  return fixed;
}

let cached = null;

/**
 * Load node-pty (an optional dependency) and the headless terminal, once.
 * Returns {ok, pty, Terminal, SerializeAddon, version} or {ok: false, error}.
 */
export function loadPtyModules({ requireFn = requireHere, platform = process.platform, arch = process.arch } = {}) {
  if (cached && requireFn === requireHere) return cached;
  let out;
  try {
    const pkgFile = requireFn.resolve('node-pty/package.json');
    const version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
    if (platform !== 'win32') ensureSpawnHelper(path.dirname(pkgFile), { platform, arch });
    const pty = requireFn('node-pty');
    // On Windows node-pty loads its native ConPTY module lazily, at the first spawn: load it now so
    // a broken install shows up in `clawdling doctor`, not as a session that cannot start.
    if (platform === 'win32') requireFn('node-pty/lib/utils').loadNativeModule('conpty');
    const { Terminal } = requireFn('@xterm/headless');
    const { SerializeAddon } = requireFn('@xterm/addon-serialize');
    out = { ok: true, pty, Terminal, SerializeAddon, version };
  } catch (err) {
    out = { ok: false, error: oneLine(err.message, 300) };
  }
  if (requireFn === requireHere) cached = out;
  return out;
}

/** The visible screen as plain text: wrapped rows joined, trailing spaces trimmed (capture-pane -p -J). */
export function visibleText(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    if (!line) break;
    const text = line.translateToString(false);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n') + '\n';
}

/** Target forms sessions.js uses (`%pane`, `=name:`, `name`) -> the session name. */
function nameOf(target) {
  return String(target || '').replace(/^=/, '').replace(/:$/, '');
}

const signalGroup = (pid, sig) => process.kill(-pid, sig);

class PtySession {
  constructor({ name, child, term, serializer, platform, logger, killGroup = signalGroup }) {
    Object.assign(this, { name, child, term, serializer, platform, logger, killGroup });
    this.pid = child.pid;
    this.cols = term.cols;
    this.rows = term.rows;
    this.sid = null;
    this.agent = null;
    this.exited = false; // the process is gone (or is being killed): hasSession() is false
    this.closed = false; // every byte it wrote has reached the model and the viewers
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.exitPromise = new Promise((resolve) => {
      this.events.once('close', resolve);
    });
    child.onData((data) => this.feed(data));
    child.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.barrier(() => this.finish({ code: exitCode, signal }));
    });
    // The model answers the app's terminal queries (DA1/DA2, cursor position, DECRQM, DECRQSS),
    // the way tmux does for a tmux pane. sessions.js keeps the queries away from browsers.
    term.onData((reply) => this.write(reply));
  }

  /** Output: into the model first, then to viewers once it is parsed (exact snapshot cuts). */
  feed(data) {
    if (this.closed) return;
    try {
      this.term.write(data, () => {
        if (!this.closed) this.events.emit('output', data);
      });
    } catch (err) {
      // xterm refuses data only far past any real backlog (50 MB): drop it from the model, keep it live
      this.logger?.warn?.(`pty ${this.name}: screen model skipped output (${err.message})`);
      this.events.emit('output', data);
    }
  }

  /** Run `fn` after everything written so far has been parsed into the model. */
  barrier(fn) {
    if (this.closed) {
      fn();
      return;
    }
    try {
      this.term.write('', fn);
    } catch {
      fn();
    }
  }

  barrierAsync() {
    return new Promise((resolve) => this.barrier(resolve));
  }

  finish(info) {
    if (this.closed) return;
    this.closed = true;
    this.events.emit('close', { code: info.code ?? null, signal: info.signal ?? null, reason: '', stderr: '' });
    this.events.removeAllListeners('output');
    this.release();
    setTimeout(() => {
      try {
        this.term.dispose();
      } catch {
        // already disposed
      }
    }, 0).unref?.();
  }

  /**
   * Windows: a process that exits on its own leaves its pseudoconsole (a conhost.exe) and node-pty's
   * output worker thread behind until the pty is killed (VS Code kills every pty after its exit).
   * Close both directly: node-pty's kill() would also fork a helper that lists the processes on a
   * console that no longer exists and prints "AttachConsole failed".
   */
  release() {
    if (this.platform !== 'win32' || this.released || this.killedByUs) return;
    this.released = true;
    const agent = this.child._agent; // node-pty 1.1.0 (pinned) internals, with a public fallback
    try {
      if (agent?._ptyNative?.kill && agent._conoutSocketWorker?.dispose) {
        agent._ptyNative.kill(agent._pty, agent._useConptyDll);
        agent._conoutSocketWorker.dispose();
        return;
      }
    } catch {
      // fall back to the public API
    }
    try {
      this.child.kill();
    } catch {
      // gone
    }
  }

  write(data) {
    if (this.exited || !data || !data.length) return;
    try {
      this.child.write(data);
    } catch {
      // the pty closed under us; onExit follows
    }
  }

  /** Resize the pty now (the app redraws on SIGWINCH) and the model after what it already sent. */
  resize(cols, rows, done = () => {}) {
    if (this.exited || (this.cols === cols && this.rows === rows)) {
      done(false);
      return;
    }
    this.cols = cols;
    this.rows = rows;
    try {
      this.child.resize(cols, rows);
    } catch {
      // exited between the check and the call
    }
    this.barrier(() => {
      try {
        this.term.resize(cols, rows);
      } catch {
        // disposed
      }
      done(true);
    });
  }

  /** End the session: SIGHUP to its process group (as a closing terminal would), SIGKILL after 3 s. */
  terminate() {
    if (this.exited) return;
    this.exited = true;
    if (this.platform === 'win32') {
      this.killedByUs = true;
      try {
        this.child.kill(); // ConPTY: closes the console and kills every process attached to it
      } catch {
        // gone
      }
      return;
    }
    const signal = (sig) => {
      try {
        this.killGroup(this.pid, sig); // node-pty makes the child a session and group leader
      } catch {
        try {
          this.child.kill(sig);
        } catch {
          // gone
        }
      }
    };
    signal('SIGHUP');
    const t = setTimeout(() => {
      if (!this.closed) signal('SIGKILL');
    }, 3000);
    t.unref?.();
  }
}

/** A viewer-side handle on one pty session, with the same events and methods as tmux's ControlClient. */
export class PtyClient extends EventEmitter {
  constructor(session, name) {
    super();
    this.name = name;
    this.session = session;
    this.paneId = name;
    this.closed = false;
    if (!session || session.closed) {
      setImmediate(() => this.markClosed({ code: null, reason: 'no such session' }));
      return;
    }
    this.onOutput = (text) => {
      if (!this.closed) this.emit('output', text);
    };
    this.onClose = (info) => this.markClosed(info);
    session.events.on('output', this.onOutput);
    session.events.once('close', this.onClose);
  }

  markClosed(info = {}) {
    if (this.closed) return;
    this.closed = true;
    if (this.session) {
      this.session.events.off('output', this.onOutput);
      this.session.events.off('close', this.onClose);
    }
    this.emit('close', { code: info.code ?? null, signal: info.signal ?? null, reason: info.reason || '', stderr: '' });
  }

  /** tmux command strings mean nothing here (kept so callers fail softly, never hang). */
  command(line, cb = () => {}) {
    cb(new Error('not a tmux session'), []);
    return false;
  }

  request() {
    return Promise.reject(new Error('not a tmux session'));
  }

  sendBytes(buf) {
    if (this.closed || !buf || !buf.length) return;
    this.session.write(buf);
  }

  resize(cols, rows) {
    this.fit(cols, rows, () => {});
  }

  /** Same contract as ControlClient.fit: done(true) once the new size is in place. */
  fit(cols, rows, done) {
    if (this.closed) {
      done(false);
      return;
    }
    this.session.resize(cols, rows, done);
  }

  /** CLEAR + the serialized screen (2000 rows of history, cursor, modes): an exact cut. */
  snapshot(modes, cb) {
    const s = this.session;
    if (this.closed || !s || s.closed) {
      cb(null);
      return;
    }
    s.barrier(() => {
      let data = null;
      try {
        data = CLEAR + s.serializer.serialize({ scrollback: SNAPSHOT_HISTORY }) + (modes ? modes.replay() : '');
      } catch {
        data = null;
      }
      cb(data);
    });
  }

  close() {
    this.markClosed({ reason: 'detached' });
  }
}

export class PtyBackend {
  /**
   * @param {{pty: object, Terminal: Function, SerializeAddon: Function, version?: string,
   *   platform?: string, logger?: object, attachPrefix?: string}} opts
   */
  constructor({ pty, Terminal, SerializeAddon, version = null, platform = process.platform, logger = null, attachPrefix = 'clawdling', scrollback = 5000, killGroup = signalGroup }) {
    this.kind = 'pty';
    this.persistent = false; // sessions end when the Clawdling server stops
    this.launcher = false; // sessions are spawned directly: no shell ever parses an argument
    this.bin = null;
    this.socket = null;
    Object.assign(this, { pty, Terminal, SerializeAddon, ptyVersion: version, platform, logger, attachPrefix, scrollback, killGroup });
    this.sessions = new Map();
  }

  async init() {}

  missing() {
    return null;
  }

  attachCommand(rec) {
    return `${this.attachPrefix} attach ${rec.sid.slice(0, 8)}`;
  }

  describe() {
    return { kind: 'pty', persistent: false, version: this.ptyVersion ? `node-pty ${this.ptyVersion}` : 'node-pty' };
  }

  async version() {
    return { ok: true, version: this.describe().version };
  }

  live(name) {
    const s = this.sessions.get(nameOf(name));
    return s && !s.exited ? s : null;
  }

  async listSessions() {
    return [...this.sessions.values()].filter((s) => !s.exited).map((s) => ({ name: s.name, id: s.name, pane: s.name, sid: s.sid, agent: s.agent }));
  }

  async hasSession(name) {
    return !!this.live(name);
  }

  /**
   * Start `launch.argv` in a new pseudo-terminal (no shell in between, on any OS).
   * @param {{name: string, cols: number, rows: number, launch: {cwd: string, env: object, argv: string[]}}} opts
   */
  async newSession({ name, cols, rows, launch }) {
    if (!launch || !Array.isArray(launch.argv) || !launch.argv.length) throw new Error('the pty backend needs launch {cwd, env, argv}');
    if (this.live(name)) throw new Error(`duplicate session: ${name}`);
    const [file, ...args] = launch.argv;
    const spec = commandFor(file, args, { platform: this.platform, env: launch.env });
    const term = new this.Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true });
    const serializer = new this.SerializeAddon();
    term.loadAddon(serializer);
    const opts = { name: 'xterm-256color', cols, rows, cwd: launch.cwd, env: launch.env };
    let child;
    try {
      // Windows: node-pty takes the command line pre-quoted (its own quoting splits an argument that
      // starts and ends with a quote); a .cmd that is not an npm shim runs through cmd.exe /d /s /c.
      child = this.platform === 'win32'
        ? this.pty.spawn(spec.file, spec.commandLine ?? spec.args.map((a) => quoteWinArg(a)).join(' '), opts)
        : this.pty.spawn(spec.file, spec.args, opts);
    } catch (err) {
      term.dispose();
      throw new Error(`could not start ${path.basename(file)}: ${oneLine(err.message, 200)}`);
    }
    const s = new PtySession({ name, child, term, serializer, platform: this.platform, logger: this.logger, killGroup: this.killGroup });
    this.sessions.set(name, s);
    s.events.once('close', () => {
      if (this.sessions.get(name) === s) this.sessions.delete(name);
    });
    return { sessionId: name, paneId: name };
  }

  /** The tmux backend tags sessions with options; here only the tags mean anything. */
  async setOptions(name, pairs) {
    const s = this.live(name);
    if (!s) return;
    for (const [k, v] of pairs) {
      if (k === '@clawdling_sid') s.sid = String(v);
      else if (k === '@clawdling_agent') s.agent = String(v);
    }
  }

  async killSession(name) {
    const s = this.live(name);
    if (!s) return false;
    s.terminate();
    return true;
  }

  async resizeWindow(name, cols, rows) {
    this.live(name)?.resize(cols, rows);
  }

  async screenText(target) {
    const s = this.sessions.get(nameOf(target));
    if (!s || s.closed) throw new Error(`no session ${nameOf(target)}`);
    await s.barrierAsync();
    return visibleText(s.term);
  }

  /** History plus screen as plain text (capture-pane -p -S -<history>). */
  async capture(target, history = 2000) {
    const s = this.sessions.get(nameOf(target));
    if (!s || s.closed) throw new Error(`no session ${nameOf(target)}`);
    await s.barrierAsync();
    const buf = s.term.buffer.active;
    const start = Math.max(0, buf.baseY - history);
    const lines = [];
    for (let i = start; i < buf.baseY + s.term.rows; i++) lines.push((buf.getLine(i)?.translateToString(true)) ?? '');
    return lines.join('\n') + '\n';
  }

  /**
   * Paste text the way tmux's paste-buffer -p does: newlines become Enter (CR), wrapped in
   * bracketed-paste markers when the app turned that mode on (so a multi-line paste is one paste).
   */
  async paste(target, text) {
    const s = this.live(target);
    if (!s) throw new Error(`no live session ${nameOf(target)}`);
    await s.barrierAsync();
    const body = String(text).replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r');
    // ConPTY may keep the app's bracketed-paste request to itself: never let a multi-line paste
    // turn into several submitted prompts on Windows.
    const bracket = s.term.modes.bracketedPasteMode || (this.platform === 'win32' && body.includes('\r'));
    s.write(bracket ? `\x1b[200~${body}\x1b[201~` : body);
  }

  async sendKeysHex(target, bytes) {
    const s = this.live(target);
    if (!s) throw new Error(`no live session ${nameOf(target)}`);
    s.write(Buffer.from(bytes));
  }

  control(name) {
    return new PtyClient(this.sessions.get(nameOf(name)) || null, nameOf(name));
  }

  async killServer() {
    await this.shutdown();
  }

  /** Stop every session (the server is stopping) and wait, briefly, for them to exit. */
  async shutdown({ timeoutMs = 4000 } = {}) {
    const live = [...this.sessions.values()].filter((s) => !s.closed);
    for (const s of live) s.terminate();
    if (live.length) await Promise.race([Promise.all(live.map((s) => s.exitPromise)), sleep(timeoutMs)]);
  }
}

/** A PtyBackend, or {error} when node-pty or the headless terminal cannot be loaded. */
export function createPtyBackend(opts = {}) {
  const mods = loadPtyModules();
  if (!mods.ok) return { error: mods.error };
  return { backend: new PtyBackend({ ...opts, pty: mods.pty, Terminal: mods.Terminal, SerializeAddon: mods.SerializeAddon, version: mods.version }) };
}
