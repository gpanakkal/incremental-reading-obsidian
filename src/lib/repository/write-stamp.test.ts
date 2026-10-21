import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bumpWriteStamp,
  classifyIncoming,
  KNOWN_WRITE_STAMP_KEY,
  loadKnownWriteVector,
  readFileWriteVector,
  readWriteVector,
  saveKnownWriteVector,
  STALE_AFTER_MS,
  type WriteVector,
} from './write-stamp';

// #region HELPERS

const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
const SCHEMA_VERSION = Number(/user_version\s*=\s*(\d+)/.exec(SCHEMA)![1]);
const DAY = 24 * 60 * 60 * 1000;
/** A moment to place generations around. */
const T = 1_790_000_000_000;

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function makeDb(): Database {
  const db = new SQL.Database();
  db.exec(SCHEMA);
  return db;
}

/** Whether `a` and `b` name the same devices at the same generations. */
function equal(a: WriteVector, b: WriteVector): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => k in b && a[k] === b[k])
  );
}

/**
 * Whether `a` has seen every save `b` has and at least one more: every device
 * of `b` at a generation at least as high in `a`, and `a` not equal to `b`.
 */
function dominates(a: WriteVector, b: WriteVector): boolean {
  return (
    !equal(a, b) && Object.entries(b).every(([k, g]) => k in a && a[k] >= g)
  );
}

/** The newest generation of `v`, no later than `now`. */
function newestBy(v: WriteVector, now: number): number {
  const values = Object.values(v);
  return values.length === 0 ? -Infinity : Math.min(now, Math.max(...values));
}

/** A few devices, so generated vectors share some and differ in others. */
const deviceArb = fc.constantFrom('a', 'b', 'c', 'd');

/**
 * Generations within a year either side of `T`, weighted toward the 180-day
 * boundary and toward ties, where the rules change.
 */
const generationArb = fc.oneof(
  fc.integer({ min: T - 365 * DAY, max: T + 365 * DAY }),
  fc
    .tuple(
      fc.constantFrom(-STALE_AFTER_MS, 0, STALE_AFTER_MS),
      fc.integer({ min: -2, max: 2 })
    )
    .map(([base, d]) => T + base + d),
  fc.constantFrom(T, T + 1)
);

const vectorArb: fc.Arbitrary<WriteVector> = fc.dictionary(
  deviceArb,
  generationArb,
  { maxKeys: 4 }
);

/**
 * `mine` and a `theirs` related to it every way a file can be: the same, a
 * later save of it (a device's generation raised, or a device added), an
 * earlier one, or unrelated.
 */
const pairArb: fc.Arbitrary<[WriteVector, WriteVector]> = vectorArb.chain(
  (mine) =>
    fc
      .oneof(
        fc.constant(mine),
        fc
          .tuple(vectorArb, fc.nat({ max: 400 * DAY }))
          .map(([extra, raise]) => ({
            ...extra,
            ...Object.fromEntries(
              Object.entries(mine).map(([k, g]) => [
                k,
                Math.max(g, extra[k] ?? -Infinity) + raise,
              ])
            ),
          })),
        fc
          .tuple(fc.subarray(Object.keys(mine)), fc.nat({ max: 400 * DAY }))
          .map(([kept, lower]) =>
            Object.fromEntries(kept.map((k) => [k, mine[k] - lower]))
          ),
        vectorArb
      )
      .map((theirs) => [mine, theirs] as [WriteVector, WriteVector])
);

/** A clock somewhere about `T`, sometimes behind the generations it reads. */
const nowArb = fc.oneof(
  fc.integer({ min: T - 400 * DAY, max: T + 400 * DAY }),
  fc.constant(T + 10 * 365 * DAY)
);

/** An app whose per-vault localStorage is `entries`, or fails as told. */
function makeApp(
  entries = new Map<string, unknown>(),
  { load = true, save = true }: { load?: boolean; save?: boolean } = {}
) {
  return {
    entries,
    loadLocalStorage: (key: string) => {
      if (!load) throw new Error('storage blocked');
      return entries.get(key) ?? null;
    },
    saveLocalStorage: (key: string, value: unknown) => {
      if (!save) throw new Error('storage blocked');
      entries.set(key, value);
    },
  };
}

// #endregion

describe('classifyIncoming', () => {
  it('property: an echo exactly when the stamps are the same', () => {
    fc.assert(
      fc.property(pairArb, nowArb, ([mine, theirs], now) => {
        expect(classifyIncoming(mine, theirs, now) === 'echo').toBe(
          equal(mine, theirs)
        );
      })
    );
  });

  it('property: a fast-forward exactly when the copy has every save this device has, and more', () => {
    fc.assert(
      fc.property(pairArb, nowArb, ([mine, theirs], now) => {
        expect(classifyIncoming(mine, theirs, now) === 'fast-forward').toBe(
          dominates(theirs, mine)
        );
      })
    );
  });

  it('property: stale exactly when, failing those, the newest saves are more than 180 days apart', () => {
    fc.assert(
      fc.property(pairArb, nowArb, ([mine, theirs], now) => {
        const kind = classifyIncoming(mine, theirs, now);
        const placed = equal(mine, theirs) || dominates(theirs, mine);
        const ahead = newestBy(theirs, now) - newestBy(mine, now);

        expect(kind === 'stale-self').toBe(!placed && ahead > STALE_AFTER_MS);
        expect(kind === 'stale-other').toBe(!placed && -ahead > STALE_AFTER_MS);
      })
    );
  });

  it('property: behind when this device has every save the copy has and more, and merge when each lacks some, unless stale', () => {
    fc.assert(
      fc.property(pairArb, nowArb, ([mine, theirs], now) => {
        const kind = classifyIncoming(mine, theirs, now);
        fc.pre(kind !== 'stale-self' && kind !== 'stale-other');
        const placed = equal(mine, theirs) || dominates(theirs, mine);

        expect(kind === 'behind').toBe(dominates(mine, theirs));
        expect(kind === 'merge').toBe(!placed && !dominates(mine, theirs));
      })
    );
  });

  it('property: one device stale to the other exactly when the other is stale to it', () => {
    fc.assert(
      fc.property(pairArb, nowArb, ([mine, theirs], now) => {
        fc.pre(!dominates(mine, theirs) && !dominates(theirs, mine));

        expect(classifyIncoming(mine, theirs, now) === 'stale-self').toBe(
          classifyIncoming(theirs, mine, now) === 'stale-other'
        );
      })
    );
  });

  it('property: the clock matters only to generations ahead of it', () => {
    fc.assert(
      fc.property(
        pairArb,
        fc.nat({ max: 400 * DAY }),
        fc.nat({ max: 400 * DAY }),
        ([mine, theirs], a, b) => {
          const latest = Math.max(
            -Infinity,
            ...Object.values(mine),
            ...Object.values(theirs)
          );
          fc.pre(Number.isFinite(latest));

          expect(classifyIncoming(mine, theirs, latest + a)).toBe(
            classifyIncoming(mine, theirs, latest + b)
          );
        }
      )
    );
  });

  it.each([
    { apart: STALE_AFTER_MS, kind: 'merge' },
    { apart: STALE_AFTER_MS + 1, kind: 'stale-self' },
    { apart: -STALE_AFTER_MS, kind: 'merge' },
    { apart: -STALE_AFTER_MS - 1, kind: 'stale-other' },
  ])(
    'takes saves $apart ms apart, each lacking the other, for $kind',
    ({ apart, kind }) => {
      const mine = { me: T, them: T - 400 * DAY };
      const theirs = { them: T + apart };

      expect(classifyIncoming(mine, theirs, T + 400 * DAY)).toBe(kind);
    }
  );

  it('property: swapping the two stamps turns each class into its mirror', () => {
    const mirrors: Record<string, string[]> = {
      echo: ['echo'],
      'fast-forward': ['behind', 'stale-other'],
      behind: ['fast-forward'],
      'stale-self': ['stale-other'],
      'stale-other': ['stale-self', 'fast-forward'],
      merge: ['merge'],
    };
    fc.assert(
      fc.property(pairArb, nowArb, ([mine, theirs], now) => {
        expect(mirrors[classifyIncoming(mine, theirs, now)]).toContain(
          classifyIncoming(theirs, mine, now)
        );
      })
    );
  });

  it('property: a generation already past the clock reads the same however far past it is', () => {
    fc.assert(
      fc.property(
        pairArb,
        nowArb,
        fc.boolean(),
        fc.nat({ max: 10 * 365 * DAY }),
        ([mine, theirs], now, inTheirs, further) => {
          const latest = Math.max(
            -Infinity,
            ...Object.values(mine),
            ...Object.values(theirs)
          );
          fc.pre(latest >= now);
          const [target, other] = inTheirs ? [theirs, mine] : [mine, theirs];
          // Ahead of the other stamp at that device too, so raising it keeps
          // which stamp has seen which saves
          const device = Object.keys(target).find(
            (d) => target[d] === latest && !(other[d] >= latest)
          );
          fc.pre(device !== undefined);
          const raised = { ...target, [device]: latest + further };
          const [m, t] = inTheirs ? [mine, raised] : [raised, theirs];

          expect(classifyIncoming(m, t, now)).toBe(
            classifyIncoming(mine, theirs, now)
          );
        }
      )
    );
  });

  it('reads a copy stamped by a clock that ran ahead as stamped now, finding neither device stale', () => {
    const mine = { me: T };
    const theirs = { me: T - 1, them: T + 365 * DAY };

    expect(classifyIncoming(mine, theirs, T)).toBe('merge');
    expect(classifyIncoming(theirs, mine, T)).toBe('merge');
  });

  it('takes any copy on over a database never saved, and leaves no copy alone as an echo of one', () => {
    expect(classifyIncoming({}, { them: T }, T)).toBe('fast-forward');
    expect(classifyIncoming({}, {}, T)).toBe('echo');
    expect(classifyIncoming({ me: T }, {}, T)).toBe('stale-other');
  });

  it('takes a device the copy lacks for a save it has not seen, however old', () => {
    const mine = { me: T - 10 * DAY, them: T };
    const theirs = { them: T + 1 };

    expect(classifyIncoming(mine, theirs, T + 1)).toBe('merge');
  });
});

describe('readWriteVector', () => {
  it('property: reads back every device and generation saved', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.integer({ min: 0, max: 2 ** 52 })),
        (vector) => {
          const db = makeDb();
          for (const [device, generation] of Object.entries(vector)) {
            db.run('INSERT INTO write_stamp VALUES ($1, $2)', [
              device,
              generation,
            ]);
          }

          expect(readWriteVector(db)).toEqual(vector);
          db.close();
        }
      )
    );
  });

  it('is null for a database with no write stamp table', () => {
    const db = new SQL.Database();
    db.exec('CREATE TABLE article (id TEXT)');

    expect(readWriteVector(db)).toBeNull();
    db.close();
  });

  it('skips rows that are not a device and a number, as a file edited by hand may hold', () => {
    const db = makeDb();
    db.run(
      `INSERT INTO write_stamp VALUES ('ok', 5), (X'07', 1), ('text', 'soon'), ('nan', 'NaN')`
    );

    expect(readWriteVector(db)).toEqual({ ok: 5 });
    db.close();
  });
});

describe('readFileWriteVector', () => {
  it('reads the stamp of a database file, closing its copy', () => {
    const db = makeDb();
    db.run(`INSERT INTO write_stamp VALUES ('a', 3)`);
    const bytes = db.export();
    db.close();
    const close = vi.spyOn(SQL.Database.prototype, 'close');

    expect(readFileWriteVector(SQL, bytes, SCHEMA_VERSION)).toEqual({ a: 3 });
    expect(close).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it('is unstamped for a database from before the write stamp', () => {
    const db = new SQL.Database();
    db.exec('CREATE TABLE article (id TEXT); PRAGMA user_version = 11');
    const bytes = db.export();
    db.close();

    expect(readFileWriteVector(SQL, bytes, SCHEMA_VERSION)).toBe('unstamped');
  });

  it('is unreadable for a database at a schema version past this one', () => {
    const db = makeDb();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    const bytes = db.export();
    db.close();

    expect(readFileWriteVector(SQL, bytes, SCHEMA_VERSION)).toBe('unreadable');
    expect(readFileWriteVector(SQL, bytes, SCHEMA_VERSION + 1)).toEqual({});
  });

  it('property: is unreadable for anything that does not open as a database', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        expect(readFileWriteVector(SQL, bytes, SCHEMA_VERSION)).toBe(
          'unreadable'
        );
      })
    );
  });
});

describe('bumpWriteStamp', () => {
  it('property: raises this device to one past its last generation or the clock, whichever is later, leaving other devices be', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('a', 'b'), generationArb),
        fc.array(nowArb, { minLength: 1, maxLength: 5 }),
        (start, clocks) => {
          const db = makeDb();
          for (const [device, generation] of Object.entries(start)) {
            db.run('INSERT INTO write_stamp VALUES ($1, $2)', [
              device,
              generation,
            ]);
          }
          let previous = start.me;

          for (const now of clocks) {
            const stamp = bumpWriteStamp(db, 'me', now);
            const expected =
              previous === undefined ? now : Math.max(previous + 1, now);

            expect(stamp).toEqual({ ...start, me: expected });
            expect(readWriteVector(db)).toEqual(stamp);
            previous = expected;
          }
          db.close();
        }
      )
    );
  });
});

describe('known write stamp', () => {
  it('property: loads the stamp it saved', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.integer()),
        (vector: WriteVector) => {
          const app = makeApp();
          saveKnownWriteVector(app, vector);

          expect(app.entries.get(KNOWN_WRITE_STAMP_KEY)).toEqual(vector);
          expect(loadKnownWriteVector(app)).toEqual(vector);
        }
      )
    );
  });

  it.each([
    { stored: null },
    { stored: 'a string' },
    { stored: 5 },
    { stored: [1, 2] },
    { stored: { a: 'soon' } },
    { stored: { a: Infinity } },
  ])('loads nothing in place of a stored $stored', ({ stored }) => {
    const app = makeApp(new Map([[KNOWN_WRITE_STAMP_KEY, stored]]));

    expect(loadKnownWriteVector(app)).toBeNull();
  });

  it('loads nothing, and saves without throwing, where storage fails', () => {
    const app = makeApp(new Map(), { load: false, save: false });

    expect(loadKnownWriteVector(app)).toBeNull();
    expect(() => saveKnownWriteVector(app, { a: 1 })).not.toThrow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
