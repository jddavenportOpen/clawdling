// ═══════════════════════════════════════════════════════════════════════════
// spawn / cockpit-spawn / spawn-domain — proxy to bridge POST
// /api/sessions/spawn, against a MOCKED bridge (no real Python process).
//
// Pins:
//   - unauthenticated -> 401, bridge never called
//   - success -> the bridge's response is re-emitted WITH the additive
//     thread_id/id/live compat aliases NewSessionPicker hard-requires
//     (see _lib.ts withCompatAliases + the build report)
//   - cockpit-spawn / spawn-domain narrow the forwarded body to exactly
//     what BRIDGE-CONTRACT.md documents for each — legacy/extra fields the
//     shipped UI sends (thread_id, project_slug, persistent) are dropped,
//     never forwarded to the bridge
//   - spawn-domain 400s locally (no bridge call) when domain is missing
//   - a bridge connection failure produces a clear, diagnosable 502 —
//     never a generic/opaque error, never a hang
//   - the bridge's own status code is preserved on a non-ok response
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

import { POST as spawnPOST } from '../spawn/route';
import { POST as cockpitSpawnPOST } from '../cockpit-spawn/route';
import { POST as spawnDomainPOST } from '../spawn-domain/route';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/sessions/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

describe('POST /api/sessions/cockpit-spawn', () => {
  it('401s without a bridge call when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await cockpitSpawnPOST(jsonRequest({ cwd: '.' }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds thread_id/id/live compat aliases on success and preserves the 201', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(201, {
        session_id: 'sid-123',
        name: 'ad-hoc',
        cwd: '/workspaces/foo',
        domain: null,
        model: 'claude',
        status: 'starting',
        created_at: '2026-09-16T00:00:00Z',
      })
    );
    const res = await cockpitSpawnPOST(jsonRequest({ cwd: '/workspaces/foo' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    // Contract fields pass through unmodified.
    expect(data.session_id).toBe('sid-123');
    expect(data.cwd).toBe('/workspaces/foo');
    // Additive aliases NewSessionPicker.spawnCockpit hard-requires
    // (`!data.thread_id` is treated as a failed spawn otherwise).
    expect(data.thread_id).toBe('sid-123');
    expect(data.id).toBe('sid-123');
    expect(data.live).toBe(true); // status !== 'exited'
  });

  it('forwards only cwd + initial_prompt, dropping anything else the browser sent', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(201, { session_id: 'sid-1', status: 'starting' }));
    await cockpitSpawnPOST(
      jsonRequest({
        cwd: '/workspaces/foo',
        initial_prompt: 'hello',
        thread_id: 'legacy-thread-should-not-forward',
        project_slug: 'legacy-project-should-not-forward',
        persistent: true,
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/sessions/spawn');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ cwd: '/workspaces/foo', initial_prompt: 'hello' });
  });

  it('a bridge connection failure produces a clear 502, not a hang or a generic 500', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const connRefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
      code: 'ECONNREFUSED',
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', { cause: connRefused })
    );
    const res = await cockpitSpawnPOST(jsonRequest({ cwd: '.' }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/bridge/i);
    expect(data.error).toMatch(/connection refused/i);
    expect(data.error).toMatch(/running/i); // "Is the Python bridge running?"
  });

  it('preserves the bridge status code on a non-ok response instead of flattening to 500', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(400, { error: 'cwd escapes CLAWDLING_WORKSPACE_ROOT' })
    );
    const res = await cockpitSpawnPOST(jsonRequest({ cwd: '/etc' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/cwd escapes CLAWDLING_WORKSPACE_ROOT/);
  });
});

describe('POST /api/sessions/spawn-domain', () => {
  it('400s locally (no bridge call) when domain is missing', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await spawnDomainPOST(jsonRequest({ initial_prompt: 'hi' }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards {domain, initial_prompt} and drops `persistent` (v1 has no such bridge concept)', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(201, { session_id: 'sid-health', status: 'starting' }));
    await spawnDomainPOST(jsonRequest({ domain: 'health', persistent: true }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ domain: 'health' });
  });

  it('response carries thread_id aliased to session_id', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      bridgeResp(201, { session_id: 'sid-health', domain: 'health', status: 'starting' })
    );
    const res = await spawnDomainPOST(jsonRequest({ domain: 'health' }));
    const data = await res.json();
    expect(data.thread_id).toBe('sid-health');
  });
});

describe('POST /api/sessions/spawn (generic)', () => {
  it('whitelists the contract fields and drops everything else', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(201, { session_id: 'sid-1', status: 'starting' }));
    await spawnPOST(
      jsonRequest({
        cwd: '/workspaces/foo',
        thread_id: 'legacy-thread-id',
        project_slug: 'legacy-slug',
        cols: 120,
        rows: 40,
        bogus: 'field',
      })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ cwd: '/workspaces/foo', cols: 120, rows: 40 });
  });

  it('an empty body is valid (every field is optional per contract)', async () => {
    mockAuth.mockResolvedValue(AUTHED);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(bridgeResp(201, { session_id: 'sid-1', status: 'starting' }));
    const res = await spawnPOST(
      new Request('http://localhost/api/sessions/spawn', { method: 'POST' })
    );
    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});
