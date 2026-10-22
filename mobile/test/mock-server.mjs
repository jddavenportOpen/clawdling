#!/usr/bin/env node
// A mock Clawdling server for the app's tests and screenshots: plain Node http, in memory, the
// same routes and JSON shapes as the real server (docs/SPEC.md section 4 + the mobile routes),
// seeded with the app's own sample org. A message sent to a session gets an assistant reply 1-2 s
// later; a message to Donna gets routed. Test-only controls live under /__mock/ (no auth).
//
//   node test/mock-server.mjs [--port 4799] [--host 127.0.0.1] [--token T] [--static dist-web]
//                             [--state file.json] [--cors] [--reply-ms 1200]
//
// It never talks to anything outside this process.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'src', 'demo', 'sample.json'), 'utf8'));
const VERSION = '1.0.0-mock';
const MIN = 60_000;
// Same rule as the server: Enter would answer these, so typing into them is refused (409).
const ANSWER_IN_TERMINAL = new Set(['trust', 'imports', 'startup', 'permission_prompt', 'elicitation_dialog']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function iso(now, minutesAgo) {
  return new Date(now - minutesAgo * MIN).toISOString();
}

function deriveTitle(text) {
  const flat = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(.*?[.!?])(?:\s|$)/.exec(flat);
  const first = (m ? m[1] : flat).replace(/[.!?]+$/, '').trim();
  if (!first) return null;
  const cut = first.length > 48 ? `${first.slice(0, 47).replace(/\s+\S*$/, '')}…` : first;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

function seed(now) {
  const agents = SAMPLE.agents.map((a) => ({ ...a, repo: null, model: null, permission_mode: null, created_at: iso(now, 60 * 24 * 30) }));
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const kinds = new Map(agents.map((a) => [a.id, a.kind]));
  const sessions = new Map();
  const messages = new Map();
  for (const s of SAMPLE.sessions) {
    sessions.set(s.sid, {
      sid: s.sid,
      agent: s.agent,
      agent_name: names.get(s.agent) ?? s.agent,
      kind: kinds.get(s.agent) ?? 'domain',
      title: s.title,
      status: s.status,
      model: s.model ?? null,
      permission_mode: null,
      cwd: `/home/alex/clawdling/${s.agent}`,
      tmux_name: `cl-${s.agent}-${s.sid.slice(0, 6)}`,
      created_at: iso(now, s.startedMinutesAgo),
      last_activity_at: iso(now, s.activeMinutesAgo),
      ended_at: s.endedMinutesAgo === undefined ? null : iso(now, s.endedMinutesAgo),
      notification: s.notification ?? null,
      waiting_on: s.status === 'needs_you' ? s.waitingOn ?? 'notification' : null,
      last_message: s.lastMessage ?? null,
    });
    // Like the server's transcript reader: entries are numbered from 0.
    messages.set(
      s.sid,
      s.messages.map((m, i) => ({ n: i, role: m.role, text: m.text, tools: m.tools ?? [], ts: iso(now, m.minutesAgo) })),
    );
  }
  const donna = SAMPLE.donna.map((d) => ({ role: d.role, text: d.text, channel: d.channel, ts: iso(now, d.minutesAgo) }));
  return { org: { version: 1, ...SAMPLE.org, channels: {} }, agents, sessions, messages, donna };
}

function view(s, { legacy = false } = {}) {
  const v = {
    ...s,
    name: `${s.agent_name}: ${s.title || 'new session'}`,
    waiting_on: s.status === 'needs_you' ? s.waiting_on ?? null : null,
    resumable: s.status === 'ended',
    attach_cmd: `tmux -L clawdling attach -t ${s.tmux_name}`,
  };
  if (legacy) delete v.waiting_on; // servers before waiting_on did not send the field at all
  return v;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function startMockServer(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const replyMs = opts.replyMs ?? 1200;
  const donnaMs = opts.donnaMs ?? 1500;
  const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : null;
  let token = opts.token ?? crypto.randomBytes(32).toString('hex');
  let state = seed(Date.now());
  const flags = { offline: false, legacy: false };
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const now = () => new Date().toISOString();
  const findSession = (sid) => {
    const s = state.sessions.get(sid);
    if (!s) throw new HttpError(404, 'no such session');
    return s;
  };
  const push = (sid, role, text, tools = []) => {
    const list = state.messages.get(sid) ?? [];
    const m = { n: list.length ? list[list.length - 1].n + 1 : 0, role, text, tools, ts: now() };
    list.push(m);
    state.messages.set(sid, list);
    return m;
  };
  const reply = (s, text) => {
    s.status = 'working';
    s.notification = null;
    s.waiting_on = null;
    s.last_activity_at = now();
    const delay = replyMs + Math.floor(Math.random() * 400);
    later(() => {
      if (!state.sessions.has(s.sid) || s.status === 'ended') return;
      const answer = `Got it: "${String(text).slice(0, 60)}". I checked my notes and **updated the plan**.\n\n- Done: read the request\n- Next: report back when it's finished`;
      push(s.sid, 'assistant', answer, [{ name: 'Read', summary: 'Read memory/NOW.md' }, { name: 'Edit', summary: 'Edit memory/NOW.md' }]);
      s.status = 'ready';
      s.last_message = answer.slice(0, 280);
      s.last_activity_at = now();
    }, delay);
  };
  const spawn = ({ agent, prompt, title, model }) => {
    const a = state.agents.find((x) => x.id === agent);
    if (!a) throw new HttpError(404, `no such agent: ${agent}`);
    const sid = crypto.randomUUID();
    const s = {
      sid,
      agent: a.id,
      agent_name: a.name,
      kind: a.kind,
      title: title || (prompt ? deriveTitle(prompt) : null),
      status: 'starting',
      model: model ?? null,
      permission_mode: null,
      cwd: `/home/alex/clawdling/${a.id}`,
      tmux_name: `cl-${a.id}-${sid.slice(0, 6)}`,
      created_at: now(),
      last_activity_at: now(),
      ended_at: null,
      notification: null,
      waiting_on: null,
      last_message: null,
    };
    state.sessions.set(sid, s);
    state.messages.set(sid, []);
    if (prompt) {
      push(sid, 'user', String(prompt));
      reply(s, prompt);
    } else later(() => s.status === 'starting' && (s.status = 'ready'), 300);
    return s;
  };

  const orgView = () => {
    const list = [...state.sessions.values()];
    const agents = state.agents.map((a) => {
      const mine = list.filter((s) => s.agent === a.id);
      return {
        ...a,
        dir: `/home/alex/clawdling/${a.id}`,
        live: mine.filter((s) => s.status !== 'ended').length,
        needs_you: mine.filter((s) => s.status === 'needs_you' || s.status === 'ready').length,
        last_activity_at: mine.map((s) => s.last_activity_at).sort().pop() ?? null,
      };
    });
    return { org: state.org, agents, channels: { telegram: { configured: true, enabled: true, paired: true }, imessage: { supported: false } } };
  };

  const MOBILE_ROUTES = [/^\/api\/sessions\/[^/]+\/messages$/, /^\/api\/donna\//, /^\/api\/pair$/, /^\/api\/sessions\/[^/]+$/];

  let baseUrl = '';
  const routes = [
    ['GET', /^\/api\/health$/, () => [200, { ok: true, version: VERSION, tmux: { ok: true, version: 'mock' }, claude: { ok: true, version: 'mock' }, home: '/home/alex/clawdling' }], { public: true }],
    ['GET', /^\/api\/me$/, () => [200, { ok: true, version: VERSION }]],
    ['GET', /^\/api\/org$/, () => [200, orgView()]],
    ['GET', /^\/api\/pair$/, () => [200, { url: baseUrl, token, link: pairLink(), lan: lanAddresses().map((ip) => `http://${ip}:${new URL(baseUrl).port}`), bind: host }]],
    [
      'GET',
      /^\/api\/sessions$/,
      () => [200, [...state.sessions.values()].sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || '')).map((s) => view(s, flags))],
    ],
    ['POST', /^\/api\/sessions$/, (m, b) => [201, view(spawn(b))]],
    ['GET', /^\/api\/sessions\/([^/]+)$/, (m) => [200, view(findSession(m[1]), flags)]],
    [
      'PATCH',
      /^\/api\/sessions\/([^/]+)$/,
      (m, b) => {
        const s = findSession(m[1]);
        if (typeof b.title !== 'string') throw new HttpError(400, 'send {title}');
        s.title = b.title.trim().slice(0, 80) || null;
        return [200, view(s)];
      },
    ],
    [
      'DELETE',
      /^\/api\/sessions\/([^/]+)$/,
      (m) => {
        const s = findSession(m[1]);
        s.status = 'ended';
        s.ended_at = now();
        return [200, view(s)];
      },
    ],
    [
      'POST',
      /^\/api\/sessions\/([^/]+)\/resume$/,
      (m) => {
        const s = findSession(m[1]);
        if (s.status === 'ended') {
          s.status = 'ready';
          s.ended_at = null;
          s.last_activity_at = now();
        }
        return [200, view(s)];
      },
    ],
    [
      'POST',
      /^\/api\/sessions\/([^/]+)\/send$/,
      (m, b) => {
        const s = findSession(m[1]);
        if (s.status === 'ended') throw new HttpError(409, 'that session has ended; resume it first');
        if (typeof b.text !== 'string') throw new HttpError(400, 'send {text, enter}');
        if (!flags.legacy && s.status === 'needs_you' && ANSWER_IN_TERMINAL.has(s.waiting_on)) {
          throw new HttpError(409, `the session is waiting for your answer in the terminal (${s.notification || s.waiting_on}); answer it in the cockpit first`);
        }
        if (b.text) push(s.sid, 'user', b.text);
        if (!s.title) s.title = deriveTitle(b.text);
        if (b.enter !== false) reply(s, b.text);
        return [204];
      },
    ],
    [
      'GET',
      /^\/api\/sessions\/([^/]+)\/messages$/,
      (m, b, url) => {
        // Same paging as the server: from the start (or after `after`), oldest first, `more` if cut.
        const s = findSession(m[1]);
        const all = state.messages.get(s.sid) ?? [];
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200));
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw === null || afterRaw === '' ? -1 : Number(afterRaw);
        if (!Number.isInteger(after) || after < -1) throw new HttpError(400, 'after must be an integer >= -1');
        const list = all.filter((x) => x.n > after).slice(0, limit);
        const next = list.length ? list[list.length - 1].n : after;
        return [200, { messages: list, next, more: all.length > 0 && all[all.length - 1].n > next, status: s.status }];
      },
    ],
    [
      'GET',
      /^\/api\/donna\/messages$/,
      (m, b, url) => {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
        return [200, { messages: state.donna.slice(-limit) }];
      },
    ],
    [
      'POST',
      /^\/api\/donna\/chat$/,
      async (m, b) => {
        if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'send {text}');
        state.donna.push({ role: 'user', text: b.text, channel: 'app', ts: now() });
        await new Promise((r) => later(r, donnaMs));
        const lower = b.text.toLowerCase();
        const target = state.agents.find((a) => a.kind !== 'chief' && (lower.includes(a.id.replace(/-/g, ' ')) || lower.includes(a.name.toLowerCase())));
        let text;
        if (target) {
          const s = spawn({ agent: target.id, prompt: b.text });
          text = `${target.name} is on it: "${s.title}". Watch it under Live.`;
        } else {
          const waiting = [...state.sessions.values()].filter((s) => s.status === 'needs_you' || s.status === 'ready');
          text = waiting.length ? `${waiting.length} things are waiting on you. First up: ${waiting[0].agent_name}, "${waiting[0].title}".` : 'Nothing is waiting on you.';
        }
        state.donna.push({ role: 'donna', text, channel: 'app', ts: now() });
        return [200, { reply: text }];
      },
    ],
  ];

  const pairLink = () => `clawdling://connect?url=${encodeURIComponent(baseUrl)}&t=${encodeURIComponent(token)}`;

  function send(res, status, body, extra = {}) {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(status === 204 ? undefined : data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function corsHeaders(req) {
    if (!opts.cors) return {};
    return {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Headers': 'content-type, x-clawdling-token',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      Vary: 'Origin',
    };
  }

  // Same rule as the real server: mutating requests need same-origin or no Origin at all.
  function originOk(req) {
    if (opts.cors) return true;
    const o = req.headers.origin;
    if (o === undefined) return true;
    try {
      return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch {
      return false;
    }
  }

  async function handleControl(req, res, url) {
    const raw = await readBody(req);
    const b = raw ? JSON.parse(raw) : {};
    const p = url.pathname;
    if (p === '/__mock/rotate-token') {
      token = crypto.randomBytes(32).toString('hex');
      return send(res, 200, { token, link: pairLink() });
    }
    if (p === '/__mock/offline') {
      flags.offline = !!b.on;
      return send(res, 200, flags);
    }
    if (p === '/__mock/legacy') {
      flags.legacy = !!b.on;
      return send(res, 200, flags);
    }
    if (p === '/__mock/reset') {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      state = seed(Date.now());
      flags.offline = false;
      flags.legacy = false;
      if (b.token) token = b.token;
      return send(res, 200, { token, link: pairLink() });
    }
    if (p === '/__mock/status') {
      const s = state.sessions.get(b.sid);
      if (!s) return send(res, 404, { error: 'no such session' });
      s.status = b.status;
      s.notification = b.notification ?? null;
      s.waiting_on = b.waiting_on ?? (b.status === 'needs_you' ? 'notification' : null);
      if (b.status === 'ended') s.ended_at = now();
      return send(res, 200, view(s));
    }
    if (p === '/__mock/state') return send(res, 200, { sessions: [...state.sessions.values()].map(view), donna: state.donna, flags });
    return send(res, 404, { error: 'no such mock control' });
  }

  async function handleApi(req, res, url) {
    if (flags.offline) {
      req.socket.destroy();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    const extra = corsHeaders(req);
    if (flags.legacy && MOBILE_ROUTES.some((re) => re.test(url.pathname)) && !(req.method === 'DELETE' || req.method === 'PATCH')) {
      return send(res, 404, { error: 'no such API route' }, extra);
    }
    const matches = routes.filter(([, re]) => re.test(url.pathname));
    if (!matches.length) return send(res, 404, { error: 'no such API route' }, extra);
    const route = matches.find(([method]) => method === req.method);
    if (!route) return send(res, 405, { error: 'method not allowed' }, extra);
    const [, re, fn, meta] = route;
    const given = req.headers['x-clawdling-token'];
    if (!meta?.public && given !== token) return send(res, 401, { error: 'missing or wrong token: open the link printed by `clawdling start`' }, extra);
    if (req.method !== 'GET' && !originOk(req)) return send(res, 403, { error: 'cross-origin request refused' }, extra);
    let body = {};
    if (req.method !== 'GET') {
      const raw = await readBody(req);
      if (raw.trim()) {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
          return send(res, 415, { error: 'send JSON with Content-Type: application/json' }, extra);
        }
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'invalid JSON body' }, extra);
        }
      }
    }
    const m = url.pathname.match(re).map((x, i) => (i ? decodeURIComponent(x) : x));
    const [status, out] = await fn(m, body, url);
    return send(res, status, out, extra);
  }

  function handleStatic(req, res, url) {
    if (!staticDir) return send(res, 404, { error: 'not found' });
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes('\0') || rel.split('/').includes('..')) return send(res, 400, { error: 'bad path' });
    let file = path.join(staticDir, rel);
    if (!file.startsWith(staticDir)) return send(res, 400, { error: 'bad path' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const html = path.join(staticDir, `${rel.replace(/\/+$/, '')}.html`);
      file = fs.existsSync(html) ? html : path.join(staticDir, 'index.html'); // SPA fallback
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const work = url.pathname.startsWith('/__mock/')
      ? handleControl(req, res, url)
      : url.pathname.startsWith('/api/')
        ? handleApi(req, res, url)
        : Promise.resolve(handleStatic(req, res, url));
    work.catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'internal error' : err.message }, corsHeaders(req));
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const port = server.address().port;
  baseUrl = `http://${host}:${port}`;

  return {
    url: baseUrl,
    port,
    get token() {
      return token;
    },
    get link() {
      return pairLink();
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const srv = await startMockServer({
    port: Number(arg('port', '0')),
    host: arg('host', '127.0.0.1'),
    token: arg('token'),
    staticDir: arg('static'),
    cors: process.argv.includes('--cors'),
    replyMs: Number(arg('reply-ms', '1200')),
  });
  const info = { url: srv.url, port: srv.port, token: srv.token, link: srv.link };
  const stateFile = arg('state');
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(info, null, 2));
  process.stdout.write(`Mock Clawdling server on ${srv.url}\nPair the app with:\n${srv.link}\n`);
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
