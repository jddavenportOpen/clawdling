// ═══════════════════════════════════════════════════════════════════════════
// tools.ts — CLIENT-EXECUTED agent tools (the "it acts" layer).
//
// These are custom tools the MODEL requests and WE run server-side, then feed
// the result back so the model can continue. Distinct from Anthropic's
// server-side web tools (which Anthropic runs). This is what turns the chat
// from "talks + searches" into a chief of staff that remembers and manages
// things for you: it can add to your task list and recall facts across sessions.
//
// Every tool is scoped to one userId and reads/writes only that user's rows
// (service key + explicit .eq('user_id', userId)), so it is safe multi-tenant.
//
// Gated by ADJUTANT_TOOLS (comma list). 'tasks' and 'memory' activate these;
// they stay OFF until their tables exist (db/migrations/002). 'web' is separate
// (Anthropic server tools, handled in sdk-engine.ts).
// ═══════════════════════════════════════════════════════════════════════════

import { getServerClient } from '@/lib/supabase';
import {
  getAccessToken, calendarList, calendarInsert,
  gmailListMessages, gmailGet, gmailSend, gmailDraft,
} from '@/lib/google';

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (userId: string, input: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const NOT_CONNECTED =
  'Google is not connected for this user. Tell them to connect Gmail + Calendar ' +
  'on the Settings page, then ask them to try again.';

// ── Tasks ────────────────────────────────────────────────────────────────────
const createTask: AgentTool = {
  name: 'create_task',
  description:
    "Add an item to the user's personal task list. Use whenever the user wants " +
    'to remember to do something, e.g. "remind me to", "add to my list", "I need to".',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The task, phrased as a short action.' },
      due: { type: 'string', description: 'Optional due date/time in the user\'s words (e.g. "tomorrow", "Friday").' },
    },
    required: ['title'],
  },
  async execute(userId, input) {
    const title = str(input.title);
    if (!title) return 'Error: a task title is required.';
    const { error } = await getServerClient()
      .from('user_tasks')
      .insert({ user_id: userId, title, status: 'open', due: str(input.due) || null });
    if (error) return `Error saving task: ${error.message}`;
    return `Added task: "${title}"${str(input.due) ? ` (due ${str(input.due)})` : ''}.`;
  },
};

const listTasks: AgentTool = {
  name: 'list_tasks',
  description: "List the user's tasks. Call this before answering any question about what they need to do, their to-dos, or their list.",
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Which tasks to return. Default open.' },
    },
  },
  async execute(userId, input) {
    const status = str(input.status) || 'open';
    let q = getServerClient().from('user_tasks').select('id,title,status,due,created_at').eq('user_id', userId);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q.order('created_at', { ascending: true }).limit(100);
    if (error) return `Error reading tasks: ${error.message}`;
    if (!data || data.length === 0) return status === 'open' ? 'No open tasks.' : 'No tasks found.';
    return data
      .map((t, i) => `${i + 1}. [${t.status}] ${t.title}${t.due ? ` (due ${t.due})` : ''}  <id:${t.id}>`)
      .join('\n');
  },
};

const completeTask: AgentTool = {
  name: 'complete_task',
  description: 'Mark a task done. Pass the task id from list_tasks. If unsure which task the user means, call list_tasks first and match by title.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The task id (from list_tasks, shown as <id:...>).' } },
    required: ['id'],
  },
  async execute(userId, input) {
    const id = str(input.id);
    if (!id) return 'Error: a task id is required.';
    const { data, error } = await getServerClient()
      .from('user_tasks')
      .update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('user_id', userId).eq('id', id).select('title').maybeSingle();
    if (error) return `Error updating task: ${error.message}`;
    if (!data) return 'No matching task found for that id.';
    return `Marked done: "${data.title}".`;
  },
};

// ── Memory ─────────────────────────────────────────────────────────────────
const saveMemory: AgentTool = {
  name: 'remember',
  description:
    'Save a durable fact about the user or their preferences so it persists across ' +
    'conversations. Use when the user shares something worth remembering ("I prefer", ' +
    '"my ... is", "remember that"). Do NOT use for one-off task reminders (use create_task).',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact to remember, in a self-contained sentence.' },
      tag: { type: 'string', description: 'Optional short category, e.g. "preference", "contact", "project".' },
    },
    required: ['content'],
  },
  async execute(userId, input) {
    const content = str(input.content);
    if (!content) return 'Error: nothing to remember.';
    const { error } = await getServerClient()
      .from('user_memory')
      .insert({ user_id: userId, content, tag: str(input.tag) || null });
    if (error) return `Error saving memory: ${error.message}`;
    return `Noted and saved: "${content}".`;
  },
};

const searchMemory: AgentTool = {
  name: 'recall',
  description:
    "Search the user's saved memories for relevant facts. Call this when the user " +
    'refers to something they told you before, asks what you know about them, or when ' +
    'a saved preference/fact would improve your answer.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Keywords to search saved memories for. Empty returns recent ones.' } },
  },
  async execute(userId, input) {
    const query = str(input.query);
    let q = getServerClient().from('user_memory').select('content,tag,created_at').eq('user_id', userId);
    if (query) q = q.ilike('content', `%${query}%`);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(25);
    if (error) return `Error reading memory: ${error.message}`;
    if (!data || data.length === 0) return query ? `No saved memories match "${query}".` : 'No saved memories yet.';
    return data.map((m) => `- ${m.content}${m.tag ? ` [${m.tag}]` : ''}`).join('\n');
  },
};

// ── Google: Calendar + Gmail (per-user connected account, see google.ts) ─────
const listCalendarEvents: AgentTool = {
  name: 'list_calendar_events',
  description:
    "List events from the user's Google Calendar. Call this to answer anything about " +
    'their schedule, availability, meetings, or what\'s coming up. Defaults to the next 7 days.',
  input_schema: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'ISO datetime lower bound. Default now.' },
      end: { type: 'string', description: 'ISO datetime upper bound. Default 7 days from now.' },
      query: { type: 'string', description: 'Optional free-text filter on event titles.' },
    },
  },
  async execute(userId, input) {
    const token = await getAccessToken(userId);
    if (!token) return NOT_CONNECTED;
    const now = new Date();
    const start = str(input.start) || now.toISOString();
    const end = str(input.end) || new Date(now.getTime() + 7 * 864e5).toISOString();
    try {
      const r = await calendarList(token, start, end, str(input.query) || undefined);
      const items = r.items || [];
      if (items.length === 0) return 'No events found in that window.';
      return items
        .map((e) => {
          const s = e.start?.dateTime || e.start?.date || '?';
          return `- ${e.summary || '(no title)'} — ${s}${e.location ? ` @ ${e.location}` : ''}`;
        })
        .join('\n');
    } catch (e) {
      return `Calendar error: ${String(e)}`;
    }
  },
};

const createCalendarEvent: AgentTool = {
  name: 'create_calendar_event',
  description: "Create an event on the user's Google Calendar. Confirm the details in your reply after it succeeds.",
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title.' },
      start: { type: 'string', description: 'ISO datetime start (with timezone offset).' },
      end: { type: 'string', description: 'ISO datetime end. If omitted, defaults to 1 hour after start.' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Optional attendee emails.' },
      description: { type: 'string', description: 'Optional event notes.' },
    },
    required: ['summary', 'start'],
  },
  async execute(userId, input) {
    const token = await getAccessToken(userId);
    if (!token) return NOT_CONNECTED;
    const summary = str(input.summary);
    const start = str(input.start);
    if (!summary || !start) return 'Error: summary and start are required.';
    const end = str(input.end) || new Date(new Date(start).getTime() + 36e5).toISOString();
    const attendees = Array.isArray(input.attendees) ? (input.attendees as unknown[]).map(str).filter(Boolean) : [];
    try {
      const ev = await calendarInsert(token, { summary, start, end, attendees, description: str(input.description) || undefined });
      return `Created "${summary}" (${start}).${ev.htmlLink ? ` Link: ${ev.htmlLink}` : ''}`;
    } catch (e) {
      return `Calendar error: ${String(e)}`;
    }
  },
};

const listRecentEmails: AgentTool = {
  name: 'list_recent_emails',
  description:
    "Search / list the user's Gmail. Use for 'my inbox', 'unread', 'emails from X', catching up. " +
    'Returns id, from, subject, snippet. Use read_email for the full body.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search (e.g. "is:unread", "from:sam newer_than:7d"). Default "in:inbox".' },
      max: { type: 'number', description: 'How many (1-15). Default 8.' },
    },
  },
  async execute(userId, input) {
    const token = await getAccessToken(userId);
    if (!token) return NOT_CONNECTED;
    const q = str(input.query) || 'in:inbox';
    const max = Math.min(Math.max(Number(input.max) || 8, 1), 15);
    try {
      const msgs = await gmailListMessages(token, q, max);
      if (msgs.length === 0) return `No emails match "${q}".`;
      return msgs.map((m) => `- <id:${m.id}> ${m.from} — ${m.subject || '(no subject)'}\n  ${m.snippet}`).join('\n');
    } catch (e) {
      return `Gmail error: ${String(e)}`;
    }
  },
};

const readEmail: AgentTool = {
  name: 'read_email',
  description: 'Read the full body of one Gmail message by its id (from list_recent_emails).',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The message id.' } },
    required: ['id'],
  },
  async execute(userId, input) {
    const token = await getAccessToken(userId);
    if (!token) return NOT_CONNECTED;
    const id = str(input.id);
    if (!id) return 'Error: a message id is required.';
    try {
      const m = await gmailGet(token, id);
      return `From: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`;
    } catch (e) {
      return `Gmail error: ${String(e)}`;
    }
  },
};

const draftEmail: AgentTool = {
  name: 'draft_email',
  description:
    'Create a Gmail DRAFT (not sent). Prefer this over send_email unless the user explicitly says to send. ' +
    'Tell the user the draft is saved for their review.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body.' },
    },
    required: ['to', 'subject', 'body'],
  },
  async execute(userId, input) {
    const token = await getAccessToken(userId);
    if (!token) return NOT_CONNECTED;
    const to = str(input.to), subject = str(input.subject), body = str(input.body);
    if (!to || !body) return 'Error: to and body are required.';
    try {
      await gmailDraft(token, to, subject, body);
      return `Draft saved to Gmail (to ${to}, subject "${subject}"). It is NOT sent; the user can review and send it.`;
    } catch (e) {
      return `Gmail error: ${String(e)}`;
    }
  },
};

const sendEmail: AgentTool = {
  name: 'send_email',
  description:
    'SEND an email from the user\'s Gmail. Only use when the user has clearly asked to send (not draft). ' +
    'Always show the user what you are about to send and prefer draft_email if there is any doubt.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body.' },
    },
    required: ['to', 'subject', 'body'],
  },
  async execute(userId, input) {
    const token = await getAccessToken(userId);
    if (!token) return NOT_CONNECTED;
    const to = str(input.to), subject = str(input.subject), body = str(input.body);
    if (!to || !body) return 'Error: to and body are required.';
    try {
      await gmailSend(token, to, subject, body);
      return `Sent to ${to} (subject "${subject}").`;
    } catch (e) {
      return `Gmail error: ${String(e)}`;
    }
  },
};

const ALL: Record<string, AgentTool[]> = {
  tasks: [createTask, listTasks, completeTask],
  memory: [saveMemory, searchMemory],
  google: [listCalendarEvents, createCalendarEvent, listRecentEmails, readEmail, draftEmail, sendEmail],
};

/**
 * The default ACTIVE toolset when ADJUTANT_TOOLS is unset. The core acting tools
 * (tasks + memory) ship ON out of the box so a fresh BYOK install can actually DO
 * things — the README's "create a task, then list tasks" first run works with zero
 * config. 'google' is intentionally NOT in the default: it needs a Google OAuth
 * client the self-hoster must supply. Single source of truth — both this module and
 * sdk-engine.ts read the enabled set via enabledToolset(), so the default can never
 * drift between the two again.
 */
export const DEFAULT_TOOLS = 'web,tasks,memory';

/** Parsed ADJUTANT_TOOLS list, falling back to DEFAULT_TOOLS. Shared by the engine. */
export function enabledToolset(): string[] {
  return (process.env.ADJUTANT_TOOLS ?? DEFAULT_TOOLS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The custom tools enabled by ADJUTANT_TOOLS (minus 'web', handled separately). */
export function enabledAgentTools(): AgentTool[] {
  const set = enabledToolset();
  const out: AgentTool[] = [];
  for (const key of Object.keys(ALL)) if (set.includes(key)) out.push(...ALL[key]);
  return out;
}

export function toolByName(name: string): AgentTool | undefined {
  for (const list of Object.values(ALL)) {
    const t = list.find((x) => x.name === name);
    if (t) return t;
  }
  return undefined;
}
