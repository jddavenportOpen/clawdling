// Use from anywhere (1.3). The server still listens on 127.0.0.1 only: a Tailscale Serve entry or
// a Cloudflare Tunnel on this computer is the one door in. This file decides which Host names
// that door may use (remote.json), who has signed in through it (remote-devices.json), and
// whether the door is still private (the checks). Nothing here reads a Tailscale, Cloudflare or
// Claude credential: the checks are a read-only `tailscale serve status --json` and plain
// unauthenticated HTTPS requests to the user's own address.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { execFileP, sha256, writeFileAtomic } from './util.js';

export const REMOTE_KINDS = ['tailscale', 'cloudflare'];
// __Host-: the browser keeps it host-only, so another site on the tailnet cannot plant one.
export const DEVICE_COOKIE = '__Host-cl_device';
export const DEVICE_KEY_HEADER = 'x-clawdling-device-key';
export const DEVICE_PREFIX = 'cld_';
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_HOSTS = 8;
export const MAX_DEVICES = 20;
export const MAX_PAIRINGS = 5;
// The macOS app's own binary. Homebrew's `tailscale` symlink to it crashes ("bundleIdentifier is
// unknown to the registry"), so on a Mac this path is tried first.
export const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// A DNS name with a letter-led top-level label: never an IP address, never a bare word.
const DNS_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TEAM_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_RE = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE_RE = /^cld_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const STATUSES = ['pending', 'private', 'unconfirmed', 'unreachable', 'public', 'access', 'unverified', 'unprotected'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;
const SERVE_PATH_RE = /^\/_clawdling\/[A-Za-z0-9_-]{32}$/;

/**
 * The private path a Tailscale Serve entry forwards to (`http://127.0.0.1:<port>/_clawdling/<p>`):
 * an HMAC of the address under the org's token. Only the serve config (and this org) knows it,
 * so a process that can merely connect to 127.0.0.1 (a container, another user) cannot pass for
 * Tailscale by writing its headers. Every request through the address must carry it.
 */
export function servePath(token, url) {
  return `/_clawdling/${crypto.createHmac('sha256', String(token)).update(`remote-path:${url}`).digest('base64url').slice(0, 32)}`;
}

/** The exact Tailscale command that points an address at this cockpit's private path. */
export function serveCommand({ entry, port, token, bin = 'tailscale' }) {
  const b = /\s/.test(bin) ? `"${bin}"` : bin;
  return `${b} serve --bg --https=${entry.port} http://127.0.0.1:${port}${servePath(token, entry.url)}`;
}

/**
 * A request path through a Tailscale address must start with its private path: the rest is the
 * real path. Null when it does not.
 */
export function stripServePath(pathname, prefix) {
  if (!prefix || typeof pathname !== 'string') return null;
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return null;
}

export class RemoteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * A remote address as Clawdling stores it: https only, a DNS name, no path. Returns
 * {url, host, port, hostport} where hostport is what a browser sends as Host.
 */
export function parseRemoteUrl(raw, kind) {
  const s = String(raw ?? '').trim();
  if (kind !== undefined && !REMOTE_KINDS.includes(kind)) throw new RemoteError('--kind must be tailscale or cloudflare');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new RemoteError(`"${s.slice(0, 80)}" is not a web address: use https://name or https://name:port`);
  }
  if (u.protocol !== 'https:') throw new RemoteError('a remote address must start with https:// (Clawdling never answers plain http from outside this computer)');
  if (u.username || u.password) throw new RemoteError('leave the user name and password out of the address');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash || /[?#]/.test(s)) throw new RemoteError('just the address, with no path: https://name or https://name:port');
  const host = u.hostname.toLowerCase();
  if (!DNS_RE.test(host)) throw new RemoteError('use a name (like box.example.ts.net), not an IP address or a bare word');
  const port = u.port ? Number(u.port) : 443;
  if (kind === 'tailscale' && !host.endsWith('.ts.net')) throw new RemoteError('a Tailscale address ends in .ts.net (the name `tailscale status` shows for this computer)');
  if (kind === 'cloudflare' && host.endsWith('.ts.net')) throw new RemoteError('a .ts.net address is Tailscale: use --kind tailscale');
  const hostport = port === 443 ? host : `${host}:${port}`;
  return { url: `https://${hostport}`, host, port, hostport };
}

/** The Host header values a browser may send for this address (":443" is usually left off). */
export function hostKeys(entry) {
  return entry.port === 443 ? [entry.host, `${entry.host}:443`] : [`${entry.host}:${entry.port}`];
}

/** Can requests through this address be answered? Safety failures and unchecked ones cannot. */
export function answerable(entry) {
  if (!entry) return false;
  // Tailscale: only once Funnel is known to be off ("unreachable" is only ever set after that),
  // and only with the owner's Tailscale login to compare each request against.
  if (entry.kind === 'tailscale') return ['private', 'unreachable'].includes(entry.status) && !!entry.login && !!entry.path;
  return entry.status === 'access' && !!entry.access;
}

function cleanText(v, max = 300) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
}

function validHost(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('a host is not an object');
  const p = parseRemoteUrl(h.url, h.kind);
  if (p.url !== h.url) throw new Error(`host ${h.url} is not in its normal form`);
  if (!STATUSES.includes(h.status)) throw new Error(`host ${h.url} has an unknown status`);
  for (const k of ['added_at', 'checked_at']) if (h[k] != null && !(typeof h[k] === 'string' && ISO_RE.test(h[k]))) throw new Error(`host ${h.url} has a bad ${k}`);
  let access = null;
  if (h.access != null) {
    if (h.kind !== 'cloudflare') throw new Error(`host ${h.url} has Access settings but is not Cloudflare`);
    if (!h.access || typeof h.access !== 'object' || !TEAM_RE.test(h.access.team_domain || '') || !AUD_RE.test(h.access.aud || '')) throw new Error(`host ${h.url} has bad Access settings`);
    access = { team_domain: h.access.team_domain, aud: h.access.aud };
  }
  if (h.kind === 'cloudflare' && h.status === 'access' && !access) throw new Error(`host ${h.url} is marked as behind Access with no Access settings`);
  let email = null;
  if (h.email != null) {
    if (h.kind !== 'cloudflare' || typeof h.email !== 'string' || !/^[^\s@]{1,200}@[^\s@]{1,200}$/.test(h.email)) throw new Error(`host ${h.url} has a bad owner email`);
    email = h.email;
  }
  let servePathValue = null;
  if (h.path != null) {
    if (h.kind !== 'tailscale' || typeof h.path !== 'string' || !SERVE_PATH_RE.test(h.path)) throw new Error(`host ${h.url} has a bad serve path`);
    servePathValue = h.path;
  }
  let login = null;
  if (h.login != null) {
    if (h.kind !== 'tailscale' || typeof h.login !== 'string' || !h.login || h.login.length > 320 || /[\u0000-\u001f\u007f]/.test(h.login)) throw new Error(`host ${h.url} has a bad Tailscale login`);
    login = h.login;
  }
  return { url: p.url, host: p.host, port: p.port, kind: h.kind, status: h.status, added_at: h.added_at || null, checked_at: h.checked_at || null, detail: cleanText(h.detail), access, login, email, path: servePathValue };
}

/**
 * remote.json, checked strictly every time it changes on disk. Anything malformed turns Use from
 * anywhere off (it fails closed) and says why, instead of answering a host nobody vetted.
 */
export function validateState(raw) {
  if (raw == null) return { enabled: false, hosts: [], invalid: null };
  try {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    if (raw.version !== 1) throw new Error('unknown version');
    if (typeof raw.enabled !== 'boolean') throw new Error('"enabled" is not true or false');
    if (!Array.isArray(raw.hosts) || raw.hosts.length > MAX_HOSTS) throw new Error('"hosts" is not a short list');
    const hosts = raw.hosts.map(validHost);
    if (new Set(hosts.map((h) => h.url)).size !== hosts.length) throw new Error('a host is listed twice');
    return { enabled: raw.enabled && hosts.length > 0, hosts, invalid: null };
  } catch (err) {
    return { enabled: false, hosts: [], invalid: `remote.json is not valid (${err.message}), so Use from anywhere is off` };
  }
}

function persistable(state) {
  return {
    version: 1,
    enabled: !!state.enabled && state.hosts.length > 0,
    hosts: state.hosts.map((h) => ({
      url: h.url, kind: h.kind, status: h.status, added_at: h.added_at || null, checked_at: h.checked_at || null, detail: h.detail || null,
      ...(h.access ? { access: { team_domain: h.access.team_domain, aud: h.access.aud } } : {}),
      ...(h.login ? { login: h.login } : {}),
      ...(h.email ? { email: h.email } : {}),
      ...(h.path ? { path: h.path } : {}),
    })),
  };
}

/** <org>/.clawdling/remote.json. Re-read only when the file changes (one stat per request). */
export class RemoteStore {
  constructor(file) {
    this.file = file;
    this.stamp = null;
    this.cache = validateState(null);
  }

  read() {
    let st = null;
    try {
      st = fs.statSync(this.file);
    } catch {
      // no file: off
    }
    const stamp = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : 'none';
    if (stamp === this.stamp) return this.cache;
    let raw = null;
    if (st) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        raw = 'unreadable';
      }
    }
    this.cache = validateState(raw);
    this.stamp = stamp;
    return this.cache;
  }

  write(state) {
    writeFileAtomic(this.file, JSON.stringify(persistable(state), null, 2) + '\n', 0o600);
    this.stamp = null;
    return this.read();
  }

  /** Read, change a copy, write. An invalid file starts again from empty. */
  update(fn) {
    const cur = this.read();
    const next = { enabled: cur.enabled, hosts: cur.hosts.map((h) => ({ ...h, access: h.access ? { ...h.access } : null })) };
    fn(next);
    return this.write(next);
  }

  /** The host entry this Host header names, or null. */
  match(hostHeader) {
    const h = String(hostHeader || '').toLowerCase();
    if (!h) return null;
    return this.read().hosts.find((e) => hostKeys(e).includes(h)) || null;
  }
}

/** A short, human label for a paired device ("iPhone · Safari"), from its User-Agent. */
export function deviceLabel(ua) {
  const s = String(ua || '');
  const osName = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Macintosh|Mac OS X/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : 'A device';
  const browser = /Edg(A|iOS)?\//.test(s) ? 'Edge' : /Firefox\/|FxiOS\//.test(s) ? 'Firefox' : /CriOS\/|Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : /Clawdling/i.test(s) ? 'Clawdling app' : '';
  return browser ? `${osName} · ${browser}` : osName;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hashHex = (s) => sha256(s).toString('hex');

/**
 * Paired devices, in <org>/.clawdling/remote-devices.json (written only by the server), each tied
 * to the address it paired through. A browser holds `cld_<id>_<secret>` in an HttpOnly cookie AND
 * a second random key in its own localStorage, sent as a header (or `k=` on its event stream and
 * terminal sockets). Browsers send a cookie to every port of a host name, so another service on
 * the same Tailscale name would see the cookie; it never sees the key, which is scoped to this
 * exact origin. The app holds only the token (it sends no cookies). The file keeps only hashes.
 */
export class DeviceStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.devices = [];
    this.stamp = null;
    this.load();
  }

  /**
   * Re-read the file whenever it changed on disk (one stat), before every read and write: a
   * device signed out by another process (the CLI while this server was busy) stays signed out,
   * and is never written back.
   */
  load() {
    let st = null;
    try {
      st = fs.statSync(this.file);
    } catch {
      // no file: no devices
    }
    const stamp = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : 'none';
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.devices = [];
    if (!st) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && Array.isArray(raw.devices)) {
        this.devices = raw.devices.filter((d) => d && /^[0-9a-f]{12}$/.test(d.id) && /^[0-9a-f]{64}$/.test(d.hash) && typeof d.expires_at === 'string'
          && (d.kind === 'app' || (d.kind === 'browser' && /^[0-9a-f]{64}$/.test(d.key_hash))));
      }
    } catch {
      // unreadable: every device signs in again
    }
  }

  save() {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, devices: this.devices }, null, 2) + '\n', 0o600);
    this.stamp = null;
    this.load();
  }

  live() {
    this.load();
    const t = this.now();
    return this.devices.filter((d) => Date.parse(d.expires_at) > t);
  }

  list() {
    return this.live().map(({ id, label, host, kind, created_at, expires_at, last_seen_at }) => ({ id, label, host, kind, created_at, expires_at, last_seen_at: last_seen_at || null }));
  }

  /** A new device on `host` (the address URL). kind: 'browser' (cookie + key) or 'app' (token). */
  add({ label, host, kind = 'browser' }) {
    const id = crypto.randomBytes(6).toString('hex');
    const secret = b64url(crypto.randomBytes(32));
    const key = kind === 'browser' ? b64url(crypto.randomBytes(32)) : null;
    const t = this.now();
    const device = {
      id, kind: key ? 'browser' : 'app', hash: hashHex(secret), ...(key ? { key_hash: hashHex(key) } : {}),
      label: cleanText(label, 60) || 'A device', host: cleanText(host, 260),
      created_at: new Date(t).toISOString(), expires_at: new Date(t + DEVICE_TTL_MS).toISOString(), last_seen_at: new Date(t).toISOString(),
    };
    this.devices = [...this.live(), device].slice(-MAX_DEVICES);
    this.save();
    return { token: `${DEVICE_PREFIX}${id}_${secret}`, key, device };
  }

  /**
   * The device this credential belongs to, or null. `via`: 'cookie' or 'header'; a browser
   * device counts only from its cookie with its key, an app device only from the header; both
   * only on the address they paired through. Constant time on the secrets.
   */
  verify(token, { host, via, key } = {}) {
    const m = DEVICE_RE.exec(String(token || ''));
    if (!m) return null;
    const d = this.live().find((x) => x.id === m[1]);
    const want = d ? Buffer.from(d.hash, 'hex') : Buffer.alloc(32);
    let ok = crypto.timingSafeEqual(sha256(m[2]), want);
    if (!d || !ok) return null;
    if (d.host !== host) return null;
    if (d.kind === 'app') return via === 'header' ? d : null;
    ok = via === 'cookie' && typeof key === 'string' && key.length <= 128 && crypto.timingSafeEqual(sha256(key), Buffer.from(d.key_hash, 'hex'));
    return ok ? d : null;
  }

  /** Remember when a device was last used, written at most once a minute per device. */
  touch(d) {
    const t = this.now();
    if (d.last_seen_at && t - Date.parse(d.last_seen_at) < 60000) return;
    this.load();
    const cur = this.devices.find((x) => x.id === d.id && x.hash === d.hash);
    if (!cur) return; // signed out meanwhile: never written back
    cur.last_seen_at = new Date(t).toISOString();
    d.last_seen_at = cur.last_seen_at;
    try {
      this.save();
    } catch {
      // best effort
    }
  }

  revoke(id) {
    this.load();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== before) this.save();
    return this.devices.length !== before;
  }

  revokeAll() {
    const n = this.live().length;
    this.devices = [];
    this.save();
    return n;
  }

  /** Sign out every device paired through this address. */
  revokeHost(host) {
    this.load();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.host !== host);
    if (this.devices.length !== before) this.save();
    return before - this.devices.length;
  }
}

/** One-time pairing codes: in memory only (a restart voids them), single use, 10 minutes. */
export class Pairings {
  constructor({ now = () => Date.now(), ttlMs = PAIRING_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.codes = new Map(); // sha256 hex -> expiry ms
  }

  prune() {
    const t = this.now();
    for (const [k, exp] of this.codes) if (exp <= t) this.codes.delete(k);
  }

  create() {
    this.prune();
    const code = b64url(crypto.randomBytes(24));
    const expires = this.now() + this.ttlMs;
    this.codes.set(hashHex(code), expires);
    while (this.codes.size > MAX_PAIRINGS) this.codes.delete(this.codes.keys().next().value);
    return { code, expires_at: new Date(expires).toISOString() };
  }

  /** True once per code, before it expires. */
  consume(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) return false;
    this.prune();
    const k = hashHex(code);
    if (!this.codes.has(k)) return false;
    this.codes.delete(k);
    return true;
  }

  clear() {
    this.codes.clear();
  }
}

/** Failed sign-ins through a remote address: past `max` in `windowMs`, refuse new attempts there. */
export class Throttle {
  constructor({ max = 10, windowMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    Object.assign(this, { max, windowMs, now });
    this.fails = new Map();
  }

  recent(key) {
    const t = this.now();
    const list = (this.fails.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }

  blocked(key) {
    return this.recent(key).length >= this.max;
  }

  fail(key) {
    const list = this.recent(key);
    list.push(this.now());
    this.fails.set(key, list.slice(-this.max * 2));
  }

  /** Seconds until the oldest counted failure leaves the window. */
  retryAfter(key) {
    const list = this.recent(key);
    if (!list.length) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }
}

// ---------------------------------------------------------------------------------- checks

/** The Tailscale command to ask for `serve status` (never anything that changes Tailscale). */
export function tailscaleBin({ env = process.env, platform = process.platform, exists = fs.existsSync, which = () => null } = {}) {
  if (env.CLAWDLING_TAILSCALE_BIN) return env.CLAWDLING_TAILSCALE_BIN;
  if (platform === 'darwin' && exists(MAC_TAILSCALE)) return MAC_TAILSCALE;
  return which('tailscale') || null;
}

/** Any AllowFunnel entry for host:port anywhere in a serve config (foreground ones included). */
export function funnelOn(config, hostPort) {
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return false;
    seen.add(o);
    if (o.AllowFunnel && typeof o.AllowFunnel === 'object' && o.AllowFunnel[hostPort] === true) return true;
    return Object.values(o).some((v) => walk(v, depth + 1));
  };
  return walk(config, 0);
}

/**
 * Raw TCP forwards (`tailscale serve --tcp` / `--tls-terminated-tcp`, or a TCP Funnel) that land
 * on the cockpit's port: whoever connects through one writes their own HTTP headers, Host and
 * Tailscale-User-Login included. Returns the serve ports that do it.
 */
export function tcpForwardsTo(config, port) {
  const target = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${Number(port)}$`, 'i');
  const hits = new Set();
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return;
    seen.add(o);
    if (o.TCP && typeof o.TCP === 'object') {
      for (const [p, h] of Object.entries(o.TCP)) if (h && typeof h.TCPForward === 'string' && target.test(h.TCPForward.trim())) hits.add(p);
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(config, 0);
  return [...hits];
}

export async function funnelState(entry, { bin, run = execFileP, port = null } = {}) {
  if (!bin) return { known: false, detail: 'the Tailscale command was not found' };
  try {
    const { stdout } = await run(bin, ['serve', 'status', '--json'], { timeout: 8000 });
    const text = String(stdout || '').trim();
    const config = text ? JSON.parse(text) : {};
    return { known: true, funnel: funnelOn(config, `${entry.host}:${entry.port}`), tcp: port ? tcpForwardsTo(config, port) : [] };
  } catch (err) {
    return { known: false, detail: `\`tailscale serve status\` failed (${String(err.message || err).split('\n')[0].slice(0, 120)})` };
  }
}

/**
 * GET an address with no credentials and no redirects followed. Tests point CLAWDLING_REMOTE_PROBE
 * (test mode only) at a local server, sending the remote name as Host the way a tunnel does.
 */
export async function probe(url, pathname, { env = process.env, testMode = false, timeoutMs = 10000 } = {}) {
  const local = testMode ? env.CLAWDLING_REMOTE_PROBE : null;
  if (local) {
    const base = new URL(local);
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: base.hostname, port: base.port, path: pathname, method: 'GET', headers: { host: target.host } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (body.length < 65536) body += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
  }
  let res;
  try {
    res = await fetch(url + pathname, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/html' } });
  } catch (err) {
    const why = err?.cause?.code || err?.cause?.message || err.message;
    throw new Error(String(why).slice(0, 160));
  }
  const headers = {};
  for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;
  const body = (await res.text().catch(() => '')).slice(0, 65536);
  return { status: res.status, headers, body };
}

/**
 * Tailscale: Funnel must be known to be off for this address, and the address must reach THIS
 * Clawdling. The check's own request comes from this computer through Tailscale Serve, which
 * says who sent it (Tailscale-User-Login): that login is the owner's, and later requests must
 * carry the same one.
 */
export async function checkTailscale(entry, { nonce, bin, run, env, testMode, port = null, probeImpl = probe } = {}) {
  const f = await funnelState(entry, { bin, run, port });
  if (f.known && f.funnel) {
    return { status: 'public', detail: 'Tailscale Funnel is on for this address, so anyone on the internet can reach it. Clawdling will not answer it until Funnel is off.' };
  }
  if (!f.known) return { status: 'unconfirmed', detail: `Clawdling could not confirm Tailscale Funnel is off (${f.detail}), so it does not answer this address.` };
  if (f.tcp && f.tcp.length) {
    return { status: 'unconfirmed', detail: `A Tailscale TCP forward on port ${f.tcp.join(', ')} sends raw connections straight to the cockpit, so whoever uses it could pretend to be you. Remove it (tailscale serve --tcp=${f.tcp[0]} off), then check again.` };
  }
  let reached = false;
  let login = null;
  let why = '';
  try {
    const r = await probeImpl(entry.url, `/api/remote/hello?nonce=${encodeURIComponent(nonce)}`, { env, testMode });
    let j = null;
    try {
      j = JSON.parse(r.body);
    } catch {
      // not ours
    }
    if (r.status === 200 && j && j.clawdling === true && j.nonce === nonce) {
      reached = true;
      login = typeof j.login === 'string' && j.login ? j.login : null;
    } else why = r.status === 200 ? 'something else answers there' : `it answered ${r.status}`;
  } catch (err) {
    why = err.message;
  }
  if (!reached) return { status: 'unreachable', detail: `Could not reach this Clawdling at ${entry.url}${why ? ` (${why})` : ''}.` };
  if (!login && !entry.login) {
    return { status: 'unconfirmed', detail: 'Tailscale did not say which account this computer is signed in to (a tagged device?), so Clawdling cannot tell your devices from others on the tailnet.' };
  }
  if (login && entry.login && login !== entry.login) {
    return { status: 'unconfirmed', detail: 'This computer is now signed in to Tailscale as someone else. Remove the address and set it up again.' };
  }
  return { status: 'private', detail: 'Only your own devices, signed in to your Tailscale account, can reach it.', login: login || entry.login };
}

/**
 * Cloudflare: an unauthenticated request must be stopped by Cloudflare Access (a redirect to
 * <team>.cloudflareaccess.com, whose `kid` is the application's AUD tag). A page that answers
 * (any 2xx, or Clawdling's own refusal) means the address is public: never registered.
 */
export async function checkCloudflare(entry, { env, testMode, probeImpl = probe } = {}) {
  let r;
  try {
    r = await probeImpl(entry.url, '/', { env, testMode });
  } catch (err) {
    return { status: 'unreachable', detail: `Could not reach ${entry.url} (${err.message}).` };
  }
  const h = r.headers || {};
  if (h['x-clawdling-refused'] || (r.status >= 200 && r.status < 300)) {
    return { status: 'unprotected', detail: `${entry.url} answers without a Cloudflare Access sign-in. Add an Access application for it first; Clawdling will not answer it until then.` };
  }
  if ([301, 302, 303, 307, 308].includes(r.status) && h.location) {
    let u = null;
    try {
      u = new URL(h.location, entry.url);
    } catch {
      // not a URL
    }
    if (u && u.protocol === 'https:' && TEAM_RE.test(`https://${u.hostname}`)) {
      const aud = u.searchParams.get('kid') || entry.access?.aud || '';
      if (!AUD_RE.test(aud)) return { status: 'unverified', detail: 'Cloudflare Access is on, but its application AUD tag was not in the sign-in link. Add it with --access-aud (Zero Trust, Access, Applications, your app, Overview).' };
      return { status: 'access', detail: 'A Cloudflare Access sign-in is required before anyone reaches it.', access: { team_domain: `https://${u.hostname}`, aud } };
    }
  }
  // A block with no redirect only keeps an address that passed with the redirect before: on a first
  // add it could just as well be a WAF or bot rule in front of a public page.
  if ((r.status === 401 || r.status === 403) && h['cf-ray'] && entry.access && entry.status === 'access') {
    return { status: 'access', detail: 'Cloudflare Access blocks requests that are not signed in.', access: entry.access };
  }
  return { status: 'unverified', detail: `${entry.url} answered ${r.status}, which is not a Cloudflare Access sign-in. Clawdling will not answer it.` };
}

// ----------------------------------------------------------------------- Cloudflare Access JWT

function b64json(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Checks the Cf-Access-Jwt-Assertion header Cloudflare Access adds to every request it lets
 * through (RS256, signed by the team's keys at <team>/cdn-cgi/access/certs). Without a valid one
 * the request did not come through Access, so it is refused: this holds even if Access is
 * removed later. Fails closed when the keys cannot be fetched.
 */
export class AccessVerifier {
  constructor({ fetchImpl = (u, o) => fetch(u, o), certsUrl = (team) => `${team}/cdn-cgi/access/certs`, ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    Object.assign(this, { fetchImpl, certsUrl, ttlMs, now });
    this.cache = new Map(); // team -> {at, keys: Map kid -> KeyObject}
  }

  async keys(team, { force = false } = {}) {
    const c = this.cache.get(team);
    if (c && !force && this.now() - c.at < this.ttlMs) return c.keys;
    if (c && force && this.now() - c.at < 30000) return c.keys; // at most one forced refetch per 30 s
    const res = await this.fetchImpl(this.certsUrl(team), { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!res.ok) throw new Error(`Access keys answered ${res.status}`);
    const j = await res.json();
    const keys = new Map();
    for (const k of (j && Array.isArray(j.keys) ? j.keys : [])) {
      if (!k || k.kty !== 'RSA' || typeof k.kid !== 'string') continue;
      try {
        keys.set(k.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' }));
      } catch {
        // skip a key we cannot read
      }
    }
    this.cache.set(team, { at: this.now(), keys });
    return keys;
  }

  /** {ok: true, email} or {ok: false, reason}. */
  async verify(jwt, { team_domain, aud }) {
    try {
      if (typeof jwt !== 'string' || jwt.length > 8192) return { ok: false, reason: 'no Access token' };
      const parts = jwt.split('.');
      if (parts.length !== 3) return { ok: false, reason: 'malformed Access token' };
      const header = b64json(parts[0]);
      const claims = b64json(parts[1]);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'unexpected Access token algorithm' };
      let keys = await this.keys(team_domain);
      if (!keys.has(header.kid)) keys = await this.keys(team_domain, { force: true });
      const key = keys.get(header.kid);
      if (!key) return { ok: false, reason: 'Access token signed by an unknown key' };
      const good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
      if (!good) return { ok: false, reason: 'bad Access token signature' };
      const t = this.now() / 1000;
      const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!auds.includes(aud)) return { ok: false, reason: 'Access token is for another application' };
      if (claims.iss !== team_domain) return { ok: false, reason: 'Access token from another team' };
      if (typeof claims.exp !== 'number' || claims.exp < t - 60) return { ok: false, reason: 'expired Access token' };
      if (typeof claims.nbf === 'number' && claims.nbf > t + 60) return { ok: false, reason: 'Access token not valid yet' };
      return { ok: true, email: typeof claims.email === 'string' ? claims.email : null };
    } catch (err) {
      return { ok: false, reason: `could not check the Access token (${String(err.message || err).slice(0, 100)})` };
    }
  }
}

/** Plain-words status for a host, the same in the CLI and the cockpit. */
export function statusText(entry) {
  const map = {
    private: 'Private to your devices ✓',
    unconfirmed: 'Not confirmed private ✗',
    access: 'Behind Cloudflare Access ✓',
    unreachable: 'Not reachable',
    public: 'Public: Tailscale Funnel is on ✗',
    unprotected: 'Not behind Cloudflare Access ✗',
    unverified: 'Cloudflare Access not confirmed ✗',
    pending: 'Checking…',
  };
  return map[entry.status] || entry.status;
}

/** A peer address on this computer itself (the tunnel or serve process connects from here). */
export function loopbackPeer(addr) {
  const a = String(addr || '');
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./i.test(a);
}

/** Origin check on a remote address: none (native apps, curl), or exactly https://<this address>. */
export function remoteOriginAllowed(req, entry) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  let u;
  try {
    u = new URL(o);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return hostKeys(entry).includes(u.host.toLowerCase());
}
