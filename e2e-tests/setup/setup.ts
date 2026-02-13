import test, { type ElectronApplication } from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  createVaultCopy,
  launchElectron,
  closeElectron,
  shouldCleanup,
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
  if (shouldCleanup) {
    await fs.rm(vaultPath, { recursive: true, force: true });
  }
});

test('Set up test vault to make plugin ready to use when Obsidian opens', async () => {
  await openVault(app, vaultPath);
});
