import { ARTICLE_TAG, AUTO_IMPORT_TAG, PLUGIN_ICON } from '#/lib/constants';
import {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App } from 'obsidian';
import {
  chooseFromMenu as chooseMenuEntry,
  closeMenu,
  executeCommandById,
  expectExtractSettled,
  finalizeArticleImport,
  openNote,
  openPluginMenu,
  pendingSaves,
  pluginMenuEntries,
  setNativeMenus,
  setPluginSetting,
  waitForReviewItem,
} from './helpers';
import { test } from './setup/fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
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
            mutate(sql: string, params: unknown[]): unknown;
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
  const testInfo = test.info();
  if (barWatched && testInfo.status !== testInfo.expectedStatus) {
    // Printed as well as attached: the job log is read first
    const log = await window
      .evaluate(() => (window as unknown as { __diag?: unknown }).__diag)
      .catch((error: unknown) => `unreadable: ${String(error)}`);
    const text = JSON.stringify(log);
    console.log(`[bar diag] ${text}`);
    await testInfo.attach('bar-diag', {
      body: text,
      contentType: 'text/plain',
    });
  }
  barWatched = false;
  if (app) await closeElectron(app);
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
  const menu = await openPluginMenu(window, target);
  const titles = await menu.locator('.menu-item-title').allTextContents();
  await closeMenu(window);
  return titles;
}

/**
 * How many of the plugin's entries in the menu `target` shows on a right click
 * import it (each marked with the plugin's icon) and how many un-import it
 * (marked with its own); the menu is closed again.
 */
async function importEntryCounts(
  target: Locator
): Promise<{ imports: number; unimports: number }> {
  const entries = pluginMenuEntries(await openPluginMenu(window, target));
  const marked = (icon: string) =>
    entries.filter({ has: window.locator(`svg.${icon}`) }).count();
  const counts = {
    imports: await marked(PLUGIN_ICON),
    unimports: await marked('lucide-file-x'),
  };
  await closeMenu(window);
  return counts;
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

/** The reading-mode action bar on the note's tab. */
const readingBar = () => window.locator('.mod-root .ir-reading-mode-bar');

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

/** The note's property `key` as the metadata cache holds it. */
const cachedProperty = (key: string) =>
  window.evaluate(
    ({ notePath, key }) => {
      const { app } = window as unknown as {
        app: {
          metadataCache: {
            getCache(path: string): { frontmatter?: Record<string, unknown> };
          };
        };
      };
      return app.metadataCache.getCache(notePath)?.frontmatter?.[key];
    },
    { notePath: NOTE, key }
  );

/** The note's `ir-id` as the metadata cache holds it. */
const cachedIrId = () => cachedProperty('ir-id');

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

/**
 * Tombstone the note's article row, or bring it back, straight in the
 * database, as a merge of another device's delete or undo would: the note is
 * left as it is.
 */
async function flagArticleRow(deleted: boolean) {
  const id = await cachedIrId();
  await markBar(deleted ? 'delete row' : 'revive row');
  await window.evaluate(
    async ({ id, deleted }) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate('UPDATE article SET deleted = $1 WHERE id = $2', [
        deleted,
        id,
      ]);
    },
    { id, deleted }
  );
}

/**
 * Set the note's tags to `tags`, as the user's own edit would, and wait for the
 * metadata cache to parse them. The bars type the note by that parse, which
 * can land well after the note's properties show the edit, and a row written
 * before it lands is typed by the old tags.
 */
async function setTags(tags: string[]) {
  await window.evaluate(
    async ({ notePath, tags }) => {
      const { app } = window as unknown as {
        app: {
          vault: { getFileByPath(path: string): unknown };
          fileManager: {
            processFrontMatter(
              file: unknown,
              fn: (frontmatter: Record<string, unknown>) => void
            ): Promise<void>;
          };
        };
      };
      await app.fileManager.processFrontMatter(
        app.vault.getFileByPath(notePath),
        (frontmatter) => {
          frontmatter.tags = tags;
        }
      );
    },
    { notePath: NOTE, tags }
  );
  await expect.poll(() => cachedProperty('tags')).toEqual(tags);
}

/** Import the note, then open the review tab's queue, showing its row. */
async function importAndOpenQueue() {
  await importFromFiles();
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow()).toHaveCount(1);
}

/** Whether {@link watchBar} ran in the current test, so its log can be read. */
let barWatched = false;

/**
 * Log, inside the page, everything that decides whether the note's bars show:
 * database writes naming its row, the metadata cache's parses of it, the item
 * layer's answers on its type and its item, and the bars coming and going,
 * each as `window.__diag` holds it. Snapshots taken between test steps arrive
 * too late to order these, so a failure prints the log instead (see
 * `test.afterEach`). Unofficial: `window.app`, `app.plugins.plugins`, and the
 * plugin's `reviewManager`.
 */
async function watchBar() {
  barWatched = true;
  await window.evaluate((notePath) => {
    type Cache = { frontmatter?: Record<string, unknown> } | null;
    type Items = {
      itemTypeFromCache(file: unknown, cache: Cache): unknown;
    };
    type Manager = {
      articles: Items;
      getReviewItemFromFile(file: unknown): Promise<unknown>;
      repo: {
        onDataChange(
          listener: (event: {
            table: string;
            op: string;
            ids: string[];
          }) => void
        ): () => void;
      };
    };
    const { app } = window as unknown as {
      app: {
        plugins: { plugins: Record<string, { reviewManager: Manager }> };
        metadataCache: {
          on(
            name: 'changed',
            listener: (
              file: { path: string },
              data: string,
              cache: Cache
            ) => void
          ): unknown;
        };
        workspace: {
          on(name: string, listener: () => void): unknown;
          getMostRecentLeaf(): { view: { getMode?(): string } } | null;
        };
      };
    };
    const diag: [number, string, unknown?][] = [];
    (window as unknown as { __diag: typeof diag }).__diag = diag;
    const log = (what: string, detail?: unknown) =>
      diag.push([Math.round(performance.now()), what, detail]);
    const parse = (cache: Cache) => ({
      tags: cache?.frontmatter?.tags,
      id: cache?.frontmatter?.['ir-id'],
    });
    // Unofficial: Obsidian's own renderer asks its main process this way
    log(
      'obsidian',
      (
        window as unknown as {
          require(module: 'electron'): {
            ipcRenderer: { sendSync(channel: 'version'): unknown };
          };
        }
      )
        .require('electron')
        .ipcRenderer.sendSync('version')
    );
    const { reviewManager } = app.plugins.plugins['incremental-reading'];
    reviewManager.repo.onDataChange(({ table, op, ids }) =>
      log('write', { table, op, ids })
    );
    app.metadataCache.on('changed', (file, _data, cache) => {
      if (file.path === notePath) log('parsed', parse(cache));
    });
    app.workspace.on('layout-change', () =>
      log('layout', app.workspace.getMostRecentLeaf()?.view.getMode?.())
    );
    const items = reviewManager.articles;
    const typeOf = items.itemTypeFromCache.bind(
      items
    ) as Items['itemTypeFromCache'];
    items.itemTypeFromCache = (file, cache) => {
      const answer = typeOf(file, cache);
      void Promise.resolve(answer).then((type) =>
        log('typed', {
          ...parse(cache),
          type,
          later: answer instanceof Promise,
        })
      );
      return answer;
    };
    const itemOf = reviewManager.getReviewItemFromFile.bind(
      reviewManager
    ) as Manager['getReviewItemFromFile'];
    reviewManager.getReviewItemFromFile = async (file) => {
      log('item read');
      const item = await itemOf(file);
      log('item', item !== null);
      return item;
    };
    const bars = () => ({
      editing: document.querySelectorAll(
        '.mod-root .markdown-source-view .ir-action-bar-panel'
      ).length,
      reading: document.querySelectorAll('.mod-root .ir-reading-mode-bar')
        .length,
    });
    let last = JSON.stringify(bars());
    log('bars', bars());
    new MutationObserver(() => {
      const now = JSON.stringify(bars());
      if (now === last) return;
      last = now;
      log('bars', bars());
    }).observe(document.body, { childList: true, subtree: true });
  }, NOTE);
}

/** Log `what` in the page's bar log, ordered with what the page saw. */
const markBar = (what: string) =>
  window.evaluate((step) => {
    (window as unknown as { __diag?: [number, string][] }).__diag?.push([
      Math.round(performance.now()),
      step,
    ]);
  }, what);

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

test('puts the bar on an article open in reading view as it is imported, and takes it off as it is un-imported, without reopening it', async () => {
  await openNote(window, NOTE);
  await executeCommandById(window, 'markdown:toggle-preview');
  await expect(
    window.locator('.mod-root .markdown-reading-view')
  ).toBeVisible();
  await expect(readingBar()).toHaveCount(0);

  await chooseFromMenu(fileRow(), 'Import article');
  await finalizeArticleImport(window);
  await expect(readingBar()).toBeVisible();

  await chooseFromMenu(fileRow(), 'Un-import article');
  await answer('Un-import');
  await expect(readingBar()).toHaveCount(0);
});

test('takes the bar off a note no tag types while its row is deleted elsewhere, and puts it back with the row, in live preview and in reading view', async () => {
  await importFromFiles();
  await watchBar();
  // Its type tag taken off by hand: its row still holds it, by its ir-id
  await markBar('untag');
  await setTags(['keep-me']);
  await expect(tagPills()).toHaveText(['keep-me']);
  await expect(actionBar()).toBeVisible();

  await flagArticleRow(true);
  await expect(actionBar()).toHaveCount(0);
  await flagArticleRow(false);
  await expect(actionBar()).toBeVisible();

  await openNote(window, NOTE);
  await markBar('to reading view');
  await executeCommandById(window, 'markdown:toggle-preview');
  await expect(readingBar()).toBeVisible();
  await flagArticleRow(true);
  await expect(readingBar()).toHaveCount(0);
  await flagArticleRow(false);
  await expect(readingBar()).toBeVisible();
});

test("offers a plain note its import alone, and an article's note its un-import alone, its tag taken off or not", async () => {
  expect(await importEntryCounts(fileRow())).toEqual({
    imports: 1,
    unimports: 0,
  });

  await importFromFiles();
  expect(await importEntryCounts(fileRow())).toEqual({
    imports: 0,
    unimports: 1,
  });

  // The row makes it an article, not the tag
  await window.evaluate(
    async ([notePath, tag]) => {
      const { app } = window as unknown as { app: App };
      const file = app.vault.getFileByPath(notePath);
      if (!file) throw new Error(`No file at ${notePath}`);
      await app.fileManager.processFrontMatter(
        file,
        (frontmatter: { tags?: string[] }) => {
          frontmatter.tags = frontmatter.tags?.filter((t) => t !== tag);
        }
      );
    },
    [NOTE, ARTICLE_TAG] as const
  );
  await expect(tagPills()).toHaveText(['keep-me']);
  expect(await importEntryCounts(fileRow())).toEqual({
    imports: 0,
    unimports: 1,
  });
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

test.describe('An article whose note lost its ir-id', () => {
  /** The question an import of the note asks about the article at its path. */
  const question = () => window.locator('.modal-container.mod-confirmation');

  /**
   * Click `button` in the open question until it goes away, with the question
   * it is in: Obsidian can take a click before a modal's button is wired. A
   * question asked next, once more, has buttons of its own.
   */
  async function answerQuestion(button: string) {
    const target = question().locator(`.modal-button-container ${button}`);
    await expect(async () => {
      if (await target.isVisible()) await target.click();
      await expect(target).toHaveCount(0, { timeout: 2_000 });
    }).toPass();
  }

  /** The `ir-id` the note on disk carries, if any. */
  const idOnDisk = async () =>
    (await noteText()).match(/^ir-id: (.+)$/m)?.[1] ?? null;

  /**
   * Import the note, then write it again with its tags but no `ir-id`, as an
   * article imported before notes had ids, or one whose properties were
   * cleared, is: with the plugin off, which would put the id straight back.
   * Imports from here on skip the import dialog, so an import of the note
   * goes straight to its question.
   * @returns the article's id
   */
  async function importAndStripId(): Promise<string> {
    await importFromFiles();
    const id = await cachedIrId();
    if (typeof id !== 'string') throw new Error('The import wrote no ir-id');
    // A save still under way when the plugin goes is dropped, and the import
    // with it
    await expect.poll(() => pendingSaves(window)).toBe(0);
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
    await setPluginSetting(window, 'showImportDialog', false);
    return id;
  }

  /** Import the note from its menu in Files, and wait for its question. */
  async function importIntoQuestion() {
    await chooseFromMenu(fileRow(), 'Import article');
    await expect(question()).toBeVisible();
  }

  test('offers the note its import alone, which asks about the article; Cancel leaves both as they were', async () => {
    await importAndStripId();
    const count = await articleCount();
    expect(await importEntryCounts(fileRow())).toEqual({
      imports: 1,
      unimports: 0,
    });

    await importIntoQuestion();
    await answerQuestion('.mod-cancel');

    expect(await idOnDisk()).toBeNull();
    expect(await articleCount()).toBe(count);
    expect(await importEntryCounts(fileRow())).toEqual({
      imports: 1,
      unimports: 0,
    });
  });

  test("Re-associate makes the note the article's note again, in the queue as before, its un-import offered once more", async () => {
    const id = await importAndStripId();
    const count = await articleCount();

    await importIntoQuestion();
    await answerQuestion('.mod-cta');

    await expect.poll(idOnDisk).toBe(id);
    expect(await articleCount()).toBe(count);
    expect(await importEntryCounts(fileRow())).toEqual({
      imports: 0,
      unimports: 1,
    });
    await openNote(window, NOTE);
    await expect(actionBar()).toBeVisible();
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(queueRow()).toHaveCount(1);
  });

  test('Erase and import fresh, once confirmed, imports the note as a new article in place of the old one', async () => {
    const id = await importAndStripId();
    const count = await articleCount();

    await importIntoQuestion();
    await answerQuestion('button.mod-destructive:not(.mod-cta)');
    // Asked once more, as it can't be undone
    await expect(question().last()).toBeVisible();
    await answerQuestion('.mod-cta');

    await expect.poll(idOnDisk).toMatch(/\S/);
    expect(await idOnDisk()).not.toBe(id);
    // The old one erased for good, the new one in its place
    expect(await articleCount()).toBe(count);
    expect(await importEntryCounts(fileRow())).toEqual({
      imports: 0,
      unimports: 1,
    });
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(queueRow()).toHaveCount(1);
    await expect(queueRow()).toHaveAttribute('data-type', 'article');
  });
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

test.describe("The review tab's own menu", () => {
  /** The text a snippet is taken from the note with. */
  const SNIPPET = 'Some text';

  /** The queue's row for the note's article, not the snippet taken from it. */
  const articleRow = () => queueRow().filter({ hasNotText: SNIPPET });

  /** The queue's row for the snippet. */
  const snippetRow = () =>
    window.locator('.ir-queue-row').filter({ hasText: SNIPPET });

  /** The item review is on, by id, or `null` between items. */
  const currentItemId = () =>
    window.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          plugins: {
            plugins: Record<
              string,
              { store: { getState(): { currentItemId: string | null } } }
            >;
          };
        };
      };
      return app.plugins.plugins['incremental-reading'].store.getState()
        .currentItemId;
    });

  /** Take `SNIPPET` from the note, opened in the active tab. */
  async function extractSnippet() {
    // Its import was chosen in Files, which left Files the active leaf
    await openNote(window, NOTE);
    await window.evaluate((text) => {
      const { editor } = (
        window as unknown as {
          app: {
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
        }
      ).app.workspace.activeEditor;
      const at = editor.getValue().indexOf(text);
      editor.setSelection(
        editor.offsetToPos(at),
        editor.offsetToPos(at + text.length)
      );
    }, SNIPPET);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await expectExtractSettled(window, NOTE, 1);
  }

  /**
   * Open the active review tab's ⋮ menu once it offers Delete, the entry
   * every item gets. Obsidian's menus animate in: the first click can land
   * before the button takes it.
   */
  async function openReviewTabMenu() {
    const menu = window.locator('.menu');
    await expect(async () => {
      if ((await menu.count()) > 0) await closeMenu(window);
      await window
        .locator('.workspace-leaf.mod-active .view-header')
        .getByLabel('More options')
        .click();
      await expect(
        menu.locator('.menu-item.is-warning:has(.lucide-trash-2)')
      ).toBeVisible({ timeout: 2_000 });
    }).toPass();
    return menu;
  }

  test('un-imports the article under review, which moves review on, and offers no un-import for a snippet', async () => {
    const before = await articleCount();
    await importFromFiles();
    await extractSnippet();
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(articleRow()).toHaveCount(1);
    await expect(snippetRow()).toHaveCount(1);

    // A snippet was never imported, so there is nothing to un-import
    await snippetRow().click();
    // A snippet's pane shows no title of its own to wait on, as an article's does
    await expect.poll(currentItemId).not.toBeNull();
    let menu = await openReviewTabMenu();
    await expect(menu.locator('.menu-item:has(.lucide-file-x)')).toHaveCount(0);
    await closeMenu(window);

    await executeCommandById(window, 'incremental-reading:learn');
    await articleRow().click();
    const article = await waitForReviewItem(window);
    expect(article.title).toBe('Unimport me');
    menu = await openReviewTabMenu();
    await menu.locator('.menu-item.is-warning:has(.lucide-file-x)').click();
    await expect(menu).toHaveCount(0);
    await expect(confirmation()).toContainText('"Unimport me"');
    await answer('Un-import');

    // Bounded well inside `CURRENT_ITEM_REFETCH_TIME`: the five-second poll
    // would move review off a gone item on its own, late
    await expect.poll(currentItemId, { timeout: 1_500 }).not.toBe(article.id);
    await expect(
      window.locator('.workspace-leaf.mod-active .ir-title', {
        hasText: 'Unimport me',
      })
    ).toHaveCount(0);
    await expect.poll(noteText).not.toMatch(/ir-id/);
    expect(await articleCount()).toBe(before);
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(snippetRow()).toHaveCount(1);
    await expect(articleRow()).toHaveCount(0);
  });
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
