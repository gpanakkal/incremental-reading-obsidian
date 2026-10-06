// @vitest-environment jsdom
import {
  charsRect,
  fakePdfLayout,
  type FakeRect,
  FakeResizeObserver,
} from '#/test/pdf-layout';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAnchor,
  ITEM_SELECTOR,
  MAX_ANCHOR_PAGE,
  type PageItem,
} from './pdf-anchor';
import {
  boxAround,
  createPdfHighlightLayer,
  drawPageHighlights,
  highlightAt,
  type HighlightRun,
  pageHighlightRuns,
  type PdfHighlight,
} from './pdf-highlights';

// #region HELPERS

/** How many characters an anchor can address in one item. */
const SPAN = 1e5;
/** How many anchors a page has. */
const PAGE_ANCHORS = SPAN * SPAN;

/** A page's items: unique idxs in any order, now and then one no anchor holds. */
const itemsArb = fc.uniqueArray(
  fc.record({
    idx: fc.oneof(
      { weight: 8, arbitrary: fc.nat({ max: 6 }) },
      { weight: 2, arbitrary: fc.integer({ min: 0, max: 99_999 }) },
      { weight: 1, arbitrary: fc.constantFrom(-1, 100_000, 2.5, NaN) }
    ),
    length: fc.oneof(
      { weight: 12, arbitrary: fc.nat({ max: 10 }) },
      { weight: 1, arbitrary: fc.integer({ min: 99_998, max: 100_002 }) }
    ),
  }),
  { selector: (item) => item.idx, maxLength: 5 }
);

/**
 * An anchor on, just before or just after `page`, mostly in its items, now
 * and then right at a page's first anchor, or a number no anchor is.
 */
const anchorNearArb = (page: number, items: PageItem[]) =>
  fc.oneof(
    {
      weight: 12,
      arbitrary: fc
        .record({
          page: fc.oneof(
            { weight: 6, arbitrary: fc.constant(page) },
            {
              weight: 1,
              arbitrary: fc.constantFrom(
                ...[page - 1, page + 1].filter(
                  (p) => p >= 1 && p <= MAX_ANCHOR_PAGE
                )
              ),
            }
          ),
          idx: fc.oneof(
            {
              weight: 6,
              arbitrary: fc.constantFrom(
                0,
                ...items
                  .map((item) => item.idx)
                  .filter(
                    (idx) => Number.isInteger(idx) && idx >= 0 && idx < SPAN
                  )
              ),
            },
            { weight: 1, arbitrary: fc.integer({ min: 0, max: 99_999 }) }
          ),
          char: fc.oneof(
            { weight: 6, arbitrary: fc.nat({ max: 11 }) },
            { weight: 1, arbitrary: fc.integer({ min: 99_997, max: 99_999 }) }
          ),
        })
        .map(encodeAnchor),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        page * PAGE_ANCHORS,
        (page + 1) * PAGE_ANCHORS
      ),
    },
    {
      weight: 1,
      arbitrary: fc.double({
        min: (page - 1) * PAGE_ANCHORS,
        max: (page + 2) * PAGE_ANCHORS,
      }),
    }
  );

/** A few anchors near `page`, for snippets to start and end at. */
const anchorPoolArb = (page: number, items: PageItem[]) =>
  fc.uniqueArray(anchorNearArb(page, items), { minLength: 1, maxLength: 5 });

/**
 * Snippets and cards as the database and card notes hold them: unique
 * references (a card's note is never a snippet's), and mostly a start before
 * the end, though a corrupt row may have them the other way round. Their ends
 * come from a few `anchors`, so they often start or end together, meet, nest
 * or leave gaps between them in one item.
 */
const highlightsFromArb = (anchors: number[]) =>
  fc.uniqueArray(
    fc
      .record({
        ref: fc.oneof(
          fc.constantFrom('A', 'B', 'C'),
          fc.string({ maxLength: 4 })
        ),
        a: fc.constantFrom(...anchors),
        b: fc.constantFrom(...anchors),
        ordered: fc.nat({ max: 5 }),
        kind: fc.constantFrom<PdfHighlight['kind']>('snippet', 'card'),
      })
      .map(({ ref, a, b, ordered, kind }) => ({
        ref,
        kind,
        start: ordered > 0 ? Math.min(a, b) : a,
        end: ordered > 0 ? Math.max(a, b) : b,
      })),
    { selector: (h) => h.ref, maxLength: 5 }
  );

const highlightsArb = (page: number, items: PageItem[]) =>
  anchorPoolArb(page, items).chain(highlightsFromArb);

const caseArb = fc
  .record({
    page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
    items: itemsArb,
  })
  .chain(({ page, items }) =>
    fc.record({
      page: fc.constant(page),
      items: fc.constant(items),
      highlights: highlightsArb(page, items),
    })
  );

/**
 * Stacking order: one that starts earlier goes under one that starts later,
 * a longer one under a shorter one, a snippet under a card over the very
 * same text, and otherwise the references decide.
 */
function outerFirst(a: PdfHighlight, b: PdfHighlight) {
  const inner = (h: PdfHighlight) => (h.kind === 'card' ? 1 : 0);
  return (
    a.start - b.start ||
    b.end - a.end ||
    inner(a) - inner(b) ||
    (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
  );
}

/**
 * What of each item each highlight covers, character by character: the
 * highlights bottom first, each in item order.
 */
function expectedRuns(
  highlights: readonly PdfHighlight[],
  page: number,
  items: readonly PageItem[]
): HighlightRun[] {
  return [...highlights].sort(outerFirst).flatMap(({ ref, kind, start, end }) =>
    items
      .filter(({ idx }) => Number.isInteger(idx) && idx >= 0 && idx < SPAN)
      .flatMap(({ idx, length }) => {
        let from = -1;
        let to = -1;
        for (let char = 0; char < Math.min(length, SPAN); char++) {
          const at = encodeAnchor({ page, idx, char });
          if (start <= at && at < end) {
            if (from < 0) from = char;
            to = char + 1;
          }
        }
        return from < 0 ? [] : [{ idx, start: from, end: to, ref, kind }];
      })
  );
}

/** One text item as Obsidian's patched pdf.js renders it, and what has been done to it. */
interface ItemModel {
  str: string;
  /** Where its text is split into separate text nodes. */
  cuts: number[];
  /** Per piece: wrapped in a span of Obsidian's own subpath highlight. */
  wraps: boolean[];
  /** Inside a `span.markedContent`. */
  marked: boolean;
  /** pdf.js find overwrote its class, dropping `textLayerNode`. */
  findMiddle: boolean;
}

const itemModelArb: fc.Arbitrary<ItemModel> = fc.record({
  // Empty strings are common in real PDFs, and get no span; astral
  // characters are two UTF-16 units, so runs can split them.
  str: fc.oneof(fc.constant(''), fc.string({ unit: 'binary', maxLength: 6 })),
  cuts: fc.array(fc.nat({ max: 6 }), { maxLength: 3 }),
  wraps: fc.array(fc.boolean(), { maxLength: 4 }),
  marked: fc.boolean(),
  findMiddle: fc.boolean(),
});

const plain = (str: string, marked = false): ItemModel => ({
  str,
  cuts: [],
  wraps: [],
  marked,
  findMiddle: false,
});

/**
 * Splits `str` at `cuts` into pieces, some empty, anywhere: Obsidian's
 * highlight leaves empty text nodes where a selection starts or ends.
 */
function pieces(str: string, cuts: number[]) {
  const at = cuts.map((cut) => Math.min(cut, str.length)).sort((a, b) => a - b);
  const out: string[] = [];
  let from = 0;
  for (const cut of [...at, str.length]) {
    out.push(str.slice(from, cut));
    from = cut;
  }
  return out;
}

type BuiltItem = PageItem & { el: HTMLElement; str: string };

/**
 * A page div holding a canvas wrapper with a canvas in it, and a text layer
 * of `models`, numbered from `firstIdx`; and the items as the model has them:
 * the DOM is never read back for them.
 */
function buildPage(page: number, firstIdx: number, models: ItemModel[]) {
  const pageEl = document.body.appendChild(document.createElement('div'));
  pageEl.className = 'page';
  pageEl.dataset.pageNumber = String(page);
  const wrapper = pageEl.appendChild(document.createElement('div'));
  wrapper.className = 'canvasWrapper';
  wrapper.appendChild(document.createElement('canvas'));
  const textLayer = pageEl.appendChild(document.createElement('div'));
  textLayer.className = 'textLayer';
  textLayer.setAttribute('data-main-rotation', '0');
  const items: BuiltItem[] = [];
  models.forEach((model, i) => {
    const idx = firstIdx + i;
    if (model.str === '') return;
    let parent: HTMLElement = textLayer;
    if (model.marked) {
      parent = textLayer.appendChild(document.createElement('span'));
      parent.className = 'markedContent';
    }
    const span = parent.appendChild(document.createElement('span'));
    span.className = model.findMiddle
      ? 'highlight middle selected'
      : 'textLayerNode';
    span.dataset.idx = String(idx);
    pieces(model.str, model.cuts).forEach((piece, j) => {
      const text = document.createTextNode(piece);
      if (model.wraps[j]) {
        const wrap = span.appendChild(document.createElement('span'));
        wrap.className = 'mod-focused selected appended';
        wrap.appendChild(text);
      } else {
        span.appendChild(text);
      }
    });
    items.push({ idx, length: model.str.length, el: span, str: model.str });
    textLayer
      .appendChild(document.createElement('br'))
      .setAttribute('role', 'presentation');
  });
  textLayer.appendChild(document.createElement('div')).className =
    'endOfContent';
  return { pageEl, wrapper, textLayer, items };
}

/** Where the overlay of every page is on screen, unless a test moves it. */
const FRAME: FakeRect = { left: 5, top: 3, width: 700, height: 1300 };

/** A frame on screen, with an area. */
const frameArb = fc.record({
  left: fc.integer({ min: -500, max: 500 }),
  top: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: 1, max: 3000 }),
  height: fc.integer({ min: 1, max: 3000 }),
});

/**
 * The boxes on `pageEl`, as their run and where they are in percent of the
 * page, in DOM order.
 */
const boxesOn = (pageEl: Element) =>
  Array.from(
    pageEl.querySelectorAll<HTMLElement>(
      '.canvasWrapper > .ir-pdf-highlights > .ir-snippet-highlight'
    ),
    (box) => ({
      run: {
        idx: Number(box.dataset.item),
        start: Number(box.dataset.start),
        end: Number(box.dataset.end),
        ref: box.dataset.snippetRef,
        kind: box.classList.contains('ir-card-highlight') ? 'card' : 'snippet',
      },
      box: [
        box.style.left,
        box.style.top,
        box.style.width,
        box.style.height,
      ].map((value) => {
        expect(value).toMatch(/%$/);
        return Number.parseFloat(value);
      }),
    })
  );

/** The box `run` takes on a page whose overlay is at `frame`. */
function expectedBox(run: HighlightRun, frame: FakeRect) {
  const chars = charsRect(run.idx, run.start, run.end);
  return [
    ((chars.left - frame.left) / frame.width) * 100,
    ((chars.top - frame.top) / frame.height) * 100,
    (chars.width / frame.width) * 100,
    (chars.height / frame.height) * 100,
  ];
}

function expectBoxes(pageEl: Element, runs: HighlightRun[], frame: FakeRect) {
  const boxes = boxesOn(pageEl);
  expect(boxes.map(({ run }) => run)).toEqual(runs);
  boxes.forEach(({ box }, i) =>
    box.forEach((value, j) =>
      expect(value).toBeCloseTo(expectedBox(runs[i], frame)[j], 6)
    )
  );
}

/** The `idx` and length of each item that has text. */
const itemsOf = (built: BuiltItem[]) =>
  built.map(({ idx, length }) => ({ idx, length }));

// #endregion

let layout: ReturnType<typeof fakePdfLayout>;
let frame: FakeRect;

beforeEach(() => {
  frame = FRAME;
  layout = fakePdfLayout(() => frame);
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  layout.restore();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pageHighlightRuns', () => {
  it("gives each highlight's characters of each item on the page as one run, the highlights bottom of the stack first, each in item order", () => {
    fc.assert(
      fc.property(caseArb, ({ page, items, highlights }) => {
        expect(pageHighlightRuns(highlights, page, items)).toEqual(
          expectedRuns(highlights, page, items)
        );
      }),
      { numRuns: 300 }
    );
  });

  it('leaves the highlights it is given as they were', () => {
    fc.assert(
      fc.property(caseArb, ({ page, items, highlights }) => {
        const before = JSON.stringify(highlights);
        pageHighlightRuns(highlights, page, items);
        expect(JSON.stringify(highlights)).toBe(before);
      })
    );
  });
});

describe('boxAround', () => {
  /** A rect's size: mostly some, now and then none or less. */
  const sizeArb = fc.oneof(
    { weight: 4, arbitrary: fc.double({ min: 1e-3, max: 1e3, noNaN: true }) },
    { weight: 1, arbitrary: fc.constantFrom(0, -0, -1, Number.MIN_VALUE) },
    { weight: 1, arbitrary: fc.double({ min: -100, max: 0, noNaN: true }) }
  );
  const rectArb = fc.record({
    left: fc.double({ min: -1e4, max: 1e4, noNaN: true }),
    top: fc.double({ min: -1e4, max: 1e4, noNaN: true }),
    width: sizeArb,
    height: sizeArb,
  });
  const someFrameArb = fc.oneof(
    frameArb,
    fc.record({
      left: fc.integer(),
      top: fc.integer(),
      width: fc.constantFrom(0, -5, 10),
      height: fc.constantFrom(0, -5, 10),
    })
  );

  it('is the tightest box around every rect with an area, in percent of the frame, or nothing when no rect has one or the frame has none', () => {
    fc.assert(
      fc.property(
        fc.array(rectArb, { maxLength: 5 }),
        someFrameArb,
        (rects, frame) => {
          const box = boxAround(rects, frame);
          const solid = rects.filter((r) => r.width > 0 && r.height > 0);
          if (solid.length === 0 || frame.width <= 0 || frame.height <= 0) {
            expect(box).toBeNull();
            return;
          }
          // Each rect's edges in percent of the frame: the box starts at
          // the least of them, exactly, and ends at the greatest
          const pct = (x: number, from: number, size: number) =>
            ((x - from) / size) * 100;
          const across = (r: (typeof solid)[number]) => [
            pct(r.left, frame.left, frame.width),
            pct(r.left + r.width, frame.left, frame.width),
          ];
          const down = (r: (typeof solid)[number]) => [
            pct(r.top, frame.top, frame.height),
            pct(r.top + r.height, frame.top, frame.height),
          ];
          const close = (a: number, b: number) =>
            Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
          for (const [edges, start, size] of [
            [solid.map(across), box!.left, box!.width],
            [solid.map(down), box!.top, box!.height],
          ] as const) {
            expect(start).toBe(Math.min(...edges.map(([from]) => from)));
            expect(
              close(start + size, Math.max(...edges.map(([, to]) => to)))
            ).toBe(true);
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});

describe('drawPageHighlights', () => {
  /** A page of items, and two sets of highlights: drawn before, and now. */
  const drawCaseArb = fc
    .record({
      page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
      firstIdx: fc.oneof(fc.constant(0), fc.nat({ max: 99_990 })),
      models: fc.array(itemModelArb, { maxLength: 6 }),
      frame: frameArb,
    })
    .chain(({ page, firstIdx, models, frame }) => {
      const items = models.map((model, i) => ({
        idx: firstIdx + i,
        length: model.str.length,
      }));
      return anchorPoolArb(page, items).chain((anchors) =>
        fc.record({
          page: fc.constant(page),
          firstIdx: fc.constant(firstIdx),
          models: fc.constant(models),
          frame: fc.constant(frame),
          before: highlightsFromArb(anchors),
          after: highlightsFromArb(anchors),
        })
      );
    });

  it("boxes exactly the characters each highlight covers, over whatever the page's items hold, bottom of the stack first, in percent of the page, a card's as a card's", () => {
    fc.assert(
      fc.property(
        drawCaseArb,
        ({ page, firstIdx, models, frame: at, before, after }) => {
          frame = at;
          const { pageEl, items } = buildPage(page, firstIdx, models);
          const text = pageEl.querySelector('.textLayer')!.innerHTML;

          expect(drawPageHighlights(pageEl, before)).toBe(true);
          layout.rangeRects.mockClear();
          expect(drawPageHighlights(pageEl, after)).toBe(true);
          // Only text there is measured: no empty range around a node's end
          for (const range of layout.rangeRects.mock.instances) {
            expect(range.collapsed).toBe(false);
          }

          const runs = expectedRuns(after, page, itemsOf(items));
          expectBoxes(pageEl, runs, at);
          // One overlay at most, after the page's canvas
          const overlays = pageEl.querySelectorAll('.ir-pdf-highlights');
          expect(overlays.length).toBeLessThanOrEqual(1);
          overlays.forEach((overlay) => {
            expect(overlay.previousElementSibling?.tagName).toBe('CANVAS');
            expect(overlay.getAttribute('aria-hidden')).toBe('true');
          });
          // Nothing in the text layer touched, and no box taken for an item
          expect(pageEl.querySelector('.textLayer')!.innerHTML).toBe(text);
          expect(pageEl.querySelectorAll(ITEM_SELECTOR)).toHaveLength(
            items.length
          );
          pageEl.remove();
        }
      ),
      { numRuns: 200 }
    );
  });

  /** How far from a page's edge a highlight ends: often right at it. */
  const gapArb = fc.oneof(fc.constant(0), fc.nat());

  it('takes the overlay off a page no highlight reaches, measuring nothing, even with its text layer hidden or gone', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: MAX_ANCHOR_PAGE - 1 }),
        fc.array(
          fc.record({
            ref: fc.string(),
            kind: fc.constantFrom<PdfHighlight['kind']>('snippet', 'card'),
            ends: fc.oneof(
              // Wholly before or after the page, meeting it at most
              fc
                .tuple(gapArb, gapArb)
                .map(([a, b]) => [
                  -Math.max(a, b),
                  -Math.min(a, b),
                  'before' as const,
                ]),
              fc
                .tuple(gapArb, gapArb)
                .map(([a, b]) => [
                  Math.min(a, b),
                  Math.max(a, b),
                  'after' as const,
                ])
            ),
          }),
          { maxLength: 4 }
        ),
        fc.constantFrom('shown', 'hidden', 'gone'),
        (page, specs, state) => {
          const { pageEl, textLayer } = buildPage(page, 0, [plain('Hello')]);
          drawPageHighlights(pageEl, [
            {
              ref: 'drawn',
              kind: 'snippet',
              start: encodeAnchor({ page, idx: 0, char: 0 }),
              end: encodeAnchor({ page, idx: 0, char: 3 }),
            },
          ]);
          expect(boxesOn(pageEl)).toHaveLength(1);
          const highlights = specs.map(({ ref, kind, ends: [a, b, side] }) => {
            const at =
              side === 'before'
                ? page * PAGE_ANCHORS
                : (page + 1) * PAGE_ANCHORS;
            return {
              ref,
              kind,
              start: at + (a as number),
              end: at + (b as number),
            };
          });
          if (state === 'hidden') textLayer.hidden = true;
          if (state === 'gone') textLayer.remove();
          layout.rangeRects.mockClear();
          layout.elementRect.mockClear();

          expect(drawPageHighlights(pageEl, highlights)).toBe(true);
          expect(pageEl.querySelector('.ir-pdf-highlights')).toBeNull();
          expect(layout.rangeRects).not.toHaveBeenCalled();
          expect(layout.elementRect).not.toHaveBeenCalled();
          pageEl.remove();
        }
      )
    );
  });

  /** "Hello" on page 1, with "ell" highlighted. */
  const ELL: PdfHighlight = {
    ref: 'ell',
    kind: 'snippet',
    start: encodeAnchor({ page: 1, idx: 0, char: 1 }),
    end: encodeAnchor({ page: 1, idx: 0, char: 4 }),
  };

  it('leaves the boxes as they were, and says so, while its text layer is hidden, missing or not laid out, or it has no canvas wrapper', () => {
    const unreadyStates = [
      'hidden',
      'no text layer',
      'no wrapper',
      'no width',
      'no height',
    ] as const;
    for (const unready of unreadyStates) {
      const { pageEl, textLayer, wrapper } = buildPage(1, 0, [plain('Hello')]);
      frame = FRAME;
      const drawn = { ...ELL, ref: 'drawn', end: ELL.start + 1 };
      drawPageHighlights(pageEl, [drawn]);
      const before = boxesOn(pageEl);
      if (unready === 'hidden') textLayer.hidden = true;
      if (unready === 'no text layer') textLayer.remove();
      if (unready === 'no wrapper') wrapper.remove();
      if (unready === 'no width') frame = { ...FRAME, width: 0 };
      if (unready === 'no height') frame = { ...FRAME, height: 0 };
      layout.rangeRects.mockClear();

      expect(drawPageHighlights(pageEl, [ELL]), unready).toBe(false);
      expect(boxesOn(pageEl), unready).toEqual(
        unready === 'no wrapper' ? [] : before
      );
      expect(layout.rangeRects).not.toHaveBeenCalled();
      pageEl.remove();
    }
  });

  it('keeps its overlay last in the wrapper as pdf.js prepends canvases, and puts it back in a wrapper made afresh', () => {
    const { pageEl, wrapper } = buildPage(1, 0, [plain('Hello')]);
    drawPageHighlights(pageEl, [ELL]);
    const overlay = pageEl.querySelector('.ir-pdf-highlights')!;
    // A redraw: a new canvas first, the old one removed after
    const canvas = wrapper.querySelector('canvas')!;
    wrapper.prepend(document.createElement('canvas'));
    canvas.remove();
    drawPageHighlights(pageEl, [ELL]);
    expect(Array.from(wrapper.children, (el) => el.tagName)).toEqual([
      'CANVAS',
      'DIV',
    ]);
    expect(wrapper.lastElementChild).toBe(overlay);

    // A page reset whole: a wrapper of its own, and our overlay gone with
    // the old one
    wrapper.remove();
    const fresh = pageEl.insertBefore(
      document.createElement('div'),
      pageEl.firstChild
    );
    fresh.className = 'canvasWrapper';
    fresh.appendChild(document.createElement('canvas'));
    expect(drawPageHighlights(pageEl, [ELL])).toBe(true);
    expect(fresh.lastElementChild!.className).toBe('ir-pdf-highlights');
    expectBoxes(
      pageEl,
      [{ idx: 0, start: 1, end: 4, ref: 'ell', kind: 'snippet' }],
      FRAME
    );
  });

  it('moves an overlay found elsewhere on the page into the wrapper', () => {
    const { pageEl, wrapper } = buildPage(1, 0, [plain('Hello')]);
    const stray = pageEl.appendChild(document.createElement('div'));
    stray.className = 'ir-pdf-highlights';
    drawPageHighlights(pageEl, [ELL]);
    expect(stray.parentElement).toBe(wrapper);
    expect(pageEl.querySelectorAll('.ir-pdf-highlights')).toHaveLength(1);
  });

  it('draws no box for a run the layout gives no area', () => {
    const { pageEl } = buildPage(1, 0, [plain('Hello')]);
    layout.rangeRects.mockReturnValue([]);
    expect(drawPageHighlights(pageEl, [ELL])).toBe(true);
    expect(pageEl.querySelector('.ir-pdf-highlights')!.children).toHaveLength(
      0
    );
  });
});

describe('highlightAt', () => {
  it('finds the topmost box the point is over, its left and top edges in it and its right and bottom out', () => {
    const boxArb = fc.record({
      left: fc.nat({ max: 90 }),
      top: fc.nat({ max: 90 }),
      width: fc.integer({ min: 1, max: 30 }),
      height: fc.integer({ min: 1, max: 30 }),
    });
    fc.assert(
      fc.property(
        fc.array(boxArb, { maxLength: 6 }),
        frameArb,
        fc.integer({ min: -1, max: 6 }),
        fc.constantFrom('left', 'top', 'right', 'bottom', 'middle', 'anywhere'),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (boxes, at, pick, edge, u, v) => {
          frame = at;
          const { pageEl, wrapper } = buildPage(1, 0, [plain('x')]);
          const overlay = wrapper.appendChild(document.createElement('div'));
          overlay.className = 'ir-pdf-highlights';
          const els = boxes.map((b) => {
            const el = overlay.appendChild(document.createElement('div'));
            el.className = 'ir-snippet-highlight';
            Object.assign(el.style, {
              left: `${b.left}%`,
              top: `${b.top}%`,
              width: `${b.width}%`,
              height: `${b.height}%`,
            });
            return el;
          });
          // Someone else's element of the class, outside any overlay
          pageEl.appendChild(document.createElement('div')).className =
            'ir-snippet-highlight';
          // As a browser lays the box out: its edges from its percentages
          const onScreen = (b: (typeof boxes)[number]) => {
            const left = at.left + (b.left / 100) * at.width;
            const top = at.top + (b.top / 100) * at.height;
            return {
              left,
              top,
              right: left + (b.width / 100) * at.width,
              bottom: top + (b.height / 100) * at.height,
            };
          };
          const target = boxes[pick] ? onScreen(boxes[pick]) : null;
          const x = !target
            ? at.left + u * at.width
            : edge === 'left'
              ? target.left
              : edge === 'right'
                ? target.right
                : target.left + u * (target.right - target.left);
          const y = !target
            ? at.top + v * at.height
            : edge === 'top'
              ? target.top
              : edge === 'bottom'
                ? target.bottom
                : target.top + v * (target.bottom - target.top);

          const expected =
            [...els].reverse().find((_, i) => {
              const r = onScreen(boxes[boxes.length - 1 - i]);
              return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
            }) ?? null;
          expect(highlightAt(pageEl, x, y)).toBe(expected);
          pageEl.remove();
        }
      )
    );
  });
});

describe('createPdfHighlightLayer', () => {
  /** Lets the layer's mutation observer run, and anything it queues. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A viewer with pages 1 and 2: "Hello world" on 1, "Second page" on 2. */
  function buildViewer() {
    const containerEl = document.body.appendChild(
      document.createElement('div')
    );
    const toolbar = containerEl.appendChild(document.createElement('div'));
    toolbar.className = 'pdf-toolbar';
    const sidebar = containerEl.appendChild(document.createElement('div'));
    sidebar.className = 'pdf-sidebar';
    const viewerEl = containerEl.appendChild(document.createElement('div'));
    viewerEl.className = 'pdfViewer';
    const pages = [
      buildPage(1, 0, [plain('Hello '), plain('world', true)]),
      buildPage(2, 0, [plain('Second page')]),
    ];
    for (const { pageEl } of pages) viewerEl.appendChild(pageEl);
    return { containerEl, toolbar, sidebar, viewerEl, pages };
  }

  /** "lo world" on page 1 through "Second" on page 2. */
  const ACROSS: PdfHighlight = {
    ref: 'Snippets/across.md',
    kind: 'snippet',
    start: encodeAnchor({ page: 1, idx: 0, char: 3 }),
    end: encodeAnchor({ page: 2, idx: 0, char: 6 }),
  };
  const ACROSS_PAGE1: HighlightRun[] = [
    { idx: 0, start: 3, end: 6, ref: ACROSS.ref, kind: 'snippet' },
    { idx: 1, start: 0, end: 5, ref: ACROSS.ref, kind: 'snippet' },
  ];
  const ACROSS_PAGE2: HighlightRun[] = [
    { idx: 0, start: 0, end: 6, ref: ACROSS.ref, kind: 'snippet' },
  ];

  /** Each page's boxes, as their runs. */
  const runsOn = (pages: { pageEl: Element }[]) =>
    pages.map(({ pageEl }) => boxesOn(pageEl).map(({ run }) => run));

  it('draws what it is given on every page there, at once', () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);

    expectBoxes(pages[0].pageEl, ACROSS_PAGE1, FRAME);
    expectBoxes(pages[1].pageEl, ACROSS_PAGE2, FRAME);
    layer.destroy();
  });

  it('draws a text layer rendered later, a page drawn afresh, a page put back whole, and a page turned', async () => {
    const { containerEl, viewerEl, pages } = buildViewer();
    const { textLayer } = pages[1];
    textLayer.remove();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    expect(runsOn(pages)).toEqual([ACROSS_PAGE1, []]);

    // pdf.js renders the page's text layer as the page comes near
    pages[1].pageEl.append(textLayer);
    await flush();
    expect(runsOn(pages)).toEqual([ACROSS_PAGE1, ACROSS_PAGE2]);

    // The page went far and came back: its wrapper and layer made afresh
    const fresh = buildPage(2, 0, [plain('Second page')]);
    pages[1].pageEl.replaceChildren(fresh.wrapper);
    await flush();
    expect(runsOn(pages)).toEqual([ACROSS_PAGE1, []]);
    pages[1].pageEl.append(fresh.textLayer);
    await flush();
    expect(runsOn(pages)).toEqual([ACROSS_PAGE1, ACROSS_PAGE2]);

    // A page div moved into a spread, overlay and all, after a layout that
    // moved its text
    frame = { ...FRAME, left: 50 };
    const spread = viewerEl.appendChild(document.createElement('div'));
    spread.className = 'spread';
    spread.append(pages[0].pageEl);
    await flush();
    expectBoxes(pages[0].pageEl, ACROSS_PAGE1, frame);

    // Turned: pdf.js sets the layer's rotation once it is redrawn
    frame = { ...FRAME, top: 70 };
    pages[0].textLayer.setAttribute('data-main-rotation', '90');
    await flush();
    expectBoxes(pages[0].pageEl, ACROSS_PAGE1, frame);
    layer.destroy();
  });

  it('measures nothing on a zoom, or for a change to the toolbar, the sidebar, an item or the end-of-content marker', async () => {
    const { containerEl, toolbar, sidebar, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    await flush();
    layout.rangeRects.mockClear();
    layout.elementRect.mockClear();
    const drawn = runsOn(pages);

    // A zoom: the scale changes, pdf.js hides each text layer, swaps in a
    // canvas drawn afresh, re-renders the annotation layer, and shows the
    // text layer again
    for (const { pageEl, wrapper, textLayer } of pages) {
      pageEl.style.setProperty('--scale-factor', '2');
      textLayer.hidden = true;
      // Set again on every zoom, to what it was
      textLayer.setAttribute('data-main-rotation', '0');
      const old = wrapper.querySelector('canvas')!;
      wrapper.prepend(document.createElement('canvas'));
      old.remove();
      const annotations = pageEl.appendChild(document.createElement('div'));
      annotations.className = 'annotationLayer';
      annotations.appendChild(document.createElement('section'));
      // Sized, and so turned, once it is on the page
      annotations.setAttribute('data-main-rotation', '0');
      await flush();
      textLayer.hidden = false;
    }
    // The toolbar and the sidebar's thumbnails, which carry page numbers too
    toolbar.appendChild(document.createElement('button'));
    const thumbnail = sidebar.appendChild(document.createElement('div'));
    thumbnail.className = 'thumbnail';
    thumbnail.dataset.pageNumber = '1';
    thumbnail.appendChild(document.createElement('img'));
    toolbar.textContent = 'zoom 200%';
    // Obsidian's subpath highlight rebuilding an item
    pages[0].items[1].el.textContent = 'world';
    // pdf.js moving its marker as a selection is made
    pages[0].textLayer.prepend(
      pages[0].textLayer.querySelector('.endOfContent')!
    );
    // A text node changing its text
    pages[0].items[0].el.firstChild!.textContent = 'Hello ';
    await flush();

    expect(layout.rangeRects).not.toHaveBeenCalled();
    expect(layout.elementRect).not.toHaveBeenCalled();
    expect(runsOn(pages)).toEqual(drawn);
    layer.destroy();
  });

  it('draws a page rendered anew inside its text layer, and only that page', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    // Its boxes taken off by someone, so a redraw shows
    pages[0].pageEl.querySelector('.ir-pdf-highlights')!.replaceChildren();
    pages[1].pageEl.querySelector('.ir-pdf-highlights')!.replaceChildren();

    const item = pages[0].textLayer.querySelector('[data-idx="0"]')!;
    item.after(document.createElement('br'));
    await flush();
    expect(runsOn(pages)).toEqual([ACROSS_PAGE1, []]);

    // Text, and the end-of-content marker with it, put in at once
    pages[0].pageEl.querySelector('.ir-pdf-highlights')!.replaceChildren();
    const marker = pages[1].textLayer.querySelector('.endOfContent')!;
    const fragment = document.createDocumentFragment();
    fragment.append('more', marker);
    pages[1].textLayer.append(fragment);
    await flush();
    expect(runsOn(pages)).toEqual([[], ACROSS_PAGE2]);
    layer.destroy();
  });

  it("waits for a hidden text layer to be shown, and a viewer off screen to be shown, to draw a page's highlights", async () => {
    const { containerEl, pages } = buildViewer();
    pages[0].textLayer.hidden = true;
    frame = { ...FRAME, width: 0 };
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    expect(runsOn(pages)).toEqual([[], []]);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    const [resizes] = FakeResizeObserver.instances;
    expect(resizes.observed).toEqual([containerEl]);

    // Shown, but still at no size: still waiting
    pages[0].textLayer.hidden = false;
    await flush();
    expect(runsOn(pages)).toEqual([[], []]);
    // The viewer laid out
    frame = FRAME;
    resizes.fire();
    expect(runsOn(pages)).toEqual([ACROSS_PAGE1, ACROSS_PAGE2]);

    // Nothing waiting: a resize measures nothing
    layout.elementRect.mockClear();
    resizes.fire();
    expect(layout.elementRect).not.toHaveBeenCalled();

    // A text layer shown again waits no more once drawn
    pages[1].textLayer.hidden = true;
    pages[1].textLayer.setAttribute('data-main-rotation', '90');
    await flush();
    layout.elementRect.mockClear();
    pages[1].textLayer.hidden = false;
    await flush();
    expect(layout.elementRect).toHaveBeenCalled();
    layout.elementRect.mockClear();
    pages[1].textLayer.hidden = true;
    pages[1].textLayer.hidden = false;
    await flush();
    expect(layout.elementRect).not.toHaveBeenCalled();
    layer.destroy();
  });

  it('forgets a page taken away while it waits', async () => {
    const { containerEl, pages } = buildViewer();
    pages[1].textLayer.hidden = true;
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    pages[1].pageEl.remove();
    await flush();
    const [resizes] = FakeResizeObserver.instances;
    resizes.fire();
    layout.elementRect.mockClear();
    pages[1].textLayer.hidden = false;
    resizes.fire();
    expect(layout.elementRect).not.toHaveBeenCalled();
    layer.destroy();
  });

  it('shows the latest set it is given, and takes every box off when destroyed, drawing nothing after', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    const other: PdfHighlight = {
      ref: 'Snippets/other.md',
      kind: 'card',
      start: encodeAnchor({ page: 2, idx: 0, char: 7 }),
      end: encodeAnchor({ page: 2, idx: 0, char: 11 }),
    };
    layer.set([other]);
    expect(runsOn(pages)).toEqual([
      [],
      [{ idx: 0, start: 7, end: 11, ref: other.ref, kind: 'card' }],
    ]);
    expect(pages[0].pageEl.querySelector('.ir-pdf-highlights')).toBeNull();

    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    layer.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(FakeResizeObserver.instances[0].observed).toEqual([]);
    expect(containerEl.querySelector('.ir-pdf-highlights')).toBeNull();
    pages[1].pageEl.append(pages[1].textLayer);
    await flush();
    expect(containerEl.querySelector('.ir-pdf-highlights')).toBeNull();
  });

  it("takes off a page's boxes when set to none, even while its text layer is hidden, and with none at all watches nothing", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([]);
    expect(observe).not.toHaveBeenCalled();
    expect(FakeResizeObserver.instances[0].observed).toEqual([]);

    layer.set([ACROSS]);
    layer.set([ACROSS]);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(containerEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'data-main-rotation'],
      attributeOldValue: true,
    });
    pages[0].textLayer.hidden = true;
    layer.set([]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(FakeResizeObserver.instances[0].observed).toEqual([]);
    expect(containerEl.querySelector('.ir-pdf-highlights')).toBeNull();
    layer.set([]);
    expect(disconnect).toHaveBeenCalledOnce();

    // A page's layer rendered with no highlights: nothing drawn, nothing run
    layout.elementRect.mockClear();
    pages[1].textLayer.remove();
    pages[1].pageEl.append(pages[1].textLayer);
    await flush();
    expect(layout.elementRect).not.toHaveBeenCalled();
    layer.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('lets be a text layer outside any page, and a canvas wrapper too', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    const drawn = runsOn(pages);
    layout.elementRect.mockClear();

    const stray = buildPage(1, 0, [plain('Hello')]);
    containerEl.append(stray.wrapper, stray.textLayer);
    await flush();
    stray.textLayer.setAttribute('data-main-rotation', '90');
    stray.textLayer.append(document.createElement('br'));
    await flush();

    expect(layout.elementRect).not.toHaveBeenCalled();
    expect(runsOn(pages)).toEqual(drawn);
    layer.destroy();
  });

  it('takes the boxes off a page pdf.js took out of the viewer, which may put it back as it is', () => {
    const { containerEl, viewerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    pages[1].pageEl.remove();

    layer.set([]);
    viewerEl.append(pages[1].pageEl);
    expect(runsOn(pages)).toEqual([[], []]);
    expect(containerEl.querySelector('.ir-pdf-highlights')).toBeNull();

    // And when destroyed
    layer.set([ACROSS]);
    pages[0].pageEl.remove();
    layer.destroy();
    expect(runsOn(pages)).toEqual([[], []]);
  });

  it('lets go of a page out of the viewer when shown other highlights, which may never come back, and draws it as it does', async () => {
    const { containerEl, viewerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    pages[1].pageEl.remove();
    // An overlay pdf.js took off with a wrapper of a page also out
    pages[0].pageEl.remove();
    pages[0].wrapper.remove();
    layout.rangeRects.mockClear();

    const other = { ...ACROSS, ref: 'Snippets/other.md' };
    layer.set([other]);
    expect(runsOn(pages)).toEqual([[], []]);
    expect(layout.rangeRects).not.toHaveBeenCalled();

    // Put back as it was
    viewerEl.append(pages[1].pageEl);
    await flush();
    expect(runsOn(pages)).toEqual([
      [],
      ACROSS_PAGE2.map((run) => ({ ...run, ref: other.ref })),
    ]);
    layer.destroy();
  });

  it('keeps the boxes of a page whose text pdf.js hides through a zoom when shown other highlights, until it shows it again', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    pages[0].textLayer.hidden = true;

    const other = { ...ACROSS, ref: 'Snippets/other.md' };
    layer.set([other]);
    expect(runsOn(pages)[0]).toEqual(ACROSS_PAGE1);
    pages[0].textLayer.hidden = false;
    await flush();
    expect(runsOn(pages)[0]).toEqual(
      ACROSS_PAGE1.map((run) => ({ ...run, ref: other.ref }))
    );
    layer.destroy();
  });

  it('leaves alone a page out of the viewer that shows nothing', () => {
    const { containerEl, viewerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    const ON_PAGE2: PdfHighlight = {
      ...ACROSS,
      start: encodeAnchor({ page: 2, idx: 0, char: 0 }),
    };
    layer.set([ON_PAGE2]);
    pages[0].pageEl.remove();
    layer.set([ACROSS]);
    expect(pages[0].pageEl.querySelector('.ir-pdf-highlights')).toBeNull();
    viewerEl.prepend(pages[0].pageEl);
    layer.destroy();
  });

  it('tells its watcher whether it has boxes, and to look again whenever boxes are drawn or moved, and only then', async () => {
    const { containerEl, toolbar, pages } = buildViewer();
    const watcher = {
      enable: vi.fn<(on: boolean) => void>(),
      refresh: vi.fn<() => void>(),
    };
    const calls = () => {
      const made = {
        enable: watcher.enable.mock.calls.map(([on]) => on),
        refresh: watcher.refresh.mock.calls.length,
      };
      watcher.enable.mockClear();
      watcher.refresh.mockClear();
      return made;
    };
    const layer = createPdfHighlightLayer(containerEl, watcher);
    const [resizes] = FakeResizeObserver.instances;
    layer.set([]);
    expect(calls()).toEqual({ enable: [], refresh: 1 });

    layer.set([ACROSS]);
    expect(calls()).toEqual({ enable: [true], refresh: 1 });
    layer.set([{ ...ACROSS, ref: 'Snippets/other.md' }]);
    expect(calls()).toEqual({ enable: [], refresh: 1 });

    // A zoom: pdf.js hides each text layer, sets its rotation again, and
    // shows it once redrawn
    pages[0].textLayer.hidden = true;
    pages[0].textLayer.setAttribute('data-main-rotation', '0');
    await flush();
    expect(calls()).toEqual({ enable: [], refresh: 1 });
    pages[0].textLayer.hidden = false;
    await flush();
    expect(calls()).toEqual({ enable: [], refresh: 1 });

    // Nothing drawn, nothing moved: the toolbar, another layer hidden, a
    // rotation set to what it was
    toolbar.appendChild(document.createElement('button'));
    const annotations = pages[1].pageEl.appendChild(
      document.createElement('div')
    );
    annotations.className = 'annotationLayer';
    await flush();
    annotations.hidden = true;
    pages[1].textLayer.setAttribute('data-main-rotation', '0');
    await flush();
    expect(calls()).toEqual({ enable: [], refresh: 0 });

    // A page turned while the viewer has no size waits, drawn on nothing,
    // and is drawn once rendered afresh with a size
    frame = { ...FRAME, width: 0 };
    pages[1].textLayer.setAttribute('data-main-rotation', '90');
    await flush();
    expect(calls()).toEqual({ enable: [], refresh: 0 });
    frame = FRAME;
    pages[1].pageEl.append(pages[1].textLayer);
    await flush();
    expect(runsOn(pages)[1]).toEqual(
      ACROSS_PAGE2.map((run) => ({ ...run, ref: 'Snippets/other.md' }))
    );
    expect(calls()).toEqual({ enable: [], refresh: 1 });
    // Any resize may move the pages
    resizes.fire();
    expect(calls()).toEqual({ enable: [], refresh: 1 });

    layer.set([]);
    expect(calls()).toEqual({ enable: [false], refresh: 1 });
    layer.set([ACROSS]);
    layer.destroy();
    expect(calls()).toEqual({ enable: [true, false], refresh: 2 });
  });

  it('draws without a ResizeObserver, where there is none', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    expect(runsOn(pages)).toEqual([ACROSS_PAGE1, ACROSS_PAGE2]);
    layer.set([]);
    layer.destroy();
    expect(containerEl.querySelector('.ir-pdf-highlights')).toBeNull();
  });
});
