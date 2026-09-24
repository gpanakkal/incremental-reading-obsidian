import test, { expect, type AndroidDevice, type Page } from '@playwright/test';
import { executeCommandById, REVIEW_VIEW_TYPE } from './helpers';
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
