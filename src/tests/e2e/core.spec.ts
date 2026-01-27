import test, {
  expect,
  type ElectronApplication,
  _electron as electron,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Tests of core plugin functionality
 */

const appPath = path.resolve('./src/.obsidian-unpacked/main.js');
const vaultPath = path.resolve('./src/tests/test-vault');

// Disable Chromium sandbox on Linux CI (required for GitHub Actions)
const extraArgs =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

let app: ElectronApplication;

test.beforeEach(async () => {
  await fs.rm(path.join(vaultPath, '.obsidian', 'workspace.json'), {
    recursive: true,
    force: true,
  });

  app = await electron.launch({
    args: [
      ...extraArgs,
      appPath,
      'open',
      `obsidian://open?path=${encodeURIComponent(vaultPath)}`,
    ],
  });
});

test.afterEach(async () => {
  await app?.close();
});

test('Can open the review interface by executing the command', async () => {
  const window = await app.firstWindow();

  {
    await window.getByLabel('Open command palette', { exact: true }).click();
    const commandPalette = window.locator(':focus');
    await commandPalette.fill('Incremental Reading: Learn');
    await commandPalette.press('Enter');
  }

  // Verify the tab header for the Incremental Reading view is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental Reading"]')
  ).toBeVisible();
});
