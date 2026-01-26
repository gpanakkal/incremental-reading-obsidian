import test, {
  expect,
  type ElectronApplication,
  _electron as electron,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const appPath = path.resolve('./src/.obsidian-unpacked/main.js');
const vaultPath = path.resolve('./src/tests/test-vault');

let app: ElectronApplication;

test.beforeEach(async () => {
  await fs.rm(path.join(vaultPath, '.obsidian', 'workspace.json'), {
    recursive: true,
    force: true,
  });

  app = await electron.launch({
    args: [
      appPath,
      'open',
      `obsidian://open?path=${encodeURIComponent(vaultPath)}`,
    ],
  });
});

test.afterEach(async () => {
  await app?.close();
});

test('Can open the modal by executing the command', async () => {
  const window = await app.firstWindow();

  // Execute command "open-sample-modal-simple"
  {
    // Open command palette
    await window.getByLabel('Open command palette', { exact: true }).click();

    // Fill the command palette
    const commandPalette = window.locator(':focus');
    await commandPalette.fill('sample plugin modal');
    await commandPalette.press('Enter');
  }

  // Expect that the modal is open
  await expect(window.getByText('Woah!', { exact: true })).toBeVisible();
});
