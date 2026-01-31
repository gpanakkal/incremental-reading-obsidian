import test, {
  expect,
  type ElectronApplication,
  _electron as electron,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Thanks to qawatake for providing an example testing setup
 * Original code can be found at https://github.com/qawatake/obsidian-e2e-sample
 */

export const appPath = path.resolve('./src/.obsidian-unpacked/main.js');
export const sourceVaultPath = path.resolve('./src/tests/test-vault');
export const testVaultsDir = path.resolve('./src/tests/e2e-test-vaults');
export const userDataDir = path.resolve('./src/tests/e2e-user-data');

// Disable Chromium sandbox on Linux CI (required for GitHub Actions)
export const sandboxArg =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

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
  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.mkdir(userDataDir, { recursive: true });
}

export async function launchElectron(vaultPath?: string) {
  const vaultArg = vaultPath
    ? [`obsidian://open?path=${encodeURIComponent(vaultPath)}`]
    : [];

  return electron.launch({
    args: [
      ...sandboxArg,
      `--user-data-dir=${userDataDir}`,
      appPath,
      'open',
      ...vaultArg,
    ],
  });
}

let app: ElectronApplication;
let vaultPath: string;

test.beforeAll(async () => {
  await cleanTestVaultsDir();
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('setup');
  await resetUserDataDir();
  app = await launchElectron();
});

test.afterEach(async () => {
  await app?.close();
});

test('Set up test vault to make plugin ready to use when Obsidian opens', async () => {
  let window = await app.firstWindow();

  // Wait for 'did-finish-load' event on Obsidian side
  await window.waitForEvent('domcontentloaded');

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

  // Close a modal for community plugins (if it appears)
  await window.keyboard.press('Escape');
});
