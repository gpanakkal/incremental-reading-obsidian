import { DATABASE_FILE_PATH } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  finalizeArticleImport,
  openFileInActiveLeaf,
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
const PDF_PATH = 'sources/PDF fixture.pdf';

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
    // Asked for a copy by the setting; a PDF can't be copied yet
    await setPluginSetting(window, 'copyOnImport', true);
    const before = await sha256(PDF_PATH);
    const filesBefore = await vaultFiles(window);
    await openFileInActiveLeaf(window, PDF_PATH);

    await executeCommandById(window, 'incremental-reading:import-article');
    await expect(window.locator('.ir-scheduling-modal')).toBeVisible();
    await expect(copyToggle(window)).toHaveCount(0);
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
    await expect(window.locator('.ir-binary-item')).toContainText(
      'PDF fixture.pdf'
    );

    expect(await sha256(PDF_PATH)).toBe(before);
  });

  test('offers every import but a copy from the file menu, and imports in place', async () => {
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
    await expect(menu.getByText('Import a copy', { exact: true })).toHaveCount(
      0
    );

    await menu.getByText('Import in place', { exact: true }).click();

    await expect
      .poll(() => rowsAt(window, PDF_PATH))
      .toEqual([{ id: expect.any(String), reference: PDF_PATH, deleted: 0 }]);
    expect(await sha256(PDF_PATH)).toBe(before);
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
