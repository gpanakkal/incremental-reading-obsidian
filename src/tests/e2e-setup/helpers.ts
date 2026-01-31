import {
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'path';

/**
 * Thanks to qawatake for providing an example testing setup
 * at https://github.com/qawatake/obsidian-e2e-sample
 */

export const appPath = path.resolve('./src/.obsidian-unpacked/main.js');
export const sourceVaultPath = path.resolve('./src/tests/test-vault');
export const testVaultsDir = path.resolve('./src/tests/e2e-test-vaults');
export const userDataDir = path.resolve('./src/tests/e2e-user-data');
// Disable Chromium sandbox on Linux CI (required for GitHub Actions)

export const sandboxArg =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

export const shouldCleanup = process.env.E2E_CLEANUP === '1';

export async function cleanTestVaultsDir() {
  await fs.rm(testVaultsDir, { recursive: true, force: true });
  await fs.mkdir(testVaultsDir, { recursive: true });
}

export async function createVaultCopy(prefix: string) {
  let vaultPath = path.join(testVaultsDir, `${prefix}-${Date.now()}`);
  while (
    await fs.access(vaultPath).then(
      () => true,
      () => false
    )
  ) {
    vaultPath = path.join(testVaultsDir, `${prefix}-${Date.now()}`);
  }
  await fs.cp(sourceVaultPath, vaultPath, { recursive: true });

  return vaultPath;
}

export async function resetUserDataDir() {
  await fs.rm(userDataDir, {
    recursive: true,
    force: true,
    // Retry to handle Windows EBUSY errors when Electron hasn't fully released
    // file locks on the user data directory after app.close()
    maxRetries: 5,
    retryDelay: 500,
  });
  await fs.mkdir(userDataDir, { recursive: true });
}

export async function launchElectron() {
  return electron.launch({
    args: [...sandboxArg, `--user-data-dir=${userDataDir}`, appPath, 'open'],
  });
}
/**
 * Close the Electron app and wait for the process to fully exit.
 * On Windows, app.close() can resolve before Chromium child processes
 * release their file locks, causing EBUSY errors on cleanup.
 */

export async function closeElectron(app: ElectronApplication) {
  const proc = app.process();
  const exited = new Promise<void>((resolve) => {
    if (!proc.connected && proc.exitCode !== null) {
      resolve();
    } else {
      proc.on('exit', () => resolve());
    }
  });
  await app.close();
  await exited;
}
/**
 * Open a vault in Obsidian by stubbing the file picker, trusting the author,
 * and dismissing any modals. Returns the vault's main window.
 */

export async function openVault(app: ElectronApplication, vaultPath: string) {
  let window = await app.firstWindow();

  // Wait for the Obsidian launcher window to finish loading
  await window.waitForLoadState('domcontentloaded');

  // Stub the file picker
  await app.evaluate(async ({ dialog }, fakePath) => {
    dialog.showOpenDialogSync = () => {
      return [fakePath];
    };
  }, vaultPath);

  const openButton = window.getByRole('button', { name: 'Open' });
  await openButton.click();

  // Wait for the new window to open after selecting vault
  window = await app.waitForEvent('window');

  // Wait for the window content to load before checking for dialogs
  await window.waitForLoadState('domcontentloaded');
  // Trust the author of the vault (if dialog appears)
  // The dialog shows when opening a vault with community plugins for the first time
  const trustButton = window.getByRole('button', {
    name: 'Trust author and enable plugins',
  });
  try {
    await trustButton.waitFor({ state: 'visible', timeout: 5000 });
    // Use evaluate to click via DOM API directly - more reliable in Electron
    await trustButton.evaluate((el: HTMLElement) => el.click());
  } catch {
    // Dialog didn't appear - vault was previously trusted, continue
  }
  const settingsModal = window.locator('.modal-bg');
  await settingsModal
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(async () => {
      // Close a modal for community plugins (if it appears)
      await window.keyboard.press('Escape');
    });

  // // Close a modal for community plugins (if it appears)
  // await window.keyboard.press('Escape');
  return window;
}
