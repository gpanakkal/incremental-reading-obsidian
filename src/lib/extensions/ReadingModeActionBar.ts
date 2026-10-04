import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
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
import { renderStandaloneActionBarDOM } from './ActionBarExtension';

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
  /** The file's item type, looked up wherever this kind of file keeps it. */
  lookUpType: () => Promise<NoteType | null>;
  /** Whether a file of the type looked up earns a bar here. */
  accepts: (type: NoteType | null) => boolean;
}

/**
 * The bar a leaf's current view would carry, or `null` for a view that never
 * carries one: a note outside reading mode (edit mode has its own CodeMirror
 * panel), a view with no file, anything that is neither a note nor a PDF.
 */
function targetOf(
  view: View,
  plugin: IncrementalReadingPlugin
): BarTarget | null {
  if (view instanceof MarkdownView) {
    const { file } = view;
    if (view.getMode() !== 'preview' || !file) return null;
    return {
      file,
      container: view.previewMode.containerEl,
      className: 'ir-reading-mode-bar',
      lookUpType: () => ObsidianHelpers.getNoteType(file, plugin.app),
      accepts: (type) => type !== null,
    };
  }
  if (isPdfFileView(view)) {
    const { file } = view;
    if (!file) return null;
    // `contentEl` is the `.view-content` Obsidian fills with `.pdf-toolbar`
    // and `.pdf-container` once pdf.js has loaded. Prepending puts the bar
    // above both, whether they are there yet or not. A PDF has no frontmatter,
    // so it is an item only by its row, and only articles are ever PDFs.
    return {
      file,
      container: view.contentEl,
      className: 'ir-pdf-leaf-bar',
      lookUpType: () => plugin.reviewManager.articles.getItemType(file),
      accepts: (type) => type === 'article',
    };
  }
  return null;
}

class LeafActionBarController {
  private barEl: HTMLElement | null = null;
  private mountedFile: TFile | null = null;
  private teardown: (() => void) | null = null;
  /**
   * The newest sync, or `null` once disposed. A lookup that answers after a
   * newer sync started is stale (the leaf may show another file by now) and is
   * dropped, so the last sync decides however the lookups interleave.
   */
  private latestSync: object | null = null;

  constructor(
    private readonly leaf: WorkspaceLeaf,
    private readonly plugin: IncrementalReadingPlugin
  ) {}

  async sync(): Promise<void> {
    const thisSync = {};
    this.latestSync = thisSync;
    const target = targetOf(this.leaf.view, this.plugin);
    if (!target) {
      this.unmount();
      return;
    }
    let type: NoteType | null;
    try {
      type = await target.lookUpType();
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

  /** Whether the leaf shows a PDF, the only kind of view typed by its row. */
  showsPdf(): boolean {
    return isPdfFileView(this.leaf.view);
  }

  private mount({ file, container, className }: BarTarget): void {
    if (
      this.barEl &&
      this.mountedFile === file &&
      container.contains(this.barEl)
    ) {
      return;
    }
    this.unmount();
    const bar = createDiv();
    bar.className = `ir-action-bar ir-action-bar-panel ${className}`;
    this.teardown = renderStandaloneActionBarDOM(file, this.plugin, bar);
    container.prepend(bar);
    this.barEl = bar;
    this.mountedFile = file;
  }

  private unmount(): void {
    this.teardown?.();
    this.teardown = null;
    this.barEl?.remove();
    this.barEl = null;
    this.mountedFile = null;
  }

  /** Removes the bar for good, and any lookup still pending with it. */
  dispose(): void {
    this.latestSync = null;
    this.unmount();
  }
}

/**
 * Keeps a standalone action bar on every leaf showing an item outside review:
 * notes in reading mode, and PDFs that are articles.
 *
 * @returns a function that re-checks every leaf, for a database swapped in
 * from disk, which replaces the rows without reporting any change to them
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
   * alone when their answer can't have changed.
   */
  const syncLeaves = (include: (ctrl: LeafActionBarController) => boolean) => {
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
      if (include(ctrl)) void ctrl.sync();
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
  // after the workspace events for it have fired. A note's type is in its
  // frontmatter, which no database write changes.
  const unsubscribe = plugin.reviewManager.repo.onDataChange(() =>
    syncLeaves((ctrl) => ctrl.showsPdf())
  );
  plugin.register(() => {
    unloaded = true;
    unsubscribe();
    controllers.forEach((c) => c.dispose());
    controllers.clear();
  });
  syncAll();
  return syncAll;
}
