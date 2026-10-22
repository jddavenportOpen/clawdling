#!/usr/bin/env node
// Mock Clawdling server for the cockpit E2E suite.
//
// Implements the SPEC §4 HTTP/WS/SSE contract in memory (fake org, fake
// sessions with statuses, SSE events, a WS terminal that echoes input and
// streams ANSI output) and serves web/ plus /vendor/* exactly like the real
// server. Nothing here talks to claude, tmux, Telegram or iMessage.
//
// Test-only control routes live under /__mock/* (reset to a fixture, read the
// recorded requests, push a channel event). The real server has none of them.
//
//   node test/e2e/mock-server.mjs [--port 4848] [--fixture default|small|big|empty] [--token T]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WEB = path.join(ROOT, 'web');
const NM = path.join(ROOT, 'node_modules');

export const VENDOR = {
  '/vendor/preact.mjs': 'preact/dist/preact.mjs',
  '/vendor/preact-hooks.mjs': 'preact/hooks/dist/hooks.mjs',
  '/vendor/htm.mjs': 'htm/dist/htm.mjs',
  '/vendor/xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': '@xterm/addon-web-links/lib/addon-web-links.mjs',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CLAUDE = '\x1b[38;2;217;119;87m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function slug(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

export function deriveTitle(text) {
  let t = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[`*_#>[\]()~]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  if (m) t = m[1];
  t = t.replace(/[.!?]+$/, '');
  if (t.length > 48) t = `${t.slice(0, 47).replace(/\s+\S*$/, '')}…`;
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function defaultClaudeMd(a, owner) {
  return [`# ${a.name} agent`, `You are the ${a.name} agent in ${owner}'s org. Mission: ${a.mission}.`, '## How you work',
    `- Stay in your lane: ${a.name}. If a request belongs to another agent, say which one.`,
    '- Keep your memory current: before you finish, update memory/NOW.md (state, open threads, next steps; under 40 lines) and append one dated line to memory/LOG.md. The /handoff skill does this.',
    '- Ask before anything irreversible or outward-facing (sending messages, spending money, deleting).', '## Current state', '@memory/NOW.md', ''].join('\n');
}

function defaultNow(a) {
  return [`# ${a.name}: now`, '', '## State', `- ${a.mission}`, '', '## Open threads', '- Nothing open yet.', '', '## Next steps', '- Wait for the first request.', ''].join('\n');
}

// ---------------------------------------------------------------- fixtures
const DOMAIN_STYLE = {
  work: ['briefcase', '#7aa2f7'], health: ['heart', '#e5484d'], money: ['coin', '#3fb27f'], home: ['home', '#e09f3e'],
  family: ['users', '#c17be0'], learning: ['book', '#5bc0be'], writing: ['book', '#d6869d'],
};

function mkAgent(id, kind, name, mission, extra = {}) {
  const style = DOMAIN_STYLE[id] || [];
  return {
    id, kind, name, mission,
    icon: extra.icon !== undefined ? extra.icon : (kind === 'chief' ? 'chat' : kind === 'project' ? 'folder' : style[0] || null),
    color: extra.color !== undefined ? extra.color : (style[1] || null),
    repo: extra.repo || null, domain: extra.domain || null, model: extra.model || null, permission_mode: null,
    created_at: iso(extra.age || 30 * DAY),
    _now: extra.now || null, _claude: extra.claude || null,
    _log: extra.log || [`${new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10)} Created ${name}.`],
  };
}

function baseAgents() {
  return [
    mkAgent('donna', 'chief', 'Donna', "Ada's chief of staff: routes every request to the right agent and reports back", {
      now: ['# Donna: now', '', '## State', '- Morning brief sent at 07:30.', '- Work is waiting on a Bash permission for the roadmap draft.', '',
        '## Open threads', "- Health: confirm Thursday's long run.", '- Home: dishwasher quotes due Friday.', '', '## Next steps', '- Check in with Work after lunch.', ''].join('\n'),
      log: ['2026-10-20 Routed "book the dentist" to Home.', '2026-10-21 Sent the morning brief; 3 items.', '2026-10-22 Routed "Q4 roadmap draft" to Work.'],
    }),
    mkAgent('work', 'domain', 'Work', 'Run my product work: roadmap, hiring and the weekly review'),
    mkAgent('health', 'domain', 'Health', 'Keep training, sleep and food on track for a spring half marathon', {
      now: ['# Health: now', '', '## State', '- Week 6 of 14. Long run Sunday: 14 km.', '- Sleep average 7h05 this week.', '', '## Open threads',
        '- Knee felt tight after Tuesday intervals.', '', '## Next steps', "- Plan this week's sessions around Thursday travel.", ''].join('\n'),
      log: ['2026-10-19 Logged long run, 13 km, easy.', '2026-10-21 Moved intervals to Wednesday.', "2026-10-22 Started planning this week's training."],
    }),
    mkAgent('money', 'domain', 'Money', 'Budget, bills and taxes, without surprises'),
    mkAgent('home', 'domain', 'Home', 'Repairs, appliances and the household calendar'),
  ];
}

function sess(agentsById, agent, title, status, opts = {}) {
  const a = agentsById[agent];
  const sid = opts.sid || crypto.randomUUID();
  const ended = status === 'ended';
  const last = opts.last ?? 5 * MIN;
  return {
    sid, agent, agent_name: a ? a.name : agent, kind: a ? a.kind : 'domain', title: title || null, status,
    model: opts.model || (a && a.model) || null,
    cwd: a ? (a.repo || `/Users/ada/clawdling/${a.kind === 'chief' ? a.id : a.kind === 'project' ? `projects/${a.id}` : `domains/${a.id}`}`) : '/Users/ada/clawdling',
    tmux_name: `cl-${agent}-${sid.slice(0, 6)}`,
    created_at: iso((opts.age ?? last) + 20 * MIN),
    last_activity_at: iso(ended ? (opts.ended ?? last) : last),
    ended_at: ended ? iso(opts.ended ?? 2 * HOUR) : null,
    notification: opts.notification || null,
    resumable: opts.resumable ?? true,
    permission_mode: null,
    last_message: opts.last_message || null,
    transcript_path: null,
    attach_cmd: `tmux -L clawdling attach -t cl-${agent}-${sid.slice(0, 6)}`,
    get name() { return `${this.agent_name}: ${this.title || 'new session'}`; },
  };
}

const FIXTURES = {
  default() {
    const agents = [
      ...baseAgents(),
      mkAgent('site', 'project', 'Launch the website', 'Ship the new marketing site with a working signup form', { domain: 'work', repo: '/Users/ada/code/site' }),
      mkAgent('marathon', 'project', 'Spring half marathon', 'Finish the April half marathon under 1:50', { domain: 'health' }),
    ];
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));
    const sessions = [
      sess(by, 'health', "Plan this week's training", 'working', { last: 15e3 }),
      sess(by, 'work', 'Draft the Q4 roadmap', 'needs_you', { last: 2 * MIN, notification: 'Claude needs your permission to use Bash' }),
      sess(by, 'donna', 'Morning brief', 'ready', { last: 6 * MIN }),
      sess(by, 'site', 'Fix the hero layout on mobile', 'working', { last: 4e3, model: 'sonnet' }),
      sess(by, 'home', 'Compare dishwasher quotes', 'ready', { last: 40 * MIN }),
      sess(by, 'work', null, 'starting', { last: 50e3 }),
      sess(by, 'money', 'Reconcile September', 'ended', { ended: 2 * HOUR }),
      sess(by, 'money', 'Tax documents checklist', 'ended', { ended: 3 * DAY }),
      sess(by, 'health', 'Sleep log review', 'ended', { ended: 20 * DAY }),
    ];
    return { agents, sessions };
  },
  small() {
    const agents = baseAgents().filter((a) => a.id !== 'home');
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));
    return {
      agents,
      sessions: [
        sess(by, 'health', "Plan this week's training", 'working', { last: 15e3 }),
        sess(by, 'work', 'Draft the Q4 roadmap', 'needs_you', { last: 2 * MIN, notification: 'Claude needs your permission to use Bash' }),
        sess(by, 'money', 'Reconcile September', 'ended', { ended: 2 * HOUR }),
      ],
    };
  },
  big() {
    const agents = [
      ...baseAgents(),
      mkAgent('family', 'domain', 'Family', 'School runs, birthdays and the family calendar'),
      mkAgent('learning', 'domain', 'Learning', 'Courses and languages, a little every day'),
      mkAgent('writing', 'domain', 'Writing', 'The newsletter and the long-form backlog'),
    ];
    const proj = [
      ['work', ['Q4 roadmap', 'Hiring pipeline', 'Launch the website', 'Customer interviews', 'Pricing page', 'Board deck']],
      ['health', ['Spring half marathon', 'Meal prep system', 'Sleep reset']],
      ['money', ['Tax return 2026', 'Emergency fund']],
      ['home', ['Kitchen remodel']],
      ['family', ['Summer trip to Lisbon', 'School applications', "Grandma's 80th"]],
      ['learning', ['Spanish B1', 'Statistics course']],
      ['writing', ['Newsletter', 'Book outline']],
      [null, ['Garage sale', 'Car purchase', 'Old laptop backup']],
    ];
    for (const [domain, names] of proj) {
      for (const name of names) agents.push(mkAgent(slug(name), 'project', name, `Get ${name.toLowerCase()} done`, { domain }));
    }
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));
    const sessions = [
      sess(by, 'health', "Plan this week's training", 'working', { last: 15e3 }),
      sess(by, 'work', 'Draft the Q4 roadmap', 'needs_you', { last: 2 * MIN, notification: 'Claude needs your permission to use Bash' }),
      sess(by, 'donna', 'Morning brief', 'ready', { last: 6 * MIN }),
      sess(by, 'pricing-page', 'Compare three pricing layouts', 'working', { last: 8e3 }),
      sess(by, 'summer-trip-to-lisbon', 'Find flights for July', 'ready', { last: 30 * MIN }),
      sess(by, 'spanish-b1', 'Daily practice', 'working', { last: 3e3 }),
      sess(by, 'tax-return-2026', 'Collect the 1099s', 'needs_you', { last: 9 * MIN, notification: 'Which brokerage accounts should I include?' }),
      sess(by, 'newsletter', 'Draft issue 14', 'ready', { last: 52 * MIN }),
    ];
    return { agents, sessions };
  },
  empty() {
    return { agents: baseAgents(), sessions: [] };
  },
};

// ---------------------------------------------------------------- fake TUI
const WORK_SCRIPT = [
  `${CLAUDE}⏺${RESET} Reading the agent's memory to pick up where we left off.`,
  `${DIM}  ⎿  Read memory/NOW.md (18 lines)${RESET}`,
  `${CLAUDE}⏺${RESET} ${BOLD}Search${RESET}(pattern: "TODO", path: "src/")`,
  `${DIM}  ⎿  Found 4 matches${RESET}`,
  `${CLAUDE}⏺${RESET} Drafting the plan. Three options, ranked by effort:`,
  `   ${GREEN}1.${RESET} Keep the current structure, tighten the copy`,
  `   ${GREEN}2.${RESET} Split the page into two sections`,
  `   ${GREEN}3.${RESET} Rebuild the layout grid`,
  `${CLAUDE}✻${RESET} ${DIM}Thinking…${RESET}`,
  `${CLAUDE}⏺${RESET} ${BOLD}Update${RESET}(memory/NOW.md)`,
  `${DIM}  ⎿  Updated memory/NOW.md with 3 additions${RESET}`,
];

function bannerFor(s, agent) {
  const lines = [
    `${CLAUDE}✻${RESET} Welcome to ${BOLD}Claude Code${RESET} ${DIM}(mock)${RESET}`,
    `${DIM}  /help for help · cwd: ${s.cwd.replace('/Users/ada', '~')}${RESET}`,
    '',
  ];
  if (s.title) {
    lines.push(`${DIM}>${RESET} ${s.title}`, '');
    lines.push(`${CLAUDE}⏺${RESET} On it. I'll check ${agent ? `${agent.name}'s` : 'my'} NOW.md first.`);
    lines.push(`${DIM}  ⎿  Read memory/NOW.md (14 lines)${RESET}`);
  }
  if (s.status === 'needs_you') {
    lines.push('', `${BOLD}Bash command${RESET}`, `   ${CYAN}npm run build${RESET}`, '', ` Do you want to proceed?`, ` ${CLAUDE}❯${RESET} 1. Yes`, '   2. No, and tell Claude what to do differently', '');
  } else if (s.status === 'ready') {
    lines.push(`${CLAUDE}⏺${RESET} Done. Summary is in NOW.md; tell me what to do next.`, '');
  }
  return `${lines.join('\r\n')}\r\n${DIM}›${RESET} `;
}

// A QR-looking placeholder (not a decodable code): the real server renders the real one.
function placeholderQr(seed) {
  const n = 25;
  let h = 2166136261;
  const bits = [];
  for (let i = 0; i < n * n; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    bits.push(h & 1);
  }
  const finder = (x, y) => `<path d="M${x} ${y}h7v7h-7z M${x + 1} ${y + 1}v5h5v-5z" fill-rule="evenodd"/><path d="M${x + 2} ${y + 2}h3v3h-3z"/>`;
  const inFinder = (x, y) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  let cells = '';
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (!inFinder(x, y) && bits[y * n + x]) cells += `M${x} ${y}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#111">${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}<path d="${cells}"/></g></svg>`;
}

// ---------------------------------------------------------------- server
export async function startMockServer({ port = 0, host = '127.0.0.1', token = 'mock-token-0123456789abcdef', fixture = 'default', quiet = true } = {}) {
  const st = {
    org: null, agents: [], sessions: new Map(), terms: new Map(), requests: [],
    channels: { telegram: { configured: false, enabled: false, paired: false, chat_id_masked: null }, imessage: { supported: true, enabled: false, handle: null } },
    pairing: null,
  };
  const sse = new Set();
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

  function reset(name = 'default') {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const term of st.terms.values()) {
      clearInterval(term.stream);
      for (const ws of term.viewers) { try { ws.close(1000, 'reset'); } catch { /* ignore */ } }
    }
    const fx = (FIXTURES[name] || FIXTURES.default)();
    st.org = { version: 1, name: "Ada's org", owner: 'Ada', chief: 'donna', channels: { telegram: { enabled: false, chat_id: null }, imessage: { enabled: false, handle: null } } };
    st.agents = fx.agents;
    st.sessions = new Map(fx.sessions.map((s) => [s.sid, s]));
    st.terms = new Map();
    st.requests = [];
    st.pairing = null;
    st.recent = [];
    st.bind = '127.0.0.1';
    st.donnaSession = name === 'empty' ? null : '7f3c2a9e-1b4d-4c8e-9a51-0d6e2f8b3c17';
    st.channels = { telegram: { configured: false, enabled: false, paired: false, chat_id_masked: null }, imessage: { supported: true, enabled: false, handle: null } };
    for (const s of fx.sessions) ensureTerm(s);
    publishOrg('reset', null);
  }

  const agentById = (id) => st.agents.find((a) => a.id === id);
  const publicAgent = (a) => {
    const out = {};
    for (const [k, v] of Object.entries(a)) if (!k.startsWith('_')) out[k] = v;
    return out;
  };
  const agentWithStats = (a) => {
    let live = 0;
    let needs = 0;
    let last = null;
    for (const s of st.sessions.values()) {
      if (s.agent !== a.id) continue;
      if (s.status !== 'ended') live += 1;
      if (s.status === 'needs_you') needs += 1;
      if (!last || s.last_activity_at > last) last = s.last_activity_at;
    }
    return { ...publicAgent(a), live, needs_you: needs, last_activity_at: last };
  };
  const claudeMd = (a) => a._claude || defaultClaudeMd(a, st.org.owner);
  const nowMd = (a) => (a._now != null ? a._now : defaultNow(a));

  const orgView = () => ({ org: st.org, agents: st.agents.map(agentWithStats), channels: channelStatus() });
  const publishOrg = (reason, id) => broadcast('org', { reason, id, ...orgView() });

  function broadcast(type, data) {
    const frame = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of sse) { try { res.write(frame); } catch { /* client gone */ } }
  }

  // ---- terminals
  function ensureTerm(s) {
    let term = st.terms.get(s.sid);
    if (term) return term;
    term = { buf: bannerFor(s, agentById(s.agent)), line: '', viewers: new Set(), stream: null, step: 0, cols: 100, rows: 30 };
    st.terms.set(s.sid, term);
    syncStream(s);
    return term;
  }

  function out(s, data) {
    const term = ensureTerm(s);
    term.buf = (term.buf + data).slice(-200000);
    s.last_activity_at = new Date().toISOString();
    const frame = JSON.stringify({ t: 'out', data });
    for (const ws of term.viewers) if (ws.readyState === 1) ws.send(frame);
  }

  function syncStream(s) {
    const term = st.terms.get(s.sid);
    if (!term) return;
    if (s.status === 'working' && !term.stream) {
      term.stream = setInterval(() => {
        const line = WORK_SCRIPT[term.step % WORK_SCRIPT.length];
        term.step += 1;
        out(s, `\r\x1b[2K${line}\r\n${DIM}›${RESET} `);
      }, 1100);
    } else if (s.status !== 'working' && term.stream) {
      clearInterval(term.stream);
      term.stream = null;
    }
  }

  function setStatus(s, status, extra = {}) {
    Object.assign(s, extra, { status });
    if (status !== 'needs_you') s.notification = extra.notification || null;
    if (status === 'ended') { s.ended_at = new Date().toISOString(); }
    else s.ended_at = null;
    s.last_activity_at = new Date().toISOString();
    syncStream(s);
    broadcast('session', s);
    const term = st.terms.get(s.sid);
    if (term) {
      for (const ws of term.viewers) {
        if (ws.readyState !== 1) continue;
        ws.send(JSON.stringify({ t: 'status', status }));
        if (status === 'ended') ws.send(JSON.stringify({ t: 'ended' })); // like core: the socket stays open
      }
    }
  }

  // Hook events drive status exactly like the real server's status machine.
  function applyHook(s, event, payload = {}) {
    if (event === 'SessionStart') { if (s.status === 'ended') setStatus(s, 'starting'); return; }
    if (event === 'UserPromptSubmit') {
      if (!s.title && payload.prompt) s.title = deriveTitle(payload.prompt);
      setStatus(s, 'working');
      return;
    }
    if (event === 'Stop') {
      if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) s.last_message = payload.last_assistant_message.trim().slice(0, 280);
      setStatus(s, 'ready');
      return;
    }
    if (event === 'Notification') { setStatus(s, 'needs_you', { notification: payload.message || 'Claude needs your attention' }); return; }
    if (event === 'SessionEnd') setStatus(s, 'ended');
  }

  function handleLine(s, line) {
    const text = line.trim();
    out(s, '\r\n');
    if (!text) { out(s, `${DIM}›${RESET} `); return; }
    if (text === '/exit') { out(s, `${DIM}Goodbye.${RESET}\r\n`); applyHook(s, 'SessionEnd'); return; }
    applyHook(s, 'UserPromptSubmit', { prompt: text });
    later(250, () => out(s, `${CLAUDE}⏺${RESET} You said: ${text}\r\n`));
    later(500, () => out(s, `${DIM}  ⎿  (mock) echoing your message back${RESET}\r\n`));
    later(800, () => {
      if (/permission\?/i.test(text)) {
        out(s, `\r\n${BOLD}Bash command${RESET}\r\n   ${CYAN}rm -rf build/${RESET}\r\n\r\n Do you want to proceed?\r\n ${CLAUDE}❯${RESET} 1. Yes\r\n   2. No\r\n`);
        applyHook(s, 'Notification', { message: 'Claude needs your permission to use Bash' });
      } else {
        applyHook(s, 'Stop', { last_assistant_message: `You said: ${text}` });
        out(s, `${DIM}›${RESET} `);
      }
    });
  }

  function feedInput(s, data) {
    if (s.status === 'ended') return;
    const term = ensureTerm(s);
    if (data.startsWith('\x1b')) {
      if (data === '\x1b\r') { term.line += '\n'; out(s, '\r\n  '); }
      return; // arrows and other escape sequences: ignored by the mock
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') { const line = term.line; term.line = ''; handleLine(s, line); }
      else if (ch === '\x7f' || ch === '\b') { if (term.line) { term.line = term.line.slice(0, -1); out(s, '\b \b'); } }
      else if (ch === '\x03') { term.line = ''; out(s, `^C\r\n${DIM}›${RESET} `); }
      else if (ch >= ' ') { term.line += ch; out(s, ch); }
    }
  }

  function createSession(body) {
    const scratch = body.agent === 'scratch';
    const a = scratch ? { id: 'scratch', kind: 'scratch', name: 'Scratch', model: null, repo: '/Users/ada/clawdling' } : agentById(body.agent);
    if (!a) return null;
    const s = sess({ [a.id]: a }, a.id, body.title || (body.prompt ? deriveTitle(body.prompt) : null), 'starting', { last: 0, age: 0, model: body.model });
    s.created_at = new Date().toISOString();
    s.last_activity_at = s.created_at;
    st.sessions.set(s.sid, s);
    const term = ensureTerm(s);
    if (Number.isInteger(body.cols) && Number.isInteger(body.rows)) { term.cols = body.cols; term.rows = body.rows; }
    term.buf = `${CLAUDE}✻${RESET} Welcome to ${BOLD}Claude Code${RESET} ${DIM}(mock)${RESET}\r\n${DIM}  /help for help · cwd: ${s.cwd.replace('/Users/ada', '~')}${RESET}\r\n\r\n${DIM}›${RESET} `;
    broadcast('session', s);
    if (body.prompt) {
      later(150, () => { out(s, body.prompt); handleLine(s, body.prompt); });
    }
    return s;
  }

  function sessionList() {
    const cutoff = Date.now() - 14 * DAY;
    return [...st.sessions.values()]
      .filter((s) => s.status !== 'ended' || Date.parse(s.ended_at || s.last_activity_at) >= cutoff)
      .sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || ''));
  }

  function channelStatus() {
    const c = JSON.parse(JSON.stringify(st.channels));
    const t = c.telegram;
    const p = st.pairing && Date.now() < st.pairing.expires ? st.pairing : null;
    Object.assign(t, { bot_username: t.configured ? 'ada_donna_bot' : null, pairing_code: !t.paired && p ? p.code : null,
      pairing_expires_at: !t.paired && p ? new Date(p.expires).toISOString() : null, polling: t.configured && t.enabled, error: null });
    return { ...c, donna: { session: st.donnaSession, busy: false }, recent: st.recent.slice(-30) };
  }
  const publishChannels = (channel) => broadcast('channel', { channel, ...channelStatus() });

  // ---- http helpers
  const send = (res, code, body, headers = {}) => {
    if (body === undefined || code === 204) { res.writeHead(code, headers); res.end(); return; }
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ __invalid: true }); } });
  });
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const safeEq = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const authed = (req, url) => {
    const h = req.headers['x-clawdling-token'];
    if (h && safeEq(h, token)) return true;
    const c = cookies(req).cl_token;
    if (c && safeEq(c, token)) return true;
    const q = url && url.searchParams.get('t');
    return !!(q && url.pathname.startsWith('/ws/') && safeEq(q, token));
  };
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://${req.headers.host}`;
  };

  function serveFile(res, file, method) {
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { send(res, 404, 'Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-cache' });
      if (method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  }

  function serveStatic(req, res, p) {
    if (VENDOR[p]) { serveFile(res, path.join(NM, VENDOR[p]), req.method); return; }
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(WEB, rel);
    if (!file.startsWith(WEB + path.sep)) { send(res, 403, 'Forbidden'); return; }
    serveFile(res, file, req.method);
  }

  async function onApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/health' && m === 'GET') {
      send(res, 200, { ok: true, version: '1.0.0-mock', tmux: { ok: true, version: '3.6a' }, claude: { ok: true, version: '2.1.0 (mock)' }, home: '/Users/ada/clawdling' });
      return;
    }
    if (!authed(req, null)) { send(res, 401, { error: 'unauthorized' }); return; }
    if (m !== 'GET' && m !== 'HEAD' && !originOk(req)) { send(res, 403, { error: 'cross-origin request refused' }); return; }
    const body = m === 'GET' || m === 'HEAD' ? null : await readBody(req);
    if (body && body.__invalid) { send(res, 400, { error: 'invalid JSON' }); return; }
    if (m !== 'GET') st.requests.push({ method: m, path: p, body, at: Date.now() });

    if (p === '/api/me' && m === 'GET') { send(res, 200, { ok: true, owner: st.org.owner, org: st.org.name, version: '1.0.0-mock' }); return; }
    if (p === '/api/org' && m === 'GET') { send(res, 200, orgView()); return; }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      sse.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      req.on('close', () => { clearInterval(ping); sse.delete(res); });
      return;
    }
    if (p === '/api/agents' && m === 'POST') {
      const kind = body.kind;
      const name = String(body.name || '').trim();
      if (kind !== 'domain' && kind !== 'project') { send(res, 400, { error: 'kind must be "domain" or "project"' }); return; }
      if (!name) { send(res, 400, { error: 'name is required' }); return; }
      const id = body.id || slug(name);
      if (!ID_RE.test(id)) { send(res, 400, { error: 'invalid agent id' }); return; }
      if (agentById(id)) { send(res, 409, { error: `an agent called "${id}" already exists` }); return; }
      const a = mkAgent(id, kind, name, String(body.mission || '').trim(), { age: 0, repo: body.repo || null, domain: body.domain || null, model: body.model || null, icon: kind === 'project' ? 'folder' : null, color: null });
      a._log = [`${new Date().toISOString().slice(0, 10)} Created ${name}.`];
      st.agents.push(a);
      publishOrg('agent_created', id);
      send(res, 201, publicAgent(a));
      return;
    }
    let mm = p.match(/^\/api\/agents\/([^/]+)(\/context)?$/);
    if (mm) {
      const id = decodeURIComponent(mm[1]);
      if (!ID_RE.test(id)) { send(res, 400, { error: 'invalid agent id' }); return; }
      const a = agentById(id);
      if (!a) { send(res, 404, { error: 'no such agent' }); return; }
      if (mm[2] && m === 'PUT') {
        for (const k of ['claude_md', 'now_md']) {
          if (body[k] != null && Buffer.byteLength(String(body[k])) > 200 * 1024) { send(res, 413, { error: `${k} is over 200 KB` }); return; }
        }
        if (typeof body.claude_md === 'string') a._claude = body.claude_md;
        if (typeof body.now_md === 'string') a._now = body.now_md;
        publishOrg('context_updated', id);
        send(res, 204);
        return;
      }
      if (!mm[2] && m === 'GET') {
        const sessions = sessionList().filter((s) => s.agent === id);
        send(res, 200, { ...agentWithStats(a), claude_md: claudeMd(a), now_md: nowMd(a), log_tail: a._log.slice(-20), sessions });
        return;
      }
      if (!mm[2] && m === 'DELETE') {
        if (id === 'donna' || a.kind === 'chief') { send(res, 400, { error: "Donna is the chief of staff and can't be archived" }); return; }
        if ([...st.sessions.values()].some((x) => x.agent === id && x.status !== 'ended')) { send(res, 409, { error: `end ${id}'s live sessions before archiving it` }); return; }
        st.agents = st.agents.filter((x) => x.id !== id);
        publishOrg('agent_archived', id);
        send(res, 200, { ok: true, archived: `.archive/${id}-${Date.now()}` });
        return;
      }
    }
    if (p === '/api/sessions' && m === 'GET') { send(res, 200, sessionList()); return; }
    if (p === '/api/sessions' && m === 'POST') {
      if (!body.agent) { send(res, 400, { error: 'agent is required' }); return; }
      const s = createSession(body);
      if (!s) { send(res, 404, { error: `no agent called "${body.agent}"` }); return; }
      send(res, 201, s);
      return;
    }
    mm = p.match(/^\/api\/sessions\/([^/]+)(\/resume|\/send)?$/);
    if (mm) {
      const s = st.sessions.get(decodeURIComponent(mm[1]));
      if (!s) { send(res, 404, { error: 'no such session' }); return; }
      if (!mm[2] && m === 'PATCH') {
        const t = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : null;
        s.title = t || null;
        broadcast('session', s);
        send(res, 200, s);
        return;
      }
      if (!mm[2] && m === 'DELETE') {
        if (s.status !== 'ended') setStatus(s, 'ended');
        send(res, 200, s);
        return;
      }
      if (!mm[2] && m === 'GET') { send(res, 200, s); return; }
      if (mm[2] === '/resume' && m === 'POST') {
        if (s.resumable === false) { send(res, 409, { error: 'this session cannot be resumed' }); return; }
        if (s.status === 'ended') {
          if (Number.isInteger(body.cols) && Number.isInteger(body.rows)) { const term = ensureTerm(s); term.cols = body.cols; term.rows = body.rows; }
          setStatus(s, 'starting');
          out(s, `\r\n${DIM}── resumed with claude --resume ${s.sid.slice(0, 8)} ──${RESET}\r\n${DIM}›${RESET} `);
          const term = ensureTerm(s); // viewers still attached get a fresh cut, like core
          for (const ws of term.viewers) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'snapshot', data: term.buf.replace(/\r\n/g, '\n') }));
          later(400, () => { if (s.status === 'starting') setStatus(s, 'ready'); });
        }
        send(res, 200, s);
        return;
      }
      if (mm[2] === '/send' && m === 'POST') {
        feedInput(s, `${String(body.text || '')}${body.enter === false ? '' : '\r'}`);
        send(res, 204);
        return;
      }
    }
    if (p === '/api/hooks' && m === 'POST') {
      const s = st.sessions.get(body.sid);
      if (!s) { send(res, 404, { error: 'no such session' }); return; }
      applyHook(s, body.event, body.payload || {});
      send(res, 204);
      return;
    }
    if (p === '/api/pair' && m === 'GET') {
      const host = req.headers.host || '127.0.0.1';
      const lanUrl = `http://192.168.1.20:${host.split(':')[1] || 4747}`;
      send(res, 200, { url: lanUrl, token, link: `${lanUrl}/?t=${token}`, lan: ['192.168.1.20'], bind: st.bind });
      return;
    }
    if (p === '/api/pair/qr.svg' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(placeholderQr(token));
      return;
    }
    if (p === '/api/channels' && m === 'GET') { send(res, 200, channelStatus()); return; }
    if (p === '/api/channels/telegram' && m === 'POST') {
      const t = st.channels.telegram;
      if (typeof body.token === 'string' && body.token.trim()) { t.configured = true; t.paired = false; t.chat_id_masked = null; }
      if (typeof body.enabled === 'boolean') t.enabled = body.enabled;
      if (!t.configured) { send(res, 400, { error: 'send a bot token first' }); return; }
      if (!t.paired && (!st.pairing || body.token || body.pair === true)) st.pairing = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 10 * MIN };
      publishChannels('telegram');
      send(res, 200, { ...channelStatus().telegram });
      return;
    }
    if (p === '/api/channels/imessage' && m === 'POST') {
      const im = st.channels.imessage;
      if (typeof body.handle === 'string') im.handle = body.handle.trim() || null;
      if (typeof body.enabled === 'boolean') im.enabled = body.enabled && !!im.handle;
      publishChannels('imessage');
      send(res, 200, channelStatus().imessage);
      return;
    }
    send(res, 404, { error: 'not found' });
  }

  async function onMock(req, res, url) {
    const p = url.pathname;
    if (p === '/__mock/reset' && req.method === 'POST') {
      const body = await readBody(req);
      reset(body.fixture || url.searchParams.get('fixture') || 'default');
      send(res, 200, { ok: true, sessions: sessionList(), agents: st.agents.map(publicAgent) });
      return;
    }
    if (p === '/__mock/requests') { send(res, 200, st.requests); return; }
    if (p === '/__mock/channel' && req.method === 'POST') {
      const body = await readBody(req);
      const msg = { channel: body.channel || 'telegram', direction: body.direction || 'in', text: body.text || '', ts: new Date().toISOString() };
      st.recent.push({ type: 'channel', ...msg });
      broadcast('channel', msg);
      send(res, 204);
      return;
    }
    if (p === '/__mock/drop' && req.method === 'POST') {
      // Simulate a network blip: kill every terminal socket without a close frame.
      let n = 0;
      for (const term of st.terms.values()) for (const ws of term.viewers) { ws.terminate(); n += 1; }
      send(res, 200, { dropped: n });
      return;
    }
    if (p === '/__mock/bind' && req.method === 'POST') {
      const body = await readBody(req);
      st.bind = body.bind || '127.0.0.1';
      send(res, 204);
      return;
    }
    if (p === '/__mock/pair' && req.method === 'POST') {
      Object.assign(st.channels.telegram, { paired: true, enabled: true, chat_id_masked: '••4821' });
      st.pairing = null;
      st.recent.push({ ts: new Date().toISOString(), type: 'channel', channel: 'telegram', event: 'paired', chat: '••4821' });
      publishChannels('telegram');
      send(res, 204);
      return;
    }
    send(res, 404, { error: 'unknown mock route' });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    Promise.resolve().then(async () => {
      if (p.startsWith('/__mock/')) return onMock(req, res, url);
      if (p === '/' && url.searchParams.has('t')) {
        const ok = safeEq(url.searchParams.get('t'), token);
        const headers = { location: '/', 'cache-control': 'no-store' };
        if (ok) headers['set-cookie'] = `cl_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
        res.writeHead(302, headers);
        res.end();
        return undefined;
      }
      if (p.startsWith('/api/')) return onApi(req, res, url);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
      send(res, 405, 'Method not allowed');
      return undefined;
    }).catch((e) => {
      if (!quiet) console.error(e);
      try { send(res, 500, { error: String(e && e.message) }); } catch { /* ignore */ }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://mock');
    const m = url.pathname.match(/^\/ws\/term\/([^/]+)$/);
    if (!m || !authed(req, url) || !originOk(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const s = st.sessions.get(decodeURIComponent(m[1]));
    if (!s) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const term = ensureTerm(s);
      // Like tmux capture-pane: "\n"-joined lines (the client must turn them into CR+LF).
      ws.send(JSON.stringify({ t: 'snapshot', data: term.buf.replace(/\r\n/g, '\n') }));
      ws.send(JSON.stringify({ t: 'status', status: s.status }));
      if (s.status === 'ended') ws.send(JSON.stringify({ t: 'ended' }));
      term.viewers.add(ws);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'in' && typeof msg.data === 'string') feedInput(s, msg.data);
        else if (msg.t === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          term.cols = msg.cols;
          term.rows = msg.rows;
          st.requests.push({ method: 'WS', path: `/ws/term/${s.sid}`, body: msg, at: Date.now() });
        }
      });
      ws.on('close', () => term.viewers.delete(ws));
    });
  });

  reset(fixture);
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;
  const url = `http://${host}:${actual}`;
  if (!quiet) console.log(`[mock] cockpit: ${url}/?t=${token}`);

  return {
    url, port: actual, token, state: st, reset,
    close: () => new Promise((resolve) => {
      for (const t of timers) clearTimeout(t);
      for (const term of st.terms.values()) clearInterval(term.stream);
      for (const res of sse) { try { res.end(); } catch { /* ignore */ } }
      for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const srv = await startMockServer({ port: Number(arg('port', 4848)), fixture: arg('fixture', 'default'), token: arg('token', 'mock-token-0123456789abcdef'), quiet: false });
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
