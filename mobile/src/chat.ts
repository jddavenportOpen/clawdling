// Chat bookkeeping shared by the session chat and Donna: merging polled pages, matching the
// messages you just sent against what the server echoes back, and the "Ran: ..." tool lines.

import type { ChatMessage, DonnaMessage, DonnaRole, MessageRole, ToolCall } from './types';

/** Merge a polled page into what we have: dedupe by `n`, keep order by `n`. */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return existing;
  const byN = new Map<number, ChatMessage>();
  for (const m of existing) byN.set(m.n, m);
  for (const m of incoming) byN.set(m.n, m);
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

export interface DisplayMessage {
  key: string;
  role: MessageRole;
  text: string;
  tools: ToolCall[];
  ts: string | null;
}

/**
 * Claude Code writes an assistant turn as several transcript lines (text, then each tool call on
 * its own line), and the server returns one message per line. For reading on a phone, a run of
 * tool-only lines is folded into the next assistant text (or kept as one group before a user
 * message), so "Ran: ..." steps collapse together. Keys stay stable while a run grows.
 */
export function groupForDisplay(messages: ChatMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let run: DisplayMessage | null = null;
  for (const m of messages) {
    if (m.role === 'assistant' && !m.text.trim()) {
      if (!run) run = { key: `n${m.n}`, role: 'assistant', text: '', tools: [], ts: m.ts };
      run.tools = [...run.tools, ...m.tools];
      run.ts = m.ts ?? run.ts;
      continue;
    }
    if (m.role === 'assistant') {
      out.push(run ? { ...run, text: m.text, tools: [...run.tools, ...m.tools], ts: m.ts } : { key: `n${m.n}`, role: 'assistant', text: m.text, tools: m.tools, ts: m.ts });
      run = null;
      continue;
    }
    if (run) out.push(run);
    run = null;
    out.push({ key: `n${m.n}`, role: m.role, text: m.text, tools: m.tools, ts: m.ts });
  }
  if (run) out.push(run);
  return out;
}

export function maxN(messages: ChatMessage[]): number | null {
  let max: number | null = null;
  for (const m of messages) if (max === null || m.n > max) max = m.n;
  return max;
}

/** The cursor for the next poll: the server's `next`, else the highest `n` we have. */
export function nextCursor(serverNext: number | null, messages: ChatMessage[], previous: number | null): number | null {
  const candidates = [serverNext, maxN(messages), previous].filter((v): v is number => typeof v === 'number');
  return candidates.length ? Math.max(...candidates) : null;
}

export type PendingState = 'sending' | 'sent' | 'failed';

export interface PendingMessage {
  id: string;
  text: string;
  state: PendingState;
  /** Highest server `n` we had when this was sent: only later messages can be its echo. */
  afterN: number | null;
  error?: string;
  createdAt: number;
}

function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Drop pending messages that the server now shows. Each server user message (newer than the
 * pending one's `afterN`) can confirm at most one pending message, oldest first.
 */
export function reconcilePending(pending: PendingMessage[], server: ChatMessage[]): PendingMessage[] {
  if (!pending.length) return pending;
  const used = new Set<number>();
  const keep: PendingMessage[] = [];
  for (const p of pending) {
    if (p.state === 'failed') {
      keep.push(p);
      continue;
    }
    const want = norm(p.text);
    const match = server.find(
      (m) => m.role === 'user' && !used.has(m.n) && (p.afterN === null || m.n > p.afterN) && norm(m.text) === want,
    );
    if (match) used.add(match.n);
    else keep.push(p);
  }
  return keep.length === pending.length ? pending : keep;
}

/** Text for one tool call: "Ran: npm test" (summary preferred, else the tool name). */
export function toolLine(tool: ToolCall): string {
  const what = (tool.summary || tool.name || 'a tool').replace(/\s+/g, ' ').trim();
  return `Ran: ${what}`;
}

export interface ToolDisplay {
  lines: string[];
  /** Label of the expand/collapse control, or null when everything already shows. */
  toggle: string | null;
}

/** Up to two tool lines show as is; longer runs collapse to the first line plus "N more". */
export function toolDisplay(tools: ToolCall[], expanded: boolean): ToolDisplay {
  if (!tools.length) return { lines: [], toggle: null };
  const all = tools.map(toolLine);
  if (all.length <= 2) return { lines: all, toggle: null };
  if (expanded) return { lines: all, toggle: 'Show less' };
  const more = all.length - 1;
  return { lines: [all[0]], toggle: `${more} more ${more === 1 ? 'step' : 'steps'}` };
}

// ---------------------------------------------------------------- Donna

export interface LocalDonnaItem {
  id: string;
  role: DonnaRole;
  text: string;
  state: PendingState;
  error?: string;
  createdAt: number;
  /**
   * Which occurrence of this role + text on the server will be this item's echo: the server's
   * count when the item was created, plus earlier local copies still waiting, plus one.
   */
  expect: number;
}

export interface DonnaRow {
  key: string;
  role: DonnaRole;
  text: string;
  ts: string | null;
  channel: string | null;
  state?: PendingState;
  error?: string;
  localId?: string;
}

export function countMatching(server: DonnaMessage[], role: DonnaRole, text: string): number {
  const want = norm(text);
  return server.reduce((n, m) => (m.role === role && norm(m.text) === want ? n + 1 : n), 0);
}

/** Local items the server does not show yet (an item is confirmed once its echo is on the server). */
export function pruneLocal(server: DonnaMessage[], local: LocalDonnaItem[]): LocalDonnaItem[] {
  const keep = local.filter((item) => countMatching(server, item.role, item.text) < item.expect);
  return keep.length === local.length ? local : keep;
}

/** Create a local copy of something just sent (or just received from POST /api/donna/chat). */
export function newLocalItem(
  server: DonnaMessage[],
  local: LocalDonnaItem[],
  role: DonnaRole,
  text: string,
  state: PendingState,
  now: number = Date.now(),
): LocalDonnaItem {
  const want = norm(text);
  const waiting = pruneLocal(server, local).filter((l) => l.role === role && norm(l.text) === want).length;
  return { id: localId('d'), role, text, state, createdAt: now, expect: countMatching(server, role, text) + waiting + 1 };
}

/** Server history first, then the local items it does not show yet. */
export function mergeDonna(server: DonnaMessage[], local: LocalDonnaItem[]): { rows: DonnaRow[]; local: LocalDonnaItem[] } {
  const rows: DonnaRow[] = server.map((m, i) => ({
    key: `s${i}:${m.ts ?? ''}:${m.role}`,
    role: m.role,
    text: m.text,
    ts: m.ts,
    channel: m.channel,
  }));
  const remaining = pruneLocal(server, local);
  for (const item of remaining) {
    rows.push({
      key: `l:${item.id}`,
      role: item.role,
      text: item.text,
      ts: new Date(item.createdAt).toISOString(),
      channel: 'app',
      state: item.state,
      error: item.error,
      localId: item.id,
    });
  }
  return { rows, local: remaining };
}

export function channelLabel(channel: string | null | undefined): string | null {
  if (!channel) return null;
  const c = channel.toLowerCase();
  if (c === 'app' || c === 'mobile' || c === 'ios' || c === 'web' || c === 'cockpit') return null;
  if (c === 'telegram') return 'via Telegram';
  if (c === 'imessage') return 'via iMessage';
  return `via ${channel}`;
}

let seq = 0;
export function localId(prefix = 'm'): string {
  seq = (seq + 1) % 1e9;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}
