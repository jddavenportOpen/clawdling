// ═══════════════════════════════════════════════════════════════════════════
// [sid]/stream (GET, metadata-only) / [sid]/input (POST) / [sid]/resize
// (POST) / [sid] (DELETE) — against a MOCKED bridge.
//
// Pins:
//   - stream returns JSON METADATA {stream_url, session_id} — never a
//     text/event-stream body, never a proxied SSE connection. stream_url
//     points at the BRIDGE directly (not this Next route) and carries a
//     minted token.
//   - input accepts `text` (what the shipped UI actually sends —
//     SessionTerminal/CleanComposer/ChatGridPane/AskUserQuestionCard all
//     POST {text}) AND `data` (the contract's documented key), and always
//     forwards {data: <value>} to the bridge.
//   - resize / DELETE pass their contract shape through correctly and
//     preserve the bridge's status code.
//   - an unreachable bridge produces a clear, diagnosable error (never a
//     hang, never a bare 500) on every one of the mutating routes.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bridge-jwt', () => ({
  signBridgeJWT: async () => 'test.jwt.token',
}));

const mockAuth = vi.fn();
vi.mock('@/lib/auth-timeout', () => ({
  authWithTimeout: () => mockAuth(),
}));

import { GET as streamGET } from '../[sid]/stream/route';
import { POST as inputPOST } from '../[sid]/input/route';
import { POST as resizePOST } from '../[sid]/resize/route';
import { DELETE as sessionDELETE } from '../[sid]/route';

function jsonRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function bridgeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sidParams(sid: string): { params: Promise<{ sid: string }> } {
  return { params: Promise.resolve({ sid }) };
}

const AUTHED = { user: { id: 'user-1', email: 'jd@example.com' } };
const connRefusedErr = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
      code: 'ECONNREFUSED',
    }),
  });

beforeEach(() => {
  vi.restoreAllMocks();
  mockAuth.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/sessions/[sid]/stream — metadata only', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await streamGET(new Request('http://localhost/x'), sidParams('sid-1'));
    expect(res.status).toBe(401);
  });

  it('returns JSON metadata, never a proxied SSE stream', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await streamGET(new Request('http://localhost/x'), sidParams('sid-1'));

    expect(res.status).toBe(200);
    // The defining contract requirement: this route must NOT open/proxy an
    // SSE connection to the bridge itself (a Vercel function timeout would
    // sever it) — it only mints a token and builds a URL string.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('Content-Type')).not.toMatch(/text\/event-stream/);

    const data = await res.json();
    expect(data.session_id).toBe('sid-1');
    expect(typeof data.stream_url).toBe('string');
    // Points at the BRIDGE, not back at this Next.js route.
    expect(data.stream_url).toMatch(/^http:\/\/localhost:8787\/api\/sessions\/sid-1\/stream\?token=/);
  });

  it('400s on a missing sid', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const res = await streamGET(new Request('http://localhost/x'), sidParams(''));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sessions/[sid]/input', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await inputPOST(
      jsonRequest('http://localhost/x', { text: 'hi\r' }),
      sidParams('sid-1')
    );
    expect(res.status).toBe(401);
  });

  it('translates the shipped UI\'s {text} body into the bridge\'s {data} shape', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { ok: true }));
    const res = await inputPOST(
      jsonRequest('http://localhost/x', { text: 'hello\r' }),
      sidParams('sid-1')
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/sessions/sid-1/input');
    expect(JSON.parse(init.body as string)).toEqual({ data: 'hello\r' });
  });

  it('also accepts the contract\'s documented {data} key directly', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { ok: true }));
    await inputPOST(jsonRequest('http://localhost/x', { data: 'raw\r' }), sidParams('sid-1'));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ data: 'raw\r' });
  });

  it('400s when neither text nor data is present', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await inputPOST(jsonRequest('http://localhost/x', {}), sidParams('sid-1'));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unreachable bridge produces a clear 502, not a hang', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(connRefusedErr());
    const res = await inputPOST(
      jsonRequest('http://localhost/x', { text: 'hi\r' }),
      sidParams('sid-1')
    );
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/connection refused/i);
  });
});

describe('POST /api/sessions/[sid]/resize', () => {
  it('passes {cols, rows} through to the bridge and relays {ok:true}', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { ok: true }));
    const res = await resizePOST(
      jsonRequest('http://localhost/x', { cols: 120, rows: 40 }),
      sidParams('sid-1')
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/sessions/sid-1/resize');
    expect(JSON.parse(init.body as string)).toEqual({ cols: 120, rows: 40 });
  });

  it('400s on a non-numeric cols/rows instead of forwarding garbage to the bridge', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await resizePOST(
      jsonRequest('http://localhost/x', { cols: 'wide', rows: 40 }),
      sidParams('sid-1')
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unreachable bridge produces a clear 502, not a hang', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(connRefusedErr());
    const res = await resizePOST(
      jsonRequest('http://localhost/x', { cols: 120, rows: 40 }),
      sidParams('sid-1')
    );
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/connection refused/i);
  });
});

describe('DELETE /api/sessions/[sid]', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await sessionDELETE(new Request('http://localhost/x'), sidParams('sid-1'));
    expect(res.status).toBe(401);
  });

  it('calls bridge DELETE and relays {ok:true, exit_code}', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { ok: true, exit_code: 0 }));
    const res = await sessionDELETE(new Request('http://localhost/x'), sidParams('sid-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, exit_code: 0 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/sessions/sid-1');
    expect(init.method).toBe('DELETE');
  });

  it('preserves a bridge 404 (already-gone sid) instead of flattening to 500', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(404, { error: 'no such session' })
    );
    const res = await sessionDELETE(new Request('http://localhost/x'), sidParams('sid-1'));
    expect(res.status).toBe(404);
  });

  it('an unreachable bridge produces a clear 502, not a hang', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(connRefusedErr());
    const res = await sessionDELETE(new Request('http://localhost/x'), sidParams('sid-1'));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/connection refused/i);
  });
});
