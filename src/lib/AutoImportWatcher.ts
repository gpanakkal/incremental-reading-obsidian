import { describeFailures } from '#/lib/bulk-import/run-import';
import type { BulkImportEntry, BulkOutcome } from '#/lib/bulk-import/types';
import {
  TFile,
  type App,
  type CachedMetadata,
  type MetadataCache,
  type TAbstractFile,
  type Vault,
} from 'obsidian';
import {
  AUTO_IMPORT_DEBOUNCE_MS,
  AUTO_IMPORT_MAX_WAIT_MS,
  AUTO_IMPORT_WATERMARK_SLACK_MS,
  DATA_DIRECTORY,
  IMPORT_BLOCKED_TAGS,
} from './constants';
import { isImportable, supportsFrontmatter } from './mime';
import { notify } from './notices';
import {
  loadAutoImportWatermark,
  saveAutoImportWatermark,
} from './plugin-data';
import type { AutoImportMode } from './settings';
import { matchFrontmatterTags } from './tags';
import { isUnderAnyFolder, isUnderFolder } from './watched-folders';

/** What decides whether, and how, notes are imported. Read afresh each time. */
export interface AutoImportConfig {
  /** Whether a note that gains a trigger tag is imported. */
  enabled: boolean;
  /** The tags that make a note an article, as `parseTagList` reads them. */
  triggerTags: readonly string[];
  /** The priority an imported note starts with. */
  priority: number;
  /** Whether a note is imported where it is or as a copy, for `importMany`. */
  mode: AutoImportMode;
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
 * it keeps the moment it last saw every change.
 */
interface WatchedApp
  extends Pick<App, 'loadLocalStorage' | 'saveLocalStorage'> {
  vault: Pick<Vault, 'getFileByPath' | 'getMarkdownFiles'>;
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
 * deleted article stays deleted. A note whose `ir-id` no row holds is
 * imported, as the import command imports it (see `hasRow`). A note whose
 * import failed is remembered until the plugin next loads, so it isn't tried
 * again on every edit.
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
  /** Notes handed to the import running now. */
  readonly #importing = new Set<TFile>();
  /**
   * Whether {@link runCatchUpScan} has run, so the stored moment may move on:
   * until then, what changed while Obsidian was closed is still unseen.
   */
  #caughtUp = false;
  /** Whether importing was on when last looked at, to see it turned on. */
  #wasEnabled = false;
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
  }: AutoImportWatcherOptions) {
    this.#app = app;
    this.#getConfig = getConfig;
    this.#importMany = importMany;
    this.#hasRow = hasRow;
  }

  /** Begin importing. Returns the cleanup to hand to `Plugin.register`. */
  start(): () => void {
    this.#running = true;
    this.#wasEnabled = this.#getConfig().enabled;
    return () => {
      this.#recordSeen();
      this.#running = false;
      this.#cancelTimer();
      this.#queued.clear();
      this.#queuedSince = null;
      this.#arrived.clear();
      this.#queuedArrivals.clear();
    };
  }

  /**
   * Queue `file` for import if its frontmatter, as `cache` has it, calls for
   * one, or if it is a note that arrived in a watched folder and this is the
   * first look at its frontmatter.
   */
  consider(file: TFile, cache: CachedMetadata | null): void {
    const config = this.#getConfig();
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
    if (!byArrival && this.#triggerTagsOf(file, cache, config) === null) {
      return;
    }
    if (byArrival) this.#queuedArrivals.add(file);
    this.#queued.add(file);
    this.#schedule();
  }

  /**
   * Hear of a change to the settings. Importing by tag turned on applies from
   * then on: a note tagged before is no change it saw, and is left alone.
   */
  configChanged(): void {
    const { enabled } = this.#getConfig();
    if (this.#running && enabled && !this.#wasEnabled) {
      this.#record(Date.now());
    }
    this.#wasEnabled = enabled;
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
    const seen = loadAutoImportWatermark(this.#app);
    this.#caughtUp = true;
    if (seen === null || !this.#getConfig().enabled) {
      this.#record(Date.now());
      return Promise.resolve();
    }
    const { vault, metadataCache } = this.#app;
    for (const file of vault.getMarkdownFiles()) {
      // Untouched since: before the cache is read, as that is nearly every note
      if (file.stat.mtime <= seen) continue;
      // Its cache may not show the `ir-id` that import is writing yet, so
      // checked again it would be imported twice
      if (this.#importing.has(file)) continue;
      this.consider(file, metadataCache.getFileCache(file));
    }
    // The flush moves the stored moment on
    return this.flushNow();
  }

  /**
   * Tell the watcher `file` was created, or moved from `oldPath`. One that
   * lands in a watched folder from outside every watched folder is imported:
   * a PDF as it is, a note once its frontmatter is known. That is when the
   * metadata cache first reads a new note ({@link consider}), and at once for
   * a note moved in, which keeps its cache. An empty note waits until it has
   * something in it. A note is never imported unread:
   * one with an `ir-id`, such as an article Sync delivers, is left alone.
   * Folders, and files moved out or within, are ignored.
   */
  noteArrival(file: TAbstractFile, oldPath?: string): void {
    if (!this.#running || !(file instanceof TFile) || !isImportable(file)) {
      return;
    }
    const config = this.#getConfig();
    if (!this.#watches(file.path, config)) return;
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
   * Import whatever is waiting now rather than when it settles. Resolves once
   * every import asked for so far is done.
   */
  flushNow(): Promise<void> {
    this.#cancelTimer();
    const batch = [...this.#queued];
    const arrivals = new Set(this.#queuedArrivals);
    this.#queued.clear();
    this.#queuedArrivals.clear();
    this.#queuedSince = null;
    this.#pending = this.#pending
      .then(async () => {
        await this.#import(batch, arrivals);
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
   * went.
   */
  async #import(
    batch: readonly TFile[],
    arrivals: ReadonlySet<TFile>
  ): Promise<void> {
    const config = this.#getConfig();
    const entries: AutoImportEntry[] = [];
    for (const file of batch) {
      // Gone if deleted, or if another file took its path. A rename moves
      // `file` with it, so a renamed note is still found, where it now is.
      if (this.#app.vault.getFileByPath(file.path) !== file) continue;
      const cache = this.#app.metadataCache.getFileCache(file);
      const matchedTags =
        this.#triggerTagsOf(file, cache, config) ??
        (arrivals.has(file) && this.#arrivalQualifies(file, cache, config)
          ? []
          : null);
      if (!matchedTags) continue;
      // An id is a string; anything else there matches no row, and the
      // import replaces it. The plugin's own write of an `ir-id` comes back
      // here, so each import costs one lookup.
      const id: unknown = cache?.frontmatter?.['ir-id'];
      if (typeof id === 'string' && (await this.#rowHolds(id))) continue;
      entries.push({ file, matchedTags });
    }
    // Stopped while a lookup ran: the plugin is unloading
    if (entries.length === 0 || !this.#running) return;

    for (const { file } of entries) this.#importing.add(file);
    let outcomes: BulkOutcome[];
    try {
      outcomes = await this.#importMany(entries, config);
    } finally {
      this.#importing.clear();
    }
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
  }

  /**
   * Store the moment up to which every change was seen, if {@link
   * runCatchUpScan} has run while listening: back as far as the note waiting
   * longest, as that is not imported yet, and further for the notes still
   * being read (see `AUTO_IMPORT_WATERMARK_SLACK_MS`).
   */
  #recordSeen(): void {
    if (!this.#running || !this.#caughtUp) return;
    const since = this.#queuedSince ?? Date.now();
    this.#record(since - AUTO_IMPORT_WATERMARK_SLACK_MS);
  }

  /** Store `time` as the moment last seen to, unless one later is stored. */
  #record(time: number): void {
    const stored = loadAutoImportWatermark(this.#app);
    if (stored !== null && stored >= time) return;
    saveAutoImportWatermark(this.#app, time);
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
