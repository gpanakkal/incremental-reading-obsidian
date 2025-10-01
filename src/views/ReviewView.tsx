import type IncrementalReadingPlugin from '#/main';
import type { IconName, TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { ItemView } from 'obsidian';
import type { ReviewItem } from '#/db/types';
import { PLACEHOLDER_PLUGIN_ICON } from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import { createReviewInterface } from '#/components/ReviewInterface';
import { render } from 'preact';

export default class ReviewView extends ItemView {
  static #viewType = 'incremental-reading-review';
  #reviewManager: ReviewManager;
  // private reviewQueue: ReviewItem[] | null = null;
  #currentItem: ReviewItem | null = null;
  // private markdownContainer: HTMLElement | null = null;
  // private buttonContainer: HTMLElement | null = null;
  plugin: IncrementalReadingPlugin;
  activeEditor: any;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: IncrementalReadingPlugin,
    reviewManager: ReviewManager
  ) {
    super(leaf);
    this.plugin = plugin;
    this.#reviewManager = reviewManager;
  }

  static get viewType() {
    return this.#viewType;
  }

  getViewType(): string {
    return ReviewView.viewType;
  }

  getDisplayText(): string {
    return 'Incremental Reading';
  }

  getIcon(): IconName {
    return PLACEHOLDER_PLUGIN_ICON;
  }

  // getViewData(): string {}

  setViewData(data: string, clear: boolean): void {}

  clear(): void {}

  get file(): TFile | null {
    return this.#currentItem?.file ?? null;
  }

  set currentItem(item: ReviewItem) {
    this.#currentItem = item;
  }

  /**
   * Get selected text from the rendered markdown content.
   * This allows snippet creation from ReviewView
   */
  getSelection(): string {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return '';
    }

    return selection.toString();
  }

  async onOpen() {
    this.containerEl.empty();
    render(
      createReviewInterface({
        reviewView: this,
        plugin: this.plugin,
        leaf: this.leaf,
        reviewManager: this.#reviewManager,
      }),
      this.containerEl
    );
  }

  async onClose() {
    render(null, this.containerEl);
  }

  // onload(): void {
  //   super.onload();
  //   this.contentEl.empty();
  //   render(
  //     createReviewInterface({
  //       plugin: this.plugin,
  //       leaf: this.leaf,
  //       reviewManager: this.#reviewManager,
  //     }),
  //     this.contentEl
  //   );
  // }

  onunload(): void {
    super.onunload();
    this.activeEditor = null;
  }

  // async refreshQueue() {
  //   if (!this.reviewQueue || !this.reviewQueue.length) {
  //     this.reviewQueue = (
  //       await this.#reviewManager.getDue({ dueBy: this.getDueTime() })
  //     ).all.reverse();
  //   }
  //   if (this.reviewQueue.length) {
  //     this.#currentItem = this.reviewQueue.pop() ?? null;
  //   }
  // }
  // // TODO: change to end of day accounting for day rollover offset
  // getDueTime() {
  //   return Date.now() + 7 * SNIPPET_BASE_REVIEW_INTERVAL;
  // }

  // async showNextDue() {
  //   await this.refreshQueue();
  //   if (!this.#currentItem) {
  //     // TODO: move fallback HTML logic here
  //     await this.buildHtml();
  //     return;
  //   }

  //   await this.buildHtml(this.#currentItem);
  //   await this.renderMarkdownContent(this.#currentItem);
  // }

  // async buildHtml(item?: ReviewItem) {
  //   const container = this.containerEl;
  //   container.empty();

  //   container.addClass('ir-review-view-container');

  //   this.buttonContainer = container.createDiv({
  //     cls: 'ir-review-button-container',
  //   });

  //   this.markdownContainer = container.createDiv({
  //     cls: 'ir-review-markdown-container',
  //   });

  //   // Obsidian classes to apply note styling to the review interface
  //   this.markdownContainer.addClasses([
  //     'markdown-source-view',
  //     'is-live-preview',
  //     'markdown-rendered',
  //     'cm-s-obsidian',
  //     'mod-cm6',
  //     'node-insert-event',
  //     'is-readable-line-width',
  //     'is-folding',
  //     'allow-fold-headings',
  //     'allow-fold-lists',
  //     'show-indentation-guide',
  //     'show-properties',
  //     'cm-sizer',
  //   ]);

  //   if (!this.reviewQueue?.length) {
  //     // Show placeholder if no file loaded
  //     this.showPlaceholder();
  //   }

  //   // Create the button bar
  //   this.createButtonBar(item);
  // }

  // private showPlaceholder() {
  //   if (!this.markdownContainer) return;

  //   this.markdownContainer.empty();
  //   this.markdownContainer.createDiv({
  //     text: 'Nothing due for review.',
  //     cls: 'ir-review-placeholder',
  //   });
  // }

  // private async renderMarkdownContent(
  //   item: ReviewItem,
  //   revealAnswer?: boolean
  // ) {
  //   if (!this.markdownContainer) return;

  //   this.markdownContainer.empty();

  //   try {
  //     // const leaf = this.app.workspace.createLeafInParent(this.leaf.parent, -1);
  //     // // TODO: create the leaf directly in the view
  //     // // const leaf = new WorkspaceLeaf();
  //     // await leaf.openFile(item.file, { state: { mode: 'preview' } });
  //     // if (!(leaf.view instanceof MarkdownView)) {
  //     //   throw new TypeError(`Leaf view isn't a MarkdownView`);
  //     // }
  //     // await this.leaf.openFile(item.file);
  //     // const markdownView = new MarkdownView(this.leaf);
  //     // await markdownView.open(this.markdownContainer);
  //     // const editView = new MarkdownEditView(markdownView);
  //     // if (markdownView.containerEl) {
  //     //   const viewContent =
  //     //     markdownView.containerEl.querySelector('.view-content');
  //     //   if (viewContent) {
  //     //     this.markdownContainer.appendChild(viewContent);
  //     //   }
  //     // }
  //     // leaf.detach();
  //     // const content = await this.app.vault.read(item.file);
  //     // // Create a content div for the rendered markdown
  //     // const contentDiv = this.markdownContainer.createDiv({
  //     //   cls: 'ir-review-content markdown-source-view cm-s-obsidian mod-cm6 node-insert-event is-readable-line-width is-live-preview is-folding show-properties',
  //     // });
  //     // let formattedContent = content;
  //     // if ('state' in item.data && !revealAnswer) {
  //     //   const match = searchAll(content, clozeDelimiterPattern)[0];
  //     //   if (!match) {
  //     //     throw new Error(`Valid cloze delimiters not found in ${content}`);
  //     //   }
  //     //   const pre = content.slice(0, match.index);
  //     //   const answer = `${CLOZE_DELIMITERS[0]}__${CLOZE_DELIMITERS[1]}`;
  //     //   const post = content.slice(match.index + match.match.length);
  //     //   formattedContent = pre + answer + post;
  //     // }
  //     // // Render the markdown content
  //     // await MarkdownRenderer.render(
  //     //   this.app,
  //     //   formattedContent,
  //     //   contentDiv,
  //     //   item.file.path,
  //     //   this
  //     // );
  //   } catch (error) {
  //     const message =
  //       error instanceof Error ? error.message : '(no error message)';
  //     this.markdownContainer.createDiv({
  //       text: `Error loading file: ${message}`,
  //       cls: 'ir-review-error',
  //     });
  //   }
  // }

  private createButtonBar(item?: ReviewItem, revealAnswer?: boolean) {
    // if (!this.buttonContainer) return;
    // this.buttonContainer.empty();

    const buttons: {
      title: string;
      icon: string;
      action: () => Promise<void>;
    }[] = []; // TODO: button to show queue as a paginated table
    if (!item) {
      // TODO: buttons to show only when no items are selected
    } else if ('state' in item.data) {
      const card = item.data;
      if (!revealAnswer) {
        buttons.push({
          title: 'Show Answer',
          icon: '',
          action: async () => {
            // await this.renderMarkdownContent(item, true);
            this.createButtonBar(item, true);
          },
        });
      }
      // else {
      // buttons
      //   .push
      // {
      //   title: '(1) Again',
      //   icon: '🔁',
      //   action: async () => {
      //     await this.gradeCard(card, Rating.Again);
      //   },
      // },
      // {
      //   title: '(2) Hard',
      //   icon: '👎',
      //   action: async () => {
      //     await this.gradeCard(card, Rating.Hard);
      //   },
      // },
      // {
      //   title: '(3) Good',
      //   icon: '👍',
      //   action: async () => {
      //     await this.gradeCard(card, Rating.Good);
      //   },
      // },
      // {
      //   title: '(4) Easy',
      //   icon: '✅',
      //   action: async () => {
      //     await this.gradeCard(card, Rating.Easy);
      //   },
      // }
      // {
      //   title: '(0) Manual',
      //   icon: '👎',
      //   action: async () => {
      //     await this.gradeCard(card, Rating.Manual);
      //     await this.showNextDue();
      //   },
      // }
      // {
      //   title: 'Skip for now',
      //   icon: '➡️',
      //   action: async () => this.nextReview(),
      // }
      // ();
      // }
      // } else if ('dismissed' in item.data) {
      //   const snippet = item.data;
      // buttons.push(
      // {
      //   title: 'Continue',
      //   icon: '',
      //   action: async () => await this.reviewSnippet(snippet),
      // },
      // {
      //   title: 'Again',
      //   icon: '🔁',
      //   action: async () =>
      //     await this.reviewSnippet(snippet, SNIPPET_REVIEW_INTERVALS.AGAIN),
      // },
      // {
      //   title: 'Tomorrow',
      //   icon: '☀',
      //   action: async () =>
      //     await this.reviewSnippet(
      //       snippet,
      //       SNIPPET_REVIEW_INTERVALS.TOMORROW
      //     ),
      // },
      // {
      //   title: 'Three Days',
      //   icon: '📅',
      //   action: async () =>
      //     await this.reviewSnippet(
      //       snippet,
      //       SNIPPET_REVIEW_INTERVALS.THREE_DAYS
      //     ),
      // },
      // {
      //   title: 'One Week',
      //   icon: '↩',
      //   action: async () =>
      //     await this.reviewSnippet(
      //       snippet,
      //       SNIPPET_REVIEW_INTERVALS.ONE_WEEK
      //     ),
      // },
      // {
      //   title: 'Dismiss',
      //   icon: '❌',
      //   action: async () => {
      //     await this.#reviewManager.dismissSnippet(snippet);
      //     await this.showNextDue();
      //   },
      // }
      // );
      // }

      // buttons.forEach((button) => {
      //   const buttonEl = this.buttonContainer!.createEl('button', {
      //     text: `${button.icon} ${button.title}`,
      //     cls: 'ir-review-button',
      //   });
      //   buttonEl.addEventListener('click', button.action);
      // });

      // if (item && 'dismissed' in item.data) {
      // const snippet = item.data;

      // const priorityContainer = this.buttonContainer.createDiv({
      //   cls: 'ir-priority-container',
      // });

      // priorityContainer.createEl('label', {
      //   text: 'Priority',
      //   cls: 'ir-priority-label',
      // });

      // const priorityField = priorityContainer.createEl('input', {
      //   value: `${item.data.priority / 10}`,
      //   cls: 'ir-priority-input',
      //   type: 'number',
      //   attr: {
      //     min: 1,
      //     max: 5,
      //     step: 0.1,
      //   },
      // });

      // priorityField.addEventListener('blur', (e) => {
      //   const rawPriority = Number(priorityField.value);
      //   if (Number.isNaN(rawPriority)) {
      //     throw new TypeError(`Priority must be a number`);
      //   }
      //   const clamped = Math.min(5, Math.max(1, rawPriority));
      //   const normalized = Math.round(Number(clamped) * 10);
      //   priorityField.value = `${clamped}`;

      //   this.#reviewManager
      //     .reprioritizeSnippet(snippet, normalized)
      //     .then(() => {
      //       new Notice(`Priority updated`, SUCCESS_NOTICE_DURATION_MS);
      //     });
      // });

      // priorityField.addEventListener('focusin', (e) => {
      //   priorityField.select();
      // });
      // }
      // TODO: hotkeys
    }
  }

  // // Button action methods
  // private async gradeCard(card: ISRSCardDisplay, grade: Grade) {
  //   new Notice(`Graded as: ${grade}`);
  //   await this.#reviewManager.reviewCard(card, grade);
  //   await this.showNextDue();
  // }

  // // Button action methods
  // private async reviewSnippet(snippet: ISnippet, nextInterval?: number) {
  //   if (nextInterval) {
  //     new Notice(
  //       `Next snippet review manually scheduled for ` +
  //         `${Math.round((10 * nextInterval) / MS_PER_DAY) / 10} days from now`,
  //       SUCCESS_NOTICE_DURATION_MS
  //     );
  //   }

  //   await this.#reviewManager.reviewSnippet(snippet, Date.now(), nextInterval);
  //   await this.showNextDue();
  // }
}
