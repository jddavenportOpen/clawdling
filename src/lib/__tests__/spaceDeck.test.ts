// ═══════════════════════════════════════════════════════════════════════════
// spaceDeck.test.ts — spine-backed deck persistence helpers (r-cockpit C2)
//
// Pins the contract the cockpit deck relies on: the SPINE is the source of truth
// when a Space is active (durable, survives a bridge restart + leaving the
// screen), localStorage is a write-through CACHE, and EVERYTHING soft-degrades to
// the cache when the spine is down (the deck must keep working off localStorage
// exactly as before). Plus the one-time seed-from-cache migration (plan §6 #8).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseDeckCache,
  spaceDeckCacheKey,
  LEGACY_DECK_CACHE_KEY,
  readDeckCache,
  writeDeckCache,
  fetchSpaceDeck,
  persistSpaceDeck,
  resolveSpaceDeck,
} from '@/lib/spaceDeck';

function resp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

// jsdom in this project's vitest config does NOT wire a working localStorage
// ("localStorage is not available because --localstorage-file was not provided").
// Install a minimal in-memory shim so the deck cache helpers are testable. The
// helpers themselves only touch window.localStorage behind try/catch, so this is
// purely test scaffolding — production uses the browser's real localStorage.
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installLocalStorageShim();
  window.localStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseDeckCache', () => {
  it('trims, drops empties, de-dupes, preserves order', () => {
    expect(parseDeckCache(' a , b ,a, ,c ')).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for null/empty', () => {
    expect(parseDeckCache(null)).toEqual([]);
    expect(parseDeckCache('')).toEqual([]);
  });
});

describe('read/writeDeckCache — per-Space vs legacy key', () => {
  it('a Space deck uses a per-Space key; legacy global deck uses the legacy key', () => {
    writeDeckCache('health', ['a', 'b']);
    writeDeckCache(null, ['x', 'y']);
    expect(window.localStorage.getItem(spaceDeckCacheKey('health'))).toBe('a,b');
    expect(window.localStorage.getItem(LEGACY_DECK_CACHE_KEY)).toBe('x,y');
    expect(readDeckCache('health')).toEqual(['a', 'b']);
    expect(readDeckCache(null)).toEqual(['x', 'y']);
  });
  it('writing an empty deck clears the key', () => {
    writeDeckCache('health', ['a']);
    writeDeckCache('health', []);
    expect(window.localStorage.getItem(spaceDeckCacheKey('health'))).toBeNull();
  });
});

describe('fetchSpaceDeck', () => {
  it('returns the server deck on a clean 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200, { deck: ['a', 'b'], focus: 'a' }));
    await expect(fetchSpaceDeck('health')).resolves.toEqual({ deck: ['a', 'b'], focus: 'a' });
  });
  it('returns null when the server reports degraded (spine down) → caller keeps cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200, { deck: [], degraded: true }));
    await expect(fetchSpaceDeck('health')).resolves.toBeNull();
  });
  it('returns null on a non-2xx / network throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(500, {}));
    await expect(fetchSpaceDeck('health')).resolves.toBeNull();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(fetchSpaceDeck('health')).resolves.toBeNull();
  });
});

describe('persistSpaceDeck', () => {
  it('PUTs deck+focus and returns true when the spine persisted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200, { persisted: true }));
    await expect(persistSpaceDeck('health', ['a'], { focus: 'a' })).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/spaces\/health\/deck$/);
    expect((init as { method: string }).method).toBe('PUT');
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ deck: ['a'], focus: 'a' });
  });
  it('returns false when the spine soft-degraded (persisted:false) — cache still holds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200, { persisted: false }));
    await expect(persistSpaceDeck('health', ['a'])).resolves.toBe(false);
  });
  it('returns false on a network throw (never throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(persistSpaceDeck('health', ['a'])).resolves.toBe(false);
  });
});

describe('resolveSpaceDeck — the cold-mount deck resolution (the heart of C2)', () => {
  it('the DURABLE spine deck WINS and refreshes the cache', async () => {
    window.localStorage.setItem(spaceDeckCacheKey('health'), 'old1,old2');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(200, { deck: ['srv1', 'srv2'], focus: 'srv2' }));
    const out = await resolveSpaceDeck('health');
    expect(out).toEqual({ deck: ['srv1', 'srv2'], focus: 'srv2', source: 'spine' });
    // cache refreshed to the durable truth so the next cold mount paints from it.
    expect(readDeckCache('health')).toEqual(['srv1', 'srv2']);
  });

  it('falls back to the localStorage CACHE when the spine is DOWN (survives a bridge/spine outage)', async () => {
    window.localStorage.setItem(spaceDeckCacheKey('health'), 'c1,c2');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('spine down'));
    const out = await resolveSpaceDeck('health');
    expect(out).toEqual({ deck: ['c1', 'c2'], focus: 'c1', source: 'cache' });
  });

  it('SEEDS the spine from the cache on first-ever Space load (one-time migration)', async () => {
    window.localStorage.setItem(spaceDeckCacheKey('health'), 'm1,m2');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const u = String(url);
      const method = (init as { method?: string } | undefined)?.method ?? 'GET';
      // GET: spine reachable but empty deck (degraded:false). PUT: accept the seed.
      if (method === 'PUT') return Promise.resolve(resp(200, { persisted: true }));
      return Promise.resolve(resp(200, { deck: [], focus: null, degraded: false }));
    });
    const out = await resolveSpaceDeck('health');
    // Returns the cache (no durable deck yet)…
    expect(out).toEqual({ deck: ['m1', 'm2'], focus: 'm1', source: 'cache' });
    // …and fired a PUT to seed the spine from the cache (the migration).
    const putCall = fetchMock.mock.calls.find(
      (c) => ((c[1] as { method?: string } | undefined)?.method ?? 'GET') === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as { body: string }).body)).toMatchObject({ deck: ['m1', 'm2'] });
  });

  it('does NOT seed when the spine is unreachable (no clobbering a real outage)', async () => {
    window.localStorage.setItem(spaceDeckCacheKey('health'), 'x1');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await resolveSpaceDeck('health');
    // Only the GET was attempted; no PUT seed when the spine couldn't be reached.
    const putCalls = fetchMock.mock.calls.filter(
      (c) => ((c[1] as { method?: string } | undefined)?.method ?? 'GET') === 'PUT'
    );
    expect(putCalls).toHaveLength(0);
  });
});
