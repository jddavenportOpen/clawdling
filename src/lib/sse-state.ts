// ═══════════════════════════════════════════════════════════════════════════
// sse-state.ts — explicit state machine for the live-session pane
//
// Born 2026-05-23 in P0.6 of cockpit-multi-session-v2 (WORKPLAN line 142).
//
// Before this file, SessionTerminal had ad-hoc bits — "thinking · 8s",
// "reconnecting to live stream", a green dot, a sync badge — with no
// explicit state. JD's complaint: "I can't tell 'the agent is working'
// from 'the SSE is broken' from 'the session ended.'" Multiple inconsistent
// badges, no truth.
//
// Modeled after how tmux + zellij report session state at the bottom-right:
// ONE indicator, six values, deterministic transitions. The badge IS the
// state machine. No second source of truth.
//
// Design:
//   states: INITIAL → SYNCING → LIVE → RECONNECT → ENDED | ERROR
//   events: HISTORY_LOADED, FIRST_LIVE_EVENT, SSE_CLOSED, SSE_RECONNECTED,
//           SESSION_ENDED, BRIDGE_ERROR, MANUAL_RELOAD
//
// The reducer is a pure function — (state, event) → state. No effects, no
// async, no setState. SessionTerminal wraps it via useSseState() which is
// thin useReducer sugar. Pure reducer = trivially testable + composable
// with future state machines (P1.1 will likely add a sibling for
// session.status that also feeds the same badge).
//
// Why explicit since-timestamps in the state shape: the RECONNECT badge
// shows elapsed seconds ("reconnecting 3s") so the user knows we're
// retrying, not stuck. ENDED carries a since for "ended 12s ago" if we
// ever want that. Keep them on the state so the reducer remains pure;
// otherwise the UI would have to track timers separately and the two
// could drift out of sync.
//
// Why MANUAL_RELOAD is a state-machine event (not just a button click):
// the ERROR state's escape hatch is "reload" — clicking it transitions
// the machine back to INITIAL so the connect cycle starts fresh. Wiring
// it through the reducer keeps the UI a pure projection of state.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useReducer } from 'react';

export type SseStateKind =
  | 'INITIAL'
  | 'SYNCING'
  | 'LIVE'
  | 'RECONNECT'
  | 'ENDED'
  | 'ERROR';

export interface SseState {
  kind: SseStateKind;
  /** ms since epoch of the transition INTO this state. Used by the badge
   *  to render "reconnecting 3s" elapsed time. */
  since: number;
  /** Optional human-readable error message for ERROR state. */
  error?: string;
  /** cockpit-multi-session-v2 P1.4 — when truthy, the ERROR state was
   *  entered via a `kind: "crashed"` SSE event from the bridge
   *  (bridge process died mid-session and crash-recovery rebooted it).
   *  Value is ms-since-epoch of the original crash, NOT of the state
   *  transition (those are usually within seconds but the bridge's
   *  ts is the authoritative one to display to the user). The badge
   *  renders distinct "agent crashed at HH:MM:SS" copy + a spawn-new
   *  button when this is set, falling back to the generic "session
   *  lost — reload" badge when it's not.
   */
  crashedAt?: number;
}

export type SseEvent =
  | { type: 'HISTORY_LOADED' }
  | { type: 'FIRST_LIVE_EVENT' }
  | { type: 'SSE_CLOSED' }
  | { type: 'SSE_RECONNECTED' }
  | { type: 'SESSION_ENDED' }
  | { type: 'BRIDGE_ERROR'; error?: string }
  | { type: 'MANUAL_RELOAD' }
  // cockpit-multi-session-v2 P1.4 — bridge crashed mid-session.
  // Distinct from SESSION_ENDED (clean exit) and BRIDGE_ERROR (transport
  // failure) so the UI can render the "agent crashed at <time>" badge
  // + "Spawn new with same prompt" button instead of just "session lost".
  // crashedAt is ms-since-epoch (per the SSE `crashed` frame's ts field);
  // the badge formats it as a HH:MM:SS local-time string.
  | { type: 'SESSION_CRASHED'; crashedAt: number };

/**
 * Initial state. `since` defaults to 0 so SSR + first-render are
 * deterministic; the first real transition sets a real timestamp.
 */
export function initialState(): SseState {
  return { kind: 'INITIAL', since: 0 };
}

/**
 * Pure state-machine reducer. (state, event) → state.
 *
 * Invariants:
 *   - ENDED is terminal UNLESS MANUAL_RELOAD (which kicks back to INITIAL).
 *   - ERROR is recoverable via MANUAL_RELOAD, or naturally if a frame
 *     arrives anyway (FIRST_LIVE_EVENT / SSE_RECONNECTED).
 *   - SESSION_ENDED always wins. The session ending is a hard truth.
 *   - Unknown (state, event) pairs are no-ops — the state is unchanged.
 *     This keeps the reducer crash-free if a stray event fires after
 *     teardown.
 */
export function sseStateReducer(state: SseState, event: SseEvent): SseState {
  const now = nowMs();

  // SESSION_ENDED wins from any state. The session ending is a hard truth
  // the user must always see immediately.
  if (event.type === 'SESSION_ENDED') {
    if (state.kind === 'ENDED') return state;
    return { kind: 'ENDED', since: now };
  }

  // SESSION_CRASHED (cockpit-multi-session-v2 P1.4) — bridge died
  // mid-session. Transitions to ERROR (per task spec: "BRIDGE_ERROR →
  // state ERROR") but stamps `crashedAt` so the badge component can
  // render the distinct "agent crashed at <time>" + spawn-new UI. We
  // do NOT short-circuit if state.kind === 'ERROR' already — the
  // crashed event may arrive AFTER a generic transport error and the
  // crash info is strictly more useful than "connect failed". Idempotent
  // when crashedAt matches (same crash replayed on /history catchup).
  if (event.type === 'SESSION_CRASHED') {
    if (state.kind === 'ERROR' && state.crashedAt === event.crashedAt) {
      return state;
    }
    return {
      kind: 'ERROR',
      since: now,
      error: 'agent crashed (bridge restart)',
      crashedAt: event.crashedAt,
    };
  }

  // MANUAL_RELOAD is the user-initiated escape from terminal/error states.
  if (event.type === 'MANUAL_RELOAD') {
    if (state.kind === 'ENDED' || state.kind === 'ERROR') {
      return { kind: 'INITIAL', since: now };
    }
    // No-op in healthy states — there's nothing to reload from.
    return state;
  }

  switch (state.kind) {
    case 'INITIAL':
      switch (event.type) {
        case 'HISTORY_LOADED':
          return { kind: 'SYNCING', since: now };
        case 'FIRST_LIVE_EVENT':
          // Fast path: live frame arrived before /history even resolved.
          // Skip SYNCING — we're already live.
          return { kind: 'LIVE', since: now };
        case 'BRIDGE_ERROR':
          return { kind: 'ERROR', since: now, error: event.error };
        case 'SSE_CLOSED':
          // Closed before we ever opened — bounce to RECONNECT so the
          // retry loop drives us. The /api/stream-post metadata fetch
          // can fail intermittently (cold Vercel function); treating it
          // as "reconnecting" instead of "error" is more honest about
          // what's happening + matches the existing reconnect-with-
          // backoff machinery.
          return { kind: 'RECONNECT', since: now };
        default:
          return state;
      }

    case 'SYNCING':
      switch (event.type) {
        case 'FIRST_LIVE_EVENT':
          return { kind: 'LIVE', since: now };
        case 'SSE_CLOSED':
          return { kind: 'RECONNECT', since: now };
        case 'BRIDGE_ERROR':
          return { kind: 'ERROR', since: now, error: event.error };
        case 'HISTORY_LOADED':
          // Already syncing; idempotent. Don't reset `since` — that would
          // make the badge flicker on every redundant history fetch.
          return state;
        default:
          return state;
      }

    case 'LIVE':
      switch (event.type) {
        case 'SSE_CLOSED':
          return { kind: 'RECONNECT', since: now };
        case 'BRIDGE_ERROR':
          return { kind: 'ERROR', since: now, error: event.error };
        case 'FIRST_LIVE_EVENT':
        case 'HISTORY_LOADED':
        case 'SSE_RECONNECTED':
          // Already live; redundant signals don't change anything.
          return state;
        default:
          return state;
      }

    case 'RECONNECT':
      switch (event.type) {
        case 'SSE_RECONNECTED':
        case 'FIRST_LIVE_EVENT':
          return { kind: 'LIVE', since: now };
        case 'BRIDGE_ERROR':
          return { kind: 'ERROR', since: now, error: event.error };
        case 'SSE_CLOSED':
        case 'HISTORY_LOADED':
          // Still reconnecting; preserve `since` so the elapsed timer
          // keeps counting through retry storms (otherwise every retry
          // would reset the clock to 0 and the user would never see
          // "reconnecting 30s — something's really wrong").
          return state;
        default:
          return state;
      }

    case 'ENDED':
      // Terminal. MANUAL_RELOAD handled above. Everything else is a no-op.
      return state;

    case 'ERROR':
      switch (event.type) {
        case 'SSE_RECONNECTED':
        case 'FIRST_LIVE_EVENT':
          // Self-heal — if data starts flowing again, recover gracefully.
          return { kind: 'LIVE', since: now };
        case 'HISTORY_LOADED':
          // History came back after an error — sync up.
          return { kind: 'SYNCING', since: now };
        case 'SSE_CLOSED':
          // Already errored; preserve `since` + error context.
          return state;
        case 'BRIDGE_ERROR':
          // Re-error with possibly-new message. Update error text but
          // preserve `since` so elapsed time isn't constantly reset by
          // a retry-loop spamming BRIDGE_ERROR every backoff cycle.
          if (event.error && event.error !== state.error) {
            return { ...state, error: event.error };
          }
          return state;
        default:
          return state;
      }
  }
}

/**
 * Thin useReducer wrapper. Returns the current state + a stable dispatch
 * function (already stable via useReducer's contract — no useCallback
 * needed). The optional `now` injection is for tests.
 */
export function useSseState() {
  const [state, dispatch] = useReducer(sseStateReducer, undefined, initialState);

  /** Convenience helper: dispatch a typed event. */
  const send = useCallback(
    (event: SseEvent) => {
      dispatch(event);
    },
    [dispatch]
  );

  return { state, dispatch, send };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Test seam: lets unit tests inject a deterministic clock without mocking
 *  Date.now globally. Defaults to Date.now in production. */
let _now: () => number = () => Date.now();

export function __setNowForTesting(fn: () => number) {
  _now = fn;
}

export function __resetNowForTesting() {
  _now = () => Date.now();
}

function nowMs(): number {
  return _now();
}

// ── Badge metadata (for the UI) ────────────────────────────────────────────

export interface BadgeSpec {
  /** Tailwind color token for the dot/icon. */
  color: 'gray' | 'cyan' | 'green' | 'amber' | 'magenta' | 'red';
  /** Short label shown next to the dot. Empty string = dot-only. */
  label: string;
  /** Icon hint — consumed by the React badge component to pick a Lucide
   *  glyph. Decoupling the icon name from the React component keeps this
   *  module render-free + Node-testable. */
  icon: 'spinner' | 'pulse' | 'dot' | 'check' | 'alert';
  /** Whether this state shows an elapsed-time counter (e.g. "reconnecting 3s"). */
  showElapsed: boolean;
  /** Whether this state shows a reload button. */
  showReload: boolean;
  /** cockpit-multi-session-v2 P1.4 — whether this state should render the
   *  "Spawn new with same prompt" button. Only true when ERROR was entered
   *  via a SESSION_CRASHED event (state.crashedAt is set).
   */
  showSpawnNew: boolean;
}

/**
 * Pure mapping from state-machine state to render-ready badge spec.
 * Kept render-free so it's Node-testable + reusable in future surfaces
 * (sidebar status pill in P1.2 will reuse this).
 */
export function badgeForState(state: SseState): BadgeSpec {
  switch (state.kind) {
    case 'INITIAL':
      return { color: 'gray', label: 'loading', icon: 'spinner', showElapsed: false, showReload: false, showSpawnNew: false };
    case 'SYNCING':
      return { color: 'cyan', label: 'syncing', icon: 'pulse', showElapsed: false, showReload: false, showSpawnNew: false };
    case 'LIVE':
      // After 2s in LIVE the label hides and we render just the dot.
      // The badge component is responsible for the 2s suppression; the
      // spec just declares the intent.
      return { color: 'green', label: 'live', icon: 'dot', showElapsed: false, showReload: false, showSpawnNew: false };
    case 'RECONNECT':
      return { color: 'amber', label: 'reconnecting', icon: 'spinner', showElapsed: true, showReload: false, showSpawnNew: false };
    case 'ENDED':
      // v3-cosmetic-batch (2026-05-28): the original PRD/audit for #97 said
      // "Spawn new with same prompt button renders in cockpit pane when status
      // flips to crashed/exited" — but ENDED (clean exit / kill button) had no
      // button, only the composer placeholder "Type to resume session". The
      // composer-typing path works (bridge's /input 404-fallback transparently
      // resumes), but a one-click button is the affordance the PRD specced and
      // is materially less friction than typing a placeholder prompt. ENDED now
      // matches CRASHED ERROR: showSpawnNew=true so the badge renders the
      // spawn-new button alongside "ended". The CRASHED path stays distinct
      // (red badge + "agent crashed at HH:MM:SS") because the user signal is
      // different (bridge died vs clean exit), but both paths now offer the
      // same one-click recovery.
      return { color: 'gray', label: 'ended', icon: 'check', showElapsed: false, showReload: false, showSpawnNew: true };
    case 'ERROR': {
      // cockpit-multi-session-v2 P1.4 — if we entered ERROR via a
      // SESSION_CRASHED event, render the crash-specific badge + the
      // "Spawn new with same prompt" button instead of the generic
      // "session lost — reload" UI. The label uses the bridge's
      // authoritative crash timestamp (HH:MM:SS local) so the user
      // knows WHEN the agent died, not just THAT it died.
      if (typeof state.crashedAt === 'number') {
        const hhmmss = formatHHMMSS(state.crashedAt);
        return {
          color: 'red',
          label: `agent crashed at ${hhmmss}`,
          icon: 'alert',
          showElapsed: false,
          showReload: false,
          showSpawnNew: true,
        };
      }
      return { color: 'magenta', label: 'session lost — reload', icon: 'alert', showElapsed: false, showReload: true, showSpawnNew: false };
    }
  }
}


// Helper kept module-private (no `export`) so we can swap the implementation
// without breaking callers. Defensive against NaN / negative ts inputs —
// returns "??:??:??" so the badge never renders garbage.
function formatHHMMSS(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '??:??:??';
  try {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '??:??:??';
  }
}
