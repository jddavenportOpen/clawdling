// ═══════════════════════════════════════════════════════════════════════════
// bridge-resilient.test.ts — bridgeGetResilient retry/timeout/degrade logic.
//
// Root cause it guards (audit 2026-06-01 §7b): the prod BRIDGE_URL is an
// ephemeral cloudflared quick-tunnel whose QUIC edge connection drops on idle
// every ~25m and takes 2–8s to re-register. Requests landing in that window
// get a Cloudflare 530 (or a hung connect → timeout → throw). Before this fix
// the route had no timeout/retry, so a single blip churned the fleet/backlog
// rail. These tests pin: (1) a transient 530 is retried then succeeds,
// (2) a network throw is retried, (3) a persistent 530 returns the last resp
// (caller degrades), (4) a 2xx returns immediately (no wasted retries),
// (5) a real 4xx is NOT retried.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// server-only is a no-op marker in tests.
vi.mock('server-only', () => ({}));
// Deterministic JWT — we only care about the fetch behavior here.
vi.mock('@/lib/bridge-jwt', () => ({
  signBridgeJWT: async () => 'test.jwt.token',
}));

import {
  bridgeGetResilient,
  isTransientGatewayStatus,
} from '@/lib/bridge-client';

function resp(status: number, body = '{}'): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('isTransientGatewayStatus', () => {
  it('flags 502/503/504 and the 520–530 Cloudflare family', () => {
    for (const s of [502, 503, 504, 520, 521, 522, 530]) {
      expect(isTransientGatewayStatus(s)).toBe(true);
    }
  });
  it('does NOT flag 2xx / real 4xx / 531', () => {
    for (const s of [200, 204, 400, 401, 404, 429, 531]) {
      expect(isTransientGatewayStatus(s)).toBe(false);
    }
  });
});

describe('bridgeGetResilient', () => {
  it('returns a 2xx on the first try without retrying', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(resp(200, '{"sessions":[]}'));
    const r = await bridgeGetResilient('/api/fleet/sessions', 'u1', 'jd@x.com', {
      retries: 2,
      backoffMs: 1,
    });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 530 then succeeds (absorbs the tunnel blip)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(resp(530))
      .mockResolvedValueOnce(resp(200, '{"sessions":[]}'));
    const r = await bridgeGetResilient('/api/backlog', 'u1', 'jd@x.com', {
      retries: 2,
      backoffMs: 1,
    });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network throw then succeeds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(resp(200));
    const r = await bridgeGetResilient('/api/backlog', 'u1', 'jd@x.com', {
      retries: 2,
      backoffMs: 1,
    });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('after exhausting retries on persistent 530, returns the last response (caller degrades)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(530));
    const r = await bridgeGetResilient('/api/fleet/sessions', 'u1', 'jd@x.com', {
      retries: 2,
      backoffMs: 1,
    });
    expect(r.status).toBe(530); // route turns this into a soft-degrade 200
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('throws only when EVERY attempt threw at the network layer', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('tunnel down'));
    await expect(
      bridgeGetResilient('/api/backlog', 'u1', 'jd@x.com', {
        retries: 2,
        backoffMs: 1,
      })
    ).rejects.toThrow('tunnel down');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a real 4xx (e.g. 401) — fails fast', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(401));
    const r = await bridgeGetResilient('/api/backlog', 'u1', 'jd@x.com', {
      retries: 2,
      backoffMs: 1,
    });
    expect(r.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
