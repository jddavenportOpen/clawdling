// ═══════════════════════════════════════════════════════════════════════════
// vitest.config.ts — frontend test runner for the app.
//
// Born 2026-05-27 (audit HIGH #3, cockpit-chat-v3): the bridge has 231 tests
// across 22 files; this app had ~90 lines of pure-util coverage and the
// component files with the most observed bugs in the last 48h had ZERO
// regression tests. This config sets up jsdom + RTL so we can finally test
// the components themselves (SessionTerminal, ChatGrid, ThreadSidebar, etc.)
// without piping through Playwright for every assertion.
//
// Why vitest (not the existing `node --test` runner): JSX/TSX. node:test
// can run pure-util `.ts` via --experimental-strip-types but can't transform
// component files. Vitest + jsdom + RTL is the standard React unit stack.
//
// Pure-util tests written under `node --test` (sse-state.test.ts,
// agent-identity.test.ts) still work — vitest's globals are node:test-compat
// for `test`/`assert`, and the file patterns below pick them up too.
// ═══════════════════════════════════════════════════════════════════════════

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'src/**/*.{test,spec}.{ts,tsx}',
    ],
    // The existing node:test files (sse-state.test.ts, agent-identity.test.ts)
    // use `import test from 'node:test'` which vitest does NOT execute under
    // its own runner — they'll be picked up by the `node --test` invocation
    // those files document. Exclude them here to keep vitest output clean.
    exclude: [
      'node_modules/**',
      '.next/**',
      'src/lib/__tests__/sse-state.test.ts',
      'src/lib/__tests__/agent-identity.test.ts',
    ],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only` is a Next.js build-time marker with no runtime export;
      // vite's import-analysis can't resolve it under the test runner. Alias it
      // to an empty stub so server-only modules (e.g. bridge-client) can be
      // imported directly in unit tests.
      'server-only': path.resolve(__dirname, './test/stubs/server-only.ts'),
    },
  },
});
