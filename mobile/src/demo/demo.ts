// Demo mode: a complete, local stand-in for a Clawdling server, so anyone (App Review included)
// can try every screen without installing anything. Nothing leaves the phone. Replies are canned
// and say so.

import { ApiError } from '../api';
import type {
  Agent,
  AgentKind,
  ChatMessage,
  ClawdlingClient,
  CreateSessionInput,
  DonnaMessage,
  DonnaReply,
  Health,
  Me,
  MessagesPage,
  OrgView,
  Session,
  SessionStatus,
  ToolCall,
} from '../types';
import sample from './sample.json';

export interface SampleMessage {
  role: 'user' | 'assistant';
  minutesAgo: number;
  text: string;
  tools?: ToolCall[];
}

export interface SampleSession {
  sid: string;
  agent: string;
  title: string;
  status: SessionStatus;
  model: string | null;
  startedMinutesAgo: number;
  activeMinutesAgo: number;
  endedMinutesAgo?: number;
  notification?: string;
  lastMessage?: string;
  messages: SampleMessage[];
}

export interface SampleData {
  org: { name: string; owner: string; chief: string };
  agents: { id: string; kind: AgentKind; name: string; mission: string; icon: string | null; color: string | null; domain: string | null }[];
  sessions: SampleSession[];
  donna: { role: 'user' | 'donna'; channel: string; minutesAgo: number; text: string }[];
}

export const SAMPLE = sample as SampleData;

const MIN = 60_000;

function iso(now: number, minutesAgo: number): string {
  return new Date(now - minutesAgo * MIN).toISOString();
}

/** A short title from a first message, the way the server derives one: first sentence, 48 chars. */
export function deriveTitle(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(.*?[.!?])(?:\s|$)/.exec(flat);
  const first = (m ? m[1] : flat).replace(/[.!?]+$/, '').trim();
  if (!first) return '';
  const cut = first.length > 48 ? `${first.slice(0, 47).replace(/\s+\S*$/, '').trimEnd()}…` : first;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

export interface DemoState {
  org: OrgView['org'];
  agents: Omit<Agent, 'live' | 'needs_you' | 'last_activity_at'>[];
  sessions: Session[];
  messages: Record<string, ChatMessage[]>;
  donna: DonnaMessage[];
}

/** Turn the bundled sample into concrete data with timestamps relative to `now`. */
export function materialize(now: number, data: SampleData = SAMPLE): DemoState {
  const names = new Map(data.agents.map((a) => [a.id, a.name]));
  const kinds = new Map(data.agents.map((a) => [a.id, a.kind]));
  const sessions: Session[] = [];
  const messages: Record<string, ChatMessage[]> = {};
  for (const s of data.sessions) {
    sessions.push({
      sid: s.sid,
      agent: s.agent,
      agent_name: names.get(s.agent) ?? s.agent,
      kind: kinds.get(s.agent) ?? 'domain',
      title: s.title,
      status: s.status,
      model: s.model,
      created_at: iso(now, s.startedMinutesAgo),
      last_activity_at: iso(now, s.activeMinutesAgo),
      ended_at: s.endedMinutesAgo === undefined ? null : iso(now, s.endedMinutesAgo),
      notification: s.notification ?? null,
      resumable: s.status === 'ended',
      last_message: s.lastMessage ?? null,
    });
    messages[s.sid] = s.messages.map((m, i) => ({
      n: i + 1,
      role: m.role,
      text: m.text,
      tools: m.tools ?? [],
      ts: iso(now, m.minutesAgo),
    }));
  }
  return {
    org: { ...data.org },
    agents: data.agents.map((a) => ({ ...a })),
    sessions,
    messages,
    donna: data.donna.map((d) => ({ role: d.role, text: d.text, channel: d.channel, ts: iso(now, d.minutesAgo) })),
  };
}

export interface DemoOptions {
  now?: () => number;
  /** How long a fake reply takes. */
  replyDelayMs?: number;
  donnaDelayMs?: number;
  schedule?: (fn: () => void, ms: number) => void;
}

function uuid(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

function quote(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export class DemoClient implements ClawdlingClient {
  readonly mode = 'demo' as const;
  readonly baseUrl = 'demo';
  readonly state: DemoState;
  private readonly now: () => number;
  private readonly replyDelayMs: number;
  private readonly donnaDelayMs: number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(opts: DemoOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.replyDelayMs = opts.replyDelayMs ?? 1600;
    this.donnaDelayMs = opts.donnaDelayMs ?? 2200;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.state = materialize(this.now());
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private find(sid: string): Session {
    const s = this.state.sessions.find((x) => x.sid === sid);
    if (!s) throw new ApiError('not_found', 'No such session.', { status: 404 });
    return s;
  }

  private push(sid: string, role: 'user' | 'assistant', text: string, tools: ToolCall[] = []): ChatMessage {
    const list = (this.state.messages[sid] ||= []);
    const m: ChatMessage = { n: (list[list.length - 1]?.n ?? 0) + 1, role, text, tools, ts: this.stamp() };
    list.push(m);
    return m;
  }

  private replyLater(s: Session, text: string) {
    s.status = 'working';
    s.notification = null;
    s.last_activity_at = this.stamp();
    this.schedule(() => {
      const reply =
        `On it. This is the demo, so nothing actually ran. With your own Clawdling server, ${s.agent_name} would work on ` +
        `"${quote(text)}" in a real session on your computer, and its replies would show up right here.`;
      this.push(s.sid, 'assistant', reply, [{ name: 'Read', summary: 'Read memory/NOW.md' }]);
      s.status = 'ready';
      s.last_message = reply.slice(0, 280);
      s.last_activity_at = this.stamp();
    }, this.replyDelayMs);
  }

  async health(): Promise<Health> {
    return { ok: true, version: 'demo' };
  }

  async me(): Promise<Me> {
    return { ok: true, version: 'demo' };
  }

  async org(): Promise<OrgView> {
    const agents: Agent[] = this.state.agents.map((a) => {
      const mine = this.state.sessions.filter((s) => s.agent === a.id);
      const last = mine.map((s) => s.last_activity_at || '').sort().pop() || null;
      return {
        ...a,
        live: mine.filter((s) => s.status !== 'ended').length,
        needs_you: mine.filter((s) => s.status === 'needs_you' || s.status === 'ready').length,
        last_activity_at: last,
      };
    });
    return { org: { ...this.state.org }, agents };
  }

  async sessions(): Promise<Session[]> {
    return this.state.sessions.map((s) => ({ ...s }));
  }

  async session(sid: string): Promise<Session> {
    return { ...this.find(sid) };
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const agent = this.state.agents.find((a) => a.id === input.agent);
    if (!agent) throw new ApiError('not_found', 'No such agent.', { status: 404 });
    const prompt = (input.prompt ?? '').trim();
    const s: Session = {
      sid: uuid(),
      agent: agent.id,
      agent_name: agent.name,
      kind: agent.kind,
      title: input.title?.trim() || (prompt ? deriveTitle(prompt) : null),
      status: prompt ? 'working' : 'ready',
      model: input.model ?? null,
      created_at: this.stamp(),
      last_activity_at: this.stamp(),
      ended_at: null,
      notification: null,
      resumable: false,
      last_message: null,
    };
    this.state.sessions.unshift(s);
    this.state.messages[s.sid] = [];
    if (prompt) {
      this.push(s.sid, 'user', prompt);
      this.replyLater(s, prompt);
    }
    return { ...s };
  }

  async send(sid: string, text: string): Promise<void> {
    const s = this.find(sid);
    if (s.status === 'ended') throw new ApiError('conflict', 'That session has ended; resume it first.', { status: 409 });
    this.push(sid, 'user', text);
    if (!s.title) s.title = deriveTitle(text) || null;
    this.replyLater(s, text);
  }

  async resume(sid: string): Promise<Session> {
    const s = this.find(sid);
    if (s.status === 'ended') {
      s.status = 'ready';
      s.ended_at = null;
      s.resumable = false;
      s.last_activity_at = this.stamp();
    }
    return { ...s };
  }

  async rename(sid: string, title: string): Promise<Session> {
    const s = this.find(sid);
    s.title = title.trim() || null;
    return { ...s };
  }

  async messages(sid: string, opts: { after?: number | null; limit?: number } = {}): Promise<MessagesPage> {
    const s = this.find(sid);
    const all = this.state.messages[sid] ?? [];
    const limit = opts.limit ?? 200;
    const list = opts.after == null ? all.slice(-limit) : all.filter((m) => m.n > (opts.after as number)).slice(0, limit);
    const next = list.length ? list[list.length - 1].n : opts.after ?? (all[all.length - 1]?.n ?? 0);
    return { messages: list.map((m) => ({ ...m, tools: [...m.tools] })), next, status: s.status };
  }

  async donnaMessages(limit = 50): Promise<DonnaMessage[]> {
    return this.state.donna.slice(-limit).map((m) => ({ ...m }));
  }

  async donnaChat(text: string): Promise<DonnaReply> {
    this.state.donna.push({ role: 'user', text, channel: 'app', ts: this.stamp() });
    await new Promise<void>((resolve) => this.schedule(resolve, this.donnaDelayMs));
    const reply = await this.route(text);
    this.state.donna.push({ role: 'donna', text: reply, channel: 'app', ts: this.stamp() });
    return { reply };
  }

  private async route(text: string): Promise<string> {
    const lower = text.toLowerCase();
    const target = this.state.agents.find(
      (a) => a.kind !== 'chief' && (lower.includes(a.id.replace(/-/g, ' ')) || lower.includes(a.name.toLowerCase())),
    );
    if (target) {
      const s = await this.createSession({ agent: target.id, prompt: text });
      return `${target.name} is on it: "${s.title}". It's under Live on Home if you want to watch.`;
    }
    if (/waiting|status|what'?s up|anything|needs? me/.test(lower)) {
      const waiting = this.state.sessions.filter((s) => s.status === 'needs_you' || s.status === 'ready');
      if (!waiting.length) return 'Nothing is waiting on you right now.';
      const parts = waiting.slice(0, 3).map((s) => `${s.agent_name}: ${s.title ?? 'new session'}`);
      return `${waiting.length} ${waiting.length === 1 ? 'thing is' : 'things are'} waiting on you. ${parts.join('. ')}.`;
    }
    return "Noted. This is the demo, so I can't start real work. With your own server connected, I'd hand this to the right agent and tell you who's on it.";
  }
}

/** The names a person would see for every demo agent, for tests and screenshots. */
export function demoAgentNames(): string[] {
  return SAMPLE.agents.map((a) => a.name);
}
