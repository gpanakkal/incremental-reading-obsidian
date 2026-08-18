import type { DataChangeEvent } from '#/lib/types';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App, TAbstractFile } from 'obsidian';
import { resolve } from 'path';
import type { Database, SqlValue } from 'sql.js';
import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLJSRepository } from './SQLJSRepository';

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
}

function loadSchema(): string {
  return readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
}

async function makeSql(): Promise<initSqlJs.SqlJsStatic> {
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  return initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
}

async function makeRepo(): Promise<{ repo: TestRepository; db: Database }> {
  const SQL = await makeSql();
  const schema = loadSchema();
  const db = new SQL.Database();
  db.exec(schema);
  const repo = TestRepository.createReal(schema, db);
  return { repo, db };
}

async function makeSavingRepo(): Promise<{
  repo: SavingTestRepository;
  db: Database;
}> {
  const SQL = await makeSql();
  const schema = loadSchema();
  const db = new SQL.Database();
  db.exec(schema);
  const repo = SavingTestRepository.createReal(schema, db);
  return { repo, db };
}

function insertArticle(repo: TestRepository, id: string, priority = 30) {
  repo.mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `articles/${id}.md`, Date.now(), 86_400_000, priority]
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

const remoteDbCache = new Map<string, Uint8Array>();

/**
 * Serialized bytes of a database holding exactly `ids` — what another device's
 * copy of the file looks like once Obsidian Sync brings it down.
 */
async function remoteDbBytes(ids: readonly string[]): Promise<Uint8Array> {
  const key = ids.join(',');
  const cached = remoteDbCache.get(key);
  if (cached) return cached;

  const SQL = await getSharedSql();
  const db = new SQL.Database(await getEmptyDbBytes());
  for (const id of ids)
    db.exec(INSERT_ARTICLE_SQL, articleRow(id) as SqlValue[]);
  const bytes = db.export();
  db.close();
  remoteDbCache.set(key, bytes);
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

  static async create(): Promise<SyncedTestRepository> {
    const SQL = await getSharedSql();
    const schema = getSharedSchema();
    let repo!: SyncedTestRepository;
    const adapter = {
      writeBinary: async (_path: string, data: ArrayBuffer) => {
        repo.diskBytes = new Uint8Array(data.slice(0));
      },
      // Resolves against whatever is on disk when the read lands rather than
      // when it was issued, so a save that beats the read wins — as it would
      // on a real filesystem.
      readBinary: async (_path: string) => {
        await new Promise<void>((release) => repo.#parkedReads.push(release));
        return repo.diskBytes.slice().buffer;
      },
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
  protected override async reloadDb() {
    const previous = this.db;
    const result = await super.reloadDb();
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

  /**
   * Wait out the floating `save()` a non-transactional `mutate` starts. Until
   * it settles `pendingSaveCount` is non-zero, which makes `handleFileChange`
   * ignore an incoming sync.
   */
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

    repo.beginSync(await remoteDbBytes(['remote-1']));
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
