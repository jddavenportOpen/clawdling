// ═══════════════════════════════════════════════════════════════════════════
// sessionResume.test.ts — the dead-session reconnect guard (Iter 3).
//
// Locks the "never resume a dead session" contract that SessionTerminal's
// connect()/resume() guards share: the latch (exited) wins even when the status
// closure is STALE ('live'), and an exited-at-mount status is caught too.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { streamIsDead } from '../sessionResume';

describe('streamIsDead', () => {
  it('is false for a healthy live session', () => {
    expect(streamIsDead('live', false)).toBe(false);
    expect(streamIsDead('starting', false)).toBe(false);
  });

  it('is true when the status string is exited', () => {
    expect(streamIsDead('exited', false)).toBe(true);
  });

  it('is true when the exited latch fired even if the status closure is STALE', () => {
    // The bug this guards: closure captured status='live' before the session
    // died; exitedRef.current is the authoritative monotonic latch.
    expect(streamIsDead('live', true)).toBe(true);
  });

  it('tolerates null/undefined status', () => {
    expect(streamIsDead(null, false)).toBe(false);
    expect(streamIsDead(undefined, true)).toBe(true);
  });
});
