// ═══════════════════════════════════════════════════════════════════════════
// spawn-failure-message.test.ts — regression guard for CAT-05 (the SILENT
// spawn-failure half).
//
// LIVE-MOBILE BUG-MOB-01: the rail spawn handlers (spawnCeoAgent /
// openDomainBrain / "+ New in this Space" in ThreadSidebar) did
//   `if (res.ok && data.session_id) open(...)`
// with NO `else` and an EMPTY `catch {}` — so a 500 (thread-create failed) or
// 502 (bridge unreachable) produced TOTAL SILENCE. JD tapped CEO/Project/Domain
// on his phone and the screen was byte-identical: no toast, no spinner-error.
//
// `spawnFailureMessage` is the pure logic the three handlers now call to turn a
// failed response into a JD-facing, retry-able message that DISTINGUISHES the
// bridge-down case (502/503) from a generic failure, and never echoes the dead
// "[object Object]" sentinel. This pins that contract.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { spawnFailureMessage } from '@/lib/utils';

describe('spawnFailureMessage — CAT-05 silent-spawn fix', () => {
  it('502 → bridge-unreachable message (the most common prod failure)', () => {
    const out = spawnFailureMessage(502);
    expect(out).toContain('bridge is unreachable');
    expect(out).toContain('retry');
  });

  it('503 is treated the same as 502 (bridge down)', () => {
    expect(spawnFailureMessage(503)).toContain('bridge is unreachable');
  });

  it('status 0 (network throw, no response) → network-error message', () => {
    const out = spawnFailureMessage(0);
    expect(out).toContain('network error');
    expect(out).toContain('retry');
  });

  it('500 (thread-create failed) → generic "couldn\'t start" message, NOT bridge', () => {
    const out = spawnFailureMessage(500);
    expect(out).toContain("Couldn't start the agent");
    expect(out).not.toContain('bridge is unreachable');
    expect(out).not.toContain('network error');
  });

  it('appends the server error reason as a parenthetical when present', () => {
    const out = spawnFailureMessage(
      500,
      'Failed to create thread: insert violates foreign key constraint [23503]'
    );
    expect(out).toContain('foreign key constraint');
    expect(out).toContain('(');
  });

  it('NEVER echoes the "[object Object]" sentinel even if the server sends it', () => {
    // Belt-and-suspenders: the server-side describeError fix (CAT-06) means the
    // body shouldn't say "[object Object]" anymore, but the client must not
    // surface it regardless.
    const out = spawnFailureMessage(500, '[object Object]');
    expect(out).not.toContain('[object Object]');
    expect(out).toBe("Couldn't start the agent. Tap to retry.");
  });

  it('truncates an overlong server reason so the rail banner stays short', () => {
    const long = 'x'.repeat(400);
    const out = spawnFailureMessage(500, long);
    // The detail is capped (…) so the mobile launcher banner doesn't explode.
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(180);
  });

  it('a null/empty/whitespace server reason produces just the base message', () => {
    expect(spawnFailureMessage(500, null)).toBe(
      "Couldn't start the agent. Tap to retry."
    );
    expect(spawnFailureMessage(500, '')).toBe(
      "Couldn't start the agent. Tap to retry."
    );
    expect(spawnFailureMessage(500, '   ')).toBe(
      "Couldn't start the agent. Tap to retry."
    );
  });

  it('every branch produces a non-empty, retry-prompting string (no silent path)', () => {
    for (const status of [0, 400, 401, 409, 500, 502, 503]) {
      const out = spawnFailureMessage(status);
      expect(out.length).toBeGreaterThan(0);
      expect(out.toLowerCase()).toContain('retry');
    }
  });
});
