import { MigrationVerificationError } from '#/db/migration-helpers';
import { migrations } from '#/db/migrations';
import {
  BACKUP_DIRECTORY,
  BATCHED_MUTATION_SLICE_MS,
  DATA_DIRECTORY,
  DATABASE_FILE_PATH,
} from '#/lib/constants';
import { getDeviceId } from '#/lib/device-id';
import * as notices from '#/lib/notices';
import type { SyncHoldReason } from '#/lib/obsidian-sync';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { requireReady } from '#/lib/readiness';
import type { DataChangeEvent, MutationStatement, NoteType } from '#/lib/types';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App, DataAdapter, Plugin, TAbstractFile } from 'obsidian';
import { resolve } from 'path';
import type { Database, SqlValue } from 'sql.js';
import initSqlJs from 'sql.js';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from 'vitest';
import { BulkMutateError } from './BulkMutateError';
import * as rowMerge from './row-merge';
import {
  DatabaseLoadError,
  SQLJSRepository,
  StartupCancelledError,
  type SyncHold,
} from './SQLJSRepository';
import {
  KNOWN_WRITE_STAMP_KEY,
  readWriteVector,
  STALE_AFTER_MS,
  type WriteVector,
} from './write-stamp';

/** The schema version every migrated or fresh database ends at. */
const LATEST_VERSION = migrations[migrations.length - 1].version;

// #region HELPERS

/**
 * A repository backed by a real in-memory sql.js database. The production
 * update-hook wiring runs unchanged; only the vault-backed `save` and the
 * WASM/vault plumbing are stubbed so no filesystem is touched.
 */
class TestRepository extends SQLJSRepository {
  static createReal(schema: string, db: Database): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema,
    });
    repo.db = db;
    repo.registerUpdateHook();
    return repo;
  }

  // Writes to a real vault are irrelevant to these tests.
  protected override async save() {}
}

/**
 * Like {@link TestRepository} but runs the real `save()` (so `db.export()`
 * actually executes), stubbing only the vault write. `export()` tears down the
 * sql.js update hook, so this exercise catches a regression where the hook is
 * not re-armed after a save.
 */
class SavingTestRepository extends SQLJSRepository {
  static createReal(schema: string, db: Database): SavingTestRepository {
    const repo = new SavingTestRepository({
      app: {
        vault: {
          adapter: { writeBinary: vi.fn().mockResolvedValue(undefined) },
          getFolderByPath: vi.fn().mockReturnValue({}),
        },
      } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema,
    });
    repo.db = db;
    repo.registerUpdateHook();
    return repo;
  }

  /** Refuse writes from here on, as saving paused does. */
  refuseWrites(error: Error) {
    this.blockWrites(error);
  }
}

function loadSchema(): string {
  return readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
}

async function makeSql(): Promise<initSqlJs.SqlJsStatic> {
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  return initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
}

async function makeRepo(): Promise<{ repo: TestRepository; db: Database }> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(await getEmptyDbBytes());
  const repo = TestRepository.createReal(getSharedSchema(), db);
  return { repo, db };
}

async function makeSavingRepo(): Promise<{
  repo: SavingTestRepository;
  db: Database;
  /** The stubbed vault write every save ends in */
  writeBinary: MockInstance<DataAdapter['writeBinary']>;
}> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(await getEmptyDbBytes());
  // Production turns foreign keys on when it opens a database (`initDb`)
  db.exec('PRAGMA foreign_keys = ON');
  const repo = SavingTestRepository.createReal(getSharedSchema(), db);
  const writeBinary = vi.spyOn(repo.app.vault.adapter, 'writeBinary');
  return { repo, db, writeBinary };
}

/** `PRAGMA foreign_keys` as the connection reports it: 1 = enforced */
function foreignKeysPragma(repo: SQLJSRepository): number {
  const [row] = repo.query('PRAGMA foreign_keys') as unknown as {
    foreign_keys: number;
  }[];
  return row.foreign_keys;
}

function insertArticle(repo: SQLJSRepository, id: string, priority = 30) {
  repo.mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `articles/${id}.md`, Date.now(), 86_400_000, priority]
  );
}

function insertArticleReview(
  repo: SQLJSRepository,
  id: string,
  articleId: string
) {
  repo.mutate(
    `INSERT INTO article_review (id, article_id, review_time) VALUES ($1, $2, $3)`,
    [id, articleId, Date.now()]
  );
}

function insertSnippet(repo: TestRepository, id: string, priority = 30) {
  repo.mutate(
    `INSERT INTO snippet (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `snippets/${id}.md`, Date.now(), 86_400_000, priority]
  );
}

function insertCard(repo: TestRepository, id: string) {
  repo.mutate(
    `INSERT INTO srs_card (id, reference, created_at, due, stability,
       difficulty, elapsed_days, scheduled_days, reps, lapses, state)
     VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0)`,
    [id, `cards/${id}.md`, Date.now(), Date.now()]
  );
}

// --- Obsidian Sync simulation ---

const SYNCED_DB_PATH = 'ir-sync-test.sqlite';
/** Fixed so two generated databases differ only in which rows they hold. */
const FIXED_DUE = 1_700_000_000_000;

const INSERT_ARTICLE_SQL = `INSERT INTO article (id, reference, due, interval, priority)
   VALUES ($1, $2, $3, $4, $5)`;

let sharedSql: Promise<initSqlJs.SqlJsStatic> | null = null;
let sharedSchema: string | null = null;

/**
 * Initializing the WASM module and reading the schema dominate the cost of
 * building a database, and the property below builds several per run — share
 * one of each rather than paying for them thousands of times.
 */
function getSharedSql(): Promise<initSqlJs.SqlJsStatic> {
  return (sharedSql ??= makeSql());
}

function getSharedSchema(): string {
  return (sharedSchema ??= loadSchema());
}

function articleRow(id: string): (string | number)[] {
  return [id, `articles/${id}.md`, FIXED_DUE, 86_400_000, 30];
}

function insertArticleRow(repo: SQLJSRepository, id: string) {
  repo.mutate(INSERT_ARTICLE_SQL, articleRow(id));
}

/** Ids of every article row the repository can currently see. */
function articleIds(repo: SQLJSRepository): string[] {
  return (repo.query('SELECT id FROM article') as { id: string }[]).map(
    (row) => row.id
  );
}

let emptyDbBytes: Uint8Array | null = null;

/**
 * Bytes of an empty database at the current schema. Executing the schema costs
 * far more than deserializing the result, and the property below needs a fresh
 * database per run.
 */
async function getEmptyDbBytes(): Promise<Uint8Array> {
  if (emptyDbBytes) return emptyDbBytes;

  const SQL = await getSharedSql();
  const db = new SQL.Database();
  db.exec(getSharedSchema());
  emptyDbBytes = db.export();
  db.close();
  return emptyDbBytes;
}

/**
 * Insert an article row per id into `db` in one transaction: committed one
 * at a time, the inserts cost several times as much as the rest of building
 * a file, and properties build a few files per case.
 */
function insertArticleRows(db: Database, ids: readonly string[]) {
  db.exec('BEGIN');
  for (const id of ids)
    db.exec(INSERT_ARTICLE_SQL, articleRow(id) as SqlValue[]);
  db.exec('COMMIT');
}

/** The device that saved every other device's copy of the file below. */
const REMOTE_DEVICE = 'remote-device';
let remoteGeneration = 0;

/**
 * Stamp `db` as saved once more by another device, as every copy Sync brings
 * down is. One that was not would read as this device's own save coming
 * back, and be left alone.
 */
function stampAsRemote(db: Database) {
  remoteGeneration = Math.max(remoteGeneration + 1, Date.now());
  db.run(
    `INSERT INTO write_stamp (device, generation) VALUES ($1, $2)
     ON CONFLICT (device) DO UPDATE SET generation = excluded.generation`,
    [REMOTE_DEVICE, remoteGeneration]
  );
}

const remoteDbCache = new Map<string, Uint8Array>();

/**
 * Serialized bytes of a database holding exactly `ids` — what another device's
 * copy of the file looks like once Obsidian Sync brings it down. Stamped anew
 * on every call, as each copy follows another save.
 */
async function remoteDbBytes(ids: readonly string[]): Promise<Uint8Array> {
  const key = ids.join(',');
  const SQL = await getSharedSql();
  let rows = remoteDbCache.get(key);
  if (!rows) {
    const db = new SQL.Database(await getEmptyDbBytes());
    insertArticleRows(db, ids);
    rows = db.export();
    db.close();
    remoteDbCache.set(key, rows);
  }
  const db = new SQL.Database(rows);
  stampAsRemote(db);
  const bytes = db.export();
  db.close();
  return bytes;
}

/**
 * A repository whose database file sits on a fake disk that a second writer —
 * Obsidian Sync — can overwrite at any moment. `save`, `reloadDb` and
 * `handleFileChange` are the production implementations; only the WASM loader
 * and the vault adapter are stubbed, so a reload really does swap `this.db`
 * for a fresh instance built from whatever bytes are on disk.
 *
 * `readBinary` parks until {@link SyncedTestRepository.landSync} releases it.
 * That is what makes the interleaving controllable, and it is faithful: in
 * production the reload suspends there too, for however long it takes to read
 * the file — which on a synced vault is long enough for a review to start and
 * finish in the meantime.
 */
class SyncedTestRepository extends SQLJSRepository {
  /** Bytes on "disk". Sync overwrites these behind the plugin's back. */
  diskBytes: Uint8Array = new Uint8Array();
  /** Writes a still-open transaction could not read back, if any. */
  readBackFailures: string[] = [];
  #parkedReads: Array<() => void> = [];
  #inFlightSync: Promise<void> | null = null;
  #sqlStatic!: initSqlJs.SqlJsStatic;

  /** Every other file written, such as backups. */
  otherFiles = new Map<string, Uint8Array>();

  static async create(): Promise<SyncedTestRepository> {
    const SQL = await getSharedSql();
    const schema = getSharedSchema();
    let repo!: SyncedTestRepository;
    const adapter = {
      writeBinary: async (path: string, data: ArrayBuffer) => {
        const bytes = new Uint8Array(data.slice(0));
        if (path === SYNCED_DB_PATH) repo.diskBytes = bytes;
        else repo.otherFiles.set(path, bytes);
      },
      // Resolves against whatever is on disk when the read lands rather than
      // when it was issued, so a save that beats the read wins — as it would
      // on a real filesystem.
      readBinary: async (path: string) => {
        const other = repo.otherFiles.get(path);
        if (other) return other.slice().buffer;
        await new Promise<void>((release) => repo.#parkedReads.push(release));
        return repo.diskBytes.slice().buffer;
      },
      exists: async () => true,
      mkdir: async () => {},
    };
    repo = new SyncedTestRepository({
      app: {
        vault: { adapter, getFolderByPath: () => ({}) },
      } as unknown as App,
      dbFilePath: SYNCED_DB_PATH,
      schema,
    });
    repo.#sqlStatic = SQL;
    // The file starts out as a valid empty database, so a reload always finds
    // one, and memory starts out matching it.
    repo.diskBytes = await getEmptyDbBytes();
    repo.db = new SQL.Database(repo.diskBytes);
    repo.registerUpdateHook();
    return repo;
  }

  protected override async loadWasm() {
    return this.#sqlStatic;
  }

  /**
   * Close the database the reload just replaced. Production leaks it, which is
   * harmless there but would pile thousands up over a fuzz run. Nothing reads
   * the old instance either way.
   */
  protected override async reloadDb(bytes?: ArrayBuffer) {
    const previous = this.db;
    const result = await super.reloadDb(bytes);
    if (this.db !== previous) previous?.close();
    return result;
  }

  /** Sync writes a peer's copy of the file; Obsidian fires `modify` for it. */
  beginSync(bytes: Uint8Array) {
    this.diskBytes = bytes;
    this.#inFlightSync = this.handleFileChange({
      path: SYNCED_DB_PATH,
    } as TAbstractFile);
  }

  /**
   * Release the parked read so the reload it belongs to runs to completion.
   * A reload the repository held back because a transaction is open has not
   * issued its read yet, so there is nothing to release and this just waits
   * out the `modify` handler.
   */
  async landSync(): Promise<void> {
    // The reload awaits the WASM loader before it reads the file; let those
    // microtasks drain so the read is really parked before releasing it.
    for (let i = 0; this.#parkedReads.length === 0 && i < 20; i++) {
      await Promise.resolve();
    }
    this.#parkedReads.shift()?.();
    await this.#inFlightSync;
    this.#inFlightSync = null;
  }

  /**
   * Release every read still parked, including one issued by a reload that was
   * held back until a transaction settled, so a run ends in a settled state.
   */
  async settleSync(): Promise<void> {
    for (let idle = 0; idle < 5; ) {
      if (this.#parkedReads.length > 0) {
        this.#parkedReads.shift()?.();
        idle = 0;
      } else {
        idle++;
      }
      await Promise.resolve();
    }
    await this.#inFlightSync;
    this.#inFlightSync = null;
  }

  /** Wait out the floating `save()` a non-transactional `mutate` starts. */
  async settleSaves(): Promise<void> {
    for (let i = 0; this.pendingSaveCount > 0 && i < 20; i++) {
      await Promise.resolve();
    }
  }

  /** Ids a fresh reader would find in the file on disk. */
  async articleIdsOnDisk(): Promise<string[]> {
    const SQL = await getSharedSql();
    const db = new SQL.Database(this.diskBytes);
    const result = db.exec('SELECT id FROM article');
    db.close();
    return (result[0]?.values ?? []).map((row) => row[0] as string);
  }
}

// --- bulkMutate ---

type ItemTable = 'article' | 'snippet' | 'srs_card';

const ITEM_TABLES: readonly ItemTable[] = ['article', 'snippet', 'srs_card'];

const NOTE_TYPE_BY_TABLE: Readonly<Record<ItemTable, NoteType>> = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
};

/** One queue-item row a generated `bulkMutate` call inserts. */
interface RowWrite {
  table: ItemTable;
  id: string;
}

function insertStatement({ table, id }: RowWrite): MutationStatement {
  switch (table) {
    case 'article':
      return { query: INSERT_ARTICLE_SQL, params: articleRow(id) };
    case 'snippet':
      return {
        query: `INSERT INTO snippet (id, reference, due, interval, priority)
          VALUES ($1, $2, $3, $4, $5)`,
        params: [id, `snippets/${id}.md`, FIXED_DUE, 86_400_000, 30],
      };
    case 'srs_card':
      return {
        query: `INSERT INTO srs_card (id, reference, created_at, due, stability,
            difficulty, elapsed_days, scheduled_days, reps, lapses, state)
          VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0)`,
        params: [id, `cards/${id}.md`, FIXED_DUE, FIXED_DUE],
      };
  }
}

/**
 * Rows to insert, unique by id so no two collide. Ids may hold any character
 * but NUL: sql.js binds a string with its length but reads one back as a C
 * string, so an id with a NUL in it would not survive the round trip.
 */
const rowWritesArb = (constraints: { minLength?: number } = {}) =>
  fc.uniqueArray(
    fc.record({
      table: fc.constantFrom(...ITEM_TABLES),
      id: fc.string({ unit: 'binary' }).filter((id) => !id.includes('\0')),
    }),
    { selector: (write) => write.id, maxLength: 60, ...constraints }
  );

/** Every valid chunk size, or `undefined` to take the default. */
const sliceMsArb = fc.option(
  fc.oneof(
    fc.maxSafeNat().map((n) => n + 1),
    fc.double({ min: 2 ** 53, noNaN: true, noDefaultInfinity: true })
  ),
  { nil: undefined }
);

/**
 * `bulkMutate` options that make a chunk exactly `sliceMs` statements, so a run
 * is reproducible and the chunk boundaries a test expects are the ones it gets.
 * The clock advances a tick a reading, and the budget is read once as a chunk
 * opens and once after each statement in it.
 */
function pace(sliceMs?: number) {
  let tick = 0;
  return { sliceMs, now: () => tick++ };
}

/** Statements that fail however they are run. */
const failingStatementArb = fc.constantFrom<MutationStatement>(
  { query: 'INSERT INTO nonexistent_table VALUES (1)' },
  { query: 'not a statement' },
  // violates the priority CHECK constraint
  {
    query: INSERT_ARTICLE_SQL,
    params: ['bulk-fail', 'articles/bulk-fail.md', FIXED_DUE, 86_400_000, 5],
  }
);

/**
 * A repository over a fresh empty database, and a spy on the file write each
 * save ends in.
 */
async function makeBulkRepo() {
  const SQL = await getSharedSql();
  const repo = SavingTestRepository.createReal(
    getSharedSchema(),
    new SQL.Database(await getEmptyDbBytes())
  );
  const writeBinary = vi.spyOn(repo.app.vault.adapter, 'writeBinary');
  return { repo, writeBinary };
}

/** What `run` rejects with, or null when it resolves. */
function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (error: unknown) => error
  );
}

/** How many rows the item tables hold between them. */
function rowCount(repo: SQLJSRepository): number {
  return Object.values(idsByTable(repo)).flat().length;
}

/** `items` split into consecutive runs of `size`. */
function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** The events one committed chunk of inserts should produce, in flush order. */
function insertEventsFor(chunk: readonly RowWrite[]): DataChangeEvent[] {
  const idsByNoteType = new Map<NoteType, string[]>();
  for (const { table, id } of chunk) {
    const noteType = NOTE_TYPE_BY_TABLE[table];
    idsByNoteType.set(noteType, [...(idsByNoteType.get(noteType) ?? []), id]);
  }
  return [...idsByNoteType].map(([table, ids]) => ({
    table,
    op: 'insert',
    ids,
  }));
}

/** Ids in each item table, in the order they were inserted. */
function idsByTable(repo: SQLJSRepository): Record<ItemTable, string[]> {
  const read = (table: ItemTable) =>
    (
      repo.query(`SELECT id FROM ${table} ORDER BY rowid`) as { id: string }[]
    ).map((row) => row.id);
  return {
    article: read('article'),
    snippet: read('snippet'),
    srs_card: read('srs_card'),
  };
}

function expectedIdsByTable(
  writes: readonly RowWrite[]
): Record<ItemTable, string[]> {
  const idsIn = (table: ItemTable) =>
    writes.filter((write) => write.table === table).map((write) => write.id);
  return {
    article: idsIn('article'),
    snippet: idsIn('snippet'),
    srs_card: idsIn('srs_card'),
  };
}
// --- startup ---

/** What the vault's file index reports for the data folder and the db file. */
interface IndexView {
  folder: boolean;
  file: boolean;
}

/**
 * A vault whose file index and disk can disagree, as they do while Obsidian
 * Sync rewrites a file or the index churns around a plugin reload. `files` is
 * the disk; the index answers from `index` alone.
 */
function makeVault(
  indexAtStart: IndexView,
  files: Map<string, Uint8Array> = new Map(),
  /**
   * Whether `exists` answers a macrotask late, as a real disk can, while the
   * other calls answer at once. That is long enough for a write issued after
   * the question to land before the answer does.
   */
  slowExists = false
) {
  // A copy, since creating the folder changes it
  const index = { ...indexAtStart };
  const adapter = {
    exists: vi.fn(async (path: string) => {
      if (slowExists) await nextMacrotask();
      return files.has(path);
    }),
    readBinary: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes.slice().buffer;
    }),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      files.set(path, new Uint8Array(data.slice(0)));
    }),
    mkdir: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
  };
  const vault = {
    adapter,
    getFolderByPath: () => (index.folder ? {} : null),
    getAbstractFileByPath: () => (index.file ? {} : null),
    // Rejects for a folder that is already there, as Obsidian's does
    createFolder: vi.fn(async () => {
      if (index.folder) throw new Error('Folder already exists.');
      index.folder = true;
    }),
  };
  return { app: { vault } as unknown as App, files, adapter, vault };
}

/**
 * Point the production WASM loader at the shared test module. Spied once per
 * test, not per {@link startRepo} call: a property starts hundreds of
 * repositories, and each spy would wrap the last.
 */
function stubWasm() {
  vi.spyOn(
    SQLJSRepository.prototype as unknown as {
      loadWasm(): Promise<initSqlJs.SqlJsStatic>;
    },
    'loadWasm'
  ).mockImplementation(getSharedSql);
}

/** Run the production factory against `app`. Needs {@link stubWasm}. */
function startRepo(
  app: App,
  params: Partial<Parameters<typeof SQLJSRepository.start>[0]> = {}
) {
  return SQLJSRepository.start({
    plugin: { app } as Plugin,
    dbFilePath: DATABASE_FILE_PATH,
    schema: getSharedSchema(),
    ...params,
  });
}

/**
 * Bytes of a database file holding exactly `ids`. Uncached, unlike
 * {@link remoteDbBytes}: its cache keys on the ids joined by commas, which
 * the ids generated here may themselves contain.
 */
async function dbFileWith(ids: readonly string[]): Promise<Uint8Array> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(await getEmptyDbBytes());
  insertArticleRows(db, ids);
  stampAsRemote(db);
  const bytes = db.export();
  db.close();
  return bytes;
}

const SQLITE_HEADER = new TextEncoder().encode('SQLite format 3\0');

/**
 * A file no database can be loaded from: anything that is not a SQLite file
 * (a sync placeholder, a foreign file); a real database cut short, as a write
 * or download still under way leaves it, at a `truncated` fraction of the way
 * through all but its last page; or a database written by a newer version of
 * the plugin, `ahead` schema versions past this one.
 *
 * Truncation stops short of the last page because SQLite reads a partial last
 * page as whole, and the database then loads intact.
 */
type UnloadableFile =
  | { bytes: Uint8Array }
  | { truncated: number }
  | { ahead: number };

const unloadableFileArb: fc.Arbitrary<UnloadableFile> = fc.oneof(
  fc
    .uint8Array({ minLength: 1, maxLength: 4096 })
    .filter((bytes) => SQLITE_HEADER.some((byte, i) => bytes[i] !== byte))
    .map((bytes) => ({ bytes })),
  fc
    .double({ min: 0, max: 1, maxExcluded: true, noNaN: true })
    .map((truncated) => ({ truncated })),
  fc.integer({ min: 1, max: 2 ** 20 }).map((ahead) => ({ ahead }))
);

/** SQLite's default page size, which sql.js writes databases with. */
const PAGE_SIZE = 4096;

let fullDbBytes: Promise<Uint8Array> | null = null;

/** A database of several pages, for cutting short. */
function getFullDbBytes(): Promise<Uint8Array> {
  return (fullDbBytes ??= dbFileWith(
    Array.from({ length: 200 }, (_, i) => `full-${i}`)
  ));
}

/**
 * A file that opens as a database but fails its migrations, which is only
 * found out once a backup of it is taken: a database from before migrations
 * were tracked (schema version 0) that lacks the tables they alter.
 */
const UNMIGRATABLE = { unmigratable: true } as const;

/** The bytes of an {@link UnloadableFile}, or of {@link UNMIGRATABLE}. */
async function unloadableBytes(
  file: UnloadableFile | typeof UNMIGRATABLE
): Promise<Uint8Array> {
  if ('bytes' in file) return file.bytes;
  if ('truncated' in file) {
    const full = await getFullDbBytes();
    const cut = 1 + Math.floor(file.truncated * (full.length - PAGE_SIZE - 1));
    return full.slice(0, cut);
  }
  const SQL = await getSharedSql();
  if ('unmigratable' in file) {
    const db = new SQL.Database();
    db.exec('CREATE TABLE unrelated (x INTEGER)');
    const bytes = db.export();
    db.close();
    return bytes;
  }
  const db = new SQL.Database(await getEmptyDbBytes());
  const version = db.exec('PRAGMA user_version')[0].values[0][0] as number;
  db.exec(`PRAGMA user_version = ${version + file.ahead}`);
  const bytes = db.export();
  db.close();
  return bytes;
}

/** Ids of every article row in the database file in `files`. */
async function idsInFile(files: Map<string, Uint8Array>): Promise<string[]> {
  const bytes = files.get(DATABASE_FILE_PATH);
  if (!bytes) return [];
  const SQL = await getSharedSql();
  const db = new SQL.Database(bytes);
  const result = db.exec('SELECT id FROM article');
  db.close();
  return (result[0]?.values ?? []).map((row) => row[0] as string);
}

/**
 * `setImmediate` rather than a zero `setTimeout`, which Windows rounds up to
 * its timer resolution: properties wait out several of these a run.
 */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Let floating saves run to completion. Against the fake adapter each takes
 * at most one macrotask plus a handful of microtasks.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextMacrotask();
}

/** An index that sees both the data folder and the database file. */
const INDEXED: IndexView = { folder: true, file: true };

/**
 * Bytes of a schema version 9 database file holding `ids`: what a device still
 * on 0.6 writes, before the `rebind` table of version 10.
 */
async function staleFileWith(ids: readonly string[]): Promise<Uint8Array> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(await dbFileWith(ids));
  db.exec('DROP TABLE rebind; DROP TABLE write_stamp; PRAGMA user_version = 9');
  const bytes = db.export();
  db.close();
  return bytes;
}

/**
 * Bytes of a database file holding exactly `ids` that another device saved
 * on top of `over`, a file this device wrote: it has every save `over` has,
 * so it is taken on whole (a fast-forward) rather than merged.
 */
async function fileOver(
  over: Uint8Array | undefined,
  ids: readonly string[]
): Promise<Uint8Array> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(await getEmptyDbBytes());
  insertArticleRows(db, ids);
  if (over) {
    const prior = new SQL.Database(over);
    const [stamps] = prior.exec('SELECT device, generation FROM write_stamp');
    prior.close();
    for (const row of stamps?.values ?? []) {
      db.run('INSERT INTO write_stamp (device, generation) VALUES (?, ?)', row);
    }
  }
  stampAsRemote(db);
  const bytes = db.export();
  db.close();
  return bytes;
}

/**
 * Bytes of another device's copy holding `ids` as it changed them after this
 * device last saw them: stamped later than any write here, with a priority
 * of 40 where {@link insertArticleRow} writes 30. Merged in, they replace
 * this device's rows of the same ids, which that device never saw.
 */
async function newerFileWith(ids: readonly string[]): Promise<Uint8Array> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(await dbFileWith(ids));
  db.run(`UPDATE article SET priority = 40, updated_at = $1, updated_by = $2`, {
    $1: Date.now() + DAY_MS,
    $2: REMOTE_DEVICE,
  });
  const bytes = db.export();
  db.close();
  return bytes;
}

/**
 * `bytes` with a review whose article neither copy has, as only a file
 * damaged by hand holds: it can't be merged, so it is taken on after a
 * backup instead.
 */
async function unmergeable(bytes: Uint8Array): Promise<Uint8Array> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(bytes);
  db.run(
    `INSERT INTO article_review (id, article_id, review_time)
     VALUES ('dangling', 'no-such-article', 0)`
  );
  const result = db.export();
  db.close();
  return result;
}

/** Priority of each article row the repository can see, by id. */
function priorities(repo: SQLJSRepository): Record<string, number> {
  return Object.fromEntries(
    (
      repo.query('SELECT id, priority FROM article') as {
        id: string;
        priority: number;
      }[]
    ).map(({ id, priority }) => [id, priority])
  );
}

/** Make every migration's verification fail, as data loss would. */
function failMigrationVerification() {
  vi.spyOn(
    SQLJSRepository.prototype as unknown as {
      verifyMigration(): { passed: boolean; errors: string[] };
    },
    'verifyMigration'
  ).mockReturnValue({ passed: false, errors: ['rows went missing'] });
}

/** Paths written under the backup folder. */
function backupWrites(adapter: ReturnType<typeof makeVault>['adapter']) {
  return adapter.writeBinary.mock.calls
    .map(([path]) => path)
    .filter((path) => path.startsWith(`${BACKUP_DIRECTORY}/`));
}

/** The schema version of the database file in `files`. */
async function readVersion(files: Map<string, Uint8Array>): Promise<number> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(files.get(DATABASE_FILE_PATH));
  const version = db.exec('PRAGMA user_version')[0].values[0][0] as number;
  db.close();
  return version;
}

/** The `modify` or `create` event Obsidian fires for the database file. */
const dbFileChange = { path: DATABASE_FILE_PATH } as TAbstractFile;

/** A started repository over a file holding `ids`. */
async function startOver(ids: readonly string[], index = INDEXED) {
  const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(ids)]]);
  const vault = makeVault(index, files);
  const onReloadFromDisk = vi.fn();
  const onWriteBlocked = vi.fn();
  const onWritesResumed = vi.fn();
  const repo = await startRepo(vault.app, {
    onReloadFromDisk,
    onWriteBlocked,
    onWritesResumed,
  });
  return { ...vault, repo, onReloadFromDisk, onWriteBlocked, onWritesResumed };
}

/** Every combination of what the index can report. */
const indexViewArb = fc.record({ folder: fc.boolean(), file: fc.boolean() });

/** Article ids for a database file, unique and NUL-free (see `rowWritesArb`). */
const articleIdsArb = fc.uniqueArray(
  fc.string({ unit: 'binary' }).filter((id) => !id.includes('\0')),
  { maxLength: 20 }
);

/**
 * A Sync hold that waits until the test releases it, answering `outcome`.
 * What Sync delivers during the wait is put in place before the release.
 */
function makeHold() {
  type Outcome = Awaited<ReturnType<SyncHold>>;
  let release: (outcome: Outcome) => void = () => {};
  const hold = vi.fn(
    (_reason: SyncHoldReason) =>
      new Promise<Outcome>((resolve) => {
        release = resolve;
      })
  );
  return {
    hold,
    release: (outcome: Outcome = 'waited') => release(outcome),
  };
}

/** What Sync can bring down while a startup waits. */
type Delivery =
  | { kind: 'nothing' }
  | { kind: 'current'; ids: string[] }
  | { kind: 'stale'; ids: string[] };
const deliveryArb: fc.Arbitrary<Delivery> = fc.oneof(
  fc.constant({ kind: 'nothing' as const }),
  articleIdsArb.map((ids) => ({ kind: 'current' as const, ids })),
  articleIdsArb.map((ids) => ({ kind: 'stale' as const, ids }))
);
const deliveredBytes = (delivery: Delivery) =>
  delivery.kind === 'current'
    ? dbFileWith(delivery.ids)
    : delivery.kind === 'stale'
      ? staleFileWith(delivery.ids)
      : null;

/** Where a startup can be when the plugin unloads under it. */
const abortPointArb = fc.oneof(
  fc.constant({ kind: 'before' as const }),
  fc.constant({ kind: 'while-held' as const }),
  fc.nat({ max: 40 }).map((hops) => ({ kind: 'after-hold' as const, hops }))
);
/** Give `app` a localStorage of its own, as every vault has. */
function withStorage(app: App): App & { storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>();
  return Object.assign(app, {
    storage,
    loadLocalStorage: (key: string): unknown => storage.get(key) ?? null,
    saveLocalStorage: (key: string, data: unknown) => {
      storage.set(key, data);
    },
  });
}

/** Bytes of a database file holding `ids`, stamped with exactly `stamp`. */
async function fileStamped(
  ids: readonly string[],
  stamp: WriteVector
): Promise<Uint8Array> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(await getEmptyDbBytes());
  insertArticleRows(db, ids);
  for (const [device, generation] of Object.entries(stamp)) {
    db.run('INSERT INTO write_stamp VALUES ($1, $2)', [device, generation]);
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

/** The write stamp of the database file `bytes`. */
async function stampOf(bytes: Uint8Array | undefined): Promise<WriteVector> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(bytes);
  const [rows] = db.exec('SELECT device, generation FROM write_stamp');
  db.close();
  return Object.fromEntries(rows?.values ?? []) as WriteVector;
}

/** Ids of every article row in the database file `bytes`. */
async function idsIn(bytes: Uint8Array | undefined): Promise<string[]> {
  return idsInFile(new Map(bytes ? [[DATABASE_FILE_PATH, bytes]] : []));
}

/**
 * `files` with `ids` added to its database file and another device's
 * generation raised: that device's next save, made on top of this one's.
 */
async function savedOnTopBy(
  bytes: Uint8Array | undefined,
  ids: readonly string[]
): Promise<Uint8Array> {
  const SQL = await getSharedSql();
  const db = new SQL.Database(bytes);
  insertArticleRows(db, ids);
  stampAsRemote(db);
  const out = db.export();
  db.close();
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// #endregion

describe('onDataChange', () => {
  let repo: TestRepository;

  beforeEach(async () => {
    ({ repo } = await makeRepo());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits an insert event with the affected UUID id', () => {
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    insertArticle(repo, 'a1');

    expect(events).toEqual([{ table: 'article', op: 'insert', ids: ['a1'] }]);
  });

  it('emits an update event with the affected id', () => {
    insertArticle(repo, 'a1', 30);
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [40, 'a1']);

    expect(events).toEqual([{ table: 'article', op: 'update', ids: ['a1'] }]);
  });

  it('emits an update event when a row is soft-deleted', () => {
    // The app removes items from the queue by flipping `deleted`/`dismissed`,
    // not with a SQL DELETE. That surfaces as an update the queue can act on.
    insertArticle(repo, 'a1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET deleted = TRUE WHERE id = $1`, ['a1']);

    expect(events).toEqual([{ table: 'article', op: 'update', ids: ['a1'] }]);
  });

  it('resolves ids for writes that match on a non-id column', () => {
    insertArticle(repo, 'a1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    // dismiss-by-reference style predicate: the param is not the id
    repo.mutate(`UPDATE article SET dismissed = 1 WHERE reference = $1`, [
      'articles/a1.md',
    ]);

    expect(events).toEqual([{ table: 'article', op: 'update', ids: ['a1'] }]);
  });

  it('maps the srs_card table to the card note type', () => {
    insertCard(repo, 'c1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE srs_card SET reps = 1 WHERE id = $1`, ['c1']);

    expect(events).toEqual([{ table: 'card', op: 'update', ids: ['c1'] }]);
  });

  it('batches a multi-row write into one event with every affected id', () => {
    insertArticle(repo, 'a1', 30);
    insertArticle(repo, 'a2', 30);
    insertArticle(repo, 'a3', 40);
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET priority = 20 WHERE priority = $1`, [30]);

    expect(events).toHaveLength(1);
    expect(events[0].table).toBe('article');
    expect(events[0].op).toBe('update');
    expect(events[0].ids.sort()).toEqual(['a1', 'a2']);
  });

  it('emits a separate event per table touched in one write', () => {
    insertArticle(repo, 'a1');
    insertSnippet(repo, 's1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(
      `UPDATE article SET priority = 25 WHERE id = 'a1';
       UPDATE snippet SET priority = 25 WHERE id = 's1';`
    );

    const tables = events.map((e) => e.table).sort();
    expect(tables).toEqual(['article', 'snippet']);
  });

  it('does not emit for writes to review tables (not queue items)', () => {
    insertArticle(repo, 'a1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(
      `INSERT INTO article_review (id, article_id, review_time)
       VALUES ($1, $2, $3)`,
      ['r1', 'a1', Date.now()]
    );

    expect(events).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const events: DataChangeEvent[] = [];
    const unsubscribe = repo.onDataChange((e) => events.push(e));

    insertArticle(repo, 'a1');
    unsubscribe();
    insertArticle(repo, 'a2');

    expect(events).toHaveLength(1);
    expect(events[0].ids).toEqual(['a1']);
  });

  it('delivers to multiple listeners', () => {
    const a: DataChangeEvent[] = [];
    const b: DataChangeEvent[] = [];
    repo.onDataChange((e) => a.push(e));
    repo.onDataChange((e) => b.push(e));

    insertArticle(repo, 'a1');

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  // Regression: sql.js `db.export()` (run by the real `save()` after every
  // mutate) tears down the update hook. Without re-arming it, only the first
  // write per save would emit — the queue would stop updating after one change.
  it('keeps emitting across successive writes despite save/export', async () => {
    const { repo: savingRepo } = await makeSavingRepo();
    const events: DataChangeEvent[] = [];
    savingRepo.onDataChange((e) => events.push(e));

    savingRepo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ($1, $2, $3, $4, $5)`,
      ['a1', 'articles/a1.md', Date.now(), 86_400_000, 30]
    );
    savingRepo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [
      40,
      'a1',
    ]);
    savingRepo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ($1, $2, $3, $4, $5)`,
      ['a2', 'articles/a2.md', Date.now(), 86_400_000, 30]
    );

    expect(events).toEqual([
      { table: 'article', op: 'insert', ids: ['a1'] },
      { table: 'article', op: 'update', ids: ['a1'] },
      { table: 'article', op: 'insert', ids: ['a2'] },
    ]);
  });
});

// sql.js `export()` (run by the real `save()`) closes the connection and
// reopens the file, so every connection-level pragma is back at its default
// afterwards. Foreign keys must survive that, or `ON DELETE CASCADE` and every
// FK constraint go unenforced after the first save of a session.
describe('foreign keys after save', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps PRAGMA foreign_keys on after a mutate has saved', async () => {
    const { repo } = await makeSavingRepo();
    expect(foreignKeysPragma(repo)).toBe(1);

    insertArticle(repo, 'a1');

    expect(foreignKeysPragma(repo)).toBe(1);
  });

  it('cascades a parent delete to its children after a save', async () => {
    const { repo } = await makeSavingRepo();
    insertArticle(repo, 'a1');
    insertArticleReview(repo, 'r1', 'a1');

    repo.mutate(`DELETE FROM article WHERE id = $1`, ['a1']);

    expect(repo.query(`SELECT id FROM article_review`)).toEqual([]);
  });

  // Every save reopens the connection, whether the write that follows it
  // succeeds or not, and a transaction saves once where a mutate saves per
  // statement.
  it('enforces foreign keys after any run of saves, failed writes included', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const step = fc.record({
      viaTransaction: fc.boolean(),
      writeFails: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 6 }),
        async (steps) => {
          const { repo, writeBinary } = await makeSavingRepo();

          for (const [i, { viaTransaction, writeFails }] of steps.entries()) {
            if (writeFails)
              writeBinary.mockRejectedValueOnce(new Error('disk full'));
            const write = () => {
              insertArticle(repo, `a${i}`);
              insertArticleReview(repo, `r${i}`, `a${i}`);
            };
            if (viaTransaction) {
              await repo.transaction(async () => write()).catch(() => {});
            } else {
              write();
            }
            expect(foreignKeysPragma(repo)).toBe(1);
          }

          repo.mutate(`DELETE FROM article`);
          expect(repo.query(`SELECT id FROM article_review`)).toEqual([]);
        }
      ),
      { numRuns: 25 }
    );
  });
});

describe('mutate error propagation', () => {
  let repo: TestRepository;

  beforeEach(async () => {
    ({ repo } = await makeRepo());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A write that silently resolves to [] is indistinguishable from one that
  // returned no rows, so callers could record undo entries for writes the
  // database rejected.
  it('throws when a write violates a constraint', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    insertArticle(repo, 'a1');

    expect(() => insertArticle(repo, 'a1')).toThrow();
  });

  it('throws on malformed SQL', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => repo.mutate('UPDATE nonexistent_table SET x = 1')).toThrow();
  });

  // Reads keep their empty-array fallback: many callers rely on it.
  it('still resolves reads of a missing table to an empty result', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(repo.query('SELECT * FROM nonexistent_table')).toEqual([]);
  });
});

describe('transaction', () => {
  let repo: TestRepository;

  beforeEach(async () => {
    ({ repo } = await makeRepo());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('commits every write when the callback resolves', async () => {
    await repo.transaction(async () => {
      insertArticle(repo, 'a1', 30);
      repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [40, 'a1']);
    });

    const rows = repo.query('SELECT priority FROM article WHERE id = $1', [
      'a1',
    ]);
    expect(rows).toEqual([{ priority: 40 }]);
  });

  it('returns the callback result', async () => {
    const result = await repo.transaction(async () => 'done');

    expect(result).toBe('done');
  });

  // The reason the review mutators are wrapped: a due date must never move
  // without the review row that justifies it.
  it('rolls back earlier writes when a later one fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    insertArticle(repo, 'a1', 30);

    await expect(
      repo.transaction(async () => {
        repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [
          40,
          'a1',
        ]);
        repo.mutate('INSERT INTO nonexistent_table VALUES (1)');
      })
    ).rejects.toThrow();

    const rows = repo.query('SELECT priority FROM article WHERE id = $1', [
      'a1',
    ]);
    expect(rows).toEqual([{ priority: 30 }]);
  });

  it('rolls back when the callback throws without any failed statement', async () => {
    insertArticle(repo, 'a1', 30);

    await expect(
      repo.transaction(async () => {
        repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [
          40,
          'a1',
        ]);
        throw new Error('caller aborted');
      })
    ).rejects.toThrow('caller aborted');

    const rows = repo.query('SELECT priority FROM article WHERE id = $1', [
      'a1',
    ]);
    expect(rows).toEqual([{ priority: 30 }]);
  });

  it('leaves the database writable after a rollback', async () => {
    insertArticle(repo, 'a1', 30);
    await expect(
      repo.transaction(async () => {
        throw new Error('aborted');
      })
    ).rejects.toThrow();

    expect(() =>
      repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [40, 'a1'])
    ).not.toThrow();
    expect(
      repo.query('SELECT priority FROM article WHERE id = $1', ['a1'])
    ).toEqual([{ priority: 40 }]);
  });

  // Subscribers refresh the queue from these events; a rolled-back row that
  // emitted would leave the UI showing state the database never held.
  it('emits no change events when the transaction rolls back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    await expect(
      repo.transaction(async () => {
        insertArticle(repo, 'a1');
        repo.mutate('INSERT INTO nonexistent_table VALUES (1)');
      })
    ).rejects.toThrow();

    expect(events).toEqual([]);
  });

  it('emits buffered change events once after commit', async () => {
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    await repo.transaction(async () => {
      insertArticle(repo, 'a1');
      insertArticle(repo, 'a2');
    });

    expect(events).toEqual([
      { table: 'article', op: 'insert', ids: ['a1', 'a2'] },
    ]);
  });

  // sql.js `save()` exports and rewrites the whole database file, so doing it
  // per statement inside a transaction would also serialize uncommitted state.
  it('saves once per transaction rather than once per statement', async () => {
    const { repo: savingRepo } = await makeSavingRepo();
    const writeBinary = savingRepo.app.vault.adapter.writeBinary as ReturnType<
      typeof vi.fn
    >;

    await savingRepo.transaction(async () => {
      savingRepo.mutate(
        `INSERT INTO article (id, reference, due, interval, priority)
         VALUES ($1, $2, $3, $4, $5)`,
        ['a1', 'articles/a1.md', Date.now(), 86_400_000, 30]
      );
      savingRepo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [
        40,
        'a1',
      ]);
    });

    expect(writeBinary).toHaveBeenCalledTimes(1);
  });

  it('does not write to disk when the transaction rolls back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo: savingRepo } = await makeSavingRepo();
    const writeBinary = savingRepo.app.vault.adapter.writeBinary as ReturnType<
      typeof vi.fn
    >;

    await expect(
      savingRepo.transaction(async () => {
        savingRepo.mutate(
          `INSERT INTO article (id, reference, due, interval, priority)
           VALUES ($1, $2, $3, $4, $5)`,
          ['a1', 'articles/a1.md', Date.now(), 86_400_000, 30]
        );
        throw new Error('aborted');
      })
    ).rejects.toThrow();

    expect(writeBinary).not.toHaveBeenCalled();
  });

  // SQLite has no nested transactions; an inner call joins the outer one so a
  // failure cannot be committed around.
  it('commits a nested transaction only with the outermost one', async () => {
    insertArticle(repo, 'a1', 30);

    await expect(
      repo.transaction(async () => {
        await repo.transaction(async () => {
          repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [
            40,
            'a1',
          ]);
        });
        throw new Error('outer aborted');
      })
    ).rejects.toThrow('outer aborted');

    const rows = repo.query('SELECT priority FROM article WHERE id = $1', [
      'a1',
    ]);
    expect(rows).toEqual([{ priority: 30 }]);
  });

  it('restores normal per-write behavior after a transaction commits', async () => {
    const events: DataChangeEvent[] = [];
    await repo.transaction(async () => {
      insertArticle(repo, 'a1');
    });
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [40, 'a1']);

    expect(events).toEqual([{ table: 'article', op: 'update', ids: ['a1'] }]);
  });

  // A nested call joins the outer transaction, so its writes inherit the same
  // deferral: nothing reaches disk or listeners until the outermost commits.
  it("defers a nested transaction's writes to the outermost commit", async () => {
    const { repo: savingRepo } = await makeSavingRepo();
    const writeBinary = savingRepo.app.vault.adapter.writeBinary as ReturnType<
      typeof vi.fn
    >;
    const events: DataChangeEvent[] = [];
    savingRepo.onDataChange((e) => events.push(e));

    await savingRepo.transaction(async () => {
      await savingRepo.transaction(async () => {
        savingRepo.mutate(
          `INSERT INTO article (id, reference, due, interval, priority)
           VALUES ($1, $2, $3, $4, $5)`,
          ['a1', 'articles/a1.md', Date.now(), 86_400_000, 30]
        );
      });
      // the inner call returned, but the outer transaction is still open
      expect(events).toEqual([]);
      expect(writeBinary).not.toHaveBeenCalled();
    });

    expect(events).toEqual([{ table: 'article', op: 'insert', ids: ['a1'] }]);
    expect(writeBinary).toHaveBeenCalledTimes(1);
  });

  // Miscounting the open-transaction depth leaves the repository permanently
  // convinced a transaction is running, silently dropping every later write.
  it('restores normal per-write behavior after a nested transaction commits', async () => {
    const events: DataChangeEvent[] = [];
    await repo.transaction(async () => {
      await repo.transaction(async () => {
        insertArticle(repo, 'a1');
      });
    });
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [40, 'a1']);

    expect(events).toEqual([{ table: 'article', op: 'update', ids: ['a1'] }]);
  });

  it('restores normal per-write behavior after a transaction rolls back', async () => {
    insertArticle(repo, 'a1', 30);
    await expect(
      repo.transaction(async () => {
        throw new Error('aborted');
      })
    ).rejects.toThrow('aborted');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [40, 'a1']);

    expect(events).toEqual([{ table: 'article', op: 'update', ids: ['a1'] }]);
  });

  it('rejects when the database is not initialized', async () => {
    repo.db = null;

    await expect(repo.transaction(async () => 'never')).rejects.toThrow(
      'Database was not initialized on repository'
    );
  });
});

describe('bulkMutate', () => {
  beforeEach(() => {
    // Yields through `window.setTimeout`, which this node environment lacks.
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes every statement in order, however they are chunked', async () => {
    await fc.assert(
      fc.asyncProperty(rowWritesArb(), sliceMsArb, async (writes, sliceMs) => {
        const { repo } = await makeBulkRepo();
        try {
          await repo.bulkMutate(writes.map(insertStatement), pace(sliceMs));

          expect(idsByTable(repo)).toEqual(expectedIdsByTable(writes));
        } finally {
          repo.db?.close();
        }
      })
    );
  });

  // Each save exports the whole database and rewrites its file, so saving per
  // statement turns a large import into hundreds of full rewrites.
  it('saves once per chunk of at most a slice of statements', async () => {
    await fc.assert(
      fc.asyncProperty(rowWritesArb(), sliceMsArb, async (writes, sliceMs) => {
        const { repo, writeBinary } = await makeBulkRepo();
        try {
          await repo.bulkMutate(writes.map(insertStatement), pace(sliceMs));

          const size = sliceMs ?? BATCHED_MUTATION_SLICE_MS;
          expect(writeBinary).toHaveBeenCalledTimes(
            chunksOf(writes, size).length
          );
        } finally {
          repo.db?.close();
        }
      })
    );
  });

  it("notifies listeners as each chunk commits, with that chunk's rows", async () => {
    await fc.assert(
      fc.asyncProperty(rowWritesArb(), sliceMsArb, async (writes, sliceMs) => {
        const { repo } = await makeBulkRepo();
        try {
          const events: DataChangeEvent[] = [];
          repo.onDataChange((event) => events.push(event));

          await repo.bulkMutate(writes.map(insertStatement), pace(sliceMs));

          const size = sliceMs ?? BATCHED_MUTATION_SLICE_MS;
          expect(events).toEqual(
            chunksOf(writes, size).flatMap(insertEventsFor)
          );
        } finally {
          repo.db?.close();
        }
      })
    );
  });

  it('on a failing statement, rolls back its chunk, keeps earlier chunks, and skips the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await fc.assert(
      fc.asyncProperty(
        rowWritesArb().chain((writes) =>
          fc.tuple(fc.constant(writes), fc.nat({ max: writes.length }))
        ),
        failingStatementArb,
        sliceMsArb,
        async ([writes, failAt], failing, sliceMs) => {
          const { repo, writeBinary } = await makeBulkRepo();
          try {
            const events: DataChangeEvent[] = [];
            repo.onDataChange((event) => events.push(event));
            const statements = writes.map(insertStatement);
            statements.splice(failAt, 0, failing);
            const size = sliceMs ?? BATCHED_MUTATION_SLICE_MS;
            // every chunk that ends before the failing statement
            const committed = writes.slice(0, Math.floor(failAt / size) * size);

            const error = await repo.bulkMutate(statements, pace(sliceMs)).then(
              () => null,
              (e: unknown) => e
            );

            expect(error).toBeInstanceOf(Error);
            expect(idsByTable(repo)).toEqual(expectedIdsByTable(committed));
            expect(writeBinary).toHaveBeenCalledTimes(
              chunksOf(committed, size).length
            );
            expect(events).toEqual(
              chunksOf(committed, size).flatMap(insertEventsFor)
            );
          } finally {
            repo.db?.close();
          }
        }
      )
    );
  });

  // A caller that did work per statement before the run, writing a note say,
  // must know which statements landed to take back the work of those that
  // didn't
  it('reports how many statements committed before a failing one, and why it stopped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await fc.assert(
      fc.asyncProperty(
        rowWritesArb().chain((writes) =>
          fc.tuple(fc.constant(writes), fc.nat({ max: writes.length }))
        ),
        failingStatementArb,
        sliceMsArb,
        async ([writes, failAt], failing, sliceMs) => {
          const { repo } = await makeBulkRepo();
          try {
            const statements = writes.map(insertStatement);
            statements.splice(failAt, 0, failing);
            const size = sliceMs ?? BATCHED_MUTATION_SLICE_MS;
            // every chunk that ends before the failing statement
            const committed = Math.floor(failAt / size) * size;
            // what the failing statement throws, run on its own
            const alone = await failureOf(
              Promise.resolve().then(() =>
                repo.mutate(failing.query, failing.params)
              )
            );

            const error = await failureOf(
              repo.bulkMutate(statements, pace(sliceMs))
            );

            expect(error).toBeInstanceOf(BulkMutateError);
            const {
              committed: reported,
              cause,
              message,
            } = error as BulkMutateError;
            expect(reported).toBe(committed);
            expect(rowCount(repo)).toBe(reported);
            expect(cause).toEqual(alone);
            expect(message).toBe(
              `Stopped after committing ${committed} of ${statements.length} statements`
            );
          } finally {
            repo.db?.close();
          }
        }
      )
    );
  });

  // Committed rows are in the database whether or not this save reached the
  // disk, and the next save writes them out
  it('counts a chunk whose save failed as committed, and stops there', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await fc.assert(
      fc.asyncProperty(
        rowWritesArb({ minLength: 1 }),
        sliceMsArb,
        fc.nat(),
        async (writes, sliceMs, failingSave) => {
          const { repo, writeBinary } = await makeBulkRepo();
          try {
            const size = sliceMs ?? BATCHED_MUTATION_SLICE_MS;
            const chunks = chunksOf(writes, size);
            const failing = failingSave % chunks.length;
            const diskFull = new Error('disk full');
            writeBinary.mockImplementation(async () => {
              if (writeBinary.mock.calls.length === failing + 1) throw diskFull;
            });
            const committed = chunks
              .slice(0, failing + 1)
              .reduce((sum, chunk) => sum + chunk.length, 0);

            const error = await failureOf(
              repo.bulkMutate(writes.map(insertStatement), pace(sliceMs))
            );

            expect(error).toBeInstanceOf(BulkMutateError);
            expect((error as BulkMutateError).committed).toBe(committed);
            expect((error as BulkMutateError).cause).toBe(diskFull);
            expect(rowCount(repo)).toBe(committed);
            expect(writeBinary).toHaveBeenCalledTimes(failing + 1);
          } finally {
            repo.db?.close();
          }
        }
      )
    );
  });

  // Saving pauses when Sync starts rewriting the file, which can happen
  // between any two chunks
  it('reports the chunks committed before writes were refused, and the refusal', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowWritesArb(),
        sliceMsArb,
        fc.nat(),
        async (writes, sliceMs, refuseAfter) => {
          const { repo, writeBinary } = await makeBulkRepo();
          try {
            const size = sliceMs ?? BATCHED_MUTATION_SLICE_MS;
            const chunks = chunksOf(writes, size);
            // after how many saves, from none to every one
            const saves = refuseAfter % (chunks.length + 1);
            const paused = new Error('Saving is paused.');
            if (saves === 0) repo.refuseWrites(paused);
            writeBinary.mockImplementation(async () => {
              if (writeBinary.mock.calls.length === saves) {
                repo.refuseWrites(paused);
              }
            });
            const committed = Math.min(saves * size, writes.length);

            const error = await failureOf(
              repo.bulkMutate(writes.map(insertStatement), pace(sliceMs))
            );

            expect(rowCount(repo)).toBe(committed);
            if (committed === writes.length) {
              expect(error).toBeNull();
              return;
            }
            expect(error).toBeInstanceOf(BulkMutateError);
            expect((error as BulkMutateError).committed).toBe(committed);
            expect((error as BulkMutateError).cause).toBe(paused);
          } finally {
            repo.db?.close();
          }
        }
      )
    );
  });

  it('keeps what stopped it, however that was thrown', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.anything({ withNullPrototype: true }),
        async (thrown) => {
          const { repo } = await makeBulkRepo();
          try {
            vi.spyOn(repo, 'mutate').mockImplementation(() => {
              // Anything can be thrown, an Error or not
              throw thrown;
            });

            const error = await failureOf(
              repo.bulkMutate([insertStatement({ table: 'article', id: 'a' })])
            );

            expect(error).toBeInstanceOf(BulkMutateError);
            expect((error as BulkMutateError).cause).toBe(thrown);
            expect((error as BulkMutateError).committed).toBe(0);
          } finally {
            vi.restoreAllMocks();
            repo.db?.close();
          }
        }
      )
    );
  });

  // Why each chunk is its own transaction with a yield after it: one held open
  // across the run would take in any unrelated write made meanwhile — a review
  // grade, say — and roll it back along with a failed chunk.
  it('lets other work run between chunks, outside any transaction', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo } = await makeRepo();
    let idsSeenBetweenChunks: string[] | null = null;

    const run = repo.bulkMutate(
      [
        { query: INSERT_ARTICLE_SQL, params: articleRow('a1') },
        { query: INSERT_ARTICLE_SQL, params: articleRow('a2') },
        { query: INSERT_ARTICLE_SQL, params: articleRow('a3') },
        { query: 'INSERT INTO nonexistent_table VALUES (1)' },
      ],
      pace(2)
    );
    setTimeout(() => {
      idsSeenBetweenChunks = articleIds(repo);
      insertArticleRow(repo, 'unrelated');
    }, 0);

    await expect(run).rejects.toThrow();
    expect(idsSeenBetweenChunks).toEqual(['a1', 'a2']);
    expect(articleIds(repo).sort()).toEqual(['a1', 'a2', 'unrelated']);
  });

  it('rejects a slice that is not a positive, finite number, writing nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowWritesArb(),
        fc.oneof(
          // zero, negatives and -0
          fc.double({ max: 0, noNaN: true, noDefaultInfinity: true }),
          fc.constantFrom(NaN, Infinity, -Infinity)
        ),
        async (writes, sliceMs) => {
          const { repo, writeBinary } = await makeBulkRepo();
          try {
            const error = await repo
              .bulkMutate(writes.map(insertStatement), pace(sliceMs))
              .then(
                () => null,
                (e: unknown) => e
              );

            expect(error).toBeInstanceOf(RangeError);
            // names the argument and the value it refused
            expect((error as RangeError).message).toContain('sliceMs');
            expect((error as RangeError).message).toContain(String(sliceMs));
            expect(idsByTable(repo)).toEqual(expectedIdsByTable([]));
            expect(writeBinary).not.toHaveBeenCalled();
          } finally {
            repo.db?.close();
          }
        }
      )
    );
  });

  // Every yield costs a frame or more, and nothing is waiting on the thread
  // once the last chunk has committed
  it('hands the thread back between chunks, but not after the last', async () => {
    const { repo } = await makeBulkRepo();
    try {
      let macrotaskRan = false;
      setTimeout(() => (macrotaskRan = true), 0);

      await repo.bulkMutate(
        [insertStatement({ table: 'article', id: 'a1' })],
        pace(1)
      );

      // One statement is one chunk: a trailing yield would have let the timer
      // above go first
      expect(macrotaskRan).toBe(false);
    } finally {
      repo.db?.close();
    }
  });

  // A budget is a duration, so unlike the statement count it replaced it has no
  // reason to be a whole number
  it('accepts a fractional slice', async () => {
    const { repo } = await makeBulkRepo();
    try {
      await repo.bulkMutate([insertStatement({ table: 'article', id: 'a1' })], {
        sliceMs: 0.5,
      });

      expect(idsByTable(repo)).toEqual(
        expectedIdsByTable([{ table: 'article', id: 'a1' }])
      );
    } finally {
      repo.db?.close();
    }
  });
});

// On a vault with Obsidian Sync running, a second writer rewrites the database
// file at arbitrary times. Obsidian reports that as a `modify` event, and
// `handleFileChange` answers it by reloading — replacing `this.db` wholesale.
//
// `mutate` used to save after every statement, so `pendingSaveCount` was
// non-zero for most of a write burst and the reload was usually suppressed.
// Inside a transaction it no longer saves, so the count stays at zero from
// BEGIN until COMMIT and nothing stands between an incoming reload and a
// half-finished transaction.
describe('external sync while a transaction is open', () => {
  beforeEach(() => {
    // A failed statement and a failed reload both log. Here those failures are
    // the subject of the test, not noise worth printing.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Control: proves the harness really does swap the database out, so the
  // failures below cannot be an artifact of the fake vault.
  it('replaces the in-memory database when a sync lands outside a transaction', async () => {
    const repo = await SyncedTestRepository.create();
    insertArticleRow(repo, 'local-1');
    await repo.settleSaves();

    repo.beginSync(await fileOver(repo.diskBytes, ['remote-1']));
    await repo.landSync();

    expect(articleIds(repo)).toEqual(['remote-1']);
  });

  // The reason the review mutators are wrapped in a transaction at all: an
  // article whose due date moved without the review row that justifies it has
  // been rescheduled off a review that never happened.
  it('commits every write when a sync reload lands between two of them', async () => {
    const repo = await SyncedTestRepository.create();
    const remote = await remoteDbBytes(['remote-1']);

    await repo.transaction(async () => {
      insertArticleRow(repo, 'local-1');
      repo.beginSync(remote);
      await repo.landSync();
      insertArticleRow(repo, 'local-2');
    });

    expect(articleIds(repo)).toEqual(
      expect.arrayContaining(['local-1', 'local-2'])
    );
  });

  // Weaker than the above, and still required of any fix that answers a
  // mid-transaction reload by failing the transaction instead of surviving it.
  it('leaves no partial transaction behind when a sync reload lands mid-transaction', async () => {
    const repo = await SyncedTestRepository.create();
    const remote = await remoteDbBytes(['remote-1']);
    let rejected = false;

    await repo
      .transaction(async () => {
        insertArticleRow(repo, 'local-1');
        repo.beginSync(remote);
        await repo.landSync();
        insertArticleRow(repo, 'local-2');
      })
      .catch(() => {
        rejected = true;
      });

    const present = articleIds(repo);
    const applied = ['local-1', 'local-2'].filter((id) => present.includes(id));
    expect(applied).toEqual(rejected ? [] : ['local-1', 'local-2']);
  });

  // A transaction saves once, after COMMIT. If the reload derails it before
  // then, the writes live only in memory and the next reload erases them.
  it('persists a committed transaction whose writes all follow a sync reload', async () => {
    const repo = await SyncedTestRepository.create();
    const remote = await remoteDbBytes(['remote-1']);

    await repo.transaction(async () => {
      repo.beginSync(remote);
      await repo.landSync();
      insertArticleRow(repo, 'local-1');
    });

    expect(await repo.articleIdsOnDisk()).toContain('local-1');
  });

  // The caller decides what to do about its own failure, so its error has to
  // survive the rollback rather than being replaced by one from the plumbing.
  it("reports the caller's error when a sync reload precedes an abort", async () => {
    const repo = await SyncedTestRepository.create();
    const remote = await remoteDbBytes(['remote-1']);

    await expect(
      repo.transaction(async () => {
        insertArticleRow(repo, 'local-1');
        repo.beginSync(remote);
        await repo.landSync();
        throw new Error('caller aborted');
      })
    ).rejects.toThrow('caller aborted');

    expect(articleIds(repo)).not.toContain('local-1');
  });

  // Holding a reload back must not mean dropping it — the peer's rows still
  // have to arrive once the transaction is out of the way. Asserted on the
  // rollback path, where nothing was saved and the file still holds them.
  it('applies a held-back sync reload once the transaction settles', async () => {
    const repo = await SyncedTestRepository.create();

    await expect(
      repo.transaction(async () => {
        insertArticleRow(repo, 'local-1');
        repo.beginSync(await remoteDbBytes(['remote-1']));
        await repo.landSync();
        throw new Error('caller aborted');
      })
    ).rejects.toThrow('caller aborted');

    await repo.settleSync();

    expect(articleIds(repo)).toEqual(['remote-1']);
  });

  // The depth counter that holds the reload back is shared with nested calls,
  // so a reload that arrives inside one must survive until the outermost ends.
  it('holds a sync reload back for the whole of a nested transaction', async () => {
    const repo = await SyncedTestRepository.create();

    await repo.transaction(async () => {
      await repo.transaction(async () => {
        repo.beginSync(await remoteDbBytes(['remote-1']));
        await repo.landSync();
        insertArticleRow(repo, 'local-1');
      });
      insertArticleRow(repo, 'local-2');
    });

    expect(articleIds(repo)).toEqual(
      expect.arrayContaining(['local-1', 'local-2'])
    );
    await repo.settleSync();
  });

  it('stays writable after a sync reload interrupts a transaction', async () => {
    const repo = await SyncedTestRepository.create();
    const remote = await remoteDbBytes(['remote-1']);

    await repo
      .transaction(async () => {
        insertArticleRow(repo, 'local-1');
        repo.beginSync(remote);
        await repo.landSync();
      })
      .catch(() => {});

    insertArticleRow(repo, 'local-2');
    await repo.settleSaves();
    expect(await repo.articleIdsOnDisk()).toContain('local-2');

    await repo.transaction(async () => {
      insertArticleRow(repo, 'local-3');
    });
    expect(articleIds(repo)).toContain('local-3');
  });

  // The reload reads the file before it can tell whether a transaction is
  // open, and one can open while the read is under way.
  it('holds back a reload whose read was under way when a transaction opened', async () => {
    const repo = await SyncedTestRepository.create();
    insertArticleRow(repo, 'local-0');
    await repo.settleSaves();
    repo.beginSync(await remoteDbBytes(['remote-1']));

    await repo.transaction(async () => {
      insertArticleRow(repo, 'local-1');
      await repo.landSync();
      insertArticleRow(repo, 'local-2');
    });

    expect(articleIds(repo)).toEqual(
      expect.arrayContaining(['local-0', 'local-1', 'local-2'])
    );
    await repo.settleSync();
  });

  // Subscribers refresh the review queue from these events. An id the reload
  // discarded would leave the queue showing a row the database does not hold.
  it('never announces a row the reload discarded', async () => {
    const repo = await SyncedTestRepository.create();
    const remote = await remoteDbBytes(['remote-1']);
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    await repo
      .transaction(async () => {
        insertArticleRow(repo, 'local-1');
        repo.beginSync(remote);
        await repo.landSync();
        insertArticleRow(repo, 'local-2');
      })
      .catch(() => {});

    const present = articleIds(repo);
    for (const event of events) {
      for (const id of event.ids) expect(present).toContain(id);
    }
  });
});

describe('external sync while a transaction is open (model-based)', () => {
  /**
   * What the caller believes about the open transaction. The real system is a
   * repository whose database file a second writer is rewriting underneath it.
   */
  type SyncModel = {
    /** Ids the open transaction has written. */
    txWrites: string[];
    /** Whether a reload has been triggered and is waiting to land. */
    syncInFlight: boolean;
  };

  class InsertArticle
    implements fc.AsyncCommand<SyncModel, SyncedTestRepository>
  {
    constructor(readonly id: string) {}
    check(model: Readonly<SyncModel>): boolean {
      // Re-inserting an id violates the UNIQUE reference, which would fail the
      // transaction for a reason that has nothing to do with sync.
      return !model.txWrites.includes(this.id);
    }
    async run(model: SyncModel, repo: SyncedTestRepository) {
      insertArticleRow(repo, this.id);
      model.txWrites.push(this.id);
    }
    toString() {
      return `insert(${this.id})`;
    }
  }

  class StartSync implements fc.AsyncCommand<SyncModel, SyncedTestRepository> {
    constructor(readonly remoteIds: string[]) {}
    check(model: Readonly<SyncModel>): boolean {
      return !model.syncInFlight;
    }
    async run(model: SyncModel, repo: SyncedTestRepository) {
      repo.beginSync(await remoteDbBytes(this.remoteIds));
      model.syncInFlight = true;
    }
    toString() {
      return `startSync(${this.remoteIds.join('+')})`;
    }
  }

  class LandSync implements fc.AsyncCommand<SyncModel, SyncedTestRepository> {
    check(model: Readonly<SyncModel>): boolean {
      return model.syncInFlight;
    }
    async run(model: SyncModel, repo: SyncedTestRepository) {
      await repo.landSync();
      model.syncInFlight = false;
    }
    toString() {
      return 'landSync()';
    }
  }

  /**
   * Recorded rather than thrown: throwing here would abort the transaction and
   * the run would report a rollback instead of the read that went missing.
   */
  class ReadBack implements fc.AsyncCommand<SyncModel, SyncedTestRepository> {
    check(): boolean {
      return true;
    }
    async run(model: SyncModel, repo: SyncedTestRepository) {
      const present = articleIds(repo);
      repo.readBackFailures.push(
        ...model.txWrites.filter((id) => !present.includes(id))
      );
    }
    toString() {
      return 'readBack()';
    }
  }

  const LOCAL_IDS = ['local-1', 'local-2', 'local-3'];
  const REMOTE_IDS = ['remote-1', 'remote-2'];

  const syncCommands: fc.Arbitrary<
    fc.AsyncCommand<SyncModel, SyncedTestRepository>
  >[] = [
    fc.constantFrom(...LOCAL_IDS).map((id) => new InsertArticle(id)),
    fc.subarray(REMOTE_IDS, { minLength: 1 }).map((ids) => new StartSync(ids)),
    fc.constant(new LandSync()),
    fc.constant(new ReadBack()),
  ];

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: a transaction is all-or-nothing however a sync reload interleaves with it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(syncCommands, { maxCommands: 6 }),
        fc.boolean(),
        async (cmds, callerAborts) => {
          const repo = await SyncedTestRepository.create();
          const events: DataChangeEvent[] = [];
          repo.onDataChange((e) => events.push(e));
          const model: SyncModel = { txWrites: [], syncInFlight: false };

          let rejected = false;
          await repo
            .transaction(async () => {
              await fc.asyncModelRun(() => ({ model, real: repo }), cmds);
              if (callerAborts) throw new Error('caller aborted');
            })
            .catch(() => {
              rejected = true;
            });

          // A reload may still be parked; let it finish so the run settles.
          await repo.settleSync();
          const present = articleIds(repo);

          // Only the caller may fail a transaction. A reload arriving
          // mid-flight is not something the caller can act on.
          expect(rejected).toBe(callerAborts);

          // Every write, or none of them — never a subset.
          const applied = model.txWrites.filter((id) => present.includes(id));
          expect(applied).toEqual(callerAborts ? [] : model.txWrites);

          // An open transaction sees its own writes for as long as it is open.
          expect(repo.readBackFailures).toEqual([]);

          // A committed transaction reached the file, not just memory.
          if (!callerAborts) {
            expect(await repo.articleIdsOnDisk()).toEqual(
              expect.arrayContaining(model.txWrites)
            );
          }

          // No listener hears about a row the database does not hold.
          for (const event of events) {
            for (const id of event.ids) expect(present).toContain(id);
          }

          repo.db?.close();
        }
      )
    );
  });
});

describe('start', () => {
  beforeEach(() => {
    stubWasm();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: loads the database file on disk whatever the vault index reports', async () => {
    await fc.assert(
      fc.asyncProperty(indexViewArb, articleIdsArb, async (index, ids) => {
        const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(ids)]]);
        const { app } = makeVault(index, files);

        const repo = await startRepo(app);

        expect(articleIds(repo).sort()).toEqual([...ids].sort());
        repo.db?.close();
      })
    );
  });

  it('property: starts on an empty database, writing nothing, when no file is on disk', async () => {
    await fc.assert(
      fc.asyncProperty(indexViewArb, async (index) => {
        const { app, adapter } = makeVault(index);

        const repo = await startRepo(app);

        expect(articleIds(repo)).toEqual([]);
        expect(adapter.writeBinary).not.toHaveBeenCalled();
        repo.db?.close();
      })
    );
  });

  it('property: refuses to start, writing nothing, when the file on disk cannot be loaded', async () => {
    await fc.assert(
      fc.asyncProperty(indexViewArb, unloadableFileArb, async (index, file) => {
        const bytes = await unloadableBytes(file);
        const files = new Map([[DATABASE_FILE_PATH, bytes]]);
        const { app, adapter } = makeVault(index, files);

        await expect(startRepo(app)).rejects.toThrow();

        // The very bytes it started with: a write would have replaced them.
        // Compared by identity, since deep-comparing a database's worth of
        // bytes costs a third of a second a run.
        expect(files.get(DATABASE_FILE_PATH)).toBe(bytes);
        // Nor a backup of it: there is nothing in it to restore
        expect(adapter.writeBinary).not.toHaveBeenCalled();
      })
    );
  });

  it('property: migrates a v9 file, keeping every row and backing it up', async () => {
    await fc.assert(
      fc.asyncProperty(indexViewArb, articleIdsArb, async (index, ids) => {
        const files = new Map([[DATABASE_FILE_PATH, await staleFileWith(ids)]]);
        const { app, adapter } = makeVault(index, files);

        const repo = await startRepo(app);

        expect(articleIds(repo).sort()).toEqual([...ids].sort());
        expect((await idsInFile(files)).sort()).toEqual([...ids].sort());
        expect(backupWrites(adapter)).toHaveLength(1);
        repo.db?.close();
      })
    );
  });

  it('leaves the rows a migration carries over unstamped, then stamps the next write to each', async () => {
    const files = new Map([
      [DATABASE_FILE_PATH, await staleFileWith(['a', 'b'])],
    ]);
    const { app } = makeVault(INDEXED, files);
    const repo = await startRepo(app);
    const stamps = () =>
      repo.db!.exec(
        'SELECT id, updated_at > 0, updated_by != $1 FROM article ORDER BY id',
        ['']
      )[0].values;
    expect(stamps()).toEqual([
      ['a', 0, 0],
      ['b', 0, 0],
    ]);

    repo.mutate(`UPDATE article SET priority = 40 WHERE id = 'a'`);

    expect(stamps()).toEqual([
      ['a', 1, 1],
      ['b', 0, 0],
    ]);
    repo.db?.close();
  });

  it('stamps nothing a migration writes, which is no deviceâ€™s edit', async () => {
    // A migration still to come, that rewrites a row the file already stamps
    migrations.push({
      version: LATEST_VERSION + 1,
      description: 'test-only rewrite',
      up: (db) => db.exec(`UPDATE article SET priority = 40`),
    });
    onTestFinished(() => void migrations.pop());
    const SQL = await getSharedSql();
    const db = new SQL.Database(await dbFileWith(['a']));
    db.exec(`UPDATE article SET updated_at = 7, updated_by = 'device-b'`);
    const files = new Map([[DATABASE_FILE_PATH, db.export()]]);
    db.close();
    const { app } = makeVault(INDEXED, files);

    const repo = await startRepo(app);

    expect(
      repo.db!.exec('SELECT priority, updated_at, updated_by FROM article')[0]
        .values
    ).toEqual([[40, 7, 'device-b']]);
    repo.db?.close();
  });

  it('stamps writes on the connection each save reopens, and saves no trigger into the file', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const { app } = makeVault(INDEXED, files);
    const repo = await startRepo(app);
    const stampOf = (db: { exec: Database['exec'] }) =>
      db.exec(`SELECT updated_at FROM article WHERE id = 'a'`)[0].values[0][0];

    const stamps: unknown[] = [];
    for (const priority of [40, 20]) {
      repo.mutate(`UPDATE article SET priority = $1 WHERE id = 'a'`, [
        priority,
      ]);
      await settle();
      stamps.push(stampOf(repo.db!));
    }

    expect(stamps[0]).toBeGreaterThan(0);
    expect(stamps[1]).toBeGreaterThan(stamps[0] as number);
    const SQL = await getSharedSql();
    const saved = new SQL.Database(files.get(DATABASE_FILE_PATH));
    expect(stampOf(saved)).toBe(stamps[1]);
    expect(
      saved.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
    ).toEqual([]);
    saved.close();
    repo.db?.close();
  });

  it('refuses to start, leaving the file as it was, when migrating it loses data', async () => {
    failMigrationVerification();
    const stale = await staleFileWith(['a']);
    const files = new Map([[DATABASE_FILE_PATH, stale]]);
    const { app } = makeVault(INDEXED, files);

    await expect(startRepo(app)).rejects.toBeInstanceOf(
      MigrationVerificationError
    );
    expect(files.get(DATABASE_FILE_PATH)).toBe(stale);
  });

  it('names the file it could not load in the error it refuses to start with', async () => {
    const files = new Map([[DATABASE_FILE_PATH, new Uint8Array([0])]]);
    const { app } = makeVault(INDEXED, files);

    const error = await startRepo(app).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DatabaseLoadError);
    expect(error).toMatchObject({
      name: 'DatabaseLoadError',
      dbFilePath: DATABASE_FILE_PATH,
      message: `Db file found at ${DATABASE_FILE_PATH}, but failed to load`,
    });
  });

  it('says why a file too short to hold a database was refused', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const files = new Map([[DATABASE_FILE_PATH, new Uint8Array([0])]]);
    const { app } = makeVault(INDEXED, files);

    await expect(startRepo(app)).rejects.toThrow();

    expect(errors).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'the file holds no database' })
    );
  });

  it('enforces foreign keys on the database it loads', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith([])]]);
    const { app } = makeVault(INDEXED, files);
    const repo = await startRepo(app);

    expect(() =>
      repo.mutate(
        `INSERT INTO article_review (id, article_id, review_time)
         VALUES ('r', 'no-such-article', 0)`
      )
    ).toThrow(/FOREIGN KEY/);
    repo.db?.close();
  });

  it('refuses to start when no file is on disk and no database can be created', async () => {
    const { app, adapter } = makeVault({ folder: true, file: false });

    await expect(startRepo(app, { schema: 'not a statement' })).rejects.toThrow(
      /create a database/
    );
    expect(adapter.writeBinary).not.toHaveBeenCalled();
  });

  it('property: a database started without a file saves every write, however many land together', async () => {
    await fc.assert(
      fc.asyncProperty(
        indexViewArb,
        articleIdsArb.filter((ids) => ids.length > 0),
        fc.boolean(),
        async (index, ids, slowExists) => {
          const { app, files } = makeVault(index, new Map(), slowExists);
          const onWriteBlocked = vi.fn();
          const repo = await startRepo(app, { onWriteBlocked });

          // Not awaited between writes: each save is still in flight when the
          // next write starts its own.
          for (const id of ids) insertArticleRow(repo, id);
          await settle();

          expect(onWriteBlocked).not.toHaveBeenCalled();
          expect((await idsInFile(files)).sort()).toEqual([...ids].sort());
          repo.db?.close();
        }
      ),
      {
        // Each run builds a database from the full schema and exports it once
        // per write, ~6ms of CPU: 100 runs took ~0.5s alone and passed the
        // 5s timeout on a loaded machine. Every index view and `exists` speed
        // runs first, with writes enough to queue behind the first save, so
        // the random runs only need to vary the ids and how many there are.
        numRuns: 32,
        examples: [true, false].flatMap((folder) =>
          [true, false].flatMap((file) =>
            [true, false].map((slowExists): [IndexView, string[], boolean] => [
              { folder, file },
              ['a', 'b', 'c'],
              slowExists,
            ])
          )
        ),
      }
    );
  });

  it('property: a database started without a file never saves over one that appears later', async () => {
    await fc.assert(
      fc.asyncProperty(
        indexViewArb,
        articleIdsArb,
        fc.uniqueArray(fc.constantFrom('local-1', 'local-2', 'local-3'), {
          minLength: 1,
        }),
        fc.boolean(),
        async (index, remoteIds, localIds, slowExists) => {
          const { app, files } = makeVault(index, new Map(), slowExists);
          const onWriteBlocked = vi.fn();
          const repo = await startRepo(app, { onWriteBlocked });
          // Brought down by Sync after startup, which Obsidian reports as a
          // `create` that the repository does not hear
          const arrived = await dbFileWith(remoteIds);
          files.set(DATABASE_FILE_PATH, arrived);

          insertArticleRow(repo, localIds[0]);
          await settle();

          expect(files.get(DATABASE_FILE_PATH)).toBe(arrived);
          expect(onWriteBlocked).toHaveBeenCalledOnce();
          expect((onWriteBlocked.mock.calls[0] as [Error])[0].message).toMatch(
            /appeared/
          );
          for (const id of localIds.slice(1)) {
            expect(() => insertArticleRow(repo, id)).toThrow();
          }
          await expect(repo.transaction(() => {})).rejects.toThrow();
          await settle();
          expect(files.get(DATABASE_FILE_PATH)).toBe(arrived);
          expect(onWriteBlocked).toHaveBeenCalledOnce();
          repo.db?.close();
        }
      )
    );
  });

  it('property: a database started without a file keeps every write made while its own first save is reported back', async () => {
    await fc.assert(
      fc.asyncProperty(
        indexViewArb,
        fc.boolean(),
        fc.nat({ max: 12 }),
        async (index, slowExists, hops) => {
          const { app, files, adapter } = makeVault(
            index,
            new Map(),
            slowExists
          );
          const onReloadFromDisk = vi.fn();
          const repo = await startRepo(app, { onReloadFromDisk });
          // Obsidian's adapter reports a file it wrote as created or modified
          // before the write settles (`reconcileInternalFile`), and the plugin
          // hands that event to `handleFileChange` unawaited
          adapter.writeBinary.mockImplementation(async (path, data) => {
            files.set(path, new Uint8Array(data.slice(0)));
            if (path === DATABASE_FILE_PATH) {
              void repo.handleFileChange(dbFileChange);
            }
          });
          // A disk read, finishing whenever the test lets it
          let release = () => {};
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          adapter.readBinary.mockImplementation(async (path) => {
            await released;
            const bytes = files.get(path);
            if (!bytes) throw new Error(`ENOENT: ${path}`);
            return bytes.slice().buffer;
          });

          insertArticleRow(repo, 'first');
          await settle();
          // The next write lands `hops` microtasks after any read finishes,
          // as a write can land at any moment relative to one
          release();
          for (let i = 0; i < hops; i++) await Promise.resolve();
          insertArticleRow(repo, 'second');
          await settle();

          expect(articleIds(repo).sort()).toEqual(['first', 'second']);
          expect((await idsInFile(files)).sort()).toEqual(['first', 'second']);
          // Its own save is no change to load
          expect(onReloadFromDisk).not.toHaveBeenCalled();
          repo.db?.close();
        }
      )
    );
  });
});

describe('start, holding for Sync', () => {
  beforeEach(() => {
    stubWasm();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: holds a migration, writing nothing until the hold ends, then loads the file as it is by then', async () => {
    await fc.assert(
      fc.asyncProperty(
        indexViewArb,
        articleIdsArb,
        deliveryArb,
        async (index, localIds, delivery) => {
          const stale = await staleFileWith(localIds);
          const files = new Map([[DATABASE_FILE_PATH, stale]]);
          const { app, adapter } = makeVault(index, files);
          const { hold, release } = makeHold();

          const starting = startRepo(app, { holdForSync: hold });
          await settle();
          expect(hold).toHaveBeenCalledOnce();
          expect(hold).toHaveBeenCalledWith('migrate');
          expect(adapter.writeBinary).not.toHaveBeenCalled();
          expect(files.get(DATABASE_FILE_PATH)).toBe(stale);

          const arrived = await deliveredBytes(delivery);
          if (arrived) files.set(DATABASE_FILE_PATH, arrived);
          release();
          const repo = await starting;

          const ids = delivery.kind === 'nothing' ? localIds : delivery.ids;
          expect(articleIds(repo).sort()).toEqual([...ids].sort());
          expect(hold).toHaveBeenCalledOnce();
          if (delivery.kind === 'current') {
            // Already migrated elsewhere: nothing to back up or save
            expect(adapter.writeBinary).not.toHaveBeenCalled();
            expect(files.get(DATABASE_FILE_PATH)).toBe(arrived);
          } else {
            expect(backupWrites(adapter)).toHaveLength(1);
            expect(await readVersion(files)).toBe(LATEST_VERSION);
            expect((await idsInFile(files)).sort()).toEqual([...ids].sort());
          }
          repo.db?.close();
        }
      )
    );
  });

  it('property: migrates the file it already read, reading it no more, when the hold went ahead at once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), articleIdsArb, async (hasFile, ids) => {
        const files = new Map<string, Uint8Array>(
          hasFile ? [[DATABASE_FILE_PATH, await staleFileWith(ids)]] : []
        );
        const { app, adapter } = makeVault(INDEXED, files);
        const hold = vi.fn(async () => 'at-once' as const);

        const repo = await startRepo(app, { holdForSync: hold });

        // A startup with no file has nothing to migrate, so never holds
        expect(hold).toHaveBeenCalledTimes(hasFile ? 1 : 0);
        expect(articleIds(repo).sort()).toEqual(hasFile ? [...ids].sort() : []);
        const dbReads = adapter.readBinary.mock.calls.filter(
          ([path]) => path === DATABASE_FILE_PATH
        );
        // Once to load and once to back up, with a file; never without
        expect(dbReads).toHaveLength(hasFile ? 2 : 0);
        expect(adapter.exists).toHaveBeenCalledTimes(hasFile ? 2 : 1);
        repo.db?.close();
      })
    );
  });

  it('looks for the file once when it has no hold to wait on', async () => {
    const { app, adapter } = makeVault(INDEXED);

    const repo = await startRepo(app);

    expect(adapter.exists).toHaveBeenCalledOnce();
    repo.db?.close();
  });

  it('property: never holds a startup with nothing to migrate', async () => {
    await fc.assert(
      fc.asyncProperty(indexViewArb, articleIdsArb, async (index, ids) => {
        const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(ids)]]);
        const { app } = makeVault(index, files);
        const hold = vi.fn(async () => 'at-once' as const);

        const repo = await startRepo(app, { holdForSync: hold });

        expect(hold).not.toHaveBeenCalled();
        expect(articleIds(repo).sort()).toEqual([...ids].sort());
        repo.db?.close();
      })
    );
  });

  it('property: never holds a startup over a file it cannot load', async () => {
    await fc.assert(
      fc.asyncProperty(unloadableFileArb, async (file) => {
        const files = new Map([
          [DATABASE_FILE_PATH, await unloadableBytes(file)],
        ]);
        const { app } = makeVault(INDEXED, files);
        const hold = vi.fn(async () => 'at-once' as const);

        await expect(startRepo(app, { holdForSync: hold })).rejects.toThrow(
          DatabaseLoadError
        );
        expect(hold).not.toHaveBeenCalled();
      })
    );
  });

  it('property: never holds a startup with no file, and takes in a copy Sync delivers after', async () => {
    await fc.assert(
      fc.asyncProperty(indexViewArb, deliveryArb, async (index, delivery) => {
        const { app, files } = makeVault(index);
        const hold = vi.fn(async () => 'waited' as const);
        const onWriteBlocked = vi.fn();

        const repo = await startRepo(app, {
          holdForSync: hold,
          onWriteBlocked,
        });

        expect(hold).not.toHaveBeenCalled();
        expect(repo.readiness).toBe('ready');
        expect(articleIds(repo)).toEqual([]);
        const arrived = await deliveredBytes(delivery);
        if (arrived) {
          files.set(DATABASE_FILE_PATH, arrived);
          await repo.handleFileChange(dbFileChange);
        }
        const ids = delivery.kind === 'nothing' ? [] : delivery.ids;
        expect(articleIds(repo).sort()).toEqual([...ids].sort());
        // A delivered file is this database's own, so writes save over it
        insertArticleRow(repo, 'later');
        await settle();
        expect(onWriteBlocked).not.toHaveBeenCalled();
        expect((await idsInFile(files)).sort()).toEqual(
          [...ids, 'later'].sort()
        );
        expect(hold).not.toHaveBeenCalled();
        repo.db?.close();
      })
    );
  });

  it('property: gives up starting, writing nothing, when the hold says not to go ahead', async () => {
    await fc.assert(
      fc.asyncProperty(articleIdsArb, async (ids) => {
        const stale = await staleFileWith(ids);
        const files = new Map<string, Uint8Array>([
          [DATABASE_FILE_PATH, stale],
        ]);
        const { app, adapter } = makeVault(INDEXED, files);

        const error = await startRepo(app, {
          holdForSync: async () => 'cancelled' as const,
        }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(StartupCancelledError);
        expect(error).toMatchObject({
          name: 'StartupCancelledError',
          message: 'Database startup was cancelled while waiting for Sync',
        });
        expect(adapter.writeBinary).not.toHaveBeenCalled();
        expect(files.get(DATABASE_FILE_PATH)).toBe(stale);
      })
    );
  });

  it('goes ahead with the migration when the hold itself fails', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await staleFileWith(['a'])]]);
    const { app } = makeVault(INDEXED, files);

    const failure = new Error('Sync internals changed');
    const repo = await startRepo(app, {
      holdForSync: async () => {
        throw failure;
      },
    });

    expect(console.error).toHaveBeenCalledWith(
      'Incremental Reading - Waiting for Sync failed:',
      failure
    );

    expect(articleIds(repo)).toEqual(['a']);
    expect(await readVersion(files)).toBe(LATEST_VERSION);
    repo.db?.close();
  });

  it('property: refuses to start, writing nothing, when the file Sync delivered cannot be loaded', async () => {
    await fc.assert(
      fc.asyncProperty(unloadableFileArb, async (file) => {
        const files = new Map<string, Uint8Array>([
          [DATABASE_FILE_PATH, await staleFileWith(['a'])],
        ]);
        const { app, adapter } = makeVault(INDEXED, files);
        const broken = await unloadableBytes(file);

        const error = await startRepo(app, {
          holdForSync: async () => {
            files.set(DATABASE_FILE_PATH, broken);
            return 'waited' as const;
          },
        }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DatabaseLoadError);
        expect(adapter.writeBinary).not.toHaveBeenCalled();
        expect(files.get(DATABASE_FILE_PATH)).toBe(broken);
      })
    );
  });

  it('property: starts on an empty database, writing nothing, when Sync deleted the file it waited on', async () => {
    await fc.assert(
      fc.asyncProperty(indexViewArb, articleIdsArb, async (index, ids) => {
        const files = new Map([[DATABASE_FILE_PATH, await staleFileWith(ids)]]);
        const { app, adapter } = makeVault(index, files);
        const onWriteBlocked = vi.fn();

        const repo = await startRepo(app, {
          onWriteBlocked,
          holdForSync: async () => {
            files.delete(DATABASE_FILE_PATH);
            return 'waited' as const;
          },
        });

        expect(articleIds(repo)).toEqual([]);
        expect(adapter.writeBinary).not.toHaveBeenCalled();
        // A database of its own, whose first write makes the file
        insertArticleRow(repo, 'new');
        await settle();
        expect(onWriteBlocked).not.toHaveBeenCalled();
        expect(await idsInFile(files)).toEqual(['new']);
        repo.db?.close();
      })
    );
  });

  it('property: leaves a started repository open when the signal aborts after startup', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), articleIdsArb, async (hasFile, ids) => {
        const files = new Map<string, Uint8Array>(
          hasFile ? [[DATABASE_FILE_PATH, await staleFileWith(ids)]] : []
        );
        const { app } = makeVault(INDEXED, files);
        const controller = new AbortController();
        const repo = await startRepo(app, {
          holdForSync: async () => 'at-once' as const,
          signal: controller.signal,
        });

        // Disposing of it is the plugin's job from here on
        controller.abort();

        expect(articleIds(repo).sort()).toEqual(hasFile ? [...ids].sort() : []);
        expect(() => insertArticleRow(repo, 'later')).not.toThrow();
        await settle();
        repo.db?.close();
      })
    );
  });

  it('property: a startup the plugin unloads under writes no database file and gives up', async () => {
    await fc.assert(
      fc.asyncProperty(articleIdsArb, abortPointArb, async (ids, abortAt) => {
        const stale = await staleFileWith(ids);
        const files = new Map<string, Uint8Array>([
          [DATABASE_FILE_PATH, stale],
        ]);
        const { app, adapter } = makeVault(INDEXED, files);
        const controller = new AbortController();
        if (abortAt.kind === 'before') controller.abort();
        const { hold, release } = makeHold();

        const starting = startRepo(app, {
          holdForSync: hold,
          signal: controller.signal,
        }).catch((e: unknown) => e);
        await settle();
        if (abortAt.kind === 'while-held') controller.abort();
        // The hold has said to go ahead, as it does when Sync settles at
        // the moment of the unload
        release('waited');
        if (abortAt.kind === 'after-hold') {
          for (let i = 0; i < abortAt.hops; i++) await Promise.resolve();
          controller.abort();
        }
        const outcome = await starting;

        const dbWrites = adapter.writeBinary.mock.calls.filter(
          ([path]) => path === DATABASE_FILE_PATH
        );
        if (outcome instanceof SQLJSRepository) {
          // Done before the unload, and the plugin's to dispose of from then
          // on: the abort leaves it open
          expect(abortAt.kind).toBe('after-hold');
          expect(articleIds(outcome).sort()).toEqual([...ids].sort());
          outcome.dispose();
        } else {
          expect(outcome).toBeInstanceOf(StartupCancelledError);
          expect(dbWrites).toHaveLength(0);
          expect(files.get(DATABASE_FILE_PATH)).toBe(stale);
        }
      })
    );
  });

  it('gives up a startup with no file, writing nothing, when the plugin unloaded before it began', async () => {
    const { app, adapter } = makeVault(INDEXED);
    const controller = new AbortController();
    controller.abort();

    const error = await startRepo(app, { signal: controller.signal }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(StartupCancelledError);
    expect(adapter.writeBinary).not.toHaveBeenCalled();
  });

  it('does not hold a merge after startup, even of a file that needs migrating', async () => {
    const { repo, files, hold } = await (async () => {
      const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
      const vault = makeVault(INDEXED, files);
      const hold = vi.fn(async () => 'at-once' as const);
      const repo = await startRepo(vault.app, { holdForSync: hold });
      return { repo, files, hold };
    })();
    files.set(DATABASE_FILE_PATH, await staleFileWith(['b']));

    await repo.handleFileChange(dbFileChange);

    expect(hold).not.toHaveBeenCalled();
    expect(articleIds(repo).sort()).toEqual(['a', 'b']);
    expect(await readVersion(files)).toBe(LATEST_VERSION);
    repo.db?.close();
  });
});

describe('reloading a file that changed on disk', () => {
  beforeEach(() => {
    stubWasm();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: keeps what it had, and stops saving, until the changed file can be loaded', async () => {
    await fc.assert(
      fc.asyncProperty(
        articleIdsArb,
        fc.oneof(unloadableFileArb, fc.constant(UNMIGRATABLE)),
        articleIdsArb,
        async (localIds, unloadable, laterIds) => {
          fc.pre(![...localIds, ...laterIds].includes('local-write'));
          const files = new Map([
            [DATABASE_FILE_PATH, await dbFileWith(localIds)],
          ]);
          const { app } = makeVault({ folder: true, file: true }, files);
          const onWriteBlocked = vi.fn();
          const onWritesResumed = vi.fn();
          const onReloadFromDisk = vi.fn();
          const repo = await startRepo(app, {
            onWriteBlocked,
            onWritesResumed,
            onReloadFromDisk,
          });

          const broken = await unloadableBytes(unloadable);
          files.set(DATABASE_FILE_PATH, broken);
          await repo.handleFileChange(dbFileChange);
          // A second change that fails the same way says nothing new
          await repo.handleFileChange(dbFileChange);

          expect(articleIds(repo).sort()).toEqual([...localIds].sort());
          expect(() => insertArticleRow(repo, 'local-write')).toThrow();
          await expect(repo.transaction(() => {})).rejects.toThrow();
          await settle();
          expect(files.get(DATABASE_FILE_PATH)).toBe(broken);
          expect(onWriteBlocked).toHaveBeenCalledOnce();
          expect((onWriteBlocked.mock.calls[0] as [Error])[0].message).toMatch(
            /could not be loaded/
          );
          expect(onReloadFromDisk).not.toHaveBeenCalled();
          expect(onWritesResumed).not.toHaveBeenCalled();

          files.set(DATABASE_FILE_PATH, await dbFileWith(laterIds));
          await repo.handleFileChange(dbFileChange);
          // Told once, as writes resume, and not again by a later reload
          files.set(DATABASE_FILE_PATH, await dbFileWith(laterIds));
          await repo.handleFileChange(dbFileChange);
          expect(onWritesResumed).toHaveBeenCalledOnce();

          expect(onReloadFromDisk).toHaveBeenCalledTimes(2);
          expect(articleIds(repo).sort()).toEqual([...laterIds].sort());
          insertArticleRow(repo, 'local-write');
          await settle();
          expect((await idsInFile(files)).sort()).toEqual(
            [...laterIds, 'local-write'].sort()
          );
          repo.db?.close();
        }
      )
    );
  });

  // Load-dependent: ~3s alone, past vitest's 5s default under the full suite
  it('property: merges a v9 file another device wrote, and keeps saving', async () => {
    await fc.assert(
      fc.asyncProperty(
        articleIdsArb,
        articleIdsArb,
        async (localIds, staleIds) => {
          fc.pre(!staleIds.includes('local-write'));
          const files = new Map([
            [DATABASE_FILE_PATH, await dbFileWith(localIds)],
          ]);
          const { app, adapter } = makeVault(INDEXED, files);
          const onReloadFromDisk = vi.fn();
          const repo = await startRepo(app, { onReloadFromDisk });

          files.set(DATABASE_FILE_PATH, await staleFileWith(staleIds));
          await repo.handleFileChange(dbFileChange);

          const merged = [...new Set([...localIds, ...staleIds])].sort();
          // Its rows are the unstamped rows both started from, so none of
          // this device's is lost, and only rows it lacked are written
          expect(onReloadFromDisk).toHaveBeenCalledTimes(
            staleIds.some((id) => !localIds.includes(id)) ? 1 : 0
          );
          expect(backupWrites(adapter)).toEqual([]);
          expect(articleIds(repo).sort()).toEqual(merged);
          insertArticleRow(repo, 'local-write');
          await settle();
          expect((await idsInFile(files)).sort()).toEqual(
            [...merged, 'local-write'].sort()
          );
          repo.db?.close();
        }
      )
    );
  }, 60_000);

  it.each([
    { handler: true, warned: 'the migration failure handler' },
    { handler: false, warned: 'onWriteBlocked' },
  ])(
    'stops saving when migrating a changed file it cannot merge loses data, warning through $warned',
    async ({ handler }) => {
      const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
      const { app } = makeVault(INDEXED, files);
      const onWriteBlocked = vi.fn();
      const onMigrationFailure = vi.fn();
      const repo = await startRepo(app, {
        onWriteBlocked,
        ...(handler ? { onMigrationFailure } : {}),
      });
      failMigrationVerification();
      // Taken on whole, so migrated as a load is, with its verification
      const stale = await unmergeable(await staleFileWith(['b']));
      files.set(DATABASE_FILE_PATH, stale);

      await repo.handleFileChange(dbFileChange);

      expect(articleIds(repo)).toEqual(['a']);
      expect(() => insertArticleRow(repo, 'c')).toThrow(
        MigrationVerificationError
      );
      await settle();
      expect(files.get(DATABASE_FILE_PATH)).toBe(stale);
      if (handler) {
        expect(onMigrationFailure).toHaveBeenCalledWith(
          expect.any(MigrationVerificationError)
        );
        expect(onWriteBlocked).not.toHaveBeenCalled();
      } else {
        expect(onWriteBlocked).toHaveBeenCalledWith(
          expect.any(MigrationVerificationError)
        );
      }
      repo.db?.close();
    }
  );

  it('migrates and saves a v9 file even while saving is refused', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const { app } = makeVault(INDEXED, files);
    const onWriteBlocked = vi.fn();
    const repo = await startRepo(app, { onWriteBlocked });
    files.set(DATABASE_FILE_PATH, new Uint8Array([0]));
    await repo.handleFileChange(dbFileChange);
    expect(onWriteBlocked).toHaveBeenCalledOnce();

    files.set(DATABASE_FILE_PATH, await staleFileWith(['b']));
    await repo.handleFileChange(dbFileChange);

    expect(await readVersion(files)).toBe(LATEST_VERSION);
    insertArticleRow(repo, 'c');
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['b', 'c']);
    repo.db?.close();
  });

  it('keeps saving when a reload succeeds but what runs after it fails', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const { app } = makeVault(INDEXED, files);
    const onWriteBlocked = vi.fn();
    const repo = await startRepo(app, {
      onWriteBlocked,
      onReloadFromDisk: () => {
        throw new Error('a listener failed');
      },
    });
    files.set(DATABASE_FILE_PATH, await dbFileWith(['b']));

    await repo.handleFileChange(dbFileChange);
    insertArticleRow(repo, 'c');
    await settle();

    expect(onWriteBlocked).not.toHaveBeenCalled();
    expect((await idsInFile(files)).sort()).toEqual(['b', 'c']);
    repo.db?.close();
  });

  it('property: a database started without a file takes on one that arrives, and saves over it from then on', async () => {
    await fc.assert(
      fc.asyncProperty(articleIdsArb, async (remoteIds) => {
        fc.pre(!remoteIds.includes('local-write'));
        const { app, files } = makeVault(INDEXED);
        const onWriteBlocked = vi.fn();
        const repo = await startRepo(app, { onWriteBlocked });
        files.set(DATABASE_FILE_PATH, await dbFileWith(remoteIds));

        await repo.handleFileChange(dbFileChange);
        insertArticleRow(repo, 'local-write');
        await settle();

        expect(onWriteBlocked).not.toHaveBeenCalled();
        expect((await idsInFile(files)).sort()).toEqual(
          [...remoteIds, 'local-write'].sort()
        );
        repo.db?.close();
      })
    );
  });

  it('closes the database a reload replaced', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const { app } = makeVault(INDEXED, files);
    const repo = await startRepo(app);
    const replaced = repo.db!;
    files.set(DATABASE_FILE_PATH, await dbFileWith(['b']));

    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo)).toEqual(['b']);
    expect(() => replaced.exec('SELECT 1')).toThrow(/closed/);
    repo.db?.close();
  });

  it('property: overlapping reloads end on the newest file, however their reads finish', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(unloadableFileArb, fc.constant(UNMIGRATABLE)),
        fc.boolean(),
        async (unloadable, slowFirst) => {
          const files = new Map([
            [DATABASE_FILE_PATH, await dbFileWith(['a'])],
          ]);
          const { app, adapter } = makeVault(INDEXED, files);
          const onWriteBlocked = vi.fn();
          const repo = await startRepo(app, { onWriteBlocked });
          // Sync writes the file in two passes, each firing `modify`. Each
          // read sees the file as it was when the read was issued, and the
          // first may finish after the second.
          let releaseFirst!: () => void;
          const firstHeld = new Promise<void>((r) => (releaseFirst = r));
          let reads = 0;
          adapter.readBinary.mockImplementation(async (path: string) => {
            const bytes = files.get(path)!;
            if (reads++ === 0 && slowFirst) await firstHeld;
            return bytes.slice().buffer;
          });

          files.set(DATABASE_FILE_PATH, await unloadableBytes(unloadable));
          const first = repo.handleFileChange(dbFileChange);
          // Otherwise the first reload finishes before the second change
          if (!slowFirst) await first;
          await settle();
          files.set(DATABASE_FILE_PATH, await dbFileWith(['b']));
          const second = repo.handleFileChange(dbFileChange);
          await settle();
          releaseFirst();
          await Promise.all([first, second]);
          await settle();

          expect(articleIds(repo)).toEqual(['b']);
          insertArticleRow(repo, 'c');
          await settle();
          expect((await idsInFile(files)).sort()).toEqual(['b', 'c']);
          // Told only of a failure no newer file had already overtaken
          expect(onWriteBlocked).toHaveBeenCalledTimes(slowFirst ? 0 : 1);
          repo.db?.close();
        }
      )
    );
  });

  it('saves when the vault index misses a data folder that is on disk', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const { app, adapter, vault } = makeVault(
      { folder: false, file: true },
      files
    );
    vault.createFolder.mockRejectedValue(new Error('Folder already exists.'));
    const exists = adapter.exists.getMockImplementation()!;
    adapter.exists.mockImplementation(
      async (path: string) => path === DATA_DIRECTORY || exists(path)
    );
    const repo = await startRepo(app);

    insertArticleRow(repo, 'b');
    await settle();

    expect((await idsInFile(files)).sort()).toEqual(['a', 'b']);
    repo.db?.close();
  });

  it('reports a data folder it could not create, saving nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const before = files.get(DATABASE_FILE_PATH);
    const { app, vault } = makeVault({ folder: false, file: true }, files);
    vault.createFolder.mockRejectedValueOnce(new Error('EACCES'));
    const repo = await startRepo(app);

    insertArticleRow(repo, 'b');
    await settle();

    expect(files.get(DATABASE_FILE_PATH)).toBe(before);
    expect(errors).toHaveBeenCalledWith(
      'Incremental Reading - Failed to save database:',
      expect.objectContaining({ error: 'EACCES' })
    );

    // The next save tries again rather than failing on the first attempt
    insertArticleRow(repo, 'c');
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b', 'c']);
    repo.db?.close();
  });

  it('passes over a failed migration of a file that changed again before it finished', async () => {
    const initial = await dbFileWith(['a']);
    const files = new Map([[DATABASE_FILE_PATH, initial]]);
    const { app, adapter } = makeVault(INDEXED, files);
    const onMigrationFailure = vi.fn();
    const onWriteBlocked = vi.fn();
    const repo = await startRepo(app, { onMigrationFailure, onWriteBlocked });
    failMigrationVerification();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    const read = adapter.readBinary.getMockImplementation()!;
    adapter.readBinary.mockImplementationOnce(async (path: string) => {
      const bytes = await read(path);
      await firstHeld;
      return bytes;
    });

    files.set(
      DATABASE_FILE_PATH,
      await unmergeable(await staleFileWith(['stale']))
    );
    const first = repo.handleFileChange(dbFileChange);
    await settle();
    files.set(DATABASE_FILE_PATH, await fileOver(initial, ['b']));
    const second = repo.handleFileChange(dbFileChange);
    releaseFirst();
    await Promise.all([first, second]);

    expect(onMigrationFailure).not.toHaveBeenCalled();
    expect(onWriteBlocked).not.toHaveBeenCalled();
    expect(articleIds(repo)).toEqual(['b']);
    insertArticleRow(repo, 'c');
    repo.db?.close();
  });

  it('does not reload the file its own save is writing', async () => {
    const { repo, adapter, files, onReloadFromDisk } = await startOver(['a']);
    let finishWrite!: () => void;
    const write = adapter.writeBinary.getMockImplementation()!;
    adapter.writeBinary.mockImplementationOnce(async (path, data) => {
      await new Promise<void>((resolve) => (finishWrite = resolve));
      return write(path, data);
    });
    const db = repo.db;

    insertArticleRow(repo, 'b');
    await settle();
    // Obsidian reports the write in progress as a change to the file
    await repo.handleFileChange(dbFileChange);
    finishWrite();
    await settle();

    expect(onReloadFromDisk).not.toHaveBeenCalled();
    expect(repo.db).toBe(db);
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b']);
    repo.db?.close();
  });

  it('takes on a file Sync brings down while its first save is still checking the path, writing nothing over it', async () => {
    const { app, files, adapter } = makeVault(INDEXED);
    const repo = await startRepo(app);
    // The first save asks whether the path is free; the answer is no file,
    // but it reaches the save only after Sync has written one
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    adapter.exists.mockImplementationOnce(async (path: string) => {
      const exists = files.has(path);
      await answered;
      return exists;
    });

    insertArticleRow(repo, 'local');
    await settle();
    const arrived = await dbFileWith(['remote']);
    files.set(DATABASE_FILE_PATH, arrived);
    await repo.handleFileChange(dbFileChange);
    answer();
    await settle();

    expect(files.get(DATABASE_FILE_PATH)).toBe(arrived);
    expect(articleIds(repo)).toEqual(['remote']);
    insertArticleRow(repo, 'later');
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['later', 'remote']);
    repo.db?.close();
  });

  it('holds a reload that comes due while a transaction is open until it settles', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const { app, adapter } = makeVault(INDEXED, files);
    let finishListener!: () => void;
    const listenerHeld = new Promise<void>((r) => (finishListener = r));
    const onReloadFromDisk = vi
      .fn()
      .mockImplementationOnce(() => listenerHeld)
      .mockResolvedValue(undefined);
    const repo = await startRepo(app, { onReloadFromDisk });
    // A reload still telling its listener when the file changes again, so a
    // second one is due as soon as the first is done
    files.set(DATABASE_FILE_PATH, await dbFileWith(['b']));
    const firstReload = repo.handleFileChange(dbFileChange);
    await settle();
    files.set(DATABASE_FILE_PATH, await dbFileWith(['c']));
    void repo.handleFileChange(dbFileChange);
    let finishWork!: () => void;
    const transaction = repo.transaction(async () => {
      insertArticleRow(repo, 'x');
      await new Promise<void>((resolve) => (finishWork = resolve));
      insertArticleRow(repo, 'y');
    });

    finishListener();
    await firstReload;
    await settle();
    const reads = adapter.readBinary.mock.calls.length;
    finishWork();

    await expect(transaction).resolves.toBeUndefined();
    expect(articleIds(repo).sort()).toEqual(['b', 'x', 'y']);
    // The held reload runs once the transaction settles. The commit's save
    // has written over the copy that came due by then, so it finds this
    // device's own save, and memory stays as it is.
    await vi.waitFor(() =>
      expect(adapter.readBinary.mock.calls.length).toBeGreaterThan(reads)
    );
    await settle();
    expect(articleIds(repo).sort()).toEqual(['b', 'x', 'y']);
    expect(onReloadFromDisk).toHaveBeenCalledOnce();
    repo.db?.close();
  });

  it('runs a reload a transaction held back even when saving its commit fails', async () => {
    // Started without a file, so the commit's save finds the one that
    // arrived meanwhile and refuses to write over it
    const { app, files } = makeVault(INDEXED);
    const repo = await startRepo(app);
    let finishWork!: () => void;
    const transaction = repo.transaction(async () => {
      insertArticleRow(repo, 'local');
      await new Promise<void>((resolve) => (finishWork = resolve));
    });
    files.set(DATABASE_FILE_PATH, await dbFileWith(['remote']));
    await repo.handleFileChange(dbFileChange);

    finishWork();
    await expect(transaction).rejects.toThrow();
    await settle();

    expect(articleIds(repo)).toEqual(['remote']);
    insertArticleRow(repo, 'later');
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['later', 'remote']);
    repo.db?.close();
  });
});

describe('dispose', () => {
  beforeEach(() => {
    stubWasm();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses every write afterwards, leaving the file as it was', async () => {
    const { repo, files } = await startOver(['a']);
    const before = files.get(DATABASE_FILE_PATH);

    repo.dispose();

    expect(() => insertArticleRow(repo, 'b')).toThrow(/disposed/);
    await expect(repo.transaction(() => {})).rejects.toThrow();
    await expect(repo.bulkMutate([{ query: 'SELECT 1' }])).rejects.toThrow();
    await settle();
    expect(files.get(DATABASE_FILE_PATH)).toBe(before);
  });

  it('closes the database', async () => {
    const { repo } = await startOver(['a']);
    const db = repo.db!;

    repo.dispose();

    expect(repo.db).toBeNull();
    expect(() => db.exec('SELECT 1')).toThrow(/closed/);
  });

  it('ignores the file changing on disk afterwards', async () => {
    const { repo, adapter, onReloadFromDisk } = await startOver(['a']);
    adapter.readBinary.mockClear();

    repo.dispose();
    await repo.handleFileChange(dbFileChange);

    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(onReloadFromDisk).not.toHaveBeenCalled();
    expect(repo.db).toBeNull();
  });

  it('drops a reload that was reading the file when it was disposed', async () => {
    const { repo, adapter, files, onReloadFromDisk, onWriteBlocked } =
      await startOver(['a']);
    files.set(DATABASE_FILE_PATH, await dbFileWith(['b']));
    let release!: () => void;
    const read = adapter.readBinary.getMockImplementation()!;
    adapter.readBinary.mockImplementationOnce(async (path: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      return read(path);
    });

    const reload = repo.handleFileChange(dbFileChange);
    await settle();
    repo.dispose();
    release();
    await reload;

    expect(repo.db).toBeNull();
    expect(onReloadFromDisk).not.toHaveBeenCalled();
    // A reload that was dropped did not fail, and is nothing to warn about
    expect(onWriteBlocked).not.toHaveBeenCalled();
  });

  it('drops a reload an open transaction was holding back', async () => {
    const { repo, adapter } = await startOver(['a']);
    let finishWork!: () => void;
    const transaction = repo.transaction(
      () => new Promise<void>((resolve) => (finishWork = resolve))
    );
    await repo.handleFileChange(dbFileChange);
    adapter.readBinary.mockClear();

    repo.dispose();
    finishWork();
    await transaction.catch(() => undefined);
    await settle();

    expect(adapter.readBinary).not.toHaveBeenCalled();
  });

  it('leaves nothing open when disposed while taking on a changed file', async () => {
    const { repo, adapter, files } = await startOver(['a']);
    files.set(
      DATABASE_FILE_PATH,
      await unmergeable(await staleFileWith(['b']))
    );
    // The reload reads the file, then the backup reads it again: hold that one
    const read = adapter.readBinary.getMockImplementation()!;
    let release!: () => void;
    adapter.readBinary
      .mockImplementationOnce(read)
      .mockImplementationOnce(async (path: string) => {
        await new Promise<void>((resolve) => (release = resolve));
        return read(path);
      });

    const reload = repo.handleFileChange(dbFileChange);
    await settle();
    repo.dispose();
    release();
    await reload;

    expect(repo.db).toBeNull();
  });

  it('drops a save that had not reached the disk yet', async () => {
    // The data folder missing from the index sends a save through
    // `createFolder` first, which is held here
    const { repo, adapter, vault } = await startOver(['a'], {
      folder: false,
      file: true,
    });
    let release!: () => void;
    vault.createFolder.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    );

    insertArticleRow(repo, 'b');
    await settle();
    repo.dispose();
    release();
    await settle();

    expect(adapter.writeBinary).not.toHaveBeenCalled();
  });
});

describe('writeRefusal', () => {
  beforeEach(() => {
    stubWasm();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is null while writes are allowed', async () => {
    const { repo } = await startOver(['a']);

    expect(repo.writeRefusal()).toBeNull();
  });

  it('is the error writes are refused with while the changed file on disk cannot be loaded, and null once it loads', async () => {
    const { repo, files } = await startOver(['a']);
    files.set(DATABASE_FILE_PATH, await unloadableBytes({ ahead: 1 }));
    await repo.handleFileChange(dbFileChange);

    const refusal = repo.writeRefusal();
    expect(refusal).toBeInstanceOf(Error);
    expect(() => insertArticleRow(repo, 'b')).toThrow(refusal!);

    files.set(DATABASE_FILE_PATH, await dbFileWith(['a']));
    await repo.handleFileChange(dbFileChange);
    expect(repo.writeRefusal()).toBeNull();
  });

  it('says the repository was disposed once it is, writes being refused with the same message', async () => {
    const { repo } = await startOver(['a']);

    repo.dispose();

    expect(repo.writeRefusal()?.message).toMatch(/disposed/);
    expect(() => insertArticleRow(repo, 'b')).toThrow(
      repo.writeRefusal()!.message
    );
  });
});

describe('skipping saves that change nothing (0174)', () => {
  beforeEach(() => {
    // bulkMutate yields through `window.setTimeout`, which node lacks
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Writes of the database file itself, leaving out backups. */
  const dbWrites = (adapter: ReturnType<typeof makeVault>['adapter']) =>
    adapter.writeBinary.mock.calls.filter(
      ([path]) => path === DATABASE_FILE_PATH
    ).length;

  it('writes the file for a change, and not for the same value again', async () => {
    const { repo, adapter } = await startOver(['a']);
    adapter.writeBinary.mockClear();
    const setPriority = (priority: number) =>
      repo.mutate('UPDATE article SET priority = $1 WHERE id = $2', [
        priority,
        'a',
      ]);

    setPriority(37);
    await settle();
    expect(dbWrites(adapter)).toBe(1);

    setPriority(37);
    await settle();
    expect(dbWrites(adapter)).toBe(1);
  });

  it('stamps and writes a change, and neither for the same value again', async () => {
    const { repo, adapter, app } = await startOver(['a']);
    const stamp = () =>
      repo.db!.exec(
        `SELECT updated_at, updated_by FROM article WHERE id = 'a'`
      )[0].values[0];
    const setPriority = (priority: number) =>
      repo.mutate('UPDATE article SET priority = $1 WHERE id = $2', [
        priority,
        'a',
      ]);
    setPriority(37);
    await settle();
    const [stampedAt] = stamp();
    adapter.writeBinary.mockClear();

    setPriority(37);
    await settle();
    expect(stamp()).toEqual([stampedAt, getDeviceId(app)]);
    expect(dbWrites(adapter)).toBe(0);

    setPriority(38);
    await settle();
    const [at, by] = stamp();
    expect(at).toBeGreaterThan(stampedAt as number);
    expect(by).toBe(getDeviceId(app));
    expect(dbWrites(adapter)).toBe(1);
  });

  it('writes a change to a stamp alone, as a merge of a newer row makes', async () => {
    const { repo, adapter } = await startOver(['a']);
    adapter.writeBinary.mockClear();

    repo.mutate(
      `UPDATE article SET updated_at = $1, updated_by = 'device-b' WHERE id = 'a'`,
      [Number.MAX_SAFE_INTEGER]
    );
    await settle();

    expect(dbWrites(adapter)).toBe(1);
  });

  it('writes once per update that changes a value, across saves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 20, max: 22 }), { maxLength: 12 }),
        async (priorities) => {
          const { repo, adapter } = await startOver(['a']);
          const [{ priority: first }] = repo.query(
            'SELECT priority FROM article'
          ) as { priority: number }[];
          adapter.writeBinary.mockClear();

          let current = first;
          let changed = 0;
          for (const priority of priorities) {
            if (priority !== current) changed++;
            current = priority;
            repo.mutate('UPDATE article SET priority = $1 WHERE id = $2', [
              priority,
              'a',
            ]);
            // Each save reopens the connection, dropping what tells changes
            await settle();
          }

          expect(dbWrites(adapter)).toBe(changed);
        }
      ),
      { numRuns: 25 }
    );
  });

  it('writes nothing for a transaction that changes nothing, once for one that does', async () => {
    const { repo, adapter } = await startOver(['a', 'b']);
    adapter.writeBinary.mockClear();

    await repo.transaction(() => {
      repo.mutate('UPDATE article SET deleted = 0 WHERE id = $1', ['a']);
      repo.mutate('UPDATE article SET deleted = 1 WHERE id = $1', ['nobody']);
    });
    expect(dbWrites(adapter)).toBe(0);

    await repo.transaction(() => {
      repo.mutate('UPDATE article SET deleted = 0 WHERE id = $1', ['a']);
      repo.mutate('UPDATE article SET deleted = 1 WHERE id = $1', ['b']);
    });
    expect(dbWrites(adapter)).toBe(1);
  });

  it('writes a bulk run once a chunk that changed something', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        async (deletes) => {
          const { repo, adapter } = await startOver(['a']);
          adapter.writeBinary.mockClear();
          // One statement a chunk: each takes a whole slice on this clock
          let tick = 0;
          const now = () => (tick += 1);

          let deleted = false;
          let changed = 0;
          for (const value of deletes) {
            if (value !== deleted) changed++;
            deleted = value;
          }
          await repo.bulkMutate(
            deletes.map((value) => ({
              query: 'UPDATE article SET deleted = $1 WHERE id = $2',
              params: [value ? 1 : 0, 'a'],
            })),
            { sliceMs: 1, now }
          );

          expect(dbWrites(adapter)).toBe(changed);
        }
      ),
      { numRuns: 25 }
    );
  });

  it('saves on the next write, even one that changes nothing, once a save failed', async () => {
    const { repo, adapter, files } = await startOver(['a']);
    vi.spyOn(console, 'error').mockReturnValue(undefined);
    adapter.writeBinary.mockRejectedValueOnce(new Error('disk full'));
    adapter.writeBinary.mockClear();
    const setPriority = (priority: number) =>
      repo.mutate('UPDATE article SET priority = $1 WHERE id = $2', [
        priority,
        'a',
      ]);
    const priorityOnDisk = async () => {
      const SQL = await getSharedSql();
      const db = new SQL.Database(files.get(DATABASE_FILE_PATH));
      const [[priority]] = db.exec('SELECT priority FROM article')[0].values;
      db.close();
      return priority;
    };

    setPriority(37);
    await settle();
    expect(dbWrites(adapter)).toBe(1);

    setPriority(37);
    await settle();
    expect(dbWrites(adapter)).toBe(2);
    expect(await priorityOnDisk()).toBe(37);

    setPriority(37);
    await settle();
    expect(dbWrites(adapter)).toBe(2);
  });

  it('saves again after a failed save that ended after a later one that wrote', async () => {
    const { repo, adapter } = await startOver(['a']);
    vi.spyOn(console, 'error').mockReturnValue(undefined);
    adapter.writeBinary.mockClear();
    let failFirst: (error: Error) => void = () => {};
    adapter.writeBinary.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failFirst = reject;
        })
    );
    const setPriority = (priority: number) =>
      repo.mutate('UPDATE article SET priority = $1 WHERE id = $2', [
        priority,
        'a',
      ]);

    setPriority(37);
    setPriority(38);
    await settle();
    failFirst(new Error('disk full'));
    await settle();
    expect(dbWrites(adapter)).toBe(2);

    // The later save held the earlier one's change, so nothing is owed
    setPriority(38);
    await settle();
    expect(dbWrites(adapter)).toBe(2);
  });

  it('still owes a failed save when an earlier one that wrote ends after it', async () => {
    const { repo, adapter, files } = await startOver(['a']);
    vi.spyOn(console, 'error').mockReturnValue(undefined);
    adapter.writeBinary.mockClear();
    let finishFirst: () => void = () => {};
    adapter.writeBinary
      .mockImplementationOnce(
        (path: string, data: ArrayBuffer) =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              files.set(path, new Uint8Array(data.slice(0)));
              resolve();
            };
          })
      )
      .mockRejectedValueOnce(new Error('disk full'));
    const setPriority = (priority: number) =>
      repo.mutate('UPDATE article SET priority = $1 WHERE id = $2', [
        priority,
        'a',
      ]);

    setPriority(37);
    setPriority(38);
    await settle();
    finishFirst();
    await settle();
    expect(dbWrites(adapter)).toBe(2);

    // Only the failed save held 38
    setPriority(38);
    await settle();
    expect(dbWrites(adapter)).toBe(3);
  });

  it('leaves the file holding what memory does after every committed write whose save went through', async () => {
    type Write = {
      kind: 'mutate' | 'transaction' | 'rollback' | 'bulk';
      priorities: number[];
      /** Whether the save this write asks for, if any, fails. */
      fails: boolean;
    };
    const writeArb: fc.Arbitrary<Write> = fc.record({
      kind: fc.constantFrom('mutate', 'transaction', 'rollback', 'bulk'),
      priorities: fc.array(fc.integer({ min: 20, max: 22 }), {
        minLength: 1,
        maxLength: 3,
      }),
      fails: fc.boolean(),
    });
    const SQL = await getSharedSql();
    const priorities = (db: Database) =>
      JSON.stringify(db.exec('SELECT id, priority FROM article ORDER BY id'));

    await fc.assert(
      fc.asyncProperty(
        fc.array(writeArb, { maxLength: 10 }),
        async (writes) => {
          const { repo, adapter, files } = await startOver(['a', 'b']);
          vi.spyOn(console, 'error').mockReturnValue(undefined);
          const update = (priority: number, i: number) => ({
            query: 'UPDATE article SET priority = $1 WHERE id = $2',
            params: [priority, i % 2 ? 'b' : 'a'],
          });

          const write = adapter.writeBinary.getMockImplementation()!;
          for (const { kind, priorities: values, fails } of writes) {
            // Drops a failure the last write left unused, having saved nothing
            adapter.writeBinary.mockReset().mockImplementation(write);
            if (fails) {
              adapter.writeBinary.mockRejectedValueOnce(new Error('disk full'));
            }
            const statements = values.map(update);
            if (kind === 'mutate') {
              repo.mutate(statements[0].query, statements[0].params);
            } else if (kind === 'bulk') {
              await repo.bulkMutate(statements).catch(() => undefined);
            } else {
              await repo
                .transaction(() => {
                  for (const { query, params } of statements) {
                    repo.mutate(query, params);
                  }
                  if (kind === 'rollback') throw new Error('rolled back');
                })
                .catch(() => undefined);
            }
            await settle();

            // A rollback commits nothing, so asks for no save
            if (kind === 'rollback' || (fails && dbWrites(adapter) > 0))
              continue;
            const onDisk = new SQL.Database(files.get(DATABASE_FILE_PATH));
            expect(priorities(onDisk)).toBe(priorities(repo.db as Database));
            onDisk.close();
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it('says it is refetching only while the reload callback runs, even one that throws', async () => {
    const { repo, files, onReloadFromDisk } = await startOver(['a']);
    const seen: boolean[] = [];
    onReloadFromDisk.mockImplementationOnce(async () => {
      seen.push(repo.refetchingAfterReload);
      await nextMacrotask();
      seen.push(repo.refetchingAfterReload);
    });
    onReloadFromDisk.mockImplementationOnce(() => {
      seen.push(repo.refetchingAfterReload);
      throw new Error('refetch failed');
    });
    vi.spyOn(console, 'error').mockReturnValue(undefined);
    expect(repo.refetchingAfterReload).toBe(false);

    for (const ids of [
      ['a', 'b'],
      ['a', 'b', 'c'],
    ]) {
      files.set(DATABASE_FILE_PATH, await dbFileWith(ids));
      await repo.handleFileChange(dbFileChange);
    }

    expect(seen).toEqual([true, true, true]);
    expect(repo.refetchingAfterReload).toBe(false);
  });
});

describe("telling another device's copy from this device's own save", () => {
  beforeEach(() => {
    stubWasm();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A started repository over a file holding `ids`, with localStorage. */
  async function startStored(ids: readonly string[]) {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(ids)]]);
    const vault = makeVault(INDEXED, files);
    const app = withStorage(vault.app);
    const onReloadFromDisk = vi.fn();
    const repo = await startRepo(app, { onReloadFromDisk });
    const device = app.storage.get('incremental-reading-device-id');
    return { ...vault, app, repo, onReloadFromDisk, device };
  }

  /** Paths of the backups written with `marker` in their name. */
  function markedBackups(
    adapter: ReturnType<typeof makeVault>['adapter'],
    marker: string
  ) {
    return backupWrites(adapter).filter((path) =>
      path.includes(`_v${LATEST_VERSION}_${marker}_`)
    );
  }

  it('property: stamps every save with this device at one past its last generation or the clock, whichever is later', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -DAY_MS, max: DAY_MS }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (moves) => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(FIXED_DUE);
          const { repo, files } = await startStored([]);
          const remote = (await stampOf(files.get(DATABASE_FILE_PATH)))[
            REMOTE_DEVICE
          ];
          let last = -Infinity;

          for (const [i, move] of moves.entries()) {
            vi.setSystemTime(Date.now() + move);
            insertArticleRow(repo, `row-${i}`);
            await settle();
            const stamp = await stampOf(files.get(DATABASE_FILE_PATH));
            const mine = Object.keys(stamp).find((d) => d !== REMOTE_DEVICE)!;

            last = Math.max(last + 1, Date.now());
            expect(stamp).toEqual({ [REMOTE_DEVICE]: remote, [mine]: last });
          }
          repo.db?.close();
          vi.useRealTimers();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('property: stamps every row it writes past the generation it last saved, however the clock moves, and the next save past the row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(fc.constant(0), fc.integer({ min: -DAY_MS, max: DAY_MS })),
          { minLength: 1, maxLength: 6 }
        ),
        async (moves) => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(FIXED_DUE);
          const { repo, files } = await startStored([]);
          const ownGeneration = async () => {
            const stamp = await stampOf(files.get(DATABASE_FILE_PATH));
            const mine = Object.keys(stamp).find((d) => d !== REMOTE_DEVICE);
            return mine === undefined ? 0 : stamp[mine];
          };

          for (const [i, move] of moves.entries()) {
            const saved = await ownGeneration();
            // The same millisecond as that save, or the clock gone back
            vi.setSystemTime(Date.now() + move);
            insertArticleRow(repo, `row-${i}`);
            const [[stamped]] = repo.db!.exec(
              'SELECT updated_at FROM article WHERE id = $1',
              [`row-${i}`]
            )[0].values as number[][];
            expect(stamped).toBeGreaterThan(saved);
            await settle();
            expect(await ownGeneration()).toBeGreaterThanOrEqual(stamped);
          }
          repo.db?.close();
          vi.useRealTimers();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('leaves its own copy coming back alone, without reloading or saving again', async () => {
    const { repo, adapter, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const db = repo.db;
    const writes = adapter.writeBinary.mock.calls.length;

    await repo.handleFileChange(dbFileChange);
    await settle();

    expect(onReloadFromDisk).not.toHaveBeenCalled();
    expect(repo.db).toBe(db);
    expect(adapter.writeBinary).toHaveBeenCalledTimes(writes);
    repo.db?.close();
  });

  it('merges a copy from another device that lands while a save of its own is in flight, then saves the merge after it', async () => {
    const { repo, adapter, files, onReloadFromDisk } = await startStored(['a']);
    let finishWrite!: () => void;
    const write = adapter.writeBinary.getMockImplementation()!;
    adapter.writeBinary.mockImplementationOnce(async (path, data) => {
      await new Promise<void>((resolve) => (finishWrite = resolve));
      return write(path, data);
    });
    insertArticleRow(repo, 'b');
    await settle();

    files.set(DATABASE_FILE_PATH, await dbFileWith(['remote']));
    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo).sort()).toEqual(['a', 'b', 'remote']);
    expect(onReloadFromDisk).toHaveBeenCalledOnce();
    expect(backupWrites(adapter)).toEqual([]);
    // Held here, the older save lands last; the report of it brings the
    // merge back over it
    finishWrite();
    await settle();
    await repo.handleFileChange(dbFileChange);
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b', 'remote']);
    repo.db?.close();
  });

  it('leaves a copy from a device away for more than 180 days alone, and saves its own over it', async () => {
    const { repo, files, adapter, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();

    files.set(
      DATABASE_FILE_PATH,
      await fileStamped(['ancient'], {
        away: Date.now() - STALE_AFTER_MS - DAY_MS,
      })
    );
    await repo.handleFileChange(dbFileChange);
    await settle();

    expect(articleIds(repo).sort()).toEqual(['a', 'b']);
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b']);
    expect(onReloadFromDisk).not.toHaveBeenCalled();
    expect(backupWrites(adapter)).toEqual([]);
    repo.db?.close();
  });

  it("backs up its own copy, then takes on another device's, when its own last save is more than 180 days older", async () => {
    // Later than any generation stamped so far
    const start = Date.now() + 3650 * DAY_MS;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    const { repo, files, adapter, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();

    vi.setSystemTime(start + STALE_AFTER_MS + DAY_MS);
    files.set(DATABASE_FILE_PATH, await dbFileWith(['fresh']));
    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo)).toEqual(['fresh']);
    expect(onReloadFromDisk).toHaveBeenCalledOnce();
    const [backup] = markedBackups(adapter, 'stale');
    expect((await idsIn(files.get(backup))).sort()).toEqual(['a', 'b']);
    expect(backupWrites(adapter)).toHaveLength(1);
    repo.db?.close();
  });

  it('takes on a copy that has every save it has, backing nothing up', async () => {
    const { repo, files, adapter, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();

    files.set(
      DATABASE_FILE_PATH,
      await savedOnTopBy(files.get(DATABASE_FILE_PATH), ['c'])
    );
    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo).sort()).toEqual(['a', 'b', 'c']);
    expect(onReloadFromDisk).toHaveBeenCalledOnce();
    expect(backupWrites(adapter)).toEqual([]);
    repo.db?.close();
  });

  it('saves over an older copy of its own when no save of its own is on the way', async () => {
    const { repo, files, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const older = files.get(DATABASE_FILE_PATH);
    insertArticleRow(repo, 'c');
    await settle();

    files.set(DATABASE_FILE_PATH, older!);
    await repo.handleFileChange(dbFileChange);
    await settle();

    expect(articleIds(repo).sort()).toEqual(['a', 'b', 'c']);
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b', 'c']);
    expect(onReloadFromDisk).not.toHaveBeenCalled();
    repo.db?.close();
  });

  it('leaves an older copy of its own alone while a save of its own is on the way', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    let finishWrite!: () => void;
    const write = adapter.writeBinary.getMockImplementation()!;
    adapter.writeBinary.mockImplementationOnce(async (path, data) => {
      await new Promise<void>((resolve) => (finishWrite = resolve));
      return write(path, data);
    });
    insertArticleRow(repo, 'b');
    await settle();
    const writes = adapter.writeBinary.mock.calls.length;

    await repo.handleFileChange(dbFileChange);
    await settle();

    expect(adapter.writeBinary).toHaveBeenCalledTimes(writes);
    finishWrite();
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b']);
    repo.db?.close();
  });

  it('merges a file no device stamped, as an older plugin version writes, whose rows lose to every stamped one', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const old = await getSharedSql().then((SQL) => SQL.Database);
    const stale = new old(await staleFileWith(['old', 'b']));
    stale.run(`UPDATE article SET priority = 40`);
    files.set(DATABASE_FILE_PATH, stale.export());
    stale.close();

    await repo.handleFileChange(dbFileChange);

    expect(priorities(repo)).toEqual({ a: 30, b: 30, old: 40 });
    expect(backupWrites(adapter)).toEqual([]);
    repo.db?.close();
  });

  it('saves its own copy over one from a device away for months even while a save of its own is on the way', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    let finishWrite!: () => void;
    const write = adapter.writeBinary.getMockImplementation()!;
    adapter.writeBinary.mockImplementationOnce(async (path, data) => {
      await new Promise<void>((resolve) => (finishWrite = resolve));
      return write(path, data);
    });
    insertArticleRow(repo, 'b');
    await settle();
    const writes = adapter.writeBinary.mock.calls.length;

    files.set(
      DATABASE_FILE_PATH,
      await fileStamped(['ancient'], {
        away: Date.now() - STALE_AFTER_MS - DAY_MS,
      })
    );
    await repo.handleFileChange(dbFileChange);
    await settle();

    expect(adapter.writeBinary.mock.calls.length).toBeGreaterThan(writes);
    finishWrite();
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b']);
    repo.db?.close();
  });

  /** Hold the next backup at creating its folder until the gate opens. */
  function holdBackup(adapter: ReturnType<typeof makeVault>['adapter']) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    adapter.mkdir.mockImplementationOnce(() => gate);
    return open;
  }

  it('merges nothing when disposed while backing memory up', async () => {
    const { repo, files, adapter, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const openBackup = holdBackup(adapter);
    files.set(DATABASE_FILE_PATH, await newerFileWith(['b']));
    const reload = repo.handleFileChange(dbFileChange);
    await settle();

    repo.dispose();
    openBackup();
    await reload;

    expect(onReloadFromDisk).not.toHaveBeenCalled();
    expect(repo.db).toBeNull();
  });

  it('holds back a merge when a transaction opens while memory is backed up', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const openBackup = holdBackup(adapter);
    files.set(DATABASE_FILE_PATH, await newerFileWith(['b']));
    const reload = repo.handleFileChange(dbFileChange);
    await settle();

    let finishWork!: () => void;
    const transaction = repo.transaction(async () => {
      insertArticleRow(repo, 'x');
      await new Promise<void>((resolve) => (finishWork = resolve));
      insertArticleRow(repo, 'y');
    });
    openBackup();
    await reload;
    finishWork();

    await expect(transaction).resolves.toBeUndefined();
    expect(priorities(repo)).toEqual({ a: 30, b: 30, x: 30, y: 30 });
    await settle();
    repo.db?.close();
  });

  // The commit's save would write over the copy, leaving its own echo for
  // the held reload to find; one that fails leaves the copy on disk
  it('merges the held copy once the transaction settles, when its save leaves the copy on disk', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const openBackup = holdBackup(adapter);
    files.set(DATABASE_FILE_PATH, await newerFileWith(['b']));
    const reload = repo.handleFileChange(dbFileChange);
    await settle();

    let finishWork!: () => void;
    const transaction = repo.transaction(async () => {
      insertArticleRow(repo, 'x');
      await new Promise<void>((resolve) => (finishWork = resolve));
    });
    openBackup();
    await reload;
    adapter.writeBinary.mockRejectedValueOnce(new Error('EBUSY'));
    finishWork();

    await expect(transaction).rejects.toThrow('EBUSY');
    await vi.waitFor(() =>
      expect(priorities(repo)).toEqual({ a: 30, b: 40, x: 30 })
    );
    repo.db?.close();
  });

  it('keeps what it had, refusing writes, when the changed file cannot be read', async () => {
    const { repo, adapter, onReloadFromDisk } = await startStored(['a']);
    adapter.readBinary.mockRejectedValueOnce(new Error('EBUSY'));

    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo)).toEqual(['a']);
    expect(repo.writeRefusal()).toBeInstanceOf(Error);
    expect(onReloadFromDisk).not.toHaveBeenCalled();
    repo.db?.close();
  });

  it('merges nothing, and keeps saving, when backing memory up fails', async () => {
    const { repo, files, adapter, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    adapter.mkdir.mockRejectedValueOnce(new Error('disk full'));

    files.set(DATABASE_FILE_PATH, await newerFileWith(['b', 'remote']));
    await repo.handleFileChange(dbFileChange);

    expect(priorities(repo)).toEqual({ a: 30, b: 30 });
    expect(onReloadFromDisk).not.toHaveBeenCalled();
    expect(repo.writeRefusal()).toBeNull();
    repo.db?.close();
  });

  it('neither writes nor moves its write stamp for a write that changes nothing (0174)', async () => {
    const { repo, adapter } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const writes = adapter.writeBinary.mock.calls.length;
    const stamp = readWriteVector(repo.db as Database);

    repo.mutate('UPDATE article SET priority = priority WHERE id = $1', ['a']);
    await settle();

    expect(adapter.writeBinary).toHaveBeenCalledTimes(writes);
    expect(readWriteVector(repo.db as Database)).toEqual(stamp);
    repo.db?.close();
  });

  it.each([
    {
      kind: 'behind',
      // An older copy of its own, no save on the way
      copy: (older: Uint8Array) => Promise.resolve(older),
    },
    {
      kind: 'stale-other',
      copy: () =>
        fileStamped(['ancient'], {
          away: Date.now() - STALE_AFTER_MS - DAY_MS,
        }),
    },
  ])(
    'saves unchanged memory over a $kind copy, past the gate that skips writes changing nothing (0174)',
    async ({ copy }) => {
      const { repo, adapter, files } = await startStored(['a']);
      insertArticleRow(repo, 'b');
      await settle();
      const older = files.get(DATABASE_FILE_PATH)!;
      insertArticleRow(repo, 'c');
      await settle();
      // The gate is on: a write that changes nothing saves nothing
      repo.mutate('UPDATE article SET priority = priority WHERE id = $1', [
        'a',
      ]);
      await settle();
      const writes = adapter.writeBinary.mock.calls.length;

      files.set(DATABASE_FILE_PATH, await copy(older));
      await repo.handleFileChange(dbFileChange);
      await settle();

      expect(adapter.writeBinary).toHaveBeenCalledTimes(writes + 1);
      expect((await idsInFile(files)).sort()).toEqual(['a', 'b', 'c']);
      repo.db?.close();
    }
  );

  it.each([
    {
      kind: 'fast-forward',
      copy: (mine: Uint8Array) => savedOnTopBy(mine, ['remote']),
    },
    { kind: 'merge', copy: () => dbFileWith(['remote']) },
  ])(
    'says it is refetching while the reload callback runs after taking on a $kind copy',
    async ({ copy }) => {
      const { repo, files, onReloadFromDisk } = await startStored(['a']);
      insertArticleRow(repo, 'b');
      await settle();
      const seen: boolean[] = [];
      onReloadFromDisk.mockImplementation(() => {
        seen.push(repo.refetchingAfterReload);
      });

      files.set(DATABASE_FILE_PATH, await copy(files.get(DATABASE_FILE_PATH)!));
      await repo.handleFileChange(dbFileChange);

      expect(articleIds(repo)).toContain('remote');
      expect(seen).toEqual([true]);
      expect(repo.refetchingAfterReload).toBe(false);
      repo.db?.close();
    }
  );

  it('backs up its own changes the copy never saw before a merge replaces them, and says how many', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    const said = vi.spyOn(notices, 'notify');
    insertArticleRow(repo, 'b');
    insertArticleRow(repo, 'c');
    await settle();

    files.set(DATABASE_FILE_PATH, await newerFileWith(['b', 'c', 'remote']));
    await repo.handleFileChange(dbFileChange);

    expect(priorities(repo)).toEqual({ a: 30, b: 40, c: 40, remote: 40 });
    const [backup] = markedBackups(adapter, 'merge');
    expect((await idsIn(files.get(backup))).sort()).toEqual(['a', 'b', 'c']);
    expect(backupWrites(adapter)).toHaveLength(1);
    expect(said).toHaveBeenCalledOnce();
    expect(said.mock.calls[0][0]).toMatch(/\b2 local changes\b/);
    repo.db?.close();
  });

  it('counts a single replaced change in the singular', async () => {
    const { repo, files } = await startStored(['a']);
    const said = vi.spyOn(notices, 'notify');
    insertArticleRow(repo, 'b');
    await settle();

    files.set(DATABASE_FILE_PATH, await newerFileWith(['b']));
    await repo.handleFileChange(dbFileChange);

    expect(said.mock.calls[0][0]).toMatch(/\b1 local change\b/);
    repo.db?.close();
  });

  it('merges a copy that loses nothing of its own without a backup or a notice', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    const said = vi.spyOn(notices, 'notify');
    insertArticleRow(repo, 'b');
    await settle();

    files.set(DATABASE_FILE_PATH, await newerFileWith(['a', 'remote']));
    await repo.handleFileChange(dbFileChange);

    expect(priorities(repo)).toEqual({ a: 40, b: 30, remote: 40 });
    expect(backupWrites(adapter)).toEqual([]);
    expect(said).not.toHaveBeenCalled();
    repo.db?.close();
  });

  it('tells listeners of the rows a merge brings, and refetches as after a reload', async () => {
    const { repo, files, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const events: DataChangeEvent[] = [];
    repo.onDataChange((event) => events.push(event));
    const refetching: boolean[] = [];
    onReloadFromDisk.mockImplementation(() => {
      refetching.push(repo.refetchingAfterReload);
    });

    files.set(DATABASE_FILE_PATH, await dbFileWith(['remote']));
    await repo.handleFileChange(dbFileChange);

    expect(events).toEqual([
      { table: 'article', op: 'insert', ids: ['remote'] },
    ]);
    expect(refetching).toEqual([true]);
    expect(repo.refetchingAfterReload).toBe(false);
    repo.db?.close();
  });

  it('saves a merge that brings no row, only saves of other devices, so they reach the next device', async () => {
    const { repo, files, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const writes = files.get(DATABASE_FILE_PATH);

    const incoming = await dbFileWith(['a']);
    files.set(DATABASE_FILE_PATH, incoming);
    await repo.handleFileChange(dbFileChange);
    await settle();

    expect(onReloadFromDisk).not.toHaveBeenCalled();
    expect(files.get(DATABASE_FILE_PATH)).not.toBe(incoming);
    expect(files.get(DATABASE_FILE_PATH)).not.toBe(writes);
    const saved = await stampOf(files.get(DATABASE_FILE_PATH));
    expect(saved[REMOTE_DEVICE]).toBe((await stampOf(incoming))[REMOTE_DEVICE]);
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b']);
    repo.db?.close();
  });

  it('takes on a copy it cannot merge, after backing memory up', async () => {
    const { repo, files, adapter, onReloadFromDisk } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();

    files.set(
      DATABASE_FILE_PATH,
      await unmergeable(await dbFileWith(['remote']))
    );
    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo)).toEqual(['remote']);
    expect(onReloadFromDisk).toHaveBeenCalledOnce();
    const [backup] = markedBackups(adapter, 'merge');
    expect((await idsIn(files.get(backup))).sort()).toEqual(['a', 'b']);
    expect(backupWrites(adapter)).toHaveLength(1);
    repo.db?.close();
  });

  it('takes on a copy it cannot read for merging, after backing memory up once', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    vi.spyOn(rowMerge, 'previewMerge').mockImplementationOnce(() => {
      throw new Error('no such column');
    });

    files.set(DATABASE_FILE_PATH, await dbFileWith(['remote']));
    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo)).toEqual(['remote']);
    expect(markedBackups(adapter, 'merge')).toHaveLength(1);
    expect(backupWrites(adapter)).toHaveLength(1);
    repo.db?.close();
  });

  it('backs memory up, then refuses writes, for a copy whose migration fails', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const SQL = await getSharedSql();
    const broken = new SQL.Database(await staleFileWith(['remote']));
    broken.exec('DROP TABLE article_review');
    files.set(DATABASE_FILE_PATH, broken.export());
    broken.close();

    await repo.handleFileChange(dbFileChange);

    expect(articleIds(repo).sort()).toEqual(['a', 'b']);
    expect(markedBackups(adapter, 'merge')).toHaveLength(1);
    expect(repo.writeRefusal()).toBeInstanceOf(Error);
    repo.db?.close();
  });

  it('backs memory up once when a merge it backed up for fails, then takes the copy on', async () => {
    const { repo, files, adapter } = await startStored(['a']);
    insertArticleRow(repo, 'b');
    await settle();

    files.set(
      DATABASE_FILE_PATH,
      await unmergeable(await newerFileWith(['b']))
    );
    await repo.handleFileChange(dbFileChange);

    expect(priorities(repo)).toEqual({ b: 40 });
    expect(markedBackups(adapter, 'merge')).toHaveLength(1);
    expect(backupWrites(adapter)).toHaveLength(1);
    repo.db?.close();
  });

  it('remembers the stamp of every file it writes or takes on', async () => {
    const { repo, files, app } = await startStored(['a']);
    const known = () => app.storage.get(KNOWN_WRITE_STAMP_KEY);
    expect(known()).toEqual(await stampOf(files.get(DATABASE_FILE_PATH)));

    insertArticleRow(repo, 'b');
    await settle();
    expect(known()).toEqual(await stampOf(files.get(DATABASE_FILE_PATH)));

    files.set(DATABASE_FILE_PATH, await dbFileWith(['remote']));
    await repo.handleFileChange(dbFileChange);
    expect(known()).toEqual(await stampOf(files.get(DATABASE_FILE_PATH)));
    repo.db?.close();
  });

  describe('at startup', () => {
    /** A first session over a file holding `ids` that writes `written`. */
    async function firstSession(ids: readonly string[], written: string) {
      const started = await startStored(ids);
      insertArticleRow(started.repo, written);
      await settle();
      started.repo.dispose();
      return started;
    }

    it('finds the file it last wrote to be its own echo, reporting nothing', async () => {
      const { app } = await firstSession(['a'], 'b');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const repo = await startRepo(app);

      expect(repo.startupKind).toBe('echo');
      expect(warn).not.toHaveBeenCalled();
      repo.dispose();
    });

    it('takes a later save made on top of its own for a fast-forward, reporting nothing', async () => {
      const { app, files } = await firstSession(['a'], 'b');
      files.set(
        DATABASE_FILE_PATH,
        await savedOnTopBy(files.get(DATABASE_FILE_PATH), ['c'])
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const repo = await startRepo(app);

      expect(repo.startupKind).toBe('fast-forward');
      expect(articleIds(repo).sort()).toEqual(['a', 'b', 'c']);
      expect(warn).not.toHaveBeenCalled();
      repo.dispose();
    });

    it("reports a file another device wrote while the plugin was not running that lacks this device's last save", async () => {
      const { app, files } = await firstSession(['a'], 'b');
      files.set(DATABASE_FILE_PATH, await dbFileWith(['other']));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const repo = await startRepo(app);

      expect(repo.startupKind).toBe('merge');
      expect(articleIds(repo)).toEqual(['other']);
      expect(warn).toHaveBeenCalledOnce();
      repo.dispose();
    });

    it('classifies nothing when this device stored no stamp, or the file has none', async () => {
      const { repo: first } = await startStored(['a']);
      expect(first.startupKind).toBeNull();
      first.dispose();

      const { app, files } = await firstSession(['a'], 'b');
      files.set(DATABASE_FILE_PATH, await staleFileWith(['old']));
      const repo = await startRepo(app);
      expect(repo.startupKind).toBeNull();
      repo.dispose();
    });

    it('classifies nothing when it starts on a new database', async () => {
      const app = withStorage(makeVault(INDEXED).app);
      app.storage.set(KNOWN_WRITE_STAMP_KEY, { someone: 1 });

      const repo = await startRepo(app);

      expect(repo.startupKind).toBeNull();
      repo.dispose();
    });
  });
});

describe('readiness', () => {
  beforeEach(() => {
    stubWasm();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Hold the next read of the database file until the test releases it,
   * handing back what is on disk by then.
   */
  function holdNextRead(
    adapter: ReturnType<typeof makeVault>['adapter'],
    files: Map<string, Uint8Array>
  ) {
    let release = () => {};
    adapter.readBinary.mockImplementationOnce(
      (path: string) =>
        new Promise<ArrayBuffer>((resolve) => {
          release = () => resolve(files.get(path)!.slice().buffer);
        })
    );
    return () => release();
  }

  /** Every state `repo` tells its listeners of, in order. */
  function recordStates(repo: SQLJSRepository) {
    const told: string[] = [];
    repo.onReadinessChange((state) => told.push(state));
    return told;
  }

  it('is starting while startup loads and classifies the file, and ready once it hands the repository over', async () => {
    const files = new Map([[DATABASE_FILE_PATH, await dbFileWith(['a'])]]);
    const { app } = makeVault(INDEXED, files);
    const seen: string[] = [];
    const proto = SQLJSRepository.prototype as unknown as {
      loadDb: (this: SQLJSRepository) => Promise<unknown>;
    };
    const loadDb = proto.loadDb;
    vi.spyOn(proto, 'loadDb').mockImplementation(async function (
      this: SQLJSRepository
    ) {
      seen.push(this.readiness);
      return (await loadDb.call(this)) as unknown;
    });

    const repo = await startRepo(app);

    expect(seen).toEqual(['starting']);
    expect(repo.readiness).toBe('ready');
    repo.dispose();
  });

  it('is ready, and stays so, for a startup that makes a new database', async () => {
    const { app } = makeVault(INDEXED);

    const repo = await startRepo(app);

    expect(repo.readiness).toBe('ready');
    await expect(repo.whenReady()).resolves.toBeUndefined();
    repo.dispose();
  });

  it('is merging while a reload reads and takes in a file, and ready before the refetch it asks for', async () => {
    const { repo, files, adapter, onReloadFromDisk } = await startOver(['a']);
    const told = recordStates(repo);
    const release = holdNextRead(adapter, files);
    let duringRefetch: string | null = null;
    onReloadFromDisk.mockImplementation(() => {
      duringRefetch = repo.readiness;
    });
    files.set(DATABASE_FILE_PATH, await dbFileWith(['a', 'b']));

    const reload = repo.handleFileChange(dbFileChange);
    await settle();
    expect(repo.readiness).toBe('merging');
    let ready = false;
    void repo.whenReady().then(() => (ready = true));
    await settle();
    expect(ready).toBe(false);

    release();
    await reload;

    expect(articleIds(repo).sort()).toEqual(['a', 'b']);
    expect(duringRefetch).toBe('ready');
    expect(ready).toBe(true);
    expect(told).toEqual(['merging', 'ready']);
    repo.dispose();
  });

  it('lands a plain write asked for during a merge once the merge ends, in the database taken in, and on disk', async () => {
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    const { repo, files, adapter } = await startOver(['a']);
    const release = holdNextRead(adapter, files);
    files.set(DATABASE_FILE_PATH, await dbFileWith(['a', 'b']));
    const reload = repo.handleFileChange(dbFileChange);
    await settle();

    const write = requireReady(repo, 'db-write', 'grade the card').then(
      (allowed) => {
        if (allowed) insertArticleRow(repo, 'graded');
        return allowed;
      }
    );
    await settle();
    expect(articleIds(repo).sort()).toEqual(['a']);
    release();
    await reload;

    expect(await write).toBe(true);
    expect(articleIds(repo).sort()).toEqual(['a', 'b', 'graded']);
    await settle();
    expect((await idsInFile(files)).sort()).toEqual(['a', 'b', 'graded']);
    repo.dispose();
  });

  it('lands a plain write asked for during a merge that fails partway, as the merge ends', async () => {
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    const { repo, files, adapter } = await startOver(['a']);
    const told = recordStates(repo);
    const release = holdNextRead(adapter, files);
    files.set(DATABASE_FILE_PATH, await dbFileWith(['a', 'b']));
    vi.spyOn(
      repo as unknown as { reloadDb(): Promise<unknown> },
      'reloadDb'
    ).mockRejectedValueOnce(new Error('Failed partway'));
    const reload = repo.handleFileChange(dbFileChange);
    await settle();

    const write = requireReady(repo, 'db-write', 'grade the card');
    release();
    await reload;

    expect(await write).toBe(true);
    expect(repo.readiness).toBe('ready');
    expect(told).toEqual(['merging', 'ready']);
    repo.dispose();
  });

  it('lets a plain write held over a merge through when a transaction holds the merge back, then merges once it ends', async () => {
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    const { repo, files, adapter } = await startOver(['a']);
    const told = recordStates(repo);
    const release = holdNextRead(adapter, files);
    files.set(DATABASE_FILE_PATH, await dbFileWith(['a', 'b']));
    const reload = repo.handleFileChange(dbFileChange);
    await settle();
    let endTransaction = () => {};
    const transaction = repo.transaction(
      () => new Promise<void>((resolve) => (endTransaction = resolve))
    );
    const write = requireReady(repo, 'db-write', 'grade the card');

    release();
    await reload;
    // Not waiting on the transaction, which the merge waits for instead
    expect(await write).toBe(true);
    expect(told).toEqual(['merging', 'ready']);
    endTransaction();
    await transaction;
    await vi.waitFor(() => expect(articleIds(repo).sort()).toEqual(['a', 'b']));

    expect(told).toEqual(['merging', 'ready', 'merging', 'ready']);
    repo.dispose();
  });

  it('is merging while it reads its own save coming back, and ready after', async () => {
    const { repo, files, adapter } = await startOver(['a']);
    insertArticleRow(repo, 'b');
    await settle();
    const told = recordStates(repo);
    const release = holdNextRead(adapter, files);

    const reload = repo.handleFileChange(dbFileChange);
    await settle();
    expect(repo.readiness).toBe('merging');
    release();
    await reload;

    expect(repo.readiness).toBe('ready');
    expect(told).toEqual(['merging', 'ready']);
    repo.dispose();
  });

  it('property: is starting once a reload finds a file it cannot load, until one loads', async () => {
    await fc.assert(
      fc.asyncProperty(unloadableFileArb, async (file) => {
        const { repo, files } = await startOver(['a']);
        const told = recordStates(repo);
        files.set(DATABASE_FILE_PATH, await unloadableBytes(file));

        await repo.handleFileChange(dbFileChange);

        expect(repo.readiness).toBe('starting');
        expect(told).toEqual(['merging', 'starting']);
        let ready = false;
        void repo.whenReady().then(() => (ready = true));
        files.set(DATABASE_FILE_PATH, await dbFileWith(['a', 'c']));
        await repo.handleFileChange(dbFileChange);
        await settle();

        expect(repo.readiness).toBe('ready');
        expect(ready).toBe(true);
        // Still refused while the next reload reads: only a load lifts it
        expect(told).toEqual(['merging', 'starting', 'ready']);
        repo.dispose();
      })
    );
  });

  it('keeps a wait for readiness waiting when a merge ends refusing writes', async () => {
    const { repo, files, adapter } = await startOver(['a']);
    const release = holdNextRead(adapter, files);
    files.set(DATABASE_FILE_PATH, new Uint8Array([1, 2, 3]));
    const reload = repo.handleFileChange(dbFileChange);
    await settle();
    let ready = false;
    void repo.whenReady().then(() => (ready = true));

    release();
    await reload;
    await settle();

    expect(repo.readiness).toBe('starting');
    expect(ready).toBe(false);
    repo.dispose();
  });

  it('is starting for good once disposed, and says so', async () => {
    const { repo } = await startOver(['a']);
    const told = recordStates(repo);

    repo.dispose();

    expect(repo.readiness).toBe('starting');
    expect(told).toEqual(['starting']);
  });

  it('tells a listener nothing once it unsubscribes', async () => {
    const { repo } = await startOver(['a']);
    const listener = vi.fn();
    const stop = repo.onReadinessChange(listener);

    stop();
    repo.dispose();

    expect(listener).not.toHaveBeenCalled();
  });
});
