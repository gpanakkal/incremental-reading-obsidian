import type { App, Editor, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, View } from 'obsidian';
import {
  addIcon,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian';
import {
  CARD_DIRECTORY,
  DATABASE_FILE_PATH,
  ERROR_NOTICE_DURATION_MS,
  PLACEHOLDER_PLUGIN_ICON,
  SCHEMA_FILE_PATH,
  SNIPPET_DIRECTORY,
} from './lib/constants';
import { SQLiteRepository } from './db/repository';
import ReviewManager from './lib/ReviewManager';
import ReviewView from './views/ReviewView';
import type { ISnippet, SRSCardRow } from './db/types';
import SRSCard from './lib/SRSCard';
import { getEditorClass } from './lib/utils';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
  mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
  mySetting: 'default',
};

export default class IncrementalReadingPlugin extends Plugin {
  settings: MyPluginSettings;
  #reviewManager: ReviewManager;
  MarkdownEditor: any;

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

    // TODO: show counts of cards and snippets in queue?
    // // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
    // const statusBarItemEl = this.addStatusBarItem();
    // statusBarItemEl.setText('Status Bar Text');

    this.addCommand({
      id: 'retain-selection',
      name: 'retain selection',
      hotkeys: [
        {
          modifiers: ['Alt'],
          key: 'X',
        },
      ], // TODO: add setting to customize hotkey
      callback: async () => {
        if (!this.#reviewManager) {
          new Notice(`Plugin still loading`);
          return;
        }
        const reviewView = this.app.workspace.getActiveViewOfType(ReviewView);
        if (reviewView) {
          return this.#reviewManager.createSnippet(reviewView);
        }

        const markdownView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          return this.#reviewManager.createSnippet(markdownView);
        }
      },
    });

    this.addCommand({
      id: 'create-card',
      name: 'Create SRS card from selection or current block',
      hotkeys: [
        {
          modifiers: ['Alt', 'Shift'],
          key: 'C',
        },
      ],
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
      // editorCallback: (editor: Editor, view: MarkdownView) => {
      //   if (!this.#reviewManager) {
      //     new Notice(`Plugin still loading`);
      //     return;
      //   }
      //   return this.#reviewManager.createCard(editor, view);
      // },
    });

    this.addCommand({
      id: 'learn',
      name: 'Learn',
      callback: () => this.learn.call(this),
    });

    this.addCommand({
      // TODO: remove after done testing
      id: 'list-snippets-and-cards',
      name: 'List snippets and cards',
      callback: async () => {
        if (!this.#reviewManager) {
          new Notice(`Plugin still loading`);
          return;
        }
        const snippets = await this.#reviewManager._fetchSnippetData({
          includeDismissed: true,
        });
        const cards = await this.#reviewManager._fetchCardData({
          includeDismissed: true,
        });

        // await this.repo?.query('SELECT rowid, * FROM snippet');
        if (!snippets && !cards) {
          console.log('No snippets or cards found');
          return;
        }
        snippets &&
          console.table(
            snippets.map((snippet) => ({
              ...snippet,
              due: snippet.due ? new Date(snippet.due).toString() : null,
              dismissed: Boolean(snippet.dismissed),
            }))
          );
        cards && console.table(cards.map(SRSCard.rowToDisplay));
      },
    });

    this.addCommand({
      // TODO: remove after done testing
      id: 'delete-all-snippets',
      name: 'DELETE all snippets',
      callback: async () => {
        if (!this.#reviewManager) {
          new Notice(`SQLite database still loading`);
          return;
        }
        const repo = this.#reviewManager.repo;
        await repo.mutate(`DELETE FROM snippet`);
        const rows = (await repo.query(`SELECT * FROM snippet`)) as ISnippet[];

        if (!rows.length) {
          const snippetDir = this.app.vault.getFolderByPath(SNIPPET_DIRECTORY);
          snippetDir && this.app.vault.trash(snippetDir, true);
        } else {
          new Notice(
            `Failed to delete all snippets from database`,
            ERROR_NOTICE_DURATION_MS
          );
          console.table(
            rows.map((row) => ({
              ...row,
              due: row.due ? new Date(row.due).toString() : null,
              dismissed: Boolean(row.dismissed),
            }))
          );
        }
      },
    });

    this.addCommand({
      // TODO: remove after done testing
      id: 'delete-all-cards',
      name: 'DELETE all cards',
      callback: async () => {
        if (!this.#reviewManager) {
          new Notice(`SQLite database still loading`);
          return;
        }
        const repo = this.#reviewManager.repo;
        await repo.mutate(`DELETE FROM srs_card`);
        const rows = (await repo.query(
          `SELECT * FROM srs_card`
        )) as SRSCardRow[];

        if (!rows.length) {
          const cardDir = this.app.vault.getFolderByPath(CARD_DIRECTORY);
          cardDir && this.app.vault.trash(cardDir, true);
        } else {
          new Notice(
            `Failed to delete all SRS cards from database`,
            ERROR_NOTICE_DURATION_MS
          );
          console.table(rows.map(SRSCard.rowToDisplay));
        }
      },
    });

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
      const repo = await SQLiteRepository.start(
        this.app,
        DATABASE_FILE_PATH,
        SCHEMA_FILE_PATH
      );
      this.#reviewManager = new ReviewManager(this.app, repo);
      this.registerView(
        ReviewView.viewType,
        (leaf) => new ReviewView(leaf, this, this.#reviewManager)
      );

      // listen for snippet creations. TODO: handle race condition
      // this.app.vault.on('create', async (file) => {
      //   // check if the snippet is in the database already
      //   const results = await this.#reviewManager.findSnippet(file);
      //   // await repo.query(
      //   //   `SELECT (id) FROM snippet WHERE reference = $1`,
      //   //   [file.name]
      //   // );
      //   // TODO: handle failed fetches differently from no results
      //   if (!results) {
      //     new Notice(`Failed to fetch rows`, ERROR_NOTICE_DURATION_MS);
      //     return;
      //   } else if (results.length === 0) {
      //     // insert a new snippet row
      //     const snippetFile = this.app.vault.getFileByPath(file.path);
      //     if (!snippetFile) {
      //       return; // TODO: handle
      //     }
      //     await this.#reviewManager.createSnippetFromFile(snippetFile);
      //   } else {
      //     // if so, set dismissed to 0
      //   }
      // });
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

  async learn() {
    let leaf: WorkspaceLeaf | null = null;
    const leaves = this.app.workspace.getLeavesOfType(ReviewView.viewType);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: ReviewView.viewType, active: true });
      // await leaf.open(new ReviewView(leaf, this.#reviewManager));
    }

    await this.app.workspace.revealLeaf(leaf);
  }
}

class SampleSettingTab extends PluginSettingTab {
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
