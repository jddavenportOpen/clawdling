// ═══════════════════════════════════════════════════════════════════════════
// seqDedup.test.ts — CAT-15 regression: frame-SEQ de-dup must skip ONLY true
// wire-replays (a seq already delivered), and must NEVER drop legit repeated
// CONTENT (the bug the old content+time ring caused).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { makeSeqDeduper } from '../seqDedup';

describe('makeSeqDeduper — monotonic seq de-dup (CAT-15)', () => {
  it('renders every frame with a strictly-increasing seq', () => {
    const d = makeSeqDeduper();
    expect(d.shouldSkip('1')).toBe(false);
    expect(d.shouldSkip('2')).toBe(false);
    expect(d.shouldSkip('3')).toBe(false);
  });

  it('skips a frame whose seq was already delivered (catchup/SSE overlap replay)', () => {
    const d = makeSeqDeduper();
    expect(d.shouldSkip('5')).toBe(false); // delivered up to 5
    expect(d.shouldSkip('6')).toBe(false);
    // Reconnect replays 5 and 6 — both already passed, skip them.
    expect(d.shouldSkip('5')).toBe(true);
    expect(d.shouldSkip('6')).toBe(true);
    // The next NEW frame still renders.
    expect(d.shouldSkip('7')).toBe(false);
  });

  it('NEVER drops legit repeated CONTENT — dedup is by SEQ, not text', () => {
    // This is the whole point of CAT-15: the old ring dropped a chunk because
    // its TEXT repeated within 3s. The seq deduper only cares about the id, so
    // a reprinted progress line / identical tool-result line with a fresh seq
    // always renders.
    const d = makeSeqDeduper();
    expect(d.shouldSkip('10')).toBe(false);
    expect(d.shouldSkip('11')).toBe(false); // identical text would have new seq
    expect(d.shouldSkip('12')).toBe(false);
  });

  it('fails OPEN on a non-numeric or absent id (renders rather than risks loss)', () => {
    const d = makeSeqDeduper();
    expect(d.shouldSkip(undefined)).toBe(false);
    expect(d.shouldSkip(null)).toBe(false);
    expect(d.shouldSkip('')).toBe(false);
    expect(d.shouldSkip('abc')).toBe(false);
    // A non-numeric id does NOT poison the high-water mark — numeric seqs after
    // it still behave.
    expect(d.shouldSkip('1')).toBe(false);
    expect(d.shouldSkip('1')).toBe(true);
  });

  it('reset() clears the high-water mark on a sid-swap (new session seqs restart)', () => {
    const d = makeSeqDeduper();
    expect(d.shouldSkip('100')).toBe(false);
    expect(d.shouldSkip('50')).toBe(true); // stale, below mark
    d.reset();
    // New session: seq 50 is now the FIRST frame of a fresh stream — render it.
    expect(d.shouldSkip('50')).toBe(false);
  });
});
