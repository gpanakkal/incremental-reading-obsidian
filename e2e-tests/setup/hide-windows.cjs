/**
 * Electron main-process preload that keeps every window Obsidian opens off the
 * desktop, so a local e2e run does not spray popups across the screen or steal
 * keyboard focus from the editor you are working in.
 *
 * Loaded via Electron's `--require` flag (see `launchElectron` in ./helpers.ts),
 * which runs it in the main process *before* Obsidian's own `main.js`. That
 * ordering is the entire point: Electron reads `show`, `x`, and `y` out of the
 * options object at construction time, so the only way to hide a window is to
 * have already replaced `BrowserWindow` by the time Obsidian calls `new`. An
 * `app.evaluate()` patch from the test would land after the launcher window
 * exists and would therefore miss it.
 *
 * CommonJS on purpose: `--require` does not accept ES modules.
 *
 * Hidden is not the same as headless. The renderer still lays out, paints, and
 * runs script normally, and Playwright's input APIs reach it over CDP rather
 * than through the OS — so tests that type and click behave as they do headed.
 * What genuinely changes is native focus: a window that is never shown cannot
 * hold OS-level focus, so `document.hasFocus()` is false and `win.focus()` is
 * a no-op. Tests must not depend on either.
 */
const electron = require('electron');

/**
 * Opt-in tracing (`E2E_HIDE_DEBUG=1`). This module is invisible when it works
 * and equally invisible when it silently does not — if Obsidian ever changes
 * how it loads `electron`, the interception simply stops firing and windows
 * quietly reappear. These lines are how you tell those two cases apart.
 */
const log = (...args) => {
  if (process.env.E2E_HIDE_DEBUG === '1') {
    console.error('[hide-windows]', ...args);
  }
};

/**
 * Far enough off-screen that the window cannot appear on any attached display,
 * but not so far that it trips window-manager coordinate clamping.
 *
 * Belt and braces alongside `show: false`: Obsidian calls `show()` on its own
 * windows during boot (and the helpers here do too, when refocusing the vault
 * window). Position survives that, so a window that gets shown anyway still
 * lands where nobody can see it.
 */
const OFFSCREEN_X = -32000;
const OFFSCREEN_Y = -32000;

/**
 * Options forced onto every window Obsidian tries to open.
 *
 * Note this does *not* set `show: false`. Obsidian gates parts of its startup
 * on a window actually being shown, and Playwright only reports windows it can
 * attach to, so a permanently unshown window hangs `firstWindow()`. Placing the
 * window offscreen achieves the same thing for the user without altering the
 * lifecycle Obsidian depends on.
 */
function hiddenOptions(options) {
  return {
    ...options,
    x: OFFSCREEN_X,
    y: OFFSCREEN_Y,
    // A window that skips the taskbar cannot be tabbed to or clicked into by
    // accident while the suite runs.
    skipTaskbar: true,
    // Deliberately NOT `focusable: false`. It looks like the natural way to
    // stop a window taking the foreground, but on Windows it creates the
    // window with WS_EX_NOACTIVATE, and Obsidian's boot gates on a window
    // actually being activated once. With it set, Obsidian tears the window
    // down and recreates it mid-boot (or never finishes booting at all), and
    // the test is handed a handle to the corpse — surfacing later as "Target
    // page, context or browser has been closed" on the test's first action.
    //
    // Foreground-stealing is already handled without it: `show` is routed to
    // `showInactive` and `focus`/`moveTop` are stubbed out in
    // `neutralizeWindow` below.
  };
}

/**
 * Keep a window off the desktop without preventing it from being *shown*.
 *
 * The distinction matters. Obsidian's boot sequence waits on `ready-to-show`
 * and calls `show()` before the launcher navigates away from `about:blank`;
 * Playwright, in turn, only reports windows it can attach to over CDP. Stubbing
 * `show()` to a no-op therefore deadlocks the launch — `firstWindow()` waits 30s
 * for a window that never finishes coming up.
 *
 * So let every display call through, and instead make the window harmless:
 * shove it offscreen and re-shove it whenever something moves it back. Focus is
 * the one thing genuinely suppressed, since stealing focus is the complaint
 * this whole module exists to fix, and Playwright drives input over CDP rather
 * than through OS focus.
 */
function neutralizeWindow(window) {
  const parkOffscreen = () => {
    if (window.isDestroyed()) return;
    // Bounds, not just position: a maximized window ignores x/y until its size
    // is also brought back under our control.
    const { width, height } = window.getBounds();
    window.setBounds({ x: OFFSCREEN_X, y: OFFSCREEN_Y, width, height });
  };

  // `show()` displays *and* focuses; `showInactive()` displays without taking
  // focus. Routing one to the other keeps Obsidian's boot sequence working
  // while leaving the user's real focus where it was.
  const showInactive = window.showInactive.bind(window);
  window.show = () => {
    showInactive();
    parkOffscreen();
  };
  window.focus = () => {};
  window.moveTop = () => {};

  // Obsidian restores a maximized/full-screen window from saved workspace
  // state, and either forces the window back onto a display.
  window.maximize = () => {};
  window.setFullScreen = () => {};

  // Anything that slips past the overrides above — Chromium's own restore
  // logic, a native title-bar action — still gets corrected.
  window.on('show', parkOffscreen);
  window.on('restore', parkOffscreen);
  window.on('maximize', parkOffscreen);
}

/**
 * Stop a main-process exception from putting a modal dialog on the desktop.
 *
 * Obsidian installs its own `uncaughtException` handler (see `main.js` in
 * `.obsidian-unpacked`, "Source: https://github.com/electron/electron/...")
 * which ends in `dialog.showErrorBox`. During a suite run that dialog blocks
 * everything until somebody clicks OK.
 *
 * Adding our own listener is not enough: `process.on` *appends*, so Obsidian's
 * handler still runs and still shows the box. The reliable interception point
 * is `showErrorBox` itself, which we stub to a log line. It is stubbed on the
 * real `electron` namespace (not the proxy) because Obsidian reaches it via a
 * dynamic `import('electron')` inside the handler.
 *
 * The known trigger is a window being torn down while Electron is still inside
 * `openGuestWindow` wiring it up, surfacing as "TypeError: Object has been
 * destroyed". `destroyNonVaultWindows` in ./helpers.ts avoids provoking it;
 * this is the backstop for anything that still slips through.
 */
electron.dialog.showErrorBox = (title, message) => {
  console.error(`[hide-windows] suppressed error dialog: ${title}\n${message}`);
};

/**
 * Keep Obsidian's auto-updater off the network.
 *
 * `main.js` calls `queueUpdate()` on every launch, which fetches release
 * metadata from raw.githubusercontent.com and releases.obsidian.md before the
 * workspace finishes booting. Across a repeat-each suite that is dozens of
 * unauthenticated requests from one IP, and the responses land in exactly the
 * window where tests are waiting on `layoutReady`.
 *
 * Nothing under test depends on the updater, so refuse the requests outright
 * rather than letting real network conditions leak into test outcomes.
 * Obsidian already treats a failed check as non-fatal — it logs and moves on.
 */
const UPDATE_HOSTS = ['releases.obsidian.md', 'raw.githubusercontent.com'];
electron.app.whenReady().then(() => {
  electron.session.defaultSession.webRequest.onBeforeRequest(
    { urls: UPDATE_HOSTS.map((host) => `*://${host}/*`) },
    (details, callback) => {
      log('blocked updater request', details.url);
      callback({ cancel: true });
    }
  );
});

const HiddenBrowserWindow = new Proxy(electron.BrowserWindow, {
  construct(target, args, newTarget) {
    const [options, ...rest] = args;
    log('BrowserWindow constructed', JSON.stringify(options ?? {}));
    const window = Reflect.construct(
      target,
      [hiddenOptions(options ?? {}), ...rest],
      newTarget
    );
    neutralizeWindow(window);
    return window;
  },
});

/**
 * Swap in the patched class at the module-loader level.
 *
 * The obvious approaches both fail. `electron.BrowserWindow` is a
 * *non-configurable getter*, so assigning to it silently does nothing and
 * `Object.defineProperty` throws "Cannot redefine property" — which kills this
 * preload outright and leaves Obsidian running completely unpatched.
 *
 * Intercepting `require` instead sidesteps the frozen property: consumers get a
 * proxied copy of the module namespace whose `BrowserWindow` resolves to the
 * patched class, while every other export passes straight through. Obsidian's
 * real UI code lives in a signed `app.asar` that this bootstrap loads later, so
 * the interception has to survive until then — patching the loader does, where
 * mutating an already-imported object would not.
 */
const Module = require('module');
const originalLoad = Module._load;

const electronProxy = new Proxy(electron, {
  get(target, property, receiver) {
    if (property === 'BrowserWindow') return HiddenBrowserWindow;
    return Reflect.get(target, property, receiver);
  },
});

Module._load = function (request, parent, isMain) {
  const resolved = originalLoad.call(this, request, parent, isMain);
  // `electron/main` is an alias for the same namespace; both must be covered,
  // and matching on the returned object rather than the specifier also catches
  // any other path that resolves to it.
  if (resolved === electron) {
    log('intercepted require of', request);
    return electronProxy;
  }
  return resolved;
};
