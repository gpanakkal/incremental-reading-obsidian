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
const userDataDir = path.resolve('./src/tests/e2e-user-data');

// Disable Chromium sandbox on Linux CI (required for GitHub Actions)
const extraArgs =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

let app: ElectronApplication;

test.beforeEach(async () => {
  await fs.rm(path.join(vaultPath, '.obsidian', 'workspace.json'), {
    recursive: true,
    force: true,
  });

  await fs.rm(path.join(vaultPath, '.obsidian', 'workspace-mobile.json'), {
    recursive: true,
    force: true,
  });

  // Clear the user data directory to reset trusted vaults and other settings
  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.mkdir(userDataDir, { recursive: true });

  app = await electron.launch({
    args: [
      ...extraArgs,
      `--user-data-dir=${userDataDir}`,
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

test('can import articles from the file explorer context menu', async ({
  page,
}) => {
  await page.getByText('Curse of dimensionality -').click({
    button: 'right',
  });
  await page.getByText('Import article').click();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByLabel('Incremental Reading').click();
  await expect(page.locator('body')).toContainText(
    'The effect complicates nearest neighbor search in high dimensional space. It is not possible to quickly reject candidates by using the difference in one coordinate as a lower bound for a distance based on all the dimensions.[^17] [^18]'
  );
});
