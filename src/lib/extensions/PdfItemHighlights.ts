import { CARD_TAG } from '#/lib/constants';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { isPdfView, pdfTabSelection } from '#/lib/pdf/obsidian-pdf';
import { createPdfHighlightHover } from '#/lib/pdf/pdf-highlight-hover';
import {
  createPdfHighlightLayer,
  highlightUnder,
  type PdfHighlight,
} from '#/lib/pdf/pdf-highlights';
import type { SnippetHighlight } from '#/lib/SnippetOffsetTracker';
import type IncrementalReadingPlugin from '#/main';
import { FileView, type TFile, type WorkspaceLeaf } from 'obsidian';
import {
  MIDDLE_MOUSE_BUTTON,
  openHighlightFromEvent,
} from './SnippetHighlightExtension';

function toPdfHighlight(highlight: SnippetHighlight): PdfHighlight {
  return {
    ref: highlight.reference,
    kind: 'snippet',
    start: highlight.start_offset,
    end: highlight.end_offset,
  };
}

function sameHighlights(
  a: readonly PdfHighlight[],
  b: readonly PdfHighlight[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (h, i) =>
        h.ref === b[i].ref &&
        h.kind === b[i].kind &&
        h.start === b[i].start &&
        h.end === b[i].end
    )
  );
}

/**
 * `read`, run one at a time, then `done`: calls made while one is under way,
 * as a bulk write makes many, call for one more after it, not one each. A
 * read that fails is logged, and `done` follows all the same.
 */
function oneAtATime(
  read: () => Promise<void>,
  done: () => void,
  stopped: () => boolean
): () => Promise<void> {
  let reading = false;
  let readAgain = false;
  return async () => {
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    do {
      readAgain = false;
      try {
        await read();
      } catch (error) {
        console.warn('Incremental Reading: PDF highlights not read', error);
      }
    } while (readAgain && !stopped());
    reading = false;
    done();
  };
}

/**
 * Open the snippet or card of the highlight a press in `containerEl` lands
 * on, as a markdown highlight does, in whichever window the viewer is: the plugin's
 * own handler covers only the main one. Returns what stops it.
 *
 * The highlights lie under the page's text layer and take no pointer events,
 * so a press on the text layer is looked up by where it is: on the topmost
 * highlight there, the innermost. So is one on the canvas, which is what a
 * press lands on while pdf.js hides the text layer through a zoom. A press on
 * a link or form field over the text, in pdf.js's annotation layer, is the
 * link's.
 *
 * A click that ends a drag selecting text opens nothing, and goes no further:
 * the text was selected to be extracted, maybe from inside a snippet or card.
 */
function openItemsOnPress(
  plugin: IncrementalReadingPlugin,
  containerEl: HTMLElement
): () => void {
  const highlightOf = (evt: MouseEvent) =>
    highlightUnder(evt.target as Element, evt.clientX, evt.clientY);
  const onClick = (evt: MouseEvent) => {
    const highlight = highlightOf(evt);
    if (!highlight) return;
    if (!containerEl.ownerDocument.getSelection()!.isCollapsed) {
      evt.stopPropagation();
      return;
    }
    openHighlightFromEvent(plugin, evt, highlight);
  };
  // A middle click fires `auxclick`; a right click does too, for the menu
  const onAuxClick = (evt: MouseEvent) => {
    if (evt.button === MIDDLE_MOUSE_BUTTON) onClick(evt);
  };
  // A middle press scrolls on Windows and pastes on Linux
  const onMouseDown = (evt: MouseEvent) => {
    if (evt.button === MIDDLE_MOUSE_BUTTON && highlightOf(evt)) {
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
 * `file` that snippets were extracted from (task 0023) and cards were made
 * from (task 0041). A click on one opens its snippet or card (see
 * {@link openItemsOnPress}). Returns what stops it and takes the highlights
 * off.
 *
 * The snippets are read from the database at once and whenever a snippet row
 * changes, which covers one being made, reviewed, dismissed or deleted with
 * its note. Undoing a snippet deletes its row outright, which the repository
 * reports no change for, and a database swapped in from disk reports none
 * either: both take it out of the offset tracker and say so with
 * `ir-highlights-changed`, and then the tracker's copy is shown.
 *
 * The cards are read likewise (`CardManager.getPdfHighlights`), at once,
 * whenever a card row changes, and on `ir-highlights-changed`. A PDF never
 * changes under them, so no tracker keeps them. Their selections are in their
 * notes' `source` links, so they are read again too when the metadata cache
 * has a card note changed that is shown, or that now links to `file`: an
 * edited link moves or drops its card's highlight.
 */
export function showPdfItemHighlights(
  plugin: IncrementalReadingPlugin,
  file: TFile,
  containerEl: HTMLElement
): () => void {
  const { reviewManager } = plugin;
  const { workspace, metadataCache } = plugin.app;
  const tracker = reviewManager.snippets.offsetTracker;
  const layer = createPdfHighlightLayer(
    containerEl,
    createPdfHighlightHover(containerEl)
  );
  const stopOpening = openItemsOnPress(plugin, containerEl);
  let stopped = false;
  let cards: readonly PdfHighlight[] = [];
  let shown: readonly PdfHighlight[] = [];

  const show = () => {
    if (stopped) return;
    const next = [
      ...tracker.getHighlights(file.path).map(toPdfHighlight),
      ...cards,
    ];
    // A review updates its card's row at each grade, which changes nothing
    // here
    if (sameHighlights(next, shown)) return;
    shown = next;
    layer.set(next);
  };

  const isStopped = () => stopped;
  const readSnippets = oneAtATime(
    async () => {
      await reviewManager.getSnippetHighlights(file);
    },
    show,
    isStopped
  );
  const readCards = oneAtATime(
    async () => {
      cards = await reviewManager.cards.getPdfHighlights(file);
    },
    show,
    isStopped
  );

  /** Whether `note` is a card note whose `source` link resolves to `file`. */
  const linksHere = (note: TFile) =>
    Obsidian.getFrontMatter(note, plugin.app)?.tags?.includes(CARD_TAG) &&
    Obsidian.sourceIs(note, file, plugin.app);

  const unsubscribe = reviewManager.repo.onDataChange((event) => {
    if (event.table === 'snippet') void readSnippets();
    if (event.table === 'card') void readCards();
  });
  const changedRef = workspace.on(
    'ir-highlights-changed',
    (...args: unknown[]) => {
      if (args[0] !== file.path) return;
      show();
      void readCards();
    }
  );
  const metadataRef = metadataCache.on('changed', (note) => {
    if (cards.some(({ ref }) => ref === note.path) || linksHere(note)) {
      void readCards();
    }
  });
  void readSnippets();
  void readCards();

  return () => {
    stopped = true;
    unsubscribe();
    workspace.offref(changedRef);
    metadataCache.offref(metadataRef);
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
 * Keep snippet and card highlights on every one of Obsidian's own PDF tabs,
 * as {@link showPdfItemHighlights} does in review: an article's snippets and
 * cards, or for a PDF that is no article, the parentless ones taken from it.
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
        stop: showPdfItemHighlights(plugin, file, pdfView.contentEl),
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
