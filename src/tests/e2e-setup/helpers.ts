import type { Locator } from '@playwright/test';
import {
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'path';

/**
 * Thanks to qawatake for providing an example testing setup
 * at https://github.com/qawatake/obsidian-e2e-sample
 */
export const appPath = path.resolve('./src/.obsidian-unpacked/main.js');
export const sourceVaultPath = path.resolve('./src/tests/test-vault');
export const testVaultsDir = path.resolve('./src/tests/e2e-test-vaults');

// Disable Chromium sandbox on Linux CI (required for GitHub Actions)
export const sandboxArg =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

export const shouldCleanup = process.env.E2E_CLEANUP === '1';

export async function createVaultCopy(prefix: string) {
  await fs.mkdir(testVaultsDir, { recursive: true });
  const id = crypto.randomBytes(4).toString('hex');
  const vaultPath = path.join(testVaultsDir, `${prefix}-${id}`);
  await fs.cp(sourceVaultPath, vaultPath, { recursive: true });
  return vaultPath;
}

export function userDataDir(vaultPath: string) {
  return path.join(vaultPath, '.user-data');
}

export async function launchElectron(vaultPath: string) {
  return electron.launch({
    args: [
      ...sandboxArg,
      `--user-data-dir=${userDataDir(vaultPath)}`,
      appPath,
      'open',
    ],
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
 * Uses `Locator.evaluate` to click via DOM API directly.
 * May be more reliable in Electron.
 */
export async function click(locator: Locator) {
  return locator.evaluate((el: HTMLElement) => el.click());
}
export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
    await trustButton.click();
  } catch {
    // Dialog didn't appear - vault was previously trusted, continue
  }

  // Close the community plugins modal if it appears
  const settingsModal = window.locator('.modal-bg');
  try {
    await settingsModal.waitFor({ state: 'visible', timeout: 5000 });
    await window.keyboard.press('Escape');
    await settingsModal.waitFor({ state: 'hidden', timeout: 5000 });
  } catch {
    // Modal didn't appear, continue
  }

  // brief pause so Obsidian is ready to take input
  await wait(200);
  return window;
}
