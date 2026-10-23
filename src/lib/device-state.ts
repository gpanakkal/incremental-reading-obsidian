import type { App } from 'obsidian';

/**
 * State that belongs to this device alone, kept in localStorage rather than in
 * `data.json`. Obsidian Sync copies `data.json` to every device and merges it,
 * so each write there is an upload for this device and a download for every
 * other, and a single slot in it holds one device's value at a time: the
 * review pointer of whichever device wrote last, and nothing for the rest.
 *
 * `loadLocalStorage` keys by the vault's `appId` (an undocumented field of
 * `App`), as {@link getDeviceId} relies on, so two vaults on one device keep
 * apart and nothing travels with the vault. Both calls are synchronous on
 * desktop and mobile and swallow their own errors (read from Obsidian's source:
 * a failed read is `null`, a failed write is lost), and `saveLocalStorage`
 * drops the key for any falsy value.
 */

/** The localStorage key, per vault, of where review left off on this device. */
export const SESSION_KEY = 'incremental-reading-session';
/** The localStorage key, per vault, of how this device's dialogs were left. */
export const UI_STATE_KEY = 'incremental-reading-ui';
/** The localStorage key, per vault, of the paths this device warned of. */
export const WARNED_PATHS_KEY = 'incremental-reading-warned-refused-paths';

/**
 * The top-level keys `data.json` kept this state under before it moved here.
 * Never settings, in either shape of the file (see `parsePluginData`).
 */
export const LEGACY_DEVICE_STATE_KEYS = [
  'session',
  'ui',
  'warnedRefusedPaths',
] as const;

type LocalStorageApp = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;

/**
 * Where the user left off in review, kept across restarts.
 *
 * Kept per device now, but still tagged with the device that wrote it and
 * ignored by any other: a pointer is only ever this device's own, which the
 * tag keeps true should localStorage ever come from elsewhere.
 */
export interface ReviewSession {
  deviceId: string;
  itemId: string;
}

/**
 * Choices made in dialogs rather than in the settings tab, remembered so each
 * dialog opens the way the user left it.
 */
export interface UiState {
  /** Whether the folder import dialog's "Include subfolders" is on. */
  folderImportIncludeSubfolders: boolean;
}

/** {@link UiState} for a device that has none: everything as it first opens. */
export const DEFAULT_UI_STATE: Readonly<UiState> = {
  folderImportIncludeSubfolders: false,
};

/** Everything this device keeps for itself; see the module comment. */
export interface DeviceState {
  session: ReviewSession | null;
  /** How the plugin's dialogs were last left; see {@link UiState}. */
  ui: UiState;
  /**
   * The item paths that break links the user was last told of on this
   * device, so that the startup notice comes back only for new ones (see
   * `startupWarning`). Per device, since the notice is.
   */
  warnedRefusedPaths: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Stored {@link UiState}, each field not saved as one of its own values left
 * at its default. Always a new object, never {@link DEFAULT_UI_STATE} itself,
 * which a dialog writing to it would change for every later read.
 */
export function parseUiState(raw: unknown): UiState {
  const ui = isRecord(raw) ? raw : {};
  return {
    folderImportIncludeSubfolders:
      typeof ui.folderImportIncludeSubfolders === 'boolean'
        ? ui.folderImportIncludeSubfolders
        : DEFAULT_UI_STATE.folderImportIncludeSubfolders,
  };
}

/** A stored session pointer, or null when absent or malformed. */
export function parseSession(raw: unknown): ReviewSession | null {
  if (!isRecord(raw)) return null;
  const { deviceId, itemId } = raw;
  if (typeof deviceId !== 'string' || !deviceId) return null;
  if (typeof itemId !== 'string' || !itemId) return null;
  return { deviceId, itemId };
}

/** A stored list of paths, as strings only; none when it is no list. */
function parsePaths(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((path): path is string => typeof path === 'string')
    : [];
}

/**
 * The item to resume, or null when the pointer belongs to another device.
 */
export function sessionItemId(
  session: ReviewSession | null,
  deviceId: string
): string | null {
  if (!session || session.deviceId !== deviceId) return null;
  return session.itemId;
}

/** What this device has stored, defaults filled in for whatever it lacks. */
export function loadDeviceState(
  app: Pick<App, 'loadLocalStorage'>
): DeviceState {
  return {
    session: parseSession(app.loadLocalStorage(SESSION_KEY)),
    ui: parseUiState(app.loadLocalStorage(UI_STATE_KEY)),
    warnedRefusedPaths: parsePaths(app.loadLocalStorage(WARNED_PATHS_KEY)),
  };
}

/** Store where review left off, or drop it for `null`. */
export function writeSession(
  app: Pick<App, 'saveLocalStorage'>,
  session: ReviewSession | null
): void {
  app.saveLocalStorage(SESSION_KEY, session);
}

/** Store how the dialogs were left. */
export function writeUiState(
  app: Pick<App, 'saveLocalStorage'>,
  ui: UiState
): void {
  app.saveLocalStorage(UI_STATE_KEY, ui);
}

/** Store the paths the user has been warned of. */
export function writeWarnedPaths(
  app: Pick<App, 'saveLocalStorage'>,
  paths: readonly string[]
): void {
  app.saveLocalStorage(WARNED_PATHS_KEY, paths);
}

/**
 * Move the device state an older `data.json` still carries (`raw`, as loaded)
 * into this device's localStorage, and say whether there was any — in which
 * case the file wants writing back without it, once.
 *
 * A pointer another device wrote is dropped rather than moved: it was never
 * this device's to resume. What this device already keeps in localStorage
 * stands over what the file says: it is this device's own, while the file's
 * copy is older, or another device's. Malformed values are dropped.
 */
export function migrateLegacyDeviceState(
  app: LocalStorageApp,
  raw: unknown,
  deviceId: string
): boolean {
  if (!isRecord(raw)) return false;
  if (!LEGACY_DEVICE_STATE_KEYS.some((key) => key in raw)) return false;

  const session = parseSession(raw.session);
  if (session?.deviceId === deviceId) adopt(app, SESSION_KEY, session);
  if (isRecord(raw.ui)) adopt(app, UI_STATE_KEY, parseUiState(raw.ui));
  if (Array.isArray(raw.warnedRefusedPaths)) {
    adopt(app, WARNED_PATHS_KEY, parsePaths(raw.warnedRefusedPaths));
  }
  return true;
}

/** Store `value` under `key` unless this device already has something there. */
function adopt(app: LocalStorageApp, key: string, value: unknown): void {
  if (app.loadLocalStorage(key) !== null) return;
  app.saveLocalStorage(key, value);
}
