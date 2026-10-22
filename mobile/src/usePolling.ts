// Poll while the screen is focused and the app is in the foreground; stop otherwise. Network
// failures back off (2 s, 4 s, 8 s ... 30 s) and are exposed so the screen can show the retry
// banner. One request at a time, never overlapping.

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { backoffMs, toApiError, type ApiError } from './api';

export interface PollState {
  /** The last failure, cleared by the next success. */
  error: ApiError | null;
  /** When the next automatic retry happens (for the banner's countdown), if retrying. */
  retryAt: number | null;
  /** True until the first attempt finishes. */
  loading: boolean;
  /** True while a pull-to-refresh is running. */
  refreshing: boolean;
}

export interface PollControls extends PollState {
  /** Pull-to-refresh: run now and resolve when done. */
  refresh: () => Promise<void>;
  /** Run now without the refreshing spinner (e.g. right after sending). */
  kick: () => void;
}

export function usePolling(task: () => Promise<void>, interval: number | (() => number), enabled = true): PollControls {
  const taskRef = useRef(task);
  taskRef.current = task;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const [state, setState] = useState<PollState>({ error: null, retryAt: null, loading: true, refreshing: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const focused = useRef(false);
  const foreground = useRef(AppState.currentState !== 'background');
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const failures = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const active = () => focused.current && foreground.current && enabledRef.current;

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const run = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    clear();
    const p = (async () => {
      let delay: number;
      try {
        await taskRef.current();
        failures.current = 0;
        if (mounted.current) setState((s) => (s.error || s.loading || s.retryAt ? { ...s, error: null, retryAt: null, loading: false } : s));
        const iv = intervalRef.current;
        delay = typeof iv === 'function' ? iv() : iv;
      } catch (e) {
        const err = toApiError(e);
        failures.current += 1;
        delay = err.retryable ? backoffMs(failures.current) : 15_000;
        if (mounted.current) setState((s) => ({ ...s, error: err, loading: false, retryAt: err.kind === 'auth' ? null : Date.now() + delay }));
        if (err.kind === 'auth') delay = -1; // the connection is being dropped; stop
      } finally {
        inFlight.current = null;
      }
      if (delay >= 0 && mounted.current && active()) timer.current = setTimeout(() => void run(), delay);
    })();
    inFlight.current = p;
    return p;
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (enabledRef.current) void run();
      return () => {
        focused.current = false;
        clear();
      };
    }, [run]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const fg = next === 'active';
      foreground.current = fg || next === 'inactive';
      if (fg && focused.current && enabledRef.current) void run();
      if (next === 'background') clear();
    });
    return () => sub.remove();
  }, [run]);

  useEffect(() => {
    if (enabled && focused.current && !inFlight.current && !timer.current) void run();
    if (!enabled) clear();
  }, [enabled, run]);

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, refreshing: true }));
    try {
      if (inFlight.current) await inFlight.current;
      await run();
    } finally {
      if (mounted.current) setState((s) => ({ ...s, refreshing: false }));
    }
  }, [run]);

  const kick = useCallback(() => {
    if (inFlight.current) {
      // Run again as soon as the current request finishes, so a fresh send is never missed.
      void inFlight.current.then(() => run());
      return;
    }
    void run();
  }, [run]);

  return { ...state, refresh, kick };
}
