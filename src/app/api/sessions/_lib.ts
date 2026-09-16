// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers for the /api/sessions/* route family — thin proxies from
// the Clawdling cockpit UI to the local Python bridge (see
// BRIDGE-CONTRACT.md at the repo root for the pinned wire contract).
//
// NOT a route — Next.js only treats a file literally named `route.ts` as a
// route handler, so this file (any other name, in the same directory tree)
// is invisible to the router. Safe to import from any `route.ts` under
// src/app/api/sessions/**.
//
// Every route in this family:
//   1. Requires a NextAuth session via authWithTimeout — same pattern as
//      every existing /api/threads/* and /api/chat/* route in this repo.
//   2. Forwards to the bridge via bridge-client's bridgeFetch (never a
//      second fetch wrapper — BRIDGE_SECRET is minted into a JWT there and
//      never touches this file directly).
//   3. Surfaces "the bridge is unreachable" as an obviously-diagnosable
//      error instead of an opaque 500 — see describeBridgeFetchError.
//   4. Preserves the bridge's own status code where sensible instead of
//      flattening every failure to 500 — see relayBridgeError.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { authWithTimeout as auth } from '@/lib/auth-timeout';
import { BRIDGE_URL } from '@/lib/bridge-client';

// ── Auth ─────────────────────────────────────────────────────────────────

export interface SessionAuth {
  userId: string;
  email: string;
}

/**
 * Resolve the caller's NextAuth session into the (userId, email) pair
 * bridgeFetch needs to mint a bridge JWT. Mirrors the
 * `(session?.user as {id?})?.id` cast every existing /api/threads and
 * /api/chat route uses — `id` isn't on next-auth's default Session.user
 * type, `email` is.
 */
export async function requireSessionAuth(): Promise<SessionAuth | null> {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const email = session?.user?.email;
  if (!userId || !email) return null;
  return { userId, email };
}

export function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

// ── Bridge-unreachable diagnosis ────────────────────────────────────────
//
// The most common failure mode for this whole route family, by far, is
// "forgot to start the Python bridge." Node's fetch (undici) surfaces that
// as `TypeError: fetch failed` with `.cause.code === 'ECONNREFUSED'` — if we
// just String(err) that into a 500, a stranger who hasn't started the
// bridge gets an opaque crash instead of the one-line fix. Detect the
// common causes explicitly.

function errnoCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = err.cause;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function describeBridgeFetchError(err: unknown): string {
  const code = errnoCode(err);
  if (code === 'ECONNREFUSED') {
    return (
      `Could not reach the Clawdling bridge at ${BRIDGE_URL} (connection refused). ` +
      `Is the Python bridge running? Start it, then retry.`
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Could not resolve the bridge host for ${BRIDGE_URL}. Check the BRIDGE_URL env var.`;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return `Timed out waiting for the Clawdling bridge at ${BRIDGE_URL}.`;
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
    return `The Clawdling bridge at ${BRIDGE_URL} is unreachable (${code}). Is it running and reachable?`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Failed to reach the Clawdling bridge at ${BRIDGE_URL}: ${msg}`;
}

/** Standard response for a THROWN bridgeFetch call (network layer never
 *  produced a Response at all) — 502 (Next acting as gateway to an
 *  unreachable upstream), with the diagnosable message above. */
export function bridgeUnreachable(err: unknown): Response {
  return Response.json({ error: describeBridgeFetchError(err) }, { status: 502 });
}

/**
 * Relay a non-ok bridge Response to the caller. Preserves the bridge's own
 * status code (400/404/409/...) instead of flattening everything to 500 —
 * only a bridge response OUTSIDE the valid HTTP status range falls back to
 * 502. Caps the echoed body so a bridge stack trace can't blow up the
 * payload, and unwraps the common `{error}` / FastAPI `{detail}` shapes
 * instead of dumping raw text when the bridge responded with JSON.
 */
export async function relayBridgeError(res: Response): Promise<Response> {
  const text = await res.text().catch(() => '');
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.error === 'string') message = obj.error;
      else if (typeof obj.detail === 'string') message = obj.detail;
    }
  } catch {
    // Not JSON — use the raw text as-is.
  }
  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  return Response.json(
    { error: `Bridge ${res.status}: ${message.slice(0, 500)}` },
    { status }
  );
}

// ── Spawn body whitelisting ─────────────────────────────────────────────
//
// BRIDGE-CONTRACT.md's POST /api/sessions/spawn accepts EXACTLY:
//   { cwd?, initial_prompt?, domain?, agent?, model?, name?, cols?, rows? }
// The shipped UI's own spawn callers (SessionTerminal's "spawn new with
// same context", NewSessionPicker's domain spawn) additionally send fields
// the v1 bridge has no concept of — `thread_id`, `project_slug`,
// `persistent` — upstream-cockpit-era ideas (Supabase threads, domain
// "continuity brains") that BRIDGE-CONTRACT.md's non-goals explicitly
// exclude from v1 ("no domain-seat rendering from ~/clawd, no Supabase").
// Whitelist down to exactly the contract's fields before forwarding, so an
// extra field never risks tripping the bridge's own request validation.

export interface SpawnRequestBody {
  cwd?: string;
  initial_prompt?: string;
  domain?: string;
  agent?: string;
  model?: string;
  name?: string;
  cols?: number;
  rows?: number;
}

export function pickSpawnFields(body: unknown): SpawnRequestBody {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: SpawnRequestBody = {};
  if (typeof b.cwd === 'string' && b.cwd) out.cwd = b.cwd;
  if (typeof b.initial_prompt === 'string' && b.initial_prompt) out.initial_prompt = b.initial_prompt;
  if (typeof b.domain === 'string' && b.domain) out.domain = b.domain;
  if (typeof b.agent === 'string' && b.agent) out.agent = b.agent;
  if (typeof b.model === 'string' && b.model) out.model = b.model;
  if (typeof b.name === 'string' && b.name) out.name = b.name;
  if (typeof b.cols === 'number') out.cols = b.cols;
  if (typeof b.rows === 'number') out.rows = b.rows;
  return out;
}

/** Safely parse a JSON request body. Returns {} on empty/invalid body
 *  rather than throwing — callers that require a specific field (e.g.
 *  spawn-domain's `domain`) validate AFTER this and 400 with a precise
 *  message; callers where every field is optional (cockpit-spawn, the
 *  generic spawn) can legitimately receive an empty body. */
export async function parseJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = await request.json();
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Response compatibility aliases ──────────────────────────────────────
//
// The shipped cockpit UI (ChatGrid, ThreadSidebar, NewSessionPicker,
// railModel, LiveProjectSessions) was ported from the upstream cockpit and was
// never trimmed to BRIDGE-CONTRACT.md's leaner v1 session shape. Verified
// by reading every consumer (see the build report for the full list):
//
//   - NewSessionPicker.spawnCockpit/spawnDomain treat a MISSING
//     `data.thread_id` as a FAILED spawn (`!data.thread_id` triggers the
//     error banner) even when the bridge successfully created the session.
//     v1 has no separate thread concept (no Supabase) — the only sane
//     value is the session_id itself.
//   - ChatGrid.fetchSessionMeta / the enrichment poll, ThreadSidebar,
//     railModel.BrainRow and LiveProjectSessions.SessionRow all read a
//     session's primary key as `.id`, not the contract's `.session_id`.
//   - The same group reads `.live` (boolean) rather than deriving it from
//     `.status`.
//
// All three additions below are ADDITIVE ONLY — every contract-documented
// field is passed through unmodified; these are extra keys a
// contract-following consumer simply never looks at.
export function withCompatAliases(
  bridgeJson: Record<string, unknown>
): Record<string, unknown> {
  const sessionId =
    typeof bridgeJson.session_id === 'string' ? bridgeJson.session_id : undefined;
  const status = typeof bridgeJson.status === 'string' ? bridgeJson.status : undefined;
  return {
    ...bridgeJson,
    ...(sessionId ? { id: sessionId, thread_id: sessionId } : {}),
    ...(status ? { live: status !== 'exited' } : {}),
  };
}
