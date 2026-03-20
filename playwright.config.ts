/* eslint-disable no-undef */
import { defineConfig } from '@playwright/test';

// See https://playwright.dev/docs/test-configuration.
export default defineConfig({
  outputDir: './e2e-tests/test-results',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  workers: process.env['CI'] ? 1 : 5,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'e2e',
      testDir: './e2e-tests',
      testMatch: '*.spec.ts',
    },
    {
      name: 'e2e-setup',
      testDir: './e2e-tests/setup',
      testMatch: 'setup.ts',
    },
  ],
  timeout: 300 * 1000,
});
