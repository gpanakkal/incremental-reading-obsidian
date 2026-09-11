import type { App } from 'obsidian';
import { DEFAULT_SETTINGS, type IRPluginSettings } from './settings';

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

  return {
    settings: { ...DEFAULT_SETTINGS, ...saved },
    session: legacy ? null : parseSession(data.session),
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
