import type { App, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import {
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from 'obsidian';
import {
  DATABASE_FILE_PATH,
  ERROR_NOTICE_DURATION_MS,
  PLACEHOLDER_PLUGIN_ICON,
} from './lib/constants';
import { SQLiteRepository } from './lib/repository';
// @ts-ignore - SQL schema imported via custom esbuild plugin
import databaseSchema from './db/schema.sql';
import ReviewManager from './lib/ReviewManager';
import ReviewView from './views/ReviewView';
import { PriorityModal } from './views/PriorityModal';
import type { ReviewItem } from './lib/types';
import SRSCard from './lib/SRSCard';
import { getEditorClass } from './lib/utils';
import Snippet from './lib/Snippet';
import Article from './lib/Article';
import { QueryModal } from './views/QueryModal';
import { createIRExtensions } from './lib/extensions';
import { queryClient } from './lib/queryClient';

interface IRPluginSettings {
  mySetting: string;
}

const DEFAULT_SETTINGS: IRPluginSettings = {
  mySetting: 'default',
};

export default class IncrementalReadingPlugin extends Plugin {
  settings: IRPluginSettings;
  #reviewManager: ReviewManager;
  MarkdownEditor: any;

  /**
   * Flag to track when the review view is saving a file.
   * Used to prevent cache invalidation for internal modifications.
   */
  #isReviewViewSaving = false;

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
    this.#isReviewViewSaving = true;
    try {
      return await operation();
    } finally {
      this.#isReviewViewSaving = false;
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
        const articles = await this.#reviewManager._fetchArticleData({
          includeDismissed: true,
        });
        const snippets = await this.#reviewManager._fetchSnippetData({
          includeDismissed: true,
        });
        const cards = await this.#reviewManager._fetchCardData({
          includeDismissed: true,
        });

        if (!articles && !snippets && !cards) {
          new Notice('No entries found');
          return;
        }
        console.table(articles.map(Article.rowToDisplay));
        console.table(snippets.map(Snippet.rowToDisplay));
        console.table(cards.map(SRSCard.rowToDisplay));
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

    // listen for file renames to update references in db
    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!this.#reviewManager) {
          // console.log('Review manager not ready; returning');
          return;
        }
        this.#reviewManager.handleExternalRename(file, oldPath);
      })
    );

    const invalidateCache = this.invalidateCurrentItemCache.bind(this);
    // Invalidate review item cache when the current item's file is modified externally
    this.registerEvent(this.app.vault.on('modify', invalidateCache));

    // This adds a settings tab so the user can configure various aspects of the plugin
    // this.addSettingTab(new SampleSettingTab(this.app, this)); // TODO: set up settings

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
   * Invalidates the React Query cache when the passed file is also
   * open in review. Used to keep review in sync with other editor panes.
   */
  async invalidateCurrentItemCache(file: TAbstractFile) {
    // Skip cache invalidation if the modification came from the review view itself
    if (this.#isReviewViewSaving) {
      // console.log('review view is saving; skipping invalidation');
      return;
    }

    const reviewView = this.app.workspace
      .getLeavesOfType(ReviewView.viewType)
      .find((leaf) => leaf.view instanceof ReviewView)?.view as
      | ReviewView
      | undefined;
    const currentItem = reviewView?.currentItem;
    if (currentItem?.file.path !== file.path) {
      // console.log(
      //   `modified file doesn't match current item; skipping invalidation`
      // );
      return;
    }
    // console.log('invalidating current item cache');
    // Only invalidate the file content query, not the current-review-item query.
    // Invalidating current-review-item would re-fetch the queue via getDue(),
    // which may return a different item than the one currently being reviewed.
    // The file content query uses the item's reference as its key.
    queryClient.invalidateQueries({
      queryKey: [currentItem.data.reference],
    });
  }
}

class IRSettingTab extends PluginSettingTab {
  plugin: IncrementalReadingPlugin;

  constructor(app: App, plugin: IncrementalReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('Setting #1')
      .setDesc("It's a secret")
      .addText((text) =>
        text
          .setPlaceholder('Enter your secret')
          .setValue(this.plugin.settings.mySetting)
          .onChange(async (value) => {
            this.plugin.settings.mySetting = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
