import { describeFailures } from '#/lib/bulk-import/run-import';
import type { BulkImportEntry, BulkOutcome } from '#/lib/bulk-import/types';
import {
  TFile,
  TFolder,
  type App,
  type CachedMetadata,
  type MetadataCache,
  type TAbstractFile,
  type Vault,
} from 'obsidian';
import {
  AUTO_IMPORT_DEBOUNCE_MS,
  AUTO_IMPORT_MAX_WAIT_MS,
  AUTO_IMPORT_SYNC_PATIENCE_MS,
  AUTO_IMPORT_SYNC_POLL_MS,
  AUTO_IMPORT_WATERMARK_SLACK_MS,
  DATA_DIRECTORY,
  IMPORT_BLOCKED_TAGS,
} from './constants';
import { isImportable, supportsFrontmatter } from './mime';
import { notify } from './notices';
import type { SyncGate } from './obsidian-sync';
import {
  loadAutoImportWatermark,
  saveAutoImportWatermark,
} from './plugin-data';
import { matchFrontmatterTags } from './tags';
import {
  ledgerArrivals,
  loadWatchedFolderLedger,
  reconcileLedger,
  saveWatchedFolderLedger,
  type WatchedFolderLedger,
} from './watched-folder-ledger';
import { isUnderAnyFolder, isUnderFolder } from './watched-folders';

/** The ledger as the watcher holds it, its paths in a set to look up. */
interface HeldLedger {
  folders: readonly string[];
  paths: Set<string>;
}

/** `ledger` as it is stored and compared. */
const plainLedger = ({ folders, paths }: HeldLedger): WatchedFolderLedger => ({
  folders,
  paths: [...paths],
});

/** What decides whether, and how, notes are imported. Read afresh each time. */
export interface AutoImportConfig {
  /** Whether a note that gains a trigger tag is imported. */
  enabled: boolean;
  /** The tags that make a note an article, as `parseTagList` reads them. */
  triggerTags: readonly string[];
  /** The priority an imported note starts with. */
  priority: number;
  /** Whether a file that arrives in one of {@link folders} is imported. */
  onFolder: boolean;
  /** The watched folders' vault paths, as `cleanFolderList` keeps them. */
  folders: readonly string[];
}

/** A note to import, with the trigger tags it carried when it was checked. */
export interface AutoImportEntry extends BulkImportEntry {
  matchedTags: string[];
}

/**
 * The parts of the app the watcher reads, and the device's own storage, where
 * it keeps the moment it last saw every change and the files it has seen in
 * the watched folders.
 */
interface WatchedApp
  extends Pick<App, 'loadLocalStorage' | 'saveLocalStorage'> {
  vault: Pick<Vault, 'getFileByPath' | 'getFiles' | 'getMarkdownFiles'>;
  metadataCache: Pick<MetadataCache, 'getFileCache'>;
}

interface AutoImportWatcherOptions {
  app: WatchedApp;
  getConfig: () => AutoImportConfig;
  /**
   * Import `entries` quietly, as `ReviewManager.importArticles` does, with the
   * config as it was when they were checked. What came of each is returned for
   * the watcher to report.
   */
  importMany: (
    entries: AutoImportEntry[],
    config: AutoImportConfig
  ) => Promise<BulkOutcome[]>;
  /**
   * Whether any item table holds a row with id `id`, deleted or not. An
   * `ir-id` no row holds is an orphan, left by a database deleted or replaced,
   * an import cut short, or the losing device of two that imported the same
   * note. A trigger tag on an orphan asks for what the import command does
   * with one: import the note afresh.
   */
  hasRow: (id: string) => Promise<boolean>;
  /**
   * Whether `file`, whose `ir-id` `id` a row holds, is the note of the live
   * article at its path but lacks the article tag (see
   * `ArticleManager.lostArticleTag`): no item to review, which the import
   * command repairs rather than refusing, so a trigger tag asks for that too.
   * Without it, no note is.
   */
  needsRepair?: (id: string, file: TFile) => Promise<boolean>;
  /**
   * Whether Obsidian Sync lets imports go ahead now (see `readSyncGate`).
   * Without it, they always may.
   */
  syncGate?: () => SyncGate;
  /**
   * Have `recheck` called whenever what {@link syncGate} reads may have
   * changed (see `subscribeSyncStatus`), for as long as the watcher holds
   * imports for Sync. Returns the function that stops it. Besides it, the
   * watcher looks again every {@link AUTO_IMPORT_SYNC_POLL_MS}.
   */
  watchSync?: (recheck: () => void) => () => void;
  /**
   * Told how many notes wait for Sync that is paused, offline, failing or
   * stuck, each time that changes; 0 once none do. See
   * {@link AutoImportWatcher.importDespiteSync}.
   */
  onSyncWait?: (waiting: number) => void;
  /**
   * Wait for the database to take in what Sync may just have brought, then
   * answer whether it is ready to be asked about rows (see
   * `settleAfterSync`). Asked before importing a note whose `ir-id` no row
   * holds, as its row may only be on its way. Without it, the database is
   * always taken as settled.
   */
  settleDatabase?: () => Promise<boolean>;
}

/**
 * Imports notes as they gain a trigger tag in their frontmatter, however the
 * tag gets there: typed in the editor or the properties widget, clipped,
 * synced, or written by a script or another plugin.
 *
 * Told of each note the metadata cache re-indexes, through {@link consider},
 * which has to cost next to nothing: that is every edit to every note. It
 * queues the notes to import and imports them together once no more arrive
 * for a moment (see {@link AUTO_IMPORT_DEBOUNCE_MS}), checking each again
 * first, since any of them may have been renamed, deleted or changed again
 * while it waited.
 *
 * A note is never imported twice: importing gives it an `ir-id`, and a note
 * whose `ir-id` a row holds, deleted or not, is dropped at the flush, so a
 * deleted article stays deleted; unless it is its live article's note and
 * lost the article tag, which the import repairs, as the import command does
 * (see `needsRepair`). A note whose `ir-id` no row holds is imported, as
 * the import command imports it (see `hasRow`). A note whose
 * import failed is remembered until the plugin next loads, so it isn't tried
 * again on every edit.
 *
 * While Obsidian Sync is syncing, nothing is imported: what is queued waits
 * until Sync is done, so a note it is still bringing in, such as one
 * un-imported on another device, or the row of one imported there, is seen as
 * it ends up. Sync paused, offline or failing holds it too; then, or once Sync
 * has been syncing a long while, the plugin offers to import anyway (see
 * {@link importDespiteSync}). The startup scan's imports wait the same way.
 * A note with an `ir-id` no row holds is imported only once Sync is done and
 * the database has taken in what it brought (see `settleDatabase`), never
 * despite Sync: its row may be the one on its way.
 *
 * The watcher acts on changes, so a note that had a trigger tag before
 * importing by tag was turned on is left alone until it next changes. Changes
 * made while it wasn't listening, with Obsidian closed, are caught at startup
 * by {@link runCatchUpScan}, by the one thing it keeps: the last moment this
 * device saw every change (see `AUTO_IMPORT_WATERMARK_KEY`).
 *
 * Files that arrive in a watched folder, through {@link noteArrival}, are
 * imported too: created there, moved in from outside, or delivered by Sync.
 * Only arrivals count, so what a folder held when it was first watched stays
 * as it is, and so does a note un-imported there, until it arrives again.
 * Files that arrived while Obsidian was closed are found at startup by
 * {@link runCatchUpScan}, as those missing from the ledger of files this
 * device has seen in its watched folders (see `WatchedFolderLedger`).
 *
 * Two devices can import the same note before either syncs the other's
 * database. One database wins outright when they meet. If the note keeps the
 * losing device's `ir-id`, its next change has it imported, and the import
 * refuses it, since the winning row is at its path already.
 */
export class AutoImportWatcher {
  readonly #app: WatchedApp;
  readonly #getConfig: () => AutoImportConfig;
  readonly #importMany: AutoImportWatcherOptions['importMany'];
  readonly #hasRow: AutoImportWatcherOptions['hasRow'];
  readonly #needsRepair: NonNullable<AutoImportWatcherOptions['needsRepair']>;

  #running = false;
  /** Notes waiting to be imported, in the order they were first queued. */
  readonly #queued = new Set<TFile>();
  /** When the oldest note still waiting was queued, for the longest wait. */
  #queuedSince: number | null = null;
  #timer: number | null = null;
  /**
   * Notes that arrived in a watched folder and wait for the metadata cache to
   * read them, since until then nothing is known of their frontmatter.
   */
  readonly #arrived = new Set<TFile>();
  /** The queued files that arrived in a watched folder, which that qualifies. */
  readonly #queuedArrivals = new Set<TFile>();
  /** Paths whose import failed since the plugin loaded. */
  readonly #failed = new Set<string>();
  /**
   * Files a flush has taken, until it is done with them: those being
   * imported, and those waiting behind the import before.
   */
  readonly #flushing = new Set<TFile>();
  /**
   * Whether {@link runCatchUpScan} has run, so the stored moment may move on:
   * until then, what changed while Obsidian was closed is still unseen.
   */
  #caughtUp = false;
  /** Whether importing was on when last looked at, to see it turned on. */
  #wasEnabled = false;
  /**
   * The files this device has seen in its watched folders, once read from
   * storage (`undefined` until then), or null when none are stored.
   */
  #ledger: HeldLedger | null | undefined;
  /** Pending store of {@link #ledger}, after a file in it moved or went. */
  #ledgerTimer: number | null = null;
  /**
   * Notes being or lately un-imported, each with the `ir-id` its cache showed
   * then (`undefined` for none), held back while the cache still shows that
   * id and a trigger tag (see {@link unimporting}). Weak, so a deleted note
   * goes with its hold.
   */
  readonly #unimported = new WeakMap<TFile, unknown>();
  readonly #syncGate: () => SyncGate;
  readonly #watchSync: (recheck: () => void) => () => void;
  readonly #onSyncWait: (waiting: number) => void;
  readonly #settleDatabase: () => Promise<boolean>;
  /**
   * Since when Sync has said it is syncing, without a break, while imports
   * waited for it; null when it doesn't.
   */
  #syncingSince: number | null = null;
  /** Stops {@link #watchSync}, while the watcher holds imports for Sync. */
  #unwatchSync: (() => void) | null = null;
  /** How many notes {@link #onSyncWait} was last told wait for Sync. */
  #syncWaiting = 0;
  /**
   * Serializes imports: a batch is checked only once the one before it is
   * done, so a note it imported has its `ir-id`, and the row holding it, by
   * then.
   */
  #pending: Promise<void> = Promise.resolve();

  constructor({
    app,
    getConfig,
    importMany,
    hasRow,
    needsRepair = () => Promise.resolve(false),
    syncGate = () => 'open',
    watchSync = () => () => undefined,
    onSyncWait = () => undefined,
    settleDatabase = () => Promise.resolve(true),
  }: AutoImportWatcherOptions) {
    this.#app = app;
    this.#getConfig = getConfig;
    this.#importMany = importMany;
    this.#hasRow = hasRow;
    this.#needsRepair = needsRepair;
    this.#syncGate = syncGate;
    this.#watchSync = watchSync;
    this.#onSyncWait = onSyncWait;
    this.#settleDatabase = settleDatabase;
  }

  /** Begin importing. Returns the cleanup to hand to `Plugin.register`. */
  start(): () => void {
    this.#running = true;
    this.#wasEnabled = this.#getConfig().enabled;
    return () => {
      this.#recordSeen();
      if (this.#ledgerTimer !== null) this.#storeLedger();
      this.#running = false;
      this.#cancelTimer();
      this.#queued.clear();
      this.#queuedSince = null;
      this.#arrived.clear();
      this.#queuedArrivals.clear();
      this.#stopWatchingSync();
      this.#tellSyncWait(0);
    };
  }

  /**
   * Queue `file` for import if its frontmatter, as `cache` has it, calls for
   * one, or if it is a note that arrived in a watched folder and this is the
   * first look at its frontmatter.
   */
  consider(file: TFile, cache: CachedMetadata | null): void {
    const config = this.#getConfig();
    this.#releaseHold(file, cache, config);
    // An arrival is settled by the first cache that has the note read, once
    // there is something in it. An empty note open in an editor takes the
    // file's text over its own unsaved text when the file changes, so
    // importing a new note while it is typed into would lose the typing; it
    // has words in it once its first save comes. (`loadFileInternal` merges
    // only when the text last saved is not empty: obsidian.asar 1.13.7.)
    const arrived =
      cache !== null && this.#arrived.has(file) && file.stat.size > 0;
    if (arrived) this.#arrived.delete(file);
    const byArrival = arrived && this.#arrivalQualifies(file, cache, config);
    if (arrived && !byArrival) this.#notePassedOver(file, config);
    // Its flush would pass it over anyway, and it would be counted waiting
    if (this.#unimported.has(file)) return;
    if (!byArrival && this.#triggerTagsOf(file, cache, config) === null) {
      return;
    }
    if (byArrival) this.#queuedArrivals.add(file);
    this.#queued.add(file);
    this.#schedule();
  }

  /**
   * Hear that `file` is about to be un-imported: its row deleted, then its
   * `ir-id` and trigger tags stripped. Leave it alone until the cache shows
   * it changed (see {@link #releaseHold}). The cache reads the stripped note
   * only a moment after the row goes, and a flush in between, of the change
   * its import's own write queued, would take it for an orphan and import it
   * again.
   */
  unimporting(file: TFile): void {
    const cache = this.#app.metadataCache.getFileCache(file);
    this.#unimported.set(file, cache?.frontmatter?.['ir-id']);
  }

  /**
   * End the hold {@link unimporting} put on `file` once `cache` shows it
   * changed: with another id, or no trigger tag. Looked at on every change,
   * so the first that shows it ends the hold.
   */
  #releaseHold(
    file: TFile,
    cache: CachedMetadata | null,
    config: AutoImportConfig
  ): void {
    if (!this.#unimported.has(file)) return;
    const frontmatter = cache?.frontmatter;
    if (
      frontmatter === undefined ||
      // `Object.is`, as YAML reads `.nan` as NaN, which equals nothing
      !Object.is(frontmatter['ir-id'], this.#unimported.get(file)) ||
      matchFrontmatterTags(frontmatter, config.triggerTags).length === 0
    ) {
      this.#unimported.delete(file);
    }
  }

  /**
   * Hear of a change to the settings. Importing by tag turned on applies from
   * then on: a note tagged before is no change it saw, and is left alone. So
   * does a folder newly watched: what it holds now is taken as seen, so the
   * next launch doesn't find it all arrived.
   */
  configChanged(): void {
    const config = this.#getConfig();
    if (this.#running && config.enabled && !this.#wasEnabled) {
      this.#record(Date.now());
    }
    this.#wasEnabled = config.enabled;
    if (this.#running) this.#followWatchedFolders(config);
  }

  /**
   * Tell the watcher `file` was deleted, so the ledger forgets it: a file
   * written to its path later, with Obsidian closed, is one that arrived.
   */
  noteDeletion(file: TAbstractFile): void {
    const ledger = this.#running ? this.#loadLedger() : null;
    if (ledger === null) return;
    let forgot = ledger.paths.delete(file.path);
    // Whether Obsidian tells of each file in a deleted folder isn't
    // documented, so they are forgotten with it
    if (file instanceof TFolder) {
      for (const path of ledger.paths) {
        if (isUnderFolder(path, file.path)) forgot = ledger.paths.delete(path);
      }
    }
    if (forgot) this.#storeLedgerSoon();
  }

  /**
   * Import the notes that changed while the watcher wasn't listening, as it
   * would have had it been: those whose file changed after the last moment it
   * saw every change. For startup, once the metadata cache has indexed the
   * vault: a note changed while Obsidian was closed (by a script, or synced
   * from another device) may have been indexed before the watcher was
   * listening, so no change of it ever comes.
   *
   * With no such moment stored, as on the first run, or with importing off,
   * nothing is imported: that moment is now. A crash leaves an older one, so
   * the next run looks at more notes than it needs to, at no cost, since one
   * already imported is passed over. What it imports goes in with anything
   * already waiting, under one notice. Resolves once that import is done.
   * Only trigger tags count here: a file that changed in a watched folder
   * while Obsidian was closed is no arrival the watcher heard of.
   */
  runCatchUpScan(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    this.#caughtUp = true;
    this.#catchUpOnTags();
    this.#catchUpOnArrivals();
    // The flush moves the stored moment on
    return this.flushNow();
  }

  /** The trigger-tag half of {@link runCatchUpScan}. */
  #catchUpOnTags(): void {
    const seen = loadAutoImportWatermark(this.#app);
    if (seen === null || !this.#getConfig().enabled) {
      this.#record(Date.now());
      return;
    }
    const { vault, metadataCache } = this.#app;
    for (const file of vault.getMarkdownFiles()) {
      // Untouched since: before the cache is read, as that is nearly every note
      if (file.stat.mtime <= seen) continue;
      // Taken by a flush already. Its cache may not show the `ir-id` that
      // import writes by then, so checked again it would be imported twice
      if (this.#flushing.has(file)) continue;
      this.consider(file, metadataCache.getFileCache(file));
    }
  }

  /**
   * The watched-folder half of {@link runCatchUpScan}. Obsidian keeps no
   * record of which files are new, so each file in a watched folder that the
   * ledger doesn't hold arrived while Obsidian was closed. A folder the ledger
   * has no record of, watched for the first time on this device, is taken as
   * seen. Files are told apart by path alone, so one deleted and written again
   * at the same path while Obsidian was closed is taken as the one seen, and
   * left alone. The ledger is then rewritten to what the folders hold, all
   * but the arrivals still to be imported, which their flush adds: a crash
   * before it leaves them to be found again.
   */
  #catchUpOnArrivals(): void {
    const config = this.#getConfig();
    const folders = this.#watchedFolders(config);
    const files = this.#watchedFiles(config);
    const ledger = this.#loadLedger();
    if (ledger !== null) {
      const byPath = new Map(files.map((file) => [file.path, file]));
      const arrived = ledgerArrivals(plainLedger(ledger), folders, [
        ...byPath.keys(),
      ]);
      for (const path of arrived) {
        const file = byPath.get(path)!;
        // Arrived since the layout was ready, and taken by a flush already
        if (this.#flushing.has(file)) continue;
        this.noteArrival(file);
      }
    }
    const seen = files
      .filter(
        (file) =>
          !this.#arrived.has(file) &&
          !this.#queuedArrivals.has(file) &&
          !this.#flushing.has(file)
      )
      .map(({ path }) => path);
    this.#keepLedger(reconcileLedger(null, folders, seen));
  }

  /**
   * Tell the watcher `file` was created, or moved from `oldPath`. One that
   * lands in a watched folder from outside every watched folder is imported:
   * a PDF as it is, a note once its frontmatter is known. That is when the
   * metadata cache first reads a new note ({@link consider}), and at once for
   * a note moved in, which keeps its cache. An empty note waits until it has
   * something in it. A note is never imported unread:
   * one with an `ir-id`, such as an article Sync delivers, is left alone.
   * Folders, and files moved out or within, are ignored. Whatever arrives is
   * added to the ledger of files seen: an import once it is done, anything
   * passed over at once.
   */
  noteArrival(file: TAbstractFile, oldPath?: string): void {
    if (!this.#running || !(file instanceof TFile)) return;
    const config = this.#getConfig();
    if (oldPath !== undefined) this.#followMove(oldPath, file.path, config);
    if (!this.#watches(file.path, config)) return;
    // Seen there, so no arrival, whatever tells of it. The ledger forgets a
    // file deleted, and Obsidian tells of a file only once it is new to the
    // vault, but a file it tells of late, after the ledger has taken it as
    // seen, stays as it is. So does one deleted with Obsidian closed and
    // written again before the startup scan, as left alone as one written
    // again before Obsidian started: the ledger is the last launch's until
    // then, and holds the path still (see `#catchUpOnArrivals`)
    if (this.#loadLedger()?.paths.has(file.path)) return;
    if (!isImportable(file)) {
      this.#notePassedOver(file, config);
      return;
    }
    if (oldPath !== undefined && this.#watches(oldPath, config)) return;
    if (!supportsFrontmatter(file)) {
      this.#queuedArrivals.add(file);
      this.#queued.add(file);
      this.#schedule();
      return;
    }
    this.#arrived.add(file);
    // No `changed` follows a rename: the cache moves with the note
    this.consider(file, this.#app.metadataCache.getFileCache(file));
  }

  /**
   * Import whatever is waiting now rather than when it settles, unless Sync
   * holds it back (see `AutoImportWatcherOptions.syncGate`): then it waits,
   * looked at again as Sync changes, and every so often. Resolves once every
   * import asked for so far is done, or held.
   */
  flushNow(): Promise<void> {
    this.#cancelTimer();
    if (this.#queued.size > 0 && this.#holdsForSync()) {
      this.#unwatchSync ??= this.#watchSync(this.#recheckSync);
      this.#timer = window.setTimeout(() => {
        this.#timer = null;
        void this.flushNow();
      }, AUTO_IMPORT_SYNC_POLL_MS);
      return this.#pending;
    }
    return this.#flush();
  }

  /** Look at Sync again, while imports wait for it. */
  readonly #recheckSync = (): void => {
    if (this.#unwatchSync === null) return;
    void this.flushNow();
  };

  /** Stop looking at Sync, as nothing waits for it now. */
  #stopWatchingSync(): void {
    this.#syncingSince = null;
    const unwatch = this.#unwatchSync;
    this.#unwatchSync = null;
    unwatch?.();
  }

  /**
   * Import whatever is waiting now, whatever Sync is doing: the user's
   * answer to being told imports wait for Sync (see `onSyncWait`).
   */
  importDespiteSync(): Promise<void> {
    this.#cancelTimer();
    return this.#flush();
  }

  /**
   * Whether Sync holds back the imports queued now, telling `onSyncWait` how
   * many wait on Sync stalled: paused, offline or failing, or syncing for
   * {@link AUTO_IMPORT_SYNC_PATIENCE_MS} on end. Only those
   * {@link importDespiteSync} would import count: not a note with an
   * `ir-id`, which waits for Sync whatever the user says.
   */
  #holdsForSync(): boolean {
    const gate = this.#syncGate();
    if (gate === 'open') return false;
    const now = Date.now();
    if (gate === 'syncing') this.#syncingSince ??= now;
    else this.#syncingSince = null;
    const stalled =
      this.#syncingSince === null ||
      now - this.#syncingSince >= AUTO_IMPORT_SYNC_PATIENCE_MS;
    this.#tellSyncWait(stalled ? this.#countImportableDespiteSync() : 0);
    return true;
  }

  /** How many notes queued have no `ir-id` (see {@link #holdsForSync}). */
  #countImportableDespiteSync(): number {
    let count = 0;
    for (const file of this.#queued) {
      const id: unknown =
        this.#app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id'];
      if (typeof id !== 'string') count++;
    }
    return count;
  }

  /** Tell `onSyncWait` that `waiting` notes wait for Sync, if that's news. */
  #tellSyncWait(waiting: number): void {
    if (waiting === this.#syncWaiting) return;
    this.#syncWaiting = waiting;
    this.#onSyncWait(waiting);
  }

  /** Import whatever is waiting now. */
  #flush(): Promise<void> {
    this.#stopWatchingSync();
    this.#tellSyncWait(0);
    const batch = [...this.#queued];
    const arrivals = new Set(this.#queuedArrivals);
    this.#queued.clear();
    this.#queuedArrivals.clear();
    this.#queuedSince = null;
    for (const file of batch) this.#flushing.add(file);
    this.#pending = this.#pending
      .then(async () => {
        let failed: ReadonlySet<TFile>;
        try {
          failed = await this.#import(batch, arrivals);
        } finally {
          for (const file of batch) this.#flushing.delete(file);
        }
        // Seen, so not found arrived at the next launch, unless it failed
        this.#noteSeen(arrivals, failed);
        // Seen to here, though a crash could come before another flush
        this.#recordSeen();
      })
      .catch((error: unknown) => {
        console.error('Incremental Reading - automatic import failed:', error);
      });
    return this.#pending;
  }

  /**
   * The trigger tags that make `file` one to import, or null if it isn't. The
   * checks run cheapest first, since most notes fail the first or second.
   * Whether a row holds the note's `ir-id` takes a database lookup, so that is
   * left to the flush.
   */
  #triggerTagsOf(
    file: TFile,
    cache: CachedMetadata | null,
    config: AutoImportConfig
  ): string[] | null {
    if (!this.#running || !config.enabled) return null;
    // A note with no frontmatter carries no tag, so matches none
    const frontmatter = cache?.frontmatter;
    const matched = matchFrontmatterTags(frontmatter, config.triggerTags);
    if (matched.length === 0) return null;
    // Snippets and cards are never imported, so trying would only fail
    if (matchFrontmatterTags(frontmatter, IMPORT_BLOCKED_TAGS).length > 0) {
      return null;
    }
    if (this.#failed.has(file.path)) return null;
    return matched;
  }

  /**
   * Whether `file`, which arrived in a watched folder, is one to import for
   * that: still in a watched folder with watching on, its import not failed,
   * and, if a note, read by the metadata cache, with no snippet or card tag
   * and no `ir-id`. An `ir-id` says the note was imported already, here or on
   * a device whose database may not have synced yet, so no lookup can tell an
   * orphan from an article whose row is on its way; a trigger tag or the
   * import command still imports an orphan.
   */
  #arrivalQualifies(
    file: TFile,
    cache: CachedMetadata | null,
    config: AutoImportConfig
  ): boolean {
    if (!this.#watches(file.path, config)) return false;
    if (this.#failed.has(file.path)) return false;
    if (cache === null && supportsFrontmatter(file)) return false;
    const frontmatter = cache?.frontmatter;
    if (matchFrontmatterTags(frontmatter, IMPORT_BLOCKED_TAGS).length > 0) {
      return false;
    }
    return typeof frontmatter?.['ir-id'] !== 'string';
  }

  /**
   * Whether an arrival at `path` counts: watching on, in a watched folder,
   * and outside the plugin's data folder, where its own copies, snippets and
   * cards are made. Settings refuse that folder, but `data.json` can be
   * edited by hand.
   */
  #watches(path: string, { onFolder, folders }: AutoImportConfig): boolean {
    return (
      onFolder &&
      isUnderAnyFolder(path, folders) &&
      !isUnderFolder(path, DATA_DIRECTORY)
    );
  }

  /** The folders watched under `config`: none while watching is off. */
  #watchedFolders({ onFolder, folders }: AutoImportConfig): readonly string[] {
    return onFolder ? folders : [];
  }

  /** The files whose arrival counts under `config` (see {@link #watches}). */
  #watchedFiles(config: AutoImportConfig): TFile[] {
    return this.#app.vault
      .getFiles()
      .filter((file) => this.#watches(file.path, config));
  }

  /** {@link #ledger}, read from storage the first time it is asked for. */
  #loadLedger(): HeldLedger | null {
    if (this.#ledger === undefined) {
      const stored = loadWatchedFolderLedger(this.#app);
      this.#ledger = stored && {
        folders: stored.folders,
        paths: new Set(stored.paths),
      };
    }
    return this.#ledger;
  }

  /** Hold `ledger`, and store it. */
  #keepLedger(ledger: WatchedFolderLedger): void {
    this.#ledger = { folders: ledger.folders, paths: new Set(ledger.paths) };
    this.#storeLedger();
  }

  /** Store the ledger held now. */
  #storeLedger(): void {
    if (this.#ledgerTimer !== null) window.clearTimeout(this.#ledgerTimer);
    this.#ledgerTimer = null;
    saveWatchedFolderLedger(this.#app, plainLedger(this.#ledger!));
  }

  /**
   * Store the ledger in a moment, once a burst of moves or deletions, such
   * as a folder's, is over. A crash before then leaves it as it was, which
   * costs at most an import the next launch could have done without.
   */
  #storeLedgerSoon(): void {
    this.#ledgerTimer ??= window.setTimeout(
      () => this.#storeLedger(),
      AUTO_IMPORT_DEBOUNCE_MS
    );
  }

  /**
   * Keep the ledger's folders the ones watched under `config`: a folder newly
   * watched is taken as seen as it is now, and one no longer watched is
   * forgotten, so watching it again later takes it as seen again.
   */
  #followWatchedFolders(config: AutoImportConfig): void {
    const ledger = this.#loadLedger();
    const folders = this.#watchedFolders(config);
    if (
      ledger === null ||
      (folders.length === ledger.folders.length &&
        folders.every((folder) => ledger.folders.includes(folder)))
    ) {
      return;
    }
    this.#seedArrivals(ledger, folders);
    const paths = this.#watchedFiles(config).map(({ path }) => path);
    this.#keepLedger(reconcileLedger(plainLedger(ledger), folders, paths));
  }

  /**
   * Take the arrivals waiting outside the folders `ledger` records and
   * `folders` keeps watched as seen, as the ledger is about to take all a
   * folder newly watched holds: what it holds once the watcher is told it is
   * watched stays as it is, even if the watcher heard of it arriving first.
   * It can, in the moment between a setting being changed and saved, as when
   * the settings are written to by hand. One waiting in a folder no longer
   * watched is no arrival either. A file waiting in a folder still watched
   * still arrived there, even under one newly watched. A file a flush has
   * taken is left to it, and one queued for a trigger tag too stays queued
   * for that.
   */
  #seedArrivals(ledger: HeldLedger, folders: readonly string[]): void {
    const kept = folders.filter((folder) => ledger.folders.includes(folder));
    for (const file of this.#arrived) {
      if (!isUnderAnyFolder(file.path, kept)) this.#arrived.delete(file);
    }
    for (const file of this.#queuedArrivals) {
      if (!isUnderAnyFolder(file.path, kept)) this.#queuedArrivals.delete(file);
    }
  }

  /**
   * Move a seen file's path in the ledger: a file moved within the watched
   * folders is still seen where it is now, and one moved out is forgotten.
   */
  #followMove(oldPath: string, path: string, config: AutoImportConfig): void {
    const ledger = this.#loadLedger();
    if (!ledger?.paths.delete(oldPath)) return;
    if (this.#watches(path, config)) ledger.paths.add(path);
    this.#storeLedgerSoon();
  }

  /**
   * Add `file`, an arrival passed over, to the ledger now, if it is in a
   * watched folder and its import didn't fail: it is seen, so the next launch
   * doesn't find it arrived once what kept it out is gone, as when an article
   * Sync delivered is un-imported.
   */
  #notePassedOver(file: TFile, config: AutoImportConfig): void {
    const ledger = this.#loadLedger();
    if (
      ledger === null ||
      ledger.paths.has(file.path) ||
      this.#failed.has(file.path) ||
      !this.#watches(file.path, config)
    ) {
      return;
    }
    ledger.paths.add(file.path);
    this.#storeLedgerSoon();
  }

  /**
   * Add to the ledger the `arrivals` a flush is done with, still where they
   * were imported or passed over, all but those that `failed`, which the next
   * launch tries again.
   */
  #noteSeen(arrivals: ReadonlySet<TFile>, failed: ReadonlySet<TFile>): void {
    const ledger = this.#running ? this.#loadLedger() : null;
    if (ledger === null) return;
    const config = this.#getConfig();
    let added = false;
    for (const file of arrivals) {
      if (failed.has(file)) continue;
      if (this.#app.vault.getFileByPath(file.path) !== file) continue;
      if (!this.#watches(file.path, config)) continue;
      ledger.paths.add(file.path);
      added = true;
    }
    if (added) this.#storeLedger();
  }

  #schedule(): void {
    const now = Date.now();
    this.#queuedSince ??= now;
    const wait = Math.min(
      AUTO_IMPORT_DEBOUNCE_MS,
      this.#queuedSince + AUTO_IMPORT_MAX_WAIT_MS - now
    );
    this.#cancelTimer();
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      void this.flushNow();
    }, wait);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Import each of `batch` that still calls for it, by a trigger tag or, for
   * those among `arrivals`, by having arrived in a watched folder. Say how it
   * went, and return the files whose import failed.
   */
  async #import(
    batch: readonly TFile[],
    arrivals: ReadonlySet<TFile>
  ): Promise<ReadonlySet<TFile>> {
    const config = this.#getConfig();
    const entries: AutoImportEntry[] = [];
    /** Notes with an `ir-id` no row holds, to wait for Sync again. */
    const held: TFile[] = [];
    /** Whether the database took in what Sync brought, once asked. */
    let settled: Promise<boolean> | null = null;
    for (const file of batch) {
      // Gone if deleted, or if another file took its path. A rename moves
      // `file` with it, so a renamed note is still found, where it now is.
      if (this.#app.vault.getFileByPath(file.path) !== file) continue;
      const cache = this.#app.metadataCache.getFileCache(file);
      let matchedTags =
        this.#triggerTagsOf(file, cache, config) ??
        (arrivals.has(file) && this.#arrivalQualifies(file, cache, config)
          ? []
          : null);
      if (!matchedTags) continue;
      // An id is a string; anything else there matches no row, and the
      // import replaces it. The plugin's own write of an `ir-id` comes back
      // here, so each import costs one lookup.
      const id: unknown = cache?.frontmatter?.['ir-id'];
      if (typeof id === 'string') {
        const rowHeld = await this.#rowHolds(id);
        // An article already, unless its note lost the tag that makes it one
        if (rowHeld && !(await this.#lostTag(id, file))) continue;
        // An orphan, or a note whose row Sync is still bringing, or a merge
        // still taking in: imported only once neither can be, never despite
        // Sync. A repair waits too: the tag may be on its way back from
        // another device, which would then have written it twice
        if (this.#syncGate() !== 'open') {
          held.push(file);
          continue;
        }
        if (!rowHeld) {
          // A database that doesn't settle leaves it for its next change
          settled ??= this.#settleDatabase();
          if (!(await settled) || (await this.#rowHolds(id))) continue;
          // Read again as it is now: it may have changed while it waited, such
          // as the trigger tag an un-import took off, which ends its hold
          const now = this.#app.metadataCache.getFileCache(file);
          if (this.#app.vault.getFileByPath(file.path) !== file) continue;
          if (now?.frontmatter?.['ir-id'] !== id) continue;
          matchedTags = this.#triggerTagsOf(file, now, config);
          if (!matchedTags) continue;
        }
      }
      // Un-imported, or while the lookup ran, which may be why no row holds it
      if (this.#unimported.has(file)) continue;
      entries.push({ file, matchedTags });
    }
    if (held.length > 0 && this.#running) {
      for (const file of held) this.#queued.add(file);
      this.#schedule();
    }
    // Stopped while a lookup ran: the plugin is unloading
    if (entries.length === 0 || !this.#running) return new Set();

    const outcomes = await this.#importMany(entries, config);
    const failed = outcomes.filter(({ status }) => status === 'failed');
    for (const { file } of failed) this.#failed.add(file.path);
    const imported = outcomes.filter(
      ({ status }) => status === 'imported'
    ).length;
    if (imported > 0) {
      notify(`Imported ${imported} article${imported === 1 ? '' : 's'}`, {
        kind: 'success',
        category: 'import',
      });
    }
    if (failed.length > 0) notify(describeFailures(failed), { kind: 'error' });
    return new Set(failed.map(({ file }) => file));
  }

  /**
   * Store the moment up to which every change was seen, if {@link
   * runCatchUpScan} has run while listening: back as far as the note waiting
   * longest, as that is not imported yet, or the oldest change of a note
   * waiting, as one the startup scan found, or Sync brought with its old
   * mtime, may wait for Sync for days; and further for the notes still being
   * read (see `AUTO_IMPORT_WATERMARK_SLACK_MS`).
   */
  #recordSeen(): void {
    if (!this.#running || !this.#caughtUp) return;
    let since = this.#queuedSince ?? Date.now();
    for (const file of this.#queued) since = Math.min(since, file.stat.mtime);
    this.#record(since - AUTO_IMPORT_WATERMARK_SLACK_MS);
  }

  /** Store `time` as the moment last seen to, unless one later is stored. */
  #record(time: number): void {
    const stored = loadAutoImportWatermark(this.#app);
    if (stored !== null && stored >= time) return;
    saveAutoImportWatermark(this.#app, time);
  }

  /**
   * Whether `file`, whose `id` a row holds, lost the tag that makes it that
   * article (see {@link AutoImportWatcherOptions.needsRepair}). A lookup that
   * throws counts as no: the note is left alone this time, as by
   * {@link #rowHolds}.
   */
  async #lostTag(id: string, file: TFile): Promise<boolean> {
    try {
      return await this.#needsRepair(id, file);
    } catch (error) {
      console.error(
        `Incremental Reading - couldn't check the note with ir-id "${id}" for its article tag:`,
        error
      );
      return false;
    }
  }

  /**
   * Whether a row holds `id`. A lookup that throws counts as yes: the note is
   * left alone this time, not remembered as failed, so its next change tries
   * again.
   */
  async #rowHolds(id: string): Promise<boolean> {
    try {
      return await this.#hasRow(id);
    } catch (error) {
      console.error(
        `Incremental Reading - couldn't look up ir-id "${id}" for an automatic import:`,
        error
      );
      return true;
    }
  }
}
