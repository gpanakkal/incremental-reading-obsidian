import {
  _android as android,
  type AndroidDevice,
  type Page,
} from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { App } from 'obsidian';
import {
  projectRoot,
  sourceVaultPath,
  wait,
  waitForLayoutReady,
} from './helpers';

// Drives the real Obsidian Android app on an emulator or device, over adb.
//
// Obsidian's release APK ships with WebView debugging on
// (`webContentsDebuggingEnabled` in its capacitor.config.json), which is what
// lets Playwright attach to the app's WebView and hand back an ordinary `Page`.
// Everything past `openAndroidVault` is then the same Page API the desktop
// tests use, against the mobile build of Obsidian rather than the desktop one
// pretending to be mobile.

export const OBSIDIAN_PACKAGE = 'md.obsidian';

/** Where `scripts/setup-obsidian-android.sh` puts the APK. */
export const apkPath = path.resolve('./.obsidian-android/Obsidian.apk');

/**
 * Shared storage, where Obsidian looks for a vault named in an
 * `obsidian://open?vault=` link. It scans only the top level, so vaults go
 * directly under it.
 */
const DEVICE_STORAGE = '/sdcard';

/** Plugin files pushed into each vault, fresh from the build. */
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];

/**
 * Cold start through vault boot. An emulator on a CI runner is slow: the first
 * launch after install also compiles the app, and the WebView loads a 4MB
 * app.js before the vault even starts indexing.
 */
const VAULT_BOOT_TIMEOUT_MS = 90_000;
/** How long the app's old WebView gets to disappear after a force-stop. */
const STOP_TIMEOUT_MS = 10_000;
const OPTIONAL_ELEMENT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

type TestWindow = Page & {
  app: App & {
    isMobile: boolean;
    plugins: { plugins: Record<string, { store?: unknown }> };
    setting: { close(): void };
  };
};

/**
 * The device to test on: the one `ANDROID_SERIAL` names, or the only one
 * attached. Two devices and no serial is an error rather than a guess, since
 * the tests install over and write into whichever they get.
 */
export async function connectAndroidDevice() {
  let devices: AndroidDevice[];
  try {
    devices = await android.devices();
  } catch (error) {
    // Playwright talks to the adb server rather than starting one, so a
    // missing server surfaces as a bare ECONNREFUSED on port 5037.
    throw new Error(
      'Could not reach the adb server. Start an emulator (or attach a ' +
        'device) and check `adb devices`.',
      { cause: error }
    );
  }
  const serial = process.env['ANDROID_SERIAL'];
  const chosen = serial
    ? devices.filter((device) => device.serial() === serial)
    : devices;

  if (chosen.length !== 1) {
    for (const device of devices) await device.close();
    throw new Error(
      chosen.length === 0
        ? `No Android device found${serial ? ` with serial ${serial}` : ''}. ` +
          'Start an emulator (or attach a device) and check `adb devices`.'
        : `${chosen.length} Android devices attached; set ANDROID_SERIAL to ` +
          'pick one.'
    );
  }

  for (const device of devices) {
    if (device !== chosen[0]) await device.close();
  }
  return chosen[0];
}

/**
 * Install the downloaded APK, replacing whatever version is there, and give it
 * the access it would otherwise ask the user for.
 *
 * `-g` grants every runtime permission up front, so no system dialog opens over
 * the app. "All files access" is not a runtime permission, though — it is an
 * app op, granted separately — and without it Obsidian cannot list shared
 * storage, so an `obsidian://open?vault=` link finds no vault there.
 */
export async function installObsidian(device: AndroidDevice) {
  try {
    await fs.access(apkPath);
  } catch {
    throw new Error(
      `No Obsidian APK at ${apkPath}. Run scripts/setup-obsidian-android.sh.`
    );
  }
  // `-S` must stay last. Playwright streams the APK over stdin and appends its
  // byte count after these args, which only `-S` consumes; without it the
  // package manager waits for an end of stdin that never comes, and the
  // install hangs until the hook times out.
  await device.installApk(apkPath, { args: ['-r', '-t', '-g', '-S'] });
  await device.shell(
    `appops set --uid ${OBSIDIAN_PACKAGE} MANAGE_EXTERNAL_STORAGE allow`
  );
}

/**
 * Copy the test vault onto the device under a fresh name, with the plugin as it
 * was just built. Returns the vault's name, which is what opens it.
 */
export async function pushVaultCopy(device: AndroidDevice, prefix: string) {
  const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const deviceRoot = `${DEVICE_STORAGE}/${name}`;

  // The source vault's plugin folder is a local artifact (symlinks on Unix,
  // stale copies on Windows); the build output replaces it below.
  const pluginDir = '.obsidian/plugins/incremental-reading';
  const files = (await listFiles(sourceVaultPath))
    .filter((relative) => !relative.startsWith('.obsidian/plugins/'))
    .map((relative) => ({
      source: path.join(sourceVaultPath, relative),
      target: relative,
    }));
  for (const file of PLUGIN_FILES) {
    files.push({
      source: path.join(projectRoot, file),
      target: `${pluginDir}/${file}`,
    });
  }

  const dirs = new Set([deviceRoot, `${deviceRoot}/${pluginDir}`]);
  for (const { target } of files) {
    const parent = path.posix.dirname(target);
    if (parent !== '.') dirs.add(`${deviceRoot}/${parent}`);
  }
  await device.shell(`mkdir -p ${[...dirs].map(shellQuote).join(' ')}`);

  for (const { source, target } of files) {
    await device.push(source, `${deviceRoot}/${target}`);
  }
  return name;
}

export async function deleteDeviceVault(device: AndroidDevice, name: string) {
  await device.shell(`rm -rf ${shellQuote(`${DEVICE_STORAGE}/${name}`)}`);
}

/**
 * Force-stop Obsidian and wait for its WebView to be gone.
 *
 * Playwright learns about WebViews by polling the device, so right after a
 * stop it can still list the dead one. Asking for the app's WebView then would
 * hand back that stale entry, and attaching to it fails.
 */
export async function stopObsidian(device: AndroidDevice) {
  await device.shell(`am force-stop ${OBSIDIAN_PACKAGE}`);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (hasObsidianWebView(device)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Obsidian's WebView was still listed ${STOP_TIMEOUT_MS}ms after ` +
          'force-stopping the app.'
      );
    }
    await wait(POLL_INTERVAL_MS);
  }
}

function hasObsidianWebView(device: AndroidDevice) {
  return device
    .webViews()
    .some((webView) => webView.pkg() === OBSIDIAN_PACKAGE);
}

/**
 * Cold-start Obsidian straight into the named vault and return its WebView as
 * a page, once the vault has booted and the plugin has loaded.
 *
 * The vault is opened with an `obsidian://open?vault=` link rather than through
 * the vault chooser: on launch Obsidian looks for a folder by that name in
 * shared storage and opens it, which skips every screen the chooser has.
 *
 * `onConsole` sees the WebView's console from the moment Playwright attaches,
 * which is before the plugin loads, so a plugin that fails to load says why.
 */
export async function openAndroidVault(
  device: AndroidDevice,
  name: string,
  onConsole?: (line: string) => void
) {
  await stopObsidian(device);

  const uri = `obsidian://open?vault=${encodeURIComponent(name)}`;
  await device.shell(
    `am start -W -a android.intent.action.VIEW -d ${shellQuote(uri)} ` +
      OBSIDIAN_PACKAGE
  );

  const webView = await device.webView(
    { pkg: OBSIDIAN_PACKAGE },
    { timeout: VAULT_BOOT_TIMEOUT_MS }
  );
  const window = await webView.page();
  if (onConsole) {
    window.on('console', (message) => {
      onConsole(`[${message.type()}] ${message.text()}`);
    });
  }
  await waitForLayoutReady(window, VAULT_BOOT_TIMEOUT_MS);

  await trustVaultPlugins(window);

  await window.waitForFunction(
    () => {
      const { app } = window as unknown as TestWindow;
      return !!app?.plugins?.plugins?.['incremental-reading']?.store;
    },
    undefined,
    { timeout: VAULT_BOOT_TIMEOUT_MS, polling: POLL_INTERVAL_MS }
  );
  return window;
}

/**
 * Answer the prompt Obsidian shows the first time it opens a vault with
 * community plugins. Every vault `pushVaultCopy` makes is new to the app, so
 * this is expected on every open; it is still probed rather than required,
 * as on desktop, so a vault Obsidian already trusts opens too.
 *
 * Trusting opens the settings modal on the community plugins tab. On mobile
 * that is a modal in the same WebView rather than a second window, and it
 * would sit over everything the tests go on to do.
 */
async function trustVaultPlugins(window: Page) {
  const trustButton = window.getByRole('button', {
    name: 'Trust author and enable plugins',
  });
  try {
    await trustButton.click({ timeout: OPTIONAL_ELEMENT_TIMEOUT_MS });
  } catch {
    return;
  }

  const settings = window.locator('.modal.mod-settings');
  try {
    await settings.waitFor({
      state: 'visible',
      timeout: OPTIONAL_ELEMENT_TIMEOUT_MS,
    });
  } catch {
    return;
  }
  await window.evaluate(() => {
    (window as unknown as TestWindow).app.setting.close();
  });
  await settings.waitFor({
    state: 'hidden',
    timeout: OPTIONAL_ELEMENT_TIMEOUT_MS,
  });
}

/** Every file under `root`, as a POSIX path relative to it. */
async function listFiles(root: string) {
  const entries = await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/')
    );
}

/** Quote one argument for the device's shell. */
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
