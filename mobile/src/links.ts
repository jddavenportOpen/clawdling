// Pairing links: `clawdling://connect?url=<base>&t=<token>` (what the cockpit's QR code holds), or a
// cockpit link such as `http://192.168.1.20:4747/?t=<token>`. This parser is deliberately strict
// and does not lean on the platform URL class, so it behaves the same in Node tests, Hermes and
// browsers. Anything that is not a plain http(s) server address with a token is refused.

export type LinkErrorCode =
  | 'empty'
  | 'not_a_link'
  | 'bad_scheme'
  | 'missing_url'
  | 'bad_url'
  | 'unsafe_url'
  | 'missing_token'
  | 'bad_token';

export type NetworkKind = 'loopback' | 'lan' | 'tailscale' | 'public';

export interface ServerAddress {
  /** Normalized base URL without a trailing slash, e.g. "http://192.168.1.20:4747". */
  url: string;
  scheme: 'http' | 'https';
  /** Lowercased host name or IP literal (IPv6 keeps its brackets). */
  host: string;
  port: number | null;
  /** "host:port" (or just host) for display. */
  hostPort: string;
  network: NetworkKind;
  /**
   * True when iOS App Transport Security will refuse this address: plain http to a fully
   * qualified internet name. IP literals, single-label names and .local names are allowed.
   */
  atsBlocked: boolean;
}

export interface PairingTarget extends ServerAddress {
  token: string;
}

export type AddressResult = { ok: true; address: ServerAddress } | { ok: false; code: LinkErrorCode; message: string };
export type LinkResult = { ok: true; target: PairingTarget } | { ok: false; code: LinkErrorCode; message: string };

export const LINK_MESSAGES: Record<LinkErrorCode, string> = {
  empty: 'Paste the link from the cockpit first.',
  not_a_link: "That doesn't look like a Clawdling link. It starts with clawdling:// or http://.",
  bad_scheme: 'Only clawdling://, http:// and https:// links can connect this app.',
  missing_url: 'That link has no server address in it. Copy it again from the cockpit.',
  bad_url: "The server address in that link isn't valid.",
  unsafe_url: 'That link points at something other than an http(s) server, so it was refused.',
  missing_token:
    'That link has no pairing code. In the cockpit, open Settings, then Connect your phone, and copy the full link.',
  bad_token: 'The pairing code in that link looks damaged. Copy it again from the cockpit.',
};

const TOKEN_RE = /^[A-Za-z0-9._~-]{8,512}$/;
const LABEL_RE = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PATH_RE = /^[A-Za-z0-9._~%!$&'()*+,;=:@/-]*$/;
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function fail<T extends { ok: false; code: LinkErrorCode; message: string }>(code: LinkErrorCode): T {
  return { ok: false, code, message: LINK_MESSAGES[code] } as T;
}

function decodePart(s: string): string {
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/** Parse a query string (with or without the leading "?"). The first value of a key wins. */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = query.startsWith('?') ? query.slice(1) : query;
  if (!q) return out;
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodePart(i < 0 ? part : part.slice(0, i));
    const v = i < 0 ? '' : decodePart(part.slice(i + 1));
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

function ipv4Octets(host: string): number[] | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '::1') return true;
  const o = ipv4Octets(h);
  return !!o && o[0] === 127;
}

/** Rough reachability class of a host, used to explain failures in plain words. */
export function networkKind(host: string): NetworkKind {
  const h = host.toLowerCase();
  if (isLoopbackHost(h)) return 'loopback';
  if (h.endsWith('.ts.net')) return 'tailscale';
  const o = ipv4Octets(h);
  if (o) {
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'tailscale'; // 100.64.0.0/10 (CGNAT, Tailscale)
    if (o[0] === 10) return 'lan';
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 'lan';
    if (o[0] === 192 && o[1] === 168) return 'lan';
    if (o[0] === 169 && o[1] === 254) return 'lan';
    return 'public';
  }
  if (h.startsWith('[')) {
    if (/^\[f[cd]/i.test(h) || /^\[fe80/i.test(h)) return 'lan';
    if (/^\[fd7a:115c:a1e0/i.test(h)) return 'tailscale';
    return 'public';
  }
  if (!h.includes('.') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return 'lan';
  return 'public';
}

function isIpLiteral(host: string): boolean {
  return !!ipv4Octets(host) || host.startsWith('[');
}

function validHostname(host: string): boolean {
  if (host.length > 253) return false;
  if (ipv4Octets(host)) return true;
  if (/^\d+(\.\d+)*$/.test(host)) return false; // looks numeric but is not a valid IPv4
  return host.split('.').every((label) => LABEL_RE.test(label));
}

/** Parse and normalize a server base URL ("http://host:port[/prefix]"). Query and fragment are refused. */
export function parseServerUrl(raw: string): AddressResult {
  const s = String(raw ?? '').trim();
  if (!s) return fail('missing_url');
  const sm = SCHEME_RE.exec(s);
  if (!sm) return fail('bad_url');
  const scheme = sm[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return fail('unsafe_url');
  const rest = s.slice(sm[0].length);
  if (!rest.startsWith('//')) return fail('bad_url');
  const afterSlashes = rest.slice(2);
  if (/[?#\s\\]/.test(afterSlashes)) return fail('bad_url');
  const slash = afterSlashes.indexOf('/');
  const authority = slash < 0 ? afterSlashes : afterSlashes.slice(0, slash);
  let path = slash < 0 ? '' : afterSlashes.slice(slash);
  if (!authority || authority.includes('@')) return fail('bad_url');

  let host: string;
  let portText: string | null = null;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return fail('bad_url');
    host = authority.slice(0, end + 1).toLowerCase();
    if (!/^\[[0-9a-f:.]+\]$/.test(host) || !host.includes(':')) return fail('bad_url');
    const tail = authority.slice(end + 1);
    if (tail) {
      if (!tail.startsWith(':')) return fail('bad_url');
      portText = tail.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      host = authority.slice(0, colon).toLowerCase();
      portText = authority.slice(colon + 1);
    } else host = authority.toLowerCase();
    if (!validHostname(host)) return fail('bad_url');
  }
  let port: number | null = null;
  if (portText !== null) {
    if (!/^\d{1,5}$/.test(portText)) return fail('bad_url');
    port = Number(portText);
    if (port < 1 || port > 65535) return fail('bad_url');
  }
  path = path.replace(/\/+$/, '');
  if (!PATH_RE.test(path) || path.split('/').some((seg) => seg === '..' || seg === '.')) return fail('bad_url');

  const hostPort = port === null ? host : `${host}:${port}`;
  const network = networkKind(host);
  const qualifiedName = !isIpLiteral(host) && host.includes('.') && !host.endsWith('.local');
  return {
    ok: true,
    address: {
      url: `${scheme}://${hostPort}${path}`,
      scheme: scheme as 'http' | 'https',
      host,
      port,
      hostPort,
      network,
      atsBlocked: scheme === 'http' && network !== 'loopback' && qualifiedName,
    },
  };
}

function checkToken(token: string | undefined): LinkErrorCode | null {
  if (!token) return 'missing_token';
  if (!TOKEN_RE.test(token)) return 'bad_token';
  return null;
}

/** Validate a server address + token pair (from a deep link's params or a manual form). */
export function makeTarget(url: string | undefined, token: string | undefined): LinkResult {
  if (!url) return fail('missing_url');
  const a = parseServerUrl(url);
  if (!a.ok) return a;
  const bad = checkToken(token);
  if (bad) return fail(bad);
  return { ok: true, target: { ...a.address, token: token as string } };
}

/** Parse anything a person might paste or scan: a clawdling:// pairing link or a cockpit link. */
export function parsePairingLink(input: string): LinkResult {
  let s = String(input ?? '').trim();
  if (!s) return fail('empty');
  if (/\s/.test(s)) {
    const found = /(clawdling:\/\/\S+|https?:\/\/\S+)/i.exec(s);
    if (!found) return fail('not_a_link');
    s = found[1].replace(/[)>\].,;'"]+$/, '');
  }
  const sm = SCHEME_RE.exec(s);
  if (!sm) return fail('not_a_link');
  const scheme = sm[1].toLowerCase();

  if (scheme === 'clawdling') {
    let rest = s.slice(sm[0].length).replace(/^\/+/, '');
    const hash = rest.indexOf('#');
    if (hash >= 0) rest = rest.slice(0, hash);
    const q = rest.indexOf('?');
    const where = (q < 0 ? rest : rest.slice(0, q)).replace(/\/+$/, '').toLowerCase();
    if (where !== 'connect') return fail('not_a_link');
    const params = parseQuery(q < 0 ? '' : rest.slice(q + 1));
    return makeTarget(params.url || params.u, params.t || params.token);
  }

  if (scheme === 'http' || scheme === 'https') {
    let rest = s;
    const hash = rest.indexOf('#');
    if (hash >= 0) rest = rest.slice(0, hash);
    const q = rest.indexOf('?');
    const base = q < 0 ? rest : rest.slice(0, q);
    const params = parseQuery(q < 0 ? '' : rest.slice(q + 1));
    const a = parseServerUrl(base);
    if (!a.ok) return a;
    const bad = checkToken(params.t || params.token);
    if (bad) return fail(bad);
    return { ok: true, target: { ...a.address, token: (params.t || params.token) as string } };
  }

  return fail('bad_scheme');
}

/** The canonical pairing link for a server + token (what the QR code holds). */
export function buildPairingLink(url: string, token: string): string {
  return `clawdling://connect?url=${encodeURIComponent(url)}&t=${encodeURIComponent(token)}`;
}
