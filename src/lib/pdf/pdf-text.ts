import { type AnchorParts, decodeAnchor } from './pdf-anchor';

/** A text item from pdf.js `getTextContent`: one that has a `str`. */
export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
  transform: readonly number[];
  width: number;
  height: number;
}

export interface PdfPageText {
  items: readonly PdfTextItem[];
  view: readonly number[];
}

/**
 * How far, as a share of the taller item's height, a baseline may shift and
 * still count as the same line: room for superscripts and subscripts.
 */
const SAME_LINE_SHIFT = 0.5;

/**
 * The share of a line's tallest item's height that its main text reaches:
 * smaller items are superscripts, subscripts and the like.
 */
const MAIN_SIZE = 0.8;

/**
 * The widest horizontal gap, as a share of the taller item's height, that
 * still counts as touching. pdf.js puts in spaces of its own past about 0.1em.
 */
const WORD_GAP = 0.1;

/**
 * Line spacing is measured as the distance between baselines over the text
 * height. Only spacings in this range count, which leaves out the jumps to
 * headers, footers and the top of the next column.
 */
const MIN_SPACING = 0.8;
const MAX_SPACING = 3;

/** The spacing of text with no line advance to measure it by. */
const DEFAULT_SPACING = 1.2;

/** How many times the usual line spacing apart paragraphs are. */
const PARAGRAPH_GAP = 1.5;

/** How much of the page's height, at its top and bottom, holds furniture. */
const BAND = 0.1;

/**
 * How many pages either side a running header or footer is looked for on: two
 * finds the heads that alternate between left and right pages.
 */
const NEIGHBOUR_REACH = 2;

const left = (item: PdfTextItem) => item.transform[4];
const baseline = (item: PdfTextItem) => item.transform[5];

type Band = 'top' | 'bottom';

function bandOf(item: PdfTextItem, view: readonly number[]): Band | null {
  const [, bottom, , top] = view;
  const depth = BAND * (top - bottom);
  if (baseline(item) > top - depth) return 'top';
  if (baseline(item) < bottom + depth) return 'bottom';
  return null;
}

/** Whether `next` sits on another baseline than `prev`. */
function onNewLine(prev: PdfTextItem, next: PdfTextItem) {
  const shift = Math.abs(baseline(prev) - baseline(next));
  return shift > SAME_LINE_SHIFT * Math.max(prev.height, next.height);
}

/** A line of a page: the items with text, in order, that share a baseline. */
interface Line {
  idxs: number[];
  /** The items' text, a space between each. */
  text: string;
  /** `text` with its numbers blanked out, as running heads vary by page. */
  key: string;
  /** The band every item of the line is in, if they share one. */
  band: Band | null;
  /** The height of its tallest item. */
  height: number;
  /** The baseline of its main text, which superscripts are set off. */
  baseline: number;
  /** Where it sits, measured from where its page starts. */
  place: { left: number; right: number; baseline: number };
  /** How far from its place a line still counts as in it: half a band. */
  reach: number;
  /** The value of the page number it is, if it is one. */
  pageNumber: number | null;
}

/**
 * A page number: Arabic, or lowercase Roman in its proper form, optionally
 * between dashes: `12`, `– xiv –`.
 */
const PAGE_NUMBER =
  /^(?:\p{Pd}\s*)?(?:\d+|(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))(?:\s*\p{Pd})?$/u;

const ROMAN_DIGITS: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

/** The value of the page number `text` is, or null if it isn't one. */
function pageNumberValue(text: string): number | null {
  if (!PAGE_NUMBER.test(text)) return null;
  const numeral = /\d+|[ivxlcdm]+/.exec(text)![0];
  const arabic = Number(numeral);
  if (!Number.isNaN(arabic)) return arabic;
  // A digit before a larger one is taken away: the numeral is well formed
  let value = 0;
  for (let i = 0; i < numeral.length; i++) {
    const digit = ROMAN_DIGITS[numeral[i]];
    value += digit < (ROMAN_DIGITS[numeral[i + 1]] ?? 0) ? -digit : digit;
  }
  return value;
}

function toLine(
  items: readonly PdfTextItem[],
  idxs: number[],
  view: readonly number[]
): Line {
  const members = idxs.map((idx) => items[idx]);
  const height = Math.max(...members.map((item) => item.height));
  const main = members.find((item) => item.height >= MAIN_SIZE * height)!;
  const bands = new Set(members.map((item) => bandOf(item, view)));
  const text = members.map((item) => item.str).join(' ');
  return {
    idxs,
    text,
    key: text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim(),
    band: bands.size === 1 ? bandOf(main, view) : null,
    height,
    baseline: baseline(main),
    place: {
      left: Math.min(...members.map(left)) - view[0],
      right:
        Math.max(...members.map((item) => left(item) + item.width)) - view[0],
      baseline: baseline(main) - view[1],
    },
    reach: (BAND * (view[3] - view[1])) / 2,
    pageNumber: pageNumberValue(text.trim()),
  };
}

/** A page's text in lines, and the line of each item with text. */
interface Layout {
  lines: Line[];
  lineOf: Map<number, Line>;
}

function layoutOf({ items, view }: PdfPageText): Layout {
  const groups: number[][] = [];
  let prev: PdfTextItem | undefined;
  // Nothing to go on with before the first line
  let lineEnded = true;
  items.forEach((item, idx) => {
    if (/\S/.test(item.str)) {
      if (lineEnded || onNewLine(prev!, item)) groups.push([idx]);
      else groups[groups.length - 1].push(idx);
      prev = item;
      lineEnded = false;
    }
    lineEnded ||= item.hasEOL;
  });
  const lines = groups.map((idxs) => toLine(items, idxs, view));
  const lineOf = new Map<number, Line>();
  for (const line of lines) {
    for (const idx of line.idxs) lineOf.set(idx, line);
  }
  return { lines, lineOf };
}

/**
 * The usual line spacing of the text, measured over every page given, as a
 * page can be too short to measure on its own. Text of no height has no
 * spacing to measure.
 */
function lineSpacing(layouts: Iterable<Layout>): number {
  const spacings: number[] = [];
  for (const { lines } of layouts) {
    for (let i = 1; i < lines.length; i++) {
      const drop = lines[i - 1].baseline - lines[i].baseline;
      const spacing = drop / Math.max(lines[i - 1].height, lines[i].height);
      if (spacing >= MIN_SPACING && spacing <= MAX_SPACING) {
        spacings.push(spacing);
      }
    }
  }
  spacings.sort((x, y) => x - y);
  // The lower quartile, as paragraph gaps can be many
  return spacings[Math.floor((spacings.length - 1) / 4)] ?? DEFAULT_SPACING;
}

/**
 * Whether `a` and `b`, on pages of their own, sit in the same place on them,
 * aligned left, centre or right. Scans shift, so within reach of it.
 */
function samePlace(a: Line, b: Line) {
  const tolerance = Math.max(a.reach, b.reach);
  const offset = Math.min(
    Math.abs(a.place.left - b.place.left),
    Math.abs(a.place.right - b.place.right),
    Math.abs(a.place.left + a.place.right - b.place.left - b.place.right) / 2
  );
  return (
    Math.abs(a.place.baseline - b.place.baseline) <= tolerance &&
    offset <= tolerance
  );
}

/** A word: a running head has one, unlike a row of figures. */
const WORD = /\p{L}{2}/u;

/**
 * The indices of each page's furniture items: those of whole lines in the
 * top or bottom band that either have a word and repeat, numbers blanked out,
 * in the same place on a page nearby, or are a bare page number as the
 * outermost line of their band that numbers on from one in the same place
 * nearby. Only whole lines count, so a body line reaching into a band keeps
 * its parts.
 *
 * @param pageNumbers the pages to find furniture on; `layouts` must hold them.
 */
function findFurniture(
  layouts: ReadonlyMap<number, Layout>,
  pageNumbers: readonly number[]
): Map<number, Set<number>> {
  const bandLines = new Map(
    Array.from(layouts, ([page, { lines }]) => [
      page,
      lines.filter((line) => line.band),
    ])
  );
  /** Whether `find` finds a line like `line` on a page nearby. */
  const nearby = (
    page: number,
    find: (other: Line, near: number) => boolean
  ) => {
    for (
      let near = page - NEIGHBOUR_REACH;
      near <= page + NEIGHBOUR_REACH;
      near++
    ) {
      const found =
        near !== page &&
        bandLines.get(near)?.some((other) => find(other, near));
      if (found) return true;
    }
    return false;
  };
  // In the same place, so in the same band
  const repeats = (page: number, line: Line) =>
    WORD.test(line.key) &&
    nearby(page, (other) => other.key === line.key && samePlace(line, other));
  const numbersOn = (page: number, line: Line, value: number) =>
    nearby(
      page,
      (other, near) =>
        other.pageNumber === value + near - page && samePlace(line, other)
    );
  return new Map(
    pageNumbers.map((page) => {
      const lines = bandLines.get(page)!;
      // Lines of the other band are on the far side of the page
      const outermost = (line: Line) =>
        lines.every((other) =>
          line.band === 'top'
            ? other.baseline <= line.baseline
            : other.baseline >= line.baseline
        );
      const furniture = new Set<number>();
      for (const line of lines) {
        if (
          repeats(page, line) ||
          (line.pageNumber !== null &&
            outermost(line) &&
            numbersOn(page, line, line.pageNumber))
        ) {
          for (const idx of line.idxs) furniture.add(idx);
        }
      }
      return [page, furniture];
    })
  );
}

/** Text the range takes from one item. */
interface Piece {
  page: number;
  idx: number;
  item: PdfTextItem;
  text: string;
  /** Whether an item of nothing but whitespace comes before the next. */
  spaceAfter: boolean;
}

/** What goes between two pieces' text, before whitespace is accounted for. */
type Break = 'none' | 'space' | 'line' | 'paragraph';

/** How the text of `next` follows on from `prev`, the piece before it. */
function breakBetween(
  layouts: ReadonlyMap<number, Layout>,
  spacing: number,
  prev: Piece,
  next: Piece
): Break {
  // Where items sit on different pages says nothing about the break
  if (prev.page !== next.page) return 'line';
  const { lineOf } = layouts.get(prev.page)!;
  const prevLine = lineOf.get(prev.idx)!;
  const nextLine = lineOf.get(next.idx)!;
  if (prevLine !== nextLine) {
    const drop = prevLine.baseline - nextLine.baseline;
    // Measured by the smaller text: a heading's size says nothing about the
    // gap between it and the body text below or above it. Text of no height
    // gives nothing to measure by.
    const size =
      Math.min(prevLine.height, nextLine.height) ||
      Math.max(prevLine.height, nextLine.height);
    return size > 0 && drop > PARAGRAPH_GAP * spacing * size
      ? 'paragraph'
      : 'line';
  }
  const size = Math.max(prev.item.height, next.item.height);
  const gap = Math.max(
    left(next.item) - (left(prev.item) + prev.item.width),
    left(prev.item) - (left(next.item) + next.item.width)
  );
  return prev.spaceAfter || gap > WORD_GAP * size ? 'space' : 'none';
}

/**
 * A letter and a hyphen, at the end of the text. (No lookbehind for the
 * letter: iOS before 16.4 lacks it.)
 */
const ENDS_WITH_HYPHEN = /\p{L}[-\u00AD\u2010]$/u;

/**
 * Text built up a part at a time. Kept as parts, not one string: every look at
 * the end of a string built by appending copies all of it.
 *
 * Starts with text, and its last part always holds some besides whitespace.
 */
class TextBuilder {
  private readonly parts: string[];

  constructor(text: string) {
    this.parts = [text];
  }

  append(text: string) {
    this.parts.push(text);
  }

  /**
   * The end of the text, without trailing whitespace: its last two parts, so
   * a hyphen in an item of its own still has the letter before it.
   */
  end() {
    return this.parts.slice(-2).join('').trimEnd();
  }

  endsWithSpace() {
    return /\s$/.test(this.parts[this.parts.length - 1]);
  }

  /** Drops whitespace from the end. */
  trimEnd() {
    this.parts.push(this.parts.pop()!.trimEnd());
  }

  /**
   * Goes on with `rest` from a hyphen that ends the text, which is dropped
   * unless `keepHyphen`, as is any whitespace after it.
   */
  continueWord(rest: string, keepHyphen: boolean) {
    const last = this.parts.pop()!.trimEnd();
    this.parts.push(keepHyphen ? last : last.slice(0, -1), rest);
  }

  toString() {
    return this.parts.join('');
  }
}

/** Appends `text` to `out` across a break of the given kind. */
function join(out: TextBuilder, brk: Break, text: string) {
  if (brk === 'paragraph') {
    out.trimEnd();
    out.append('\n\n');
    out.append(text.trimStart());
    return;
  }
  if (brk === 'line' && ENDS_WITH_HYPHEN.test(out.end())) {
    const rest = text.trimStart();
    // A word split over two lines goes on in lowercase; anything else after
    // the hyphen is the second half of a compound
    out.continueWord(rest, !/^\p{Ll}/u.test(rest));
    return;
  }
  if (brk !== 'none' && !out.endsWithSpace() && !/^\s/.test(text)) {
    out.append(' ');
  }
  out.append(text);
}

/** Latin ligatures, ff to st, which pdf.js leaves as one character each. */
const LIGATURES = /[\uFB00-\uFB06]/g;

function pageAt(pages: ReadonlyMap<number, PdfPageText>, page: number) {
  const text = pages.get(page);
  if (!text) throw new RangeError(`No text content for PDF page ${page}`);
  return text;
}

/** @throws {RangeError} when `anchor` lies outside its page's text. */
function checkAnchor(
  pages: ReadonlyMap<number, PdfPageText>,
  { page, idx, char }: AnchorParts
) {
  const item = pageAt(pages, page).items[idx] as PdfTextItem | undefined;
  if (!item || char > item.str.length) {
    throw new RangeError(
      `PDF anchor past the text of page ${page}: item ${idx}, char ${char}`
    );
  }
}

/** The body text from `from` to `to`, item by item. */
function piecesBetween(
  pages: ReadonlyMap<number, PdfPageText>,
  layouts: ReadonlyMap<number, Layout>,
  from: AnchorParts,
  to: AnchorParts
): Piece[] {
  checkAnchor(pages, from);
  checkAnchor(pages, to);
  const pageNumbers: number[] = [];
  for (let page = from.page; page <= to.page; page++) {
    pageAt(pages, page);
    pageNumbers.push(page);
  }
  const furniture = findFurniture(layouts, pageNumbers);
  const pieces: Piece[] = [];
  for (const page of pageNumbers) {
    const { items } = pages.get(page)!;
    const first = page === from.page ? from.idx : 0;
    const final = page === to.page ? to.idx : items.length - 1;
    for (let idx = first; idx <= final; idx++) {
      const item = items[idx];
      const isStart = page === from.page && idx === from.idx;
      const isEnd = page === to.page && idx === to.idx;
      // The range's own ends are kept: they were chosen
      if (!isStart && !isEnd && furniture.get(page)!.has(idx)) continue;
      const text = item.str.slice(
        isStart ? from.char : 0,
        isEnd ? to.char : undefined
      );
      const prev = pieces[pieces.length - 1] as Piece | undefined;
      if (/\S/.test(text)) {
        pieces.push({ page, idx, item, text, spaceAfter: false });
      } else if (text !== '' && prev) {
        // Blank text says nothing about the line it is on, or which side of
        // a hyphenated word's break it lies; only that a space follows
        prev.spaceAfter = true;
      }
    }
  }
  return pieces;
}

/**
 * The text of a PDF from the anchor `start` to the anchor `end` (exclusive),
 * as it reads: words that pdf.js splits into items joined back up, lines
 * joined with spaces and paragraphs with blank lines, items of nothing but
 * whitespace read as one space, words hyphenated across lines rejoined,
 * ligatures spelled out, and running headers, footers and page numbers left
 * out between pages. A page break reads as a line break: where text sits
 * can't tell whether a paragraph ends at the foot of a page.
 *
 * @param pages each page's text content, keyed by page number: every page of
 *   the range, and as many of the two pages either side of it as the PDF has,
 *   to tell running heads by. `readPageTexts` reads these.
 * @returns an empty string when `end` isn't after `start`.
 * @throws {RangeError} when an anchor isn't one, or lies outside the text of
 *   `pages`.
 */
export function extractText(
  pages: ReadonlyMap<number, PdfPageText>,
  start: number,
  end: number
): string {
  const from = decodeAnchor(start);
  const to = decodeAnchor(end);
  // Anchors sort in document order
  if (start >= end) return '';
  const layouts = new Map(
    Array.from(pages, ([page, text]) => [page, layoutOf(text)])
  );
  const pieces = piecesBetween(pages, layouts, from, to);
  if (pieces.length === 0) return '';
  const spacing = lineSpacing(layouts.values());
  const out = new TextBuilder(pieces[0].text);
  for (let i = 1; i < pieces.length; i++) {
    const brk = breakBetween(layouts, spacing, pieces[i - 1], pieces[i]);
    join(out, brk, pieces[i].text);
  }
  return out
    .toString()
    .replace(LIGATURES, (ligature) => ligature.normalize('NFKC'));
}

/** The part of a pdf.js `PDFDocumentProxy` that `readPageTexts` uses. */
export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    view: readonly number[];
    getTextContent(params: {
      includeMarkedContent: boolean;
      disableNormalization: boolean;
    }): Promise<{ items: readonly object[] }>;
  }>;
}

/**
 * Reads the text content `extractText` needs for the range from `start` to
 * `end` out of `doc`: its pages and the pages nearby that tell running heads
 * apart. Item indices match the text layer's `data-idx`.
 */
export async function readPageTexts(
  doc: PdfDocument,
  start: number,
  end: number
): Promise<Map<number, PdfPageText>> {
  const first = Math.max(1, decodeAnchor(start).page - NEIGHBOUR_REACH);
  const last = Math.min(doc.numPages, decodeAnchor(end).page + NEIGHBOUR_REACH);
  const pageNumbers = Array.from(
    { length: last - first + 1 },
    (_, i) => first + i
  );
  const texts = await Promise.all(
    pageNumbers.map((pageNumber) => readPageText(doc, pageNumber))
  );
  return new Map(pageNumbers.map((pageNumber, i) => [pageNumber, texts[i]]));
}

/**
 * Reads the text content of page `pageNumber` of `doc`. Item indices match
 * the text layer's `data-idx`.
 */
export async function readPageText(
  doc: PdfDocument,
  pageNumber: number
): Promise<PdfPageText> {
  const page = await doc.getPage(pageNumber);
  // The options the text layer renders with (undocumented in Obsidian: its
  // TextLayerBuilder also passes a nonstandard `includeChars`, which adds no
  // items). Marked content has no `str` and takes no `data-idx`.
  const content = await page.getTextContent({
    includeMarkedContent: true,
    disableNormalization: true,
  });
  const items = content.items.filter(
    (item): item is PdfTextItem => 'str' in item
  );
  return { items, view: page.view };
}
