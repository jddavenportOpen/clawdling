// ═══════════════════════════════════════════════════════════════════════════
// cockpitMode.test.ts — V3.2 chat-mode vs pane-mode contract.
//
// Born 2026-05-28 (Cockpit V3.2, JD msgs 8280 + 8285). Two regression guards:
//   1. resolveInitialMode precedence (URL > storage > default).
//   2. parseModeParam silently coerces junk to the default — a typo'd URL
//      never wedges the UI.
//
// jsdom 29 deliberately omits localStorage from `window`; the in-memory shim
// matches the one in clickMode.test.ts (preserved here for round-trip tests
// of getStoredMode / setStoredMode).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  LS_COCKPIT_MODE,
  DEFAULT_MODE,
  parseModeParam,
  getStoredMode,
  setStoredMode,
  resolveInitialMode,
} from '../cockpitMode';

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
  };
}

let originalLocalStorage: Storage | undefined;

beforeAll(() => {
  // @ts-expect-error — descriptor may be undefined on jsdom 29
  originalLocalStorage = window.localStorage;
  Object.defineProperty(window, 'localStorage', {
    value: makeMemoryStorage(),
    configurable: true,
    writable: true,
  });
});

afterAll(() => {
  if (originalLocalStorage === undefined) {
    // @ts-expect-error — restore by removing the property entirely
    delete window.localStorage;
  } else {
    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
  }
});

describe('parseModeParam — URL value coercion', () => {
  it('returns chat for the explicit "chat" value', () => {
    expect(parseModeParam('chat')).toBe('chat');
  });
  it('returns pane for the explicit "pane" value', () => {
    expect(parseModeParam('pane')).toBe('pane');
  });
  it('falls back to DEFAULT_MODE for null/undefined', () => {
    expect(parseModeParam(null)).toBe(DEFAULT_MODE);
    expect(parseModeParam(undefined)).toBe(DEFAULT_MODE);
  });
  it('falls back to DEFAULT_MODE for junk values', () => {
    expect(parseModeParam('grid')).toBe(DEFAULT_MODE);
    expect(parseModeParam('CHAT')).toBe(DEFAULT_MODE); // case-sensitive on purpose
    expect(parseModeParam('')).toBe(DEFAULT_MODE);
  });
});

describe('getStoredMode / setStoredMode — localStorage round-trip', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns DEFAULT_MODE when nothing is stored', () => {
    expect(getStoredMode()).toBe(DEFAULT_MODE);
  });

  it('round-trips chat and pane values', () => {
    setStoredMode('pane');
    expect(getStoredMode()).toBe('pane');
    setStoredMode('chat');
    expect(getStoredMode()).toBe('chat');
  });

  it('falls back to DEFAULT_MODE when storage holds a junk value', () => {
    window.localStorage.setItem(LS_COCKPIT_MODE, 'not-a-mode');
    expect(getStoredMode()).toBe(DEFAULT_MODE);
  });
});

describe('resolveInitialMode — URL > storage > default precedence', () => {
  it('returns URL value when present and valid', () => {
    expect(resolveInitialMode('chat', 'pane')).toBe('chat');
    expect(resolveInitialMode('pane', 'chat')).toBe('pane');
  });

  it('falls through to storage when URL is null/junk', () => {
    expect(resolveInitialMode(null, 'pane')).toBe('pane');
    expect(resolveInitialMode(undefined, 'pane')).toBe('pane');
    expect(resolveInitialMode('grid', 'pane')).toBe('pane'); // junk URL
  });

  it('falls through to default when both URL and storage are missing/junk', () => {
    expect(resolveInitialMode(null, null)).toBe(DEFAULT_MODE);
    expect(resolveInitialMode(null, undefined)).toBe(DEFAULT_MODE);
    // @ts-expect-error — runtime guards against junk storage values
    expect(resolveInitialMode('grid', 'grid')).toBe(DEFAULT_MODE);
  });

  it('the literal "chat" URL still wins over a stored "pane" — defaults are explicit', () => {
    // Edge case: a bookmark with ?mode=chat MUST land in chat mode, even if
    // the user's stored pref is pane. The URL is the source of truth on
    // initial render — matches the existing ?panes= precedence contract.
    expect(resolveInitialMode('chat', 'pane')).toBe('chat');
  });
});

describe('DEFAULT_MODE — JD directive 8280', () => {
  it("is 'chat' (not 'pane') — pane is opt-in", () => {
    expect(DEFAULT_MODE).toBe('chat');
  });
});
