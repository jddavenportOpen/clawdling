// ═══════════════════════════════════════════════════════════════════════════
// scrollLock — ref-counted body scroll lock (CAT-21, 2026-06-12).
//
// The naive pattern each overlay used independently:
//
//   const prev = document.body.style.overflow;   // capture
//   document.body.style.overflow = 'hidden';      // lock
//   …on close: document.body.style.overflow = prev;   // restore
//
// breaks when TWO scroll-locking surfaces overlap: the second overlay opens
// while the first already set `overflow:'hidden'`, so its `prev` captures
// `'hidden'`. When the SECOND closes (first still open) it restores `'hidden'`
// — fine — but when the FIRST closes it restores whatever IT captured, and the
// ordering can leave the body permanently `overflow:hidden` (unscrollable page)
// OR unlock prematurely while a surface is still open.
//
// Fix: a single shared lock with a reference count. The FIRST lock captures the
// real prior value and applies `overflow:hidden`; nested locks just bump the
// count; the body is only restored to the captured value when the count returns
// to 0. Every overlay calls `lockBodyScroll()` on open and the returned
// `unlock` on close (idempotent — calling it twice is a no-op).
// ═══════════════════════════════════════════════════════════════════════════

let lockCount = 0;
let savedOverflow = '';

/**
 * Lock body scroll (ref-counted). Returns an idempotent `unlock` function;
 * the body is only restored when the LAST holder unlocks. SSR-safe no-op when
 * `document` is unavailable.
 */
export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {};

  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;

  let released = false;
  return function unlock() {
    if (released) return; // idempotent — double-unlock can't underflow the count
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      document.body.style.overflow = savedOverflow;
      savedOverflow = '';
    }
  };
}

/** Test-only: current active lock count. */
export function __getLockCount(): number {
  return lockCount;
}
