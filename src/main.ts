import { AutoImportWatcher } from '#/lib/AutoImportWatcher';
import { folderSource } from '#/lib/bulk-import/candidates';
import {
  itemCount,
  selectionMayImport,
  selectionRoots,
  selectionSource,
} from '#/lib/bulk-import/selection';
import { createEmitter } from '#/lib/emitter';
import {
  explorerComparator,
  readExplorerSortOrder,
} from '#/lib/explorer-order';
import { registerPdfLeafHighlights } from '#/lib/extensions/PdfItemHighlights';
import {
  createArrivalWarning,
  ItemPathGuard,
  refusedPathsWarning,
  startupWarning,
} from '#/lib/item-path-guard';
import { withTag } from '#/lib/item-tags';
import { checkImportable } from '#/lib/items/ArticleManager';
import { appendLog } from '#/lib/log-file';
import { getMimeType, isCopyImportable, isImportable } from '#/lib/mime';
import { trackNavbarFootprint } from '#/lib/navbar-footprint';
import { isPdfView, stopPdfTabSelections } from '#/lib/pdf/obsidian-pdf';
import { registerPluginIcon } from '#/lib/plugin-icon';
import { REBIND_LOG_TOPIC } from '#/lib/rebind-records';
import { goToReviewPlace } from '#/lib/review-history';
import {
  type Menu,
  type PaneType,
  type TAbstractFile,
  type TFile,
  type WorkspaceLeaf,
  ItemView,
  Keymap,
  MarkdownView,
  Plugin,
  TFolder,
} from 'obsidian';
// @ts-ignore - SQL schema imported via custom esbuild plugin
import databaseSchema from './db/schema.sql';
import { Actions } from './lib/Actions';
import { DATABASE_FILE_PATH, PLUGIN_ICON } from './lib/constants';
import { recordEphemeralState } from './lib/ephemeral-position';
import { createIRExtensions, IR_ID_LOCKED_NOTICE } from './lib/extensions';
import { registerFileExplorerActiveFileClick } from './lib/extensions/FileExplorerActiveFileClick';
import { registerReadingModeActionBar } from './lib/extensions/ReadingModeActionBar';
import {
  MIDDLE_MOUSE_BUTTON,
  openHighlightFromEvent,
} from './lib/extensions/SnippetHighlightExtension';
import {
  registerHighlightRefreshListener,
  registerSnippetHighlightPostProcessor,
} from './lib/extensions/SnippetHighlightPostProcessor';
import { registerTransclusionHostPostProcessor } from './lib/extensions/TransclusionHostPostProcessor';
import { createIrIdRepairer } from './lib/ir-id-repair';
import {
  type IrIdWarning,
  type NoticeTarget,
  type Timer,
  createIrIdWarning,
  createTypeTagNotices,
  hostTimer,
  IR_ID_WARNING_MESSAGE,
  persistentNotice,
} from './lib/ir-id-warning-notice';
import ReviewManager from './lib/items/ReviewManager';
import { scanForMovedNotes } from './lib/moved-note-scan';
import { configureSuccessNotices } from './lib/notices';
import {
  type ExtractedMarkdownEditor,
  getEditorClass,
} from './lib/obsidian-editor';
import {
  findSyncExclusions,
  getSyncPlugin,
  holdForSync,
  syncExclusionMessage,
} from './lib/obsidian-sync';
import { ObsidianHelpers as Obsidian } from './lib/ObsidianHelpers';
import {
  type IRPluginData,
  type ReviewSession,
  type UiState,
  getDeviceId,
  parsePluginData,
  sessionItemId,
} from './lib/plugin-data';
import {
  applyQueueChange,
  invalidateCacheOnMatch,
  invalidateCurrentItemQuery,
  queryClient,
  resetCurrentOnMatch,
  startItemCacheEviction,
} from './lib/query-client';
import {
  DatabaseLoadError,
  SQLJSRepository,
  StartupCancelledError,
} from './lib/repository/SQLJSRepository';
import { initReviewCommands } from './lib/review-commands';
import {
  type ReviewReminder,
  startReviewReminder,
} from './lib/review-reminder';
import { SessionTracker } from './lib/SessionTracker';
import { type IRPluginSettings, IRSettingTab } from './lib/settings';
import { setCurrentItemId, setPage, store } from './lib/store';
import type { ReviewItem, SQLiteRepository } from './lib/types';
import { unimportArticle } from './lib/unimport-article';
import {
  type WebPage,
  type WebViewerView,
  asWebViewer,
  readWebPage,
} from './lib/web-viewer';
import { BulkImportModal } from './views/BulkImportModal';
import { ImportModal } from './views/ImportModal';
import { LeftoverWatch } from './views/LeftoverModal';
import ReviewView from './views/ReviewView';

/**
 * The notice for a startup that failed with `error`. A database file that
 * would not load gets its own, saying it was not touched: a general "failed
 * to initialize" over a database that holds everything the user has reads as
 * data loss.
 */
export function startupFailureMessage(error: unknown): string {
  if (error instanceof DatabaseLoadError) {
    return (
      `Incremental reading: the database file ${error.dbFilePath} could not ` +
      `be loaded, so the plugin did not start. The file was left unchanged. ` +
      `See the console for details.`
    );
  }
  return `Failed to initialize plugin. See the console for details.`;
}

/** Shown for a way into review used before the database is up. */
export const STILL_STARTING_NOTICE =
  'Incremental reading: still starting. Try again in a moment.';

/**
 * For e2e tests only: how long startup waits on Sync, when a test has put a
 * number at `window.__irSyncWaitTimeoutMs` before enabling the plugin.
 * Otherwise undefined, for the default.
 */
function syncWaitTimeoutForTests(): number | undefined {
  const value = (window as { __irSyncWaitTimeoutMs?: unknown })
    .__irSyncWaitTimeoutMs;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Web viewers whose page is being imported. A second import asked for while
 * one runs would make a second note, named apart from the first.
 */
const importingWebViewers = new WeakSet<WebViewerView>();

/** A promise and the function that settles it, as ES2024's `Promise.withResolvers`. */
function withResolvers<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

export default class IncrementalReadingPlugin extends Plugin {
  /** Everything persisted to `data.json`; `settings` is this object's own half. */
  data!: IRPluginData;
  // `declare`: Obsidian 1.13 types `Plugin.settings` as `unknown`, so this
  // narrows it without emitting a class field.
  declare settings: IRPluginSettings;
  /** Announces each {@link saveSettings}; see {@link onSettingsChange}. */
  private readonly settingsChanged = createEmitter();
  /**
   * Hear of each change to the settings, as `useSyncExternalStore` subscribes:
   * returns the unsubscribe. Heard on every {@link saveSettings}, which every
   * writer of a setting calls, so a listener rereads what it needs.
   */
  readonly onSettingsChange = this.settingsChanged.subscribe;
  sessionTracker?: SessionTracker;
  reviewManager!: ReviewManager;
  store!: typeof store;
  actions!: Actions;
  /**
   * Re-checks which open tabs carry a standalone action bar. Unset until the
   * bars are registered, after the database is up.
   */
  private resyncLeafActionBars?: () => void;
  /**
   * Explains an edit to `ir-id` that the editor guard refused. Read by
   * `irIdGuardExtension` through `irPluginFacet`, and unset until the guard is
   * registered alongside it.
   */
  irIdLockedWarning?: IrIdWarning;
  /**
   * Puts back a rename that would break links to an item. Unset until the
   * review manager it asks is up.
   */
  private itemPathGuard?: ItemPathGuard;
  /**
   * The status bar's "Ready for review". Unset on mobile, which has no status
   * bar, and until the review manager it asks is up.
   */
  private reviewReminder?: ReviewReminder;
  /** Imports notes that gain a trigger tag. Unset until the database is up. */
  autoImportWatcher?: AutoImportWatcher;
  /**
   * Settles with {@link autoImportWatcher} once {@link watchAutoImports} has
   * made it. The startup scan in {@link followMovedNotes} waits on this, not
   * on which of the two happens to run first.
   */
  private readonly autoImportWatcherMade = withResolvers<AutoImportWatcher>();
  /**
   * The notes left without review data by a crash, which review asks about.
   * Unset until the database it reads is up.
   */
  leftovers?: LeftoverWatch;

  MarkdownEditor!: typeof ExtractedMarkdownEditor;

  async onload() {
    await this.loadSettings();
    // Success notices follow this plugin's levels, inside review or not
    configureSuccessNotices(this);
    this.MarkdownEditor = getEditorClass(this.app);

    // Before anything draws it: `setIcon` draws nothing for an unknown id
    registerPluginIcon();
    const ribbonIconEl = this.addRibbonIcon(
      PLUGIN_ICON,
      'Incremental reading',
      async (_evt: MouseEvent) => {
        // The database can take a while to start, as when it waits on Sync
        if (!this.reviewManager) {
          Obsidian.notify(STILL_STARTING_NOTICE);
          return;
        }
        await this.learn();
      }
    );

    ribbonIconEl.addClass('incremental-reading-ribbon');

    this.addExtractCommands();

    this.addImportCommands();

    this.addCommand({
      id: 'create-empty-article',
      name: 'Create empty article',
      checkCallback: (checking: boolean) => {
        if (!this.reviewManager) return false;

        if (checking) return true;

        // get the current folder from the open view, if any
        const fileView = this.app.workspace.getActiveFileView();
        const currentDirectory = fileView?.file?.parent?.path;
        void this.reviewManager
          .createEmptyArticle(this.settings.defaultPriority, currentDirectory)
          .then((article) => void this.learn(article ?? undefined));
      },
    });

    this.addCommand({
      id: 'learn',
      name: 'Learn',
      checkCallback: (checking: boolean) => {
        if (!this.reviewManager) return false;
        if (checking) return true;
        void this.learn();
      },
    });

    if (this.settings.showAdvancedImportCommands) {
      this.toggleAdvancedCommands(true);
    }

    this.addCommand({
      id: 'undo',
      name: 'Undo last action',
      checkCallback: (checking: boolean) => {
        if (!this.reviewManager) return false;
        if (checking) return true;

        void this.actions.undo();
      },
    });

    initReviewCommands(this);

    this.registerEvent(
      this.app.workspace.on(
        'file-menu',
        (menu, abstractFile, _source, leaf) => {
          this.addIRMenuItems(menu, abstractFile, leaf);
        }
      )
    );
    // `files-menu` fires only when the item right-clicked is part of a
    // multi-selection in the Files view (Bases and Canvas raise it too); a
    // single right-click raises `file-menu`. Its `files` may hold folders, and
    // from the Files view `leaf` is null (observed, not documented).
    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files, _source, leaf) => {
        this.addSelectionMenuItems(menu, files, leaf);
      })
    );
    // Undocumented: `leaf-menu`, raised for a tab's more-options and tab
    // header menus after its view has filled them. A web viewer holds no
    // file, so `file-menu` never reaches its menu.
    this.registerEvent(
      this.app.workspace.on('leaf-menu', (menu, leaf) => {
        this.addWebViewerMenuItems(menu, leaf);
      })
    );

    // Invalidate review item cache when the current item's file is modified externally
    this.registerEvent(
      this.app.vault.on(
        'modify',
        (file) => void invalidateCacheOnMatch(file, this.reviewManager)
      )
    );

    // listen for file renames to update references in db. Renames before the
    // review manager exists, and moves made while Obsidian was closed, are
    // caught by `followMovedNotes` instead.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) =>
        this.onVaultRename(file, oldPath)
      )
    );

    // listen for file deletions, mark items deleted, and go to next item if
    // the current item was deleted
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.onVaultDelete(file))
    );

    this.addSettingTab(new IRSettingTab(this.app, this));

    // // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
    // this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

    this.app.workspace.onLayoutReady(async () => {
      // expensive startup operations should go here
      try {
        if (!this.manifest.dir) {
          throw new Error('manifest.dir is undefined');
        }

        // Not awaited: Sync's settings may be minutes from loading, and
        // nothing here depends on them
        void this.verifySyncSettings();

        if (this.app.isMobile) {
          this.configureNavbarPosition();
        }

        this.store = store;
        await this.initReviewManager();
        this.actions = new Actions(this);
        // Nothing is resumed here: a review tab restored with the workspace
        // resumes itself as it mounts (`ReviewView.resumeUnclaimedSession`),
        // which is the only moment that knows a tab is actually coming back.
        // Reading the pointer any earlier would put `page` on an item no tab is
        // showing, and the first visit to the home screen would then read as
        // leaving review and discard it. Until a tab mounts, the pointer simply
        // stays on disk, held by the tracker.
        this.startSessionTracking();
        this.register(startItemCacheEviction());
        this.registerView(
          ReviewView.viewType,
          (leaf) => new ReviewView(leaf, this, this.reviewManager)
        );
        this.showReviewReminders();

        // One notice for a held key's worth of refused edits, like the repair
        // path's warning below but with its own message: nothing was changed
        // here, where there it already had been. Uncounted, because a count of
        // key repeats is nothing the user can act on.
        const lockedWarning = createIrIdWarning({
          createNotice: persistentNotice,
          message: IR_ID_LOCKED_NOTICE,
          showCount: false,
        });
        this.irIdLockedWarning = lockedWarning;
        this.register(() => lockedWarning.dispose());

        // Register global CodeMirror extensions for IR notes
        this.registerEditorExtension(createIRExtensions(this));
        // Lets scroll restore stand aside for a note opened to a particular
        // place, which Obsidian tells the view only through this method.
        this.register(recordEphemeralState(MarkdownView.prototype));

        // Register post-processor for reading mode snippet highlights
        registerSnippetHighlightPostProcessor(this);
        registerHighlightRefreshListener(this);
        // Snippet highlights on Obsidian's own PDF tabs (review's PDF viewer
        // keeps its own)
        registerPdfLeafHighlights(this);

        // Mark reading mode transclusion hosts for styles.css
        registerTransclusionHostPostProcessor(this);

        // Action bar on notes in reading mode and on PDF article tabs
        this.resyncLeafActionBars = registerReadingModeActionBar(this);

        // Make the reviewed note openable from the file explorer, which
        // otherwise swallows a plain click on the active file's row
        registerFileExplorerActiveFileClick(this);

        this.watchCreations(hostTimer);

        this.watchIrIdFrontmatter();

        this.watchAutoImports();

        // Delegated handlers for highlights in reading mode.
        // The CM extension's eventHandlers cover edit mode;
        // these cover reading mode rendered HTML.
        const openHighlightInReadingMode = (evt: MouseEvent) => {
          const target = evt.target as HTMLElement | null;
          // Skip if inside a CM editor — the CM extension handles that
          if (target?.closest('.cm-editor')) return;
          openHighlightFromEvent(this, evt);
        };

        this.registerDomEvent(document, 'click', openHighlightInReadingMode);

        // Middle click fires auxclick, not click. Right-click fires auxclick
        // too, so restrict this to the middle button.
        this.registerDomEvent(document, 'auxclick', (evt: MouseEvent) => {
          if (evt.button !== MIDDLE_MOUSE_BUTTON) return;
          openHighlightInReadingMode(evt);
        });

        // Suppress the middle-click default action (autoscroll / primary-paste)
        // over a highlight so the auxclick above is a clean navigation.
        this.registerDomEvent(document, 'mousedown', (evt: MouseEvent) => {
          if (evt.button !== MIDDLE_MOUSE_BUTTON) return;
          const target = evt.target as HTMLElement | null;
          if (!target?.closest('.ir-snippet-highlight')) return;
          evt.preventDefault();
        });
      } catch (error) {
        // Unloaded while startup waited on Sync, so there is nothing to undo
        if (error instanceof StartupCancelledError) return;
        console.error(error);
        Obsidian.notify(startupFailureMessage(error), {
          kind: 'error',
          persist: true,
        });
        this.unload();
      }
    });
  }

  /**
   * Runs last in `Component.unload`, after every child, registered view and
   * listener is gone, so nothing torn down above can still be writing. (That
   * order is undocumented; it is what `Component.prototype.unload` in
   * obsidian.asar does.) The repository goes then: an instance being replaced
   * in place — by an update or a disable and re-enable — must never save its
   * copy of the database over the file the next instance is loading and
   * migrating.
   *
   * A teardown write that is still waiting on an `await` when this runs, such
   * as a PDF tab saving its scroll position, is refused rather than saved.
   */
  onunload() {
    this.reviewManager?.repo.dispose();
    configureSuccessNotices(null);
  }

  async loadSettings() {
    this.data = parsePluginData(await this.loadData());
    // The same object, not a copy: every `plugin.settings.x = y; saveSettings()`
    // call site keeps working, and its edit is already in what gets written.
    this.settings = this.data.settings;
  }

  /**
   * Say in the status bar when items are ready for review, and open review
   * from there. Desktop only: mobile has no status bar.
   */
  private showReviewReminders() {
    // `app.isMobile` is undocumented (obsidian-typings); true under
    // `emulateMobile` too, which hides the status bar as well
    if (this.app.isMobile) return;
    const reminder = startReviewReminder({
      el: this.addStatusBarItem(),
      icon: PLUGIN_ICON,
      reviewManager: this.reviewManager,
      getSettings: () => this.settings,
      onDataChange: (listener) =>
        this.reviewManager.repo.onDataChange(listener),
      onSettingsChange: this.onSettingsChange,
      open: () => void this.learn(),
    });
    this.reviewReminder = reminder;
    this.register(() => reminder.dispose());
  }

  getActiveReviewView(): ReviewView | null {
    return this.app.workspace.getActiveViewOfType(ReviewView);
  }

  getOpenReviewLeaf(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(ReviewView.viewType);
    return leaves[0] ?? null;
  }

  /**
   * Write the settings, telling each {@link onSettingsChange} listener first:
   * the open views read the settings from memory, and a failed write must not
   * leave them behind the views opened after it.
   */
  async saveSettings() {
    this.settingsChanged.emit();
    await this.saveData(this.data);
  }

  /**
   * Persist (or drop) the item review left off on. Writes the whole file, since
   * that is all `saveData` can do — hence the single shared {@link data}.
   */
  async saveSession(session: ReviewSession | null) {
    this.data.session = session;
    await this.saveData(this.data);
  }

  /**
   * Remember `change` to how a dialog was left, so it opens that way next
   * time, restarts included. Writes the whole file, as {@link saveSession}.
   */
  async saveUiState(change: Partial<UiState>) {
    Object.assign(this.data.ui, change);
    await this.saveData(this.data);
  }

  /**
   * Put the item review last had open back into the store, and report whether
   * there is one. Does nothing once review already has an item.
   *
   * The pointer outlives the review tab, so this runs both at startup and when
   * the tab is reopened — closing it is somewhere to come back to. It is only as
   * good as the database, though: the item may have been deleted, or the row may
   * have arrived from another device's sync, so it is resolved before it is
   * trusted and dropped when it no longer resolves.
   *
   * The page is left to the caller — startup opens straight onto the item, while
   * {@link learn} keeps its usual home-screen choice.
   */
  async resumeSession(): Promise<boolean> {
    if (store.getState().currentItemId) return false;

    // Tracking owns the pointer once it is running: a departure it has not
    // written out yet is still a departure, while `data.json` would still name
    // the item for another `SESSION_CLEAR_DELAY`. Only startup, which runs
    // before tracking begins, reads the file.
    const itemId = this.sessionTracker
      ? this.sessionTracker.itemId
      : sessionItemId(this.data.session, getDeviceId(this.app));
    if (!itemId) return false;

    const item = await this.reviewManager.getItemOrMissingFromId(itemId);
    // A dismissed item is not coming back into review, and the pointer can name
    // one: dismissing runs a database write first, so a tab closed in the
    // moments after the click records the item still on screen.
    if (!item || item.data.dismissed) {
      // Through tracking where it is running, so that its own idea of what is
      // on disk goes with the pointer; straight to the file at startup, which
      // is the only time there is no tracker to tell.
      if (this.sessionTracker) this.sessionTracker.forget();
      else await this.saveSession(null);
      return false;
    }
    store.dispatch(setCurrentItemId(itemId));
    return true;
  }

  /** Keep `data.json` in step with the item review is showing. */
  private startSessionTracking() {
    const deviceId = getDeviceId(this.app);
    this.sessionTracker = new SessionTracker({
      store,
      deviceId,
      initialItemId: sessionItemId(this.data.session, deviceId),
      save: (session) => this.saveSession(session),
    });
    this.register(this.sessionTracker.start());
    // Quitting empties the review session the same way leaving it does; stop
    // mirroring before any of that teardown can be written out. The write that
    // suspending settles goes on the quit's own task list, so the app waits for
    // `data.json` rather than closing over a half-finished save.
    this.registerEvent(
      this.app.workspace.on('quit', (tasks) => {
        const suspended = this.sessionTracker?.suspend();
        if (suspended) tasks.addPromise(suspended);
      })
    );
  }

  /**
   * Overridden rather than handled in {@link onunload}: `Component.unload`
   * tears down children — the review view among them — around that call, and
   * the view's teardown empties the review session. Suspending here runs before
   * any of it, so an unload cannot clear the remembered item.
   *
   * The write it settles is left to finish on its own — unlike the quit above,
   * nothing here can be made to wait, and the app is still running to complete
   * it.
   */
  override unload() {
    void this.sessionTracker?.suspend();
    super.unload();
  }

  private async initReviewManager() {
    let writesBlockedNotice: NoticeTarget | null = null;
    // An instance unloaded while its database starts — by an update installed
    // in place, say, while startup waits on Sync — must not go on to migrate
    // and save after the instance replacing it has loaded the file
    const unloaded = new AbortController();
    this.register(() => unloaded.abort());
    const repo: SQLiteRepository = await SQLJSRepository.start({
      plugin: this,
      dbFilePath: DATABASE_FILE_PATH,
      schema: databaseSchema as string,
      signal: unloaded.signal,
      holdForSync: (reason) =>
        holdForSync({
          getSync: () => getSyncPlugin(this.app),
          path: DATABASE_FILE_PATH,
          reason,
          signal: unloaded.signal,
          timeoutMs: syncWaitTimeoutForTests(),
          createNotice: persistentNotice,
          notify: (message, options) => Obsidian.notify(message, options),
        }),
      onMigrationFailure: (error) => {
        console.error(
          'Incremental Reading - Migration verification failed:',
          error.errors
        );
        Obsidian.notify(
          `Incremental reading: database migration failed. ` +
            `Check the console for details.`,
          { kind: 'error', persist: true }
        );
        this.unload();
      },
      // Up until saving resumes, which is when the notice stops being true
      onWriteBlocked: (error) => {
        writesBlockedNotice?.hide();
        writesBlockedNotice = persistentNotice(
          `Incremental reading: ${error.message}`
        );
      },
      onWritesResumed: () => {
        writesBlockedNotice?.hide();
        writesBlockedNotice = null;
        // Highlight offsets the review editor couldn't save meanwhile
        void this.reviewManager?.snippets.persistPendingOffsets();
      },
      onReloadFromDisk: async () => {
        await invalidateCurrentItemQuery();
        // A swapped-in database reports no change to any row, so the queue
        // would keep what it last read, a failed read included
        await queryClient.invalidateQueries({ queryKey: ['queue'] });
        // A PDF is an article only by its row, and a swapped-in database
        // reports no change to any row
        this.resyncLeafActionBars?.();
        // Nor does what is due
        this.reviewReminder?.refresh();
        // Item text is re-fetched above, but snippet highlights are cached
        // separately in the offset tracker and are just as stale: the rows they
        // came from went out with the replaced database. The event that
        // normally refreshes them is raised by whichever device took the
        // snippet, and events do not cross devices, so raise it here.
        if (!this.reviewManager) return;
        await this.reviewManager.refreshAllHighlights();
      },
    });
    // Unloaded just as the database finished starting: nothing below may
    // register on a plugin that is gone
    if (unloaded.signal.aborted) {
      repo.dispose();
      throw new StartupCancelledError();
    }
    // listen for sync updates to the database and re-read the file. Sync
    // reports a file it downloads for the first time — to a device that
    // started without one — as `create`, not `modify`.
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        void repo.handleFileChange(file);
      })
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        void repo.handleFileChange(file);
      })
    );
    this.reviewManager = new ReviewManager(this, repo);
    this.itemPathGuard = new ItemPathGuard({
      app: this.app,
      isItemFile: (file, path) => this.reviewManager.isItemFileAt(file, path),
      referencesUnder: (folder) => this.reviewManager.referencesUnder(folder),
      follow: (file, oldPath) => this.followRename(file, oldPath),
      notify: (...args) => Obsidian.notify(...args),
    });
    this.leftovers = this.createLeftoverWatch(repo);
    this.followMovedNotes(repo);

    // Keep the review-queue table live: when a row on a cached page changes,
    // patch (or drop) it and reconcile order/totals. Unsubscribe on unload.
    this.register(
      repo.onDataChange((event) => {
        void applyQueueChange(event, this.reviewManager);
      })
    );
  }

  /**
   * Follow a file or folder Obsidian renamed or moved from `oldPath`. A rename
   * that would break links to an item is put back instead, and neither it nor
   * its undo is followed: the guard is asked first, and at once (see
   * {@link ItemPathGuard}). A folder's files each fire their own rename.
   */
  private onVaultRename(file: TAbstractFile, oldPath: string) {
    if (!this.reviewManager) return;
    if (this.itemPathGuard?.handleRename(file, oldPath)) return;
    if (file instanceof TFolder) return;
    this.followRename(file, oldPath);
  }

  /**
   * Listen for file creations and handle them, especially restored item
   * notes. One notice names every item a burst brings to a path that breaks
   * links to it, and those paths count as heard of at the next startup.
   */
  private watchCreations(timer: Timer) {
    const arrivals = createArrivalWarning({
      notify: (message, paths) => {
        Obsidian.notify(message);
        void this.rememberWarnedPaths([
          ...this.data.warnedRefusedPaths,
          ...paths,
        ]);
      },
      timer,
    });
    this.register(() => arrivals.dispose());
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!this.reviewManager) return;
        void this.reviewManager.handleCreation(file).then((refused) => {
          if (refused !== null) arrivals.add(refused);
          return invalidateCacheOnMatch(file, this.reviewManager);
        });
      })
    );
  }

  /** Keep `paths` as the item paths that break links the user has heard of. */
  private async rememberWarnedPaths(paths: readonly string[]) {
    this.data.warnedRefusedPaths = [...new Set(paths)];
    await this.saveData(this.data);
  }

  /**
   * Mark the rows of a deleted file deleted, where the database has them:
   * elsewhere, if its rename was being put back. Review moves on if it was
   * showing it.
   */
  private onVaultDelete(file: TAbstractFile) {
    if (!this.reviewManager) return;
    const path = this.itemPathGuard?.pathBeforeDeletion(file) ?? file.path;
    void this.reviewManager
      .handleDeletion(file, path)
      .then(() => resetCurrentOnMatch(file, this.reviewManager));
  }

  /** Point the database at where `file` moved from `oldPath`. */
  private followRename(file: TAbstractFile, oldPath: string) {
    void this.reviewManager
      .handleExternalRename(file, oldPath)
      .then(() => invalidateCacheOnMatch(file, this.reviewManager));
  }

  /**
   * Put back `ir-id` frontmatter and item type tags that were changed outside
   * the plugin, and bring a row back when a mangled id is undone. See
   * {@link createIrIdRepairer}.
   *
   * Registered here rather than in {@link onload} for two reasons. The repairs
   * read and write the database, which does not exist until
   * {@link initReviewManager} has run; and Obsidian presents the whole vault to
   * the metadata cache before the layout is ready, so by now the first index —
   * one `changed` per file in the vault — is already over. Anything mangled while
   * Obsidian was closed is caught on that item's next review fetch, as it was
   * before this existed.
   */
  private watchIrIdFrontmatter() {
    const { vault, metadataCache } = this.app;
    // One notice at a time however many notes a single burst damages: a checkout
    // or a folder arriving over Sync can name a great many at once, and a stack
    // of identical warnings would be worse than the edit it is warning about
    const warning = createIrIdWarning({
      createNotice: persistentNotice,
      message: IR_ID_WARNING_MESSAGE,
    });
    this.register(() => warning.dispose());
    const tagNotices = createTypeTagNotices({ createNotice: persistentNotice });
    this.register(() => tagNotices.dispose());

    const repairer = createIrIdRepairer({
      repo: this.reviewManager.repo,
      vault,
      metadataCache,
      // A tag is added inside the write, off the note as it is on disk now, so
      // another writer's edit since the cache read is kept and the tag never
      // doubles
      writeIrId: (file, id, tag) =>
        Obsidian.updateFrontMatter(
          file,
          (frontmatter) => {
            frontmatter['ir-id'] = id;
            if (tag !== undefined) {
              frontmatter.tags = withTag(frontmatter.tags, tag);
            }
          },
          this.app
        ),
      writeTag: (file, tag) =>
        Obsidian.updateFrontMatter(
          file,
          (frontmatter) => {
            frontmatter.tags = withTag(frontmatter.tags, tag);
          },
          this.app
        ),
      // A row coming back comes back at a new `reference`, and highlights are
      // cached by note path. The queue table patches itself from the
      // repository's own change events.
      onRepaired: async (repairs) => {
        if (!repairs.some(({ kind }) => kind === 'undelete')) return;
        await this.reviewManager.refreshAllHighlights();
        await invalidateCurrentItemQuery();
      },
      // Once per damaged note; the warning folds them into the one notice and
      // counts them off on it
      onDamage: (paths) => paths.forEach(() => warning.warn()),
      onTagRestored: (repairs) =>
        repairs.forEach(({ tag }) => tagNotices.warn(tag)),
    });
    this.register(() => repairer.dispose());

    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (!this.reviewManager) return;
        repairer.handleChange(file);
      })
    );
  }

  /** Watch for notes left without review data in `repo` (see `LeftoverWatch`). */
  private createLeftoverWatch(repo: SQLiteRepository): LeftoverWatch {
    return new LeftoverWatch({
      app: this.app,
      repo,
      managers: () => this.reviewManager,
      onResolved: () => queryClient.invalidateQueries({ queryKey: ['queue'] }),
      // A review tab restored in the background has no view until it is
      // shown, and has told the watch nothing yet
      isReviewOpen: () =>
        this.app.workspace
          .getLeavesOfType(ReviewView.viewType)
          .some((leaf) => leaf.view instanceof ReviewView),
    });
  }

  /**
   * Import notes as their frontmatter gains a trigger tag, and files as they
   * arrive in a watched folder. See {@link AutoImportWatcher}.
   *
   * `changed` is the one event every writer reaches: the editor, reading
   * mode's properties widget (which writes straight to the file), Sync, and
   * scripts and other plugins. `vault.on('create')` is no use here, since it
   * comes before the new note's frontmatter is read. Listened to whether the
   * setting is on or not: the watcher reads it on each change, so turning it
   * on needs no reload.
   */
  private watchAutoImports() {
    const watcher = new AutoImportWatcher({
      app: this.app,
      getConfig: () => ({
        enabled: this.settings.autoImportOnTag,
        triggerTags: this.settings.autoImportTags,
        priority: this.settings.defaultPriority,
        mode: this.settings.autoImportMode,
        onFolder: this.settings.autoImportOnFolder,
        folders: this.settings.autoImportFolders,
      }),
      importMany: (entries, { priority, mode }) =>
        this.reviewManager.importTaggedNotes(entries, { priority, mode }),
      hasRow: (id) => this.reviewManager.hasItemRow(id),
    });
    this.autoImportWatcher = watcher;
    this.register(watcher.start());
    this.register(this.onSettingsChange(() => watcher.configChanged()));
    this.autoImportWatcherMade.resolve(watcher);

    this.registerEvent(
      this.app.metadataCache.on('changed', (file, _data, cache) => {
        if (!this.reviewManager) return;
        this.autoImportWatcher?.consider(file, cache);
      })
    );

    // Arrivals in watched folders. Registered once the layout is ready, as
    // this is, so the `create` Obsidian raises for every file as the vault
    // loads isn't taken for one.
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!this.reviewManager) return;
        this.autoImportWatcher?.noteArrival(file);
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!this.reviewManager) return;
        this.autoImportWatcher?.noteArrival(file, oldPath);
      })
    );
    // So the files seen in watched folders are only those still there
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.autoImportWatcher?.noteDeletion(file);
      })
    );
  }

  /**
   * Point the database back at notes that moved while no rename handler was
   * listening: with Obsidian closed, or during startup before
   * {@link reviewManager} existed. See {@link scanForMovedNotes}.
   *
   * Obsidian is still indexing when the layout becomes ready, and a note that
   * moved has no cached frontmatter to be found by until it is re-indexed, so
   * the scan waits for the metadata cache to settle.
   */
  private followMovedNotes(repo: SQLiteRepository) {
    const controller = new AbortController();
    this.register(() => controller.abort());
    const { vault, metadataCache } = this.app;

    const scan = () => {
      void scanForMovedNotes({
        repo,
        vault,
        metadataCache,
        signal: controller.signal,
        log: (entries) => appendLog(vault.adapter, REBIND_LOG_TOPIC, entries),
      })
        .then(async (moved) => {
          if (moved.length === 0) return;
          // Obsidian saw none of these moves, so updated no links to them
          await this.reviewManager.followChildSources(moved);
          await this.reviewManager.claimMovedFiles(moved);
          // Highlights are cached by note path, and review may be showing one
          // of the notes that moved
          await this.reviewManager.refreshAllHighlights();
          await invalidateCurrentItemQuery();
        })
        .catch((error: unknown) => {
          console.error(
            'Incremental Reading - failed to follow moved notes:',
            error
          );
        })
        // Then notes that gained a trigger tag, and files that arrived in a
        // watched folder, while Obsidian was closed, once every row is where
        // its note is, so the import's checks by path see the vault as it is
        .then(async () => {
          const watcher = await this.autoImportWatcherMade.promise;
          if (controller.signal.aborted) return;
          await watcher.runCatchUpScan();
        })
        .catch((error: unknown) => {
          console.error(
            'Incremental Reading - failed to catch up on automatic imports:',
            error
          );
        })
        // Once every row is where its file is, whether or not following them
        // went well: paths that break links to their items are left as they
        // are, but the user hears of them
        .then(async () => {
          if (controller.signal.aborted) return;
          const paths = await this.reviewManager.itemPathsWithRefusedChars();
          const { warn, remember } = startupWarning(
            paths,
            this.data.warnedRefusedPaths
          );
          if (warn)
            Obsidian.notify(refusedPathsWarning(paths)!, { persist: true });
          if (remember) await this.rememberWarnedPaths(remember);
        })
        .catch((error: unknown) => {
          console.error(
            'Incremental Reading - failed to look for item paths that break links:',
            error
          );
        })
        // Last, once every row is where its note is: a note the scan just
        // pointed a row at is no leftover, nor one just imported by its tag.
        // Notes only, by the cache, read once it is clean.
        // TODO(0081): once the startup hold for Obsidian Sync lands, wait for
        // its settled signal here too. Until then, a note Sync brings down
        // before the database reads as a leftover; the notice only asks, and
        // `resolveLeftover` looks again before it acts.
        .then(async () => {
          if (controller.signal.aborted) return;
          await this.leftovers?.startupScan();
        })
        .catch((error: unknown) => {
          console.error(
            'Incremental Reading - failed to flag notes left without review data:',
            error
          );
        });
    };

    // `onCleanCache` runs its callback once nothing is left to parse and every
    // link has resolved. Obsidian presents the whole vault to the cache before
    // the layout is ready, so by now it cannot report clean early.
    if (typeof metadataCache.onCleanCache === 'function') {
      metadataCache.onCleanCache(scan);
      return;
    }
    // `onCleanCache` is undocumented, so fall back to the official event that
    // says the same thing. Scanning straight away instead would read a moved
    // note before its frontmatter was cached and quietly pass it over. The
    // trade is that `resolved` has to fire: on a vault indexed before the
    // plugin loaded it never does, and the scan waits for the next launch.
    const ref = metadataCache.on('resolved', () => {
      metadataCache.offref(ref);
      scan();
    });
    this.registerEvent(ref);
  }

  /**
   * Focus an existing unfocused review tab if one exists, or open review if
   * no such tab exists. If the review tab is already focused, toggle between
   * the home screen or item review.
   * @param initialItem
   * @param newLeaf where to open review when no review tab exists: a pane type
   * (`Keymap.isModEvent` hands one over for a modified click), `true` for a
   * new tab, or `false` for the tab the command was executed from. An open
   * review tab is reused whatever this says, since there is only ever one.
   */
  async learn(initialItem?: ReviewItem, newLeaf: PaneType | boolean = true) {
    const openReviewLeaf: WorkspaceLeaf | null = this.getOpenReviewLeaf();
    const alreadyActive = openReviewLeaf === this.getActiveReviewView()?.leaf;
    // A tab closed mid-review keeps its item; put it back before the view mounts
    // so review resumes there rather than at the top of the queue.
    const resumed = initialItem ? false : await this.resumeSession();
    const leaf =
      openReviewLeaf ??
      this.app.workspace.getLeaf(newLeaf === true ? 'tab' : newLeaf);

    // Everything the interface reads is settled before the view mounts:
    // `setViewState` runs `onOpen`, which renders against the store as it finds
    // it, and `resetSession` left `page` on 'home' when the last tab closed.
    // Choosing afterwards paints the queue table for a frame first.
    if (initialItem) {
      // An explicit item always lands in review, never on the home screen
      goToReviewPlace(store, initialItem.data.id);
    } else if (!openReviewLeaf) {
      // Only pick the landing page when instantiating a fresh view; an existing
      // view keeps its page (e.g. mid-review) regardless of skipHomeScreen.
      //
      // An item carried over from a closed tab is where the user already was,
      // so it opens on that item whatever the home-screen setting says: the
      // setting is about opening review with nothing in progress.
      const landOnItem = resumed || this.settings.skipHomeScreen;
      store.dispatch(setPage(landOnItem ? 'review' : 'home'));
    } else if (alreadyActive) {
      // review is open and focused, so toggle between home and item review
      // pages. Review from home is the top of the queue, as Begin Review is,
      // not the item the store kept while home was up.
      if (store.getState().page === 'home') goToReviewPlace(store, null);
      else store.dispatch(setPage('home'));
    }

    await leaf.setViewState({
      type: ReviewView.viewType,
      active: true,
    });

    if (initialItem) {
      // Kept for the file the view shows; the item itself is already in the
      // store, which is what stopped the mount above from resuming over it.
      if (!openReviewLeaf) {
        (leaf.view as ReviewView).initialItem = initialItem;
      }
    } else if (openReviewLeaf) {
      // The view was already open, so invalidate the query to trigger a refetch.
      // This ensures the new initial item is displayed immediately
      await invalidateCurrentItemQuery();
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Offer to import a note as an article, or to un-import one that is,
   * wherever Obsidian raises a file menu.
   *
   * Skipped in the review tab, whose menu {@link ReviewView.addFileMenuItems}
   * raises: the note showing there is already an item, so the entries would
   * offer to import what the user is in the middle of reviewing. Keyed on the
   * leaf's view rather than on the menu's `source`, because a plain note's own
   * ⋮ and tab-header menus report those same sources and do want the entries.
   */
  addIRMenuItems(
    menu: Menu,
    abstractFile: TAbstractFile,
    leaf?: WorkspaceLeaf | null
  ): void {
    if (leaf?.view instanceof ReviewView) return;

    if (abstractFile instanceof TFolder) {
      if (!this.reviewManager) return;
      menu.addSections(['incremental-reading']);
      menu.addItem((item) => {
        item
          .setTitle('Import from folder…')
          .setIcon(PLUGIN_ICON)
          .setSection('incremental-reading')
          .onClick(() => {
            this.importFromFolder(abstractFile);
          });
      });
      return;
    }

    const file = this.app.vault.getFileByPath(abstractFile.path);
    if (!file || !this.reviewManager) return;

    menu.addSections(['incremental-reading']);
    // Checked by type alone: a file the plugin can't turn into an article
    // gets no import entry at all, rather than one that fails on click.
    const importable = isImportable(file);
    if (importable) {
      menu.addItem((item) => {
        item
          .setTitle('Import article')
          .setIcon(PLUGIN_ICON)
          .setSection('incremental-reading')
          .onClick(async () => {
            await this.importArticle(file);
          });
      });
    }

    // Menus are built synchronously, so the database cannot be asked here. An
    // `ir-id` is the cached mark of an item's note; `goToContext` checks the
    // row and says so when there is none, as for a copy of an item's note.
    if (
      typeof Obsidian.getFrontMatter(file, this.app)?.['ir-id'] === 'string'
    ) {
      menu.addItem((item) => {
        item
          .setTitle('Go to context')
          .setIcon('lucide-locate')
          .setSection('incremental-reading')
          .onClick(async (evt) => {
            await this.actions.goToContext(file, Keymap.isModEvent(evt));
          });
      });
    }
    // Asked of the database while the menu is built, which sql.js answers at
    // once. A note's or PDF's own ⋮ "More options" menu raises this same
    // `file-menu`, with source `more-options`, so the entry shows there too
    // (undocumented, read from obsidian.asar 1.13: `EditableFileView`'s
    // `onPaneMenu` raises it, and the markdown and PDF views extend that).
    if (this.reviewManager.articleIdAt(file) !== null) {
      menu.addItem((item) => {
        item
          .setTitle('Un-import article')
          .setIcon('lucide-file-x')
          .setSection('incremental-reading')
          .onClick(() => {
            void unimportArticle(this, file);
          });
      });
    }
    if (!importable || !this.settings.showAdvancedImportMenuItems) {
      return;
    }

    if (isCopyImportable(file)) {
      menu.addItem((item) => {
        item
          .setTitle('Import a copy')
          .setIcon(PLUGIN_ICON)
          .setSection('incremental-reading')
          .onClick(async () => {
            await this.importArticle(file, {
              copyOnImport: true,
              showImportDialog: false,
            });
          });
      });
    }

    menu.addItem((item) => {
      item
        .setTitle('Import in place')
        .setIcon(PLUGIN_ICON)
        .setSection('incremental-reading')
        .onClick(async () => {
          await this.importArticle(file, {
            copyOnImport: false,
            showImportDialog: false,
          });
        });
    });

    menu.addItem((item) => {
      item
        .setTitle('Open import dialog...')
        .setIcon(PLUGIN_ICON)
        .setSection('incremental-reading')
        .onClick(async () => {
          await this.importArticle(file, { showImportDialog: true });
        });
    });

    menu.addItem((item) => {
      item
        .setTitle('Quick import')
        .setIcon(PLUGIN_ICON)
        .setSection('incremental-reading')
        .onClick(async () => {
          await this.importArticle(file, { showImportDialog: false });
        });
    });
  }

  /**
   * Add the import to the menu of `leaf` when it holds a web viewer this
   * plugin can read pages from (see {@link asWebViewer}).
   */
  addWebViewerMenuItems(menu: Menu, leaf: WorkspaceLeaf): void {
    if (!this.reviewManager) return;
    const viewer = asWebViewer(leaf.view);
    if (!viewer) return;

    menu.addSections(['incremental-reading']);
    menu.addItem((item) => {
      item
        .setTitle('Import article')
        .setIcon(PLUGIN_ICON)
        .setSection('incremental-reading')
        .onClick(async () => {
          await this.importWebPage(viewer);
        });
    });
  }

  /**
   * The entries for a menu on several files and folders at once: **Import N
   * items…**, N counting the selection with what a selected folder covers
   * left out, when anything in it could import. Not in the review tab, and
   * not before the review manager is up, as {@link addIRMenuItems}.
   */
  addSelectionMenuItems(
    menu: Menu,
    files: readonly TAbstractFile[],
    leaf?: WorkspaceLeaf | null
  ): void {
    if (leaf?.view instanceof ReviewView || !this.reviewManager) return;
    const roots = selectionRoots(files);
    if (!selectionMayImport(roots)) return;
    menu.addSections(['incremental-reading']);
    menu.addItem((item) => {
      item
        .setTitle(`Import ${itemCount(roots.length)}…`)
        .setIcon(PLUGIN_ICON)
        .setSection('incremental-reading')
        .onClick(() => {
          this.importSelection(files);
        });
    });
  }

  /**
   * Offer what `files`, a Files-view selection, holds for import in the bulk
   * import dialog: each selected file, and the files in each selected folder
   * (and, with "Include subfolders", under it), in the explorer's order as
   * the dialog opens. See `selectionSource`.
   */
  importSelection(files: readonly TAbstractFile[]): BulkImportModal {
    const { reviewManager } = this;
    const modal = new BulkImportModal(this, {
      source: selectionSource(
        files,
        {
          app: this.app,
          isItemAtPath: (file) => reviewManager.isItemFileAt(file, file.path),
        },
        explorerComparator(readExplorerSortOrder(this.app.workspace))
      ),
      mode: 'import',
    });
    modal.open();
    return modal;
  }

  /**
   * Offer the files directly in `folder` for import, in the bulk import
   * dialog, and with its "Include subfolders" toggle those under it too. It
   * always opens, whatever `showImportDialog` says: the user picks the files
   * there. They are listed in the file explorer's order as the
   * dialog opens; changing the explorer's order afterwards leaves the list be.
   */
  importFromFolder(folder: TFolder): BulkImportModal {
    const { reviewManager } = this;
    const modal = new BulkImportModal(this, {
      source: folderSource(
        folder,
        {
          app: this.app,
          isItemAtPath: (file) => reviewManager.isItemFileAt(file, file.path),
        },
        explorerComparator(readExplorerSortOrder(this.app.workspace))
      ),
      mode: 'import',
    });
    modal.open();
    return modal;
  }

  async importArticle(
    file: TFile,
    opts?: {
      showImportDialog?: boolean;
      copyOnImport?: boolean;
    }
  ) {
    if (!checkImportable(file)) return;

    const merged = { ...this.settings, ...(opts ?? {}) };
    if (merged.showImportDialog) {
      new ImportModal(this, {
        kind: 'file',
        file,
        defaultCopyOnImport: merged.copyOnImport,
      }).open();
    } else {
      await this.reviewManager.importArticle(
        file,
        this.settings.defaultPriority,
        null,
        merged.copyOnImport
      );
    }
  }

  /**
   * The commands that make a snippet or a card.
   *
   * In the review tab they do what the action bar's buttons do, through the
   * same {@link Actions.extract}: selected text becomes the snippet or card at
   * once, and with nothing selected review enters selection mode instead. Once
   * in the mode, the command for its kind confirms it and the other is refused.
   * In a note, which has no selection mode, they make it at once either way.
   * So they do in a PDF open in Obsidian's own tab, through the PDF's viewer.
   * Both are off in a note in reading mode.
   */
  private addExtractCommands() {
    // The commands follow the selection in PDF tabs, which outlive the plugin
    this.register(stopPdfTabSelections);
    /**
     * The commands on a PDF article, which has no editor for them to find:
     * in review, handed to the button's path, which selects in the PDF's
     * viewer instead; in Obsidian's own PDF tab, to the tab's. Whether that
     * applied, and so whether the command is available.
     */
    const extractFromPdf = (kind: 'snippet' | 'card', checking: boolean) => {
      const view = this.getActiveReviewView();
      if (!view) return extractFromPdfTab(kind, checking);
      const file = view.currentItemFile();
      if (!file || getMimeType(file) !== 'application/pdf') return false;
      if (!checking) void this.actions.extract(kind, view);
      return true;
    };
    /**
     * {@link extractFromPdf} in Obsidian's own PDF tab, on any PDF it has
     * open: one that is no article gives a parentless snippet or card.
     */
    const extractFromPdfTab = (kind: 'snippet' | 'card', checking: boolean) => {
      // Undocumented: `Workspace.getActiveFileView` (typed by obsidian-typings)
      const view = this.app.workspace.getActiveFileView();
      if (!view?.file || !isPdfView(view)) return false;
      if (!checking) void this.actions.extractFromPdfTab(kind, view);
      return true;
    };
    /**
     * Whether `view` is a note in reading mode, where both commands are off.
     * Its editor is still there, hidden behind the rendered note, and keeps
     * whatever it had selected before the switch; it never sees what the user
     * selects on screen. A snippet or card made through it would be of text
     * the user can't see selected, or refused for want of a selection that is
     * plainly there. Obsidian's own editor commands are off there the same
     * way (undocumented: its `editorCallback` wrapper skips a view whose
     * `getMode()` is `'preview'`, as of 1.13.7). `currentMode` and
     * `previewMode` are public API.
     */
    const inReadingMode = (view: MarkdownView | ReviewView) =>
      view instanceof MarkdownView && view.currentMode === view.previewMode;
    /** The one check both commands make, so they can't drift apart. */
    const extractCallback =
      (kind: 'snippet' | 'card') =>
      (checking: boolean): boolean | void => {
        if (!this.reviewManager) return false;
        if (extractFromPdf(kind, checking)) return true;
        if (!this.app.workspace.activeEditor?.editor) return false;

        const view =
          this.getActiveReviewView() ??
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || inReadingMode(view)) return false;
        if (checking) return true;

        if (view instanceof ReviewView) void this.actions.extract(kind, view);
        else if (kind === 'snippet') void this.actions.createSnippet();
        else void this.actions.createCard();
      };

    this.addCommand({
      id: 'extract-selection',
      name: 'Extract selection to snippet',
      // hotkeys: [{ key: 'X', modifiers: ['Alt'] }],
      checkCallback: extractCallback('snippet'),
    });

    this.addCommand({
      id: 'create-card',
      name: 'Create spaced repetition card',
      // hotkeys: [{ key: 'Z', modifiers: ['Alt'] }],
      checkCallback: extractCallback('card'),
    });
  }

  /** The import command every user gets; the rest are advanced. */
  private addImportCommands() {
    this.addImportCommand('import-article', 'Import article');
  }

  /**
   * Register a command that imports the active tab's file with `opts`.
   *
   * Unavailable until the plugin has loaded, in the review tab (whose note is
   * already an item), with no file open, and while the open file is of a type
   * that can't be imported (or, for a copy, copied), so the palette never lists
   * an import that would only be refused.
   */
  private addImportCommand(
    id: string,
    name: string,
    opts?: Parameters<IncrementalReadingPlugin['importArticle']>[1]
  ) {
    this.addCommand({
      id,
      name,
      checkCallback: (checking: boolean) => {
        if (!this.reviewManager) return false;
        if (this.getActiveReviewView()) return false;

        // The basic import also takes the page open in the web viewer
        if (!opts) {
          const viewer = this.getActiveWebViewer();
          if (viewer) {
            if (!checking) void this.importWebPage(viewer);
            return true;
          }
        }

        const file = this.app.workspace.getActiveFileView()?.file;
        if (!file || !isImportable(file)) return false;
        if (opts?.copyOnImport && !isCopyImportable(file)) return false;

        if (checking) return true;
        void this.importArticle(file, opts);
      },
    });
  }

  /**
   * The web viewer in the active tab, when it is one this plugin can read
   * pages from (see {@link asWebViewer}), or null.
   */
  private getActiveWebViewer(): WebViewerView | null {
    // The web viewer's view is an ItemView (undocumented core plugin)
    return asWebViewer(this.app.workspace.getActiveViewOfType(ItemView));
  }

  /**
   * Import the page `viewer` shows as an article, in a note made for it in
   * the articles folder (see `ArticleManager.importWebPage`): through the
   * import dialog when the "Show import dialog" setting is on, else at the
   * default priority. The page is read first, so a page that can't be read
   * opens no dialog. Nothing more is said when Obsidian reads nothing from
   * the page: it has said why itself. Asked again while the page in `viewer`
   * is being imported, or while its dialog is open, it does nothing.
   */
  async importWebPage(viewer: WebViewerView) {
    if (importingWebViewers.has(viewer)) return;
    importingWebViewers.add(viewer);
    try {
      let page: WebPage | null;
      try {
        page = await readWebPage(viewer);
      } catch (error) {
        console.error(error);
        Obsidian.notify("Couldn't read the page in the web viewer");
        return;
      }
      if (!page) return;
      if (this.settings.showImportDialog) {
        const dialog = new ImportModal(this, { kind: 'web', page });
        dialog.open();
        await dialog.closed;
      } else {
        await this.reviewManager.importWebPage(
          page,
          this.settings.defaultPriority,
          null
        );
      }
    } finally {
      importingWebViewers.delete(viewer);
    }
  }

  /**
   * Re-apply the "Show review tab title bar" setting to every review tab open.
   * A leaf whose view Obsidian has not built yet holds a stand-in view rather
   * than a ReviewView; it is passed over and picks the setting up when it is
   * built, in ReviewView's constructor.
   */
  syncReviewTitleBars() {
    for (const leaf of this.app.workspace.getLeavesOfType(
      ReviewView.viewType
    )) {
      if (leaf.view instanceof ReviewView) leaf.view.syncTitleBar();
    }
  }

  toggleAdvancedCommands(enable: boolean) {
    if (enable) {
      this.addImportCommand('import-article-copy', 'Import article as copy', {
        copyOnImport: true,
        showImportDialog: false,
      });
      this.addImportCommand(
        'import-article-in-place',
        'Import article in place',
        { copyOnImport: false, showImportDialog: false }
      );
      this.addImportCommand('open-import-dialog', 'Open import dialog...', {
        showImportDialog: true,
      });
      this.addImportCommand('quick-import', 'Quick import', {
        showImportDialog: false,
      });
    } else {
      this.removeCommand('import-article-copy');
      this.removeCommand('import-article-in-place');
      this.removeCommand('open-import-dialog');
      this.removeCommand('quick-import');
    }
  }

  private configureNavbarPosition() {
    // `app.mobileNavbar` and its `containerEl` are undocumented Obsidian
    // internals, read here for the navbar's element.
    if (!this.app.mobileNavbar || !('containerEl' in this.app.mobileNavbar)) {
      throw new Error(`Failed to find navbar container element.`);
    }
    // TODO: remove 'as' assertion once mobileNavbar type is added
    const navbarBox = this.app.mobileNavbar.containerEl as
      | HTMLElement
      | undefined;
    if (navbarBox) this.register(trackNavbarFootprint(navbarBox));
  }

  /**
   * Warn, once per cause, when Obsidian Sync, set up for this vault, leaves
   * the database file out: "Sync all other types" off, as it is by default,
   * or an excluded folder over the data folder. Sync reads its settings after
   * the layout is ready, so this waits for them.
   */
  private async verifySyncSettings(): Promise<void> {
    const unloaded = new AbortController();
    this.register(() => unloaded.abort());
    const exclusions = await findSyncExclusions({
      getSync: () => getSyncPlugin(this.app),
      path: DATABASE_FILE_PATH,
      signal: unloaded.signal,
    });
    for (const exclusion of exclusions) {
      Obsidian.notify(syncExclusionMessage(exclusion), { persist: true });
    }
  }
}
