// @vitest-environment jsdom
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAnchor, MAX_ANCHOR_PAGE, type PageItem } from './pdf-anchor';
import {
  createPdfHighlightLayer,
  type HighlightSegment,
  highlightSegments,
  paintPageHighlights,
  type PdfHighlight,
} from './pdf-highlights';

// #region HELPERS

/** How many characters an anchor can address in one item. */
const SPAN = 1e5;

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

/** An anchor on, just before or just after `page`, mostly in its items. */
const anchorNearArb = (page: number, items: PageItem[]) =>
  fc
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
              .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < SPAN)
          ),
        },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 99_999 }) }
      ),
      char: fc.oneof(
        { weight: 6, arbitrary: fc.nat({ max: 11 }) },
        { weight: 1, arbitrary: fc.integer({ min: 99_997, max: 99_999 }) }
      ),
    })
    .map(encodeAnchor);

/** A few anchors near `page`, for snippets to start and end at. */
const anchorPoolArb = (page: number, items: PageItem[]) =>
  fc.uniqueArray(anchorNearArb(page, items), { minLength: 1, maxLength: 5 });

/**
 * Snippets as the database holds them: unique references, and mostly a start
 * before the end, though a corrupt row may have them the other way round.
 * Their ends come from a few `anchors`, so snippets often start or end
 * together, meet, nest or leave gaps between them in one item.
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
      })
      .map(({ ref, a, b, ordered }) => ({
        ref,
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
 * Nesting order: one that starts earlier wraps one that starts later, a
 * longer one a shorter one, and otherwise the references decide.
 */
function outerFirst(a: PdfHighlight, b: PdfHighlight) {
  return (
    a.start - b.start ||
    b.end - a.end ||
    (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
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
 * A page div holding a text layer of `models`, numbered from `firstIdx`, and
 * the items as the model has them: the DOM is never read back for them.
 */
function buildPage(page: number, firstIdx: number, models: ItemModel[]) {
  const pageEl = document.body.appendChild(document.createElement('div'));
  pageEl.className = 'page';
  pageEl.dataset.pageNumber = String(page);
  pageEl.appendChild(document.createElement('div')).className = 'canvasWrapper';
  const textLayer = pageEl.appendChild(document.createElement('div'));
  textLayer.className = 'textLayer';
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
  return { pageEl, textLayer, items };
}

/** The runs each item's highlight spans mark, read off the DOM. */
function readSegments(items: { idx: number; el: HTMLElement }[]) {
  return items.flatMap(({ idx, el }) => {
    const runs: HighlightSegment[] = [];
    let offset = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const { length } = node as Text;
      const refs: string[] = [];
      for (
        let up = node.parentElement;
        up && up !== el;
        up = up.parentElement
      ) {
        if (up.classList.contains('ir-snippet-highlight')) {
          refs.unshift(up.getAttribute('data-snippet-ref')!);
        }
      }
      const last = runs[runs.length - 1];
      if (
        last &&
        last.end === offset &&
        JSON.stringify(last.refs) === JSON.stringify(refs)
      ) {
        last.end += length;
      } else if (refs.length > 0 && length > 0) {
        runs.push({ idx, start: offset, end: offset + length, refs });
      }
      offset += length;
    }
    return runs;
  });
}

/** A page of items, and two sets of snippets: the ones painted before, and now. */
const paintCaseArb = fc
  .record({
    page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
    firstIdx: fc.oneof(fc.constant(0), fc.nat({ max: 99_990 })),
    models: fc.array(itemModelArb, { maxLength: 6 }),
  })
  .chain(({ page, firstIdx, models }) => {
    const items = models.map((model, i) => ({
      idx: firstIdx + i,
      length: model.str.length,
    }));
    // Both sets from one pool of anchors, so a run painted before may now
    // end elsewhere, or be another snippet's
    return anchorPoolArb(page, items).chain((anchors) =>
      fc.record({
        page: fc.constant(page),
        firstIdx: fc.constant(firstIdx),
        models: fc.constant(models),
        before: highlightsFromArb(anchors),
        after: highlightsFromArb(anchors),
      })
    );
  });

/** Records every DOM change under `root` until the returned function is called. */
function watch(root: Node) {
  const observer = new MutationObserver(() => {});
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  return () => {
    const records = observer.takeRecords();
    observer.disconnect();
    return records;
  };
}

/** How many empty text nodes `root` holds. */
function emptyTextNodes(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).length === 0) count++;
  }
  return count;
}

/** The segments of `idx` alone, to compare one item's runs. */
function segmentsOf(segments: HighlightSegment[], idx: number) {
  return JSON.stringify(segments.filter((segment) => segment.idx === idx));
}

// #endregion

describe('highlightSegments', () => {
  it('splits each item into the runs a fixed set of snippets covers, listing them outermost first, in item order', () => {
    fc.assert(
      fc.property(caseArb, ({ page, items, highlights }) => {
        const segments = highlightSegments(highlights, page, items);

        const nested = [...highlights].sort(outerFirst);
        const expected = items
          .filter(({ idx }) => Number.isInteger(idx) && idx >= 0 && idx < SPAN)
          .flatMap(({ idx, length }) => {
            const runs: {
              idx: number;
              start: number;
              end: number;
              refs: string[];
            }[] = [];
            for (let char = 0; char < Math.min(length, SPAN); char++) {
              const at = encodeAnchor({ page, idx, char });
              const refs = nested
                .filter((h) => h.start <= at && at < h.end)
                .map((h) => h.ref);
              const last = runs[runs.length - 1];
              if (
                last &&
                last.end === char &&
                JSON.stringify(last.refs) === JSON.stringify(refs)
              ) {
                last.end++;
              } else if (refs.length > 0) {
                runs.push({ idx, start: char, end: char + 1, refs });
              }
            }
            return runs;
          });
        expect(segments).toEqual(expected);
      }),
      { numRuns: 300 }
    );
  });
});

describe('paintPageHighlights', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("marks exactly the runs the snippets cover, nested outermost first, over whatever the page's spans already hold, leaving its text and other spans as they were", () => {
    fc.assert(
      fc.property(paintCaseArb, ({ page, firstIdx, models, before, after }) => {
        document.body.replaceChildren();
        const { pageEl, items } = buildPage(page, firstIdx, models);
        const own = Array.from(pageEl.querySelectorAll('*'));

        const empties = emptyTextNodes(pageEl);

        paintPageHighlights(pageEl, before);
        paintPageHighlights(pageEl, after);

        // Text split where runs start and end, and nowhere else
        expect(emptyTextNodes(pageEl)).toBeLessThanOrEqual(empties);
        expect(readSegments(items)).toEqual(
          highlightSegments(after, page, items)
        );
        for (const { el, str } of items) expect(el.textContent).toBe(str);
        // Nothing of the page's own went anywhere
        for (const el of own) expect(pageEl.contains(el)).toBe(true);
        for (const wrapper of pageEl.querySelectorAll(
          '.ir-snippet-highlight'
        )) {
          expect(wrapper.tagName).toBe('SPAN');
          expect(wrapper.textContent).not.toBe('');
          expect(wrapper.closest('[data-idx]')).not.toBeNull();
        }
      })
    );
  });

  it('leaves alone every item whose runs are already marked, so a selection in it survives', () => {
    fc.assert(
      fc.property(paintCaseArb, ({ page, firstIdx, models, before, after }) => {
        document.body.replaceChildren();
        const { pageEl, items } = buildPage(page, firstIdx, models);
        paintPageHighlights(pageEl, before);
        const was = highlightSegments(before, page, items);
        const now = highlightSegments(after, page, items);
        const unchanged = items.filter(
          ({ idx }) => segmentsOf(was, idx) === segmentsOf(now, idx)
        );

        const changes = watch(pageEl);
        paintPageHighlights(pageEl, after);
        const records = changes();

        for (const { el } of unchanged) {
          expect(records.filter((r) => el.contains(r.target))).toEqual([]);
        }
        // Painting what is already there changes nothing at all
        const again = watch(pageEl);
        paintPageHighlights(pageEl, after);
        expect(again()).toEqual([]);
      })
    );
  });
});

describe('highlightSegments and paintPageHighlights, on cases too rare to draw', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  /** Characters `from` to `to` of page 1's item 0, as snippet `ref`. */
  const chars = (ref: string, from: number, to: number): PdfHighlight => ({
    ref,
    start: encodeAnchor({ page: 1, idx: 0, char: from }),
    end: encodeAnchor({ page: 1, idx: 0, char: to }),
  });

  /** Page 1, its item 0 "Hello world" split after "Hello" by Obsidian's highlight. */
  const helloWorld = () =>
    buildPage(1, 0, [
      {
        str: 'Hello world',
        cuts: [5],
        wraps: [true, false],
        marked: false,
        findMiddle: false,
      },
    ]);

  it('leaves the characters between two snippets in one item unmarked', () => {
    expect(
      highlightSegments([chars('A', 1, 3), chars('B', 5, 7)], 1, [
        { idx: 0, length: 10 },
      ])
    ).toEqual([
      { idx: 0, start: 1, end: 3, refs: ['A'] },
      { idx: 0, start: 5, end: 7, refs: ['B'] },
    ]);
  });

  it('marks a run afresh when only its end moves', () => {
    const { pageEl, items } = helloWorld();
    paintPageHighlights(pageEl, [chars('A', 0, 5)]);
    paintPageHighlights(pageEl, [chars('A', 0, 7)]);
    expect(readSegments(items)).toEqual([
      { idx: 0, start: 0, end: 7, refs: ['A'] },
    ]);
  });

  it('marks a run afresh when only its start moves', () => {
    const { pageEl, items } = helloWorld();
    paintPageHighlights(pageEl, [chars('A', 0, 7)]);
    paintPageHighlights(pageEl, [chars('A', 2, 7)]);
    expect(readSegments(items)).toEqual([
      { idx: 0, start: 2, end: 7, refs: ['A'] },
    ]);
  });

  it('marks a run afresh when only an inner snippet over it changes', () => {
    const { pageEl, items } = helloWorld();
    paintPageHighlights(pageEl, [chars('A', 0, 11), chars('B', 2, 4)]);
    paintPageHighlights(pageEl, [chars('A', 0, 11), chars('C', 2, 4)]);
    expect(readSegments(items)).toEqual([
      { idx: 0, start: 0, end: 2, refs: ['A'] },
      { idx: 0, start: 2, end: 4, refs: ['A', 'C'] },
      { idx: 0, start: 4, end: 11, refs: ['A'] },
    ]);
  });

  it('changes nothing when painting nested snippets already there', () => {
    const { pageEl } = helloWorld();
    const nested = [chars('A', 0, 11), chars('B', 6, 8)];
    paintPageHighlights(pageEl, nested);
    const changes = watch(pageEl);
    paintPageHighlights(pageEl, nested);
    expect(changes()).toEqual([]);
  });

  it('wraps nothing past a run that ends where a text node starts', () => {
    const { pageEl } = helloWorld();
    paintPageHighlights(pageEl, [chars('A', 0, 5)]);
    const wrappers = pageEl.querySelectorAll('.ir-snippet-highlight');
    expect(Array.from(wrappers, (w) => w.textContent)).toEqual(['Hello']);
  });
});

describe('createPdfHighlightLayer', () => {
  /** Lets the layer's mutation observer run, and anything it queues. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const plain = (str: string, marked = false): ItemModel => ({
    str,
    cuts: [],
    wraps: [],
    marked,
    findMiddle: false,
  });

  /** A viewer with pages 1 and 2: "Hello world" on 1, "Second page" on 2. */
  function buildViewer() {
    const containerEl = document.body.appendChild(
      document.createElement('div')
    );
    const viewerEl = containerEl.appendChild(document.createElement('div'));
    const pages = [
      buildPage(1, 0, [plain('Hello '), plain('world', true)]),
      buildPage(2, 0, [plain('Second page')]),
    ];
    for (const { pageEl } of pages) viewerEl.appendChild(pageEl);
    return { containerEl, viewerEl, pages };
  }

  /** "lo world" on page 1 through "Second" on page 2. */
  const ACROSS: PdfHighlight = {
    ref: 'Snippets/across.md',
    start: encodeAnchor({ page: 1, idx: 0, char: 3 }),
    end: encodeAnchor({ page: 2, idx: 0, char: 6 }),
  };

  const marked = (el: Element) =>
    Array.from(el.querySelectorAll('.ir-snippet-highlight'), (span) => [
      span.getAttribute('data-snippet-ref'),
      span.textContent,
    ]);

  afterEach(() => {
    document.body.replaceChildren();
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it('marks what it is given on every page there, partial items included', () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);

    expect(marked(pages[0].pageEl)).toEqual([
      [ACROSS.ref, 'lo '],
      [ACROSS.ref, 'world'],
    ]);
    expect(marked(pages[1].pageEl)).toEqual([[ACROSS.ref, 'Second']]);
    layer.destroy();
  });

  it('marks a text layer rendered later, an item whose content another highlighter rebuilt, and a page built afresh', async () => {
    const { containerEl, viewerEl, pages } = buildViewer();
    const { textLayer } = pages[1];
    textLayer.remove();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    expect(marked(pages[1].pageEl)).toEqual([]);

    // pdf.js renders the page's text layer as the page comes near
    pages[1].pageEl.append(textLayer);
    await flush();
    expect(marked(pages[1].pageEl)).toEqual([[ACROSS.ref, 'Second']]);

    // Obsidian's clearTextHighlight resets the item's text
    pages[0].items[1].el.textContent = 'world';
    await flush();
    expect(marked(pages[0].pageEl)).toEqual([
      [ACROSS.ref, 'lo '],
      [ACROSS.ref, 'world'],
    ]);

    // A page div replaced whole
    const rebuilt = buildPage(1, 0, [plain('Hello '), plain('world')]);
    pages[0].pageEl.replaceWith(rebuilt.pageEl);
    await flush();
    expect(viewerEl.contains(rebuilt.pageEl)).toBe(true);
    expect(marked(rebuilt.pageEl)).toEqual([
      [ACROSS.ref, 'lo '],
      [ACROSS.ref, 'world'],
    ]);
    layer.destroy();
  });

  it('settles once painted: its own changes set nothing more off', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    pages[0].items[0].el.textContent = 'Hello ';
    await flush();

    // pdf.js moves its end-of-content div about as a selection is made
    const endOfContent = pages[0].textLayer.querySelector('.endOfContent')!;
    const changes = watch(containerEl);
    pages[0].textLayer.prepend(endOfContent);
    await flush();
    expect(
      changes().filter(
        (record) =>
          ![...record.addedNodes, ...record.removedNodes].every(
            (node) => node === endOfContent
          )
      )
    ).toEqual([]);
    layer.destroy();
  });

  it('shows the latest set it is given, and takes every mark off when destroyed, painting nothing after', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([ACROSS]);
    const other: PdfHighlight = {
      ref: 'Snippets/other.md',
      start: encodeAnchor({ page: 2, idx: 0, char: 7 }),
      end: encodeAnchor({ page: 2, idx: 0, char: 11 }),
    };
    layer.set([other]);
    expect(marked(pages[0].pageEl)).toEqual([]);
    expect(marked(pages[1].pageEl)).toEqual([[other.ref, 'page']]);

    layer.destroy();
    expect(marked(containerEl)).toEqual([]);
    expect(pages[1].items[0].el.textContent).toBe('Second page');
    pages[1].items[0].el.textContent = 'Second page';
    await flush();
    expect(marked(containerEl)).toEqual([]);
  });

  /** "el" of page 1's "Hello " marked, which splits it into three nodes. */
  const EL: PdfHighlight = {
    ref: 'Snippets/el.md',
    start: encodeAnchor({ page: 1, idx: 0, char: 1 }),
    end: encodeAnchor({ page: 1, idx: 0, char: 3 }),
  };

  /** Select from (`node`, `offset`) to the end of page 2's text. */
  function selectFrom(
    node: Node,
    offset: number,
    pages: { items: BuiltItem[] }[]
  ) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(pages[1].items[0].el.firstChild!, 3);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    return range;
  }

  const pointerUp = (el: Element) =>
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

  it("puts back at an item's start a selection Obsidian snapped to just before the item's last node, which a highlight made only its tail", () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([EL]);
    const item = pages[0].items[0].el;
    expect(item.childNodes).toHaveLength(3);

    // What Obsidian's pointerup snap does to a drag begun beside the text
    selectFrom(item, item.childNodes.length - 1, pages);
    pointerUp(pages[1].textLayer);

    const range = document.getSelection()!.getRangeAt(0);
    expect([range.startContainer, range.startOffset]).toEqual([item, 0]);
    expect(range.endContainer).toBe(pages[1].items[0].el.firstChild);
    layer.destroy();
  });

  it('leaves alone a selection starting anywhere else, in an item without highlights, or once destroyed', () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([EL]);
    const item = pages[0].items[0].el;
    const plain = pages[0].items[1].el;
    const starts: [Node, number][] = [
      // Not an item: a text layer, whose last node is the marker
      [pages[0].textLayer, pages[0].textLayer.childNodes.length - 1],
      [item, 1],
      [item.firstChild!, 1],
      [item.lastChild!, 0],
      [plain, 0],
      [plain.firstChild!, 2],
    ];
    for (const [node, offset] of starts) {
      selectFrom(node, offset, pages);
      pointerUp(pages[0].textLayer);
      const range = document.getSelection()!.getRangeAt(0);
      expect([range.startContainer, range.startOffset]).toEqual([node, offset]);
    }
    // A collapsed one, as a plain click leaves
    const caret = document.createRange();
    caret.setStart(item, 2);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(caret);
    pointerUp(pages[0].textLayer);
    expect(document.getSelection()!.getRangeAt(0).startOffset).toBe(2);
    // None at all
    document.getSelection()!.removeAllRanges();
    pointerUp(pages[0].textLayer);
    expect(document.getSelection()!.rangeCount).toBe(0);

    layer.destroy();
    layer.set([EL]);
    selectFrom(item, item.childNodes.length - 1, pages);
    pointerUp(pages[0].textLayer);
    expect(document.getSelection()!.getRangeAt(0).startOffset).toBe(2);
  });

  it("moves pdf.js's end-of-content marker out of a highlight, beside its item, so it still covers the page while a selection is made", async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([EL]);
    const item = pages[0].items[0].el;
    const marker = pages[0].textLayer.querySelector('.endOfContent')!;
    const span = item.querySelector('.ir-snippet-highlight')!;

    // pdf.js puts it after the node a selection ends in
    span.after(marker);
    await flush();
    expect(marker.parentElement).toBe(item.parentElement);
    expect(marker.previousSibling).toBe(item);

    // ...or before the one it starts in, when made backwards: here, after
    // the item's text "H"
    const back = (focus: Node) => {
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.setBaseAndExtent(pages[1].items[0].el.firstChild!, 2, focus, 1);
    };
    back(span.firstChild!);
    span.before(marker);
    await flush();
    expect(marker.parentElement).toBe(item.parentElement);
    expect(marker.nextSibling).toBe(item);
    expect(item.textContent).toBe('Hello ');
    layer.destroy();
  });

  it('puts the marker before the item for a backward selection whose focus is in a highlight right after another', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    // "H" and "el" of "Hello ", side by side
    const H: PdfHighlight = {
      ...EL,
      ref: 'Snippets/h.md',
      start: EL.start - 1,
      end: EL.start,
    };
    layer.set([H, EL]);
    const item = pages[0].items[0].el;
    const marker = pages[0].textLayer.querySelector('.endOfContent')!;
    const [, second] = item.querySelectorAll('.ir-snippet-highlight');
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.setBaseAndExtent(
      pages[1].items[0].el.firstChild!,
      2,
      second.firstChild!,
      1
    );

    second.before(marker);
    await flush();
    expect(marker.nextSibling).toBe(item);

    // Forward, from before the item, ending in the first: after the item
    selection.setBaseAndExtent(
      pages[0].textLayer,
      0,
      item.firstChild!.firstChild!,
      1
    );
    item.firstChild!.after(marker);
    await flush();
    expect(marker.previousSibling).toBe(item);
    layer.destroy();
  });

  it('repaints a text layer pdf.js rebuilds whole, marker and all', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([EL]);
    const { textLayer } = pages[0];
    const marker = textLayer.querySelector('.endOfContent')!;
    const item = document.createElement('span');
    item.className = 'textLayerNode';
    item.dataset.idx = '0';
    item.textContent = 'Hello ';

    // One change that adds the new items and the marker together
    textLayer.replaceChildren(item, marker);
    await flush();
    expect(marked(textLayer)).toEqual([[EL.ref, 'el']]);
    layer.destroy();
  });

  it('leaves the marker be, and scans no page, when pdf.js moves it about the text layer', async () => {
    const { containerEl, pages } = buildViewer();
    const layer = createPdfHighlightLayer(containerEl);
    layer.set([EL]);
    const marker = pages[0].textLayer.querySelector('.endOfContent')!;
    const scans = vi.spyOn(pages[0].pageEl, 'querySelectorAll');

    pages[0].textLayer.prepend(marker);
    await flush();
    expect(pages[0].textLayer.firstChild).toBe(marker);
    expect(scans).not.toHaveBeenCalled();
    layer.destroy();
  });
});
