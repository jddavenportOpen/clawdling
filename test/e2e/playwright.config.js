// Cockpit E2E. Runs against the in-memory mock by default (started by
// global-setup on a free port). Point it at a real server with:
//   CLAWDLING_E2E_URL=http://127.0.0.1:4747 CLAWDLING_E2E_TOKEN=<token> npm run e2e
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  outputDir: './test-results',
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1, // one shared server state; the suite is serial by design
  // One retry absorbs infrastructure flakes on a shared machine (a browser process killed
  // under load); Playwright still reports any test that needed it as "flaky".
  retries: Number(process.env.CLAWDLING_E2E_RETRIES ?? 1),
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.CLAWDLING_E2E_URL,
    browserName: 'chromium',
    channel: process.env.CLAWDLING_E2E_CHANNEL || undefined, // e.g. "chromium" for new-headless Chromium
    headless: true,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
