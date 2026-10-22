// Display helpers shared by every screen. Pure functions, unit-tested.

import type { Agent, AgentKind, Session, SessionStatus } from './types';

export type StatusTone = 'working' | 'needs' | 'ready' | 'ended';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Short words for screen readers. */
  a11y: string;
}

export const STATUS_META: Record<SessionStatus, StatusMeta> = {
  starting: { label: 'Starting', tone: 'working', a11y: 'starting' },
  working: { label: 'Working', tone: 'working', a11y: 'working' },
  ready: { label: 'Ready', tone: 'ready', a11y: 'ready, your turn' },
  needs_you: { label: 'Needs you', tone: 'needs', a11y: 'needs you' },
  ended: { label: 'Ended', tone: 'ended', a11y: 'ended' },
};

export function statusMeta(status: SessionStatus): StatusMeta {
  return STATUS_META[status] ?? STATUS_META.working;
}

export function isLive(status: SessionStatus): boolean {
  return status !== 'ended';
}

/** The name a person sees for a session: its title, else "<Agent>: new session". */
export function sessionTitle(s: Pick<Session, 'title' | 'agent_name' | 'agent'>): string {
  const t = (s.title ?? '').trim();
  if (t) return t;
  const agent = (s.agent_name || s.agent || 'Agent').trim();
  return `${agent}: new session`;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact relative time for lists: "now", "4m", "3h", "2d", then "Oct 3". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const t = toMs(iso);
  if (t === null) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(t);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** Longer form for headers and accessibility: "just now", "4 min ago", "3 hr ago", "2 days ago". */
export function relativeTimeLong(iso: string | null | undefined, now: number = Date.now()): string {
  const t = toMs(iso);
  if (t === null) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  const date = new Date(t);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** Clock time for chat timestamps, e.g. "9:41 AM". */
export function clockTime(iso: string | null | undefined): string {
  const t = toMs(iso);
  if (t === null) return '';
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m < 10 ? '0' : ''}${m} ${h < 12 ? 'AM' : 'PM'}`;
}

export function activityTime(s: Pick<Session, 'last_activity_at' | 'created_at' | 'ended_at' | 'status'>): string | null {
  if (s.status === 'ended') return s.ended_at || s.last_activity_at || s.created_at;
  return s.last_activity_at || s.created_at;
}

export const RECENT_DAYS = 14;

export interface HomeSections {
  needsYou: Session[];
  live: Session[];
  recent: Session[];
  agents: Agent[];
}

const KIND_ORDER: Record<AgentKind, number> = { chief: 0, domain: 1, project: 2, scratch: 3 };

function byActivityDesc(a: Session, b: Session): number {
  return (toMs(activityTime(b)) ?? 0) - (toMs(activityTime(a)) ?? 0);
}

/**
 * Home's sections: Needs you (needs_you first, then ready: both are "your turn"), Live (working +
 * starting), Recent (ended in the last 14 days) and Agents (Donna, then domains, then projects).
 */
export function groupHome(sessions: Session[], agents: Agent[], now: number = Date.now()): HomeSections {
  const cutoff = now - RECENT_DAYS * 24 * 3600 * 1000;
  const needs = sessions.filter((s) => s.status === 'needs_you').sort(byActivityDesc);
  const ready = sessions.filter((s) => s.status === 'ready').sort(byActivityDesc);
  const live = sessions.filter((s) => s.status === 'working' || s.status === 'starting').sort(byActivityDesc);
  const recent = sessions
    .filter((s) => s.status === 'ended' && (toMs(activityTime(s)) ?? now) >= cutoff)
    .sort(byActivityDesc);
  const ordered = agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (KIND_ORDER[x.a.kind] ?? 9) - (KIND_ORDER[y.a.kind] ?? 9) || x.i - y.i)
    .map((x) => x.a);
  return { needsYou: [...needs, ...ready], live, recent, agents: ordered };
}

/** "••••••••3f9a": enough to recognise a code, not enough to use it. */
export function maskToken(token: string): string {
  if (!token) return '';
  return `${'•'.repeat(8)}${token.slice(-4)}`;
}

/** "192.168.1.20:4747" from "http://192.168.1.20:4747". */
export function hostLabel(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}

/**
 * Questions only the terminal can answer: Enter would pick an option (folder trust defaults to
 * "No, exit", a permission prompt to "Yes"), so the server refuses to type into them (409).
 */
export const ANSWER_IN_TERMINAL = new Set(['trust', 'imports', 'startup', 'permission_prompt', 'elicitation_dialog']);

export type TerminalQuestion = { kind: 'permission' | 'choice' | 'startup'; certain: boolean };

/**
 * Is this session waiting on a question that must be answered in the terminal? `certain` is false
 * for older servers that do not report `waiting_on`, where the notice text is the only clue.
 */
export function terminalQuestion(s: Pick<Session, 'status' | 'waiting_on' | 'reports_waiting' | 'notification'>): TerminalQuestion | null {
  if (s.status !== 'needs_you') return null;
  if (s.waiting_on) {
    if (!ANSWER_IN_TERMINAL.has(s.waiting_on)) return null;
    if (s.waiting_on === 'permission_prompt') return { kind: 'permission', certain: true };
    if (s.waiting_on === 'elicitation_dialog') return { kind: 'choice', certain: true };
    return { kind: 'startup', certain: true };
  }
  if (!s.reports_waiting && isPermissionPrompt(s.notification)) return { kind: 'permission', certain: false };
  return null;
}

/** True when a needs-you notice is a permission prompt (answering it means pressing keys in the TUI). */
export function isPermissionPrompt(notification: string | null | undefined): boolean {
  return !!notification && /\bpermission\b|\bapprove\b|\ballow\b/i.test(notification);
}

/** First line of a reply, trimmed for a one-line preview. */
export function previewText(text: string | null | undefined, max = 140): string {
  if (!text) return '';
  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
