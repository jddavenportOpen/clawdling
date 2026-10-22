// Typed client for a Clawdling server. Every request carries the `x-clawdling-token` header (no
// cookies). Failures become an ApiError with a `kind` the UI can act on: `auth` sends the user
// back to Connect, `network`/`timeout` show the retry banner, `unsupported` means the server is
// older than the app. Responses are normalized so odd or partial server data never crashes a screen.

import {
  SESSION_STATUSES,
  type Agent,
  type AgentKind,
  type ChatMessage,
  type ClawdlingClient,
  type CreateSessionInput,
  type DonnaMessage,
  type DonnaReply,
  type Health,
  type Me,
  type MessagesPage,
  type OrgView,
  type Session,
  type SessionStatus,
  type ToolCall,
} from './types';

export type ApiErrorKind =
  | 'auth' // 401: the token is wrong or was rotated
  | 'forbidden' // 403: Host/Origin guard refused us
  | 'network' // could not reach the server at all
  | 'timeout' // reached it, but no answer in time
  | 'unsupported' // the route does not exist on this server version
  | 'not_found' // e.g. the session is gone
  | 'conflict' // 409: e.g. the session ended, or Claude Code is waiting in the terminal
  | 'bad_request' // 4xx we caused
  | 'server' // 5xx
  | 'bad_response'; // not JSON, or not a Clawdling server

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** The server's own `{error}` text, when it sent one. */
  readonly serverMessage: string | null;

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number | null; serverMessage?: string | null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.serverMessage = opts.serverMessage ?? null;
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Any thrown value as an ApiError (unknown errors count as a bad response, never a crash). */
export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  return new ApiError('bad_response', e instanceof Error && e.message ? e.message : 'Something went wrong.');
}

/** Retry delay after `failures` consecutive network failures: 2 s, 4 s, 8 s ... capped at 30 s. */
export function backoffMs(failures: number, base = 2000, max = 30_000): number {
  return Math.min(max, base * 2 ** Math.max(0, failures - 1));
}

export const TIMEOUTS = {
  default: 12_000,
  send: 25_000, // the server waits up to 15 s for a just-started session to be ready
  spawn: 35_000,
  donna: 200_000, // a Donna turn may take a minute or more; the server gives up at 180 s
};

const UNKNOWN_ROUTE = /no such api route/i;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  /** Called once per 401 so the app can drop the connection and return to Connect. */
  onAuthError?: (err: ApiError) => void;
  timeouts?: Partial<typeof TIMEOUTS>;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
  timeoutMs?: number;
  auth?: boolean;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeStatus(v: unknown): SessionStatus {
  return (SESSION_STATUSES as readonly string[]).includes(v as string) ? (v as SessionStatus) : 'working';
}

export function normalizeSession(raw: unknown): Session | null {
  if (!isObject(raw) || typeof raw.sid !== 'string' || !raw.sid) return null;
  const agent = str(raw.agent, 'scratch');
  const status = normalizeStatus(raw.status);
  return {
    sid: raw.sid,
    agent,
    agent_name: str(raw.agent_name) || agent.charAt(0).toUpperCase() + agent.slice(1),
    kind: str(raw.kind, 'domain'),
    title: strOrNull(typeof raw.title === 'string' ? raw.title.trim() : null),
    status,
    model: strOrNull(raw.model),
    created_at: strOrNull(raw.created_at),
    last_activity_at: strOrNull(raw.last_activity_at),
    ended_at: strOrNull(raw.ended_at),
    notification: strOrNull(raw.notification),
    resumable: typeof raw.resumable === 'boolean' ? raw.resumable : status === 'ended',
    last_message: strOrNull(raw.last_message),
    waiting_on: status === 'needs_you' ? strOrNull(raw.waiting_on) : null,
    reports_waiting: 'waiting_on' in raw,
  };
}

const AGENT_KINDS: AgentKind[] = ['chief', 'domain', 'project', 'scratch'];

export function normalizeAgent(raw: unknown): Agent | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const kind = (AGENT_KINDS as string[]).includes(raw.kind as string) ? (raw.kind as AgentKind) : 'domain';
  return {
    id: raw.id,
    kind,
    name: str(raw.name) || raw.id,
    mission: str(raw.mission),
    icon: strOrNull(raw.icon),
    color: strOrNull(raw.color),
    domain: strOrNull(raw.domain),
    live: Math.max(0, num(raw.live)),
    needs_you: Math.max(0, num(raw.needs_you)),
    last_activity_at: strOrNull(raw.last_activity_at),
  };
}

export function normalizeOrg(raw: unknown): OrgView {
  if (!isObject(raw)) throw new ApiError('bad_response', 'The server sent an unexpected answer for the org.');
  const org = isObject(raw.org) ? raw.org : {};
  const agents = Array.isArray(raw.agents) ? raw.agents.map(normalizeAgent).filter((a): a is Agent => !!a) : [];
  const owner = str(org.owner);
  return {
    org: { name: str(org.name) || (owner ? `${owner}'s org` : 'Your org'), owner, chief: str(org.chief, 'donna') || 'donna' },
    agents,
  };
}

function normalizeTool(raw: unknown): ToolCall | null {
  if (typeof raw === 'string') return raw ? { name: raw, summary: '' } : null;
  if (!isObject(raw)) return null;
  const name = str(raw.name);
  const summary = str(raw.summary);
  return name || summary ? { name, summary } : null;
}

export function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!isObject(raw)) return null;
  const n = num(raw.n, NaN);
  if (!Number.isFinite(n)) return null;
  const role = raw.role === 'user' ? 'user' : raw.role === 'assistant' ? 'assistant' : null;
  if (!role) return null;
  const tools = Array.isArray(raw.tools) ? raw.tools.map(normalizeTool).filter((t): t is ToolCall => !!t) : [];
  return { n, role, text: str(raw.text), tools, ts: strOrNull(raw.ts) };
}

export function normalizeMessagesPage(raw: unknown): MessagesPage {
  if (!isObject(raw) || !Array.isArray(raw.messages)) {
    throw new ApiError('bad_response', 'The server sent an unexpected answer for this chat.');
  }
  const messages = raw.messages.map(normalizeMessage).filter((m): m is ChatMessage => !!m);
  const next = raw.next == null ? null : num(raw.next, NaN);
  return {
    messages,
    next: next === null || !Number.isFinite(next) ? null : next,
    status: raw.status == null ? null : normalizeStatus(raw.status),
    more: typeof raw.more === 'boolean' ? raw.more : null,
  };
}

export function normalizeDonnaMessage(raw: unknown): DonnaMessage | null {
  if (!isObject(raw)) return null;
  const role = raw.role === 'user' ? 'user' : raw.role === 'donna' || raw.role === 'assistant' ? 'donna' : null;
  if (!role) return null;
  const text = str(raw.text);
  if (!text) return null;
  return { role, text, ts: strOrNull(raw.ts), channel: strOrNull(raw.channel), ...(raw.error === true ? { error: true } : {}) };
}

function errorText(body: unknown): string | null {
  if (isObject(body) && typeof body.error === 'string' && body.error) return body.error;
  return null;
}

/** Turn a non-2xx response into an ApiError. Exported for tests. */
export function errorForStatus(status: number, body: unknown): ApiError {
  const msg = errorText(body);
  const opts = { status, serverMessage: msg };
  if (status === 401) {
    return new ApiError('auth', 'Your computer did not accept this phone. Scan a fresh code from the cockpit.', opts);
  }
  if (status === 403) return new ApiError('forbidden', `Your computer refused the request${msg ? `: ${msg}` : '.'}`, opts);
  if (status === 404) {
    if (msg && UNKNOWN_ROUTE.test(msg)) {
      return new ApiError('unsupported', 'Your Clawdling server is older than this app. Update Clawdling on your computer.', opts);
    }
    return new ApiError('not_found', msg ? capitalize(msg) : 'Not found.', opts);
  }
  if (status === 405) {
    return new ApiError('unsupported', 'Your Clawdling server is older than this app. Update Clawdling on your computer.', opts);
  }
  if (status === 409) return new ApiError('conflict', msg ? capitalize(msg) : 'That is not possible right now.', opts);
  if (status >= 500) return new ApiError('server', msg && msg !== 'internal error' ? capitalize(msg) : 'Clawdling hit an error on your computer.', opts);
  return new ApiError('bad_request', msg ? capitalize(msg) : `The request failed (HTTP ${status}).`, opts);
}

function capitalize(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const out = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function sidPath(sid: string): string {
  return encodeURIComponent(sid);
}

export class HttpClient implements ClawdlingClient {
  readonly mode = 'live' as const;
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly onAuthError?: (err: ApiError) => void;
  private readonly timeouts: typeof TIMEOUTS;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onAuthError = opts.onAuthError;
    this.timeouts = { ...TIMEOUTS, ...(opts.timeouts ?? {}) };
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.auth !== false) headers['x-clawdling-token'] = this.token;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs ?? this.timeouts.default);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      if (timedOut) throw new ApiError('timeout', 'Your computer took too long to answer.');
      throw new ApiError('network', "Can't reach your computer.", { serverMessage: e instanceof Error ? e.message : null });
    }

    let text = '';
    try {
      text = await res.text();
    } catch {
      clearTimeout(timer);
      if (timedOut) throw new ApiError('timeout', 'Your computer took too long to answer.');
      throw new ApiError('network', 'The connection dropped before the answer arrived.');
    }
    clearTimeout(timer);

    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const err = errorForStatus(res.status, json);
      if (err.kind === 'auth') this.onAuthError?.(err);
      throw err;
    }
    if (res.status === 204 || !text) return undefined as T;
    if (json === undefined) throw new ApiError('bad_response', "That address answered, but it isn't a Clawdling server.");
    return json as T;
  }

  async health(): Promise<Health> {
    const raw = await this.request('GET', '/api/health', { auth: false });
    if (!isObject(raw) || (raw.ok !== true && typeof raw.version !== 'string')) {
      throw new ApiError('bad_response', "That address answered, but it isn't a Clawdling server.");
    }
    return { ok: raw.ok === true, version: strOrNull(raw.version) };
  }

  async me(): Promise<Me> {
    const raw = await this.request('GET', '/api/me');
    if (!isObject(raw)) throw new ApiError('bad_response', "That address answered, but it isn't a Clawdling server.");
    return { ok: raw.ok !== false, version: strOrNull(raw.version) };
  }

  async org(): Promise<OrgView> {
    return normalizeOrg(await this.request('GET', '/api/org'));
  }

  async sessions(): Promise<Session[]> {
    const raw = await this.request('GET', '/api/sessions');
    if (!Array.isArray(raw)) throw new ApiError('bad_response', 'The server sent an unexpected answer for sessions.');
    return raw.map(normalizeSession).filter((s): s is Session => !!s);
  }

  async session(sid: string): Promise<Session> {
    try {
      const s = normalizeSession(await this.request('GET', `/api/sessions/${sidPath(sid)}`));
      if (!s) throw new ApiError('bad_response', 'The server sent an unexpected answer for this session.');
      return s;
    } catch (e) {
      // Older servers have no single-session route: fall back to the list.
      if (isApiError(e) && e.kind === 'unsupported') {
        const found = (await this.sessions()).find((s) => s.sid === sid);
        if (found) return found;
        throw new ApiError('not_found', 'That session is no longer on your computer.', { status: 404 });
      }
      throw e;
    }
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const body: Record<string, string> = { agent: input.agent };
    if (input.prompt) body.prompt = input.prompt;
    if (input.model) body.model = input.model;
    if (input.title) body.title = input.title;
    const s = normalizeSession(await this.request('POST', '/api/sessions', { body, timeoutMs: this.timeouts.spawn }));
    if (!s) throw new ApiError('bad_response', 'The server did not return the new session.');
    return s;
  }

  async send(sid: string, text: string): Promise<void> {
    await this.request('POST', `/api/sessions/${sidPath(sid)}/send`, { body: { text, enter: true }, timeoutMs: this.timeouts.send });
  }

  async resume(sid: string): Promise<Session> {
    const s = normalizeSession(await this.request('POST', `/api/sessions/${sidPath(sid)}/resume`, { body: {}, timeoutMs: this.timeouts.spawn }));
    if (!s) throw new ApiError('bad_response', 'The server did not return the resumed session.');
    return s;
  }

  async rename(sid: string, title: string): Promise<Session> {
    const s = normalizeSession(await this.request('PATCH', `/api/sessions/${sidPath(sid)}`, { body: { title } }));
    if (!s) throw new ApiError('bad_response', 'The server did not return the session.');
    return s;
  }

  async messages(sid: string, opts: { after?: number | null; limit?: number } = {}): Promise<MessagesPage> {
    const raw = await this.request('GET', `/api/sessions/${sidPath(sid)}/messages`, {
      query: { after: opts.after ?? undefined, limit: opts.limit ?? 200 },
    });
    return normalizeMessagesPage(raw);
  }

  async donnaMessages(limit = 50): Promise<DonnaMessage[]> {
    const raw = await this.request('GET', '/api/donna/messages', { query: { limit } });
    const list = isObject(raw) && Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw) ? raw : null;
    if (!list) throw new ApiError('bad_response', "The server sent an unexpected answer for Donna's messages.");
    return list.map(normalizeDonnaMessage).filter((m): m is DonnaMessage => !!m);
  }

  async donnaChat(text: string): Promise<DonnaReply> {
    const raw = await this.request('POST', '/api/donna/chat', { body: { text }, timeoutMs: this.timeouts.donna });
    if (!isObject(raw) || typeof raw.reply !== 'string') throw new ApiError('bad_response', "Donna's answer did not come through.");
    return { reply: raw.reply };
  }
}

export interface ConnectionCheck {
  ok: boolean;
  version: string | null;
  error?: ApiError;
  /** Which request failed: the public health check, or the authenticated /api/me. */
  step?: 'health' | 'me';
}

/**
 * The Connect flow: GET /api/health (public, proves it is a Clawdling server we can reach), then
 * GET /api/me with the token (proves the pairing code is right). Never throws.
 */
export async function checkConnection(url: string, token: string, fetchImpl?: FetchLike): Promise<ConnectionCheck> {
  const client = new HttpClient({ baseUrl: url, token, fetchImpl, timeouts: { default: 8000 } });
  try {
    await client.health();
  } catch (e) {
    return { ok: false, version: null, step: 'health', error: isApiError(e) ? e : new ApiError('network', "Can't reach your computer.") };
  }
  try {
    const me = await client.me();
    return { ok: true, version: me.version };
  } catch (e) {
    return { ok: false, version: null, step: 'me', error: isApiError(e) ? e : new ApiError('network', "Can't reach your computer.") };
  }
}
