import {
  cleanTestVaultsDir,
  createVaultCopy,
  launchElectron,
  openVault,
  resetUserDataDir,
} from './helpers';
/**
 * See https://github.com/microsoft/playwright/issues/5181#issuecomment-2769098576
 */
(async () => {
  await cleanTestVaultsDir();
  const vaultPath = await createVaultCopy('codegen');
  await resetUserDataDir();
  const app = await launchElectron();

  const context = app.context();
  await context.route('**/*', (route) => route.continue());

  const window = await openVault(app, vaultPath);
  await window.pause();
})();
