import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PositionRow,
  PositionStore,
  STORAGE_WRITE_INTERVAL_MS,
  type StoredPosition,
} from './position-store';

// #region HELPERS

const DEVICE = 'this-device';
const OTHER = 'other-device';

type Entries = Record<string, StoredPosition> | null;

/** A device tier over one value, as `app.saveLocalStorage` keeps it. */
function makeStorage(initial: unknown = null) {
  let data: unknown = structuredClone(initial);
  return {
    load: vi.fn(() => structuredClone(data)),
    save: vi.fn((entries: Entries) => {
      data = structuredClone(entries);
    }),
    get data() {
      return data as Entries;
    },
  };
}

/** A clock the test moves by hand. */
function makeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * A database tier over `initial`, stamping each write the way 0167's
 * triggers do: `max(previous + 1, now)` and this device.
 */
function makeRows(
  initial: Record<string, PositionRow> = {},
  clock: () => number = () => 0
) {
  const rows = new Map(Object.entries(structuredClone(initial)));
  return {
    rows,
    read: vi.fn(async (id: string) => {
      const row = rows.get(id);
      return row ? { ...row } : null;
    }),
    write: vi.fn(async (id: string, position: number) => {
      const previous = rows.get(id);
      rows.set(id, {
        position,
        updatedAt: Math.max((previous?.updatedAt ?? 0) + 1, clock()),
        updatedBy: DEVICE,
      });
    }),
  };
}

function makeStore(
  options: {
    storage?: ReturnType<typeof makeStorage>;
    rows?: ReturnType<typeof makeRows>;
    clock?: ReturnType<typeof makeClock>;
    onError?: (error: unknown) => void;
  } = {}
) {
  const clock = options.clock ?? makeClock();
  const storage = options.storage ?? makeStorage();
  const rows = options.rows ?? makeRows({}, clock.now);
  const store = new PositionStore({
    storage,
    rows,
    deviceId: () => DEVICE,
    now: clock.now,
    onError: options.onError,
  });
  return { store, storage, rows, clock };
}

function row(position: number, updatedAt = 0, updatedBy = DEVICE): PositionRow {
  return { position, updatedAt, updatedBy };
}

/** Let every pending promise and timer run. */
async function settle() {
  await vi.runAllTimersAsync();
}

// #endregion

beforeEach(() => {
  vi.useFakeTimers();
  // The store schedules through `window`, which the node environment lacks
  vi.stubGlobal('window', {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('restore', () => {
  it("opens at the device tier's position without asking the database", async () => {
    const { store, rows } = makeStore({
      storage: makeStorage({ a: { position: 42, at: 5 } }),
      rows: makeRows({ a: row(7) }),
    });
    await expect(store.open('a').restore()).resolves.toBe(42);
    expect(rows.read).not.toHaveBeenCalled();
  });

  it("opens at the row's position when the device tier has none", async () => {
    const { store } = makeStore({ rows: makeRows({ a: row(7) }) });
    await expect(store.open('a').restore()).resolves.toBe(7);
  });

  it('opens nowhere when the row holds no position or there is no row', async () => {
    const { store } = makeStore({ rows: makeRows({ a: row(0) }) });
    await expect(store.open('a').restore()).resolves.toBeNull();
    await expect(store.open('b').restore()).resolves.toBeNull();
  });

  it('opens nowhere, and says why, when the row cannot be read', async () => {
    const onError = vi.fn();
    const rows = makeRows();
    const error = new Error('no db');
    rows.read.mockRejectedValue(error);
    const { store } = makeStore({ rows, onError });
    await expect(store.open('a').restore()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('opens a second tab at where the first one is, before storage is written', async () => {
    const { store, storage } = makeStore({ rows: makeRows({ a: row(7) }) });
    const first = store.open('a');
    await first.restore();
    first.set(300);
    expect(storage.save).not.toHaveBeenCalled();
    await expect(store.open('a').restore()).resolves.toBe(300);
  });

  it('ignores stored values that are not positions', async () => {
    const { store } = makeStore({
      storage: makeStorage({
        a: { position: 'x', at: 1 },
        b: { position: 3, at: Number.NaN },
        c: null,
        d: { position: 9, at: 2 },
      }),
      rows: makeRows({ a: row(1), b: row(2), c: row(3), d: row(4) }),
    });
    await expect(store.open('a').restore()).resolves.toBe(1);
    await expect(store.open('b').restore()).resolves.toBe(2);
    await expect(store.open('c').restore()).resolves.toBe(3);
    await expect(store.open('d').restore()).resolves.toBe(9);
  });

  it.each([null, 'text', 12, ['a']])(
    'reads %j in storage as no entries',
    async (stored) => {
      const { store } = makeStore({
        storage: makeStorage(stored),
        rows: makeRows({ 0: row(5), a: row(6) }),
      });
      await expect(store.open('0').restore()).resolves.toBe(5);
      await expect(store.open('a').restore()).resolves.toBe(6);
    }
  );

  it('reads storage that throws as no entries, and says why', async () => {
    const onError = vi.fn();
    const storage = makeStorage();
    const error = new Error('denied');
    storage.load.mockImplementation(() => {
      throw error;
    });
    const { store } = makeStore({
      storage,
      rows: makeRows({ a: row(6) }),
      onError,
    });
    await expect(store.open('a').restore()).resolves.toBe(6);
    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe('device tier writes', () => {
  it('writes the latest of many moves once, a write interval after the first', async () => {
    const { store, storage, clock } = makeStore();
    const handle = store.open('a');
    handle.set(10);
    clock.tick(20);
    handle.set(20);
    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS - 1);
    handle.set(30);
    expect(storage.save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.data).toEqual({ a: { position: 30, at: 1_020 } });

    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS * 10);
    expect(storage.save).toHaveBeenCalledOnce();
  });

  it('writes again for a move after the last write', async () => {
    const { store, storage } = makeStore();
    const handle = store.open('a');
    handle.set(10);
    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS);
    handle.set(20);
    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS);
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(storage.data?.a?.position).toBe(20);
  });

  it('keeps every item in the one entry map', async () => {
    const { store, storage } = makeStore({
      storage: makeStorage({ old: { position: 1, at: 1 } }),
    });
    store.open('a').set(10);
    store.open('b').set(20);
    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS);
    expect(Object.keys(storage.data ?? {}).sort()).toEqual(['a', 'b', 'old']);
  });

  it('writes nothing for a move back to where the tab opened from the row', async () => {
    const { store, storage } = makeStore({ rows: makeRows({ a: row(7) }) });
    const handle = store.open('a');
    await handle.restore();
    handle.set(7);
    await settle();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('writes nothing for a move to the position the device tier holds', async () => {
    const { store, storage } = makeStore({
      storage: makeStorage({ a: { position: 42, at: 1 } }),
    });
    const handle = store.open('a');
    await handle.restore();
    handle.set(42);
    await settle();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("records a tab's move back to the row's position over another tab's move", async () => {
    const { store, storage } = makeStore({ rows: makeRows({ a: row(7) }) });
    const first = store.open('a');
    await first.restore();
    const second = store.open('a');
    await second.restore();
    second.set(50);
    first.set(8);
    first.set(7);
    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS);
    expect(storage.data?.a?.position).toBe(7);
  });

  it('ignores moves from a closed handle', async () => {
    const { store, storage } = makeStore();
    const other = store.open('a');
    const handle = store.open('a');
    handle.close();
    handle.set(10);
    await settle();
    expect(storage.save).not.toHaveBeenCalled();
    other.close();
  });

  it('keeps moves in memory, and says why, when storage refuses them', async () => {
    const onError = vi.fn();
    const storage = makeStorage();
    const error = new Error('quota');
    storage.save.mockImplementation(() => {
      throw error;
    });
    const { store } = makeStore({
      storage,
      rows: makeRows({ a: row(1) }),
      onError,
    });
    const handle = store.open('a');
    handle.set(10);
    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS);
    expect(onError).toHaveBeenCalledWith(error);
    await expect(store.open('a').restore()).resolves.toBe(10);
  });

  it('persist writes a waiting move at once, and nothing when none waits', () => {
    const { store, storage } = makeStore();
    store.persist();
    expect(storage.save).not.toHaveBeenCalled();
    store.open('a').set(10);
    store.persist();
    expect(storage.save).toHaveBeenCalledOnce();
    expect(storage.data?.a?.position).toBe(10);
    vi.advanceTimersByTime(STORAGE_WRITE_INTERVAL_MS);
    expect(storage.save).toHaveBeenCalledOnce();
  });
});

describe('database writes', () => {
  it('writes nothing while tabs hold the item', async () => {
    const { store, rows } = makeStore({ rows: makeRows({ a: row(1) }) });
    const first = store.open('a');
    const second = store.open('a');
    first.set(10);
    second.set(20);
    first.close();
    first.close();
    await settle();
    expect(rows.read).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
    second.close();
    await settle();
    expect(rows.write.mock.calls).toEqual([['a', 20, row(1)]]);
  });

  it('writes the latest position once the last tab closes, then drops the entry', async () => {
    const { store, storage, rows } = makeStore({
      rows: makeRows({ a: row(1) }),
    });
    const handle = store.open('a');
    handle.set(10);
    handle.set(11);
    handle.close();
    await settle();
    expect(rows.write).toHaveBeenCalledOnce();
    expect(rows.rows.get('a')?.position).toBe(11);
    expect(storage.data).toBeNull();
  });

  it('has the entry on disk while the database is written', async () => {
    const { store, storage, rows } = makeStore({
      rows: makeRows({ a: row(1) }),
    });
    let onDisk: Entries = null;
    rows.read.mockImplementation(async () => {
      onDisk = storage.data;
      return row(1);
    });
    const handle = store.open('a');
    handle.set(10);
    handle.close();
    await settle();
    expect(onDisk).toEqual({ a: { position: 10, at: 1_000 } });
  });

  it('closes without reading the database when nothing moved', async () => {
    const { store, rows } = makeStore({ rows: makeRows({ a: row(1) }) });
    store.open('a').close();
    await settle();
    expect(rows.read).not.toHaveBeenCalled();
  });

  it('drops the entry of an item that has no row, writing nothing', async () => {
    const { store, storage, rows } = makeStore();
    const handle = store.open('a');
    handle.set(10);
    handle.close();
    await settle();
    expect(rows.write).not.toHaveBeenCalled();
    expect(storage.data).toBeNull();
  });

  it('keeps the entry when a tab opens the item while it is written', async () => {
    const { store, storage, rows } = makeStore({
      rows: makeRows({ a: row(1) }),
    });
    const handle = store.open('a');
    handle.set(10);
    handle.close();
    const reopened = store.open('a');
    await settle();
    expect(rows.write).toHaveBeenCalledOnce();
    expect(storage.data?.a?.position).toBe(10);
    await expect(reopened.restore()).resolves.toBe(10);
  });

  it('keeps a move made while the closed item was written', async () => {
    const { store, storage, rows } = makeStore({
      rows: makeRows({ a: row(1) }),
    });
    let reopened: ReturnType<typeof store.open> | null = null;
    rows.read.mockImplementation(async () => {
      reopened = store.open('a');
      reopened.set(99);
      reopened.close();
      return row(1);
    });
    const handle = store.open('a');
    handle.set(10);
    handle.close();
    await settle();
    expect(rows.rows.get('a')?.position).toBe(99);
    expect(reopened).not.toBeNull();
    expect(storage.data).toBeNull();
  });

  it.each([
    ['the read', 'read'],
    ['the write', 'write'],
  ] as const)(
    'keeps the entry, and says why, when %s fails',
    async (_label, method) => {
      const onError = vi.fn();
      const rows = makeRows({ a: row(1) });
      const error = new Error('db gone');
      rows[method].mockRejectedValueOnce(error);
      const { store, storage } = makeStore({ rows, onError });
      const handle = store.open('a');
      handle.set(10);
      handle.close();
      await settle();
      expect(onError).toHaveBeenCalledWith(error);
      expect(storage.data?.a?.position).toBe(10);

      await store.flushAll();
      expect(rows.rows.get('a')?.position).toBe(10);
      expect(storage.data).toBeNull();
    }
  );

  it('writes a row another device changed before the move', async () => {
    const clock = makeClock(500);
    const { store, rows } = makeStore({
      clock,
      rows: makeRows({ a: row(1, 499, OTHER) }, clock.now),
    });
    const handle = store.open('a');
    handle.set(10);
    handle.close();
    await settle();
    expect(rows.rows.get('a')?.position).toBe(10);
  });

  it('leaves a row another device changed after the move, and drops the entry', async () => {
    const clock = makeClock(500);
    const { store, rows, storage } = makeStore({
      clock,
      rows: makeRows({ a: row(1, 500, OTHER) }, clock.now),
    });
    const handle = store.open('a');
    handle.set(10);
    handle.close();
    await settle();
    expect(rows.write).not.toHaveBeenCalled();
    expect(storage.data).toBeNull();
  });

  it('writes a row this device changed after the move', async () => {
    const clock = makeClock(500);
    const { store, rows } = makeStore({
      clock,
      rows: makeRows({ a: row(1, 9_000, DEVICE) }, clock.now),
    });
    const handle = store.open('a');
    handle.set(10);
    handle.close();
    await settle();
    expect(rows.rows.get('a')?.position).toBe(10);
  });

  it('writes a row stamped after the move whose position nobody moved', async () => {
    const clock = makeClock(500);
    const { store, rows } = makeStore({
      clock,
      rows: makeRows({ a: row(1, 0, DEVICE) }, clock.now),
    });
    const handle = store.open('a');
    await handle.restore();
    handle.set(10);
    // Another device reviews the item: a newer stamp, the same position
    rows.rows.set('a', row(1, 9_000, OTHER));
    handle.close();
    await settle();
    expect(rows.rows.get('a')?.position).toBe(10);
  });

  it('leaves a position another device stored after the move, though this device stamped the row since', async () => {
    const clock = makeClock(500);
    const { store, rows, storage } = makeStore({
      clock,
      rows: makeRows({ a: row(1, 0, DEVICE) }, clock.now),
    });
    const handle = store.open('a');
    await handle.restore();
    handle.set(10);
    // Synced in: another device's position, then this device reviews the item
    rows.rows.set('a', row(30, 9_000, DEVICE));
    handle.close();
    await settle();
    expect(rows.write).not.toHaveBeenCalled();
    expect(storage.data).toBeNull();
  });

  it("writes a move made after a flush saw the other device's position", async () => {
    const clock = makeClock(500);
    const { store, rows } = makeStore({
      clock,
      rows: makeRows({ a: row(1, 0, DEVICE) }, clock.now),
    });
    const handle = store.open('a');
    await handle.restore();
    handle.set(10);
    rows.rows.set('a', row(30, 2_000, OTHER));
    // The document goes hidden: the other device's position is newer
    await store.flushAll();
    expect(rows.write).not.toHaveBeenCalled();

    // The reader moves on from there, then reviews the item
    handle.set(40);
    rows.rows.set('a', row(30, 9_000, DEVICE));
    handle.close();
    await settle();
    expect(rows.rows.get('a')?.position).toBe(40);
  });

  it('writes a move made after a flush wrote the row this device stamps later', async () => {
    const clock = makeClock(500);
    const { store, rows } = makeStore({
      clock,
      rows: makeRows({ a: row(1, 0, OTHER) }, clock.now),
    });
    const handle = store.open('a');
    await handle.restore();
    handle.set(10);
    await store.flushAll();
    expect(rows.rows.get('a')?.position).toBe(10);

    handle.set(40);
    rows.rows.set('a', row(10, 9_000, OTHER));
    handle.close();
    await settle();
    expect(rows.rows.get('a')?.position).toBe(40);
  });

  it("keeps a stored entry's base for a move in a tab that opened from it", async () => {
    const clock = makeClock(500);
    const { store, rows } = makeStore({
      clock,
      storage: makeStorage({ a: { position: 5, at: 1, base: 1 } }),
      rows: makeRows({ a: row(1, 9_000, OTHER) }, clock.now),
    });
    const handle = store.open('a');
    await expect(handle.restore()).resolves.toBe(5);
    expect(rows.read).not.toHaveBeenCalled();
    handle.set(7);
    handle.close();
    await settle();
    expect(rows.rows.get('a')?.position).toBe(7);
  });

  it('takes a stored base that is not a position for none', async () => {
    const { store, rows } = makeStore({
      storage: makeStorage({ a: { position: 5, at: 1, base: 'x' } }),
      rows: makeRows({ a: row(1, 9_000, DEVICE) }),
    });
    await store.flushAll();
    expect(rows.rows.get('a')?.position).toBe(5);
  });

  it('writes nothing when the row already holds the position', async () => {
    const { store, rows } = makeStore({
      storage: makeStorage({ a: { position: 10, at: 5 } }),
      rows: makeRows({ a: row(10, 1) }),
    });
    store.open('a').close();
    await settle();
    expect(rows.read).toHaveBeenCalledOnce();
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('flushAll', () => {
  it('writes every entry, keeping those of held items and dropping the rest', async () => {
    const { store, storage, rows } = makeStore({
      storage: makeStorage({ left: { position: 5, at: 2_000 } }),
      rows: makeRows({ left: row(1), held: row(1) }),
    });
    const handle = store.open('held');
    handle.set(10);
    await store.flushAll();
    expect(rows.rows.get('left')?.position).toBe(5);
    expect(rows.rows.get('held')?.position).toBe(10);
    expect(storage.data).toEqual({ held: { position: 10, at: 1_000 } });

    // The held item's tab closes later: nothing new to write
    handle.close();
    await settle();
    expect(rows.write).toHaveBeenCalledTimes(2);
    expect(storage.data).toBeNull();
  });

  it('writes a waiting move to storage before it returns', () => {
    const { store, storage } = makeStore();
    store.open('a').set(10);
    void store.flushAll();
    expect(storage.data?.a?.position).toBe(10);
  });

  it('writes once when the last tab closes during a flush', async () => {
    const { store, rows } = makeStore({ rows: makeRows({ a: row(1) }) });
    const handle = store.open('a');
    handle.set(10);
    const flushed = store.flushAll();
    handle.close();
    await flushed;
    await settle();
    expect(rows.write).toHaveBeenCalledOnce();
  });
});

describe('properties', () => {
  type Command =
    | { kind: 'open'; tab: number; item: number }
    | { kind: 'set'; tab: number; position: number }
    | { kind: 'close'; tab: number }
    | { kind: 'tick'; ms: number };

  const TABS = 3;
  const ITEMS = 2;
  const command: fc.Arbitrary<Command> = fc.oneof(
    fc.record({
      kind: fc.constant('open' as const),
      tab: fc.nat(TABS - 1),
      item: fc.nat(ITEMS - 1),
    }),
    fc.record({
      kind: fc.constant('set' as const),
      tab: fc.nat(TABS - 1),
      position: fc.integer({ min: 1, max: 6 }),
    }),
    fc.record({ kind: fc.constant('close' as const), tab: fc.nat(TABS - 1) }),
    fc.record({
      kind: fc.constant('tick' as const),
      ms: fc.integer({ min: 0, max: 300 }),
    })
  );

  it('writes each item once per last close, with its latest position, and nothing while it is open', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 6 }), {
          minLength: ITEMS,
          maxLength: ITEMS,
        }),
        fc.array(command, { maxLength: 40 }),
        async (initial, commands) => {
          const clock = makeClock();
          const rows = makeRows(
            Object.fromEntries(initial.map((p, i) => [`i${i}`, row(p)])),
            clock.now
          );
          const { store, storage } = makeStore({ clock, rows });
          const tabs = new Map<
            number,
            { item: string; handle: ReturnType<typeof store.open> }
          >();
          /** The last position set for each item this session. */
          const latest = new Map<string, number>();
          const expected: [string, number][] = [];

          for (const step of commands) {
            if (step.kind === 'tick') {
              clock.tick(step.ms);
              await vi.advanceTimersByTimeAsync(step.ms);
              continue;
            }
            const tab = tabs.get(step.tab);
            if (step.kind === 'open') {
              if (tab) continue;
              const item = `i${step.item}`;
              const handle = store.open(item);
              tabs.set(step.tab, { item, handle });
              await handle.restore();
            } else if (step.kind === 'set') {
              if (!tab) continue;
              tab.handle.set(step.position);
              latest.set(tab.item, step.position);
            } else {
              if (!tab) continue;
              tabs.delete(step.tab);
              tab.handle.close();
              const stillHeld = [...tabs.values()].some(
                (other) => other.item === tab.item
              );
              if (!stillHeld) {
                const position = latest.get(tab.item);
                if (
                  position !== undefined &&
                  position !== rows.rows.get(tab.item)?.position
                ) {
                  expected.push([tab.item, position]);
                }
                latest.delete(tab.item);
              }
            }
            await settle();
            expect(
              rows.write.mock.calls.map(([id, position]) => [id, position])
            ).toEqual(expected);
          }

          for (const { handle } of tabs.values()) handle.close();
          for (const [item, position] of latest) {
            if (position !== rows.rows.get(item)?.position) {
              expected.push([item, position]);
            }
          }
          await settle();
          expect(
            rows.write.mock.calls.map(([id, position]) => [id, position]).sort()
          ).toEqual(expected.sort());
          expect(storage.data).toBeNull();
        }
      )
    );
  });

  it('writes a leftover only if it differs and nobody moved the row since', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 10 }),
        fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 10 }),
        fc.constantFrom(DEVICE, OTHER, ''),
        async (position, at, base, rowPosition, updatedAt, updatedBy) => {
          const entry =
            base === undefined ? { position, at } : { position, at, base };
          const { store, rows, storage } = makeStore({
            storage: makeStorage({ a: entry }),
            rows: makeRows({ a: row(rowPosition, updatedAt, updatedBy) }),
          });
          await store.flushAll();
          const unmoved =
            base === undefined ? updatedBy === DEVICE : rowPosition === base;
          const written =
            position !== rowPosition && (at > updatedAt || unmoved);
          expect(rows.write.mock.calls).toEqual(
            written
              ? [['a', position, row(rowPosition, updatedAt, updatedBy)]]
              : []
          );
          expect(storage.data).toBeNull();
        }
      )
    );
  });

  it('flushes leftovers from a killed app once at load, then has none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.constantFrom('a', 'b', 'c', 'd'),
          fc.record({
            position: fc.integer({ min: 1, max: 5 }),
            at: fc.integer({ min: 1, max: 100 }),
          })
        ),
        fc.dictionary(
          fc.constantFrom('a', 'b', 'c', 'd'),
          fc.integer({ min: 0, max: 5 }).map((p) => row(p))
        ),
        async (leftovers, initialRows) => {
          const storage = makeStorage(leftovers);
          const rows = makeRows(initialRows);
          await makeStore({ storage, rows }).store.flushAll();

          const expected = Object.entries(leftovers)
            .filter(
              ([id, entry]) =>
                id in initialRows && initialRows[id].position !== entry.position
            )
            .map(([id, entry]) => [id, entry.position]);
          expect(
            rows.write.mock.calls.map(([id, position]) => [id, position]).sort()
          ).toEqual(expected.sort());
          expect(Object.keys(storage.data ?? {})).toEqual([]);

          // The next load finds nothing left
          const next = makeStore({ storage, rows });
          await next.store.flushAll();
          expect(rows.write).toHaveBeenCalledTimes(expected.length);
        }
      )
    );
  });
});
