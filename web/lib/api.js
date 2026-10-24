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

async function request(method, path, body, { quiet401 = false } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
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
  channels: () => request('GET', '/api/channels'),
  telegram: (body) => request('POST', '/api/channels/telegram', body),
  imessage: (body) => request('POST', '/api/channels/imessage', body),
};
