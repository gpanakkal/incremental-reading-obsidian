import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'path';
import {
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import type { Locator } from '@playwright/test';

/**
 * Thanks to qawatake for providing an example testing setup
 * at https://github.com/qawatake/obsidian-e2e-sample
 */
export const appPath = path.resolve('./.obsidian-unpacked/main.js');
export const sourceVaultPath = path.resolve('./e2e-tests/setup/test-vault');
export const testVaultsDir = path.resolve('./e2e-tests/test-vaults');
export const projectRoot = path.resolve('.');

// Disable Chromium sandbox on Linux CI (required for GitHub Actions)
export const sandboxArg =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

export const shouldCleanup = process.env.E2E_CLEANUP === '1';

export async function createVaultCopy(prefix: string, subDirectory?: string) {
  await fs.mkdir(testVaultsDir, { recursive: true });
  const id = crypto.randomBytes(4).toString('hex');
  const pathSegments = [testVaultsDir];
  if (subDirectory) pathSegments.push(subDirectory);
  const name = prefix ? `${prefix}-${id}` : id;
  const vaultPath = path.join(...pathSegments, name);
  await fs.cp(sourceVaultPath, vaultPath, { recursive: true });

  // Ensure plugin files in the copied vault point to the freshly built plugin.
  // On Unix, the source vault contains symlinks which break after copying
  // (their relative targets no longer resolve). On Windows, setup-obsidian.ps1
  // copies files which become stale after rebuilding. Either way, we need to
  // refresh the plugin files from the project root.
  const pluginDir = path.join(
    vaultPath,
    '.obsidian/plugins/incremental-reading'
  );
  await fs.mkdir(pluginDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    const target = path.join(pluginDir, file);
    await fs.rm(target, { force: true });
    if (process.platform === 'win32') {
      // Windows: copy files (symlinks require admin rights)
      await fs.copyFile(path.join(projectRoot, file), target);
    } else {
      // Unix: use symlinks for faster iteration during development
      await fs.symlink(path.join(projectRoot, file), target);
    }
  }

  return vaultPath;
}

export const deleteVaultCopy = async (vaultPath: string) =>
  await fs.rm(vaultPath, { recursive: true, force: true });

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
 * On Windows/Linux CI, app.close() can resolve before the Node ChildProcess
 * 'exit' event fires (Playwright may terminate the process at the OS level in
 * a way that bypasses Node's event machinery). A polling fallback ensures we
 * always escape the wait, preventing afterEach timeouts in CI.
 */
export async function closeElectron(app: ElectronApplication) {
  const proc = app.process();

  // Register 'exit' listener before calling close() so we don't miss the event.
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
    } else {
      proc.on('exit', resolve);
    }
  });

  await app.close();

  // After close() resolves, the process may have already exited without firing
  // the 'exit' event (observed in CI on Windows/Linux). Race the event listener
  // against a polling fallback to avoid hanging indefinitely.
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const id = setInterval(() => {
        if (proc.exitCode !== null) {
          clearInterval(id);
          resolve();
        }
      }, 100);
    }),
  ]);
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
  try {
    await openButton.click();
  } catch {
    // vault selection dialog was not shown; continue
  }

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

  // maximize the window
  const maximizeButton = window.getByLabel('Maximize');
  try {
    await maximizeButton.click();
  } catch {
    /* empty */
  }
  return window;
}
