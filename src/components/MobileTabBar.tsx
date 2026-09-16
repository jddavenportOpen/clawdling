'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import {
  Inbox, Folder, Bot, Settings,
  MoreHorizontal, X,
  MessageSquare, Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const primaryTabs = [
  { href: '/chat', label: 'Chat', icon: MessageSquare, color: '#00FFE0' },
  { href: '/tasks', label: 'Tasks', icon: Inbox, color: '#00FFE0' },
  { href: '/projects', label: 'Projects', icon: Folder, color: '#00FFE0' },
  { href: '/agents', label: 'Agents', icon: Bot, color: '#00FFE0' },
];

// Convert href like "/chat" -> "chat", "/" -> "home"
const hrefToSlug = (href: string): string => {
  if (href === '/') return 'home';
  return href.replace(/^\//, '').replace(/[\/#]/g, '-') || 'home';
};

const moreTabs = [
  { href: '/workers', label: 'Workers', icon: Zap, color: '#00FFE0' },
  { href: '/settings', label: 'Settings', icon: Settings, color: '#00FFE0' },
];

// V3 M8 (mobile cockpit, 2026-05-27): hide the bottom tab bar when the /chat
// cockpit is in grid mode (`?panes=…`) on a phone, so the pane composer owns
// the bottom edge of the viewport instead of fighting a 64px nav bar. The
// global tab bar reappears the moment JD leaves grid mode (closes the last
// pane → URL drops `?panes=`). Reads the SAME `?panes=` signal DashboardShell
// uses (isMobileCockpit) — single source of truth, the URL.
//
// useSearchParams() forces a CSR bailout, so it's isolated behind a Suspense
// boundary (Next 16 build requirement) — MobileTabBarInner does the real work.
export default function MobileTabBar() {
  return (
    <Suspense fallback={null}>
      <MobileTabBarInner />
    </Suspense>
  );
}

function MobileTabBarInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showMore, setShowMore] = useState(false);

  // In mobile grid mode the cockpit is full-bleed — don't render the tab bar
  // at all (it's md:hidden anyway, so this only affects phones).
  const panes = searchParams.get('panes');
  const inMobileCockpit =
    pathname === '/chat' && !!(panes && panes.trim().length > 0);

  // 2026-05-03 M5 fix — drop the dead `t.href === '/'` ternary. moreTabs
  // never contains a `/` route (CEO is in primaryTabs), so the branch
  // was a no-op fallback that just made the check confusing.
  const activeInMore = moreTabs.some(t => pathname.startsWith(t.href));

  // 2026-05-03 L1 fix — Esc closes the More overlay. Mobile keyboards
  // can be paired (and a few users browse on iPads with hardware
  // keyboards), so consistency with the rest of the modal contract
  // matters. Listener bound only while open. Bound BEFORE the cockpit
  // early-return so the hook order is stable (rules-of-hooks).
  useEffect(() => {
    if (!showMore) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMore(false);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [showMore]);

  if (inMobileCockpit) return null;

  return (
    <>
      {/* More menu overlay */}
      {showMore && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowMore(false)}
          />
          <div className="absolute bottom-20 left-2 right-2 pb-[env(safe-area-inset-bottom)] z-[61]">
            <div className="bg-surface/95 backdrop-blur-xl border border-border-glass rounded-2xl p-3 shadow-2xl">
              <div className="grid grid-cols-4 gap-1">
                {moreTabs.map(({ href, label, icon: Icon, color }) => {
                  // M5 — same dead branch as activeInMore. moreTabs has no '/'.
                  const isActive = pathname.startsWith(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setShowMore(false)}
                      data-testid={`mobile-tab-${hrefToSlug(href)}`}
                      className={cn(
                        'flex flex-col items-center justify-center gap-1 px-1 rounded-xl transition-colors min-h-[48px] py-3',
                        isActive ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                      )}
                    >
                      <Icon
                        className="w-5 h-5"
                        style={{ color: isActive ? color : '#8C939A' }}
                      />
                      <span
                        className="text-[9px] font-mono leading-tight text-center"
                        style={{ color: isActive ? color : '#8C939A' }}
                      >
                        {label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab bar */}
      <nav data-testid="mobile-tab-bar" className="fixed bottom-0 inset-x-0 z-50 md:hidden bg-surface/80 backdrop-blur-xl border-t border-border-glass pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-16">
          {primaryTabs.map(({ href, label, icon: Icon, color }) => {
            const isActive = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                data-testid={`mobile-tab-${hrefToSlug(href)}`}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
                  isActive ? 'opacity-100' : 'opacity-50 hover:opacity-75'
                )}
              >
                <Icon
                  className="w-5 h-5"
                  style={{ color: isActive ? color : 'currentColor' }}
                />
                <span
                  className="text-[10px] font-mono"
                  style={{ color: isActive ? color : 'currentColor' }}
                >
                  {label}
                </span>
              </Link>
            );
          })}

          {/* More button */}
          <button
            onClick={() => setShowMore(!showMore)}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
              (showMore || activeInMore) ? 'opacity-100' : 'opacity-50 hover:opacity-75'
            )}
          >
            {showMore ? (
              <X className="w-5 h-5" style={{ color: '#00FFE0' }} />
            ) : (
              <MoreHorizontal
                className="w-5 h-5"
                style={{ color: activeInMore ? '#00FFE0' : 'currentColor' }}
              />
            )}
            <span
              className="text-[10px] font-mono"
              style={{ color: (showMore || activeInMore) ? '#00FFE0' : 'currentColor' }}
            >
              More
            </span>
          </button>
        </div>
      </nav>
    </>
  );
}
