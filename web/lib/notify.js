// "An agent needs you" in this browser: a system notification when the cockpit tab is hidden and
// a session starts waiting on you. Off until turned on in Settings (the browser asks permission
// then). One per session a minute; a click brings the tab back on that session.
import { load, save } from './prefs.js';

const PREF = 'notifyNeedsYou';
const PER_SESSION_MS = 60000;
const PER_MINUTE = 6; // in all, however many sessions start waiting
const last = new Map();
let recent = [];
// The agents' names the owner approved when turning on "Message me" (GET /api/notify `labels`):
// the only names a notification shows; anything else is "An agent".
let labels = {};
export function setLabels(map) {
  labels = map && typeof map === 'object' ? map : {};
}
function nameFor(agent) {
  if (Object.hasOwn(labels, agent)) return safeName(labels[agent]);
  const mine = load(`${PREF}.labels`, {}) || {};
  return Object.hasOwn(mine, agent) ? safeName(mine[agent]) : 'An agent';
}
// What kind of wait, in fixed words: the notification can show on a lock screen, so it never
// carries the question itself or anything else from the conversation.
const WHAT = { question: 'a question', plan: 'a plan to approve', permission_prompt: 'a permission', elicitation_dialog: 'a question', login: 'a sign-in', error: 'an error', trust: 'a question before it starts', imports: 'a question before it starts', startup: 'a question before it starts' };
const kindOf = (k) => (typeof k === 'string' && Object.hasOwn(WHAT, k) ? WHAT[k] : null);
/** The agent's name in plain words (agents can name themselves): letters, digits, spaces, hyphens. */
export function safeName(name) {
  const s = String(name || '').replace(/[^\p{L}\p{N} -]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return (s.length > 40 ? s.slice(0, 40).trim() : s) || 'An agent';
}

export function notifyBody(s) {
  const what = kindOf(s && s.asking && s.asking.kind) || kindOf(s && s.waiting_on);
  return `Waiting on you${what ? `: ${what}` : ''}. Open the cockpit to answer.`;
}

export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;
export const notifyOn = () => notifySupported() && !!load(PREF, false) && window.Notification.permission === 'granted';

/**
 * Turn it on (asks the browser) or off. `names` ({agent id: name}) are the names the owner sees
 * now: they become this browser's approved labels. Returns 'on' | 'off' | 'denied'.
 */
export async function setNotify(on, names = {}) {
  if (!on || !notifySupported()) {
    save(PREF, false);
    save(`${PREF}.labels`, null);
    return 'off';
  }
  const snap = {};
  for (const [id, n] of Object.entries(names || {})) snap[id] = safeName(n);
  save(`${PREF}.labels`, snap);
  let perm = window.Notification.permission;
  if (perm === 'default') perm = await window.Notification.requestPermission();
  save(PREF, perm === 'granted');
  return perm === 'granted' ? 'on' : 'denied';
}

/** Called with a session's old and new row: notify when it just started needing you. */
export function maybeNotify(prev, next, { onOpen = () => {} } = {}) {
  if (!next || next.status !== 'needs_you' || (prev && prev.status === 'needs_you')) return false;
  if (typeof document === 'undefined' || !document.hidden || !notifyOn()) return false;
  const t = Date.now();
  for (const [k, at] of last) if (t - at >= PER_SESSION_MS) last.delete(k);
  recent = recent.filter((x) => t - x < 60000);
  if (last.has(next.sid) || recent.length >= PER_MINUTE) return false;
  last.set(next.sid, t);
  recent.push(t);
  try {
    const n = new window.Notification(`${nameFor(next.agent)} needs you`, { body: notifyBody(next), tag: `clawdling-${next.sid}` });
    n.onclick = () => {
      window.focus();
      onOpen(next.sid);
      n.close();
    };
    return true;
  } catch {
    return false; // some browsers only allow notifications from a service worker
  }
}
