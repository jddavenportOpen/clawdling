// ═══════════════════════════════════════════════════════════════════════════
// scrollLock.test.ts — CAT-21 regression (nested body-scroll-lock leak).
//
// The old per-overlay capture/restore pattern leaked `overflow:hidden` onto the
// body when two scroll-locking surfaces overlapped: the second lock captured the
// first's `'hidden'` as its "prior" value and restored `'hidden'` on close,
// leaving the page permanently unscrollable. The ref-counted lock must:
//   1. capture the REAL prior overflow exactly once (first lock),
//   2. keep the body locked while ANY holder is active,
//   3. restore the real prior value only when the LAST holder unlocks,
//   4. be idempotent on double-unlock (can't underflow the count).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import { lockBodyScroll, __getLockCount } from '../scrollLock';

beforeEach(() => {
  // Reset to a known-scrollable body before each case.
  document.body.style.overflow = '';
});

describe('scrollLock — ref-counted body lock (CAT-21)', () => {
  it('locks on first acquire and restores the real prior value on release', () => {
    document.body.style.overflow = 'auto'; // a real prior value
    const unlock = lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');
    unlock();
    expect(document.body.style.overflow).toBe('auto');
    expect(__getLockCount()).toBe(0);
  });

  it('nested locks keep the body locked until the LAST releases', () => {
    document.body.style.overflow = ''; // scrollable
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    expect(__getLockCount()).toBe(2);
    expect(document.body.style.overflow).toBe('hidden');

    a(); // first holder releases — still locked by b
    expect(document.body.style.overflow).toBe('hidden');
    expect(__getLockCount()).toBe(1);

    b(); // last holder releases — restored
    expect(document.body.style.overflow).toBe('');
    expect(__getLockCount()).toBe(0);
  });

  it('does NOT leak "hidden": nesting never captures hidden as the prior value', () => {
    // This is the exact CAT-21 failure mode. With the naive pattern, b would
    // capture 'hidden' (set by a) and restore 'hidden' forever.
    document.body.style.overflow = 'scroll';
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    b();
    a();
    // Body is fully restored to the original 'scroll' — never stuck on 'hidden'.
    expect(document.body.style.overflow).toBe('scroll');
    expect(__getLockCount()).toBe(0);
  });

  it('double-unlock is idempotent (cannot underflow the count)', () => {
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    a(); // second call must be a no-op
    expect(__getLockCount()).toBe(1); // only b remains
    expect(document.body.style.overflow).toBe('hidden');
    b();
    expect(__getLockCount()).toBe(0);
  });
});
