/**
 * Snippet and card highlights in a PDF's text layer (tasks 0023, 0041): which
 * characters of which text items each snippet or card covers, and the spans
 * that mark them.
 */
import {
  ITEM_SELECTOR,
  type ItemSpan,
  itemSpansOnPage,
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

/** A run of an item's characters that the same snippets and cards cover. */
export interface HighlightSegment extends ItemSpan {
  /** The covering items' references, outermost first. */
  refs: string[];
}

/** Where a highlight of each kind goes among those over the very same text. */
const TIE_DEPTH = { snippet: 0, card: 1 } as const;

/**
 * Nesting order: a highlight that starts earlier wraps one that starts later,
 * a longer one a shorter one, a snippet a card over the very same text, and
 * otherwise the references decide (no two items share one), so the same
 * highlights always nest the same way.
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
 * Split `page`'s `items` into the runs of characters that `highlights` cover,
 * each as long as the same set of snippets covers it: in item order, then in
 * text order. Characters no snippet covers get no segment.
 */
export function highlightSegments(
  highlights: readonly PdfHighlight[],
  page: number,
  items: readonly PageItem[]
): HighlightSegment[] {
  const nested = [...highlights].sort(outerFirst);
  const segments: HighlightSegment[] = [];
  for (const item of items) {
    const covers = nested.flatMap((highlight) =>
      itemSpansOnPage(highlight, page, [item]).map((span) => ({
        ref: highlight.ref,
        span,
      }))
    );
    const cuts = [
      ...new Set(covers.flatMap(({ span }) => [span.start, span.end])),
    ].sort((a, b) => a - b);
    cuts.slice(1).forEach((end, i) => {
      const start = cuts[i];
      const refs = covers
        .filter(({ span }) => span.start <= start && end <= span.end)
        .map(({ ref }) => ref);
      if (refs.length > 0) segments.push({ idx: item.idx, start, end, refs });
    });
  }
  return segments;
}

// #region TEXT LAYER DOM
// Obsidian's patched pdf.js 5.3 text layer (undocumented): see pdf-anchor.ts.
// An item span's text may already be split into text nodes and child spans by
// Obsidian's subpath highlight or pdf.js find, which rebuild the item's
// content whenever they change, dropping the spans painted here.

/**
 * The class a highlight span carries, as in markdown notes: a card's too, so
 * one set of rules finds, paints and opens them all.
 */
export const HIGHLIGHT_CLASS = 'ir-snippet-highlight';
/** The class a card's highlight span carries as well, for its color. */
export const CARD_HIGHLIGHT_CLASS = 'ir-card-highlight';
const REF_ATTR = 'data-snippet-ref';

function textNodesIn(el: Element): Text[] {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** The refs of the highlight spans around `node` inside `item`, outermost first. */
function refsAround(node: Node, item: Element): string[] {
  const refs: string[] = [];
  // `node` is in `item`, so the walk up ends there
  for (let el = node.parentElement!; el !== item; el = el.parentElement!) {
    if (el.classList.contains(HIGHLIGHT_CLASS)) {
      refs.unshift(el.getAttribute(REF_ATTR)!);
    }
  }
  return refs;
}

function sameRefs(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((ref, i) => ref === b[i]);
}

/** The runs `item`'s highlight spans mark now, as {@link highlightSegments} has them. */
function paintedSegments(item: Element, idx: number): HighlightSegment[] {
  const runs: HighlightSegment[] = [];
  let offset = 0;
  for (const node of textNodesIn(item)) {
    const { length } = node;
    const refs = refsAround(node, item);
    const last = runs[runs.length - 1];
    // A snippet's run is unbroken, so one whose snippets match the last's
    // carries it on
    if (last && sameRefs(last.refs, refs)) {
      last.end += length;
    } else if (refs.length > 0) {
      runs.push({ idx, start: offset, end: offset + length, refs });
    }
    offset += length;
  }
  return runs;
}

function sameSegments(a: HighlightSegment[], b: HighlightSegment[]) {
  return (
    a.length === b.length &&
    a.every(
      (seg, i) =>
        seg.start === b[i].start &&
        seg.end === b[i].end &&
        sameRefs(seg.refs, b[i].refs)
    )
  );
}

/** Take every highlight span out of `item`, keeping what they held. */
function unpaint(item: Element) {
  item
    .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    .forEach((span) => span.replaceWith(...Array.from(span.childNodes)));
  item.normalize();
}

/**
 * Whether every highlight span in `item` is marked as a card's exactly when
 * its ref is one of `cards`.
 */
function paintedKindsMatch(item: Element, cards: ReadonlySet<string>) {
  return Array.from(item.querySelectorAll(`.${HIGHLIGHT_CLASS}`)).every(
    (span) =>
      span.classList.contains(CARD_HIGHLIGHT_CLASS) ===
      cards.has(span.getAttribute(REF_ATTR)!)
  );
}

/**
 * Wrap characters `start` to `end` of `item` in nested spans, one per ref,
 * those of `cards` marked as a card's.
 */
function wrapRun(
  item: Element,
  { start, end, refs }: HighlightSegment,
  cards: ReadonlySet<string>
) {
  // A text layer is always in a window's document
  const win = item.ownerDocument.defaultView!;
  let offset = 0;
  for (let node of textNodesIn(item)) {
    const from = offset;
    offset += node.length;
    // `item` was normalized: no text node is empty
    if (offset <= start || from >= end) continue;
    if (start > from) node = node.splitText(start - from);
    const length = Math.min(end, offset) - Math.max(start, from);
    if (length < node.length) node.splitText(length);
    const [parent, next] = [node.parentNode!, node.nextSibling];
    let outer: Node = node;
    for (let i = refs.length - 1; i >= 0; i--) {
      // In the item's own window, which may be a popout. Not `doc.createSpan`:
      // Obsidian's `Node.createSpan` appends the span to the node it's called on
      const span = win.createSpan({
        cls: cards.has(refs[i])
          ? [HIGHLIGHT_CLASS, CARD_HIGHLIGHT_CLASS]
          : HIGHLIGHT_CLASS,
        attr: { [REF_ATTR]: refs[i] },
      });
      span.append(outer);
      outer = span;
    }
    parent.insertBefore(outer, next);
  }
}

/** The page's text item spans, by `data-idx`, and the items they hold. */
function pageItems(pageEl: Element) {
  return Array.from(pageEl.querySelectorAll(ITEM_SELECTOR), (el) => ({
    el,
    idx: Number(el.getAttribute('data-idx')),
    length: el.textContent.length,
  }));
}

/**
 * Make the text layer of the page div `pageEl` mark exactly what `highlights`
 * cover: each run of characters ({@link highlightSegments}) wrapped in one
 * `span.ir-snippet-highlight[data-snippet-ref]` per snippet or card over it,
 * outermost first, a card's also `.ir-card-highlight`.
 *
 * Only items whose marks differ are touched, so painting what is already
 * there changes nothing, and a selection in an item that keeps its marks
 * survives. The text is left as it is, so anchors read off the page, and
 * Obsidian's own selection links, come out the same.
 */
export function paintPageHighlights(
  pageEl: Element,
  highlights: readonly PdfHighlight[]
): void {
  const page = Number(pageEl.getAttribute('data-page-number'));
  const items = pageItems(pageEl);
  const wanted = highlightSegments(highlights, page, items);
  const cards = new Set(
    highlights.filter(({ kind }) => kind === 'card').map(({ ref }) => ref)
  );
  // Most pages, of most PDFs, have none to paint and none to take off
  if (wanted.length === 0 && !pageEl.querySelector(`.${HIGHLIGHT_CLASS}`)) {
    return;
  }
  for (const { el, idx } of items) {
    const want = wanted.filter((segment) => segment.idx === idx);
    if (
      sameSegments(paintedSegments(el, idx), want) &&
      paintedKindsMatch(el, cards)
    ) {
      continue;
    }
    unpaint(el);
    for (const segment of want) wrapRun(el, segment, cards);
  }
}

// #endregion

/** Whether `node` is pdf.js's `div.endOfContent`, one per text layer. */
function isEndOfContent(node: Node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).classList.contains('endOfContent')
  );
}

/** Whether `record` only moves pdf.js's end-of-content marker. */
function movesEndOfContent(record: MutationRecord) {
  return [...record.addedNodes, ...record.removedNodes].every(isEndOfContent);
}

/**
 * Put pdf.js's end-of-content marker beside the item it went into, where it
 * would have gone without a highlight.
 *
 * Undocumented: while text is selected, pdf.js's `selectionchange` handler
 * (TextLayerBuilder) puts the marker next to the element holding the
 * selection's focus, sized to cover the whole text layer, so a drag past the
 * text doesn't jump. When that element is a highlight, the marker lands inside
 * the item, which pdf.js positions on its own, and covers only part of the page.
 */
function keepOutOfItems(marker: Node) {
  const item = (marker as Element).parentElement?.closest(ITEM_SELECTOR);
  if (!item) return;
  // pdf.js puts it before the highlight a backward selection's focus is in,
  // and after the one a forward selection's is: the item's own place, in the
  // item's stead
  const { focusNode } = marker.ownerDocument!.getSelection()!;
  const next = marker.nextSibling;
  if (focusNode && next?.contains(focusNode)) item.before(marker);
  else item.after(marker);
}

/** Snippet highlights kept on a PDF viewer's pages, however it redraws them. */
export interface PdfHighlightLayer {
  /** Show `highlights` from now on, on the pages there now and any to come. */
  set(highlights: readonly PdfHighlight[]): void;
  /** Stop, and take every highlight off the pages. */
  destroy(): void;
}

/**
 * Keep `highlights` painted on the pages of the PDF viewer in `containerEl`
 * (see {@link paintPageHighlights}).
 *
 * pdf.js renders a page's text layer only as the page nears the view, drops
 * it when the page goes far, and rebuilds it on a zoom; Obsidian's subpath
 * highlight and pdf.js find rebuild an item's content, dropping the spans in
 * it. Rather than hook each of those (Obsidian's `clearTextHighlight` fires
 * no event at all), the layer watches the viewer's DOM and repaints a page
 * whenever its content changes. Its own changes are taken off the record, and
 * painting what is already there changes nothing, so it settles.
 */
export function createPdfHighlightLayer(
  containerEl: HTMLElement
): PdfHighlightLayer {
  let highlights: readonly PdfHighlight[] = [];
  const paint = (pages: Iterable<Element>) => {
    for (const pageEl of pages) paintPageHighlights(pageEl, highlights);
    // Its own changes: nothing for the observer to answer
    observer.takeRecords();
  };
  const allPages = () => containerEl.querySelectorAll(PAGE_SELECTOR);

  const observer = new MutationObserver((records) => {
    const pages = new Set<Element>();
    for (const record of records) {
      // pdf.js moves its marker on every selection change in the window
      if (movesEndOfContent(record)) {
        record.addedNodes.forEach(keepOutOfItems);
        continue;
      }
      // Only an element has children to change
      const page = (record.target as Element).closest(PAGE_SELECTOR);
      // A change above the pages may have added some
      if (!page) {
        paint(allPages());
        return;
      }
      pages.add(page);
    }
    paint(pages);
  });
  observer.observe(containerEl, { childList: true, subtree: true });

  // Undocumented: Obsidian's pdf.js snaps a drag begun beside the text by
  // setting the selection's start before the first item's `lastChild`, in a
  // `pointerup` listener on the viewer's container (TextLayerBuilder). That
  // was the item's start while its text was one node; a highlight leaves it
  // only the tail. Its own highlight is cleared on `pointerdown`, ours stays.
  const onPointerUp = () => {
    const selection = containerEl.ownerDocument.getSelection()!;
    // No range at all is collapsed too
    if (selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const { startContainer: start, startOffset } = range;
    if (
      start.nodeType === Node.ELEMENT_NODE &&
      (start as Element).matches(ITEM_SELECTOR) &&
      containerEl.contains(start) &&
      (start as Element).querySelector(`.${HIGHLIGHT_CLASS}`) &&
      startOffset === start.childNodes.length - 1
    ) {
      range.setStart(start, 0);
    }
  };
  containerEl.addEventListener('pointerup', onPointerUp);

  return {
    set(next) {
      highlights = next;
      paint(allPages());
    },
    destroy() {
      observer.disconnect();
      containerEl.removeEventListener('pointerup', onPointerUp);
      highlights = [];
      for (const pageEl of allPages()) paintPageHighlights(pageEl, []);
    },
  };
}
