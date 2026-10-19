import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import { executeCommandById } from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

/** The test vault's folder of plain notes, and what it holds, by name. */
const SOURCES = 'sources';
const SOURCE_NOTES = [
  'Curse of dimensionality - Wikipedia',
  'Memorizing a programming language using spaced repetition software',
  'Security Principles',
];

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('bulk-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // CI runs headed in a smaller window than local runs get
  await window.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test.describe('Bulk import from the review home', () => {
  test('lists the folder picked in the filter bar, imports it, and the queue shows the new articles', async () => {
    await executeCommandById(window, 'incremental-reading:learn');
    const queueRow = (name: string) =>
      window.locator('.ir-queue-row', { hasText: name });
    await expect(window.locator('#begin-review-button')).toBeVisible();
    for (const name of SOURCE_NOTES)
      await expect(queueRow(name)).toHaveCount(0);

    await window.locator('#bulk-import-button').click();

    const modal = window
      .locator('.modal')
      .filter({ has: window.locator('.ir-bulk-import-filter') });
    await expect(modal.locator('.ir-bulk-import-prompt')).toBeVisible();
    await expect(modal.locator('.ir-bulk-import-row')).toHaveCount(0);
    await modal.locator('.ir-bulk-import-folder-input').fill(SOURCES);
    await window
      .locator('.suggestion-container .suggestion-item')
      .filter({ hasText: new RegExp(`^${SOURCES}$`) })
      .click();

    const rows = modal.locator('.ir-bulk-import-row');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(rows.locator('.ir-bulk-import-name')).toHaveText(SOURCE_NOTES);
    await modal.locator('button.mod-cta').click();

    await expect(modal).toHaveCount(0);
    // No refresh asked for: the imports' own change events reach the queue
    for (const name of SOURCE_NOTES)
      await expect(queueRow(name)).toHaveCount(1);
  });
});
