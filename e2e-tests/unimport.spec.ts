import { ARTICLE_TAG, AUTO_IMPORT_TAG } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  chooseFromMenu as chooseMenuEntry,
  closeMenu,
  executeCommandById,
  finalizeArticleImport,
  openMenuWith,
  openNote,
  pendingSaves,
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
const NOTE = 'Unimport me.md';
const NOTE_TEXT = '---\ntags:\n  - keep-me\n---\n# Unimport me\n\nSome text.\n';

/**
 * What the page-side calls below reach on the plugin. Unofficial:
 * `window.app` and `app.plugins.plugins`; the plugin's `autoImportWatcher` is
 * private to it.
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
        autoImportWatcher: { flushNow(): Promise<void> };
      }
    >;
  };
};

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('unimport');
  await fs.writeFile(path.join(vaultPath, NOTE), NOTE_TEXT);
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

/** The note's row in Files. */
const fileRow = () => window.locator(`.nav-file-title[data-path="${NOTE}"]`);

/** Choose `title` from the menu `target` shows on a right click. */
const chooseFromMenu = (target: Locator, title: string) =>
  chooseMenuEntry(window, target, [title]);

/** The titles of the menu `target` shows on a right click, which is closed again. */
async function menuTitles(target: Locator): Promise<string[]> {
  // Its own entries come last, once the plugin's handler has run
  const menu = await openMenuWith(window, target, ['Import article']);
  const titles = await menu.locator('.menu-item-title').allTextContents();
  await closeMenu(window);
  return titles;
}

/**
 * The properties the note's tab shows. Not the active leaf's: a click on a row
 * in Files makes Files the active leaf.
 */
const properties = () =>
  window
    .locator('.mod-root .markdown-source-view .metadata-property')
    .filter({ visible: true });

/** The names of the properties the note's tab shows, in order. */
const propertyKeys = () =>
  properties().evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-property-key'))
  );

/** The pills of the tags property the note's tab shows. */
const tagPills = () =>
  properties()
    .and(window.locator('[data-property-key="tags"]'))
    .locator('.multi-select-pill');

/**
 * What reloading the plugin reaches. Unofficial: `app.plugins` and its
 * `disablePlugin` / `enablePlugin`.
 */
type ReloadableApp = {
  plugins: {
    plugins: Record<string, { reviewManager?: unknown } | undefined>;
    disablePlugin(id: string): Promise<void>;
    enablePlugin(id: string): Promise<boolean>;
  };
};

/** The note's `ir-id` as the metadata cache holds it. */
const cachedIrId = () =>
  window.evaluate((notePath) => {
    const { app } = window as unknown as {
      app: {
        metadataCache: {
          getCache(path: string): { frontmatter?: Record<string, unknown> };
        };
      };
    };
    return app.metadataCache.getCache(notePath)?.frontmatter?.['ir-id'];
  }, NOTE);

/** How many articles the database holds, deleted ones included. */
const articleCount = () =>
  window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    const [row] = await repo.query('SELECT COUNT(*) AS count FROM article');
    return row.count as number;
  });

/**
 * The note as written to disk: the properties view hides `ir-id`, which
 * source mode shows.
 */
const noteText = () => fs.readFile(path.join(vaultPath, NOTE), 'utf-8');

/** The confirmation an un-import asks for. */
const confirmation = () => window.locator('.modal-container.mod-confirmation');

/**
 * Click `button` of the confirmation until it closes: Obsidian can show a
 * modal before its buttons take clicks (see `finalizeArticleImport`).
 */
async function answer(button: 'Un-import' | 'Cancel') {
  const target = confirmation().getByRole('button', { name: button });
  await expect(async () => {
    if (await target.isVisible()) await target.click();
    await expect(confirmation()).toHaveCount(0, { timeout: 2_000 });
  }).toPass();
}

/** Open the note and import it from its menu in Files. */
async function importFromFiles() {
  await openNote(window, NOTE);
  await chooseFromMenu(fileRow(), 'Import article');
  await finalizeArticleImport(window);
  await expect(tagPills()).toHaveText(['keep-me', 'ir-article']);
  expect(await noteText()).toMatch(/^ir-id: /m);
}

/** The note's row in the review tab's queue. */
const queueRow = () =>
  window.locator('.ir-queue-row').filter({ hasText: 'Unimport me' });

/**
 * Open the queue row's menu and choose its un-import entry, found by its icon
 * and warning state. Right clicks are repeated as in `chooseFromMenu`.
 */
async function unimportFromQueueRow() {
  const menu = window.locator('.menu');
  const item = menu.locator('.menu-item.is-warning:has(.lucide-file-x)');
  await expect(async () => {
    if ((await menu.count()) === 0) {
      await queueRow().locator('.ir-queue-cell').first().click({
        button: 'right',
      });
    }
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await item.click();
  await expect(menu).toHaveCount(0);
}

/** Import the note, then open the review tab's queue, showing its row. */
async function importAndOpenQueue() {
  await importFromFiles();
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow()).toHaveCount(1);
}

// #endregion

test('un-imports an article from its menu in Files, leaving a plain note with its own tags', async () => {
  const before = await articleCount();
  await importFromFiles();
  expect(await articleCount()).toBe(before + 1);

  await chooseFromMenu(fileRow(), 'Un-import article');
  await expect(confirmation()).toContainText(
    `Un-import "Unimport me"? Its review history is deleted and can't be undone.`
  );
  await answer('Un-import');

  await expect(
    window.locator('.notice').filter({ hasText: 'Un-imported "Unimport me"' })
  ).toBeVisible();
  await expect(tagPills()).toHaveText(['keep-me']);
  expect(await propertyKeys()).toEqual(['tags']);
  await expect.poll(noteText).not.toMatch(/ir-id/);
  expect(await articleCount()).toBe(before);
  const titles = await menuTitles(fileRow());
  expect(titles).toContain('Import article');
  expect(titles).not.toContain('Un-import article');
});

test('leaves the article as it was when the un-import is turned down', async () => {
  const before = await articleCount();
  await importFromFiles();
  const keys = await propertyKeys();
  const tags = await tagPills().allTextContents();

  await chooseFromMenu(fileRow(), 'Un-import article');
  await answer('Cancel');

  expect(await propertyKeys()).toEqual(keys);
  await expect(tagPills()).toHaveText(tags);
  expect(await noteText()).toMatch(/^ir-id: /m);
  expect(await articleCount()).toBe(before + 1);
  expect(await menuTitles(fileRow())).toContain('Un-import article');
});

test('un-imports an article whose note carries no ir-id, as one imported before notes had them', async () => {
  const before = await articleCount();
  await importFromFiles();
  // A save still under way when the plugin goes is dropped, and the import
  // with it
  await expect.poll(() => pendingSaves(window)).toBe(0);
  // Written with the plugin off, which would put the id straight back
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: ReloadableApp };
    await app.plugins.disablePlugin('incremental-reading');
  });
  await fs.writeFile(
    path.join(vaultPath, NOTE),
    NOTE_TEXT.replace('  - keep-me\n', `  - keep-me\n  - ${ARTICLE_TAG}\n`)
  );
  await expect.poll(cachedIrId).toBeUndefined();
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: ReloadableApp };
    await app.plugins.enablePlugin('incremental-reading');
  });
  await expect
    .poll(() =>
      window.evaluate(() => {
        const { app } = window as unknown as { app: ReloadableApp };
        return Boolean(
          app.plugins.plugins['incremental-reading']?.reviewManager
        );
      })
    )
    .toBe(true);

  expect(await menuTitles(fileRow())).toContain('Un-import article');
  // Still with no id: the entry was offered by the row at its path
  expect(await noteText()).not.toMatch(/ir-id/);
  await chooseFromMenu(fileRow(), 'Un-import article');
  await answer('Un-import');

  await expect(tagPills()).toHaveText(['keep-me']);
  expect(await articleCount()).toBe(before);
});

test('leaves a note imported by its tag a plain note for good, with import by tag on', async () => {
  await setPluginSetting(window, 'autoImportOnTag', true);
  const before = await articleCount();
  await openNote(window, NOTE);
  await fs.writeFile(
    path.join(vaultPath, NOTE),
    NOTE_TEXT.replace('  - keep-me\n', `  - keep-me\n  - ${AUTO_IMPORT_TAG}\n`)
  );
  await expect(tagPills()).toHaveText([
    'keep-me',
    AUTO_IMPORT_TAG,
    ARTICLE_TAG,
  ]);
  expect(await articleCount()).toBe(before + 1);

  await chooseFromMenu(fileRow(), 'Un-import article');
  await answer('Un-import');
  await expect(tagPills()).toHaveText(['keep-me']);

  // Changed again from outside: with its trigger tag still there, this is
  // what would import it again
  await fs.appendFile(path.join(vaultPath, NOTE), '\nEdited later.\n');
  await expect(
    window.locator('.mod-root .markdown-source-view .cm-content')
  ).toContainText('Edited later.');
  // Whatever that change queued is imported now, not when it would settle
  await window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    await app.plugins.plugins[
      'incremental-reading'
    ].autoImportWatcher.flushNow();
  });

  await expect(tagPills()).toHaveText(['keep-me']);
  expect(await articleCount()).toBe(before);
});

test('un-imports an article from its row menu in the queue, which drops the row', async () => {
  const before = await articleCount();
  await importAndOpenQueue();

  await unimportFromQueueRow();
  await expect(confirmation()).toContainText('"Unimport me"');
  await answer('Un-import');

  await expect(queueRow()).toHaveCount(0);
  await expect.poll(noteText).not.toMatch(/ir-id/);
  expect(await articleCount()).toBe(before);
});

test('keeps the queue row when the un-import from it is turned down', async () => {
  const before = await articleCount();
  await importAndOpenQueue();

  await unimportFromQueueRow();
  await answer('Cancel');

  await expect(queueRow()).toHaveCount(1);
  expect(await noteText()).toMatch(/^ir-id: /m);
  expect(await articleCount()).toBe(before + 1);
});
