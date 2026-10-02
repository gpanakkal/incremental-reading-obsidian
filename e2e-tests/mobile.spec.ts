import test, { expect, type AndroidDevice, type Page } from '@playwright/test';
import {
  executeCommandById,
  finalizeArticleImport,
  openFileInActiveLeaf,
  REVIEW_VIEW_TYPE,
  watchNotices,
} from './helpers';
import {
  connectAndroidDevice,
  deleteDeviceVault,
  installObsidian,
  openAndroidVault,
  pushVaultCopy,
  stopObsidian,
} from './setup/android';
import { shouldCleanup } from './setup/helpers';

// The real Obsidian Android app on an emulator, as the `e2e-android` project
// runs it. What this covers that `app.emulateMobile` on desktop cannot: the
// plugin loading in Obsidian's mobile build, inside an Android WebView with no
// Node or Electron underneath it.

// One device, one app: tests take turns on it.
test.describe.configure({ mode: 'serial' });

let device: AndroidDevice;
let window: Page;
let vaultName: string;
let consoleLines: string[];

test.beforeAll(async () => {
  device = await connectAndroidDevice();
  await installObsidian(device);
});

test.afterAll(async () => {
  if (device) {
    await stopObsidian(device).catch(() => {});
    await device.close();
  }
});

test.beforeEach(async () => {
  consoleLines = [];
  vaultName = await pushVaultCopy(device, 'mobile');
  window = await openAndroidVault(device, vaultName, (line) =>
    consoleLines.push(line)
  );
});

test.afterEach(async () => {
  // No trace or video exists for a WebView page, so a failure here would
  // otherwise leave nothing to look at in the CI artifacts.
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('device-screen', {
      body: await device.screenshot(),
      contentType: 'image/png',
    });
    await testInfo.attach('webview-console', {
      body: consoleLines.join('\n'),
      contentType: 'text/plain',
    });
  }
  await stopObsidian(device);
  if (shouldCleanup) await deleteDeviceVault(device, vaultName);
});

test('Set up test vault to make plugin ready to use when Obsidian opens', async () => {
  // `openAndroidVault` already waited for the plugin; this pins down that it
  // loaded in the mobile app rather than anything that only looks like it.
  expect(
    await window.evaluate(() => ({
      isMobile: (window as unknown as { app: { isMobile: boolean } }).app
        .isMobile,
      isAndroid: document.body.classList.contains('is-android'),
    }))
  ).toEqual({ isMobile: true, isAndroid: true });
});

test('Can open the review interface by executing the command', async () => {
  await executeCommandById(window, 'incremental-reading:learn');

  // Mobile shows one tab at a time and has no tab header row to find it by, as
  // the desktop version of this test does. The view itself is what is on
  // screen.
  await expect(
    window.locator(`.workspace-leaf-content[data-type="${REVIEW_VIEW_TYPE}"]`)
  ).toBeVisible();
  await expect(window.locator('css=#begin-review-button')).toBeVisible();
});

test("Reviews a PDF article in Obsidian's own PDF viewer", async () => {
  await openFileInActiveLeaf(window, 'sources/PDF fixture.pdf');
  await executeCommandById(window, 'incremental-reading:import-article');
  await finalizeArticleImport(window);
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();

  const article = window.locator('.ir-pdf-article');
  const firstPage = article.locator('.page[data-page-number="1"]');
  await expect(firstPage.locator('.textLayer')).toContainText(
    'Incremental reading turns a long text'
  );

  // Above the action bar, which sits at the bottom on mobile, never under it
  const leaf = `.workspace-leaf-content[data-type="${REVIEW_VIEW_TYPE}"]`;
  const viewer = await article.boundingBox();
  const bar = await window.locator(`${leaf} .ir-action-bar`).boundingBox();
  expect(viewer && bar).toBeTruthy();
  expect(viewer!.y + viewer!.height).toBeLessThanOrEqual(bar!.y + 1);

  const widthBefore = (await firstPage.boundingBox())!.width;
  await article.locator('[aria-label="Zoom in"]').click();
  await expect
    .poll(async () => (await firstPage.boundingBox())!.width)
    .toBeGreaterThan(widthBefore);

  // Find, from Obsidian's own search command, closed by the viewer's Escape
  await executeCommandById(window, 'editor:open-search');
  const findBar = article.locator('.pdf-findbar');
  await expect(findBar).toBeVisible();
  const findInput = findBar.locator('input[type="text"], input:not([type])');
  await findInput.first().fill('snippet');
  await findInput.first().press('Enter');
  await expect(article.locator('.textLayer .highlight').first()).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(findBar).toBeHidden();

  // Snippets and cards aren't there yet, and say so
  const notices = await watchNotices(window);
  await window.getByRole('button', { name: 'Create snippet' }).click();
  await window.getByRole('button', { name: 'Create card' }).click();
  await expect
    .poll(notices)
    .toEqual([
      "Snippets from PDFs aren't supported yet",
      "Cards from PDFs aren't supported yet",
    ]);

  // Finishing the item takes the viewer, and its keys, with it
  await window.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(article).toHaveCount(0);
  expect(
    await window.evaluate((viewType) => {
      const { app } = window as unknown as {
        app: {
          workspace: {
            getLeavesOfType(type: string): {
              view: { scope: unknown; pdfViewer: unknown };
            }[];
          };
        };
      };
      const { view } = app.workspace.getLeavesOfType(viewType)[0];
      return { viewer: view.pdfViewer, scope: view.scope };
    }, REVIEW_VIEW_TYPE)
  ).toEqual({ viewer: null, scope: null });
});
