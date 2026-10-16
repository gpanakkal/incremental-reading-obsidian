import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import { setNativeMenus } from './helpers';
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

/** The test vault's folder of plain notes, and what it holds. */
const SOURCES = 'sources';
const SOURCE_NOTES = [
  'Curse of dimensionality - Wikipedia.md',
  'Memorizing a programming language using spaced repetition software.md',
  'Security Principles.md',
];

/**
 * What the page-side call below reaches on the plugin. Unofficial:
 * `window.app` and `app.plugins.plugins`.
 */
type PageApp = {
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            query(sql: string, params?: unknown[]): Record<string, unknown>[];
          };
        };
      }
    >;
  };
};

/** The path of every live article, sorted. */
const articlePaths = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo
      .query(
        'SELECT reference FROM article WHERE deleted = FALSE ORDER BY reference'
      )
      .map((row) => row.reference as string);
  });

/**
 * Right click `target` until its menu shows `title`, then choose it, and wait
 * for the menu to go. Obsidian's menus animate in, and on a loaded runner the
 * first right click can land before the row takes it, so it is repeated.
 */
async function chooseFromMenu(page: Page, target: Locator, title: string) {
  const menu = page.locator('.menu');
  const item = menu.getByText(title, { exact: true });
  await expect(async () => {
    if ((await menu.count()) === 0) await target.click({ button: 'right' });
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await item.click();
  await expect(menu).toHaveCount(0);
}

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('folder-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    // Best-effort, as in core.spec.ts: a surviving child can hold a handle
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test.describe('Importing from a folder', () => {
  test('lists the folder’s notes, and imports only the ones left ticked', async () => {
    await setNativeMenus(window, false);
    const folderRow = window.locator(
      `.nav-folder-title[data-path="${SOURCES}"]`
    );

    await chooseFromMenu(window, folderRow, 'Import from folder…');

    const modal = window.locator('.modal').filter({
      has: window.locator('.ir-bulk-import'),
    });
    await expect(modal.locator('.modal-title')).toHaveText(
      `Importing from ${SOURCES}`
    );
    const rows = modal.locator('.ir-bulk-import-row');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(rows).toHaveText(SOURCE_NOTES);
    await expect(modal.getByText('3 selected')).toBeVisible();

    const [kept1, kept2, unticked] = SOURCE_NOTES;
    await rows.filter({ hasText: unticked }).getByRole('checkbox').uncheck();
    await expect(modal.getByText('2 selected')).toBeVisible();
    await modal.getByRole('button', { name: 'Import 2' }).click();

    await expect(modal).toHaveCount(0);
    await expect(
      window.locator('.notice', {
        hasText: `2 of 2 imported from ${SOURCES}`,
      })
    ).toBeVisible();
    await expect
      .poll(() => articlePaths(window))
      .toEqual([`${SOURCES}/${kept1}`, `${SOURCES}/${kept2}`]);
  });
});
