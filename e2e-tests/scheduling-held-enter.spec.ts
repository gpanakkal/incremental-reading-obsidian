import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  executeCommandById,
  importArticle,
  waitForReviewItem,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  E2E_PLUGIN_DATA,
  launchElectron,
  openVault,
  shouldCleanup,
} from './setup/helpers';

/** The double-click guard, on for this spec (the suite's vaults have it off). */
const COOLDOWN_SECONDS = 2;

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('scheduling-held-enter', undefined, false, {
    ...E2E_PLUGIN_DATA,
    settings: {
      ...E2E_PLUGIN_DATA.settings,
      actionCooldownSeconds: COOLDOWN_SECONDS,
    },
  });
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    // Best-effort, as in core.spec.ts: a surviving Electron child on Windows
    // can still hold a handle inside the disposable vault.
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

const schedulingButton = () =>
  window.locator(
    '.workspace-leaf.mod-active .ir-action-bar .ir-scheduling-button'
  );

const schedulingModal = () => window.locator('.modal .ir-scheduling-modal');

test('holding Enter on Confirm closes the scheduling modal once, without reopening it from the button focus returns to', async () => {
  await importArticle(window, 'sources/Security Principles');
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await waitForReviewItem(window);
  // Showing the item armed the guard; wait it out so the button opens
  await window.waitForTimeout(COOLDOWN_SECONDS * 1000 + 100);

  await schedulingButton().focus();
  await window.keyboard.press('Enter');
  await expect(schedulingModal()).toBeVisible();
  await schedulingModal().locator('button.mod-cta').focus();

  // A held key: the first press, then key repeats (Playwright marks a second
  // `down` of a key still down as a repeat)
  await window.keyboard.down('Enter');
  await expect(schedulingModal()).toHaveCount(0);
  // Focus is back on the button the modal was opened from, where the repeats
  // land
  await expect(schedulingButton()).toBeFocused();
  await window.keyboard.down('Enter');
  // Opening a modal is synchronous on the click; this leaves time to see one
  await window.waitForTimeout(300);
  await expect(schedulingModal()).toHaveCount(0);
  await window.keyboard.down('Enter');
  await window.keyboard.up('Enter');
  await window.waitForTimeout(300);
  await expect(schedulingModal()).toHaveCount(0);

  // Held, not broken: once the guard has run out the same button opens it
  await window.waitForTimeout(COOLDOWN_SECONDS * 1000 + 100);
  await schedulingButton().focus();
  await window.keyboard.press('Enter');
  await expect(schedulingModal()).toBeVisible();
});
