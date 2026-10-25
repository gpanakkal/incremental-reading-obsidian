import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BlockSection,
  imputeDelimiters,
  isLiteralAt,
  openBlockAtEnd,
  readSections,
} from './block-delimiters';

// #region HELPERS

/** What replaces a cut in its note, in the tests: a card's embed. */
const EMBED = '![[card]]';

/** The lines of `text` split at `\n`, with their offsets. */
function linesOf(text: string) {
  let start = 0;
  return text.split('\n').map((line) => {
    const out = { start, end: start + line.length, text: line };
    start += line.length + 1;
    return out;
  });
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const PAIRED_LINE = /^ {0,3}(\$\$|%%)/;
const QUOTE_LINE = /^ {0,3}>/;
const CALLOUT_LINE = /^ {0,3}> ?\[![^\]]*\]/;
const INDENTED_LINE = /^ {4}/;
/** A table's separator row: cells of dashes, a colon at either end or not. */
const isSeparator = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
const isBlank = (line: string) => line.trim() === '';
/** Lines that end a paragraph, or a quote's lazy line, by starting a block. */
const interrupts = (line: string) =>
  FENCE_LINE.test(line) || PAIRED_LINE.test(line) || QUOTE_LINE.test(line);

/**
 * The top-level sections of `text` as Obsidian's metadata cache reads the
 * blocks {@link docArb} writes, and what imputing delimiters makes of them,
 * which unit tests can't ask it for: the e2e probe in
 * e2e-tests/impute-delimiters.spec.ts checks these rules against it.
 * Fenced code runs to a closing fence or the end, math and comments to a
 * line ending in their delimiter, a quote over its lazy lines to a blank
 * line or a block, a table from a header over a separator while its lines
 * hold a pipe, and indented code over blank lines to its last indented line.
 */
function parseSections(text: string): BlockSection[] {
  const lines = linesOf(text);
  const sections: BlockSection[] = [];
  const push = (type: string, first: number, last: number) =>
    sections.push({ type, start: lines[first].start, end: lines[last].end });
  const continues = (j: number, test: (line: string) => boolean) =>
    j + 1 < lines.length &&
    !isBlank(lines[j + 1].text) &&
    test(lines[j + 1].text);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].text;
    if (isBlank(line)) {
      i++;
      continue;
    }
    let j = i;
    const fence = FENCE_LINE.exec(line)?.[1];
    const paired = PAIRED_LINE.exec(line)?.[1];
    if (fence) {
      const closer = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
      j = i + 1;
      while (j < lines.length && !closer.test(lines[j].text)) j++;
      j = Math.min(j, lines.length - 1);
      push('code', i, j);
    } else if (paired) {
      j = i + 1;
      while (j < lines.length && !lines[j].text.trimEnd().endsWith(paired)) {
        j++;
      }
      j = Math.min(j, lines.length - 1);
      push(paired === '$$' ? 'math' : 'comment', i, j);
    } else if (QUOTE_LINE.test(line)) {
      while (continues(j, (next) => QUOTE_LINE.test(next) || !interrupts(next)))
        j++;
      push(CALLOUT_LINE.test(line) ? 'callout' : 'blockquote', i, j);
    } else if (INDENTED_LINE.test(line)) {
      for (
        let k = i + 1;
        k < lines.length &&
        (INDENTED_LINE.test(lines[k].text) || isBlank(lines[k].text));
        k++
      ) {
        if (!isBlank(lines[k].text)) j = k;
      }
      push('code', i, j);
    } else if (line.includes('|') && isSeparator(lines[i + 1]?.text ?? '')) {
      j = i + 1;
      while (continues(j, (next) => next.includes('|'))) j++;
      push('table', i, j);
    } else {
      while (continues(j, (next) => !interrupts(next))) j++;
      push('paragraph', i, j);
    }
    i = j + 1;
  }
  return sections;
}

/** The type of the section of `sections` holding `at`, if any. */
const typeAt = (sections: readonly BlockSection[], at: number) =>
  sections.find(({ start, end }) => start <= at && at < end)?.type ?? null;

const wordArb = fc.stringMatching(/^[a-z]{1,4}$/);
const wordsArb = fc
  .array(wordArb, { minLength: 1, maxLength: 3 })
  .map((words) => words.join(' '));
const linesArb = <T>(
  line: fc.Arbitrary<T>,
  minLength: number,
  maxLength: number
) => fc.array(line, { minLength, maxLength });

type GeneratedBlock = { type: string; text: string };

const paragraphArb: fc.Arbitrary<GeneratedBlock> = linesArb(wordsArb, 1, 3).map(
  (lines) => ({ type: 'paragraph', text: lines.join('\n') })
);

/** A fenced code block, `closed` or running to the note's end. */
const fenceArb = (closed: boolean): fc.Arbitrary<GeneratedBlock> =>
  fc
    .record({
      char: fc.constantFrom('`', '~'),
      length: fc.integer({ min: 3, max: 4 }),
      info: fc.oneof(fc.constant(''), wordArb),
      indent: fc.constantFrom('', '  '),
      lines: linesArb(
        fc.oneof(
          wordsArb,
          fc.constant(''),
          wordsArb.map((w) => `  ${w}`)
        ),
        0,
        3
      ),
    })
    .map(({ char, length, info, indent, lines }) => {
      const run = char.repeat(length);
      return {
        type: 'code',
        text: [
          indent + run + info,
          ...lines,
          ...(closed ? [indent + run] : []),
        ].join('\n'),
      };
    });

/** Math or a comment, with text on its delimiters' lines or not. */
const pairedArb = (delimiter: string, type: string) =>
  fc
    .record({
      head: fc.oneof(
        fc.constant(''),
        wordsArb.map((w) => ` ${w}`)
      ),
      lines: linesArb(fc.oneof(wordsArb, fc.constant('')), 0, 2),
      tail: fc.oneof(
        fc.constant(''),
        wordsArb.map((w) => `${w} `)
      ),
    })
    .map(({ head, lines, tail }) => ({
      type,
      text: [delimiter + head, ...lines, tail + delimiter].join('\n'),
    }));

const quoteLineArb = fc
  .tuple(fc.constantFrom('> ', '>', '> > ', '   > '), wordsArb)
  .map(([markers, words]) => markers + words);

/** A quote, with lazy lines or not. */
const quoteArb: fc.Arbitrary<GeneratedBlock> = fc
  .tuple(quoteLineArb, linesArb(fc.oneof(quoteLineArb, wordsArb), 0, 2))
  .map(([first, rest]) => ({
    type: 'blockquote',
    text: [first, ...rest].join('\n'),
  }));

const calloutArb: fc.Arbitrary<GeneratedBlock> = fc
  .record({
    kind: wordArb,
    fold: fc.constantFrom('', '+', '-'),
    title: fc.oneof(
      fc.constant(''),
      wordsArb.map((w) => ` ${w}`)
    ),
    rest: linesArb(quoteLineArb, 0, 2),
  })
  .map(({ kind, fold, title, rest }) => ({
    type: 'callout',
    text: [`> [!${kind}]${fold}${title}`, ...rest].join('\n'),
  }));

/** A table, some cells holding an escaped pipe. */
const tableArb: fc.Arbitrary<GeneratedBlock> = fc
  .integer({ min: 1, max: 3 })
  .chain((columns) => {
    const cells = (cell: fc.Arbitrary<string>) =>
      fc.array(cell, { minLength: columns, maxLength: columns });
    const cellArb = fc.oneof(
      wordsArb,
      wordArb.map((w) => `${w}\\|${w}`)
    );
    return fc.record({
      header: cells(cellArb),
      separator: cells(fc.constantFrom('---', ':--', '-:', '-', ':-:')),
      rows: linesArb(cells(cellArb), 0, 3),
    });
  })
  .map(({ header, separator, rows }) => {
    const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
    return {
      type: 'table',
      text: [row(header), row(separator), ...rows.map(row)].join('\n'),
    };
  });

/** Indented code, blank lines among its lines or not. */
const indentedArb: fc.Arbitrary<GeneratedBlock> = fc
  .array(fc.tuple(wordsArb, fc.boolean()), { minLength: 1, maxLength: 3 })
  .map((lines) => ({
    type: 'code',
    text: lines
      .flatMap(([words, gap], k) => [
        `    ${words}`,
        ...(gap && k < lines.length - 1 ? [''] : []),
      ])
      .join('\n'),
  }));

/**
 * A note of blocks, blank lines between them, and an unclosed fence at its
 * end or not, with its sections as the metadata cache reads them.
 */
const docArb = fc
  .tuple(
    fc.array(
      fc.oneof(
        paragraphArb,
        fenceArb(true),
        pairedArb('$$', 'math'),
        pairedArb('%%', 'comment'),
        quoteArb,
        calloutArb,
        tableArb,
        indentedArb
      ),
      { minLength: 1, maxLength: 4 }
    ),
    fc.option(fenceArb(false), { nil: undefined })
  )
  .map(([blocks, unclosed]) => {
    let doc = '';
    const sections: BlockSection[] = [];
    let indented = false;
    for (const block of unclosed ? [...blocks, unclosed] : blocks) {
      // Indented code runs on over blank lines into indented code after it
      const isIndented = block.text.startsWith('    ');
      if (indented && isIndented) continue;
      indented = isIndented;
      if (doc) doc += '\n\n';
      sections.push({
        type: block.type,
        start: doc.length,
        end: doc.length + block.text.length,
      });
      doc += block.text;
    }
    return { doc, sections };
  });

/**
 * The spans of `doc` that are a delimiter alone: a fence's line, the run of
 * `$$` or `%%` and the spaces beside it, each with the blank space between
 * it and its block's text, a callout's markers. A cut inside one has nothing
 * to it but delimiter.
 */
function delimiterSpans(doc: string, sections: readonly BlockSection[]) {
  return sections
    .flatMap(({ type, start, end }): [number, number][] => {
      const lines = linesOf(doc.slice(start, end));
      const first = lines[0].text;
      const last = lines[lines.length - 1];
      // `open` past the blank space after it, `close` before that before it
      const blanks = (open: number, close: number) => {
        const text = doc.slice(open, close);
        return [
          open + (text.length - text.trimStart().length),
          close - (text.length - text.trimEnd().length),
        ];
      };
      if (type === 'code' && FENCE_LINE.test(first)) {
        const fenceRun = FENCE_LINE.exec(first)![1];
        const closed =
          lines.length > 1 && last.text.trim().startsWith(fenceRun);
        const [textStart, textEnd] = blanks(
          start + first.length,
          closed ? start + last.start : end
        );
        // Unclosed, only the blank space after its text, to the note's end
        return [
          [start, textStart],
          [textEnd, end],
        ];
      }
      if (type === 'math' || type === 'comment') {
        const open = /^\S+ ?/.exec(first)![0].length;
        const close = / ?\S+$/.exec(last.text)![0].length;
        const [textStart, textEnd] = blanks(start + open, end - close);
        return [
          [start, textStart],
          [textEnd, end],
        ];
      }
      if (type === 'callout') {
        return [
          [start, start + /^> \[![^\]]*\][+-]? ?/.exec(first)![0].length],
        ];
      }
      if (type === 'blockquote') {
        return [[start, start + /^(?:[ \t]*>[ \t]?)+/.exec(first)![0].length]];
      }
      return [];
    })
    .reduce<[number, number][]>((merged, [start, end]) => {
      // A block with no text is delimiter all through: its spans meet
      const last = merged.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
      return merged;
    }, []);
}

/** A note and a cut from it, and whether it is more than part of one delimiter. */
const cutArb = docArb.chain(({ doc, sections }) =>
  fc.tuple(fc.nat(doc.length), fc.nat(doc.length)).map(([a, b]) => ({
    doc,
    sections,
    range: [Math.min(a, b), Math.max(a, b)] as const,
    // Nothing, or part of one delimiter alone, which a cut takes nothing of
    collapsed:
      a === b ||
      delimiterSpans(doc, sections).some(
        ([start, end]) => start <= Math.min(a, b) && Math.max(a, b) <= end
      ),
  }))
);

/** A note and a cut from it of nothing but part of one delimiter. */
const delimiterCutArb = docArb
  .map(({ doc, sections }) => ({
    doc,
    sections,
    spans: delimiterSpans(doc, sections).filter(([start, end]) => end > start),
  }))
  .filter(({ spans }) => spans.length > 0)
  .chain(({ doc, sections, spans }) =>
    fc
      .constantFrom(...spans)
      .chain(([start, end]) =>
        fc
          .tuple(
            fc.integer({ min: start, max: end }),
            fc.integer({ min: start, max: end })
          )
          .filter(([a, b]) => a !== b)
      )
      .map(([a, b]) => ({
        doc,
        sections,
        range: [Math.min(a, b), Math.max(a, b)] as const,
      }))
  );

/** `doc` with `range` taken out and the embed in its place, as a card leaves it. */
function embedded(
  doc: string,
  sections: readonly BlockSection[],
  range: readonly [number, number]
) {
  const imputed = imputeDelimiters(doc, sections, range);
  const [from, to] = imputed.range;
  const head = doc.slice(0, from) + imputed.before;
  return {
    imputed,
    text: head + EMBED + imputed.after + doc.slice(to),
    embedAt: head.length,
    shift: head.length + EMBED.length + imputed.after.length - to,
  };
}

/** The note made of `range` of `doc`, with its delimiters. */
function noteOf(
  doc: string,
  sections: readonly BlockSection[],
  range: readonly [number, number]
) {
  const imputed = imputeDelimiters(doc, sections, range);
  const [from, to] = imputed.range;
  return {
    imputed,
    text: imputed.open + doc.slice(from, to) + imputed.close,
  };
}

/** A metadata cache whose parser reads any text as `sections`. */
function makeApp(computeMetadataAsync?: unknown) {
  return { metadataCache: { computeMetadataAsync } } as unknown as App;
}

/**
 * A table row's cells as GFM splits them at unescaped pipes, trimmed, or
 * `null` for a line that is no row: one with no pipe past its first cell, as
 * `| a`, ends the table, it and the lines after it a paragraph (seen in
 * Obsidian 1.14.5). An escaped pipe reads as a pipe.
 */
function rowCells(line: string): string[] | null {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (line.trim().startsWith('|')) parts.shift();
  if (parts.length < 2) return null;
  if (/(?<!\\)\|$/.test(line.trim())) parts.pop();
  return parts.map(cellText);
}

/** A cell's text as it reads: trimmed, an escaped pipe a pipe. */
const cellText = (cell: string) => cell.trim().replace(/\\\|/g, '|');

/**
 * What a row of a table's body with `columns` reads as, cell by cell: short
 * of cells, it reads the rest as empty, and any past them not at all. A
 * line that is no row (see {@link rowCells}) reads as empty here: check
 * that apart.
 */
const readRow = (line: string, columns: number) =>
  [...(rowCells(line) ?? []), ...Array<string>(columns).fill('')].slice(
    0,
    columns
  );

/** A generated table row: its line, and where each cell lies between its pipes. */
type TableLine = { text: string; cells: { start: number; end: number }[] };

/**
 * A table whose rows each have a pipe at their start, their end, both or
 * neither (a single column's at least at its end), an indent or trailing
 * space or not, cells
 * padded unevenly, some empty or holding an escaped pipe; with the offsets of
 * its cells in its text.
 */
const gridArb = fc
  .integer({ min: 1, max: 4 })
  .chain((columns) => {
    const cells = (cell: fc.Arbitrary<string>) =>
      fc.array(
        fc.tuple(
          cell,
          fc.constantFrom('', ' ', '  '),
          fc.constantFrom('', ' ', '  ')
        ),
        { minLength: columns, maxLength: columns }
      );
    const cellArb = fc.oneof(
      wordsArb,
      fc.constant(''),
      wordArb.map((w) => `${w}\\|${w}`),
      // A backslash before a letter, and an escaped pipe ending a cell
      wordArb.map((w) => `${w}\\${w}`),
      wordArb.map((w) => `${w}\\|`)
    );
    const styleArb = fc.record({
      lead: fc.boolean(),
      trail: fc.boolean(),
      indent: fc.constantFrom('', ' '),
      tail: fc.constantFrom('', ' '),
    });
    return fc.record({
      header: cells(wordsArb),
      separator: cells(fc.constantFrom('---', ':--', '-:', '-', ':-:')),
      rows: linesArb(cells(cellArb), 1, 3),
      styles: fc.array(styleArb, { minLength: 5, maxLength: 5 }),
    });
  })
  .map(({ header, separator, rows, styles }) => {
    const lines: TableLine[] = [];
    let offset = 0;
    [header, separator, ...rows].forEach((row, k) => {
      const { indent, tail } = styles[k];
      // No pipe-less side a cell is empty at, where its pipe would seem the
      // row's own; a single column needs a pipe past its cell to be a row
      const lead = styles[k].lead || row[0][0] === '';
      const trail =
        styles[k].trail || row.at(-1)![0] === '' || row.length === 1;
      let text = indent + (lead ? '|' : '');
      const cells = row.map(([cell, left, right], c) => {
        if (c > 0) text += '|';
        const start = text.length;
        text += left + cell + right;
        // A cell with nothing between its pipes has a space in it
        if (text.length === start) text += ' ';
        return { start: offset + start, end: offset + text.length };
      });
      text += (trail ? '|' : '') + tail;
      lines.push({ text, cells });
      offset += text.length + 1;
    });
    return { doc: lines.map(({ text }) => text).join('\n'), lines };
  });

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the sections the tests read', () => {
  it('are those the generated note was written with', () => {
    fc.assert(
      fc.property(docArb, ({ doc, sections }) => {
        expect(parseSections(doc)).toEqual(sections);
      })
    );
  });
});

describe('imputeDelimiters', () => {
  it('makes a note of a cut that renders each letter in the kind of block it was in', () => {
    fc.assert(
      fc.property(cutArb, ({ doc, sections, range, collapsed }) => {
        fc.pre(!collapsed);
        const { imputed, text } = noteOf(doc, sections, range);
        const [from, to] = imputed.range;
        const noteSections = parseSections(text);
        for (let i = from; i < to; i++) {
          if (!/[a-z]/.test(doc[i])) continue;
          expect(
            typeAt(noteSections, imputed.open.length + i - from),
            `letter ${i} of ${JSON.stringify(doc)} in ${JSON.stringify(text)}`
          ).toBe(typeAt(sections, i));
        }
      }),
      { numRuns: 2000 }
    );
  });

  it('leaves every letter of the note outside the cut in its kind of block, the embed in a paragraph or the quote it was cut from', () => {
    fc.assert(
      fc.property(cutArb, ({ doc, sections, range, collapsed }) => {
        fc.pre(!collapsed);
        const { imputed, text, embedAt, shift } = embedded(
          doc,
          sections,
          range
        );
        const [from, to] = imputed.range;
        const after = parseSections(text);
        for (let i = 0; i < doc.length; i++) {
          if (!/[a-z]/.test(doc[i]) || (from <= i && i < to)) continue;
          expect(
            typeAt(after, i < from ? i : i + shift),
            `letter ${i} of ${JSON.stringify(doc)} in ${JSON.stringify(text)}`
          ).toBe(typeAt(sections, i));
        }
        const quote = sections.find(
          ({ type, start, end }) =>
            (type === 'blockquote' || type === 'callout') &&
            start < from &&
            from < end
        );
        expect(typeAt(after, embedAt)).toBe(quote?.type ?? 'paragraph');
      }),
      { numRuns: 2000 }
    );
  });

  it('only ever widens a cut, and only over delimiters', () => {
    fc.assert(
      fc.property(cutArb, ({ doc, sections, range, collapsed }) => {
        fc.pre(!collapsed);
        const {
          range: [from, to],
        } = imputeDelimiters(doc, sections, range);
        const spans = delimiterSpans(doc, sections);
        const within = (a: number, b: number) =>
          a === b || spans.some(([start, end]) => start <= a && b <= end);
        expect(from).toBeLessThan(to);
        // Each end moved over delimiter alone: widened over one it cut into,
        // or narrowed off one the cut held nothing else of
        expect(within(Math.min(from, range[0]), Math.max(from, range[0]))).toBe(
          true
        );
        expect(within(Math.min(to, range[1]), Math.max(to, range[1]))).toBe(
          true
        );
      }),
      { numRuns: 1000 }
    );
  });

  it('leaves no code, math or comment block empty that was not, in the note or the new one', () => {
    // Blocks with no letter of text in them
    const empties = (text: string) =>
      parseSections(text).filter(
        ({ type, start, end }) =>
          ['code', 'math', 'comment'].includes(type) &&
          !/[a-z]/.test(text.slice(start, end))
      ).length;
    fc.assert(
      fc.property(cutArb, ({ doc, sections, range, collapsed }) => {
        fc.pre(!collapsed);
        const before = empties(doc);
        const { text: source } = embedded(doc, sections, range);
        const { text: note } = noteOf(doc, sections, range);
        expect(empties(source), JSON.stringify(source)).toBeLessThanOrEqual(
          before
        );
        // Only blocks it takes whole can be empty, or one it takes only
        // blank space of
        if (/[a-z]/.test(doc.slice(...range))) {
          expect(empties(note), JSON.stringify(note)).toBeLessThanOrEqual(
            before
          );
        }
      }),
      { numRuns: 2000 }
    );
  });

  it('copies a cut as it is only where it starts in code, math, a comment or a table', () => {
    fc.assert(
      fc.property(cutArb, ({ doc, sections, range, collapsed }) => {
        fc.pre(!collapsed);
        const imputed = imputeDelimiters(doc, sections, range);
        const [from] = imputed.range;
        expect(imputed.raw).toBe(
          sections.some(
            ({ type, start, end }) =>
              ['code', 'math', 'comment', 'table'].includes(type) &&
              start < from &&
              from < end
          )
        );
      })
    );
  });

  it('imputes nothing for a cut of nothing but part of one delimiter', () => {
    fc.assert(
      fc.property(delimiterCutArb, ({ doc, sections, range }) => {
        const imputed = imputeDelimiters(doc, sections, range);
        expect(imputed).toMatchObject({
          open: '',
          close: '',
          before: '',
          after: '',
          raw: false,
        });
        // Still a cut of something: as it was, or a block with no text whole
        expect(imputed.range[1]).toBeGreaterThan(imputed.range[0]);
      })
    );
  });

  it('reopens a fenced code block with its info string, and closes it with its run', () => {
    const doc = 'p\n\n  ~~~~py\none\ntwo\n  ~~~~\n\nq';
    const sections = parseSections(doc);
    const at = (text: string) => doc.indexOf(text);
    expect(imputeDelimiters(doc, sections, [at('ne'), at('wo')])).toEqual({
      range: [at('ne'), at('wo')],
      open: '  ~~~~py\n',
      close: '\n~~~~',
      before: '\n~~~~\n',
      after: '\n  ~~~~py\n',
      raw: true,
    });
    // Cut at a line's end and start, it adds no line break of its own
    expect(
      imputeDelimiters(doc, sections, [at('\ntwo'), at('two')])
    ).toMatchObject({ open: '  ~~~~py', close: '~~~~', before: '\n~~~~\n' });
  });

  it('takes in the opening fence line a cut starts on, and the closing one it ends on', () => {
    const doc = '```js\ncode\n```\n\nq';
    const sections = parseSections(doc);
    expect(imputeDelimiters(doc, sections, [3, 12]).range).toEqual([0, 14]);
    expect(imputeDelimiters(doc, sections, [5, 12]).range).toEqual([0, 14]);
  });

  it("moves a cut's start at the closing fence past it, and its end at the opening one before it", () => {
    const doc = 'p\n\n```\ncode\n```\n\nq';
    const sections = parseSections(doc);
    const close = doc.lastIndexOf('```');
    expect(imputeDelimiters(doc, sections, [close, doc.length]).range).toEqual([
      close + 3,
      doc.length,
    ]);
    expect(imputeDelimiters(doc, sections, [0, 6]).range).toEqual([0, 3]);
    // An end inside its text stays, and the fence is imputed
    expect(imputeDelimiters(doc, sections, [8, 10])).toMatchObject({
      range: [8, 10],
      close: '\n```',
    });
  });

  it('takes a whole code, math or comment block for a cut of all of its text, so neither half of it is left empty', () => {
    const doc = 'p\n\n```js\n\none\ntwo\n\n```\n\nq';
    const sections = parseSections(doc);
    const block = sections[1];
    const at = (text: string) => doc.indexOf(text);
    // From its text's first letter or the blank line before, to its last
    // letter's end or the blank line after
    for (const from of [at('one'), at('\n\none') + 1]) {
      for (const to of [at('two') + 3, doc.lastIndexOf('\n```')]) {
        expect(imputeDelimiters(doc, sections, [from, to])).toEqual({
          range: [block.start, block.end],
          open: '',
          close: '',
          before: '',
          after: '',
          raw: false,
        });
      }
    }
    // Ended at its text's start, or started at its end, it takes none of it
    expect(imputeDelimiters(doc, sections, [0, at('one')]).range).toEqual([
      0,
      block.start,
    ]);
    expect(
      imputeDelimiters(doc, sections, [at('two') + 3, doc.length]).range
    ).toEqual([block.end, doc.length]);
    // Unless the cut's bounds must stay put
    expect(
      imputeDelimiters(doc, sections, [at('one'), at('two') + 3], {
        overBlanks: false,
      })
    ).toMatchObject({ range: [at('one'), at('two') + 3], before: '```\n' });
    for (const [delimiter, type] of [
      ['$$', 'math'],
      ['%%', 'comment'],
    ]) {
      const paired = `${delimiter}\nab\n${delimiter}`;
      expect(
        imputeDelimiters(
          paired,
          [{ type, start: 0, end: paired.length }],
          [3, 5]
        ).range
      ).toEqual([0, paired.length]);
    }
  });

  it('moves a cut off a closing fence as it would without blanks by it, where they are not delimiter', () => {
    const doc = 'p\n\n```\ncode\n```\n\nq';
    const sections = parseSections(doc);
    const close = doc.lastIndexOf('```');
    const fixed = { overBlanks: false };
    // A start right at it moves past it, an end into it too, but an end
    // right at it stays
    expect(
      imputeDelimiters(doc, sections, [close, doc.length], fixed).range
    ).toEqual([close + 3, doc.length]);
    expect(
      imputeDelimiters(doc, sections, [8, close + 1], fixed).range
    ).toEqual([8, close + 3]);
    expect(imputeDelimiters(doc, sections, [8, close], fixed)).toMatchObject({
      range: [8, close],
      close: '```',
    });
  });

  it("moves a cut's start right after a quote's first markers to its start", () => {
    const doc = '> ab\n> cd';
    const sections = [{ type: 'blockquote', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [2, 7]).range).toEqual([0, 7]);
  });

  it('closes an unclosed fence in the note all the same', () => {
    const doc = '```\na\nb\nc';
    expect(imputeDelimiters(doc, parseSections(doc), [5, 7])).toMatchObject({
      open: '```',
      close: '\n```',
    });
  });

  it('reopens math and comments on their own line, and closes them on theirs', () => {
    for (const [delimiter, type] of [
      ['$$', 'math'],
      ['%%', 'comment'],
    ]) {
      const doc = `${delimiter} ab\ncd\nef ${delimiter}`;
      const sections = [{ type, start: 0, end: doc.length }];
      expect(imputeDelimiters(doc, sections, [4, 8])).toEqual({
        range: [4, 8],
        open: `${delimiter}\n`,
        close: `\n${delimiter}`,
        before: `\n${delimiter}\n`,
        after: `\n${delimiter}`,
        raw: true,
      });
      // Its text on the delimiters' lines comes with them; the spaces by
      // them don't keep a cut out
      expect(imputeDelimiters(doc, sections, [3, 12]).range).toEqual([
        0,
        doc.length,
      ]);
      expect(imputeDelimiters(doc, sections, [1, 9]).range).toEqual([0, 9]);
      expect(imputeDelimiters(doc, sections, [7, 8]).close).toBe(
        `\n${delimiter}`
      );
      expect(imputeDelimiters(doc, sections, [4, 6]).close).toBe(delimiter);
    }
  });

  it('reopens math whose delimiter has a line of its own without a line break of its own at a line end', () => {
    const doc = '$$\nab\ncd\n$$';
    const sections = [{ type: 'math', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [5, 8])).toMatchObject({
      range: [5, doc.length],
      open: '$$',
    });
  });

  it("gives back indented code's indent, and parts the embed from both its halves", () => {
    const doc = '    one two\n      three';
    const sections = [{ type: 'code', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [8, 18])).toEqual({
      range: [8, 18],
      open: '    ',
      close: '',
      before: '\n',
      after: '\n\n      ',
      raw: true,
    });
    expect(imputeDelimiters(doc, sections, [2, 14])).toMatchObject({
      open: '  ',
      before: '\n',
      after: '\n\n  ',
    });
    expect(imputeDelimiters(doc, sections, [12, 14])).toMatchObject({
      open: '',
      before: '',
    });
  });

  it("gives back a quote's markers, as far as the cut cut into them, and leaves the embed in it", () => {
    const doc = '> a\n> > one two\nlazy\n> three';
    const sections = [{ type: 'blockquote', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [12, 24])).toEqual({
      range: [12, 24],
      open: '> > ',
      close: '',
      before: '',
      after: '',
      raw: false,
    });
    expect(imputeDelimiters(doc, sections, [6, 24]).open).toBe('> ');
    expect(imputeDelimiters(doc, sections, [17, 24]).open).toBe('> ');
    // Its first line's markers come whole
    expect(imputeDelimiters(doc, sections, [1, 24]).range).toEqual([0, 24]);
  });

  it("gives back a callout's first line, or its markers to its title", () => {
    const doc = '> [!note]- Title\n> body';
    const sections = [{ type: 'callout', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [20, 22])).toMatchObject({
      open: '> [!note]- Title\n> ',
      before: '',
      after: '',
      raw: false,
    });
    expect(imputeDelimiters(doc, sections, [13, 22]).open).toBe('> [!note]- ');
    expect(imputeDelimiters(doc, sections, [5, 22]).range).toEqual([0, 22]);
  });

  it('opens a callout again after a blank line when a cut ends in it', () => {
    const doc = 'p\n\n> [!tip] T\n> body';
    const sections = parseSections(doc);
    expect(imputeDelimiters(doc, sections, [0, 18]).after).toBe(
      '\n\n> [!tip] T\n> '
    );
  });

  it("gives back a table's header and separator, the cells before the cut emptied", () => {
    const doc = '| a | b |\n| - | :-: |\n| c\\|d | e |\n| f | g |';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    const at = (text: string) => doc.indexOf(text);
    expect(imputeDelimiters(doc, sections, [at('e |'), at(' g')])).toEqual({
      range: [at('e |'), at(' g')],
      open: '| a | b |\n| - | :-: |\n| | ',
      close: ' |',
      before: ' |\n\n',
      after: '\n\n| a | b |\n| - | :-: |\n| |',
      raw: true,
    });
    // On the header, only its column in the note, and the separator's after
    // it; in the source, the header's cells after the cut emptied
    expect(imputeDelimiters(doc, sections, [at(' b'), at('b |')])).toEqual({
      range: [at(' b'), at('b |')],
      open: '|',
      close: ' |\n| :-: |',
      before: ' |\n| - | :-: |\n\n',
      after: '\n\n| | ',
      raw: true,
    });
    // On the separator, as it is, but for the columns the cut leaves out
    expect(
      imputeDelimiters(doc, sections, [at(':-:'), at('-: |')])
    ).toMatchObject({
      open: '| b |\n| ',
      close: '-: |',
      before: ':-: |\n\n',
      after: '\n\n| a | b |\n| - | :',
    });
  });

  it('gives back a table row cut at its ends without emptying a cell more', () => {
    const doc = '| a |\n| - |\n| b |\n| c |';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [5, 9])).toMatchObject({
      open: '| a |',
      before: '\n| - |\n\n',
    });
    expect(imputeDelimiters(doc, sections, [17, 20])).toMatchObject({
      open: '| a |\n| - |',
      after: '\n\n| a |\n| - |\n| ',
    });
    expect(imputeDelimiters(doc, sections, [12, 20])).toMatchObject({
      open: '| a |\n| - |\n',
      before: '\n',
    });
    expect(imputeDelimiters(doc, sections, [6, 9])).toMatchObject({
      open: '| a |\n',
      close: ' |',
      before: '| - |\n\n',
    });
  });

  it('reads a table whose lines end in CRLF', () => {
    const doc = '| a |\r\n| - |\r\n| b |';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [16, 18]).open).toBe(
      '| a |\n| - |\n| '
    );
  });

  it('keeps an embed off the line of a block it follows, and off a quote it would continue', () => {
    const doc = '```\nx\n```\n\n> q\n\n# h\n\np';
    const sections = [
      { type: 'code', start: 0, end: 9 },
      { type: 'blockquote', start: 11, end: 14 },
      { type: 'heading', start: 16, end: 19 },
      { type: 'paragraph', start: 21, end: 22 },
    ];
    expect(imputeDelimiters(doc, sections, [9, 22]).before).toBe('\n');
    expect(imputeDelimiters(doc, sections, [14, 22]).before).toBe('\n\n');
    expect(imputeDelimiters(doc, sections, [15, 22]).before).toBe('\n');
    expect(imputeDelimiters(doc, sections, [19, 22]).before).toBe('\n');
    expect(imputeDelimiters(doc, sections, [17, 22]).before).toBe('');
    expect(imputeDelimiters(doc, sections, [22, 22]).before).toBe('');
  });

  it('keeps an embed off a block it comes just before', () => {
    const doc = 'p\n\n| a |\n| - |\n\n```\nx\n```\n\nq';
    const sections = parseSections(doc);
    expect(imputeDelimiters(doc, sections, [0, 3]).after).toBe('\n\n');
    expect(imputeDelimiters(doc, sections, [0, 2]).after).toBe('\n');
    expect(imputeDelimiters(doc, sections, [0, 17]).after).toBe('\n\n');
    expect(imputeDelimiters(doc, sections, [0, 15]).after).toBe('\n');
    expect(imputeDelimiters(doc, sections, [0, 26]).after).toBe('');
    expect(imputeDelimiters(doc, sections, [0, doc.length - 1]).after).toBe('');
  });

  it('parts a paragraph from the quote it was cut to, and nothing from the note end', () => {
    const doc = '> qq\n\np r';
    const sections = parseSections(doc);
    expect(imputeDelimiters(doc, sections, [3, 8]).after).toBe('\n\n');
    expect(imputeDelimiters(doc, sections, [3, 5]).after).toBe('\n');
    expect(imputeDelimiters(doc, sections, [3, 6]).after).toBe('\n\n');
    expect(imputeDelimiters(doc, sections, [3, 4]).after).toBe('');
    const end = '> qq\n';
    expect(imputeDelimiters(end, parseSections(end), [3, 5]).after).toBe('');
  });

  it('enters a code block after a blank line where a quote is left', () => {
    const doc = '> qq\n\n```\nx\ny\n```';
    const sections = parseSections(doc);
    expect(imputeDelimiters(doc, sections, [3, 11]).after).toBe('\n\n```');
  });

  it('moves no cut over delimiters a section lacks', () => {
    for (const type of ['math', 'comment', 'blockquote', 'callout']) {
      const doc = 'ab\ncd';
      expect(
        imputeDelimiters(doc, [{ type, start: 0, end: doc.length }], [1, 4])
          .range
      ).toEqual([1, 4]);
    }
    const unclosed = '$$\nabc';
    expect(
      imputeDelimiters(unclosed, [{ type: 'math', start: 0, end: 6 }], [4, 5])
    ).toMatchObject({ range: [4, 5], close: '\n$$' });
  });

  it('takes no delimiter on the first line of math for its closing one', () => {
    const doc = '$$ ab $$';
    expect(
      imputeDelimiters(doc, [{ type: 'math', start: 0, end: 8 }], [4, 6]).range
    ).toEqual([4, 6]);
  });

  it('empties a cell of nothing but an escaped pipe', () => {
    // Over two rows, so it takes all columns
    const doc = '| a | b |\n| - | - |\n|\\|| c |\n| d | e |';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    expect(imputeDelimiters(doc, sections, [25, 32]).open).toBe(
      '| a | b |\n| - | - |\n| | '
    );
  });

  it('keeps an embed on the line of a paragraph or heading it is cut from the end or middle of', () => {
    const doc = 'ab\n\ncd';
    expect(
      imputeDelimiters(
        doc,
        [
          { type: 'paragraph', start: 0, end: 2 },
          { type: 'paragraph', start: 4, end: 6 },
        ],
        [2, 5]
      ).before
    ).toBe('');
    const heading = '> q\n# hd';
    expect(
      imputeDelimiters(
        heading,
        [
          { type: 'blockquote', start: 0, end: 3 },
          { type: 'heading', start: 4, end: 8 },
        ],
        [7, 8]
      ).before
    ).toBe('');
  });

  it('leaves blocks it knows nothing of as they are', () => {
    const doc = '- a\n- b';
    expect(
      imputeDelimiters(doc, [{ type: 'list', start: 0, end: 7 }], [2, 6])
    ).toEqual({
      range: [2, 6],
      open: '',
      close: '',
      before: '',
      after: '',
      raw: false,
    });
  });
});

describe('imputeDelimiters, in a table', () => {
  const TABLE = [
    '| Technique          | Purpose                     | Interval |',
    '| ------------------ | --------------------------- | -------- |',
    '| Spaced repetition  | Remember facts over time    | Growing  |',
    '| Cloze deletion     | Recall a missing word       | Varies   |',
  ].join('\n');
  const TABLE_SECTIONS = [{ type: 'table', start: 0, end: TABLE.length }];
  const snip = (text: string) => {
    const from = TABLE.indexOf(text);
    return noteOf(TABLE, TABLE_SECTIONS, [from, from + text.length]).text;
  };

  it('gives a cut from one cell of the body only its column', () => {
    expect(snip('Remember facts over time')).toBe(
      [
        '| Purpose                     |',
        '| --------------------------- |',
        '| Remember facts over time |',
      ].join('\n')
    );
    expect(snip('deletion')).toBe(
      ['| Technique          |', '| ------------------ |', '| deletion |'].join(
        '\n'
      )
    );
    expect(snip('Varies')).toBe(
      ['| Interval |', '| -------- |', '| Varies |'].join('\n')
    );
  });

  it('takes the columns of the one row a cut reaches into from outside the table, or from a line end', () => {
    // From before the table into its header: the separator follows
    const before = 'p\n\n| a | b |\n| - | - |';
    expect(
      imputeDelimiters(
        before,
        [
          { type: 'paragraph', start: 0, end: 1 },
          { type: 'table', start: 3, end: before.length },
        ],
        [0, before.indexOf(' |')]
      ).close
    ).toBe(' |\n| - |');
    // From a row's line end into the next row: nothing of the row above
    const doc = '| a | b |\n| - | - |\n| c | d |\n| e | f |';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    expect(
      imputeDelimiters(doc, sections, [
        doc.indexOf('\n| e'),
        doc.indexOf(' | f'),
      ])
    ).toMatchObject({ open: '| a |\n| - |', close: ' |' });
  });

  it('takes all columns for a cut through the line end of a row with no pipe to close it', () => {
    // Its text ends past the line break, so no pipe can close its cell, and
    // a row with only its opening pipe ends the table
    const doc = 'a | b\n--- | ---\nc | d\ne | f';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    const lines = (from: number, to: number) =>
      noteOf(doc, sections, [from, to]).text.split('\n').map(rowCells);
    expect(lines(doc.indexOf('d'), doc.indexOf('e'))).toEqual([
      ['a', 'b'],
      ['---', '---'],
      ['', 'd'],
      null,
    ]);
    expect(lines(doc.indexOf('b'), doc.indexOf('---'))).toEqual([
      ['', 'b'],
      ['---', '---'],
    ]);
  });

  it('opens the emptied rest of a row with no opening pipe that a cut leaves only blank space before', () => {
    const doc = 'h | i\n--- | ---\n a | b\n c | d';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    const blank = doc.indexOf(' c') + 1;
    // In the note, a cut over rows ending in it
    const rows = noteOf(doc, sections, [doc.indexOf('b'), blank])
      .text.split('\n')
      .slice(2);
    expect(rows.map(rowCells)).not.toContain(null);
    expect(rows.map((row) => readRow(row, 2))).toEqual([
      ['', 'b'],
      ['', ''],
    ]);
    // In the source, a card's cut starting in it
    const row = embedded(doc, sections, [blank, doc.length]).text.split(
      '\n'
    )[3];
    expect(rowCells(row)).not.toBeNull();
    expect(readRow(row, 2)).toEqual(['', '']);
    // A one-column table's row the note opens itself gets no second pipe
    const column = 'h|\n---|\n a|';
    expect(
      noteOf(
        column,
        [{ type: 'table', start: 0, end: column.length }],
        [column.indexOf(' a'), column.indexOf('a')]
      ).text
    ).toBe('h|\n---|\n|  |');
    // An indented row with its own opening pipe gets none more
    const indented = '| h | i |\n| - | - |\n| a | b |\n  | c | d |';
    const before = indented.indexOf('  |') + 1;
    expect(
      noteOf(
        indented,
        [{ type: 'table', start: 0, end: indented.length }],
        [indented.indexOf('b'), before]
      ).text.split('\n')[3]
    ).toBe('  | | |');
  });

  it('takes all columns for a cut on past the table from a row with no pipe to close it', () => {
    const sectionsOf = (doc: string) => [
      { type: 'table', start: 0, end: doc.indexOf('\n\n') },
      { type: 'paragraph', start: doc.indexOf('after'), end: doc.length },
    ];
    const snip = (doc: string) =>
      imputeDelimiters(doc, sectionsOf(doc), [doc.indexOf('d'), doc.length]);
    expect(snip('| a | b |\n| - | - |\n| c | d\n\nafter')).toMatchObject({
      open: '| a | b |\n| - | - |\n| | ',
      close: '',
    });
    // A pipe closes it, so it takes its column alone
    expect(snip('| a | b |\n| - | - |\n| c | d |\n\nafter')).toMatchObject({
      open: '| b |\n| - |\n| ',
      close: '',
    });
  });

  it('opens a cut at the pipe that opens its cell, and closes one past the pipe that closes it, with nothing more', () => {
    expect(snip('| Remember facts over time    |')).toBe(
      [
        '| Purpose                     |',
        '| --------------------------- |',
        '| Remember facts over time    |',
      ].join('\n')
    );
  });

  it('keeps a cut of all the cells of one row to the table as it is', () => {
    const doc = ' | a | b |\n | - | - |\n | c | d |';
    expect(
      imputeDelimiters(
        doc,
        [{ type: 'table', start: 0, end: doc.length }],
        [doc.indexOf('c'), doc.indexOf('d') + 1]
      ).open
    ).toBe(' | a | b |\n | - | - |\n | ');
  });

  it('takes the columns a row short of cells has, blank space after its last pipe or not', () => {
    for (const tail of ['', '  ']) {
      const doc = `| a | b | c |\n| - | - | - |\n| d | e |${tail}\n| f | g | h |`;
      expect(
        noteOf(
          doc,
          [{ type: 'table', start: 0, end: doc.length }],
          [doc.indexOf('e'), doc.indexOf('| f')]
        ).text
      ).toBe(`| b |\n| - |\n| e |${tail}\n`);
    }
  });

  it("takes no column past the header's for a cut from a cell past them", () => {
    // Which no reading shows
    const doc = '| a | b |\n| - | - |\n| c | d | e |';
    const from = doc.indexOf('e');
    expect(
      noteOf(
        doc,
        [{ type: 'table', start: 0, end: doc.length }],
        [from, from + 1]
      ).text
    ).toBe('| b |\n| - |\n| | e');
  });

  it('reads a row of one pipe as one empty cell', () => {
    const doc = '| a | b |\n| - | - |\n|';
    expect(
      noteOf(
        doc,
        [{ type: 'table', start: 0, end: doc.length }],
        [doc.length - 1, doc.length]
      ).text
    ).toBe('| a |\n| - |\n||');
  });

  it("keeps a separator's dashes and colons a cut starts after, in its column", () => {
    const doc = '| a | b |\n| - | :-: |\n| c | d |';
    const from = doc.indexOf('-: |');
    expect(
      imputeDelimiters(
        doc,
        [{ type: 'table', start: 0, end: doc.length }],
        [from, from + 1]
      ).open
    ).toBe('| b |\n| :');
  });

  it('cuts no columns out of a block that is no table', () => {
    expect(
      imputeDelimiters(
        '> a | b',
        [{ type: 'blockquote', start: 0, end: 7 }],
        [5, 7]
      ).close
    ).toBe('');
  });

  it('reads the row a cut ends on at the line break of a CRLF line', () => {
    const doc = '| a | b |\r\n| - | - |\r\n| c | d |\r\n| e | f |';
    const sections = [{ type: 'table', start: 0, end: doc.length }];
    expect(
      imputeDelimiters(doc, sections, [doc.indexOf('d'), doc.indexOf('| e')])
    ).toMatchObject({ open: '| b |\n| - |\n| ', close: '' });
    expect(
      imputeDelimiters(doc, sections, [doc.indexOf('b'), doc.indexOf('| -')])
        .close
    ).toBe('| - |');
  });

  it('gives a cut over cells of one row the columns it spans', () => {
    expect(snip('repetition  | Remember')).toBe(
      [
        '| Technique          | Purpose                     |',
        '| ------------------ | --------------------------- |',
        '| repetition  | Remember |',
      ].join('\n')
    );
  });

  it('keeps each cell of the body a cut is in in its column, and the header and separator to those columns', () => {
    fc.assert(
      fc.property(
        gridArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        ({ doc, lines }, r, c, span, a, b) => {
          const body = lines.slice(2);
          const row = body[r % body.length];
          const columns = row.cells.length;
          const c1 = c % columns;
          const c2 = c1 + (span % (columns - c1));
          const first = row.cells[c1];
          const last = row.cells[c2];
          // Its start in its first cell, its last letter in its last
          const from = first.start + (a % (first.end - first.start));
          const lastFrom = c1 === c2 ? from : last.start;
          const to = lastFrom + 1 + (b % (last.end - lastFrom));
          const { text } = noteOf(
            doc,
            [{ type: 'table', start: 0, end: doc.length }],
            [from, to]
          );

          const note = text.split('\n');
          const columnsOf = (line: TableLine) =>
            line.cells
              .slice(c1, c2 + 1)
              .map(({ start, end }) => cellText(doc.slice(start, end)));
          const message = JSON.stringify({ doc, text });
          const kept = row.cells
            .slice(c1, c2 + 1)
            .map(({ start, end }) =>
              cellText(doc.slice(Math.max(start, from), Math.min(end, to)))
            );
          expect(note, message).toHaveLength(3);
          expect(rowCells(note[0]), message).toEqual(columnsOf(lines[0]));
          expect(rowCells(note[1]), message).toEqual(columnsOf(lines[1]));
          expect(rowCells(note[2]), message).not.toBeNull();
          expect(readRow(note[2], kept.length), message).toEqual(kept);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('keeps every row of the body a cut spans in its columns, its first and last cell where they were', () => {
    fc.assert(
      fc.property(
        gridArb.filter(({ lines }) => lines.length > 3),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        ({ doc, lines }, r, length, c, d, a, b) => {
          const body = lines.slice(2);
          const top = r % (body.length - 1);
          const bottom = top + 1 + (length % (body.length - top - 1));
          const columns = lines[0].cells.length;
          const first = body[top].cells[c % columns];
          const last = body[bottom].cells[d % columns];
          const from = first.start + (a % (first.end - first.start));
          const to = last.start + 1 + (b % (last.end - last.start));
          const { text } = noteOf(
            doc,
            [{ type: 'table', start: 0, end: doc.length }],
            [from, to]
          );

          const note = text.split('\n');
          const message = JSON.stringify({ doc, text });
          expect(note).toHaveLength(2 + bottom - top + 1);
          expect(rowCells(note[0]), message).toHaveLength(columns);
          expect(rowCells(note[1]), message).toHaveLength(columns);
          note.slice(2).forEach((line, k) => {
            expect(rowCells(line), message).not.toBeNull();
            expect(readRow(line, columns), message).toEqual(
              body[top + k].cells.map(({ start, end }) =>
                cellText(doc.slice(Math.max(start, from), Math.min(end, to)))
              )
            );
          });
        }
      ),
      { numRuns: 1000 }
    );
  });
});

describe('isLiteralAt', () => {
  it('says whether a point lies inside code, math or a comment', () => {
    fc.assert(
      fc.property(docArb, fc.nat(), ({ doc, sections }, n) => {
        const at = n % (doc.length + 1);
        expect(isLiteralAt(doc, sections, at)).toBe(
          sections.some(
            ({ type, start, end }) =>
              ['code', 'math', 'comment'].includes(type) &&
              start < at &&
              at < end
          )
        );
      })
    );
  });
});

describe('openBlockAtEnd', () => {
  it('reads the fenced code, math or comment block a text ends in, but for a fence line', () => {
    fc.assert(
      fc.property(docArb, ({ doc, sections }) => {
        for (let at = 0; at < doc.length; at++) {
          if (!/[a-z]/.test(doc[at])) continue;
          const section = sections.find(
            ({ start, end }) => start <= at && at < end
          );
          const fenced =
            section?.type === 'code' &&
            FENCE_LINE.test(doc.slice(section.start)) &&
            doc.slice(section.start, at).includes('\n');
          const expected =
            section?.type === 'math' || section?.type === 'comment'
              ? section.type
              : fenced
                ? 'code'
                : null;
          expect(openBlockAtEnd(doc.slice(0, at)), `${at} of ${doc}`).toBe(
            expected
          );
        }
      })
    );
  });

  it('reads math or a comment closed on the line it opens on, and CRLF lines', () => {
    expect(openBlockAtEnd('$$ a $$\nb')).toBe(null);
    // Its delimiter opens it only at its line's start, after up to 3 spaces
    expect(openBlockAtEnd('a $$\nb')).toBe(null);
    expect(openBlockAtEnd('   $$\nb')).toBe('math');
    expect(openBlockAtEnd('$$ a $$')).toBe(null);
    expect(openBlockAtEnd('%%a%%\n')).toBe(null);
    expect(openBlockAtEnd('~~~~\r\na\r\n~~~\r\nb')).toBe('code');
    expect(openBlockAtEnd('~~~~\r\na\r\n~~~~\r\nb')).toBe(null);
  });
});

describe('readSections', () => {
  it("reads the sections of the parser's metadata, from the text's UTF-8 bytes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.array(
          fc.record({ type: fc.string(), start: fc.nat(), end: fc.nat() })
        ),
        async (text, sections) => {
          let read: string | null = null;
          const app = makeApp(async (data: ArrayBuffer) => {
            read = new TextDecoder().decode(data);
            return {
              sections: sections.map(({ type, start, end }) => ({
                type,
                position: { start: { offset: start }, end: { offset: end } },
              })),
            };
          });

          expect(await readSections(app, text)).toEqual(sections);
          expect(read).toBe(
            new TextDecoder().decode(new TextEncoder().encode(text))
          );
        }
      )
    );
  });

  it('reads no sections from metadata with none, or none at all', async () => {
    expect(
      await readSections(
        makeApp(async () => ({})),
        'x'
      )
    ).toEqual([]);
    expect(
      await readSections(
        makeApp(async () => null),
        'x'
      )
    ).toEqual([]);
  });

  it('reads nothing where the parser is out of reach, or fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    expect(await readSections({} as App, 'x')).toBeNull();
    expect(await readSections(makeApp(), 'x')).toBeNull();
    expect(await readSections(makeApp('nope'), 'x')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    const error = new Error('worker gone');
    expect(
      await readSections(
        makeApp(async () => {
          throw error;
        }),
        'x'
      )
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.any(String), error);
  });
});
