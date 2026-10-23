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
import { getDeviceId } from '#/lib/device-id';
import { notify } from '#/lib/notices';
import type { SyncHoldReason } from '#/lib/obsidian-sync';
import { yieldToHost } from '#/lib/pacing';
import type {
  BulkMutateOptions,
  DataChangeEvent,
  DataChangeListener,
  DataChangeOp,
  MutationStatement,
  NoteType,
  Readiness,
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
import { BulkMutateError } from './BulkMutateError';
import { ContentWatch, type ContentMark } from './content-watch';
import { backupFileName, pruneBackups, pruneDatabase } from './retention';
import {
  mergeInto,
  mergeUnlessLossy,
  openIncoming,
  type MergeReport,
} from './row-merge';
import { armRowStamps, disarmRowStamps } from './row-stamps';
import { recordSave } from './save-stats';
import {
  DEFAULT_REPLAY_SETTINGS,
  type ReplaySettings,
} from './scheduling-replay';
import {
  bumpWriteStamp,
  classifyIncoming,
  loadKnownWriteVector,
  readFileWriteVector,
  readWriteVector,
  saveKnownWriteVector,
  type IncomingKind,
  type WriteVector,
} from './write-stamp';
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
 * Why a copy of the database was backed up: before a migration (no marker),
 * before another device's copy replaced one this device could not merge
 * (`merge`), or before a copy from a device away for months replaced this
 * device's own stale one (`stale`). Named in the file, so each kind can be
 * pruned on its own.
 */
export type BackupMarker = 'merge' | 'stale';

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
  /** The `updated_by` of every row this device writes; read on first use. */
  #deviceId: string | undefined;
  /**
   * The clock row stamps and write stamp generations are drawn from (see
   * `armRowStamps`, `bumpWriteStamp`).
   */
  #stampClock: () => number;
  /**
   * This device's generation in the database in memory (its `write_stamp`
   * row, 0 if none), read each time the row stamps are armed: after every
   * save, load and merge.
   */
  #ownGeneration = 0;
  /**
   * The clock row stamps are drawn from: {@link #stampClock}, but always past
   * the generation this device last saved, so a row it writes is never
   * stamped at or below a save it already sent (a write in the same
   * millisecond as a save, or after the clock went back). Another device
   * holding that save would otherwise count the row as seen (row-merge.ts).
   */
  #rowClock = () => Math.max(this.#stampClock(), this.#ownGeneration + 1);
  /** The settings a merge replays review logs with, as they are now. */
  #replaySettings: () => ReplaySettings;
  /** Tells writes that changed nothing from the rest, which alone save. */
  #content = new ContentWatch();
  /** How many {@link onReloadFromDisk} calls are running. */
  #reloadCallbacks = 0;
  /**
   * Saves begun so far, and the latest of them that wrote and that failed
   * (0174). Each exports when it begins, so holds all an earlier one did:
   * past a failure no later save made good, memory holds changes the file
   * lacks, and the next write saves even if it changes nothing.
   */
  #saves = { begun: 0, wrote: 0, failed: 0 };
  /**
   * Whether a backup was written since retention last ran (0173): the reload
   * pass that wrote it runs {@link applyRetention} once it is done.
   */
  #retentionDue = false;
  /**
   * The write stamp of the file {@link reloadDb} last read, as it was before
   * any migration: what startup measures against the stamp this device last
   * knew the file by.
   */
  #loadedStamp: WriteVector | null = null;
  /** What startup found the file on disk to be; see {@link startupKind}. */
  #startupKind: IncomingKind | null = null;
  /**
   * Set while {@link start} runs, so {@link readiness} is `starting` until
   * the file on disk is loaded, migrated and classified (see
   * {@link startupKind}): a write before that would bump this device's write
   * stamp and hide what the file was.
   */
  #starting = false;
  /** Set while a reload reads, classifies and takes in the file on disk. */
  #merging = false;
  #readinessListeners = new Set<(state: Readiness) => void>();
  /** The {@link readiness} listeners were last told of. */
  #toldReadiness: Readiness = 'ready';

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
    /** Stands in for this install's id (see `getDeviceId`), for tests. */
    deviceId?: string;
    /** Stands in for `Date.now` as the clock of stamps, for tests. */
    stampClock?: () => number;
    /** The settings a merge replays review logs with (see `mergeInto`). */
    replaySettings?: () => ReplaySettings;
  }) {
    this.app = params.app;
    this.#deviceId = params.deviceId;
    this.#stampClock = params.stampClock ?? (() => Date.now());
    this.#replaySettings =
      params.replaySettings ?? (() => DEFAULT_REPLAY_SETTINGS);
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
   * @param holdForSync awaited before migrating the file, after which a wait
   * has the file read afresh: Sync may have delivered a newer one meanwhile.
   * Not awaited on a startup with nothing to migrate, a new database
   * included, nor ever again after startup: a copy Sync delivers later is
   * classified and taken in when it arrives (see `#answerIncoming`).
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
    replaySettings?: () => ReplaySettings;
  }): Promise<SQLJSRepository> {
    const repo = new SQLJSRepository({ ...params, app: params.plugin.app });
    repo.#syncHold = params.holdForSync;
    repo.#starting = true;
    repo.#readinessChanged();
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
    // Read before loading, which stores the stamp of the file it loads
    const known = loadKnownWriteVector(repo.app);
    try {
      // No file, no wait: a copy Sync delivers later is taken in by the
      // reload its arrival asks for (see `#answerIncoming`)
      if (await repo.dbExists()) {
        const loaded = await repo.loadDb();
        assertLive();
        if (loaded !== null) {
          repo.#classifyAtStartup(known);
          await repo.applyRetention();
          assertLive();
          return repo;
        }
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
      await repo.applyRetention(); // backups outlive a database deleted
      assertLive();
      return repo;
    } finally {
      repo.#syncHold = undefined;
      repo.#starting = false;
      repo.#readinessChanged();
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * What the file on disk was at startup, measured against the stamp of the
   * file this device last wrote or took on: anything but `echo` means
   * something else wrote it while the plugin was not running. Null when
   * startup made a new database, or this device had no stamp stored (a first
   * run, or localStorage that can't be read), or the file had none (an older
   * plugin version wrote it).
   */
  get startupKind(): IncomingKind | null {
    return this.#startupKind;
  }

  /**
   * Classify the file startup loaded (see {@link startupKind}). Nothing is
   * left to back up by now: the copy this device last wrote is gone from
   * disk, and was never loaded. So a file that lacks this device's last save
   * is only reported.
   */
  #classifyAtStartup(known: WriteVector | null) {
    const loaded = this.#loadedStamp;
    if (!known || !loaded) return;
    const kind = classifyIncoming(known, loaded, this.#stampClock());
    this.#startupKind = kind;
    if (kind === 'echo' || kind === 'fast-forward') return;
    console.warn(
      'Incremental Reading - The database file changed while the plugin ' +
        'was not running, and lacks saves this device knew of:',
      { kind, known, loaded }
    );
  }

  /**
   * Apply the retention policy (0173, `retention.ts`): delete tombstones and
   * `write_stamp` devices past the sync horizon, saving if any went, then
   * backups past their window. Runs once at startup and after each reload
   * pass that wrote a backup. While writes are refused or a transaction is
   * open it does nothing and stays due, for the next pass. Never throws: a
   * failure is logged, and retried after the next backup.
   */
  async applyRetention(): Promise<void> {
    const db = this.db;
    // 0171: also wait for `readiness === 'ready'` here once that lands; until
    // then the write block is the gate
    if (!db || this.writeRefusal() || this.#txDepth > 0) {
      this.#retentionDue = true;
      return;
    }
    this.#retentionDue = false;
    const now = this.#stampClock();
    try {
      const pruned = pruneDatabase(db, now, {
        deviceId: () => this.#device(),
        now: this.#rowClock,
      });
      // Saved at once, past 0174's gate: `write_stamp` is no content to it,
      // yet memory's stamp must match the last export (`classifyIncoming`)
      if (pruned.rows + pruned.devices > 0) await this.save();
      await pruneBackups(this.adapter, now);
    } catch (error) {
      console.error('Incremental Reading - Retention failed:', error);
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
    this.#readinessChanged();
  }

  /**
   * Refuse writes until a reload loads the file on disk, and say why through
   * `onWriteBlocked`. Told once per run of refusals, not once per write.
   * @returns `error`, for throwing
   */
  protected blockWrites(error: Error): Error {
    const alreadyBlocked = this.#writeBlock !== null;
    this.#writeBlock = error;
    this.#readinessChanged();
    if (!alreadyBlocked) this.#onWriteBlocked?.(error);
    return error;
  }

  /**
   * Why a write would be refused now (see {@link blockWrites},
   * {@link dispose}), or null when it would not be: for an operation that
   * also writes files to check before touching any.
   */
  writeRefusal(): Error | null {
    if (this.#disposed) return new Error('Database repository was disposed');
    return this.#writeBlock;
  }

  /** @throws if writes are refused (see {@link writeRefusal}) */
  #assertWritable() {
    const refusal = this.writeRefusal();
    if (refusal) throw refusal;
  }

  /**
   * Whether this is inside {@link onReloadFromDisk}: reads made then are the
   * refetch of a database just swapped in, possibly ahead of the notes that
   * Sync delivers as separate files, so they must not write repairs
   * (`ItemManager.reconcileNote`).
   */
  get refetchingAfterReload(): boolean {
    return this.#reloadCallbacks > 0;
  }

  /**
   * Whether actions may start (see `gate` in `readiness.ts`): `starting`
   * while {@link start} runs or writes are refused (see
   * {@link writeRefusal}), `merging` while a reload reads, classifies and
   * takes in the file on disk, `ready` otherwise.
   */
  get readiness(): Readiness {
    if (this.#starting || this.writeRefusal()) return 'starting';
    return this.#merging ? 'merging' : 'ready';
  }

  onReadinessChange(listener: (state: Readiness) => void): () => void {
    this.#readinessListeners.add(listener);
    return () => this.#readinessListeners.delete(listener);
  }

  whenReady(): Promise<void> {
    if (this.readiness === 'ready') return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.onReadinessChange((state) => {
        if (state !== 'ready') return;
        stop();
        resolve();
      });
    });
  }

  /** Tell the {@link readiness} listeners, if it changed since last told. */
  #readinessChanged() {
    const state = this.readiness;
    if (state === this.#toldReadiness) return;
    this.#toldReadiness = state;
    for (const listener of [...this.#readinessListeners]) listener(state);
  }

  /**
   * Mark a reload's read, classification and take-in as under way, or over.
   * A write block it set or lifted meanwhile is told when it ends.
   */
  #setMerging(merging: boolean) {
    this.#merging = merging;
    this.#readinessChanged();
  }

  get dbFilePath() {
    return this.#dbFilePath;
  }

  async handleFileChange(file: TAbstractFile) {
    if (this.#disposed) return;
    if (file.path !== this.dbFilePath || file.deleted) {
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
          // A change that came in meanwhile is answered first
          if (this.#retentionDue && !this.#reloadAgain) {
            await this.applyRetention();
          }
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
   * The file is read once, and what to do with it is decided by its write
   * stamp (see {@link #answerIncoming}): this device's own save coming back
   * is left alone, while another device's copy is taken on, or merged into
   * memory when each holds saves the other lacks.
   *
   * A file that fails to load leaves the database in memory as it was, still
   * readable, but refuses writes until a later reload succeeds: the file on
   * disk is newer than memory, and saving memory over it would discard
   * whatever another device wrote. A failure is passed over when the file has
   * changed again since, as the reload that follows decides instead.
   */
  async #reloadOnce() {
    this.#setMerging(true);
    try {
      const incoming = await this.#readIncoming();
      // What follows may export or save the database, which would end a
      // transaction opened while the file was read; hold it back like any
      // reload that comes due during one
      if (this.#txDepth > 0) {
        this.#reloadPending = true;
        return;
      }
      if (incoming && !(await this.#answerIncoming(incoming))) return;
      const db = incoming ? await this.reloadDb(incoming.bytes) : null;
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
      // Taken in: what follows only refetches
      this.#setMerging(false);
      this.#reloadCallbacks++;
      try {
        await this.onReloadFromDisk?.();
      } finally {
        this.#reloadCallbacks--;
      }
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
    } finally {
      this.#setMerging(false);
    }
  }

  /**
   * Read the database file and its write stamp, or null if it can't be read.
   */
  async #readIncoming(): Promise<{
    bytes: ArrayBuffer;
    stamp: WriteVector | 'unstamped' | 'unreadable';
  } | null> {
    try {
      this.#sql ||= await this.loadWasm();
      const bytes = await this.app.vault.adapter.readBinary(
        normalizePath(this.#dbFilePath)
      );
      const stamp = readFileWriteVector(
        this.#sql,
        new Uint8Array(bytes),
        migrations[migrations.length - 1].version
      );
      return { bytes, stamp };
    } catch (error) {
      console.error('Incremental Reading - Failed to read database:', error);
      return null;
    }
  }

  /**
   * Decide what to do with the file that arrived, by its write stamp against
   * the stamp of the database in memory (see `classifyIncoming`):
   *
   * - this device's own save coming back (`echo`), or an older one
   *   (`behind`), is left alone. A file older than memory with no save of
   *   memory on the way would stay older, so memory is saved over it.
   * - a copy from a device away for months (`stale-other`) is left alone,
   *   and memory saved over it, so that device takes this one on in turn.
   * - a copy that has every save memory has (`fast-forward`) is taken on.
   * - one from a device that has every save memory has, but more than six
   *   months on (`stale-self`), is taken on after memory is backed up, since
   *   the saves it lacks are dropped.
   * - one where each has saves the other lacks (`merge`) is merged into
   *   memory (see {@link #mergeIncoming}), and never taken on.
   *
   * A file that is not a database is loaded all the same, which refuses it.
   * So is every file while writes are refused, since only loading one lifts
   * the refusal. One older than the write stamp (an older plugin version
   * wrote it) can't be placed, so is merged.
   * @returns whether to take the file on
   * @throws if the backup fails, taking nothing on
   */
  async #answerIncoming(incoming: {
    bytes: ArrayBuffer;
    stamp: WriteVector | 'unstamped' | 'unreadable';
  }): Promise<boolean> {
    const { stamp } = incoming;
    if (stamp === 'unreadable' || this.#writeBlock || !this.db) return true;
    const kind =
      stamp === 'unstamped'
        ? 'merge'
        : classifyIncoming(
            readWriteVector(this.db) ?? {},
            stamp,
            this.#stampClock()
          );
    switch (kind) {
      case 'echo':
        return false;
      case 'behind':
      case 'stale-other':
        if (kind === 'stale-other' || this.pendingSaveCount === 0) {
          // Straight to `save`, past the gate that skips writes changing
          // nothing (`#contentChanged`, 0174): memory is unchanged on
          // purpose, and the point is to put it over the file. `save` logs
          // its own failures
          this.save().catch(() => undefined);
        }
        return false;
      case 'fast-forward':
        return true;
      case 'stale-self':
        return this.#backUpMemory(this.db, 'stale');
      case 'merge':
        // A database started without a file merges nothing: its first save
        // is still checking that no file appeared, and would find this one
        // and refuse writes. Taken on instead, as a reload makes that save
        // write nothing.
        if (this.#fresh) return this.#backUpMemory(this.db, 'merge');
        return this.#mergeIncoming(this.db, incoming.bytes);
    }
  }

  /**
   * Back up the database in memory before another device's copy changes it.
   * @returns whether to go on: not when the repository was disposed meanwhile,
   * or a transaction opened, which holds the reload back
   * @throws if the backup fails
   */
  async #backUpMemory(db: Database, marker: BackupMarker): Promise<boolean> {
    await this.backupDatabase(getSchemaVersion(db), {
      marker,
      data: this.#exportDb(db).buffer as ArrayBuffer,
    });
    // Reloads run one at a time, so only disposal can have replaced
    // the database meanwhile
    if (this.#disposed) return false;
    if (this.#txDepth > 0) {
      this.#reloadPending = true;
      return false;
    }
    return true;
  }

  /**
   * Merge another device's copy into memory, row by row (see `mergeInto`),
   * then save, so that the other device takes the result on as a
   * fast-forward. The one way into a merge.
   *
   * Memory is backed up first only when the merge would lose rows of this
   * device's that the copy never saw, and the user is told how many. Should
   * the merge itself fail, nothing of it stays, and the copy is taken on
   * after a backup instead, as before merging existed.
   * @returns whether to take the copy on instead
   * @throws if the backup fails, merging nothing
   */
  async #mergeIncoming(db: Database, bytes: ArrayBuffer): Promise<boolean> {
    let incoming: Database;
    try {
      incoming = openIncoming(this.#sql!, new Uint8Array(bytes), migrations);
    } catch (error) {
      return this.#mergeFailed(db, error, false);
    }
    let report: MergeReport;
    try {
      const stamps = { deviceId: () => this.#device(), now: this.#rowClock };
      let clean: MergeReport | null;
      try {
        clean = mergeUnlessLossy(db, incoming, stamps, this.#replaySettings());
      } catch (error) {
        return await this.#mergeFailed(db, error, false);
      }
      if (clean) {
        report = clean;
      } else {
        // Nothing merged yet: memory is backed up as it stands, then merged
        if (!(await this.#backUpMemory(db, 'merge'))) return false;
        try {
          report = mergeInto(db, incoming, stamps, this.#replaySettings());
        } catch (error) {
          return await this.#mergeFailed(db, error, true);
        }
      }
      // The merge takes the newer generation of each device, this one's too
      this.#readOwnGeneration(db);
    } finally {
      incoming.close();
    }
    // Listeners hear of the rows the merge changed, as of any write
    this.#flushChanges();
    // Straight to `save`, past the gate that skips writes changing nothing
    // (`#contentChanged`, 0174): a merge that changed no row still has a
    // write stamp the other device must take on. `save` logs its own failures
    this.save().catch(() => undefined);
    if (report.replaced > 0) {
      notify(
        `Merged changes from another device, replacing ${report.replaced} ` +
          `local ${report.replaced === 1 ? 'change' : 'changes'}. ` +
          `A backup was saved.`
      );
    }
    // Merged, committed and its save under way: what follows only refetches,
    // as after a take-in (see `#reloadOnce`), so writes held over the merge
    // land now instead of waiting out the refetch too
    this.#setMerging(false);
    if (report.written > 0) {
      // Merged rows may be ahead of the notes Sync brings, as a reload's are
      this.#reloadCallbacks++;
      try {
        await this.onReloadFromDisk?.();
      } finally {
        this.#reloadCallbacks--;
      }
    }
    return false;
  }

  /**
   * Fall back to taking a copy on that could not be merged, after memory is
   * backed up, unless it already was.
   * @returns whether to take the copy on
   */
  async #mergeFailed(
    db: Database,
    error: unknown,
    backedUp: boolean
  ): Promise<boolean> {
    console.error('Incremental Reading - Failed to merge database:', error);
    return backedUp || this.#backUpMemory(db, 'merge');
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
    const mark = this.#markContent(); // 0174
    const result = this._execSql(query, params, { throwOnError: true });
    this.#flushChanges();
    // `save` logs its own failures, and the caller has its result already
    if (this.#contentChanged(mark)) this.save().catch(() => undefined); // 0174
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
    const mark = this.#markContent(); // 0174
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
      if (this.#contentChanged(mark)) await this.save(); // 0174
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
   * nothing commits until it does and the yields hold it open; a failure then
   * rolls nothing back here, leaving that to the open transaction, and the
   * count a {@link BulkMutateError} gives is of the chunks that ran in full.
   * @param statements run in order; do any async work before calling, since
   * none can happen inside the transactions
   * @param options `sliceMs` is how long to keep writing before committing a
   * chunk and yielding; `now` is the clock it is measured on
   * @throws {RangeError} if `sliceMs` is not a positive, finite number, before
   * anything is written
   * @throws {BulkMutateError} when the run stops short: at a failing
   * statement, whose chunk is rolled back; at writes being refused; or at a
   * save that failed, whose chunk had committed and counts as such. Its
   * `committed` says how many statements, from the first, are in the database;
   * the rest never ran, or were rolled back. A caller that did work for each
   * statement beforehand takes back the work of the rest.
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

    let committed = 0;
    try {
      while (committed < statements.length) {
        const started = now();
        let next = committed;
        await this.transaction(() => {
          while (next < statements.length) {
            const { query, params } = statements[next++];
            this.mutate(query, params);
            if (now() - started >= sliceMs) break;
          }
          // The chunk commits once this returns, so a save that fails after
          // it leaves these in the database all the same
          committed = next;
        });
        // Nothing after the last chunk is waiting on the thread being free, so
        // only the gaps between chunks are paid for
        if (committed < statements.length) await yieldToHost();
      }
    } catch (cause) {
      throw new BulkMutateError(committed, statements.length, cause);
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
   *
   * Arms the row stamps on the same connection too (see `armRowStamps`),
   * which `export` drops just as it drops the hook.
   */
  protected registerUpdateHook() {
    if (this.db) this.#armRowStamps(this.db);
    this.db?.updateHook((op, _dbName, table, rowId) => {
      const noteType = ITEM_TABLE_TO_NOTE_TYPE[table];
      if (!noteType) return; // not a queue-item table (e.g. a review log)

      const id = this.#resolveRowId(table, rowId);
      if (id === null) return; // unresolvable (e.g. a hard DELETE); skip

      const byOp =
        this.#pendingChanges.get(noteType) ??
        new Map<DataChangeOp, Set<string>>();
      // The stamp an insert's trigger writes is part of the insert
      if (byOp.get('insert')?.has(id)) return;

      const ids = byOp.get(op) ?? new Set<string>();
      ids.add(id);
      byOp.set(op, ids);
      this.#pendingChanges.set(noteType, byOp);
    });
  }

  #armRowStamps(db: Database) {
    this.#readOwnGeneration(db);
    armRowStamps(db, {
      deviceId: () => this.#device(),
      now: this.#rowClock,
    });
  }

  /** Cache this device's generation in `db` (see {@link #ownGeneration}). */
  #readOwnGeneration(db: Database) {
    this.#ownGeneration = readWriteVector(db)?.[this.#device()] ?? 0;
  }

  /** This device's id (see `getDeviceId`), read on first use. */
  #device(): string {
    return (this.#deviceId ??= getDeviceId(this.app));
  }

  /**
   * Serialize `db`, putting back what that takes away. sql.js `export()`
   * frees every statement, closes the connection, reads the file out of its
   * FS and opens it again, so `db` is a new connection afterwards: the update
   * hook and row stamps are gone and every connection-level pragma is back at
   * its default (`foreign_keys` OFF, which would leave `ON DELETE CASCADE`
   * unenforced for the rest of the session). Called with no transaction
   * open, so the pragma takes.
   */
  #exportDb(db: Database): Uint8Array {
    const data = db.export();
    db.exec('PRAGMA foreign_keys = ON');
    this.registerUpdateHook();
    return data;
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
   * Where a write starts, for {@link #contentChanged}: a write that leaves
   * every row as it was has nothing to save (0174).
   */
  #markContent(): ContentMark | null {
    return this.db ? this.#content.mark(this.db) : null;
  }

  /** Whether the write begun at `mark` changed anything, so must be saved. */
  #contentChanged(mark: ContentMark | null): boolean {
    if (
      this.db &&
      this.#saves.failed <= this.#saves.wrote &&
      !this.#content.changedSince(this.db, mark)
    ) {
      recordSave('skipped');
      return false;
    }
    return true;
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
    const save = ++this.#saves.begun;
    try {
      const source = this.db;
      // Inside the save, never on its own: a write of its own would ask for
      // a save. So a write that changed nothing, which asks for none
      // (`#contentChanged`, 0174), moves no generation either; and
      // `write_stamp` is no content to that check, so the bump asks for no
      // save after this one
      const stamp = bumpWriteStamp(source, this.#device(), this.#stampClock());
      const data = this.#exportDb(source).buffer;
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
      recordSave('saved');
      await this.app.vault.adapter.writeBinary(
        normalizePath(this.#dbFilePath),
        data as ArrayBuffer
      );
      this.#saves.wrote = Math.max(this.#saves.wrote, save);
      // In the order writes land, so the last one on disk is the one kept
      saveKnownWriteVector(this.app, stamp);
    } catch (error) {
      // Nothing was written that this database can count as its file
      if (wroteFresh) this.#fresh = true;
      this.#saves.failed = Math.max(this.#saves.failed, save);
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
   * @param bytes the file, already read; read afresh when not given
   * @returns a Database, or `null` if the file is invalid or not found
   * @throws if the latest schema version is lower than the database's
   * current version, or if post-migration verification fails
   */
  protected async reloadDb(bytes?: ArrayBuffer): Promise<Database | null> {
    const previous = this.db;
    let candidate: Database | null = null;
    try {
      this.#sql ||= await this.loadWasm();
      const dbArrayBuffer =
        bytes ??
        (await this.app.vault.adapter.readBinary(
          normalizePath(this.#dbFilePath)
        ));
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
      const loadedStamp = readWriteVector(candidate);

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
      this.#loadedStamp = loadedStamp;
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

        // A migration's writes are no device's edits, and its table rebuilds
        // rename tables the stamp triggers name. The save after it arms them
        // again, over the migrated tables.
        disarmRowStamps(this.db);
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
      // The file on disk is this one now (or its migration, saved above)
      const stamp = readWriteVector(this.db);
      if (stamp) saveKnownWriteVector(this.app, stamp);
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
   * Back up the database file before applying migrations, or `from.data`,
   * the database in memory, before another device's copy replaces it.
   * Verifies backup integrity via SHA-256 checksum comparison.
   * @param currentVersion the schema version of what is backed up
   */
  protected async backupDatabase(
    currentVersion: number,
    from?: { marker: BackupMarker; data: ArrayBuffer }
  ): Promise<string> {
    const dirExists = await this.adapter.exists(
      normalizePath(BACKUP_DIRECTORY)
    );
    if (!dirExists) {
      await this.adapter.mkdir(normalizePath(BACKUP_DIRECTORY));
    }

    const originalData =
      from?.data ??
      (await this.adapter.readBinary(normalizePath(this.#dbFilePath)));

    // Named by the clock retention measures its age on
    const name = backupFileName(
      currentVersion,
      from?.marker ?? 'migration',
      new Date(this.#stampClock())
    );
    const backupPath = normalizePath(`${BACKUP_DIRECTORY}/${name}`);

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
    this.#retentionDue = true;
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
