import test, {
  expect,
  type ElectronApplication,
} from '@playwright/test';
import {
  cleanTestVaultsDir,
  createVaultCopy,
  launchElectron,
  resetUserDataDir,
} from '../e2e-setup/setup';

/**
 * Tests of core plugin functionality
 */

let app: ElectronApplication;
let vaultPath: string;

test.beforeAll(async () => {
  await cleanTestVaultsDir();
});

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  await resetUserDataDir();
  app = await launchElectron(vaultPath);
});

test.afterEach(async () => {
  await app?.close();
});

test('Can open the review interface by executing the command', async () => {
  const window = await app.firstWindow();

  {
    await window.getByLabel('Open command palette', { exact: true }).click();
    const commandPalette = window.locator(':focus');
    await commandPalette.fill('Incremental Reading: Learn');
    await commandPalette.press('Enter');
  }

  // Verify the tab header for the Incremental Reading view is visible
  await expect(
    window.locator('div.workspace-tab-header[aria-label="Incremental Reading"]')
  ).toBeVisible();
});

test('can import articles from the file explorer context menu', async ({
  page,
}) => {
  await page.getByText('Curse of dimensionality -').click({
    button: 'right',
  });
  await page.getByText('Import article').click();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByLabel('Incremental Reading').click();
  await expect(page.locator('body')).toContainText(
    'The effect complicates nearest neighbor search in high dimensional space. It is not possible to quickly reject candidates by using the difference in one coordinate as a lower bound for a distance based on all the dimensions.[^17] [^18]'
  );
});
