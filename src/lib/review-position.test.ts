import fc from 'fast-check';
import type {
  App,
  CachedMetadata,
  Editor,
  SubpathResult,
  TFile,
} from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { wasPositioned } from './ephemeral-position';
import {
  arrivalRanges,
  positionEditor,
  positionOnArrival,
  subpathResolver,
  type OffsetRange,
} from './review-position';

// #region HELPERS

/** A location as the metadata cache reports one; only the offset is read. */
const locAt = (offset: number) => ({ line: 0, col: 0, offset });

/** Any offset a cache or a match could report, past the document's end too. */
const offsetArb = fc.integer({ min: -5, max: 300 });

const subpathResultArb: fc.Arbitrary<SubpathResult> = fc.record({
  start: offsetArb.map(locAt),
  end: fc.option(offsetArb.map(locAt), { nil: null }),
});

/** What a subpath resolves to in the note, or nothing found there. */
const resolvedArb = fc.option(subpathResultArb, { nil: null });

const matchArb = fc.record({
  content: fc.string(),
  matches: fc.array(fc.tuple(offsetArb, offsetArb), { maxLength: 3 }),
});

/** Ephemeral state of every shape a link can hand over, and some it cannot. */
const eStateArb = fc.oneof(
  fc.record(
    { subpath: fc.string(), match: matchArb, focus: fc.boolean() },
    { requiredKeys: [] }
  ),
  fc.anything()
);

/** Whether `range` lies inside a note `length` long, in order. */
const inside = (range: OffsetRange, length: number) =>
  range.from >= 0 && range.from <= range.to && range.to <= length;

/**
 * Whether `range` is `a` and `b` brought inside a note `length` long: each
 * end is one of them, or the edge it was past.
 */
const keeps = (range: OffsetRange, a: number, b: number, length: number) => {
  const toEdge = (n: number) => (n < 0 ? 0 : n > length ? length : n);
  return (
    inside(range, length) &&
    [range.from, range.to].sort((x, y) => x - y).join() ===
      [toEdge(a), toEdge(b)].sort((x, y) => x - y).join()
  );
};

/** An editor whose positions are offsets, recording what was done to it. */
function makeEditor(doc = '') {
  const pos = (offset: number) => ({ line: 0, ch: offset });
  const editor = {
    offsetToPos: vi.fn(pos),
    addHighlights: vi.fn(),
    setCursor: vi.fn(),
    scrollIntoView: vi.fn(),
    getValue: () => doc,
  };
  return { editor, asEditor: editor as unknown as Editor, pos };
}

/** A review tab that hands each listener what `arrive` is given. */
function makeReviewView() {
  const listeners = new Map<string, (eState: unknown) => void>();
  const stop = vi.fn(() => listeners.clear());
  return {
    reviewView: {
      onArrival: vi.fn((itemId: string, position: (e: unknown) => void) => {
        listeners.set(itemId, position);
        return stop;
      }),
    },
    arrive: (itemId: string, eState: unknown) =>
      listeners.get(itemId)?.(eState),
    stop,
  };
}

/** An editor for `item` on a note `doc` whose subpaths resolve to `resolved`. */
function wireArrivals(doc: string, resolved: SubpathResult | null) {
  const tab = makeReviewView();
  const { editor, asEditor, pos } = makeEditor(doc);
  const owner = {};
  const resolve = vi.fn(() => resolved);
  const stop = positionOnArrival({
    reviewView: tab.reviewView,
    itemId: 'item',
    owner,
    editor: asEditor,
    resolveSubpath: resolve,
  });
  return { ...tab, editor, pos, owner, resolve, stopListening: stop };
}

/** A note subpaths are resolved in. */
const noteFile = { path: 'Snippets/a.md' } as TFile;
/** An app whose metadata cache holds `cache` for every note. */
const appWith = (cache: CachedMetadata | null) =>
  ({
    metadataCache: { getFileCache: vi.fn(() => cache) },
  }) as unknown as App & {
    metadataCache: { getFileCache: ReturnType<typeof vi.fn> };
  };

// #endregion

describe('arrivalRanges', () => {
  it.each([
    [
      'a heading to the next',
      { subpath: '#H' },
      { start: 5, end: 10 },
      20,
      [[5, 10]],
    ],
    [
      'the last heading to the end',
      { subpath: '#H' },
      { start: 5, end: null },
      20,
      [[5, 20]],
    ],
    [
      'a block cut short by an edit',
      { subpath: '#^b' },
      { start: 15, end: 40 },
      20,
      [[15, 20]],
    ],
    [
      'a match backwards and past both ends',
      { match: { content: '', matches: [[30, -2]] } },
      null,
      20,
      [[0, 20]],
    ],
    [
      'every match',
      {
        match: {
          content: '',
          matches: [
            [1, 2],
            [8, 4],
          ],
        },
      },
      null,
      20,
      [
        [1, 2],
        [4, 8],
      ],
    ],
    [
      'a match, its subpath unresolved',
      { subpath: '#Gone', match: { content: '', matches: [[3, 6]] } },
      null,
      20,
      [[3, 6]],
    ],
    [
      'the subpath over a match',
      { subpath: '#H', match: { content: '', matches: [[3, 6]] } },
      { start: 9, end: 12 },
      20,
      [[9, 12]],
    ],
  ] as const)('opens %s', (_name, eState, resolved, length, expected) => {
    const result = resolved && {
      start: locAt(resolved.start),
      end: resolved.end === null ? null : locAt(resolved.end),
    };

    expect(arrivalRanges(eState, length, () => result)).toEqual(
      expected.map(([from, to]) => ({ from, to }))
    );
  });

  it("opens a link's subpath at what it resolves to, kept inside the note", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        subpathResultArb,
        fc.option(matchArb, { nil: undefined }),
        fc.nat(300),
        (subpath, resolved, match, length) => {
          const resolve = vi.fn(() => resolved);
          const ranges = arrivalRanges(
            match ? { subpath, match } : { subpath },
            length,
            resolve
          );

          expect(resolve).toHaveBeenCalledExactlyOnceWith(subpath);
          expect(ranges).toHaveLength(1);
          const end = resolved.end?.offset ?? length;
          expect(keeps(ranges[0], resolved.start.offset, end, length)).toBe(
            true
          );
        }
      )
    );
  });

  it('opens every match, kept inside the note, once no subpath resolves', () => {
    fc.assert(
      fc.property(
        matchArb,
        fc.option(fc.string(), { nil: undefined }),
        fc.nat(300),
        (match, subpath, length) => {
          const eState = subpath === undefined ? { match } : { match, subpath };
          const ranges = arrivalRanges(eState, length, () => null);

          expect(ranges).toHaveLength(match.matches.length);
          ranges.forEach((range, i) => {
            const [a, b] = match.matches[i];
            expect(keeps(range, a, b, length)).toBe(true);
          });
        }
      )
    );
  });

  it('always answers ranges inside the note, in order', () => {
    fc.assert(
      fc.property(
        eStateArb,
        resolvedArb,
        fc.nat(300),
        (eState, resolved, length) => {
          for (const range of arrivalRanges(eState, length, () => resolved)) {
            expect(inside(range, length)).toBe(true);
          }
        }
      )
    );
  });

  it('answers no range, and resolves nothing, for a state that names no place', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(null, undefined, 0, 'subpath', true),
          fc.record({ focus: fc.boolean() }),
          fc.record({ subpath: fc.oneof(fc.nat(), fc.constant('')) }),
          fc.record({
            match: fc.constantFrom(null, 'x', {}, { matches: 'x' }),
          }),
          fc.record({
            match: fc.record({
              matches: fc.constantFrom([['a', 1]], [[1, 'b']], ['x'], [null]),
            }),
          })
        ),
        fc.nat(300),
        (eState, length) => {
          const resolve = vi.fn(() => null);

          expect(arrivalRanges(eState, length, resolve)).toEqual([]);
          expect(resolve).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('opens nowhere for a subpath the note cannot resolve, and no match', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat(300),
        (subpath, length) => {
          expect(arrivalRanges({ subpath }, length, () => null)).toEqual([]);
        }
      )
    );
  });
});

describe('subpathResolver', () => {
  it("resolves a heading in the note's cache, read as it is when asked", () => {
    const heading = {
      heading: 'Heading',
      level: 1,
      position: { start: locAt(4), end: locAt(13) },
    };
    const app = appWith({ headings: [heading] });
    let asked = noteFile;
    const resolve = subpathResolver(app, () => asked);
    asked = { path: 'Snippets/renamed.md' } as TFile;

    expect(resolve('#Heading')?.start.offset).toBe(4);
    expect(app.metadataCache.getFileCache).toHaveBeenCalledExactlyOnceWith(
      asked
    );
  });

  it('resolves nothing in a note the cache has not read', () => {
    expect(
      subpathResolver(appWith(null), () => noteFile)('#Heading')
    ).toBeNull();
  });
});

describe('positionEditor', () => {
  it('flashes every range, puts the cursor at the first one and centers it, as a note tab does', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.nat(100), fc.nat(100)).map(([a, b]) => ({
            from: Math.min(a, b),
            to: Math.max(a, b),
          })),
          { minLength: 1, maxLength: 3 }
        ),
        (ranges) => {
          const { editor, asEditor, pos } = makeEditor();

          positionEditor(asEditor, ranges);

          // Replacing those already there, and unfolding what hides them
          expect(editor.addHighlights).toHaveBeenCalledExactlyOnceWith(
            ranges.map(({ from, to }) => ({ from: pos(from), to: pos(to) })),
            'is-flashing',
            true,
            true
          );
          const [first] = ranges;
          expect(editor.setCursor).toHaveBeenCalledExactlyOnceWith(
            pos(first.from)
          );
          expect(editor.scrollIntoView).toHaveBeenCalledExactlyOnceWith(
            { from: pos(first.to), to: pos(first.from) },
            true
          );
        }
      )
    );
  });

  it('does nothing with no range', () => {
    const { editor, asEditor } = makeEditor();

    positionEditor(asEditor, []);

    expect(editor.addHighlights).not.toHaveBeenCalled();
    expect(editor.setCursor).not.toHaveBeenCalled();
    expect(editor.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('positionOnArrival', () => {
  it('puts the editor at the place a link names, and keeps scroll restore from undoing it', () => {
    fc.assert(
      fc.property(fc.string(), subpathResultArb, (doc, resolved) => {
        const wired = wireArrivals(doc, resolved);
        const eState = { subpath: '#Heading' };

        wired.arrive('item', eState);

        const [range] = arrivalRanges(eState, doc.length, () => resolved);
        expect(wired.resolve).toHaveBeenCalledExactlyOnceWith('#Heading');
        expect(wired.editor.setCursor).toHaveBeenCalledExactlyOnceWith(
          wired.pos(range.from)
        );
        expect(wasPositioned(wired.owner)).toBe(true);
      })
    );
  });

  it('leaves the editor, and scroll restore, alone for a place it cannot find', () => {
    const wired = wireArrivals('# Heading', null);

    wired.arrive('item', { subpath: '#Gone' });

    expect(wired.editor.setCursor).not.toHaveBeenCalled();
    expect(wired.editor.scrollIntoView).not.toHaveBeenCalled();
    expect(wasPositioned(wired.owner)).toBe(false);
  });

  it('listens for its own item, and for nothing once told to stop', () => {
    const wired = wireArrivals('# Heading', {
      start: locAt(0),
      end: null,
    });

    expect(wired.reviewView.onArrival).toHaveBeenCalledExactlyOnceWith(
      'item',
      expect.any(Function)
    );
    wired.stopListening();
    wired.arrive('item', { subpath: '#Heading' });

    expect(wired.editor.setCursor).not.toHaveBeenCalled();
  });
});
