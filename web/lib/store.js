// A tiny global store: one immutable state object, shallow-merged updates,
// and a selector hook that re-renders a component only when its slice changes.
import { useEffect, useReducer, useRef } from 'preact/hooks';

let state = {};
const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  if (!next) return;
  let changed = false;
  for (const k in next) {
    if (state[k] !== next[k]) { changed = true; break; }
  }
  if (!changed) return;
  state = { ...state, ...next };
  for (const fn of [...listeners]) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

export function useStore(selector, eq = shallowEqual) {
  const [, force] = useReducer((c) => c + 1, 0);
  const sel = useRef(selector);
  sel.current = selector;
  const value = selector(state);
  const last = useRef(value);
  last.current = value;
  useEffect(() => subscribe((s) => {
    const next = sel.current(s);
    if (!eq(next, last.current)) {
      last.current = next;
      force();
    }
  }), []);
  return value;
}
