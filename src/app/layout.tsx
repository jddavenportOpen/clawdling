import type { Metadata, Viewport } from 'next';
// WARM GRAPHITE v6 — Geist Sans + Geist Mono via the npm `geist` package
// (NOT Google Fonts) so the ss02 / slashed-zero stylistic sets survive the
// build. Inter is BANNED as the primary face (the #1 AI-slop type tell);
// Space Grotesk and JetBrains Mono are retired with it. These set the
// `--font-geist-sans` / `--font-geist-mono` CSS vars the v6 token system and
// the `@theme` font mapping (--font-sans/--font-mono/--font-display) read.
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import DashboardShell from '@/components/DashboardShell';
import CommandPalette from '@/components/CommandPalette';
import MobileTabBar from '@/components/MobileTabBar';
import OfflineBanner from '@/components/OfflineBanner';
import NotificationProvider from '@/components/notifications/NotificationProvider';

export const metadata: Metadata = {
  title: 'Clawdling',
  description: 'Your AI chief of staff, in a cockpit you own.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Clawdling',
  },
  other: {
    // Next 15 emits the modern `mobile-web-app-capable` for appleWebApp.capable;
    // iOS < 17.4 only honors the legacy apple- prefixed tag for Add-to-Home-
    // Screen standalone mode. Emit it explicitly (mobile-app-ready, 2026-06-12).
    'apple-mobile-web-app-capable': 'yes',
  },
};

// force-dynamic (app-wide): render every page on-demand instead of statically
// prerendering at build time. This is the correct posture for a single-user,
// auth-gated self-hosted cockpit — nothing here benefits from SSG, and every
// page inherits this root layout's client providers (cmdk command palette +
// framer-motion + notification context). Next 16.2 / React 19 crash when
// statically prerendering pages under a layout that mounts those client
// providers (`Cannot read properties of null (reading 'useState'/'useContext')`
// — the client dispatcher is null during static export; tracked upstream in
// vercel/next.js #85668 / #86178). Opting the whole tree out of static
// prerender sidesteps that path for every page at once, so a newly added page
// can't silently reintroduce the build break.
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  // Warm Graphite canvas (#0c0b0a) — was neon cyan.
  themeColor: '#0c0b0a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  // CAT-07 keystone (2026-06-12): WITHOUT `viewport-fit=cover`, iOS Safari
  // resolves EVERY `env(safe-area-inset-*)` to 0px, silently nullifying all
  // the safe-area handling the mobile-ready pass already wrote
  // (MobileTabBar `pb-[env(safe-area-inset-bottom)]`, the composer's
  // `.composer-safe-bottom`, `.safe-*`). The result: the composer send row +
  // the bottom tab bar sit UNDER the iPhone home indicator, untappable.
  // `public/offline.html` already sets `viewport-fit=cover` — the Next app
  // shell just forgot it. Adding it here activates ~4 files of dormant
  // safe-area code with one line. Maps to the `viewport-fit=cover` meta.
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans bg-canvas text-1">
        <OfflineBanner />
        <DashboardShell>
          {children}
        </DashboardShell>
        <MobileTabBar />
        <CommandPalette />
        {/* Cockpit v1 §7.3 — in-app completion notifications. Mounted ONCE
            here so the bell + toasts are visible on every route, including
            full-bleed chat pages where the dashboard header is hidden. */}
        <NotificationProvider />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Service worker registration — defensive against stuck old SWs.
              //
              // 2026-05-02: discovered the v1 SW used cache-first on
              // /_next/static/* and would deadlock clients after enough
              // chunks rotated off Vercel. New v3 SW fixes that, but only
              // helps clients that can actually load this page in the first
              // place. To recover stuck devices, we now:
              //   1. Force-update any existing registration on every load.
              //   2. Reload once if a NEW SW takes control mid-session.
              //   3. Allow ?nosw=1 query to skip registration entirely (a
              //      truly-stuck device can land via that and break free).
              if ('serviceWorker' in navigator) {
                if (location.search.indexOf('nosw=1') !== -1) {
                  navigator.serviceWorker.getRegistrations().then(function(rs) {
                    rs.forEach(function(r) { r.unregister(); });
                  });
                } else {
                  window.addEventListener('load', function() {
                    navigator.serviceWorker.getRegistrations().then(function(rs) {
                      rs.forEach(function(r) { r.update().catch(function(){}); });
                    });
                    navigator.serviceWorker.register('/sw.js').catch(function(){});
                    var reloaded = false;
                    navigator.serviceWorker.addEventListener('controllerchange', function() {
                      if (reloaded) return;
                      reloaded = true;
                      // A new SW just took over — reload so the fresh
                      // shell + chunks come from network.
                      window.location.reload();
                    });
                  });
                }
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
