'use client';

// ═══════════════════════════════════════════════════════════════════════════
// MobileSidebarDrawer — wraps ThreadSidebar in a slide-out drawer on
// mobile (<md). On desktop (>=md) the drawer machinery short-circuits and
// renders ThreadSidebar inline, preserving the original 3-pane layout.
//
// Why: in /chat?panes=… (grid mode) on a phone, ThreadSidebar is hidden by
// the parent layout so the multi-pane cockpit owns the viewport. Without a
// drawer, mobile users have no way to switch threads from inside the grid.
// JD's P2.1 spec: "Sidebar collapses to a hamburger menu + slide-out drawer."
//
// Contract:
//   - On <md: renders a fixed hamburger button (top-left, z-50). Tapping it
//     opens a left-anchored drawer with ThreadSidebar inside. Tapping the
//     backdrop OR pressing Esc closes it. Tapping a thread row inside the
//     sidebar also auto-closes the drawer (delegated via click-capture on
//     the drawer pane — ThreadSidebar uses <Link>s, so we close on any
//     anchor-tag click).
//   - On >=md: renders <ThreadSidebar /> inline; no drawer chrome, no
//     hamburger. Toggling state is a no-op. The parent layout owns the
//     288px column width.
//
// P2.1 cockpit-multi-session-v2 (2026-05-23).
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Menu, PanelLeftOpen, X } from 'lucide-react';
import ThreadSidebar from './ThreadSidebar';
import { lockBodyScroll } from '@/lib/scrollLock';
import { Z } from '@/lib/chatChrome';
import type { DbChatThread } from '@/lib/supabase';

// v3 pane-readability (2026-05-27) — auto-collapse the desktop rail when
// 3+ panes are open. JD msg 8120: "many panes at once appears to work but
// its unreadable when many are together." The 288px rail eats ~30% of a
// laptop viewport; at 3+ panes each pane only gets ~30% width which is
// where xterm text starts wrapping awkwardly. Auto-collapsing reclaims
// 256px (288 − 32) for the panes. Manual pin-open via the toggle button
// overrides for the current session.
const COLLAPSE_AT_PANE_COUNT = 3;
const LS_RAIL_PINNED = 'chat-cockpit.rail-pinned';

interface Props {
  threads: DbChatThread[];
  activeThreadId: string | null;
  initialSpace?: string | null;
}

function countPanes(panesParam: string | null): number {
  if (!panesParam) return 0;
  return panesParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

export default function MobileSidebarDrawer({
  threads,
  activeThreadId,
  initialSpace = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);

  // v3 — desktop rail collapse state. `pinned` is the user-controlled
  // override: when true, rail stays open even at 3+ panes. Hydrated from
  // localStorage so the preference persists across reloads/sessions.
  const searchParams = useSearchParams();
  const panesParam = searchParams.get('panes');
  const paneCount = useMemo(() => countPanes(panesParam), [panesParam]);
  const [pinned, setPinned] = useState<boolean>(false);
  // Hydration guard — read LS only after mount to avoid SSR mismatch.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const raw = window.localStorage.getItem(LS_RAIL_PINNED);
      if (raw === '1') setPinned(true);
    } catch {
      /* LS disabled — keep default */
    }
  }, []);
  const persistPinned = (v: boolean) => {
    setPinned(v);
    try {
      window.localStorage.setItem(LS_RAIL_PINNED, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  // Desktop rail is collapsed when 3+ panes AND user has not pinned it open.
  const desktopCollapsed = paneCount >= COLLAPSE_AT_PANE_COUNT && !pinned;

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Auto-close after a thread link is clicked inside the drawer. ThreadSidebar
  // uses <Link> + buttons that route via Next.js — we detect via event
  // delegation rather than threading a callback down through ThreadSidebar
  // (avoids polluting the desktop API for one mobile feature).
  useEffect(() => {
    if (!open) return;
    const pane = paneRef.current;
    if (!pane) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a');
      if (anchor && pane.contains(anchor)) {
        // Defer close so the navigation fires first.
        setTimeout(() => setOpen(false), 0);
      }
    };
    pane.addEventListener('click', onClick);
    return () => pane.removeEventListener('click', onClick);
  }, [open]);

  // Lock body scroll while drawer is open (prevents iOS rubber-band under
  // the backdrop). CAT-21 (2026-06-12): use the shared ref-counted lock so a
  // second scroll-locking overlay can't leak `overflow:hidden` onto the body
  // permanently (the old capture/restore pattern restored a stale 'hidden').
  useEffect(() => {
    if (!open) return;
    const unlock = lockBodyScroll();
    return unlock;
  }, [open]);

  return (
    <>
      {/* Mobile hamburger trigger — fixed top-left so it sits over the
          ChatGrid toolbar. Hidden on >=md (desktop sidebar is always
          visible). */}
      <button
        type="button"
        aria-label="Open thread sidebar"
        aria-expanded={open}
        data-testid="mobile-sidebar-toggle"
        onClick={() => setOpen(true)}
        // ≥44px touch target (chat-session mobile pass, 2026-06-10): was w-9 h-9
        // (36px) — below the 44px thumb minimum. This control is md:hidden
        // (mobile-only), so the bump never touches desktop.
        // CAT-23 (2026-06-12): z-index sourced from the shared chatChrome `Z`
        // token (raised from z-40 to the tab-bar tier) so the hamburger is never
        // covered by passive chrome and the whole chat z-stack has one owner.
        className={`md:hidden fixed top-2 left-2 ${Z.hamburger} inline-flex items-center justify-center w-11 h-11 rounded-md bg-surface-2/90 border border-border-default text-1 hover:bg-surface-3 active:scale-[0.97] transition-[background-color,transform] duration-[var(--dur-micro)]`}
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile drawer + backdrop. Mounted at all times so the slide
          transition can animate both directions; visibility is gated on
          `open`. Backdrop click closes. */}
      <div
        // CAT-23: drawer overlay sits ABOVE the hamburger (Z.drawer > Z.hamburger)
        // so the open drawer's own X owns the closed-action when open.
        className={`md:hidden fixed inset-0 ${Z.drawer} transition-opacity duration-200 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!open}
      >
        {/* Backdrop */}
        <div
          onClick={() => setOpen(false)}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          data-testid="mobile-sidebar-backdrop"
        />
        {/* Drawer pane — anchored left, slides in/out. Width capped so a
            sliver of the underlying ChatGrid stays visible (drawer-UX
            convention). */}
        <div
          ref={paneRef}
          className={`absolute top-0 left-0 bottom-0 w-[85vw] max-w-[320px] bg-surface-1 border-r border-hairline transform transition-transform duration-[var(--dur-modal)] ease-[var(--ease-drawer)] ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
          style={{ boxShadow: 'var(--shadow-modal)' }}
          role="dialog"
          aria-label="Thread sidebar"
          data-testid="mobile-sidebar-drawer"
        >
          {/* Close button — top-right of the drawer for thumb reach. */}
          <button
            type="button"
            aria-label="Close thread sidebar"
            onClick={() => setOpen(false)}
            // ≥44px touch target (chat-session mobile pass) — drawer is
            // mobile-only so this never affects desktop.
            className="absolute top-2 right-2 z-10 inline-flex items-center justify-center w-11 h-11 rounded-md text-3 hover:text-1 hover:bg-surface-3 active:scale-[0.97] transition-[background-color,color,transform] duration-[var(--dur-micro)]"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="h-full overflow-hidden">
            {/* inDrawer hides the brand-row HeaderClock + reserves right-padding
                so the drawer's close (X) above doesn't overlap it (CAT-12). */}
            <ThreadSidebar threads={threads} activeThreadId={activeThreadId} initialSpace={initialSpace} inDrawer />
          </div>
        </div>
      </div>

      {/* Desktop: ThreadSidebar inline. The drawer above is hidden via
          md:hidden, this is shown md:block so the layout column matches
          the original 3-pane chat page.

          v3 pane-readability (2026-05-27): when 3+ panes are open AND the
          user hasn't pinned the rail, render a thin 32px icon strip
          instead of the 288px sidebar. Clicking the strip's toggle pins
          the rail back open (persists in LS). This reclaims ~256px for
          the cockpit grid so dense xterm content fits without wrapping. */}
      {desktopCollapsed ? (
        <div
          className="hidden md:flex w-8 shrink-0 border-r border-hairline bg-surface-1 flex-col items-center py-2"
          data-testid="rail-collapsed-strip"
        >
          <button
            type="button"
            aria-label="Pin rail open"
            title="Expand thread rail (auto-collapsed at 3+ panes)"
            onClick={() => persistPinned(true)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-3 hover:text-1 hover:bg-surface-3 active:scale-[0.97] transition-[background-color,color,transform] duration-[var(--dur-micro)]"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
          <div className="mt-2 text-[10px] font-mono tabular text-4 [writing-mode:vertical-rl] rotate-180 select-none">
            {paneCount} panes · rail collapsed
          </div>
        </div>
      ) : (
        <div className="hidden md:contents" data-testid="rail-expanded">
          {/* Wrap ThreadSidebar so we can layer in the "unpin" affordance
              when the rail is currently pinned open at 3+ panes. The
              wrapper uses md:contents to preserve the original flex layout
              (the sidebar's own w-72 still controls width). */}
          <div className="hidden md:contents">
            <ThreadSidebar
              threads={threads}
              activeThreadId={activeThreadId}
              initialSpace={initialSpace}
            />
          </div>
          {pinned && paneCount >= COLLAPSE_AT_PANE_COUNT && (
            <button
              type="button"
              aria-label="Auto-collapse rail"
              title="Auto-collapse rail (3+ panes)"
              onClick={() => persistPinned(false)}
              data-testid="rail-unpin"
              className="hidden md:inline-flex fixed top-2 left-[260px] z-30 items-center justify-center w-6 h-6 rounded-md bg-surface-2/90 border border-border-default text-3 hover:text-1 hover:bg-surface-3 active:scale-[0.97] transition-[background-color,color,transform] duration-[var(--dur-micro)]"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </>
  );
}
