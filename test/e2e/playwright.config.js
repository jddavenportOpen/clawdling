// Cockpit E2E. Runs against the in-memory mock by default (started by
// global-setup on a free port). Point it at a real server with:
//   CLAWDLING_E2E_URL=http://127.0.0.1:4747 CLAWDLING_E2E_TOKEN=<token> npm run e2e
//
// Projects: `desktop` (Chromium, 1440x900) runs every spec except mobile.spec.js. The phone
// checks in mobile.spec.js run twice at 390x844 with touch: in Chromium and in WebKit (what
// iPhone Safari is). WebKit needs `npx playwright install webkit`; without it, set
// CLAWDLING_E2E_WEBKIT=0 to skip that project.
import { defineConfig } from '@playwright/test';

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

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
    headless: true,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /mobile\.spec\.js$/,
      use: {
        browserName: 'chromium',
        channel: process.env.CLAWDLING_E2E_CHANNEL || undefined, // e.g. "chromium" for new-headless Chromium
        viewport: { width: 1440, height: 900 },
      },
    },
    { name: 'phone-chromium', testMatch: /mobile\.spec\.js$/, use: { browserName: 'chromium', ...phone } },
    ...(process.env.CLAWDLING_E2E_WEBKIT === '0' ? [] : [{ name: 'phone-webkit', testMatch: /mobile\.spec\.js$/, use: { browserName: 'webkit', ...phone } }]),
  ],
});
