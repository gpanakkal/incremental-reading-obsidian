import type { Locator, Page } from '@playwright/test';
import {
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'path';

/**
 * Thanks to qawatake for providing an example testing setup
 * at https://github.com/qawatake/obsidian-e2e-sample
 */
export const appPath = path.resolve('./.obsidian-unpacked/main.js');
export const sourceVaultPath = path.resolve('./e2e-tests/setup/test-vault');
export const testVaultsDir = path.resolve('./e2e-tests/test-vaults');
export const projectRoot = path.resolve('.');

// Disable Chromium sandbox on Linux CI (required for GitHub Actions)
export const sandboxArg =
  process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

export const shouldCleanup = process.env.E2E_CLEANUP === '1';

export async function createVaultCopy(
  prefix: string,
  subDirectory?: string,
  adminElevated?: boolean
) {
  await fs.mkdir(testVaultsDir, { recursive: true });
  const id = crypto.randomUUID().slice(0, 8);
  const pathSegments = [testVaultsDir];
  if (subDirectory) pathSegments.push(subDirectory);
  const name = prefix ? `${prefix}-${id}` : id;
  const vaultPath = path.join(...pathSegments, name);
  await fs.cp(sourceVaultPath, vaultPath, { recursive: true });

  // Ensure plugin files in the copied vault point to the freshly built plugin.
  // On Unix, the source vault contains symlinks which break after copying
  // (their relative targets no longer resolve). On Windows, setup-obsidian.ps1
  // copies files which become stale after rebuilding. Either way, we need to
  // refresh the plugin files from the project root.
  const pluginDir = path.join(
    vaultPath,
    // eslint-disable-next-line obsidianmd/hardcoded-config-path -- test file, ignore
    '.obsidian/plugins/incremental-reading'
  );
  await fs.mkdir(pluginDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    const target = path.join(pluginDir, file);
    await fs.rm(target, { force: true });
    if (process.platform === 'win32' && !adminElevated) {
      // Windows: copy files (symlinks require admin rights)
      await fs.copyFile(path.join(projectRoot, file), target);
    } else {
      // Unix: use symlinks for faster iteration during development
      await fs.symlink(path.join(projectRoot, file), target);
    }
  }

  return vaultPath;
}

export const deleteVaultCopy = async (vaultPath: string) =>
  await fs.rm(vaultPath, { recursive: true, force: true });

export function userDataDir(vaultPath: string) {
  return path.join(vaultPath, '.user-data');
}

export async function launchElectron(vaultPath: string) {
  return electron.launch({
    args: [
      ...sandboxArg,
      `--user-data-dir=${userDataDir(vaultPath)}`,
      appPath,
      'open',
    ],
  });
}

/** Upper bound on waiting for a closed Electron process to report its exit. */
const EXIT_TIMEOUT_MS = 10_000;

/**
 * Whether the Electron process is gone.
 *
 * `app.process()` does not merely report a dead process — it throws once
 * Playwright has disposed the application handle, so the throw itself is a
 * positive signal that the app has exited.
 */
function hasExited(app: ElectronApplication) {
  try {
    return app.process().exitCode !== null;
  } catch {
    return true;
  }
}

/**
 * Close the Electron app and wait for the process to fully exit.
 * On Windows/Linux CI, app.close() can resolve before the Node ChildProcess
 * 'exit' event fires (Playwright may terminate the process at the OS level in
 * a way that bypasses Node's event machinery). A polling fallback ensures we
 * always escape the wait, preventing afterEach timeouts in CI.
 */
export async function closeElectron(app: ElectronApplication) {
  // If the app already crashed, Playwright has torn down its internal handle
  // and `process()` throws. There is nothing left to close, and letting this
  // throw from afterEach would replace the test's real failure with a
  // confusing "Cannot read properties of undefined" error.
  let proc: ReturnType<ElectronApplication['process']>;
  try {
    proc = app.process();
  } catch {
    return;
  }

  // Register 'exit' listener before calling close() so we don't miss the event.
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
    } else {
      proc.on('exit', resolve);
    }
  });

  // A crashed app rejects here; the process is already gone, so fall through
  // to the exit wait rather than failing teardown.
  await app.close().catch(() => {});

  // After close() resolves, the process may have already exited without firing
  // the 'exit' event (observed in CI on Windows/Linux). Race the event listener
  // against a polling fallback to avoid hanging indefinitely.
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const started = Date.now();
      const id = setInterval(() => {
        // Give up after a bounded wait: a process that never reports an exit
        // code should not hold the whole suite until the test timeout.
        if (proc.exitCode !== null || Date.now() - started > EXIT_TIMEOUT_MS) {
          clearInterval(id);
          resolve();
        }
      }, 100);
    }),
  ]);
}
/**
 * Uses `Locator.evaluate` to click via DOM API directly.
 * May be more reliable in Electron.
 */
export async function click(locator: Locator) {
  return locator.evaluate((el: HTMLElement) => el.click());
}
export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Obsidian's vault picker, shown only when no vault is set to reopen. */
const LAUNCHER_WINDOW_URL = 'starter.html';

/**
 * Timeout for UI that is expected to be present shortly after a window loads,
 * or not at all. Obsidian renders these once the window is ready, so a short
 * bound is enough — and it keeps paths where they never appear from paying
 * Playwright's 30s default.
 */
const OPTIONAL_ELEMENT_TIMEOUT_MS = 5000;

/**
 * Open a vault in Obsidian by stubbing the file picker, trusting the author,
 * and dismissing any modals. Returns the vault's main window.
 *
 * Handles both a first launch of a fresh vault (launcher → trust prompt →
 * community-plugins modal → settings window) and a relaunch of a vault
 * Obsidian already knows, where none of those appear.
 */
export async function openVault(app: ElectronApplication, vaultPath: string) {
  let window = await app.firstWindow();

  // Wait for the Obsidian launcher window to finish loading
  await window.waitForLoadState('domcontentloaded');

  // Stub the file picker
  await app.evaluate(({ dialog }, fakePath) => {
    dialog.showOpenDialogSync = () => {
      return [fakePath];
    };
  }, vaultPath);

  // Obsidian only shows the launcher when it has no vault to reopen; on later
  // launches it restores the vault directly. The window's URL tells us which
  // case we are in, so the first-launch-only prompts below are probed only when
  // they can actually appear. Probing them unconditionally cost a full timeout
  // each on every reopen.
  const isFirstLaunch = window.url().includes(LAUNCHER_WINDOW_URL);

  if (isFirstLaunch) {
    await window.getByRole('button', { name: 'Open' }).click();

    // Wait for the vault window to open after selecting the vault
    window = await app.waitForEvent('window');
    await window.waitForLoadState('domcontentloaded');

    await dismissFirstLaunchPrompts(app, window);
  } else {
    window =
      app.windows().find((page) => page.url().includes(VAULT_WINDOW_URL)) ??
      window;
    await window.waitForLoadState('domcontentloaded');
  }

  // brief pause so Obsidian is ready to take input
  await wait(200);

  // maximize the window
  const maximizeButton = window.getByLabel('Maximize');
  try {
    await maximizeButton.click({ timeout: OPTIONAL_ELEMENT_TIMEOUT_MS });
  } catch {
    // Already maximized (Obsidian restores window state on reopen)
  }

  // Guarantee the vault window is the one receiving keyboard input. On a
  // relaunch no settings window is created, but the vault window is not always
  // focused either, so this runs on every path.
  await focusVaultWindow(app);

  return window;
}

/** Bring the vault window to the front so it receives keyboard input. */
async function focusVaultWindow(app: ElectronApplication) {
  try {
    await app.evaluate(({ BrowserWindow }, urlFragment) => {
      const vaultWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes(urlFragment)
      );
      if (!vaultWindow) return;
      if (vaultWindow.isMinimized()) vaultWindow.restore();
      vaultWindow.show();
      vaultWindow.focus();
    }, VAULT_WINDOW_URL);
  } catch {
    // Focusing is best-effort; if the app is already tearing down there is
    // nothing to focus and the caller's own assertions should report the
    // failure, not this helper.
  }
}

/**
 * Handle the prompts Obsidian shows only the first time a vault is opened:
 * the plugin-author trust dialog, the community-plugins modal, and the
 * separate settings window that dismissing that modal spawns.
 */
async function dismissFirstLaunchPrompts(
  app: ElectronApplication,
  window: Page
) {
  // Trust the author of the vault (if dialog appears).
  // Shown when opening a vault with community plugins for the first time.
  const trustButton = window.getByRole('button', {
    name: 'Trust author and enable plugins',
  });
  try {
    await trustButton.waitFor({
      state: 'visible',
      timeout: OPTIONAL_ELEMENT_TIMEOUT_MS,
    });
    await trustButton.click({ timeout: OPTIONAL_ELEMENT_TIMEOUT_MS });
  } catch {
    // Dialog didn't appear - vault was previously trusted, continue
  }

  // Close the community plugins modal if it appears
  const enablePluginsModal = window.locator('.modal-bg');
  let dismissedPluginsModal = false;
  try {
    await enablePluginsModal.waitFor({
      state: 'visible',
      timeout: OPTIONAL_ELEMENT_TIMEOUT_MS,
    });
    await window.keyboard.press('Escape');
    await enablePluginsModal.waitFor({
      state: 'hidden',
      timeout: OPTIONAL_ELEMENT_TIMEOUT_MS,
    });
    dismissedPluginsModal = true;
  } catch {
    // Modal didn't appear, continue
  }

  // Dismissing that modal is what spawns the settings window, so this wait is
  // only reachable when the modal was actually shown.
  if (dismissedPluginsModal) {
    await closeSettingsWindow(app);
  }
}

/** Obsidian's vault window is the only one served from `index.html`. */
const VAULT_WINDOW_URL = 'index.html';

/** How long to wait for the settings window to be created after Escape. */
const SETTINGS_WINDOW_TIMEOUT_MS = 15_000;
/** After destroying it, how long to watch for a follow-up window. */
const SETTINGS_WINDOW_SETTLE_MS = 500;
const POLL_INTERVAL_MS = 50;

/**
 * Destroy the separate settings window and restore focus to the vault window.
 *
 * Obsidian 1.13 moved settings out of an in-window modal and into its own
 * BrowserWindow. Dismissing the community-plugins modal opens it, and because
 * it takes focus, later keyboard input (quick switcher, command palette) is
 * delivered to the settings window rather than the vault.
 *
 * Two properties of this window make it awkward to detect:
 *
 * 1. It is created asynchronously — about 300ms after the Escape keypress on a
 *    warm dev machine. A snapshot of `app.windows()` taken right after the
 *    modal hides usually predates it, which is why a fixed short wait is flaky.
 * 2. It starts out `about:blank`, hidden, and titled "Electron", only later
 *    settling into a visible window titled "Settings — <vault>". So we identify
 *    it by elimination (any window that is not the vault) rather than by title.
 *
 * Only call this when the community-plugins modal was actually dismissed:
 * on later launches of an already-trusted vault the modal never shows, no
 * settings window is ever created, and we would wait out the full timeout for
 * nothing.
 */
async function closeSettingsWindow(app: ElectronApplication) {
  const deadline = Date.now() + SETTINGS_WINDOW_TIMEOUT_MS;
  let destroyedAny = false;

  // Phase 1: wait for the window to appear, then destroy it.
  while (Date.now() < deadline) {
    // If Obsidian has died there is nothing left to wait for, and blocking for
    // the full timeout would only delay the real failure the caller will hit.
    if (hasExited(app)) return;

    if ((await destroyNonVaultWindows(app)) > 0) {
      destroyedAny = true;
      break;
    }
    await wait(POLL_INTERVAL_MS);
  }

  if (!destroyedAny) {
    // Not fatal: a future Obsidian version may stop opening this window, and
    // the tests are fine in that case. Warn so the cause of the added delay is
    // discoverable rather than silent.
    console.warn(
      `[openVault] No settings window appeared within ` +
        `${SETTINGS_WINDOW_TIMEOUT_MS}ms of dismissing the community plugins ` +
        `modal. If Obsidian no longer opens one, remove this wait from ` +
        `e2e-tests/setup/helpers.ts.`
    );
  }

  // Phase 2: make sure no replacement window follows.
  const settleDeadline = Date.now() + SETTINGS_WINDOW_SETTLE_MS;
  while (Date.now() < settleDeadline) {
    await wait(POLL_INTERVAL_MS);
    await destroyNonVaultWindows(app);
  }
}

/**
 * Destroys every window except the vault window in a single main-process round
 * trip, refocusing the vault window afterwards. Returns the number destroyed.
 *
 * Uses `destroy()` rather than `close()` so the teardown cannot be delayed or
 * vetoed by the window's own `close` handlers, and so it works even while the
 * window is still `about:blank`.
 */
async function destroyNonVaultWindows(app: ElectronApplication) {
  try {
    return await app.evaluate(({ BrowserWindow }, urlFragment) => {
      const windows = BrowserWindow.getAllWindows();
      const vaultWindow = windows.find((candidate) =>
        candidate.webContents.getURL().includes(urlFragment)
      );
      // Without a vault window we cannot tell which window to keep; wait for
      // the next poll rather than risk destroying the vault itself.
      if (!vaultWindow) return 0;

      const others = windows.filter(
        (candidate) => candidate !== vaultWindow && !candidate.isDestroyed()
      );
      others.forEach((candidate) => candidate.destroy());

      if (others.length > 0) {
        vaultWindow.show();
        vaultWindow.focus();
      }

      return others.length;
    }, VAULT_WINDOW_URL);
  } catch {
    // A window can be torn down between listing and destroying it, and the app
    // itself may go away while we poll. Report "nothing destroyed" and let the
    // caller decide whether to keep waiting.
    return 0;
  }
}
