import { isPdfView } from '#/lib/pdf/obsidian-pdf';
import type { NoteType } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import ReviewView from '#/views/ReviewView';
import {
  FileView,
  MarkdownView,
  type TFile,
  type View,
  type WorkspaceLeaf,
} from 'obsidian';
import {
  renderStandaloneActionBarDOM,
  ROWS_RELOADED_EVENT,
  type StandaloneActionBar,
} from './ActionBarExtension';

/**
 * Whether `view` is Obsidian's built-in PDF tab, as the PDF adapter (the one
 * place that knows Obsidian's PDF internals) tells it, narrowed to the
 * `FileView` it is.
 */
function isPdfFileView(view: View): view is FileView {
  return view instanceof FileView && isPdfView(view);
}

/** Where a leaf's bar goes, and whether the file it shows earns one. */
interface BarTarget {
  file: TFile;
  container: HTMLElement;
  /** The bar's own class, telling the two kinds of host apart. */
  className: string;
  /** Whether a file of the type looked up earns a bar here. */
  accepts: (type: NoteType | null) => boolean;
}

/**
 * The bar a leaf's current view would carry, or `null` for a view that never
 * carries one: a note outside reading mode (edit mode has its own CodeMirror
 * panel), a view with no file, anything that is neither a note nor a PDF.
 */
function targetOf(view: View): BarTarget | null {
  if (view instanceof MarkdownView) {
    const { file } = view;
    if (view.getMode() !== 'preview' || !file) return null;
    return {
      file,
      container: view.previewMode.containerEl,
      className: 'ir-reading-mode-bar',
      accepts: (type) => type !== null,
    };
  }
  if (isPdfFileView(view)) {
    const { file } = view;
    if (!file) return null;
    // `contentEl` is the `.view-content` Obsidian fills with `.pdf-toolbar`
    // and `.pdf-container` once pdf.js has loaded. Prepending puts the bar
    // above both, whether they are there yet or not; on mobile, styles.css
    // moves it to the bottom, as it does a note's. A PDF has no frontmatter,
    // so it is an item only by its row, and only articles are ever PDFs.
    return {
      file,
      container: view.contentEl,
      className: 'ir-pdf-leaf-bar',
      accepts: (type) => type === 'article',
    };
  }
  return null;
}

class LeafActionBarController {
  private barEl: HTMLElement | null = null;
  private mountedFile: TFile | null = null;
  private bar: StandaloneActionBar | null = null;
  /**
   * The newest sync, or `null` once disposed. A lookup that answers after a
   * newer sync started is stale (the leaf may show another file by now) and is
   * dropped, so the last sync decides however the lookups interleave.
   */
  private latestSync: object | null = null;
  /**
   * The row the note the leaf shows claims, if it claims one, and how to stop
   * watching it. A database write naming it can change what the note is with
   * the note untouched, so each batch of them re-checks the leaf.
   */
  private followed: { id: string; stop: () => void } | null = null;
  /**
   * Whether a sync has been asked to have the bar read its item again, and
   * none has got as far as the bar since. Kept here, not with the sync, so a
   * newer sync overtaking that one still has the bar look again.
   */
  private lookAgain = false;

  constructor(
    private readonly leaf: WorkspaceLeaf,
    private readonly plugin: IncrementalReadingPlugin
  ) {}

  /**
   * Put a bar on the leaf or take it off, as what it shows earns one.
   *
   * @param lookAgain whether a bar already on the leaf reads its item again:
   * after a database write that can change the item and leave the note's type
   * as it was (a tagged note is an article with its row or without it). A note
   * that has come to claim another id, as an import writes, has it read again
   * too: another row may hold it now.
   */
  async sync(lookAgain: boolean): Promise<void> {
    const thisSync = {};
    this.latestSync = thisSync;
    const target = targetOf(this.leaf.view);
    const items = this.plugin.reviewManager.articles;
    const claimed = target && items.typingRowId(target.file);
    const before = this.followed?.id ?? null;
    this.follow(claimed);
    if (lookAgain || claimed !== before) this.lookAgain = true;
    if (!target) {
      this.unmount();
      return;
    }
    let type: NoteType | null;
    try {
      // The item layer types a note by the row its `ir-id` names at its path
      // or else by its tags, a copy of an item's note as none, and a PDF by
      // the row at its path
      type = await items.getItemType(target.file);
    } catch (error) {
      // A note whose frontmatter won't parse, say: no type, so no bar
      console.error(
        'Failed to look up the item type for the action bar',
        error
      );
      type = null;
    }
    if (this.latestSync !== thisSync) return;
    if (target.accepts(type)) this.mount(target);
    else this.unmount();
  }

  /**
   * Watch row `id` (see `ItemManager.typingRowId`), or none for `null`,
   * letting go of any other.
   */
  private follow(id: string | null): void {
    if (this.followed?.id === id) return;
    this.followed?.stop();
    this.followed = null;
    if (id === null) return;
    const stop = this.plugin.reviewManager.articles.watchRow(
      id,
      () => void this.sync(true)
    );
    this.followed = { id, stop };
  }

  /** Whether the leaf shows a PDF, typed by the row at its path. */
  showsPdf(): boolean {
    return isPdfFileView(this.leaf.view);
  }

  /** Whether the leaf shows `file`, as a note or a PDF. */
  shows(file: TFile): boolean {
    const { view } = this.leaf;
    return view instanceof FileView && view.file === file;
  }

  private mount({ file, container, className }: BarTarget): void {
    if (
      this.barEl &&
      this.mountedFile === file &&
      container.contains(this.barEl)
    ) {
      if (this.lookAgain) this.bar?.refresh();
      this.lookAgain = false;
      return;
    }
    // A bar built afresh reads its item anyway
    this.unmount();
    const bar = createDiv();
    bar.className = `ir-action-bar ir-action-bar-panel ${className}`;
    this.bar = renderStandaloneActionBarDOM(file, this.plugin, bar);
    container.prepend(bar);
    this.barEl = bar;
    this.mountedFile = file;
  }

  private unmount(): void {
    this.bar?.dispose();
    this.bar = null;
    this.lookAgain = false;
    this.barEl?.remove();
    this.barEl = null;
    this.mountedFile = null;
  }

  /** Removes the bar for good, and any lookup still pending with it. */
  dispose(): void {
    this.latestSync = null;
    this.follow(null);
    this.unmount();
  }
}

/**
 * Keeps a standalone action bar on every leaf showing an item outside review:
 * notes in reading mode, and PDFs that are articles.
 *
 * A note claiming an id is what its row makes it, tags aside, and its leaf
 * watches that row alone while it shows one (see `ItemManager.typingRowId`):
 * a note claiming no id watches nothing.
 *
 * @returns a function that re-checks every leaf, for a database swapped in
 * from disk, which replaces the rows without reporting any change to them,
 * and tells the edit-mode bars to look again too ({@link ROWS_RELOADED_EVENT})
 */
export function registerReadingModeActionBar(
  plugin: IncrementalReadingPlugin
): () => void {
  const controllers = new Map<WorkspaceLeaf, LeafActionBarController>();

  /** Set once the plugin unloads, after which nothing is mounted again. */
  let unloaded = false;

  /**
   * Re-checks the leaves `include` picks and drops the controllers of leaves
   * that have closed. A note's type is read from disk, so the rest are left
   * alone when their answer can't have changed. With `lookAgain`, the bars
   * already up read their items again too (see `LeafActionBarController.sync`).
   */
  const syncLeaves = (
    include: (ctrl: LeafActionBarController) => boolean,
    lookAgain = false
  ) => {
    if (unloaded) return;
    const liveLeaves = new Set<WorkspaceLeaf>();
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() === ReviewView.viewType) return;
      liveLeaves.add(leaf);
      let ctrl = controllers.get(leaf);
      if (!ctrl) {
        ctrl = new LeafActionBarController(leaf, plugin);
        controllers.set(leaf, ctrl);
      }
      if (include(ctrl)) void ctrl.sync(lookAgain);
    });
    for (const [leaf, ctrl] of controllers) {
      if (!liveLeaves.has(leaf)) {
        ctrl.dispose();
        controllers.delete(leaf);
      }
    }
  };
  const syncAll = () => syncLeaves(() => true);

  /**
   * Switching tabs fires `active-leaf-change` and `file-open` back to back,
   * and opening a file adds `layout-change`: one sweep covers the lot.
   */
  let sweepQueued = false;
  const queueSyncAll = () => {
    if (sweepQueued) return;
    sweepQueued = true;
    queueMicrotask(() => {
      sweepQueued = false;
      syncAll();
    });
  };

  const { workspace } = plugin.app;
  plugin.registerEvent(workspace.on('layout-change', queueSyncAll));
  // Opening another file in the same leaf fires no `layout-change`
  plugin.registerEvent(workspace.on('file-open', queueSyncAll));
  plugin.registerEvent(workspace.on('active-leaf-change', queueSyncAll));
  // A PDF is an article only by its row, which a rename or an import settles
  // after the workspace events for it have fired, and its bar reads the item
  // again on each write, as one may have dismissed or restored it. A note
  // claiming an id watches that row from its controller.
  const unsubscribe = plugin.reviewManager.repo.onDataChange(() =>
    syncLeaves((ctrl) => ctrl.showsPdf(), true)
  );
  // A note's type is in its frontmatter, and importing a note in place gives
  // it an `ir-id` through the cache with no workspace event, so the bar of a
  // note open in reading mode would otherwise wait for an unrelated one. It
  // costs one type lookup per save for the leaves showing that file, and
  // `mount` is a no-op for the file already mounted.
  plugin.registerEvent(
    plugin.app.metadataCache.on('changed', (file) =>
      syncLeaves((ctrl) => ctrl.shows(file))
    )
  );
  plugin.register(() => {
    unloaded = true;
    unsubscribe();
    controllers.forEach((c) => c.dispose());
    controllers.clear();
  });
  syncAll();
  return () => {
    // Any row may have changed, the items of the bars up included
    syncLeaves(() => true, true);
    // Edit-mode bars are CodeMirror's, out of reach here: they hear it
    workspace.trigger(ROWS_RELOADED_EVENT);
  };
}
