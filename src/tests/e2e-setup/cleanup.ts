import test, {
  expect,
  type ElectronApplication,
} from '@playwright/test';
import {
  cleanTestVaultsDir,
  createVaultCopy,
  launchElectron,
  resetUserDataDir,
} from './setup';

let app: ElectronApplication;
let vaultPath: string;

test.beforeAll(async () => {
  await cleanTestVaultsDir();
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('cleanup');
  app = await launchElectron(vaultPath);

  // Reset user data dir after launch (cleanup needs the existing vault registration)
  await resetUserDataDir();
});

test.afterEach(async () => {
  await app?.close();
});

test('Unregister test vault', async () => {
  let window = await app.firstWindow();

  // Execute the "Open another vault" command
  {
    // Open the command palette
    await window.getByLabel('Open command palette', { exact: true }).click();

    // Input to the command palette
    const commandPalette = window.locator(':focus');
    await commandPalette.fill('open another vault');
    await commandPalette.press('Enter');
  }

  // Wait for the new window to open
  window = await app.waitForEvent('window', (w) => w.url().includes('starter'));

  // Close the originally opened window
  {
    const originalWindow = app
      .windows()
      .find((w) => !w.url().includes('starter'));
    await originalWindow?.close();
  }

  // Remove the registered vault
  {
    await window
      .getByLabel(vaultPath)
      .getByLabel('More options', { exact: true })
      .click();
    await window.getByText('Remove from list').click();
  }
});
