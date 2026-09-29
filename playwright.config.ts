import { defineConfig } from '@playwright/test';

// See https://playwright.dev/docs/test-configuration.
export default defineConfig({
  outputDir: './e2e-tests/test-results',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  workers: process.env['CI'] ? 1 : 5,
  retries: process.env['CI'] ? 2 : 0,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Well under the 300s test timeout. The default is 30s, which meant a
    // single missing element burned 30s before reporting — and several of those
    // in one test could push the whole test toward the timeout, where it fails
    // as an opaque "test exceeded" instead of naming the element.
    actionTimeout: 20_000,
  },
  expect: {
    timeout: 15_000,
  },
  projects: [
    {
      name: 'e2e',
      testDir: './e2e-tests',
      testMatch: '*.spec.ts',
      testIgnore: ['mobile.spec.ts', 'embed-engines.spec.ts'],
    },
    // The stylesheet in engines that measure layout differently from Electron's
    // Chromium: WebKit, which Obsidian's iOS app renders with, and Firefox,
    // which measures the same way. No Obsidian needed, only the browsers
    // (`pnpm exec playwright install webkit firefox`).
    {
      name: 'engines-webkit',
      testDir: './e2e-tests',
      testMatch: 'embed-engines.spec.ts',
      use: { browserName: 'webkit' },
    },
    {
      name: 'engines-firefox',
      testDir: './e2e-tests',
      testMatch: 'embed-engines.spec.ts',
      use: { browserName: 'firefox' },
    },
    {
      // The Obsidian Android app on an emulator or device over adb. Needs one
      // attached (`adb devices`) and the APK from
      // scripts/setup-obsidian-android.sh.
      name: 'e2e-android',
      testDir: './e2e-tests',
      testMatch: 'mobile.spec.ts',
    },
    {
      name: 'e2e-setup',
      testDir: './e2e-tests/setup',
      testMatch: 'setup.ts',
    },
  ],
  timeout: 300 * 1000,
});
