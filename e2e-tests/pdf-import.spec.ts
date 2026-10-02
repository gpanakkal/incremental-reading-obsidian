import {
  ARTICLE_DIRECTORY,
  DATA_DIRECTORY,
  DATABASE_FILE_PATH,
} from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createLargePdf,
  executeCommandById,
  finalizeArticleImport,
  openFileInActiveLeaf,
  setNativeMenus,
  setPluginSetting,
  watchFileReads,
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
const PDF_PATH = 'sources/PDF fixture.pdf';

/** The folder copies are imported into. */
const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;

/**
 * The size of the PDF that shows an import reads only its leading bytes: big
 * enough that reading all of it would be slow on a phone.
 */
const LARGE_PDF_BYTES = 20 * 1024 * 1024;

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

/** The reference of every article row, sorted. */
const allReferences = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo
      .query('SELECT reference FROM article ORDER BY reference')
      .map((row) => row.reference as string);
  });

/** The scheduling state of the article row `id`. */
const scheduleOf = (page: Page, id: unknown) =>
  page.evaluate((rowId) => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo.query(
      'SELECT deleted, dismissed, priority, fixed_interval_days FROM article WHERE id = $1',
      [rowId]
    )[0];
  }, id);

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

/** The import dialog's "Make a copy" toggle. */
const copyToggle = (page: Page) =>
  page.locator('.ir-scheduling-modal label', { hasText: 'Make a copy' });

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
    await expect(copyToggle(window).locator('input')).not.toBeChecked();
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
    const before = await sha256(PDF_PATH);

    await window.getByText('sources', { exact: true }).click();
    const fileRow = window.locator(`.nav-file-title[data-path="${PDF_PATH}"]`);
    await fileRow.click({ button: 'right' });
    const menu = window.locator('.menu');
    await expect(
      menu.getByText('Import in place', { exact: true })
    ).toBeVisible();
    await expect(
      menu.getByText('Import a copy', { exact: true })
    ).toBeVisible();

    await menu.getByText('Import in place', { exact: true }).click();

    await expect
      .poll(() => rowsAt(window, PDF_PATH))
      .toEqual([{ id: expect.any(String), reference: PDF_PATH, deleted: 0 }]);
    expect(await sha256(PDF_PATH)).toBe(before);
  });

  test('imports a byte-identical copy from the dialog, and a second, distinctly named one when imported again', async () => {
    await setPluginSetting(window, 'copyOnImport', true);
    const before = await sha256(PDF_PATH);
    await openFileInActiveLeaf(window, PDF_PATH);

    await executeCommandById(window, 'incremental-reading:import-article');
    await expect(copyToggle(window).locator('input')).toBeChecked();
    await finalizeArticleImport(window);

    const firstCopy = `${ARTICLES}/PDF fixture.pdf`;
    await expect.poll(() => allReferences(window)).toEqual([firstCopy]);
    expect(await sha256(firstCopy)).toBe(before);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect.poll(() => allReferences(window)).toHaveLength(2);
    const references = await allReferences(window);
    const secondCopy = references.find((ref) => ref !== firstCopy);
    expect(references).toContain(firstCopy);
    expect(secondCopy?.startsWith(`${ARTICLES}/PDF fixture - `)).toBe(true);
    expect(secondCopy).toMatch(/\/PDF fixture - [a-z0-9]{0,5}\.pdf$/);
    expect(await sha256(secondCopy!)).toBe(before);
    // The original is no article, and is as it was
    expect(await rowsAt(window, PDF_PATH)).toEqual([]);
    expect(await sha256(PDF_PATH)).toBe(before);

    await executeCommandById(window, 'incremental-reading:learn');
    await expect(
      window.locator('.ir-queue-row', { hasText: 'PDF fixture' })
    ).toHaveCount(2);
  });

  test('imports a copy from the file menu and from the copy command', async () => {
    await setNativeMenus(window, false);
    await setPluginSetting(window, 'showAdvancedImportMenuItems', true);
    const before = await sha256(PDF_PATH);

    await window.getByText('sources', { exact: true }).click();
    const fileRow = window.locator(`.nav-file-title[data-path="${PDF_PATH}"]`);
    await fileRow.click({ button: 'right' });
    await window
      .locator('.menu')
      .getByText('Import a copy', { exact: true })
      .click();

    const firstCopy = `${ARTICLES}/PDF fixture.pdf`;
    await expect.poll(() => allReferences(window)).toEqual([firstCopy]);
    expect(await sha256(firstCopy)).toBe(before);

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

    await expect.poll(() => allReferences(window)).toHaveLength(2);
    const secondCopy = (await allReferences(window)).find(
      (ref) => ref !== firstCopy
    );
    expect(secondCopy?.startsWith(`${ARTICLES}/PDF fixture - `)).toBe(true);
    expect(await sha256(secondCopy!)).toBe(before);
    expect(await sha256(PDF_PATH)).toBe(before);
  });

  test('imports a large PDF reading only its leading bytes, never the whole file', async () => {
    const largePath = 'sources/Large PDF.pdf';
    await createLargePdf(
      window,
      largePath,
      await fs.readFile(path.join(vaultPath, PDF_PATH)),
      LARGE_PDF_BYTES
    );
    expect(
      (await fs.stat(path.join(vaultPath, largePath))).size
    ).toBeGreaterThan(LARGE_PDF_BYTES);
    await setNativeMenus(window, false);
    await setPluginSetting(window, 'showAdvancedImportMenuItems', true);
    // Imported from the file menu: opening the PDF in a tab would have the
    // PDF viewer read it too
    const reads = await watchFileReads(window, largePath);

    await window.getByText('sources', { exact: true }).click();
    await window
      .locator(`.nav-file-title[data-path="${largePath}"]`)
      .click({ button: 'right' });
    await window
      .locator('.menu')
      .getByText('Import in place', { exact: true })
      .click();

    await expect
      .poll(() => rowsAt(window, largePath))
      .toEqual([{ id: expect.any(String), reference: largePath, deleted: 0 }]);
    const { fetches, readBinary } = await reads();
    // Electron's file protocol answers a range with only those bytes but a
    // 200; Obsidian's own handler, where it is used, with a 206
    expect(fetches).toEqual([
      { range: 'bytes=0-4', status: expect.any(Number), bodyBytesRead: 5 },
    ]);
    expect([200, 206]).toContain(fetches[0].status);
    expect(readBinary).toBe(0);
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
      .toContainEqual(
        `"Not really.pdf" doesn't hold what its extension says; canceling import`
      );
    expect(await rowsAt(window, fakePath)).toEqual([]);
  });

  test('revives the deleted row of a PDF imported again', async () => {
    await openFileInActiveLeaf(window, PDF_PATH);
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await expect.poll(() => rowsAt(window, PDF_PATH)).toHaveLength(1);
    const [{ id }] = await rowsAt(window, PDF_PATH);

    // Tombstoned, as a fetch that once found no file there would leave it
    await window.evaluate(async (rowId) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate('UPDATE article SET deleted = 1 WHERE id = $1', [
        rowId,
      ]);
    }, id);
    expect(await rowsAt(window, PDF_PATH)).toEqual([
      { id, reference: PDF_PATH, deleted: 1 },
    ]);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect
      .poll(() => rowsAt(window, PDF_PATH))
      .toEqual([{ id, reference: PDF_PATH, deleted: 0 }]);
  });

  test('brings a dismissed, deleted PDF back into the queue on its old schedule', async () => {
    await openFileInActiveLeaf(window, PDF_PATH);
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await expect.poll(() => rowsAt(window, PDF_PATH)).toHaveLength(1);
    const [{ id }] = await rowsAt(window, PDF_PATH);

    // Dismissed, then tombstoned, on a schedule of its own
    await window.evaluate(async (rowId) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate(
        'UPDATE article SET deleted = 1, dismissed = 1, priority = 11, fixed_interval_days = 9 WHERE id = $1',
        [rowId]
      );
    }, id);
    const notices = await watchNotices(window);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect
      .poll(() => scheduleOf(window, id))
      .toEqual({
        deleted: 0,
        dismissed: 0,
        priority: 11,
        fixed_interval_days: 9,
      });
    expect(await notices()).toContain(
      'Restored the article "PDF fixture" to the queue with its earlier schedule'
    );
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(
      window.locator('.ir-queue-row', { hasText: 'PDF fixture' })
    ).toBeVisible();
  });
});
