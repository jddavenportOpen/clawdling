// ═══════════════════════════════════════════════════════════════════════════
// chatChrome — shared z-index + geometry tokens for the mobile /chat cockpit
// chrome (CAT-23, 2026-06-12).
//
// Before: the hamburger trigger, drawer overlay, tab bar, More overlay, popovers
// and modals each hard-coded their own z-index, and ChatGrid reserved a MAGIC
// `pl-14` (56px) tied by hand to the hamburger's exact `left-2 (8px) + w-11
// (44px)` geometry. Change the hamburger size → the reserve silently clips the
// "N chats" label. There was no single owner across the whole stack.
//
// These tokens make the z-stack legible in one place and let the content reserve
// DERIVE from the hamburger geometry instead of a coincidental magic number.
// ═══════════════════════════════════════════════════════════════════════════

// ── z-stack (low → high). Literal Tailwind class strings so the JIT scanner
//    picks them up from THIS file and a single place owns the ordering. ──────
export const Z = {
  /** Open-chats tab strip / cockpit toolbar content (base chrome). */
  chrome: 'z-30',
  /** The fixed hamburger trigger. Raised to the tab-bar tier (was z-40, BELOW
   *  the tab bar + several overlays) so it's never covered by passive chrome;
   *  the drawer overlay (higher) still sits ABOVE it when open, so the X owns
   *  the closed action. */
  hamburger: 'z-50',
  /** Bottom MobileTabBar. */
  tabBar: 'z-50',
  /** The slide-out thread drawer + its backdrop — above the hamburger. */
  drawer: 'z-[55]',
  /** The "More" tab overlay. */
  more: 'z-[60]',
} as const;

// ── hamburger geometry (single source of truth) ─────────────────────────────
// Matches `fixed top-2 left-2 w-11 h-11` in MobileSidebarDrawer. The content
// reserve is the hamburger's right edge + a small gutter, expressed as a
// Tailwind padding step so it tracks the geometry instead of a magic px.
export const HAMBURGER = {
  /** Tailwind left inset class (left-2 = 8px). */
  leftClass: 'left-2',
  /** Tailwind size classes (w-11 h-11 = 44px). */
  sizeClass: 'w-11 h-11',
  /** Tailwind top inset class (top-2 = 8px). */
  topClass: 'top-2',
  /** Left padding the cockpit content must reserve on mobile so it clears the
   *  hamburger: left-2 (8px) + w-11 (44px) + ~4px gutter ≈ 56px → `pl-14`.
   *  Desktop has no hamburger → `md:pl-3`. Derived here so a hamburger resize
   *  is changed in ONE place. */
  contentReserveClass: 'pl-14 md:pl-3',
} as const;
