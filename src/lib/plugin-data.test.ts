import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_ID_KEY,
  getDeviceId,
  parsePluginData,
  parseSession,
  sessionItemId,
} from './plugin-data';
import { DEFAULT_SETTINGS } from './settings';

// #region HELPERS

/** Stands in for Obsidian's per-vault, per-install localStorage. */
function makeLocalStorage(initial: Record<string, unknown> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    loadLocalStorage: (key: string) => entries.get(key) ?? null,
    saveLocalStorage: (key: string, data: unknown) => {
      if (data === null) entries.delete(key);
      else entries.set(key, data);
    },
  };
}

const makeSession = (deviceId = 'device-a', itemId = 'item-1') => ({
  deviceId,
  itemId,
});

// #endregion

describe('parsePluginData', () => {
  it('reads a file written before session state existed as settings', () => {
    const data = parsePluginData({ defaultPriority: 42, skipHomeScreen: true });

    expect(data.settings.defaultPriority).toBe(42);
    expect(data.settings.skipHomeScreen).toBe(true);
    expect(data.session).toBeNull();
  });

  it('reads settings and session from their own keys', () => {
    const data = parsePluginData({
      settings: { defaultPriority: 42 },
      session: makeSession(),
    });

    expect(data.settings.defaultPriority).toBe(42);
    expect(data.session).toEqual(makeSession());
  });

  it('fills in defaults for missing settings', () => {
    const data = parsePluginData({ settings: { defaultPriority: 42 } });

    expect(data.settings.skipHomeScreen).toBe(DEFAULT_SETTINGS.skipHomeScreen);
    expect(data.settings.fuzzTextReviews).toBe(
      DEFAULT_SETTINGS.fuzzTextReviews
    );
  });

  it('returns the defaults for a file that is absent or not an object', () => {
    for (const raw of [null, undefined, 'nonsense', 42, ['a']]) {
      const data = parsePluginData(raw);
      expect(data.settings).toEqual(DEFAULT_SETTINGS);
      expect(data.session).toBeNull();
    }
  });

  it('keeps saved settings and drops nothing, whatever else the file holds', () => {
    fc.assert(
      fc.property(
        fc.record({
          defaultPriority: fc.integer(),
          copyOnImport: fc.boolean(),
        }),
        fc.option(fc.record({ deviceId: fc.string(), itemId: fc.string() }), {
          nil: undefined,
        }),
        (settings, session) => {
          const data = parsePluginData({
            settings,
            ...(session && { session }),
          });

          expect(data.settings).toEqual({ ...DEFAULT_SETTINGS, ...settings });
          expect(data.session).toEqual(
            session?.deviceId && session.itemId ? session : null
          );
        }
      )
    );
  });
});

describe('parseSession', () => {
  it('accepts a well-formed pointer', () => {
    expect(parseSession(makeSession())).toEqual(makeSession());
  });

  it('rejects anything missing an id', () => {
    const malformed = [
      null,
      undefined,
      'item-1',
      [makeSession()],
      {},
      { itemId: 'item-1' },
      { deviceId: 'device-a' },
      { deviceId: 'device-a', itemId: '' },
      { deviceId: '', itemId: 'item-1' },
      { deviceId: 7, itemId: 'item-1' },
      { deviceId: 'device-a', itemId: 7 },
    ];
    for (const raw of malformed) {
      expect(parseSession(raw)).toBeNull();
    }
  });
});

describe('sessionItemId', () => {
  it('returns the item when the pointer belongs to this device', () => {
    expect(sessionItemId(makeSession('device-a'), 'device-a')).toBe('item-1');
  });

  it('ignores a pointer another device synced over', () => {
    expect(sessionItemId(makeSession('device-b'), 'device-a')).toBeNull();
  });

  it('has nothing to resume without a pointer', () => {
    expect(sessionItemId(null, 'device-a')).toBeNull();
  });
});

describe('getDeviceId', () => {
  it('namespaces its localStorage key to this plugin', () => {
    // Obsidian's per-vault localStorage is shared with every other plugin.
    expect(DEVICE_ID_KEY).toContain('incremental-reading');
  });

  it('generates an id once and reuses it', () => {
    const app = makeLocalStorage();
    const first = getDeviceId(app);

    expect(first).not.toBe('');
    expect(app.entries.get(DEVICE_ID_KEY)).toBe(first);
    expect(getDeviceId(app)).toBe(first);
  });

  it('gives each device its own id', () => {
    expect(getDeviceId(makeLocalStorage())).not.toBe(
      getDeviceId(makeLocalStorage())
    );
  });

  it('replaces a stored value that is not a usable id', () => {
    for (const stored of ['', 42, null, {}]) {
      const app = makeLocalStorage({ [DEVICE_ID_KEY]: stored });
      const save = vi.spyOn(app, 'saveLocalStorage');

      const deviceId = getDeviceId(app);

      expect(typeof deviceId).toBe('string');
      expect(deviceId).not.toBe('');
      expect(save).toHaveBeenCalledWith(DEVICE_ID_KEY, deviceId);
    }
  });
});
