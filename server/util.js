// Small shared helpers. No dependencies beyond Node itself.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Same shape the claude CLI accepts for model aliases and full model names.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;

export function isValidAgentId(id) {
  return typeof id === 'string' && AGENT_ID_RE.test(id);
}

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function isValidModel(m) {
  return typeof m === 'string' && MODEL_RE.test(m);
}

// The claude CLI's own --effort levels (claude --help, 2.1.283).
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isValidEffort(e) {
  return typeof e === 'string' && EFFORTS.includes(e);
}

/** Turn a free-text name into an agent id. Returns `fallback` if nothing usable is left. */
export function slugify(name, fallback = 'agent') {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s && AGENT_ID_RE.test(s) ? s : fallback;
}

export function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) });
  if (mode) {
    try {
      fs.chmodSync(dir, mode);
    } catch {
      // best effort
    }
  }
  return dir;
}

/** Block for `ms` without spinning (used between rename retries on Windows). */
function pauseSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // no SharedArrayBuffer: retry at once
  }
}

/**
 * Write a file via a temp file + rename so readers never see a half-written file. File modes are
 * POSIX only (Windows keeps just the read-only bit), so a chmod that cannot apply is ignored. On
 * Windows a rename onto a file another process has open (a hook reading server.json, a virus
 * scanner) fails for a moment with EPERM/EBUSY, so it is retried briefly.
 */
export function writeFileAtomic(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    // best effort
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // already gone
        }
        throw err;
      }
      pauseSync(25 + attempt * 10);
    }
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, mode = 0o644) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', mode);
}

/** POSIX single-quote a string for /bin/sh. Everything between single quotes is literal. */
export function shq(value) {
  const s = String(value);
  if (s.includes('\0')) throw new Error('refusing to quote a string that contains a NUL byte');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Promise wrapper around execFile (argv only, never a shell). `spawn` adds child_process options. */
export function execFileP(cmd, args, { timeout = 10000, input, cwd, env, maxBuffer = 32 * 1024 * 1024, spawn: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { windowsHide: true, ...extra, timeout, cwd, env, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    }
  });
}

const ANSI_RE =
  // CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC (ST terminated), then 2-byte escapes.
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/** Replace control characters with spaces (optionally keeping newlines and tabs). */
export function stripControl(s, { keepNewlines = false } = {}) {
  const re = keepNewlines ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return String(s).replace(re, ' ');
}

export function clampText(s, max) {
  const str = String(s ?? '');
  return str.length > max ? str.slice(0, max) : str;
}

/** One-line, trimmed, control-free text of at most `max` chars (for titles, names, notices). */
export function oneLine(s, max = 200) {
  return clampText(stripControl(stripAnsi(String(s ?? ''))).replace(/\s+/g, ' ').trim(), max);
}

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function maskTail(v, keep = 4) {
  const s = String(v ?? '');
  if (!s) return null;
  return '•••' + s.slice(-keep);
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

/** Read up to the last `bytes` bytes of a file as UTF-8, dropping a partial first line. */
export function readTail(file, bytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'not found') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
