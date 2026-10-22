import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApiError,
  HttpClient,
  backoffMs,
  checkConnection,
  errorForStatus,
  normalizeMessagesPage,
  normalizeOrg,
  normalizeSession,
  toApiError,
} from '../../src/api';

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const TOKEN = 'a3f9c2d17b8e4f60a3f9c2d17b8e4f60a3f9c2d17b8e4f60a3f9c2d17b8e4f60';
const SESSION = {
  sid: '5f0c2a8e-4b1d-4c3e-9a77-1d2e3f4a5b01',
  agent: 'health',
  agent_name: 'Health',
  kind: 'domain',
  title: 'Plan the week',
  status: 'ready',
  model: null,
  created_at: '2026-10-22T10:00:00.000Z',
  last_activity_at: '2026-10-22T10:05:00.000Z',
  ended_at: null,
  notification: null,
  resumable: false,
};

function client(handler: Parameters<typeof fakeFetch>[0], extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const f = fakeFetch(handler);
  const c = new HttpClient({ baseUrl: 'http://10.0.0.5:4747/', token: TOKEN, fetchImpl: f.fn, ...extra });
  return { c, calls: f.calls };
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

describe('HttpClient requests', () => {
  it('sends the token header (and no cookie) on every authenticated request', async () => {
    const { c, calls } = client(() => json(200, [SESSION]));
    const list = await c.sessions();
    assert.equal(list.length, 1);
    assert.equal(calls[0].url, 'http://10.0.0.5:4747/api/sessions');
    assert.equal(header(calls[0].init, 'x-clawdling-token'), TOKEN);
    assert.equal(header(calls[0].init, 'Cookie'), undefined);
    assert.equal(calls[0].init.credentials, undefined);
  });

  it('does not send the token to the public health check', async () => {
    const { c, calls } = client(() => json(200, { ok: true, version: '1.0.0' }));
    const h = await c.health();
    assert.deepEqual(h, { ok: true, version: '1.0.0' });
    assert.equal(header(calls[0].init, 'x-clawdling-token'), undefined);
  });

  it('posts JSON with a content type to send, and treats 204 as success', async () => {
    const { c, calls } = client(() => new Response(null, { status: 204 }));
    await c.send(SESSION.sid, 'hello there');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].url, `http://10.0.0.5:4747/api/sessions/${SESSION.sid}/send`);
    assert.equal(header(calls[0].init, 'Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { text: 'hello there', enter: true });
  });

  it('builds the messages query (after + limit) and normalizes the page', async () => {
    const { c, calls } = client(() =>
      json(200, {
        messages: [
          { n: 3, role: 'assistant', text: 'Done', tools: [{ name: 'Bash', summary: 'npm test' }, 'Read'], ts: '2026-10-22T10:00:00Z' },
          { n: 'x', role: 'assistant', text: 'bad n' },
          { n: 4, role: 'system', text: 'unknown role' },
        ],
        next: 3,
        status: 'ready',
      }),
    );
    const page = await c.messages(SESSION.sid, { after: 2, limit: 50 });
    assert.equal(calls[0].url, `http://10.0.0.5:4747/api/sessions/${SESSION.sid}/messages?after=2&limit=50`);
    assert.equal(page.messages.length, 1);
    assert.deepEqual(page.messages[0].tools, [
      { name: 'Bash', summary: 'npm test' },
      { name: 'Read', summary: '' },
    ]);
    assert.equal(page.next, 3);
    assert.equal(page.status, 'ready');
  });

  it('omits after on the first page', async () => {
    const { c, calls } = client(() => json(200, { messages: [], next: null }));
    await c.messages(SESSION.sid, { after: null });
    assert.equal(calls[0].url, `http://10.0.0.5:4747/api/sessions/${SESSION.sid}/messages?limit=200`);
  });

  it('creates sessions with only the fields given', async () => {
    const { c, calls } = client(() => json(201, { ...SESSION, status: 'starting' }));
    const s = await c.createSession({ agent: 'health', prompt: 'Plan my week' });
    assert.equal(s.status, 'starting');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { agent: 'health', prompt: 'Plan my week' });
  });

  it('talks to Donna', async () => {
    const { c, calls } = client((url) =>
      url.includes('/api/donna/chat')
        ? json(200, { reply: 'Health is on it.' })
        : json(200, { messages: [{ role: 'user', text: 'hi', ts: 't', channel: 'telegram' }, { role: 'donna', text: 'hello', ts: 't' }, { role: 'x', text: 'dropped' }] }),
    );
    const list = await c.donnaMessages(50);
    assert.equal(calls[0].url, 'http://10.0.0.5:4747/api/donna/messages?limit=50');
    assert.deepEqual(list.map((m) => m.role), ['user', 'donna']);
    assert.equal(list[0].channel, 'telegram');
    const r = await c.donnaChat('plan my week');
    assert.equal(r.reply, 'Health is on it.');
  });

  it('url-encodes session ids', async () => {
    const { c, calls } = client(() => json(200, SESSION));
    await c.session('../../etc');
    assert.equal(calls[0].url, 'http://10.0.0.5:4747/api/sessions/..%2F..%2Fetc');
  });
});

describe('HttpClient errors', () => {
  it('401 becomes an auth error and notifies once per call', async () => {
    let notified = 0;
    const { c } = client(() => json(401, { error: 'missing or wrong token' }), { onAuthError: () => notified++ });
    await assert.rejects(c.sessions(), (e: ApiError) => e.kind === 'auth' && e.status === 401 && /fresh code/.test(e.message));
    assert.equal(notified, 1);
  });

  it('a thrown fetch is a retryable network error', async () => {
    const { c } = client(() => {
      throw new TypeError('Network request failed');
    });
    await assert.rejects(c.org(), (e: ApiError) => e.kind === 'network' && e.retryable && e.serverMessage === 'Network request failed');
  });

  it('a slow server is a timeout', async () => {
    const { c } = client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { timeouts: { default: 30 } },
    );
    await assert.rejects(c.sessions(), (e: ApiError) => e.kind === 'timeout' && e.retryable);
  });

  it('an unknown route means the server is older than the app', async () => {
    const { c } = client(() => json(404, { error: 'no such API route' }));
    await assert.rejects(c.messages(SESSION.sid), (e: ApiError) => e.kind === 'unsupported');
  });

  it('a missing session is not_found, a 409 keeps the server message', async () => {
    const a = client(() => json(404, { error: 'no such session' }));
    await assert.rejects(a.c.send(SESSION.sid, 'x'), (e: ApiError) => e.kind === 'not_found' && e.message === 'No such session.');
    const b = client(() => json(409, { error: 'that session has ended; resume it first' }));
    await assert.rejects(b.c.send(SESSION.sid, 'x'), (e: ApiError) => e.kind === 'conflict' && e.message === 'That session has ended; resume it first.');
  });

  it('5xx is a retryable server error; HTML is not a Clawdling server', async () => {
    const a = client(() => json(500, { error: 'internal error' }));
    await assert.rejects(a.c.org(), (e: ApiError) => e.kind === 'server' && e.retryable && e.message === 'Clawdling hit an error on your computer.');
    const b = client(() => new Response('<html>router login</html>', { status: 200 }));
    await assert.rejects(b.c.health(), (e: ApiError) => e.kind === 'bad_response' && !e.retryable);
  });

  it('falls back to the session list when GET /api/sessions/:sid does not exist', async () => {
    const { c } = client((url) => (url.endsWith('/api/sessions') ? json(200, [SESSION]) : json(404, { error: 'no such API route' })));
    const s = await c.session(SESSION.sid);
    assert.equal(s.title, 'Plan the week');
  });

  it('errorForStatus maps 403 and 405', () => {
    assert.equal(errorForStatus(403, { error: 'unexpected Host header' }).kind, 'forbidden');
    assert.equal(errorForStatus(405, { error: 'method not allowed' }).kind, 'unsupported');
    assert.equal(errorForStatus(413, null).kind, 'bad_request');
  });

  it('toApiError wraps anything; backoff doubles and caps', () => {
    assert.equal(toApiError(new Error('boom')).kind, 'bad_response');
    assert.equal(toApiError('weird').message, 'Something went wrong.');
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => backoffMs(n)), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe('checkConnection', () => {
  it('passes when health and /api/me answer', async () => {
    const f = fakeFetch((url) => (url.endsWith('/api/health') ? json(200, { ok: true, version: '1.0.0' }) : json(200, { ok: true, version: '1.0.0' })));
    const r = await checkConnection('http://10.0.0.5:4747', TOKEN, f.fn);
    assert.deepEqual(r, { ok: true, version: '1.0.0' });
    assert.equal(f.calls.length, 2);
  });

  it('reports which step failed', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const a = await checkConnection('http://10.0.0.5:4747', TOKEN, down.fn);
    assert.equal(a.step, 'health');
    assert.equal(a.error?.kind, 'network');
    const wrong = fakeFetch((url) => (url.endsWith('/api/health') ? json(200, { ok: true }) : json(401, { error: 'missing or wrong token' })));
    const b = await checkConnection('http://10.0.0.5:4747', TOKEN, wrong.fn);
    assert.equal(b.step, 'me');
    assert.equal(b.error?.kind, 'auth');
  });
});

describe('normalizers', () => {
  it('fills sensible defaults for a sparse session', () => {
    const s = normalizeSession({ sid: 'abc', agent: 'money', status: 'weird' });
    assert.ok(s);
    assert.equal(s?.agent_name, 'Money');
    assert.equal(s?.status, 'working');
    assert.equal(s?.title, null);
    assert.equal(normalizeSession({ agent: 'x' }), null);
    assert.equal(normalizeSession(null), null);
  });

  it('derives an org name and drops agents without ids', () => {
    const o = normalizeOrg({ org: { owner: 'Sam' }, agents: [{ id: 'work', kind: 'domain', name: 'Work', live: '2' }, { name: 'no id' }] });
    assert.equal(o.org.name, "Sam's org");
    assert.equal(o.agents.length, 1);
    assert.equal(o.agents[0].live, 2);
  });

  it('refuses a page without a messages array', () => {
    assert.throws(() => normalizeMessagesPage({ items: [] }), (e: ApiError) => e.kind === 'bad_response');
  });
});
