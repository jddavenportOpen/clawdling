// Nerve Center v5 — Service Worker
// Strategy: Network-first for HTML/API, stale-while-revalidate for static.
//
// 2026-05-02 — bumped to v3. Prior versions used cache-first on static
// assets, which meant once clients cached an old `_next/static` chunk they
// would never re-fetch. After enough deploys, those chunks get rotated off
// Vercel and the page hangs forever. This version:
//   - Stops pre-caching the HTML shell (which referenced rotated chunks).
//   - Switches static assets to stale-while-revalidate so updates land.
//   - Aggressively wipes ALL old caches on activate.
//   - Self-unregisters if a `?sw=kill` query is ever appended to a request,
//     giving us an in-band kill switch for stuck users.

// 2026-06-12 — v4. Adds a branded offline shell (/offline.html). The shell is
// fully static with ZERO _next chunk references, so precaching it can never
// reproduce the rotated-chunk hang v3 was built to kill. Navigations that fail
// offline now fall back to it instead of a bare 503.

const CACHE_VERSION = 'v4-2026-06-12';
const RUNTIME_CACHE = `nc-runtime-${CACHE_VERSION}`;
const STATIC_CACHE = `nc-static-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  // Precache ONLY the static offline shell (no _next chunk refs — cannot go
  // stale against a deploy). The real HTML shell must always come from the
  // network so it references the chunks of the live deploy.
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Wipe EVERY cache that's not the current version. Brute force, but
      // this is exactly what stuck users need.
      await Promise.all(
        keys
          .filter((k) => k !== RUNTIME_CACHE && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Kill switch: any client can post {type:'SW_KILL'} or hit a URL with
// ?sw=kill to force the SW to unregister + nuke caches.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SW_KILL') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        await self.registration.unregister();
        const clients = await self.clients.matchAll();
        clients.forEach((c) => c.navigate(c.url));
      })()
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, non-http
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // In-band kill switch: ?sw=kill on any request triggers unregister + reload.
  if (url.searchParams.get('sw') === 'kill') {
    event.respondWith(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        await self.registration.unregister();
        return new Response(
          '<!doctype html><meta http-equiv="refresh" content="0;url=' +
            url.pathname +
            '"><body>Service worker unregistered. Reloading…</body>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      })()
    );
    return;
  }

  // API: network-first, cache fallback for offline read.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response(
            JSON.stringify({ error: 'Offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // Next.js static chunks: stale-while-revalidate. Serve cache for speed,
  // but always go to network in the background so cache stays fresh.
  // Critically: if cache MISS we must hit network — otherwise stale-chunk
  // 404s hang the app forever.
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|gif|woff2?|ttf|ico)$/)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached); // fall back to cached on network error
        // Cache hit: return immediately, refresh in background.
        if (cached) {
          networkPromise.catch(() => {}); // don't crash on bg failure
          return cached;
        }
        // Cache miss: must go to network.
        return networkPromise;
      })()
    );
    return;
  }

  // HTML pages: network-first, cache fallback. Never serve stale HTML
  // unless the network is dead.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(request, clone));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Branded offline shell for navigations (standalone-app UX). The old
        // `caches.match('/')` was effectively always a miss — '/' is never
        // precached and `||` on a pending promise was a latent bug anyway.
        const offline = await caches.match(OFFLINE_URL);
        if (offline) return offline;
        return new Response('Offline', { status: 503 });
      })
  );
});
