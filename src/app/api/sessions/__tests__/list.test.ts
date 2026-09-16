// ═══════════════════════════════════════════════════════════════════════════
// list / recent-cwds / history — against a MOCKED bridge.
//
// Pins:
//   - list: 401 unauthenticated; per-session id/thread_id/live aliases are
//     added (ChatGrid.fetchSessionMeta and its enrichment poll both key off
//     `.id`, not the contract's `.session_id` — verified by reading both
//     call sites); a bridge failure is a clear error, not a hang.
//   - recent-cwds / history: honest stub shape per BRIDGE-CONTRACT.md
//     ("may be a stub" — there's no bridge endpoint for either), still
//     auth-gated like every other route in the family.
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

import { GET as listGET } from '../list/route';
import { GET as recentCwdsGET } from '../recent-cwds/route';
import { GET as historyGET } from '../history/route';

function bridgeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const AUTHED = { user: { id: 'user-1', email: 'jd@example.com' } };

beforeEach(() => {
  vi.restoreAllMocks();
  mockAuth.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/sessions/list', () => {
  it('401s without a bridge call when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await listGET();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the bridge GET /api/sessions and adds id/thread_id/live aliases per row', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(200, {
        sessions: [
          { session_id: 'sid-a', name: 'a', cwd: '/x', domain: null, model: 'claude', status: 'running', created_at: 't' },
          { session_id: 'sid-b', name: 'b', cwd: '/y', domain: null, model: 'claude', status: 'exited', created_at: 't' },
        ],
      })
    );
    const res = await listGET();
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/sessions');
    expect(init.method).toBe('GET');

    const data = await res.json();
    expect(data.sessions).toHaveLength(2);
    const [a, b] = data.sessions;
    expect(a.id).toBe('sid-a');
    expect(a.thread_id).toBe('sid-a');
    expect(a.live).toBe(true); // status: 'running' -> live
    expect(b.id).toBe('sid-b');
    expect(b.live).toBe(false); // status: 'exited' -> not live
    // Contract fields untouched.
    expect(a.cwd).toBe('/x');
    expect(a.status).toBe('running');
  });

  it('an unreachable bridge produces a clear diagnosable error, not a hang or opaque 500', async () => {
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

  it('degrades to an empty sessions array if the bridge body is not valid JSON', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 200 })
    );
    const res = await listGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toEqual([]);
  });
});

describe('GET /api/sessions/recent-cwds', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await recentCwdsGET();
    expect(res.status).toBe(401);
  });

  it('returns the documented stub shape { cwds: [] }', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await recentCwdsGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cwds: [] });
    // Documented as a Next-local stub — never touches the bridge.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/history', () => {
  it('401s when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await historyGET();
    expect(res.status).toBe(401);
  });

  it('returns the documented stub shape { sessions: [] }', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await historyGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
