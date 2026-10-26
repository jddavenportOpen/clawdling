// HTTP client for the Clawdling server (SPEC §4). Same-origin only: the
// server authenticates with the HttpOnly cl_token cookie it set at /?t=<token>.

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

const enc = encodeURIComponent;

// Use from anywhere: a paired browser's second key, kept in this origin's own storage (another
// service on the same host name, on another port, never sees it; it does see cookies).
const KEY_STORE = 'clawdling.deviceKey';
export function deviceKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}
function setDeviceKey(k) {
  try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch { /* storage off: pair again next time */ }
}
/** `?k=` / `&k=` for the event stream and terminal sockets, which cannot send headers. */
export function keyQuery(sep = '?') {
  const k = deviceKey();
  return k ? `${sep}k=${encodeURIComponent(k)}` : '';
}

async function request(method, path, body, { quiet401 = false } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  const key = deviceKey();
  if (key) opts.headers['x-clawdling-device-key'] = key;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, 'The Clawdling server is not reachable.');
  }
  if (res.status === 401) {
    if (!quiet401) onUnauthorized();
    throw new ApiError(401, 'Not signed in to this cockpit');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.error || data.message)) || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, String(msg), data);
  }
  return data;
}

const list = (r, key) => (Array.isArray(r) ? r : (r && Array.isArray(r[key]) ? r[key] : []));
const one = (r, key) => (r && typeof r === 'object' && r[key] && typeof r[key] === 'object' && !Array.isArray(r[key]) && !('sid' in r) && !('id' in r) ? r[key] : r);

export const api = {
  me: () => request('GET', '/api/me', undefined, { quiet401: true }),
  health: () => request('GET', '/api/health'),
  org: () => request('GET', '/api/org'),

  agent: async (id) => one(await request('GET', `/api/agents/${enc(id)}`), 'agent'),
  createAgent: async (body) => one(await request('POST', '/api/agents', body), 'agent'),
  saveContext: (id, body) => request('PUT', `/api/agents/${enc(id)}/context`, body),
  archiveAgent: (id) => request('DELETE', `/api/agents/${enc(id)}`),

  sessions: async () => list(await request('GET', '/api/sessions'), 'sessions'),
  spawn: async (body) => one(await request('POST', '/api/sessions', body), 'session'),
  rename: async (sid, title) => one(await request('PATCH', `/api/sessions/${enc(sid)}`, { title }), 'session'),
  end: async (sid) => one(await request('DELETE', `/api/sessions/${enc(sid)}`), 'session'),
  resume: async (sid, size) => one(await request('POST', `/api/sessions/${enc(sid)}/resume`, size), 'session'),
  // "Start again": a new claude for a session stuck on "not signed in" (or a stalled start).
  restart: async (sid, size) => one(await request('POST', `/api/sessions/${enc(sid)}/restart`, size || {}), 'session'),
  answer: async (sid, option) => one(await request('POST', `/api/sessions/${enc(sid)}/answer`, { option }), 'session'),
  // A question card ({tool_id, answers}) or a plan with what to change ({option, text}).
  answerWith: async (sid, body) => one(await request('POST', `/api/sessions/${enc(sid)}/answer`, body), 'session'),
  send: (sid, text, enter = true) => request('POST', `/api/sessions/${enc(sid)}/send`, { text, enter }),
  // The session's chat, read from Claude Code's own transcript: {messages:[{n, role, text, tools, ts, model}], next, more, status}.
  messages: (sid, after = -1) => request('GET', `/api/sessions/${enc(sid)}/messages?after=${enc(String(after))}`),
  // Switch model / effort between turns ({model?, effort?}); 409 unless it is the owner's turn.
  sessionSettings: async (sid, body) => one(await request('POST', `/api/sessions/${enc(sid)}/settings`, body), 'session'),

  // Claude logins: [{id: 'default', name, default: true}, {id, name, dir}...]. Clawdling only passes CLAUDE_CONFIG_DIR.
  accounts: async () => list(await request('GET', '/api/accounts'), 'accounts'),
  addAccount: (name) => request('POST', '/api/accounts', { name }),
  signIn: async (id) => one(await request('POST', `/api/accounts/${enc(id)}/signin`, {}), 'session'),

  // 1.2. Find the user's projects: read-only, local, and GitHub only through their own gh.
  // {candidates, sources: {claude, local, github}, clone_root, took_ms}. github: false skips gh;
  // refresh: true skips the server's 30 s cache.
  discover: ({ github = true, refresh = false } = {}) => {
    const q = [github ? '' : 'github=0', refresh ? 'refresh=1' : ''].filter(Boolean).join('&');
    return request('GET', `/api/discover${q ? `?${q}` : ''}`);
  },
  // The user's own Claude Code setup, names and descriptions only (never a key or a command).
  setup: () => request('GET', '/api/setup'),
  // One project per call, so the cockpit can show each row's progress: {path?, github?, url?, name?,
  // domain?, new_domain?, clone?} or {group: {name, domain?, new_domain?}, items: [{path}]}.
  // 201 {agent, created, cloned}, or 200 {agent, skipped, reason} when it is already an agent.
  importProject: (body) => request('POST', '/api/import', body),
  // A Claude Code subagent becomes a standing domain agent: {scope: 'user'|'repo', repo?, name}.
  promoteSubagent: async (body) => one(await request('POST', '/api/setup/promote', body), 'agent'),

  pair: () => request('GET', '/api/pair'),

  // 1.3, Use from anywhere. {enabled, invalid, port, hosts, devices, here}. Turning it on, adding
  // addresses and making pairing links work only on the computer itself; off works from anywhere.
  remote: () => request('GET', '/api/remote'),
  remoteCheck: () => request('POST', '/api/remote/check', {}),
  remoteEnabled: (enabled) => request('POST', '/api/remote/enabled', { enabled }),
  // {expires_at, minutes, links: [{url, kind, link, qr_svg}]}: one code, once, for a few minutes.
  remotePairing: () => request('POST', '/api/remote/pairing', {}),
  // The phone's side of a pairing link (through the remote address): sets this device's cookie.
  remotePair: async (code) => {
    const r = await request('POST', '/api/remote/pair', { code }, { quiet401: true });
    if (r && r.device_key) setDeviceKey(r.device_key);
    return r;
  },
  remoteSignOut: (id) => request('DELETE', `/api/remote/devices/${enc(id)}`),
  // 1.5, the report card (read-only). window: 'today' | '7d' | '30d'. Dollar figures are list-price
  // equivalents, never a bill.
  agentReport: (id, window = '7d') => request('GET', `/api/agents/${enc(id)}/report?window=${enc(window)}`),
  orgReport: (window = '7d') => request('GET', `/api/org/report?window=${enc(window)}`),
  // A session's Timeline: {entries: [{n, kind, ...}], next, more, total, transcript, cost}, 500 at a time.
  timeline: (sid, after = -1) => request('GET', `/api/sessions/${enc(sid)}/timeline?after=${enc(String(after))}`),
  // The Monday report (opt-in): {enabled, channel, preview, day, hour, last_sent_week, ...}.
  digest: () => request('GET', '/api/digest'),
  setDigest: (body) => request('POST', '/api/digest', body),
  // The detailed timeline (beta, OpenTelemetry): {enabled, blocked, reason, ...}.
  otel: () => request('GET', '/api/otel'),
  setOtel: (enabled) => request('POST', '/api/otel', { enabled: !!enabled }),
  // 1.6, Verified done. Claim receipts for one session's chat, and the one "fix it" message (the
  // exact text shown, which the server checks again before sending).
  sessionClaims: (sid) => request('GET', `/api/sessions/${enc(sid)}/claims`),
  sendFix: (sid, text) => request('POST', `/api/sessions/${enc(sid)}/fix`, { text }),
  // The ship check: {available, proposals, config, approved, last, running, notes}. Approving needs
  // `shown`, the exact command strings on screen; approving and running work only on the computer itself.
  checks: (id) => request('GET', `/api/agents/${enc(id)}/checks`),
  approveChecks: (id, body) => request('PUT', `/api/agents/${enc(id)}/checks`, body),
  runChecks: (id) => request('POST', `/api/agents/${enc(id)}/checks/run`, {}),
  // Agent check-ups: {cases, settings, estimate, matrix, active, history, notes}.
  evals: (id) => request('GET', `/api/agents/${enc(id)}/evals`),
  draftEvals: (id) => request('POST', `/api/agents/${enc(id)}/evals/draft`, {}),
  saveCase: (id, caseId, body) => request('PUT', `/api/agents/${enc(id)}/evals/${enc(caseId)}`, body),
  removeCase: (id, caseId) => request('DELETE', `/api/agents/${enc(id)}/evals/${enc(caseId)}`),
  approveCases: (id, body) => request('POST', `/api/agents/${enc(id)}/evals/approve`, body),
  saveEvalSettings: (id, body) => request('POST', `/api/agents/${enc(id)}/evals/settings`, body),
  evalEstimate: (id, { k = 1, models = '' } = {}) => request('GET', `/api/agents/${enc(id)}/evals/estimate?k=${enc(String(k))}${models ? `&models=${enc(models)}` : ''}`),
  runEvals: (id, body) => request('POST', `/api/agents/${enc(id)}/evals/run`, body),
  applyModel: (id, body) => request('POST', `/api/agents/${enc(id)}/evals/apply`, body),
  channels: () => request('GET', '/api/channels'),
  notify: () => request('GET', '/api/notify'),
  setNotify: (needsYou) => request('POST', '/api/notify', { needs_you: !!needsYou }),
  telegram: (body) => request('POST', '/api/channels/telegram', body),
  imessage: (body) => request('POST', '/api/channels/imessage', body),
};
