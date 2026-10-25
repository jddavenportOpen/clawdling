// Every state transition the UI can make lives here, so the rail, panes,
// palette and pages all share ONE definition of "focus", "open", "end".
import { getState, setState } from './store.js';
import { api } from './api.js';
import { load, save } from './prefs.js';
import { terms } from './term.js';
import { copyText } from './util.js';
import { attachCommand } from './model.js';
import { maybeNotify } from './notify.js';
import { nextPaneSize } from './layout.js';

const LAYOUTS = ['focus', 'split', 'grid'];

export function initialState() {
  const open = load('open', []);
  const layout = load('layout', null);
  return {
    auth: 'checking',
    authError: '',
    me: null,
    org: null,
    agents: [],
    agentsById: {},
    channels: null,
    channelLog: [],
    health: null,
    orgError: '',
    orgTrusted: null, // has Claude Code trusted the org folder? (server org view; null = not told)
    sessions: {},
    sessionsLoaded: false,
    open: Array.isArray(open) ? open.filter((x) => typeof x === 'string') : [],
    focused: load('focused', null),
    focusTick: 0,
    layout: LAYOUTS.includes(layout) ? layout : 'grid',
    layoutChosen: LAYOUTS.includes(layout),
    prevLayout: load('prevLayout', 'grid'),
    splitPair: load('splitPair', []),
    rail: load('rail', 'expanded') === 'collapsed' ? 'collapsed' : 'expanded',
    query: '',
    route: { name: 'cockpit' },
    overlay: null,
    menu: null,
    toasts: [],
    conn: 'connecting',
    now: Date.now(),
    renaming: null,
    mobile: false,
    mobileView: 'list',
    importDismissed: !!load('importCardDismissed', false), // the first-run "Bring in your projects" card
  };
}

function persistWorkspace() {
  const s = getState();
  save('open', s.open);
  save('focused', s.focused);
  save('layout', s.layoutChosen ? s.layout : null);
  save('prevLayout', s.prevLayout);
  save('splitPair', s.splitPair);
}

// ---------- toasts ----------
let toastId = 0;
// `action` ({label, run}) adds one button to the toast, like "Open" after making an agent.
export function toast(text, { tone = 'info', ms = 3200, action = null } = {}) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, text, tone, action }].slice(-4) }));
  setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// The first-run "Bring in your projects" card: hidden for good once dismissed (New agent and
// the palette still offer it).
export function dismissImportCard() {
  setState({ importDismissed: true });
  save('importCardDismissed', true);
}

export function errorToast(prefix, err) {
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  toast(`${prefix}: ${msg}`, { tone: 'error', ms: 5200 });
}

// ---------- routing ----------
export function navigate(hash) {
  if (location.hash === hash || (hash === '#/' && (location.hash === '' || location.hash === '#'))) {
    setState({ route: parseRoute(hash) });
    return;
  }
  location.hash = hash;
}

export function parseRoute(hash = location.hash) {
  const h = (hash || '').replace(/^#\/?/, '');
  const [head, ...rest] = h.split('/');
  if (head === 'map') return { name: 'map' };
  if (head === 'donna') return { name: 'donna' };
  if (head === 'settings') return { name: 'settings', section: rest[0] || null };
  if (head === 'agent' && rest[0]) return { name: 'agent', id: decodeURIComponent(rest[0]), tab: rest[1] || 'sessions' };
  return { name: 'cockpit' };
}

export function goHome() {
  setState({ menu: null, mobileView: getState().mobile && getState().open.length && getState().focused ? getState().mobileView : 'list' });
  navigate('#/');
}

// ---------- sessions store ----------
const touched = new Map(); // sid -> ms of a local write; protects fresh rows from a stale poll

export function mergeSession(patch) {
  if (!patch || !patch.sid) return;
  touched.set(patch.sid, Date.now());
  const before = getState().sessions[patch.sid];
  setState((s) => {
    const prev = s.sessions[patch.sid];
    const next = prev ? { ...prev, ...patch } : patch;
    return { sessions: { ...s.sessions, [patch.sid]: next } };
  });
  const st = getState();
  maybeNotify(before, st.sessions[patch.sid], { agentsById: st.agentsById, onOpen: focusSession });
}

// A poll that STARTED before a local write may carry stale rows for that sid,
// so for those sids the local copy wins; everything else takes the server row.
export function applySessionList(list, startedAt = 0) {
  const s = getState();
  const map = {};
  for (const row of list) if (row && row.sid) map[row.sid] = row;
  const cutoff = Date.now() - 30000;
  for (const [sid, at] of touched) {
    if (at < cutoff) { touched.delete(sid); continue; }
    if (at >= startedAt && s.sessions[sid]) map[sid] = s.sessions[sid];
  }
  const open = s.open.filter((sid) => map[sid]);
  const patch = { sessions: map, sessionsLoaded: true };
  if (open.length !== s.open.length) {
    patch.open = open;
    if (s.focused && !open.includes(s.focused)) patch.focused = open[open.length - 1] || null;
    patch.splitPair = (s.splitPair || []).filter((x) => open.includes(x));
  }
  setState(patch);
  if (patch.open) persistWorkspace();
}

// ---------- workspace ----------
function nextSplitPair(pair, sid, prevFocused, open) {
  const p = (pair || []).filter((x) => open.includes(x));
  if (p.includes(sid)) return p.length === 2 ? p : fillPair(p, open, sid);
  if (p.length < 2) return fillPair([...p, sid], open, sid);
  // Replace the member that is NOT the currently focused pane, keep positions stable.
  const keep = p.includes(prevFocused) ? prevFocused : p[0];
  return p.map((x) => (x === keep ? x : sid));
}

function fillPair(p, open, sid) {
  const out = [...new Set(p)];
  for (const x of [...open].reverse()) {
    if (out.length >= 2) break;
    if (!out.includes(x)) out.push(x);
  }
  if (!out.includes(sid)) out.push(sid);
  return out.slice(0, 2);
}

// Focus a session in the workspace. Already open: it becomes the focused pane and
// nothing else changes. Not open: it is appended to the open set, then focused.
export function focusSession(sid, { route = true } = {}) {
  const s = getState();
  if (!sid) return;
  const open = s.open.includes(sid) ? s.open : [...s.open, sid];
  const patch = { open, focused: sid, focusTick: s.focusTick + 1, menu: null };
  if (s.layout === 'split') patch.splitPair = nextSplitPair(s.splitPair, sid, s.focused, open);
  if (!s.layoutChosen && open.length > 1 && s.layout !== 'grid') patch.layout = 'grid';
  if (s.mobile) patch.mobileView = 'pane';
  setState(patch);
  persistWorkspace();
  if (route && s.route.name !== 'cockpit') navigate('#/');
}

// Clicking inside a pane: focus follows the pointer, without scrolling or flashing.
export function touchFocus(sid) {
  const s = getState();
  if (s.focused === sid || !s.open.includes(sid)) return;
  const patch = { focused: sid };
  if (s.layout === 'split') patch.splitPair = nextSplitPair(s.splitPair, sid, s.focused, s.open);
  setState(patch);
  persistWorkspace();
}

export function focusPaneIndex(i) {
  const s = getState();
  const sid = s.open[i];
  if (sid) focusSession(sid);
}

export function closePane(sid) {
  const s = getState();
  if (!s.open.includes(sid)) return;
  const idx = s.open.indexOf(sid);
  const open = s.open.filter((x) => x !== sid);
  const patch = { open, splitPair: (s.splitPair || []).filter((x) => x !== sid) };
  if (s.focused === sid) patch.focused = open[Math.min(idx, open.length - 1)] || null;
  if (open.length === 0 && s.mobile) patch.mobileView = 'list';
  setState(patch);
  persistWorkspace();
}

export function closeAllPanes() {
  setState({ open: [], focused: null, splitPair: [], mobileView: 'list' });
  persistWorkspace();
}

export function setLayout(layout) {
  if (!LAYOUTS.includes(layout)) return;
  const s = getState();
  const patch = { layout, layoutChosen: true };
  if (layout === 'split') patch.splitPair = fillPair((s.splitPair || []).filter((x) => s.open.includes(x)).concat(s.focused ? [s.focused] : []), s.open, s.focused || s.open[0]);
  setState(patch);
  persistWorkspace();
  refocusSoon();
}

export function toggleMaximize(sid) {
  const s = getState();
  if (s.layout === 'focus' && s.focused === sid) {
    setState({ layout: s.prevLayout && s.prevLayout !== 'focus' ? s.prevLayout : 'grid', layoutChosen: true });
  } else {
    setState({ prevLayout: s.layout === 'focus' ? s.prevLayout : s.layout, layout: 'focus', layoutChosen: true, focused: sid });
  }
  persistWorkspace();
  refocusSoon();
}

function refocusSoon() {
  const sid = getState().focused;
  if (!sid) return;
  setTimeout(() => { const v = terms.get(sid); if (v) v.focus(); }, 30);
}

export function toggleRail(force) {
  const s = getState();
  const rail = force || (s.rail === 'collapsed' ? 'expanded' : 'collapsed');
  setState({ rail });
  save('rail', rail);
}

export function setQuery(query) {
  setState({ query });
}

// ---------- overlays ----------
export function openOverlay(overlay) {
  setState({ overlay, menu: null });
}
export function closeOverlay() {
  setState({ overlay: null });
}
export function togglePalette() {
  const s = getState();
  setState({ overlay: s.overlay && s.overlay.type === 'palette' ? null : { type: 'palette' }, menu: null });
}
export function openMenu(menu) {
  setState({ menu });
}
export function closeMenu() {
  if (getState().menu) setState({ menu: null });
}

// ---------- server actions ----------
export async function startSession(agent, { prompt, model, effort, account, title } = {}) {
  const body = { agent, ...(nextPaneSize() || {}) };
  if (prompt && prompt.trim()) body.prompt = prompt.trim();
  if (model && model.trim()) body.model = model.trim();
  if (effort && effort.trim()) body.effort = effort.trim();
  // No account = the user's own Claude login; only a second login is named.
  if (account && account.trim() && account.trim() !== 'default') body.account = account.trim();
  if (title && title.trim()) body.title = title.trim();
  try {
    const s = await api.spawn(body);
    if (s && s.sid) {
      mergeSession(s);
      focusSession(s.sid);
    }
    return s;
  } catch (e) {
    errorToast('Could not start the session', e);
    // A missing claude/tmux is a lasting problem: re-read /api/health so the banner says so and stays.
    import('./live.js').then((m) => m.refreshHealth()).catch(() => {});
    throw e;
  }
}

export function askEndSession(sid) {
  openOverlay({ type: 'end', sid });
}

export async function endSession(sid) {
  try {
    const s = await api.end(sid);
    mergeSession(s && s.sid ? s : { sid, status: 'ended', ended_at: new Date().toISOString() });
    closePane(sid);
    const v = terms.get(sid);
    if (v) v.setEnded(true);
  } catch (e) {
    errorToast('Could not end the session', e);
  }
}

export async function resumeSession(sid) {
  try {
    const v = terms.get(sid);
    const size = v && v.term.cols > 0 ? { cols: v.term.cols, rows: v.term.rows } : nextPaneSize(getState().open.includes(sid) ? 0 : 1);
    const s = await api.resume(sid, size || undefined);
    mergeSession(s && s.sid ? s : { sid, status: 'starting', ended_at: null });
    focusSession((s && s.sid) || sid);
    const view = terms.get((s && s.sid) || sid);
    if (view) view.setEnded(false);
    return s;
  } catch (e) {
    errorToast('Could not resume the session', e);
    return null;
  }
}

// Answer Claude Code's startup dialog in a session. `option` is the choice's place on screen (see
// the session's `choices`; Claude Code decides the order). 409 = nothing to answer.
// Not signed in: open a "Sign in" session for that session's login (the default one, or a second
// account), a plain claude where the user follows Claude Code's own sign-in. Clawdling never sees it.
export async function signInFor(s) {
  const account = (s && s.account) || 'default';
  try {
    const signin = await api.signIn(account);
    if (signin && signin.sid) {
      mergeSession(signin);
      focusSession(signin.sid);
    }
    toast('Follow the steps in the new session: Claude Code opens your browser to sign in.', { tone: 'ok', ms: 5200 });
    return signin;
  } catch (e) {
    errorToast('Could not start the sign-in', e);
    return null;
  }
}

// After signing in: start a session that was stuck on "not signed in" again, on the same session.
export async function restartSession(sid) {
  try {
    const v = terms.get(sid);
    const size = v && v.term.cols > 0 ? { cols: v.term.cols, rows: v.term.rows } : undefined;
    const s = await api.restart(sid, size);
    mergeSession(s && s.sid ? s : { sid, status: 'starting', waiting_on: null });
    focusSession((s && s.sid) || sid);
    return s;
  } catch (e) {
    if (e && e.status === 409) toast('This session is no longer waiting for a sign-in.', { ms: 3600 });
    else errorToast('Could not start the session again', e);
    return null;
  }
}

export async function answerDialog(sid, option, { focus = false } = {}) {
  try {
    const s = await api.answer(sid, option);
    if (s && s.sid) mergeSession(s);
    else mergeSession({ sid, waiting_on: null, choices: null });
    const v = terms.get(sid);
    if (v && focus) v.focus();
    return true;
  } catch (e) {
    if (e && e.status === 409) {
      toast('Claude Code is no longer asking. The session has moved on.', { ms: 3600 });
      mergeSession({ sid, waiting_on: null, choices: null });
    } else {
      errorToast('Could not answer Claude Code', e);
    }
    return false;
  }
}

// Answer a question card or a plan card (same route as the dialogs; see sessions.answer).
export async function answerCard(sid, body) {
  try {
    const s = await api.answerWith(sid, body);
    if (s && s.sid) mergeSession(s);
    return true;
  } catch (e) {
    if (e && e.status === 409) toast(e.message && !/^\d{3} /.test(e.message) ? `Not sent: ${e.message}.` : 'Claude is no longer asking this. The session has moved on.', { ms: 4200 });
    else errorToast('Could not send your answer', e);
    return false;
  }
}

export async function renameSession(sid, title) {
  const t = (title || '').trim();
  const prev = getState().sessions[sid];
  if (!prev || t === (prev.title || '')) return;
  mergeSession({ sid, title: t || null });
  try {
    const s = await api.rename(sid, t);
    if (s && s.sid) mergeSession(s);
  } catch (e) {
    mergeSession({ sid, title: prev.title });
    errorToast('Could not rename the session', e);
  }
}

export async function copyAttach(session) {
  const cmd = attachCommand(session);
  if (!cmd) { toast('This server did not send an attach command for the session.', { tone: 'error' }); return; }
  const ok = await copyText(cmd);
  toast(ok ? 'Attach command copied. Paste it in any terminal.' : cmd, { tone: ok ? 'ok' : 'info', ms: ok ? 2600 : 8000 });
}

export function setRenaming(sid) {
  setState({ renaming: sid });
}
