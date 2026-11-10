import { SOURCE_PROPERTY_NAME } from '#/lib/constants';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  expectReviewHome,
  importArticle,
  openFileInActiveLeaf,
  recordedFlash,
  recordFlash,
  REVIEW_VIEW_TYPE,
  selectParagraph,
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

/** The note imported as a copy, which the article's `source` then names. */
const ORIGINAL = 'testing/Bar source original.md';
const ORIGINAL_TITLE = 'Bar source original';

/** A note imported where it is, so its article names no source. */
const IN_PLACE = 'testing/Bar source in place.md';
const IN_PLACE_TITLE = 'Bar source in place';

/** The text extracted as a snippet of the copied article. */
const PARAGRAPH = 'The passage the snippet is taken from';

const ORIGINAL_TEXT = [
  '# A note to import as a copy',
  '',
  'An opening paragraph, ahead of the one extracted.',
  '',
  `${PARAGRAPH}, with some words after it.`,
  '',
  'A last paragraph, closing the note.',
  '',
].join('\n');

const IN_PLACE_TEXT = [
  '# A note to import where it is',
  '',
  'Nothing in it is extracted.',
  '',
].join('\n');

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('barsrc');
  await fs.writeFile(path.join(vaultPath, ORIGINAL), ORIGINAL_TEXT);
  await fs.writeFile(path.join(vaultPath, IN_PLACE), IN_PLACE_TEXT);
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // Pinned: CI's window is much narrower than a local headless run's
  await window.setViewportSize({ width: 1280, height: 800 });
  // No notices sliding in over the bar to take a click meant for it
  await setPluginSetting(window, 'successNoticesOutsideReview', 'none');
  await setPluginSetting(window, 'successNoticesInReview', 'none');
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

/** The title in the header of the active tab. */
const activeTabTitle = () =>
  window.locator(
    '.workspace-tabs.mod-active .workspace-tab-header.is-active .workspace-tab-header-inner-title'
  );

/** A button of the review tab's bar, by its class. */
const barButton = (className: string) =>
  window.locator(
    `.workspace-leaf-content[data-type="${REVIEW_VIEW_TYPE}"] .ir-action-bar button.${className}`
  );
const goToContextButton = () => barButton('ir-go-to-context-button');
const goToSourceButton = () => barButton('ir-go-to-source-button');

/** Open the queued article named `title` in review, from the home screen. */
async function reviewArticle(title: string) {
  await executeCommandById(window, 'incremental-reading:learn');
  await expectReviewHome(window);
  await window.locator('.ir-queue-row', { hasText: title }).click();
  expect((await waitForReviewItem(window)).title).toContain(title);
}

/** The path of the one snippet stored, once it is. */
async function snippetPath(): Promise<string> {
  const paths = () =>
    window.evaluate(() => {
      // Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`
      const { app } = window as unknown as {
        app: {
          plugins: {
            plugins: Record<
              string,
              {
                reviewManager: {
                  repo: { query(sql: string): { reference: string }[] };
                };
              }
            >;
          };
        };
      };
      return app.plugins.plugins['incremental-reading'].reviewManager.repo
        .query('SELECT reference FROM snippet')
        .map((row) => row.reference);
    });
  await expect.poll(paths).toHaveLength(1);
  return (await paths())[0];
}

/** Show the snippet at `snippet` in review, which is the active tab. */
async function reviewSnippet(snippet: string) {
  await openFileInActiveLeaf(window, snippet);
  // Not `waitForReviewItem`: a snippet's pane shows no title of its own
  await expect(activeTabTitle()).toHaveText(
    path.posix.basename(snippet, '.md')
  );
}

/**
 * Take the `source` property off the note of the article that is not the one
 * at `keep`, as editing its properties would.
 */
async function dropArticleSource(keep: string) {
  await window.evaluate(
    async ({ keep, property }) => {
      // Unofficial: `window.app`, `app.plugins.plugins`, `reviewManager.repo`
      const { app } = window as unknown as {
        app: {
          vault: { getFileByPath(path: string): unknown };
          fileManager: {
            processFrontMatter(
              file: unknown,
              fn: (frontmatter: Record<string, unknown>) => void
            ): Promise<void>;
          };
          plugins: {
            plugins: Record<
              string,
              {
                reviewManager: {
                  repo: {
                    query(
                      sql: string,
                      params: string[]
                    ): { reference: string }[];
                  };
                };
              }
            >;
          };
        };
      };
      const [row] = app.plugins.plugins[
        'incremental-reading'
      ].reviewManager.repo.query(
        'SELECT reference FROM article WHERE reference != $1',
        [keep]
      );
      await app.fileManager.processFrontMatter(
        app.vault.getFileByPath(row.reference),
        (frontmatter) => {
          delete frontmatter[property];
        }
      );
    },
    { keep, property: SOURCE_PROPERTY_NAME }
  );
}

const activeFile = () =>
  window.evaluate(() => {
    const { app } = window as unknown as {
      app: { workspace: { getActiveFile(): { path: string } | null } };
    };
    return app.workspace.getActiveFile()?.path ?? null;
  });

test.describe("Review bar's Go to context and Go to source", () => {
  test("from a snippet of an article copied from a note, go to the snippet's passage in the article and to the note, until the article gives up its source; an article with no source offers neither", async () => {
    await importArticle(window, IN_PLACE);
    await setPluginSetting(window, 'copyOnImport', true);
    await importArticle(window, ORIGINAL);

    // An article copied from a note goes to that note, and has no context
    await reviewArticle(ORIGINAL_TITLE);
    await expect(goToSourceButton()).toBeVisible();
    await expect(goToContextButton()).toHaveCount(0);

    await selectParagraph(window, PARAGRAPH);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    const snippet = await snippetPath();

    await reviewSnippet(snippet);
    await recordFlash(window);
    await goToContextButton().click();

    // The article, shown in review, lit at the snippet's passage
    expect((await waitForReviewItem(window)).title).toContain(ORIGINAL_TITLE);
    await expect
      .poll(() => recordedFlash(window), { timeout: 5000 })
      .not.toBeNull();
    expect(await recordedFlash(window)).toMatchObject({
      text: expect.stringMatching(new RegExp(`^${PARAGRAPH}`)),
    });

    await reviewSnippet(snippet);
    await goToSourceButton().click();

    // The original note, not the article copied from it
    await expect.poll(activeFile).toBe(ORIGINAL);
    await expect(
      window.locator(
        '.workspace-leaf.mod-active .workspace-leaf-content[data-type="markdown"]'
      )
    ).toBeVisible();
    await expect(
      window.locator(`.workspace-leaf-content[data-type="${REVIEW_VIEW_TYPE}"]`)
    ).toHaveCount(1);

    // The article's note giving up its source takes the button off the
    // snippet's bar, as it takes the entry out of the menus
    await executeCommandById(window, 'incremental-reading:learn');
    await reviewSnippet(snippet);
    await expect(goToSourceButton()).toBeVisible();
    await dropArticleSource(IN_PLACE);
    await expect(goToSourceButton()).toHaveCount(0);
    await expect(goToContextButton()).toBeVisible();

    // The article imported where it was names no source
    await executeCommandById(window, 'incremental-reading:learn');
    await openFileInActiveLeaf(window, IN_PLACE);
    expect((await waitForReviewItem(window)).title).toContain(IN_PLACE_TITLE);
    await expect(barButton('ir-snippet-button')).toBeVisible();
    await expect(goToSourceButton()).toHaveCount(0);
    await expect(goToContextButton()).toHaveCount(0);
  });
});
