import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  cleanTestVaultsDir,
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  resetUserDataDir,
  shouldCleanup,
} from '../e2e-setup/helpers';

/**
 * Tests of core plugin functionality
 */

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

test.beforeAll(async () => {
  await cleanTestVaultsDir();
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  await resetUserDataDir();
  app = await launchElectron();
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs.rm(vaultPath, { recursive: true, force: true });
  }
});

test('Can open the review interface by executing the command', async () => {
  await window.getByLabel('Open command palette', { exact: true }).click();
  const commandPalette = window.locator(':focus');
  await commandPalette.fill('Incremental Reading: Learn');
  await commandPalette.press('Enter');

  // Verify the tab header for the Incremental Reading view is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental Reading"]')
  ).toBeVisible();
});

test('can import articles from the file explorer context menu', async () => {
  await window
    .locator('div')
    .filter({ hasText: /^sources$/ })
    .nth(1)
    .click();
  await window.getByText('Curse of dimensionality -').click({
    button: 'right',
  });
  await window.getByText('Import article').click();
  await window.getByRole('button', { name: 'Import' }).click();
  await window.getByLabel('Incremental Reading').click();
  await expect(window.locator('body')).toContainText(
    'The effect complicates nearest neighbor search in high dimensional space. It is not possible to quickly reject candidates by using the difference in one coordinate as a lower bound for a distance based on all the dimensions.[^17] [^18]'
  );
});
