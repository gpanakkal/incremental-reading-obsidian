import { _electron, type ElectronApplication } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const appPath = path.resolve('./src/.obsidian-unpacked/main.js');
const vaultPath = path.resolve('./src/tests/test-vault');
const userDataDir = path.resolve('./src/tests/e2e-user-data');

// Disable Chromium sandbox on Linux CI (required for GitHub Actions)
const extraArgs =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

let app: ElectronApplication;

(async () => {
  await fs.rm(path.join(vaultPath, '.obsidian', 'workspace.json'), {
    recursive: true,
    force: true,
  });

  await fs.rm(path.join(vaultPath, '.obsidian', 'workspace-mobile.json'), {
    recursive: true,
    force: true,
  });

  // Clear the user data directory to reset trusted vaults and other settings
  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.mkdir(userDataDir, { recursive: true });

  app = await _electron.launch({
    args: [...extraArgs, `--user-data-dir=${userDataDir}`, appPath, 'open'],
  });

  const context = app.context();
  await context.route('**/*', (route) => route.continue());

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
  await window.pause();
})();
