import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Notice, Plugin } from 'obsidian';
import type { SyncPluginInstance } from 'obsidian-typings';
// @ts-ignore - SQL schema imported via custom esbuild plugin
import databaseSchema from './db/schema.sql';
import { Actions } from './lib/Actions';
import { DATABASE_FILE_PATH, PLACEHOLDER_PLUGIN_ICON } from './lib/constants';
import { createIRExtensions } from './lib/extensions';
import { registerReadingModeActionBar } from './lib/extensions/ReadingModeActionBar';
import {
  registerHighlightRefreshListener,
  registerSnippetHighlightPostProcessor,
} from './lib/extensions/SnippetHighlightPostProcessor';
import ReviewManager from './lib/items/ReviewManager';
import type { ExtractedMarkdownEditor } from './lib/obsidian-editor';
import { getEditorClass } from './lib/obsidian-editor';
import {
  invalidateCacheOnMatch,
  invalidateCurrentItemQuery,
  resetCurrentOnMatch,
} from './lib/query-client';
import { SQLJSRepository } from './lib/repository/SQLJSRepository';
import { initReviewCommands } from './lib/review-commands';
import type { IRPluginSettings } from './lib/settings';
import { DEFAULT_SETTINGS, IRSettingTab } from './lib/settings';
import { setCurrentItemId, setPage, store } from './lib/store';
import type { ReviewItem, SQLiteRepository } from './lib/types';
import { ImportModal } from './views/ImportModal';
import ReviewView from './views/ReviewView';

export default class IncrementalReadingPlugin extends Plugin {
  settings!: IRPluginSettings;
  reviewManager!: ReviewManager;
  store!: typeof store;
  actions!: Actions;

  MarkdownEditor!: typeof ExtractedMarkdownEditor;

  async onload() {
    await this.loadSettings();
    this.MarkdownEditor = getEditorClass(this.app);

    const ribbonIconEl = this.addRibbonIcon(
      PLACEHOLDER_PLUGIN_ICON,
      'Incremental reading',
      async (_evt: MouseEvent) => {
        await this.learn();
      }
    );

    ribbonIconEl.addClass('incremental-reading-ribbon');

    // TODO: show counts of items in queue?
    // // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
    // const statusBarItemEl = this.addStatusBarItem();
    // statusBarItemEl.setText('Status Bar Text');

    this.addCommand({
      id: 'extract-selection',
      name: 'Extract selection to snippet',
      // hotkeys: [{ key: 'X', modifiers: ['Alt'] }],
      checkCallback: (checking) => {
        if (!this.reviewManager) return false;

        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) return false;

        const view =
          this.getActiveReviewView() ??
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (
          view.getViewType() === 'markdown' &&
          view instanceof MarkdownView &&
          view.currentMode === view.previewMode
        ) {
          // disable in reading mode
          return false;
        }
        if (checking) return true;

        void this.reviewManager.createSnippet(editor, view);
      },
    });

    this.addCommand({
      id: 'create-card',
      name: 'Create spaced repetition card',
      // hotkeys: [{ key: 'Z', modifiers: ['Alt'] }],
      checkCallback: (checking) => {
        if (!this.reviewManager) return false;

        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) return false;
        if (checking) return true;

        const reviewView = this.getActiveReviewView();
        if (reviewView) {
          void this.reviewManager.createCard(editor, reviewView);
        }

        const markdownView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          void this.reviewManager.createCard(editor, markdownView);
        }
      },
    });

    this.addCommand({
      id: 'import-article',
      name: 'Import article',
      checkCallback: (checking: boolean) => {
        if (!this.reviewManager) return false;

        const activeReviewView = this.getActiveReviewView();
        if (activeReviewView) return false;

        const fileView = this.app.workspace.getActiveFileView();
        if (!fileView?.file) return false;

        if (checking) return true;
        void this.importArticle(fileView.file);
      },
    });

    this.addCommand({
      id: 'create-empty-article',
      name: 'Create empty article',
      checkCallback: (checking: boolean) => {
        if (!this.reviewManager) return false;

        if (checking) return true;
        void this.reviewManager
          .createEmptyArticle(this.settings.defaultPriority)
          .then((article) => void this.learn(article ?? undefined));
      },
    });

    this.addCommand({
      id: 'learn',
      name: 'Learn',
      callback: async () => await this.learn(),
    });

    if (this.settings.showAdvancedImportCommands) {
      this.toggleAdvancedCommands(true);
    }

    this.addCommand({
      // TODO: remove after done testing
      id: 'list-entries',
      name: '(dev) list articles, snippets and cards',
      callback: async () => {
        if (!this.reviewManager) {
          new Notice(`Plugin still loading`);
          return;
        }
        await this.reviewManager._logItems();
      },
    });

    initReviewCommands(this);

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, abstractFile) => {
        const file = this.app.vault.getFileByPath(abstractFile.path);
        if (file && this.reviewManager) {
          menu.addSections(['incremental-reading']);
          menu.addItem((item) => {
            item
              .setTitle('Import article')
              .setIcon(PLACEHOLDER_PLUGIN_ICON)
              .setSection('incremental-reading')
              .onClick(async () => {
                await this.importArticle(file);
              });
          });

          if (!this.settings.showAdvancedImportMenuItems) {
            return;
          }

          menu.addItem((item) => {
            item
              .setTitle('Import a copy')
              .setIcon(PLACEHOLDER_PLUGIN_ICON)
              .setSection('incremental-reading')
              .onClick(async () => {
                void this.importArticle(file, { copyOnImport: true });
              });
          });

          menu.addItem((item) => {
            item
              .setTitle('Import in place')
              .setIcon(PLACEHOLDER_PLUGIN_ICON)
              .setSection('incremental-reading')
              .onClick(async () => {
                void this.importArticle(file, { copyOnImport: false });
              });
          });

          menu.addItem((item) => {
            item
              .setTitle('Open import dialog...')
              .setIcon(PLACEHOLDER_PLUGIN_ICON)
              .setSection('incremental-reading')
              .onClick(async () => {
                void this.importArticle(file, { showImportDialog: true });
              });
          });

          menu.addItem((item) => {
            item
              .setTitle('Quick import')
              .setIcon(PLACEHOLDER_PLUGIN_ICON)
              .setSection('incremental-reading')
              .onClick(async () => {
                void this.importArticle(file, { showImportDialog: false });
              });
          });
        } else {
          // TODO: entire folder imports
          // const folder = this.app.vault.getFolderByPath(abstractFile.path);
        }
      })
    );

    // Invalidate review item cache when the current item's file is modified externally
    this.registerEvent(
      this.app.vault.on(
        'modify',
        (file) => void invalidateCacheOnMatch(file, this.reviewManager)
      )
    );

    // listen for file renames to update references in db
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!this.reviewManager) {
          // console.log('Review manager not ready; returning');
          return;
        }
        void this.reviewManager
          .handleExternalRename(file, oldPath)
          .then(() => invalidateCacheOnMatch(file, this.reviewManager));
      })
    );

    // listen for file deletions, mark items deleted, and go to next item if
    // the current item was deleted
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!this.reviewManager) {
          // console.log('Review manager not ready; returning');
          return;
        }
        void this.reviewManager
          .handleDeletion(file)
          .then(() => resetCurrentOnMatch(file, this.reviewManager));
      })
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

        if (!this.verifySyncSettings) {
          new Notice(
            `Incremental reading: please enable "sync all other types"` +
              ` before using the plugin`,
            0
          );
        }

        if (this.app.isMobile) {
          this.configureNavbarPosition();
        }

        this.store = store;
        await this.initReviewManager();
        this.actions = new Actions(this);
        this.registerView(
          ReviewView.viewType,
          (leaf) => new ReviewView(leaf, this, this.reviewManager)
        );

        // Register global CodeMirror extensions for IR notes
        this.registerEditorExtension(createIRExtensions(this));

        // Register post-processor for reading mode snippet highlights
        registerSnippetHighlightPostProcessor(this);
        registerHighlightRefreshListener(this);

        // Register action bar for reading mode standalone notes
        registerReadingModeActionBar(this);

        // listen for file creations and handle, especially restored item notes
        this.registerEvent(
          this.app.vault.on('create', (file) => {
            if (!this.reviewManager) {
              // console.log('Review manager not ready; returning');
              return;
            }
            void this.reviewManager
              .handleCreation(file)
              .then(() => invalidateCacheOnMatch(file, this.reviewManager));
          })
        );

        // Delegated click handler for highlights in reading mode.
        // The CM extension's eventHandlers.click covers edit mode;
        // this covers reading mode rendered HTML.
        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
          const target = evt.target as HTMLElement;
          const highlight = target.closest('.ir-snippet-highlight');
          if (!highlight) return;
          const snippetRef = highlight.getAttribute('data-snippet-ref');
          if (!snippetRef) return;
          // Skip if inside a CM editor — the CM extension handles that
          if (target.closest('.cm-editor')) return;
          evt.preventDefault();
          evt.stopPropagation();
          void this.app.workspace.openLinkText(snippetRef, '');
        });
      } catch (error) {
        console.error(error);
        new Notice(
          `Failed to initialize plugin. See the console for details.`,
          0
        );
        this.unload();
      }
    });
  }

  onunload() {}

  async loadSettings() {
    const saved = (await this.loadData()) as object;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  getActiveReviewView(): ReviewView | null {
    return this.app.workspace.getActiveViewOfType(ReviewView);
  }

  getOpenReviewLeaf(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(ReviewView.viewType);
    return leaves[0] ?? null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async initReviewManager() {
    const repo: SQLiteRepository = await SQLJSRepository.start({
      plugin: this,
      dbFilePath: DATABASE_FILE_PATH,
      schema: databaseSchema as string,
      onMigrationFailure: (error) => {
        console.error(
          'Incremental Reading - Migration verification failed:',
          error.errors
        );
        new Notice(
          `Incremental reading: database migration failed. ` +
            `Check the console for details.`,
          0
        );
        this.unload();
      },
      onReloadFromDisk: async () => invalidateCurrentItemQuery(),
    });
    // listen for sync updates to the database and re-read the file
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        void repo.handleFileChange(file);
      })
    );
    this.reviewManager = new ReviewManager(this, repo);
  }

  async learn(initialItem?: ReviewItem, newLeaf: boolean = true) {
    const openReviewLeaf: WorkspaceLeaf | null = this.getOpenReviewLeaf();
    const leaf =
      openReviewLeaf ?? this.app.workspace.getLeaf(newLeaf ? 'tab' : false);

    await leaf.setViewState({
      type: ReviewView.viewType,
      active: true,
    });
    // Only pick the landing page when instantiating a fresh view; an existing
    // view keeps its page (e.g. mid-review) regardless of skipHomeScreen.
    if (!openReviewLeaf) {
      store.dispatch(setPage(this.settings.skipHomeScreen ? 'review' : 'home'));
    }
    // Set the initial item on the view if provided
    if (initialItem) {
      if (!openReviewLeaf) {
        (leaf.view as ReviewView).initialItem = initialItem;
      }
      store.dispatch(setCurrentItemId(initialItem.data.id));
      // An explicit item always lands in review, never on the home screen
      store.dispatch(setPage('review'));
    } else {
      // If the view was already open, invalidate the query to trigger a refetch
      // This ensures the new initial item is displayed immediately
      if (openReviewLeaf) await invalidateCurrentItemQuery();
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  async importArticle(
    file: TFile,
    opts?: {
      showImportDialog?: boolean;
      copyOnImport?: boolean;
      reviewOnImport?: boolean;
    }
  ) {
    const merged = { ...this.settings, ...(opts ?? {}) };
    if (merged.showImportDialog) {
      new ImportModal(this, file, merged.copyOnImport).open();
    } else {
      const article = await this.reviewManager.importArticle(
        file,
        this.settings.defaultPriority,
        null,
        merged.copyOnImport
      );
      if (article && merged.reviewOnImport) {
        await this.learn(article);
      }
    }
  }

  toggleAdvancedCommands(enable: boolean) {
    if (enable) {
      this.addCommand({
        id: 'import-article-copy',
        name: 'Import article as copy',
        checkCallback: (checking: boolean) => {
          if (!this.reviewManager) return false;

          const activeReviewView = this.getActiveReviewView();
          if (activeReviewView) return false;

          const fileView = this.app.workspace.getActiveFileView();
          if (!fileView?.file) return false;

          if (checking) return true;
          void this.importArticle(fileView.file, { copyOnImport: true });
        },
      });

      this.addCommand({
        id: 'import-article-in-place',
        name: 'Import article in place',
        checkCallback: (checking: boolean) => {
          if (!this.reviewManager) return false;

          const activeReviewView = this.getActiveReviewView();
          if (activeReviewView) return false;

          const fileView = this.app.workspace.getActiveFileView();
          if (!fileView?.file) return false;

          if (checking) return true;
          void this.importArticle(fileView.file, { copyOnImport: false });
        },
      });

      this.addCommand({
        id: 'open-import-dialog',
        name: 'Open import dialog...',
        checkCallback: (checking: boolean) => {
          if (!this.reviewManager) return false;

          const activeReviewView = this.getActiveReviewView();
          if (activeReviewView) return false;

          const fileView = this.app.workspace.getActiveFileView();
          if (!fileView?.file) return false;

          if (checking) return true;
          void this.importArticle(fileView.file, { showImportDialog: true });
        },
      });

      this.addCommand({
        id: 'quick-import',
        name: 'Quick import',
        checkCallback: (checking: boolean) => {
          if (!this.reviewManager) return false;

          const activeReviewView = this.getActiveReviewView();
          if (activeReviewView) return false;

          const fileView = this.app.workspace.getActiveFileView();
          if (!fileView?.file) return false;

          if (checking) return true;
          void this.importArticle(fileView.file, { showImportDialog: false });
        },
      });
    } else {
      this.removeCommand('import-article-copy');
      this.removeCommand('import-article-in-place');
      this.removeCommand('open-import-dialog');
      this.removeCommand('quick-import');
    }
  }

  private configureNavbarPosition() {
    if (!this.app.mobileNavbar || !('containerEl' in this.app.mobileNavbar)) {
      throw new Error(`Failed to find navbar container element.`);
    }
    // TODO: remove 'as' assertion once mobileNavbar type is added
    const navbarBox = this.app.mobileNavbar.containerEl as
      | HTMLElement
      | undefined;
    if (navbarBox) {
      const setNavbarHeightProp = (height?: number) => {
        let calculatedHeight: number =
          height ?? navbarBox.getBoundingClientRect().height;
        const marginBottom =
          parseFloat(getComputedStyle(navbarBox).marginBottom) || 0;
        calculatedHeight += marginBottom;

        document.body.style.setProperty(
          '--ir-mobile-toolbar-height',
          `${calculatedHeight}px`
        );
      };

      const observer = new ResizeObserver(() => setNavbarHeightProp());

      observer.observe(navbarBox);
      setNavbarHeightProp();
      this.register(function cleanupNavbarObserver() {
        observer.disconnect();
        document.body.style.removeProperty('--ir-mobile-toolbar-height');
      });
    }
  }

  private verifySyncSettings(app: App): boolean {
    const syncPlugin = app.internalPlugins.getEnabledPluginById('sync');
    if (!syncPlugin) return true;
    const syncAllOtherTypesEnabled = (
      syncPlugin as SyncPluginInstance & { allowTypes: Set<string> }
    ).allowTypes.has('unsupported');

    return syncAllOtherTypesEnabled;
  }
}
