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

/** Text thick with backslashes, what they escape and what they don't. */
const escapeyArb = fc.string({
  unit: fc.constantFrom('a', ' ', '\\', '|', '*', '\u{1F600}'),
  maxLength: 8,
});

/**
 * Where `text` has a character a backslash escapes, read left to right as
 * Markdown does: a backslash before ASCII punctuation escapes it, an escaped
 * backslash escapes nothing more.
 */
function escapedAt(text: string): Set<number> {
  const escaped = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && /[!-/:-@[-`{-~]/.test(text[i + 1] ?? '')) {
      escaped.add(++i);
    }
  }
  return escaped;
}

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

/**
 * Text of a few words and marks, spaced any way: two drawn alike share many
 * tokens, so `narrowChanges` has a diff to make of them.
 */
const wordyTextArb = fc
  .array(
    fc.tuple(
      fc.constantFrom('a', 'b', 'ab', 'cd', '|', '-', '.', '1.'),
      fc.constantFrom('', ' ', '  ', '\n')
    ),
    { maxLength: 12 }
  )
  .map((parts) => parts.map(([token, space]) => token + space).join(''));

/** A whole document replaced by another drawn alike, as `setValue` does it. */
const wordyRewriteArb = fc
  .record({ before: wordyTextArb, after: wordyTextArb })
  .map(({ before, after }) => {
    const doc = Text.of(before.split('\n'));
    return {
      doc,
      changes: ChangeSet.of(
        { from: 0, to: doc.length, insert: after },
        doc.length
      ),
    };
  });

/** Whitespace between tokens: never none, or two words would run together. */
const spaceArb = fc.constantFrom(' ', '  ', '   ', '\n', ' \n ');

/** The same words and marks spaced two ways, as a re-pad or re-wrap leaves them. */
const respacedArb = fc
  .array(fc.constantFrom('a', 'bc', 'def', '|', '---', ':', '1.'), {
    minLength: 1,
    maxLength: 10,
  })
  .chain((tokens) => {
    const spaced = fc
      .array(spaceArb, {
        minLength: tokens.length + 1,
        maxLength: tokens.length + 1,
      })
      .map((spaces) =>
        tokens.reduce(
          (text, token, i) => text + token + spaces[i + 1],
          spaces[0]
        )
      );
    return fc.record({ before: spaced, after: spaced });
  });

/**
 * Distinct words spaced one way, and the same spaced another with one of them
 * swapped, taken out, or put in, and a one-letter word put in at up to three
 * more places; with where each word left alone starts in either. No two
 * words share a first or last letter, so trimming the text the two share at
 * either end never stops inside one; every word left alone (six letters or
 * more) outweighs the most put in beside it (five), so no run of them is too
 * short to keep.
 */
const editedWordsArb = fc
  .array(fc.stringMatching(/^[a-z]{4,5}$/), { minLength: 2, maxLength: 12 })
  .map((mids) =>
    mids.map(
      (mid, i) =>
        String.fromCharCode(97 + i) + mid + String.fromCharCode(65 + i)
    )
  )
  .chain((words) =>
    fc.record({
      words: fc.constant(words),
      at: fc.nat({ max: words.length - 1 }),
      edit: fc.constantFrom('swap', 'remove', 'add'),
      adds: fc.array(fc.nat({ max: words.length }), { maxLength: 3 }),
      spaces: fc.array(spaceArb, {
        minLength: 2 * words.length + 8,
        maxLength: 2 * words.length + 8,
      }),
    })
  )
  .map(({ words, at, edit, adds, spaces }) => {
    const NEW = 'ZZ';
    const next = [...words];
    if (edit === 'swap') next.splice(at, 1, NEW);
    if (edit === 'remove') next.splice(at, 1);
    if (edit === 'add') next.splice(at, 0, NEW);
    for (const add of adds) next.splice(add, 0, 'Z');
    /** `list` spaced with `spaces` from `first` on, and where each word starts. */
    const spaced = (list: string[], first: number) => {
      let text = spaces[first];
      const starts = new Map<string, number>();
      list.forEach((word, i) => {
        starts.set(word, text.length);
        text += word + spaces[first + i + 1];
      });
      return { text, starts };
    };
    const before = spaced(words, 0);
    const after = spaced(next, words.length + 1);
    const kept = words
      .filter((word) => after.starts.has(word))
      .map((word) => ({
        from: before.starts.get(word)!,
        to: after.starts.get(word)!,
        length: word.length,
      }));
    return { before: before.text, after: after.text, kept };
  });

/**
 * A rewrite of `filler` words that it keeps, between `edits` / 2 words before
 * and after it that it swaps for others: `edits` tokens added and removed in
 * all. `kept` is where the kept words start, before and after.
 */
function scatteredRewrite(edits: number, filler: number) {
  const swapped = (word: string, count: number) =>
    Array.from({ length: count }, () => word);
  const kept = Array.from({ length: filler }, (_, i) => `w${i}`);
  const text = (word: string) =>
    [...swapped(word, edits / 4), ...kept, ...swapped(word, edits / 4)].join(
      ' '
    );
  const before = text('a');
  const doc = Text.of([before]);
  return {
    doc,
    rewrite: ChangeSet.of(
      { from: 0, to: doc.length, insert: text('b') },
      doc.length
    ),
    kept: before.indexOf('w0'),
  };
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

  it.each([
    // The shared tail would start on the escaped pipe
    ['a\\|', 'a\\ |', 'latest', { from: 2, to: 3, insert: ' |' }],
    // ... and put what a re-pad adds between it and its backslash
    ['a\\|', 'a\\| |', 'earliest', { from: 3, to: 3, insert: ' |' }],
    // An escape only the new text has stays outside the change
    ['a |', 'a \\|', 'earliest', { from: 2, to: 2, insert: '\\' }],
    // A backslash before a letter escapes nothing
    ['a\\b', 'a\\c', 'latest', { from: 2, to: 3, insert: 'c' }],
    // An escaped backslash leaves the pipe after it bare, a third escapes it
    ['x\\\\|', 'x\\\\| |', 'earliest', { from: 3, to: 3, insert: '| ' }],
    ['x\\\\\\|', 'x\\\\\\| |', 'earliest', { from: 5, to: 5, insert: ' |' }],
  ] as const)(
    'keeps a character the current text escapes out of the shared tail when told to: %j to %j, %s',
    (current, next, placement, change) => {
      expect(computeMinimalChange(current, next, placement, true)).toEqual(
        change
      );
    }
  );

  it('keeps a character the current text escapes out of the shared tail, and changes nothing else, when told to (property-based)', () => {
    fc.assert(
      fc.property(
        escapeyArb,
        escapeyArb,
        escapeyArb,
        escapeyArb,
        placementArb,
        (head, oldMiddle, newMiddle, tail, placement) => {
          const current = head + oldMiddle + tail;
          const next = head + newMiddle + tail;
          const plain = computeMinimalChange(current, next, placement);
          const kept = computeMinimalChange(current, next, placement, true);
          if (plain === null) {
            expect(kept).toBeNull();
            return;
          }
          expect(applyChange(current, kept!)).toBe(next);
          expect(splitsSurrogatePair(current, kept!.from)).toBe(false);
          expect(splitsSurrogatePair(current, kept!.to)).toBe(false);
          expect(escapedAt(current).has(kept!.to)).toBe(false);
          if (!escapedAt(current).has(plain.to)) {
            expect(kept).toEqual(plain);
          } else {
            // One character more of the tail in the change, which may let
            // the head take one more, as an edit that could go anywhere in a
            // run moves to where it can
            expect(kept!.to).toBe(plain.to + 1);
            expect(kept!.from - plain.from).toBeGreaterThanOrEqual(0);
            expect(kept!.from - plain.from).toBeLessThanOrEqual(1);
          }
        }
      ),
      { numRuns: 1000 }
    );
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

  it('keeps each replacement within the span computeMinimalChange trims it to', () => {
    fc.assert(
      fc.property(
        fc.oneof(docAndChanges, wordyRewriteArb),
        placementArb,
        ({ doc, changes }, placement) => {
          const trimmed: [number, number][] = [];
          changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const change = computeMinimalChange(
              doc.sliceString(fromA, toA),
              inserted.toString(),
              placement
            );
            if (change) {
              trimmed.push([fromA + change.from, fromA + change.to]);
            }
          });
          const narrowed = narrowChanges(changes, doc, placement);
          for (const [from, to] of spans(narrowed)) {
            expect(trimmed.some(([f, t]) => f <= from && to <= t)).toBe(true);
          }
          expect(narrowed.apply(doc).toString()).toBe(
            changes.apply(doc).toString()
          );
        }
      )
    );
  });

  it('keeps every position on text a rewrite only re-spaced on that text', () => {
    fc.assert(
      fc.property(respacedArb, placementArb, ({ before, after }, placement) => {
        const doc = Text.of(before.split('\n'));
        const rewrite = ChangeSet.of(
          { from: 0, to: doc.length, insert: after },
          doc.length
        );

        const narrowed = narrowChanges(rewrite, doc, placement);

        for (let i = 0; i < before.length; i++) {
          if (/\s/.test(before[i])) continue;
          // Onto the same character, whichever side it sticks to
          expect(after[narrowed.mapPos(i, 1)]).toBe(before[i]);
          expect(after[narrowed.mapPos(i + 1, -1) - 1]).toBe(before[i]);
        }
      })
    );
  });

  it('splits a rewrite where the text it keeps outweighs the edits beside it', () => {
    const doc = Text.of(['cat, big dog']);
    const rewrite = ChangeSet.of(
      { from: 0, to: 12, insert: 'pig, big cow' },
      12
    );
    expect(spans(narrowChanges(rewrite, doc))).toEqual([
      [0, 3],
      [9, 12],
    ]);
  });

  it('leaves a rewrite whole where the texts share only a scatter of short tokens', () => {
    // ', a' says nothing of where 'cat' or 'dog' went: no longer than the
    // most taken out (or put in) on either side of it
    const doc = Text.of(['cat, a dog']);
    const rewrite = ChangeSet.of({ from: 0, to: 10, insert: 'p, a q' }, 10);
    expect(spans(narrowChanges(rewrite, doc))).toEqual([[0, 10]]);
  });

  it('leaves a rewrite whole where what it keeps is just as long as the edits beside it', () => {
    const doc = Text.of(['cat, ab dog']);
    const rewrite = ChangeSet.of(
      { from: 0, to: 11, insert: 'pig, ab cow' },
      11
    );
    expect(spans(narrowChanges(rewrite, doc))).toEqual([[0, 11]]);
  });

  it('weighs each kept run by the edits on its own two sides', () => {
    // 'c' alone is no longer than the words swapped either side of it; the
    // 'longword's are
    const before = '1 longword aaaa c bbbb longword 1';
    const doc = Text.of([before]);
    const rewrite = ChangeSet.of(
      { from: 0, to: 33, insert: '2 longword xxxx c yyyy longword 2' },
      33
    );
    expect(spans(narrowChanges(rewrite, doc))).toEqual([
      [0, 1],
      [11, 22],
      [32, 33],
    ]);
  });

  it('splits a rewrite that puts in exactly as many tokens as are looked for', () => {
    const kept = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    const added = Array.from({ length: 500 / 2 }, () => 'b').join(' ');
    const after = `${added} ${kept} ${added}`;
    const doc = Text.of([kept]);
    const rewrite = ChangeSet.of(
      { from: 0, to: doc.length, insert: after },
      doc.length
    );
    expect(narrowChanges(rewrite, doc).mapPos(0, 1)).toBe(after.indexOf('w0'));
  });

  it('keeps every token a rewrite neither took out nor put in on itself', () => {
    fc.assert(
      fc.property(
        editedWordsArb,
        placementArb,
        ({ before, after, kept }, placement) => {
          const doc = Text.of(before.split('\n'));
          const rewrite = ChangeSet.of(
            { from: 0, to: doc.length, insert: after },
            doc.length
          );

          const narrowed = narrowChanges(rewrite, doc, placement);

          for (const { from, to, length } of kept) {
            for (let c = 0; c < length; c++) {
              expect(narrowed.mapPos(from + c, 1)).toBe(to + c);
            }
          }
        }
      )
    );
  });

  it('weighs a kept run again once the edits beside it join up', () => {
    // 'ab' outweighs the 'c' → 'e' after it, until the lone 'd' between that
    // and the long edit after goes, and the edits it parted join
    const doc = Text.of(['pq ab c d vwxyz']);
    const rewrite = ChangeSet.of(
      { from: 0, to: 15, insert: 'rs ab e d fghij' },
      15
    );
    expect(spans(narrowChanges(rewrite, doc))).toEqual([[0, 15]]);
  });

  it.each(['latest', 'earliest'] as const)(
    'keeps a one-character cell where a re-pad puts pipes at both its sides (%s)',
    (placement) => {
      // Rows given the pipes they lacked at their ends: each pipe added
      // counts for nothing against the lone 'p' between two of them
      const before = ' ro  |lu y  \n|  :-: |  :-:  \n|   |p ';
      const after = '| ro  | lu y |\n| :-: | :--: |\n|     | p    |';
      const doc = Text.of(before.split('\n'));
      const rewrite = ChangeSet.of(
        { from: 0, to: before.length, insert: after },
        before.length
      );
      const narrowed = narrowChanges(rewrite, doc, placement);
      const p = before.indexOf('p');
      expect([narrowed.mapPos(p, 1), narrowed.mapPos(p + 1, -1)]).toEqual([
        after.indexOf('p'),
        after.indexOf('p') + 1,
      ]);
    }
  );

  it.each(['latest', 'earliest'] as const)(
    'keeps text between separator rows whose dashes grow by more than it holds (%s)',
    (placement) => {
      const before = '|-|\n|ab|\n|-|';
      const dashes = '-'.repeat(10);
      const after = `| ${dashes} |\n| ab |\n| ${dashes} |`;
      const doc = Text.of(before.split('\n'));
      const narrowed = narrowChanges(
        ChangeSet.of(
          { from: 0, to: before.length, insert: after },
          before.length
        ),
        doc,
        placement
      );
      const ab = before.indexOf('ab');
      expect([narrowed.mapPos(ab, 1), narrowed.mapPos(ab + 2, -1)]).toEqual([
        after.indexOf('ab'),
        after.indexOf('ab') + 2,
      ]);
    }
  );

  it('splits a re-pad that widens a separator row by more dashes than it looks for edits', () => {
    // Columns 300 wide: 598 dashes added, as one run each
    const wide = (c: string) => c.repeat(300);
    const before = `|a|b|\n|-|-|\n|${wide('x')}|${wide('y')}|`;
    const after = [
      `| ${'a'.padEnd(300)} | ${'b'.padEnd(300)} |`,
      `| ${wide('-')} | ${wide('-')} |`,
      `| ${wide('x')} | ${wide('y')} |`,
    ].join('\n');
    const doc = Text.of(before.split('\n'));
    const narrowed = narrowChanges(
      ChangeSet.of(
        { from: 0, to: before.length, insert: after },
        before.length
      ),
      doc
    );
    expect([narrowed.mapPos(1, 1), narrowed.mapPos(2, -1)]).toEqual([2, 3]);
  });

  it('keeps a token among like ones by the placement it is told', () => {
    // One of the two 'a's goes: 'latest' keeps the first, 'earliest' the last
    const doc = Text.of(['|a  a|']);
    const rewrite = ChangeSet.of({ from: 0, to: 6, insert: '| a |' }, 6);
    expect(narrowChanges(rewrite, doc, 'latest').mapPos(1, 1)).toBe(2);
    expect(narrowChanges(rewrite, doc, 'latest').mapPos(4, 1)).toBe(4);
    expect(narrowChanges(rewrite, doc, 'earliest').mapPos(1, 1)).toBe(1);
    expect(narrowChanges(rewrite, doc, 'earliest').mapPos(4, 1)).toBe(2);
  });

  it('splits a rewrite that adds and removes a few hundred tokens around text it keeps', () => {
    const { doc, rewrite, kept } = scatteredRewrite(400, 2_000);
    const narrowed = narrowChanges(rewrite, doc);
    expect(narrowed.mapPos(kept, 1)).toBe(kept);
  });

  it('leaves a rewrite whole that adds and removes more tokens than are worth diffing', () => {
    const { doc, rewrite, kept } = scatteredRewrite(600, 2_000);
    expect(spans(narrowChanges(rewrite, doc))).toEqual([[0, doc.length]]);
    expect(narrowChanges(rewrite, doc).mapPos(kept, 1)).not.toBe(kept);
  });

  it('diffs a long rewrite only as far as it can do cheaply', () => {
    // Long enough that fewer edits are looked for than in a short one
    const far = scatteredRewrite(300, 20_000);
    expect(spans(narrowChanges(far.rewrite, far.doc))).toEqual([
      [0, far.doc.length],
    ]);
    const near = scatteredRewrite(60, 20_000);
    expect(narrowChanges(near.rewrite, near.doc).mapPos(near.kept, 1)).toBe(
      near.kept
    );
  });

  it('places an edit in a run of like characters where it is told', () => {
    // 'a' taken out of 'xaaab': the run says nothing of which 'a' went
    const doc = Text.of(['xaaab']);
    const whole = ChangeSet.of({ from: 0, to: 5, insert: 'xaab' }, 5);
    expect(spans(narrowChanges(whole, doc, 'latest'))).toEqual([[3, 4]]);
    expect(spans(narrowChanges(whole, doc, 'earliest'))).toEqual([[1, 2]]);
  });

  it.each([
    // A row given the pipe at its end it lacked, and a column besides
    ['| x | k\\|', '| x | k\\| |'],
    ['| x | k\\|', '|     | x   | k\\| |'],
    ['| k\\| |', '| k\\| |     |'],
    ['| \\|k |', '|     | \\|k |'],
    ['| \\| |', '| \\| |     |'],
  ])(
    'keeps an escaped pipe in a cell on itself, never on a pipe the rewrite puts beside it: %j to %j',
    (before, after) => {
      const doc = Text.of([before]);
      const rewrite = ChangeSet.of(
        { from: 0, to: before.length, insert: after },
        before.length
      );
      const from = before.indexOf('\\|');
      for (const placement of ['latest', 'earliest'] as const) {
        const narrowed = narrowChanges(rewrite, doc, placement);
        expect([
          narrowed.mapPos(from, 1),
          narrowed.mapPos(from + 2, -1),
        ]).toEqual([after.indexOf('\\|'), after.indexOf('\\|') + 2]);
      }
    }
  );

  it.each([
    // A backslash made to escape what is typed after it, and the reverse
    ['a k\\ b', 'a k\\! b', [4, 4]],
    ['a k\\! b', 'a k\\ b', [4, 5]],
    // A character escaped by a backslash typed before it, and the reverse
    ['a |k b', 'a \\|k b', [2, 2]],
    ['a \\|k b', 'a |k b', [2, 3]],
  ] as const)(
    'narrows a rewrite that makes or unmakes an escape to what it puts in or takes out: %j to %j',
    (before, after, span) => {
      const doc = Text.of([before]);
      const rewrite = ChangeSet.of(
        { from: 0, to: before.length, insert: after },
        before.length
      );
      for (const placement of ['latest', 'earliest'] as const) {
        expect(spans(narrowChanges(rewrite, doc, placement))).toEqual([span]);
      }
    }
  );

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
