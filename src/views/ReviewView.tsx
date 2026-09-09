import { createReviewInterface } from '#/components/ReviewInterface';
import { PLACEHOLDER_PLUGIN_ICON } from '#/lib/constants';
import type ReviewManager from '#/lib/items/ReviewManager';
import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';
import { resetSession, type ReviewPage } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import {
  FileView,
  WorkspaceWindow,
  type IconName,
  type TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { render } from 'preact';

/** Shown whenever the review tab is not displaying an item. */
export const REVIEW_VIEW_DEFAULT_TITLE = 'Incremental reading';

export default class ReviewView extends FileView {
  static #viewType = 'incremental-reading-review';
  #reviewManager: ReviewManager;
  plugin: IncrementalReadingPlugin;

  activeEditor: ExtractedMarkdownEditor['owner'] = null;
  /* required for review view to open */
  allowNoFile: boolean = true;
  #lastFocusedEl: Element | null = null;
  /**
   * Optional initial item to display first instead of the top of the queue.
   * Set this before opening the view to jump to a specific item.
   */
  initialItem: ReviewItem | null = null;
  /**
   * The page as of the last store notification, kept only to spot page
   * *changes*. Read the store for the current page — see {@link getDisplayText}.
   */
  #page: ReviewPage;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: IncrementalReadingPlugin,
    reviewManager: ReviewManager
  ) {
    super(leaf);
    this.plugin = plugin;
    this.#reviewManager = reviewManager;
    this.#page = plugin.store.getState().page;

    const unsub = plugin.store.subscribe(() => {
      const currentPage = plugin.store.getState().page;
      if (currentPage !== this.#page) {
        this.#page = plugin.store.getState().page;
        this.setTitle();
      }
    });
    this.register(() => unsub());
  }

  /**
   * Synchronously set file and title.
   * Use when fetching a new item
   */
  setFile(file: TFile | null) {
    this.file = file;
    this.setTitle();
  }

  /**
   * Push the current title into every place Obsidian caches it.
   * Call when fetching a new item or changing page.
   *
   * Obsidian only refreshes these on leaf and layout changes, and moving between
   * the home screen and an item is neither, so they have to be poked by hand.
   * `updateHeader` re-reads {@link getDisplayText} for the tab header, its
   * tooltip and the mobile tab-group header; `updateTitle` recomputes
   * `document.title`, which is what the OS taskbar shows. A popout retitles its
   * own window instead — the same branch Obsidian's `setActiveLeaf` takes.
   */
  setTitle() {
    this.titleEl.setText(this.getDisplayText());
    this.leaf.updateHeader();
    const container = this.leaf.getContainer();
    if (container instanceof WorkspaceWindow) {
      container.updateTitle();
    } else {
      this.app.workspace.updateTitle();
    }
  }

  static get viewType() {
    return this.#viewType;
  }

  getViewType(): string {
    return ReviewView.viewType;
  }

  /**
   * The single source of truth for this tab's name. Obsidian reads it for the
   * tab header, the OS taskbar title (`Workspace.updateTitle` ->
   * `document.title`), the mobile tab switcher's card labels, the tab context
   * menu and the serialized layout — so the page check belongs here, not only in
   * {@link setTitle}. Returning the file basename unconditionally is what leaked
   * the current item's name onto the taskbar and the iOS tab switcher while the
   * home screen was showing.
   *
   * Reads the page from the store rather than {@link #page}, which exists only to
   * detect page *changes*: Obsidian calls this from paths the store subscription
   * does not drive, and a title read must never lag the state it describes.
   *
   * A file with an empty basename falls back too, rather than leaving the tab
   * and the taskbar blank.
   */
  getDisplayText(): string {
    const { page } = this.plugin.store.getState();
    return page === 'review' && this.file?.basename
      ? this.file.basename
      : REVIEW_VIEW_DEFAULT_TITLE;
  }

  getIcon(): IconName {
    return PLACEHOLDER_PLUGIN_ICON;
  }

  // For extending TextFileView/MarkdownView. If implemented incorrectly, can
  //  erase or overwrite note contents
  // getViewData(): string {}

  // setViewData(data: string, clear: boolean): void {}

  clear(): void {}

  /**
   * `editor:open-search` tries `workspace.activeEditor` first, then falls back to
   * `activeLeaf.view`. The former is only set once the CodeMirror editor takes
   * focus, so this covers Ctrl+F right after the tab is activated, and on pages
   * with no editor mounted (home screen, queue, un-revealed cards).
   *
   * Must stay a prototype method: `getMarkdownController` spreads `...view`, which
   * would copy a class-field arrow as an own property and shadow the controller's
   * own forwarder.
   */
  showSearch(replace = false): void {
    this.activeEditor?.showSearch(replace);
  }

  /**
   * Publish the review editor as the workspace's active editor.
   *
   * For a real markdown view Obsidian resolves `workspace.activeEditor` as
   * `_activeEditor ?? getActiveViewOfType(MarkdownView)` — from the *active view*,
   * not from DOM focus. That is why Ctrl+F works in a note the instant its tab
   * opens. This view is not a MarkdownView, so it has to publish itself, and doing
   * that only from the CodeMirror focus handler left `editor:open-search` with
   * nothing to find until the user clicked into the text.
   *
   * `Workspace.setActiveLeaf` nulls the workspace's editor on every leaf switch,
   * so this has to run again each time the tab is reactivated.
   */
  setActiveEditor(owner: ExtractedMarkdownEditor['owner']): void {
    this.activeEditor = owner;
    this.app.workspace.activeEditor = owner;
  }

  /**
   * Refocus the last-focused element when the review tab is reactivated, without
   * scrolling it into view. `HTMLElement.focus()` scrolls the element into the
   * viewport by default, which would yank the editor to the top-most focusable
   * element (the title editor / action bar) on every tab switch — the reported
   * "jumps to top" bug. `preventScroll` keeps the current scroll position.
   *
   * Takes the element rather than reading `#lastFocusedEl`, so the DOM behaviour
   * stays exercisable on its own.
   */
  refocusWithoutScroll(el: Element | null): void {
    if (el instanceof HTMLElement) {
      el.focus({ preventScroll: true });
    }
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
    await super.onOpen();
    if (this.initialItem) {
      this.setFile(this.initialItem.file);
    }
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

    this.registerDomEvent(this.contentEl, 'focusin', (e: FocusEvent) => {
      if (e.target instanceof Element) {
        this.#lastFocusedEl = e.target;
      }
    });

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf) {
          this.refocusWithoutScroll(this.#lastFocusedEl);
          // Reclaim the workspace editor slot that setActiveLeaf just cleared,
          // so the search commands resolve without waiting for a click.
          this.setActiveEditor(this.activeEditor);
        }
      })
    );
  }

  async onClose() {
    await super.onClose();
    render(null, this.contentEl);
    this.activeEditor = null;
    this.#lastFocusedEl = null;
    this.plugin.store.dispatch(resetSession());
  }

  /* TODO: add file options */
  // onPaneMenu(menu: Menu, source: 'more-options' | 'tab-header' | string): void {
  //   super.onPaneMenu(menu, source);
  // }

  /* TODO: investigate how to use this */
  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await super.onUnloadFile(file);
  }
}
