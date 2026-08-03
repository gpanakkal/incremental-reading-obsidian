import type { Locator, Page } from '@playwright/test';
import {
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import type { App } from 'obsidian';
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
 * Upper bound on waiting for Obsidian to finish booting a vault.
 *
 * This is a ceiling, not a cost: the wait resolves as soon as the workspace is
 * ready, so raising it never slows a passing run — it only decides how long a
 * doomed run burns before reporting. Kept small so a genuinely broken boot
 * fails fast instead of stalling the suite.
 *
 * Measured over a full serial suite run (n=34, first launch included), the wait
 * resolved in 2-24ms: callers reach it only after `domcontentloaded` and the
 * first-launch prompts, by which point Obsidian has already booted, so this
 * normally costs a single poll. 10s is ~400x the observed worst case, which
 * leaves ample room for a loaded CI runner.
 */
const LAYOUT_READY_TIMEOUT_MS = 10_000;
/** How often to re-check readiness. */
const LAYOUT_READY_POLL_MS = 100;

/**
 * Wait until Obsidian has finished booting the vault.
 *
 * `domcontentloaded` only means the document parsed. Obsidian then indexes the
 * vault, deserializes the workspace, and loads community plugins — any of which
 * can replace the renderer's execution context. Code that calls `evaluate()`
 * before that settles fails with "Execution context was destroyed, most likely
 * because of a navigation".
 *
 * `waitForFunction` is the only primitive that can safely wait *through* such a
 * teardown: Playwright re-injects and re-polls the predicate in whatever context
 * is current, whereas a bare `evaluate()` rejects when its context dies.
 */
export async function waitForLayoutReady(
  window: Page,
  timeout = LAYOUT_READY_TIMEOUT_MS
) {
  await window.waitForFunction(
    () => Boolean((window as Page & { app?: App }).app?.workspace?.layoutReady),
    undefined,
    { timeout, polling: LAYOUT_READY_POLL_MS }
  );
  return window;
}

/**
 * Wait for a booted vault window, surviving Obsidian replacing it mid-boot.
 *
 * `waitForFunction` rides out a navigation, but not the page being *closed* —
 * that rejects with "Target page, context or browser has been closed". During
 * startup Obsidian does close and recreate windows, so a handle that was valid
 * when we picked it can die while we watch it. Re-resolve by URL and try again
 * on the successor rather than failing the test.
 */
async function waitForBootedVaultWindow(app: ElectronApplication, window: Page) {
  const deadline = Date.now() + LAYOUT_READY_TIMEOUT_MS;
  let current = window;

  while (Date.now() < deadline) {
    if (hasExited(app)) return current;

    try {
      // Never pass 0: Playwright reads that as "no timeout", which would turn
      // the last iteration of a loop that is out of budget into an infinite
      // wait — the exact opposite of the deadline being enforced here.
      return await waitForLayoutReady(
        current,
        Math.max(1, deadline - Date.now())
      );
    } catch (error) {
      // A timeout means Obsidian is genuinely not booting; only a closed page
      // is worth retrying, and only against a *different* window than the one
      // that just died.
      if (!isPageClosedError(error)) throw error;

      // Bounded by our own remaining budget so a retry cannot outlive the
      // deadline this loop is enforcing.
      const successor = await waitForVaultWindow(
        app,
        current,
        Math.max(1, deadline - Date.now())
      );
      if (successor === current || successor.isClosed()) {
        await wait(POLL_INTERVAL_MS);
        continue;
      }
      current = successor;
    }
  }

  return current;
}

/** Whether a Playwright rejection is the page/context/browser having closed. */
function isPageClosedError(error: unknown) {
  return (
    error instanceof Error &&
    /Target (page|closed)|has been closed/i.test(error.message)
  );
}

/**
 * Timeout for UI that is expected to be present shortly after a window loads,
 * or not at all. Obsidian renders these once the window is ready, so a short
 * bound is enough — and it keeps paths where they never appear from paying
 * Playwright's 30s default.
 */
const OPTIONAL_ELEMENT_TIMEOUT_MS = 5000;

/** How long to wait for the vault window to appear among the app's windows. */
const VAULT_WINDOW_TIMEOUT_MS = 10_000;

/**
 * Resolve the live vault window, waiting for it to appear if necessary.
 *
 * Window handles captured during startup go stale: Obsidian creates and
 * destroys transient windows while booting, so the only reliable identity is
 * the URL. Skips closed pages so a destroyed settings window is never returned.
 *
 * Falls back to `current` if no vault window is ever found, so callers still
 * fail on their own assertions rather than on this helper. Callers that are
 * themselves on a deadline pass `timeout` so this cannot outlive them.
 */
async function waitForVaultWindow(
  app: ElectronApplication,
  current: Page,
  timeout = VAULT_WINDOW_TIMEOUT_MS
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (hasExited(app)) return current;

    const vaultWindow = app
      .windows()
      .find((page) => !page.isClosed() && page.url().includes(VAULT_WINDOW_URL));

    if (vaultWindow) {
      await vaultWindow.waitForLoadState('domcontentloaded');
      return vaultWindow;
    }
    await wait(POLL_INTERVAL_MS);
  }

  return current;
}

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
  }

  // Re-resolve the vault window by URL rather than trusting the handle above.
  // `waitForEvent('window')` yields whichever window Obsidian happened to
  // create next, which in 1.13 is often the transient settings window —
  // and `dismissFirstLaunchPrompts` destroys that one, leaving us holding a
  // closed page ("Target page, context or browser has been closed").
  window = await waitForVaultWindow(app, window);

  // Wait for Obsidian to finish booting rather than guessing with a fixed
  // delay. A short sleep is a bet on machine speed that loaded CI runners lose:
  // the first evaluate() in a test then lands mid-navigation and the test dies
  // with "Execution context was destroyed".
  window = await waitForBootedVaultWindow(app, window);

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
const SETTINGS_WINDOW_TIMEOUT_MS = 5_000;
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
