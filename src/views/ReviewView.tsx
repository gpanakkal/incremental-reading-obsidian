import type IncrementalReadingPlugin from '#/main';
import type { IconName, TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { FileView, Scope } from 'obsidian';
import { render } from 'preact';
import type { Unsubscribe } from '@reduxjs/toolkit';
import type { ReviewItem } from '#/lib/types';
import { PLACEHOLDER_PLUGIN_ICON } from '#/lib/constants';
import type ReviewManager from '#/lib/ReviewManager';
import { createReviewInterface } from '#/components/ReviewInterface';
import { resetSession } from '#/lib/store';

export default class ReviewView extends FileView {
  static #viewType = 'incremental-reading-review';
  #reviewManager: ReviewManager;
  plugin: IncrementalReadingPlugin;
  activeEditor: any;
  /* required for review view to open */
  allowNoFile: boolean = true;
  /**
   * Optional initial item to display first instead of the top of the queue.
   * Set this before opening the view to jump to a specific item.
   */
  initialItem: ReviewItem | null = null;
  scope: Scope;
  #unsubscribe: Unsubscribe;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: IncrementalReadingPlugin,
    reviewManager: ReviewManager
  ) {
    super(leaf);
    this.plugin = plugin;
    this.#reviewManager = reviewManager;
    this.scope = new Scope(this.plugin.app.scope);
    this.#unsubscribe = plugin.store.subscribe(() => {
      const { currentItem } = plugin.store.getState();
      this.file = currentItem?.file ?? null;
    });
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
    this.#unsubscribe();
    this.plugin.store.dispatch(resetSession());
  }

  async onLoadFile(file: unknown): Promise<void> {}

  async onUnloadFile(file: unknown): Promise<void> {}
}
