/**
 * A position in a PDF's text, packed into one number that sorts in document
 * order: `page * 1e10 + idx * 1e5 + char`.
 */
export interface AnchorParts {
  /** 1-based page number, as in the page div's `data-page-number`. */
  page: number;
  /** The text item's `data-idx` in that page's text layer. */
  idx: number;
  /** UTF-16 offset into the item's text. */
  char: number;
}

/** How many values `char`, and likewise `idx`, can take. */
const SPAN = 1e5;

/** The highest page whose every anchor stays a safe integer. */
export const MAX_ANCHOR_PAGE = 900_718;

/** The least anchor there is: page 1's first character. */
export const MIN_ANCHOR = SPAN * SPAN;
const MAX_ANCHOR = ((MAX_ANCHOR_PAGE + 1) * SPAN - 1) * SPAN + SPAN - 1;

function inRange(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** @throws {RangeError} when a component lies outside what the codec holds. */
export function encodeAnchor({ page, idx, char }: AnchorParts): number {
  if (
    !inRange(page, 1, MAX_ANCHOR_PAGE) ||
    !inRange(idx, 0, SPAN - 1) ||
    !inRange(char, 0, SPAN - 1)
  ) {
    throw new RangeError(
      `PDF anchor out of range: page ${page}, idx ${idx}, char ${char}`
    );
  }
  return (page * SPAN + idx) * SPAN + char;
}

/** @throws {RangeError} when `anchor` isn't a number `encodeAnchor` returns. */
export function decodeAnchor(anchor: number): AnchorParts {
  if (!inRange(anchor, MIN_ANCHOR, MAX_ANCHOR)) {
    throw new RangeError(`Not a PDF anchor: ${anchor}`);
  }
  // Integer steps keep every intermediate value exact.
  const char = anchor % SPAN;
  const rest = (anchor - char) / SPAN;
  const idx = rest % SPAN;
  return { page: (rest - idx) / SPAN, idx, char };
}

/** Which end of a selection a DOM point is, which decides how it snaps. */
export type AnchorEdge = 'start' | 'end';

export interface AnchorRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/** A text item on a page: its `data-idx` and the length of its text. */
export interface PageItem {
  idx: number;
  /** UTF-16 length of the item's text. */
  length: number;
}

/** The characters `start` to `end` (exclusive) of the text item `idx`. */
export interface ItemSpan {
  idx: number;
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * The part of each of `page`'s `items` that `range` covers: the characters
 * whose anchors fall in it, in the order the items come. An item it doesn't
 * reach, one whose idx no anchor holds, and the characters of an item past
 * the most an anchor addresses get no span. `range` may start and end on
 * other pages, or be one no snippet has, starting at or after its end.
 */
export function itemSpansOnPage(
  range: AnchorRange,
  page: number,
  items: readonly PageItem[]
): ItemSpan[] {
  const spans: ItemSpan[] = [];
  for (const { idx, length } of items) {
    if (!inRange(idx, 0, SPAN - 1)) continue;
    const base = (page * SPAN + idx) * SPAN;
    const start = Math.max(Math.ceil(range.start - base), 0);
    const end = Math.min(Math.ceil(range.end - base), length, SPAN);
    if (start < end) spans.push({ idx, start, end });
  }
  return spans;
}

// Text layer DOM of Obsidian's patched pdf.js 5.3 (undocumented; its
// TextLayer#appendText): `div.page[data-page-number]` > `div.textLayer` >
// `span.textLayerNode[data-idx]`, possibly nested in `span.markedContent`, with
// a `<br role="presentation">` after each item that ends a line. `data-idx`
// counts every text item, but items with empty text get no span, so idx gaps
// are normal. Highlights split a span's text into child spans and text nodes.

export const PAGE_SELECTOR = '[data-page-number]';

/**
 * A text item's span on a page. Select on `data-idx` alone, which only these
 * spans carry: pdf.js find overwrites a middle match's class, dropping
 * `textLayerNode` while the match is shown.
 */
export const ITEM_SELECTOR = `${PAGE_SELECTOR} [data-idx]`;

function numberAttr(el: Element, name: string) {
  return Number(el.getAttribute(name));
}

/** The item span `node` sits in, if any. */
function enclosingItem(node: Node): Element | null {
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return el?.closest(ITEM_SELECTOR) ?? null;
}

/**
 * UTF-16 offset of the point (`node`, `offset`) within `item`'s text: the
 * text nodes Obsidian's `getTextSelectionRangeStr` counts. Unlike Obsidian, an
 * element's offset counts child nodes, not characters.
 */
function charOffset(item: Element, node: Node, offset: number) {
  const range = item.ownerDocument.createRange();
  range.setStart(item, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function itemAnchor(page: number, item: Element, char: number) {
  return encodeAnchor({ page, idx: numberAttr(item, 'data-idx'), char });
}

function itemStart(page: number, item: Element) {
  return itemAnchor(page, item, 0);
}

/** Every item span has text: pdf.js only renders items with some. */
function textLength(item: Element) {
  return item.textContent.length;
}

function itemEnd(page: number, item: Element) {
  return itemAnchor(page, item, textLength(item));
}

function pageOf(item: Element) {
  return numberAttr(item.closest(PAGE_SELECTOR)!, 'data-page-number');
}

/**
 * Maps a DOM boundary point on the page div `pageEl` to an anchor.
 *
 * A point inside an item span maps to that item. Anywhere else (a `<br>`, the
 * text layer div, a gap between spans, the page div) it snaps to the nearest
 * item on the page in document order: a start forward, an end backward. With
 * no item that way, it clamps to the page's last or first item instead.
 * Obsidian only snaps pointer selections; programmatic ranges arrive
 * unsnapped.
 *
 * @returns null when the point isn't on `pageEl`, or `pageEl` holds no item
 *   span inside a `[data-page-number]` element: a page without text, or a
 *   detached text layer.
 * @throws {RangeError} when the DOM's page number or idx isn't one an anchor
 *   can hold, including when `pageEl` sits inside a page instead of being the
 *   page div, since it has no page number of its own.
 */
export function anchorFromDomPoint(
  pageEl: Element,
  node: Node,
  offset: number,
  edge: AnchorEdge
): number | null {
  if (!pageEl.contains(node)) return null;
  const page = numberAttr(pageEl, 'data-page-number');
  const item = enclosingItem(node);
  if (item) return itemAnchor(page, item, charOffset(item, node, offset));

  const items = Array.from(pageEl.querySelectorAll(ITEM_SELECTOR));
  if (items.length === 0) return null;
  const point = pageEl.ownerDocument.createRange();
  point.setStart(node, offset);
  if (edge === 'start') {
    const next = items.find((it) => point.comparePoint(it, 0) === 1);
    return next
      ? itemStart(page, next)
      : itemEnd(page, items[items.length - 1]);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const prev = items[i];
    if (point.comparePoint(prev, prev.childNodes.length) === -1) {
      return itemEnd(page, prev);
    }
  }
  return itemStart(page, items[0]);
}

/**
 * Maps `range`, which may span pages, to the anchors of its first character
 * and just past its last, counting only the text of the PDF viewer `viewerEl`.
 *
 * The anchors are tight. An endpoint inside an item span maps to that item,
 * unless it holds none of the item's text (a start at the item's very end, an
 * end at its very start). Such an endpoint, like one outside any item of this
 * viewer, snaps to the next item the range reaches (start) or the previous one
 * (end), which may sit on another page than the endpoint.
 *
 * @param viewerEl holds every page of the PDF; a range reaching into another
 *   viewer, such as a second embed in the same note, is clipped to this one.
 * @returns null when the range holds no characters of this viewer's text.
 * @throws {RangeError} when the DOM's page number or idx isn't one an anchor
 *   can hold.
 */
export function rangeToAnchors(
  range: Range,
  viewerEl: Element
): AnchorRange | null {
  // Only needed to snap, which pointer selections rarely do: Obsidian has
  // already snapped them into items.
  let reached: Element[] | undefined;
  const reachedItems = () => (reached ??= itemsReachedBy(range, viewerEl));
  const itemAt = (node: Node) => {
    const item = enclosingItem(node);
    return item && viewerEl.contains(item) ? item : null;
  };

  const start = tightEdge(
    itemAt(range.startContainer),
    range.startContainer,
    range.startOffset,
    (item, char) => char < textLength(item),
    // A start inside an item is inside the first item reached.
    (inItem) => {
      const next = reachedItems()[inItem ? 1 : 0];
      return next ? itemStart(pageOf(next), next) : Infinity;
    }
  );
  const end = tightEdge(
    itemAt(range.endContainer),
    range.endContainer,
    range.endOffset,
    (_item, char) => char > 0,
    (inItem) => {
      const items = reachedItems();
      const prev = items[items.length - (inItem ? 2 : 1)];
      return prev ? itemEnd(pageOf(prev), prev) : -Infinity;
    }
  );
  return start < end ? { start, end } : null;
}

/**
 * The anchor of a range endpoint in `item` when `holdsText` says the range
 * takes some of the item's text from there, else the one `snap` finds.
 */
function tightEdge(
  item: Element | null,
  node: Node,
  offset: number,
  holdsText: (item: Element, char: number) => boolean,
  snap: (inItem: boolean) => number
) {
  if (item) {
    const char = charOffset(item, node, offset);
    if (holdsText(item, char)) return itemAnchor(pageOf(item), item, char);
  }
  return snap(item !== null);
}

/** The item spans of `viewerEl` that `range` reaches into, in document order. */
function itemsReachedBy(range: Range, viewerEl: Element): Element[] {
  // Search no wider than the range: the viewer keeps many pages rendered.
  const common = range.commonAncestorContainer;
  const root = viewerEl.contains(common)
    ? common
    : common.contains(viewerEl)
      ? viewerEl
      : null;
  // A range beside the viewer reaches none of it. Snapping never needs the
  // item a range lies wholly inside, and a text node has no items in it.
  if (!root || !('querySelectorAll' in root)) return [];
  return Array.from(
    (root as ParentNode).querySelectorAll(ITEM_SELECTOR)
  ).filter((item) => range.intersectsNode(item));
}
