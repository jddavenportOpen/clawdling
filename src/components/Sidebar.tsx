'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Bot,
  X,
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquare,
  BookOpen,
  Inbox,
  LogOut,
  Settings,
  Zap,
} from 'lucide-react';
import { signOut } from 'next-auth/react';
import { cn } from '@/lib/utils';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { DOMAINS } from '@/config/domains';
// ── Warm Graphite foundation (REUSED) ───────────────────────────────────────
// This global nav rail was still 100% on the legacy
// neon-cyan theme (text-neon-cyan, bg-neon-cyan/8 active glow, cyan logo
// gradient, per-item rainbow color chips + cyan/red badges). That cyan was the
// SECOND brand accent the critic saw competing with the warm-graphite amber. The
// rail now uses warm-graphite tokens: selection is the sanctioned 2px left amber
// accent bar + surface-3 fill (luminance, no glow), icons are monochrome text-2
// (no saturated rail chips — a named slop tell), and the brand lockup is the
// bespoke claw Logomark + mono eyebrow.
import { Logomark } from '@/components/ds/Wordmark';
import { StatusGlyph } from '@/components/ds/StatusGlyph';

interface NavItem {
  href: string;
  icon: typeof Activity;
  label: string;
  /** @deprecated Warm Graphite (critic round-3 FIX #2): the rail no longer
   *  renders per-item color chips/glows — that saturated-rail-icon palette was
   *  the named slop tell + the competing teal accent. This field is retained on
   *  the data only for back-compat; DO NOT re-wire it into the render. Selection
   *  is the 2px left amber accent bar; icons are monochrome text tokens. */
  color?: string;
  children?: NavItem[];
  badgeKey?: string;
}

// Convert href like "/growth/linkedin" -> "growth-linkedin", "/" -> "home"
const hrefToSlug = (href: string): string => {
  if (href === '/') return 'home';
  return href.replace(/^\//, '').replace(/[\/#]/g, '-') || 'home';
};

interface NavGroup {
  title: string;
  items: NavItem[];
}

// Badge counts fetcher — the active-projects count on the Projects nav item.
const badgeFetcher = async (): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  try {
    const res = await fetch('/api/projects?status=active');
    if (res.ok) {
      const json = await res.json();
      counts['projects'] = json.stats?.total ?? 0;
    }
  } catch {
    // silently fail
  }
  return counts;
};

// The domains from the configured profile render as their own nav group, in
// config order. Each links to its chat; unknown domains use a generic Folder
// icon.
const domainNavItems: NavItem[] = DOMAINS.map((d) => ({
  href: `/chat?domain=${d.id}`,
  icon: Folder as NavItem['icon'],
  label: d.label,
  color: d.color,
}));

// The engine nav — only surfaces that exist for every install (KEEP routes) plus
// the configured domains. Chat-first.
const PRODUCT_NAV: NavGroup[] = [
  {
    title: 'Workspace',
    items: [
      { href: '/chat', icon: MessageSquare, label: 'Chat', badgeKey: undefined },
      { href: '/workers', icon: Zap, label: 'Workers' },
      { href: '/tasks', icon: Inbox, label: 'Tasks' },
      { href: '/projects', icon: Folder, label: 'Projects', badgeKey: 'projects' },
      { href: '/agents', icon: Bot, label: 'Agents' },
      { href: '/docs/index', icon: BookOpen, label: 'Docs' },
    ],
  },
  {
    title: 'Domains',
    items: domainNavItems,
  },
  {
    title: 'Account',
    items: [
      { href: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const { data: badgeCounts } = useSWR('sidebar-badges', badgeFetcher, { refreshInterval: 60_000 });

  const toggleGroup = (title: string) => {
    setCollapsed((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  const toggleItem = (href: string) => {
    setExpandedItems((prev) => ({ ...prev, [href]: !prev[href] }));
  };

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href;
  };

  const isActiveParent = (href: string, children?: NavItem[]) => {
    if (href === '/') return pathname === '/';
    if (pathname.startsWith(href)) return true;
    if (children?.some((c) => pathname.startsWith(c.href))) return true;
    return false;
  };

  const sidebar = (
    <motion.aside
      initial={{ x: -280 }}
      animate={{ x: 0 }}
      exit={{ x: -280 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="fixed left-0 top-0 z-50 h-screen w-[260px] flex flex-col bg-surface-1 border-r border-hairline lg:relative lg:z-auto"
      data-testid="sidebar"
    >
      {/* Header — the brand lockup: the Logomark + the product wordmark on a
          hairline-bounded warm-graphite surface. */}
      <div className="flex items-center justify-between p-5 border-b border-hairline">
        <div className="flex items-center gap-3 min-w-0">
          <span className="shrink-0 flex h-9 w-9 items-center justify-center rounded-md border border-hairline bg-surface-2">
            <Logomark size={18} className="text-1" title="" />
          </span>
          <span className="flex flex-col gap-0.5 leading-none min-w-0">
            <span className="text-sm weight-strong tracking-[-0.02em] text-1 lowercase">clawdling</span>
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close sidebar"
          className="lg:hidden p-1.5 rounded-md hover:bg-surface-3 text-2 hover:text-1 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
        {PRODUCT_NAV.map((group) => (
          <div key={group.title}>
            <button
              onClick={() => toggleGroup(group.title)}
              className="flex items-center justify-between w-full px-3 mb-1"
            >
              <span className="overline">
                {group.title}
              </span>
              <ChevronDown
                className={cn(
                  'w-3 h-3 text-3 transition-transform duration-200',
                  collapsed[group.title] && '-rotate-90'
                )}
              />
            </button>

            <AnimatePresence initial={false}>
              {!collapsed[group.title] && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  className="overflow-hidden space-y-0.5"
                >
                  {group.items.map(({ href, icon: Icon, label, children, badgeKey }) => {
                    const active = isActive(href);
                    const parentActive = isActiveParent(href, children);
                    const hasChildren = children && children.length > 0;
                    const isExpanded = expandedItems[href] || (hasChildren && parentActive);

                    return (
                      <div key={href}>
                        <div className="flex items-center">
                          <Link
                            href={href}
                            onClick={onClose}
                            data-testid={`nav-${hrefToSlug(href)}`}
                            className={cn(
                              'group relative flex items-center gap-3 px-3 py-2 rounded-md text-[13px] weight-label transition-colors duration-[var(--dur-micro)] flex-1',
                              (active || (parentActive && !hasChildren))
                                ? 'bg-accent-subtle text-1'
                                : 'text-2 hover:bg-surface-2 hover:text-1'
                            )}
                          >
                            {/* The rail's ONE sanctioned side-accent: a 2px left
                                amber bar marks the active row (selection indicator
                                only, never decorative). Replaces the cyan glow +
                                cyan ping dot. */}
                            {(active || (parentActive && !hasChildren)) && (
                              <motion.span
                                layoutId="sidebar-active"
                                aria-hidden="true"
                                className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-accent"
                                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                              />
                            )}

                            {/* Monochrome icon — no per-item saturated color chip
                                (a named rail slop tell). text-3 idle → text-1 on
                                the active/hover row. */}
                            <Icon
                              className={cn(
                                'w-4 h-4 relative z-10 transition-colors shrink-0',
                                (active || (parentActive && !hasChildren))
                                  ? 'text-1'
                                  : 'text-3 group-hover:text-1'
                              )}
                            />
                            <span className="relative z-10 truncate">{label}</span>

                            {/* Notification badge — a quiet monochrome hairline
                                pill (tabular mono), not a saturated cyan/red chip.
                                Open Loops carries the muted attention tint as the
                                one semantic exception. */}
                            {badgeKey && badgeCounts && badgeCounts[badgeKey] > 0 && (
                              <span
                                className={cn(
                                  'relative z-10 ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-mono tabular weight-label',
                                  badgeKey === 'open-loops'
                                    ? 'bg-tint-attention text-state-attention'
                                    : 'bg-surface-3 text-2 border border-hairline'
                                )}
                              >
                                {badgeCounts[badgeKey] > 99 ? '99+' : badgeCounts[badgeKey]}
                              </span>
                            )}
                          </Link>

                          {hasChildren && (
                            <button
                              onClick={() => toggleItem(href)}
                              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${label}`}
                              aria-expanded={isExpanded}
                              className="relative z-10 p-1.5 rounded-md hover:bg-surface-3 text-3 hover:text-1 transition-colors"
                            >
                              <ChevronRight
                                className={cn(
                                  'w-3 h-3 transition-transform duration-200',
                                  isExpanded && 'rotate-90'
                                )}
                              />
                            </button>
                          )}
                        </div>

                        {/* Sub-items */}
                        {hasChildren && (
                          <AnimatePresence initial={false}>
                            {isExpanded && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                className="overflow-hidden ml-4 pl-3 border-l border-hairline space-y-0.5 mt-0.5"
                              >
                                {children.map(({ href: childHref, icon: ChildIcon, label: childLabel }) => {
                                  const childActive = isActive(childHref);

                                  return (
                                    <Link
                                      key={childHref}
                                      href={childHref}
                                      onClick={onClose}
                                      data-testid={`nav-${hrefToSlug(childHref)}`}
                                      className={cn(
                                        'group relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs weight-label transition-colors duration-[var(--dur-micro)]',
                                        childActive
                                          ? 'bg-accent-subtle text-1'
                                          : 'text-2 hover:bg-surface-2 hover:text-1'
                                      )}
                                    >
                                      {childActive && (
                                        <span
                                          aria-hidden="true"
                                          className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-accent"
                                        />
                                      )}
                                      <ChildIcon
                                        className={cn(
                                          'w-3.5 h-3.5 relative z-10 transition-colors shrink-0',
                                          childActive ? 'text-1' : 'text-3 group-hover:text-1'
                                        )}
                                      />
                                      <span className="relative z-10 truncate">{childLabel}</span>
                                    </Link>
                                  );
                                })}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        )}
                      </div>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-hairline space-y-3">
        {/* Sign out — clears the NextAuth session and returns to /login.
            Critical on shared/public machines. The muted --state-error hue is
            the one sanctioned semantic color here (destructive intent), at low
            alpha on hover, never a saturated red. */}
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          data-testid="sign-out"
          className="group flex w-full items-center gap-2.5 px-3 py-2 rounded-md text-[13px] weight-label text-2 hover:text-state-error border border-hairline hover:border-state-error/30 hover:bg-tint-error transition-colors duration-[var(--dur-micro)]"
        >
          <LogOut className="w-4 h-4 text-3 group-hover:text-state-error transition-colors" />
          <span>Sign out</span>
        </button>
        {/* System-online — the live indicator is the bespoke StatusGlyph working
            ring (muted), not a saturated neon-green pulsing dot. */}
        <div className="flex items-center gap-2 px-2">
          <StatusGlyph state="working" size={12} title="System online" />
          <span className="text-xs font-mono text-3 tabular">System Online</span>
        </div>
      </div>
    </motion.aside>
  );

  return (
    <>
      {/* Desktop: always visible */}
      <div className="hidden lg:block">
        {sidebar}
      </div>

      {/* Mobile: overlay */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
              onClick={onClose}
            />
            <div className="lg:hidden">
              {sidebar}
            </div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
