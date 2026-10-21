import type { App } from 'obsidian';

/** The localStorage key, per vault, of this install's device id. */
export const DEVICE_ID_KEY = 'incremental-reading-device-id';

type LocalStorageApp = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;

/** The id made for each app this session, for when its storage fails. */
const made = new WeakMap<object, string>();

/**
 * This install's id for the vault `app` has open: a UUID made the first time
 * it is asked for and kept in localStorage from then on. It names the device
 * that last changed a database row (`updated_by`) and the device a saved
 * review session belongs to (`ReviewSession`), so it has to outlast the
 * session but must not travel with the vault, which Sync copies to every
 * device. `loadLocalStorage` keys by the vault's `appId` (an undocumented
 * field of `App`), so two vaults on one device get two ids.
 *
 * Where localStorage can't be read or written, the id made is kept in memory
 * instead, so that this session at least names itself the same each time.
 */
export function getDeviceId(app: LocalStorageApp): string {
  let stored: unknown = null;
  try {
    stored = app.loadLocalStorage(DEVICE_ID_KEY);
  } catch {
    // Unreadable: made anew below
  }

  if (typeof stored === 'string' && stored !== '') return stored;

  const cached = made.get(app);
  if (cached) return cached;
  const id = crypto.randomUUID();
  made.set(app, id);
  try {
    app.saveLocalStorage(DEVICE_ID_KEY, id);
  } catch {
    // Kept in memory alone, as above
  }
  return id;
}
