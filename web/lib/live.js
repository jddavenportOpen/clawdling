// Boot + live data: auth probe, initial loads, SSE /api/events with reconnect,
// and a 10 s safety poll of /api/sessions (SSE can drop silently behind proxies).
import { api, ApiError, setUnauthorizedHandler } from './api.js';
import { getState, setState } from './store.js';
import { applySessionList, mergeSession } from './actions.js';

let es = null;
let esRetry = 1000;
let esTimer = 0;
let pollTimer = 0;
let clockTimer = 0;
let started = false;

function indexAgents(agents) {
  const byId = {};
  for (const a of agents) if (a && a.id) byId[a.id] = a;
  return byId;
}

function applyOrg(r) {
  const agents = Array.isArray(r && r.agents) ? r.agents : [];
  const patch = { org: (r && r.org) || {}, agents, agentsById: indexAgents(agents) };
  if (r && r.channels) {
    patch.channels = r.channels;
    if (Array.isArray(r.channels.recent) && !getState().channelLog.length) patch.channelLog = r.channels.recent.slice(-50);
  }
  setState(patch);
}

export async function refreshOrg() {
  try {
    applyOrg(await api.org());
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) console.warn('[clawdling] org refresh failed', e);
  }
}

export async function refreshSessions() {
  const startedAt = Date.now();
  try {
    const list = await api.sessions();
    applySessionList(list, startedAt);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) setState({ conn: getState().conn === 'live' ? 'live' : 'retrying' });
  }
}

export async function refreshChannels() {
  try {
    const channels = await api.channels();
    setState({ channels });
    if (channels && Array.isArray(channels.recent) && !getState().channelLog.length) {
      setState({ channelLog: channels.recent.slice(-50) });
    }
  } catch { /* channels are optional on a fresh org */ }
}

export async function refreshHealth() {
  try { setState({ health: await api.health() }); } catch { /* shown as unknown */ }
}

function parse(data) {
  if (data == null || data === '') return null;
  try { return JSON.parse(data); } catch { return null; }
}

// Accept both framings: default "message" events carrying {type,data}, and
// named events (event: session) whose data is the payload or {type,data}.
export function handleEvent(type, payload) {
  let data = payload;
  if (data && typeof data === 'object' && typeof data.type === 'string' && 'data' in data && (!type || data.type === type)) {
    type = data.type;
    data = data.data;
  }
  if (type === 'session') {
    const row = data && (data.session || data);
    if (row && row.sid) {
      const known = getState().sessions[row.sid];
      if (known || (row.agent && row.status)) mergeSession(row);
      else refreshSessions();
      if (row.deleted || row.removed) refreshSessions();
    } else {
      refreshSessions();
    }
  } else if (type === 'org') {
    // The server may ship the whole org view with the event; apply it, else refetch.
    if (data && Array.isArray(data.agents)) applyOrg(data);
    else refreshOrg();
  } else if (type === 'channel') {
    if (data && typeof data === 'object' && (data.telegram || data.imessage)) {
      // A channel STATUS snapshot (configured, paired, pairing code...), not a message.
      const { channel: _c, ...status } = data;
      setState({ channels: status });
      if (Array.isArray(status.recent)) setState({ channelLog: status.recent.slice(-50) });
      return;
    }
    const entry = { ...(data && typeof data === 'object' ? data : { text: String(data) }), _at: Date.now() };
    setState((s) => ({ channelLog: [...s.channelLog, entry].slice(-50) }));
  }
}

function connectEvents() {
  clearTimeout(esTimer);
  if (es) { try { es.close(); } catch { /* ignore */ } }
  let src;
  try {
    src = new EventSource('/api/events', { withCredentials: true });
  } catch {
    esTimer = setTimeout(connectEvents, esRetry);
    return;
  }
  es = src;
  src.onopen = () => {
    esRetry = 1000;
    setState({ conn: 'live' });
    refreshSessions();
  };
  src.onmessage = (e) => {
    const m = parse(e.data);
    if (m && typeof m === 'object') handleEvent(m.type, m);
  };
  for (const t of ['session', 'org', 'channel']) {
    src.addEventListener(t, (e) => handleEvent(t, parse(e.data)));
  }
  src.onerror = () => {
    if (es !== src) return;
    setState({ conn: 'retrying' });
    if (src.readyState === 2) { // CLOSED: the browser gave up (e.g. 401/500), so retry ourselves
      src.close();
      esTimer = setTimeout(connectEvents, esRetry);
      esRetry = Math.min(esRetry * 2, 15000);
    }
  };
}

function onAuthLost() {
  if (getState().auth === 'ok') setState({ auth: 'denied' });
  stopLive();
}

export function stopLive() {
  started = false;
  clearTimeout(esTimer);
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
}

function startLive() {
  if (started) return;
  started = true;
  connectEvents();
  pollTimer = setInterval(refreshSessions, 10000);
  clockTimer = setInterval(() => setState({ now: Date.now() }), 20000);
}

// GET /api/me is the auth probe. A server without /api/me (404) falls back to /api/org.
async function probeAuth() {
  try {
    const me = await api.me();
    return { ok: true, me };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { ok: false };
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
      try {
        await api.org();
        return { ok: true, me: null };
      } catch (e2) {
        if (e2 instanceof ApiError && e2.status === 401) return { ok: false };
        return { ok: false, error: e2.message };
      }
    }
    return { ok: false, error: e.message };
  }
}

export async function boot() {
  setUnauthorizedHandler(onAuthLost);
  // The server swaps ?t=<token> for an HttpOnly cookie; never leave a token in the address bar.
  if (/[?&]t=/.test(location.search)) {
    history.replaceState(null, '', location.pathname + location.hash);
  }
  setState({ auth: 'checking', authError: '' });
  const r = await probeAuth();
  if (!r.ok) {
    setState({ auth: r.error ? 'error' : 'denied', authError: r.error || '' });
    return false;
  }
  setState({ auth: 'ok', me: r.me });
  await Promise.all([refreshOrg(), refreshSessions(), refreshChannels(), refreshHealth()]);
  startLive();
  return true;
}
