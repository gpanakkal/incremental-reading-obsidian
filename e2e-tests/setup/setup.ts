import type { ElectronApplication } from '@playwright/test';
import { test } from './fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
} from './helpers';

let app: ElectronApplication;
let vaultPath: string;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('setup');
  app = await launchElectron(vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

test('Set up test vault to make plugin ready to use when Obsidian opens', async () => {
  await openVault(app, vaultPath);
});
