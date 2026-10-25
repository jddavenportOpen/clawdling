// "An agent needs you" in this browser: a system notification when the cockpit tab is hidden and
// a session starts waiting on you. Off until turned on in Settings (the browser asks permission
// then). One per session a minute; a click brings the tab back on that session.
import { load, save } from './prefs.js';
import { agentLabel } from './model.js';

const PREF = 'notifyNeedsYou';
const PER_SESSION_MS = 60000;
const PER_MINUTE = 6; // in all, however many sessions start waiting
const last = new Map();
let recent = [];
// What kind of wait, in fixed words: the notification can show on a lock screen, so it never
// carries the question itself or anything else from the conversation.
const WHAT = { question: 'a question', plan: 'a plan to approve', permission_prompt: 'a permission', elicitation_dialog: 'a question', login: 'a sign-in', error: 'an error', trust: 'a question before it starts', imports: 'a question before it starts', startup: 'a question before it starts' };
const kindOf = (k) => (typeof k === 'string' && Object.hasOwn(WHAT, k) ? WHAT[k] : null);
export function notifyBody(s) {
  const what = kindOf(s && s.asking && s.asking.kind) || kindOf(s && s.waiting_on);
  return `Waiting on you${what ? `: ${what}` : ''}. Open the cockpit to answer.`;
}

export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;
export const notifyOn = () => notifySupported() && !!load(PREF, false) && window.Notification.permission === 'granted';

/** Turn it on (asks the browser) or off. Returns the state it ended in: 'on' | 'off' | 'denied'. */
export async function setNotify(on) {
  if (!on || !notifySupported()) {
    save(PREF, false);
    return 'off';
  }
  let perm = window.Notification.permission;
  if (perm === 'default') perm = await window.Notification.requestPermission();
  save(PREF, perm === 'granted');
  return perm === 'granted' ? 'on' : 'denied';
}

/** Called with a session's old and new row: notify when it just started needing you. */
export function maybeNotify(prev, next, { agentsById = {}, onOpen = () => {} } = {}) {
  if (!next || next.status !== 'needs_you' || (prev && prev.status === 'needs_you')) return false;
  if (typeof document === 'undefined' || !document.hidden || !notifyOn()) return false;
  const t = Date.now();
  for (const [k, at] of last) if (t - at >= PER_SESSION_MS) last.delete(k);
  recent = recent.filter((x) => t - x < 60000);
  if (last.has(next.sid) || recent.length >= PER_MINUTE) return false;
  last.set(next.sid, t);
  recent.push(t);
  try {
    const n = new window.Notification(`${agentLabel(next, agentsById)} needs you`, { body: notifyBody(next), tag: `clawdling-${next.sid}` });
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
