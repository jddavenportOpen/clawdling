// ═══════════════════════════════════════════════════════════════════════════
// sessionResume — the single "is this session permanently dead, never resume"
// predicate for SessionTerminal's reconnect/resume guards.
//
// ROOT CAUSE it single-sources (fix/cockpit-resume-after-rotation lineage):
// reconnect guards that read the `status` STATE captured in their closure go
// STALE the instant a session exits but before React flushes setStatus. The
// authoritative signal is the monotonic `exitedRef` latch (set synchronously
// on every exit/crash path). A guard must consult BOTH — the latch covers the
// stale-closure window, the status string covers the exited-at-mount case.
//
// Before this, `connect()` and `scheduleReconnect()` honored the latch but the
// visibility/focus `resume()` effect guarded on `status` ALONE — so a tab
// re-focus in the stale window ran a wasteful catchup + dispatched SSE_CLOSED
// (flipping a correctly-ENDED badge to a stuck "RECONNECT") before connect()
// bailed. Routing every guard through this predicate closes that gap. (Iter 3)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * True when a session must NOT be (re)connected: either its status string is
 * already 'exited', or the monotonic exited latch has fired. Pass
 * `exitedRef.current` for `exited`. Monotonic — once dead, always dead.
 */
export function streamIsDead(
  status: string | null | undefined,
  exited: boolean
): boolean {
  return status === 'exited' || exited === true;
}
