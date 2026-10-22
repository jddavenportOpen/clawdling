// Shapes of the Clawdling server API the app talks to (docs/SPEC.md section 4 plus the mobile
// additions). Every response is normalized in api.ts before the UI sees it, so a server that
// adds fields or omits optional ones never crashes a screen.

export type SessionStatus = 'starting' | 'working' | 'ready' | 'needs_you' | 'ended';

export const SESSION_STATUSES: readonly SessionStatus[] = ['starting', 'working', 'ready', 'needs_you', 'ended'];

export type AgentKind = 'chief' | 'domain' | 'project' | 'scratch';

export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  mission: string;
  icon: string | null;
  color: string | null;
  domain: string | null;
  live: number;
  needs_you: number;
  last_activity_at: string | null;
}

export interface Org {
  name: string;
  owner: string;
  chief: string;
}

export interface OrgView {
  org: Org;
  agents: Agent[];
}

export interface Session {
  sid: string;
  agent: string;
  agent_name: string;
  kind: string;
  title: string | null;
  status: SessionStatus;
  model: string | null;
  created_at: string | null;
  last_activity_at: string | null;
  ended_at: string | null;
  /** Why the session is waiting on you (permission prompt text, question, idle notice). */
  notification: string | null;
  resumable: boolean;
  /** First ~280 chars of Claude's last reply (from the Stop hook), when the server provides it. */
  last_message: string | null;
}

export interface Health {
  ok: boolean;
  version: string | null;
}

export interface Me {
  ok: boolean;
  version: string | null;
}

export interface ToolCall {
  name: string;
  summary: string;
}

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  /** Server sequence number: strictly increasing within a session. */
  n: number;
  role: MessageRole;
  text: string;
  tools: ToolCall[];
  ts: string | null;
}

export interface MessagesPage {
  messages: ChatMessage[];
  /** Cursor to pass as `after` on the next request. */
  next: number | null;
  status: SessionStatus | null;
}

export type DonnaRole = 'user' | 'donna';

export interface DonnaMessage {
  role: DonnaRole;
  text: string;
  ts: string | null;
  /** Where the message came from: "app", "telegram", "imessage", ... */
  channel: string | null;
}

export interface DonnaReply {
  reply: string;
}

export interface CreateSessionInput {
  agent: string;
  prompt?: string;
  model?: string;
  title?: string;
}

/** Everything a screen needs. Implemented by the HTTP client and by the local demo. */
export interface ClawdlingClient {
  readonly mode: 'live' | 'demo';
  /** Base URL of the server ("demo" in demo mode). */
  readonly baseUrl: string;
  health(): Promise<Health>;
  me(): Promise<Me>;
  org(): Promise<OrgView>;
  sessions(): Promise<Session[]>;
  session(sid: string): Promise<Session>;
  createSession(input: CreateSessionInput): Promise<Session>;
  send(sid: string, text: string): Promise<void>;
  resume(sid: string): Promise<Session>;
  rename(sid: string, title: string): Promise<Session>;
  messages(sid: string, opts?: { after?: number | null; limit?: number }): Promise<MessagesPage>;
  donnaMessages(limit?: number): Promise<DonnaMessage[]>;
  donnaChat(text: string): Promise<DonnaReply>;
}
