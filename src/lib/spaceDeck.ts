// ═══════════════════════════════════════════════════════════════════════════
// spaceDeck.ts — spine-backed deck persistence for the /chat cockpit (r-cockpit C2)
//
// THE GAP (chat-cockpit audit §6): the /chat deck (the ordered list of open
// session panes) was localStorage-ONLY. The audit flagged this as "breaks on
// resume" and "no cross-device continuity" — the deck lived in one browser's
// localStorage and vanished if you opened /chat elsewhere or the tab restarted
// at the wrong moment. C2 makes the deck DURABLE: when a Space is active
// (`?space=<id>`), the cockpit reads/writes the deck to the cockpit spine (via
// the server deck route `/api/spaces/[id]/deck`), so the deck survives a bridge
// restart and "leaving the screen", and follows the user across devices.
//
// localStorage stays a write-through CACHE: it's the offline/no-Space fallback
// and gives an instant cold-mount paint before the spine round-trip lands. The
// spine is the SOURCE OF TRUTH when a Space is active; localStorage is the cache.
//
// These are CLIENT-side helpers (the routes own auth + the server-only spine
// secret). They are pure / fetch-thin so they unit-test without a browser.
// ═══════════════════════════════════════════════════════════════════════════

/** The deck cache key family. The legacy global key (no Space) is kept verbatim
 *  for back-compat; a Space-scoped deck gets its own per-Space cache key so two
 *  Spaces don't clobber each other's local cache. */
export const LEGACY_DECK_CACHE_KEY = 'chat-cockpit.last-panes';
export function spaceDeckCacheKey(spaceId: string): string {
  return `chat-cockpit.deck.${spaceId}`;
}

export interface DeckState {
  deck: string[];
  focus: string | null;
}

/** Parse a comma-joined cache value into a clean sid list (mirrors ChatGrid's
 *  parsePanesParam shape: trimmed, non-empty, de-duped, order-preserving). */
export function parseDeckCache(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const sid = part.trim();
    if (sid && !seen.has(sid)) {
      seen.add(sid);
      out.push(sid);
    }
  }
  return out;
}

/** Read the local deck cache for a Space (or the legacy global deck when no
 *  Space). Soft-fails to [] when localStorage is disabled/corrupt. */
export function readDeckCache(spaceId: string | null): string[] {
  try {
    const key = spaceId ? spaceDeckCacheKey(spaceId) : LEGACY_DECK_CACHE_KEY;
    return parseDeckCache(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

/** Write the local deck cache for a Space (or the legacy global deck). The cache
 *  is write-through: the spine is the source of truth when a Space is active, but
 *  the cache gives an instant cold-mount paint + an offline fallback. No-op &
 *  swallow when localStorage is disabled. */
export function writeDeckCache(spaceId: string | null, deck: string[]): void {
  try {
    const key = spaceId ? spaceDeckCacheKey(spaceId) : LEGACY_DECK_CACHE_KEY;
    if (deck.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, deck.join(','));
    }
  } catch {
    /* localStorage disabled — fine, the spine still holds the deck */
  }
}

/**
 * Fetch the server-side (spine-backed) deck for a Space via the server deck route. The
 * route soft-degrades (200 + `degraded:true`) when the spine is down, so we only
 * trust a server deck that wasn't degraded — otherwise the caller keeps its local
 * cache rather than overwriting it with an empty server deck. Returns null on any
 * failure or a degraded response, signaling "fall back to the localStorage cache".
 */
export async function fetchSpaceDeck(
  spaceId: string,
  opts?: { signal?: AbortSignal }
): Promise<DeckState | null> {
  try {
    const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/deck`, {
      method: 'GET',
      cache: 'no-store',
      signal: opts?.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      deck?: unknown;
      focus?: string | null;
      degraded?: boolean;
    };
    // Degraded ⇒ the spine was unreachable; the server deck is an empty
    // placeholder, not truth. Keep the local cache.
    if (data.degraded) return null;
    if (!Array.isArray(data.deck)) return null;
    const deck = (data.deck as unknown[]).filter(
      (s): s is string => typeof s === 'string'
    );
    return { deck, focus: typeof data.focus === 'string' ? data.focus : null };
  } catch {
    return null;
  }
}

/**
 * Persist the deck for a Space to the spine via the server deck route. Fire-and-forget
 * friendly: returns true on a confirmed server persist, false on any soft-degrade
 * (spine down / non-2xx / network). The caller ALWAYS writes the local cache
 * first (write-through), so a false here just means "the spine will re-sync
 * later" — never deck loss.
 */
export async function persistSpaceDeck(
  spaceId: string,
  deck: string[],
  opts?: { focus?: string | null; signal?: AbortSignal }
): Promise<boolean> {
  try {
    const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/deck`, {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deck, focus: opts?.focus ?? null }),
      signal: opts?.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { persisted?: boolean };
    return data.persisted === true;
  } catch {
    return false;
  }
}

/**
 * The cold-mount deck resolution for a Space: prefer the spine's durable deck;
 * fall back to the localStorage cache when the spine is down or has no deck yet.
 * This is the heart of the "deck survives a bridge restart + leaving the screen"
 * contract: the durable deck wins, and on first-ever Space load we SEED the spine
 * from the cache (one-time migration, plan §6 risk #8) so JD never loses the deck
 * he already had locally.
 *
 * Returns { deck, focus, source } where source tells the caller whether the deck
 * came from the durable spine or the local cache (for an honest "restored from
 * spine vs cache" toast).
 */
export async function resolveSpaceDeck(
  spaceId: string,
  opts?: { signal?: AbortSignal }
): Promise<{ deck: string[]; focus: string | null; source: 'spine' | 'cache' }> {
  const cached = readDeckCache(spaceId);
  const server = await fetchSpaceDeck(spaceId, opts);

  if (server && server.deck.length > 0) {
    // Durable deck wins. Refresh the local cache so the next cold mount paints
    // instantly from the same truth.
    writeDeckCache(spaceId, server.deck);
    return { deck: server.deck, focus: server.focus, source: 'spine' };
  }

  // No durable deck (spine down, or first-ever load of this Space). Fall back to
  // the cache. If the spine is reachable (server !== null) but empty AND we DO
  // have a local deck, SEED the spine from the cache — the one-time migration so
  // the deck becomes durable from now on without JD losing it.
  if (server !== null && cached.length > 0) {
    void persistSpaceDeck(spaceId, cached, { focus: cached[0] ?? null });
  }
  return { deck: cached, focus: cached[0] ?? null, source: 'cache' };
}
