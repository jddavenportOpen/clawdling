import { defineConfig } from '@playwright/test';

// The app's web build (npm run export:web) against the mock server, in an iPhone-sized window.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  // Tests are independent (fresh browser context, mock reset). One retry absorbs a browser killed
  // from outside (a shared machine's memory guard does that); a real failure fails twice.
  retries: 1,
  reporter: [['list']],
  outputDir: './results',
  use: {
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
});
