// ═══════════════════════════════════════════════════════════════════════════
// vitest.setup.ts — jsdom polyfills + RTL matchers + global mocks.
//
// Loaded for every test (configured in vitest.config.ts). Anything in this
// file is the contract every component test relies on; don't add per-test
// state here or you'll leak between tests.
// ═══════════════════════════════════════════════════════════════════════════

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL doesn't auto-cleanup with vitest globals; do it ourselves so each
// test gets a fresh DOM. Without this, React reconciler state bleeds across
// tests and assertions on `screen.getByX` become flaky.
afterEach(() => {
  cleanup();
  // Reset the captured xterm instances between tests (see the @xterm/xterm
  // mock + the __xtermInstances registry below).
  (globalThis as { __xtermInstances?: unknown[] }).__xtermInstances = [];
});

// ── jsdom polyfills ────────────────────────────────────────────────────────
//
// jsdom doesn't ship these, but components (and xterm.js) lean on them. We
// stub minimal no-op implementations so a render call doesn't throw.

if (typeof window !== 'undefined') {
  // ResizeObserver — xterm fit addon + ChatGrid use it. The implementation
  // doesn't need to actually observe; we just need the constructor to exist
  // so `new ResizeObserver(fn)` doesn't blow up.
  if (!('ResizeObserver' in window)) {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // @ts-expect-error: stubbing onto window
    window.ResizeObserver = MockResizeObserver;
  }

  // matchMedia — Tailwind responsive utility used by ChatGrid / SessionTerminal
  // for the mobile vs desktop split. jsdom doesn't implement it.
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  // scrollIntoView — used by MessageStream / SessionTerminal autoscroll.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
}

// ── Next.js router mock ────────────────────────────────────────────────────
//
// Components import { useRouter, useSearchParams, usePathname } from
// 'next/navigation'. Default to a minimal stub; individual tests can
// override via `vi.mock(...)` for finer control.

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>(
    'next/navigation'
  );
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(''),
    usePathname: () => '/',
  };
});

// ── xterm.js mocks ─────────────────────────────────────────────────────────
//
// xterm requires real browser canvas. We don't test xterm rendering; we test
// the SSE state machine + component logic that drives it. Mock both the core
// Terminal + the fit addon so SessionTerminal's effects can `new Terminal()`
// and `term.write()` without DOM canvas errors.

// A controllable buffer so tests for the TUI-menu detector (fix/cockpit-
// interactive-prompts) can script the visible rows. `__setLines(lines)` sets
// the rendered viewport; getLine returns a {translateToString} matching what
// real xterm yields. Defaults to empty so existing tests see no menu.
// Registry of constructed MockTerminal instances so a test can grab the live
// one the component created (it isn't otherwise exposed). Reset per test in the
// global beforeEach below.
(globalThis as { __xtermInstances?: unknown[] }).__xtermInstances = [];

vi.mock('@xterm/xterm', () => {
  return {
    Terminal: class MockTerminal {
      _lines: string[] = [];
      constructor() {
        ((globalThis as { __xtermInstances?: unknown[] }).__xtermInstances ??=
          []).push(this);
      }
      buffer = {
        active: {
          length: 0,
          viewportY: 0,
          getLine: (y: number) => {
            const text = this._lines[y] ?? '';
            return { translateToString: () => text };
          },
        },
      };
      // Test helper — not part of the real xterm API.
      __setLines(lines: string[]) {
        this._lines = lines;
        this.buffer.active.length = lines.length;
        this.rows = Math.max(this.rows, lines.length);
      }
      write = vi.fn();
      writeln = vi.fn();
      open = vi.fn();
      dispose = vi.fn();
      onData = vi.fn(() => ({ dispose: vi.fn() }));
      onResize = vi.fn(() => ({ dispose: vi.fn() }));
      loadAddon = vi.fn();
      focus = vi.fn();
      scrollToBottom = vi.fn();
      resize = vi.fn();
      reset = vi.fn();
      attachCustomKeyEventHandler = vi.fn();
      // PR #100 (clickable URLs/paths) calls term.registerLinkProvider(...)
      // on construction. Returns IDisposable for cleanup. Stub it.
      registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
      // PR #101 (font tiers) sets term.options.fontSize on prop change.
      options = { fontSize: 12 };
      cols = 80;
      rows = 24;
    },
  };
});

vi.mock('@xterm/addon-fit', () => {
  return {
    FitAddon: class MockFitAddon {
      fit = vi.fn();
      activate = vi.fn();
      dispose = vi.fn();
      proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    },
  };
});

// ── EventSource mock helper ────────────────────────────────────────────────
//
// Tests that need to push SSE frames programmatically import from
// `tests/utils/event-source-mock.ts`. This block just makes sure jsdom
// doesn't have a real EventSource that would race the mock.
if (typeof window !== 'undefined' && 'EventSource' in window) {
  // @ts-expect-error: replace with a controllable mock per-test
  delete window.EventSource;
}
