import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { ACTION_COOLDOWN_SECONDS, AUTO_IMPORT_TAG } from './constants';
import { LEGACY_DEVICE_STATE_KEYS } from './device-state';
import {
  AUTO_IMPORT_WATERMARK_KEY,
  DEVICE_ID_KEY,
  getDeviceId,
  loadAutoImportWatermark,
  parsePluginData,
  saveAutoImportWatermark,
} from './plugin-data';
import { DEFAULT_SETTINGS } from './settings';
import { parseTagList } from './tags';
import { cleanFolderList } from './watched-folders';

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

const legacyKeys: readonly string[] = LEGACY_DEVICE_STATE_KEYS;

/** The device state an older version kept beside the settings, any of it. */
const legacyStateArb = fc.record(
  {
    session: fc.oneof(
      fc.record({ deviceId: fc.string(), itemId: fc.string() }),
      fc.anything()
    ),
    ui: fc.oneof(
      fc.record({ folderImportIncludeSubfolders: fc.boolean() }),
      fc.anything()
    ),
    warnedRefusedPaths: fc.oneof(fc.array(fc.string()), fc.anything()),
  },
  { requiredKeys: [] }
);

// #endregion

describe('parsePluginData', () => {
  it('reads settings alone, never the device state an older version kept beside them, in either shape of the file', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .oneof(fc.dictionary(fc.string(), fc.anything()), fc.anything())
            .map((settings) => ({ settings })),
          // Written before settings had a key of their own
          fc.dictionary(
            fc
              .string()
              .filter((key) => key !== 'settings' && !legacyKeys.includes(key)),
            fc.anything()
          )
        ),
        legacyStateArb,
        (file, state) => {
          const data = parsePluginData({ ...file, ...state });

          expect(data).toStrictEqual(parsePluginData(file));
          expect(Object.keys(data)).toEqual(['settings']);
        }
      )
    );
  });

  it('reads a file written before session state existed as settings', () => {
    const data = parsePluginData({ defaultPriority: 42, skipHomeScreen: true });

    expect(data.settings.defaultPriority).toBe(42);
    expect(data.settings.skipHomeScreen).toBe(true);
  });

  it('reads settings from their own key', () => {
    const data = parsePluginData({ settings: { defaultPriority: 42 } });

    expect(data.settings.defaultPriority).toBe(42);
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

  it('turns importing by tag on, triggered by the import tag, unless told otherwise', () => {
    expect(DEFAULT_SETTINGS.autoImportOnTag).toBe(true);
    expect(DEFAULT_SETTINGS.autoImportTags).toEqual([AUTO_IMPORT_TAG]);
    expect(parsePluginData({ settings: {} }).settings).toMatchObject({
      autoImportOnTag: true,
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

  it('leaves watching folders off, with none watched, unless told otherwise', () => {
    expect(DEFAULT_SETTINGS.autoImportOnFolder).toBe(false);
    expect(DEFAULT_SETTINGS.autoImportFolders).toEqual([]);
    expect(parsePluginData({ settings: {} }).settings).toMatchObject({
      autoImportOnFolder: false,
      autoImportFolders: [],
    });
  });

  it('keeps a saved on or off for watching folders and turns anything else off', () => {
    fc.assert(
      fc.property(fc.anything(), fc.boolean(), (stored, legacy) => {
        const saved = { autoImportOnFolder: stored };
        const data = parsePluginData(legacy ? saved : { settings: saved });

        expect(data.settings.autoImportOnFolder).toBe(stored === true);
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

  it('reads saved watched folders as the settings tab keeps them, and anything but a list as none', () => {
    const storedArb = fc.oneof(
      fc.array(fc.string()),
      fc.array(fc.oneof(fc.string(), fc.anything())),
      fc.constantFrom(
        'Inbox',
        ['/Inbox/', 'Inbox', ' Clips ', '/', 'a, b', 'c\nd'],
        null
      ),
      fc.anything()
    );
    fc.assert(
      fc.property(storedArb, fc.boolean(), (stored, legacy) => {
        const saved = { autoImportFolders: stored };
        const data = parsePluginData(legacy ? saved : { settings: saved });

        expect(data.settings.autoImportFolders).toEqual(
          Array.isArray(stored)
            ? cleanFolderList(
                stored.filter((folder) => typeof folder === 'string')
              )
            : []
        );
      })
    );
  });

  it('keeps a saved watched folder whole, commas and line breaks included', () => {
    const data = parsePluginData({
      settings: { autoImportFolders: ['/a, b/', 'c\nd', '/', 'a, b'] },
    });

    expect(data.settings.autoImportFolders).toEqual(['a, b', 'c\nd']);
  });

  it('gives each read its own list of watched folders, apart from the defaults', () => {
    const first = parsePluginData({ settings: {} }).settings;
    const second = parsePluginData({}).settings;

    first.autoImportFolders.push('changed');

    expect(second.autoImportFolders).toEqual([]);
    expect(DEFAULT_SETTINGS.autoImportFolders).toEqual([]);
  });

  it('gives each read its own list of trigger tags, apart from the defaults', () => {
    const first = parsePluginData({ settings: {} }).settings;
    const second = parsePluginData({}).settings;

    first.autoImportTags.push('changed');

    expect(second.autoImportTags).toEqual([AUTO_IMPORT_TAG]);
    expect(DEFAULT_SETTINGS.autoImportTags).toEqual([AUTO_IMPORT_TAG]);
  });

  it('keeps a saved double-click guard within the slider, pulls one past it to its nearest end, and reads anything else as the default', () => {
    const { MIN, MAX, DEFAULT } = ACTION_COOLDOWN_SECONDS;
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: MIN, max: MAX, noNaN: true }),
          fc.double(),
          fc.anything()
        ),
        fc.boolean(),
        (stored, legacy) => {
          const saved = { actionCooldownSeconds: stored };
          const { actionCooldownSeconds } = parsePluginData(
            legacy ? saved : { settings: saved }
          ).settings;

          if (typeof stored !== 'number' || Number.isNaN(stored)) {
            expect(actionCooldownSeconds).toBe(DEFAULT);
          } else if (stored <= MIN) {
            // -0 included, which comes back as the slider's own 0
            expect(actionCooldownSeconds).toBe(MIN);
          } else if (stored > MAX) {
            expect(actionCooldownSeconds).toBe(MAX);
          } else {
            expect(actionCooldownSeconds).toBe(stored);
          }
        }
      )
    );
  });

  it('keeps saved settings and drops nothing, whatever else the file holds', () => {
    fc.assert(
      fc.property(
        fc.record({
          defaultPriority: fc.integer(),
          copyOnImport: fc.boolean(),
        }),
        legacyStateArb,
        (settings, state) => {
          const data = parsePluginData({ settings, ...state });

          expect(data.settings).toEqual({ ...DEFAULT_SETTINGS, ...settings });
        }
      )
    );
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
