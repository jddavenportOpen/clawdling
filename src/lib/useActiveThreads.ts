// ═══════════════════════════════════════════════════════════════════════════
// useActiveThreads — React hook that polls /api/threads/active and returns
// the set of thread_ids currently running a claude subprocess on the bridge.
//
// (see docs/ARCHITECTURE.md)
//
// Polling cadence:
//   - 5s when document.visibilityState === 'visible' (active tab)
//   - 30s when hidden (background tab — keep latency low-ish on return)
//
// On visibilitychange we tear down the current interval and reinstall the
// other one. We also fetch immediately on becoming visible so the dot lights
// up without waiting a full cycle.
//
// Errors swallowed — sidebar UI degrades gracefully to an empty set.
// `cache: 'no-store'` is set so Next never serves a stale snapshot.
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useEffect, useRef, useState } from 'react';

const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 30_000;

interface ActiveThreadsResponse {
  active_thread_ids?: string[];
  as_of?: string | null;
}

export function useActiveThreads(): Set<string> {
  const [activeSet, setActiveSet] = useState<Set<string>>(() => new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track in-flight fetches so a slow request can't clobber a fresher one.
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchOnce(): Promise<void> {
      const mySeq = ++fetchSeqRef.current;
      try {
        const res = await fetch('/api/threads/active', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as ActiveThreadsResponse;
        if (cancelled || mySeq !== fetchSeqRef.current) return;
        const ids = Array.isArray(body.active_thread_ids)
          ? body.active_thread_ids.filter((x): x is string => typeof x === 'string')
          : [];
        setActiveSet((prev) => {
          // Skip the state churn if nothing changed — keeps React from
          // re-rendering the whole sidebar every 5s for no reason.
          if (prev.size === ids.length && ids.every((id) => prev.has(id))) {
            return prev;
          }
          return new Set(ids);
        });
      } catch {
        // network/tunnel hiccup — leave previous state in place
      }
    }

    function intervalForVisibility(): number {
      if (typeof document === 'undefined') return POLL_VISIBLE_MS;
      return document.visibilityState === 'visible'
        ? POLL_VISIBLE_MS
        : POLL_HIDDEN_MS;
    }

    function installInterval(): void {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
      intervalRef.current = setInterval(fetchOnce, intervalForVisibility());
    }

    function onVisibilityChange(): void {
      installInterval();
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      ) {
        // Fire immediately on regaining focus so the dot updates instantly.
        void fetchOnce();
      }
    }

    // Initial fetch + interval install.
    void fetchOnce();
    installInterval();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      cancelled = true;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, []);

  return activeSet;
}
