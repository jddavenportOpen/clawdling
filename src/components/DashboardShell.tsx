'use client';

import { useState, useRef, useCallback, useEffect, Suspense } from 'react';
import { Menu, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { usePathname, useSearchParams } from 'next/navigation';
import Sidebar from './Sidebar';

// 2026-05-03 L3 fix — removed the dead `FULL_BLEED_PREFIXES` constant.
// It declared 4 prefixes but `isFullBleed` only checks `/login`. JD's
// product call: every other route keeps the sidebar/vitals bar visible
// so chats feel like views inside the app. The constant misled readers
// into thinking chat / projects / agents were full-bleed.
function isFullBleed(pathname: string | null): boolean {
  if (!pathname) return false;
  if (pathname === '/login' || pathname.startsWith('/login/')) return true;
  // Public marketing + auth/account pages render standalone (no cockpit sidebar).
  if (pathname === '/') return true;
  for (const p of ['/privacy', '/terms', '/onboarding', '/settings']) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  return false;
}

// V3 M8 (mobile cockpit, 2026-05-27): when the /chat cockpit is in grid mode
// (`?panes=…`), on a phone the global app chrome (VitalsBar header, the
// DashboardShell hamburger, the MobileTabBar) competed with the cockpit's OWN
// chrome (the rail-drawer hamburger + pane toolbar). Result on a 390px
// viewport: TWO overlapping hamburgers top-left (the rail toggle was buried
// behind the app menu), the "+ New session" button clipped by the VitalsBar's
// "N live" rail, and a cramped composer. Root-cause fix: on mobile, the
// cockpit goes full-bleed — it owns the viewport so the rail drawer is the one
// top-left control and the composer gets the full bottom edge.
//
// V3 M6 (desktop cockpit chrome, 2026-05-27): EXTEND the same URL signal to
// desktop — when `?panes=…` is set, the global NC sidebar collapses to give
// the cockpit panes more room. The chat surface already has its own rail
// (ThreadSidebar) so the global Sidebar's domain links are redundant chrome
// stealing ~260px of pane real estate. This flag drives the suppression here
// AND in MobileTabBar (which reads the same `?panes=` signal).
//
// Detected purely from the URL so it's SSR-stable and matches the cockpit's
// own URL-is-source-of-truth contract (ChatGrid).
function isMobileCockpit(pathname: string | null, panes: string | null): boolean {
  if (!pathname) return false;
  if (pathname !== '/chat' && !pathname.startsWith('/chat?')) return false;
  return !!(panes && panes.trim().length > 0);
}

// V3 M6 — same URL signal, used on desktop to suppress the global Sidebar.
// Currently identical predicate to isMobileCockpit; kept as a separate name so
// future tweaks (e.g. a "Show nav" toggle) can diverge mobile vs desktop
// without flipping both at once.
function isCockpitGridMode(pathname: string | null, panes: string | null): boolean {
  return isMobileCockpit(pathname, panes);
}

const pageVariants = {
  initial: { opacity: 0, y: 12 },
  enter: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

function usePullToRefresh(ref: React.RefObject<HTMLElement | null>) {
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const startY = useRef(0);
  const isPulling = useRef(false);
  const pullDistRef = useRef(0);

  const THRESHOLD = 80;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      if (el!.scrollTop <= 0) {
        startY.current = e.touches[0].clientY;
        isPulling.current = true;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (!isPulling.current) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta > 0 && el!.scrollTop <= 0) {
        const dist = Math.min(delta * 0.5, 120);
        pullDistRef.current = dist;
        setPulling(true);
        setPullDistance(dist);
        if (delta > 10) e.preventDefault();
      } else {
        isPulling.current = false;
        pullDistRef.current = 0;
        setPulling(false);
        setPullDistance(0);
      }
    }

    function onTouchEnd() {
      if (isPulling.current && pullDistRef.current >= THRESHOLD) {
        window.location.reload();
      }
      isPulling.current = false;
      pullDistRef.current = 0;
      setPulling(false);
      setPullDistance(0);
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [ref]);

  return { pulling, pullDistance, threshold: THRESHOLD };
}

// Reads `?panes=` to decide whether the mobile cockpit is active. Isolated in
// its own component so the useSearchParams() CSR-bailout is contained behind a
// Suspense boundary in the parent (Next 16 requires this or the whole tree
// de-opts to client rendering + the build errors on the missing boundary).
//
// V3 M6: also drives the DESKTOP cockpit-grid signal (`cockpitGrid`). Same URL
// source, different consumer — desktop uses it to collapse the global Sidebar,
// mobile uses it to suppress the hamburger + VitalsBar + tab bar.
function MobileCockpitFlag({
  pathname,
  onChange,
}: {
  pathname: string | null;
  onChange: (mobile: boolean, cockpitGrid: boolean) => void;
}) {
  const searchParams = useSearchParams();
  const panes = searchParams.get('panes');
  const mobile = isMobileCockpit(pathname, panes);
  const cockpitGrid = isCockpitGridMode(pathname, panes);
  useEffect(() => {
    onChange(mobile, cockpitGrid);
  }, [mobile, cockpitGrid, onChange]);
  return null;
}

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileCockpit, setMobileCockpit] = useState(false);
  // V3 M6 — desktop cockpit-grid signal. True whenever /chat has `?panes=…`,
  // independent of viewport size. Drives the global Sidebar's lg:block
  // suppression so the chat panes get the full width.
  const [cockpitGrid, setCockpitGrid] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const { pulling, pullDistance, threshold } = usePullToRefresh(mainRef);
  const pathname = usePathname();
  const handleCockpitChange = useCallback((mobile: boolean, grid: boolean) => {
    setMobileCockpit(mobile);
    setCockpitGrid(grid);
  }, []);

  // Chat / login / session pages render full-bleed — they own their own chrome.
  // NOTE: must be block (not flex) — the login page already uses flex internally
  // to center its form; wrapping it in another flex shrinks it to max-w-sm width.
  if (isFullBleed(pathname)) {
    return (
      <div className="h-screen w-screen bg-void overflow-hidden">
        {children}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-void overflow-hidden">
      <Suspense fallback={null}>
        <MobileCockpitFlag pathname={pathname} onChange={handleCockpitChange} />
      </Suspense>
      {/* V3 M6 — when /chat is in grid mode (?panes=…), the desktop Sidebar
          collapses entirely so the cockpit panes get the full width. The
          mobile drawer overlay is also suppressed: in cockpit mode the
          ThreadSidebar (rail) is the relevant nav, not the global Sidebar.
          `contents` keeps the flex layout flowing through this wrapper when
          the sidebar is shown. */}
      <div className={cockpitGrid ? 'hidden' : 'contents'}>
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Mobile header button — hidden on a phone when the cockpit owns the
          viewport (the rail-drawer hamburger is the single top-left control
          there; see isMobileCockpit). md+ unaffected. */}
      <button
        onClick={() => setSidebarOpen(true)}
        className={`fixed top-4 left-4 z-30 p-2.5 rounded-md bg-surface-2 border border-hairline lg:hidden text-1 hover:bg-surface-3 transition-colors ${
          mobileCockpit ? 'hidden' : ''
        }`}
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <main
          ref={mainRef}
          tabIndex={0}
          className={`flex-1 overflow-y-auto relative md:pb-0 ${
            mobileCockpit ? 'pb-0' : 'pb-20'
          }`}
        >
          {/* Pull-to-refresh indicator */}
          {pulling && (
            <div
              className="flex items-center justify-center transition-all duration-100 pointer-events-none"
              style={{ height: pullDistance }}
            >
              <RefreshCw
                className="w-5 h-5 text-2 transition-transform"
                style={{
                  opacity: Math.min(pullDistance / threshold, 1),
                  transform: `rotate(${(pullDistance / threshold) * 360}deg)`,
                }}
              />
            </div>
          )}

          <AnimatePresence mode="wait">
            <motion.div
              key="page"
              variants={pageVariants}
              initial="initial"
              animate="enter"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="h-full"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
