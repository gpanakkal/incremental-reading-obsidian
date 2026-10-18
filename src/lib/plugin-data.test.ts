import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { AUTO_IMPORT_TAG } from './constants';
import {
  AUTO_IMPORT_WATERMARK_KEY,
  DEVICE_ID_KEY,
  getDeviceId,
  loadAutoImportWatermark,
  parsePluginData,
  parseSession,
  saveAutoImportWatermark,
  sessionItemId,
} from './plugin-data';
import { DEFAULT_SETTINGS } from './settings';
import { parseTagList } from './tags';

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
  it('reads the item paths the user was warned of, as strings only, and none from a file without them', () => {
    expect(
      parsePluginData({
        settings: {},
        warnedRefusedPaths: ['a|.md', 7, null, 'b#.md'],
      }).warnedRefusedPaths
    ).toStrictEqual(['a|.md', 'b#.md']);
    expect(
      parsePluginData({ settings: {}, warnedRefusedPaths: 'a|.md' })
        .warnedRefusedPaths
    ).toStrictEqual([]);
    expect(parsePluginData({ settings: {} }).warnedRefusedPaths).toStrictEqual(
      []
    );
    expect(
      parsePluginData({ defaultPriority: 42, warnedRefusedPaths: ['a|.md'] })
        .warnedRefusedPaths
    ).toStrictEqual(['a|.md']);
  });

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

  it('follows Obsidian for the review title bar unless told otherwise', () => {
    expect(DEFAULT_SETTINGS.reviewTitleBar).toBe('obsidian');
    expect(parsePluginData({ settings: {} }).settings.reviewTitleBar).toBe(
      'obsidian'
    );
  });

  it('hides the intervals on grade buttons unless turned on, saved data without the setting included', () => {
    expect(DEFAULT_SETTINGS.showGradeIntervals).toBe(false);
    fc.assert(
      fc.property(
        fc.dictionary(
          fc
            .string()
            .filter((key) => !['showGradeIntervals', 'settings'].includes(key)),
          fc.anything()
        ),
        fc.boolean(),
        (saved, legacy) => {
          const data = parsePluginData(legacy ? saved : { settings: saved });

          expect(data.settings.showGradeIntervals).toBe(false);
        }
      )
    );
    expect(
      parsePluginData({ settings: { showGradeIntervals: true } }).settings
        .showGradeIntervals
    ).toBe(true);
  });

  it('keeps a known review title bar choice and replaces anything else with the default', () => {
    const CHOICES: unknown[] = ['obsidian', 'show', 'hide'];
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(...CHOICES),
          fc.constantFrom('Show', 'HIDE', ' show', '', 'toString', '__proto__'),
          // not strings, though each reads as a choice once made one
          fc.constantFrom(['show'], ['hide'], { toString: () => 'hide' }),
          fc.anything()
        ),
        fc.boolean(),
        (stored, legacy) => {
          const saved = { reviewTitleBar: stored };
          const data = parsePluginData(legacy ? saved : { settings: saved });

          expect(data.settings.reviewTitleBar).toBe(
            CHOICES.includes(stored) ? stored : 'obsidian'
          );
        }
      )
    );
  });

  it('shows every success notice inside and outside review unless told otherwise', () => {
    expect(DEFAULT_SETTINGS.successNoticesInReview).toBe('all');
    expect(DEFAULT_SETTINGS.successNoticesOutsideReview).toBe('all');
    expect(parsePluginData({ settings: {} }).settings).toMatchObject({
      successNoticesInReview: 'all',
      successNoticesOutsideReview: 'all',
    });
  });

  it('turns review reminders on for every item type unless told otherwise', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      reviewReminders: true,
      remindDueArticles: true,
      remindDueSnippets: true,
    });
    for (const legacy of [false, true]) {
      const saved = {};
      expect(
        parsePluginData(legacy ? saved : { settings: saved }).settings
      ).toMatchObject({
        reviewReminders: true,
        remindDueArticles: true,
        remindDueSnippets: true,
      });
    }
  });

  it('keeps a known success notice level and replaces anything else with all', () => {
    const LEVELS: unknown[] = ['all', 'minimal', 'none'];
    const storedArb = fc.oneof(
      fc.constantFrom(...LEVELS),
      fc.constantFrom('All', 'NONE', ' minimal', '', 'toString', '__proto__'),
      // not strings, though each reads as a level once made one
      fc.constantFrom(['none'], { toString: () => 'minimal' }),
      fc.anything()
    );
    fc.assert(
      fc.property(
        storedArb,
        storedArb,
        fc.boolean(),
        (inside, outside, legacy) => {
          const saved = {
            successNoticesInReview: inside,
            successNoticesOutsideReview: outside,
          };
          const data = parsePluginData(legacy ? saved : { settings: saved });

          expect(data.settings.successNoticesInReview).toBe(
            LEVELS.includes(inside) ? inside : 'all'
          );
          expect(data.settings.successNoticesOutsideReview).toBe(
            LEVELS.includes(outside) ? outside : 'all'
          );
        }
      )
    );
  });

  it('leaves importing by tag off, triggered by the import tag, unless told otherwise', () => {
    expect(DEFAULT_SETTINGS.autoImportOnTag).toBe(false);
    expect(DEFAULT_SETTINGS.autoImportTags).toEqual([AUTO_IMPORT_TAG]);
    expect(parsePluginData({ settings: {} }).settings).toMatchObject({
      autoImportOnTag: false,
      autoImportTags: [AUTO_IMPORT_TAG],
    });
  });

  it('keeps a saved on or off for importing by tag and turns anything else off', () => {
    fc.assert(
      fc.property(fc.anything(), fc.boolean(), (stored, legacy) => {
        const saved = { autoImportOnTag: stored };
        const data = parsePluginData(legacy ? saved : { settings: saved });

        expect(data.settings.autoImportOnTag).toBe(stored === true);
      })
    );
  });

  it('reads saved trigger tags as a typed list of them would be, and anything but a list as the default', () => {
    const storedArb = fc.oneof(
      fc.array(fc.string()),
      fc.array(fc.oneof(fc.string(), fc.anything())),
      fc.constantFrom('ir-import', 'a, b', null),
      fc.anything()
    );
    fc.assert(
      fc.property(storedArb, fc.boolean(), (stored, legacy) => {
        const saved = { autoImportTags: stored };
        const data = parsePluginData(legacy ? saved : { settings: saved });

        expect(data.settings.autoImportTags).toEqual(
          Array.isArray(stored)
            ? parseTagList(
                stored
                  .filter((tag): tag is string => typeof tag === 'string')
                  .join(',')
              )
            : [AUTO_IMPORT_TAG]
        );
      })
    );
  });

  it('imports tagged notes in place unless told otherwise, whatever copying on import says', () => {
    fc.assert(
      fc.property(fc.anything(), fc.boolean(), (copyOnImport, legacy) => {
        const saved = { copyOnImport };
        const data = parsePluginData(legacy ? saved : { settings: saved });

        expect(DEFAULT_SETTINGS.autoImportMode).toBe('inPlace');
        expect(data.settings.autoImportMode).toBe('inPlace');
      })
    );
  });

  it('keeps a known way of importing tagged notes and replaces anything else with in place', () => {
    const MODES: unknown[] = ['inPlace', 'copy', 'inherit'];
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(...MODES),
          fc.constantFrom('Copy', 'inplace', ' copy', '', 'toString'),
          // not strings, though each reads as a mode once made one
          fc.constantFrom(['copy'], { toString: () => 'copy' }),
          fc.anything()
        ),
        fc.boolean(),
        (stored, legacy) => {
          const saved = { autoImportMode: stored };
          const data = parsePluginData(legacy ? saved : { settings: saved });

          expect(data.settings.autoImportMode).toBe(
            MODES.includes(stored) ? stored : 'inPlace'
          );
        }
      )
    );
  });

  it('gives each read its own list of trigger tags, apart from the defaults', () => {
    const first = parsePluginData({ settings: {} }).settings;
    const second = parsePluginData({}).settings;

    first.autoImportTags.push('changed');

    expect(second.autoImportTags).toEqual([AUTO_IMPORT_TAG]);
    expect(DEFAULT_SETTINGS.autoImportTags).toEqual([AUTO_IMPORT_TAG]);
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

describe('the moment the automatic import last saw every change', () => {
  it('is kept under a localStorage key of this plugin, apart from the device id', () => {
    expect(AUTO_IMPORT_WATERMARK_KEY).toContain('incremental-reading');
    expect(AUTO_IMPORT_WATERMARK_KEY).not.toBe(DEVICE_ID_KEY);
  });

  it('reads back as the time saved, whatever time that is', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (time) => {
          const app = makeLocalStorage();

          saveAutoImportWatermark(app, time);

          expect(app.entries.get(AUTO_IMPORT_WATERMARK_KEY)).toBe(time);
          expect(loadAutoImportWatermark(app)).toBe(time);
        }
      )
    );
  });

  it('reads as none where nothing is stored, or what is stored is no time', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(null, undefined, NaN, Infinity, -Infinity, '1', ''),
          fc.anything().filter((stored) => typeof stored !== 'number')
        ),
        (stored) => {
          const app = makeLocalStorage({ [AUTO_IMPORT_WATERMARK_KEY]: stored });

          expect(loadAutoImportWatermark(app)).toBeNull();
        }
      )
    );
  });
});
