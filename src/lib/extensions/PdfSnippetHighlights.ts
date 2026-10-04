import { isPdfView, pdfTabSelection } from '#/lib/pdf/obsidian-pdf';
import {
  createPdfHighlightLayer,
  HIGHLIGHT_CLASS,
  type PdfHighlight,
} from '#/lib/pdf/pdf-highlights';
import type { SnippetHighlight } from '#/lib/SnippetOffsetTracker';
import type IncrementalReadingPlugin from '#/main';
import { FileView, type TFile, type WorkspaceLeaf } from 'obsidian';
import {
  MIDDLE_MOUSE_BUTTON,
  openSnippetFromEvent,
} from './SnippetHighlightExtension';

function toPdfHighlight(highlight: SnippetHighlight): PdfHighlight {
  return {
    ref: highlight.reference,
    start: highlight.start_offset,
    end: highlight.end_offset,
  };
}

/**
 * Open the snippet of the highlight a press in `containerEl` lands on, as a
 * markdown highlight does, in whichever window the viewer is: the plugin's
 * own handler covers only the main one. Returns what stops it.
 *
 * A click that ends a drag selecting text opens nothing, and goes no further:
 * the text was selected to be extracted, maybe from inside a snippet.
 */
function openSnippetsOnPress(
  plugin: IncrementalReadingPlugin,
  containerEl: HTMLElement
): () => void {
  const onHighlight = (evt: MouseEvent) =>
    (evt.target as Element).closest(`.${HIGHLIGHT_CLASS}`) !== null;
  const onClick = (evt: MouseEvent) => {
    if (!onHighlight(evt)) return;
    if (!containerEl.ownerDocument.getSelection()!.isCollapsed) {
      evt.stopPropagation();
      return;
    }
    openSnippetFromEvent(plugin, evt);
  };
  // A middle click fires `auxclick`; a right click does too, for the menu
  const onAuxClick = (evt: MouseEvent) => {
    if (evt.button === MIDDLE_MOUSE_BUTTON) onClick(evt);
  };
  // A middle press scrolls on Windows and pastes on Linux
  const onMouseDown = (evt: MouseEvent) => {
    if (evt.button === MIDDLE_MOUSE_BUTTON && onHighlight(evt)) {
      evt.preventDefault();
    }
  };
  containerEl.addEventListener('click', onClick);
  containerEl.addEventListener('auxclick', onAuxClick);
  containerEl.addEventListener('mousedown', onMouseDown);
  return () => {
    containerEl.removeEventListener('click', onClick);
    containerEl.removeEventListener('auxclick', onAuxClick);
    containerEl.removeEventListener('mousedown', onMouseDown);
  };
}

/**
 * Highlight, in the PDF viewer in `containerEl`, the passages of the PDF
 * `file` that snippets were extracted from (task 0023). A click on one opens
 * its snippet (see {@link openSnippetsOnPress}). Returns what stops it and
 * takes the highlights off.
 *
 * The snippets are read from the database at once and whenever a snippet row
 * changes, which covers one being made, reviewed, dismissed or deleted with
 * its note. Undoing a snippet deletes its row outright, which the repository
 * reports no change for, and a database swapped in from disk reports none
 * either: both take it out of the offset tracker and say so with
 * `ir-highlights-changed`, and then the tracker's copy is shown.
 */
export function showPdfSnippetHighlights(
  plugin: IncrementalReadingPlugin,
  file: TFile,
  containerEl: HTMLElement
): () => void {
  const { reviewManager } = plugin;
  const { workspace } = plugin.app;
  const tracker = reviewManager.snippets.offsetTracker;
  const layer = createPdfHighlightLayer(containerEl);
  const stopOpening = openSnippetsOnPress(plugin, containerEl);
  let stopped = false;

  const show = () => {
    if (stopped) return;
    layer.set(tracker.getHighlights(file.path).map(toPdfHighlight));
  };

  // One read at a time: changes made while one is under way, as a bulk write
  // makes many, call for one more after it, not one each
  let reading = false;
  let readAgain = false;
  const read = async () => {
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    do {
      readAgain = false;
      try {
        await reviewManager.getSnippetHighlights(file);
      } catch (error) {
        console.warn('Incremental Reading: PDF highlights not read', error);
      }
    } while (readAgain && !stopped);
    reading = false;
    show();
  };

  const unsubscribe = reviewManager.repo.onDataChange((event) => {
    if (event.table === 'snippet') void read();
  });
  const changedRef = workspace.on(
    'ir-highlights-changed',
    (...args: unknown[]) => {
      if (args[0] === file.path) show();
    }
  );
  void read();

  return () => {
    stopped = true;
    unsubscribe();
    workspace.offref(changedRef);
    stopOpening();
    layer.destroy();
  };
}

/** What a PDF tab's highlights are kept for: its file, and what stops them. */
interface LeafHighlights {
  file: TFile;
  stop: () => void;
}

/**
 * Keep snippet highlights on every one of Obsidian's own PDF tabs, as
 * {@link showPdfSnippetHighlights} does in review: an article's snippets, or
 * for a PDF that is no article, the parentless ones taken from it.
 *
 * Also follows the selection in each of them, from when it is first found,
 * for the snippet and card commands: picking one from the palette, or a tap
 * on mobile, moves the browser's selection out of the PDF before the command
 * runs. Asked again, a tab's is the same one; it stops once the tab closes.
 */
export function registerPdfLeafHighlights(
  plugin: IncrementalReadingPlugin
): void {
  const shown = new Map<WorkspaceLeaf, LeafHighlights>();
  let unloaded = false;

  const sync = () => {
    if (unloaded) return;
    const live = new Set<WorkspaceLeaf>();
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      const { view } = leaf;
      const pdfView = view instanceof FileView && isPdfView(view) ? view : null;
      const file = pdfView?.file;
      // Let go of below, with closed tabs
      if (!pdfView || !file) return;
      live.add(leaf);
      pdfTabSelection(pdfView);
      const current = shown.get(leaf);
      if (current?.file === file) return;
      current?.stop();
      // Undocumented: `PdfView.contentEl` holds Obsidian's viewer, and with it
      // every pdf.js page div, once loaded (plans/reference/obsidian-pdf-internals.md)
      shown.set(leaf, {
        file,
        stop: showPdfSnippetHighlights(plugin, file, pdfView.contentEl),
      });
    });
    for (const [leaf, { stop }] of shown) {
      if (live.has(leaf)) continue;
      stop();
      shown.delete(leaf);
    }
  };

  // Once the event's own work is done. Switching tabs fires several back to
  // back; a sweep that finds each tab as it was leaves it alone.
  const queueSync = () => queueMicrotask(sync);

  const { workspace } = plugin.app;
  plugin.registerEvent(workspace.on('layout-change', queueSync));
  // Opening another file in the same tab fires no `layout-change`
  plugin.registerEvent(workspace.on('file-open', queueSync));
  plugin.registerEvent(workspace.on('active-leaf-change', queueSync));
  plugin.register(() => {
    unloaded = true;
    shown.forEach(({ stop }) => stop());
    shown.clear();
  });
  sync();
}
