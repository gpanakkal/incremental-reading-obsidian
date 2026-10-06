import type { ReviewArticle } from '#/lib/types';
import type { TFile } from 'obsidian';
import {
  type AnchorRange,
  decodeAnchor,
  encodeAnchor,
  rangeToAnchors,
} from './pdf-anchor';
import {
  extractText,
  type PdfDocument,
  type PdfPageText,
  readPageTexts,
} from './pdf-text';

/**
 * The PDF a snippet or card is made from: the article it is, which becomes its
 * parent, or a PDF that is no article, which leaves it parentless until the
 * PDF is imported.
 */
export type PdfOrigin =
  | { article: ReviewArticle; pdf?: undefined }
  | { article?: undefined; pdf: TFile };

/** The PDF file of `origin`. */
export function originFile(origin: PdfOrigin): TFile {
  return origin.article ? origin.article.file : origin.pdf;
}

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
 * Text on one page of a PDF, as Obsidian highlights it: from item
 * `range[0][0]`'s character `range[0][1]` to item `range[1][0]`'s character
 * `range[1][1]` (exclusive), counted in `data-idx` and UTF-16 units.
 */
export interface PageSelection {
  page: number;
  range: [[number, number], [number, number]];
}

/**
 * The part of the text from the anchor `start` to the anchor `end`
 * (exclusive) that Obsidian can highlight: Obsidian highlights a selection on
 * one page only, so one that runs onto a later page is cut off at the end of
 * the text on its first.
 *
 * @param startPage the text content of `start`'s page. Only text that runs
 *   onto a later page needs it; when given, the selection is checked against
 *   it.
 * @returns null for text that runs onto a later page when `startPage` isn't
 *   given, or holds no text, and whenever `startPage` is given but doesn't
 *   hold the selection's ends, as when the PDF has changed since they were
 *   taken. Obsidian's highlighting throws on an item a page doesn't have.
 */
export function pageSelection(
  start: number,
  end: number,
  startPage?: PdfPageText
): PageSelection | null {
  const from = decodeAnchor(start);
  let to = decodeAnchor(end);
  const items = startPage?.items ?? [];
  if (to.page !== from.page) {
    // Empty items are never on the page, so they can't end a highlight
    let idx = items.length - 1;
    while (idx >= 0 && items[idx].str === '') idx--;
    if (idx < 0) return null;
    to = { page: from.page, idx, char: items[idx].str.length };
  }
  const holds = ({ idx, char }: { idx: number; char: number }) =>
    idx < items.length && char <= items[idx].str.length;
  if (startPage && !(holds(from) && holds(to))) return null;
  return {
    page: from.page,
    range: [
      [from.idx, from.char],
      [to.idx, to.char],
    ],
  };
}

/**
 * The subpath of a link to `selection`, as Obsidian's own "Copy link to
 * selection" writes it: `#page=N&selection=a,b,c,d`, the begin item's
 * `data-idx` and offset, then the end's.
 *
 * Undocumented: the grammar `PdfViewerChild.applySubpath` parses, read from
 * the app bundle (anchor `getTextSelectionRangeStr`).
 */
export function pageSelectionSubpath({
  page,
  range: [[beginIdx, beginChar], [endIdx, endChar]],
}: PageSelection): string {
  return `#page=${page}&selection=${beginIdx},${beginChar},${endIdx},${endChar}`;
}

/** A whole number as a subpath writes one: digits only. */
const DIGITS = /^\d+$/;

/**
 * The anchors of the selection a link's subpath names, as
 * {@link pageSelectionSubpath} writes it: `#page=N&selection=a,b,c,d`. Other
 * parameters are ignored, as Obsidian ignores them in highlighting it.
 *
 * Undocumented: read as `PdfViewerChild.applySubpath` reads it (strip the
 * `#`, then `URLSearchParams`; see plans/reference/obsidian-pdf-internals.md).
 *
 * @returns null when the subpath names no page, or no selection of four
 *   whole numbers an anchor holds, or one that doesn't end after it starts.
 */
export function parseSelectionSubpath(subpath: string): AnchorRange | null {
  const params = new URLSearchParams(subpath.replace(/^#/, ''));
  const page = params.get('page') ?? '';
  const parts = params.get('selection')?.split(',') ?? [];
  if (
    !DIGITS.test(page) ||
    parts.length !== 4 ||
    !parts.every((part) => DIGITS.test(part))
  ) {
    return null;
  }
  const [beginIdx, beginChar, endIdx, endChar] = parts.map(Number);
  let start, end;
  try {
    start = encodeAnchor({ page: +page, idx: beginIdx, char: beginChar });
    end = encodeAnchor({ page: +page, idx: endIdx, char: endChar });
  } catch {
    // Out of what an anchor holds: no selection of a PDF Obsidian shows
    return null;
  }
  return start < end ? { start, end } : null;
}

/**
 * The subpath of a link to the text from the anchor `start` to the anchor
 * `end` (exclusive): see {@link pageSelection} and
 * {@link pageSelectionSubpath}.
 *
 * @param startPage the text content of `start`'s page, which holds text
 *   from `start` on.
 */
export function selectionSubpath(
  start: number,
  end: number,
  startPage: PdfPageText
): string {
  return pageSelectionSubpath(
    (pageSelection(start, end) ?? pageSelection(start, end, startPage))!
  );
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
