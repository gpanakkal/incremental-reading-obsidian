import { createReviewInterface } from '#/components/ReviewInterface';
import {
  MORE_OPTIONS_SECTIONS,
  PLACEHOLDER_PLUGIN_ICON,
} from '#/lib/constants';
import type ReviewManager from '#/lib/items/ReviewManager';
import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';
import { resetSession, setPage, type ReviewPage } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import {
  FileView,
  Menu,
  MenuItem,
  Platform,
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
   *
   * The breadcrumb goes first, matching the order `FileView.loadFile` uses.
   */
  setTitle() {
    this.renderTitleParent();
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
   * The item this tab is displaying, or `null` when it is showing anything else.
   * Everything that speaks for the current item — the name in
   * {@link getDisplayText}, the folder path in {@link renderTitleParent}, the
   * file entries in {@link onPaneMenu} — keys off this one answer, so they can
   * never end up describing different items.
   *
   * `file` legitimately stays pointed at the last item while the home screen is
   * up, so the page is what decides, not the file alone. A file with an empty
   * basename counts as no item, rather than leaving the tab and the taskbar
   * blank.
   *
   * Reads the page from the store rather than {@link #page}, which exists only to
   * detect page *changes*: Obsidian calls this from paths the store subscription
   * does not drive, and a title read must never lag the state it describes.
   */
  currentItemFile(): TFile | null {
    const { page } = this.plugin.store.getState();
    if (page !== 'review') return null;
    return this.file?.basename ? this.file : null;
  }

  /** The name of the item this tab is displaying — see {@link currentItemFile}. */
  currentItemName(): string | null {
    return this.currentItemFile()?.basename ?? null;
  }

  /**
   * The single source of truth for this tab's name. Obsidian reads it for the
   * tab header, the OS taskbar title (`Workspace.updateTitle` ->
   * `document.title`), the mobile tab switcher's card labels, the tab context
   * menu and the serialized layout — so the page check belongs here, not only in
   * {@link setTitle}. Returning the file basename unconditionally is what leaked
   * the current item's name onto the taskbar and the iOS tab switcher while the
   * home screen was showing.
   */
  getDisplayText(): string {
    return this.currentItemName() ?? REVIEW_VIEW_DEFAULT_TITLE;
  }

  /**
   * Redraw the folder breadcrumb that sits left of the title in the view header.
   *
   * `FileView` fills `titleParentEl` from `file.parent.path` in
   * `renderBreadcrumbs`, and calls it from exactly two places: `loadFile` and its
   * vault-rename handler. {@link setFile} assigns `this.file` directly and never
   * goes through `loadFile`, so without this the breadcrumb stays frozen at
   * whatever the last real `loadFile` drew — in practice the item the saved
   * workspace layout restored on startup, since `FileView.setState` is the only
   * thing that ever calls it here. The header then names the current item while
   * pointing at a different item's folder, and the breadcrumb's reveal-in-file-
   * explorer click opens that wrong folder.
   *
   * Emptied rather than rendered when no item is showing, to match
   * {@link getDisplayText} falling back to the plugin name on the home screen.
   */
  renderTitleParent(): void {
    if (this.currentItemName()) {
      this.renderBreadcrumbs();
    } else {
      this.titleParentEl.empty();
    }
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

  /**
   * Land a newly mounted tab on the item this device left off on.
   *
   * For the mounts that do not come through {@link IncrementalReadingPlugin.learn}
   * — reopening a closed tab, and a tab restored with the workspace — which
   * reach the item through nobody: with the session emptied by the close, the
   * queue would hand the view whatever is at the top and the remembered item
   * would be written over by the tab that was meant to return to it.
   *
   * Says nothing when `learn` opened the tab: it resumed the session before
   * the view mounted, so {@link IncrementalReadingPlugin.resumeSession} reports
   * nothing left to resume and `learn` picks the page itself, home screen
   * setting included.
   */
  async resumeUnclaimedSession(): Promise<void> {
    if (this.initialItem) return;
    if (!(await this.plugin.resumeSession())) return;
    this.plugin.store.dispatch(setPage('review'));
  }

  async onOpen() {
    await super.onOpen();
    // Before the interface renders: mounting it first would fetch the top of
    // the queue against the empty session and dispatch that as the current item.
    await this.resumeUnclaimedSession();
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

  /**
   * Whether this is the only review tab left, and so the one whose close ends
   * the review session.
   *
   * Asked because the session is one shared store, not a thing each tab owns: a
   * split view is two `ReviewView`s over the same state, and `resetSession`
   * from either of them empties it for both. Works whichever side of the
   * workspace's own bookkeeping this runs on — a leaf already dropped is simply
   * not among the ones that remain.
   */
  isLastReviewTab(): boolean {
    return this.app.workspace
      .getLeavesOfType(ReviewView.viewType)
      .every((leaf) => leaf === this.leaf);
  }

  async onClose() {
    await super.onClose();
    render(null, this.contentEl);
    this.activeEditor = null;
    this.#lastFocusedEl = null;
    // Another review tab is still open and still on its item: the session
    // belongs to it now, and ending it here would send that tab back to the
    // home screen and drop what it was reading.
    if (!this.isLastReviewTab()) return;
    // The last tab out records what it was showing, so the tab closed last is
    // the one remembered — an item to come back to, or nothing at all if it had
    // already left review. That also keeps the `resetSession` below, which is
    // indistinguishable from leaving review for the home screen, from
    // discarding an item the user is coming back to. Reopening review resumes
    // there; see `Plugin.resumeSession`.
    this.plugin.sessionTracker?.commit();
    this.plugin.store.dispatch(resetSession());
  }

  /**
   * Populate the file context menu — the ⋮ button in the view header on mobile,
   * the action bar's stand-in for it on desktop, and the tab header's
   * right-click menu on both.
   *
   * `FileView` does not implement this. The class that does is the editable file
   * view below it in the hierarchy, which every markdown tab uses, so a plain
   * `FileView` subclass inherits only `ItemView`'s tab-level entries — Split
   * right and Split down on desktop, Close and Pin on a phone. Missing with it
   * are rename, delete, and the `file-menu` event that every core and community
   * plugin listens on to contribute its own entries, which is why the menu looks
   * broken rather than merely short. Firing that event here is what fills it.
   *
   * The three steps read top to bottom but do not render that way: `Menu.sort`
   * groups by section, following {@link MORE_OPTIONS_SECTIONS}. What puts this
   * view's own entries above Split right is their `pane` section, not the order
   * they were added in.
   */
  onPaneMenu(menu: Menu, source: string): void {
    this.addViewMenuItems(menu);
    super.onPaneMenu(menu, source);

    // Disable duplicating the review tab for now
    for (const item of menu.items) {
      if (
        item instanceof MenuItem &&
        (item.titleEl.textContent === 'Split right' ||
          item.titleEl.textContent === 'Split down')
      ) {
        item.setDisabled(true);
      }
    }
    this.addFileMenuItems(menu, source);
  }

  /**
   * The review tab's own menu entries, which render above everything Obsidian
   * and other plugins add.
   *
   * This is the extension point: add entries here, each carrying
   * `.setSection('pane')`, and they join the top group in the order written.
   */
  addViewMenuItems(menu: Menu): void {
    const file = this.currentItemFile();
    if (!file) return;

    menu.addItem((item) =>
      item
        .setTitle('Open in new tab')
        .setIcon('lucide-file-plus')
        .setSection('pane')
        .onClick(() => {
          void this.app.workspace
            .getLeaf('tab')
            .openFile(file, { active: true });
        })
    );

    // Obsidian's file explorer contributes "Reveal file in navigation" to every
    // `file-menu` it sees, but its handler is guarded by `!Platform.isMobile`,
    // so only desktop gets it. Adding ours unconditionally would list the
    // action twice there.
    if (Platform.isMobile) {
      menu.addItem((item) =>
        item
          .setTitle('Reveal file in navigation')
          .setIcon('lucide-folder-open')
          .setSection('pane')
          .onClick(() => {
            this.app.internalPlugins
              .getEnabledPluginById('file-explorer')
              ?.revealInFolder(file);
          })
      );
    }
  }

  /**
   * Everything a markdown tab's menu offers for the file it is showing: rename
   * and delete, which the view owns, then the `file-menu` event, which is where
   * the rest of the menu comes from — Move file to, Bookmark, Copy path, Reveal
   * in navigation, and whatever community plugins add.
   *
   * `source` is passed through untouched because handlers branch on it; the
   * file explorer's own reveal entry, for one, skips its own context menu that
   * way.
   *
   * Guarded on {@link currentItemFile} rather than `file`, which stays pointed
   * at the last item while the home screen is up: a menu offering to rename or
   * delete a note the tab is not showing would act on the wrong file.
   */
  addFileMenuItems(menu: Menu, source: string): void {
    const file = this.currentItemFile();
    if (!file) return;

    menu.addItem((item) =>
      item
        .setTitle('Rename...')
        .setIcon('lucide-edit-3')
        .setSection('action')
        .onClick(() => {
          void this.app.fileManager.promptForFileRename(file);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('Delete')
        .setIcon('lucide-trash-2')
        .setSection('danger')
        .setWarning(true)
        .onClick(() => {
          void this.app.fileManager.promptForDeletion(file);
        })
    );

    this.app.workspace.trigger('file-menu', menu, file, source, this.leaf);
  }

  /**
   * Open the file context menu from a caller of our own.
   *
   * Obsidian builds this menu in `ItemView.onMoreOptions`, wired to the ⋮ button
   * it draws in `headerEl` — which {@link onOpen} hides on desktop, where the
   * action bar takes the header's place. The action bar's ⋮ calls this instead,
   * and it mirrors that method step for step: same sections, same submenu
   * grouping, same `leaf-menu` event, anchored under the button the same way, so
   * the menu desktop gets is the one mobile gets natively.
   */
  showMoreOptionsMenu(anchorEl: HTMLElement): void {
    const menu = new Menu().addSections(MORE_OPTIONS_SECTIONS);
    menu.setSectionSubmenu('info.copy', {
      title: 'Copy path',
      icon: 'lucide-clipboard',
    });
    menu.setSectionSubmenu('view.linked', {
      title: 'Open linked view',
      icon: 'lucide-link',
    });

    this.onPaneMenu(menu, 'more-options');
    this.app.workspace.trigger('leaf-menu', menu, this.leaf);

    const rect = anchorEl.getBoundingClientRect();
    menu.setParentElement(anchorEl).showAtPosition({
      x: rect.x,
      y: rect.bottom,
      width: rect.width,
      overlap: true,
      left: true,
    });
  }

  /* TODO: investigate how to use this */
  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await super.onUnloadFile(file);
  }
}
