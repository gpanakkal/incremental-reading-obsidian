import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_STATE,
  LEGACY_DEVICE_STATE_KEYS,
  loadDeviceState,
  migrateLegacyDeviceState,
  parseSession,
  parseUiState,
  type ReviewSession,
  SESSION_KEY,
  sessionItemId,
  UI_STATE_KEY,
  WARNED_PATHS_KEY,
  writeSession,
  writeUiState,
  writeWarnedPaths,
} from './device-state';
import { AUTO_IMPORT_WATERMARK_KEY, DEVICE_ID_KEY } from './plugin-data';
import { POSITIONS_KEY } from './reading-positions';

// #region HELPERS

const DEVICE = 'device-a';

const STATE_KEYS = [SESSION_KEY, UI_STATE_KEY, WARNED_PATHS_KEY] as const;

/**
 * Obsidian's per-vault localStorage as its source has it: values kept as
 * JSON, `null` for a key never set, and any falsy value removing the key.
 */
function makeLocalStorage(initial: Record<string, unknown> = {}) {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(initial)) {
    if (value) entries.set(key, JSON.stringify(value));
  }
  const loadLocalStorage = (key: string): unknown => {
    const json = entries.get(key);
    return json ? (JSON.parse(json) as unknown) : null;
  };
  return {
    entries,
    loadLocalStorage,
    saveLocalStorage: (key: string, data: unknown) => {
      if (data) entries.set(key, JSON.stringify(data));
      else entries.delete(key);
    },
    /** Every state key's value, `null` where unset. */
    snapshot: () =>
      Object.fromEntries(STATE_KEYS.map((key) => [key, loadLocalStorage(key)])),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const makeSession = (deviceId = DEVICE, itemId = 'item-1'): ReviewSession => ({
  deviceId,
  itemId,
});

/** Any id, the empty one included. */
const idArb = fc.string({ maxLength: 4 });

/** A stored or legacy pointer: this device's, another's, half-formed, or anything. */
const sessionArb = fc.oneof(
  idArb.map((itemId) => ({ deviceId: DEVICE, itemId })),
  fc.record({ deviceId: idArb, itemId: idArb }),
  fc.record(
    { deviceId: fc.anything(), itemId: fc.anything() },
    { requiredKeys: [] }
  ),
  fc.anything()
);

/** A stored `ui`: a valid one, one with a field gone wrong, or anything. */
const uiArb = fc.oneof(
  fc.record({ folderImportIncludeSubfolders: fc.boolean() }),
  fc.record(
    { folderImportIncludeSubfolders: fc.anything() },
    { requiredKeys: [] }
  ),
  fc.dictionary(fc.string(), fc.anything()),
  fc.anything()
);

/** A stored list of paths, other values mixed in, or anything at all. */
const pathsArb = fc.oneof(
  fc.array(fc.string()),
  fc.array(fc.oneof(fc.string(), fc.anything())),
  fc.anything()
);

/** The device state an older `data.json` kept, each key there or not. */
const legacyStateArb = fc.record(
  { session: sessionArb, ui: uiArb, warnedRefusedPaths: pathsArb },
  { requiredKeys: [] }
);

const legacyKeys: readonly string[] = LEGACY_DEVICE_STATE_KEYS;

/** Settings-like keys: anything but `settings` and the device state's own. */
const settingsDictArb = fc.dictionary(
  fc.string().filter((key) => key !== 'settings' && !legacyKeys.includes(key)),
  fc.anything()
);

/**
 * `data.json` as any version may have left it: settings under their own key,
 * or the settings object itself, each with any of the device state beside
 * them, or nothing usable at all.
 */
const dataJsonArb = fc.oneof(
  fc
    .tuple(fc.oneof(settingsDictArb, fc.anything()), legacyStateArb)
    .map(([settings, state]) => ({ settings, ...state })),
  fc
    .tuple(settingsDictArb, legacyStateArb)
    .map(([settings, state]) => ({ ...settings, ...state })),
  fc.anything()
);

/**
 * What this device already keeps, per key: nothing, its own kind of value,
 * or whatever a corrupted entry decodes to. Only truthy values can be stored.
 */
const storedArb = fc.record({
  [SESSION_KEY]: fc.option(sessionArb, { nil: undefined }),
  [UI_STATE_KEY]: fc.option(uiArb, { nil: undefined }),
  [WARNED_PATHS_KEY]: fc.option(pathsArb, { nil: undefined }),
});

/** JSON's view of `value`: what a store keeping JSON hands back. */
const asJson = (value: unknown): unknown =>
  value ? (JSON.parse(JSON.stringify(value)) as unknown) : null;

/** The legacy pointer this device should take over, or null. */
function ownLegacySession(raw: Record<string, unknown>): ReviewSession | null {
  const session = raw.session;
  if (!isRecord(session)) return null;
  const { deviceId, itemId } = session;
  if (deviceId !== DEVICE) return null;
  if (typeof itemId !== 'string' || itemId === '') return null;
  return { deviceId, itemId };
}

/** What each state key should hold after migrating `raw` over `before`. */
function expectedAfterMigration(
  raw: unknown,
  before: Record<string, unknown>
): Record<string, unknown> {
  if (!isRecord(raw) || !legacyKeys.some((key) => key in raw)) return before;
  const legacy: Record<string, unknown> = {
    [SESSION_KEY]: ownLegacySession(raw),
    [UI_STATE_KEY]: isRecord(raw.ui)
      ? {
          folderImportIncludeSubfolders:
            raw.ui.folderImportIncludeSubfolders === true,
        }
      : null,
    [WARNED_PATHS_KEY]: Array.isArray(raw.warnedRefusedPaths)
      ? raw.warnedRefusedPaths.filter((path) => typeof path === 'string')
      : null,
  };
  return Object.fromEntries(
    STATE_KEYS.map((key) => [key, before[key] ?? legacy[key]])
  );
}

// #endregion

describe('the keys device state is kept under', () => {
  it('belong to this plugin and to nothing else it stores', () => {
    // Obsidian's per-vault localStorage is shared with every other plugin.
    for (const key of STATE_KEYS) expect(key).toContain('incremental-reading');
    const all = [
      ...STATE_KEYS,
      DEVICE_ID_KEY,
      AUTO_IMPORT_WATERMARK_KEY,
      POSITIONS_KEY,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('parseUiState', () => {
  it('starts with "Include subfolders" off', () => {
    expect(DEFAULT_UI_STATE).toEqual({ folderImportIncludeSubfolders: false });
  });

  it('keeps a saved on or off for "Include subfolders" and reads anything else as off', () => {
    fc.assert(
      fc.property(uiArb, (stored) => {
        const field = isRecord(stored)
          ? stored.folderImportIncludeSubfolders
          : undefined;
        expect(parseUiState(stored)).toStrictEqual({
          folderImportIncludeSubfolders:
            typeof field === 'boolean' ? field : false,
        });
      })
    );
  });

  it('reads into an object of its own, so a change to one is no other read', () => {
    fc.assert(
      fc.property(uiArb, (stored) => {
        const first = parseUiState(stored);
        const expected = { ...first };
        first.folderImportIncludeSubfolders =
          !first.folderImportIncludeSubfolders;

        expect(DEFAULT_UI_STATE.folderImportIncludeSubfolders).toBe(false);
        expect(parseUiState(stored)).toEqual(expected);
        expect(parseUiState(undefined)).toEqual({
          folderImportIncludeSubfolders: false,
        });
      })
    );
  });
});

describe('parseSession', () => {
  it('accepts a well-formed pointer', () => {
    expect(parseSession(makeSession())).toEqual(makeSession());
  });

  it('keeps only the two ids, both non-empty strings, of anything stored', () => {
    fc.assert(
      fc.property(sessionArb, (raw) => {
        const parsed = parseSession(raw);
        const valid =
          isRecord(raw) &&
          typeof raw.deviceId === 'string' &&
          raw.deviceId !== '' &&
          typeof raw.itemId === 'string' &&
          raw.itemId !== '';
        expect(parsed).toStrictEqual(
          valid ? { deviceId: raw.deviceId, itemId: raw.itemId } : null
        );
      })
    );
  });

  it('rejects anything missing an id', () => {
    const malformed = [
      null,
      undefined,
      'item-1',
      [makeSession()],
      {},
      { itemId: 'item-1' },
      { deviceId: DEVICE },
      { deviceId: DEVICE, itemId: '' },
      { deviceId: '', itemId: 'item-1' },
      { deviceId: 7, itemId: 'item-1' },
      { deviceId: DEVICE, itemId: 7 },
    ];
    for (const raw of malformed) {
      expect(parseSession(raw)).toBeNull();
    }
  });
});

describe('sessionItemId', () => {
  it("returns the item only for this device's own pointer", () => {
    fc.assert(
      fc.property(
        fc.option(fc.record({ deviceId: idArb, itemId: idArb }), { nil: null }),
        idArb,
        (session, deviceId) => {
          expect(sessionItemId(session, deviceId)).toBe(
            session && session.deviceId === deviceId ? session.itemId : null
          );
        }
      )
    );
  });

  it('ignores a pointer another device wrote', () => {
    expect(sessionItemId(makeSession('device-b'), DEVICE)).toBeNull();
  });
});

describe('loadDeviceState', () => {
  it('reads each key as its parser does, defaults where nothing usable is stored', () => {
    fc.assert(
      fc.property(storedArb, (stored) => {
        const app = makeLocalStorage(stored);
        const json = (key: string) =>
          asJson(stored[key as keyof typeof stored]);

        const state = loadDeviceState(app);

        expect(state.session).toStrictEqual(parseSession(json(SESSION_KEY)));
        expect(state.ui).toStrictEqual(parseUiState(json(UI_STATE_KEY)));
        const paths = json(WARNED_PATHS_KEY);
        expect(state.warnedRefusedPaths).toStrictEqual(
          Array.isArray(paths)
            ? paths.filter((path) => typeof path === 'string')
            : []
        );
      })
    );
  });

  it('starts empty on a device that has stored nothing', () => {
    expect(loadDeviceState(makeLocalStorage())).toStrictEqual({
      session: null,
      ui: { folderImportIncludeSubfolders: false },
      warnedRefusedPaths: [],
    });
  });
});

describe('writing device state', () => {
  it('reads back what was written, each key apart from the others', () => {
    fc.assert(
      fc.property(
        storedArb,
        fc.option(fc.record({ deviceId: idArb, itemId: idArb }), { nil: null }),
        fc.record({ folderImportIncludeSubfolders: fc.boolean() }),
        fc.array(fc.string()),
        fc.subarray([...STATE_KEYS]),
        (stored, session, ui, paths, written) => {
          const app = makeLocalStorage(stored);
          const before = app.snapshot();

          if (written.includes(SESSION_KEY)) writeSession(app, session);
          if (written.includes(UI_STATE_KEY)) writeUiState(app, ui);
          if (written.includes(WARNED_PATHS_KEY)) writeWarnedPaths(app, paths);

          const state = loadDeviceState(app);
          const after = app.snapshot();
          for (const key of STATE_KEYS) {
            if (!written.includes(key)) expect(after[key]).toEqual(before[key]);
          }
          if (written.includes(SESSION_KEY)) {
            expect(state.session).toStrictEqual(parseSession(session));
          }
          if (written.includes(UI_STATE_KEY)) expect(state.ui).toEqual(ui);
          if (written.includes(WARNED_PATHS_KEY)) {
            expect(state.warnedRefusedPaths).toEqual(paths);
          }
        }
      )
    );
  });

  it('drops the pointer for none', () => {
    const app = makeLocalStorage({ [SESSION_KEY]: makeSession() });

    writeSession(app, null);

    expect(app.entries.has(SESSION_KEY)).toBe(false);
  });
});

describe('migrateLegacyDeviceState', () => {
  it("moves this device's state out of any data.json into what it has not stored yet, and says whether there was any", () => {
    fc.assert(
      fc.property(dataJsonArb, storedArb, (raw, stored) => {
        const app = makeLocalStorage(stored);
        const before = app.snapshot();

        const found = migrateLegacyDeviceState(app, raw, DEVICE);

        expect(found).toBe(
          isRecord(raw) && legacyKeys.some((key) => key in raw)
        );
        expect(app.snapshot()).toStrictEqual(
          expectedAfterMigration(raw, before)
        );
      })
    );
  });

  it('finds nothing the second time, in the file written back without it, and stores nothing more', () => {
    fc.assert(
      fc.property(dataJsonArb, storedArb, (raw, stored) => {
        const app = makeLocalStorage(stored);
        migrateLegacyDeviceState(app, raw, DEVICE);
        const migrated = app.snapshot();
        // What the plugin writes back: the settings, under their own key
        const written = { settings: isRecord(raw) ? raw.settings : {} };

        expect(migrateLegacyDeviceState(app, written, DEVICE)).toBe(false);
        // The unchanged file a second time takes nothing over either
        migrateLegacyDeviceState(app, raw, DEVICE);
        expect(app.snapshot()).toStrictEqual(migrated);
      })
    );
  });

  it("drops another device's pointer instead of taking it over", () => {
    const app = makeLocalStorage();

    expect(
      migrateLegacyDeviceState(
        app,
        { settings: {}, session: makeSession('device-b') },
        DEVICE
      )
    ).toBe(true);
    expect(loadDeviceState(app).session).toBeNull();
  });

  it("takes over this device's pointer, dialog state and warned paths", () => {
    const app = makeLocalStorage();

    migrateLegacyDeviceState(
      app,
      {
        settings: {},
        session: makeSession(),
        ui: { folderImportIncludeSubfolders: true },
        warnedRefusedPaths: ['a|b.md'],
      },
      DEVICE
    );

    expect(loadDeviceState(app)).toStrictEqual({
      session: makeSession(),
      ui: { folderImportIncludeSubfolders: true },
      warnedRefusedPaths: ['a|b.md'],
    });
  });
});
