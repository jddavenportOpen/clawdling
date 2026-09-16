// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sessions/[sid]/history — against a MOCKED bridge.
//
// Pins the four things SessionTerminal actually depends on (verified by
// reading src/components/chat/SessionTerminal.tsx, seedHistoryTail +
// catchupHistory):
//
//   - the body is RAW TEXT, not JSON. The component writes it straight into
//     xterm; a JSON envelope would be painted into the terminal.
//   - X-Session-Log-Total-Bytes is forwarded VERBATIM. It is the byte cursor
//     the component stores and sends back as ?start=; recomputing it here
//     from the response text would drift on multi-byte characters.
//   - ?bytes= and ?start= reach the bridge.
//   - a 404 stays a 404. The component reads that as "no prior history, this
//     pane is fresh" and still opens the live stream, so flattening it to a
//     500 would turn a normal first-run into an error state.
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

import { GET as historyGET } from '../[sid]/history/route';

function sidParams(sid: string): { params: Promise<{ sid: string }> } {
  return { params: Promise.resolve({ sid }) };
}

function textResp(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });
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

describe('GET /api/sessions/[sid]/history', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history'),
      sidParams('sid-1')
    );
    expect(res.status).toBe(401);
  });

  it('returns the transcript as RAW TEXT, never a JSON envelope', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    // A real transcript slice: ANSI in, ANSI out, byte for byte.
    const slice = '[2mprior output[0m\r\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      textResp(200, slice, { 'X-Session-Log-Total-Bytes': '4096' })
    );

    const res = await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history?bytes=51200'),
      sidParams('sid-1')
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    expect(await res.text()).toBe(slice);
  });

  it('forwards the byte cursor header verbatim', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      textResp(200, 'abc', {
        'X-Session-Log-Total-Bytes': '123456',
        'X-Session-Log-Start-Byte': '100',
        'X-Session-Log-Gap': 'true',
      })
    );
    const res = await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history'),
      sidParams('sid-1')
    );
    expect(res.headers.get('X-Session-Log-Total-Bytes')).toBe('123456');
    expect(res.headers.get('X-Session-Log-Start-Byte')).toBe('100');
    expect(res.headers.get('X-Session-Log-Gap')).toBe('true');
  });

  it('passes ?bytes= and ?start= through to the bridge', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(textResp(200, ''));
    await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history?bytes=524288&start=900'),
      sidParams('sid-1')
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:8787/api/sessions/sid-1/history?bytes=524288&start=900'
    );
  });

  it('drops a malformed cursor instead of relaying it', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(textResp(200, ''));
    await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history?bytes=abc&start=-5'),
      sidParams('sid-1')
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/sessions/sid-1/history');
  });

  it('keeps a 404 a 404 — that is "fresh pane", not a failure', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'unknown session sid-1' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history'),
      sidParams('sid-1')
    );
    expect(res.status).toBe(404);
  });

  it('an empty catchup response is a 200 with an empty body', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      textResp(200, '', { 'X-Session-Log-Total-Bytes': '900' })
    );
    const res = await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history?start=900'),
      sidParams('sid-1')
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('X-Session-Log-Total-Bytes')).toBe('900');
  });

  it('400s on a missing sid without calling the bridge', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await historyGET(
      new Request('http://localhost/api/sessions//history'),
      sidParams('')
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unreachable bridge produces a clear 502, not a hang', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(connRefusedErr());
    const res = await historyGET(
      new Request('http://localhost/api/sessions/sid-1/history'),
      sidParams('sid-1')
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/connection refused/i);
  });
});
