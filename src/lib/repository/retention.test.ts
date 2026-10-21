import { BACKUP_DIRECTORY } from '#/lib/constants';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_KEEP_COUNT,
  BACKUP_KEEP_MS,
  backupFileName,
  parseBackupName,
  pastSyncHorizon,
  pruneBackups,
  PRUNED_TABLES,
  pruneDatabase,
  readPruneCandidates,
  selectBackupsToPrune,
  selectTombstonesToPrune,
  type BackupKind,
  type PruneCandidate,
} from './retention';
import { armRowStamps, SYNCED_TABLES, type SyncedTable } from './row-stamps';
import { STALE_AFTER_MS } from './write-stamp';

// #region HELPERS

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** The path of a backup of `kind` at `version`, `age` ms before {@link NOW}. */
function backupAt(kind: BackupKind, version: number, age: number): string {
  return `${BACKUP_DIRECTORY}/${backupFileName(version, kind, new Date(NOW - age))}`;
}

interface Backup {
  path: string;
  kind: BackupKind;
  version: number;
  age: number;
}

/** Ages that sit on, or a millisecond either side of, the 30-day window. */
const backupAgeArb = fc.oneof(
  fc.integer({ min: -DAY, max: 400 * DAY }),
  fc.constantFrom(BACKUP_KEEP_MS - 1, BACKUP_KEEP_MS, BACKUP_KEEP_MS + 1)
);

const backupsArb = fc
  .uniqueArray(
    fc
      .record({
        kind: fc.constantFrom<BackupKind>('merge', 'stale', 'migration'),
        version: fc.integer({ min: 1, max: 6 }),
        age: backupAgeArb,
      })
      .map((b): Backup => ({ ...b, path: backupAt(b.kind, b.version, b.age) })),
    { selector: (b) => b.path, maxLength: 25 }
  )
  .chain((backups) =>
    fc.shuffledSubarray(backups, {
      minLength: backups.length,
      maxLength: backups.length,
    })
  );

/** Files in the backup folder that are no backup this plugin wrote. */
const NOT_BACKUPS = [
  `${BACKUP_DIRECTORY}/notes.md`,
  `${BACKUP_DIRECTORY}/ir-user-data_v3_2020-01-01T00-00-00-000Z.sqlite.bak`,
  `${BACKUP_DIRECTORY}/ir-user-data_v3_2020-13-45T00-00-00-000Z.sqlite`,
  `${BACKUP_DIRECTORY}/my-ir-user-data_v3_2020-01-01T00-00-00-000Z.sqlite`,
  `${BACKUP_DIRECTORY}/ir-user-data_v3_other_2020-01-01T00-00-00-000Z.sqlite`,
  `${BACKUP_DIRECTORY}/ir-user-data_v3_MERGE_2020-01-01T00-00-00-000Z.sqlite`,
  `${BACKUP_DIRECTORY}/ir-user-data_vx_2020-01-01T00-00-00-000Z.sqlite`,
  `${BACKUP_DIRECTORY}/ir-user-data_v3_2020-01-01T00-00-00Z.sqlite`,
];

/**
 * The migration backups in `backups`, or the others, newest first; of two
 * written in the same millisecond, the later name first.
 */
function poolOf(backups: readonly Backup[], migration: boolean): Backup[] {
  return backups
    .filter((b) => (b.kind === 'migration') === migration)
    .sort((a, b) => a.age - b.age || (a.path < b.path ? 1 : -1));
}

const ITEM_TABLES = ['article', 'snippet', 'srs_card'] as const;
const CHILD_TABLES = PRUNED_TABLES.filter((t) => t.parent).map((t) => t.table);
const PARENT_OF = new Map(
  PRUNED_TABLES.flatMap((t) => (t.parent ? [[t.table, t.parent.table]] : []))
);
const KEYS = ['a', 'b', 'c', 'd'];

/** Ages on, or a millisecond either side of, the horizon; NOW = unstamped. */
const rowAgeArb = fc.oneof(
  fc.integer({ min: 0, max: 400 * DAY }),
  fc.constantFrom(STALE_AFTER_MS - 1, STALE_AFTER_MS, STALE_AFTER_MS + 1, NOW)
);

const candidatesArb = fc
  .tuple(
    fc.uniqueArray(
      fc.record({
        table: fc.constantFrom(...ITEM_TABLES),
        key: fc.constantFrom(...KEYS),
        // A snippet or card made from an item names it, and outlives it
        parent: fc.option(fc.constantFrom(...KEYS), { nil: null }),
        deleted: fc.boolean(),
        age: rowAgeArb,
      }),
      { selector: (r) => `${r.table}/${r.key}` }
    ),
    fc.array(
      fc.record({
        table: fc.constantFrom(...CHILD_TABLES),
        parent: fc.option(fc.constantFrom(...KEYS), { nil: null }),
        deleted: fc.boolean(),
        age: rowAgeArb,
      }),
      { maxLength: 12 }
    )
  )
  .map(([items, children]): PruneCandidate[] => [
    ...items.map(({ age, ...row }) => ({ ...row, updatedAt: NOW - age })),
    ...children.map(({ age, ...row }, i) => ({
      ...row,
      key: `child-${i}`,
      updatedAt: NOW - age,
    })),
  ]);

/** Whether `row` is a stamped tombstone past the horizon. */
function expired(row: PruneCandidate): boolean {
  return (
    row.deleted && row.updatedAt > 0 && NOW - row.updatedAt > STALE_AFTER_MS
  );
}

/** The item `row` belongs to among `rows`, if any. */
function itemOf(rows: readonly PruneCandidate[], row: PruneCandidate) {
  const table = PARENT_OF.get(row.table);
  return rows.find((r) => r.table === table && r.key === row.parent);
}

/** A database on the current schema, foreign keys on as the plugin runs. */
function makeDb(): Database {
  const db = new SQL.Database();
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

const STAMPS = { deviceId: () => 'device-a', now: () => NOW };

function addArticle(db: Database, id: string, deleted: boolean, age: number) {
  db.run(
    `INSERT INTO article (id, reference, due, interval, priority, deleted, updated_at, updated_by)
     VALUES (?, ?, 0, 1, 30, ?, ?, 'x')`,
    [id, `n/${id}.md`, deleted ? 1 : 0, NOW - age]
  );
}

function addArticleReview(
  db: Database,
  id: string,
  articleId: string,
  deleted: boolean,
  age: number
) {
  db.run(
    `INSERT INTO article_review (id, article_id, review_time, deleted, updated_at, updated_by)
     VALUES (?, ?, 0, ?, ?, 'x')`,
    [id, articleId, deleted ? 1 : 0, NOW - age]
  );
}

function addRebind(db: Database, articleId: string, age: number) {
  db.run(
    `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at, updated_at, updated_by)
     VALUES (?, 'old.md', 'new.md', 0, ?, 'x')`,
    [articleId, NOW - age]
  );
}

function addSnippet(
  db: Database,
  id: string,
  deleted: boolean,
  age: number,
  parent: string | null = null
) {
  db.run(
    `INSERT INTO snippet (id, reference, parent, due, interval, priority, deleted, updated_at, updated_by)
     VALUES (?, ?, ?, 0, 1, 30, ?, ?, 'x')`,
    [id, `s/${id}.md`, parent, deleted ? 1 : 0, NOW - age]
  );
}

function addSnippetReview(db: Database, id: string, snippetId: string) {
  db.run(
    `INSERT INTO snippet_review (id, snippet_id, review_time, updated_at, updated_by)
     VALUES (?, ?, 0, ?, 'x')`,
    [id, snippetId, NOW]
  );
}

function addCard(db: Database, id: string, deleted: boolean, age: number) {
  db.run(
    `INSERT INTO srs_card (id, reference, created_at, due, deleted, stability, difficulty,
       elapsed_days, scheduled_days, state, updated_at, updated_by)
     VALUES (?, ?, 0, 0, ?, 1, 1, 0, 0, 0, ?, 'x')`,
    [id, `c/${id}.md`, deleted ? 1 : 0, NOW - age]
  );
}

function addCardReview(db: Database, id: string, cardId: string, age: number) {
  db.run(
    `INSERT INTO srs_card_review (id, card_id, review, rating, state, due, stability,
       difficulty, elapsed_days, last_elapsed_days, scheduled_days, learning_steps,
       updated_at, updated_by)
     VALUES (?, ?, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, ?, 'x')`,
    [id, cardId, NOW - age]
  );
}

function stampDevice(db: Database, device: string, age: number) {
  db.run('INSERT INTO write_stamp (device, generation) VALUES (?, ?)', [
    device,
    NOW - age,
  ]);
}

/** Every key left in `table`. */
function keysIn(db: Database, table: SyncedTable | 'write_stamp'): string[] {
  const key =
    table === 'write_stamp'
      ? 'device'
      : PRUNED_TABLES.find((t) => t.table === table)!.key;
  return (db.exec(`SELECT ${key} FROM ${table} ORDER BY 1`)[0]?.values ?? [])
    .flat()
    .map(String);
}

function tempTables(db: Database): string[] {
  return (
    db.exec(`SELECT name FROM sqlite_temp_master WHERE type = 'table'`)[0]
      ?.values ?? []
  )
    .flat()
    .map(String);
}

// #endregion

describe('backup names', () => {
  it('property: reads back the version, kind and time a name was written with, whatever folder it is in', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom<BackupKind>('merge', 'stale', 'migration'),
        fc.integer({ min: Date.UTC(1971, 0, 1), max: Date.UTC(2999, 0, 1) }),
        fc.constantFrom('', 'a/', 'incremental-reading/.backups/'),
        (version, kind, time, folder) => {
          const path = `${folder}${backupFileName(version, kind, new Date(time))}`;
          expect(parseBackupName(path)).toEqual({ path, version, kind, time });
        }
      )
    );
  });

  it('writes no marker for a migration backup, and its kind for the others', () => {
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    expect(backupFileName(12, 'migration', date)).toBe(
      'ir-user-data_v12_2026-01-02T03-04-05-006Z.sqlite'
    );
    expect(backupFileName(12, 'stale', date)).toBe(
      'ir-user-data_v12_stale_2026-01-02T03-04-05-006Z.sqlite'
    );
  });

  it.each(NOT_BACKUPS)('reads %s as no backup', (path) => {
    expect(parseBackupName(path)).toBeNull();
  });

  it('reads a name with text before or after it as no backup', () => {
    const name = backupFileName(3, 'merge', new Date(NOW));
    expect(parseBackupName(`x${name}`)).toBeNull();
    expect(parseBackupName(`${name}x`)).toBeNull();
    expect(parseBackupName(name.replace('.sqlite', 'xsqlite'))).toBeNull();
  });
});

describe('selectBackupsToPrune', () => {
  it('keeps the newest five merge backups, and drops older ones past 30 days', () => {
    const daily = [31, 32, 33, 34, 35, 36, 37].map((d) =>
      backupAt('merge', 12, d * DAY)
    );
    const old = backupAt('merge', 12, 40 * DAY);

    expect(selectBackupsToPrune([old, ...daily], NOW)).toEqual([
      old,
      daily[5],
      daily[6],
    ]);
  });

  it('keeps every merge backup younger than 30 days, however many', () => {
    const daily = [1, 2, 3, 4, 5, 6, 7].map((d) =>
      backupAt('merge', 12, d * DAY)
    );
    const old = backupAt('merge', 12, 40 * DAY);

    expect(selectBackupsToPrune([...daily, old], NOW)).toEqual([old]);
  });

  it('keeps one 200-day-old migration backup of each schema version', () => {
    const v10 = backupAt('migration', 10, 200 * DAY);
    const v11 = backupAt('migration', 11, 200 * DAY);
    const recent = [1, 2, 3, 4, 5].map((d) =>
      backupAt('migration', 12, d * DAY)
    );

    expect(selectBackupsToPrune([v10, v11, ...recent], NOW)).toEqual([]);
  });

  it('drops all but the newest of a version’s migration backups once five newer are kept', () => {
    const v10 = [200, 201, 202].map((d) => backupAt('migration', 10, d * DAY));
    const recent = [1, 2, 3, 4, 5].map((d) =>
      backupAt('migration', 12, d * DAY)
    );

    expect(selectBackupsToPrune([...v10, ...recent], NOW)).toEqual([
      v10[1],
      v10[2],
    ]);
  });

  it('counts merge and stale backups as one pool, and migration backups as another', () => {
    const memory = [
      backupAt('merge', 12, 41 * DAY),
      backupAt('stale', 12, 42 * DAY),
      backupAt('merge', 12, 43 * DAY),
      backupAt('stale', 12, 44 * DAY),
      backupAt('merge', 12, 45 * DAY),
      backupAt('stale', 12, 46 * DAY),
    ];
    const migration = [50, 51, 52, 53, 54].map((d) =>
      backupAt('migration', 12, d * DAY)
    );

    expect(selectBackupsToPrune([...memory, ...migration], NOW)).toEqual([
      memory[5],
    ]);
  });

  it('keeps a backup exactly 30 days old, and drops one a millisecond older', () => {
    const newer = [1, 2, 3, 4, 5].map((d) => backupAt('stale', 12, d * DAY));
    const onEdge = backupAt('stale', 12, BACKUP_KEEP_MS);
    const past = backupAt('stale', 12, BACKUP_KEEP_MS + 1);

    expect(selectBackupsToPrune([...newer, onEdge, past], NOW)).toEqual([past]);
  });

  it('never picks a file that is no backup, however old', () => {
    const newer = [1, 2, 3, 4, 5].map((d) => backupAt('merge', 12, d * DAY));
    expect(selectBackupsToPrune([...NOT_BACKUPS, ...newer], NOW)).toEqual([]);
  });

  it('property: never prunes the newest migration backup of a schema version', () => {
    fc.assert(
      fc.property(backupsArb, (backups) => {
        const pruned = selectBackupsToPrune(
          backups.map((b) => b.path),
          NOW
        );
        for (const version of new Set(backups.map((b) => b.version))) {
          const [newest] = poolOf(backups, true).filter(
            (b) => b.version === version
          );
          if (newest) expect(pruned).not.toContain(newest.path);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('property: never prunes a backup 30 days old or younger', () => {
    fc.assert(
      fc.property(backupsArb, (backups) => {
        const pruned = new Set(
          selectBackupsToPrune(
            backups.map((b) => b.path),
            NOW
          )
        );
        for (const b of backups) {
          if (b.age <= BACKUP_KEEP_MS) expect(pruned.has(b.path)).toBe(false);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('property: keeps the newest five of each pool', () => {
    fc.assert(
      fc.property(backupsArb, (backups) => {
        const pruned = new Set(
          selectBackupsToPrune(
            backups.map((b) => b.path),
            NOW
          )
        );
        for (const migration of [false, true]) {
          const newest = poolOf(backups, migration).slice(0, BACKUP_KEEP_COUNT);
          for (const b of newest) expect(pruned.has(b.path)).toBe(false);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('property: prunes every backup none of those keeps, in the order given, and nothing else', () => {
    fc.assert(
      fc.property(backupsArb, fc.subarray(NOT_BACKUPS), (backups, others) => {
        const paths = [...others, ...backups.map((b) => b.path)];
        const pruned = selectBackupsToPrune(paths, NOW);

        const kept = (b: Backup) => {
          const pool = poolOf(backups, b.kind === 'migration');
          const newestOfVersion =
            b.kind === 'migration' &&
            pool.find((p) => p.version === b.version) === b;
          return (
            b.age <= BACKUP_KEEP_MS ||
            pool.indexOf(b) < BACKUP_KEEP_COUNT ||
            newestOfVersion
          );
        };
        expect(pruned).toEqual(
          backups.filter((b) => !kept(b)).map((b) => b.path)
        );
      }),
      { numRuns: 300 }
    );
  });

  it('property: picks the same backups whatever order they are listed in', () => {
    fc.assert(
      fc.property(
        backupsArb.chain((backups) =>
          fc.tuple(
            fc.constant(backups),
            fc.shuffledSubarray(backups, {
              minLength: backups.length,
              maxLength: backups.length,
            })
          )
        ),
        ([listed, shuffled]) => {
          const pick = (bs: Backup[]) =>
            selectBackupsToPrune(
              bs.map((b) => b.path),
              NOW
            ).sort();
          expect(pick(shuffled)).toEqual(pick(listed));
        }
      ),
      { numRuns: 200 }
    );
  });

  it('keeps the newest migration backup of a version that has a newer merge backup', () => {
    const merge = backupAt('merge', 10, DAY);
    const v10 = backupAt('migration', 10, 200 * DAY);
    const recent = [1, 2, 3, 4, 5].map((d) =>
      backupAt('migration', 12, d * DAY)
    );

    expect(selectBackupsToPrune([merge, v10, ...recent], NOW)).toEqual([]);
  });

  it('property: of backups written in the same millisecond, drops the earliest names, whatever the order', () => {
    const same = [3, 4, 5, 6, 7, 8, 9].map((v) =>
      backupAt('merge', v, 40 * DAY)
    );
    fc.assert(
      fc.property(
        fc.shuffledSubarray(same, { minLength: 7, maxLength: 7 }),
        (listed) => {
          expect(selectBackupsToPrune(listed, NOW).sort()).toEqual(
            same.slice(0, 2)
          );
        }
      )
    );
  });

  it('breaks a tie in time by name, whatever the order', () => {
    // Six backups written in the same millisecond, five newer than 30 days
    // old: the one dropped is the same either way round
    const same = [3, 4, 5, 6, 7, 8].map((v) => backupAt('merge', v, 40 * DAY));
    const forward = selectBackupsToPrune(same, NOW);
    expect(forward).toHaveLength(1);
    expect(selectBackupsToPrune([...same].reverse(), NOW)).toEqual(forward);
    expect(forward).toEqual([same[0]]);
  });
});

describe('pruneBackups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeAdapter(files: string[], folderExists = true) {
    return {
      exists: vi.fn(async () => folderExists),
      list: vi.fn(async () => ({ files: [...files], folders: [] })),
      remove: vi.fn(async (_path: string) => {}),
    };
  }

  it('deletes the backups retention lets go from the backup folder', async () => {
    const keep = [1, 2, 3, 4, 5].map((d) => backupAt('merge', 12, d * DAY));
    const drop = backupAt('merge', 12, 40 * DAY);
    const adapter = makeAdapter([...keep, drop]);

    const pruned = await pruneBackups(adapter, NOW);

    expect(adapter.exists).toHaveBeenCalledWith(BACKUP_DIRECTORY);
    expect(adapter.list).toHaveBeenCalledWith(BACKUP_DIRECTORY);
    expect(adapter.remove.mock.calls).toEqual([[drop]]);
    expect(pruned).toEqual([drop]);
  });

  it('lists nothing when there is no backup folder', async () => {
    const adapter = makeAdapter([], false);

    expect(await pruneBackups(adapter, NOW)).toEqual([]);
    expect(adapter.list).not.toHaveBeenCalled();
  });

  it('still deletes the others when one fails to delete, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keep = [1, 2, 3, 4, 5].map((d) => backupAt('stale', 12, d * DAY));
    const drop = [40, 41].map((d) => backupAt('stale', 12, d * DAY));
    const adapter = makeAdapter([...keep, ...drop]);
    adapter.remove.mockRejectedValueOnce(new Error('busy'));

    const pruned = await pruneBackups(adapter, NOW);

    expect(adapter.remove.mock.calls).toEqual([[drop[0]], [drop[1]]]);
    expect(pruned).toEqual([drop[1]]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('selectTombstonesToPrune', () => {
  const row = (
    table: SyncedTable,
    key: string,
    deleted: boolean,
    age: number,
    parent: string | null = null
  ): PruneCandidate => ({ table, key, parent, deleted, updatedAt: NOW - age });

  it('prunes a tombstone 181 days old with every row of its item, and keeps one 180 days old with its rows', () => {
    const old = row('article', 'old', true, 181 * DAY);
    const oldRows = [
      row('article_review', 'r1', false, DAY, 'old'),
      row('article_review', 'r2', true, DAY, 'old'),
      row('rebind', 'old', false, DAY, 'old'),
    ];
    const edge = row('article', 'edge', true, STALE_AFTER_MS);
    const edgeRow = row('article_review', 'r3', false, DAY, 'edge');

    expect(
      selectTombstonesToPrune([old, edge, ...oldRows, edgeRow], NOW)
    ).toEqual([old, ...oldRows]);
  });

  it('prunes a tombstone a millisecond past 180 days, and never an unstamped one', () => {
    const past = row('snippet', 'past', true, STALE_AFTER_MS + 1);
    const unstamped = row('srs_card', 'u', true, NOW);
    const live = row('srs_card', 'live', false, NOW);

    expect(selectTombstonesToPrune([past, unstamped, live], NOW)).toEqual([
      past,
    ]);
  });

  it('keeps the rows of an unstamped item, except an old stamped tombstone among them', () => {
    const legacy = row('article', 'legacy', true, NOW);
    const oldTombstone = row('article_review', 'r1', true, 181 * DAY, 'legacy');
    const keptRows = [
      row('article_review', 'r2', true, STALE_AFTER_MS, 'legacy'),
      row('article_review', 'r3', false, 400 * DAY, 'legacy'),
      row('article_review', 'r4', true, NOW, 'legacy'),
      row('rebind', 'legacy', false, 400 * DAY, 'legacy'),
    ];

    expect(
      selectTombstonesToPrune([legacy, oldTombstone, ...keptRows], NOW)
    ).toEqual([oldTombstone]);
  });

  it('property: prunes an unstamped row only with its item, and a row of an unstamped item only on its own age', () => {
    fc.assert(
      fc.property(candidatesArb, (rows) => {
        const pruned = new Set(selectTombstonesToPrune(rows, NOW));
        for (const r of rows) {
          const item = itemOf(rows, r);
          if (r.updatedAt === 0) {
            expect(pruned.has(r)).toBe(item !== undefined && expired(item));
          }
          if (item?.updatedAt === 0) {
            expect(pruned.has(r)).toBe(
              r.deleted && r.updatedAt > 0 && NOW - r.updatedAt > STALE_AFTER_MS
            );
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  it('prunes an old tombstone of a review alone, keeping its live item', () => {
    const item = row('srs_card', 'c', false, 400 * DAY);
    const review = row('srs_card_review', 'r', true, 400 * DAY, 'c');

    expect(selectTombstonesToPrune([item, review], NOW)).toEqual([review]);
  });

  it('keeps a row of another table’s item of the same id, and a snippet made from a pruned item', () => {
    const card = row('srs_card', 'x', true, 400 * DAY);
    const articleReview = row('article_review', 'r', false, DAY, 'x');
    const snippetReview = row('snippet_review', 's', false, DAY, 'x');
    const madeFrom = row('snippet', 'child', false, DAY, 'x');
    const article = row('article', 'x', true, 400 * DAY);

    expect(
      selectTombstonesToPrune([card, articleReview, snippetReview], NOW)
    ).toEqual([card]);
    expect(selectTombstonesToPrune([article, madeFrom], NOW)).toEqual([
      article,
    ]);
  });

  it('property: leaves every tombstone 180 days old or younger, and every live row, unless its item goes', () => {
    fc.assert(
      fc.property(candidatesArb, (rows) => {
        const pruned = new Set(selectTombstonesToPrune(rows, NOW));
        for (const r of rows) {
          if (expired(r)) continue;
          const item = itemOf(rows, r);
          if (!item || !expired(item)) expect(pruned.has(r)).toBe(false);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('property: prunes every tombstone past 180 days, and no row outlives its item', () => {
    fc.assert(
      fc.property(candidatesArb, (rows) => {
        const pruned = new Set(selectTombstonesToPrune(rows, NOW));
        for (const r of rows) {
          if (expired(r)) expect(pruned.has(r)).toBe(true);
          const item = itemOf(rows, r);
          if (item && pruned.has(item)) expect(pruned.has(r)).toBe(true);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('property: keeps the order it was given', () => {
    fc.assert(
      fc.property(candidatesArb, (rows) => {
        const pruned = selectTombstonesToPrune(rows, NOW);
        expect(pruned).toEqual(rows.filter((r) => pruned.includes(r)));
      })
    );
  });

  it('measures the horizon with the classifier’s stale rule', () => {
    expect(pastSyncHorizon(NOW - STALE_AFTER_MS, NOW)).toBe(false);
    expect(pastSyncHorizon(NOW - STALE_AFTER_MS - 1, NOW)).toBe(true);
    expect(STALE_AFTER_MS).toBe(180 * DAY);
  });
});

describe('PRUNED_TABLES', () => {
  it('names every synced table once', () => {
    expect(PRUNED_TABLES.map((t) => t.table).sort()).toEqual(
      [...SYNCED_TABLES].sort()
    );
  });

  it('lists each table before the one its rows belong to, which its foreign key names', () => {
    const db = makeDb();
    const order = PRUNED_TABLES.map((t) => t.table);
    for (const { table, key, parent } of PRUNED_TABLES) {
      const keys = db
        .exec(`PRAGMA table_info(${table})`)[0]
        .values.filter((c) => Number(c[5]) > 0)
        .map((c) => c[1]);
      expect(keys).toEqual([key]);
      const foreign = (
        db.exec(`PRAGMA foreign_key_list(${table})`)[0]?.values ?? []
      ).map((fk) => [fk[2], fk[3]]);
      if (!parent) {
        expect(foreign).toEqual([]);
        continue;
      }
      expect(foreign).toEqual([[parent.table, parent.column]]);
      expect(order.indexOf(table)).toBeLessThan(order.indexOf(parent.table));
    }
    db.close();
  });
});

describe('pruneDatabase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A database holding a little of everything, old and new. */
  function populated(): Database {
    const db = makeDb();
    addArticle(db, 'gone', true, 181 * DAY);
    addArticleReview(db, 'gone-r', 'gone', false, DAY);
    addRebind(db, 'gone', DAY);
    addArticle(db, 'young', true, 179 * DAY);
    addArticleReview(db, 'young-r', 'young', true, 200 * DAY);
    addArticleReview(db, 'young-r2', 'young', false, 200 * DAY);
    addArticle(db, 'live', false, 400 * DAY);
    addSnippet(db, 'unstamped', true, NOW);
    addSnippetReview(db, 'unstamped-r', 'unstamped');
    addSnippet(db, 'made-from-gone', false, DAY, 'gone');
    addCard(db, 'card', true, 400 * DAY);
    addCardReview(db, 'card-r', 'card', DAY);
    addCard(db, 'card-live', false, 400 * DAY);
    stampDevice(db, 'away', STALE_AFTER_MS + 1);
    stampDevice(db, 'edge', STALE_AFTER_MS);
    stampDevice(db, 'here', 0);
    armRowStamps(db, STAMPS);
    return db;
  }

  it('deletes old tombstones with their items’ rows, and devices that have not saved since', () => {
    const db = populated();

    expect(pruneDatabase(db, NOW, STAMPS)).toEqual({ rows: 6, devices: 1 });

    expect(keysIn(db, 'article')).toEqual(['live', 'young']);
    expect(keysIn(db, 'article_review')).toEqual(['young-r2']);
    expect(keysIn(db, 'rebind')).toEqual([]);
    expect(keysIn(db, 'snippet')).toEqual(['made-from-gone', 'unstamped']);
    expect(keysIn(db, 'snippet_review')).toEqual(['unstamped-r']);
    expect(keysIn(db, 'srs_card')).toEqual(['card-live']);
    expect(keysIn(db, 'srs_card_review')).toEqual([]);
    expect(keysIn(db, 'write_stamp')).toEqual(['edge', 'here']);
    expect(tempTables(db)).toEqual([]);
    expect(() => db.exec('BEGIN; COMMIT;')).not.toThrow(); // none left open
    db.close();
  });

  it('reads as candidates the tombstones and every row of a tombstoned item, nothing else', () => {
    const db = populated();
    const keys = readPruneCandidates(db)
      .map((r) => `${r.table}/${r.key}`)
      .sort();
    expect(keys).toEqual(
      [
        'article/gone',
        'article/young',
        'article_review/gone-r',
        'article_review/young-r',
        'article_review/young-r2',
        'rebind/gone',
        'snippet/unstamped',
        'snippet_review/unstamped-r',
        'srs_card/card',
        'srs_card_review/card-r',
      ].sort()
    );
    expect(readPruneCandidates(db).find((r) => r.key === 'gone-r')).toEqual({
      table: 'article_review',
      key: 'gone-r',
      parent: 'gone',
      deleted: false,
      updatedAt: NOW - DAY,
    });
    expect(
      readPruneCandidates(db).find(
        (r) => r.table === 'article' && r.key === 'gone'
      )
    ).toEqual({
      table: 'article',
      key: 'gone',
      parent: null,
      deleted: true,
      updatedAt: NOW - 181 * DAY,
    });
    db.close();
  });

  it('refuses hard deletes and stamps writes again afterwards', () => {
    const db = populated();
    pruneDatabase(db, NOW, STAMPS);

    expect(() => db.run(`DELETE FROM article WHERE id = 'live'`)).toThrow();
    db.run(`UPDATE article SET priority = 40 WHERE id = 'live'`);
    expect(
      db.exec(`SELECT updated_at, updated_by FROM article WHERE id = 'live'`)[0]
        .values
    ).toEqual([[NOW, 'device-a']]);
    db.close();
  });

  it('reads and nothing more when nothing is due, even inside a transaction', () => {
    const db = makeDb();
    addArticle(db, 'young', true, DAY);
    stampDevice(db, 'here', 0);
    db.exec('BEGIN');

    expect(pruneDatabase(db, NOW, STAMPS)).toEqual({ rows: 0, devices: 0 });

    db.exec('COMMIT');
    expect(keysIn(db, 'article')).toEqual(['young']);
    db.close();
  });

  it('deletes an old tombstone when no device is due', () => {
    const db = makeDb();
    addArticle(db, 'gone', true, 400 * DAY);
    stampDevice(db, 'here', 0);

    expect(pruneDatabase(db, NOW, STAMPS)).toEqual({ rows: 1, devices: 0 });
    expect(keysIn(db, 'article')).toEqual([]);
    db.close();
  });

  it('drops an old device alone when no row is due', () => {
    const db = makeDb();
    stampDevice(db, 'away', 400 * DAY);
    stampDevice(db, 'here', STALE_AFTER_MS);

    expect(pruneDatabase(db, NOW, STAMPS)).toEqual({ rows: 0, devices: 1 });
    expect(keysIn(db, 'write_stamp')).toEqual(['here']);
    db.close();
  });

  it('deletes nothing from a copy whose newest save is past 180 days, or that has none', () => {
    const stale = makeDb();
    addArticle(stale, 'gone', true, 400 * DAY);
    stampDevice(stale, 'away', 400 * DAY);
    stampDevice(stale, 'here', STALE_AFTER_MS + 1);
    const unsaved = makeDb();
    addArticle(unsaved, 'gone', true, 400 * DAY);

    for (const db of [stale, unsaved]) {
      expect(pruneDatabase(db, NOW, STAMPS)).toEqual({ rows: 0, devices: 0 });
      expect(keysIn(db, 'article')).toEqual(['gone']);
    }
    expect(keysIn(stale, 'write_stamp')).toEqual(['away', 'here']);
    stale.close();
    unsaved.close();
  });

  it('deletes nothing when a statement fails, and still refuses hard deletes after', () => {
    const db = populated();
    // The rows are deleted by then; dropping the devices fails
    db.exec(`CREATE TEMP TRIGGER fail BEFORE DELETE ON main.write_stamp
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);

    expect(() => pruneDatabase(db, NOW, STAMPS)).toThrow('disk I/O error');

    expect(() => db.exec('BEGIN; COMMIT;')).not.toThrow(); // none left open
    expect(keysIn(db, 'article')).toEqual(['gone', 'live', 'young']);
    expect(keysIn(db, 'article_review')).toEqual([
      'gone-r',
      'young-r',
      'young-r2',
    ]);
    expect(keysIn(db, 'write_stamp')).toEqual(['away', 'edge', 'here']);
    expect(() => db.run(`DELETE FROM article WHERE id = 'live'`)).toThrow();
    db.close();
  });
});
