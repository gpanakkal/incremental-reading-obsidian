import { ARTICLE_DIRECTORY, DATA_DIRECTORY } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  finalizeArticleImport,
  openNote,
  scrollToText,
  selectParagraph,
  setNativeMenus,
  setNewLinkFormat,
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
