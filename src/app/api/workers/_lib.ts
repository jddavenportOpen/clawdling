// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers for the /api/workers/* route family — thin proxies from the
// cockpit UI to the local Python bridge's worker endpoints (see
// bridge/README.md "Workers" for the wire shape).
//
// NOT a route — Next.js only treats a file literally named `route.ts` as a
// route handler, so this file is invisible to the router.
//
// Everything that is not worker-specific is IMPORTED from the sessions family
// rather than re-implemented: auth (`requireSessionAuth`), the
// bridge-unreachable diagnosis, and the error relay. There is exactly one auth
// path in this app and exactly one place that knows what `ECONNREFUSED` from
// the bridge means; a second copy would drift.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

export {
  requireSessionAuth,
  unauthorized,
  bridgeUnreachable,
  relayBridgeError,
  parseJsonObject,
} from '../sessions/_lib';

// ── Dispatch body whitelisting ──────────────────────────────────────────────
//
// The bridge's POST /api/workers accepts EXACTLY:
//   { objective, cwd?, domain?, agent?, model?, name?, max_runtime_sec?,
//     permission_mode? }
// Whitelist down to those before forwarding, the same way pickSpawnFields does
// for sessions, so a stray field from a future UI can never reach the bridge's
// request validation and turn into a confusing 422.

export interface WorkerDispatchBody {
  objective?: string;
  cwd?: string;
  domain?: string;
  agent?: string;
  model?: string;
  name?: string;
  max_runtime_sec?: number;
  permission_mode?: string;
}

export function pickWorkerFields(body: unknown): WorkerDispatchBody {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: WorkerDispatchBody = {};
  if (typeof b.objective === 'string' && b.objective.trim()) out.objective = b.objective;
  if (typeof b.cwd === 'string' && b.cwd) out.cwd = b.cwd;
  if (typeof b.domain === 'string' && b.domain) out.domain = b.domain;
  if (typeof b.agent === 'string' && b.agent) out.agent = b.agent;
  if (typeof b.model === 'string' && b.model) out.model = b.model;
  if (typeof b.name === 'string' && b.name) out.name = b.name;
  if (typeof b.max_runtime_sec === 'number' && Number.isFinite(b.max_runtime_sec)) {
    out.max_runtime_sec = Math.trunc(b.max_runtime_sec);
  }
  if (typeof b.permission_mode === 'string' && b.permission_mode) {
    out.permission_mode = b.permission_mode;
  }
  return out;
}

/** Percent-encode a run id for a bridge path. Ids are uuid4s, but the id comes
 *  off the URL, so it is encoded rather than trusted. */
export function bridgeWorkerPath(runId: string, suffix = ''): string {
  return `/api/workers/${encodeURIComponent(runId)}${suffix}`;
}
