import { decodeAnchor, rangeToAnchors } from './pdf-anchor';
import {
  extractText,
  type PdfDocument,
  type PdfPageText,
  readPageTexts,
} from './pdf-text';

/** A selection in a PDF, read for extracting. */
export interface PdfSelection {
  /** Anchor of its first character. */
  start: number;
  /** Anchor just past its last character. */
  end: number;
  /** Its text as it reads: see `extractText`. */
  text: string;
  /** The subpath of a link to it: see {@link selectionSubpath}. */
  subpath: string;
}

/**
 * The subpath of a link to the text from the anchor `start` to the anchor
 * `end` (exclusive), as Obsidian's own "Copy link to selection" writes it:
 * `#page=N&selection=a,b,c,d`, the begin item's `data-idx` and offset, then
 * the end's. Obsidian highlights a selection on one page only, so one that
 * runs onto a later page is cut off at the end of the text on its first.
 *
 * Undocumented: the grammar `PdfViewerChild.applySubpath` parses, read from
 * the app bundle (anchor `getTextSelectionRangeStr`).
 *
 * @param startPage the text content of `start`'s page, which holds text
 *   from `start` on.
 */
export function selectionSubpath(
  start: number,
  end: number,
  startPage: PdfPageText
): string {
  const from = decodeAnchor(start);
  let to = decodeAnchor(end);
  if (to.page !== from.page) {
    // Empty items are never on the page, so they can't end a highlight
    const { items } = startPage;
    let idx = items.length - 1;
    while (items[idx].str === '') idx--;
    to = { page: from.page, idx, char: items[idx].str.length };
  }
  return `#page=${from.page}&selection=${from.idx},${from.char},${to.idx},${to.char}`;
}

/**
 * The alias Obsidian gives a link to a page of a PDF (`PdfViewerChild`'s
 * undocumented `getPageLinkAlias`), in English.
 */
export function pageLinkAlias(basename: string, page: number): string {
  return `${basename}, page ${page}`;
}

/**
 * Read `range`, a selection in the PDF viewer `viewerEl` showing `doc`, for
 * extracting: where it starts and ends, its text read from `doc`, and the
 * link to it.
 *
 * @returns null when the range holds no text to extract: none of the
 *   viewer's text, as on a scanned page with no text layer, or only blank
 *   text. Also null, with a warning in the console, when the text layer is
 *   one an anchor can't hold, or disagrees with `doc`.
 * @throws whatever reading `doc` throws.
 */
export async function readPdfSelection(
  range: Range,
  viewerEl: Element,
  doc: PdfDocument
): Promise<PdfSelection | null> {
  let anchors;
  try {
    anchors = rangeToAnchors(range, viewerEl);
  } catch (error) {
    return unreadable(error);
  }
  if (!anchors) return null;
  const { start, end } = anchors;
  const pages = await readPageTexts(doc, start, end);
  let text;
  try {
    text = extractText(pages, start, end);
  } catch (error) {
    return unreadable(error);
  }
  // Never blank otherwise: `extractText` keeps only items with some text
  if (text === '') return null;
  const subpath = selectionSubpath(
    start,
    end,
    pages.get(decodeAnchor(start).page)!
  );
  return { start, end, text, subpath };
}

/** @throws `error` unless it is a `RangeError`, which is logged instead. */
function unreadable(error: unknown): null {
  if (!(error instanceof RangeError)) throw error;
  console.warn("Incremental Reading: can't read the PDF selection", error);
  return null;
}

/**
 * Whether page `page` of `doc` has any text to select: false for a scanned
 * page, which has no text layer.
 */
export async function pageHasText(
  doc: PdfDocument,
  page: number
): Promise<boolean> {
  const content = await (
    await doc.getPage(page)
  ).getTextContent({ includeMarkedContent: false, disableNormalization: true });
  return content.items.some(
    (item) => 'str' in item && /\S/.test((item as { str: string }).str)
  );
}
