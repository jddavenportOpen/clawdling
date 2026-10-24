// Git metadata read straight from a repo's .git folder: no git process, no network, read-only.
import fs from 'node:fs';
import path from 'node:path';

function readSmall(file, max = 256 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function mtimeIso(file) {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * A remote URL with any userinfo removed, so a token embedded in it is never shown or stored:
 * `https://user:tok@github.com/a/b.git` -> `https://github.com/a/b.git`. Userinfo runs to the
 * LAST `@` (a password may hold `/`, `?`, `#` or `:`: `https://u:tok/x@host/a`,
 * `deploy:tok@host:a/b`). scp-style `git@host:a/b.git` keeps `git@` (the protocol's user, not a
 * secret); any other user is dropped. Query strings and fragments are dropped too.
 */
export function sanitizeRemote(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u || /[\s\0]/.test(u)) return null;
  const scheme = u.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (scheme) {
    let rest = scheme[2];
    const at = rest.lastIndexOf('@');
    if (at !== -1) rest = rest.slice(at + 1);
    rest = rest.replace(/[?#].*$/, '');
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    if (!authority) return null;
    return `${scheme[1].toLowerCase()}://${authority}${slash === -1 ? '' : rest.slice(slash)}`;
  }
  if (path.isAbsolute(u) || /^[A-Za-z]:[\\/]/.test(u)) return u; // a local path remote
  const at = u.lastIndexOf('@');
  const user = at === -1 ? null : u.slice(0, at);
  // Hosts may be ssh config aliases, which can hold an underscore (`github_work`).
  const scp = (at === -1 ? u : u.slice(at + 1)).match(/^([A-Za-z0-9._-]+):(?!\/\/)(.+)$/);
  if (scp && !/^[A-Za-z]$/.test(scp[1])) return `${user === 'git' ? 'git@' : ''}${scp[1]}:${scp[2].replace(/[?#].*$/, '')}`;
  return null;
}

/**
 * A comparable identity for a remote: `github.com/owner/name`, lowercase, no scheme, user,
 * port or `.git`. https and ssh forms of the same repo give the same key. null if unparseable.
 */
export function remoteKey(url) {
  const clean = sanitizeRemote(url);
  if (!clean) return null;
  let host;
  let p;
  const scheme = clean.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*)?$/i);
  if (scheme) {
    host = scheme[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
    p = scheme[2] || '';
  } else {
    const scp = clean.match(/^(?:[^@]+@)?([^:]+):(.*)$/);
    if (!scp || path.isAbsolute(clean)) return null;
    host = scp[1];
    p = scp[2];
  }
  p = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !p || /^[A-Za-z]$/.test(host)) return null; // a Windows drive letter, not a host
  host = host.toLowerCase();
  // An ssh config alias for GitHub (`github-work`, `github-personal`: no dot) is github.com.
  if (!host.includes('.') && /^github([-_].+)?$/.test(host)) host = 'github.com';
  return `${host}/${p.toLowerCase()}`;
}

/** The folder holding a repo's git data for `dir` (follows a worktree's `gitdir:` file), or null. */
export function gitDirOf(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try {
    st = fs.statSync(dotgit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotgit;
  if (!st.isFile()) return null;
  const m = (readSmall(dotgit, 4096) || '').match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const gd = path.resolve(dir, m[1]);
  try {
    return fs.statSync(gd).isDirectory() ? gd : null;
  } catch {
    return null;
  }
}

/** The shared git dir of a worktree's git dir (its `commondir`), else the dir itself. */
function commonDirOf(gitDir) {
  const c = readSmall(path.join(gitDir, 'commondir'), 4096);
  if (!c || !c.trim()) return gitDir;
  return path.resolve(gitDir, c.trim());
}

/** How many backslashes end `s`. */
function trailingBackslashes(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) n++;
  return n;
}

/**
 * A git config's lines with continuations joined: a line ending in an odd number of backslashes
 * goes on with the next line (git-config(1)), so `url = https://u:tok\` + `@host/x` is one value.
 */
function joinContinuations(text) {
  const raw = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const parts = [];
    let piece = raw[i];
    while (trailingBackslashes(piece) % 2 === 1 && i + 1 < raw.length) {
      parts.push(piece.slice(0, -1));
      piece = raw[++i];
    }
    parts.push(piece);
    out.push(parts.join(''));
  }
  return out;
}

/** `[remote "x"] url = ...` entries of a git config, in file order. */
export function configRemotes(text) {
  const out = [];
  let cur = null;
  for (const line of joinContinuations(text)) {
    const sec = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (sec) {
      cur = sec[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s*url\s*=\s*(.+?)\s*$/i);
    if (kv) out.push({ name: cur, url: kv[1].replace(/^"(.*)"$/, '$1') });
  }
  return out;
}

/**
 * What a repo is, without running git: `{root, remote, branch, last_commit_at}`. `remote` is the
 * origin's URL (else the first remote's) with userinfo stripped. `last_commit_at` is the mtime of
 * the reflog (updated by commits, checkouts, pulls), else the index, else HEAD. null if `dir` is
 * not a repo root.
 */
export function gitInfo(dir) {
  const gd = gitDirOf(dir);
  if (!gd) return null;
  const common = commonDirOf(gd);
  const head = (readSmall(path.join(gd, 'HEAD'), 4096) || '').trim();
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  const branch = ref ? ref[1] : head ? 'detached' : null;
  const remotes = configRemotes(readSmall(path.join(common, 'config')) || '');
  const pick = remotes.find((r) => r.name === 'origin') || remotes[0] || null;
  const last = mtimeIso(path.join(gd, 'logs', 'HEAD')) || mtimeIso(path.join(gd, 'index')) || mtimeIso(path.join(gd, 'HEAD'));
  return { root: dir, remote: pick ? sanitizeRemote(pick.url) : null, branch, last_commit_at: last };
}

/** The nearest folder at or above `p` that is a repo root, not going above `stopAt`. */
export function findGitRoot(p, { stopAt } = {}) {
  let cur = path.resolve(p);
  const stop = stopAt ? path.resolve(stopAt) : null;
  for (;;) {
    if (gitDirOf(cur)) return cur;
    if (stop && cur === stop) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    if (stop && !(parent + path.sep).startsWith(stop + path.sep) && parent !== stop) return null;
    cur = parent;
  }
}

/** `owner/name` (lowercase) for a GitHub remote, else null. */
export function githubSlug(url) {
  const key = remoteKey(url);
  const m = key && key.match(/^github\.com\/([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
}
