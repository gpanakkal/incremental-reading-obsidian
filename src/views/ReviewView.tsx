import type IncrementalReadingPlugin from '#/main';
import type { IconName, TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { FileView } from 'obsidian';
import type { ReviewItem } from '#/lib/types';
import { PLACEHOLDER_PLUGIN_ICON } from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import { createReviewInterface } from '#/components/ReviewInterface';
import { render } from 'preact';

export default class ReviewView extends FileView {
  static #viewType = 'incremental-reading-review';
  #reviewManager: ReviewManager;
  seenIds: Set<string> = new Set();
  #currentItem: ReviewItem | null = null;
  plugin: IncrementalReadingPlugin;
  activeEditor: any;
  allowNoFile: boolean = true;

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

  // setViewData(data: string, clear: boolean): void {}

  clear(): void {}

  set currentItem(item: ReviewItem | null) {
    this.#currentItem = item;
    // Update the file property to notify FileView of the change
    // This makes sidebar panels (backlinks, outline, etc.) update
    this.file = item?.file ?? null;
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
    this.activeEditor = null;
  }

  async onLoadFile(file: unknown): Promise<void> {}

  async onUnloadFile(file: unknown): Promise<void> {}
}
