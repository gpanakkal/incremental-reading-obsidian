import type { TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import {
  DATABASE_FILE_PATH,
  ERROR_NOTICE_DURATION_MS,
  PLACEHOLDER_PLUGIN_ICON,
} from './lib/constants';
import { SQLiteRepository } from './lib/repository';
// @ts-ignore - SQL schema imported via custom esbuild plugin
import databaseSchema from './db/schema.sql';
import { createIRExtensions } from './lib/extensions';
import { queryClient } from './lib/queryClient';
import ReviewManager from './lib/ReviewManager';
import { setReviewViewSaving, store } from './lib/store';
import type { IRPluginSettings } from './lib/settings';
import { DEFAULT_SETTINGS, IRSettingTab } from './lib/settings';
import type { ReviewItem } from './lib/types';
import { getEditorClass } from './lib/utils';
import { PriorityModal } from './views/PriorityModal';
import { QueryModal } from './views/QueryModal';
import ReviewView from './views/ReviewView';

export default class IncrementalReadingPlugin extends Plugin {
  settings: IRPluginSettings;
  #reviewManager: ReviewManager;
  store: typeof store;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MarkdownEditor: any;

  /**
   * Get the ReviewManager instance.
   * May be null if called before onLayoutReady completes.
   */
  get reviewManager(): ReviewManager | null {
    return this.#reviewManager ?? null;
  }

  /**
   * Wrap a file-modifying operation to prevent external modification detection.
   * The vault 'modify' event handler will ignore changes while this is active.
   */
  async withReviewViewSave<T>(operation: () => Promise<T>): Promise<T> {
    store.dispatch(setReviewViewSaving(true));
    try {
      return await operation();
    } finally {
      store.dispatch(setReviewViewSaving(false));
    }
  }

  async onload() {
    await this.loadSettings();
    this.MarkdownEditor = getEditorClass(this.app);

    // This creates an icon in the left ribbon.
    // TODO: replace the placeholder
    const ribbonIconEl = this.addRibbonIcon(
      PLACEHOLDER_PLUGIN_ICON,
      'Incremental Reading',
      async (evt: MouseEvent) => {
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
      // hotkeys: [
      //   {
      //     modifiers: ['Alt'],
      //     key: 'X',
      //   },
      // ],
      callback: async () => {
        if (!this.#reviewManager) {
          new Notice(`Plugin still loading`);
          return;
        }
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
          return;
        }
        const reviewView = this.app.workspace.getActiveViewOfType(ReviewView);
        if (reviewView) {
          return this.#reviewManager.createSnippet(editor, reviewView);
        }

        const markdownView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          return this.#reviewManager.createSnippet(editor, markdownView);
        }
      },
    });

    this.addCommand({
      id: 'create-card',
      name: 'Create SRS card',
      callback: () => {
        if (!this.#reviewManager) {
          new Notice(`Plugin still loading`);
          return;
        }
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) {
          return;
        }
        const reviewView = this.app.workspace.getActiveViewOfType(ReviewView);
        if (reviewView) {
          return this.#reviewManager.createCard(editor, reviewView);
        }

        const markdownView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          return this.#reviewManager.createCard(editor, markdownView);
        }
      },
    });

    const importArticle = (file?: TAbstractFile) => {
      if (!this.#reviewManager) {
        new Notice(`Plugin still loading`);
        return;
      }
      if (file instanceof TFile) {
        new PriorityModal(this.app, this.#reviewManager, file).open();
      } else {
        const reviewView = this.app.workspace.getActiveViewOfType(ReviewView);
        if (reviewView) {
          new Notice('Cannot import articles from review view', 0);
          return;
        }

        const markdownView = this.app.workspace.getActiveFileView();
        if (markdownView?.file) {
          new PriorityModal(
            this.app,
            this.#reviewManager,
            markdownView.file
          ).open();
        } else {
          new Notice(
            'A markdown note must be active',
            ERROR_NOTICE_DURATION_MS
          );
        }
      }
    };

    this.addCommand({
      id: 'import-article',
      name: 'Import article',
      callback: importArticle,
    });

    this.addCommand({
      id: 'learn',
      name: 'Learn',
      callback: async () => await this.learn.call(this),
    });

    this.addCommand({
      // TODO: remove after done testing
      id: 'list-entries',
      name: '(dev) List articles, snippets and cards',
      callback: async () => {
        if (!this.#reviewManager) {
          new Notice(`Plugin still loading`);
          return;
        }
        await this.#reviewManager._logItems();
      },
    });

    this.addCommand({
      // TODO: remove after done testing
      id: 'query-db',
      name: '(dev) Query the database',
      callback: async () => {
        if (!this.#reviewManager) {
          new Notice(`Plugin still loading`);
          return;
        }
        new QueryModal(this.app, this.#reviewManager).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle('Import article')
            .setIcon(PLACEHOLDER_PLUGIN_ICON)
            .onClick(async () => importArticle(file));
        });
      })
    );

    const invalidateCache: (file: TAbstractFile) => Promise<void> =
      this.invalidateCurrentItemCache.bind(this);
    // Invalidate review item cache when the current item's file is modified externally
    this.registerEvent(this.app.vault.on('modify', invalidateCache));

    // listen for file renames to update references in db
    this.registerEvent(
      this.app.vault.on(
        'rename',
        async (file: TAbstractFile, oldPath: string) => {
          if (!this.#reviewManager) {
            // console.log('Review manager not ready; returning');
            return;
          }
          await this.#reviewManager.handleExternalRename(file, oldPath);
          await invalidateCache(file);
        }
      )
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
          // TODO: remove 'as' assertion once mobileNavbar type is added
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const navbarBox = (this.app.mobileNavbar as any)?.containerEl as
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

        this.store = store;
        const repo = await SQLiteRepository.start(
          this,
          DATABASE_FILE_PATH,
          databaseSchema,
          (error) => {
            console.error(
              'Incremental Reading - Migration verification failed:',
              error.errors
            );
            new Notice(
              `Incremental Reading: Database migration failed. Check the console for details.`,
              0
            );
            this.unload();
          }
        );

        this.#reviewManager = new ReviewManager(this.app, repo);
        this.registerView(
          ReviewView.viewType,
          (leaf) => new ReviewView(leaf, this, this.#reviewManager)
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

  onunload() {
    this.MarkdownEditor = null; // is this necessary?
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
      const view = leaf.view as ReviewView;
      view.initialItem = initialItem;

      // If the view was already open, invalidate the query to trigger a refetch
      // This ensures the new initial item is displayed immediately
      if (viewAlreadyOpen) {
        queryClient.invalidateQueries({ queryKey: ['current-review-item'] });
      }
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Invalidates the React Query cache when the passed file is also open in
   * review. Used to keep review in sync with other editor panes.
   */
  async invalidateCurrentItemCache(file: TAbstractFile) {
    // Skip cache invalidation if the modification came from the review view itself
    if (store.getState().isReviewViewSaving) {
      // console.log('review view is saving; skipping invalidation');
      return;
    }

    const { currentItem } = this.store.getState();
    if (currentItem?.file.path !== file.path) {
      // console.log(
      //   `modified file doesn't match current item; skipping invalidation`
      // );
      return;
    }
    // console.log('invalidating item cache');

    await queryClient.invalidateQueries({
      queryKey: [currentItem.data.id],
    });
    await queryClient.invalidateQueries({
      queryKey: [currentItem.data.id, 'file-text'],
    });
  }
}
