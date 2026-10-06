/**
 * Snippet and card highlights on a PDF's pages (tasks 0023, 0041, 0047):
 * which characters of which text items each snippet or card covers, and the
 * boxes that mark them.
 *
 * The boxes sit in an overlay of their own over each page's canvas, under its
 * text layer, positioned in percent of the page. pdf.js keeps the overlay
 * through a zoom and the page's size carries the boxes with it, so they stay
 * on screen and on their text while pdf.js hides and redraws the text layer.
 * Nothing of the plugin's goes into the text layer itself.
 */
import {
  type ItemSpan,
  itemSpansOnPage,
  MIN_ANCHOR,
  PAGE_SELECTOR,
  type PageItem,
} from './pdf-anchor';

/**
 * A snippet's or card's extent in its PDF, and the reference its highlight
 * opens.
 */
export interface PdfHighlight {
  /** Its note's path. A card's note is never a snippet's. */
  ref: string;
  kind: 'snippet' | 'card';
  /** Anchor of its first character. */
  start: number;
  /** Anchor just past its last character. */
  end: number;
}

/** The characters of one text item that one snippet or card covers. */
export interface HighlightRun extends ItemSpan {
  ref: string;
  kind: PdfHighlight['kind'];
}

/** Where a highlight of each kind goes among those over the very same text. */
const TIE_DEPTH = { snippet: 0, card: 1 } as const;

/**
 * Stacking order: a highlight that starts earlier goes under one that starts
 * later, a longer one under a shorter one, a snippet under a card over the
 * very same text, and otherwise the references decide (no two items share
 * one), so the same highlights always stack the same way.
 */
function outerFirst(a: PdfHighlight, b: PdfHighlight) {
  return (
    a.start - b.start ||
    b.end - a.end ||
    TIE_DEPTH[a.kind] - TIE_DEPTH[b.kind] ||
    (a.ref < b.ref ? -1 : 1)
  );
}

/**
 * Whether `highlight` may cover any character of `page`, whose anchors are
 * `[page * MIN_ANCHOR, (page + 1) * MIN_ANCHOR)`.
 */
function mayCoverPage(highlight: PdfHighlight, page: number) {
  return (
    highlight.start < (page + 1) * MIN_ANCHOR &&
    highlight.end > page * MIN_ANCHOR
  );
}

/**
 * What of `page`'s `items` each of `highlights` covers, one run per highlight
 * and item: the highlights outermost first (the bottom of the stack), each in
 * item order. Characters no highlight covers get no run.
 */
export function pageHighlightRuns(
  highlights: readonly PdfHighlight[],
  page: number,
  items: readonly PageItem[]
): HighlightRun[] {
  return highlights
    .filter((highlight) => mayCoverPage(highlight, page))
    .sort(outerFirst)
    .flatMap(({ ref, kind, start, end }) =>
      itemSpansOnPage({ start, end }, page, items).map((span) => ({
        ...span,
        ref,
        kind,
      }))
    );
}

/** A box on a page, in percent of the page's width and height. */
export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A rectangle on screen, as `getBoundingClientRect` and `getClientRects` give. */
export type ScreenRect = Pick<
  DOMRectReadOnly,
  'left' | 'top' | 'width' | 'height'
>;

/**
 * The box around every one of `rects` that has an area, in percent of
 * `frame`. Null when none has, or `frame` has no area: nothing laid out.
 * Text set at a slant gets the upright box around it, wider than its glyphs.
 */
export function boxAround(
  rects: readonly ScreenRect[],
  frame: ScreenRect
): PageBox | null {
  const solid = rects.filter(({ width, height }) => width > 0 && height > 0);
  if (solid.length === 0 || !(frame.width > 0 && frame.height > 0)) {
    return null;
  }
  const left = Math.min(...solid.map((rect) => rect.left));
  const top = Math.min(...solid.map((rect) => rect.top));
  const right = Math.max(...solid.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...solid.map((rect) => rect.top + rect.height));
  return {
    left: ((left - frame.left) / frame.width) * 100,
    top: ((top - frame.top) / frame.height) * 100,
    width: ((right - left) / frame.width) * 100,
    height: ((bottom - top) / frame.height) * 100,
  };
}

// #region PAGE DOM
// Obsidian's patched pdf.js 5.3 (undocumented; see pdf-anchor.ts and
// plans/reference/obsidian-pdf-internals.md): `div.page[data-page-number]`
// holds `div.canvasWrapper`, which holds the page's canvases, and after it
// `div.textLayer`, which holds the item spans. A zoom keeps both
// (`PDFPageView.update` resets with `keepCanvasWrapper` and `keepTextLayer`);
// pdf.js only prepends canvases to the wrapper and removes old ones, so a
// box overlay appended there stays, under the text layer. pdf.js hides the
// text layer with its `hidden` attribute from a zoom until the canvas is
// redrawn, and rebuilds it whole only when the page went far out of view.

/**
 * The class each highlight box carries, as a markdown highlight does: a
 * card's too, so one set of rules finds, paints and opens them all.
 */
export const HIGHLIGHT_CLASS = 'ir-snippet-highlight';
/** The class a card's highlight box carries as well, for its color. */
export const CARD_HIGHLIGHT_CLASS = 'ir-card-highlight';
/** The class of the overlay that holds a page's boxes. */
export const OVERLAY_CLASS = 'ir-pdf-highlights';
const REF_ATTR = 'data-snippet-ref';
const TEXT_LAYER_CLASS = 'textLayer';
const CANVAS_WRAPPER_CLASS = 'canvasWrapper';
/**
 * The attribute pdf.js keeps a text layer's rotation in. `setLayerDimensions`
 * sets it on every zoom, mostly to the value it had.
 */
const ROTATION_ATTR = 'data-main-rotation';

/** The text layer of the page div `pageEl`, if it has one. */
function textLayerOf(pageEl: Element) {
  return pageEl.querySelector<HTMLElement>(`.${TEXT_LAYER_CLASS}`);
}

/** The text nodes of `el`, in order. */
function textNodesIn(el: Element): Text[] {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/**
 * Where characters `start` to `end` of `item` are on screen. Obsidian's
 * subpath highlight and pdf.js find may have split its text into several
 * nodes, so each one's part is measured on its own: a range over a whole
 * child span would report the span's box as well.
 */
function rectsOfChars(item: Element, start: number, end: number) {
  const range = item.ownerDocument.createRange();
  const rects: ScreenRect[] = [];
  let from = 0;
  for (const node of textNodesIn(item)) {
    // This node's part of the run, if it holds any
    const first = Math.max(start - from, 0);
    const last = Math.min(end - from, node.length);
    from += node.length;
    if (first >= last) continue;
    range.setStart(node, first);
    range.setEnd(node, last);
    rects.push(...Array.from(range.getClientRects()));
  }
  return rects;
}

/** One box of `run`'s, at `box`, in the overlay's window. */
function makeBox(win: Window, run: HighlightRun, box: PageBox) {
  const el = win.createDiv({
    cls:
      run.kind === 'card'
        ? [HIGHLIGHT_CLASS, CARD_HIGHLIGHT_CLASS]
        : HIGHLIGHT_CLASS,
    attr: {
      [REF_ATTR]: run.ref,
      // Not `data-idx`, which marks pdf.js's text items
      'data-item': run.idx,
      'data-start': run.start,
      'data-end': run.end,
    },
  });
  el.style.left = `${box.left}%`;
  el.style.top = `${box.top}%`;
  el.style.width = `${box.width}%`;
  el.style.height = `${box.height}%`;
  return el;
}

/**
 * Make the page div `pageEl` show exactly what `highlights` cover: one box
 * per highlight and text item over the characters it covers ({@link
 * pageHighlightRuns}), in an overlay in the page's canvas wrapper, a card's
 * also `.ir-card-highlight`.
 *
 * The boxes are measured off the text layer, so that has to be shown and
 * laid out. A page none of `highlights` reaches loses its overlay without
 * being measured at all.
 *
 * @returns whether the page shows them now: false when its text layer, or
 *   its canvas wrapper, isn't there, is hidden or has no size, which leaves
 *   whatever it showed before.
 */
export function drawPageHighlights(
  pageEl: Element,
  highlights: readonly PdfHighlight[]
): boolean {
  const page = Number(pageEl.getAttribute('data-page-number'));
  const onPage = highlights.filter((h) => mayCoverPage(h, page));
  const existing = pageEl.querySelector(`.${OVERLAY_CLASS}`);
  // Most pages, of most PDFs, have none
  if (onPage.length === 0) {
    existing?.remove();
    return true;
  }
  const textLayer = textLayerOf(pageEl);
  const wrapper = pageEl.querySelector(`.${CANVAS_WRAPPER_CLASS}`);
  if (!textLayer || textLayer.hidden || !wrapper) return false;

  // A page is always in a window's document
  const win = pageEl.ownerDocument.defaultView!;
  const overlay =
    existing ??
    win.createDiv({ cls: OVERLAY_CLASS, attr: { 'aria-hidden': 'true' } });
  // After the canvases pdf.js prepends, so over them
  if (overlay.parentElement !== wrapper) wrapper.append(overlay);
  const frame = overlay.getBoundingClientRect();
  if (!(frame.width > 0 && frame.height > 0)) return false;

  const items = new Map(
    Array.from(textLayer.querySelectorAll('[data-idx]'), (el) => [
      Number(el.getAttribute('data-idx')),
      el,
    ])
  );
  const runs = pageHighlightRuns(
    onPage,
    page,
    Array.from(items, ([idx, el]) => ({ idx, length: el.textContent.length }))
  );
  const boxes: HTMLElement[] = [];
  for (const run of runs) {
    // Every run is of an item on the page
    const box = boxAround(
      rectsOfChars(items.get(run.idx)!, run.start, run.end),
      frame
    );
    if (box) boxes.push(makeBox(win, run, box));
  }
  overlay.replaceChildren(...boxes);
  return true;
}

/**
 * The highlight box on the page div `pageEl` that the point (`x`, `y`) on
 * screen is over, the topmost if several are: the innermost highlight.
 */
export function highlightAt(
  pageEl: Element,
  x: number,
  y: number
): Element | null {
  const boxes = pageEl.querySelectorAll(
    `.${OVERLAY_CLASS} > .${HIGHLIGHT_CLASS}`
  );
  for (let i = boxes.length - 1; i >= 0; i--) {
    const { left, top, right, bottom } = boxes[i].getBoundingClientRect();
    if (x >= left && x < right && y >= top && y < bottom) return boxes[i];
  }
  return null;
}

/**
 * The highlight box under the point (`x`, `y`) on screen ({@link
 * highlightAt}), where `el` is what the pointer is on there: only a page's
 * text layer or canvas wrapper, or something in one, has a highlight under
 * it. A link or form field over the text, in pdf.js's annotation layer, is
 * the link's.
 */
export function highlightUnder(
  el: Element | null,
  x: number,
  y: number
): Element | null {
  const pageEl = el
    ?.closest(`.${TEXT_LAYER_CLASS}, .${CANVAS_WRAPPER_CLASS}`)
    ?.closest(PAGE_SELECTOR);
  return pageEl ? highlightAt(pageEl, x, y) : null;
}

/** Whether `node` is pdf.js's `div.endOfContent`, one per text layer. */
function isEndOfContent(node: Node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).classList.contains('endOfContent')
  );
}

/**
 * Whether `record` only moves pdf.js's end-of-content marker. Undocumented:
 * its `selectionchange` handler (TextLayerBuilder) moves the marker on every
 * selection change in the window.
 */
function movesEndOfContent(record: MutationRecord) {
  return [...record.addedNodes, ...record.removedNodes].every(isEndOfContent);
}

/**
 * The pages whose text layer or canvas wrapper `node`, just added, is or
 * holds: a text layer rendered afresh, or a page drawn afresh, moved or put
 * back.
 */
function pagesBuiltIn(node: Node): Element[] {
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const layers =
    el.classList.contains(TEXT_LAYER_CLASS) ||
    el.classList.contains(CANVAS_WRAPPER_CLASS)
      ? [el]
      : Array.from(el.querySelectorAll(`.${TEXT_LAYER_CLASS}`));
  return layers.flatMap((layer) => layer.closest(PAGE_SELECTOR) ?? []);
}

// #endregion

/** Snippet highlights kept on a PDF viewer's pages, however it redraws them. */
export interface PdfHighlightLayer {
  /** Show `highlights` from now on, on the pages there now and any to come. */
  set(highlights: readonly PdfHighlight[]): void;
  /** Stop, and take every highlight off the pages. */
  destroy(): void;
}

/**
 * What a {@link createPdfHighlightLayer} tells of its boxes, for what follows
 * them on screen, such as the hover ring.
 */
export interface HighlightBoxWatcher {
  /** Called with true when the layer has boxes to show, and false when not. */
  enable(on: boolean): void;
  /**
   * Called when boxes may have changed under a pointer at rest: drawn afresh,
   * or moved with their page, as when pdf.js hides or shows a text layer for
   * a zoom.
   */
  refresh(): void;
}

/**
 * Keep `highlights` drawn on the pages of the PDF viewer in `containerEl`
 * (see {@link drawPageHighlights}), and tell `watcher` of them.
 *
 * The boxes are measured once per text layer pdf.js renders, and again when
 * the highlights change or a page turns. A zoom needs nothing: pdf.js keeps
 * both the text layer and the overlay, and the boxes scale with the page.
 * Rather than hook pdf.js's rendering, the layer watches the viewer's DOM for
 * a text layer or canvas wrapper put on a page, and for a text layer turned
 * or shown again. A page it can't measure yet, its text layer hidden or the
 * viewer not on screen, waits until the layer is shown or the viewer resized.
 * With no highlights at all, it watches nothing.
 */
export function createPdfHighlightLayer(
  containerEl: HTMLElement,
  watcher?: HighlightBoxWatcher
): PdfHighlightLayer {
  let highlights: readonly PdfHighlight[] = [];
  /** Pages to draw once they can be measured. */
  const pending = new Set<Element>();
  /**
   * Pages drawn on, attached or not: pdf.js takes page divs out of the
   * viewer, and may put them back as they are, overlay and all.
   */
  const drawnOn = new Set<Element>();
  let watching = false;

  /** {@link drawPageHighlights}, noting the page. */
  const draw = (pageEl: Element) => {
    drawnOn.add(pageEl);
    return drawPageHighlights(pageEl, highlights);
  };

  /** Draw the pages waiting to be, and say whether any was. */
  const drawPending = () => {
    let drew = false;
    for (const pageEl of pending) {
      if (!pageEl.isConnected) {
        pending.delete(pageEl);
      } else if (draw(pageEl)) {
        pending.delete(pageEl);
        drew = true;
      }
    }
    return drew;
  };

  const mutations = new MutationObserver((records) => {
    /** Whether pdf.js hid or showed a text layer: a zoom moved the boxes. */
    let moved = false;
    for (const record of records) {
      const target = record.target as Element;
      if (record.type === 'attributes') {
        moved ||=
          record.attributeName === 'hidden' &&
          target.classList.contains(TEXT_LAYER_CLASS);
        // Shown again: a pending page may be drawn now. A text layer turned:
        // measure anew. The annotation layer carries the attribute too
        if (
          record.attributeName === ROTATION_ATTR &&
          target.classList.contains(TEXT_LAYER_CLASS) &&
          record.oldValue !== target.getAttribute(ROTATION_ATTR)
        ) {
          const page = target.closest(PAGE_SELECTOR);
          if (page) pending.add(page);
        }
        continue;
      }
      // Obsidian's subpath highlight and pdf.js find rebuild an item's
      // content, which moves none of its text
      if (target.closest('[data-idx]')) continue;
      if (target.closest(`.${TEXT_LAYER_CLASS}`)) {
        if (movesEndOfContent(record)) continue;
        const page = target.closest(PAGE_SELECTOR);
        if (page) pending.add(page);
        continue;
      }
      // Canvases swapped on a redraw, the toolbar, the sidebar's thumbnails,
      // the overlay's own boxes: none puts a layer on a page
      record.addedNodes.forEach((node) =>
        pagesBuiltIn(node).forEach((page) => pending.add(page))
      );
    }
    if (drawPending() || moved) watcher?.refresh();
  });

  // Showing a hidden viewer takes it from no size to some size. A resize may
  // move the pages, boxes and all
  const Resize = window.ResizeObserver;
  const resizes =
    typeof Resize === 'function'
      ? new Resize(() => {
          drawPending();
          watcher?.refresh();
        })
      : null;

  const watch = (on: boolean) => {
    if (on === watching) return;
    watching = on;
    watcher?.enable(on);
    if (on) {
      mutations.observe(containerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', ROTATION_ATTR],
        attributeOldValue: true,
      });
      resizes?.observe(containerEl);
    } else {
      mutations.disconnect();
      resizes?.disconnect();
      pending.clear();
    }
  };

  const show = (next: readonly PdfHighlight[]) => {
    highlights = next;
    watch(next.length > 0);
    // A page out of the viewer may never come back, as when the PDF is
    // opened afresh: let it go, boxes and all. One put back is drawn as it
    // comes, while there are highlights to draw
    for (const page of drawnOn) {
      if (page.isConnected) continue;
      page.querySelector(`.${OVERLAY_CLASS}`)?.remove();
      drawnOn.delete(page);
    }
    const rendered = Array.from(
      containerEl.querySelectorAll(`.${TEXT_LAYER_CLASS}`),
      (layer) => layer.closest(PAGE_SELECTOR)
    ).filter((page) => page !== null);
    for (const page of new Set([...rendered, ...drawnOn])) {
      if (!draw(page)) pending.add(page);
    }
    watcher?.refresh();
  };

  return { set: show, destroy: () => show([]) };
}
