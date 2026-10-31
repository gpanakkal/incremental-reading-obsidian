import {
  ARTICLE_DIRECTORY,
  DATA_DIRECTORY,
  SNIPPET_TAG,
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
  openFileInActiveLeaf,
  openNote,
  scrollToText,
  selectParagraph,
  setNativeMenus,
  setNewLinkFormat,
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

/** The plain note the cards below are made from. */
const NOTE_PATH = 'sources/Security Principles.md';
/** The list item made into a card, as it reads in the source. */
const BULLET_TEXT =
  'Explain the security functions: Confidentiality, Integrity and Availability (CIA).';

/**
 * What the page-side calls below reach on Obsidian and the plugin. Unofficial:
 * `window.app` and `app.plugins.plugins`.
 */
type PageApp = {
  vault: {
    getFileByPath(path: string): unknown;
    create(path: string, data: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
    process(file: unknown, edit: (text: string) => string): Promise<string>;
  };
  fileManager: {
    processFrontMatter(
      file: unknown,
      fn: (frontmatter: Record<string, unknown>) => void
    ): Promise<void>;
  };
  metadataCache: {
    getFileCache(file: unknown): {
      frontmatter?: Record<string, unknown>;
    } | null;
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): {
      openFile(file: unknown, state: unknown): Promise<void>;
    };
  };
  plugins: {
    plugins: Record<
      string,
      {
        toggleAdvancedCommands(enable: boolean): void;
        reviewManager: {
          repo: {
            query(sql: string, params?: unknown[]): Record<string, unknown>[];
          };
        };
      }
    >;
  };
};

/**
 * The path of every card's note. Read only to open the card: nothing on
 * screen names it.
 */
const cardPaths = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo
      .query('SELECT reference FROM srs_card')
      .map((row) => row.reference as string);
  });

const readNote = () => fs.readFile(path.join(vaultPath, NOTE_PATH), 'utf8');

/** The card's embed in the active tab's note, rendered with the card's text. */
const cardEmbed = (page: Page) =>
  page.locator('.workspace-leaf.mod-active .internal-embed', {
    hasText: 'Explain the security functions',
  });

/** The title in the header of the active tab. */
const activeTabTitle = (page: Page) =>
  page.locator(
    '.workspace-tabs.mod-active .workspace-tab-header.is-active .workspace-tab-header-inner-title'
  );

/**
 * Make a card of {@link BULLET_TEXT} in the note, which is no article, and
 * wait until the note shows its embed.
 * @returns the card's note path
 */
async function cardFromPlainNote(page: Page) {
  await openNote(page, 'sources/Security Principles');
  await selectParagraph(page, BULLET_TEXT);
  await executeCommandById(page, 'incremental-reading:create-card');
  await expect(cardEmbed(page)).toBeVisible();
  // Not a check: an import reads the note as saved, so the embed has to have
  // reached the disk before one starts
  await expect.poll(readNote).toContain('|ir-hide-title]]');
  await expect.poll(() => cardPaths(page)).toHaveLength(1);
  const [cardPath] = await cardPaths(page);
  return cardPath;
}

/**
 * Open the card at `cardPath` in a tab of its own and choose Go to context
 * from its view's menu, retrying the menu until it shows the entry: Obsidian's
 * menus animate in, and the first click can land before the button takes it.
 */
async function goToContext(page: Page, cardPath: string) {
  await page.evaluate((cardPath) => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace
      .getLeaf('tab')
      .openFile(app.vault.getFileByPath(cardPath), { active: true });
  }, cardPath);
  await expect(activeTabTitle(page)).toHaveText(
    path.posix.basename(cardPath, '.md')
  );
  await setNativeMenus(page, false);
  const menu = page.locator('.menu');
  const entry = menu.getByText('Go to context', { exact: true });
  await expect(async () => {
    if ((await menu.count()) === 0) {
      await page
        .locator('.workspace-leaf.mod-active .view-header')
        .getByLabel('More options')
        .click();
    }
    await expect(entry).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await entry.click();
  await expect(menu).toHaveCount(0);
}

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('note-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await window.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test.describe('Importing a note cards were made from', () => {
  test('gives the card to the note imported in place, which keeps its embed', async () => {
    const cardPath = await cardFromPlainNote(window);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await expect(cardEmbed(window)).toBeVisible();

    // The card's queue row names the article as its parent
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(
      window.locator('.ir-queue-row').filter({
        has: window.getByRole('cell', {
          name: `Parent ${NOTE_PATH}`,
          exact: true,
        }),
      })
    ).toHaveCount(1);

    await goToContext(window, cardPath);
    await expect(activeTabTitle(window)).toHaveText('Security Principles');
    await expect(cardEmbed(window)).toBeInViewport();
  });
});

test.describe('Importing a note as a copy re-bases its links', () => {
  test('in the relative link format, a relative link and a card embed resolve from the copy as from the original, and Go to context lands on the embed', async () => {
    await setNewLinkFormat(window, 'relative');
    const link = '[[../other/Target]]';
    await window.evaluate(
      async ({ notePath, link }) => {
        const { app } = window as unknown as { app: PageApp };
        await app.vault.createFolder('other');
        await app.vault.create('other/Target.md', 'The target.');
        await app.vault.process(
          app.vault.getFileByPath(notePath),
          (text) => `${text}\nSee ${link}.\n`
        );
      },
      { notePath: NOTE_PATH, link }
    );
    const cardPath = await cardFromPlainNote(window);
    // The premise, read off the disk as source mode would show it: the format
    // writes the embed by its path from the note's folder
    expect(await readNote()).toContain(
      `![[../${cardPath.slice(0, -'.md'.length)}|ir-hide-title]]`
    );

    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
    });
    await executeCommandById(window, 'incremental-reading:import-article-copy');

    // The card went with the copy, so Go to context opens the copy, in the
    // data folder rather than the original's, with the embed rendered there
    await goToContext(window, cardPath);
    await expect(activeTabTitle(window)).toHaveText('Security Principles');
    const breadcrumb = window.locator(
      '.workspace-leaf.mod-active .view-header-title-parent'
    );
    await expect(breadcrumb).toContainText(DATA_DIRECTORY);
    await expect(breadcrumb).toContainText(ARTICLE_DIRECTORY);
    await expect(cardEmbed(window)).toBeInViewport();

    // The relative link, rewritten from the copy's folder, still leads to the
    // target
    const rebased = '../../other/Target';
    await scrollToText(window, rebased);
    await window
      .locator('.workspace-leaf.mod-active .cm-hmd-internal-link', {
        hasText: rebased,
      })
      .click();
    await expect(activeTabTitle(window)).toHaveText('Target');
    await expect(
      window.locator('.workspace-leaf.mod-active .cm-content')
    ).toContainText('The target.');
  });
});

test.describe("The import notice's Open button", () => {
  test('opens the copy an import made, in the tab the original was in', async () => {
    await openNote(window, 'sources/Security Principles');
    const tabs = window.locator(
      '.workspace-tabs.mod-active .workspace-tab-header'
    );
    const tabCount = await tabs.count();
    const breadcrumb = window.locator(
      '.workspace-leaf.mod-active .view-header-title-parent'
    );
    await expect(breadcrumb).toContainText('sources');
    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
    });

    await executeCommandById(window, 'incremental-reading:import-article-copy');
    const notice = window
      .locator('.notice')
      .filter({ hasText: 'Imported "Security Principles"' });
    await notice.getByRole('button', { name: 'Open' }).click();

    await expect(notice).toHaveCount(0);
    // The copy, which has the original's name, in the data folder
    await expect(activeTabTitle(window)).toHaveText('Security Principles');
    await expect(breadcrumb).toContainText(DATA_DIRECTORY);
    await expect(breadcrumb).toContainText(ARTICLE_DIRECTORY);
    await expect(tabs).toHaveCount(tabCount);
  });
});

test.describe("Importing a snippet's or card's note that lost its type tag", () => {
  const kinds = [
    { kind: 'snippet', table: 'snippet', command: 'extract-selection' },
    { kind: 'card', table: 'srs_card', command: 'create-card' },
  ];

  for (const { kind, table, command } of kinds) {
    test(`refuses a ${kind} note, saying so, and makes no article of it`, async () => {
      await openNote(window, 'sources/Security Principles');
      await selectParagraph(window, BULLET_TEXT);
      await executeCommandById(window, `incremental-reading:${command}`);
      const reference = async () =>
        (
          await window.evaluate((table) => {
            const { app } = window as unknown as { app: PageApp };
            const { repo } =
              app.plugins.plugins['incremental-reading'].reviewManager;
            return repo
              .query(`SELECT reference FROM ${table}`)
              .map((row) => row.reference as string);
          }, table)
        )[0];
      await expect.poll(reference).toBeTruthy();
      const itemPath = await reference();

      // The user takes the type tag off; the import reads the note's tags
      // from the metadata cache, so it waits for the cache to have it
      await window.evaluate(async (itemPath) => {
        const { app } = window as unknown as { app: PageApp };
        await app.fileManager.processFrontMatter(
          app.vault.getFileByPath(itemPath),
          (frontmatter) => {
            frontmatter.tags = ['mine'];
          }
        );
      }, itemPath);
      await expect
        .poll(() =>
          window.evaluate((itemPath) => {
            const { app } = window as unknown as { app: PageApp };
            return app.metadataCache.getFileCache(
              app.vault.getFileByPath(itemPath)
            )?.frontmatter?.tags;
          }, itemPath)
        )
        .toEqual(['mine']);

      await openFileInActiveLeaf(window, itemPath);
      const notices = await watchNotices(window);
      await executeCommandById(window, 'incremental-reading:import-article');
      await finalizeArticleImport(window);

      // Told why, once
      await expect.poll(async () => (await notices()).length).toBe(1);
      // The note's own tags, with no article tag added
      await expect(
        window
          .locator(
            '.workspace-leaf.mod-active .metadata-property[data-property-key="tags"] .multi-select-pill'
          )
          .filter({ visible: true })
      ).toHaveText(['mine']);
      await executeCommandById(window, 'incremental-reading:learn');
      await expect(
        window.locator(`.ir-queue-row[data-type="${kind}"]`)
      ).toHaveCount(1);
      await expect(
        window.locator('.ir-queue-row[data-type="article"]')
      ).toHaveCount(0);
    });
  }
});

test.describe("Importing a note at a deleted snippet's path", () => {
  /** The snippet's row as the database holds it. */
  const snippetRow = () =>
    window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo.query('SELECT reference, deleted FROM snippet')[0] as
        | { reference: string; deleted: number }
        | undefined;
    });

  /** The tags shown in the active tab's properties. */
  const tagPills = () =>
    window
      .locator(
        '.workspace-leaf.mod-active .metadata-property[data-property-key="tags"] .multi-select-pill'
      )
      .filter({ visible: true });

  /** The item's action bar in the active tab, which a plain note has none of. */
  const actionBar = () =>
    window
      .locator('.workspace-leaf.mod-active .ir-action-bar-panel')
      .filter({ visible: true });

  /**
   * Make a snippet, delete its note, and put a plain note of the user's at
   * its path by renaming one there; then import that note. Leaves the
   * question the import asks on screen.
   * @returns the question's modal
   */
  async function importPlainNoteAtSnippetPath() {
    await openNote(window, 'sources/Security Principles');
    await selectParagraph(window, BULLET_TEXT);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await expect.poll(snippetRow).toMatchObject({ deleted: 0 });
    const { reference } = (await snippetRow())!;

    await window.evaluate(async (reference) => {
      const { app } = window as unknown as {
        app: PageApp & {
          fileManager: { trashFile(file: unknown): Promise<void> };
        };
      };
      await app.fileManager.trashFile(app.vault.getFileByPath(reference));
    }, reference);
    await expect.poll(snippetRow).toEqual({ reference, deleted: 1 });

    await window.evaluate(async (reference) => {
      const { app } = window as unknown as {
        app: PageApp & {
          fileManager: {
            renameFile(file: unknown, newPath: string): Promise<void>;
          };
        };
      };
      const file = await app.vault.create(
        'Plain note.md',
        '---\ntags:\n  - mine\n---\nMy own text.\n'
      );
      await app.fileManager.renameFile(file, reference);
    }, reference);
    await expect
      .poll(() =>
        window.evaluate((reference) => {
          const { app } = window as unknown as { app: PageApp };
          return app.metadataCache.getFileCache(
            app.vault.getFileByPath(reference)
          )?.frontmatter?.tags;
        }, reference)
      )
      .toEqual(['mine']);
    // Renaming a note there brings no deleted item back
    expect(await snippetRow()).toEqual({ reference, deleted: 1 });

    await openFileInActiveLeaf(window, reference);
    await expect(tagPills()).toHaveText(['mine']);
    await expect(actionBar()).toHaveCount(0);
    // Straight to the import, as the setting to skip the dialog does
    await window.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          plugins: {
            plugins: Record<
              string,
              { settings: { showImportDialog: boolean } }
            >;
          };
        };
      };
      app.plugins.plugins['incremental-reading'].settings.showImportDialog =
        false;
    });
    await executeCommandById(window, 'incremental-reading:import-article');
    const modal = window.locator('.modal-container.mod-confirmation');
    await expect(modal).toBeVisible();
    return modal;
  }

  /**
   * Click `button` in the question's modal until the modal goes away:
   * Obsidian can take a click before the button is wired (see
   * `finalizeArticleImport`).
   */
  async function answer(modal: Locator, button: '.mod-cta' | '.mod-cancel') {
    await expect(async () => {
      const target = modal.locator(`.modal-button-container ${button}`);
      if (await target.isVisible()) await target.click();
      await expect(modal).toBeHidden({ timeout: 2_000 });
    }).toPass();
  }

  test("Re-associate makes the note the snippet's note, back in review", async () => {
    const modal = await importPlainNoteAtSnippetPath();

    await answer(modal, '.mod-cta');

    await expect(actionBar()).toBeVisible();
    await expect(tagPills()).toHaveText(['mine', SNIPPET_TAG]);
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(
      window.locator('.ir-queue-row[data-type="snippet"]')
    ).toHaveCount(1);
    await expect(
      window.locator('.ir-queue-row[data-type="article"]')
    ).toHaveCount(0);
  });

  test('Cancel leaves the note and the deleted snippet as they were', async () => {
    const modal = await importPlainNoteAtSnippetPath();
    const before = await snippetRow();

    await answer(modal, '.mod-cancel');

    await expect(tagPills()).toHaveText(['mine']);
    await expect(actionBar()).toHaveCount(0);
    expect(await snippetRow()).toEqual(before);
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(
      window.locator('.ir-queue-row[data-type="snippet"]')
    ).toHaveCount(0);
    await expect(
      window.locator('.ir-queue-row[data-type="article"]')
    ).toHaveCount(0);
  });
});

test.describe("Importing a copy of a snippet's or card's note that lost its type tag", () => {
  const kinds = [
    { kind: 'snippet', table: 'snippet', command: 'extract-selection' },
    { kind: 'card', table: 'srs_card', command: 'create-card' },
  ];
  /** Where the user moves the item's note: outside the data folder. */
  const MOVED = 'Moved item.md';

  for (const { kind, table, command } of kinds) {
    test(`refuses a ${kind} note moved out of the data folder, as a tagged one is, and makes no copy`, async () => {
      await openNote(window, 'sources/Security Principles');
      await selectParagraph(window, BULLET_TEXT);
      await executeCommandById(window, `incremental-reading:${command}`);
      // Unofficial: `app.plugins.plugins`, `reviewManager.repo`
      const reference = async () =>
        (
          await window.evaluate((table) => {
            const { app } = window as unknown as { app: PageApp };
            const { repo } =
              app.plugins.plugins['incremental-reading'].reviewManager;
            return repo
              .query(`SELECT reference FROM ${table}`)
              .map((row) => row.reference as string);
          }, table)
        )[0];
      await expect.poll(reference).toBeTruthy();
      const itemPath = await reference();

      // The user takes the type tag off, then moves the note out of the data
      // folder; its row follows it there
      await window.evaluate(
        async ([itemPath, moved]) => {
          const { app } = window as unknown as {
            app: PageApp & {
              fileManager: {
                renameFile(file: unknown, path: string): Promise<void>;
              };
            };
          };
          const file = app.vault.getFileByPath(itemPath);
          await app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter.tags = ['mine'];
          });
          await app.fileManager.renameFile(file, moved);
        },
        [itemPath, MOVED] as const
      );
      await expect.poll(reference).toBe(MOVED);
      await expect
        .poll(() =>
          window.evaluate((moved) => {
            const { app } = window as unknown as { app: PageApp };
            return app.metadataCache.getFileCache(
              app.vault.getFileByPath(moved)
            )?.frontmatter?.tags;
          }, MOVED)
        )
        .toEqual(['mine']);

      await setPluginSetting(window, 'copyOnImport', true);
      await openFileInActiveLeaf(window, MOVED);
      const notices = await watchNotices(window);
      await executeCommandById(window, 'incremental-reading:import-article');
      await finalizeArticleImport(window);

      // Told why, once
      await expect.poll(async () => (await notices()).length).toBe(1);
      await executeCommandById(window, 'incremental-reading:learn');
      await expect(
        window.locator(`.ir-queue-row[data-type="${kind}"]`)
      ).toHaveCount(1);
      await expect(
        window.locator('.ir-queue-row[data-type="article"]')
      ).toHaveCount(0);
    });
  }
});
