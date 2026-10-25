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
  expectExtractSettled,
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

/** The edit-mode action bar on the note's tab. */
const actionBar = () =>
  window.locator('.mod-root .markdown-source-view .ir-action-bar-panel');

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

/**
 * How many articles the database holds, deleted ones included, but not the
 * tombstones of those deleted for good (`NOT_PURGED` in `row-delete.ts`).
 */
const articleCount = () =>
  window.evaluate(async () => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    const [row] = await repo.query(
      `SELECT COUNT(*) AS count FROM article
       WHERE reference != ('/ir-deleted/' || id)`
    );
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
  await expect(actionBar()).toBeVisible();

  await chooseFromMenu(fileRow(), 'Un-import article');
  // Names the note
  await expect(confirmation()).toContainText('"Unimport me"');
  await answer('Un-import');

  await expect(
    window.locator('.notice').filter({ hasText: 'Un-imported "Unimport me"' })
  ).toBeVisible();
  await expect(tagPills()).toHaveText(['keep-me']);
  // Gone from the open note without switching away, as from any plain note
  await expect(actionBar()).toHaveCount(0);
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

test.describe('Un-importing from a folder', () => {
  /** The test vault's folder of plain notes, and what it holds. */
  const SOURCES = 'sources';
  const SOURCE_NOTES = [
    'Curse of dimensionality - Wikipedia.md',
    'Memorizing a programming language using spaced repetition software.md',
    'Security Principles.md',
  ];
  /** The note a snippet is taken from, and the snippet's text. */
  const PARENT = `${SOURCES}/Security Principles.md`;
  const SNIPPET = 'Security has become a buzzword';

  /**
   * What the page-side calls below reach. Unofficial: `window.app`,
   * `app.plugins.plugins` and the active editor's `editor`.
   */
  type SnippetApp = PageApp & {
    workspace: {
      activeEditor: {
        editor: {
          getValue(): string;
          offsetToPos(offset: number): unknown;
          setSelection(from: unknown, to: unknown): void;
        };
      };
    };
  };

  /** The live articles in `SOURCES`, by path, sorted. */
  const sourceArticles = () =>
    window.evaluate(async (folder) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      const rows = await repo.query(
        'SELECT reference FROM article WHERE deleted = FALSE ORDER BY reference'
      );
      return rows
        .map((row) => row.reference as string)
        .filter((reference) => reference.startsWith(`${folder}/`));
    }, SOURCES);

  /**
   * The snippet made last, the one taken from `PARENT`: live or not, its
   * parent's id, and where that parent's note is.
   */
  const snippet = () =>
    window.evaluate(async () => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      const [row] = await repo.query(
        `SELECT s.deleted AS deleted, s.parent AS parent, a.reference AS of
           FROM snippet s LEFT JOIN article a ON a.id = s.parent
           ORDER BY s.rowid DESC LIMIT 1`
      );
      return row
        ? {
            live: !row.deleted,
            parent: (row.parent as string | null) ?? null,
            of: (row.of as string | null) ?? null,
          }
        : null;
    });

  /** The bulk dialog. */
  const bulkModal = () =>
    window.locator('.modal').filter({ has: window.locator('.ir-bulk-import') });

  /** `SOURCES`' row in Files. */
  const folderRow = () =>
    window.locator(`.nav-folder-title[data-path="${SOURCES}"]`);

  /** The queue's rows showing `text`. */
  const queueRows = (text: string) =>
    window.locator('.ir-queue-row').filter({ hasText: text });

  /** Take `SNIPPET` from `PARENT`, open in the active tab. */
  async function extractSnippet() {
    await openNote(window, PARENT);
    await window.evaluate((text) => {
      const { editor } = (window as unknown as { app: SnippetApp }).app
        .workspace.activeEditor;
      const at = editor.getValue().indexOf(text);
      editor.setSelection(
        editor.offsetToPos(at),
        editor.offsetToPos(at + text.length)
      );
    }, SNIPPET);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await expectExtractSettled(window, PARENT, 1);
  }

  test('un-imports what a folder import made, keeping the snippet taken from it, which importing the note again adopts', async () => {
    // Import the folder
    await chooseFromMenu(folderRow(), 'Import from folder…');
    await expect(bulkModal().locator('.ir-loading')).toHaveCount(0);
    await expect(bulkModal().locator('.ir-bulk-import-row')).toHaveCount(
      SOURCE_NOTES.length
    );
    await bulkModal().locator('button.mod-cta').click();
    await expect(bulkModal()).toHaveCount(0);
    await expect
      .poll(sourceArticles)
      .toEqual(SOURCE_NOTES.map((name) => `${SOURCES}/${name}`));

    await extractSnippet();
    const taken = await snippet();
    expect(taken).toMatchObject({ live: true, of: PARENT });
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(queueRows('Curse of dimensionality')).toHaveCount(1);
    await expect(queueRows(SNIPPET)).toHaveCount(1);

    // Un-import it again, listing only its articles
    await chooseFromMenu(folderRow(), 'Un-import from folder…');
    await expect(bulkModal().locator('.ir-loading')).toHaveCount(0);
    await expect(
      bulkModal().locator('.ir-bulk-import-row .ir-bulk-import-name')
    ).toHaveText(SOURCE_NOTES.map((name) => name.replace(/\.md$/, '')));
    await bulkModal().locator('button.mod-warning').click();
    await answer('Un-import');

    await expect(bulkModal()).toHaveCount(0);
    await expect(
      window.locator('.notice', { hasText: '3 of 3' }).filter({
        hasText: SOURCES,
      })
    ).toBeVisible();
    await expect.poll(sourceArticles).toEqual([]);
    await expect(queueRows('Curse of dimensionality')).toHaveCount(0);
    await expect(queueRows('Memorizing a programming')).toHaveCount(0);
    // Still reviewing, taken from nothing now
    await expect(queueRows(SNIPPET)).toHaveCount(1);
    expect(await snippet()).toEqual({ live: true, parent: null, of: null });
    for (const name of SOURCE_NOTES) {
      const text = await fs.readFile(
        path.join(vaultPath, SOURCES, name),
        'utf-8'
      );
      expect(text).not.toMatch(/ir-id/);
      expect(text).not.toContain(ARTICLE_TAG);
    }

    // Imported again, the note takes its snippet back
    await openNote(window, PARENT);
    const noteRow = window.locator(`.nav-file-title[data-path="${PARENT}"]`);
    const folderItem = folderRow().locator('xpath=..');
    if (
      await folderItem.evaluate((el) => el.classList.contains('is-collapsed'))
    ) {
      await folderRow().click();
    }
    await chooseFromMenu(noteRow, 'Import article');
    await finalizeArticleImport(window);

    await expect.poll(sourceArticles).toEqual([PARENT]);
    await expect.poll(snippet).toMatchObject({ live: true, of: PARENT });
  });
});
