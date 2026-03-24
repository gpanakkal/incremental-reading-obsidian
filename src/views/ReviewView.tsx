import { FileView } from 'obsidian';
import { render } from 'preact';
import { createReviewInterface } from '#/components/ReviewInterface';
import { PLACEHOLDER_PLUGIN_ICON } from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import { resetSession } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type { IconName, TFile, WorkspaceLeaf } from 'obsidian';
import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';

export default class ReviewView extends FileView {
  static #viewType = 'incremental-reading-review';
  #reviewManager: ReviewManager;
  plugin: IncrementalReadingPlugin;

  activeEditor: ExtractedMarkdownEditor['owner'];
  /* required for review view to open */
  allowNoFile: boolean = true;
  /**
   * Optional initial item to display first instead of the top of the queue.
   * Set this before opening the view to jump to a specific item.
   */
  initialItem: ReviewItem | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: IncrementalReadingPlugin,
    reviewManager: ReviewManager
  ) {
    super(leaf);
    this.allowNoFile = true;
    this.plugin = plugin;
    this.#reviewManager = reviewManager;
  }

  /** Synchronously set file and title.
   * Use when fetching a new item
   */
  setFile(file: TFile | null) {
    this.file = file;
    if (file) {
      this.leaf.tabHeaderInnerTitleEl.setText(file.basename);
      this.titleEl.setText(file.basename);
    } else {
      this.leaf.tabHeaderInnerTitleEl.setText('Incremental reading');
      this.titleEl.setText('Incremental reading');
    }
  }

  static get viewType() {
    return this.#viewType;
  }

  getViewType(): string {
    return ReviewView.viewType;
  }

  getDisplayText(): string {
    return this.file?.basename || 'Incremental reading';
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
    if (!this.app.isMobile) {
      this.headerEl.hide();
    }
    render(
      createReviewInterface({
        reviewView: this,
        plugin: this.plugin,
        reviewManager: this.#reviewManager,
      }),
      this.contentEl
    );
  }

  async onClose() {
    render(null, this.contentEl);
    this.activeEditor = null;
    this.plugin.store.dispatch(resetSession());
  }

  async onLoadFile(_file: unknown): Promise<void> {}

  async onUnloadFile(_file: unknown): Promise<void> {}
}
