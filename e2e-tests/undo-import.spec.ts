import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  AUTO_IMPORT_TAG,
  DATA_DIRECTORY,
} from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  finalizeArticleImport,
  importArticle,
  openNote,
  setNativeMenus,
  setPluginSetting,
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

/** A plain note at the vault's top, so its row shows with no folder to open. */
const NOTE = 'Undo me.md';
/** A folder of two plain notes, for a bulk import. */
const FOLDER = 'bulk';
const FOLDER_NOTES = [`${FOLDER}/One.md`, `${FOLDER}/Two.md`];
/** Where copies are made. */
const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;

/** A note's text, carrying a tag of its own. */
const noteText = (title: string) =>
  `---\ntags:\n  - keep-me\n---\n# ${title}\n\nSome text.\n`;

/**
 * What the page-side calls below reach on the plugin. Unofficial:
 * `window.app` and `app.plugins.plugins`.
 */
type PageApp = {
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            query(
              sql: string
            ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
          };
        };
      }
    >;
  };
};

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('undo-import');
  await fs.writeFile(path.join(vaultPath, NOTE), noteText('Undo me'));
  await fs.mkdir(path.join(vaultPath, FOLDER), { recursive: true });
  for (const note of FOLDER_NOTES) {
    await fs.writeFile(
      path.join(vaultPath, note),
      noteText(path.basename(note, '.md'))
    );
  }
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await setNativeMenus(window, false);
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

// #region HELPERS

/** The row of the file or folder at `notePath` in Files. */
const fileRow = (notePath: string) =>
  window.locator(
    `.nav-file-title[data-path="${notePath}"], .nav-folder-title[data-path="${notePath}"]`
  );

/**
 * Right click `target` until its menu shows `title`, then choose it, and wait
 * for the menu to go. Obsidian's menus animate in, and on a loaded runner the
 * first right click can land before the row takes it, so it is repeated.
 */
async function chooseFromMenu(target: Locator, title: string) {
  const menu = window.locator('.menu');
  const item = menu.getByText(title, { exact: true });
  await expect(async () => {
    if ((await menu.count()) === 0) await target.click({ button: 'right' });
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await item.click();
  await expect(menu).toHaveCount(0);
}

/** How many live articles the database holds. */
const articleCount = () =>
  window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    const [row] = await repo.query(
      'SELECT COUNT(*) AS count FROM article WHERE deleted = FALSE'
    );
    return row.count as number;
  });

/**
 * The note at `notePath` as written to disk: the properties view hides
 * `ir-id`, which source mode shows.
 */
const textOf = (notePath: string) =>
  fs.readFile(path.join(vaultPath, notePath), 'utf-8');

/** The files in the articles folder, by name. */
const copies = () =>
  fs.readdir(path.join(vaultPath, ARTICLES)).catch(() => [] as string[]);

/** The pills of the tags property the open note's tab shows. */
const tagPills = () =>
  window
    .locator('.mod-root .markdown-source-view .metadata-property')
    .filter({ visible: true })
    .and(window.locator('[data-property-key="tags"]'))
    .locator('.multi-select-pill');

/** Import the note at `notePath` from its menu in Files, through the dialog. */
async function importFromFiles(notePath: string) {
  await openNote(window, notePath);
  await chooseFromMenu(fileRow(notePath), 'Import article');
  await finalizeArticleImport(window);
}

/** Undo through the command, as the palette or a hotkey runs it. */
const undo = () => executeCommandById(window, 'incremental-reading:undo');

// #endregion

test('undoing an import of a note where it is leaves it a plain note again', async () => {
  const before = await articleCount();
  await importFromFiles(NOTE);
  await expect(tagPills()).toHaveText(['keep-me', ARTICLE_TAG]);
  await expect.poll(() => textOf(NOTE)).toMatch(/^ir-id: /m);
  expect(await articleCount()).toBe(before + 1);

  await undo();

  await expect(tagPills()).toHaveText(['keep-me']);
  await expect.poll(() => textOf(NOTE)).not.toMatch(/ir-id/);
  expect(await articleCount()).toBe(before);
});

test("the Undo button on a folder import's notice takes back every note it imported", async () => {
  const before = await articleCount();
  await chooseFromMenu(fileRow(FOLDER), 'Import from folder…');
  const modal = window
    .locator('.modal')
    .filter({ has: window.locator('.ir-bulk-import') });
  await expect(modal.locator('.ir-bulk-import-row')).toHaveCount(2);
  await modal.getByRole('button', { name: 'Import 2' }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(articleCount).toBe(before + 2);

  await window
    .locator('.notice')
    .filter({ hasText: FOLDER })
    .locator('.ir-notice-action')
    .click();

  await expect.poll(articleCount).toBe(before);
  for (const note of FOLDER_NOTES) {
    await expect.poll(() => textOf(note)).not.toMatch(/ir-id/);
    expect(await textOf(note)).not.toContain(ARTICLE_TAG);
  }
});

test('undoing a copy import trashes the copy and leaves the original as it was', async () => {
  await setPluginSetting(window, 'copyOnImport', true);
  const original = await textOf(NOTE);
  const before = await articleCount();
  const copiesBefore = await copies();
  await importFromFiles(NOTE);
  await expect.poll(copies).toContain(NOTE);
  expect(await articleCount()).toBe(before + 1);

  await undo();

  await expect.poll(copies).toEqual(copiesBefore);
  expect(await articleCount()).toBe(before);
  expect(await textOf(NOTE)).toBe(original);
});

test('an import by tag is never undone: undo takes back the manual import before it', async () => {
  const [manual] = FOLDER_NOTES;
  // Through the command: its folder is collapsed in Files
  await importArticle(window, manual);
  await expect.poll(() => textOf(manual)).toMatch(/^ir-id: /m);
  await setPluginSetting(window, 'autoImportOnTag', true);
  await openNote(window, NOTE);
  await fs.writeFile(
    path.join(vaultPath, NOTE),
    noteText('Undo me').replace(
      '  - keep-me\n',
      `  - keep-me\n  - ${AUTO_IMPORT_TAG}\n`
    )
  );
  await expect(tagPills()).toHaveText([
    'keep-me',
    AUTO_IMPORT_TAG,
    ARTICLE_TAG,
  ]);
  const count = await articleCount();

  await undo();

  await expect.poll(() => textOf(manual)).not.toMatch(/ir-id/);
  expect(await articleCount()).toBe(count - 1);
  await expect(tagPills()).toHaveText([
    'keep-me',
    AUTO_IMPORT_TAG,
    ARTICLE_TAG,
  ]);
  expect(await textOf(NOTE)).toMatch(/^ir-id: /m);
});
