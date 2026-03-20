import path from 'path';
import {
  createVaultCopy,
  deleteVaultCopy,
  launchElectron,
  openVault,
  testVaultsDir,
} from './helpers';
/**
 * See https://github.com/microsoft/playwright/issues/5181#issuecomment-2769098576
 */
void (async () => {
  await deleteVaultCopy(path.join(testVaultsDir, 'codegen'));
  const vaultPath = await createVaultCopy('', 'codegen');
  const app = await launchElectron(vaultPath);

  const context = app.context();
  await context.route('**/*', (route) => route.continue());

  const window = await openVault(app, vaultPath);
  await window.pause();
})();
