import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_KEY, getDeviceId } from './device-id';

// #region HELPERS

/** An app whose per-vault localStorage is `entries`, or fails as told. */
function makeApp(
  entries = new Map<string, unknown>(),
  { load = true, save = true }: { load?: boolean; save?: boolean } = {}
) {
  return {
    entries,
    loadLocalStorage: vi.fn((key: string) => {
      if (!load) throw new Error('storage blocked');
      return entries.get(key) ?? null;
    }),
    saveLocalStorage: vi.fn((key: string, value: unknown) => {
      if (!save) throw new Error('storage blocked');
      entries.set(key, value);
    }),
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// #endregion

describe('getDeviceId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: answers the id the vault stored, writing nothing', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (stored) => {
        const app = makeApp(new Map([[DEVICE_ID_KEY, stored]]));

        expect(getDeviceId(app)).toBe(stored);
        expect(app.saveLocalStorage).not.toHaveBeenCalled();
      })
    );
  });

  it('makes a UUID the first time, stores it, and answers it from then on', () => {
    const app = makeApp();

    const id = getDeviceId(app);

    expect(id).toMatch(UUID);
    expect(app.saveLocalStorage).toHaveBeenCalledExactlyOnceWith(
      DEVICE_ID_KEY,
      id
    );
    expect(getDeviceId(app)).toBe(id);
    expect(app.saveLocalStorage).toHaveBeenCalledOnce();
  });

  it.each([null, '', 42, { id: 'x' }])(
    'replaces a stored %j, which is no id',
    (stored) => {
      const app = makeApp(new Map([[DEVICE_ID_KEY, stored]]));

      const id = getDeviceId(app);

      expect(id).toMatch(UUID);
      expect(app.entries.get(DEVICE_ID_KEY)).toBe(id);
    }
  );

  it('gives two vaults two ids', () => {
    expect(getDeviceId(makeApp())).not.toBe(getDeviceId(makeApp()));
  });

  it.each([
    ['read', { load: false }],
    ['written', { save: false }],
    ['neither read nor written', { load: false, save: false }],
  ])(
    'keeps one id for the session when storage cannot be %s',
    (_label, failing) => {
      const app = makeApp(new Map(), failing);

      const id = getDeviceId(app);

      expect(id).toMatch(UUID);
      expect(getDeviceId(app)).toBe(id);
    }
  );

  it('answers a stored id over the one it made while storage failed', () => {
    const app = makeApp(new Map(), { load: false });
    getDeviceId(app);
    app.entries.set(DEVICE_ID_KEY, 'stored-later');
    app.loadLocalStorage.mockImplementation(
      (key: string) => app.entries.get(key) ?? null
    );

    expect(getDeviceId(app)).toBe('stored-later');
  });
});
