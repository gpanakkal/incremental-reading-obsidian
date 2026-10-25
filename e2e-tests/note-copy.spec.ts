import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App } from 'obsidian';
import {
  closeMenu,
  executeCommandById,
  importArticle,
  openFileInActiveLeaf,
  openMenuWith,
  pendingSaves,
  readSnippetState,
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

/** An article's note at the vault's top, so its row shows in Files. */
const NOTE = 'Copied article';
const NOTE_PATH = `${NOTE}.md`;
/** Where Make a copy puts its copy, and where the copy is renamed to. */
const COPY_PATH = `${NOTE} 1.md`;
const RENAMED_PATH = 'Renamed copy.md';

const SNIPPET_TEXT = 'the passage a snippet is taken from';
const NOTE_TEXT = `# ${NOTE}\n\nA paragraph holding ${SNIPPET_TEXT}, and more.\n`;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('note-copy');
  await fs.writeFile(path.join(vaultPath, NOTE_PATH), NOTE_TEXT);
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // Pinned: CI's window is much narrower than a local headless run's
  await window.setViewportSize({ width: 1000, height: 900 });
  // No success notices: one still up over a menu takes the click meant for it
  await setPluginSetting(window, 'successNoticesOutsideReview', 'none');
  await setPluginSetting(window, 'successNoticesInReview', 'none');
  // macOS defaults to native menus, which Electron draws outside the page
  await setNativeMenus(window, false);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

// #region HELPERS

/**
 * Import the note, take a snippet from it, and return the snippet note's path
 * once its row is stored.
 *
 * Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`.
 */
async function importWithSnippet(): Promise<string> {
  await importArticle(window, NOTE);
  await window.evaluate((text) => {
    const editor = (window as unknown as { app: App }).app.workspace
      .activeEditor?.editor;
    if (!editor) throw new Error('No active editor');
    const start = editor.getValue().indexOf(text);
    editor.setSelection(
      editor.offsetToPos(start),
      editor.offsetToPos(start + text.length)
    );
  }, SNIPPET_TEXT);
  await executeCommandById(window, 'incremental-reading:extract-selection');
  // Polled: the snippet's offsets reach the database on their own debounce
  await expect
    .poll(async () => (await readSnippetState(window, NOTE_PATH)).rows.length)
    .toBe(1);
  return window.evaluate(() => {
    type Repo = {
      query(sql: string, params: unknown[]): { reference: string }[];
    };
    const { app } = window as unknown as {
      app: {
        plugins: {
          plugins: Record<string, { reviewManager: { repo: Repo } }>;
        };
      };
    };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo.query('SELECT reference FROM snippet', [])[0].reference;
  });
}

/**
 * Copy the note as Make a copy does (`vault.copy`, frontmatter and `ir-id`
 * included), then rename the copy, and wait for whatever that writes to be
 * saved. Returns nothing: a `TFile` can't cross back from the page.
 */
async function copyAndRename() {
  await window.evaluate(
    async ([from, copyAt, renameTo]) => {
      const { app } = window as unknown as { app: App };
      const original = app.vault.getFileByPath(from);
      if (!original) throw new Error(`No file at ${from}`);
      const copy = await app.vault.copy(original, copyAt);
      await app.fileManager.renameFile(copy, renameTo);
    },
    [NOTE_PATH, COPY_PATH, RENAMED_PATH] as const
  );
  await expect
    .poll(() =>
      window.evaluate(
        (at) =>
          (window as unknown as { app: App }).app.vault.getFileByPath(at) !==
          null,
        RENAMED_PATH
      )
    )
    .toBe(true);
  await expect.poll(() => pendingSaves(window)).toBe(0);
}

/** A file's row in Files. */
const fileRow = (at: string) =>
  window.locator(`.nav-file-title[data-path="${at}"]`);

/** The titles of the menu a file's row in Files shows, which is closed again. */
async function menuTitles(at: string, showing: string): Promise<string[]> {
  const menu = await openMenuWith(window, fileRow(at), [showing]);
  const titles = await menu.locator('.menu-item-title').allTextContents();
  await closeMenu(window);
  return titles;
}

/** The title in the active tab's header: the name the user reads it by. */
const activeTabTitle = () =>
  window.locator(
    '.workspace-tabs.mod-active .workspace-tab-header.is-active .workspace-tab-header-inner-title'
  );

/** Open the snippet at `snippetPath` and choose Go to context from its ⋮ menu. */
async function goToContextFrom(snippetPath: string) {
  await openFileInActiveLeaf(window, snippetPath);
  await expect(activeTabTitle()).toHaveText(
    path.posix.basename(snippetPath, '.md')
  );
  await window
    .locator('.workspace-leaf.mod-active .view-header')
    .getByLabel('More options')
    .click();
  await window
    .locator('.menu')
    .getByText('Go to context', { exact: true })
    .click();
}

// #endregion

test("renaming a copy of an article's note leaves the article with the original", async () => {
  const snippet = await importWithSnippet();

  await copyAndRename();

  // The original is still the article, and the copy a plain note to import
  await openMenuWith(window, fileRow(NOTE_PATH), ['Un-import article']);
  await closeMenu(window);
  const copyTitles = await menuTitles(RENAMED_PATH, 'Import article');
  expect(copyTitles).not.toContain('Un-import article');
  // The snippet's context is still in the original
  await goToContextFrom(snippet);
  await expect(activeTabTitle()).toHaveText(NOTE);
});

test('a note its article moved away from loses its snippet highlights at once, and the note it moved to shows them', async () => {
  await importWithSnippet();
  const painted = () =>
    window.locator('.workspace-leaf.mod-active .ir-snippet-highlight');
  await expect(painted().first()).toBeVisible();

  // The copy is the article's note once the original claims another id
  await window.evaluate(
    async ([from, copyAt]) => {
      const { app } = window as unknown as { app: App };
      const original = app.vault.getFileByPath(from);
      if (!original) throw new Error(`No file at ${from}`);
      await app.vault.copy(original, copyAt);
      await app.fileManager.processFrontMatter(
        original,
        (frontmatter: Record<string, unknown>) => {
          frontmatter['ir-id'] = 'another-item';
        }
      );
    },
    [NOTE_PATH, COPY_PATH] as const
  );
  // The rename goes by the id the cache has for the original, which it reads
  // back from disk a moment after the write
  await expect
    .poll(() =>
      window.evaluate((at) => {
        const { app } = window as unknown as { app: App };
        const original = app.vault.getFileByPath(at);
        if (!original) return null;
        const frontmatter = app.metadataCache.getFileCache(original)
          ?.frontmatter as Record<string, unknown> | undefined;
        return frontmatter?.['ir-id'] ?? null;
      }, NOTE_PATH)
    )
    .toBe('another-item');
  await window.evaluate(
    async ([copyAt, renameTo]) => {
      const { app } = window as unknown as { app: App };
      const copy = app.vault.getFileByPath(copyAt);
      if (!copy) throw new Error(`No file at ${copyAt}`);
      await app.fileManager.renameFile(copy, renameTo);
    },
    [COPY_PATH, RENAMED_PATH] as const
  );

  await expect(activeTabTitle()).toHaveText(NOTE);
  await expect(painted()).toHaveCount(0);
  await openFileInActiveLeaf(window, RENAMED_PATH);
  await expect(activeTabTitle()).toHaveText(
    path.posix.basename(RENAMED_PATH, '.md')
  );
  await expect(painted().first()).toBeVisible();
});
