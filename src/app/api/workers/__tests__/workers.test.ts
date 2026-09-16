// ═══════════════════════════════════════════════════════════════════════════
// /api/workers/* — against a MOCKED bridge.
//
// Pins, in the order they matter:
//   - every verb is auth-gated and does NOT touch the bridge when it isn't;
//   - BRIDGE_SECRET never leaves the server (the token is minted in
//     bridge-jwt, which is mocked here — these routes must never read the
//     secret themselves);
//   - a missing objective is caught HERE with a readable message instead of
//     being relayed as an opaque bridge 422;
//   - the whitelist forwards exactly the bridge's documented fields;
//   - an unreachable bridge is a diagnosable 502, not a hang or an opaque 500;
//   - a reap refusal is surfaced to the caller, never swallowed.
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

import { GET as listGET, POST as dispatchPOST } from '../route';
import { GET as runGET, DELETE as runDELETE } from '../[runId]/route';
import { GET as logGET } from '../[runId]/log/route';
import { pickWorkerFields, bridgeWorkerPath } from '../_lib';

function bridgeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const AUTHED = { user: { id: 'user-1', email: 'operator@example.com' } };

const RUN = {
  run_id: 'run-aaa',
  name: 'notes-run-aaa',
  objective: 'tidy the notes directory',
  status: 'running',
  exit_code: null,
  cwd: '/w/notes',
  isolation: 'worktree',
  isolated: true,
  branch: 'clawdling/worker-run-aaa',
  elapsed_sec: 4.2,
};

function params(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockAuth.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── _lib ───────────────────────────────────────────────────────────────────

describe('pickWorkerFields', () => {
  it('keeps exactly the bridge-documented fields and drops everything else', () => {
    const picked = pickWorkerFields({
      objective: 'do the thing',
      cwd: '/w/notes',
      domain: 'work',
      agent: 'tasks',
      model: 'claude-test-model',
      name: 'nightly',
      max_runtime_sec: 900.7,
      permission_mode: 'acceptEdits',
      thread_id: 'not-a-worker-field',
      persistent: true,
    });
    expect(picked).toEqual({
      objective: 'do the thing',
      cwd: '/w/notes',
      domain: 'work',
      agent: 'tasks',
      model: 'claude-test-model',
      name: 'nightly',
      max_runtime_sec: 900,
      permission_mode: 'acceptEdits',
    });
  });

  it('drops a blank objective and a non-finite runtime', () => {
    expect(pickWorkerFields({ objective: '   ' })).toEqual({});
    expect(pickWorkerFields({ objective: 'x', max_runtime_sec: NaN })).toEqual({
      objective: 'x',
    });
  });

  it('returns an empty object for a non-object body', () => {
    expect(pickWorkerFields(null)).toEqual({});
    expect(pickWorkerFields('nope')).toEqual({});
  });
});

describe('bridgeWorkerPath', () => {
  it('encodes the run id instead of trusting it', () => {
    expect(bridgeWorkerPath('a b/c')).toBe('/api/workers/a%20b%2Fc');
    expect(bridgeWorkerPath('run-1', '/log?tail=5')).toBe('/api/workers/run-1/log?tail=5');
  });
});

// ── GET /api/workers ───────────────────────────────────────────────────────

describe('GET /api/workers', () => {
  it('401s without a bridge call when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await listGET();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relays the bridge list plus the cap', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { workers: [RUN], running: 1, max_workers: 4 }));
    const res = await listGET();
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/workers');
    expect(init.method).toBe('GET');

    const data = await res.json();
    expect(data.workers).toHaveLength(1);
    expect(data.workers[0].run_id).toBe('run-aaa');
    expect(data.running).toBe(1);
    expect(data.max_workers).toBe(4);
  });

  it('degrades to an empty list when the bridge body is not JSON', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    const res = await listGET();
    expect(res.status).toBe(200);
    expect((await res.json()).workers).toEqual([]);
  });

  it('an unreachable bridge is a diagnosable 502, not an opaque 500', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const connRefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
      code: 'ECONNREFUSED',
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', { cause: connRefused })
    );
    const res = await listGET();
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/connection refused/i);
    expect(data.error).not.toBe('Internal Server Error');
  });
});

// ── POST /api/workers ──────────────────────────────────────────────────────

function dispatchRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/workers', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/workers', () => {
  it('401s without a bridge call when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await dispatchPOST(dispatchRequest({ objective: 'x' }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s a missing objective locally, with a readable message', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await dispatchPOST(dispatchRequest({ cwd: '/w/notes' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/objective is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the whitelisted body and returns the bridge record with its 201', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(bridgeResp(201, RUN));
    const res = await dispatchPOST(
      dispatchRequest({
        objective: 'tidy the notes directory',
        domain: 'work',
        thread_id: 'ignored',
      })
    );
    expect(res.status).toBe(201);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/workers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      objective: 'tidy the notes directory',
      domain: 'work',
    });
    // The bearer is minted in bridge-jwt (mocked); the route never sees a secret.
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test.jwt.token');

    expect((await res.json()).run_id).toBe('run-aaa');
  });

  it('preserves a bridge 429 (the worker cap) instead of flattening it to 500', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(429, { detail: 'worker limit reached (4 running).' })
    );
    const res = await dispatchPOST(dispatchRequest({ objective: 'one too many' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/worker limit reached/);
  });

  it('preserves a bridge 400 (a cwd outside the workspace)', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(400, { detail: 'cwd /etc is outside the allowed workspace roots' })
    );
    const res = await dispatchPOST(
      dispatchRequest({ objective: 'read the secrets', cwd: '/etc' })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside the allowed workspace roots/);
  });
});

// ── GET/DELETE /api/workers/[runId] ────────────────────────────────────────

describe('GET /api/workers/[runId]', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await runGET(new Request('http://x/'), params('run-aaa'));
    expect(res.status).toBe(401);
  });

  it('fetches the single run record', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(bridgeResp(200, RUN));
    const res = await runGET(new Request('http://x/'), params('run-aaa'));
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'http://localhost:8787/api/workers/run-aaa'
    );
    expect((await res.json()).branch).toBe('clawdling/worker-run-aaa');
  });

  it('relays a 404 for an unknown run rather than inventing an empty record', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(404, { detail: 'unknown worker run run-zzz' })
    );
    const res = await runGET(new Request('http://x/'), params('run-zzz'));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/workers/[runId]', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await runDELETE(
      new Request('http://x/', { method: 'DELETE' }),
      params('run-aaa')
    );
    expect(res.status).toBe(401);
  });

  it('kills without reaping by default', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { ok: true, status: 'killed', reaped: false }));
    const res = await runDELETE(
      new Request('http://localhost:3000/api/workers/run-aaa', { method: 'DELETE' }),
      params('run-aaa')
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/workers/run-aaa');
    expect(init.method).toBe('DELETE');
    expect((await res.json()).status).toBe('killed');
  });

  it('forwards ?reap=true and surfaces a refusal instead of swallowing it', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(200, {
        ok: true,
        status: 'done',
        reaped: false,
        reap_refused: 'the worktree holds 2 commit(s) reachable from no other ref',
      })
    );
    const res = await runDELETE(
      new Request('http://localhost:3000/api/workers/run-aaa?reap=true', { method: 'DELETE' }),
      params('run-aaa')
    );
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'http://localhost:8787/api/workers/run-aaa?reap=true'
    );
    const data = await res.json();
    expect(data.reaped).toBe(false);
    expect(data.reap_refused).toMatch(/reachable from no other ref/);
  });
});

// ── GET /api/workers/[runId]/log ───────────────────────────────────────────

describe('GET /api/workers/[runId]/log', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await logGET(new Request('http://x/'), params('run-aaa'));
    expect(res.status).toBe(401);
  });

  it('defaults to the events stream with a bounded tail', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { lines: ['{}'], stream: 'events' }));
    const res = await logGET(
      new Request('http://localhost:3000/api/workers/run-aaa/log'),
      params('run-aaa')
    );
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'http://localhost:8787/api/workers/run-aaa/log?stream=events&tail=200'
    );
  });

  it('passes stderr through and clamps an oversized tail', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(200, { lines: [], stream: 'stderr' }));
    await logGET(
      new Request('http://localhost:3000/api/workers/run-aaa/log?stream=stderr&tail=999999'),
      params('run-aaa')
    );
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'http://localhost:8787/api/workers/run-aaa/log?stream=stderr&tail=2000'
    );
  });

  it('400s an unknown stream without calling the bridge', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await logGET(
      new Request('http://localhost:3000/api/workers/run-aaa/log?stream=etc-passwd'),
      params('run-aaa')
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
