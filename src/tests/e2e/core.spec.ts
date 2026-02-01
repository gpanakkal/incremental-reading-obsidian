import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from '../e2e-setup/helpers';

/**
 * Tests of core plugin functionality
 */

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
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

  // Verify the tab header for the review interface is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental Reading"]')
  ).toBeVisible();
});

test('Can open the review interface from the ribbon button', async () => {
  await window.getByLabel('Incremental Reading').click();
  // Verify the tab header for the review interface is visible
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

  await window.getByText('Curse of dimensionality - Wikipedia').click({
    button: 'right',
  });
  await window.getByText('Import article').click();
  await window.getByRole('button', { name: 'Import' }).click();
  await window.getByLabel('Incremental Reading').click();

  // ensure the action bar is visible
  await expect(window.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(
    window.getByText('Curse of dimensionality - Wikipedia').nth(1)
  ).toBeVisible();
});

test('can import articles from the note hamburger menu', async () => {
  await window
    .locator('div')
    .filter({ hasText: /^sources$/ })
    .nth(1)
    .click();

  await window
    .locator('div')
    .filter({
      hasText:
        /^Memorizing a programming language using spaced repetition software$/,
    })
    .nth(1)
    .click();
  await window.getByRole('button', { name: 'More options' }).click();
  await window.getByText('Import article').click();
  await window.getByRole('button', { name: 'Import' }).click();
  await window.getByLabel('Incremental Reading').click();

  // ensure the action bar is visible
  await expect(window.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(
    window
      .getByText(
        'Memorizing a programming language using spaced repetition software'
      )
      .nth(1)
  ).toBeVisible();
});
