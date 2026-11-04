import { expect, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import {
  executeCommandById,
  importArticle,
  openMenuWith,
  openPluginSettings,
  selectParagraph,
  setNativeMenus,
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
  vaultPath = await createVaultCopy('settings-window-modals');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await setNativeMenus(window, false);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

// #region HELPERS

/** The note imported or reviewed below. */
const NOTE_PATH = 'sources/Security Principles.md';

/**
 * Open Settings in its own window (Obsidian 1.13+) and leave it open behind
 * the main window, as the user does before going back to the main window.
 *
 * Opening Settings makes it Obsidian's `activeWindow` (undocumented global,
 * set by its popout modal's `open`). In the e2e browser every window counts
 * as focused, so going back to the main window raises no `focus` event and
 * `activeWindow` stays on Settings: the state in which the plugin's modals
 * went to Settings. Checked here so a run that lost that state can't pass
 * without testing anything.
 */
async function openSettingsBehind(): Promise<Page> {
  const settings = await openPluginSettings(app, window);
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          activeWindow ===
          (window as unknown as { app: { setting: { win: Window | null } } })
            .app.setting.win
      )
    )
    .toBe(true);
  return settings;
}

/** Modals and menus open in `page`'s document. */
const modalsIn = (page: Page) => page.locator('.modal-container');
const menusIn = (page: Page) => page.locator('.menu');

/** Expand the explorer folder holding `NOTE_PATH` and return the note's row. */
async function explorerRowOfNote() {
  const folder = window.locator(
    `.nav-folder-title[data-path="${path.posix.dirname(NOTE_PATH)}"]`
  );
  const row = window.locator(`.nav-file-title[data-path="${NOTE_PATH}"]`);
  await expect(async () => {
    if (!(await row.isVisible())) await folder.click();
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass();
  return row;
}

/** A paragraph of `NOTE_PATH` to extract a snippet or card of. */
const PARAGRAPH =
  'Before we start discussing the different security principles, it is ' +
  'vital to know the adversary against whom we are protecting our assets.';

/** Import `NOTE_PATH` and put review on it. */
async function reviewNote() {
  await importArticle(window, NOTE_PATH.replace(/\.md$/, ''));
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await waitForReviewItem(window);
}

/**
 * Have Obsidian ask before deleting a note, as it does by default (the test
 * vault turns it off). Undocumented: `vault.setConfig`/`saveConfig` and the
 * `promptDelete` key, read from obsidian.asar 1.14.
 */
async function askBeforeDeleting() {
  await window.evaluate(async () => {
    const { vault } = (
      window as unknown as {
        app: {
          vault: {
            setConfig(key: string, value: unknown): void;
            saveConfig(): Promise<void>;
          };
        };
      }
    ).app;
    vault.setConfig('promptDelete', true);
    await vault.saveConfig();
  });
}

// #endregion

test('opens the scheduling modal from the action bar in the main window while Settings is open', async () => {
  await importArticle(window, NOTE_PATH.replace(/\.md$/, ''));
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  await waitForReviewItem(window);
  const settings = await openSettingsBehind();

  await window
    .locator('.workspace-leaf.mod-active .ir-action-bar .ir-scheduling-button')
    .click();

  await expect(
    modalsIn(window).filter({ has: window.locator('.ir-scheduling-modal') })
  ).toBeVisible();
  await expect(modalsIn(settings)).toHaveCount(0);
  // Its keys reach it from the main window: Escape closes it there and
  // leaves Settings open
  await window.keyboard.press('Escape');
  await expect(modalsIn(window)).toHaveCount(0);
  await expect(settings.locator('.vertical-tab-content')).toBeVisible();
});

test('opens the import modal from the file menu in the main window while Settings is open', async () => {
  const row = await explorerRowOfNote();
  const settings = await openSettingsBehind();

  const menu = await openMenuWith(window, row, ['Import article']);
  await menu.getByText('Import article', { exact: true }).click();

  await expect(modalsIn(window)).toBeVisible();
  await expect(modalsIn(settings)).toHaveCount(0);
});

test('opens a queue row menu and the scheduling modal it offers in the main window while Settings is open', async () => {
  await importArticle(window, NOTE_PATH.replace(/\.md$/, ''));
  await executeCommandById(window, 'incremental-reading:learn');
  const cell = window.locator('.ir-queue-row .ir-queue-cell').first();
  await expect(cell).toBeVisible();
  const settings = await openSettingsBehind();

  const menu = await openMenuWith(window, cell, ['Change scheduling…']);
  await expect(menusIn(settings)).toHaveCount(0);
  await menu.getByText('Change scheduling…', { exact: true }).click();

  await expect(
    modalsIn(window).filter({ has: window.locator('.ir-scheduling-modal') })
  ).toBeVisible();
  await expect(modalsIn(settings)).toHaveCount(0);
});

test('opens the card answer modal from selection mode in the main window while Settings is open', async () => {
  await reviewNote();
  await window.getByRole('button', { name: 'Create card' }).click();
  await selectParagraph(window, PARAGRAPH);
  const settings = await openSettingsBehind();

  await window.locator('#confirm-selection-button').click();

  await expect(
    modalsIn(window).filter({ has: window.locator('.ir-card-answer-text') })
  ).toBeVisible();
  await expect(modalsIn(settings)).toHaveCount(0);
});

test('asks to delete the snippet an undo takes back in the main window while Settings is open', async () => {
  await reviewNote();
  await selectParagraph(window, PARAGRAPH);
  await executeCommandById(window, 'incremental-reading:extract-selection');
  const undo = window.locator('css=#undo-button');
  await expect(undo).toBeEnabled();
  await askBeforeDeleting();
  const settings = await openSettingsBehind();

  await undo.click();

  await expect(modalsIn(window)).toBeVisible();
  await expect(modalsIn(settings)).toHaveCount(0);
});
