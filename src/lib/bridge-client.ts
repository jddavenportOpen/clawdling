// ═══════════════════════════════════════════════════════════════════════════
// chat-interface-v2 — Bridge HTTP client (server-only)
//
// Thin wrapper around `fetch` for talking to the Mac Mini FastAPI bridge.
// Auto-mints a fresh HS256 JWT per call (15-minute TTL) via `bridge-jwt.ts`.
//
// Env vars (read at runtime):
//   BRIDGE_URL     — base URL of the bridge, e.g.:
//                      http://localhost:8787         (dev)
//                      https://app.example.com (prod)
//                    Defaults to http://localhost:8787.
//   BRIDGE_SECRET  — shared HMAC secret with the bridge (HS256). Required.
//
// Bridge endpoints used:
//   POST   /api/sessions/spawn
//   GET    /api/sessions/{sid}/stream   (SSE — browser connects directly)
//   POST   /api/sessions/{sid}/input
//   DELETE /api/sessions/{sid}
//
// The SSE route is intentionally NOT proxied through Next.js — Vercel Hobby
// imposes a 10-second function timeout, which would sever every stream. The
// browser opens EventSource straight at the bridge using a JWT minted by our
// /api/sessions/[sid]/stream metadata endpoint.
// ═══════════════════════════════════════════════════════════════════════════
import 'server-only';

import { signBridgeJWT } from '@/lib/bridge-jwt';

export const BRIDGE_URL: string = (
  process.env.BRIDGE_URL || 'http://localhost:8787'
).replace(/\/$/, '');

/**
 * Fetch a bridge endpoint with an auto-minted JWT.
 * Caller owns body encoding and response parsing.
 * Throws on network failure; non-2xx is returned as-is for the caller to handle.
 */
export async function bridgeFetch(
  path: string,
  init: RequestInit,
  userId: string,
  email: string
): Promise<Response> {
  if (!path.startsWith('/')) {
    throw new Error(`[bridge-client] path must be absolute, got: ${path}`);
  }

  const token = await signBridgeJWT(userId, email);

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  // Default Content-Type to JSON ONLY when the body is a plain string (i.e.
  // a JSON.stringify result). For FormData/Blob/ReadableStream/etc the
  // runtime sets the correct Content-Type itself — including the multipart
  // boundary FormData needs. Forcing application/json on a FormData body
  // strips the boundary and the receiver sees zero form fields (this was
  // the bug behind "no files provided; saw form keys: []").
  if (
    init.body &&
    typeof init.body === 'string' &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }

  return await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers,
    // Never cache bridge calls; every one is authenticated + session-bound
    cache: 'no-store',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Resilient GET — absorbs the cloudflared quick-tunnel reconnect blip.
//
// The prod BRIDGE_URL is an ephemeral `*.trycloudflare.com` quick-tunnel. Its
// QUIC connection to the Cloudflare edge drops on idle (~every 25m,
// "timeout: no recent network activity" in tunnel.log) and takes 2–8s to
// re-register. Any request that lands in that window gets a Cloudflare **530**
// ("origin unreachable"); a hung connect can also stall until the Vercel
// function timeout → the route throws → **502**. Either way the fleet/backlog
// rail churned (caught: ~/clawd/audits/2026-06-01-cockpit-chat-functional.md §7b).
//
// The true fix is the named-tunnel migration (chat-bridge-named-tunnel.sh),
// which is JD-blocked on a domain. Until then we make the CLIENT resilient:
// a bounded timeout + a couple of short retries lets a single 2–8s reconnect
// blip resolve transparently instead of surfacing to the rail.
//
// ONLY use this for idempotent GETs (fleet/sessions, backlog). Never retry a
// spawn/input/delete — those aren't safe to replay.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A response status that means "tunnel/edge momentarily unhealthy" → retry,
 * and (in the route layer) soft-degrade rather than surface to the client.
 * 502 bad gateway, 503 unavailable, 504 gateway timeout — and Cloudflare's
 * 52x/53x family (520–530), where 530 = origin unreachable (tunnel down).
 */
export function isTransientGatewayStatus(status: number): boolean {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 530)
  );
}

export interface ResilientGetOptions {
  /** Per-attempt timeout. Kept under Vercel's 10s function ceiling. */
  timeoutMs?: number;
  /** Extra attempts after the first (so 2 = up to 3 total tries). */
  retries?: number;
  /** Base backoff between attempts (grows linearly). */
  backoffMs?: number;
}

/**
 * GET a bridge endpoint with a bounded per-attempt timeout and short retries
 * on network failure OR a transient (5xx / 52x-53x) status. Returns the LAST
 * response (even if still transient) so the caller can soft-degrade. Throws
 * only if every attempt threw at the network layer (no Response to return).
 */
export async function bridgeGetResilient(
  path: string,
  userId: string,
  email: string,
  opts: ResilientGetOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 350;

  let lastResp: Response | null = null;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await bridgeFetch(
        path,
        { method: 'GET', signal: ctrl.signal },
        userId,
        email
      );
      lastResp = resp;
      if (!isTransientGatewayStatus(resp.status)) {
        clearTimeout(timer);
        return resp; // healthy (2xx) or a real client error (4xx) — don't retry
      }
      // Transient status: fall through to retry (unless out of attempts).
    } catch (err) {
      lastErr = err; // network failure or abort/timeout — retry
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }

  if (lastResp) return lastResp; // last transient response — caller degrades
  throw lastErr ?? new Error('[bridge-client] resilient GET failed');
}

/** Build the SSE URL the browser should open (direct to bridge, not proxied). */
export function bridgeStreamUrl(sessionId: string, token: string): string {
  const sid = encodeURIComponent(sessionId);
  const t = encodeURIComponent(token);
  return `${BRIDGE_URL}/api/sessions/${sid}/stream?token=${t}`;
}
