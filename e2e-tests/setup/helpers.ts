import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
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

/**
 * Whether to keep Obsidian's windows off the desktop for this run.
 *
 * Defaults to off, so an ad-hoc `playwright test` still shows what it is doing.
 * The `pnpm e2e*` scripts opt in, because a local suite run otherwise throws a
 * popup on screen per test and steals focus mid-keystroke.
 *
 * Electron cannot run headless the way Chromium can — Obsidian creates its own
 * `BrowserWindow`s and there is no launch flag to suppress them — so this works
 * by preloading a main-process patch instead. See ./hide-windows.cjs.
 *
 * NOTE: CI runs *headed* (`e2e:headed`), so that preload — and with it the
 * error-dialog suppression and updater blocking it also installs — is absent on
 * exactly the machines that need it most. `applyStabilityPatches` below covers
 * that gap for both modes.
 */
export const isHeadless = process.env.E2E_HEADLESS === '1';

/**
 * Preload the window-hiding patch into Electron's main process, which runs it
 * before Obsidian's own entry point — the only moment early enough to intercept
 * construction of the launcher window.
 *
 * Must be spelled `-r <path>` as two separate argv entries, matching how
 * Playwright passes its own loader. The `--require=<path>` form is not a flag
 * Electron recognizes, and an unrecognized `--`-flag makes it parse the whole
 * command line in strict Node mode, where it then rejects every Chromium switch
 * (including Playwright's own `--remote-debugging-port`) with "bad option" and
 * fails to launch at all.
 */
const hideWindowsArg = isHeadless
  ? ['-r', path.resolve('./e2e-tests/setup/hide-windows.cjs')]
  : [];

/**
 * Chromium throttles timers, rAF, and painting in windows it believes are
 * hidden or occluded — which, in this mode, is all of them. Left on, the
 * renderer effectively stalls and tests time out waiting for UI that is never
 * painted. These switches are what make a hidden window behave like a visible
 * one.
 */
const noThrottlingArgs = isHeadless
  ? [
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
    ]
  : [];

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

/**
 * Tail of Electron's stderr, kept per app so a boot failure can report what
 * the process actually said before dying. Without this, an Electron that
 * exits during startup surfaces only as a timeout with no cause attached.
 */
const stderrTails = new WeakMap<ElectronApplication, string[]>();
const STDERR_TAIL_LINES = 20;

/** The last thing Electron printed before it died, if anything. */
export function lastStderr(app: ElectronApplication) {
  return (stderrTails.get(app) ?? []).join('\n');
}

/**
 * Neutralize the two main-process behaviours that can hang an unattended run:
 * native modal dialogs, and the auto-updater's network calls.
 *
 * `hide-windows.cjs` already installs equivalent patches, but only on headless
 * runs — and CI runs headed, so on CI nothing installs them. Rather than move
 * the preload behind a second `-r` (Electron accepts only one; Playwright owns
 * it), this reapplies the same protections over CDP on every run. Re-patching
 * an already-patched main process is harmless.
 *
 * The tradeoff versus a preload is timing: this runs after Obsidian's `main.js`
 * has started, so a dialog raised in the first moments of boot is still missed.
 * That is acceptable — the failures this addresses come from dialogs raised
 * mid-test and during teardown — and `closeElectron`'s timeout bounds the
 * boot-time case by killing a process that will not close.
 *
 * Best-effort by design: a failure to patch is not worth failing the test over.
 */
async function applyStabilityPatches(app: ElectronApplication) {
  try {
    await app.evaluate(({ dialog, app: electronApp, session }, hosts) => {
      // Obsidian's `uncaughtException` handler ends in `showErrorBox`, which is
      // synchronous and modal: the main process then answers nothing, including
      // Playwright's `app.close()`, until someone clicks OK. On CI that is
      // nobody, so teardown hangs until the worker is killed — taking the
      // results of every test that worker already ran with it.
      dialog.showErrorBox = (title: string, message: string) => {
        console.error(`[e2e] suppressed error dialog: ${title}\n${message}`);
      };

      // Same hazard, other entry point. A *Sync* message box blocks just as
      // hard; answer with the default button instead of waiting for a click.
      dialog.showMessageBoxSync = ((options: { defaultId?: number }) =>
        options?.defaultId ?? 0) as typeof dialog.showMessageBoxSync;
      dialog.showMessageBox = ((options: { defaultId?: number }) => ({
        response: options?.defaultId ?? 0,
        checkboxChecked: false,
      })) as unknown as typeof dialog.showMessageBox;

      // `main.js` calls `queueUpdate()` on every launch, fetching release
      // metadata before the workspace finishes booting. Across a full suite
      // that is dozens of unauthenticated requests from one runner IP, landing
      // in exactly the window where tests wait on `layoutReady`. Nothing under
      // test depends on the updater, and Obsidian treats a failed check as
      // non-fatal, so refuse them rather than letting network conditions leak
      // into test outcomes.
      const block = () =>
        session.defaultSession.webRequest.onBeforeRequest(
          { urls: hosts.map((host) => `*://${host}/*`) },
          (_details, callback) => callback({ cancel: true })
        );

      // `whenReady` has usually already resolved by the time this runs; calling
      // it again is safe and covers the case where it has not.
      if (electronApp.isReady()) block();
      else void electronApp.whenReady().then(block);
    }, UPDATE_HOSTS);
  } catch {
    // The app can die during launch, and a version bump could rename any of
    // these APIs. Neither is worth replacing the test's real failure with a
    // stack pointing at this helper.
  }
}

/** Hosts Obsidian's auto-updater contacts on every launch. */
const UPDATE_HOSTS = ['releases.obsidian.md', 'raw.githubusercontent.com'];

export async function launchElectron(vaultPath: string) {
  const app = await electron.launch({
    args: [
      ...sandboxArg,
      ...hideWindowsArg,
      ...noThrottlingArgs,
      `--user-data-dir=${userDataDir(vaultPath)}`,
      appPath,
      'open',
    ],
    // Deliberately no `env`: Playwright's test workers run with
    // ELECTRON_RUN_AS_NODE=1, and forwarding that to the child puts Electron in
    // plain-Node mode, where it rejects every Chromium switch (including
    // Playwright's own --remote-debugging-port) with "bad option" and never
    // launches. Omitting the key lets Playwright supply a sanitized environment.
  });

  await applyStabilityPatches(app);

  const tail: string[] = [];
  stderrTails.set(app, tail);

  const proc = app.process();
  proc.stderr?.on('data', (chunk: Buffer) => {
    tail.push(chunk.toString());
    if (tail.length > STDERR_TAIL_LINES)
      tail.splice(0, tail.length - STDERR_TAIL_LINES);
  });

  // Record the real OS-level exit separately from Playwright disposing its
  // handle. The two are easy to confuse — `app.process()` throws in both
  // cases — but only one of them means Obsidian actually died.
  proc.on('exit', (code, signal) => {
    exitedForReal.set(app, { code, signal });
  });

  return app;
}

/** OS-level exit, recorded only when the child process genuinely exits. */
const exitedForReal = new WeakMap<
  ElectronApplication,
  { code: number | null; signal: NodeJS.Signals | null }
>();

/** Upper bound on waiting for a closed Electron process to report its exit. */
const EXIT_TIMEOUT_MS = 10_000;

/**
 * Upper bound on `app.close()` itself.
 *
 * `close()` asks Electron to shut down gracefully, and a main process that is
 * blocked cannot answer. The known blocker is a native modal error box: Obsidian
 * ends its `uncaughtException` handler in `dialog.showErrorBox`, which is
 * synchronous and modal, so the process sits there until somebody clicks OK —
 * which, on a CI runner, is nobody.
 *
 * `applyStabilityPatches` stubs that out, but only from the moment it runs — a
 * dialog raised earlier in boot still lands here — and a wedged main process
 * has other ways to stop answering. This bound is the backstop.
 *
 * Without a bound here, that hang is absorbed by Playwright's *worker* teardown
 * timeout instead, which kills the worker and discards the results of every test
 * it had already run. Capping it converts a lost worker into one failed test.
 */
const CLOSE_TIMEOUT_MS = 20_000;

/** Resolves to `true` on timeout, `false` if the promise settled in time. */
async function raceTimeout(promise: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    return await Promise.race([promise.then(() => false), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the app is unusable — either the process exited or Playwright has
 * disposed its handle.
 *
 * These are two different states and the distinction matters when diagnosing a
 * failure: `app.process()` throws in both cases, so a throw does NOT prove the
 * process died. Use `exitedForReal` to tell them apart; it is populated only
 * from the child process's own 'exit' event.
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
  //
  // Bounded, because a main process blocked in a modal dialog never answers the
  // close request at all. See CLOSE_TIMEOUT_MS.
  const closeHung = await raceTimeout(
    app.close().catch(() => {}),
    CLOSE_TIMEOUT_MS
  );

  if (closeHung) {
    console.warn(
      `[closeElectron] app.close() did not resolve within ` +
        `${CLOSE_TIMEOUT_MS}ms; killing the process. This usually means the ` +
        `main process is blocked in a native modal (e.g. Obsidian's error ` +
        `box). stderr: ${lastStderr(app) || '<none>'}`
    );
    killProcessTree(proc);
  }

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

  // Last resort. A surviving Electron keeps a lock on the vault directory, so
  // the cleanup step that follows in afterEach fails on Windows with EBUSY —
  // and the next test's fresh-vault copy inherits a dirty user-data dir.
  if (proc.exitCode === null) killProcessTree(proc);
}

/**
 * Terminate Electron and its renderer children.
 *
 * `proc.kill()` alone is not enough on Windows: it signals only the top-level
 * process, leaving the renderer and GPU children alive and still holding file
 * handles inside the vault. `taskkill /T` walks the tree. On POSIX, SIGKILL to
 * the process group does the same job.
 */
function killProcessTree(proc: ChildProcess) {
  const { pid } = proc;
  try {
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    // Already gone, or we lack permission to signal it. Either way there is
    // nothing further teardown can do, and throwing here would replace the
    // test's real failure with a teardown error.
  }
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
    () => (window as Page & { app?: App }).app?.workspace?.layoutReady,
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
async function waitForBootedVaultWindow(
  app: ElectronApplication,
  window: Page
) {
  const deadline = Date.now() + LAYOUT_READY_TIMEOUT_MS;
  let current = window;

  while (Date.now() < deadline) {
    // The Electron process is gone, so no window will ever become ready. Say
    // so here rather than returning a dead handle for the test to trip over.
    if (hasExited(app)) {
      const exit = exitedForReal.get(app);
      throw new Error(
        (exit
          ? `Obsidian exited before the workspace was ready ` +
            `(code=${exit.code} signal=${exit.signal}). `
          : 'Lost the Electron debugger connection before the workspace was ' +
            'ready. ') + `stderr: ${lastStderr(app) || '<none>'}`
      );
    }

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

  // Out of budget without ever seeing a ready workspace. Returning `current`
  // here would hand the caller a page that is very likely closed, and the
  // failure would then surface on the test's first interaction — a stack
  // pointing at `getByLabel(...).click()` for a vault that never booted.
  // Fail where the problem actually is.
  throw new Error(
    `Obsidian did not reach layoutReady within ${LAYOUT_READY_TIMEOUT_MS}ms. ` +
      `Last window url: ${current.isClosed() ? '<closed>' : current.url()}`
  );
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
 * Viewport used in place of maximizing when windows are hidden.
 *
 * Maximizing exists so the workspace is wide enough that Obsidian does not
 * collapse the sidebars or wrap the toolbars the tests interact with. A fixed
 * size buys the same thing and, unlike maximizing, is identical on every
 * machine regardless of display resolution.
 */
const HEADLESS_VIEWPORT = { width: 1920, height: 1080 };

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
      .find(
        (page) => !page.isClosed() && page.url().includes(VAULT_WINDOW_URL)
      );

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
    // This click destroys the page it is clicking. The picker stub above is
    // synchronous, so Obsidian opens the vault and tears down starter.html
    // inside the click handler while Playwright's input round-trip is still in
    // flight. `noWaitAfter` skips the post-action navigation wait, but the
    // dispatch itself still loses the race on a loaded runner, so a closed
    // target here is the success path — the vault window below is the proof
    // that the click landed.
    try {
      await window
        .getByRole('button', { name: 'Open' })
        .click({ noWaitAfter: true });
    } catch (error) {
      if (!isPageClosedError(error)) throw error;
    }

    // Resolve the vault window by URL before dismissing anything. The prompts
    // render in the *vault* window, not the launcher, and probing them on a
    // stale handle fails silently: `dismissFirstLaunchPrompts` treats a missing
    // prompt as "already dismissed", so the trust dialog survives and every
    // later test runs against a vault whose plugins never loaded.
    window = await waitForVaultWindow(app, window);

    await dismissFirstLaunchPrompts(app, window);
  }

  // Re-resolve once more: `dismissFirstLaunchPrompts` destroys the transient
  // settings window Obsidian 1.13 opens, and if the handle above happened to be
  // that window we would now be holding a closed page ("Target page, context or
  // browser has been closed").
  window = await waitForVaultWindow(app, window);

  // Wait for Obsidian to finish booting rather than guessing with a fixed
  // delay. A short sleep is a bet on machine speed that loaded CI runners lose:
  // the first evaluate() in a test then lands mid-navigation and the test dies
  // with "Execution context was destroyed".
  window = await waitForBootedVaultWindow(app, window);

  // Maximizing is about giving a *visible* window enough room for the layout
  // under test. In headless mode the window is deliberately off-screen and its
  // maximize() is a no-op, so the click can only ever cost a full timeout —
  // set the viewport directly instead, which is what maximizing was buying us.
  //
  // Best-effort, like the maximize click it replaces. Obsidian can close and
  // recreate windows during boot, and `waitForBootedVaultWindow` deliberately
  // returns its handle rather than throwing when the app dies — so this can be
  // reached holding a page that is already gone. Sizing the window is cosmetic;
  // letting it throw here would replace the test's real failure with a
  // "Target page, context or browser has been closed" pointing at this line.
  if (isHeadless) {
    await window.setViewportSize(HEADLESS_VIEWPORT).catch(() => {});
  } else {
    const maximizeButton = window.getByLabel('Maximize');
    try {
      await maximizeButton.click({ timeout: OPTIONAL_ELEMENT_TIMEOUT_MS });
    } catch {
      // Already maximized (Obsidian restores window state on reopen)
    }

    // Guarantee the vault window is the one receiving keyboard input. On a
    // relaunch no settings window is created, but the vault window is not
    // always focused either, so this runs on every path.
    //
    // Skipped when headless: no window is on the desktop to focus, Playwright
    // delivers input over CDP rather than through the OS, and the patched
    // show()/focus() are no-ops.
    await focusVaultWindow(app);
  }

  // Last gate before the test body runs.
  //
  // Deliberately after maximize and focus rather than right after boot: the
  // settings window is created a few hundred ms into startup, so a check any
  // earlier can pass and still leave one behind. Nothing above is allowed to
  // hand back a workspace that shares the app with another window.
  await assertVaultWindowIsAlone(app);

  return window;
}

/**
 * Bring the vault window to the front so it receives keyboard input.
 *
 * Verifies rather than assumes. A lone show()/focus() pair can be refused —
 * another window still holding focus, or a window manager that has not finished
 * mapping this one — and the previous version returned as though it had worked.
 * Being wrong is expensive and hard to read later: Obsidian opens modals in
 * whichever BrowserWindow is focused, so a lost focus race sends the quick
 * switcher and the plugin's own modals to a window no assertion is watching.
 *
 * Warns rather than throws when focus never lands. `assertVaultWindowIsAlone`
 * is the hard guard — with one window left there is nowhere else for a modal to
 * go, so unfocused-but-alone is survivable and not worth failing a boot over.
 */
async function focusVaultWindow(app: ElectronApplication) {
  const deadline = Date.now() + FOCUS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await tryFocusVaultWindow(app)) return true;
    await wait(POLL_INTERVAL_MS);
  }

  console.warn(
    `[openVault] The vault window did not take focus within ` +
      `${FOCUS_TIMEOUT_MS}ms. Harmless while it is the only window open; if ` +
      `tests start losing modals, suspect this first.`
  );
  return false;
}

/** One show/focus attempt. Reports whether the vault window ended up focused. */
async function tryFocusVaultWindow(app: ElectronApplication) {
  try {
    return await app.evaluate(({ BrowserWindow }, urlFragment) => {
      const vaultWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes(urlFragment)
      );
      if (!vaultWindow) return false;
      if (vaultWindow.isMinimized()) vaultWindow.restore();
      vaultWindow.show();
      vaultWindow.focus();
      return vaultWindow.isFocused();
    }, VAULT_WINDOW_URL);
  } catch {
    // Focusing is best-effort; if the app is already tearing down there is
    // nothing to focus and the caller's own assertions should report the
    // failure, not this helper.
    return false;
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

  // Close the community plugins modal if it appears.
  //
  // Best-effort and bounded: on Obsidian 1.13 the trust click frequently goes
  // straight to the settings window without ever raising an in-vault modal, so
  // this timing out is an ordinary outcome rather than a failure.
  const enablePluginsModal = window.locator('.modal-bg');
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
  } catch {
    // Modal didn't appear, continue
  }

  // Unconditional, because the modal is not what spawns the settings window.
  //
  // This used to be gated on having dismissed that modal, on the theory that
  // dismissing it is what opens settings. On a loaded Ubuntu runner the modal
  // never appeared within its bound, the gate skipped cleanup — and Obsidian
  // opened the settings window anyway. It then held focus and received every
  // modal the tests went on to open, including the plugin's own import modal,
  // so tests timed out waiting on a `.modal-bg` that had in fact rendered, just
  // in a window they were not watching.
  await closeSettingsWindow(app);
}

/** Obsidian's vault window is the only one served from `index.html`. */
const VAULT_WINDOW_URL = 'index.html';

/** How long to wait for the settings window to be created after Escape. */
const SETTINGS_WINDOW_TIMEOUT_MS = 5_000;
/** After destroying it, how long to watch for a follow-up window. */
const SETTINGS_WINDOW_SETTLE_MS = 500;
const POLL_INTERVAL_MS = 50;

/**
 * How long to keep clearing stray windows before failing the boot.
 *
 * A ceiling, not a cost: a healthy boot has no stray windows and pays one
 * window listing. This only bounds how long a doomed one retries.
 */
const STRAY_WINDOW_TIMEOUT_MS = 5_000;

/**
 * How long to wait for the vault window to actually take OS focus.
 *
 * Short on purpose. Focus either lands within a frame or two of `focus()` or a
 * window manager is refusing it, and waiting longer does not change which.
 */
const FOCUS_TIMEOUT_MS = 2_000;

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
 * Called on every first launch, whether or not the community-plugins modal
 * showed. Gating on that modal was the bug: when it failed to appear, cleanup
 * was skipped and the settings window survived. The cost of running it for
 * nothing is one `SETTINGS_WINDOW_TIMEOUT_MS` wait plus a warning, paid only on
 * a first launch — cheap next to a stray window redirecting every later modal.
 */
async function closeSettingsWindow(app: ElectronApplication) {
  const deadline = Date.now() + SETTINGS_WINDOW_TIMEOUT_MS;
  let closedAny = false;

  // Phase 1: wait for the window to appear, then destroy it.
  while (Date.now() < deadline) {
    // If Obsidian has died there is nothing left to wait for, and blocking for
    // the full timeout would only delay the real failure the caller will hit.
    if (hasExited(app)) return;

    if ((await closeNonVaultWindows(app)) > 0) {
      closedAny = true;
      break;
    }
    await wait(POLL_INTERVAL_MS);
  }

  if (!closedAny) {
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
    await closeNonVaultWindows(app);
  }
}

/**
 * Closes every window except the vault window in a single main-process round
 * trip, refocusing the vault window afterwards. Returns the number closed.
 *
 * Uses `close()`, NOT `destroy()`. `destroy()` tears the window down
 * synchronously, without running Obsidian's own teardown — and if Electron is
 * still inside `openGuestWindow` wiring that window up, its lifecycle events
 * then fire at handlers holding a now-dead reference:
 *
 *     TypeError: Object has been destroyed
 *       at WebContents.emit (node:events)
 *       at openGuestWindow (node:electron/js2c/browser_init)
 *
 * That lands in Obsidian's `uncaughtException` handler, which shows a modal
 * error dialog and takes the whole app down — surfacing in tests as Obsidian
 * dying before `layoutReady`, and later as "Target page, context or browser
 * has been closed" on whatever the test touched first.
 *
 * Measured over repeated fresh-vault boots: `destroy()` killed the app in
 * ~2/25 runs, `close()` in 0/25, and `close()` removes the settings window
 * just as reliably (one `index.html` window left standing either way).
 */
async function closeNonVaultWindows(app: ElectronApplication) {
  try {
    return await app.evaluate(({ BrowserWindow }, urlFragment) => {
      const windows = BrowserWindow.getAllWindows();
      const vaultWindow = windows.find((candidate) =>
        candidate.webContents.getURL().includes(urlFragment)
      );
      // Without a vault window we cannot tell which window to keep; wait for
      // the next poll rather than risk closing the vault itself.
      if (!vaultWindow) return 0;

      const others = windows.filter(
        (candidate) => candidate !== vaultWindow && !candidate.isDestroyed()
      );
      others.forEach((candidate) => {
        // Re-check: closing an earlier window in this loop can trigger
        // teardown of a dependent one.
        if (!candidate.isDestroyed()) candidate.close();
      });

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

/**
 * URLs of every window that is not the vault window, for reporting.
 *
 * Reports none when there is no vault window to compare against: callers reach
 * this only after `waitForBootedVaultWindow`, which already fails when the
 * vault window never arrives, so inventing a failure here would only mask that
 * one with a less specific message.
 */
async function listNonVaultWindows(app: ElectronApplication) {
  try {
    return await app.evaluate(({ BrowserWindow }, urlFragment) => {
      const windows = BrowserWindow.getAllWindows();
      const vaultWindow = windows.find((candidate) =>
        candidate.webContents.getURL().includes(urlFragment)
      );
      if (!vaultWindow) return [];

      return windows
        .filter(
          (candidate) => candidate !== vaultWindow && !candidate.isDestroyed()
        )
        .map((candidate) => candidate.webContents.getURL() || '<blank>');
    }, VAULT_WINDOW_URL);
  } catch {
    return [];
  }
}

/**
 * Fail the boot unless the vault window is the only one left standing.
 *
 * A surviving second window is not cosmetic. Obsidian opens modals in whichever
 * BrowserWindow holds focus, so one left behind silently redirects the quick
 * switcher, the command palette, and the plugin's own modals away from the
 * window under test — and every symptom of that surfaces later and elsewhere: a
 * `.modal-bg` that never becomes visible, a `switcher:open` that returns true
 * with nothing on screen, each reported against whichever helper looked first.
 * Checking here names the cause while the cause is still on screen.
 *
 * Closes what it finds before giving up, so a window that merely arrived late
 * gets handled rather than reported.
 */
async function assertVaultWindowIsAlone(app: ElectronApplication) {
  const deadline = Date.now() + STRAY_WINDOW_TIMEOUT_MS;
  let stray = await listNonVaultWindows(app);

  while (stray.length > 0 && Date.now() < deadline) {
    await closeNonVaultWindows(app);
    await wait(POLL_INTERVAL_MS);
    stray = await listNonVaultWindows(app);
  }

  if (stray.length > 0) {
    throw new Error(
      `Obsidian left ${stray.length} window(s) open besides the vault, and ` +
        `they survived ${STRAY_WINDOW_TIMEOUT_MS}ms of close() attempts: ` +
        `${stray.join(', ')}. Modals open in the focused window, so these ` +
        `would take the quick switcher and the plugin's own modals away from ` +
        `the window under test.`
    );
  }
}
