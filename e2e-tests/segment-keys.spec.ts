import { expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  executeCommandById,
  openNote,
  REVIEW_VIEW_TYPE,
  waitForReviewItem,
} from './helpers';
import { test } from './setup/fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('seg-keys');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

// #region HELPERS

const REVIEW_BAR = `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .ir-review-interface > .ir-action-bar`;

/**
 * Under the review tab's 5s refetch of its item (CURRENT_ITEM_REFETCH_TIME),
 * so a bar that only catches up on the poll fails the wait.
 */
const BAR_TIMEOUT_MS = 4_000;

const modal = () => window.locator('.modal .ir-scheduling-modal');

/** The open modal's strategy segments: priority, then fixed intervals. */
const strategySegments = () =>
  modal()
    .locator(':scope > .ir-segments[role="group"]')
    .first()
    .locator(':scope > button.ir-segment');

/** Expect the strategy segment at `index` pressed, alone, and focused. */
async function expectPressedAndFocused(index: number) {
  for (const i of [0, 1]) {
    await expect(strategySegments().nth(i)).toHaveAttribute(
      'aria-pressed',
      String(i === index)
    );
    await expect(strategySegments().nth(i)).toHaveClass(
      i === index ? /\bis-active\b/ : /^(?!.*\bis-active\b)/
    );
  }
  await expect(strategySegments().nth(index)).toBeFocused();
}

// #endregion

test('Space cycles the strategy segments and Enter on one confirms, in the import and scheduling modals', async () => {
  await openNote(window, 'sources/Security Principles');
  await executeCommandById(window, 'incremental-reading:import-article');
  await expect(modal()).toBeVisible();
  await strategySegments().first().focus();
  await expectPressedAndFocused(0);

  // Left to right, wrapping from the last segment to the first
  await window.keyboard.press('Space');
  await expectPressedAndFocused(1);
  await window.keyboard.press('Space');
  await expectPressedAndFocused(0);
  await window.keyboard.press('Space');
  await expectPressedAndFocused(1);

  await window.keyboard.press('Enter');
  await expect(modal()).toHaveCount(0);

  // Imported on fixed intervals: review shows the interval field
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await waitForReviewItem(window);
  await expect(
    window.locator(`${REVIEW_BAR} .ir-fixed-interval-input`)
  ).toBeVisible();

  const schedulingButton = window.locator(
    `${REVIEW_BAR} .ir-scheduling-button`
  );
  await schedulingButton.click();
  await expect(modal()).toBeVisible();
  // Into the group by the real focus order: back from the field after it
  await modal().locator('.ir-fixed-interval-input').focus();
  await window.keyboard.press('Shift+Tab');
  await expectPressedAndFocused(1);

  await window.keyboard.press('Space');
  await expectPressedAndFocused(0);
  await window.keyboard.press('Enter');
  await expect(modal()).toHaveCount(0);

  // Now on priority scheduling
  await expect(window.locator(`${REVIEW_BAR} .ir-priority-input`)).toBeVisible({
    timeout: BAR_TIMEOUT_MS,
  });
  await expect(
    window.locator(`${REVIEW_BAR} .ir-fixed-interval-input`)
  ).toHaveCount(0, { timeout: BAR_TIMEOUT_MS });

  // Enter on Cancel still cancels, whatever Space picked
  await schedulingButton.click();
  await expect(modal()).toBeVisible();
  await strategySegments().first().focus();
  await window.keyboard.press('Space');
  await expectPressedAndFocused(1);
  await modal()
    .locator('.modal-button-container > button:not(.mod-cta)')
    .focus();
  await window.keyboard.press('Enter');
  await expect(modal()).toHaveCount(0);
  // Long enough for a save the cancel should not have made to show
  await window.waitForTimeout(500);
  await expect(
    window.locator(`${REVIEW_BAR} .ir-priority-input`)
  ).toBeVisible();
  await expect(
    window.locator(`${REVIEW_BAR} .ir-fixed-interval-input`)
  ).toHaveCount(0);
});
