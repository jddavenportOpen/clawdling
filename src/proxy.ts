// ═══════════════════════════════════════════════════════════════════════════
// Next.js 16 proxy (formerly middleware) — auth gate for chat-interface-v2.
//
// IMPORTANT: Next 16 renamed this file from `middleware.ts` to `proxy.ts`
// and the export from `middleware()` to `proxy()` / default export.
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md)
//
// Runs before every request matched by `config.matcher`. If the visitor has
// no valid NextAuth session cookie → redirect to /login (carry `?callbackUrl`
// so they land back on what they wanted after signing in).
//
// Kill-switch: if NEXT_AUTH_KILL=1, returns 503 for everything except /login
// (so there's a visible landing page) and the NextAuth routes themselves
// (so we can still log out / revoke).
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { auth } from '@/auth';

export default auth((req) => {
  const { nextUrl, auth: session } = req;
  const path = nextUrl.pathname;

  // Single-user local auth (ADJUTANT_AUTH=single) — self-host default.
  // The edge runtime can't build the Node-side singleUserSession, so short-
  // circuit the gate to allow-all. Without this, req.auth (from the Supabase
  // database-session path) is always null in single mode and every request
  // infinite-redirects to /login. auth-timeout.ts supplies the real session
  // object to Server Components + route handlers on the Node side.
  if (process.env.ADJUTANT_AUTH === 'single') {
    return NextResponse.next();
  }

  // Kill-switch short-circuit — show a minimal 503 page.
  if (process.env.NEXT_AUTH_KILL === '1'
      && !path.startsWith('/login')
      && !path.startsWith('/api/auth')) {
    return new NextResponse('App is temporarily disabled.', { status: 503 });
  }

  // Unauthenticated: redirect to /login unless already there or on auth APIs.
  if (!session?.user) {
    if (
      path === '/' ||
      path.startsWith('/login') ||
      path.startsWith('/privacy') ||
      path.startsWith('/terms') ||
      path.startsWith('/api/auth')
    ) {
      return NextResponse.next();
    }
    const login = new URL('/login', nextUrl);
    // Preserve where the user was going so we can bounce back after sign-in.
    if (path !== '/') login.searchParams.set('callbackUrl', path + (nextUrl.search || ''));
    return NextResponse.redirect(login);
  }

  // Signed in but on /login → send them into the app (not the marketing root).
  if (session?.user && path.startsWith('/login')) {
    return NextResponse.redirect(new URL('/chat', nextUrl));
  }

  return NextResponse.next();
});

// Match everything except static assets + Next internals.
// Keep this list conservative — RSC requests, images, fonts must slip through
// to avoid double-trip latency.
export const config = {
  matcher: [
    // Run on all paths except:
    //  - _next/* (Next internals, chunks, images)
    //  - favicon / apple-touch-icon / robots / manifest
    //  - offline.html (static PWA offline shell — sw.js precaches it on
    //    install; if auth-gated, an unauthenticated SW would cache the
    //    login page as the "offline shell". Zero data, safe to be public.)
    //  - api/auth/* (handled by NextAuth itself)
    //  - any asset-like extension on the URL
    '/((?!_next/|favicon\\.ico|apple-touch-icon|robots\\.txt|manifest\\.webmanifest|offline\\.html|api/auth/|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|woff2?)).*)',
  ],
};
