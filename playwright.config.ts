import { defineConfig, devices } from '@playwright/test';

// See https://playwright.dev/docs/test-configuration.
export default defineConfig({
  outputDir: './src/tests/e2e-test-results',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  workers: process.env['CI'] ? 2 : 8,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'e2e',
      testDir: './src/tests/e2e',
    },
    {
      name: 'e2e-setup',
      testDir: './src/tests/e2e-setup',
      testMatch: 'setup.ts',
    },
  ],
  timeout: 300 * 1000,
});
