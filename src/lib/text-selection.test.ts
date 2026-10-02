// @vitest-environment jsdom
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  rangeOffsetsWithin,
  type TextBounds,
  trackRange,
  trackSelection,
} from './text-selection';

// #region HELPERS

/**
 * A container holding `chunks` as consecutive text nodes, between two sibling
 * elements with text of their own, so ranges can reach out either side.
 */
function makeContainer(chunks: string[]) {
  const parent = document.createElement('div');
  const before = parent.appendChild(document.createElement('span'));
  before.textContent = 'before';
  const container = parent.appendChild(document.createElement('div'));
  for (const chunk of chunks) {
    container.appendChild(document.createTextNode(chunk));
  }
  const after = parent.appendChild(document.createElement('span'));
  after.textContent = 'after';
  document.body.appendChild(parent);
  return { container, before, after };
}

/** The text node and offset in it that `offset` into the joined chunks lands on. */
function pointAt(container: HTMLElement, offset: number): [Node, number] {
  let rest = offset;
  const nodes = Array.from(container.childNodes);
  for (const node of nodes) {
    const length = node.textContent?.length ?? 0;
    if (rest <= length) return [node, rest];
    rest -= length;
  }
  throw new Error(`offset ${offset} past the end of the text`);
}

function rangeBetween(
  [startNode, startOffset]: [Node, number],
  [endNode, endOffset]: [Node, number]
): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** A selection holding `range`, or nothing at all. */
function selectionOf(range: Range | null) {
  return {
    rangeCount: range ? 1 : 0,
    getRangeAt: () => {
      if (!range) throw new Error('no range');
      return range;
    },
  };
}

/** Non-empty chunks, joined, with two offsets into the joined text in order. */
const textWithBoundsArb = fc
  .array(fc.string({ minLength: 1, maxLength: 12 }), {
    minLength: 1,
    maxLength: 5,
  })
  .chain((chunks) => {
    const length = chunks.join('').length;
    return fc
      .tuple(
        fc.integer({ min: 0, max: length }),
        fc.integer({ min: 0, max: length })
      )
      .map(([a, b]) => ({
        chunks,
        bounds: [Math.min(a, b), Math.max(a, b)] as TextBounds,
      }));
  });

const previousArb = fc.option(
  fc
    .tuple(fc.nat(100), fc.nat(100))
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as TextBounds)
);

/** The four boundary values of `range`, for comparing two ranges. */
function boundsOf(range: Range | null) {
  return (
    range && [
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    ]
  );
}

/** A previous tracked range: none, or one in a tree of its own. */
const previousRangeArb = fc.option(
  fc.string({ minLength: 1, maxLength: 8 }).map((text) => {
    const el = document.createElement('p');
    el.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(el);
    return range;
  })
);

// #endregion

afterEach(() => {
  document.body.innerHTML = '';
});

describe('rangeOffsetsWithin', () => {
  it('counts offsets through the whole text, however it is split into nodes', () => {
    fc.assert(
      fc.property(textWithBoundsArb, ({ chunks, bounds }) => {
        const { container } = makeContainer(chunks);
        const range = rangeBetween(
          pointAt(container, bounds[0]),
          pointAt(container, bounds[1])
        );

        expect(rangeOffsetsWithin(container, range)).toEqual(bounds);
        document.body.innerHTML = '';
      })
    );
  });

  it('cuts off what reaches out before the text', () => {
    fc.assert(
      fc.property(textWithBoundsArb, ({ chunks, bounds }) => {
        const { container, before } = makeContainer(chunks);
        const range = rangeBetween(
          [before.firstChild!, 2],
          pointAt(container, bounds[1])
        );

        expect(rangeOffsetsWithin(container, range)).toEqual([0, bounds[1]]);
        document.body.innerHTML = '';
      })
    );
  });

  it('cuts off what reaches out after the text', () => {
    fc.assert(
      fc.property(textWithBoundsArb, ({ chunks, bounds }) => {
        const { container, after } = makeContainer(chunks);
        const range = rangeBetween(pointAt(container, bounds[0]), [
          after.firstChild!,
          2,
        ]);

        expect(rangeOffsetsWithin(container, range)).toEqual([
          bounds[0],
          chunks.join('').length,
        ]);
        document.body.innerHTML = '';
      })
    );
  });

  it('is the whole text for a range around all of it', () => {
    const { container, before, after } = makeContainer(['one ', 'two']);
    const range = rangeBetween([before.firstChild!, 0], [after.firstChild!, 1]);

    expect(rangeOffsetsWithin(container, range)).toEqual([0, 7]);
  });

  it('is null for a range wholly on either side of the text', () => {
    const { container, before, after } = makeContainer(['text']);

    expect(
      rangeOffsetsWithin(
        container,
        rangeBetween([before.firstChild!, 1], [before.firstChild!, 4])
      )
    ).toBeNull();
    expect(
      rangeOffsetsWithin(
        container,
        rangeBetween([after.firstChild!, 0], [after.firstChild!, 3])
      )
    ).toBeNull();
  });

  it('is null for a range in a tree the text is not part of', () => {
    const { container } = makeContainer(['text']);
    const detached = document.createElement('p');
    detached.textContent = 'elsewhere';

    expect(
      rangeOffsetsWithin(
        container,
        rangeBetween([detached.firstChild!, 0], [detached.firstChild!, 4])
      )
    ).toBeNull();
  });
});

describe('trackSelection', () => {
  it('takes a selection made in the text', () => {
    fc.assert(
      fc.property(
        textWithBoundsArb.filter(({ bounds }) => bounds[0] !== bounds[1]),
        previousArb,
        ({ chunks, bounds }, previous) => {
          const { container } = makeContainer(chunks);
          const range = rangeBetween(
            pointAt(container, bounds[0]),
            pointAt(container, bounds[1])
          );

          expect(
            trackSelection(previous, container, selectionOf(range))
          ).toEqual(bounds);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('clears the selection when it collapses inside the text', () => {
    fc.assert(
      fc.property(
        textWithBoundsArb,
        previousArb,
        ({ chunks, bounds }, previous) => {
          const { container } = makeContainer(chunks);
          const point = pointAt(container, bounds[0]);

          expect(
            trackSelection(
              previous,
              container,
              selectionOf(rangeBetween(point, point))
            )
          ).toBeNull();
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('keeps the last selection when the selection moves out of the text', () => {
    fc.assert(
      fc.property(previousArb, (previous) => {
        const { container, after } = makeContainer(['text']);
        const point: [Node, number] = [after.firstChild!, 1];

        expect(
          trackSelection(
            previous,
            container,
            selectionOf(rangeBetween(point, point))
          )
        ).toBe(previous);
        document.body.innerHTML = '';
      })
    );
  });

  it('keeps the last selection when there is no selection at all', () => {
    fc.assert(
      fc.property(previousArb, (previous) => {
        const { container } = makeContainer(['text']);

        expect(trackSelection(previous, container, selectionOf(null))).toBe(
          previous
        );
        expect(trackSelection(previous, container, null)).toBe(previous);
        document.body.innerHTML = '';
      })
    );
  });
});

describe('trackRange', () => {
  it('takes a copy of a selection made in the text', () => {
    fc.assert(
      fc.property(
        textWithBoundsArb.filter(({ bounds }) => bounds[0] !== bounds[1]),
        previousRangeArb,
        ({ chunks, bounds }, previous) => {
          const { container } = makeContainer(chunks);
          const range = rangeBetween(
            pointAt(container, bounds[0]),
            pointAt(container, bounds[1])
          );
          const taken = boundsOf(range);

          const tracked = trackRange(previous, container, selectionOf(range));
          // The selection's own range moves on as the user selects again
          range.collapse(true);

          expect(tracked).not.toBe(range);
          expect(boundsOf(tracked)).toEqual(taken);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('takes a selection reaching into the text from either side, uncut', () => {
    fc.assert(
      fc.property(
        textWithBoundsArb,
        fc.constantFrom('before', 'after', 'both'),
        fc.nat(6),
        fc.nat(5),
        previousRangeArb,
        ({ chunks, bounds }, side, beforeOffset, afterOffset, previous) => {
          const { container, before, after } = makeContainer(chunks);
          const outsideStart: [Node, number] = [
            before.firstChild!,
            beforeOffset,
          ];
          const outsideEnd: [Node, number] = [after.firstChild!, afterOffset];
          const range = rangeBetween(
            side === 'after' ? pointAt(container, bounds[0]) : outsideStart,
            side === 'before' ? pointAt(container, bounds[1]) : outsideEnd
          );

          expect(
            boundsOf(trackRange(previous, container, selectionOf(range)))
          ).toEqual(boundsOf(range));
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('clears the selection when it collapses inside the text', () => {
    fc.assert(
      fc.property(
        textWithBoundsArb,
        previousRangeArb,
        ({ chunks, bounds }, previous) => {
          const { container } = makeContainer(chunks);
          const point = pointAt(container, bounds[0]);

          expect(
            trackRange(
              previous,
              container,
              selectionOf(rangeBetween(point, point))
            )
          ).toBeNull();
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('keeps the last selection when the selection moves out of the text', () => {
    fc.assert(
      fc.property(
        previousRangeArb,
        fc.constantFrom('before', 'after', 'detached'),
        fc.boolean(),
        (previous, side, collapsed) => {
          const { container, before, after } = makeContainer(['text']);
          const detached = document.createElement('p');
          detached.textContent = 'elsewhere';
          const el = { before, after, detached }[side];
          const range = rangeBetween(
            [el.firstChild!, 1],
            [el.firstChild!, collapsed ? 1 : 3]
          );

          expect(trackRange(previous, container, selectionOf(range))).toBe(
            previous
          );
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('keeps the last selection when there is no selection at all', () => {
    fc.assert(
      fc.property(previousRangeArb, (previous) => {
        const { container } = makeContainer(['text']);

        expect(trackRange(previous, container, selectionOf(null))).toBe(
          previous
        );
        expect(trackRange(previous, container, null)).toBe(previous);
        document.body.innerHTML = '';
      })
    );
  });
});
