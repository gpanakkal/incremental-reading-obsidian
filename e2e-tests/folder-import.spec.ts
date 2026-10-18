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
 * `SOURCE_NOTES`, newest modified first: neither name order nor its reverse,
 * so only a list that follows the times comes out this way.
 */
const NEWEST_FIRST = [SOURCE_NOTES[1], SOURCE_NOTES[0], SOURCE_NOTES[2]];

/** `name` as the import dialog shows it, without its extension. */
const withoutExtension = (name: string) => name.replace(/\.[^.]*$/, '');

/**
 * What setting the explorer's order reaches. Unofficial: `window.app`, and
 * the explorer view's `setSortOrder`, which its sort menu calls.
 */
type ExplorerApp = {
  workspace: {
    getLeavesOfType(type: 'file-explorer'): {
      loadIfDeferred(): Promise<void>;
      view: { setSortOrder(order: string): void };
    }[];
  };
};

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
 * The names of the files the file explorer lists directly in `folder`, top to
 * bottom. The folder must be expanded.
 */
const explorerFileNames = (page: Page, folder: string) =>
  page
    .locator(`.nav-folder-title[data-path="${folder}"]`)
    .locator('xpath=..')
    .locator(':scope > .nav-folder-children > .nav-file > .nav-file-title')
    .evaluateAll((titles) =>
      titles.map((title) =>
        (title.getAttribute('data-path') ?? '').replace(/^.*\//, '')
      )
    );

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

/** A folder of nested files, two levels deep, built by `buildNested`. */
const NESTED = 'nested';

/**
 * Fill `NESTED` with notes, a PDF and files that can't be imported, some
 * folders deep, through the vault so Obsidian knows of them at once.
 * Unofficial: `window.app`.
 */
const buildNested = (page: Page) =>
  page.evaluate(
    async ({ root, pdf }) => {
      type Vault = {
        createFolder(path: string): Promise<unknown>;
        create(path: string, data: string): Promise<unknown>;
        copy(file: unknown, path: string): Promise<unknown>;
        getFileByPath(path: string): unknown;
      };
      const { vault } = (window as unknown as { app: { vault: Vault } }).app;
      for (const folder of ['', '/Alpha', '/Alpha/Deep', '/Beta', '/Empty']) {
        await vault.createFolder(`${root}${folder}`);
      }
      const notes = [
        'root.md',
        'Alpha/a1.md',
        'Alpha/Deep/d1.md',
        'Beta/b1.md',
      ];
      for (const note of notes) {
        await vault.create(
          `${root}/${note}`,
          `# ${note}

Some text.`
        );
      }
      // Not importable: listed nowhere, and a folder of only these neither
      await vault.create(`${root}/Alpha/data.json`, '{}');
      await vault.create(`${root}/Empty/readme.txt`, 'Nothing here.');
      await vault.copy(vault.getFileByPath(pdf), `${root}/Alpha/paper.pdf`);
    },
    { root: NESTED, pdf: 'testing/PDF fixture.pdf' }
  );

/** The bulk import dialog. */
const bulkModal = (page: Page) =>
  page.locator('.modal').filter({ has: page.locator('.ir-bulk-import') });

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('folder-import');
  // Hours apart, newest first as `NEWEST_FIRST` lists them, before Obsidian
  // reads them
  const now = Date.now() / 1000;
  await Promise.all(
    NEWEST_FIRST.map((name, i) => {
      const time = now - (i + 1) * 3600;
      return fs.utimes(path.join(vaultPath, SOURCES, name), time, time);
    })
  );
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
    await expect(modal.locator('.modal-title')).toContainText(SOURCES);
    const rows = modal.locator('.ir-bulk-import-row');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(rows.locator('.ir-bulk-import-name')).toHaveText(
      SOURCE_NOTES.map(withoutExtension)
    );
    await expect(modal.locator('.ir-bulk-import-count')).toHaveText(/^3\b/);

    const [kept1, kept2, unticked] = SOURCE_NOTES;
    await rows
      .filter({ hasText: withoutExtension(unticked) })
      .getByRole('checkbox')
      .uncheck();
    await expect(modal.locator('.ir-bulk-import-count')).toHaveText(/^2\b/);
    await modal.getByRole('button', { name: 'Import 2' }).click();

    await expect(modal).toHaveCount(0);
    await expect(
      window
        .locator('.notice', { hasText: '2 of 2' })
        .filter({ hasText: SOURCES })
    ).toBeVisible();
    await expect
      .poll(() => articlePaths(window))
      .toEqual([`${SOURCES}/${kept1}`, `${SOURCES}/${kept2}`]);
  });

  test('lists the folder’s notes in the order the file explorer shows them', async () => {
    await setNativeMenus(window, false);
    await window.evaluate(async () => {
      const { app } = window as unknown as { app: ExplorerApp };
      const [leaf] = app.workspace.getLeavesOfType('file-explorer');
      await leaf.loadIfDeferred();
      leaf.view.setSortOrder('byModifiedTime');
    });
    const folderRow = window.locator(
      `.nav-folder-title[data-path="${SOURCES}"]`
    );
    const folderItem = folderRow.locator('xpath=..');
    if (
      await folderItem.evaluate((el) => el.classList.contains('is-collapsed'))
    ) {
      await folderRow.click();
    }
    await expect(folderItem).not.toHaveClass(/is-collapsed/);
    await expect
      .poll(() => explorerFileNames(window, SOURCES))
      .toEqual(NEWEST_FIRST);

    await chooseFromMenu(window, folderRow, 'Import from folder…');

    const modal = window.locator('.modal').filter({
      has: window.locator('.ir-bulk-import'),
    });
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(
      modal.locator('.ir-bulk-import-row .ir-bulk-import-name')
    ).toHaveText(
      (await explorerFileNames(window, SOURCES)).map(withoutExtension)
    );
  });

  test('with subfolders included, lists everything under the folder as a tree, and imports it', async () => {
    await setNativeMenus(window, false);
    await buildNested(window);
    const folderRow = window.locator(
      `.nav-folder-title[data-path="${NESTED}"]`
    );

    await chooseFromMenu(window, folderRow, 'Import from folder…');

    const modal = bulkModal(window);
    const rows = modal.locator('.ir-bulk-import-row');
    const names = rows.locator('.ir-bulk-import-name');
    const folders = modal.locator('.ir-bulk-import-folder');
    const include = modal.locator('label', { hasText: 'Include subfolders' });
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(names).toHaveText(['root']);
    await expect(include.locator('input')).not.toBeChecked();

    await include.click();

    await expect(include.locator('input')).toBeChecked();
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    // Top to bottom as the Files view lists them, each folder's subfolders
    // then its files; the folder holding nothing to import is gone
    await expect(
      modal.locator('.ir-bulk-import-folder-title .ir-bulk-import-name')
    ).toHaveText(['Alpha', 'Deep', 'Beta']);
    await expect(names).toHaveText(['d1', 'a1', 'paper', 'b1', 'root']);
    // Only the PDF is tagged with its type, as in the Files view
    await expect(modal.locator('.ir-bulk-import-tag')).toHaveCount(1);
    await expect(
      rows.filter({ hasText: /^paper/ }).locator('.ir-bulk-import-tag')
    ).toHaveText(/^pdf$/i);
    const alpha = folders.filter({ hasText: /^Alpha/ });
    await expect(
      alpha.locator('.ir-bulk-import-folder').locator('.ir-bulk-import-name')
    ).toHaveText(['Deep', 'd1']);
    await expect(modal.locator('.ir-bulk-import-count')).toHaveText(/^5\b/);

    await include.click();

    await expect(include.locator('input')).not.toBeChecked();
    await expect(folders).toHaveCount(0);
    await expect(names).toHaveText(['root']);
    await expect(modal.locator('.ir-bulk-import-count')).toHaveText(/^1\b/);
    await modal.getByRole('button', { name: 'Import 1' }).click();

    await expect(modal).toHaveCount(0);
    await expect
      .poll(() => articlePaths(window))
      .toEqual([`${NESTED}/root.md`]);

    // Again, with subfolders: what is under it, and nothing already imported
    await chooseFromMenu(window, folderRow, 'Import from folder…');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await include.click();
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(names).toHaveText(['d1', 'a1', 'paper', 'b1']);
    await modal.getByRole('button', { name: 'Import 4' }).click();

    await expect(modal).toHaveCount(0);
    await expect
      .poll(() => articlePaths(window))
      .toEqual([
        `${NESTED}/Alpha/Deep/d1.md`,
        `${NESTED}/Alpha/a1.md`,
        `${NESTED}/Alpha/paper.pdf`,
        `${NESTED}/Beta/b1.md`,
        `${NESTED}/root.md`,
      ]);
  });

  test('unticking a folder leaves everything under it out, and a partly ticked folder shows so', async () => {
    await setNativeMenus(window, false);
    await buildNested(window);
    const folderRow = window.locator(
      `.nav-folder-title[data-path="${NESTED}"]`
    );
    const modal = bulkModal(window);
    const include = modal.locator('label', { hasText: 'Include subfolders' });
    const folderBox = (name: string) =>
      modal
        .locator('.ir-bulk-import-folder-title')
        .filter({
          has: window.locator('.ir-bulk-import-name', {
            hasText: new RegExp(`^${name}$`),
          }),
        })
        .locator('input[type="checkbox"]');
    const count = modal.locator('.ir-bulk-import-count');

    await chooseFromMenu(window, folderRow, 'Import from folder…');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await include.click();
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(count).toHaveText(/^5\b/);

    await folderBox('Alpha').click();

    await expect(folderBox('Alpha')).not.toBeChecked();
    await expect(folderBox('Deep')).not.toBeChecked();
    await expect(folderBox('Beta')).toBeChecked();
    await expect(count).toHaveText(/^2\b/);

    // Ticking the folder inside it alone leaves it partly ticked
    await folderBox('Deep').click();

    await expect(folderBox('Deep')).toBeChecked();
    await expect(folderBox('Alpha')).toHaveJSProperty('indeterminate', true);
    await expect(count).toHaveText(/^3\b/);
    await modal.getByRole('button', { name: 'Import 3' }).click();

    await expect(modal).toHaveCount(0);
    await expect
      .poll(() => articlePaths(window))
      .toEqual([
        `${NESTED}/Alpha/Deep/d1.md`,
        `${NESTED}/Beta/b1.md`,
        `${NESTED}/root.md`,
      ]);
  });

  test('opens with subfolders included the way it was last left, across a reload of the plugin', async () => {
    await setNativeMenus(window, false);
    await buildNested(window);
    const folderRow = window.locator(
      `.nav-folder-title[data-path="${NESTED}"]`
    );
    const modal = bulkModal(window);
    const names = modal.locator('.ir-bulk-import-row .ir-bulk-import-name');
    const include = modal.locator('label', { hasText: 'Include subfolders' });
    const everything = ['d1', 'a1', 'paper', 'b1', 'root'];

    await chooseFromMenu(window, folderRow, 'Import from folder…');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await include.click();
    await expect(names).toHaveText(everything);
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);

    // Opened again, it is still on, and goes into subfolders unasked
    await chooseFromMenu(window, folderRow, 'Import from folder…');
    await expect(include.locator('input')).toBeChecked();
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(names).toHaveText(everything);
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);

    // Saved, so the plugin loaded again below reads it
    await expect
      .poll(async () => {
        try {
          const data = await fs.readFile(
            path.join(
              vaultPath,
              '.obsidian/plugins/incremental-reading/data.json'
            ),
            'utf8'
          );
          return (JSON.parse(data) as { ui?: unknown }).ui;
        } catch {
          // Not written yet, or caught halfway through a write
          return null;
        }
      })
      .toEqual({ folderImportIncludeSubfolders: true });
    // Loaded again, as at the next start. Unofficial: `app.plugins`.
    await window.evaluate(async () => {
      type Plugins = {
        plugins: Record<string, unknown>;
        disablePlugin(id: string): Promise<void>;
        enablePlugin(id: string): Promise<boolean>;
      };
      const { plugins } = (window as unknown as { app: { plugins: Plugins } })
        .app;
      await plugins.disablePlugin('incremental-reading');
      await plugins.enablePlugin('incremental-reading');
    });
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            'incremental-reading' in
            (
              window as unknown as {
                app: { plugins: { plugins: Record<string, unknown> } };
              }
            ).app.plugins.plugins
        )
      )
      .toBe(true);

    await chooseFromMenu(window, folderRow, 'Import from folder…');
    await expect(include.locator('input')).toBeChecked();
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(names).toHaveText(everything);

    // Switched off, it opens off from then on
    await include.click();
    await expect(names).toHaveText(['root']);
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await chooseFromMenu(window, folderRow, 'Import from folder…');
    await expect(include.locator('input')).not.toBeChecked();
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(names).toHaveText(['root']);
  });
});
