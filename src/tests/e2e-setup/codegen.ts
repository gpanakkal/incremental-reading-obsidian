import {
  cleanTestVaultsDir,
  createVaultCopy,
  launchElectron,
  resetUserDataDir,
} from './setup';

(async () => {
  await cleanTestVaultsDir();
  const vaultPath = await createVaultCopy('codegen');
  await resetUserDataDir();
  const app = await launchElectron();

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
