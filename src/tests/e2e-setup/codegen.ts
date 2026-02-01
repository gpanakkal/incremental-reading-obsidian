import { createVaultCopy, launchElectron, openVault } from './helpers';
/**
 * See https://github.com/microsoft/playwright/issues/5181#issuecomment-2769098576
 */
(async () => {
  const vaultPath = await createVaultCopy('codegen');
  const app = await launchElectron(vaultPath);

  const context = app.context();
  await context.route('**/*', (route) => route.continue());

  const window = await openVault(app, vaultPath);
  await window.pause();
})();
