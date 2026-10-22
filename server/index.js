// The Clawdling server: HTTP API + static cockpit + terminal WebSockets + SSE, all on 127.0.0.1.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import {
  COOKIE_NAME,
  allowedHosts,
  cookieHeader,
  extractToken,
  hostAllowed,
  isLoopback,
  loadOrCreateToken,
  originAllowed,
  tokenEquals,
} from './auth.js';
import { DonnaRouter } from './channels/donna.js';
import { IMessageGateway } from './channels/imessage.js';
import { TelegramGateway } from './channels/telegram.js';
import { EventBus } from './events.js';
import { buildHooksSettings } from './hooks.js';
import { OrgStore } from './org.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PKG_ROOT,
  TELEGRAM_OFFICIAL_BASE,
  VERSION,
  childEnv,
  isTestMode,
  stableNodePath,
  runtimePaths,
  telegramApiBase,
  tmuxSocketName,
  which,
} from './paths.js';
import { SessionManager } from './sessions.js';
import { Tmux } from './tmux.js';
import { TranscriptReader, claudeConfigDir, findTranscript } from './transcripts.js';
import { HttpError, badRequest, ensureDir, execFileP, isUuid, isValidAgentId, notFound, readJson, shq, writeFileAtomic, writeJson } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

// Browser modules served straight out of node_modules (no bundler, no build step).
export const VENDOR = {
  'preact.mjs': ['preact', 'dist/preact.mjs'],
  'preact-hooks.mjs': ['preact', 'hooks/dist/hooks.mjs'],
  'htm.mjs': ['htm', 'dist/htm.mjs'],
  'xterm.mjs': ['@xterm/xterm', 'lib/xterm.mjs'],
  'xterm.css': ['@xterm/xterm', 'css/xterm.css'],
  'addon-fit.mjs': ['@xterm/addon-fit', 'lib/addon-fit.mjs'],
  'addon-web-links.mjs': ['@xterm/addon-web-links', 'lib/addon-web-links.mjs'],
};

const requireHere = createRequire(import.meta.url);

/** Directory of an installed package, found the way Node would find it (global, npx or repo). */
export function packageDir(name, req = requireHere) {
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    // package.json not exported: walk up from the main entry
  }
  let dir = path.dirname(req.resolve(name));
  for (;;) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot locate package ${name}`);
    dir = parent;
  }
}

export function resolveVendor(file) {
  const v = VENDOR[file];
  if (!v) return null;
  try {
    const p = path.join(packageDir(v[0]), v[1]);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const FALLBACK_INDEX = `<!doctype html><meta charset="utf-8"><title>Clawdling</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:2rem">
<h1>Clawdling is running</h1><p>The web cockpit files (web/index.html) are not installed in this copy.</p></body>`;

function makeLogger({ quiet = false, file } = {}) {
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    if (!quiet || level !== 'info') process.stderr.write(line);
    if (file) {
      try {
        fs.appendFileSync(file, line, { mode: 0o600 });
      } catch {
        // ignore
      }
    }
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

function sendJson(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function noContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'send JSON with Content-Type: application/json');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw badRequest('invalid JSON body');
  }
}

function param(m, i) {
  try {
    return decodeURIComponent(m[i]);
  } catch {
    throw badRequest('bad path');
  }
}

function agentParam(m) {
  const id = param(m, 1);
  if (!isValidAgentId(id)) throw badRequest('invalid agent id');
  return id;
}

function sidParam(m) {
  const sid = param(m, 1);
  if (!isUuid(sid)) throw badRequest('invalid session id');
  return sid;
}

/** Non-internal IPv4 addresses of this machine (for pairing a phone on the same network). */
export function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export function pairingInfo({ host, port, token, lan = lanAddresses() }) {
  const lanUrls = lan.map((ip) => `http://${ip}:${port}`);
  let url;
  if (host === '0.0.0.0' || host === '::') url = lanUrls[0] || `http://127.0.0.1:${port}`;
  else if (isLoopback(host)) url = `http://127.0.0.1:${port}`;
  else url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return { url, token, link: `clawdling://connect?url=${encodeURIComponent(url)}&t=${token}`, lan: lanUrls, bind: host };
}

/** SVG QR code for a string, via the MIT `qrcode-generator` package (server-side only). */
export function qrSvg(text) {
  const qrcode = requireHere('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true, title: 'Clawdling pairing code', alt: 'Clawdling pairing code' });
}

/**
 * Start a server. Resolves once it is listening.
 * @param {object} opts {home, port, host, env, quiet, webDir}
 */
export async function startServer(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home;
  if (!home) throw new Error('startServer needs a home');
  const paths = runtimePaths(home);
  if (!fs.existsSync(paths.orgJson)) throw new Error(`No org at ${home}. Run \`clawdling init\` first.`);
  for (const d of [paths.rt, paths.logs, paths.run, paths.ctx, paths.bin]) ensureDir(d, 0o700);

  const logger = opts.logger || makeLogger({ quiet: opts.quiet, file: path.join(paths.logs, 'server.log') });
  const testMode = isTestMode(env);
  const socket = tmuxSocketName(env);
  const claudeBin = env.CLAWDLING_CLAUDE_BIN || 'claude';
  if (testMode) {
    if (socket === 'clawdling') throw new Error('test mode: set CLAWDLING_TMUX_SOCKET to a unique test socket');
    if (!env.CLAWDLING_CLAUDE_BIN) throw new Error('test mode: set CLAWDLING_CLAUDE_BIN to the fake claude');
  }
  const token = loadOrCreateToken(paths.token);
  const cEnv = childEnv(env);
  const tmux = new Tmux({ bin: env.CLAWDLING_TMUX_BIN || 'tmux', socket, conf: paths.tmuxConf, env: cEnv });
  tmux.writeConf();

  // The --settings file every session gets: our hooks + the clawdling allow-list.
  const hookScript = path.join(PKG_ROOT, 'bin', 'clawdling-hook.js');
  const nodePath = stableNodePath(env);
  writeJson(paths.hooksSettings, buildHooksSettings({ nodePath, hookScript }), 0o600);
  // `clawdling` on PATH inside every session and Donna turn.
  const shim = `#!/bin/sh\n# Generated by Clawdling: runs this install's CLI.\nexec ${shq(nodePath)} ${shq(path.join(PKG_ROOT, 'bin', 'clawdling.js'))} "$@"\n`;
  writeFileAtomic(path.join(paths.bin, 'clawdling'), shim, 0o700);

  const events = new EventBus({ file: paths.events, logger });
  const org = new OrgStore(paths, { events });
  let port = Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT;
  const host = opts.host || DEFAULT_HOST;
  const sessions = new SessionManager({
    paths, org, events, tmux, claudeBin, socket, shimDir: paths.bin, env: cEnv, logger, getPort: () => port,
  });
  await sessions.init();

  const donna = new DonnaRouter({ paths, org, sessions, events, claudeBin, env: cEnv, getPort: () => port, shimDir: paths.bin, logger });
  const apiBase = telegramApiBase(env);
  const telegram = new TelegramGateway({
    paths, org, donna, events, logger, apiBase,
    pollTimeoutSec: Number(env.CLAWDLING_TELEGRAM_POLL_TIMEOUT) || 25,
    blocked: testMode && apiBase === TELEGRAM_OFFICIAL_BASE ? 'test mode: TELEGRAM_API_BASE must point at a local stub' : null,
  });
  const imessage = new IMessageGateway({ paths, org, donna, events, logger, env });
  const transcripts = new TranscriptReader();
  const configDir = claudeConfigDir(cEnv);

  const versions = { at: 0, claude: null, tmux: null };
  async function toolVersions() {
    if (Date.now() - versions.at < 60000 && versions.claude) return versions;
    const tv = await tmux.version();
    let claude = { ok: false, version: null };
    const bin = which(claudeBin, cEnv.PATH || '');
    if (bin) {
      try {
        const { stdout } = await execFileP(bin, ['--version'], { timeout: 8000, env: cEnv });
        claude = { ok: true, version: stdout.trim().split('\n')[0] };
      } catch (e) {
        claude = { ok: false, version: null, error: String(e.message).slice(0, 200) };
      }
    } else claude.error = `${claudeBin} not found on PATH`;
    Object.assign(versions, { at: Date.now(), claude, tmux: { ok: tv.ok, version: tv.version, ...(tv.error ? { error: tv.error } : {}) } });
    return versions;
  }

  function channelsStatus() {
    const o = org.read();
    return {
      telegram: telegram.status(o),
      imessage: imessage.status(o),
      donna: { session: o.donna_session || null, busy: donna.busy },
      recent: events.recent({ type: 'channel', limit: 30 }),
    };
  }

  function orgView() {
    const o = org.read();
    const stats = sessions.agentStats();
    const agents = org.agents().map((a) => ({ ...a, live: stats[a.id]?.live || 0, needs_you: stats[a.id]?.needs_you || 0, last_activity_at: stats[a.id]?.last_activity_at || null }));
    return { org: o, agents, channels: channelsStatus() };
  }

  function publishOrg(reason, id) {
    try {
      events.publish('org', { reason, id, ...orgView() });
    } catch (err) {
      logger.warn(`org event failed: ${err.message}`);
    }
  }
  telegram.onChange = () => events.publish('channel', { channel: 'telegram', ...channelsStatus() });
  imessage.onChange = () => events.publish('channel', { channel: 'imessage', ...channelsStatus() });

  const routes = [
    ['GET', /^\/api\/health$/, async () => {
      const v = await toolVersions();
      return [200, { ok: true, version: VERSION, tmux: v.tmux, claude: v.claude, home }];
    }, { public: true }],
    ['GET', /^\/api\/me$/, () => [200, { ok: true, version: VERSION }]],
    ['GET', /^\/api\/org$/, () => [200, orgView()]],
    ['POST', /^\/api\/agents$/, async (req) => {
      const body = await jsonBody(req);
      const agent = org.createAgent(body);
      events.record({ type: 'agent', action: 'created', id: agent.id });
      publishOrg('agent_created', agent.id);
      return [201, { ...agent, live: 0, needs_you: 0, last_activity_at: null }];
    }],
    ['GET', /^\/api\/agents\/([^/]+)$/, (req, m) => {
      const id = agentParam(m);
      const a = org.require(id);
      const ctx = org.context(id);
      const stats = sessions.agentStats()[id] || {};
      return [200, { ...a, live: stats.live || 0, needs_you: stats.needs_you || 0, last_activity_at: stats.last_activity_at || null, ...ctx, sessions: sessions.list().filter((s) => s.agent === id) }];
    }],
    ['PUT', /^\/api\/agents\/([^/]+)\/context$/, async (req, m) => {
      const id = agentParam(m);
      const body = await jsonBody(req);
      org.writeContext(id, body);
      events.record({ type: 'agent', action: 'context', id });
      publishOrg('context_updated', id);
      return [204];
    }],
    ['DELETE', /^\/api\/agents\/([^/]+)$/, (req, m) => {
      const id = agentParam(m);
      if (sessions.list().some((s) => s.agent === id && s.status !== 'ended')) {
        throw new HttpError(409, `end ${id}'s live sessions before archiving it`);
      }
      const out = org.archiveAgent(id);
      events.record({ type: 'agent', action: 'archived', id });
      publishOrg('agent_archived', id);
      return [200, { ok: true, ...out }];
    }],
    ['GET', /^\/api\/sessions$/, () => [200, sessions.list()]],
    ['POST', /^\/api\/sessions$/, async (req) => {
      const b = await jsonBody(req);
      return [201, await sessions.spawn({ agent: b.agent, prompt: b.prompt, model: b.model, title: b.title, cols: b.cols, rows: b.rows })];
    }],
    ['GET', /^\/api\/sessions\/([^/]+)$/, (req, m) => [200, sessions.view(sessions.require(sidParam(m)))]],
    ['PATCH', /^\/api\/sessions\/([^/]+)$/, async (req, m) => {
      const sid = sidParam(m);
      const b = await jsonBody(req);
      if (!('title' in b)) throw badRequest('send {title}');
      return [200, sessions.rename(sid, b.title)];
    }],
    ['DELETE', /^\/api\/sessions\/([^/]+)$/, async (req, m) => [200, await sessions.end(sidParam(m))]],
    ['POST', /^\/api\/sessions\/([^/]+)\/resume$/, async (req, m) => {
      const sid = sidParam(m);
      const b = await jsonBody(req);
      return [200, await sessions.resume(sid, { cols: b.cols, rows: b.rows })];
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/send$/, async (req, m) => {
      const sid = sidParam(m);
      const b = await jsonBody(req);
      if (typeof b.text !== 'string') throw badRequest('send {text, enter}');
      await sessions.send(sid, b.text, b.enter !== false);
      return [204];
    }],
    ['POST', /^\/api\/hooks$/, async (req) => {
      const b = await jsonBody(req);
      if (!isUuid(b.sid)) throw badRequest('invalid sid');
      sessions.applyHook(String(b.event), b.sid, b.payload && typeof b.payload === 'object' ? b.payload : {});
      return [204];
    }],
    ['GET', /^\/api\/events$/, (req, m, res) => {
      events.attachSse(req, res);
      return null;
    }],
    ['GET', /^\/api\/sessions\/([^/]+)\/messages$/, (req, m, res, url) => {
      const rec = sessions.require(sidParam(m));
      const afterRaw = url.searchParams.get('after');
      const after = afterRaw === null || afterRaw === '' ? -1 : Number(afterRaw);
      if (!Number.isInteger(after) || after < -1) throw badRequest('after must be an integer >= -1');
      const limitRaw = Number(url.searchParams.get('limit') || 200);
      const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;
      const file = findTranscript({ ids: [rec.claude_session_id, rec.sid].filter(Boolean), hint: rec.transcript_path, configDir });
      const all = file ? transcripts.read(file) : [];
      const page = [];
      for (const e of all) {
        if (e.n <= after) continue;
        if (page.length >= limit) break;
        page.push(e);
      }
      const next = page.length ? page[page.length - 1].n : after;
      return [200, { messages: page, next, more: all.length > 0 && all[all.length - 1].n > next, status: rec.status }];
    }],
    ['POST', /^\/api\/donna\/chat$/, async (req) => {
      const b = await jsonBody(req);
      const text = typeof b.text === 'string' ? b.text.replace(/\0/g, '').trim() : '';
      if (!text) throw badRequest('send {text}');
      if (text.length > 8000) throw new HttpError(413, 'message is longer than 8000 characters');
      events.publish('channel', { channel: 'app', direction: 'in', text: text.slice(0, 500), ts: new Date().toISOString() });
      try {
        const reply = (await donna.handle({ channel: 'app', text })) || 'Done.';
        events.publish('channel', { channel: 'app', direction: 'out', text: reply.slice(0, 500), ts: new Date().toISOString() });
        return [200, { reply }];
      } catch (err) {
        const reason = String(err.message || err).slice(0, 200);
        return [200, { reply: `Donna hit an error: ${reason}`, error: reason }];
      }
    }],
    ['GET', /^\/api\/donna\/messages$/, (req, m, res, url) => {
      const limit = Number(url.searchParams.get('limit') || 50);
      return [200, { messages: donna.messages(Number.isInteger(limit) ? limit : 50) }];
    }],
    ['GET', /^\/api\/pair$/, () => [200, pairingInfo({ host, port, token })]],
    ['GET', /^\/api\/pair\/qr\.svg$/, (req, m, res) => {
      let svg;
      try {
        svg = qrSvg(pairingInfo({ host, port, token }).link);
      } catch (err) {
        throw new HttpError(503, `QR code unavailable (${err.code === 'MODULE_NOT_FOUND' ? 'run npm install' : err.message})`);
      }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(svg) });
      res.end(req.method === 'HEAD' ? undefined : svg);
      return null;
    }],
    ['GET', /^\/api\/channels$/, () => [200, channelsStatus()]],
    ['POST', /^\/api\/channels\/telegram$/, async (req) => {
      const b = await jsonBody(req);
      const out = await telegram.configure({ token: b.token, enabled: b.enabled, pair: b.pair });
      return [200, { ...channelsStatus().telegram, ...out }];
    }],
    ['POST', /^\/api\/channels\/imessage$/, async (req) => {
      const b = await jsonBody(req);
      await imessage.configure({ handle: b.handle, enabled: b.enabled });
      return [200, channelsStatus().imessage];
    }],
  ];

  let allowed = null;
  const webDir = path.resolve(opts.webDir || env.CLAWDLING_WEB_DIR || path.join(PKG_ROOT, 'web'));

  async function handleApi(req, res, url) {
    const matches = routes.filter(([, re]) => re.test(url.pathname));
    if (!matches.length) return sendJson(res, 404, { error: 'no such API route' });
    const route = matches.find(([method]) => method === req.method || (method === 'GET' && req.method === 'HEAD'));
    if (!route) return sendJson(res, 405, { error: 'method not allowed' });
    const [, re, fn, meta] = route;
    if (!meta?.public) {
      if (!tokenEquals(extractToken(req, url), token)) return sendJson(res, 401, { error: 'missing or wrong token: open the link printed by `clawdling start`' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
    const out = await fn(req, url.pathname.match(re), res, url);
    if (out === null) return; // handler streamed its own response
    const [status, body] = out;
    if (status === 204) return noContent(res);
    return sendJson(res, status, body);
  }

  function serveFile(req, res, file, { cache }) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(file).pipe(res);
    return true;
  }

  function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/' && url.searchParams.has('t')) {
      const headers = { Location: '/', 'Cache-Control': 'no-store' };
      if (tokenEquals(url.searchParams.get('t'), token)) headers['Set-Cookie'] = cookieHeader(token);
      res.writeHead(302, headers);
      return res.end();
    }
    if (url.pathname.startsWith('/vendor/')) {
      const file = resolveVendor(url.pathname.slice('/vendor/'.length));
      if (file && serveFile(req, res, file, { cache: 'public, max-age=3600' })) return;
      return sendJson(res, 404, { error: 'not found' });
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'bad path' });
    }
    if (rel.includes('\0') || rel.split('/').some((seg) => seg === '..')) return sendJson(res, 400, { error: 'bad path' });
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(webDir, '.' + rel);
    if (file !== webDir && !file.startsWith(webDir + path.sep)) return sendJson(res, 400, { error: 'bad path' });
    if (serveFile(req, res, file, { cache: 'no-cache' })) return;
    if (rel === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : FALLBACK_INDEX);
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    securityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad url' });
    }
    if (!hostAllowed(req, allowed)) return sendJson(res, 403, { error: 'unexpected Host header' });
    const work = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : Promise.resolve(handleStatic(req, res, url));
    work.catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) logger.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !(err instanceof HttpError) ? 'internal error' : err.message });
      else res.end();
    });
  });
  server.keepAliveTimeout = 5000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, sock, head) => {
    const reject = (code, text) => {
      sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      sock.destroy();
    };
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return reject(400, 'Bad Request');
    }
    if (!hostAllowed(req, allowed) || !originAllowed(req)) return reject(403, 'Forbidden');
    if (!tokenEquals(extractToken(req, url, { allowQuery: true }), token)) return reject(401, 'Unauthorized');
    const m = url.pathname.match(/^\/ws\/term\/([^/]+)$/);
    if (!m || !isUuid(m[1]) || !sessions.get(m[1])) return reject(404, 'Not Found');
    wss.handleUpgrade(req, sock, head, (ws) => sessions.attachViewer(m[1], ws));
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListen);
      reject(err);
    };
    const onListen = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, host);
  });
  port = server.address().port;
  const extra = String(env.CLAWDLING_ALLOWED_HOSTS || '').split(',').filter(Boolean);
  allowed = allowedHosts({ host, port, extra });
  if (!isLoopback(host)) logger.warn(`listening on ${host}: anyone who can reach this address and has the token can drive your sessions`);

  writeJson(paths.server, { pid: process.pid, port, host, version: VERSION, home, socket, started_at: new Date().toISOString() }, 0o600);
  sessions.replaySpool(); // hooks that fired between reconcile and listen
  telegram.start();
  imessage.start();

  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const baseUrl = `http://${urlHost}:${port}`;
  let stopped = false;

  async function stop() {
    if (stopped) return;
    stopped = true;
    telegram.stop();
    imessage.stop();
    await sessions.shutdown();
    events.closeAll();
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
    const cur = readJson(paths.server, null);
    if (cur && cur.pid === process.pid) {
      try {
        fs.unlinkSync(paths.server);
      } catch {
        // ignore
      }
    }
  }

  logger.info(`Clawdling ${VERSION} listening on ${baseUrl} (home ${home}, tmux -L ${socket})`);
  return {
    port,
    host,
    url: baseUrl,
    openUrl: `${baseUrl}/?t=${token}`,
    token,
    home,
    socket,
    paths,
    sessions,
    org,
    events,
    telegram,
    imessage,
    donna,
    tmux,
    stop,
    cookieName: COOKIE_NAME,
  };
}
