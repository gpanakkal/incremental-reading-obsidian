import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeMinimalChange, narrowChanges } from './minimal-change';

// #region HELPERS

/**
 * Text of the given code points, written out so a test reads what they are:
 * astral ones and surrogate halves show as nothing, or tofu, in most editors.
 */
const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

/** Applies a change the way CodeMirror's ChangeSet does, for round-tripping. */
function applyChange(
  current: string,
  change: { from: number; to: number; insert: string }
): string {
  return (
    current.slice(0, change.from) + change.insert + current.slice(change.to)
  );
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** True when position `i` falls between the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, i: number): boolean {
  return (
    isHighSurrogate(text.charCodeAt(i - 1)) &&
    isLowSurrogate(text.charCodeAt(i))
  );
}

/**
 * A document built from a shared head, a differing middle, and a shared tail —
 * the shape every real external sync takes, since a note edited elsewhere keeps
 * most of its text.
 */
const localEditArb = fc
  .record({
    head: fc.string({ minLength: 1, maxLength: 60 }),
    tail: fc.string({ minLength: 1, maxLength: 60 }),
    oldMiddle: fc.string({ minLength: 1, maxLength: 30 }),
    newMiddle: fc.string({ minLength: 1, maxLength: 30 }),
  })
  // The middles must differ at both ends, or the algorithm legitimately
  // absorbs the matching characters into the shared prefix/suffix and the
  // exact boundary assertions below would not hold.
  .filter(
    ({ oldMiddle, newMiddle }) =>
      oldMiddle[0] !== newMiddle[0] &&
      oldMiddle[oldMiddle.length - 1] !== newMiddle[newMiddle.length - 1]
  );

const placementArb = fc.constantFrom('latest', 'earliest');

/** A line of any UTF-16 text, lone surrogates included, but no line break. */
const lineArb = fc
  .string({ unit: 'binary', maxLength: 12 })
  .map((s) => s.replace(/[\r\n]/g, ''));

const docArb = fc
  .array(lineArb, { minLength: 1, maxLength: 4 })
  .map((lines) => Text.of(lines));

/** Text an edit may put in: like a document's, line breaks included. */
const insertArb = fc
  .array(lineArb, { minLength: 1, maxLength: 3 })
  .map((lines) => lines.join('\n'));

/** Any set of edits to `doc`, as Obsidian or a plugin could dispatch them. */
const changesFor = (doc: Text) =>
  fc
    .array(
      fc.record({
        a: fc.integer({ min: 0, max: doc.length }),
        b: fc.integer({ min: 0, max: doc.length }),
        insert: insertArb,
      }),
      { maxLength: 4 }
    )
    .map((edits) => {
      // Sorted and kept apart, as one ChangeSet's edits must be
      const specs: { from: number; to: number; insert: string }[] = [];
      for (const { a, b, insert } of edits
        .map((e) => ({ ...e, a: Math.min(e.a, e.b), b: Math.max(e.a, e.b) }))
        .sort((x, y) => x.a - y.a || x.b - y.b)) {
        const last = specs[specs.length - 1];
        if (last && a <= last.to) continue;
        specs.push({ from: a, to: b, insert });
      }
      return ChangeSet.of(specs as ChangeSpec[], doc.length);
    });

const docAndChanges = docArb.chain((doc) =>
  fc.record({ doc: fc.constant(doc), changes: changesFor(doc) })
);

/** Each replaced span of `changes`, in the document before them. */
function spans(changes: ChangeSet) {
  const out: [number, number][] = [];
  changes.iterChanges((fromA, toA) => out.push([fromA, toA]));
  return out;
}

// #endregion

describe('computeMinimalChange narrows a whole-document swap to the differing span', () => {
  it('returns null when the incoming text already matches the document', () => {
    expect(computeMinimalChange('same text', 'same text')).toBeNull();
  });

  it('returns null for two empty strings', () => {
    expect(computeMinimalChange('', '')).toBeNull();
  });

  it('reports the exact span when a card line is undone out of the middle of a note', () => {
    const before = 'intro\ncard line\noutro';
    const after = 'intro\noutro';

    expect(computeMinimalChange(before, after)).toEqual({
      from: 6,
      to: 16,
      insert: '',
    });
  });

  it('reports an insertion as a zero-width replacement at the insertion point', () => {
    expect(computeMinimalChange('ab', 'aXb')).toEqual({
      from: 1,
      to: 1,
      insert: 'X',
    });
  });

  it('replaces the whole document when nothing at all is shared', () => {
    expect(computeMinimalChange('abc', 'xyz')).toEqual({
      from: 0,
      to: 3,
      insert: 'xyz',
    });
  });

  it('reconstructs the incoming text exactly (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 120 }),
        fc.string({ unit: 'binary', maxLength: 120 }),
        placementArb,
        async (current, next, placement) => {
          const change = computeMinimalChange(current, next, placement);
          // A null result must mean the texts already match; anything else
          // would silently drop an external edit.
          if (change === null) {
            expect(current).toBe(next);
            return;
          }
          expect(applyChange(current, change)).toBe(next);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('keeps from and to inside the current document and in order (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 120 }),
        fc.string({ unit: 'binary', maxLength: 120 }),
        placementArb,
        async (current, next, placement) => {
          const change = computeMinimalChange(current, next, placement);
          if (change === null) return;
          expect(change.from).toBeGreaterThanOrEqual(0);
          expect(change.to).toBeGreaterThanOrEqual(change.from);
          expect(change.to).toBeLessThanOrEqual(current.length);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('leaves the shared head and tail outside the changed span (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        localEditArb,
        placementArb,
        async ({ head, tail, oldMiddle, newMiddle }, placement) => {
          const current = head + oldMiddle + tail;
          const next = head + newMiddle + tail;

          const change = computeMinimalChange(current, next, placement);

          // Anything less than this and the scroll anchor — a position in the
          // head — would fall inside the deleted range and collapse.
          expect(change).not.toBeNull();
          expect(change!.from).toBeGreaterThanOrEqual(head.length);
          expect(change!.to).toBeLessThanOrEqual(
            head.length + oldMiddle.length
          );
        }
      ),
      { numRuns: 300 }
    );
  });

  it('never places a boundary inside a surrogate pair (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 80 }),
        fc.string({ unit: 'binary', maxLength: 80 }),
        placementArb,
        async (current, next, placement) => {
          const change = computeMinimalChange(current, next, placement);
          if (change === null) return;
          // A boundary inside an astral character hands CodeMirror a position
          // that is not a valid cursor location.
          expect(splitsSurrogatePair(current, change.from)).toBe(false);
          expect(splitsSurrogatePair(current, change.to)).toBe(false);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('widens past a shared astral character rather than splitting it', () => {
    // Both strings start with the same emoji, so a naive scan would stop the
    // prefix between its two code units.
    const change = computeMinimalChange('\u{1F600}a', '\u{1F600}b');

    expect(change).toEqual({ from: 2, to: 3, insert: 'b' });
  });

  it('widens when the two texts share only the leading half of a pair', () => {
    // \u{1F600} and \u{1F601} share their high surrogate but differ in the low
    // one, so the scan would otherwise cut the pair in half.
    const change = computeMinimalChange('\u{1F600}', '\u{1F601}');

    expect(change).not.toBeNull();
    expect(change!.from).toBe(0);
    expect(applyChange('\u{1F600}', change!)).toBe('\u{1F601}');
  });

  it('widens when the two texts share only the trailing half of a pair', () => {
    // \u{1F600} is D83D DE00 and \u{1FA00} is D83E DE00: the suffix scan matches
    // the shared low surrogate and stops mid-pair, putting the boundary between
    // the halves of the character still in the document.
    const change = computeMinimalChange('\u{1F600}', '\u{1FA00}');

    expect(change).toEqual({ from: 0, to: 2, insert: '\u{1FA00}' });
  });

  it('handles astral characters that share either surrogate half (property-based)', async () => {
    // Emoji drawn at random almost never share a surrogate half, so a pool of
    // characters chosen to share one or the other is needed to reach the
    // boundary adjustments at all. D83D DE00 / D83E DE00 share the low half;
    // D83D DE00 / D83D DE01 share the high half.
    const astralText = fc
      .array(
        fc.constantFrom(
          '\u{1F600}',
          '\u{1FA00}',
          '\u{1F601}',
          '\u{1F9A0}',
          'a',
          '\n'
        ),
        { maxLength: 12 }
      )
      .map((chars) => chars.join(''));

    await fc.assert(
      fc.asyncProperty(
        astralText,
        astralText,
        placementArb,
        async (current, next, placement) => {
          const change = computeMinimalChange(current, next, placement);
          if (change === null) {
            expect(current).toBe(next);
            return;
          }
          expect(applyChange(current, change)).toBe(next);
          expect(splitsSurrogatePair(current, change.from)).toBe(false);
          expect(splitsSurrogatePair(current, change.to)).toBe(false);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it.each([
    // High halves at either end of their range, the low one changing
    [cp(0x10000), cp(0x10001), { from: 0, to: 2, insert: cp(0x10001) }],
    [cp(0x10fc00), cp(0x10fc01), { from: 0, to: 2, insert: cp(0x10fc01) }],
    // Low halves at either end of theirs, the high one changing
    [cp(0x10000), cp(0x10400), { from: 0, to: 2, insert: cp(0x10400) }],
    [cp(0x103ff), cp(0x107ff), { from: 0, to: 2, insert: cp(0x107ff) }],
    // Just outside the surrogate range on either side: characters of their
    // own, nothing to widen past
    [cp(0x61, 0xe000), cp(0x62, 0xe000), { from: 0, to: 1, insert: 'b' }],
    [cp(0xd7ff, 0x61), cp(0xd7ff, 0x62), { from: 1, to: 2, insert: 'b' }],
  ])(
    'widens past exactly the surrogate halves %j → %j share',
    (current, next, expected) => {
      for (const placement of ['latest', 'earliest'] as const) {
        expect(computeMinimalChange(current, next, placement)).toEqual(
          expected
        );
      }
    }
  );

  it('puts an edit that could go anywhere in a run as late as it can, unless told the earliest (property-based)', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', 'c'), maxLength: 8 }),
        fc.string({ unit: fc.constantFrom('a', 'b', 'c'), maxLength: 8 }),
        fc.constantFrom('a', 'b', 'c'),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 3 }),
        fc.nat(),
        fc.boolean(),
        (pre, post, c, run, k, at, inserting) => {
          // `c` repeated, with neither neighbour a `c`
          fc.pre(!pre.endsWith(c) && !post.startsWith(c));
          const before = pre + c.repeat(run);
          const longer = before + c.repeat(k) + post;
          const shorter = before + post;
          const [current, next] = inserting
            ? [shorter, longer]
            : [longer, shorter];
          // Wherever in the run the edit was made, the text reads the same
          const where = at % (run + 1);
          expect(
            current.slice(0, pre.length + where) +
              (inserting ? c.repeat(k) : '') +
              current.slice(pre.length + where + (inserting ? 0 : k))
          ).toBe(next);

          const runEnd = before.length + (inserting ? 0 : k);
          expect(computeMinimalChange(current, next)).toEqual({
            from: runEnd - (inserting ? 0 : k),
            to: runEnd,
            insert: inserting ? c.repeat(k) : '',
          });
          expect(computeMinimalChange(current, next, 'earliest')).toEqual({
            from: pre.length,
            to: pre.length + (inserting ? 0 : k),
            insert: inserting ? c.repeat(k) : '',
          });
        }
      )
    );
  });
});

describe('narrowChanges', () => {
  it('makes the same document of the one it was given', () => {
    fc.assert(
      fc.property(
        docAndChanges,
        placementArb,
        ({ doc, changes }, placement) => {
          const narrowed = narrowChanges(changes, doc, placement);

          expect(narrowed.length).toBe(doc.length);
          expect(narrowed.apply(doc).toString()).toBe(
            changes.apply(doc).toString()
          );
        }
      )
    );
  });

  it('only ever shrinks a replaced span, never moves or joins one', () => {
    fc.assert(
      fc.property(
        docAndChanges,
        placementArb,
        ({ doc, changes }, placement) => {
          const original = spans(changes);
          for (const [from, to] of spans(
            narrowChanges(changes, doc, placement)
          )) {
            expect(
              original.some(([oFrom, oTo]) => oFrom <= from && to <= oTo)
            ).toBe(true);
          }
        }
      )
    );
  });

  it('keeps positions in the unchanged head and tail of a replacement where they were', () => {
    fc.assert(
      fc.property(
        docArb,
        insertArb,
        fc.nat(),
        placementArb,
        (doc, insert, at, placement) => {
          // The whole document replaced by itself with `insert` put in, as
          // `editor.setValue` does it
          const pos = at % (doc.length + 1);
          const text = doc.toString();
          const next = text.slice(0, pos) + insert + text.slice(pos);
          const changes = ChangeSet.of(
            { from: 0, to: doc.length, insert: next },
            doc.length
          );

          const narrowed = narrowChanges(changes, doc, placement);
          const after = narrowed.apply(doc).toString();

          // Nothing deleted but, at most, the halves of a surrogate pair
          // `insert` went between
          const replaced = spans(narrowed);
          for (const [from, to] of replaced) {
            expect(to - from).toBeLessThanOrEqual(2);
          }
          // Every other position maps onto the character it was on
          for (let i = 0; i < doc.length; i++) {
            if (replaced.some(([from, to]) => from <= i && i < to)) continue;
            const mapped = narrowed.mapPos(i, 1);
            expect(after.charCodeAt(mapped)).toBe(text.charCodeAt(i));
          }
        }
      )
    );
  });

  it('narrows each replacement as computeMinimalChange does, in the placement asked for', () => {
    fc.assert(
      fc.property(
        docAndChanges,
        placementArb,
        ({ doc, changes }, placement) => {
          const expected: { from: number; to: number; insert: string }[] = [];
          changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const change = computeMinimalChange(
              doc.sliceString(fromA, toA),
              inserted.toString(),
              placement
            );
            if (change) {
              expected.push({
                from: fromA + change.from,
                to: fromA + change.to,
                insert: change.insert,
              });
            }
          });
          const actual: { from: number; to: number; insert: string }[] = [];
          narrowChanges(changes, doc, placement).iterChanges(
            (fromA, toA, _fromB, _toB, inserted) => {
              actual.push({
                from: fromA,
                to: toA,
                insert: inserted.toString(),
              });
            }
          );
          expect(actual).toEqual(expected);
        }
      )
    );
  });

  it('places an edit in a run of like characters where it is told', () => {
    // 'a' taken out of 'xaaab': the run says nothing of which 'a' went
    const doc = Text.of(['xaaab']);
    const whole = ChangeSet.of({ from: 0, to: 5, insert: 'xaab' }, 5);
    expect(spans(narrowChanges(whole, doc, 'latest'))).toEqual([[3, 4]]);
    expect(spans(narrowChanges(whole, doc, 'earliest'))).toEqual([[1, 2]]);
  });

  it('drops a replacement of text with itself', () => {
    fc.assert(
      fc.property(docArb, placementArb, (doc, placement) => {
        const changes = ChangeSet.of(
          { from: 0, to: doc.length, insert: doc.toString() },
          doc.length
        );
        expect(narrowChanges(changes, doc, placement).empty).toBe(true);
      })
    );
  });
});
