import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App } from 'obsidian';
import {
  importArticle,
  openPluginSettings,
  reviewNewCard,
  setPluginSetting,
  watchNotices,
} from './helpers';
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

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
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

/** `data.json` as last written, or null before the plugin first saves. */
async function readPluginData() {
  const dataPath = path.join(
    vaultPath,
    '.obsidian/plugins/incremental-reading/data.json'
  );
  try {
    return JSON.parse(await fs.readFile(dataPath, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** Show the card's answer, grade it Good, and wait for review to move on. */
async function gradeGood(page: Page) {
  await page.getByRole('button', { name: 'Show answer' }).click();
  await page.getByRole('button', { name: /^Good\b/ }).click();
  await expect(page.locator('.ir-review-summary-total')).toBeVisible();
}

/** Undo from the summary, and wait for review to bring the card back. */
async function undoGrade(page: Page) {
  await page.locator('css=#undo-button').click();
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible();
}

/** An undo's notice names the card it ungraded, in quotes, then the grade. */
const UNDO_NOTICE = /"[^"]+" Good\b/;
const IMPORTED = 'Curse of dimensionality - Wikipedia';

test('success notice levels hide confirmations inside review and keep undo and import ones at minimal', async () => {
  const settings = await openPluginSettings(app, window);
  const dropdown = (name: string) =>
    settings
      .locator('.vertical-tab-content .setting-item')
      .filter({
        has: settings
          .locator('.setting-item-name')
          .getByText(name, { exact: true }),
      })
      .getByRole('combobox');
  const inside = dropdown('Inside review');
  const outside = dropdown('Outside review');
  await expect(inside).toHaveValue('all');
  await expect(outside).toHaveValue('all');

  await inside.selectOption({ label: 'None' });
  await outside.selectOption({ label: 'Minimal' });
  await expect.poll(readPluginData).toMatchObject({
    settings: {
      successNoticesInReview: 'none',
      successNoticesOutsideReview: 'minimal',
    },
  });
  await window.evaluate(() =>
    (
      window as unknown as { app: App & { setting: { close(): void } } }
    ).app.setting.close()
  );

  await reviewNewCard(window);
  const notices = await watchNotices(window);

  // None inside review: neither the grade nor its undo says anything
  await gradeGood(window);
  await undoGrade(window);

  // Minimal inside review: the grade is still quiet, its undo is not
  await setPluginSetting(window, 'successNoticesInReview', 'minimal');
  await gradeGood(window);
  await undoGrade(window);
  await expect(
    window.locator('.notice').filter({ hasText: UNDO_NOTICE })
  ).toBeVisible();

  // Minimal outside review: an import still confirms, though inside review
  // would now hide it
  await setPluginSetting(window, 'successNoticesInReview', 'none');
  await importArticle(window, 'sources/Curse of dimensionality - Wikipedia');
  await expect(
    window.locator('.notice').filter({ hasText: `"${IMPORTED}"` })
  ).toBeVisible();

  // Every confirmation seen, in order: the first undo said nothing, nor did
  // either grade (each names its grade, Good, as the undo does)
  expect(
    (await notices()).filter(
      (text) => /\bGood\b/.test(text) || text.includes(IMPORTED)
    )
  ).toEqual([
    expect.stringMatching(UNDO_NOTICE),
    expect.stringContaining(`"${IMPORTED}"`),
  ]);
});
