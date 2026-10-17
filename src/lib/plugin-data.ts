import type { App } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  isAutoImportMode,
  isReviewTitleBar,
  isSuccessNoticeLevel,
  type IRPluginSettings,
} from './settings';
import { parseTagList } from './tags';

/**
 * localStorage key holding this device's id. Obsidian namespaces
 * `loadLocalStorage`/`saveLocalStorage` per vault *and* per install, so the
 * value never travels with a synced vault — which is what makes it usable as
 * the device half of {@link ReviewSession}.
 */
export const DEVICE_ID_KEY = 'incremental-reading-device-id';

/**
 * Where the user left off in review, kept across restarts.
 *
 * `data.json` is synced along with the rest of the plugin's settings, so the
 * pointer carries the device that wrote it and is ignored everywhere else:
 * resuming one device's half-read article on another would silently override
 * that device's own queue order.
 */
export interface ReviewSession {
  deviceId: string;
  itemId: string;
}

/**
 * Everything the plugin keeps in `data.json`. Settings live under their own key
 * so session state can be written without the settings tab knowing about it,
 * and vice versa — both writers go through the one in-memory object, since
 * `saveData` replaces the whole file.
 */
export interface IRPluginData {
  settings: IRPluginSettings;
  session: ReviewSession | null;
  /**
   * The item paths that break links the user was last told of, so that the
   * startup notice comes back only for new ones (see `startupWarning`).
   */
  warnedRefusedPaths: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read `data.json` into its two halves, filling in defaults.
 *
 * Files written before session state existed are the settings object itself,
 * with no `settings` key — those are read whole as settings. No `IRPluginSettings`
 * field is named `settings`, so the two shapes can't be confused.
 */
export function parsePluginData(raw: unknown): IRPluginData {
  const data = isRecord(raw) ? raw : {};
  const legacy = !('settings' in data);
  const saved = legacy ? data : isRecord(data.settings) ? data.settings : {};
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  // A hand-edited or newer file can hold any value here; one the review tab
  // doesn't know would leave it matching none of its three choices.
  if (!isReviewTitleBar(settings.reviewTitleBar)) {
    settings.reviewTitleBar = DEFAULT_SETTINGS.reviewTitleBar;
  }
  for (const key of [
    'successNoticesInReview',
    'successNoticesOutsideReview',
  ] as const) {
    if (!isSuccessNoticeLevel(settings[key])) {
      settings[key] = DEFAULT_SETTINGS[key];
    }
  }
  // Both are read on every change to a note, so neither may be left as
  // anything a hand edit put there. The tags are always a list of their own:
  // never the defaults' list, which another read would share.
  settings.autoImportOnTag = settings.autoImportOnTag === true;
  const storedTags: unknown = settings.autoImportTags;
  settings.autoImportTags = Array.isArray(storedTags)
    ? parseTagList(
        storedTags
          .filter((tag): tag is string => typeof tag === 'string')
          .join(',')
      )
    : [...DEFAULT_SETTINGS.autoImportTags];
  // One the dropdown doesn't offer would show as none of its choices
  if (!isAutoImportMode(settings.autoImportMode)) {
    settings.autoImportMode = DEFAULT_SETTINGS.autoImportMode;
  }

  return {
    settings,
    session: legacy ? null : parseSession(data.session),
    warnedRefusedPaths: Array.isArray(data.warnedRefusedPaths)
      ? data.warnedRefusedPaths.filter(
          (path): path is string => typeof path === 'string'
        )
      : [],
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

/**
 * This device's id, generated on first use. Stored outside `data.json` so it
 * stays put when the vault syncs — see {@link DEVICE_ID_KEY}.
 */
export function getDeviceId(
  app: Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>
): string {
  const stored: unknown = app.loadLocalStorage(DEVICE_ID_KEY);
  if (typeof stored === 'string' && stored) return stored;

  const deviceId = crypto.randomUUID();
  app.saveLocalStorage(DEVICE_ID_KEY, deviceId);
  return deviceId;
}
