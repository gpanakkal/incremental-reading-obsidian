/**
 * Copies of the table arbitraries in `src/lib/block-delimiters.test.ts`
 * (task 0210). TODO(0213 merge): have that file import these instead.
 */
import fc from 'fast-check';

export const wordArb = fc.stringMatching(/^[a-z]{1,4}$/);
export const wordsArb = fc
  .array(wordArb, { minLength: 1, maxLength: 3 })
  .map((words) => words.join(' '));
export const linesArb = <T>(
  line: fc.Arbitrary<T>,
  minLength: number,
  maxLength: number
) => fc.array(line, { minLength, maxLength });

/** A generated table row: its line, and where each cell lies between its pipes. */
export type TableLine = {
  text: string;
  cells: { start: number; end: number }[];
};

/**
 * A table whose rows each have a pipe at their start, their end, both or
 * neither (a single column's at least at its end), an indent or trailing
 * space or not, cells
 * padded unevenly, some empty or holding an escaped pipe; with the offsets of
 * its cells in its text.
 */
export const gridArb = fc
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
