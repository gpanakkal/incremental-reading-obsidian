import type { WorkspaceLeaf, TFile } from 'obsidian';
import { MarkdownView, Notice, Plugin } from 'obsidian';
// @ts-ignore - SQL schema imported via custom esbuild plugin
import databaseSchema from './db/schema.sql';
import { DATABASE_FILE_PATH, PLACEHOLDER_PLUGIN_ICON } from './lib/constants';
import { createIRExtensions } from './lib/extensions';
import type { ExtractedMarkdownEditor } from './lib/obsidian-editor';
import { getEditorClass } from './lib/obsidian-editor';
import {
  invalidateCacheOnMatch,
  invalidateCurrentItemQuery,
} from './lib/query-client';
import { SQLJSRepository } from './lib/repository/SQLJSRepository';
import ReviewManager from './lib/ReviewManager';
import type { IRPluginSettings } from './lib/settings';
import { DEFAULT_SETTINGS, IRSettingTab } from './lib/settings';
import { setCurrentItemId, store } from './lib/store';
import type { ReviewItem, SQLiteRepository } from './lib/types';
import { PriorityModal } from './views/PriorityModal';
import ReviewView from './views/ReviewView';
import { initReviewCommands } from './lib/review-commands';

export default class IncrementalReadingPlugin extends Plugin {
  settings: IRPluginSettings;
  reviewManager: ReviewManager;
  store: typeof store;

  MarkdownEditor: typeof ExtractedMarkdownEditor;

  async onload() {
    await this.loadSettings();
    this.MarkdownEditor = getEditorClass(this.app);

    // This creates an icon in the left ribbon.
    // TODO: replace the placeholder
    const ribbonIconEl = this.addRibbonIcon(
      PLACEHOLDER_PLUGIN_ICON,
      'Incremental reading',
      async (_evt: MouseEvent) => {
        // Called when the user clicks the icon.
        await this.learn();
      }
    );
    // Perform additional things with the ribbon
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

        const reviewView = this.getActiveReviewView();
        if (checking) return true;

        if (reviewView) {
          void this.reviewManager.createSnippet(editor, reviewView);
        }

        const markdownView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          void this.reviewManager.createSnippet(editor, markdownView);
        }
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

    const importArticle = async (file: TFile) => {
      if (this.settings.showImportDialog) {
        new PriorityModal(this, file).open();
      } else {
        await this.reviewManager.importArticle(
          file,
          this.settings.defaultPriority
        );
      }
    };

    this.addCommand({
      id: 'import-article',
      name: 'Import article',
      checkCallback: (checking: boolean) => {
        if (!this.reviewManager) return false;

        const reviewView = this.getActiveReviewView();
        if (reviewView) return false;

        const fileView = this.app.workspace.getActiveFileView();
        if (!fileView?.file) return false;

        if (checking) return true;
        void importArticle(fileView.file);
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
          .then((article) => void this.learn(article));
      },
    });

    this.addCommand({
      id: 'learn',
      name: 'Learn',
      callback: async () => await this.learn(),
    });

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
          menu.addItem((item) => {
            item
              .setTitle('Import article')
              .setIcon(PLACEHOLDER_PLUGIN_ICON)
              .onClick(async () => {
                await importArticle(file);
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

    this.addSettingTab(new IRSettingTab(this.app, this));

    // // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
    // // Using this function will automatically remove the event listener when this plugin is disabled.
    // this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
    // 	console.log('click', evt);
    // });

    // // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
    // this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

    this.app.workspace.onLayoutReady(async () => {
      // expensive startup operations should go here
      try {
        if (!this.manifest.dir) {
          throw new Error('manifest.dir is undefined');
        }

        if (this.app.isMobile) {
          this.configureNavbarPosition();
        }

        this.store = store;
        await this.initReviewManager();
        this.registerView(
          ReviewView.viewType,
          (leaf) => new ReviewView(leaf, this, this.reviewManager)
        );

        // Register global CodeMirror extensions for IR notes
        this.registerEditorExtension(createIRExtensions(this));
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

  getActiveReviewView() {
    return this.app.workspace.getActiveViewOfType(ReviewView);
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
    this.reviewManager = new ReviewManager(this.app, repo);
  }

  async learn(initialItem?: ReviewItem) {
    let leaf: WorkspaceLeaf | null = null;
    const leaves = this.app.workspace.getLeavesOfType(ReviewView.viewType);
    const viewAlreadyOpen = leaves.length > 0;

    if (viewAlreadyOpen) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: ReviewView.viewType, active: true });
    }

    // Set the initial item on the view if provided
    if (initialItem) {
      if (!viewAlreadyOpen) {
        const view = leaf.view as ReviewView;
        view.initialItem = initialItem;
      }
      store.dispatch(setCurrentItemId(initialItem.data.id));
    }

    await this.app.workspace.revealLeaf(leaf);

    // If the view was already open, invalidate the query to trigger a refetch
    // This ensures the new initial item is displayed immediately
    if (viewAlreadyOpen && !initialItem) {
      await invalidateCurrentItemQuery();
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
}
