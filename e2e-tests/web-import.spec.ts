import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import {
  executeCommandById,
  finalizeArticleImport,
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
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
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
