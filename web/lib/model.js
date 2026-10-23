// Domain helpers: how a session is named, grouped and labelled everywhere.
import { toMs } from './util.js';

export const DAY = 86400000;
export const RECENT_DAYS = 14;

export const STATUS_LABEL = {
  starting: 'New',
  working: 'Working',
  ready: 'Your turn',
  needs_you: 'Needs you',
  ended: 'Ended',
};

export function isEnded(s) {
  return !s || s.status === 'ended';
}

export function isLive(s) {
  return !!s && s.status !== 'ended';
}

// Claude Code asked you something (a permission, a startup dialog): it cannot go on without you.
export function isBlocked(s) {
  return !!s && s.status === 'needs_you';
}

// Claude finished a turn and is waiting for your reply. A session you just opened is "ready" too,
// but it has no last message yet: it is waiting for your FIRST message, not waiting on you.
export function isYourTurn(s) {
  return !!s && s.status === 'ready' && !!s.last_message;
}

// "Needs you" everywhere (rail section, counts, badges, the map): blocked or your turn.
export function needsYou(s) {
  return isBlocked(s) || isYourTurn(s);
}

export function agentLabel(s, agentsById = {}) {
  if (!s) return '';
  const a = agentsById[s.agent];
  if (s.agent_name) return s.agent_name;
  if (a && a.name) return a.name;
  if (s.agent === 'scratch') return 'Scratch';
  const id = s.agent || 'Agent';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// The session's REAL name: its title, else "<Agent>: new session" (never a class label).
export function sessionName(s, agentsById = {}) {
  if (!s) return 'Session';
  const t = typeof s.title === 'string' ? s.title.trim() : '';
  return t || `${agentLabel(s, agentsById)}: new session`;
}

export function statusText(s) {
  if (!s) return '';
  if (s.status === 'needs_you') return s.notification ? String(s.notification) : 'Needs you';
  if (s.status === 'ready' && s.last_message) return `Your turn · ${String(s.last_message)}`;
  if (s.status === 'ready') return 'Ready for your first message';
  if (s.status === 'starting' && s.notification) return String(s.notification);
  return STATUS_LABEL[s.status] || s.status || '';
}

export function activityAt(s) {
  return toMs(s.last_activity_at) || toMs(s.created_at) || 0;
}

export function sessionTime(s) {
  return s.status === 'ended' ? (s.ended_at || s.last_activity_at || s.created_at) : (s.last_activity_at || s.created_at);
}

// Only the server knows its real tmux socket, so the attach command is always its attach_cmd.
export function attachCommand(s) {
  return s && typeof s.attach_cmd === 'string' && s.attach_cmd.trim() ? s.attach_cmd.trim() : '';
}

const NEEDS_ORDER = { needs_you: 0, ready: 1 };
const LIVE_ORDER = { working: 0, starting: 1, ready: 2 };

export function groupSessions(list, now = Date.now()) {
  const needs = [];
  const live = [];
  const recent = [];
  for (const s of list) {
    if (needsYou(s)) needs.push(s);
    else if (s.status === 'ended') {
      const t = toMs(s.ended_at) || activityAt(s);
      if (!t || now - t <= RECENT_DAYS * DAY) recent.push(s);
    } else live.push(s);
  }
  needs.sort((a, b) => (NEEDS_ORDER[a.status] - NEEDS_ORDER[b.status]) || (activityAt(b) - activityAt(a)));
  live.sort((a, b) => ((LIVE_ORDER[a.status] ?? 2) - (LIVE_ORDER[b.status] ?? 2)) || (activityAt(b) - activityAt(a)));
  recent.sort((a, b) => (toMs(b.ended_at) || activityAt(b)) - (toMs(a.ended_at) || activityAt(a)));
  return { needs, live, recent };
}

// Per agent: live sessions, blocked (Claude asked something), turn (your reply), needs = both
// (the same "need you" as the rail), working.
export function agentStats(agentId, sessions) {
  let live = 0;
  let blocked = 0;
  let turn = 0;
  let working = 0;
  for (const s of sessions) {
    if (s.agent !== agentId || s.status === 'ended') continue;
    live += 1;
    if (isBlocked(s)) blocked += 1;
    else if (isYourTurn(s)) turn += 1;
    if (s.status === 'working' || s.status === 'starting') working += 1;
  }
  return { live, blocked, turn, needs: blocked + turn, working };
}

export function countNeedsYou(sessions) {
  let n = 0;
  for (const s of sessions) if (needsYou(s)) n += 1;
  return n;
}

export const KIND_LABEL = { chief: 'Chief of staff', domain: 'Domain', project: 'Project' };

// One check in /api/health passed (`{ok: true}`).
export function ok(x) {
  return !!x && (x.ok === true || x.ok === 'true');
}

// The checks in /api/health that failed and stop sessions from starting: every top-level entry
// shaped `{ok, ...}` whose ok is false, unless the server marks it `optional`. Generic on purpose,
// so a check the server adds later (another session backend, say) shows up without a UI change.
export function healthProblems(health) {
  if (!health || typeof health !== 'object') return [];
  const out = [];
  for (const [id, v] of Object.entries(health)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !('ok' in v)) continue;
    if (ok(v) || v.optional) continue;
    out.push({ id, ...v });
  }
  return out;
}

export function agentFolder(a) {
  if (!a) return '';
  if (a.kind === 'chief') return `${a.id}/`;
  return `${a.kind === 'project' ? 'projects' : 'domains'}/${a.id}/`;
}

// Donna first, then domains, then projects, each in the server's order.
export function sortAgents(agents) {
  const rank = { chief: 0, domain: 1, project: 2 };
  return [...agents].sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3));
}
