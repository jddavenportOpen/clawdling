/** Merge class names, filtering out falsy values. */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/** Format a number as currency. */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Turn an unknown thrown value into a human-legible string.
 *
 * Why this exists (CAT-06 / LIVE-DESKTOP BUG-6 / BUG-R1, 2026-06-12):
 *   Supabase/Postgres errors are PLAIN OBJECTS ({ message, details, hint,
 *   code }), not Error instances. `String(err)` on them yields the useless
 *   literal "[object Object]", which hid the real FK-violation behind
 *   "Failed to create thread: [object Object]" for every createThread
 *   failure. This extracts message/details/code so logs and client errors
 *   carry the actual Postgres reason.
 *
 * Order of preference: Error.message → PostgrestError-shaped fields →
 * JSON.stringify → String(). Never returns "[object Object]".
 */
export function describeError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    const parts: string[] = [];
    if (typeof e.message === 'string' && e.message) parts.push(e.message);
    if (typeof e.details === 'string' && e.details) parts.push(e.details);
    if (typeof e.code === 'string' && e.code) parts.push(`[${e.code}]`);
    if (parts.length) return parts.join(' — ');
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* circular — fall through */
    }
  }
  return String(err);
}

// chat_sessions.id is a Postgres `uuid`. A non-UUID path segment passed
// straight into `.eq('id', sid)` makes Postgres throw 22P02 ("invalid input
// syntax for type uuid"), which the [sid] routes surfaced as a 500 leaking the
// raw DB error — AND broke the resume-on-404 brain (it keys on 404/409, never a
// 500). Validate at the route boundary so a malformed sid is a clean 404
// (CAT-19, 2026-06-12). A valid-format-but-nonexistent UUID already 404s
// correctly downstream via maybeSingle() → null.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `sid` is a canonical UUID (the shape chat_sessions.id requires). */
export function isUuid(sid: unknown): sid is string {
  return typeof sid === 'string' && UUID_RE.test(sid);
}

/**
 * Humanize a failed agent-spawn response into a short, JD-facing error string.
 *
 * Why this exists (CAT-05 / LIVE-MOBILE BUG-MOB-01, 2026-06-12):
 *   The rail spawn handlers (spawnCeoAgent / openDomainBrain / Space spawn in
 *   ThreadSidebar) did `if (res.ok && data.session_id) open(...)` with NO else
 *   and an EMPTY catch — so a 500 (thread-create failed) or 502 (bridge
 *   unreachable) produced TOTAL SILENCE: JD taps, the screen is byte-identical,
 *   no toast, no spinner-error. This maps the failure to a clear message,
 *   distinguishing the two operator-actionable cases:
 *     - 502/503 → the bridge is down/unreachable (transient; retry / check daemon)
 *     - status 0 → network throw (offline / DNS / aborted fetch)
 *     - everything else (500/4xx) → couldn't start the agent
 *
 * `status` is the HTTP status (or 0 for a network throw with no response).
 * `serverError` is the route's `{ error }` body, surfaced as a parenthetical
 * detail when present (it already carries the real Postgres/bridge reason via
 * describeError on the server side).
 */
export function spawnFailureMessage(
  status: number,
  serverError?: string | null
): string {
  const base =
    status === 502 || status === 503
      ? "Couldn't start the agent — the bridge is unreachable. Tap to retry."
      : status === 0
        ? "Couldn't start the agent — network error. Tap to retry."
        : "Couldn't start the agent. Tap to retry.";
  const detail = (serverError ?? '').trim();
  // Don't echo the useless "[object Object]" (now fixed server-side) or a bare
  // duplicate of the base. Keep the detail short so the rail banner stays one
  // or two lines on mobile.
  if (detail && detail !== '[object Object]') {
    const short = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
    return `${base} (${short})`;
  }
  return base;
}

/** Format a relative time string like "3m ago". */
export function timeAgo(date: Date | string): string {
  const now = new Date();
  const then = new Date(date);
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
