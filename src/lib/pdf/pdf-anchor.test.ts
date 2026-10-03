// @vitest-environment jsdom
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anchorFromDomPoint,
  type AnchorParts,
  decodeAnchor,
  encodeAnchor,
  itemSpansOnPage,
  MAX_ANCHOR_PAGE,
  type PageItem,
  rangeToAnchors,
} from './pdf-anchor';

// #region HELPERS

/** The last position on the last page the codec holds. */
const MAX_ANCHOR = MAX_ANCHOR_PAGE * 1e10 + 99_999 * 1e5 + 99_999;

/** Every position the codec promises to hold. */
const partsArb = fc.record({
  page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
  idx: fc.integer({ min: 0, max: 99_999 }),
  char: fc.integer({ min: 0, max: 99_999 }),
});

/** Lexicographic (page, idx, char) order: document order. */
function compareParts(a: AnchorParts, b: AnchorParts) {
  return a.page - b.page || a.idx - b.idx || a.char - b.char;
}

/** Any number at all, weighted towards the edges of the valid range. */
const anyNumberArb = fc.oneof(
  fc.double(),
  fc.integer({ min: -1, max: 1e10 + 1 }),
  fc.integer({ min: MAX_ANCHOR - 1, max: Number.MAX_SAFE_INTEGER }),
  fc.constantFrom(
    NaN,
    Infinity,
    -Infinity,
    -0,
    1e10,
    MAX_ANCHOR,
    MAX_ANCHOR + 1
  )
);

/** One entry of a page's text content, in the order pdf.js streams them. */
type TextOp =
  | {
      kind: 'item';
      str: string;
      hasEOL: boolean;
      /** Where the span's text is split into separate text nodes. */
      cuts: number[];
      /** Per piece: wrap it in a child span, as highlights do. */
      wraps: boolean[];
      /** pdf.js find overwrites a middle match's class, dropping `textLayerNode`. */
      findMiddle: boolean;
    }
  | { kind: 'begin' }
  | { kind: 'end' };

const itemOpArb: fc.Arbitrary<TextOp> = fc.record({
  kind: fc.constant('item' as const),
  // Empty strings are common in real PDFs; astral characters are two UTF-16
  // units, so offsets can land between the halves.
  str: fc.oneof(fc.constant(''), fc.string({ unit: 'binary', maxLength: 6 })),
  hasEOL: fc.boolean(),
  cuts: fc.array(fc.nat({ max: 6 }), { maxLength: 3 }),
  wraps: fc.array(fc.boolean(), { maxLength: 4 }),
  findMiddle: fc.boolean(),
});

const textOpArb: fc.Arbitrary<TextOp> = fc.oneof(
  { weight: 4, arbitrary: itemOpArb },
  { weight: 1, arbitrary: fc.constant({ kind: 'begin' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'end' as const }) }
);

interface PageModel {
  pageNumber: number;
  /** A page not rendered yet has no text layer at all. */
  hasTextLayer: boolean;
  /** The first op's idx: any number of empty items can come before it. */
  firstIdx: number;
  ops: TextOp[];
}

/** A few pages of one PDF, in page order, not necessarily consecutive. */
const pagesArb: fc.Arbitrary<PageModel[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }), {
    minLength: 1,
    maxLength: 3,
  })
  .chain((numbers) =>
    fc.tuple(
      ...numbers
        .sort((a, b) => a - b)
        .map((pageNumber) =>
          fc.record({
            pageNumber: fc.constant(pageNumber),
            hasTextLayer: fc.boolean(),
            // Leaves room for 8 more items below the idx limit.
            firstIdx: fc.oneof(fc.constant(0), fc.nat({ max: 99_991 })),
            ops: fc.array(textOpArb, { maxLength: 8 }),
          })
        )
    )
  );

/** One or two PDF viewers (a leaf, or embeds in one note) in the document. */
const viewersArb = fc.array(pagesArb, { minLength: 1, maxLength: 2 });

/** What the model says a text item's span is. */
interface ItemInfo {
  viewer: number;
  pageEl: HTMLElement;
  page: number;
  idx: number;
  length: number;
  /** Position among every item span in the document. */
  seq: number;
}

/** A DOM boundary point, and what the model says lies around it. */
interface Point {
  node: Node;
  offset: number;
  /** The page div it sits in, if any. */
  pageEl: HTMLElement | null;
  /** Set when the point is inside an item span. */
  inside: { item: ItemInfo; char: number } | null;
  /** How many item spans start before the point. */
  started: number;
}

interface Built {
  /** Each viewer's root element. */
  viewerEls: HTMLElement[];
  pageEls: HTMLElement[];
  /** Every item span in the document, in document order. */
  items: ItemInfo[];
  /** Every boundary point in the document, in document order. */
  points: Point[];
}

/** Splits `str` at `cuts` into pieces (some empty), as highlights leave it. */
function pieces(str: string, cuts: number[]) {
  const at = [...new Set(cuts.map((cut) => Math.min(cut, str.length)))].sort(
    (a, b) => a - b
  );
  const out: string[] = [];
  let from = 0;
  for (const cut of [...at, str.length]) {
    out.push(str.slice(from, cut));
    from = cut;
  }
  return out;
}

/** Fills `textLayer` as Obsidian's patched pdf.js does, calling `onItem` per span. */
function fillTextLayer(
  textLayer: HTMLElement,
  firstIdx: number,
  ops: TextOp[],
  onItem: (span: HTMLElement, idx: number, length: number) => void
) {
  let parent = textLayer;
  let idx = firstIdx;
  for (const op of ops) {
    if (op.kind === 'begin') {
      const marked = parent.appendChild(document.createElement('span'));
      marked.className = 'markedContent';
      parent = marked;
    } else if (op.kind === 'end') {
      if (parent !== textLayer) parent = parent.parentElement!;
    } else {
      if (op.str !== '') {
        const span = parent.appendChild(document.createElement('span'));
        span.className = op.findMiddle
          ? 'highlight middle selected'
          : 'textLayerNode';
        span.dataset.idx = String(idx);
        pieces(op.str, op.cuts).forEach((piece, i) => {
          const text = document.createTextNode(piece);
          if (op.wraps[i]) {
            const wrap = span.appendChild(document.createElement('span'));
            wrap.className = 'mod-focused selected appended';
            wrap.appendChild(text);
          } else {
            span.appendChild(text);
          }
        });
        onItem(span, idx, op.str.length);
      }
      // Empty items still use up an idx.
      idx++;
      if (op.hasEOL) {
        parent
          .appendChild(document.createElement('br'))
          .setAttribute('role', 'presentation');
      }
    }
  }
  textLayer.appendChild(document.createElement('div')).className =
    'endOfContent';
}

/**
 * Builds the DOM Obsidian's patched pdf.js renders for each viewer's pages,
 * with text outside any page before and after each viewer. The model's
 * answers are recorded while building, never read back off the DOM.
 */
function buildViewers(viewers: PageModel[][]): Built {
  document.body.replaceChildren();
  const itemOf = new Map<Node, Omit<ItemInfo, 'seq'>>();
  const pageEls: HTMLElement[] = [];
  const viewerEls = viewers.map((pages, viewer) => {
    const root = document.body.appendChild(document.createElement('div'));
    root.appendChild(document.createElement('div')).textContent = 'Toolbar';
    const pdfViewer = root.appendChild(document.createElement('div'));
    pdfViewer.className = 'pdfViewer';
    for (const { pageNumber, hasTextLayer, firstIdx, ops } of pages) {
      const pageEl = pdfViewer.appendChild(document.createElement('div'));
      pageEl.className = 'page';
      pageEl.dataset.pageNumber = String(pageNumber);
      pageEls.push(pageEl);
      pageEl.appendChild(document.createElement('div')).className =
        'canvasWrapper';
      if (hasTextLayer) {
        const textLayer = pageEl.appendChild(document.createElement('div'));
        textLayer.className = 'textLayer';
        fillTextLayer(textLayer, firstIdx, ops, (span, idx, length) => {
          itemOf.set(span, { viewer, pageEl, page: pageNumber, idx, length });
        });
      }
      const annotations = pageEl.appendChild(document.createElement('div'));
      annotations.className = 'annotationLayer';
      annotations.appendChild(document.createElement('section')).textContent =
        'Annotation';
    }
    root.appendChild(document.createElement('div')).textContent = 'After';
    return root;
  });

  const items: ItemInfo[] = [];
  const points: Point[] = [];
  const visit = (
    node: Node,
    pageEl: HTMLElement | null,
    inside: { item: ItemInfo; char: number } | null
  ) => {
    const info = itemOf.get(node);
    if (info) {
      const item = { ...info, seq: items.length };
      items.push(item);
      inside = { item, char: 0 };
    }
    if (pageEls.includes(node as HTMLElement)) pageEl = node as HTMLElement;
    const here = (offset: number, char: number) => {
      points.push({
        node,
        offset,
        pageEl,
        inside: inside && { item: inside.item, char },
        started: items.length,
      });
    };
    if (node.nodeType === Node.TEXT_NODE) {
      const { length } = node as Text;
      for (let offset = 0; offset <= length; offset++) {
        here(offset, (inside?.char ?? 0) + offset);
      }
      if (inside) inside.char += length;
      return;
    }
    node.childNodes.forEach((child, offset) => {
      here(offset, inside?.char ?? 0);
      visit(child, pageEl, inside);
    });
    here(node.childNodes.length, inside?.char ?? 0);
  };
  visit(document.body, null, null);
  return { viewerEls, pageEls, items, points };
}

/** The anchor at the start of `item`, or at its end. */
function itemStart(item: ItemInfo) {
  return encodeAnchor({ page: item.page, idx: item.idx, char: 0 });
}
function itemEnd(item: ItemInfo) {
  return encodeAnchor({ page: item.page, idx: item.idx, char: item.length });
}

/** The anchor of a point `char` UTF-16 units into `item`. */
function insideAnchor({ item, char }: { item: ItemInfo; char: number }) {
  return encodeAnchor({ page: item.page, idx: item.idx, char });
}

/**
 * Each DOM property case checks every boundary point of a fresh document, so
 * fewer cases still check thousands of points, within the test timeout.
 */
const DOM_RUNS = { numRuns: 50 };

const edgeArb = fc.constantFrom('start' as const, 'end' as const);

// #endregion

afterEach(() => {
  document.body.replaceChildren();
});

describe('encodeAnchor / decodeAnchor', () => {
  it('decodes every encoded position back to itself', () => {
    fc.assert(
      fc.property(partsArb, (parts) => {
        expect(decodeAnchor(encodeAnchor(parts))).toEqual(parts);
      })
    );
  });

  it('orders anchors numerically exactly as their positions sit in the document', () => {
    fc.assert(
      fc.property(partsArb, partsArb, (a, b) => {
        expect(Math.sign(encodeAnchor(a) - encodeAnchor(b))).toBe(
          Math.sign(compareParts(a, b))
        );
      })
    );
  });

  it('keeps every anchor a safe integer', () => {
    fc.assert(
      fc.property(partsArb, (parts) => {
        expect(Number.isSafeInteger(encodeAnchor(parts))).toBe(true);
      })
    );
    expect(Number.isSafeInteger(MAX_ANCHOR)).toBe(true);
    // One more page would not fit.
    expect(Number.isSafeInteger(MAX_ANCHOR + 1e10)).toBe(false);
  });

  it('encodes exactly page * 1e10 + idx * 1e5 + char', () => {
    fc.assert(
      fc.property(partsArb, ({ page, idx, char }) => {
        expect(encodeAnchor({ page, idx, char })).toBe(
          page * 1e10 + idx * 1e5 + char
        );
      })
    );
  });

  it('refuses to encode a component outside its range, naming it', () => {
    const notInteger = fc.double().filter((n) => !Number.isInteger(n));
    const badPage = fc.oneof(
      fc.constantFrom(0, MAX_ANCHOR_PAGE + 1),
      fc.integer({ max: 0 }),
      fc.integer({ min: MAX_ANCHOR_PAGE + 1 }),
      notInteger
    );
    const badPart = fc.oneof(
      fc.constantFrom(-1, 100_000, 100_001),
      fc.integer({ max: -1 }),
      fc.integer({ min: 100_000 }),
      notInteger
    );
    fc.assert(
      fc.property(
        partsArb,
        fc.oneof(
          badPage.map((page) => ['page', page] as const),
          badPart.map((idx) => ['idx', idx] as const),
          badPart.map((char) => ['char', char] as const)
        ),
        (valid, [name, value]) => {
          const encode = () => encodeAnchor({ ...valid, [name]: value });
          expect(encode).toThrow(RangeError);
          expect(encode).toThrow(`${name} ${value}`);
        }
      )
    );
  });

  it('decodes a number iff it is an integer anchor on a page from 1 to MAX_ANCHOR_PAGE', () => {
    fc.assert(
      fc.property(anyNumberArb, (n) => {
        const valid = Number.isInteger(n) && n >= 1e10 && n <= MAX_ANCHOR;
        if (valid) {
          expect(encodeAnchor(decodeAnchor(n))).toBe(n);
        } else {
          expect(() => decodeAnchor(n)).toThrow(RangeError);
          expect(() => decodeAnchor(n)).toThrow(String(n));
        }
      })
    );
  });
});

describe('anchorFromDomPoint', () => {
  it('maps a point inside an item span to that item and its UTF-16 offset', () => {
    fc.assert(
      fc.property(viewersArb, edgeArb, (viewers, edge) => {
        const { points } = buildViewers(viewers);
        for (const { node, offset, pageEl, inside } of points) {
          if (!inside) continue;
          expect(anchorFromDomPoint(pageEl!, node, offset, edge)).toBe(
            insideAnchor(inside)
          );
        }
      }),
      DOM_RUNS
    );
  });

  it('snaps a start outside any item forward and an end backward, within its page', () => {
    fc.assert(
      fc.property(viewersArb, edgeArb, (viewers, edge) => {
        const { items, points } = buildViewers(viewers);
        for (const { node, offset, pageEl, inside, started } of points) {
          const onPage = items.filter((item) => item.pageEl === pageEl);
          if (inside || pageEl === null || onPage.length === 0) continue;
          const before = onPage.filter((item) => item.seq < started);
          const after = onPage.filter((item) => item.seq >= started);
          // With nothing to snap to in its direction, the point clamps to the
          // page's text instead.
          const expected =
            edge === 'start'
              ? after.length > 0
                ? itemStart(after[0])
                : itemEnd(onPage[onPage.length - 1])
              : before.length > 0
                ? itemEnd(before[before.length - 1])
                : itemStart(onPage[0]);
          expect(anchorFromDomPoint(pageEl, node, offset, edge)).toBe(expected);
        }
      }),
      DOM_RUNS
    );
  });

  it('maps no point off its page, nor any point on a page without text', () => {
    fc.assert(
      fc.property(viewersArb, edgeArb, (viewers, edge) => {
        const { pageEls, items, points } = buildViewers(viewers);
        for (const pageEl of pageEls) {
          const hasText = items.some((item) => item.pageEl === pageEl);
          for (const { node, offset, pageEl: on } of points) {
            if (hasText && on === pageEl) continue;
            expect(anchorFromDomPoint(pageEl, node, offset, edge)).toBeNull();
          }
        }
      }),
      DOM_RUNS
    );
  });
});

describe('rangeToAnchors', () => {
  it('maps a range to the first character in the viewer and just past the last, snapping across pages, or null when it holds none', () => {
    fc.assert(
      fc.property(
        viewersArb,
        fc.nat(),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 10 }),
        (viewers, pick, pairs) => {
          const { viewerEls, items, points } = buildViewers(viewers);
          const viewer = pick % viewerEls.length;
          const ours = items.filter((item) => item.viewer === viewer);
          for (const pair of pairs) {
            const [from, to] = pair
              .map((n) => points[n % points.length])
              .sort((a, b) => points.indexOf(a) - points.indexOf(b));
            const range = document.createRange();
            range.setStart(from.node, from.offset);
            range.setEnd(to.node, to.offset);

            // The anchors are tight: a start at the very end of an item, like
            // an end at the very start of one, holds none of its text and
            // moves on to the next item (or back to the previous one). Items
            // of another viewer don't count.
            const fromOurs = from.inside?.item.viewer === viewer;
            const toOurs = to.inside?.item.viewer === viewer;
            const next = ours.find((item) => item.seq >= from.started);
            const prevLimit = to.inside ? to.started - 1 : to.started;
            const prev = ours.filter((item) => item.seq < prevLimit).pop();
            const start =
              fromOurs && from.inside!.char < from.inside!.item.length
                ? insideAnchor(from.inside!)
                : next
                  ? itemStart(next)
                  : Infinity;
            const end =
              toOurs && to.inside!.char > 0
                ? insideAnchor(to.inside!)
                : prev
                  ? itemEnd(prev)
                  : -Infinity;
            expect(rangeToAnchors(range, viewerEls[viewer])).toEqual(
              start < end ? { start, end } : null
            );
          }
        }
      ),
      DOM_RUNS
    );
  });

  it('maps a range holding no characters to null, even between two text nodes of one item', () => {
    fc.assert(
      fc.property(viewersArb, fc.nat(), (viewers, pick) => {
        const { viewerEls, points } = buildViewers(viewers);
        const viewerEl = viewerEls[pick % viewerEls.length];
        points.forEach((from, i) => {
          // The same point, then every later point at the same position in
          // the text: those follow it directly, across the item's text nodes
          // and wrapper spans, until the next character.
          for (let j = i; j < points.length; j++) {
            const to = points[j];
            if (
              j > i &&
              !(
                from.inside &&
                to.inside?.item === from.inside.item &&
                to.inside.char === from.inside.char
              )
            ) {
              break;
            }
            const range = document.createRange();
            range.setStart(from.node, from.offset);
            range.setEnd(to.node, to.offset);
            expect(rangeToAnchors(range, viewerEl)).toBeNull();
          }
        });
      }),
      DOM_RUNS
    );
  });
});

describe('text layers no anchor can hold', () => {
  /** One page holding one item, 'abc', with the given attributes. */
  function buildPage(pageNumber: string | null, idx: string) {
    const pageEl = document.body.appendChild(document.createElement('div'));
    if (pageNumber !== null) pageEl.dataset.pageNumber = pageNumber;
    const textLayer = pageEl.appendChild(document.createElement('div'));
    const span = textLayer.appendChild(document.createElement('span'));
    span.dataset.idx = idx;
    const text = span.appendChild(document.createTextNode('abc'));
    return { pageEl, textLayer, text };
  }

  it('throw a RangeError for a page number or idx outside what anchors hold', () => {
    const badPage = fc.constantFrom(
      '0',
      '-1',
      String(MAX_ANCHOR_PAGE + 1),
      '1.5',
      'x',
      ''
    );
    const badIdx = fc.constantFrom('-1', '100000', '1.5', 'x');
    fc.assert(
      fc.property(
        fc.oneof(
          badPage.map((page) => [page, '0'] as const),
          badIdx.map((idx) => ['1', idx] as const)
        ),
        fc.nat({ max: 3 }),
        fc.nat({ max: 3 }),
        edgeArb,
        ([page, idx], a, b, edge) => {
          document.body.replaceChildren();
          const { pageEl, textLayer, text } = buildPage(page, idx);
          const range = document.createRange();
          range.setStart(text, Math.min(a, b, 2));
          range.setEnd(text, Math.max(a, b, 1));
          expect(() => rangeToAnchors(range, pageEl)).toThrow(RangeError);
          // Inside the item, and snapping to it from outside.
          expect(() => anchorFromDomPoint(pageEl, text, a, edge)).toThrow(
            RangeError
          );
          expect(() => anchorFromDomPoint(pageEl, textLayer, 0, edge)).toThrow(
            RangeError
          );
        }
      )
    );
  });

  it('map nothing on a page div without a page number', () => {
    const { pageEl, textLayer, text } = buildPage(null, '0');
    const range = document.createRange();
    range.selectNodeContents(text);
    expect(anchorFromDomPoint(pageEl, text, 1, 'start')).toBeNull();
    expect(anchorFromDomPoint(pageEl, textLayer, 0, 'start')).toBeNull();
    expect(rangeToAnchors(range, pageEl)).toBeNull();
  });

  it('throw a RangeError for a text layer passed in place of its page div', () => {
    const { textLayer, text } = buildPage('1', '0');
    expect(() => anchorFromDomPoint(textLayer, text, 1, 'start')).toThrow(
      RangeError
    );
  });

  it('throw a RangeError for a position past 99,999 characters into an item', () => {
    const { pageEl, text } = buildPage('1', '0');
    text.data = 'a'.repeat(100_001);
    const range = document.createRange();
    range.setStart(text, 99_999);
    range.setEnd(text, 100_000);
    expect(anchorFromDomPoint(pageEl, text, 99_999, 'start')).toBe(
      encodeAnchor({ page: 1, idx: 0, char: 99_999 })
    );
    expect(() => anchorFromDomPoint(pageEl, text, 100_000, 'end')).toThrow(
      RangeError
    );
    expect(() => rangeToAnchors(range, pageEl)).toThrow(RangeError);
  });
});

describe('itemSpansOnPage', () => {
  /** How many characters an anchor can address in one item. */
  const SPAN = 1e5;

  /**
   * A page's items as its text layer lists them: unique idxs in any order,
   * long and short texts, and the odd idx no anchor can hold.
   */
  const itemsArb = fc.uniqueArray(
    fc.record({
      idx: fc.oneof(
        { weight: 6, arbitrary: fc.integer({ min: 0, max: 99_999 }) },
        { weight: 6, arbitrary: fc.nat({ max: 8 }) },
        {
          weight: 1,
          arbitrary: fc.constantFrom(-1, 100_000, 1.5, NaN, Infinity),
        }
      ),
      length: fc.oneof(
        { weight: 6, arbitrary: fc.nat({ max: 12 }) },
        { weight: 1, arbitrary: fc.integer({ min: 99_990, max: 200_000 }) }
      ),
    }),
    { selector: (item) => item.idx, maxLength: 6 }
  );

  /**
   * Anchors on, before and after `page`, landing in, around and between its
   * items, and now and then a number no anchor is.
   */
  const anchorNearArb = (page: number, items: PageItem[]) =>
    fc.oneof(
      {
        weight: 8,
        arbitrary: fc
          .record({
            page: fc.constantFrom(
              ...[page - 1, page, page, page + 1].filter(
                (p) => p >= 1 && p <= MAX_ANCHOR_PAGE
              )
            ),
            idx: fc.oneof(
              fc.constantFrom(
                ...items
                  .map((item) => item.idx)
                  .filter((idx) => Number.isInteger(idx) && idx >= 0)
                  .filter((idx) => idx < SPAN),
                0
              ),
              fc.integer({ min: 0, max: 99_999 })
            ),
            char: fc.oneof(
              fc.nat({ max: 14 }),
              fc.integer({ min: 99_985, max: 99_999 })
            ),
          })
          .map(encodeAnchor),
      },
      { weight: 1, arbitrary: anyNumberArb }
    );

  const caseArb = fc
    .record({
      page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
      items: itemsArb,
    })
    .chain(({ page, items }) =>
      fc.record({
        page: fc.constant(page),
        items: fc.constant(items),
        start: anchorNearArb(page, items),
        end: anchorNearArb(page, items),
      })
    );

  it("gives each item the run of characters whose anchors fall in the range, in the items' order, and nothing for an item with none or an idx no anchor holds", () => {
    fc.assert(
      fc.property(caseArb, ({ page, items, start, end }) => {
        const spans = itemSpansOnPage({ start, end }, page, items);

        const addressable = items.filter(
          ({ idx }) => Number.isInteger(idx) && idx >= 0 && idx < SPAN
        );
        // Whether the character at `char` of `item` starts inside the range
        const covered = (item: PageItem, char: number) => {
          const at = encodeAnchor({ page, idx: item.idx, char });
          return at >= start && at < end;
        };
        const expected = addressable.flatMap((item) => {
          // Characters past what an anchor can address are never covered
          const length = Math.min(item.length, SPAN);
          if (length === 0) return [];
          // The covered characters are one run, as anchors grow with `char`:
          // when there are any, the first at or after `start` is one of them
          const offset = start - encodeAnchor({ page, idx: item.idx, char: 0 });
          const first =
            offset > 0 ? Math.min(Math.ceil(offset), length - 1) : 0;
          if (!covered(item, first)) return [];
          let last = first;
          while (last + 1 < length && covered(item, last + 1)) last++;
          return [{ idx: item.idx, start: first, end: last + 1 }];
        });
        expect(spans).toEqual(expected);
      })
    );
  });
});
