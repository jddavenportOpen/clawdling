// Local auth: one random token per org home, checked in constant time.
// Browsers carry it in an HttpOnly SameSite=Strict cookie; the CLI and the hook script send a header.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sha256, writeFileAtomic } from './util.js';

export const COOKIE_NAME = 'cl_token';
export const TOKEN_HEADER = 'x-clawdling-token';
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function loadOrCreateToken(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(t)) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // best effort
      }
      return t;
    }
  } catch {
    // create below
  }
  const token = crypto.randomBytes(32).toString('hex');
  writeFileAtomic(file, token + '\n', 0o600);
  return token;
}

export function readToken(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Constant-time comparison (hash both sides so length differences do not leak either). */
export function tokenEquals(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

/** Every value sent for one cookie name (a page elsewhere may have planted a decoy before ours). */
export function cookieValues(header, name) {
  const out = [];
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1 || part.slice(0, i).trim() !== name) continue;
    out.push(part.slice(i + 1).trim());
  }
  return out.slice(0, 8);
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep raw
    }
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

/** Token from header, cookie, or (only when allowed, e.g. WebSocket upgrades) the `t` query param. */
export function extractToken(req, url, { allowQuery = false } = {}) {
  const h = req.headers[TOKEN_HEADER];
  if (typeof h === 'string' && h) return h;
  const c = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (c) return c;
  if (allowQuery && url) {
    const t = url.searchParams.get('t');
    if (t) return t;
  }
  return null;
}

export function cookieHeader(token) {
  // One year: a local cockpit should survive a browser restart. HttpOnly + SameSite=Strict.
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

/**
 * A paired device's cookie on a remote address (Use from anywhere). `__Host-`: host-only, so no
 * other site on the tailnet (ts.net is a public suffix) can set one in its place. Secure: only ever sent over
 * https. HttpOnly: page scripts never see it. SameSite=Strict: another site can neither send it
 * nor embed the cockpit; a link from elsewhere opens the page signed out for that one load, and
 * its own same-origin API calls carry the cookie. 30 days, the same as the server-side expiry.
 */
export function deviceCookieHeader(value, maxAgeSec = 30 * 24 * 60 * 60) {
  return `__Host-cl_device=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

/**
 * Host header allow-list (DNS-rebinding guard). When bound to loopback only loopback names are
 * accepted. When bound elsewhere the check is off unless CLAWDLING_ALLOWED_HOSTS lists names.
 * Returns null when every Host is allowed.
 */
export function allowedHosts({ host, port, extra = [] }) {
  const names = new Set();
  if (isLoopback(host)) {
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) names.add(`${h}:${port}`);
  } else if (!extra.length) {
    return null;
  } else {
    names.add(`${host}:${port}`);
  }
  for (const e of extra) {
    const v = String(e).trim().toLowerCase();
    if (!v) continue;
    names.add(v.includes(':') && !v.startsWith('[') ? v : `${v}:${port}`);
  }
  return names;
}

export function hostAllowed(req, allowed) {
  if (!allowed) return true;
  const h = String(req.headers.host || '').toLowerCase();
  return allowed.has(h);
}

/**
 * Same-origin or no Origin at all (CLI, curl, the hook script). `Origin: null` is rejected.
 * `secure`: a remote address, where only an https origin counts.
 */
export function originAllowed(req, { secure = false } = {}) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  if (!o || o === 'null') return false;
  let u;
  try {
    u = new URL(o);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (secure && u.protocol !== 'https:') return false;
  return u.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
}
