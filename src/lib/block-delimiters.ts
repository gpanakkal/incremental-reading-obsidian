import type { App } from 'obsidian';
import type { TextBounds } from './text-selection';

/**
 * A top-level block of a note as Obsidian's metadata cache reads it: its
 * `SectionCache` type (`code`, `math`, `blockquote`, ...) and the offsets of
 * its first and past its last character.
 */
export type BlockSection = { type: string; start: number; end: number };

/**
 * Obsidian's top-level sections of `text`, read by the same parser as the
 * metadata cache, from the text itself rather than a saved note, so they
 * match an editor's unsaved content. `null` when the parser can't be reached.
 *
 * Undocumented: `MetadataCache.computeMetadataAsync`, which hands the text's
 * UTF-8 bytes to the cache's worker and resolves to a `CachedMetadata`
 * whose offsets index the decoded string (Obsidian 1.13.7).
 */
export async function readSections(
  app: App,
  text: string
): Promise<BlockSection[] | null> {
  const cache = app.metadataCache as
    | {
        computeMetadataAsync?: (data: ArrayBuffer) => Promise<{
          sections?: {
            type: string;
            position: { start: { offset: number }; end: { offset: number } };
          }[];
        } | null>;
      }
    | undefined;
  if (typeof cache?.computeMetadataAsync !== 'function') return null;
  try {
    const metadata = await cache.computeMetadataAsync(
      new TextEncoder().encode(text).buffer
    );
    return (metadata?.sections ?? []).map(({ type, position }) => ({
      type,
      start: position.start.offset,
      end: position.end.offset,
    }));
  } catch (error) {
    console.warn('[readSections] Could not parse the note', error);
    return null;
  }
}

/**
 * What a text cut from a note needs around it to render as it did there,
 * and what the note needs around whatever replaces the cut to keep rendering
 * as it did: see {@link imputeDelimiters}.
 */
export type ImputedDelimiters = {
  /** The cut, moved off any delimiter line it split. */
  range: TextBounds;
  /** Text to put before the cut's text in its new note. */
  open: string;
  /** Text to put after it. */
  close: string;
  /** Text to put before whatever replaces the cut in the note it came from. */
  before: string;
  /** Text to put after that. */
  after: string;
  /**
   * Whether the cut starts in a block whose context `open` restores exactly
   * as it was (code, math, a comment, a table), so that its text belongs in
   * the new note as it is, unescaped.
   */
  raw: boolean;
};

/** The kinds of block that a cut from inside them loses the syntax of. */
type Kind =
  | 'fence'
  | 'indented'
  | 'math'
  | 'comment'
  | 'quote'
  | 'callout'
  | 'table';

/** A section of a kind this module handles, its ends on whole lines. */
type Block = {
  kind: Kind;
  /** The start of its first line. */
  start: number;
  /** The end of its last line. */
  end: number;
  /** The end of its opening delimiter, which a cut keeps whole. */
  openEnd: number;
  /** The start of its closing delimiter, if it has one, which a cut keeps whole. */
  closeStart: number | null;
};

/** Where nothing is syntax, so a cut's text is copied as it is. */
const LITERAL: ReadonlySet<Kind> = new Set([
  'fence',
  'indented',
  'math',
  'comment',
]);

/** A fence's run, after up to three spaces of indent. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Quote markers, nested to any depth, with the whitespace after each. */
const QUOTE_MARKERS = /^(?:[ \t]*>[ \t]?)+/;
/** A callout's markers, up to where its title starts. */
const CALLOUT_MARKERS = /^(?:[ \t]*>[ \t]?)+\[![^\]]*\][+-]?[ \t]*/;

const isLineBreak = (char: string | undefined) =>
  char === '\n' || char === '\r';

/** The start of the line holding `at` in `doc`. */
function lineStartOf(doc: string, at: number): number {
  let i = at;
  while (i > 0 && !isLineBreak(doc[i - 1])) i--;
  return i;
}

/** The end of the line holding `at` in `doc`, before its line break. */
function lineEndOf(doc: string, at: number): number {
  let i = at;
  while (i < doc.length && !isLineBreak(doc[i])) i++;
  return i;
}

const lineAt = (doc: string, at: number) =>
  doc.slice(lineStartOf(doc, at), lineEndOf(doc, at));

/** The math or comment delimiter of a kind, which opens and closes it alike. */
const PAIRED = { math: '$$', comment: '%%' } as const;

/**
 * `section` as a {@link Block}, or `null` for a kind a cut loses nothing of
 * (a paragraph, a list, a heading...), whose syntax lies only at its lines'
 * starts or stays with the text.
 */
function blockOf(doc: string, section: BlockSection): Block | null {
  const start = lineStartOf(doc, section.start);
  const end = lineEndOf(doc, section.end);
  const first = doc.slice(start, lineEndOf(doc, start));
  const lastStart = lineStartOf(doc, end);
  const last = doc.slice(lastStart, end);
  const multiline = lastStart > start;
  switch (section.type) {
    case 'code': {
      const fence = FENCE.exec(first)?.[1];
      if (!fence) {
        return {
          kind: 'indented',
          start,
          end,
          openEnd: start,
          closeStart: null,
        };
      }
      // Closed by a run of its char at least as long, alone on its line
      const closer = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
      return {
        kind: 'fence',
        start,
        end,
        openEnd: start + first.length,
        closeStart: multiline && closer.test(last) ? lastStart : null,
      };
    }
    case 'math':
    case 'comment': {
      const delimiter = PAIRED[section.type];
      const escaped = delimiter.replace(/\$/g, '\\$');
      const opener = new RegExp(`^[ \\t]*${escaped}[ \\t]*`).exec(first);
      const closer = new RegExp(`[ \\t]*${escaped}[ \\t]*$`).exec(last);
      return {
        kind: section.type,
        start,
        end,
        openEnd: start + (opener?.[0].length ?? 0),
        closeStart: multiline && closer ? end - closer[0].length : null,
      };
    }
    case 'blockquote':
      // Its first line's markers open it: cut into, the rest of that line
      // would be no quote
      return {
        kind: 'quote',
        start,
        end,
        openEnd: start + (QUOTE_MARKERS.exec(first)?.[0].length ?? 0),
        closeStart: null,
      };
    case 'callout':
      // Its type and fold marker are a delimiter, its title is not
      return {
        kind: 'callout',
        start,
        end,
        openEnd: start + (CALLOUT_MARKERS.exec(first)?.[0].length ?? 0),
        closeStart: null,
      };
    case 'table':
      return { kind: 'table', start, end, openEnd: start, closeStart: null };
    default:
      return null;
  }
}

/** Whether `at` lies inside `block`, past its start and before its end. */
const holds = (block: Block, at: number) => block.start < at && at < block.end;

/**
 * Where a cut's start (`isStart`) or end at `at` goes so it splits none of
 * `block`'s delimiters: into the opening one, to the block's start; into the
 * closing one, to the block's end. A start right at the closing delimiter
 * moves past it too, taking nothing of the block; an end right after the
 * opening one moves before it.
 *
 * With `overBlanks`, the blank space between a code, math or comment block's
 * delimiters and its text counts as part of them, so a cut of all of the
 * block's text takes the whole block rather than leave an empty block behind
 * on either side of what replaces it.
 */
function snap(
  doc: string,
  block: Block,
  at: number,
  isStart: boolean,
  overBlanks: boolean
): number {
  if (!holds(block, at)) return at;
  const blank = (from: number, to: number) =>
    overBlanks &&
    (block.kind in PAIRED || block.kind === 'fence') &&
    !/\S/.test(doc.slice(from, to));
  // A block with no opening delimiter opens at its start, which it doesn't hold
  if (at <= block.openEnd || blank(block.openEnd, at)) return block.start;
  // An unclosed block runs to its end, which it holds none of
  const close = block.closeStart ?? block.end;
  if (at > close || (isStart && at === close) || blank(at, close)) {
    return block.end;
  }
  return at;
}

/** The kind's markers on the line holding `at`, up to `at`, or `> ` on a lazy line. */
function quotePrefix(doc: string, at: number, markers: RegExp): string {
  const lineStart = lineStartOf(doc, at);
  const length = markers.exec(lineAt(doc, at))?.[0].length ?? 0;
  if (length === 0) return '> ';
  return doc.slice(lineStart, Math.min(at, lineStart + length));
}

/** Whether the character at `at` in `doc` is a pipe no backslash escapes. */
const isPipe = (doc: string, at: number) =>
  doc[at] === '|' && doc[at - 1] !== '\\';

/**
 * Part of a table row in `doc`, from `from` to `to`, its cells emptied but
 * kept as cells. A backslash it ends in that escapes the pipe after it is
 * kept, so that pipe stays none between cells.
 */
function emptyCells(doc: string, from: number, to: number): string {
  let emptied = '';
  for (let at = from; at < to; at++) {
    const escape = at === to - 1 && doc[at] === '\\' && doc[to] === '|';
    if (isPipe(doc, at)) emptied += '|';
    else if (escape) emptied += '\\';
    else if (!emptied.endsWith(' ')) emptied += ' ';
  }
  return emptied;
}

/** The start of the line after the one holding `at` in `doc`. */
function nextLineStart(doc: string, at: number): number {
  const end = lineEndOf(doc, at);
  return end + (doc.startsWith('\r\n', end) ? 2 : 1);
}

/** The end of the text `doc` has before `at`, any line breaks just before it not counted. */
function endBeforeBreaks(doc: string, at: number): number {
  let end = at;
  while (isLineBreak(doc[end - 1])) end--;
  return end;
}

/**
 * A table's header and separator rows, and which `at` is on: the header (0),
 * the separator (1), or a row of the body (2).
 */
function tableRowOf(doc: string, block: Block, at: number) {
  const separatorStart = nextLineStart(doc, block.start);
  const lineStart = lineStartOf(doc, at);
  return {
    header: doc.slice(block.start, lineEndOf(doc, block.start)),
    separator: doc.slice(separatorStart, lineEndOf(doc, separatorStart)),
    row: lineStart === block.start ? 0 : lineStart === separatorStart ? 1 : 2,
  };
}

/** The first and last of a span of a table's columns, counted from 0. */
type Columns = readonly [number, number];

/**
 * Where the cells of the table row starting at `lineStart` lie: cell `i`
 * between bound `i` and bound `i + 1`, each the offset of an unescaped pipe,
 * or, at a side of the row with no pipe, of where its text starts (less
 * one) or ends.
 */
function cellBounds(doc: string, lineStart: number): number[] {
  const lineEnd = lineEndOf(doc, lineStart);
  const line = doc.slice(lineStart, lineEnd);
  // As `isPipe` reads them
  const pipes = [...line.matchAll(/(?<!\\)\|/g)].map(
    ({ index }) => lineStart + index
  );
  const lead = /^\s*\|/.test(line);
  // A row of one pipe has it at its start only
  const trail = pipes.length > (lead ? 1 : 0) && /(?<!\\)\|\s*$/.test(line);
  return [
    ...(lead ? [] : [lineStart - 1]),
    ...pipes,
    ...(trail ? [] : [lineEnd]),
  ];
}

/**
 * The column of the cell of a row with `bounds` that holds the character at
 * `at`: a pipe between two cells opens the one after it for a cut's start
 * (`isStart`), and closes the one before it for its last character.
 */
function columnAt(bounds: number[], at: number, isStart: boolean): number {
  const passed = bounds.filter((bound) => (isStart ? bound <= at : bound < at));
  return Math.min(Math.max(passed.length - 1, 0), bounds.length - 2);
}

/**
 * The cells of the table row holding `at` before it, emptied, with a pipe
 * to open them where the row has none: emptied, its first cell would leave
 * its next pipe to read as the row's opening one, and every cell after it
 * a column to the left.
 */
function emptyCellsBefore(doc: string, at: number): string {
  const lineStart = lineStartOf(doc, at);
  const lead = cellBounds(doc, lineStart)[0] >= lineStart;
  return (lead ? '' : '|') + emptyCells(doc, lineStart, at);
}

/**
 * The cells of the table row holding `at` after it, emptied, with a pipe to
 * open them where the row has none and keeps nothing before `at` but blank
 * space, as it is (not `opened` by {@link emptyCellsBefore}): its next pipe
 * would otherwise read as the row's opening one, and a row of that pipe
 * alone ends the table (seen in Obsidian 1.14.5).
 */
function emptyCellsAfter(doc: string, at: number, opened: boolean): string {
  const lineStart = lineStartOf(doc, at);
  const lead =
    opened ||
    cellBounds(doc, lineStart)[0] >= lineStart ||
    doc.slice(lineStart, at).trim() !== '';
  return (lead ? '' : '|') + emptyCells(doc, at, lineEndOf(doc, at));
}

/** The cells of the table row starting at `lineStart` in `columns`, with pipes at both ends. */
function cellsIn(doc: string, lineStart: number, [first, last]: Columns) {
  const bounds = cellBounds(doc, lineStart);
  return `|${doc.slice(bounds[first] + 1, bounds[last + 1])}|`;
}

/**
 * The columns of `block`, a table, that a cut over `[from, to]` takes cells
 * of, if it takes them from one of its rows and leaves some columns out, or
 * `null`: a cut over rows takes the ones between whole, so all columns.
 */
function cutColumns(
  doc: string,
  block: Block,
  from: number,
  to: number
): Columns | null {
  // Its first row, past the line break a cut can start with, and its last,
  // the line break it can end with not counted
  const start = Math.max(from, block.start);
  const first = isLineBreak(doc[start])
    ? nextLineStart(doc, start)
    : lineStartOf(doc, start);
  const end = endBeforeBreaks(doc, Math.min(to, block.end));
  if (lineStartOf(doc, end - 1) !== first) return null;
  const bounds = cellBounds(doc, first);
  // A cut on past its row's line end, or the table's, from a row with no
  // pipe to close it has nowhere before its line break to close its last
  // cell, so the cells before it keep the row a row
  const lineEnd = lineEndOf(doc, first);
  if (to > lineEnd && bounds.at(-1) === lineEnd) return null;
  const columns = cellBounds(doc, block.start).length - 1;
  const firstColumn = Math.min(columnAt(bounds, from, true), columns - 1);
  const lastColumn = Math.min(columnAt(bounds, end - 1, false), columns - 1);
  return firstColumn === 0 && lastColumn === columns - 1
    ? null
    : [firstColumn, lastColumn];
}

/**
 * What a table needs before text cut from `at` in it that takes only
 * `columns` of it: its header, and its separator if the cut starts below
 * it, cut down to those columns, and the cut's own cell up to it emptied.
 */
function openColumns(
  doc: string,
  block: Block,
  at: number,
  columns: Columns
): string {
  const separatorStart = nextLineStart(doc, block.start);
  const atLineEnd = isLineBreak(doc[at]);
  const rowStart = atLineEnd ? nextLineStart(doc, at) : lineStartOf(doc, at);
  const above = [block.start, separatorStart]
    .filter((start) => start < rowStart)
    .map((start) => cellsIn(doc, start, columns));
  if (atLineEnd) return above.join('\n');
  const opening = cellBounds(doc, rowStart)[columns[0]];
  // A cut taking the pipe that opens its cell has it already. The
  // separator's dashes are no cell text
  const cell =
    at <= opening
      ? ''
      : `|${
          rowStart === separatorStart
            ? doc.slice(opening + 1, at)
            : emptyCells(doc, opening + 1, at)
        }`;
  return [...above, cell].join('\n');
}

/**
 * What a table needs after text cut up to `at` in it that takes only
 * `columns` of it: the rest of the cut's last cell emptied, and the
 * separator, cut down to those columns, if that cell is the header's.
 */
function closeColumns(
  doc: string,
  block: Block,
  at: number,
  columns: Columns
): string {
  const separatorStart = nextLineStart(doc, block.start);
  const end = endBeforeBreaks(doc, at);
  const rowStart = lineStartOf(doc, end - 1);
  const closing = cellBounds(doc, rowStart)[columns[1] + 1];
  // A cut taking the pipe that closes its cell, or ending past its line, has
  // it already
  const cell =
    at > closing
      ? ''
      : `${
          rowStart === separatorStart
            ? doc.slice(at, closing)
            : emptyCells(doc, at, closing)
        }|`;
  if (rowStart !== block.start) return cell;
  return (end < at ? '' : `${cell}\n`) + cellsIn(doc, separatorStart, columns);
}

/**
 * What `block` needs before text cut from `at` inside it for that text to
 * read as it did there: of a table, only `columns`, if given (see
 * {@link cutColumns}).
 */
function openAt(
  doc: string,
  block: Block,
  at: number,
  columns: Columns | null = null
): string {
  const lineStart = lineStartOf(doc, at);
  const atLineEnd = isLineBreak(doc[at]);
  const firstLine = doc.slice(block.start, lineEndOf(doc, block.start));
  switch (block.kind) {
    case 'fence':
      return firstLine + (atLineEnd ? '' : '\n');
    case 'math':
    case 'comment':
      return PAIRED[block.kind] + (atLineEnd ? '' : '\n');
    case 'indented': {
      const line = lineAt(doc, at);
      const indent = line.length - line.trimStart().length;
      return doc.slice(lineStart, Math.min(at, lineStart + indent));
    }
    case 'quote':
      return quotePrefix(doc, at, QUOTE_MARKERS);
    case 'callout':
      return lineStart === block.start
        ? quotePrefix(doc, at, CALLOUT_MARKERS)
        : `${firstLine}\n${quotePrefix(doc, at, QUOTE_MARKERS)}`;
    case 'table': {
      if (columns) return openColumns(doc, block, at, columns);
      const { header, separator, row } = tableRowOf(doc, block, at);
      const before = doc.slice(lineStart, at);
      // The rows above the cut's whole, and the cells of its own row before
      // it emptied, so what follows stays in its column. The separator's
      // dashes are no cell text, and a header cut at its end is all there is
      // of it
      if (row === 0) return atLineEnd ? before : emptyCellsBefore(doc, at);
      if (row === 1) return `${header}\n${before}`;
      return [
        header,
        separator,
        ...(atLineEnd ? [] : [emptyCellsBefore(doc, at)]),
      ].join('\n');
    }
  }
}

/**
 * What `block` needs after text cut up to `at` inside it for that text to
 * read as it did there: of a table, only `columns`, if given (see
 * {@link cutColumns}).
 */
function closeAt(
  doc: string,
  block: Block,
  at: number,
  columns: Columns | null = null,
  opened = false
): string {
  const newline = isLineBreak(doc[at - 1]) ? '' : '\n';
  switch (block.kind) {
    case 'fence':
      return newline + FENCE.exec(lineAt(doc, block.start))![1];
    case 'math':
    case 'comment':
      return newline + PAIRED[block.kind];
    case 'table': {
      if (columns) return closeColumns(doc, block, at, columns);
      // A header needs its separator, of as many cells, and a separator all
      // of itself. The rest of a row of the body is emptied, so the row keeps
      // a pipe past its first cell, without which it is no row at all
      const { separator, row } = tableRowOf(doc, block, at);
      const rest = emptyCellsAfter(doc, at, opened);
      if (row === 0) return `${rest}\n${separator}`;
      if (row === 1) return doc.slice(at, lineEndOf(doc, at));
      return isLineBreak(doc[at - 1]) ? '' : rest;
    }
    default:
      return '';
  }
}

/**
 * What the note needs between its text before `at`, inside `block`, and
 * what replaces the cut there, for the rest of the note to read as it did:
 * code, math and comments are closed, and a table or indented code ended,
 * so the replacement stands as a block of its own. A quote holds the
 * replacement as it held the cut.
 */
function leaveAt(doc: string, block: Block, at: number): string {
  const atLineStart = isLineBreak(doc[at - 1]);
  switch (block.kind) {
    case 'fence':
    case 'math':
    case 'comment':
      return `${closeAt(doc, block, at)}\n`;
    case 'indented':
      return atLineStart ? '' : '\n';
    case 'table': {
      const close = closeAt(doc, block, at);
      return close + (close || !atLineStart ? '\n\n' : '\n');
    }
    default:
      return '';
  }
}

/**
 * What the note needs between what replaces the cut and its text from `at`,
 * inside `block`, for that text to read as it did: `block` opened again, on
 * a line of its own, after a blank one where a paragraph would otherwise
 * hold it (a table's header, indented code) or a quote the cut left would.
 */
function enterAt(
  doc: string,
  block: Block,
  at: number,
  leftQuote: boolean
): string {
  const ownLine =
    !leftQuote && (block.kind in PAIRED || block.kind === 'fence');
  return (ownLine ? '\n' : '\n\n') + openAt(doc, block, at);
}

/** Sections a line after them, with no blank line between, continues. */
const LAZY: ReadonlySet<string> = new Set([
  'blockquote',
  'callout',
  'list',
  'html',
  'footnoteDefinition',
]);

/** Sections a paragraph's line before them, with no blank line between, takes in. */
const NO_INTERRUPTING: ReadonlySet<string> = new Set(['table', 'code', 'html']);

/** The line breaks to put after `gap` for `needed` to stand between what it parts. */
function separation(gap: string, needed: number): string {
  const breaks = gap.match(/\r\n|\r|\n/g)?.length ?? 0;
  return '\n'.repeat(Math.max(0, needed - breaks));
}

/** The blocks of `sections` that a cut can lose syntax of. */
const blocksOf = (doc: string, sections: readonly BlockSection[]) =>
  sections.flatMap((section) => blockOf(doc, section) ?? []);

/**
 * The kind of fenced code, math or comment block that `text` ends inside,
 * as the section type the metadata cache would give it, or `null`.
 *
 * A line-by-line reading of only those blocks' delimiters, for where the
 * metadata cache's parser (see {@link readSections}) can't be awaited, as
 * while rendering a card: a fence is closed by a run of its char at least as
 * long, alone on its line; math and comments by a line ending in their
 * delimiter. The line `text` ends on is inside math or a comment that it
 * opens, but not inside code whose fence it is (its info string).
 */
export function openBlockAtEnd(
  text: string
): 'code' | 'math' | 'comment' | null {
  const lines = text.split(/\r?\n/);
  const last = lines.pop()!;
  type Opened = { type: 'code' | 'math' | 'comment'; closer: RegExp };
  /** The block `line` opens and leaves open, if any. */
  const opener = (line: string): Opened | null => {
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      return {
        type: 'code',
        closer: new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`),
      };
    }
    const paired = /^ {0,3}(\$\$|%%)/.exec(line);
    if (!paired) return null;
    const closer = new RegExp(`${paired[1].replace(/\$/g, '\\$')}[ \\t]*$`);
    // Math or a comment closed on the line it opens on
    if (closer.test(line.slice(paired[0].length))) return null;
    return { type: paired[1] === '$$' ? 'math' : 'comment', closer };
  };
  let open: Opened | null = null;
  for (const line of lines) {
    if (!open) open = opener(line);
    else if (open.closer.test(line)) open = null;
  }
  if (open) return open.type;
  const opened = opener(last);
  return opened && opened.type !== 'code' ? opened.type : null;
}

/**
 * Whether `at` in `doc` lies in code, math or a comment, where nothing is
 * syntax.
 */
export function isLiteralAt(
  doc: string,
  sections: readonly BlockSection[],
  at: number
): boolean {
  return blocksOf(doc, sections).some(
    (block) => LITERAL.has(block.kind) && holds(block, at)
  );
}

/**
 * The delimiters that text cut from `doc` over `range` lacks to render in a
 * note of its own as it did in `doc`, and those `doc` needs to keep rendering
 * as it did once the cut is replaced by something else, as a card's embed.
 *
 * Only top-level blocks are seen, as the metadata cache reads them
 * (`sections`): fenced and indented code, math and `%%` comment blocks, quotes,
 * callouts and tables. A cut starting in one opens it again in the new note
 * (its fence and info string, `$$`, the quote markers of the line it starts
 * on, a callout's first line, a table's header and separator rows, with the
 * cells before it in its row emptied); one ending in code, math or a comment
 * closes it. A cut never splits a delimiter line: an end inside one moves to
 * whichever side of it keeps the delimiter whole (see {@link snap}), as does
 * one taking only blank space beside a delimiter of code, math or a comment,
 * unless `overBlanks` is off (for bounds that must stay put, as a card's
 * whole line). A cut of nothing but part of one delimiter gets nothing
 * imputed.
 *
 * In `doc`, the replacement stands between the block the cut left, closed,
 * and the one it entered, opened again, as blocks of their own: a code block
 * cut in the middle becomes two around it. A quote or callout the cut stays
 * in holds the replacement as it did the cut. Cut from between blocks, the
 * replacement is set apart from any block beside it that would otherwise
 * take it in: a closing fence it would follow on its line, a quote it would
 * continue, a table it would head.
 */
export function imputeDelimiters(
  doc: string,
  sections: readonly BlockSection[],
  range: TextBounds,
  { overBlanks = true }: { overBlanks?: boolean } = {}
): ImputedDelimiters {
  const blocks = blocksOf(doc, sections);
  let [from, to] = range;
  for (const block of blocks) {
    from = snap(doc, block, from, true, overBlanks);
    to = snap(doc, block, to, false, overBlanks);
  }
  if (from >= to) {
    return { range, open: '', close: '', before: '', after: '', raw: false };
  }
  const left = blocks.find((block) => holds(block, from));
  const entered = blocks.find((block) => holds(block, to));
  const leftQuote = left?.kind === 'quote' || left?.kind === 'callout';
  // The columns of a table the note takes, the rest of it in the source
  const columns = (block: Block) =>
    block.kind === 'table' ? cutColumns(doc, block, from, to) : null;
  const inSection = (at: number) =>
    sections.some(({ start, end }) => start < at && at < end);

  let before = '';
  if (left) before = leaveAt(doc, left, from);
  else if (!inSection(from)) {
    const previous = sections.filter(({ end }) => end <= from).at(-1);
    if (previous) {
      before = separation(
        doc.slice(previous.end, from),
        previous.type === 'paragraph' ? 0 : LAZY.has(previous.type) ? 2 : 1
      );
    }
  }

  let after = '';
  if (entered) {
    if (!(entered === left && leftQuote)) {
      after = enterAt(doc, entered, to, leftQuote);
    }
  } else if (inSection(to)) {
    // The rest of the paragraph the cut ends in, which a quote would take in
    after = leftQuote ? '\n\n' : '';
  } else {
    const next = sections.find(({ start }) => start >= to);
    const needed = !next
      ? 0
      : next.type === 'paragraph'
        ? 0
        : NO_INTERRUPTING.has(next.type)
          ? 2
          : 1;
    after = separation(
      doc.slice(to, next?.start ?? to),
      Math.max(needed, leftQuote && next ? 2 : 0)
    );
  }

  // A cut to a table's very end, taking only some of its columns, still
  // closes its last cell
  const leftColumns = left && columns(left);
  let close = '';
  // Whether the cut starts in the row it ends in, which the note then opens
  // with the cells before it emptied
  const opened =
    left === entered && lineStartOf(doc, from) === lineStartOf(doc, to);
  if (entered) close = closeAt(doc, entered, to, columns(entered), opened);
  else if (leftColumns && to === left.end) {
    close = closeColumns(doc, left, to, leftColumns);
  }

  return {
    range: [from, to],
    open: left ? openAt(doc, left, from, leftColumns) : '',
    close,
    before,
    after,
    raw: left !== undefined && !leftQuote,
  };
}
