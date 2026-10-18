import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setNativeMenus } from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
  sourceVaultPath,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

/** Two of the test vault's plain notes, and the folder of fixtures. */
const NOTES = [
  'sources/Curse of dimensionality - Wikipedia.md',
  'sources/Security Principles.md',
];
const FOLDER = 'testing';

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
 * for the menu to go (see `folder-import.spec.ts`).
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

/** How the Files view orders names A to Z (see `src/lib/explorer-order.ts`). */
const byExplorerName = new Intl.Collator(undefined, {
  usage: 'sort',
  sensitivity: 'base',
  numeric: true,
});

/** `name` as the import dialog shows it, without its extension. */
const withoutExtension = (name: string) =>
  name.replace(/^.*\//, '').replace(/\.[^.]*$/, '');

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('selection-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test.describe('Importing a Files-view selection', () => {
  test('imports two selected notes and what a selected folder holds, with one set of options', async () => {
    await setNativeMenus(window, false);
    const folderFiles = (
      await fs.readdir(path.join(sourceVaultPath, FOLDER))
    ).map((name) => `${FOLDER}/${name}`);
    const sources = window.locator('.nav-folder-title[data-path="sources"]');
    if (
      await sources
        .locator('xpath=..')
        .evaluate((el) => el.classList.contains('is-collapsed'))
    ) {
      await sources.click();
    }
    const [first, second] = NOTES.map((note) =>
      window.locator(`.nav-file-title[data-path="${note}"]`)
    );
    const folder = window.locator(`.nav-folder-title[data-path="${FOLDER}"]`);

    // Alt-click adds a row to the selection; Ctrl/Cmd-click opens a tab
    // (Obsidian 1.13.7's file tree `handleItemSelection`, undocumented)
    for (const row of [first, second, folder]) {
      await row.click({ modifiers: ['Alt'] });
    }
    await expect(
      window.locator('.nav-files-container .tree-item-self.is-selected')
    ).toHaveCount(3);
    await chooseFromMenu(window, second, 'Import 3 items…');

    const modal = window
      .locator('.modal')
      .filter({ has: window.locator('.ir-bulk-import') });
    await expect(modal.locator('.modal-title')).toContainText('3');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    const list = modal.locator('.ir-bulk-import-list');
    // The folder first, holding its files, then the notes, as the Files view
    await expect(
      list.locator(
        ':scope > .ir-bulk-import-folder > .ir-bulk-import-folder-title'
      )
    ).toHaveText([FOLDER]);
    await expect(
      list.locator(
        ':scope > .ir-bulk-import-folder .ir-bulk-import-row .ir-bulk-import-name'
      )
    ).toHaveText(
      folderFiles
        .map(withoutExtension)
        .sort((a, b) => byExplorerName.compare(a, b))
    );
    await expect(
      list.locator(':scope > .ir-bulk-import-row .ir-bulk-import-name')
    ).toHaveText(NOTES.map(withoutExtension));
    const total = NOTES.length + folderFiles.length;
    await modal.getByRole('button', { name: `Import ${total}` }).click();

    await expect(modal).toHaveCount(0);
    await expect
      .poll(() => articlePaths(window))
      .toEqual([...NOTES, ...folderFiles].sort());
  });
});
