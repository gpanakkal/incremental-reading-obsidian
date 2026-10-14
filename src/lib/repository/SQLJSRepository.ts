import {
  applyMigrations,
  getPendingMigrations,
  getSchemaVersion,
  MigrationVerificationError,
} from '#/db/migration-helpers';
import { migrations } from '#/db/migrations';
import {
  BACKUP_DIRECTORY,
  BATCHED_MUTATION_SLICE_MS,
  DATA_DIRECTORY,
  LOG_DIRECTORY,
  TABLE_NAMES,
} from '#/lib/constants';
import type { SyncHoldReason } from '#/lib/obsidian-sync';
import { yieldToHost } from '#/lib/pacing';
import type {
  BulkMutateOptions,
  DataChangeEvent,
  DataChangeListener,
  DataChangeOp,
  MutationStatement,
  NoteType,
  RowTypes,
  SQLiteRepository,
} from '#/lib/types';
import type { Primitive } from '#/lib/utility-types';
import {
  normalizePath,
  Platform,
  type App,
  type DataAdapter,
  type Plugin,
  type TAbstractFile,
} from 'obsidian';
import initSqlJs, {
  type BindParams,
  type Database,
  type QueryExecResult,
} from 'sql.js';
// @ts-ignore - WASM imported as base64 string via custom esbuild plugin.
// Points at the binary shipped with the installed sql.js package so the bundled
// WASM stays in lockstep with the sql.js version in node_modules.
import wasmBase64 from 'sql.js/dist/sql-wasm.wasm';

/**
 * sqlite table name -> queue `NoteType`, for the tables whose rows appear in
 * the review queue. Review-log tables are intentionally absent: their writes
 * never change a queue row directly (the paired item write does).
 */
const ITEM_TABLE_TO_NOTE_TYPE: Readonly<Record<string, NoteType>> = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
};

/**
 * The database file is on disk but could not be loaded. Nothing was written
 * to it.
 */
export class DatabaseLoadError extends Error {
  constructor(readonly dbFilePath: string) {
    super(`Db file found at ${dbFilePath}, but failed to load`);
    this.name = 'DatabaseLoadError';
  }
}

/**
 * Startup was told to stop while it waited on Sync — the plugin is unloading.
 * Nothing was written.
 */
export class StartupCancelledError extends Error {
  constructor() {
    super('Database startup was cancelled while waiting for Sync');
    this.name = 'StartupCancelledError';
  }
}

/**
 * Holds a startup about to write the database file until Sync delivers any
 * newer copy of it (see `holdForSync` in `obsidian-sync.ts`).
 * @returns `'waited'` when Sync may have changed the file meanwhile,
 * `'at-once'` when it went ahead without waiting, or `'cancelled'` when
 * startup is not to go ahead
 */
export type SyncHold = (
  reason: SyncHoldReason
) => Promise<'waited' | 'at-once' | 'cancelled'>;

export class SQLJSRepository implements SQLiteRepository {
  app: App;
  adapter: DataAdapter;
  db: Database | null = null;
  #dbFilePath: string;
  #schema: string;
  #sql: initSqlJs.SqlJsStatic | null = null;
  protected pendingSaveCount: number = 0;
  #onMigrationFailure?: (error: MigrationVerificationError) => void;
  onReloadFromDisk?: () => void | Promise<void>;

  #changeListeners = new Set<DataChangeListener>();
  /**
   * Row changes reported by the update hook during the current `mutate`,
   * grouped by note type then op. Flushed to listeners once the write finishes.
   */
  #pendingChanges = new Map<NoteType, Map<DataChangeOp, Set<string>>>();
  /**
   * How many {@link transaction} calls are currently open. Only the outermost
   * one issues BEGIN/COMMIT/ROLLBACK; a non-zero depth also tells `mutate` to
   * defer saving and change notification to that outermost call.
   */
  #txDepth = 0;
  /**
   * Set when a `modify` event for the database file arrives while a
   * transaction is open, so the reload it asks for can run once that
   * transaction settles. See {@link handleFileChange}.
   */
  #reloadPending = false;
  /**
   * Why writes are refused, or null while they are allowed. Set when the file
   * on disk is one this repository could not load, or one it did not expect
   * to find, so that nothing it holds in memory is saved over that file. A
   * reload that loads the file clears it. See {@link blockWrites}.
   */
  #writeBlock: Error | null = null;
  #onWriteBlocked?: (error: Error) => void;
  #onWritesResumed?: () => void;
  /**
   * Whether `db` is a new database made because no file was on disk at
   * startup, rather than one loaded from the file. Its saves wait on one
   * check that the path is still free; see {@link save}.
   */
  #fresh = false;
  /** The check, made by the first save, that a fresh database's path is free. */
  #freshPathCheck: Promise<void> | null = null;
  /** Set by {@link dispose}; nothing is read from or written to disk after. */
  #disposed = false;
  /** The reload under way, if any. See {@link #reloadFromDisk}. */
  #reloading: Promise<void> | null = null;
  /** Whether the file changed again while {@link #reloading} was under way. */
  #reloadAgain = false;
  /** Creation of the data folder, while one is under way. */
  #creatingDataDir: Promise<void> | null = null;
  /**
   * Set only while {@link start} runs, and spent on first use: startup is
   * the one write a device makes without being asked, and so the one that
   * could overwrite a newer copy Sync has yet to deliver.
   */
  #syncHold: SyncHold | undefined;
  /** Whether startup waited on Sync, which may have changed the file. */
  #waitedOnSync = false;

  /**
   * Use .start to instantiate
   */
  protected constructor(params: {
    app: App;
    dbFilePath: string;
    schema: string;
    onMigrationFailure?: (error: MigrationVerificationError) => void;
    onReloadFromDisk?: () => void | Promise<void>;
    onWriteBlocked?: (error: Error) => void;
    onWritesResumed?: () => void;
  }) {
    this.app = params.app;
    this.adapter = params.app.vault.adapter;
    this.#dbFilePath = normalizePath(params.dbFilePath);
    this.#schema = params.schema;
    this.#onMigrationFailure = params.onMigrationFailure;
    this.onReloadFromDisk = params.onReloadFromDisk;
    this.#onWriteBlocked = params.onWriteBlocked;
    this.#onWritesResumed = params.onWritesResumed;
    this.handleFileChange = this.handleFileChange.bind(this) as (
      file: TAbstractFile
    ) => Promise<void>;
  }

  /**
   * Asynchronous factory function.
   *
   * Loads the database file, or starts on a new, empty database when there is
   * no file on disk. A file that is there but cannot be loaded is never
   * replaced: the factory throws and leaves it as it is.
   * @param plugin the plugin instance
   * @param schema the SQL schema as a string
   * @param onWriteBlocked called when writes start being refused; see
   * {@link blockWrites}
   * @param onWritesResumed called when a reload ends the refusal
   * @param holdForSync awaited before migrating the file, or before starting
   * on a new database when there is none, after which a wait has the file
   * read afresh: Sync may have delivered a newer one meanwhile. Not awaited
   * on a startup that does neither, nor ever again after startup.
   * @param signal an abort stops startup wherever it has got to
   * @throws {DatabaseLoadError} if the file exists but cannot be loaded
   * @throws {MigrationVerificationError} if migrating the file loses data
   * @throws {StartupCancelledError} if `holdForSync` says not to go ahead
   * @throws if no database can be created
   */
  static async start(params: {
    plugin: Plugin;
    dbFilePath: string;
    schema: string;
    onMigrationFailure?: (error: MigrationVerificationError) => void;
    onReloadFromDisk?: () => void | Promise<void>;
    onWriteBlocked?: (error: Error) => void;
    onWritesResumed?: () => void;
    holdForSync?: SyncHold;
    signal?: AbortSignal;
  }): Promise<SQLJSRepository> {
    const repo = new SQLJSRepository({ ...params, app: params.plugin.app });
    repo.#syncHold = params.holdForSync;
    // An unload stops startup wherever it has got to, so an instance being
    // replaced never saves over the file its successor is loading. Only
    // until `start` hands the repository over, which is the plugin's to
    // dispose of from then on.
    const { signal } = params;
    const stop = () => repo.dispose();
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop);
    const assertLive = () => {
      if (!repo.#disposed) return;
      repo.dispose(); // closes a database opened since
      throw new StartupCancelledError();
    };
    try {
      let exists = await repo.dbExists();
      if (!exists && (await repo.#waitOnSync('create'))) {
        exists = await repo.dbExists();
      }
      if (exists) {
        const loaded = await repo.loadDb();
        assertLive();
        if (loaded !== null) return repo;
        // Sync deleting the file while startup waited for it leaves nothing
        // to load, which is no failure to load
        if (!repo.#waitedOnSync || (await repo.dbExists())) {
          throw new DatabaseLoadError(repo.dbFilePath);
        }
      }
      const created = await repo.initDb();
      assertLive();
      if (created === null) throw new Error('Failed to create a database');
      repo.#fresh = true;
      return repo;
    } finally {
      repo.#syncHold = undefined;
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * Spend the startup's Sync hold, if it has one left. A hold that fails is
   * passed over, as if there were no Sync to wait for.
   * @returns whether it waited, so that the file may have changed
   * @throws {StartupCancelledError} if the hold says not to go ahead
   */
  async #waitOnSync(reason: SyncHoldReason): Promise<boolean> {
    const hold = this.#syncHold;
    if (!hold) return false;
    this.#syncHold = undefined;
    let outcome: Awaited<ReturnType<SyncHold>> = 'at-once';
    try {
      outcome = await hold(reason);
    } catch (error) {
      console.error('Incremental Reading - Waiting for Sync failed:', error);
    }
    if (outcome === 'cancelled') throw new StartupCancelledError();
    this.#waitedOnSync = outcome === 'waited';
    return this.#waitedOnSync;
  }

  /**
   * Stop for good: refuse every later write, drop a reload still waiting to
   * run, and close the database. For plugin unload, so an instance being
   * replaced — by an update installed in place, say — can never write its
   * copy of the database over the file the new instance is loading.
   *
   * A save already handed to the adapter cannot be called back, but every
   * save captures its bytes before its first `await`, so none is left holding
   * data newer than what it was asked to write; one that is still waiting to
   * reach the adapter is dropped.
   */
  dispose() {
    this.#disposed = true;
    this.db?.close();
    this.db = null;
  }

  /**
   * Refuse writes until a reload loads the file on disk, and say why through
   * `onWriteBlocked`. Told once per run of refusals, not once per write.
   * @returns `error`, for throwing
   */
  protected blockWrites(error: Error): Error {
    const alreadyBlocked = this.#writeBlock !== null;
    this.#writeBlock = error;
    if (!alreadyBlocked) this.#onWriteBlocked?.(error);
    return error;
  }

  /** @throws if writes are refused (see {@link blockWrites}, {@link dispose}) */
  #assertWritable() {
    if (this.#disposed) {
      throw new Error('Database repository was disposed');
    }
    if (this.#writeBlock) throw this.#writeBlock;
  }

  get dbFilePath() {
    return this.#dbFilePath;
  }

  async handleFileChange(file: TAbstractFile) {
    if (this.#disposed) return;
    if (file.path !== this.dbFilePath || file.deleted) {
      return;
    }
    // skip reload if the changes resulted from saving this db instance to disk.
    // Not for a database made without a file, whose saves have not written
    // one yet: the file is someone else's, and its save must not win.
    if (this.pendingSaveCount > 0 && !this.#fresh) {
      return;
    }
    // A reload replaces `this.db` wholesale, which would orphan an open
    // transaction: its BEGIN belongs to the database being discarded, so the
    // writes made so far vanish, later ones land outside any transaction, and
    // the COMMIT fails on a database that never started one. Hold the reload
    // until the transaction settles — {@link transaction} runs it then.
    if (this.#txDepth > 0) {
      this.#reloadPending = true;
      return;
    }

    await this.#reloadFromDisk();
  }

  /**
   * Reload the database file, reporting rather than throwing on failure.
   *
   * One reload runs at a time. A change that lands while one is under way is
   * folded into a single reload after it, which reads the file as it is by
   * then: reloads run side by side could finish out of order, leaving an
   * older read in memory, or refusing writes over a file a newer read loaded.
   */
  #reloadFromDisk(): Promise<void> {
    if (this.#reloading) {
      this.#reloadAgain = true;
      return this.#reloading;
    }
    const run = async () => {
      try {
        do {
          // A transaction opened while the last pass was under way holds
          // the next one back, as it would any reload
          if (this.#txDepth > 0) {
            this.#reloadPending = true;
            break;
          }
          this.#reloadAgain = false;
          await this.#reloadOnce();
        } while (this.#reloadAgain && !this.#disposed);
      } finally {
        this.#reloading = null;
      }
    };
    this.#reloading = run();
    return this.#reloading;
  }

  /**
   * One pass of {@link #reloadFromDisk}.
   *
   * A file that fails to load leaves the database in memory as it was, still
   * readable, but refuses writes until a later reload succeeds: the file on
   * disk is newer than memory, and saving memory over it would discard
   * whatever another device wrote. A failure is passed over when the file has
   * changed again since, as the reload that follows decides instead.
   */
  async #reloadOnce() {
    try {
      const db = await this.reloadDb();
      if (this.#disposed) return;
      if (db === null) {
        if (this.#reloadAgain) return;
        this.blockWrites(
          new Error(
            'The database file changed on disk but could not be loaded. ' +
              'Changes will not be saved until it loads.'
          )
        );
        return;
      }
      await this.onReloadFromDisk?.();
    } catch (error) {
      if (this.#reloadAgain) {
        console.error(error);
        return;
      }
      if (
        error instanceof MigrationVerificationError &&
        this.#onMigrationFailure
      ) {
        // Refused without `onWriteBlocked`: the handler tells the user
        this.#writeBlock = error;
        this.#onMigrationFailure(error);
      } else {
        if (error instanceof MigrationVerificationError) {
          this.blockWrites(error);
        }
        console.error(error);
      }
    }
  }

  /**
   * Run a reload that arrived while a transaction was open. Left unawaited to
   * match how Obsidian dispatches the `modify` event that asks for it: the
   * transaction is finished either way, and its caller should not wait on a
   * full re-read of the database file.
   */
  #runPendingReload() {
    if (!this.#reloadPending) return;
    this.#reloadPending = false;
    void this.#reloadFromDisk();
  }

  /**
   * Execute a read query and return an array of objects corresponding to table rows
   * @param query
   * @param options `throwOnError` rejects on a failed query instead of
   * resolving to no rows, for a caller that must tell the two apart
   * @returns an array of rows
   */
  query(
    query: string,
    params: Primitive[] = [],
    options?: { throwOnError?: boolean }
  ) {
    const result = this._execSql(query, params, options);
    const rows = result[0];
    return rows;
  }

  /**
   * Execute a write query
   *
   * Unlike {@link query}, a failed write throws rather than resolving to an
   * empty result: callers cannot otherwise distinguish a rejected write from
   * one that legitimately returned no rows, and {@link transaction} needs the
   * failure to decide whether to roll back.
   * @param query
   * @returns an empty array on success
   * @throws if the statement fails
   */
  mutate(query: string, params: Primitive[] = []) {
    this.#assertWritable();
    if (this.#txDepth > 0) {
      // Inside a transaction the caller owns commit/rollback, so changes are
      // buffered and flushed there — a statement that is later rolled back
      // must not notify listeners or reach disk.
      return this._execSql(query, params, { throwOnError: true }) as [][];
    }

    this.#pendingChanges.clear();
    const result = this._execSql(query, params, { throwOnError: true });
    this.#flushChanges();
    // `save` logs its own failures, and the caller has its result already
    this.save().catch(() => undefined);
    return result as [][];
  }

  /**
   * Run `work` inside a SQLite transaction,rolling back if it throws.
   *
   * Statements issued by `work` skip the per-statement save and change
   * notification that {@link mutate} normally performs; both happen once, after
   * a successful commit, so subscribers never observe rolled-back rows and the
   * database file is written once per transaction rather than once per
   * statement.
   *
   * Transactions do not nest: a `transaction` call made while another is open
   * joins the outer one, which alone commits or rolls back. SQLite has no
   * nested transactions, and savepoints would let an inner failure be swallowed
   * while the outer transaction still commits.
   *
   * A reload asked for while the transaction was open — by Obsidian Sync
   * rewriting the database file, say — is held back and run once it settles,
   * so an external write cannot swap the database out mid-transaction.
   * @returns whatever `work` resolves to
   * @throws whatever `work` throws, after rolling back
   */
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (!this.db) throw new Error('Database was not initialized on repository');
    this.#assertWritable();

    if (this.#txDepth > 0) {
      this.#txDepth++;
      try {
        return await work();
      } finally {
        this.#txDepth--;
      }
    }

    this.#pendingChanges.clear();
    this.db.exec('BEGIN');
    this.#txDepth++;
    let result: T;
    try {
      result = await work();
    } catch (error) {
      this.#txDepth--;
      this.db.exec('ROLLBACK');
      // Rolled-back rows were never durable, so their buffered change events
      // must not reach listeners.
      this.#pendingChanges.clear();
      this.#runPendingReload();
      throw error;
    }
    this.#txDepth--;
    this.db.exec('COMMIT');
    this.#flushChanges();
    try {
      await this.save();
    } finally {
      // Even past a failed save: the reload may be what lifts the refusal
      // that failed it
      this.#runPendingReload();
    }
    return result;
  }

  /**
   * Run many writes, in order, as a series of short transactions.
   *
   * Every {@link mutate} outside a transaction saves the whole database file,
   * so hundreds of them rewrite it hundreds of times. A single transaction
   * around them all saves once, but stays open for the entire run, and any
   * unrelated write made meanwhile — a review grade, say — would join it and
   * share its commit or rollback. Chunking keeps both costs down: each chunk
   * of `chunkSize` statements commits, saves and notifies once, then yields a
   * macrotask so other work runs between chunks, outside any transaction.
   *
   * Chunks are measured in time, not statements: a statement costs a small
   * fraction of a millisecond while a yield costs a frame or more, so a chunk
   * of a fixed few statements would spend the run waiting rather than writing.
   *
   * Called inside an open {@link transaction}, the chunks join it instead, so
   * nothing commits until it does and the yields hold it open.
   * @param statements run in order; do any async work before calling, since
   * none can happen inside the transactions
   * @param options `sliceMs` is how long to keep writing before committing a
   * chunk and yielding; `now` is the clock it is measured on
   * @throws {RangeError} if `sliceMs` is not a positive, finite number, before
   * anything is written
   * @throws whatever the first failing statement throws, after rolling back
   * its chunk. Earlier chunks stay committed; later ones never run.
   */
  async bulkMutate(
    statements: readonly MutationStatement[],
    {
      sliceMs = BATCHED_MUTATION_SLICE_MS,
      now = () => performance.now(),
    }: BulkMutateOptions = {}
  ): Promise<void> {
    if (!Number.isFinite(sliceMs) || sliceMs <= 0) {
      throw new RangeError(
        `sliceMs must be a positive, finite number, got ${sliceMs}`
      );
    }

    let next = 0;
    while (next < statements.length) {
      const started = now();
      await this.transaction(() => {
        while (next < statements.length) {
          const { query, params } = statements[next++];
          this.mutate(query, params);
          if (now() - started >= sliceMs) break;
        }
      });
      // Nothing after the last chunk is waiting on the thread being free, so
      // only the gaps between chunks are paid for
      if (next < statements.length) await yieldToHost();
    }
  }

  /**
   * Subscribe to row-level changes on item tables. The listener fires once per
   * (table, op) per `mutate`, with the affected rows' UUID `id`s.
   * @returns an unsubscribe function
   */
  onDataChange(listener: DataChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  /**
   * Register the sql.js update hook on the current `db`. Must be called every
   * time `this.db` is (re)assigned, since the hook binds to that instance.
   *
   * The hook fires once per changed row, mid-statement, and only reads (never
   * writes) the db, as sql.js requires. For inserts and updates the row is
   * still visible, so its UUID `id` is resolvable. Hard SQL `DELETE`s are not
   * resolvable this way (the row is already gone to a nested query) and are
   * skipped — but the app removes items by soft-deleting (an `UPDATE` that sets
   * `deleted`/`dismissed`), which resolves normally, so this is not hit in
   * practice.
   */
  protected registerUpdateHook() {
    this.db?.updateHook((op, _dbName, table, rowId) => {
      const noteType = ITEM_TABLE_TO_NOTE_TYPE[table];
      if (!noteType) return; // not a queue-item table (e.g. a review log)

      const id = this.#resolveRowId(table, rowId);
      if (id === null) return; // unresolvable (e.g. a hard DELETE); skip

      const byOp =
        this.#pendingChanges.get(noteType) ??
        new Map<DataChangeOp, Set<string>>();
      const ids = byOp.get(op) ?? new Set<string>();
      ids.add(id);
      byOp.set(op, ids);
      this.#pendingChanges.set(noteType, byOp);
    });
  }

  /** Resolve a rowid to its UUID `id`, or null if the row is gone. */
  #resolveRowId(table: string, rowId: number): string | null {
    const result = this.db?.exec(`SELECT id FROM ${table} WHERE rowid = $1`, [
      rowId,
    ]);
    const id = result?.[0]?.values[0]?.[0];
    return typeof id === 'string' ? id : null;
  }

  /** Emit one event per buffered (table, op) and clear the buffer. */
  #flushChanges() {
    for (const [table, byOp] of this.#pendingChanges) {
      for (const [op, ids] of byOp) {
        const event: DataChangeEvent = { table, op, ids: [...ids] };
        for (const listener of this.#changeListeners) {
          listener(event);
        }
      }
    }
    this.#pendingChanges.clear();
  }

  /**
   * Execute one or more queries and return an array of objects corresponding to table rows.
   * Use `query` or `mutate` methods above instead where possible.
   *
   * @param query
   * @param params
   * @param options `throwOnError` rethrows a failed statement instead of
   * resolving to an empty result. Reads leave it off, so the many `query`
   * callers keep their empty-array fallback; writes turn it on, since a
   * silently dropped write is indistinguishable from an empty result set.
   * @returns an array where each top-level element is the result of a query
   */
  _execSql(
    query: string,
    params: Primitive[] = [],
    options?: { throwOnError?: boolean }
  ) {
    try {
      const results = this.db?.exec(query, this.coerceParams(params));
      if (!results || !results.length) return [[]];

      // in SQL.js, selected rows are returned in form [{ columns: string[], values: Array<SQLValue[]> }]
      const formatted = results.map((result) => this.formatResult(result));
      return formatted;
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Incremental Reading - Database query failed:', {
          error: error?.message || error,
          query: query.slice(0, 100) + (query.length > 100 ? '...' : ''),
          platform: Platform.isMobile ? 'mobile' : 'desktop',
        });
      }
      if (options?.throwOnError) throw error;
      return [[]];
    }
  }

  /**
   * Converts params to SQLite-appropriate types
   */
  protected coerceParams(params: Primitive[]): BindParams {
    return params.map((param) => {
      switch (typeof param) {
        case 'boolean':
          return Number(param);
        case 'symbol':
          return param.toString();
        case 'undefined':
          return null;
        case 'string':
        case 'number':
        case 'object': // typeof null
          return param;
      }
    });
  }

  /**
   * Format the result of a single query
   */
  protected formatResult<T extends RowTypes>(result: QueryExecResult): T[] {
    const { columns, values } = result;
    const formattedEntries = values.map((row) => {
      const output = row.reduce(
        (acc, cell, i) => Object.assign(acc, { [columns[i]]: cell }),
        {}
      );

      return output;
    });

    return formattedEntries as T[];
  }

  /**
   * Overwrite or create the database file.
   *
   * The first save of a database made because no file was on disk checks
   * that there still is none. One that has appeared since — brought down by
   * Obsidian Sync, or missed at startup — holds data this database has never
   * seen, so writes stop rather than overwrite it.
   *
   * Refused writes are turned away before they reach memory, by `mutate` and
   * `transaction`, so a save is never asked for while writes are refused.
   * @throws if the path is no longer free, or the write fails
   */
  protected async save() {
    if (!this.db) throw new Error('Database was not initialized on repository');
    this.pendingSaveCount++;
    let wroteFresh = false;
    try {
      const source = this.db;
      const data = source.export().buffer;
      // sql.js `export()` tears down the update hook
      this.registerUpdateHook();
      if (this.#fresh) {
        // Shared, so saves started together all wait on one check rather
        // than a later one finding the file an earlier one just wrote
        this.#freshPathCheck ??= this.#checkFreshPath();
        await this.#freshPathCheck;
      }
      // Awaited only when there is something to wait for, so a save with its
      // folder in place reaches the disk without yielding first
      const creatingDataDir = this.#ensureDataDir();
      if (creatingDataDir) await creatingDataDir;
      // A reload that swapped the database meanwhile loaded the file this
      // would write over, and memory is that file now
      if (this.#disposed || this.db !== source) return;
      // The file this writes is this database's own from here on. Cleared
      // before the write, not after: Obsidian's adapter reports the file it
      // wrote (`reconcileInternalFile`, undocumented) before the write
      // settles, and `handleFileChange` must take that for this save's echo.
      // Reloading it instead swapped `db` under the writes made meanwhile,
      // and a save still waiting then dropped one for good.
      wroteFresh = this.#fresh;
      this.#fresh = false;
      return await this.app.vault.adapter.writeBinary(
        normalizePath(this.#dbFilePath),
        data as ArrayBuffer
      );
    } catch (error) {
      // Nothing was written that this database can count as its file
      if (wroteFresh) this.#fresh = true;
      if (error instanceof Error) {
        console.error('Incremental Reading - Failed to save database:', {
          error: 'message' in error ? error.message : error,
          platform: Platform,
          dbPath: this.#dbFilePath,
        });
        throw error; // Re-throw to surface critical save failures
      }
    } finally {
      this.pendingSaveCount--;
    }
  }

  /**
   * Create the data folder if it is missing. Saves that find it missing
   * together share one creation, since a second would fail on the folder the
   * first made, and every save waits it out, even one that finds the folder
   * already indexed: one that did not would write ahead of the saves still
   * waiting, and an older one would land last. A folder the vault index
   * misses but the disk holds is fine.
   */
  #ensureDataDir(): Promise<void> | undefined {
    if (this.#creatingDataDir) return this.#creatingDataDir;
    if (this.app.vault.getFolderByPath(DATA_DIRECTORY)) return;
    this.#creatingDataDir ??= this.app.vault
      .createFolder(DATA_DIRECTORY)
      .then(
        () => undefined,
        async (error: unknown) => {
          if (!(await this.adapter.exists(normalizePath(DATA_DIRECTORY)))) {
            throw error;
          }
        }
      )
      .finally(() => {
        this.#creatingDataDir = null;
      });
    return this.#creatingDataDir;
  }

  /**
   * Settle once a fresh database may take its path, or block writes and throw
   * if a file is already there.
   */
  async #checkFreshPath() {
    if (await this.adapter.exists(normalizePath(this.#dbFilePath))) {
      throw this.blockWrites(
        new Error(
          'A database file appeared on disk after the plugin started without ' +
            'one. Changes will not be saved, so the file is left as it is; ' +
            'reload the plugin to load it.'
        )
      );
    }
  }

  /**
   * Initialize the in-memory database.
   * If a database file exists, use `loadDb()` instead
   * @returns a Database, or null if an error is thrown
   */
  protected async initDb() {
    try {
      this.#sql ||= await this.loadWasm();
      this.db = new this.#sql.Database();
      this.db.exec(this.#schema);
      this.db.exec('PRAGMA foreign_keys = ON');
      this.registerUpdateHook();
      return this.db;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  /**
   * Check if the database file exists on disk.
   *
   * Asks the adapter rather than the vault's file index: the index can miss a
   * file that is there — while Obsidian Sync rewrites it, or while the index
   * churns around a plugin reload — and a miss here would start the plugin on
   * an empty database that its first write then saves over the real one.
   */
  protected dbExists() {
    return this.adapter.exists(normalizePath(this.#dbFilePath));
  }

  /**
   * Attempt to load a pre-existing database from disk
   * @returns a Database, or `null` if the file is invalid or not found
   * @throws {MigrationVerificationError} if post-migration verification fails
   */
  protected async loadDb() {
    try {
      const result = await this.reloadDb();
      if (!result) {
        console.error('Incremental Reading - Failed to load database');
        return null;
      }
      return result;
    } catch (error) {
      if (
        error instanceof MigrationVerificationError ||
        error instanceof StartupCancelledError
      ) {
        throw error;
      }
      console.error(error);
      return null;
    }
  }

  /**
   * Attempt to reload a pre-existing database from disk.
   * If migrations are pending, backs up the database first and verifies
   * data integrity after applying them.
   * @returns a Database, or `null` if the file is invalid or not found
   * @throws if the latest schema version is lower than the database's
   * current version, or if post-migration verification fails
   */
  protected async reloadDb(): Promise<Database | null> {
    const previous = this.db;
    let candidate: Database | null = null;
    try {
      this.#sql ||= await this.loadWasm();
      const dbArrayBuffer = await this.app.vault.adapter.readBinary(
        normalizePath(this.#dbFilePath)
      );
      if (this.#disposed) return null;
      // Use browser-compatible Uint8Array instead of Node.js Buffer
      // for mobile compatibility
      candidate = new this.#sql.Database(new Uint8Array(dbArrayBuffer));
      candidate.exec('PRAGMA foreign_keys = ON');
      const result = candidate.exec('PRAGMA integrity_check');
      const status = result[0]?.values[0]?.[0] as string;
      if (status !== 'ok') {
        throw new Error(`integrity_check failed: ${status}`);
      }
      // SQLite opens a file too short to hold a header as an empty database,
      // which would pass for one at schema version 0 and be migrated and saved
      // over whatever the file was meant to hold — a sync still in progress,
      // say. Every database this plugin writes has tables.
      if (candidate.exec('SELECT 1 FROM sqlite_master LIMIT 1').length === 0) {
        throw new Error('the file holds no database');
      }

      const currentDbVersion = getSchemaVersion(candidate);
      const latestSchemaVersion = migrations[migrations.length - 1].version;
      if (currentDbVersion > latestSchemaVersion) {
        throw new Error(
          `Plugin is out of date with the database. ` +
            `Please ensure the plugin is fully updated, then re-enable it.`
        );
      }

      // A startup about to migrate waits for Sync first, then reads the file
      // again if it waited: what Sync brought down meanwhile may be migrated
      // already
      if (
        this.#syncHold &&
        getPendingMigrations(candidate, migrations).length > 0 &&
        (await this.#waitOnSync('migrate'))
      ) {
        candidate.close();
        candidate = null;
        return await this.reloadDb();
      }

      // Only a file that loaded replaces the database in memory: one that did
      // not leaves the previous one in place, never a broken or empty stand-in
      // that a later write would save over the file.
      this.db = candidate;
      this.registerUpdateHook();
      this.#fresh = false;

      const pending = getPendingMigrations(this.db, migrations);
      if (pending.length > 0) {
        await this.backupDatabase(currentDbVersion);

        const preRowCounts = this.snapshotRowCounts();
        const preFkIssues = this.foreignKeyCheck();

        // Aggregate expected row count changes across all pending migrations
        const expectedChanges: Record<string, number> = {};
        for (const migration of pending) {
          if (migration.expectedRowCountChanges) {
            for (const [table, delta] of Object.entries(
              migration.expectedRowCountChanges
            )) {
              expectedChanges[table] = (expectedChanges[table] ?? 0) + delta;
            }
          }
        }

        const updated = applyMigrations(this.db, pending);

        if (updated) {
          const verification = this.verifyMigration(
            preRowCounts,
            preFkIssues,
            Object.keys(expectedChanges).length > 0
              ? expectedChanges
              : undefined
          );

          if (!verification.passed) {
            const newVersion = getSchemaVersion(this.db);
            const logPath = await this.writeErrorLog(verification.errors, {
              previousVersion: currentDbVersion,
              targetVersion: newVersion,
            });

            console.error(
              'Incremental Reading - Migration verification failed:',
              verification.errors
            );

            throw new MigrationVerificationError(
              `Migration verification failed (v${currentDbVersion} -> v${newVersion}). See log: ${logPath}`,
              verification.errors,
              logPath
            );
          }

          await this.save();
        }
      }

      if (this.#writeBlock) {
        this.#writeBlock = null;
        this.#onWritesResumed?.();
      }
      // Nothing holds the replaced database across an await: reloads wait
      // out transactions, and every other use is synchronous
      previous?.close();
      return this.db;
    } catch (error) {
      if (candidate) {
        if (this.db === candidate) {
          this.db = previous;
          this.registerUpdateHook();
        }
        candidate.close();
      }
      if (
        error instanceof MigrationVerificationError ||
        error instanceof StartupCancelledError
      ) {
        throw error;
      }
      if (error instanceof Error) {
        console.error('Incremental Reading - Failed to reload database:', {
          error: error?.message || error,
          platform: Platform.isMobile ? 'mobile' : 'desktop',
          dbPath: this.#dbFilePath,
        });
      }
      return null;
    }
  }

  /**
   * Back up the database file before applying migrations.
   * Verifies backup integrity via SHA-256 checksum comparison.
   */
  protected async backupDatabase(currentVersion: number): Promise<string> {
    const dirExists = await this.adapter.exists(
      normalizePath(BACKUP_DIRECTORY)
    );
    if (!dirExists) {
      await this.adapter.mkdir(normalizePath(BACKUP_DIRECTORY));
    }

    const originalData = await this.adapter.readBinary(
      normalizePath(this.#dbFilePath)
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `ir-user-data_v${currentVersion}_${timestamp}.sqlite`;
    const backupPath = normalizePath(`${BACKUP_DIRECTORY}/${backupFileName}`);

    await this.adapter.writeBinary(backupPath, originalData);

    // Verify backup integrity via SHA-256 checksum
    const backupData = await this.adapter.readBinary(backupPath);
    const [originalHash, backupHash] = await Promise.all([
      this.sha256(originalData),
      this.sha256(backupData),
    ]);

    if (originalHash !== backupHash) {
      throw new Error(
        `Backup verification failed: checksum mismatch for ${backupPath}`
      );
    }

    console.debug(`Incremental Reading - Database backed up to ${backupPath}`);
    return backupPath;
  }

  protected async sha256(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  protected snapshotRowCounts(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const table of TABLE_NAMES) {
      try {
        if (!this.db) throw new Error(`Database not initialized`);
        const result = this.db.exec(`SELECT COUNT(*) FROM ${table}`);
        snapshot[table] = (result[0]?.values[0]?.[0] as number) ?? 0;
      } catch {
        snapshot[table] = -1; // table may not exist yet
      }
    }
    return snapshot;
  }

  protected foreignKeyCheck(): string | null {
    try {
      if (!this.db) throw new Error(`Database not initialized`);
      this.db.exec('PRAGMA foreign_keys = ON');
      const fkResult = this.db.exec('PRAGMA foreign_key_check');
      if (fkResult.length > 0 && fkResult[0].values.length > 0) {
        return `foreign_key_check found ${fkResult[0].values.length} violation(s): ${JSON.stringify(fkResult[0].values.slice(0, 5))}`;
      }
      return null;
    } catch (e) {
      return `foreign_key_check threw: ${e}`;
    }
  }

  protected verifyMigration(
    preRowCounts: Record<string, number>,
    preFkIssues: string | null,
    expectedRowCountChanges?: Record<string, number>
  ): { passed: boolean; errors: string[] } {
    const errors: string[] = [];

    // 1. Structural integrity
    try {
      if (!this.db) throw new Error(`Database not initialized`);
      const result = this.db.exec('PRAGMA integrity_check');
      const status = result[0]?.values[0]?.[0] as string;
      if (status !== 'ok') {
        errors.push(`integrity_check failed: ${status}`);
      }
    } catch (e) {
      errors.push(`integrity_check threw: ${e}`);
    }

    // 2. Foreign key integrity — only flag new issues introduced by the migration
    const postFkIssues = this.foreignKeyCheck();
    if (postFkIssues !== null && postFkIssues !== preFkIssues) {
      errors.push(postFkIssues);
    }

    // 3. Row count comparison
    const postRowCounts = this.snapshotRowCounts();
    for (const table of TABLE_NAMES) {
      const pre = preRowCounts[table];
      const post = postRowCounts[table];
      if (pre === -1) continue; // table didn't exist before migration
      const expectedDelta = expectedRowCountChanges?.[table] ?? 0;
      const actualDelta = post - pre;
      if (actualDelta !== expectedDelta) {
        errors.push(
          `Row count mismatch for "${table}": expected delta ${expectedDelta}, got ${actualDelta} (was ${pre}, now ${post})`
        );
      }
    }

    // 4. CHECK constraint spot-checks
    const checkQueries = [
      {
        sql: `SELECT COUNT(*) FROM article WHERE priority < 10 OR priority > 50`,
        desc: 'article priority out of range',
      },
      {
        sql: `SELECT COUNT(*) FROM article WHERE dismissed NOT IN (0, 1)`,
        desc: 'article dismissed invalid',
      },
      {
        sql: `SELECT COUNT(*) FROM snippet WHERE priority < 10 OR priority > 50`,
        desc: 'snippet priority out of range',
      },
      {
        sql: `SELECT COUNT(*) FROM srs_card WHERE state < 0 OR state > 3`,
        desc: 'srs_card state out of range',
      },
    ];
    for (const check of checkQueries) {
      try {
        if (!this.db) throw new Error(`Database not initialized`);
        const result = this.db.exec(check.sql);
        const count = (result[0]?.values[0]?.[0] as number) ?? 0;
        if (count > 0) {
          errors.push(`CHECK violation: ${check.desc} (${count} rows)`);
        }
      } catch (e) {
        errors.push(`CHECK validation threw for "${check.desc}": ${e}`);
      }
    }

    return { passed: errors.length === 0, errors };
  }

  protected async writeErrorLog(
    errors: string[],
    context: { previousVersion: number; targetVersion: number }
  ): Promise<string> {
    const dirExists = await this.adapter.exists(normalizePath(LOG_DIRECTORY));
    if (!dirExists) {
      await this.adapter.mkdir(normalizePath(LOG_DIRECTORY));
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFileName = `migration-error_v${context.previousVersion}-to-v${context.targetVersion}_${timestamp}.log`;
    const logPath = normalizePath(`${LOG_DIRECTORY}/${logFileName}`);

    const content = [
      `Incremental Reading Plugin - Migration Verification Failure`,
      `Timestamp: ${new Date().toISOString()}`,
      `Migration: v${context.previousVersion} -> v${context.targetVersion}`,
      ``,
      `Errors:`,
      ...errors.map((e, i) => `  ${i + 1}. ${e}`),
    ].join('\n');

    await this.adapter.write(logPath, content);
    return logPath;
  }

  protected async loadWasm() {
    // Decode base64 WASM to binary using browser-compatible API (instead of Node.js Buffer)
    // This ensures compatibility with mobile devices (iOS/Android WebView)
    const binaryString = atob(wasmBase64 as string);
    const wasmBinary = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      wasmBinary[i] = binaryString.charCodeAt(i);
    }

    try {
      const sql = await initSqlJs({
        wasmBinary: wasmBinary as unknown as ArrayBuffer,
      });
      return sql;
    } catch (error) {
      console.error('Incremental Reading - Failed to initialize WASM:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          name: error?.name,
          message: error?.message,
          stack: error?.stack,
        });
      }
      throw error;
    }
  }
}
