import path from 'path';
import {
  createVaultCopy,
  deleteVaultCopy,
  launchElectron,
  openVault,
  testVaultsDir,
} from './helpers';
/**
 * Recording harness: opens a throwaway vault and hands the window to the
 * Playwright Inspector, whose Record button writes selectors as you click.
 *
 * `window.pause()` is the whole mechanism — it is what opens the Inspector. The
 * recipe this is based on
 * (https://github.com/microsoft/playwright/issues/5181#issuecomment-2769098576)
 * also installs `context.route('**\/*', route => route.continue())`, which is
 * incidental to recording and actively harmful here, so it is deliberately
 * absent.
 *
 * Why it is harmful: Playwright always calls `Fetch.enable` with a catch-all
 * pattern and matches URLs in JS, so *every* request on a routed target is
 * re-issued via `Fetch.continueRequest` — including ones no handler matches.
 * Re-issuing goes through Chromium's network stack, which knows nothing about
 * the `app://` protocol Obsidian registers in the main process, so those
 * responses come back empty.
 *
 * The vault window survives that (it fetches `app.css` before Playwright
 * attaches to the new target), but Obsidian 1.13's settings window does not.
 * It is a `window.open('about:blank')` popout that Obsidian styles by cloning
 * the vault window's `<link href="app.css">` into it and re-fetching — well
 * after interception is live. Measured on the settings window: 3 stylesheets
 * and a painted background without the route, 2 and a transparent background
 * with it. On screen that is a settings window rendered as unstyled HTML.
 *
 * Narrowing the pattern does not help, for the reason above. Remove the route
 * or accept broken styling.
 */
void (async () => {
  await deleteVaultCopy(path.join(testVaultsDir, 'codegen'));
  const vaultPath = await createVaultCopy('', 'codegen', true);
  const app = await launchElectron(vaultPath);

  const window = await openVault(app, vaultPath);
  await window.pause();
})();
