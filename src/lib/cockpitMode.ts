// ═══════════════════════════════════════════════════════════════════════════
// cockpitMode.ts — Cockpit V3.2 chat-mode vs pane-mode toggle.
//
// JD msg 8280 (2026-05-27): "I dont mind the whole screen panes for the chat
// agents, but I want that to be an option to do, NOT the default. I need both
// things: many chats to one view multi-paned agent view, AND id like the
// opportunity to just use individual chats and have them all be running
// without needing to be opened to them."
//
// The /chat cockpit now has two render modes for the SAME running deck
// (the `?panes=` list — every spawned chat stays mounted, SSE alive,
// regardless of mode):
//
//   chat (DEFAULT) — ONE focused chat fills the canvas. The others stay
//                    mounted but hidden (display:none) so their streams
//                    keep running. Mental model: ChatGPT / Claude.ai tabs.
//                    Switching between chats is instant (no remount).
//   pane           — the existing multi-pane grid. Multiple agents tiled
//                    side-by-side. Opt-in for the power-user "I want to
//                    see all 4 things happening at once" view.
//
// URL contract:
//   ?mode=chat     → default if absent
//   ?mode=pane     → grid layout
//   ?panes=<sids>  → the running deck (shared by both modes)
//   ?focus=<sid>   → in chat mode, the currently visible chat. In pane mode,
//                    the maximized pane (same as before — backwards compat).
//
// Persistence: localStorage `chat-cockpit.mode`. URL wins on initial load
// (matches the existing `?panes=` precedence).
//
// V2.1 (clickMode.ts) is RETIRED — this toggle subsumes the per-user
// click-mode preference. The chrome-level toggle is more discoverable than
// a hidden dropdown and reflects intent ("I want this view") rather than
// "what should a click do." Per-pane Maximize still works inside pane mode
// for the "make this one pane full-bleed in the grid" UX.
// ═══════════════════════════════════════════════════════════════════════════

export type CockpitMode = 'chat' | 'pane';

export const LS_COCKPIT_MODE = 'chat-cockpit.mode';

const VALID_MODES: ReadonlyArray<CockpitMode> = ['chat', 'pane'];

/** Default mode when nothing is stored / URL is silent. JD's directive:
 *  chat is the default; pane is opt-in. */
export const DEFAULT_MODE: CockpitMode = 'chat';

/** Parse a raw URL `?mode=` value into a CockpitMode. Falls back to the
 *  default on null / unknown values so a typo'd URL never wedges the UI. */
export function parseModeParam(raw: string | null | undefined): CockpitMode {
  if (raw && (VALID_MODES as readonly string[]).includes(raw)) {
    return raw as CockpitMode;
  }
  return DEFAULT_MODE;
}

/** Read the user's persisted mode. SSR-safe (returns DEFAULT_MODE on the
 *  server). Wrapped in try/catch so disabled storage / SecurityError never
 *  throws into a render. */
export function getStoredMode(): CockpitMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const v = window.localStorage.getItem(LS_COCKPIT_MODE);
    if (v && (VALID_MODES as readonly string[]).includes(v)) {
      return v as CockpitMode;
    }
  } catch {
    /* storage disabled — fall through */
  }
  return DEFAULT_MODE;
}

/** Persist the mode. No-op on SSR or storage failure. */
export function setStoredMode(mode: CockpitMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_COCKPIT_MODE, mode);
  } catch {
    /* ignore */
  }
}

/** Resolve the effective mode for initial render: URL beats storage beats
 *  default. Pure — no DOM access — so the test suite can pin the precedence
 *  contract directly. */
export function resolveInitialMode(
  urlMode: string | null | undefined,
  storedMode: CockpitMode | null | undefined
): CockpitMode {
  // URL wins, even an explicit ?mode=chat (which IS the default).
  if (urlMode && (VALID_MODES as readonly string[]).includes(urlMode)) {
    return urlMode as CockpitMode;
  }
  if (storedMode && (VALID_MODES as readonly string[]).includes(storedMode)) {
    return storedMode;
  }
  return DEFAULT_MODE;
}
