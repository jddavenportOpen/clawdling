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
  answer: async (sid, option) => one(await request('POST', `/api/sessions/${enc(sid)}/answer`, { option }), 'session'),
  send: (sid, text, enter = true) => request('POST', `/api/sessions/${enc(sid)}/send`, { text, enter }),

  pair: () => request('GET', '/api/pair'),
  channels: () => request('GET', '/api/channels'),
  telegram: (body) => request('POST', '/api/channels/telegram', body),
  imessage: (body) => request('POST', '/api/channels/imessage', body),
};
