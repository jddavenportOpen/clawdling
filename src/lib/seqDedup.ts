// ═══════════════════════════════════════════════════════════════════════════
// seqDedup — monotonic frame-seq de-duplication for the SSE output stream.
//
// CAT-15 (2026-06-12). The bridge stamps every output frame with a MONOTONIC
// `id:` / Last-Event-ID seq (the P0.3/P0.4 contract). The ONLY duplicate source
// on the wire is the catchup/SSE overlap window after a reconnect: the bridge
// replays frames we may have already rendered, and those replays carry seqs
// we've ALREADY passed. So correct de-duplication is "skip a frame whose seq we
// have already delivered" — keyed on the monotonic id, NOT on chunk CONTENT.
//
// The old approach (a content+time ring in SessionTerminal.appendChunk) dropped
// any chunk ≥4 chars that textually repeated within 3s — which SILENTLY
// CORRUPTED legitimately-repeated PTY output (a reprinted progress line, two
// identical tool-result lines, an ANSI repaint that emits identical bytes).
// This replaces it.
//
// Fail-open by design: a frame with a NEW seq, a NON-NUMERIC id, or NO id at
// all always renders. We would rather double-paint a pathological frame than
// drop one real byte of the agent's output.
// ═══════════════════════════════════════════════════════════════════════════

/** Stateful de-duper. `shouldSkip(rawId)` returns true ONLY when `rawId` is a
 *  numeric seq we have already delivered (≤ the high-water mark). Any new seq
 *  advances the mark; a non-numeric / absent id never skips. `reset()` clears
 *  the mark on a sid-swap (the new session's seqs restart from a low number and
 *  must not be mistaken for already-delivered replays). */
export interface SeqDeduper {
  shouldSkip(rawId: string | null | undefined): boolean;
  reset(): void;
}

export function makeSeqDeduper(): SeqDeduper {
  let maxDelivered = -1;
  return {
    shouldSkip(rawId: string | null | undefined): boolean {
      if (!rawId) return false; // no seq → can't be a known replay → render it
      const seq = Number(rawId);
      if (!Number.isFinite(seq)) return false; // non-numeric id → render it
      if (seq <= maxDelivered) return true; // already delivered → skip
      maxDelivered = seq;
      return false;
    },
    reset() {
      maxDelivered = -1;
    },
  };
}
