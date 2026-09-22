import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App, CachedMetadata, TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  type Holder,
  ITEM_TABLES,
  type ItemLocation,
  type ItemTable,
  type Move,
  type NoteAt,
  PAGE_SIZE,
  type RelocationPlan,
  type Skip,
  dropConflicts,
  evictedSpot,
  isStranded,
  resolveMoves,
  scanForMovedNotes,
} from './moved-note-scan';

// #region HELPERS

/** An item row as the database holds it; the scan only reads live ones. */
interface StoredRow extends ItemLocation {
  deleted: boolean;
}

const SCHEMA = readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8');
const FIXED_DUE = 1_700_000_000_000;

let SQL: SqlJsStatic;

/** A repository over a real in-memory database, with the vault write stubbed. */
class TestRepository extends SQLJSRepository {
  static create(): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    repo.registerUpdateHook();
    return repo;
  }

  protected override async save() {}

  /**
   * The real transaction, still reachable once a spy has taken over the
   * instance's own `transaction`: `super` resolves past it on the prototype.
   */
  openTransaction<T>(work: () => T | Promise<T>): Promise<T> {
    return super.transaction(work);
  }
}

function insertItem(repo: TestRepository, row: StoredRow) {
  if (row.table === 'srs_card') {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, deleted, created_at, due, stability,
         difficulty, elapsed_days, scheduled_days, reps, lapses, state)
       VALUES ($1, $2, $3, $4, $4, 0, 0, 0, 0, 0, 0, 0)`,
      [row.id, row.reference, row.deleted, FIXED_DUE]
    );
    return;
  }
  repo.mutate(
    `INSERT INTO ${row.table} (id, reference, deleted, due, interval, priority)
     VALUES ($1, $2, $3, $4, 86400000, 30)`,
    [row.id, row.reference, row.deleted, FIXED_DUE]
  );
}

/** Every item row, read straight off the database so no spy counts it. */
function readLocations(repo: TestRepository): StoredRow[] {
  return ITEM_TABLES.flatMap((table) => {
    const [result] = repo.db?.exec(
      `SELECT id, reference, deleted FROM ${table} ORDER BY id`
    ) ?? [undefined];
    return (result?.values ?? []).map(([id, reference, deleted]) => ({
      table,
      id: String(id),
      reference: String(reference),
      deleted: deleted === 1,
    }));
  });
}

interface FakeNote {
  path: string;
  frontmatter?: Record<string, unknown>;
  /** False while Obsidian has yet to (re)index the note, as after a move. */
  indexed?: boolean;
}

/** The slice of vault and metadata cache the scan reads, over mutable notes. */
function makeVault(initial: FakeNote[]) {
  const notes = new Map(initial.map((note) => [note.path, note]));
  const files = new Map<string, TFile>();
  const fileAt = (path: string) => {
    const file = files.get(path) ?? ({ path } as TFile);
    files.set(path, file);
    return file;
  };
  return {
    notes,
    vault: {
      getFileByPath: vi.fn((path: string) =>
        notes.has(path) ? fileAt(path) : null
      ),
      getMarkdownFiles: vi.fn(() => [...notes.keys()].map(fileAt)),
    },
    metadataCache: {
      getFileCache: vi.fn((file: TFile): CachedMetadata | null => {
        const note = notes.get(file.path);
        if (!note || note.indexed === false) return null;
        return { frontmatter: note.frontmatter } as CachedMetadata;
      }),
    },
    move(from: string, to: string) {
      const note = notes.get(from);
      if (!note) return;
      notes.delete(from);
      notes.set(to, { ...note, path: to });
    },
  };
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const tableArb = fc.constantFrom(...ITEM_TABLES);

/** Anything can end up in `reference`; nothing about the scan relies on its shape. */
const pathArb = fc.string({ minLength: 1, maxLength: 12 });

const rowArb: fc.Arbitrary<StoredRow> = fc.record({
  table: tableArb,
  id: fc.uuid(),
  reference: pathArb,
  deleted: fc.boolean(),
});

const sameRow = (a: { table: string; id: string }) => (b: typeof a) =>
  a.table === b.table && a.id === b.id;

/**
 * Rows as the three item tables can hold them: ids are UUIDs, so unique across
 * tables, and `reference` is `UNIQUE` within each table — though nothing stops
 * two tables naming the same path.
 */
const rowsArb = fc
  .uniqueArray(rowArb, { selector: (row) => row.id, maxLength: 12 })
  .filter(
    (rows) =>
      new Set(rows.map((row) => `${row.table}\0${row.reference}`)).size ===
      rows.length
  );

/** Rows whose references are unique across all tables, as a healthy vault has them. */
const distinctRowsArb = rowsArb.filter(
  (rows) => new Set(rows.map((row) => row.reference)).size === rows.length
);

type NoteState =
  | { kind: 'home' }
  | { kind: 'untagged' }
  | { kind: 'gone' }
  | { kind: 'foreign'; irId: string };

/** What each row's reference holds now, against rows with distinct references. */
const noteStatesArb = distinctRowsArb.chain((rows) =>
  fc.tuple(
    fc.constant(rows),
    fc.tuple(
      ...rows.map((row) =>
        fc.oneof(
          fc.constant<NoteState>({ kind: 'home' }),
          fc.constant<NoteState>({ kind: 'untagged' }),
          fc.constant<NoteState>({ kind: 'gone' }),
          fc
            .string()
            .filter((irId) => irId !== row.id)
            .map((irId): NoteState => ({ kind: 'foreign', irId }))
        )
      )
    )
  )
);

function noteAtFor(rows: ItemLocation[], states: NoteState[]): NoteAt {
  const notes = new Map<string, { irId: string | undefined }>();
  rows.forEach((row, i) => {
    const state = states[i];
    if (state.kind === 'home') notes.set(row.reference, { irId: row.id });
    if (state.kind === 'untagged')
      notes.set(row.reference, { irId: undefined });
    if (state.kind === 'foreign')
      notes.set(row.reference, { irId: state.irId });
  });
  return (path) => notes.get(path) ?? null;
}

/**
 * A database snapshot, some of its rows judged stranded, and an index of where
 * notes carrying those rows' ids sit. Index paths favour existing references so
 * that swaps, chains, and collisions with rows that stay put come up often.
 * Each path appears once: a note carries one `ir-id`.
 */
const planInputArb = rowsArb.chain((rows) => {
  const references = rows.map((row) => row.reference);
  const ids = rows.map((row) => row.id);
  const indexPathArb =
    references.length > 0
      ? fc.oneof(fc.constantFrom(...references), pathArb)
      : pathArb;
  const indexIdArb =
    ids.length > 0 ? fc.oneof(fc.constantFrom(...ids), fc.uuid()) : fc.uuid();
  return fc.record({
    rows: fc.constant(rows),
    stranded: fc.subarray(rows),
    index: fc.uniqueArray(fc.tuple(indexPathArb, indexIdArb), {
      selector: ([path]) => path,
      maxLength: 16,
    }),
  });
});

function groupIndex(index: [string, string][]) {
  const pathsById = new Map<string, string[]>();
  for (const [path, id] of index) {
    pathsById.set(id, [...(pathsById.get(id) ?? []), path]);
  }
  return pathsById;
}

/** Rows as they would read once the whole plan — moves and evictions — was written. */
function applyPlan<T extends ItemLocation>(
  rows: T[],
  plan: RelocationPlan
): T[] {
  return rows.map((row) => {
    const move = plan.relocations.find(sameRow(row));
    if (move) return { ...row, reference: move.to };
    const gone = plan.evicted.find(sameRow(row));
    return gone ? { ...row, reference: evictedSpot(gone) } : row;
  });
}

/** What became of an item's note since the database last heard of it. */
const FATES = [
  'home',
  'untagged',
  'unindexed',
  'gone',
  'moved',
  'movedUnindexed',
  'replaced',
] as const;
type Fate = (typeof FATES)[number];

/** Fates that leave nothing of the item's own at its reference. */
const STRANDING_FATES: readonly Fate[] = [
  'gone',
  'moved',
  'movedUnindexed',
  'replaced',
];

/** Fates the scan can follow: one indexed note carrying the id, elsewhere. */
const FOLLOWABLE_FATES: readonly Fate[] = ['moved', 'replaced'];

interface ScanWorld {
  rows: StoredRow[];
  fates: Fate[];
  targets: string[];
  notes: FakeNote[];
  pageSize: number;
}

/**
 * A database and a vault that has moved on from it. Every path is distinct, so
 * each row's fate plays out alone; unrelated notes carry no id or one no row
 * has.
 */
const scanWorldArb: fc.Arbitrary<ScanWorld> = fc
  .integer({ min: 0, max: 8 })
  .chain((n) =>
    fc.record({
      paths: fc.uniqueArray(pathArb, {
        minLength: 2 * n + 3,
        maxLength: 2 * n + 3,
      }),
      ids: fc.uniqueArray(fc.uuid(), { minLength: n, maxLength: n }),
      tables: fc.array(tableArb, { minLength: n, maxLength: n }),
      deleted: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
      fates: fc.array(fc.constantFrom(...FATES), {
        minLength: n,
        maxLength: n,
      }),
      strays: fc.array(fc.option(fc.string(), { nil: undefined }), {
        maxLength: 3,
      }),
      pageSize: fc.integer({ min: 1, max: 4 }),
    })
  )
  .map(({ paths, ids, tables, deleted, fates, strays, pageSize }) => {
    const n = ids.length;
    const rows = ids.map((id, i) => ({
      table: tables[i],
      id,
      reference: paths[i],
      deleted: deleted[i],
    }));
    const targets = paths.slice(n, 2 * n);
    const notes: FakeNote[] = [];
    rows.forEach((row, i) => {
      const own = { 'ir-id': row.id };
      const at = row.reference;
      const to = targets[i];
      switch (fates[i]) {
        case 'home':
          notes.push({ path: at, frontmatter: own });
          break;
        case 'untagged':
          notes.push({ path: at, frontmatter: {} });
          break;
        case 'unindexed':
          notes.push({ path: at, frontmatter: own, indexed: false });
          break;
        case 'gone':
          break;
        case 'moved':
          notes.push({ path: to, frontmatter: own });
          break;
        case 'movedUnindexed':
          notes.push({ path: to, frontmatter: own, indexed: false });
          break;
        case 'replaced':
          notes.push({ path: at, frontmatter: { 'ir-id': `${row.id}-new` } });
          notes.push({ path: to, frontmatter: own });
          break;
      }
    });
    strays.forEach((irId, i) => {
      const path = paths[2 * n + i];
      const foreign = irId !== undefined && !ids.includes(irId);
      notes.push({
        path,
        frontmatter: foreign ? { 'ir-id': irId } : undefined,
      });
    });
    return { rows, fates, targets, notes, pageSize };
  });

/** A scan over `world`, with every collaborator counted. */
function wire(world: ScanWorld, onYield?: (count: number) => void) {
  const repo = TestRepository.create();
  for (const row of world.rows) insertItem(repo, row);
  const fake = makeVault(world.notes);
  const controller = new AbortController();
  const yieldSpy = vi.fn(async () => {
    onYield?.(yieldSpy.mock.calls.length);
  });
  const query = vi.spyOn(repo, 'query');
  const transaction = vi.spyOn(repo, 'transaction');
  const work = () =>
    query.mock.calls.length +
    transaction.mock.calls.length +
    fake.vault.getFileByPath.mock.calls.length +
    fake.vault.getMarkdownFiles.mock.calls.length +
    fake.metadataCache.getFileCache.mock.calls.length;
  return {
    ...fake,
    repo,
    controller,
    yieldSpy,
    query,
    transaction,
    work,
    deps: {
      repo,
      vault: fake.vault,
      metadataCache: fake.metadataCache,
      yieldToHost: yieldSpy,
      signal: controller.signal,
      pageSize: world.pageSize,
      // One tick a clock reading, so the budget counts checked work rather
      // than elapsed time and a run is reproducible
      sliceMs: world.pageSize,
      now: fakeClock(),
    },
  };
}

/**
 * Run `sql` in the window the write guard covers: after the scan has read which
 * rows hold its targets, before its transaction opens. The only moment a live
 * handler can take a path the plan was already made against.
 */
function raceTheWrite(run: ReturnType<typeof wire>, sql: string) {
  run.transaction.mockImplementationOnce(
    <T>(work: () => T | Promise<T>): Promise<T> => {
      run.repo.mutate(sql);
      return run.repo.openTransaction(work);
    }
  );
}

const article = (id: string, reference: string): StoredRow => ({
  table: 'article',
  id,
  reference,
  deleted: false,
});

/** A clock that advances one tick a reading, so a slice is a count of work. */
const fakeClock = () => {
  let tick = 0;
  return () => tick++;
};

/** The rows naming each path, as {@link dropConflicts} is handed them. */
function holdersOf(rows: readonly StoredRow[]): Map<string, Holder[]> {
  const holders = new Map<string, Holder[]>();
  for (const { table, id, reference, deleted } of rows) {
    holders.set(reference, [
      ...(holders.get(reference) ?? []),
      { table, id, deleted },
    ]);
  }
  return holders;
}

/**
 * The blocking rule stated the slow way, as the plain reading of it: drop every
 * move blocked right now, then look again, until a pass finds none. A move is
 * blocked while a live row that is not moving holds its target, or while another
 * standing move wants that same path. Whatever survives then evicts the
 * tombstones left standing where it lands.
 */
function settleByRounds(
  moves: readonly Move[],
  holders: ReadonlyMap<string, readonly Holder[]>
): RelocationPlan {
  const keyOf = (row: { table: string; id: string }) =>
    `${row.table}\0${row.id}`;
  const skipped: Skip[] = [];
  let kept = [...moves];
  for (;;) {
    const moving = new Set(kept.map(({ row }) => keyOf(row)));
    const blocked = kept.filter(
      (move) =>
        (holders.get(move.to) ?? []).some(
          (holder) => !holder.deleted && !moving.has(keyOf(holder))
        ) || kept.some((other) => other !== move && other.to === move.to)
    );
    if (blocked.length === 0) break;

    for (const { row } of blocked) skipped.push({ row, reason: 'conflict' });
    kept = kept.filter((move) => !blocked.includes(move));
  }

  const leaving = new Set(kept.map(({ row }) => keyOf(row)));
  const evicted = new Map<string, ItemLocation>();
  for (const move of kept) {
    for (const holder of holders.get(move.to) ?? []) {
      if (!holder.deleted || leaving.has(keyOf(holder))) continue;
      evicted.set(keyOf(holder), {
        table: holder.table,
        id: holder.id,
        reference: move.to,
      });
    }
  }
  return {
    relocations: kept.map(({ row, to }) => ({
      table: row.table,
      id: row.id,
      from: row.reference,
      to,
    })),
    skipped,
    evicted: [...evicted.values()],
  };
}

/**
 * Rows and the moves over them, drawn from a pool small enough that swaps,
 * chains, two moves onto one path, and rows that stay put all come up. The last
 * path is never a row's, so some moves are onto free ground; a row can be named
 * by more than one move, which no caller does, but the rule still settles it.
 */
const conflictWorldArb = fc
  .tuple(
    fc.uniqueArray(pathArb, { minLength: 2, maxLength: 6 }),
    fc.array(fc.tuple(tableArb, fc.nat(), fc.boolean()), { maxLength: 8 }),
    fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 8 })
  )
  .map(([paths, rowSpecs, moveSpecs]) => {
    const held = paths.slice(0, -1);
    const rows: StoredRow[] = [];
    const taken = new Set<string>();
    rowSpecs.forEach(([table, pick, deleted], i) => {
      const reference = held[pick % held.length];
      // `reference` is UNIQUE within each table
      if (taken.has(`${table}\0${reference}`)) return;
      taken.add(`${table}\0${reference}`);
      rows.push({ table, id: `row-${i}`, reference, deleted });
    });
    const moves: Move[] =
      rows.length === 0
        ? []
        : moveSpecs.map(([rowPick, pathPick]) => ({
            row: rows[rowPick % rows.length],
            to: paths[pathPick % paths.length],
          }));
    return { rows, moves };
  });

/** The same worlds, with the one move per row that a caller ever produces. */
const onePerRowArb = conflictWorldArb.map(({ rows, moves }) => ({
  rows,
  moves: moves.filter(
    (move, i) => moves.findIndex((other) => other.row === move.row) === i
  ),
}));

/**
 * A chain of `length` moves, each onto the path the one behind it would vacate,
 * ending on a path a row keeps: every move falls, one round apiece.
 */
function blockingChain(length: number) {
  const keeper = article('keeper', 'path-0');
  const rows = Array.from({ length }, (_, i) =>
    article(`row-${i + 1}`, `path-${i + 1}`)
  );
  const moves = rows.map((row, i) => ({ row, to: `path-${i}` }));
  return { rows: [keeper, ...rows], moves };
}

/**
 * A budget of one tick, so that every check spends it and the scan hands the
 * thread back at each step — the only way a test gets to act mid-scan.
 */
const EVERY_STEP = 1;

/** A world spelled out by hand, for the scenarios the generator can't stage. */
function handWorld(
  rows: StoredRow[],
  notes: FakeNote[],
  pageSize = PAGE_SIZE
): ScanWorld {
  return { rows, fates: [], targets: [], notes, pageSize };
}

/**
 * The real {@link SQLJSRepository.transaction}, reached past the spy {@link wire}
 * puts over it, so a test can act in the moment before the scan's write lands.
 */
const commitOn =
  (repo: TestRepository) =>
  <T>(work: () => T | Promise<T>): Promise<T> =>
    SQLJSRepository.prototype.transaction.call(repo, work) as Promise<T>;

/**
 * A deleted row: its note is gone, but the row is kept for its review history
 * and goes on naming — and so holding — the path the note was at.
 */
const tombstone = (
  table: ItemTable,
  id: string,
  reference: string
): StoredRow => ({ table, id, reference, deleted: true });

/**
 * A live article whose note moved onto a path a tombstone in its own table is
 * still named at: the one shape `reference TEXT NOT NULL UNIQUE` cannot hold.
 */
const stepOverWorld = () =>
  handWorld(
    [article('a', 'one.md'), tombstone('article', 'gone', 'two.md')],
    [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }]
  );

// #endregion

describe('isStranded', () => {
  it('flags exactly the rows whose reference no longer holds their own note', () => {
    fc.assert(
      fc.property(noteStatesArb, ([rows, states]) => {
        const noteAt = noteAtFor(rows, states);

        rows.forEach((row, i) => {
          const gone =
            states[i].kind === 'gone' || states[i].kind === 'foreign';
          expect(isStranded(row, noteAt)).toBe(gone);
        });
      })
    );
  });
});

describe('resolveMoves', () => {
  it('moves a stranded row only onto the single other path its note is indexed at', () => {
    fc.assert(
      fc.property(planInputArb, ({ stranded, index }) => {
        const pathsById = groupIndex(index);

        const { moves } = resolveMoves(stranded, pathsById);

        for (const move of moves) {
          expect(stranded).toContain(move.row);
          expect(pathsById.get(move.row.id)).toEqual([move.to]);
          expect(move.to).not.toBe(move.row.reference);
        }
      })
    );
  });

  it('accounts for each stranded row once, by how many other paths hold its note', () => {
    fc.assert(
      fc.property(planInputArb, ({ stranded, index }) => {
        const pathsById = groupIndex(index);

        const { moves, skipped } = resolveMoves(stranded, pathsById);

        for (const row of stranded) {
          const paths = pathsById.get(row.id) ?? [];
          const mine = moves.filter((move) => sameRow(row)(move.row));
          const skips = skipped.filter((skip) => sameRow(skip.row)(row));

          if (paths.includes(row.reference)) {
            // The index found the note back home after all: nothing to do
            expect(mine).toHaveLength(0);
            expect(skips).toHaveLength(0);
          } else if (paths.length === 0) {
            expect(mine).toHaveLength(0);
            expect(skips).toEqual([{ row, reason: 'missing' }]);
          } else if (paths.length > 1) {
            expect(mine).toHaveLength(0);
            expect(skips).toEqual([{ row, reason: 'ambiguous' }]);
          } else {
            expect(skips).toHaveLength(0);
            expect(mine).toEqual([{ row, to: paths[0] }]);
          }
        }
        expect(moves.length + skipped.length).toBeLessThanOrEqual(
          stranded.length
        );
      })
    );
  });
});

describe('dropConflicts', () => {
  /** Moves as `scanForMovedNotes` hands them over, against the rows they run into. */
  const conflictInputArb = planInputArb.map(({ rows, stranded, index }) => ({
    rows,
    moves: resolveMoves(stranded, groupIndex(index)).moves,
  }));

  it('never leaves a relocated path shared with another row', () => {
    fc.assert(
      fc.property(conflictInputArb, ({ rows, moves }) => {
        const plan = dropConflicts(moves, holdersOf(rows));

        const after = applyPlan(rows, plan);
        for (const { to } of plan.relocations) {
          expect(after.filter((row) => row.reference === to)).toHaveLength(1);
        }
      })
    );
  });

  it('accounts for every move, giving up only while a live row keeps its target', () => {
    fc.assert(
      fc.property(conflictInputArb, ({ rows, moves }) => {
        const plan = dropConflicts(moves, holdersOf(rows));
        const { relocations, skipped } = plan;

        expect(relocations.length + skipped.length).toBe(moves.length);
        const after = applyPlan(rows, plan);
        for (const { row, reason } of skipped) {
          expect(reason).toBe('conflict');
          const target = moves.find((move) => sameRow(row)(move.row))?.to;
          // A tombstone is never the reason: it steps aside instead
          const keepers = after.filter(
            (other) =>
              !sameRow(row)(other) &&
              !other.deleted &&
              other.reference === target
          );
          expect(keepers.length).toBeGreaterThan(0);
        }
      })
    );
  });

  it('evicts exactly the tombstones left standing where a move lands', () => {
    fc.assert(
      fc.property(conflictInputArb, ({ rows, moves }) => {
        const plan = dropConflicts(moves, holdersOf(rows));
        const landed = new Set(plan.relocations.map(({ to }) => to));

        const expected = rows
          .filter(
            (row) =>
              row.deleted &&
              landed.has(row.reference) &&
              !plan.relocations.some(sameRow(row))
          )
          .map(({ table, id, reference }) => ({ table, id, reference }));
        const byRow = (a: ItemLocation, b: ItemLocation) =>
          `${a.table}\0${a.id}` < `${b.table}\0${b.id}` ? -1 : 1;
        expect([...plan.evicted].sort(byRow)).toEqual(expected.sort(byRow));
      })
    );
  });

  it('parks each evicted tombstone somewhere no note and no other row can be', () => {
    fc.assert(
      fc.property(conflictInputArb, ({ rows, moves }) => {
        const plan = dropConflicts(moves, holdersOf(rows));

        const targets = plan.relocations.map(({ to }) => to);
        for (const gone of plan.evicted) {
          const spot = evictedSpot(gone);
          // Vault paths are relative, so a leading slash is unreachable
          expect(spot.startsWith('/')).toBe(true);
          // and it names the row, so two tombstones never share a spot
          expect(spot).toContain(gone.id);
          expect(spot).not.toBe(gone.reference);
          expect(targets).not.toContain(spot);
        }
      })
    );
  });

  it('swaps two notes that traded places', () => {
    const a = article('a', 'one.md');
    const b: StoredRow = {
      table: 'snippet',
      id: 'b',
      reference: 'two.md',
      deleted: false,
    };

    const { relocations, skipped } = dropConflicts(
      [
        { row: a, to: 'two.md' },
        { row: b, to: 'one.md' },
      ],
      holdersOf([a, b])
    );

    expect(skipped).toEqual([]);
    expect(relocations).toEqual([
      { table: 'article', id: 'a', from: 'one.md', to: 'two.md' },
      { table: 'snippet', id: 'b', from: 'two.md', to: 'one.md' },
    ]);
  });

  it('holds back a chain of moves that ends on a path a live row keeps', () => {
    // A live row: its own note is there, so the path is not the mover's to take
    const keeper: StoredRow = {
      table: 'srs_card',
      id: 'keeper',
      reference: 'kept.md',
      deleted: false,
    };
    const first = article('first', 'first.md');
    const second = article('second', 'second.md');

    const { relocations, skipped, evicted } = dropConflicts(
      [
        { row: first, to: 'kept.md' },
        { row: second, to: 'first.md' },
      ],
      holdersOf([keeper, first, second])
    );

    expect(relocations).toEqual([]);
    expect(evicted).toEqual([]);
    expect(skipped).toEqual([
      { row: first, reason: 'conflict' },
      { row: second, reason: 'conflict' },
    ]);
  });

  it('lets that same chain through when a tombstone is all that holds the end', () => {
    // A deleted row keeps its reference, but has no note there to lose and is
    // restored by id, so it gives the path up rather than blocking forever
    const keeper: StoredRow = {
      table: 'srs_card',
      id: 'keeper',
      reference: 'kept.md',
      deleted: true,
    };
    const first = article('first', 'first.md');
    const second = article('second', 'second.md');

    const { relocations, skipped, evicted } = dropConflicts(
      [
        { row: first, to: 'kept.md' },
        { row: second, to: 'first.md' },
      ],
      holdersOf([keeper, first, second])
    );

    expect(skipped).toEqual([]);
    expect(relocations).toEqual([
      { table: 'article', id: 'first', from: 'first.md', to: 'kept.md' },
      { table: 'article', id: 'second', from: 'second.md', to: 'first.md' },
    ]);
    expect(evicted).toEqual([
      { table: 'srs_card', id: 'keeper', reference: 'kept.md' },
    ]);
  });

  it('still holds back a move onto a path a tombstone and a live row both name', () => {
    const tombstone: StoredRow = {
      table: 'srs_card',
      id: 'tombstone',
      reference: 'kept.md',
      deleted: true,
    };
    // `reference` is UNIQUE per table, so a second row can name the same path
    const keeper: StoredRow = {
      table: 'snippet',
      id: 'keeper',
      reference: 'kept.md',
      deleted: false,
    };
    const mover = article('mover', 'mover.md');

    const { relocations, skipped, evicted } = dropConflicts(
      [{ row: mover, to: 'kept.md' }],
      holdersOf([tombstone, keeper, mover])
    );

    expect(relocations).toEqual([]);
    // Nothing moved, so the tombstone is left holding its path
    expect(evicted).toEqual([]);
    expect(skipped).toEqual([{ row: mover, reason: 'conflict' }]);
  });

  it('holds back both moves onto one path, and the moves waiting behind them', () => {
    const first = article('first', 'first.md');
    const second = article('second', 'second.md');
    const third = article('third', 'third.md');

    const { relocations, skipped } = dropConflicts(
      [
        { row: first, to: 'shared.md' },
        { row: second, to: 'shared.md' },
        { row: third, to: 'first.md' },
      ],
      // Nothing holds `shared.md`: the two moves collide with each other alone
      holdersOf([first, second, third])
    );

    expect(relocations).toEqual([]);
    expect(skipped).toEqual([
      { row: first, reason: 'conflict' },
      { row: second, reason: 'conflict' },
      { row: third, reason: 'conflict' },
    ]);
  });

  it('settles every move as dropping all the blocked ones and looking again would', () => {
    fc.assert(
      fc.property(conflictWorldArb, ({ rows, moves }) => {
        const holders = holdersOf(rows);

        expect(dropConflicts(moves, holders)).toEqual(
          settleByRounds(moves, holders)
        );
      })
    );
  });

  it('never lands two rows on one path, whatever the moves ask for', () => {
    fc.assert(
      fc.property(onePerRowArb, ({ rows, moves }) => {
        const plan = dropConflicts(moves, holdersOf(rows));
        const { relocations, skipped } = plan;

        expect(relocations.length + skipped.length).toBe(moves.length);
        const after = applyPlan(rows, plan);
        for (const { to } of relocations) {
          expect(after.filter((row) => row.reference === to)).toHaveLength(1);
        }
      })
    );
  });

  it('settles a chain of thousands of moves in well under a second', () => {
    // Settling by rounds spends a pass over every standing move per drop, which
    // is tens of seconds at this length; a worklist is milliseconds
    const BUDGET_MS = 500;
    const { rows, moves } = blockingChain(3000);
    const holders = holdersOf(rows);

    const started = performance.now();
    const { relocations, skipped } = dropConflicts(moves, holders);
    const elapsed = performance.now() - started;

    expect(relocations).toEqual([]);
    // One drop a round, so the chain falls in the order it was handed over
    expect(skipped).toEqual(
      moves.map(({ row }) => ({ row, reason: 'conflict' }))
    );
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});

describe('scanForMovedNotes', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('points each live row at the one indexed note carrying its id, and nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(scanWorldArb, async (world) => {
        const run = wire(world);

        const moved = await scanForMovedNotes(run.deps);

        const follows = (i: number) =>
          !world.rows[i].deleted && FOLLOWABLE_FATES.includes(world.fates[i]);
        const expected = world.rows.map((row, i) =>
          follows(i) ? { ...row, reference: world.targets[i] } : row
        );
        expect(readLocations(run.repo).sort(byId)).toEqual(expected.sort(byId));
        expect(moved.sort(byId)).toEqual(
          world.rows
            .flatMap((row, i) =>
              follows(i)
                ? [
                    {
                      table: row.table,
                      id: row.id,
                      from: row.reference,
                      to: world.targets[i],
                    },
                  ]
                : []
            )
            .sort(byId)
        );
      })
    );
  });

  it('only searches the vault when a row is stranded, and only writes when one can move', async () => {
    await fc.assert(
      fc.asyncProperty(scanWorldArb, async (world) => {
        const run = wire(world);
        const live = world.rows.map((row) => !row.deleted);
        const stranded = world.fates.some(
          (fate, i) => live[i] && STRANDING_FATES.includes(fate)
        );
        const followable = world.fates.some(
          (fate, i) => live[i] && FOLLOWABLE_FATES.includes(fate)
        );

        await scanForMovedNotes(run.deps);

        expect(run.vault.getMarkdownFiles).toHaveBeenCalledTimes(
          stranded ? 1 : 0
        );
        expect(run.transaction).toHaveBeenCalledTimes(followable ? 1 : 0);
      })
    );
  });

  it('hands the thread back at least every slice of work', async () => {
    await fc.assert(
      fc.asyncProperty(scanWorldArb, async (world) => {
        const segments: { lookups: number; caches: number }[] = [];
        let lookups = 0;
        let caches = 0;
        const cut = () => {
          const { getFileByPath } = run.vault;
          const { getFileCache } = run.metadataCache;
          segments.push({
            lookups: getFileByPath.mock.calls.length - lookups,
            caches: getFileCache.mock.calls.length - caches,
          });
          lookups = getFileByPath.mock.calls.length;
          caches = getFileCache.mock.calls.length;
        };
        const run = wire(world, cut);

        await scanForMovedNotes(run.deps);
        cut();

        const pages = run.query.mock.results.filter((_, i) =>
          String(run.query.mock.calls[i][0]).includes('rowid >')
        );
        for (const page of pages) {
          expect((page.value as unknown[]).length).toBeLessThanOrEqual(
            world.pageSize
          );
        }
        const strandedIds = new Set(
          world.rows
            .filter(
              (row, i) =>
                !row.deleted && STRANDING_FATES.includes(world.fates[i])
            )
            .map((row) => row.id)
        );
        const indexed = world.notes.filter(
          (note) =>
            note.indexed !== false &&
            strandedIds.has(String(note.frontmatter?.['ir-id']))
        ).length;
        // The last stretch also re-checks the notes about to be written, which
        // must not be separated from the write by a yield
        const last = segments.pop();
        const finalBudget = world.pageSize + indexed;
        expect(last?.lookups).toBeLessThanOrEqual(finalBudget);
        expect(last?.caches).toBeLessThanOrEqual(finalBudget);
        for (const segment of segments) {
          expect(segment.lookups).toBeLessThanOrEqual(world.pageSize);
          expect(segment.caches).toBeLessThanOrEqual(world.pageSize);
        }
      })
    );
  });

  it('only yields when there is more work to come', async () => {
    await fc.assert(
      fc.asyncProperty(scanWorldArb, async (world) => {
        const workAtYield: number[] = [];
        const run: ReturnType<typeof wire> = wire(world, () => {
          workAtYield.push(run.work());
        });

        await scanForMovedNotes(run.deps);

        // Each idle wait must be followed by something before the next, or the
        // end: a yield with nothing after it stalls the scan for no reason
        const marks = [...workAtYield, run.work()];
        for (let i = 1; i < marks.length; i++) {
          expect(marks[i]).toBeGreaterThan(marks[i - 1]);
        }
      })
    );
  });

  it('stops working, and writes nothing, from the moment it is aborted', async () => {
    await fc.assert(
      fc.asyncProperty(scanWorldArb, fc.nat(), async (world, seed) => {
        const probe = wire(world);
        await scanForMovedNotes(probe.deps);
        // A run too short to spend a slice never yields, so it never aborts
        fc.pre(probe.yieldSpy.mock.calls.length > 0);
        const abortAt = 1 + (seed % probe.yieldSpy.mock.calls.length);

        let workAtAbort = -1;
        const run: ReturnType<typeof wire> = wire(world, (count) => {
          if (count !== abortAt) return;
          run.controller.abort();
          workAtAbort = run.work();
        });
        const before = readLocations(run.repo);

        const moved = await scanForMovedNotes(run.deps);

        expect(moved).toEqual([]);
        expect(run.work()).toBe(workAtAbort);
        expect(readLocations(run.repo)).toEqual(before);
      })
    );
  });

  it('runs without a signal', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md')],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }]
      )
    );

    const moved = await scanForMovedNotes({ ...run.deps, signal: undefined });

    expect(moved).toEqual([
      { table: 'article', id: 'a', from: 'one.md', to: 'two.md' },
    ]);
  });

  it('pages through more rows than fit in one page', async () => {
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) =>
      article(`id-${String(i).padStart(4, '0')}`, `note-${i}.md`)
    );
    // The rows either side of the page break moved: reading the first twice
    // would move it twice, and stopping at the break would miss the second
    const boundary = PAGE_SIZE - 1;
    const last = PAGE_SIZE;
    const notes = rows.map((row, i) => ({
      path: i === boundary || i === last ? `moved-${i}.md` : row.reference,
      frontmatter: { 'ir-id': row.id },
    }));
    const run = wire(handWorld(rows, notes));
    const defaults = { ...run.deps, pageSize: undefined };

    const moved = await scanForMovedNotes(defaults);

    expect(moved).toEqual(
      [boundary, last].map((i) => ({
        table: 'article',
        id: rows[i].id,
        from: rows[i].reference,
        to: `moved-${i}.md`,
      }))
    );
  });

  it('trades back two notes that swapped places, despite reference being UNIQUE', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md'), article('b', 'two.md')],
        [
          { path: 'one.md', frontmatter: { 'ir-id': 'b' } },
          { path: 'two.md', frontmatter: { 'ir-id': 'a' } },
        ]
      )
    );

    await scanForMovedNotes(run.deps);

    expect(readLocations(run.repo).map((row) => row.reference)).toEqual([
      'two.md',
      'one.md',
    ]);
  });

  it('reads an ir-id that is not a string as no ir-id at all', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md'), article('b', 'two.md')],
        [
          // Not a's note, but not provably anyone else's either
          { path: 'one.md', frontmatter: { 'ir-id': ['c'] } },
          { path: 'one-copy.md', frontmatter: { 'ir-id': 'a' } },
          { path: 'three.md', frontmatter: { 'ir-id': ['b'] } },
        ]
      )
    );

    const moved = await scanForMovedNotes(run.deps);

    expect(moved).toEqual([]);
    expect(readLocations(run.repo).map((row) => row.reference)).toEqual([
      'one.md',
      'two.md',
    ]);
  });

  it('leaves a note that moves again before the write to the live handlers', async () => {
    let fired = false;
    const run: ReturnType<typeof wire> = wire(
      handWorld(
        [article('a', 'one.md')],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }],
        EVERY_STEP
      ),
      () => {
        const indexed = run.metadataCache.getFileCache.mock.calls.some(
          ([file]) => file.path === 'two.md'
        );
        if (fired || !indexed) return;
        fired = true;
        run.move('two.md', 'three.md');
      }
    );

    const moved = await scanForMovedNotes(run.deps);

    expect(fired).toBe(true);
    expect(moved).toEqual([]);
    expect(readLocations(run.repo)[0].reference).toBe('one.md');
  });

  it('holds back a swap when one of the two notes moves on mid-scan', async () => {
    let fired = false;
    const run: ReturnType<typeof wire> = wire(
      handWorld(
        [article('a', 'one.md'), article('b', 'two.md')],
        [
          { path: 'one.md', frontmatter: { 'ir-id': 'b' } },
          { path: 'two.md', frontmatter: { 'ir-id': 'a' } },
        ],
        EVERY_STEP
      ),
      () => {
        const indexed = run.vault.getMarkdownFiles.mock.calls.length > 0;
        const looked = run.metadataCache.getFileCache.mock.calls.filter(
          ([file]) => file.path === 'one.md'
        ).length;
        // once by the stranded check, once by the vault index
        if (fired || !indexed || looked < 2) return;
        fired = true;
        run.move('one.md', 'elsewhere.md');
      }
    );

    await expect(scanForMovedNotes(run.deps)).resolves.toEqual([]);

    expect(fired).toBe(true);
    expect(readLocations(run.repo).map((row) => row.reference)).toEqual([
      'one.md',
      'two.md',
    ]);
  });

  it('lets a live rename made mid-scan stand', async () => {
    let fired = false;
    const run: ReturnType<typeof wire> = wire(
      handWorld(
        [article('a', 'one.md')],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }],
        EVERY_STEP
      ),
      () => {
        if (fired || run.vault.getMarkdownFiles.mock.calls.length === 0) return;
        fired = true;
        run.repo.mutate(`UPDATE article SET reference = 'live.md'`);
      }
    );

    await scanForMovedNotes(run.deps);

    expect(fired).toBe(true);
    expect(readLocations(run.repo)[0].reference).toBe('live.md');
  });

  it('leaves a row deleted mid-scan where it was', async () => {
    let fired = false;
    const run: ReturnType<typeof wire> = wire(
      handWorld(
        [article('a', 'one.md')],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }],
        EVERY_STEP
      ),
      () => {
        if (fired || run.vault.getMarkdownFiles.mock.calls.length === 0) return;
        fired = true;
        run.repo.mutate(`UPDATE article SET deleted = 1`);
      }
    );

    await scanForMovedNotes(run.deps);

    expect(fired).toBe(true);
    expect(readLocations(run.repo)).toEqual([
      { ...article('a', 'one.md'), deleted: true },
    ]);
  });

  it('holds back only the move whose target another row took before the write', async () => {
    const run = wire(
      handWorld(
        [
          article('a', 'one.md'),
          article('c', 'three.md'),
          article('d', 'four.md'),
        ],
        [
          { path: 'two.md', frontmatter: { 'ir-id': 'a' } },
          { path: 'three.md', frontmatter: { 'ir-id': 'c' } },
          { path: 'five.md', frontmatter: { 'ir-id': 'd' } },
        ]
      )
    );
    raceTheWrite(run, `UPDATE article SET reference = 'two.md' WHERE id = 'c'`);

    const moved = await scanForMovedNotes(run.deps);

    // d still lands; a is held back rather than taking every move down with it
    expect(moved).toEqual([
      { table: 'article', id: 'd', from: 'four.md', to: 'five.md' },
    ]);
    expect(
      readLocations(run.repo).map((row) => [row.id, row.reference])
    ).toEqual([
      ['a', 'one.md'],
      ['c', 'two.md'],
      ['d', 'five.md'],
    ]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('reached these paths first'),
      [{ table: 'article', id: 'a', from: 'one.md', to: 'two.md' }]
    );
  });

  it('never leaves a held-back row parked on a spot no note can be at', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md'), article('c', 'three.md')],
        [
          { path: 'two.md', frontmatter: { 'ir-id': 'a' } },
          { path: 'three.md', frontmatter: { 'ir-id': 'c' } },
        ]
      )
    );
    raceTheWrite(run, `UPDATE article SET reference = 'two.md' WHERE id = 'c'`);

    await scanForMovedNotes(run.deps);

    // A `NOT EXISTS` guard on the landing statement alone would strand `a`
    // here, live and pointing at its parking spot
    for (const row of readLocations(run.repo)) {
      expect(row.reference).not.toMatch(/^\/ir-/);
    }
  });

  it('warns about notes it could not follow for a reason other than being gone', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md'), article('b', 'two.md')],
        [
          { path: 'copy-1.md', frontmatter: { 'ir-id': 'a' } },
          { path: 'copy-2.md', frontmatter: { 'ir-id': 'a' } },
        ]
      )
    );

    await scanForMovedNotes(run.deps);

    expect(run.transaction).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Incremental Reading'),
      [
        {
          row: { table: 'article', id: 'a', reference: 'one.md' },
          reason: 'ambiguous',
        },
      ]
    );
  });

  it('follows a note onto a path only a deleted item still holds', async () => {
    const run = wire(stepOverWorld());

    const moved = await scanForMovedNotes(run.deps);

    expect(moved).toEqual([
      { table: 'article', id: 'a', from: 'one.md', to: 'two.md' },
    ]);
    expect(readLocations(run.repo)).toEqual([
      article('a', 'two.md'),
      tombstone(
        'article',
        'gone',
        evictedSpot({ table: 'article', id: 'gone' })
      ),
    ]);
    // Nothing failed, so nothing to warn about — least of all on every launch
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('leaves an evicted tombstone whole, and restorable onto any path by id', async () => {
    const run = wire(stepOverWorld());

    await scanForMovedNotes(run.deps);

    const [kept] = run.repo.db?.exec(
      `SELECT due, interval, priority, dismissed FROM article WHERE id = 'gone'`
    ) ?? [undefined];
    expect(kept?.values).toEqual([[FIXED_DUE, 86400000, 30, 0]]);
    // Every restore overwrites the reference outright, so the old path is not
    // something the row needs to have kept
    run.repo.mutate(
      `UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2`,
      ['back.md', 'gone']
    );
    expect(readLocations(run.repo)).toEqual([
      article('a', 'two.md'),
      article('gone', 'back.md'),
    ]);
  });

  it('reports an eviction at debug level rather than as a failure', async () => {
    const run = wire(stepOverWorld());

    await scanForMovedNotes(run.deps);

    expect(console.debug).toHaveBeenCalledTimes(1);
    expect(console.debug).toHaveBeenCalledWith(
      expect.stringContaining('Incremental Reading'),
      [{ table: 'article', id: 'gone', reference: 'two.md' }]
    );
  });

  it('says nothing about a move that displaced no tombstone', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md')],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }]
      )
    );

    const moved = await scanForMovedNotes(run.deps);

    expect(moved).toHaveLength(1);
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('evicts a tombstone once, leaving the next scan nothing to do', async () => {
    const run = wire(stepOverWorld());

    await scanForMovedNotes(run.deps);
    const settled = readLocations(run.repo);
    run.transaction.mockClear();
    const again = await scanForMovedNotes(run.deps);

    expect(again).toEqual([]);
    expect(run.transaction).not.toHaveBeenCalled();
    expect(readLocations(run.repo)).toEqual(settled);
    expect(console.debug).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('still refuses a move onto a path a live item holds', async () => {
    const run = wire(
      handWorld(
        [
          article('a', 'one.md'),
          { table: 'snippet', id: 'b', reference: 'two.md', deleted: false },
        ],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }]
      )
    );

    const moved = await scanForMovedNotes(run.deps);

    expect(moved).toEqual([]);
    expect(run.transaction).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
    expect(readLocations(run.repo).map((row) => row.reference)).toEqual([
      'one.md',
      'two.md',
    ]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Incremental Reading'),
      [
        {
          row: { table: 'article', id: 'a', reference: 'one.md' },
          reason: 'conflict',
        },
      ]
    );
  });

  it('leaves a tombstone in place when a live row blocks the same path', async () => {
    const run = wire(
      handWorld(
        [
          article('a', 'one.md'),
          tombstone('srs_card', 'gone', 'two.md'),
          { table: 'snippet', id: 'b', reference: 'two.md', deleted: false },
        ],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }]
      )
    );

    const moved = await scanForMovedNotes(run.deps);

    expect(moved).toEqual([]);
    expect(console.debug).not.toHaveBeenCalled();
    // The move was refused, so nothing needed the path and the row keeps it
    expect(readLocations(run.repo)).toEqual([
      article('a', 'one.md'),
      { table: 'snippet', id: 'b', reference: 'two.md', deleted: false },
      tombstone('srs_card', 'gone', 'two.md'),
    ]);
  });

  it('leaves a tombstone restored between the plan and the write holding its path', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md'), tombstone('snippet', 'gone', 'two.md')],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }]
      )
    );
    const commit = commitOn(run.repo);
    run.transaction.mockImplementation(async (work) => {
      // A live handler put the note back before the scan's write began: the
      // row is no longer a tombstone, and the reference it was given is newer
      run.repo.mutate(`UPDATE snippet SET deleted = 0 WHERE id = $1`, ['gone']);
      return commit(work);
    });

    await scanForMovedNotes(run.deps);

    expect(readLocations(run.repo)).toEqual([
      article('a', 'two.md'),
      { table: 'snippet', id: 'gone', reference: 'two.md', deleted: false },
    ]);
  });

  it('leaves a tombstone moved between the plan and the write where it went', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md'), tombstone('snippet', 'gone', 'two.md')],
        [{ path: 'two.md', frontmatter: { 'ir-id': 'a' } }]
      )
    );
    const commit = commitOn(run.repo);
    run.transaction.mockImplementation(async (work) => {
      // A live handler dragged the tombstone's stale pointer along with a
      // rename of some other note, leaving it deleted but elsewhere
      run.repo.mutate(`UPDATE snippet SET reference = $1 WHERE id = $2`, [
        'elsewhere.md',
        'gone',
      ]);
      return commit(work);
    });

    await scanForMovedNotes(run.deps);

    expect(readLocations(run.repo)).toEqual([
      article('a', 'two.md'),
      tombstone('snippet', 'gone', 'elsewhere.md'),
    ]);
  });

  it('stays quiet when every note it could not follow is simply gone', async () => {
    const run = wire(
      handWorld(
        [article('a', 'one.md'), article('b', 'two.md')],
        [{ path: 'three.md', frontmatter: { 'ir-id': 'b' } }]
      )
    );

    const moved = await scanForMovedNotes(run.deps);

    expect(moved).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
