import type { SnippetHighlight } from './SnippetOffsetTracker';

/** One block of a note as reading mode renders it. */
export interface ReadingSection {
  /** The section's markdown, exactly as the note has it */
  source: string;
  /** Where `source` starts in the note's body, the space snippet offsets are in */
  bodyOffset: number;
}

/**
 * The section of `text` spanning lines `lineStart` to `lineEnd`, as reading
 * mode's `getSectionInfo` describes one; null for one that starts in the
 * frontmatter, before `bodyStart`, or past the text's end.
 */
export function readingSection(
  text: string,
  lineStart: number,
  lineEnd: number,
  bodyStart: number
): ReadingSection | null {
  const lines = text.split('\n');
  if (lineStart >= lines.length) return null;
  let start = 0;
  for (let i = 0; i < lineStart; i += 1) start += lines[i].length + 1;
  if (start < bodyStart) return null;
  return {
    source: lines.slice(lineStart, lineEnd + 1).join('\n'),
    bodyOffset: start - bodyStart,
  };
}

/** Render `markdown` into `into` the way reading mode renders a section. */
export type RenderSection = (
  markdown: string,
  into: HTMLElement
) => Promise<void>;

/**
 * A marker is a private-use character, numbering the boundary, between two
 * U+2E3B (three-em dash). The dashes are punctuation, so emphasis next to a
 * marker still parses; the private-use character is no digit or word, so code
 * highlighting leaves the marker in one piece.
 */
const MARKER_EDGE = String.fromCharCode(0x2e3b);
const FIRST_INDEX = 0xe000;
const MARKER = new RegExp(
  `${MARKER_EDGE}([${String.fromCharCode(FIRST_INDEX)}-${String.fromCharCode(0xf8ff)}])${MARKER_EDGE}`,
  'g'
);

/**
 * Text that isn't the note's own, as it shows in the section: an embed's,
 * which is another note's and loads on its own time, so a section can be
 * painted with or without it; and a footnote reference's number, which
 * counts the note's footnotes, not the section's.
 */
const SKIPPED = '.internal-embed, [data-footnote-id]';

/**
 * Paint each highlight's text in a reading-mode section with
 * `span.ir-snippet-highlight`, one span per text node it covers.
 *
 * A boundary at either end of the section is the section's start or end. One
 * inside is carried to the rendered text by rendering the section once more,
 * with a marker at each such boundary, and reading where the markers land.
 */
export async function paintSectionHighlights(
  el: HTMLElement,
  section: ReadingSection,
  highlights: readonly SnippetHighlight[],
  render: RenderSection
): Promise<void> {
  const { source, bodyOffset } = section;
  const clamp = (offset: number) =>
    Math.min(Math.max(offset - bodyOffset, 0), source.length);
  const ranges = highlights
    .map((highlight) => ({
      highlight,
      start: clamp(highlight.start_offset),
      end: clamp(highlight.end_offset),
    }))
    .filter(({ start, end }) => start < end);

  // No marker at the section's edges: there one would sit before or after
  // block syntax that takes no stray text (a fence, a table row)
  const inner = ranges
    .flatMap(({ start, end }) => [start, end])
    .filter((offset) => offset > 0 && offset < source.length);
  const positions = new Map([
    [0, 0],
    [source.length, Infinity],
  ]);
  if (inner.length > 0) {
    const code = isFencedCode(source);
    const boundaries = [...new Set(inner)];
    const marked = markBoundaries(
      source,
      boundaries.map((offset) =>
        code ? offset : pastBlockSyntax(source, offset)
      )
    );
    // The note defines the section's footnotes elsewhere; without a
    // definition a reference renders as typed instead of as a reference.
    // After every marker, so whatever the definitions render as moves none.
    const names = new Set(
      Array.from(source.matchAll(FOOTNOTE_REF), ([, name]) => name)
    );
    const footnotes = [...names].map((name) => `\n\n[^${name}]: -`);
    const rendered = createDiv();
    await render(marked + footnotes.join(''), rendered);
    const found = readMarkers(rendered);
    boundaries.forEach((offset, i) => {
      const position = found.get(i);
      if (position !== undefined) positions.set(offset, position);
    });
  }

  // By start, as live preview's decorations are: of two that overlap, the one
  // starting later is innermost, so it is the one a click there opens
  ranges.sort((a, b) => a.start - b.start);
  paintRanges(
    el,
    ranges.flatMap(({ highlight, start, end }) => {
      const from = positions.get(start);
      const to = positions.get(end);
      return from === undefined || to === undefined
        ? []
        : [{ highlight, start: from, end: to }];
    })
  );
}

/** Whether the section is a fenced code block, all of whose text shows. */
const isFencedCode = (source: string) => /^ {0,3}(?:```|~~~)/.test(source);

/** A footnote reference, by any name Obsidian takes; not a definition. */
const FOOTNOTE_REF = /\[\^([^\]\s]+)\](?!:)/g;

/**
 * A line's leading block markup: indentation, blockquote `>`s, list markers
 * (with a task box), then perhaps a heading's `#`s, after which the line is
 * the heading's text. It renders as no text, and a marker placed before it
 * would turn the line into a plain paragraph.
 *
 * Sticky, to match only where a line starts, which it always does: every part
 * of the pattern is optional.
 */
const BLOCK_PREFIX =
  /(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+(?:\[.\][ \t]+)?|\d{1,9}[.)][ \t]+(?:\[.\][ \t]+)?))*[ \t]*(?:#{1,6}(?:[ \t]+|$))?/my;

/**
 * Move `offset` past any block markup in front of it on its line, so a marker
 * there leaves the block's syntax intact. Moves only across text that renders
 * as nothing.
 *
 * A line of nothing but markup (a quote's `>` between two paragraphs) would
 * join the blocks around it once a marker gave it text: the marker goes on
 * to the next line's text, which shows the same place.
 */
function pastBlockSyntax(source: string, offset: number): number {
  let lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  for (;;) {
    BLOCK_PREFIX.lastIndex = lineStart;
    BLOCK_PREFIX.exec(source);
    const prefixEnd = BLOCK_PREFIX.lastIndex;
    if (source[prefixEnd] !== '\n') return Math.max(offset, prefixEnd);
    lineStart = prefixEnd + 1;
  }
}

/** `source` with boundary `i`'s marker inserted at `boundaries[i]`. */
function markBoundaries(source: string, boundaries: number[]): string {
  // From the end, so each insertion leaves the offsets before it valid
  const order = boundaries
    .map((offset, index) => ({ offset, index }))
    .sort((a, b) => b.offset - a.offset);
  let marked = source;
  for (const { offset, index } of order) {
    marked =
      marked.slice(0, offset) +
      MARKER_EDGE +
      String.fromCharCode(FIRST_INDEX + index) +
      MARKER_EDGE +
      marked.slice(offset);
  }
  return marked;
}

/** Where each marker sits in the rendered text once the markers are gone. */
function readMarkers(root: HTMLElement): Map<number, number> {
  const positions = new Map<number, number>();
  let length = 0;
  for (const node of textNodes(root)) {
    // Counted as the section's own node is, which has no markers in it: a
    // marker can land in a newline the section's render skips as layout
    const counted = !isLayout(node, node.data.replace(MARKER, ''));
    let from = 0;
    for (const match of node.data.matchAll(MARKER)) {
      if (counted) length += match.index - from;
      positions.set(match[1].charCodeAt(0) - FIRST_INDEX, length);
      from = match.index + match[0].length;
    }
    if (counted) length += node.length - from;
  }
  return positions;
}

interface PaintedRange {
  highlight: SnippetHighlight;
  /** Offsets into `root`'s rendered text, less skipped text and layout */
  start: number;
  end: number;
}

/**
 * Wrap each range of `root`'s rendered text in spans, one per stretch of a
 * text node it covers; overlapping ones nest.
 *
 * Every text node is cut at every boundary inside it before any is wrapped:
 * nodes are counted as they were rendered, since a cut can leave a piece that
 * looks like layout.
 */
function paintRanges(root: HTMLElement, ranges: PaintedRange[]): void {
  let offset = 0;
  const content = textNodes(root).filter((node) => !isLayout(node));
  for (const node of content) {
    const nodeStart = offset;
    offset += node.length;
    const cuts = ranges
      .flatMap(({ start, end }) => [start - nodeStart, end - nodeStart])
      .filter((cut) => cut > 0 && cut < node.length)
      .sort((a, b) => b - a);
    // From the end, so `node` keeps the first piece and each cut is in it
    const pieces = [node];
    for (const cut of new Set(cuts)) pieces.splice(1, 0, node.splitText(cut));
    let pieceStart = nodeStart;
    for (const piece of pieces) {
      const pieceEnd = pieceStart + piece.length;
      for (const { highlight, start, end } of ranges) {
        if (start <= pieceStart && pieceEnd <= end && pieceStart < pieceEnd) {
          wrap(piece, highlight);
        }
      }
      pieceStart = pieceEnd;
    }
  }
}

/** Wrap `node` in a highlight's span, inside any it is already in. */
function wrap(node: Text, highlight: SnippetHighlight): void {
  // The global, not `activeDocument.createSpan()`: that `Node` method appends
  // the span to the node it is called on, and a document refuses it
  const span = createSpan({
    cls: 'ir-snippet-highlight',
    attr: {
      'data-snippet-id': highlight.id,
      'data-snippet-ref': highlight.reference,
    },
  });
  node.before(span);
  span.append(node);
}

/**
 * Whether a text node holds only the newlines Obsidian's HTML puts between
 * elements (`<ul>\n<li>`, `<br>\n<strong>`): no text of the note's, and a span
 * there could sit between list items. Neither counted nor painted.
 *
 * Never in code, whose whitespace is the note's text: highlighting splits it
 * into tokens, and a marker cutting a token can merge an indent into the text
 * beside it, so the two renders must count it alike.
 *
 * @param text the node's text, if not its own
 */
const isLayout = (node: Text, text = node.data) =>
  text.trim() === '' &&
  text.includes('\n') &&
  node.parentElement?.closest('pre') == null;

/**
 * `root`'s text nodes in document order, less {@link SKIPPED} text.
 *
 * By node type rather than `instanceof`: a popout window's nodes are of its
 * own window's classes.
 */
function textNodes(root: HTMLElement): Text[] {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    (node) =>
      node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(SKIPPED)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
  );
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) nodes.push(node as Text);
  }
  return nodes;
}
