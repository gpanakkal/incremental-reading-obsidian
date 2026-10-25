import type { App } from 'obsidian';
import { ACTION_COOLDOWN_SECONDS } from './constants';
import { LEGACY_DEVICE_STATE_KEYS } from './device-state';
import {
  DEFAULT_SETTINGS,
  isReviewTitleBar,
  isSuccessNoticeLevel,
  type IRPluginSettings,
} from './settings';
import { parseTagList } from './tags';
import { cleanFolderList } from './watched-folders';

// This device's id, the device half of `ReviewSession` as well as the
// `updated_by` of every database row it writes: one helper, so the two can
// never disagree
export { DEVICE_ID_KEY, getDeviceId } from './device-id';

/**
 * Everything the plugin keeps in `data.json`: the settings, under their own key.
 *
 * Settings alone, since Sync copies the file to every device: whatever belongs
 * to one device lives in its localStorage instead (see `device-state.ts`).
 */
export interface IRPluginData {
  settings: IRPluginSettings;
}

/**
 * Settings an older version stored that no longer exist, dropped as read so
 * the next save leaves them out. `autoImportMode` chose where auto-imports
 * went; they always import in place now, whatever it held.
 */
const RETIRED_SETTING_KEYS: readonly string[] = ['autoImportMode'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read `data.json`'s settings, filling in defaults.
 *
 * Files written before session state existed are the settings object itself,
 * with no `settings` key — those are read whole as settings. No `IRPluginSettings`
 * field is named `settings`, so the two shapes can't be confused. In neither
 * shape is the device state an older version kept beside the settings read as
 * settings: `migrateLegacyDeviceState` moves it out.
 */
export function parsePluginData(raw: unknown): IRPluginData {
  const data = isRecord(raw) ? raw : {};
  const legacy = !('settings' in data);
  const saved = legacy
    ? withoutDeviceState(data)
    : isRecord(data.settings)
      ? data.settings
      : {};
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  for (const key of RETIRED_SETTING_KEYS) {
    delete (settings as Record<string, unknown>)[key];
  }
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
  // Read on every press in review: a hand edit past the slider's range could
  // hold the bar for minutes after each item, and a non-number holds nothing
  // the slider can show.
  const cooldown: unknown = settings.actionCooldownSeconds;
  settings.actionCooldownSeconds =
    typeof cooldown === 'number' && !Number.isNaN(cooldown)
      ? Math.min(
          Math.max(cooldown, ACTION_COOLDOWN_SECONDS.MIN),
          ACTION_COOLDOWN_SECONDS.MAX
        )
      : ACTION_COOLDOWN_SECONDS.DEFAULT;
  // Read on every file created or moved, so held to the same, and kept as the
  // settings tab keeps them
  settings.autoImportOnFolder = settings.autoImportOnFolder === true;
  const storedFolders: unknown = settings.autoImportFolders;
  settings.autoImportFolders = Array.isArray(storedFolders)
    ? cleanFolderList(
        storedFolders.filter(
          (folder): folder is string => typeof folder === 'string'
        )
      )
    : [];

  return { settings };
}

/** `data` without the keys device state was once kept under. */
function withoutDeviceState(
  data: Record<string, unknown>
): Record<string, unknown> {
  const legacyKeys: readonly string[] = LEGACY_DEVICE_STATE_KEYS;
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !legacyKeys.includes(key))
  );
}

/**
 * localStorage key holding the last moment this device's `AutoImportWatcher`
 * saw every change to the vault. Device-local, as {@link DEVICE_ID_KEY} is:
 * the moment says what this device's metadata cache saw, which no other
 * device can speak for.
 */
export const AUTO_IMPORT_WATERMARK_KEY = 'incremental-reading-auto-import-seen';

/**
 * The moment stored under {@link AUTO_IMPORT_WATERMARK_KEY}, in milliseconds
 * since the epoch, or null when none is stored or what is there is no time.
 */
export function loadAutoImportWatermark(
  app: Pick<App, 'loadLocalStorage'>
): number | null {
  const stored: unknown = app.loadLocalStorage(AUTO_IMPORT_WATERMARK_KEY);
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : null;
}

/** Store `time` under {@link AUTO_IMPORT_WATERMARK_KEY}. */
export function saveAutoImportWatermark(
  app: Pick<App, 'saveLocalStorage'>,
  time: number
): void {
  app.saveLocalStorage(AUTO_IMPORT_WATERMARK_KEY, time);
}
