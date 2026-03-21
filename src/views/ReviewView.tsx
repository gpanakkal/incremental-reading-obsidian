import { FileView, Scope } from 'obsidian';
import { render } from 'preact';
import { createReviewInterface } from '#/components/ReviewInterface';
import { PLACEHOLDER_PLUGIN_ICON } from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import { resetSession } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type { IconName, TFile, WorkspaceLeaf } from 'obsidian';

export default class ReviewView extends FileView {
  static #viewType = 'incremental-reading-review';
  #reviewManager: ReviewManager;
  plugin: IncrementalReadingPlugin;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activeEditor: any;
  /* required for review view to open */
  allowNoFile: boolean = true;
  /**
   * Optional initial item to display first instead of the top of the queue.
   * Set this before opening the view to jump to a specific item.
   */
  initialItem: ReviewItem | null = null;
  scope: Scope;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: IncrementalReadingPlugin,
    reviewManager: ReviewManager
  ) {
    super(leaf);
    this.plugin = plugin;
    this.#reviewManager = reviewManager;
    this.scope = new Scope(this.plugin.app.scope);
  }

  /** Use this to synchronously set file when fetching a new item */
  setFile(file: TFile | null) {
    this.file = file;
  }

  static get viewType() {
    return this.#viewType;
  }

  getViewType(): string {
    return ReviewView.viewType;
  }

  getDisplayText(): string {
    // eslint-disable-next-line obsidianmd/ui/sentence-case
    return 'Incremental Reading';
  }

  getIcon(): IconName {
    return PLACEHOLDER_PLUGIN_ICON;
  }

  // getViewData(): string {}

  // setViewData(data: string, clear: boolean): void {}

  clear(): void {}

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
    this.activeEditor = null;
    this.plugin.store.dispatch(resetSession());
  }

  async onLoadFile(_file: unknown): Promise<void> {}

  async onUnloadFile(_file: unknown): Promise<void> {}
}
