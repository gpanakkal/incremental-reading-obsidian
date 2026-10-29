import {
  ARTICLE_DIRECTORY,
  DATA_DIRECTORY,
  DATABASE_FILE_PATH,
} from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  chooseFromMenu,
  executeCommandById,
  finalizeArticleImport,
  openFileInActiveLeaf,
  PDF_FIXTURE_FOLDER,
  PDF_FIXTURE_PATH,
  setNativeMenus,
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

/** The main fixture `scripts/make-pdf-fixtures.mjs` writes. */
const PDF_PATH = PDF_FIXTURE_PATH;

/** The folder copies are imported into. */
const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;

/** What the page-side calls below reach on Obsidian and the plugin. */
type PageApp = {
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            query(sql: string, params?: unknown[]): Record<string, unknown>[];
            mutate(sql: string, params?: unknown[]): Promise<unknown>;
          };
        };
      }
    >;
  };
};

/** Every article row at `reference`. */
const rowsAt = (page: Page, reference: string) =>
  page.evaluate((ref) => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo.query(
      'SELECT id, reference, deleted FROM article WHERE reference = $1',
      [ref]
    );
  }, reference);

const sha256 = async (at: string) =>
  createHash('sha256')
    .update(await fs.readFile(path.join(vaultPath, at)))
    .digest('hex');

/**
 * The path of every file in the vault, sorted, but for the database, which
 * the first write to it creates.
 */
const vaultFiles = (page: Page) =>
  page.evaluate(
    (database) =>
      (
        window as unknown as {
          app: { vault: { getFiles(): { path: string }[] } };
        }
      ).app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => p !== database)
        .sort(),
    DATABASE_FILE_PATH
  );

/**
 * The queue row whose File column is `reference`, as its cell's tooltip reads
 * it.
 */
const queueRow = (page: Page, reference: string) =>
  page.locator('.ir-queue-row').filter({
    has: page.getByRole('cell', { name: reference, exact: true }),
  });

/**
 * Show the file explorer's rows inside `folder`, expanding it and each folder
 * above it that is collapsed. Expanding rather than clicking blindly: a click
 * on a folder already open collapses it.
 */
async function expandFolder(page: Page, folder: string, shown: Locator) {
  const parts = folder.split('/');
  await expect(async () => {
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      const collapsed = page.locator(
        `.nav-folder.is-collapsed > .nav-folder-title[data-path="${at}"]`
      );
      if ((await collapsed.count()) > 0) await collapsed.click();
    }
    await expect(shown.first()).toBeVisible({ timeout: 2_000 });
  }).toPass();
}

/** The file explorer's row for the file at `at`. */
const explorerRow = (page: Page, at: string) =>
  page.locator(`.nav-file-title[data-path="${at}"]`);

/** The import dialog's copy choice: in place, then a copy. */
const copySegments = (page: Page) =>
  page
    .locator('.ir-scheduling-modal > .ir-segments[role="group"]')
    .nth(1)
    .locator(':scope > .ir-segment');

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('pdf-import');
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

test.describe('Importing a PDF', () => {
  test('imports it in place from the command, leaving its bytes alone, into the queue', async () => {
    await setPluginSetting(window, 'copyOnImport', false);
    const before = await sha256(PDF_PATH);
    const filesBefore = await vaultFiles(window);
    await openFileInActiveLeaf(window, PDF_PATH);

    await executeCommandById(window, 'incremental-reading:import-article');
    await expect(window.locator('.ir-scheduling-modal')).toBeVisible();
    await expect(copySegments(window).nth(0)).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await finalizeArticleImport(window);

    await expect
      .poll(() => rowsAt(window, PDF_PATH))
      .toEqual([{ id: expect.any(String), reference: PDF_PATH, deleted: 0 }]);
    // Nothing was copied, or written anywhere else, in the vault either
    expect(await vaultFiles(window)).toEqual(filesBefore);

    await executeCommandById(window, 'incremental-reading:learn');
    await expect(
      window.locator('.ir-queue-row', { hasText: 'PDF fixture' })
    ).toBeVisible();
    await window.locator('css=#begin-review-button').click();
    await expect(
      window.locator('.ir-pdf-article .textLayer').first()
    ).toContainText('Incremental reading');

    expect(await sha256(PDF_PATH)).toBe(before);
  });

  test('offers every import from the file menu, and imports in place', async () => {
    await setNativeMenus(window, false);
    await setPluginSetting(window, 'showAdvancedImportMenuItems', true);

    const fileRow = explorerRow(window, PDF_PATH);
    await expandFolder(window, PDF_FIXTURE_FOLDER, fileRow);
    await chooseFromMenu(window, fileRow, ['Import in place', 'Import a copy']);

    await executeCommandById(window, 'incremental-reading:learn');
    await expect(queueRow(window, PDF_PATH)).toBeVisible();
    // In place: no copy was queued
    await expect(window.locator('.ir-queue-row')).toHaveCount(1);
  });

  test('imports a copy from the file menu and from the copy command', async () => {
    await setNativeMenus(window, false);
    await setPluginSetting(window, 'showAdvancedImportMenuItems', true);

    const fileRow = explorerRow(window, PDF_PATH);
    await expandFolder(window, PDF_FIXTURE_FOLDER, fileRow);
    await chooseFromMenu(window, fileRow, ['Import a copy']);

    const firstCopy = `${ARTICLES}/PDF fixture.pdf`;
    await expandFolder(window, ARTICLES, explorerRow(window, firstCopy));

    await window.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          plugins: {
            plugins: Record<
              string,
              { toggleAdvancedCommands(enable: boolean): void }
            >;
          };
        };
      };
      app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
    });
    await openFileInActiveLeaf(window, PDF_PATH);
    await executeCommandById(window, 'incremental-reading:import-article-copy');

    // A second copy beside the first, named apart from it; the original stays
    const copies = window.locator(
      `.nav-file-title[data-path^="${ARTICLES}/PDF fixture"]`
    );
    await expect(copies.locator('.nav-file-title-content')).toHaveText([
      'PDF fixture',
      /^PDF fixture - /,
    ]);
    await expect(explorerRow(window, PDF_PATH)).toBeVisible();

    // Both copies are queued, and the original is not
    await executeCommandById(window, 'incremental-reading:learn');
    const rows = window.locator('.ir-queue-row');
    await expect(rows).toHaveCount(2);
    await expect(
      rows.filter({ hasText: `${ARTICLES}/PDF fixture` })
    ).toHaveCount(2);
    await expect(queueRow(window, firstCopy)).toBeVisible();
    await expect(queueRow(window, PDF_PATH)).toHaveCount(0);
  });

  test('refuses a .pdf that is not a PDF, with a notice', async () => {
    const fakePath = 'sources/Not really.pdf';
    await fs.writeFile(path.join(vaultPath, fakePath), '# Just a note\n');
    await expect
      .poll(() =>
        window.evaluate(
          (p) =>
            (
              window as unknown as {
                app: { vault: { getFileByPath(p: string): unknown } };
              }
            ).app.vault.getFileByPath(p) !== null,
          fakePath
        )
      )
      .toBe(true);
    const notices = await watchNotices(window);
    await openFileInActiveLeaf(window, fakePath);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect
      .poll(notices)
      .toContainEqual(expect.stringContaining('"Not really.pdf"'));
    expect(await rowsAt(window, fakePath)).toEqual([]);
  });
});
