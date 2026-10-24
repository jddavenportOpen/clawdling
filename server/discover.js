// "Bring in your projects" and "Your Claude Code setup": find the folders where Claude Code has
// been used, the git repos under the usual code folders and (only through the user's own `gh`)
// their GitHub repos, and list the Claude Code setup every session inherits.
//
// Read-only and local. Nothing here writes a file or opens a socket. The only process it ever
// starts is `gh` (defaultExec refuses anything else); git metadata is read straight from `.git`.
// The setup scan returns NAMES and DESCRIPTIONS only: from ~/.claude.json it takes the keys of
// `mcpServers` and nothing else, hook commands are never read past their event name, and every
// free-text field passes through redactSecrets().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { findGitRoot, gitDirOf, gitInfo, remoteKey, sanitizeRemote } from './git.js';
import { which } from './paths.js';
import { commandFor, envGet, spawnOptions } from './platform.js';
import { detectStack, readmeExcerpt } from './stack.js';
import { claudeConfigDir } from './transcripts.js';
import { execFileP, oneLine } from './util.js';

const MAX_FILE = 20 * 1024 * 1024; // files larger than this are skipped, never read
const HEAD_BYTES = 64 * 1024; // a transcript's head, a skill's frontmatter, a CLAUDE.md's opening
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 90;
const DESC_MAX = 300;
const NAME_MAX = 100;
const LIST_MAX = 500; // skills, subagents, commands, MCP servers per source
const REDACTED = '[redacted]';

// ------------------------------------------------------------------------------ small fs helpers

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function defaultIsDir(p) {
  return !!statSafe(p)?.isDirectory();
}

function isFile(p) {
  return !!statSafe(p)?.isFile();
}

/** realpath, or null when the path does not exist. */
function real(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Up to `max` directory entries (Dirents), and whether there were more. Never throws. */
function listEntries(dir, max) {
  const out = [];
  let more = false;
  let d;
  try {
    d = fs.opendirSync(dir);
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (out.length >= max) {
        more = true;
        break;
      }
      out.push(e);
    }
  } catch {
    // unreadable: whatever was read so far
  } finally {
    try {
      d?.closeSync();
    } catch {
      // ignore
    }
  }
  return { entries: out, more };
}

/** Is a Dirent (or the symlink it is) a directory / a file? */
function direntIsDir(dir, e) {
  if (e.isDirectory()) return true;
  return e.isSymbolicLink() && defaultIsDir(path.join(dir, e.name));
}
function direntIsFile(dir, e) {
  if (e.isFile()) return true;
  return e.isSymbolicLink() && isFile(path.join(dir, e.name));
}

/** The first `bytes` bytes of a file as UTF-8 (a partial last line is the caller's problem). */
function readHeadDefault(file, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** A regular file's text (whole, or its head), or null when missing or over MAX_FILE. */
function readCapped(file, { head = false } = {}) {
  const st = statSafe(file);
  if (!st || !st.isFile() || st.size > MAX_FILE) return null;
  if (head) return readHeadDefault(file, HEAD_BYTES);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse a JSON file of at most MAX_FILE bytes and hand it to `pick`, returning only what `pick`
 * returns. The parsed object never leaves this function, and a parse error (whose message can
 * quote the file) is swallowed, never logged or returned.
 */
function withJson(file, pick) {
  const text = readCapped(file);
  if (text === null) return pick(null);
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    obj = null;
  }
  return pick(obj && typeof obj === 'object' ? obj : null);
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const nowMsOf = (now) => (typeof now === 'function' ? toMs(now()) : toMs(now)) ?? Date.now();

function samePathKey(p, platform = process.platform) {
  return platform === 'win32' ? p.toLowerCase() : p;
}

/** Is `p` the folder `dir` or inside it? Both absolute. */
function isInside(p, dir) {
  const a = samePathKey(path.resolve(p));
  const b = samePathKey(path.resolve(dir));
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** `~/x` for a path under the home folder (display only). */
function tildify(p, home) {
  if (!p) return p;
  const r = path.resolve(p);
  const h = path.resolve(home);
  if (samePathKey(r) === samePathKey(h)) return '~';
  if (isInside(r, h)) return `~${path.sep}${r.slice(h.length).replace(/^[\\/]+/, '')}`;
  return r;
}

// ------------------------------------------------------------------------------ redaction

const SECRET_KEY_WORD = '(?:token|secret|password|passwd|passphrase|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential|auth)';
const STRONG_KEY_RE = /token|secret|password|passwd|passphrase|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential/i;
// `key: value` / `key = value` where the key names a secret. The value is a quoted string or a bare
// run of characters that cannot start with "[" (so an earlier [redacted] is not redacted again).
// Every quantifier is bounded and the key must start a run of key characters, so a hostile 64 KB
// line costs linear time, not quadratic.
const KV_RE = new RegExp(
  `(["']?)(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,48}${SECRET_KEY_WORD}[A-Za-z0-9_.-]{0,48})\\1([ \\t]{0,8})([:=])([ \\t]{0,8})(?:"([^"\\n]{1,512})"|'([^'\\n]{1,512})'|([^\\s"'\`,;<>(){}\\[\\]]{1,1024}))`,
  'gi'
);
const TOKEN_RES = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,16384}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{4,}/g,
  /\bsk-(?=[A-Za-z0-9_-]{0,256}\d)[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{6,}/g,
  /\bxapp-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{8,}/g,
  /\bglpat-[A-Za-z0-9_-]{8,}/g,
  /\bnpm_[A-Za-z0-9]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // a JWT
];

/** A value that looks like a credential rather than a word: long, or letters mixed with digits. */
function looksSecret(v) {
  return v.length >= 20 || (v.length >= 8 && /\d/.test(v) && /[A-Za-z]/.test(v));
}

/** After `Bearer` / `Basic`: a credential, not a word ("Bearer tokens", "Basic Authentication"). */
function looksCredential(v) {
  return looksSecret(v) || v.length >= 16 || (v.length >= 8 && !/^[A-Z]?[a-z]+$/.test(v));
}

/**
 * Text with secret-looking values replaced by `[redacted]`: known token prefixes (sk-ant-, sk-,
 * ghp_/gho_/ghu_/ghs_/ghr_, github_pat_, xox?-, AKIA, AIza, glpat-, npm_, Stripe keys, JWTs,
 * private key blocks), `Bearer <x>` / `Basic <x>`, URL userinfo, and `key = value` /
 * `key: value` where the key names a secret (token, secret, password, api_key, private_key,
 * auth...). Ordinary prose is left alone. Defence in depth: callers never surface credential
 * fields in the first place.
 */
export function redactSecrets(text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  if (!s) return s;
  // URL userinfo: scheme://user:pass@host, or scheme://<token>@host.
  s = s.replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s/@]{1,256})@/gi, (m, scheme, info) => (info.includes(':') || looksSecret(info) ? `${scheme}${REDACTED}@` : m));
  for (const re of TOKEN_RES) s = s.replace(re, REDACTED);
  // Authorization headers, with or without a scheme word.
  s = s.replace(/\b((?:proxy-)?authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)(?:(bearer|basic|token|bot|digest)[ \t]+)?([^\s"',;]{1,2048})/gi, (m, head, scheme, val) =>
    val.startsWith('[') || (!scheme && !looksSecret(val)) ? m : `${head}${scheme ? `${scheme} ` : ''}${REDACTED}`
  );
  s = s.replace(/\b(bearer|basic)([ \t]{1,8})([A-Za-z0-9._~+/=-]{1,4096})/gi, (m, word, sp, val) => (looksCredential(val) ? `${word}${sp}${REDACTED}` : m));
  s = s.replace(KV_RE, (m, q1, key, s1, sep, s2, dq, sq, bare, offset, whole) => {
    const val = dq ?? sq ?? bare ?? '';
    if (!val || val.startsWith(REDACTED) || /authorization/i.test(key)) return m; // headers: done above
    if (/tokens$/i.test(key) && /^\d+$/.test(val)) return m; // max_tokens=4096 is a count
    const quoted = dq !== undefined || sq !== undefined;
    // `auth` alone is too common a fragment (author, OAuth) to mean a secret by itself.
    const relevant = STRONG_KEY_RE.test(key) || /(?:^|[_.-])auth(?:[_.-]|$)/i.test(key);
    let hide;
    if (!relevant) hide = looksSecret(val); // `author: Jane` stays, `OAuth: 9f8e7d6c5b4a` does not
    else if (quoted || sep === '=' || looksSecret(val)) hide = true;
    else {
      // `password: hunter2` is a secret; `Password: reset flows` and `Credentials: rotation` are prose.
      const prose = /^[ \t]+[A-Za-z]/.test(whole.slice(offset + m.length));
      hide = !/s$/i.test(key) && val.length >= 4 && !prose;
    }
    if (!hide) return m;
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `${q1}${key}${q1}${s1}${sep}${s2}${q}${REDACTED}${q}`;
  });
  // ENV_STYLE_KEY=value (STRIPE_KEY=..., DEPLOY_KEY=...).
  s = s.replace(/(?<![A-Z0-9_])([A-Z][A-Z0-9_]{0,64}_KEY)([ \t]{0,8}=[ \t]{0,8})(?!\[redacted\])(\S{1,4096})/g, `$1$2${REDACTED}`);
  return s;
}

/** One line of at most `max` chars, redacted, or null when empty. */
function cleanText(s, max = DESC_MAX) {
  if (s === null || s === undefined) return null;
  const out = oneLine(redactSecrets(String(s)), max);
  return out || null;
}
const cleanName = (s) => cleanText(s, NAME_MAX);

// ------------------------------------------------------------------------------ frontmatter

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function unquoteDouble(s) {
  return s.replace(/\\(["\\/nrt0 ])/g, (m, c) => ({ n: '\n', r: '', t: '\t', 0: '', ' ': ' ' })[c] ?? c);
}

function frontmatterScalar(raw, cont) {
  const block = raw.match(/^([>|])([+-]?)\d?\s*(?:#.*)?$/);
  if (block) {
    const nonBlank = cont.filter((l) => l.trim());
    const indent = nonBlank.length ? Math.min(...nonBlank.map((l) => l.match(/^\s*/)[0].length)) : 0;
    const lines = cont.map((l) => (l.trim() ? l.slice(indent) : ''));
    if (block[1] === '|') return lines.join('\n').replace(/\s+$/, '');
    // Folded: lines join with a space, a blank line is a line break.
    let out = '';
    for (const l of lines) {
      if (!l) out += '\n';
      else out += out && !out.endsWith('\n') ? ` ${l}` : l;
    }
    return out.replace(/\s+$/, '');
  }
  const joined = [raw, ...cont.map((l) => l.trim()).filter(Boolean)].join(' ').trim();
  if (joined.startsWith('"')) {
    const m = joined.match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? unquoteDouble(m[1]) : joined.slice(1);
  }
  if (joined.startsWith("'")) {
    const m = joined.match(/^'((?:[^']|'')*)'/);
    return m ? m[1].replace(/''/g, "'") : joined.slice(1);
  }
  if (!raw && cont.length && cont.every((l) => !l.trim() || /^\s*-\s/.test(l) || /^\s*-$/.test(l))) {
    // A block list (`tools:\n  - Read\n  - Grep`): the items, comma separated.
    return cont
      .map((l) => l.replace(/^\s*-\s?/, '').trim().replace(/^(["'])(.*)\1$/, '$2'))
      .filter(Boolean)
      .join(', ');
  }
  let v = joined.replace(/\s+#.*$/, '');
  const flow = v.match(/^\[(.*)\]$/);
  if (flow) v = flow[1].split(',').map((x) => x.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean).join(', ');
  return v;
}

/**
 * Split a Markdown file with YAML-ish frontmatter: `key: value` lines between `---` fences.
 * Quoted values are unquoted, `>` and `|` block values are folded / kept, plain multi-line values
 * are joined, a list becomes "a, b". Every value is a string. No frontmatter: data is {}.
 * @returns {{data: Record<string, string>, body: string}}
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return { data: {}, body: src };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: src };
  const fm = lines.slice(1, end);
  const data = {};
  for (let i = 0; i < fm.length; i++) {
    const m = fm[i].match(/^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/);
    if (!m) continue;
    const cont = [];
    while (i + 1 < fm.length && (/^\s+\S/.test(fm[i + 1]) || !fm[i + 1].trim())) cont.push(fm[++i]);
    if (FORBIDDEN_KEYS.has(m[1])) continue;
    data[m[1]] = frontmatterScalar((m[2] || '').trim(), cont);
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

// ------------------------------------------------------------------------------ Claude Code history

/**
 * Claude Code's folder name for a working directory under `<config>/projects/`: every character
 * outside [A-Za-z0-9] becomes `-` (verified against real folders: `/a/my_app` -> `-a-my-app`,
 * `/x/.claude/w` -> `-x--claude-w`; Windows `C:\x\y` -> `C--x-y`).
 */
export function encodeProjectPath(p) {
  return String(p ?? '').replace(/[^A-Za-z0-9]/g, '-');
}

function defaultReaddir(dir) {
  // A big folder on the way (macOS's temp folder holds tens of thousands) must still be walkable;
  // the step budget in decodeProjectDirName bounds the total work.
  const { entries } = listEntries(dir, 200000);
  return entries.filter((e) => direntIsDir(dir, e)).map((e) => e.name);
}

/**
 * The absolute path behind a Claude Code history folder name, or null. The encoding is lossy
 * (`-` was `/`, `.`, `_`, a space or `-`), so this walks the real filesystem from the root, at
 * each level taking a child folder whose encoded name is a prefix of what is left (longest
 * first) and backtracking from dead ends. `C--Users-x` decodes from `C:\`.
 * Options (for tests): `isDir`, `readdir(dir) -> names`, `root` (a folder to start from; the name
 * must begin with its encoding), `path` (a path module, e.g. path.win32).
 */
export function decodeProjectDirName(name, { isDir = defaultIsDir, readdir = defaultReaddir, root, path: pathMod } = {}) {
  if (typeof name !== 'string' || !name || name.length > 4096 || /[\\/\0]/.test(name)) return null;
  let start;
  let rest;
  let p = pathMod;
  if (root) {
    p = p || (/^[A-Za-z]:(?:[\\/]|$)|\\/.test(root) ? path.win32 : path.posix);
    start = p.parse(root).root === root ? root : root.replace(/[\\/]+$/, '');
    const enc = encodeProjectPath(start);
    if (enc.endsWith('-') && p.parse(start).root === start) {
      if (!name.startsWith(enc)) return null;
      rest = name.slice(enc.length);
    } else if (name === enc) rest = '';
    else if (name.startsWith(`${enc}-`)) rest = name.slice(enc.length + 1);
    else return null;
  } else {
    const win = name.match(/^([A-Za-z])--(.*)$/);
    if (win) {
      p = p || path.win32;
      start = `${win[1].toUpperCase()}:\\`;
      rest = win[2];
    } else if (name.startsWith('-')) {
      p = p || path.posix;
      start = '/';
      rest = name.slice(1);
    } else return null;
  }
  if (!rest) return isDir(start) ? start : null;
  const listings = new Map();
  let steps = 0;
  const walk = (dir, left) => {
    if (++steps > 500) return null;
    let kids = listings.get(dir);
    if (!kids) {
      try {
        kids = (readdir(dir) || []).map((k) => [k, encodeProjectPath(k)]);
      } catch {
        kids = [];
      }
      listings.set(dir, kids);
    }
    const hits = kids.filter(([, e]) => e === left || left.startsWith(`${e}-`)).sort((a, b) => b[1].length - a[1].length);
    for (const [k, e] of hits) {
      const full = p.join(dir, k);
      if (!isDir(full)) continue;
      if (e === left) return full;
      const found = walk(full, left.slice(e.length + 1));
      if (found) return found;
    }
    return null;
  };
  return walk(start, rest);
}

function isAbsoluteAny(p) {
  return typeof p === 'string' && (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) && !p.includes('\0');
}

/** The working directory a transcript head records (only `cwd`; the rest is dropped at once). */
function cwdFromHead(text, name) {
  let first = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"cwd"')) continue;
    let cwd = null;
    try {
      const o = JSON.parse(line);
      cwd = o && typeof o.cwd === 'string' ? o.cwd : null;
    } catch {
      continue; // the cut-off last line, or not JSON
    }
    if (!isAbsoluteAny(cwd) || cwd.length > 4096) continue;
    if (encodeProjectPath(cwd) === name) return cwd;
    first = first || cwd;
  }
  return first;
}

/**
 * The folders Claude Code has been used in, from `<configDir>/projects/*`, newest first:
 * `[{path, last_session_at, sessions}]`. path = the `cwd` of the newest transcript (only its first
 * 64 KB is read, only `cwd` kept), else the decoded folder name. Folders that no longer exist are
 * skipped. `skipName(name)` drops a history folder by name before anything inside it is touched
 * (temp folders); `exclude(path)` drops a decoded path without using up the cap.
 */
export function claudeProjectFolders({
  configDir,
  isDir = defaultIsDir,
  readHead = readHeadDefault,
  skipName = () => false,
  exclude = () => false,
  limit = 300,
  maxFolders = 100000,
  maxInspect = 1500,
  maxFilesPerFolder = 5000,
} = {}) {
  if (!configDir) return [];
  const root = path.join(configDir, 'projects');
  const { entries } = listEntries(root, maxFolders);
  const folders = [];
  for (const e of entries) {
    if (skipName(e.name) || !direntIsDir(root, e)) continue;
    const st = statSafe(path.join(root, e.name));
    if (st) folders.push({ name: e.name, dir: path.join(root, e.name), mtime: st.mtimeMs });
  }
  folders.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  let inspected = 0;
  for (const f of folders) {
    if (out.length >= limit || inspected >= maxInspect) break;
    inspected++;
    const { entries: files, more } = listEntries(f.dir, maxFilesPerFolder);
    let newest = null;
    let sessions = 0;
    for (const x of files) {
      if (!x.name.endsWith('.jsonl') || !x.isFile()) continue;
      sessions++;
      const st = statSafe(path.join(f.dir, x.name));
      if (st && (!newest || st.mtimeMs > newest.mtime)) newest = { file: path.join(f.dir, x.name), mtime: st.mtimeMs };
    }
    // Only a transcript's head is read (never the whole file, however large). A recorded cwd is
    // trusted as is: when it is gone the folder is gone, and decoding the name instead could land
    // on a lossy sibling (a deleted my_app read as the my-app next to it).
    let p = newest ? cwdFromHead(readHead(newest.file, HEAD_BYTES), f.name) : null;
    if (!p) p = decodeProjectDirName(f.name, { isDir });
    if (!p || !isDir(p) || exclude(p)) continue;
    // A listing cut short may have missed the newest transcript; the folder's own mtime (a new
    // transcript was created in it) bounds it from below.
    const last = newest ? (more ? Math.max(newest.mtime, f.mtime) : newest.mtime) : f.mtime;
    out.push({ path: p, last_session_at: iso(last), sessions });
  }
  return out.sort((a, b) => (b.last_session_at || '').localeCompare(a.last_session_at || ''));
}

// ------------------------------------------------------------------------------ local git repos

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'venv', 'target', 'dist', 'build', 'Library', 'Pictures', 'Music', 'Movies', '__pycache__']);
const ROOT_NAMES = [['code'], ['projects'], ['dev'], ['src'], ['repos'], ['GitHub'], ['Documents', 'GitHub'], ['Developer'], ['source', 'repos']];

/** The usual code folders under `homedir` that exist (deduplicated by realpath). */
export function defaultRoots(homedir = os.homedir(), platform = process.platform, { isDir = defaultIsDir } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  const seen = new Set();
  for (const parts of ROOT_NAMES) {
    const dir = p.join(homedir, ...parts);
    if (!isDir(dir)) continue;
    const key = samePathKey(real(dir) || dir, platform === 'darwin' ? 'win32' : platform); // macOS: case-insensitive
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * Git repos under `roots`: `[{path}]`. A repo is a folder with a `.git` entry (a folder, or a
 * worktree's `.git` file); the walk never descends into a repo, node_modules, dot-folders,
 * vendor/venv/target/dist/build or the macOS media folders, skips a folder with more than
 * `maxDirEntries` entries, goes `maxDepth` levels below a root and stops after `maxEntries`.
 */
export function findGitRepos({ roots = [], maxDepth = 3, maxEntries = 20000, maxDirEntries = 2000 } = {}) {
  const out = [];
  const seen = new Set();
  let visited = 0;
  const visit = (dir, depth) => {
    if (visited >= maxEntries) return;
    const key = samePathKey(real(dir) || dir);
    if (seen.has(key)) return;
    seen.add(key);
    try {
      fs.lstatSync(path.join(dir, '.git'));
      out.push({ path: dir });
      return;
    } catch {
      // not a repo: look inside
    }
    if (depth >= maxDepth) return;
    const { entries, more } = listEntries(dir, maxDirEntries);
    if (more) return;
    visited += entries.length;
    for (const e of entries) {
      if (visited >= maxEntries) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (!direntIsDir(dir, e)) continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) {
    if (typeof r === 'string' && r && defaultIsDir(r)) visit(path.resolve(r), 0);
  }
  return out;
}

/**
 * For a linked worktree (`.git` is a file whose git dir has a `commondir`), the main checkout's
 * folder, when it still exists. null for a normal repo, a submodule or a bare-repo worktree.
 */
function mainCheckout(root) {
  let st;
  try {
    st = fs.lstatSync(path.join(root, '.git'));
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const gd = gitDirOf(root);
  if (!gd) return null;
  const c = readCapped(path.join(gd, 'commondir'), { head: true });
  if (!c || !c.trim()) return null;
  const common = path.resolve(gd, c.trim());
  if (path.basename(common) !== '.git') return null;
  const main = path.dirname(common);
  return defaultIsDir(path.join(main, '.git')) ? real(main) : null;
}

// ------------------------------------------------------------------------------ GitHub (via gh)

const GH_FIELDS = ['name', 'nameWithOwner', 'description', 'pushedAt', 'primaryLanguage', 'isPrivate', 'url', 'isArchived', 'isFork'];
const GH_OLD_FIELDS = GH_FIELDS.filter((f) => f !== 'isArchived' && f !== 'isFork');
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NWO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Run the user's own `gh` (found on env.PATH, through its .cmd shim on Windows) with argv only,
 * no shell. Resolves {stdout, stderr}; rejects on a non-zero exit, a timeout, or (code ENOENT)
 * when gh is not installed. Refuses any program but gh: discovery starts nothing else.
 */
export async function defaultExec(file, args, { timeout = 15000, env = process.env } = {}) {
  if (file !== 'gh') throw new Error(`discover only runs gh, not ${file}`);
  const resolved = which(file, envGet(env, 'PATH') || '', { env });
  if (!resolved) {
    const err = new Error(`${file} is not installed`);
    err.code = 'ENOENT';
    throw err;
  }
  const spec = commandFor(resolved, args, { env });
  return execFileP(spec.file, spec.args, { timeout, env, spawn: spawnOptions(spec) });
}

function ghFailure(err) {
  if (!err) return 'error';
  if (err.code === 'ENOENT') return 'missing';
  const text = `${err.stderr || ''}\n${err.message || ''}`;
  if (/unknown json field/i.test(text)) return 'fields';
  if (err.code === 4 || /gh auth login|not logged in|authentication required|HTTP 401|bad credentials|no oauth token/i.test(text)) return 'auth';
  if (err.killed || err.signal || err.code === 'ETIMEDOUT') return 'timeout';
  return 'error';
}

function ghErrorText(err) {
  if (ghFailure(err) === 'timeout') return 'gh did not answer in time';
  const first = String(err?.stderr || err?.message || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return cleanText(first || 'gh failed', 200);
}

function normRepo(r) {
  if (!isObj(r)) return null;
  const nwo = typeof r.nameWithOwner === 'string' ? r.nameWithOwner.trim() : '';
  if (!NWO_RE.test(nwo)) return null;
  const name = nwo.split('/')[1];
  if (name === '.' || name === '..') return null;
  const url = (typeof r.url === 'string' && sanitizeRemote(r.url)) || `https://github.com/${nwo}`;
  const pushed = toMs(r.pushedAt);
  return {
    name,
    nameWithOwner: nwo,
    description: cleanText(r.description),
    pushedAt: iso(pushed),
    language: isObj(r.primaryLanguage) ? cleanText(r.primaryLanguage.name, 60) : null,
    isPrivate: r.isPrivate === true,
    url,
    isArchived: r.isArchived === true,
    isFork: r.isFork === true,
  };
}

function parseRepoList(stdout) {
  let list;
  try {
    list = JSON.parse(String(stdout || '').trim() || '[]');
  } catch {
    throw new Error('gh repo list returned something that is not JSON');
  }
  if (!Array.isArray(list)) throw new Error('gh repo list returned something that is not a list');
  return list.map(normRepo).filter(Boolean);
}

const lines = (s) =>
  String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * The user's GitHub repos through their own `gh`: `{installed, authed, user, repos, error}`.
 * `gh repo list` (the user's own, up to `limit`), `gh api user` for the login, `gh api user/orgs`
 * and `gh repo list <org>` for the first `orgLimit` orgs. Each call has a timeout and the whole
 * thing a budget; no single failure is fatal. gh missing -> installed false; not signed in ->
 * authed false; authed null when gh could not tell (offline, timed out). An old gh that does not
 * know isArchived/isFork is asked again without them. Never reads GH_TOKEN or hosts.yml and never
 * passes a token: gh runs with the inherited environment plus "no prompts, no update check".
 */
export async function githubRepos({ exec = defaultExec, env = process.env, limit = 100, orgLimit = 5, orgRepoLimit = 50, timeout = 15000, budget = 20000 } = {}) {
  const started = Date.now();
  const ghEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  const run = async (args) => {
    const left = budget - (Date.now() - started);
    if (left < 250) {
      const err = new Error('gh: out of time');
      err.killed = true;
      throw err;
    }
    return exec('gh', args, { timeout: Math.min(timeout, left), env: ghEnv });
  };
  let fields = GH_FIELDS;
  const listRepos = async (owner, n) => {
    const args = () => ['repo', 'list', ...(owner ? [owner] : []), '--json', fields.join(','), '--limit', String(n)];
    try {
      return parseRepoList((await run(args())).stdout);
    } catch (err) {
      if (ghFailure(err) !== 'fields' || fields === GH_OLD_FIELDS) throw err;
      fields = GH_OLD_FIELDS;
      return parseRepoList((await run(args())).stdout);
    }
  };
  const [userR, listR, orgsR] = await Promise.allSettled([
    run(['api', 'user', '--jq', '.login']),
    listRepos(null, limit),
    orgLimit > 0 ? run(['api', 'user/orgs', '--jq', '.[].login']) : Promise.resolve({ stdout: '' }),
  ]);
  const kinds = [userR, listR, orgsR].filter((r) => r.status === 'rejected').map((r) => ghFailure(r.reason));
  if (kinds.includes('missing')) return { installed: false, authed: false, user: null, repos: [], error: null };
  if (kinds.includes('auth')) return { installed: true, authed: false, user: null, repos: [], error: null };
  const userLine = userR.status === 'fulfilled' ? lines(userR.value.stdout)[0] : null;
  const user = userLine && LOGIN_RE.test(userLine) ? userLine : null;
  const repos = [];
  const seen = new Set();
  const add = (list) => {
    for (const r of list) {
      const k = r.nameWithOwner.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      repos.push(r);
    }
  };
  if (listR.status === 'fulfilled') add(listR.value);
  const orgs = orgsR.status === 'fulfilled' ? [...new Set(lines(orgsR.value.stdout).filter((o) => LOGIN_RE.test(o) && o !== user))].slice(0, orgLimit) : [];
  const orgResults = await Promise.allSettled(orgs.map((o) => listRepos(o, orgRepoLimit)));
  for (const r of orgResults) if (r.status === 'fulfilled') add(r.value);
  const anyOk = userR.status === 'fulfilled' || listR.status === 'fulfilled' || orgResults.some((r) => r.status === 'fulfilled');
  const error = listR.status === 'rejected' ? ghErrorText(listR.reason) : null;
  return { installed: true, authed: anyOk ? true : null, user, repos, error };
}

// ------------------------------------------------------------------------------ merge

/** Temp folders, as given and as realpaths (macOS /var -> /private/var). */
export function defaultTmpDirs(platform = process.platform) {
  const base = platform === 'win32' ? [os.tmpdir()] : [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];
  const out = [];
  for (const d of base) {
    for (const v of [path.resolve(d), real(d)]) if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The temp folders to exclude, minus any that hold the home folder itself (a sandbox or CI box
 * with HOME under /tmp would otherwise have every project excluded).
 */
function tempDirsOutside(tmpDirs, home) {
  const homes = [path.resolve(home), real(home)].filter(Boolean);
  // Compare realpaths too: /var/folders holds a home under /private/var/folders on macOS.
  return (Array.isArray(tmpDirs) ? tmpDirs : []).filter((t) => typeof t === 'string' && t && !homes.some((h) => isInside(h, t) || isInside(h, real(t) || t)));
}

/** A history-folder-name filter for temp folders (cheap: no fs access for 25k scratch folders). */
function tempNameFilter(tmpDirs) {
  const prefixes = [...new Set(tmpDirs.map((d) => encodeProjectPath(path.resolve(d))).filter((e) => e.length > 2))];
  return (name) => prefixes.some((pre) => name === pre || name.startsWith(`${pre}-`));
}

function makeExcluder({ home, orgHome, configDir, tmpDirs = [] }) {
  const variants = (p) => {
    if (!p) return [];
    const r = path.resolve(p);
    const rr = real(r);
    return rr && rr !== r ? [r, rr] : [r];
  };
  const trees = [
    ...variants(orgHome),
    ...variants(home && path.join(home, '.clawdling-accounts')),
    ...variants(configDir),
    ...variants(home && path.join(home, '.claude')),
    ...tmpDirs.flatMap(variants),
  ];
  const exact = variants(home).map((p) => samePathKey(p));
  return (p) => {
    const r = path.resolve(p);
    if (path.parse(r).root === r) return true;
    if (exact.includes(samePathKey(r))) return true;
    return trees.some((t) => isInside(r, t));
  };
}

function agentMatcher(agents) {
  const byPath = new Map();
  const byKey = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.id !== 'string' || (a.kind && a.kind !== 'project')) continue;
    const info = { id: a.id, name: typeof a.name === 'string' && a.name ? a.name : a.id };
    for (const r of [a.repo, ...(Array.isArray(a.repos) ? a.repos : [])]) {
      if (typeof r !== 'string' || !r) continue;
      for (const v of [path.resolve(r), real(r)]) if (v && !byPath.has(samePathKey(v))) byPath.set(samePathKey(v), info);
    }
    const k = a.source && typeof a.source.remote_key === 'string' ? a.source.remote_key.toLowerCase() : null;
    if (k && !byKey.has(k)) byKey.set(k, info);
  }
  return (p, rk) => (p && byPath.get(samePathKey(p))) || (rk && byKey.get(rk)) || null;
}

function firstSentence(text) {
  if (!text) return null;
  const para = String(text).split(/\n\s*\n/)[0];
  const m = para.match(/^(.+?[.!?])(?:\s|$)/);
  return (m ? m[1] : para).trim() || null;
}

function githubView(r) {
  return {
    nameWithOwner: r.nameWithOwner,
    url: sanitizeRemote(r.url) || `https://github.com/${r.nameWithOwner}`,
    private: r.isPrivate === true,
    description: cleanText(r.description),
    pushed_at: iso(toMs(r.pushedAt)),
    archived: r.isArchived === true,
    fork: r.isFork === true,
  };
}

/**
 * One candidate per project, newest activity first. A Claude Code folder inside a repo counts for
 * the repo root (a monorepo is one agent) and a linked worktree for its main checkout; a local
 * repo and a GitHub repo with the same remoteKey are one candidate; anything else is keyed by
 * realpath. Excluded: the org home and everything in it, ~/.clawdling-accounts, the home folder,
 * `/`, temp folders, the Claude config dir, and (unless they are repos) container folders: the
 * scan roots, ~/Desktop, ~/Documents, ~/Downloads.
 */
export function mergeCandidates({
  claude = [],
  local = [],
  github = null,
  agents = [],
  home = os.homedir(),
  orgHome = null,
  configDir = null,
  tmpDirs = defaultTmpDirs(),
  roots = [],
  now = Date.now(),
} = {}) {
  const nowMs = nowMsOf(now);
  const homeDir = path.resolve(home);
  const homeReal = real(homeDir) || homeDir;
  const excluded = makeExcluder({ home: homeDir, orgHome, configDir, tmpDirs: tempDirsOutside(tmpDirs, homeDir) });
  const containers = new Set(
    [...roots, path.join(homeDir, 'Desktop'), path.join(homeDir, 'Documents'), path.join(homeDir, 'Downloads')]
      .flatMap((p) => [path.resolve(p), real(p)])
      .filter(Boolean)
      .map((p) => samePathKey(p))
  );
  const entries = new Map();
  const entryFor = (root) => {
    const k = samePathKey(root);
    let e = entries.get(k);
    if (!e) {
      e = { path: root, sources: new Set(), session: null };
      entries.set(k, e);
    }
    return e;
  };

  for (const r of Array.isArray(local) ? local : []) {
    const rp = real(typeof r === 'string' ? r : r?.path);
    if (!rp || excluded(rp)) continue;
    const main = mainCheckout(rp);
    entryFor(main && !excluded(main) ? main : rp).sources.add('local');
  }
  for (const c of Array.isArray(claude) ? claude : []) {
    const rp = real(c?.path);
    if (!rp || excluded(rp)) continue;
    // Never look above the home folder for a repo root (a dotfiles repo at ~ is not this project).
    const stopAt = isInside(rp, homeReal) ? homeReal : isInside(rp, homeDir) ? homeDir : undefined;
    let root = findGitRoot(rp, stopAt ? { stopAt } : {});
    root = root ? real(root) : null;
    if (root) {
      const main = mainCheckout(root);
      if (main && !excluded(main)) root = main;
    }
    if (!root || excluded(root)) root = rp;
    if (containers.has(samePathKey(root)) && !gitDirOf(root)) continue;
    const e = entryFor(root);
    e.sources.add('claude');
    const t = toMs(c.last_session_at);
    if (t !== null && (e.session === null || t > e.session)) e.session = t;
  }

  // Git facts per folder, then which folder holds each remote's key (the most active clone).
  const items = [...entries.values()].map((e) => {
    const info = gitInfo(e.path);
    const rk = info?.remote ? remoteKey(info.remote) : null;
    const activity = Math.max(toMs(info?.last_commit_at) ?? -Infinity, e.session ?? -Infinity);
    return { e, info, rk, activity, gh: null };
  });
  const primary = new Map();
  for (const it of [...items].sort((a, b) => b.activity - a.activity || a.e.path.localeCompare(b.e.path))) {
    if (it.rk && !primary.has(it.rk)) primary.set(it.rk, it);
  }
  const ghRepos = Array.isArray(github) ? github : Array.isArray(github?.repos) ? github.repos : [];
  const notCloned = [];
  for (const r of ghRepos) {
    if (!r || !r.nameWithOwner) continue;
    const rk = remoteKey(r.url) || `github.com/${String(r.nameWithOwner).toLowerCase()}`;
    const hit = primary.get(rk);
    if (hit) {
      if (!hit.gh) hit.gh = r;
    } else if (!notCloned.some((x) => x.rk === rk)) notCloned.push({ rk, r });
  }

  const agentFor = agentMatcher(agents);
  const out = [];
  for (const it of items) {
    const { e, info, rk, gh } = it;
    const stack = detectStack(e.path);
    const ghv = gh ? githubView(gh) : null;
    let description = ghv?.description || cleanText(stack.description);
    if (!description) description = cleanText(firstSentence(readmeExcerpt(e.path, 600)?.text));
    const lastMs = Math.max(it.activity, toMs(gh?.pushedAt) ?? -Infinity);
    const sources = ['claude', 'local'].filter((s) => e.sources.has(s));
    if (gh) sources.push('github');
    const has = (f) => isFile(path.join(e.path, f));
    out.push({
      key: rk && primary.get(rk) === it ? rk : `path:${e.path}`,
      name: path.basename(e.path) || e.path,
      path: e.path,
      cloned: true,
      remote: info?.remote || null,
      github: ghv,
      language: stack.language || cleanText(gh?.language, 60) || null,
      description: description || null,
      git: !!info,
      last_activity_at: Number.isFinite(lastMs) ? iso(lastMs) : null,
      last_claude_session_at: iso(e.session),
      sources,
      recent: Number.isFinite(lastMs) && nowMs - lastMs <= RECENT_DAYS * DAY_MS,
      agent: agentFor(e.path, rk),
      has: {
        claude_md: has('CLAUDE.md') || has(path.join('.claude', 'CLAUDE.md')),
        agents_md: has('AGENTS.md'),
        dot_claude: defaultIsDir(path.join(e.path, '.claude')),
        mcp_json: has('.mcp.json'),
      },
      monorepo: !!stack.monorepo,
    });
  }
  for (const { rk, r } of notCloned) {
    const lastMs = toMs(r.pushedAt);
    const ghv = githubView(r);
    out.push({
      key: rk,
      name: cleanName(r.name) || String(r.nameWithOwner).split('/')[1],
      path: null,
      cloned: false,
      remote: ghv.url,
      github: ghv,
      language: cleanText(r.language, 60) || null,
      description: ghv.description,
      git: true,
      last_activity_at: iso(lastMs),
      last_claude_session_at: null,
      sources: ['github'],
      recent: lastMs !== null && nowMs - lastMs <= RECENT_DAYS * DAY_MS,
      agent: agentFor(null, rk),
      has: { claude_md: false, agents_md: false, dot_claude: false, mcp_json: false },
      monorepo: false,
    });
  }
  return out.sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || '') || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

// ------------------------------------------------------------------------------ discover

/** `$CLAUDE_CONFIG_DIR/.claude.json` when that is set, else `~/.claude.json`. */
export function claudeJsonPathFor(env = process.env, homedir = os.homedir()) {
  const dir = envGet(env, 'CLAUDE_CONFIG_DIR');
  return dir ? path.join(dir, '.claude.json') : path.join(homedir, '.claude.json');
}

function configDirFor(env, homedir) {
  return envGet(env, 'CLAUDE_CONFIG_DIR') ? claudeConfigDir({ CLAUDE_CONFIG_DIR: envGet(env, 'CLAUDE_CONFIG_DIR') }) : path.join(homedir, '.claude');
}

/**
 * The `GET /api/discover` body: `{candidates, sources: {claude, local, github}, clone_root,
 * took_ms}`. `github: false` skips gh entirely. Local scans take about a second; gh is bounded by
 * its own budget (about 20 s worst case) and runs while the local scans do.
 */
export async function discover({
  env = process.env,
  homedir = os.homedir(),
  configDir,
  orgHome = null,
  agents = [],
  github = true,
  roots,
  exec = defaultExec,
  now = Date.now,
  tmpDirs = defaultTmpDirs(),
  ghTimeout = 15000,
  ghBudget = 20000,
} = {}) {
  const t0 = performance.now();
  const home = path.resolve(homedir);
  const cfg = path.resolve(configDir || configDirFor(env, home));
  const temps = tempDirsOutside(tmpDirs, home);
  // gh first: its processes start now and work while the local scans below run.
  const ghPromise = github === false ? null : githubRepos({ exec, env, timeout: ghTimeout, budget: ghBudget }).catch((err) => ({ installed: true, authed: null, user: null, repos: [], error: ghErrorText(err) }));
  const scanRoots = (roots || defaultRoots(home)).map((r) => path.resolve(r)).filter(defaultIsDir);
  const excluded = makeExcluder({ home, orgHome, configDir: cfg, tmpDirs: temps });
  const claude = claudeProjectFolders({ configDir: cfg, skipName: tempNameFilter(temps), exclude: excluded });
  const local = findGitRepos({ roots: scanRoots });
  const gh = ghPromise ? await ghPromise : null;
  const candidates = mergeCandidates({ claude, local, github: gh, agents, home, orgHome, configDir: cfg, tmpDirs, roots: scanRoots, now });

  // Clone into the scan root that already holds the most repos, else the first one, else ~/code.
  let cloneRoot = scanRoots[0] || path.join(home, 'code');
  let best = 0;
  for (const r of scanRoots) {
    const n = candidates.filter((c) => c.path && isInside(c.path, real(r) || r)).length;
    if (n > best) {
      best = n;
      cloneRoot = r;
    }
  }
  const count = (src) => candidates.filter((c) => c.sources.includes(src)).length;
  return {
    candidates,
    sources: {
      claude: { dir: tildify(path.join(cfg, 'projects'), home), found: count('claude') },
      local: { roots: scanRoots.map((r) => tildify(r, home)), found: count('local') },
      github: gh
        ? { installed: gh.installed, authed: gh.authed, user: gh.user || null, found: gh.repos.length, error: gh.error || null }
        : { installed: null, authed: null, user: null, found: 0, error: null, skipped: true },
    },
    clone_root: cloneRoot,
    took_ms: Math.round(performance.now() - t0),
  };
}

// ------------------------------------------------------------------------------ setup scan

function mdFiles(dir) {
  const { entries } = listEntries(dir, LIST_MAX);
  return entries
    .filter((e) => /\.md$/i.test(e.name) && direntIsFile(dir, e))
    .map((e) => e.name)
    .sort();
}

/** Skills: `<dir>/*\/SKILL.md` -> [{name, description, source}]. */
function listSkills(dir, source) {
  const out = [];
  const { entries } = listEntries(dir, LIST_MAX);
  for (const e of entries) {
    if (e.name.startsWith('.') || !direntIsDir(dir, e)) continue;
    const text = readCapped(path.join(dir, e.name, 'SKILL.md'), { head: true });
    if (text === null) continue;
    const { data } = parseFrontmatter(text);
    const name = cleanName(data.name || e.name);
    if (name) out.push({ name, description: cleanText(data.description), source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Subagents: `<dir>/*.md` -> [{name, description, file, source}]. */
function listSubagents(dir, source) {
  const out = [];
  for (const f of mdFiles(dir)) {
    const text = readCapped(path.join(dir, f), { head: true });
    if (text === null) continue;
    const { data } = parseFrontmatter(text);
    const name = cleanName(data.name || f.replace(/\.md$/i, ''));
    if (name) out.push({ name, description: cleanText(data.description), file: f, source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Slash commands: `<dir>/**\/*.md`, a subfolder's commands named `sub:name`. */
function listCommands(dir) {
  const out = [];
  const walk = (d, prefix, depth) => {
    const { entries } = listEntries(d, LIST_MAX);
    for (const e of entries) {
      if (out.length >= LIST_MAX || e.name.startsWith('.')) continue;
      if (direntIsDir(d, e)) {
        if (depth < 3) walk(path.join(d, e.name), [...prefix, e.name], depth + 1);
        continue;
      }
      if (!/\.md$/i.test(e.name) || !direntIsFile(d, e)) continue;
      const text = readCapped(path.join(d, e.name), { head: true });
      if (text === null) continue;
      const { data, body } = parseFrontmatter(text);
      // Claude Code's own fallback: the first line of the prompt is the description.
      const firstLine = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
      const name = cleanName([...prefix, e.name.replace(/\.md$/i, '')].join(':'));
      if (name) out.push({ name, description: cleanText(data.description || firstLine) });
    }
  };
  walk(dir, [], 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** From a settings.json: hook EVENT names with their hook counts, and enabledPlugins flags. */
function settingsSummary(file) {
  return withJson(file, (s) => {
    const hooks = [];
    if (s && isObj(s.hooks)) {
      for (const [event, groups] of Object.entries(s.hooks)) {
        if (!EVENT_RE.test(event) || !Array.isArray(groups)) continue;
        const count = groups.reduce((n, g) => n + (isObj(g) && Array.isArray(g.hooks) ? g.hooks.length : 1), 0);
        hooks.push({ event, count });
      }
    }
    const enabled = [];
    if (s && isObj(s.enabledPlugins)) for (const [k, v] of Object.entries(s.enabledPlugins)) enabled.push([k, v === true]);
    return { hooks, enabled };
  });
}

function mergeHooks(...lists) {
  const out = [];
  for (const list of lists) {
    for (const h of list) {
      const cur = out.find((x) => x.event === h.event);
      if (cur) cur.count += h.count;
      else out.push({ ...h });
    }
  }
  return out;
}

function claudeJsonProjectKey(p) {
  return samePathKey(String(p).replace(/\\/g, '/').replace(/\/+$/, ''));
}

/**
 * Only the NAMES of MCP servers in ~/.claude.json: top-level `mcpServers` keys, and
 * `projects[<repo>].mcpServers` keys for the given repos. Nothing else is read out of the file
 * and the parsed object is dropped before this returns.
 */
function claudeJsonMcpNames(file, repoPaths) {
  return withJson(file, (j) => {
    const keysOf = (o) => (isObj(o) ? Object.keys(o).slice(0, LIST_MAX) : []);
    const user = keysOf(j?.mcpServers);
    const byRepo = new Map();
    if (j && isObj(j.projects)) {
      const want = new Map();
      for (const p of repoPaths) for (const v of [p, real(p)]) if (v) want.set(claudeJsonProjectKey(v), p);
      for (const [k, v] of Object.entries(j.projects)) {
        const repo = want.get(claudeJsonProjectKey(k));
        if (!repo || !isObj(v)) continue;
        const names = keysOf(v.mcpServers);
        if (names.length) byRepo.set(repo, [...new Set([...(byRepo.get(repo) || []), ...names])]);
      }
    }
    return { user, byRepo };
  });
}

function mcpJsonNames(file) {
  return withJson(file, (j) => (j && isObj(j.mcpServers) ? Object.keys(j.mcpServers).slice(0, LIST_MAX) : []));
}

function namesToMcp(names, scope) {
  const out = [];
  for (const n of names) {
    const name = cleanName(n);
    if (name && !out.some((x) => x.name === name && x.scope === scope)) out.push({ name, scope });
  }
  return out;
}

function claudeMdLines(file) {
  const text = readCapped(file, { head: true });
  if (text === null) return { exists: isFile(file), lines: [] };
  // The opening up to the 8th non-empty line, redacted as one piece (a private key block spans
  // lines), then cut into lines.
  const raw = text.split(/\r?\n/);
  let end = 0;
  for (let seen = 0; end < raw.length && seen < 8; end++) if (raw[end].trim()) seen++;
  const out = [];
  for (const l of redactSecrets(raw.slice(0, end).join('\n')).split('\n')) {
    const t = cleanText(l);
    if (t) out.push(t);
  }
  return { exists: true, lines: out.slice(0, 8) };
}

function listPlugins(cfg, enabled) {
  const installed = withJson(path.join(cfg, 'plugins', 'installed_plugins.json'), (j) => (j && isObj(j.plugins) ? Object.keys(j.plugins).slice(0, LIST_MAX) : []));
  const flags = new Map(enabled);
  const keys = [...new Set([...installed, ...flags.keys()])];
  const out = [];
  for (const k of keys) {
    const at = k.lastIndexOf('@');
    const name = cleanName(at > 0 ? k.slice(0, at) : k);
    if (!name) continue;
    out.push({ name, marketplace: at > 0 ? cleanName(k.slice(at + 1)) : null, enabled: flags.get(k) === true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || String(a.marketplace).localeCompare(String(b.marketplace)));
}

/** `[{path, agent}]` from `repos` (paths or {path, agent}) and/or org agents (their repo/repos). */
function setupRepos(repos, agents) {
  const out = [];
  const seen = new Set();
  const add = (p, agent) => {
    if (typeof p !== 'string' || !p || !isAbsoluteAny(p)) return;
    const rp = real(p);
    if (!rp || !defaultIsDir(rp) || seen.has(samePathKey(rp))) return;
    seen.add(samePathKey(rp));
    out.push({ path: path.resolve(p), agent: typeof agent === 'string' ? agent : null });
  };
  for (const r of Array.isArray(repos) ? repos : []) add(typeof r === 'string' ? r : r?.path, typeof r === 'string' ? null : r?.agent);
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || (a.kind && a.kind !== 'project')) continue;
    for (const p of [a.repo, ...(Array.isArray(a.repos) ? a.repos : [])]) add(p, a.id);
  }
  return out;
}

/**
 * The Claude Code setup every session loads (the `GET /api/setup` body): the first lines of the
 * global CLAUDE.md, skills, subagents, commands, plugins, hook event names with counts, MCP server
 * names, and per repo what the repo adds. Names and descriptions only. `repos` = paths or
 * `{path, agent}`; or pass the org's `agents` and their repos are used.
 */
export function scanSetup({ configDir, claudeJsonPath, repos = [], agents, homedir = os.homedir(), env = process.env } = {}) {
  const home = path.resolve(homedir);
  const cfg = path.resolve(configDir || configDirFor(env, home));
  const repoList = setupRepos(repos, agents);
  const mcp = claudeJsonMcpNames(claudeJsonPath || claudeJsonPathFor(env, home), repoList.map((r) => r.path));
  const settings = settingsSummary(path.join(cfg, 'settings.json'));
  return {
    config_dir: tildify(cfg, home),
    claude_md: claudeMdLines(path.join(cfg, 'CLAUDE.md')),
    skills: listSkills(path.join(cfg, 'skills'), 'user'),
    agents: listSubagents(path.join(cfg, 'agents'), 'user'),
    commands: listCommands(path.join(cfg, 'commands')),
    plugins: listPlugins(cfg, settings.enabled),
    hooks: settings.hooks,
    mcp: namesToMcp(mcp.user, 'user'),
    projects: repoList.map(({ path: repo, agent }) => {
      const dot = path.join(repo, '.claude');
      return {
        path: repo,
        agent,
        claude_md: isFile(path.join(repo, 'CLAUDE.md')) || isFile(path.join(dot, 'CLAUDE.md')),
        agents_md: isFile(path.join(repo, 'AGENTS.md')),
        skills: listSkills(path.join(dot, 'skills'), 'project'),
        agents: listSubagents(path.join(dot, 'agents'), 'project'),
        commands: listCommands(path.join(dot, 'commands')),
        hooks: mergeHooks(settingsSummary(path.join(dot, 'settings.json')).hooks, settingsSummary(path.join(dot, 'settings.local.json')).hooks),
        mcp: [...namesToMcp(mcpJsonNames(path.join(repo, '.mcp.json')), 'project'), ...namesToMcp(mcp.byRepo.get(repo) || [], 'local')],
      };
    }),
  };
}

/**
 * A Claude Code subagent definition looked up BY NAME among `<configDir>/agents/*.md` (scope
 * user) or `<repo>/.claude/agents/*.md` (scope repo), matching its frontmatter `name` (else the
 * file's basename): `{name, description, file, path, body, tools, model}` or null. No path is ever
 * built from `name`. Pass `repos` (allowed repo paths) to refuse a repo outside the org. The body
 * (the subagent's prompt) is read only here, and comes back redacted.
 */
export function findSubagent({ configDir, scope, repo, name, repos } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) return null;
  let dir;
  if (scope === 'user') {
    if (typeof configDir !== 'string' || !configDir) return null;
    dir = path.join(path.resolve(configDir), 'agents');
  } else if (scope === 'repo') {
    if (typeof repo !== 'string' || !isAbsoluteAny(repo)) return null;
    const rr = real(repo);
    if (!rr || !defaultIsDir(rr)) return null;
    if (Array.isArray(repos) && !repos.some((p) => typeof p === 'string' && real(p) && samePathKey(real(p)) === samePathKey(rr))) return null;
    dir = path.join(rr, '.claude', 'agents');
  } else return null;
  const want = name.trim();
  for (const f of mdFiles(dir)) {
    const text = readCapped(path.join(dir, f));
    if (text === null) continue;
    const { data, body } = parseFrontmatter(text);
    const raw = String(data.name || '').trim() || f.replace(/\.md$/i, '');
    if (raw !== want && cleanName(raw) !== want) continue;
    return {
      name: cleanName(raw),
      description: cleanText(data.description),
      file: f,
      path: path.join(dir, f), // for the promoted agent's provenance line
      body: redactSecrets(body.replace(/^\s*\n/, '').replace(/\s+$/, '')),
      tools: cleanText(data.tools, 500),
      model: cleanText(data.model, 100),
    };
  }
  return null;
}
