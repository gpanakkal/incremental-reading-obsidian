import { createReviewInterface } from '#/components/ReviewInterface';
import {
  MORE_OPTIONS_SECTIONS,
  PLACEHOLDER_PLUGIN_ICON,
} from '#/lib/constants';
import type ReviewManager from '#/lib/items/ReviewManager';
import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';
import {
  actionsToReach,
  isDestination,
  placeOf,
  placeToEphemeralState,
  readPlace,
  samePlace,
  type ReviewPlace,
} from '#/lib/review-history';
import {
  resetCurrentItem,
  resetSession,
  setPage,
  type ReviewPage,
} from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import {
  FileView,
  Menu,
  MenuItem,
  Platform,
  WorkspaceWindow,
  type IconName,
  type MarkdownEditView,
  type TFile,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';
import type { WorkspaceLeafHistoryState } from 'obsidian-typings';
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
  /**
   * The place as of the last store notification, kept to spot place changes and
   * to describe the place being left when one happens — by the time the store
   * notifies, it already names the next. See {@link trackPlace}.
   */
  #place: ReviewPlace;
  /**
   * Whether place changes go into this tab's back history: only between a
   * finished {@link onOpen} and the start of {@link onClose}. Before, the page and
   * item are still being settled for the tab rather than chosen by the user;
   * after, closing empties the session, which is not the user going anywhere.
   */
  #open = false;
  /** Set while a history entry is being applied, which must not record itself. */
  #applyingHistory = false;
  /**
   * Whether the review editor renders raw markdown rather than live preview.
   *
   * Lives on the tab rather than on the editor because the editor does not
   * outlive the item: `ReviewItem` keys `IREditor` on the item's id, so every
   * advance through the queue builds a fresh one, which would seed itself from
   * the vault config again and drop the choice made two items ago.
   *
   * Seeded from that config — the value Obsidian seeds every markdown editor
   * from — so a review tab opens reading the way a note does. Taken once, at
   * construction, as a markdown tab's editor takes it: changing the global
   * setting leaves the tabs already open alone.
   */
  sourceMode: boolean;
  /**
   * The entry this tab pushed most recently, for taking it back off when review
   * returns to its place before settling anywhere else — see {@link trackPlace}.
   */
  #lastRecorded: WorkspaceLeafHistoryState | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: IncrementalReadingPlugin,
    reviewManager: ReviewManager
  ) {
    super(leaf);
    this.plugin = plugin;
    this.#reviewManager = reviewManager;
    this.#page = plugin.store.getState().page;
    this.#place = placeOf(plugin.store.getState());
    this.sourceMode = !plugin.app.vault.getConfig('livePreview');

    const unsub = plugin.store.subscribe(() => {
      this.trackPlace(placeOf(plugin.store.getState()));
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
    return this.itemFileOn(this.plugin.store.getState().page);
  }

  /**
   * The item `file` stands for with review on `page` — the rule behind
   * {@link currentItemFile}, for describing a page other than the store's: the
   * one a history entry is being written for.
   */
  itemFileOn(page: ReviewPage): TFile | null {
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

  /**
   * Record leaving a place in this tab's back history, the way following a link
   * records leaving a note. Called on every store notification.
   *
   * Obsidian records history only when a leaf's view state changes, and moving
   * between the home screen and items changes nothing it can see: the view type
   * stays put and `file` is assigned directly (see {@link setFile}). So the entry
   * is written here, through the same `recordHistory` Obsidian's web viewer uses
   * for its own in-page navigation.
   *
   * The entry has to describe the place being left, and by now the store names
   * the next one; hence {@link historyEntryFor} takes the place rather than
   * reading it. Nothing else has caught up yet — `file` follows the item from a
   * render effect, and the editor has not re-rendered — so the rest of the view
   * still describes the place being left too.
   *
   * Review between items is never recorded (see `isDestination`). An advance
   * that comes back to the item it left — undo lands there — would otherwise
   * leave that item on top of the back stack, making the next back a step that
   * goes nowhere, so the entry is taken back off. Only while it is still the top
   * entry and still this tab's: anything pushed since means the user has moved
   * on.
   */
  trackPlace(next: ReviewPlace): void {
    const left = this.#place;
    if (samePlace(left, next)) return;
    this.#place = next;
    if (!this.#open || this.#applyingHistory) return;

    if (isDestination(left)) {
      const entry = this.historyEntryFor(left);
      this.leaf.recordHistory(entry);
      this.#lastRecorded = entry;
      return;
    }

    const { backHistory } = this.leaf.history;
    const top = backHistory[backHistory.length - 1];
    const lastRecordedPlace = readPlace(this.#lastRecorded?.eState);
    if (
      top === this.#lastRecorded &&
      lastRecordedPlace !== null &&
      samePlace(lastRecordedPlace, next)
    ) {
      backHistory.pop();
      this.#lastRecorded = null;
      this.leaf.trigger('history-change');
    }
  }

  /**
   * The history entry for `place`, in the shape `WorkspaceLeaf.getHistoryState`
   * gives Obsidian's own entries.
   *
   * The title is what the tab showed there, worked out from `place` rather than
   * {@link getDisplayText}, which reads the store; it goes in the view state too,
   * since that copy is what Obsidian compares to drop an entry repeating the one
   * before it.
   */
  historyEntryFor(place: ReviewPlace): WorkspaceLeafHistoryState {
    const title =
      this.itemFileOn(place.page)?.basename ?? REVIEW_VIEW_DEFAULT_TITLE;
    return {
      title,
      icon: this.getIcon(),
      state: { ...this.leaf.getViewState(), title },
      eState: placeToEphemeralState(place),
    };
  }

  /**
   * Obsidian snapshots this for the entry it records when the tab navigates to
   * another view, and for the current place when back or forward leaves it —
   * which is what brings review back to its page and item on the return trip.
   *
   * Not for a tab being closed. Obsidian snapshots that too, for reopening the
   * tab, and hands it back the same way; but a reopened tab resumes like a
   * restored one (see {@link resumeUnclaimedSession}), and a place carried over
   * would overrule it — putting a tab closed on the home screen back there
   * despite the setting to skip it. `WorkspaceLeaf.detach` takes the leaf out of
   * its parent before snapshotting, and nothing else snapshots a detached leaf.
   */
  getEphemeralState(): Record<string, unknown> {
    const eState = super.getEphemeralState();
    if (!this.leaf.parent) return eState;
    return {
      ...eState,
      ...placeToEphemeralState(placeOf(this.plugin.store.getState())),
    };
  }

  /**
   * Return to the place a history entry names, when it names one. Everything
   * else Obsidian passes here — a link's `subpath`, `focusLeaf`'s `{ focus }` —
   * means nothing to review.
   */
  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const place = readPlace(state);
    if (place) this.goToPlace(place);
  }

  /**
   * Put review on `place` without recording the move: it is a move through
   * history, which Obsidian has already accounted for.
   *
   * Only the store moves. The item query, the cache eviction, the view's `file`
   * and title, and the session tracker all follow the store, exactly as they do
   * when an item is picked from the queue — so no path back gets to leave them
   * disagreeing with it.
   */
  goToPlace(place: ReviewPlace): void {
    const { store } = this.plugin;
    this.#lastRecorded = null;
    this.#applyingHistory = true;
    try {
      for (const action of actionsToReach(store.getState(), place)) {
        store.dispatch(action);
      }
    } finally {
      this.#applyingHistory = false;
    }
    if (place.itemId !== null) void this.leaveIfGone(place.itemId);
  }

  /**
   * Move review on to the next item when the one history brought it back to no
   * longer exists, as deleting an item in review does. History outlives items:
   * one deleted since it was recorded would otherwise sit in review as an empty
   * pane.
   *
   * Unless review has already moved off it by the time the lookup returns.
   */
  async leaveIfGone(itemId: string): Promise<void> {
    const item = await this.#reviewManager.getReviewItemFromId(itemId);
    if (item) return;
    const { store } = this.plugin;
    if (store.getState().currentItemId !== itemId) return;
    this.#applyingHistory = true;
    try {
      store.dispatch(resetCurrentItem());
    } finally {
      this.#applyingHistory = false;
    }
  }

  /**
   * `FileView.setState` loads the file the state names, and here that file is
   * not the view's to choose: it follows the item in the store, through
   * {@link setFile}. A file loaded from a history entry or the saved layout
   * overrides that until the item's file next changes — which never comes when
   * the entry is the home screen, left with some other item's file still loaded
   * — and the tab then names one item while showing another.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    // Spreading `null` gives `{}`; spreading a string would give its characters.
    const rest: Record<string, unknown> =
      typeof state === 'object' ? { ...state } : {};
    delete rest.file;
    await super.setState(rest, result);
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
   * Switch the review editor between raw markdown and live preview.
   *
   * Two halves, because the flag outlives any one editor: the tab remembers the
   * choice for the editors items still to come, and the editor on screen is
   * switched in place. `toggleSource` is Obsidian's own switch, and reads the
   * editor's own flag rather than this one, so it is called rather than handed
   * a value — exactly as `MarkdownView.setState` does it.
   */
  toggleSourceMode(): void {
    this.sourceMode = !this.sourceMode;
    this.reviewEditor()?.toggleSource();
  }

  /**
   * The review editor on screen, or `null` when the page has none — the home
   * screen, the queue, and a card still asking its question, which is rendered
   * markdown rather than an editor.
   *
   * `activeEditor` is the controller `IREditor` publishes when it mounts and
   * drops when it unmounts, so it tracks exactly that.
   */
  reviewEditor(): MarkdownEditView | null {
    return this.activeEditor?.editMode ?? null;
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
   * Says nothing when `learn` opened the tab: it settles both the item and the
   * page before the view mounts, so {@link IncrementalReadingPlugin.resumeSession}
   * reports nothing left to resume and every branch below agrees with what it
   * already chose.
   */
  async resumeUnclaimedSession(): Promise<void> {
    if (this.initialItem) return;
    if (await this.plugin.resumeSession()) {
      this.plugin.store.dispatch(setPage('review'));
      return;
    }
    // Nothing to come back to, so this is review opening with nothing in
    // progress — the case the home-screen setting is about. `learn` applies it
    // to the tabs it opens; these mounts have nobody else to.
    if (!this.plugin.settings.skipHomeScreen) return;
    // Not while another review tab is up: the page is one shared store, so this
    // would move that tab too, off whatever it was already showing.
    if (!this.isOnlyReviewTab()) return;
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

    this.registerEvent(
      this.leaf.on('history-change', () => this.refreshMobileNavbar())
    );
    this.#open = true;
  }

  /**
   * Bring the mobile navbar's back and forward buttons up to date with the
   * active tab's history.
   *
   * The navbar re-reads history only on `active-leaf-change`, which a markdown
   * tab raises each time it loads a file. Review raises it for none of the moves
   * it records — the file stays the same between the home screen and an item, and
   * is never loaded by Obsidian otherwise — nor when back and forward move between
   * its own entries, so without this the buttons stay greyed out over a history
   * they could walk. The navbar exists only on mobile.
   */
  refreshMobileNavbar(): void {
    this.app.mobileNavbar?.onLeafChange();
  }

  /**
   * Whether this is the only review tab there is — the one whose close ends the
   * review session, and the only one free to choose the page on the way in.
   *
   * Asked because the session is one shared store, not a thing each tab owns: a
   * split view is two `ReviewView`s over the same state, and `resetSession`
   * from either of them empties it for both. Works whichever side of the
   * workspace's own bookkeeping this runs on — a leaf already dropped, or one
   * whose view is still being constructed, is simply not among those counted,
   * and either way leaves this tab alone in the answer.
   */
  isOnlyReviewTab(): boolean {
    return this.app.workspace
      .getLeavesOfType(ReviewView.viewType)
      .every((leaf) => leaf === this.leaf);
  }

  async onClose() {
    this.#open = false;
    await super.onClose();
    render(null, this.contentEl);
    this.activeEditor = null;
    this.#lastFocusedEl = null;
    // Another review tab is still open and still on its item: the session
    // belongs to it now, and ending it here would send that tab back to the
    // home screen and drop what it was reading.
    if (!this.isOnlyReviewTab()) return;
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

    // Obsidian adds this entry only while a markdown tab is editing, and leaves
    // it out in reading view, where there is no editor for it to act on. The
    // same condition here is an editor being mounted: a card still asking its
    // question is rendered markdown, not an editor, and the entry would do
    // nothing visible. Title, icon and section are Obsidian's own, so the
    // review tab's entry reads as the one users already know.
    if (this.reviewEditor()) {
      menu.addItem((item) =>
        item
          .setTitle('Source mode')
          .setIcon('lucide-code-2')
          .setSection('pane')
          .setChecked(this.sourceMode)
          .onClick(() => {
            this.toggleSourceMode();
          })
      );
    }

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
