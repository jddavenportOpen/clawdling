// ═══════════════════════════════════════════════════════════════════════════
// cockpitCaps.ts — the SINGLE source of truth for the /chat deck pane cap.
//
// C5 (R-Cockpit, no-cap): "many open Claude Codes, all organized, from the
// GUI." The fleet must be UNBOUNDED — the old arbitrary caps directly
// contradicted the infinity-agents ethos (INTEGRATION-PLAN §C5):
//   • ChatGrid.MAX_PANES = 10   (hard refusal on add)
//   • ThreadSidebar.openSidInDeck cap = 10  (bump-oldest)
//   • ThreadSidebar.openInGrid    cap = 6   (bump-oldest — a DIFFERENT number)
// Those three numbers disagreed (the chat-cockpit audit §4 #3 + the adversarial
// verifier B3 both flagged the 6-vs-10 mismatch), so a session could be
// silently EVICTED from the deck depending on which button opened it.
//
// The fix (INTEGRATION-PLAN §C5, two layers):
//   1. Unify the cap — every append path imports PANE_SOFT_CAP from HERE, so the
//      three code paths can never drift again.
//   2. Make it a SOFT RENDER BUDGET, not a hard refusal. The deck holds as many
//      sessions as JD spawns; ChatGrid keeps every pane MOUNTED (display:none in
//      chat mode, tiled in pane mode) so backgrounded agents keep streaming —
//      the keep-alive mechanism already exists (ChatGrid render loop). The hard
//      ceiling is PHYSICS (one box → a finite PTY count), surfaced honestly via
//      the CapacityPill / spine /capacity, NEVER a magic number in three files.
//
// PANE_SOFT_CAP is deliberately large (effectively unbounded for a human-driven
// fleet) but FINITE, so a pathological/corrupt `?panes=` URL or a runaway loop
// can't try to mount an unbounded number of xterm panes in one tick and wedge
// the tab. It is the parser clamp + the deck-append clamp — the same constant
// for both, which is the whole point.
//
// Behavior for decks of <= 10 sessions is BYTE-IDENTICAL to the old code: every
// branch that compared against 6/10 now compares against PANE_SOFT_CAP, and
// PANE_SOFT_CAP >> 10, so no <=10 deck ever hits the bump-oldest branch that
// the old 6/10 caps did. Existing single-/multi-pane UX is unchanged.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The unified soft render budget for the /chat deck.
 *
 * This replaces the old `MAX_PANES = 10` (ChatGrid) + the hardcoded `10`
 * (openSidInDeck) + `6` (openInGrid) caps with ONE number every append path
 * shares. It is a soft cap: the deck may hold this many sessions before the
 * URL/append clamps engage. It is NOT a UI refusal at 10 — the fleet is
 * unbounded up to this budget, and the true ceiling is the box's physical PTY
 * limit (surfaced via CapacityPill), not this constant.
 *
 * 1000 is "unbounded" for any human-driven cockpit fleet while still capping a
 * corrupt-URL / runaway-append blowup. Bump it freely; nothing assumes a
 * specific value beyond "much larger than any realistic deck."
 */
export const PANE_SOFT_CAP = 1000;
