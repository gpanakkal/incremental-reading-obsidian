import { expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import {
  closeMenu,
  executeCommandById,
  expectReviewHome,
  finalizeArticleImport,
  importArticle,
  openFileInActiveLeaf,
  REVIEW_VIEW_TYPE,
  selectParagraph,
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

/** The page imported, served by {@link server}. */
const PAGE_FILE = path.resolve('e2e-tests/fixtures/web-article.html');
/** Its title, which the article is named for. */
const PAGE_TITLE = 'Gardens of the Northern Coast';

/**
 * What the page-side calls below reach on Obsidian. Unofficial:
 * `window.app` and `app.internalPlugins`.
 */
type PageApp = {
  internalPlugins: {
    getPluginById(id: string): { enabled: boolean; enable(): Promise<void> };
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): {
      setViewState(state: unknown): Promise<void>;
    };
  };
};

/**
 * Serves {@link PAGE_FILE} over http, at {@link pageUrl}. Not a `file:` URL:
 * since Obsidian 1.14 the web viewer loads only http(s) addresses, and leaves
 * the tab blank, titled with the address, for anything else.
 */
let server: http.Server;
let pageUrl: string;

test.beforeAll(async () => {
  const html = await fs.readFile(PAGE_FILE);
  server = http.createServer((request, response) => {
    if (request.url !== '/web-article.html') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  pageUrl = `http://127.0.0.1:${port}/web-article.html`;
});

test.afterAll(async () => {
  // A connection the web viewer kept alive would hold `close` open
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The title in the header of the active tab. */
const activeTabTitle = (page: Page) =>
  page.locator(
    '.workspace-tabs.mod-active .workspace-tab-header.is-active .workspace-tab-header-inner-title'
  );

/**
 * Open {@link pageUrl} in a web viewer tab of its own, turning the core Web
 * viewer plugin on first if it is off, and wait until the page has loaded:
 * the tab takes its title from the page.
 */
async function openPage(page: Page) {
  await page.evaluate(async (url) => {
    const { app } = window as unknown as { app: PageApp };
    // Undocumented: core plugins are reached through `app.internalPlugins`
    const webViewer = app.internalPlugins.getPluginById('webviewer');
    if (!webViewer.enabled) await webViewer.enable();
    // As the web viewer opens a link itself (`openUrl`); its view type and
    // state are undocumented
    await app.workspace.getLeaf('tab').setViewState({
      type: 'webviewer',
      active: true,
      state: { url, title: url, navigate: true },
    });
  }, pageUrl);
  await expect(activeTabTitle(page)).toHaveText(PAGE_TITLE);
}

/** Assert the review queue lists the article named for the page. */
async function expectQueued(page: Page) {
  await executeCommandById(page, 'incremental-reading:learn');
  await expect(
    page.locator('.ir-queue-row', { hasText: PAGE_TITLE })
  ).toBeVisible();
}

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('web-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await window.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

test.describe('Importing the page open in the web viewer', () => {
  test('"Import article" asks in the import dialog, then makes the page an article in the queue, named for its title', async () => {
    await setPluginSetting(window, 'showImportDialog', true);
    await openPage(window);

    await executeCommandById(window, 'incremental-reading:import-article');

    await expect(window.locator('.modal .modal-title')).toContainText(
      PAGE_TITLE
    );
    await finalizeArticleImport(window);
    await expectQueued(window);
  });

  test("the web viewer's more-options menu offers the import, straight away with the dialog off", async () => {
    await setPluginSetting(window, 'showImportDialog', false);
    await openPage(window);
    await setNativeMenus(window, false);
    const menu = window.locator('.menu');
    const entry = menu.getByText('Import article', { exact: true });
    // Obsidian's menus animate in: the first click can land before the
    // button takes it
    await expect(async () => {
      if ((await menu.count()) === 0) {
        await window
          .locator('.workspace-leaf.mod-active .view-header')
          .getByLabel('More options')
          .click();
      }
      await expect(entry).toBeVisible({ timeout: 2_000 });
    }).toPass();

    await entry.click();

    await expectQueued(window);
  });
});

/** A paragraph of the page, which the snippet is taken from. */
const PARAGRAPH = 'Hardy perennials do best';

/** The note the vault-source test imports a copy of, and its title. */
const VAULT_NOTE = 'sources/Security Principles.md';
const VAULT_NOTE_TITLE = 'Security Principles';

/**
 * Open the active review tab's more-options menu, and return Go to source's
 * entry in it. Obsidian's menus animate in: the first click can land before
 * the button takes it.
 */
async function openSourceEntry(page: Page) {
  const menu = page.locator('.menu');
  const entry = menu.locator('.menu-item-title', { hasText: /^Go to source/ });
  await expect(async () => {
    if ((await menu.count()) > 0) await closeMenu(page);
    await page
      .locator('.workspace-leaf.mod-active .view-header')
      .getByLabel('More options')
      .click();
    await expect(entry).toBeVisible({ timeout: 2_000 });
  }).toPass();
  return entry;
}

/**
 * Import the page, close its tab, so only Go to source can bring it back,
 * and show the article in review.
 */
async function reviewImportedPage(page: Page) {
  await setPluginSetting(page, 'showImportDialog', false);
  await openPage(page);
  await executeCommandById(page, 'incremental-reading:import-article');
  await expectQueued(page);
  await page.evaluate(() => {
    const { app } = window as unknown as {
      app: { workspace: { detachLeavesOfType(type: string): void } };
    };
    app.workspace.detachLeavesOfType('webviewer');
  });
  await expectReviewHome(page);
  await page.locator('.ir-queue-row', { hasText: PAGE_TITLE }).click();
  expect((await waitForReviewItem(page)).title).toBe(PAGE_TITLE);
}

test.describe('Go to source', () => {
  test.beforeEach(async () => {
    await setNativeMenus(window, false);
    // No notices sliding in over the ⋮ to take the click meant for it
    await setPluginSetting(window, 'successNoticesOutsideReview', 'none');
  });

  test("from a snippet of a page imported from the web, opens the page in a web viewer tab, leaving review open; it says it would leave the app once the web viewer won't open links", async () => {
    await reviewImportedPage(window);
    await selectParagraph(window, PARAGRAPH);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    // Not a check: the path is what the snippet is opened by
    const snippets = () =>
      window.evaluate(() => {
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
    await expect.poll(snippets).toHaveLength(1);
    const [snippet] = await snippets();
    await openFileInActiveLeaf(window, snippet);
    // Review moves on to the snippet. Not `waitForReviewItem`: a snippet's
    // pane shows no title of its own to match the tab's
    await expect(activeTabTitle(window)).toHaveText(
      path.posix.basename(snippet, '.md')
    );

    // Undocumented: the web viewer's own "Open external links in web viewer"
    // option, `options.openExternalURLs` on its instance
    const setOpensLinks = (on: boolean) =>
      window.evaluate((value) => {
        const { app } = window as unknown as {
          app: {
            internalPlugins: {
              getEnabledPluginById(id: string): {
                options: { openExternalURLs: boolean };
              };
            };
          };
        };
        app.internalPlugins.getEnabledPluginById(
          'webviewer'
        ).options.openExternalURLs = value;
      }, on);
    await setOpensLinks(false);
    await expect(await openSourceEntry(window)).toHaveText(
      /in system browser$/
    );
    await closeMenu(window);
    await setOpensLinks(true);
    const entry = await openSourceEntry(window);
    await expect(entry).not.toHaveText(/in system browser$/);

    await entry.click();

    await expect(
      window.locator(
        '.workspace-leaf.mod-active .workspace-leaf-content[data-type="webviewer"]'
      )
    ).toBeVisible();
    // Named for the page once it has loaded
    await expect(activeTabTitle(window)).toHaveText(PAGE_TITLE);
    await expect(
      window.locator(`.workspace-leaf-content[data-type="${REVIEW_VIEW_TYPE}"]`)
    ).toHaveCount(1);
  });

  test('from an article copied from a note, opens that note', async () => {
    await setPluginSetting(window, 'copyOnImport', true);
    await importArticle(window, VAULT_NOTE);
    await executeCommandById(window, 'incremental-reading:learn');
    await expectReviewHome(window);
    await window
      .locator('.ir-queue-row', { hasText: VAULT_NOTE_TITLE })
      .click();
    expect((await waitForReviewItem(window)).title).toContain(VAULT_NOTE_TITLE);

    await executeCommandById(window, 'incremental-reading:go-to-source');

    await expect(
      window.locator(
        '.workspace-leaf.mod-active .workspace-leaf-content[data-type="markdown"]'
      )
    ).toBeVisible();
    await expect(activeTabTitle(window)).toHaveText(VAULT_NOTE_TITLE);
    const activeFile = () =>
      window.evaluate(() => {
        const { app } = window as unknown as {
          app: { workspace: { getActiveFile(): { path: string } | null } };
        };
        return app.workspace.getActiveFile()?.path ?? null;
      });
    // The original, not the article copied from it
    await expect.poll(activeFile).toBe(VAULT_NOTE);
  });
});
