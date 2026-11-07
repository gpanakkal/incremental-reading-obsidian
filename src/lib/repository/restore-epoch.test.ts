import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  answerByRestoreEpoch,
  bumpRestoreEpoch,
  KNOWN_RESTORE_EPOCH_KEY,
  loadKnownRestoreEpoch,
  NEVER_RESTORED,
  readRestoreEpoch,
  saveKnownRestoreEpoch,
} from './restore-epoch';

// #region HELPERS

const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function makeDb(): Database {
  const db = new SQL.Database();
  db.exec(SCHEMA);
  return db;
}

/** Every row of `restore_epoch`, as objects. */
function epochRows(db: Database): Record<string, unknown>[] {
  const [result] = db.exec('SELECT * FROM restore_epoch');
  return (result?.values ?? []).map((row) =>
    Object.fromEntries(result.columns.map((column, i) => [column, row[i]]))
  );
}

/** An epoch as a restore writes one: never restored, or a clock reading. */
const epochArb = fc.oneof(
  fc.constant(NEVER_RESTORED),
  fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - 1 })
);

/** Any clock, including one set back before 1970. */
const nowArb = fc.integer({ min: -1e13, max: 1e13 });

/** localStorage as `App` exposes it, optionally failing. */
function makeApp(
  entries = new Map<string, unknown>(),
  works = { load: true, save: true }
) {
  return {
    entries,
    loadLocalStorage: (key: string): unknown => {
      if (!works.load) throw new Error('storage unavailable');
      return entries.get(key) ?? null;
    },
    saveLocalStorage: (key: string, value: unknown) => {
      if (!works.save) throw new Error('storage unavailable');
      entries.set(key, value);
    },
  };
}

// #endregion

describe('readRestoreEpoch', () => {
  it('reads a database without the table as never restored', () => {
    const db = new SQL.Database();
    db.exec('CREATE TABLE article (id TEXT)');

    expect(readRestoreEpoch(db)).toBe(NEVER_RESTORED);
    db.close();
  });

  it('reads a database whose table has no row as never restored', () => {
    const db = makeDb();

    expect(readRestoreEpoch(db)).toBe(NEVER_RESTORED);
    db.close();
  });

  it('property: reads the epoch stored', () => {
    const db = makeDb();
    fc.assert(
      fc.property(
        fc.oneof(
          epochArb,
          // A file edited by hand; -0 is stored as the integer 0
          fc
            .double({ noNaN: true, noDefaultInfinity: true })
            .filter((epoch) => !Object.is(epoch, -0))
        ),
        (epoch) => {
          db.run('DELETE FROM restore_epoch');
          db.run('INSERT INTO restore_epoch (id, epoch) VALUES (1, $1)', [
            epoch,
          ]);

          expect(readRestoreEpoch(db)).toBe(epoch);
        }
      )
    );
    db.close();
  });

  it.each([{ stored: "'soon'" }, { stored: "X'07'" }])(
    'reads an epoch of $stored, as a file edited by hand may hold, as never restored',
    ({ stored }) => {
      const db = makeDb();
      db.run(`INSERT INTO restore_epoch (id, epoch) VALUES (1, ${stored})`);

      expect(readRestoreEpoch(db)).toBe(NEVER_RESTORED);
      db.close();
    }
  );

  it('reads a table it cannot select an epoch from, as a file edited by hand may hold, as never restored', () => {
    const db = new SQL.Database();
    db.exec('CREATE TABLE restore_epoch (id INTEGER PRIMARY KEY)');
    db.run('INSERT INTO restore_epoch (id) VALUES (1)');

    expect(readRestoreEpoch(db)).toBe(NEVER_RESTORED);
    db.close();
  });
});

describe('bumpRestoreEpoch', () => {
  it('property: sets the one epoch to one past the previous or the clock, whichever is later, recording who restored and when', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(epochArb, nowArb, fc.string()), {
          minLength: 1,
          maxLength: 4,
        }),
        (bumps) => {
          const db = makeDb();

          for (const [previous, now, device] of bumps) {
            const epoch = bumpRestoreEpoch(db, previous, device, now);

            expect(epoch).toBe(Math.max(previous + 1, now));
            expect(epoch).toBeGreaterThan(previous);
            expect(readRestoreEpoch(db)).toBe(epoch);
            expect(epochRows(db)).toEqual([
              { id: 1, epoch, device, restored_at: now },
            ]);
          }
          db.close();
        }
      )
    );
  });
});

describe('answerByRestoreEpoch', () => {
  it('property: takes on a file at a higher epoch, saves over one at a lower, and classifies one at the same', () => {
    fc.assert(
      fc.property(epochArb, epochArb, (mine, theirs) => {
        const answer = answerByRestoreEpoch(mine, theirs);

        expect(answer).toBe(
          theirs > mine ? 'take-on' : theirs < mine ? 'save-over' : 'classify'
        );
      })
    );
  });

  it('property: classifies a file at its own epoch', () => {
    fc.assert(
      fc.property(epochArb, (epoch) => {
        expect(answerByRestoreEpoch(epoch, epoch)).toBe('classify');
      })
    );
  });
});

describe('known restore epoch', () => {
  it('property: loads the epoch it saved', () => {
    fc.assert(
      fc.property(epochArb, (epoch) => {
        const app = makeApp();
        saveKnownRestoreEpoch(app, epoch);

        expect(app.entries.get(KNOWN_RESTORE_EPOCH_KEY)).toBe(epoch);
        expect(loadKnownRestoreEpoch(app)).toBe(epoch);
      })
    );
  });

  it.each([
    { stored: null },
    { stored: '5' },
    { stored: Infinity },
    { stored: NaN },
    { stored: { epoch: 5 } },
  ])('loads nothing in place of a stored $stored', ({ stored }) => {
    const app = makeApp(new Map([[KNOWN_RESTORE_EPOCH_KEY, stored]]));

    expect(loadKnownRestoreEpoch(app)).toBeNull();
  });

  it('loads nothing, and saves without throwing, where storage fails', () => {
    const app = makeApp(new Map(), { load: false, save: false });

    expect(loadKnownRestoreEpoch(app)).toBeNull();
    expect(() => saveKnownRestoreEpoch(app, 1)).not.toThrow();
  });
});
