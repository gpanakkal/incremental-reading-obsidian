import { gridArb } from '#/test/table-arbitraries';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { narrowChanges } from './minimal-change';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from './SnippetOffsetTracker';

// #region HELPERS

function createHighlight(
  id: string,
  start: number,
  end: number
): SnippetHighlight {
  return {
    id,
    reference: `test-ref-${id}`,
    start_offset: start,
    end_offset: end,
    parent: 'parent-article',
  } as SnippetHighlight;
}

type Span = readonly [number, number];

/** Whether two spans share any text; a zero-length one shares none. */
const overlaps = (a: Span, b: Span) =>
  Math.max(a[0], b[0]) < Math.min(a[1], b[1]);

/** Whether `pos` lies inside `span`, not at either end. */
const inside = (pos: number, [start, end]: Span) => start < pos && pos < end;

/** A document of few letters, so edits often border like text. */
const docTextArb = fc.string({
  unit: fc.constantFrom('a', 'b', ' ', '\n'),
  maxLength: 30,
});

/** Any edits to a document of `length`: deletions, insertions, replacements. */
const changeSetArb = (length: number) =>
  fc
    .array(
      fc.record({
        a: fc.nat({ max: length }),
        b: fc.nat({ max: length }),
        insert: docTextArb.map((t) => t.slice(0, 6)),
      }),
      { maxLength: 3 }
    )
    .map((edits) => {
      // Sorted and kept apart, as one ChangeSet's edits must be
      const specs: ChangeSpec[] = [];
      let end = -1;
      for (const { a, b, insert } of edits
        .map((e) => ({ ...e, a: Math.min(e.a, e.b), b: Math.max(e.a, e.b) }))
        .sort((x, y) => x.a - y.a || x.b - y.b)) {
        if (a <= end) continue;
        specs.push({ from: a, to: b, insert });
        end = b;
      }
      return ChangeSet.of(specs, length);
    });

/**
 * An edit and another placement of it: as `SnippetHighlightExtension` makes
 * them of an edit (narrowed latest and earliest), or any two edits at all.
 */
const editPairFor = (doc: string) => {
  const text = Text.of(doc.split('\n'));
  const narrowed = (changes: ChangeSet) => ({
    changes: narrowChanges(changes, text, 'latest'),
    alternative: narrowChanges(changes, text, 'earliest'),
  });
  return fc.oneof(
    // A whole-document replacement, as `editor.setValue` makes
    docTextArb.map((next) =>
      narrowed(
        ChangeSet.of({ from: 0, to: doc.length, insert: next }, doc.length)
      )
    ),
    changeSetArb(doc.length).map(narrowed),
    fc.record({
      changes: changeSetArb(doc.length),
      alternative: changeSetArb(doc.length),
    })
  );
};

/** Body-relative highlights in a body of `max` characters. */
type SpansArb = (max: number) => fc.Arbitrary<Span[]>;

/** In any order, as rows can load in any. */
const shuffled = (spans: Span[]) =>
  fc.shuffledSubarray(spans, {
    minLength: spans.length,
    maxLength: spans.length,
  });

/**
 * Highlights that all share text with one another, each running across one
 * point of the body — and maybe one collapsed at that point, nested in all.
 */
const crossingSpansArb: SpansArb = (max) =>
  max < 2
    ? fc.constant([])
    : fc.integer({ min: 1, max: max - 1 }).chain((point) =>
        fc
          .tuple(
            fc.array(
              fc.tuple(
                fc.integer({ min: 0, max: point - 1 }),
                fc.integer({ min: point + 1, max })
              ),
              { minLength: 1, maxLength: 5 }
            ),
            fc.boolean()
          )
          .map(([spans, nested]): Span[] =>
            nested ? [...spans, [point, point]] : spans
          )
          .chain(shuffled)
      );

/** Any highlights at all: overlapping, nested, collapsed anywhere. */
const anySpansArb: SpansArb = (max) =>
  fc
    .array(
      fc
        .tuple(fc.nat({ max }), fc.nat({ max }))
        .map(([a, b]): Span => [Math.min(a, b), Math.max(a, b)]),
      { maxLength: 6 }
    )
    .chain(shuffled);

/** A document, its body start, highlights in its body, and an edit pair. */
const trackedEditArb = (spansArb: SpansArb) =>
  docTextArb.chain((doc) =>
    fc.nat({ max: doc.length }).chain((oldBodyStart) =>
      fc.record({
        oldBodyStart: fc.constant(oldBodyStart),
        newBodyStart: fc.nat({ max: 40 }),
        spans: spansArb(doc.length - oldBodyStart),
        pair: editPairFor(doc),
      })
    )
  );

/**
 * Where `updateOffsetsWithMapping` puts each of `spans`, the `i`th with the id
 * `ids[i]`.
 */
function mapSpans(
  spans: readonly Span[],
  changes: ChangeSet,
  oldBodyStart: number,
  newBodyStart: number,
  alternative?: ChangeSet,
  ids = spans.map((_, i) => `${i}`)
): Span[] {
  const tracker = new SnippetOffsetTracker();
  tracker.loadHighlights(
    'f.md',
    spans.map(([start, end], i) => createHighlight(ids[i], start, end))
  );
  tracker.updateOffsetsWithMapping(
    'f.md',
    changes,
    oldBodyStart,
    newBodyStart,
    alternative
  );
  return tracker
    .getHighlights('f.md')
    .map((h) => [h.start_offset, h.end_offset] as const);
}

const length = ([start, end]: Span) => end - start;

/** Each span on its own, as the edit alone and its alternative move it. */
const alone = (
  spans: readonly Span[],
  pair: { changes: ChangeSet; alternative: ChangeSet },
  oldBodyStart: number,
  newBodyStart: number
) =>
  spans.map((span) => ({
    span,
    edit: mapSpans([span], pair.changes, oldBodyStart, newBodyStart)[0],
    alt: mapSpans([span], pair.alternative, oldBodyStart, newBodyStart)[0],
  }));

/** Whether a highlight that would take its alternative could, alone. */
const wantsAlt = ({ span, edit, alt }: ReturnType<typeof alone>[number]) =>
  length(span) > 0 &&
  length(edit) !== length(span) &&
  length(alt) === length(span);

const same = (a: Span, b: Span) => a[0] === b[0] && a[1] === b[1];

/**
 * Whether two highlights share text or one sits collapsed inside the other:
 * overlapping as the user made them, or nested.
 */
const related = (a: Span, b: Span) =>
  overlaps(a, b) ||
  (length(a) === 0 && inside(a[0], b)) ||
  (length(b) === 0 && inside(b[0], a));

/**
 * Stored offsets of which one, at least, lies past the end of a body of
 * `max` characters, as a note shortened behind the plugin's back leaves
 * them: in either order, from before the body to well past its end.
 */
const pastEndSpanArb = (max: number) =>
  fc
    .tuple(
      fc.integer({ min: -5, max: max + 20 }),
      fc.integer({ min: -5, max: max + 20 })
    )
    .filter(([a, b]) => a > max || b > max)
    .map((span): Span => span);

/**
 * A document, its body start, highlights in its body, one or more whose
 * offsets reach past its end, and an edit pair.
 */
const pastEndEditArb = (pastEnd: (max: number) => fc.Arbitrary<Span>) =>
  trackedEditArb(anySpansArb).chain((tracked) => {
    const max = tracked.pair.changes.length - tracked.oldBodyStart;
    return fc.record({
      ...Object.fromEntries(
        Object.entries(tracked).map(([k, v]) => [k, fc.constant(v)])
      ),
      stale: fc.array(pastEnd(max), { minLength: 1, maxLength: 3 }),
      max: fc.constant(max),
    }) as fc.Arbitrary<typeof tracked & { stale: Span[]; max: number }>;
  });

/** Whether none of a span's text lies in a body of `max` characters. */
const whollyPast = ([start]: Span, max: number) => start >= max;

/** Stored offsets in any order and range, and a document to show them in. */
const shownCaseArb = fc.record({
  start: fc.integer({ min: -30, max: 60 }),
  end: fc.integer({ min: -30, max: 60 }),
  bodyStart: fc.nat({ max: 20 }),
  docLength: fc.nat({ max: 50 }),
});

/** Text around the table in the documents the re-pad cases rewrite. */
const INTRO = 'Intro\n\n';
const OUTRO = '\n\nOutro';

/**
 * A generated table re-padded as Obsidian's table editor does it: every cell's
 * text kept, its padding changed, and the separator row's dashes lengthened
 * (they follow the column width); with a highlight on part of one cell's text.
 */
const repaddedTableArb = gridArb.chain(({ doc, lines }) => {
  const cells = lines.flatMap(({ cells }, row) =>
    cells.map((cell) => ({ ...cell, row }))
  );
  // Cells with text a highlight can lie on: never the separator's dashes
  const marked = cells.filter(
    ({ row, start, end }) => row !== 1 && doc.slice(start, end).trim() !== ''
  );
  return fc
    .record({
      pads: fc.array(fc.tuple(fc.nat({ max: 3 }), fc.nat({ max: 3 })), {
        minLength: cells.length,
        maxLength: cells.length,
      }),
      dashes: fc.nat({ max: 3 }),
      cell: fc.constantFrom(...marked),
      from: fc.nat(),
      to: fc.nat(),
    })
    .map(({ pads, dashes, cell, from, to }) => {
      let after = '';
      let last = 0;
      cells.forEach(({ start, end, row }, i) => {
        let text = doc.slice(start, end).trim();
        if (row === 1) {
          text = text.replace(/-+/, (run) => run + '-'.repeat(dashes));
        }
        after += doc.slice(last, start) + ' '.repeat(pads[i][0]) + text;
        after += ' '.repeat(pads[i][1]);
        last = end;
      });
      after += doc.slice(last);
      const raw = doc.slice(cell.start, cell.end);
      const text = raw.trim();
      const textStart = INTRO.length + cell.start + raw.indexOf(text);
      const p = from % text.length;
      const q = p + 1 + (to % (text.length - p));
      return {
        before: INTRO + doc + OUTRO,
        after: INTRO + after + OUTRO,
        table: {
          from: INTRO.length,
          to: INTRO.length + doc.length,
          insert: after,
        },
        highlight: [textStart + p, textStart + q] as const,
        text: text.slice(p, q),
      };
    });
});

/**
 * A generated table laid out as Obsidian's table editor lays one out: a pipe
 * at each side of every row, each cell padded to its column's widest, the
 * separator's dashes as wide; with a highlight from anywhere off the
 * separator row to anywhere off it, padding and pipes included.
 */
const reformattedTableArb = gridArb.chain(({ doc, lines }) => {
  const texts = lines.map(({ cells }) =>
    cells.map(({ start, end }) => doc.slice(start, end).trim())
  );
  const widths = texts[0].map((_, c) =>
    Math.max(3, ...texts.map((row) => row[c].length))
  );
  const after = texts
    .map((row, k) => {
      const cells = row.map((text, c) =>
        k === 1
          ? text.replace(/-+/, (run) =>
              run.padEnd(run.length + widths[c] - text.length, '-')
            )
          : text.padEnd(widths[c])
      );
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');
  const separator = {
    from: lines[0].text.length,
    to: doc.indexOf('\n', lines[0].text.length + 1) + 1,
  };
  // Off the separator row: before its line break or after its own
  const offSeparator = fc
    .nat({ max: doc.length - (separator.to - separator.from) })
    .map((p) => (p <= separator.from ? p : p + separator.to - separator.from));
  return fc
    .tuple(offSeparator, offSeparator)
    .filter(([p, q]) => p !== q)
    .map(([p, q]) => ({
      before: INTRO + doc + OUTRO,
      after: INTRO + after + OUTRO,
      table: {
        from: INTRO.length,
        to: INTRO.length + doc.length,
        insert: after,
      },
      highlight: [
        INTRO.length + Math.min(p, q),
        INTRO.length + Math.max(p, q),
      ] as const,
    }));
});

/**
 * A generated table rewritten whole as Obsidian's table commands rewrite it to
 * insert a column: an empty column at any index, laid out anew (a pipe at
 * each side of every row, each cell padded to its column's widest); with a
 * highlight on part of one cell's text, in any row off the separator.
 */
const columnInsertedTableArb = gridArb.chain(({ doc, lines }) => {
  const texts = lines.map(({ cells }) =>
    cells.map(({ start, end }) => doc.slice(start, end).trim())
  );
  const marked = lines.flatMap(({ cells }, row) =>
    row === 1
      ? []
      : cells.filter(({ start, end }) => doc.slice(start, end).trim() !== '')
  );
  return fc
    .record({
      at: fc.nat({ max: texts[0].length }),
      cell: fc.constantFrom(...marked),
      from: fc.nat(),
      to: fc.nat(),
    })
    .map(({ at, cell, from, to }) => {
      const grown = texts.map((row, k) => [
        ...row.slice(0, at),
        k === 1 ? '---' : '',
        ...row.slice(at),
      ]);
      const widths = grown[0].map((_, c) =>
        Math.max(3, ...grown.map((row) => row[c].length))
      );
      const after = grown
        .map((row, k) => {
          const cells = row.map((text, c) =>
            k === 1
              ? text.replace(/-+/, (run) =>
                  run.padEnd(run.length + widths[c] - text.length, '-')
                )
              : text.padEnd(widths[c])
          );
          return `| ${cells.join(' | ')} |`;
        })
        .join('\n');
      const raw = doc.slice(cell.start, cell.end);
      const text = raw.trim();
      const textStart = INTRO.length + cell.start + raw.indexOf(text);
      const p = from % text.length;
      const q = p + 1 + (to % (text.length - p));
      return {
        before: INTRO + doc + OUTRO,
        after: INTRO + after + OUTRO,
        table: {
          from: INTRO.length,
          to: INTRO.length + doc.length,
          insert: after,
        },
        highlight: [textStart + p, textStart + q] as const,
        text: text.slice(p, q),
      };
    });
});

/**
 * `text` less what a re-pad changes in it: its whitespace, its pipes (a row
 * may gain them at its sides), and how many dashes a run of them has.
 */
const sansPadding = (text: string) =>
  text.replace(/[\s|]+/g, '').replace(/-+/g, '-');

/**
 * Maps `tracker`'s highlights in `path` through `rewrite` of `before`, narrowed
 * both ways as `SnippetHighlightExtension` narrows an edit.
 */
function mapRewrite(
  tracker: SnippetOffsetTracker,
  path: string,
  before: string,
  rewrite: ChangeSpec
): void {
  const doc = Text.of(before.split('\n'));
  const changes = ChangeSet.of(rewrite, doc.length);
  tracker.updateOffsetsWithMapping(
    path,
    narrowChanges(changes, doc),
    0,
    0,
    narrowChanges(changes, doc, 'earliest')
  );
}

/** The text each of `tracker`'s highlights in `path` lies on in `doc`. */
const shownIn = (tracker: SnippetOffsetTracker, path: string, doc: string) =>
  tracker
    .getHighlights(path)
    .map((h) => doc.slice(h.start_offset, h.end_offset));

// #endregion

describe('SnippetOffsetTracker', () => {
  let tracker: SnippetOffsetTracker;
  const filePath = 'test/file.md';

  beforeEach(() => {
    tracker = new SnippetOffsetTracker();
  });

  describe('updateOffsetsWithMapping', () => {
    describe('with an alternative placement of the same edit', () => {
      it('never leaves two highlights sharing text, or one collapsed inside the other, that did not before', () => {
        fc.assert(
          fc.property(
            trackedEditArb(anySpansArb),
            ({ spans, pair, oldBodyStart, newBodyStart }) => {
              const after = mapSpans(
                spans,
                pair.changes,
                oldBodyStart,
                newBodyStart,
                pair.alternative
              );
              spans.forEach((a, i) =>
                spans.forEach((b, j) => {
                  // Overlapping as the user made them, or nested, they map
                  // as they will
                  if (i === j || related(a, b)) return;
                  expect(overlaps(after[i], after[j])).toBe(false);
                  // Or the next edit there could re-expand it into the other
                  if (length(after[i]) === 0) {
                    expect(inside(after[i][0], after[j])).toBe(false);
                  }
                })
              );
            }
          ),
          { numRuns: 300 }
        );
      });

      it('moves each highlight as the edit or its alternative does, or leaves one collapsed, only to keep its length or keep them apart', () => {
        fc.assert(
          fc.property(
            trackedEditArb(anySpansArb),
            ({ spans, pair, oldBodyStart, newBodyStart }) => {
              const after = mapSpans(
                spans,
                pair.changes,
                oldBodyStart,
                newBodyStart,
                pair.alternative
              );
              const each = alone(spans, pair, oldBodyStart, newBodyStart);
              each.forEach((one, i) => {
                const { span, edit, alt } = one;
                if (same(after[i], edit)) {
                  if (!wantsAlt(one) || same(alt, edit)) return;
                  // Kept off the alternative only by another highlight where
                  // it is, or where the edit alone puts it: in the way, or
                  // collapsed where the alternative would take it in
                  const blocks = (other: Span) =>
                    overlaps(alt, other) ||
                    (length(other) === 0 &&
                      inside(other[0], alt) &&
                      !inside(other[0], edit));
                  expect(
                    each.some(
                      (o, j) =>
                        j !== i &&
                        !related(span, o.span) &&
                        (blocks(after[j]) || blocks(o.edit))
                    )
                  ).toBe(true);
                } else if (wantsAlt(one)) {
                  expect(after[i]).toEqual(alt);
                } else {
                  // A re-expansion into text another collapsed one took
                  expect(length(span)).toBe(0);
                  expect(after[i]).toEqual([edit[0], edit[0]]);
                  expect(
                    each.some(
                      (o, j) =>
                        j !== i &&
                        !related(span, o.span) &&
                        length(o.span) === 0 &&
                        overlaps(edit, after[j])
                    )
                  ).toBe(true);
                }
              });
            }
          ),
          { numRuns: 300 }
        );
      });

      it('moves highlights that all overlap or nest in one another as each would move alone', () => {
        fc.assert(
          fc.property(
            trackedEditArb(crossingSpansArb),
            ({ spans, pair, oldBodyStart, newBodyStart }) => {
              expect(
                mapSpans(
                  spans,
                  pair.changes,
                  oldBodyStart,
                  newBodyStart,
                  pair.alternative
                )
              ).toEqual(
                alone(spans, pair, oldBodyStart, newBodyStart).map((one) =>
                  wantsAlt(one) ? one.alt : one.edit
                )
              );
            }
          ),
          { numRuns: 300 }
        );
      });

      it('takes the alternative for a lone highlight exactly when it keeps a length the edit would change', () => {
        fc.assert(
          fc.property(
            trackedEditArb(anySpansArb),
            ({ spans, pair, oldBodyStart, newBodyStart }) => {
              for (const one of alone(
                spans,
                pair,
                oldBodyStart,
                newBodyStart
              )) {
                expect(
                  mapSpans(
                    [one.span],
                    pair.changes,
                    oldBodyStart,
                    newBodyStart,
                    pair.alternative
                  )
                ).toEqual([wantsAlt(one) ? one.alt : one.edit]);
              }
            }
          ),
          { numRuns: 300 }
        );
      });

      it('moves every highlight as the edit does when there is no alternative, but a re-expansion into text another collapsed one took', () => {
        fc.assert(
          fc.property(
            trackedEditArb(anySpansArb),
            ({ spans, pair, oldBodyStart, newBodyStart }) => {
              const after = mapSpans(
                spans,
                pair.changes,
                oldBodyStart,
                newBodyStart
              );
              alone(spans, pair, oldBodyStart, newBodyStart).forEach(
                ({ span, edit }, i) => {
                  if (same(after[i], edit)) return;
                  expect(length(span)).toBe(0);
                  expect(after[i]).toEqual([edit[0], edit[0]]);
                  expect(
                    spans.some(
                      (other, j) =>
                        j !== i &&
                        length(other) === 0 &&
                        overlaps(edit, after[j])
                    )
                  ).toBe(true);
                }
              );
            }
          ),
          { numRuns: 300 }
        );
      });

      it('moves each highlight the same, whatever order they were loaded in', () => {
        fc.assert(
          fc.property(
            trackedEditArb(anySpansArb),
            ({ spans, pair, oldBodyStart, newBodyStart }) => {
              const ids = spans.map((_, i) => `${i}`);
              const forward = mapSpans(
                spans,
                pair.changes,
                oldBodyStart,
                newBodyStart,
                pair.alternative,
                ids
              );
              const backward = mapSpans(
                [...spans].reverse(),
                pair.changes,
                oldBodyStart,
                newBodyStart,
                pair.alternative,
                [...ids].reverse()
              );
              expect([...backward].reverse()).toEqual(forward);
            }
          ),
          { numRuns: 300 }
        );
      });

      it('re-nests a highlight collapsed inside another when its text comes back, whichever comes first', () => {
        // A snippet of 'cd' inside one of 'abcdef', its text erased, then
        // put back by undo
        for (const order of [
          [
            [0, 4],
            [2, 2],
          ],
          [
            [2, 2],
            [0, 4],
          ],
        ] as Span[][]) {
          const after = mapSpans(
            order,
            ChangeSet.of({ from: 2, insert: 'cd' }, 4),
            0,
            0
          );
          expect(after).toEqual(
            order.map(([start]) => (start === 0 ? [0, 6] : [2, 4]))
          );
        }
      });

      it('gives text put back to the highlight erased from it, not one collapsed there before', () => {
        // In 'abcdef', 'cd' highlighted, and another highlight collapsed at its
        // start (loaded so, its text erased long ago). Erase 'cd', undo.
        for (const [x, ghost] of [
          ['a-x', 'b-ghost'],
          ['b-x', 'a-ghost'],
        ]) {
          const tracker = new SnippetOffsetTracker();
          tracker.loadHighlights(filePath, [
            createHighlight(x, 2, 4),
            createHighlight(ghost, 2, 2),
          ]);
          tracker.updateOffsetsWithMapping(
            filePath,
            ChangeSet.of({ from: 2, to: 4 }, 6),
            0,
            0
          );
          tracker.updateOffsetsWithMapping(
            filePath,
            ChangeSet.of({ from: 2, insert: 'cd' }, 4),
            0,
            0
          );
          expect(
            tracker
              .getHighlights(filePath)
              .map((h) => [h.id, h.start_offset, h.end_offset])
          ).toEqual([
            [x, 2, 4],
            [ghost, 2, 2],
          ]);
        }
      });

      it('gives text put back to the one of two highlights erased there last', () => {
        // 'ab' and 'cd' side by side; 'ab' erased, then 'cd', then 'cd' back
        for (const ids of [
          ['1', '2'],
          ['2', '1'],
        ]) {
          const tracker = new SnippetOffsetTracker();
          tracker.loadHighlights(filePath, [
            createHighlight(ids[0], 0, 2),
            createHighlight(ids[1], 2, 4),
          ]);
          tracker.updateOffsetsWithMapping(
            filePath,
            ChangeSet.of({ from: 0, to: 2 }, 4),
            0,
            0
          );
          tracker.updateOffsetsWithMapping(
            filePath,
            ChangeSet.of({ from: 0, to: 2 }, 2),
            0,
            0
          );
          tracker.updateOffsetsWithMapping(
            filePath,
            ChangeSet.of({ from: 0, insert: 'cd' }, 0),
            0,
            0
          );
          expect(
            tracker
              .getHighlights(filePath)
              .map((h) => [h.id, h.start_offset, h.end_offset])
          ).toEqual([
            [ids[0], 0, 0],
            [ids[1], 0, 2],
          ]);
        }
      });

      it('of two highlights erased in one edit, gives text put back to the first by id', () => {
        // 'a' and 'b' side by side, erased together, then put back
        for (const ids of [
          ['1', '2'],
          ['2', '1'],
        ]) {
          const tracker = new SnippetOffsetTracker();
          tracker.loadHighlights(filePath, [
            createHighlight(ids[0], 0, 1),
            createHighlight(ids[1], 1, 2),
          ]);
          tracker.updateOffsetsWithMapping(
            filePath,
            ChangeSet.of({ from: 0, to: 2 }, 2),
            0,
            0
          );
          tracker.updateOffsetsWithMapping(
            filePath,
            ChangeSet.of({ from: 0, insert: 'ab' }, 0),
            0,
            0
          );
          expect(
            tracker
              .getHighlights(filePath)
              .map((h) => [h.id, h.start_offset, h.end_offset])
              .sort()
          ).toEqual([
            ['1', 0, 2],
            ['2', 0, 0],
          ]);
        }
      });

      it('gives text typed back over two snippets of one text, erased together, to the first by id', () => {
        // The same text made a snippet twice, erased, then typed again (not
        // undone, which puts both back): collapsed, nothing tells them from
        // neighbours erased together, which mustn't come back overlapping
        const tracker = new SnippetOffsetTracker();
        tracker.loadHighlights(filePath, [
          createHighlight('2', 2, 5),
          createHighlight('1', 2, 5),
        ]);
        tracker.updateOffsetsWithMapping(
          filePath,
          ChangeSet.of({ from: 2, to: 5 }, 8),
          0,
          0
        );
        tracker.updateOffsetsWithMapping(
          filePath,
          ChangeSet.of({ from: 2, insert: 'abc' }, 5),
          0,
          0
        );
        expect(
          tracker
            .getHighlights(filePath)
            .map((h) => [h.id, h.start_offset, h.end_offset])
        ).toEqual([
          ['2', 2, 2],
          ['1', 2, 5],
        ]);
      });

      it('re-expands only the first by id of two highlights loaded collapsed where text comes back', () => {
        // Both loaded collapsed, as their text was erased in an earlier
        // session, and the text then comes back: it can belong to one of
        // them, not both.
        expect(
          mapSpans(
            [
              [3, 3],
              [3, 3],
            ],
            ChangeSet.of({ from: 3, insert: 'abc' }, 6),
            0,
            0,
            undefined,
            ['b', 'a']
          )
        ).toEqual([
          [3, 3],
          [3, 6],
        ]);
      });

      it('takes the alternative right up to a neighbour, or a collapsed one at its end', () => {
        // [0,2) and [3,5), and a collapsed one at 5: the edit takes a
        // character out of the second, the alternative the one between them
        expect(
          mapSpans(
            [
              [0, 2],
              [3, 5],
              [5, 5],
            ],
            ChangeSet.of({ from: 3, to: 4 }, 8),
            0,
            0,
            ChangeSet.of({ from: 2, to: 3 }, 8)
          )
        ).toEqual([
          [0, 2],
          [2, 4],
          [4, 4],
        ]);
      });

      it('takes the alternative past a collapsed highlight it leaves outside', () => {
        // [5,7), and a collapsed one at 4: the alternative puts it left of
        // that point, ending there, where the edit leaves it right of it
        expect(
          mapSpans(
            [
              [5, 7],
              [4, 4],
            ],
            ChangeSet.of({ from: 6, to: 7 }, 8),
            0,
            0,
            ChangeSet.of({ from: 0, to: 3 }, 8)
          )
        ).toEqual([
          [2, 4],
          [4, 4],
        ]);
      });

      it('takes the alternative over a collapsed highlight nested in it before, though the edit leaves that at its edge', () => {
        // [3,9) with one collapsed inside at 6: the edit takes out what lies
        // between their starts, the alternative as much before it
        expect(
          mapSpans(
            [
              [3, 9],
              [6, 6],
            ],
            ChangeSet.of({ from: 3, to: 6 }, 10),
            0,
            0,
            ChangeSet.of({ from: 0, to: 3 }, 10)
          )
        ).toEqual([
          [0, 6],
          [3, 3],
        ]);
      });

      it('takes the alternative over a collapsed highlight nested in it already', () => {
        // [1,7) with one collapsed inside at 4: the edit takes a character out
        // of it, the alternative the one before it
        expect(
          mapSpans(
            [
              [1, 7],
              [4, 4],
            ],
            ChangeSet.of({ from: 5, to: 6 }, 8),
            0,
            0,
            ChangeSet.of({ from: 0, to: 1 }, 8)
          )
        ).toEqual([
          [0, 6],
          [4, 4],
        ]);
      });

      it('keeps a collapsed highlight out of the one whose alternative would take it in', () => {
        // In 'aaaab', 'aab' and a collapsed highlight at its start; one 'a'
        // goes. The alternative would keep 'aab' whole by moving it left over
        // the collapsed one, which the next 'x' typed there would re-expand
        // inside it.
        const doc = Text.of(['aaaab']);
        const whole = ChangeSet.of({ from: 0, to: 5, insert: 'aaab' }, 5);
        const first = mapSpans(
          [
            [2, 5],
            [2, 2],
          ],
          narrowChanges(whole, doc, 'latest'),
          0,
          0,
          narrowChanges(whole, doc, 'earliest')
        );
        expect(first).toEqual([
          [2, 4],
          [2, 2],
        ]);
        const typed = ChangeSet.of({ from: 2, insert: 'x' }, 4);
        const second = mapSpans(first, typed, 0, 0, typed);
        expect(overlaps(second[0], second[1])).toBe(false);
      });

      it('shrinks the highlight that would have to move into its neighbour, rather than overlap them', () => {
        // 'ab' and 'bc' touch in 'abbc'; one 'b' goes, and the text can't say
        // whose. 'ab' keeps its text, as the edit leaves it, and 'bc', which
        // only the alternative would keep whole, gives up its 'b'.
        const doc = Text.of(['abbc']);
        const whole = ChangeSet.of({ from: 0, to: 4, insert: 'abc' }, 4);
        expect(
          mapSpans(
            [
              [0, 2],
              [2, 4],
            ],
            narrowChanges(whole, doc, 'latest'),
            0,
            0,
            narrowChanges(whole, doc, 'earliest')
          )
        ).toEqual([
          [0, 2],
          [2, 3],
        ]);
      });
    });

    it('should prevent zero-width highlights when content before snippet is deleted', () => {
      // Scenario: Two snippets both at offset 100-150, deleting content before them
      // that causes them to collapse to the same position
      const highlight1 = createHighlight('1', 100, 150);
      const highlight2 = createHighlight('2', 100, 150);
      tracker.loadHighlights(filePath, [highlight1, highlight2]);

      // Simulate deleting 100 characters before the snippets, which would
      // map both start and end to position 0
      const oldDoc = Text.of(['x'.repeat(200)]);
      const _newDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 0, to: 100 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // Both highlights should have at least 1 character width
      expect(updated[0].start_offset).toBe(0);
      expect(updated[0].end_offset).toBe(50); // 150 - 100 = 50
      expect(updated[1].start_offset).toBe(0);
      expect(updated[1].end_offset).toBe(50);
    });

    it('should collapse a highlight to zero length when its entire content is deleted', () => {
      // Scenario: Snippet spans 100-200, and we delete exactly that range.
      // The highlight should collapse to zero length so it disappears from the
      // view rather than lingering as a length-1 zombie over unrelated text.
      const highlight = createHighlight('1', 100, 200);
      tracker.loadHighlights(filePath, [highlight]);

      // Delete the entire snippet content (positions 100-200)
      const oldDoc = Text.of(['x'.repeat(300)]);
      const changes = ChangeSet.of({ from: 100, to: 200 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // Both endpoints map to the deletion point → zero-length (invisible) range.
      expect(updated[0].start_offset).toBe(100);
      expect(updated[0].end_offset).toBe(100);
    });

    it('should collapse to zero length when the final remaining character is deleted', () => {
      // Regression: previously a highlight could shrink to length 1 but never
      // below, so deleting the last character left a stuck length-1 highlight.
      const highlight = createHighlight('1', 10, 11); // one character left
      tracker.loadHighlights(filePath, [highlight]);

      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 10, to: 11 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(10);
      expect(updated[0].end_offset).toBe(10); // collapsed, not forced to 11
    });

    it('should restore a collapsed highlight when the erasure is undone', () => {
      // Erase the whole highlight, then undo. The zero-length record must
      // re-expand to cover the re-inserted text.
      const highlight = createHighlight('1', 10, 15); // "hello"
      tracker.loadHighlights(filePath, [highlight]);

      // Delete the 5 highlighted chars → collapses to [10, 10]
      const oldDoc = Text.of(['x'.repeat(100)]);
      const deletion = ChangeSet.of({ from: 10, to: 15 }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, deletion, 0, 0);

      let updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(10);
      expect(updated[0].end_offset).toBe(10);

      // Undo: CodeMirror re-inserts the 5 chars at position 10
      const collapsedDoc = Text.of(['x'.repeat(95)]);
      const undo = ChangeSet.of(
        { from: 10, insert: 'hello' },
        collapsedDoc.length
      );
      tracker.updateOffsetsWithMapping(filePath, undo, 0, 0);

      updated = tracker.getHighlights(filePath);
      // Outward association re-expands the collapsed range over the restored text
      expect(updated[0].start_offset).toBe(10);
      expect(updated[0].end_offset).toBe(15);
    });

    it('should maintain proper offsets when content is deleted before snippet', () => {
      // Normal case: snippet at 200-300, delete 50 chars at start
      const highlight = createHighlight('1', 200, 300);
      tracker.loadHighlights(filePath, [highlight]);

      const oldDoc = Text.of(['x'.repeat(400)]);
      const changes = ChangeSet.of({ from: 0, to: 50 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(150); // 200 - 50
      expect(updated[0].end_offset).toBe(250); // 300 - 50
    });

    it('should handle deletion that partially overlaps snippet start', () => {
      // Snippet at 100-200, delete 80-120 (overlaps start)
      const highlight = createHighlight('1', 100, 200);
      tracker.loadHighlights(filePath, [highlight]);

      const oldDoc = Text.of(['x'.repeat(300)]);
      const changes = ChangeSet.of({ from: 80, to: 120 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // Start maps to 80 (deletion point), end maps to 160 (200 - 40)
      expect(updated[0].start_offset).toBe(80);
      expect(updated[0].end_offset).toBe(160);
    });

    it('should correctly shift snippets when deleting large content before them (image deletion scenario)', () => {
      // Scenario: Document has images from 0-8000, then text with snippets at 8244-8300 and 8400-8500
      // User deletes all images (0-8000)
      const highlight1 = createHighlight('1', 8244, 8300);
      const highlight2 = createHighlight('2', 8400, 8500);
      tracker.loadHighlights(filePath, [highlight1, highlight2]);

      // Document is 10000 chars, delete first 8000
      const oldDoc = Text.of(['x'.repeat(10000)]);
      const changes = ChangeSet.of({ from: 0, to: 8000 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // Snippets should shift left by 8000
      expect(updated[0].start_offset).toBe(244); // 8244 - 8000
      expect(updated[0].end_offset).toBe(300); // 8300 - 8000
      expect(updated[1].start_offset).toBe(400); // 8400 - 8000
      expect(updated[1].end_offset).toBe(500); // 8500 - 8000
    });

    it('should handle incremental backspacing (multiple small deletions)', () => {
      // Scenario: User backspaces character by character
      const highlight = createHighlight('1', 100, 150);
      tracker.loadHighlights(filePath, [highlight]);

      // First backspace: delete char at position 50
      let oldDoc = Text.of(['x'.repeat(200)]);
      let changes = ChangeSet.of({ from: 50, to: 51 }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      let updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(99);
      expect(updated[0].end_offset).toBe(149);

      // Second backspace: delete char at position 49
      oldDoc = Text.of(['x'.repeat(199)]);
      changes = ChangeSet.of({ from: 49, to: 50 }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(98);
      expect(updated[0].end_offset).toBe(148);
    });

    it('should correctly handle undo of multiple combined edits', () => {
      // Scenario: User types "abc" (3 chars at position 50), which Obsidian may group
      // into a single undo action. When undone, the ChangeSet represents all 3
      // deletions combined - we need to handle this correctly via mapPos().
      const highlight = createHighlight('1', 100, 150);
      tracker.loadHighlights(filePath, [highlight]);

      // Step 1: User types "abc" at position 50 (inserts 3 chars)
      // This shifts the highlight from 100-150 to 103-153
      let oldDoc = Text.of(['x'.repeat(200)]);
      let changes = ChangeSet.of({ from: 50, insert: 'abc' }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      let updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(103); // 100 + 3
      expect(updated[0].end_offset).toBe(153); // 150 + 3

      // Step 2: User hits undo - Obsidian provides a ChangeSet that deletes "abc"
      // This is the INVERSE transformation: delete 3 chars at position 50
      oldDoc = Text.of(['x'.repeat(203)]);
      changes = ChangeSet.of({ from: 50, to: 53 }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      updated = tracker.getHighlights(filePath);
      // Should return to original positions
      expect(updated[0].start_offset).toBe(100);
      expect(updated[0].end_offset).toBe(150);
    });

    it('should handle undo of find-replace with multiple replacements', () => {
      // Scenario: Find-replace changes "aa" to "bbbb" at multiple locations in one action.
      // The ChangeSet contains multiple changes that are applied atomically.
      const highlight = createHighlight('1', 100, 150);
      tracker.loadHighlights(filePath, [highlight]);

      // Find-replace: "aa" -> "bbbb" at positions 20 and 60 (before the highlight)
      // Each replacement adds 2 chars, total +4 to positions after both
      const oldDoc = Text.of(['x'.repeat(200)]);
      const changes = ChangeSet.of(
        [
          { from: 20, to: 22, insert: 'bbbb' }, // +2 chars
          { from: 60, to: 62, insert: 'bbbb' }, // +2 chars
        ],
        oldDoc.length
      );
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      let updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(104); // 100 + 4
      expect(updated[0].end_offset).toBe(154); // 150 + 4

      // Undo: "bbbb" -> "aa" at positions 20 and 62 (note: second position shifted)
      // This is the inverse: each replacement removes 2 chars
      const newDoc = Text.of(['x'.repeat(204)]);
      const undoChanges = ChangeSet.of(
        [
          { from: 20, to: 24, insert: 'aa' }, // -2 chars
          { from: 62, to: 66, insert: 'aa' }, // -2 chars
        ],
        newDoc.length
      );
      tracker.updateOffsetsWithMapping(filePath, undoChanges, 0, 0);

      updated = tracker.getHighlights(filePath);
      // Should return to original positions
      expect(updated[0].start_offset).toBe(100);
      expect(updated[0].end_offset).toBe(150);
    });

    it('should do nothing when no highlights are cached for the file', () => {
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 0, to: 10 }, oldDoc.length);
      // Must not throw and cache must remain empty
      expect(() =>
        tracker.updateOffsetsWithMapping('nonexistent.md', changes, 0, 0)
      ).not.toThrow();
      expect(tracker.getHighlights('nonexistent.md')).toEqual([]);
    });

    it('should do nothing when highlights array is empty', () => {
      tracker.loadHighlights(filePath, []);
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 0, to: 10 }, oldDoc.length);
      expect(() =>
        tracker.updateOffsetsWithMapping(filePath, changes, 0, 0)
      ).not.toThrow();
      expect(tracker.getHighlights(filePath)).toEqual([]);
    });

    it('should account for body start offset when mapping positions', () => {
      // Highlights are body-relative; body starts at offset 50 in the doc
      const highlight = createHighlight('1', 10, 30); // body-relative
      tracker.loadHighlights(filePath, [highlight]);

      // Insert 5 chars at absolute position 60 (body-relative 10 — snippet start)
      const oldDoc = Text.of(['x'.repeat(200)]);
      const changes = ChangeSet.of(
        { from: 60, insert: 'abcde' },
        oldDoc.length
      );

      // oldBodyStart = 50, newBodyStart = 50 (frontmatter unchanged)
      tracker.updateOffsetsWithMapping(filePath, changes, 50, 50);

      const updated = tracker.getHighlights(filePath);
      // Absolute start was 60 (=10+50); assoc=1 maps it to 65 after insert; body-relative = 15
      expect(updated[0].start_offset).toBe(15);
      // Absolute end was 80 (=30+50); shifts to 85; body-relative = 35
      expect(updated[0].end_offset).toBe(35);
    });

    it('should clamp start_offset to 0 when mapping would produce a negative body-relative position', () => {
      // Highlight at body-relative 5-20, body starts at 50 (absolute 55-70).
      // Delete absolute 0-60 — would map start below newBodyStart.
      const highlight = createHighlight('1', 5, 20);
      tracker.loadHighlights(filePath, [highlight]);

      const oldDocLen = 200;
      const changes = ChangeSet.of({ from: 0, to: 60 }, oldDocLen);

      // newBodyStart also shrinks: frontmatter (50 chars) remains but body now at 50-60=...
      // Keep newBodyStart = 0 to trigger the Math.max(0, ...) guard
      tracker.updateOffsetsWithMapping(filePath, changes, 50, 0);

      const updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBeGreaterThanOrEqual(0);
      expect(updated[0].end_offset).toBeGreaterThan(updated[0].start_offset);
    });

    it('should not extend end_offset when text is inserted exactly at the snippet end boundary', () => {
      // assoc=-1 for end means it stays LEFT of the insertion (end does not grow).
      // assoc=+1 would move to the RIGHT, making end_offset larger than expected.
      const highlight = createHighlight('1', 10, 20);
      tracker.loadHighlights(filePath, [highlight]);

      // Insert 5 chars exactly at position 20 (= absoluteEnd when bodyStart=0)
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of(
        { from: 20, insert: 'hello' },
        oldDoc.length
      );

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // start: assoc=1, at position 10 (no change nearby) → stays 10
      expect(updated[0].start_offset).toBe(10);
      // end: assoc=-1, at right edge of insertion → stays at 20, not 25
      expect(updated[0].end_offset).toBe(20);
    });

    it('should extend start_offset rightward when text is inserted exactly at the snippet start boundary', () => {
      // assoc=+1 for start means it stays RIGHT of the insertion (start grows past inserted text).
      // assoc=-1 would stay LEFT, absorbing the new text into the snippet.
      const highlight = createHighlight('1', 10, 20);
      tracker.loadHighlights(filePath, [highlight]);

      // Insert 5 chars exactly at position 10 (= absoluteStart when bodyStart=0)
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of(
        { from: 10, insert: 'hello' },
        oldDoc.length
      );

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // start: assoc=+1 → jumps to right of insertion = 15
      expect(updated[0].start_offset).toBe(15);
      // end: assoc=-1, at position 20, insertion was before it → shifts to 25
      expect(updated[0].end_offset).toBe(25);
    });

    it('should update all highlights in cache and persist them (property-based)', () => {
      fc.assert(
        fc.property(
          // Generate between 1 and 5 non-overlapping highlights within a 1000-char body
          fc
            .array(fc.nat({ max: 998 }), { minLength: 1, maxLength: 5 })
            .map((starts) =>
              starts
                .sort((a, b) => a - b)
                .map((start, i) =>
                  createHighlight(String(i), start, start + 1 + (i % 10))
                )
            ),
          (highlights) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(filePath, highlights);

            // No-op change: insert nothing
            const docLen = 2000;
            const changes = ChangeSet.of({ from: 0, insert: '' }, docLen);
            t.updateOffsetsWithMapping(filePath, changes, 0, 0);

            const result = t.getHighlights(filePath);
            // Every highlight must have end > start
            for (const h of result) {
              expect(h.end_offset).toBeGreaterThan(h.start_offset);
            }
            // Count must be preserved
            expect(result.length).toBe(highlights.length);
          }
        )
      );
    });
    describe('with offsets past the document’s end', () => {
      it('keeps a highlight running past the end as far past it when text is typed at the end', () => {
        // Its end inward, as a live one's: alone, it would stay before the
        // text typed, and the overhang would take that text in
        const typed = ChangeSet.of({ from: 10, insert: 'x' }, 10);
        expect(mapSpans([[5, 15]], typed, 0, 0)).toEqual([[5, 16]]);
      });

      it('collapses a highlight running past the end whose text in the document is erased, as any erased one', () => {
        const erased = ChangeSet.of({ from: 5, to: 9 }, 9);
        expect(mapSpans([[5, 12]], erased, 0, 0)).toEqual([[5, 5]]);
      });

      it('keeps a highlight with none of its text in the document as far past the end, and maps the rest as without it', () => {
        fc.assert(
          fc.property(
            pastEndEditArb((max) =>
              pastEndSpanArb(max).filter((span) => whollyPast(span, max))
            ),
            ({ spans, stale, max, pair, oldBodyStart, newBodyStart }) => {
              const args = [
                pair.changes,
                oldBodyStart,
                newBodyStart,
                pair.alternative,
              ] as const;
              const after = mapSpans([...spans, ...stale], ...args);
              expect(after.slice(0, spans.length)).toEqual(
                mapSpans(spans, ...args)
              );
              // Each offset as far from the body's end as before the edit
              const newMax = pair.changes.newLength - newBodyStart;
              expect(after.slice(spans.length)).toEqual(
                stale.map(([start, end]) => [
                  newMax + start - max,
                  newMax + end - max,
                ])
              );
            }
          ),
          { numRuns: 300 }
        );
      });

      it('maps a highlight running past the end as its part in the document, its end staying as far past the end', () => {
        fc.assert(
          fc.property(
            pastEndEditArb((max) =>
              pastEndSpanArb(max).filter((span) => !whollyPast(span, max))
            ),
            ({ spans, stale, max, pair, oldBodyStart, newBodyStart }) => {
              const args = [
                pair.changes,
                oldBodyStart,
                newBodyStart,
                pair.alternative,
              ] as const;
              const visible = stale.map(([start]): Span => [start, max]);
              const expected = mapSpans([...spans, ...visible], ...args);
              const after = mapSpans([...spans, ...stale], ...args);
              expect(after.slice(0, spans.length)).toEqual(
                expected.slice(0, spans.length)
              );
              const newEnd = pair.changes.newLength - newBodyStart;
              stale.forEach(([, end], i) => {
                const [start, visibleEnd] = expected[spans.length + i];
                expect(after[spans.length + i]).toEqual(
                  // Its text in the document erased: collapsed, as any is
                  start === visibleEnd
                    ? [start, start]
                    : [start, Math.max(visibleEnd, newEnd) + end - max]
                );
              });
            }
          ),
          { numRuns: 300 }
        );
      });
    });

    describe('when a block is rewritten whole, as Obsidian re-pads a table', () => {
      beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
      });
      afterEach(() => vi.restoreAllMocks());

      const before =
        'Intro\n\n| fruit | n |\n|---|---|\n|apple    | 3 |\n\nOutro';
      const repadded = '| fruit | n   |\n| ----- | --- |\n| apple | 3   |';
      const table = {
        from: before.indexOf('|'),
        to: before.lastIndexOf('|') + 1,
      };
      const after = (insert: string) =>
        before.slice(0, table.from) + insert + before.slice(table.to);
      const highlightOn = (text: string, id = 'h') => {
        const start = before.indexOf(text);
        return createHighlight(id, start, start + text.length);
      };
      const lengths = (path: string) =>
        tracker.getHighlights(path).map((h) => h.end_offset - h.start_offset);

      it('keeps a highlight in a cell on its text', () => {
        tracker.loadHighlights(filePath, [highlightOn('apple')]);

        mapRewrite(tracker, filePath, before, { ...table, insert: repadded });

        expect(shownIn(tracker, filePath, after(repadded))).toEqual(['apple']);
      });

      it('keeps a highlight in a cell on its text when another cell was edited in the same rewrite', () => {
        // The first edit to a hand-padded table: the cell typed in, and every
        // row re-padded around it
        const edited = '| fruit | n   |\n| ----- | --- |\n| apple | 30  |';
        tracker.loadHighlights(filePath, [highlightOn('apple')]);

        mapRewrite(tracker, filePath, before, { ...table, insert: edited });

        expect(shownIn(tracker, filePath, after(edited))).toEqual(['apple']);
      });

      it('keeps a highlight in a cell on its text when text pasted into another cell widens the separator row as much', () => {
        // The separator's dashes grow as far as the paste: as many characters
        // changed on both sides of the row between them as the paste holds
        const narrow = 'Intro\n\n| fruit |\n|-|\n| apple |\n| |\n\nOutro';
        const paste = 'a long pasted sentence of words';
        const width = paste.length;
        const row = (cell: string) => `| ${cell.padEnd(width)} |`;
        const wide = [
          row('fruit'),
          `| ${'-'.repeat(width)} |`,
          row('apple'),
          row(paste),
        ].join('\n');
        const from = narrow.indexOf('|');
        const to = narrow.lastIndexOf('|') + 1;
        const start = narrow.indexOf('apple');
        tracker.loadHighlights(filePath, [
          createHighlight('h', start, start + 5),
        ]);

        mapRewrite(tracker, filePath, narrow, { from, to, insert: wide });

        expect(
          shownIn(
            tracker,
            filePath,
            narrow.slice(0, from) + wide + narrow.slice(to)
          )
        ).toEqual(['apple']);
      });

      it('keeps the text under a highlight in any cell of any table, whatever padding it is given', () => {
        fc.assert(
          fc.property(
            repaddedTableArb,
            ({ before, after, table, highlight, text }) => {
              const t = new SnippetOffsetTracker();
              t.loadHighlights(filePath, [createHighlight('h', ...highlight)]);

              mapRewrite(t, filePath, before, table);

              expect(shownIn(t, filePath, after)).toEqual([text]);
            }
          ),
          { numRuns: 300 }
        );
      });

      it('keeps the text under a highlight that starts or ends in padding or spans pipes when Obsidian lays the table out anew', () => {
        fc.assert(
          fc.property(
            reformattedTableArb,
            ({ before, after, table, highlight }) => {
              const text = sansPadding(before.slice(...highlight));
              fc.pre(text !== '');
              const t = new SnippetOffsetTracker();
              t.loadHighlights(filePath, [createHighlight('h', ...highlight)]);

              mapRewrite(t, filePath, before, table);

              expect(shownIn(t, filePath, after).map(sansPadding)).toEqual([
                text,
              ]);
            }
          ),
          { numRuns: 300 }
        );
      });

      it('keeps the text under a highlight in any cell when a table command inserts a column anywhere', () => {
        fc.assert(
          fc.property(
            columnInsertedTableArb,
            ({ before, after, table, highlight, text }) => {
              const t = new SnippetOffsetTracker();
              t.loadHighlights(filePath, [createHighlight('h', ...highlight)]);

              mapRewrite(t, filePath, before, table);

              expect(shownIn(t, filePath, after)).toEqual([text]);
            }
          ),
          { numRuns: 300 }
        );
      });

      it('keeps a highlight from a header row into the rows below over the separator row the re-pad widens', () => {
        const table = '|fxy kuon aw |\n  --- |\n   q\\q|\n|   | ';
        const laidOut =
          '| fxy kuon aw |\n| ----------- |\n| q\\q         |\n|             |';
        const before = INTRO + table + OUTRO;
        // From the space after 'aw' to the end of 'q\q|'
        const start = before.indexOf(' |');
        const end = before.indexOf('q|') + 2;
        tracker.loadHighlights(filePath, [createHighlight('h', start, end)]);

        mapRewrite(tracker, filePath, before, {
          from: INTRO.length,
          to: INTRO.length + table.length,
          insert: laidOut,
        });

        expect(
          shownIn(tracker, filePath, INTRO + laidOut + OUTRO).map(sansPadding)
        ).toEqual([sansPadding(before.slice(start, end))]);
      });

      it('collapses a highlight whose text the rewrite took out, and warns of it once per file', () => {
        const warn = vi.mocked(console.warn);
        const pear = '| fruit | n   |\n| ----- | --- |\n| pear  | 3   |';
        tracker.loadHighlights(filePath, [highlightOn('apple')]);
        tracker.loadHighlights('other.md', [highlightOn('apple', 'o')]);

        mapRewrite(tracker, filePath, before, { ...table, insert: pear });
        expect(lengths(filePath)).toEqual([0]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(filePath);

        // Again in the same file: already warned of
        tracker.loadHighlights(filePath, [highlightOn('apple')]);
        mapRewrite(tracker, filePath, before, { ...table, insert: pear });
        expect(lengths(filePath)).toEqual([0]);
        expect(warn).toHaveBeenCalledTimes(1);

        mapRewrite(tracker, 'other.md', before, { ...table, insert: pear });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(String(warn.mock.calls[1][0])).toContain('other.md');
      });

      it('does not warn of a highlight whose text was only deleted', () => {
        tracker.loadHighlights(filePath, [highlightOn('apple')]);
        const start = before.indexOf('apple');

        mapRewrite(tracker, filePath, before, { from: start, to: start + 5 });

        expect(lengths(filePath)).toEqual([0]);
        expect(console.warn).not.toHaveBeenCalled();
      });

      it('does not warn of a highlight already collapsed before the rewrite', () => {
        const start = before.indexOf('apple');
        tracker.loadHighlights(filePath, [createHighlight('h', start, start)]);

        mapRewrite(tracker, filePath, before, { ...table, insert: 'x' });

        expect(console.warn).not.toHaveBeenCalled();
      });

      it('does not warn of a highlight a rewrite elsewhere left alone', () => {
        tracker.loadHighlights(filePath, [highlightOn('Outro')]);

        mapRewrite(tracker, filePath, before, { ...table, insert: 'x' });

        expect(shownIn(tracker, filePath, after('x'))).toEqual(['Outro']);
        expect(console.warn).not.toHaveBeenCalled();
      });

      describe('in a note whose body starts after its frontmatter', () => {
        // 'apple' in the body, 10 characters in
        const text = 'frontmat\n\none apple two';
        const bodyStart = 10;
        it.each([
          {
            what: 'text put in where its text was',
            specs: [{ from: 11, to: 19, insert: 'X' }],
            warns: true,
          },
          {
            what: 'its text erased, and text put in after it, apart',
            specs: [
              { from: 14, to: 19 },
              { from: 20, to: 23, insert: 'six' },
            ],
            warns: false,
          },
          {
            what: 'its text erased, and text put in before it, apart',
            specs: [
              { from: 10, to: 13, insert: 'six' },
              { from: 14, to: 19 },
            ],
            warns: false,
          },
        ])(
          'warns of a collapsed highlight as $what: $warns',
          ({ specs, warns }) => {
            tracker.loadHighlights(filePath, [createHighlight('h', 4, 9)]);

            tracker.updateOffsetsWithMapping(
              filePath,
              ChangeSet.of(specs, text.length),
              bodyStart,
              bodyStart
            );

            expect(lengths(filePath)).toEqual([0]);
            expect(vi.mocked(console.warn).mock.calls.length).toBe(
              warns ? 1 : 0
            );
          }
        );
      });
    });
  });

  // #region HELPERS
  const highlightArb = fc
    .record({
      id: fc.uuid(),
      start: fc.nat({ max: 9000 }),
      width: fc.integer({ min: 1, max: 100 }),
    })
    .map(({ id, start, width }) => createHighlight(id, start, start + width));
  // #endregion

  describe('loadHighlights / getHighlights', () => {
    it('should return empty array when no highlights loaded for a path', () => {
      fc.assert(
        fc.property(fc.string(), (path) => {
          const t = new SnippetOffsetTracker();
          expect(t.getHighlights(path)).toEqual([]);
        })
      );
    });

    it('should return the loaded highlights for the correct path', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 10 }),
          (path, highlights) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(path, highlights);
            expect(t.getHighlights(path)).toEqual(highlights);
          }
        )
      );
    });

    it('should not leak highlights between different file paths', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (pathA, pathB, hlA, hlB) => {
            fc.pre(pathA !== pathB);
            const t = new SnippetOffsetTracker();
            t.loadHighlights(pathA, hlA);
            t.loadHighlights(pathB, hlB);
            expect(t.getHighlights(pathA)).toEqual(hlA);
            expect(t.getHighlights(pathB)).toEqual(hlB);
          }
        )
      );
    });

    it('should overwrite previously loaded highlights when loaded again for the same path', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (path, first, second) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(path, first);
            t.loadHighlights(path, second);
            expect(t.getHighlights(path)).toEqual(second);
          }
        )
      );
    });
  });

  describe('invalidateCache', () => {
    it('should remove highlights for the given path', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (path, highlights) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(path, highlights);
            t.invalidateCache(path);
            expect(t.getHighlights(path)).toEqual([]);
          }
        )
      );
    });

    it('should not affect highlights for other paths', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (pathA, pathB, hlA, hlB) => {
            fc.pre(pathA !== pathB);
            const t = new SnippetOffsetTracker();
            t.loadHighlights(pathA, hlA);
            t.loadHighlights(pathB, hlB);
            t.invalidateCache(pathA);
            expect(t.getHighlights(pathB)).toEqual(hlB);
          }
        )
      );
    });

    it('should be a no-op when no highlights are cached for the path', () => {
      fc.assert(
        fc.property(fc.string(), (path) => {
          const t = new SnippetOffsetTracker();
          expect(() => t.invalidateCache(path)).not.toThrow();
          expect(t.getHighlights(path)).toEqual([]);
        })
      );
    });
  });

  describe('getTrackedPaths', () => {
    it('should return no paths for a tracker that has loaded nothing', () => {
      expect(tracker.getTrackedPaths()).toEqual([]);
    });

    it('should return every loaded path, including paths cached as having no highlights', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.string({ minLength: 1 }), {
            minLength: 1,
            maxLength: 8,
          }),
          // maxLength 0 is allowed on purpose: a note read from the database
          // and found to have no snippets is still tracked, and must still be
          // refreshed when the database is replaced.
          fc.array(fc.array(highlightArb, { maxLength: 5 }), { maxLength: 8 }),
          (paths, highlightLists) => {
            const t = new SnippetOffsetTracker();
            for (const [index, path] of paths.entries()) {
              t.loadHighlights(path, highlightLists[index] ?? []);
            }
            expect(t.getTrackedPaths().sort()).toEqual([...paths].sort());
          }
        )
      );
    });

    it('should report a path once no matter how many times it is loaded', () => {
      tracker.loadHighlights('a.md', [createHighlight('1', 0, 5)]);
      tracker.loadHighlights('a.md', [createHighlight('2', 6, 9)]);
      expect(tracker.getTrackedPaths()).toEqual(['a.md']);
    });

    it('should stop reporting paths dropped by invalidateCache and clearAll', () => {
      tracker.loadHighlights('a.md', [createHighlight('1', 0, 5)]);
      tracker.loadHighlights('b.md', [createHighlight('2', 0, 5)]);

      tracker.invalidateCache('a.md');
      expect(tracker.getTrackedPaths()).toEqual(['b.md']);

      tracker.clearAll();
      expect(tracker.getTrackedPaths()).toEqual([]);
    });

    it('should report the new path after a rename, not the old one', () => {
      tracker.loadHighlights('old.md', [createHighlight('1', 0, 10)]);
      tracker.renameFile('old.md', 'new.md');
      expect(tracker.getTrackedPaths()).toEqual(['new.md']);
    });

    it('should return a snapshot, so every path is still visited when the cache is emptied mid-iteration', () => {
      // refreshAllHighlights() invalidates entries while walking this result;
      // handing back the live key iterator would skip paths.
      tracker.loadHighlights('a.md', [createHighlight('1', 0, 5)]);
      tracker.loadHighlights('b.md', [createHighlight('2', 0, 5)]);
      tracker.loadHighlights('c.md', [createHighlight('3', 0, 5)]);

      const visited: string[] = [];
      for (const path of tracker.getTrackedPaths()) {
        visited.push(path);
        tracker.invalidateCache(path);
      }

      expect(visited).toEqual(['a.md', 'b.md', 'c.md']);
    });
  });

  describe('shownRange', () => {
    afterEach(() => vi.restoreAllMocks());

    it('spans the characters of the document its offsets cover, or is null where it covers none or starts before the document', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      fc.assert(
        fc.property(shownCaseArb, ({ start, end, bodyStart, docLength }) => {
          // Each character of the document, by whether the offsets cover it
          const covered = Array.from({ length: docLength }, (_, i) => i).filter(
            (i) => start + bodyStart <= i && i < end + bodyStart
          );
          expect(
            tracker.shownRange(
              filePath,
              createHighlight('h', start, end),
              bodyStart,
              docLength
            )
          ).toEqual(
            start + bodyStart < 0 || covered.length === 0
              ? null
              : [covered[0], covered[covered.length - 1] + 1]
          );
        })
      );
    });

    it('shows one starting at the document’s very start', () => {
      expect(
        tracker.shownRange(filePath, createHighlight('h', -2, 3), 2, 9)
      ).toEqual([0, 5]);
    });

    it('warns once of each highlight reaching past the end, and of no other', () => {
      fc.assert(
        fc.property(
          fc.array(shownCaseArb, { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 1, max: 3 }),
          (cases, times) => {
            // Cleared each case: one spy serves them all, and afterEach runs
            // per test, not per case
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            warn.mockClear();
            const fresh = new SnippetOffsetTracker();
            for (let i = 0; i < times; i++) {
              cases.forEach(({ start, end, bodyStart, docLength }, id) =>
                fresh.shownRange(
                  filePath,
                  createHighlight(`${id}`, start, end),
                  bodyStart,
                  docLength
                )
              );
            }
            const past = cases.flatMap(
              ({ start, end, bodyStart, docLength }, id) =>
                [start, end].some((offset) => offset + bodyStart > docLength)
                  ? [id]
                  : []
            );
            expect(warn.mock.calls).toEqual(
              past.map((id) => [
                expect.stringMatching(
                  new RegExp(`test-ref-${id}.*${filePath}`)
                ) as string,
              ])
            );
          }
        )
      );
    });

    it('names the snippet, its offsets, the note, how long its body is, and whether it shows', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tracker.shownRange(filePath, createHighlight('h', 3, 40), 4, 14);
      tracker.shownRange(filePath, createHighlight('g', 10, 40), 4, 14);
      expect(warn.mock.calls).toEqual([
        [
          'Incremental Reading: the highlight of snippet "test-ref-h" ' +
            '(offsets 3-40) reaches past the end of "test/file.md" ' +
            '(body 10 characters long); it shows up to the end',
        ],
        [
          'Incremental Reading: the highlight of snippet "test-ref-g" ' +
            '(offsets 10-40) reaches past the end of "test/file.md" ' +
            "(body 10 characters long); it isn't shown",
        ],
      ]);
    });
  });

  describe('updateHighlight', () => {
    it('should update start and end offsets of the matching highlight', () => {
      const h = createHighlight('abc', 10, 20);
      tracker.loadHighlights(filePath, [h]);
      tracker.updateHighlight(filePath, 'abc', { start: 50, end: 80 });
      const result = tracker.getHighlights(filePath);
      expect(result[0].start_offset).toBe(50);
      expect(result[0].end_offset).toBe(80);
    });

    it('should not modify other highlights in the same file', () => {
      const h1 = createHighlight('a', 10, 20);
      const h2 = createHighlight('b', 30, 40);
      tracker.loadHighlights(filePath, [h1, h2]);
      tracker.updateHighlight(filePath, 'a', { start: 100, end: 110 });
      const result = tracker.getHighlights(filePath);
      expect(result[1].start_offset).toBe(30);
      expect(result[1].end_offset).toBe(40);
    });

    it('should be a no-op when the snippetId does not exist in the file', () => {
      const h = createHighlight('real-id', 10, 20);
      tracker.loadHighlights(filePath, [h]);
      tracker.updateHighlight(filePath, 'nonexistent', { start: 99, end: 200 });
      const result = tracker.getHighlights(filePath);
      expect(result[0].start_offset).toBe(10);
      expect(result[0].end_offset).toBe(20);
    });

    it('should be a no-op when no highlights are cached for the path', () => {
      expect(() =>
        tracker.updateHighlight(filePath, 'any', { start: 0, end: 1 })
      ).not.toThrow();
    });

    it('should apply arbitrary valid offsets (property-based)', () => {
      fc.assert(
        fc.property(
          highlightArb,
          fc.nat({ max: 9000 }),
          fc.integer({ min: 1, max: 100 }),
          (h, newStart, width) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(filePath, [h]);
            t.updateHighlight(filePath, h.id, {
              start: newStart,
              end: newStart + width,
            });
            const result = t.getHighlights(filePath);
            expect(result[0].start_offset).toBe(newStart);
            expect(result[0].end_offset).toBe(newStart + width);
          }
        )
      );
    });
  });

  describe('restoreHighlights', () => {
    it('puts the highlights named back where it says, and leaves the rest and other notes alone', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              start: fc.nat(50),
              end: fc.nat(50),
              back: fc.boolean(),
            }),
            { maxLength: 6 }
          ),
          fc.array(fc.tuple(fc.nat(50), fc.nat(50)), { maxLength: 6 }),
          (rows, backTo) => {
            const tracker = new SnippetOffsetTracker();
            tracker.loadHighlights(
              filePath,
              rows.map(({ start, end }, i) =>
                createHighlight(`${i}`, start, end)
              )
            );
            tracker.loadHighlights('other.md', [createHighlight('0', 1, 2)]);
            const spans = rows.flatMap(({ back }, i) =>
              back ? [[`${i}`, ...(backTo[i] ?? [0, 0])] as const] : []
            );

            tracker.restoreHighlights(filePath, [...spans, ['gone', 3, 4]]);

            expect(
              tracker
                .getHighlights(filePath)
                .map((h) => [h.start_offset, h.end_offset])
            ).toEqual(
              rows.map(({ start, end, back }, i) =>
                back ? (backTo[i] ?? [0, 0]) : [start, end]
              )
            );
            expect(tracker.getHighlights('other.md')[0]).toMatchObject({
              start_offset: 1,
              end_offset: 2,
            });
          }
        )
      );
    });
  });

  describe('removeHighlight', () => {
    it('should remove the highlight with the matching id', () => {
      const h1 = createHighlight('x', 0, 5);
      const h2 = createHighlight('y', 10, 15);
      tracker.loadHighlights(filePath, [h1, h2]);
      tracker.removeHighlight(filePath, 'x');
      const result = tracker.getHighlights(filePath);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('y');
    });

    it('should be a no-op when id does not match any highlight', () => {
      const h = createHighlight('known', 0, 5);
      tracker.loadHighlights(filePath, [h]);
      tracker.removeHighlight(filePath, 'unknown');
      expect(tracker.getHighlights(filePath)).toHaveLength(1);
    });

    it('should be a no-op when no highlights are cached for the path', () => {
      expect(() => tracker.removeHighlight(filePath, 'any')).not.toThrow();
    });

    it('should not affect highlights for other paths (property-based)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { minLength: 1, maxLength: 5 }),
          fc.array(highlightArb, { minLength: 1, maxLength: 5 }),
          (pathA, pathB, hlA, hlB) => {
            fc.pre(pathA !== pathB);
            const t = new SnippetOffsetTracker();
            t.loadHighlights(pathA, hlA);
            t.loadHighlights(pathB, hlB);
            // Remove every highlight from pathA
            for (const h of hlA) t.removeHighlight(pathA, h.id);
            expect(t.getHighlights(pathB)).toEqual(hlB);
          }
        )
      );
    });
  });

  describe('renameFile', () => {
    it('should move highlights from oldPath to newPath', () => {
      const highlights = [createHighlight('1', 0, 10)];
      tracker.loadHighlights('old.md', highlights);
      tracker.renameFile('old.md', 'new.md');
      expect(tracker.getHighlights('new.md')).toEqual(highlights);
      expect(tracker.getHighlights('old.md')).toEqual([]);
    });

    it('should be a no-op when oldPath has no cached highlights', () => {
      tracker.renameFile('missing.md', 'new.md');
      expect(tracker.getHighlights('new.md')).toEqual([]);
    });

    it('should preserve highlights for unrelated paths (property-based)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (oldPath, newPath, otherPath, hlOld, hlOther) => {
            fc.pre(
              oldPath !== newPath &&
                oldPath !== otherPath &&
                newPath !== otherPath
            );
            const t = new SnippetOffsetTracker();
            t.loadHighlights(oldPath, hlOld);
            t.loadHighlights(otherPath, hlOther);
            t.renameFile(oldPath, newPath);
            expect(t.getHighlights(otherPath)).toEqual(hlOther);
          }
        )
      );
    });

    it('should transfer the exact same array reference (highlights mutated after rename are visible)', () => {
      const highlights = [createHighlight('1', 0, 10)];
      tracker.loadHighlights('old.md', highlights);
      tracker.renameFile('old.md', 'new.md');
      // Mutate the original array reference
      highlights[0].start_offset = 999;
      // The cache holds the same reference, so the mutation is visible
      expect(tracker.getHighlights('new.md')[0].start_offset).toBe(999);
    });
  });

  describe('clearAll', () => {
    it('should remove all cached highlights', () => {
      tracker.loadHighlights('a.md', [createHighlight('1', 0, 5)]);
      tracker.loadHighlights('b.md', [createHighlight('2', 0, 5)]);
      tracker.clearAll();
      expect(tracker.getHighlights('a.md')).toEqual([]);
      expect(tracker.getHighlights('b.md')).toEqual([]);
    });

    it('should be a no-op when cache is already empty', () => {
      expect(() => tracker.clearAll()).not.toThrow();
    });

    it('should clear highlights for all arbitrary paths (property-based)', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              path: fc.string({ minLength: 1 }),
              highlights: fc.array(highlightArb, { maxLength: 5 }),
            }),
            { minLength: 1, maxLength: 8 }
          ),
          (entries) => {
            const t = new SnippetOffsetTracker();
            for (const { path, highlights } of entries) {
              t.loadHighlights(path, highlights);
            }
            t.clearAll();
            for (const { path } of entries) {
              expect(t.getHighlights(path)).toEqual([]);
            }
          }
        )
      );
    });
  });
});
