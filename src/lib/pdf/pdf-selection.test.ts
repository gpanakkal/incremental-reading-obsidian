// @vitest-environment jsdom
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pdfAnchor from './pdf-anchor';
import { decodeAnchor, encodeAnchor, rangeToAnchors } from './pdf-anchor';
import {
  pageHasText,
  pageLinkAlias,
  pageSelection,
  pageSelectionSubpath,
  parseSelectionSubpath,
  readPdfSelection,
  selectionSubpath,
} from './pdf-selection';
import {
  extractText,
  type PdfDocument,
  type PdfPageText,
  type PdfTextItem,
  readPageTexts,
} from './pdf-text';

// #region HELPERS

function at(page: number, idx: number, char: number) {
  return encodeAnchor({ page, idx, char });
}

/** A text item with nothing but its text to go on. */
function makeItem(str: string, hasEOL = false): PdfTextItem {
  return {
    str,
    hasEOL,
    transform: [10, 0, 0, 10, 72, 700],
    width: 0,
    height: 10,
  };
}

function makePage(strs: string[]): PdfPageText {
  return { items: strs.map((str) => makeItem(str)), view: [0, 0, 612, 792] };
}

/** What `pnpm run fixtures:pdf-text` recorded of a fixture PDF. */
interface TextFixture {
  pages: { view: number[]; items: object[] }[];
}

function loadTextFixture(name: string): TextFixture {
  // Under jsdom, `import.meta.url` isn't a file URL to resolve against
  const file = resolve(__dirname, `../../test/fixtures/pdf-text/${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as TextFixture;
}

/** A pdf.js document stand-in serving `pages`' text content. */
function makeDocument(pages: TextFixture['pages']) {
  const getPage = vi.fn((n: number) =>
    Promise.resolve({
      view: pages[n - 1].view,
      getTextContent: () => Promise.resolve({ items: pages[n - 1].items }),
    })
  );
  return { numPages: pages.length, getPage } satisfies PdfDocument;
}

/**
 * The text layers Obsidian's pdf.js renders for `pages`, in a viewer element
 * attached to the document: a span per item with text, numbered by its index
 * among the items that have a `str`, and a `<br>` after each that ends a line.
 */
function buildViewer(pages: TextFixture['pages']) {
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    parent: Element,
    cls?: string
  ) => {
    const child = parent.appendChild(document.createElement(tag));
    if (cls) child.className = cls;
    return child;
  };
  const viewerEl = el('div', document.body, 'pdf-viewer');
  pages.forEach(({ items }, i) => {
    const pageEl = el('div', viewerEl, 'page');
    pageEl.dataset.pageNumber = String(i + 1);
    const layer = el('div', pageEl, 'textLayer');
    items
      .filter((item): item is PdfTextItem => 'str' in item)
      .forEach(({ str, hasEOL }, idx) => {
        if (str !== '') {
          const span = el('span', layer, 'textLayerNode');
          span.textContent = str;
          span.dataset.idx = String(idx);
        }
        if (hasEOL) el('br', layer).setAttribute('role', 'presentation');
      });
  });
  return viewerEl;
}

function spanAt(viewerEl: HTMLElement, page: number, idx: number) {
  return viewerEl.querySelector(
    `[data-page-number="${page}"] [data-idx="${idx}"]`
  )!;
}

function rangeBetween(
  [startNode, startOffset]: [Node, number],
  [endNode, endOffset]: [Node, number]
) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** Every boundary point inside `root`, in no particular order. */
function pointsIn(root: Node): [Node, number][] {
  const points: [Node, number][] = [];
  const walk = (node: Node) => {
    const size =
      node.nodeType === Node.TEXT_NODE
        ? node.textContent!.length
        : node.childNodes.length;
    for (let offset = 0; offset <= size; offset++) points.push([node, offset]);
    node.childNodes.forEach(walk);
  };
  walk(root);
  return points;
}

/** The order of two boundary points in the document. */
function comparePoints(
  [a, aOffset]: [Node, number],
  [b, bOffset]: [Node, number]
) {
  const range = document.createRange();
  range.setStart(a, aOffset);
  return range.comparePoint(b, bOffset);
}

/**
 * Page items for a link's start page: text of any kind, empty strings
 * included, with a start anchor in an item that has text, as a tight anchor
 * always is.
 */
const startPageArb = fc
  .array(fc.oneof(fc.constant(''), fc.string({ maxLength: 6 })), {
    minLength: 1,
    maxLength: 8,
  })
  .filter((strs) => strs.some((str) => str !== ''))
  .chain((strs) => {
    const withText = strs.flatMap((str, idx) => (str === '' ? [] : [idx]));
    return fc
      .constantFrom(...withText)
      .chain((idx) =>
        fc
          .nat(strs[idx].length - 1)
          .map((char) => ({ strs, start: { idx, char } }))
      );
  });

const pageArb = fc.integer({ min: 1, max: 900_718 });

/** An item index or character offset an anchor holds. */
const partArb = fc.integer({ min: 0, max: 99_999 });
/** Two positions on a page, the first before the second. */
const orderedArb = fc
  .tuple(partArb, partArb, partArb, partArb)
  .filter(([a, b, c, d]) => a < c || (a === c && b < d));
/** A parameter Obsidian's grammar may carry besides `page` and `selection`. */
const extraArb = fc
  .tuple(
    fc.constantFrom('color', 'offset', 'height', 'zoom', 'x'),
    fc.stringMatching(/^[\w,.-]{0,8}$/)
  )
  .map(([name, value]) => `${name}=${value}`);

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('selectionSubpath', () => {
  it("links to the selection on its page, in the grammar Obsidian's own selection links use", () => {
    fc.assert(
      fc.property(
        pageArb,
        startPageArb,
        fc.nat(99_999),
        fc.nat(99_999),
        (page, { strs, start }, endIdx, endChar) => {
          const subpath = selectionSubpath(
            at(page, start.idx, start.char),
            at(page, endIdx, endChar),
            makePage(strs)
          );

          expect(subpath).toBe(
            `#page=${page}&selection=${start.idx},${start.char},${endIdx},${endChar}`
          );
        }
      )
    );
  });

  it('cuts a selection that runs onto a later page off at the end of the text on its first', () => {
    fc.assert(
      fc.property(
        pageArb.filter((page) => page < 900_718),
        startPageArb,
        fc.integer({ min: 1, max: 100 }),
        fc.nat(99_999),
        fc.nat(99_999),
        (page, { strs, start }, pagesOn, endIdx, endChar) => {
          const subpath = selectionSubpath(
            at(page, start.idx, start.char),
            at(Math.min(page + pagesOn, 900_718), endIdx, endChar),
            makePage(strs)
          );

          // The last item with text: Obsidian highlights item by item, and an
          // empty one is never on the page to highlight
          let last = strs.length - 1;
          while (strs[last] === '') last--;
          expect(subpath).toBe(
            `#page=${page}&selection=${start.idx},${start.char},${last},${strs[last].length}`
          );
        }
      )
    );
  });
});

describe('pageSelection', () => {
  it("selects text on one page whole when the page isn't read", () => {
    fc.assert(
      fc.property(
        pageArb,
        fc.nat(99_999),
        fc.nat(99_999),
        fc.nat(99_999),
        fc.nat(99_999),
        (page, startIdx, startChar, endIdx, endChar) => {
          const selection = pageSelection(
            at(page, startIdx, startChar),
            at(page, endIdx, endChar)
          );

          expect(selection).toEqual({
            page,
            range: [
              [startIdx, startChar],
              [endIdx, endChar],
            ],
          });
        }
      )
    );
  });

  it('selects text on one page whole when the page read holds both its ends, else nothing', () => {
    fc.assert(
      fc.property(
        pageArb,
        startPageArb.chain(({ strs, start }) =>
          fc.record({
            strs: fc.constant(strs),
            start: fc.constant(start),
            endIdx: fc.nat(strs.length),
            endChar: fc.nat(8),
          })
        ),
        (page, { strs, start, endIdx, endChar }) => {
          const selection = pageSelection(
            at(page, start.idx, start.char),
            at(page, endIdx, endChar),
            makePage(strs)
          );

          const fits = endIdx < strs.length && endChar <= strs[endIdx].length;
          expect(selection).toEqual(
            fits
              ? {
                  page,
                  range: [
                    [start.idx, start.char],
                    [endIdx, endChar],
                  ],
                }
              : null
          );
        }
      )
    );
  });

  it("is null when the page read doesn't hold the start, as when the PDF has changed since", () => {
    fc.assert(
      fc.property(
        pageArb.filter((page) => page < 900_718),
        startPageArb.chain(({ strs }) =>
          fc.record({
            strs: fc.constant(strs),
            start: fc.oneof(
              fc.record({
                idx: fc.integer({ min: strs.length, max: 99_999 }),
                char: fc.nat(99_999),
              }),
              fc.nat(strs.length - 1).chain((idx) =>
                fc.record({
                  idx: fc.constant(idx),
                  char: fc.integer({
                    min: strs[idx].length + 1,
                    max: 99_999,
                  }),
                })
              )
            ),
          })
        ),
        fc.nat(1),
        (page, { strs, start }, pagesOn) => {
          const selection = pageSelection(
            at(page, start.idx, start.char),
            at(page + pagesOn, 99_999, 99_999),
            makePage(strs)
          );

          expect(selection).toBeNull();
        }
      )
    );
  });

  it('cuts text that runs onto a later page off at the end of the text on its first', () => {
    fc.assert(
      fc.property(
        pageArb.filter((page) => page < 900_718),
        startPageArb,
        fc.integer({ min: 1, max: 100 }),
        fc.nat(99_999),
        fc.nat(99_999),
        (page, { strs, start }, pagesOn, endIdx, endChar) => {
          const selection = pageSelection(
            at(page, start.idx, start.char),
            at(Math.min(page + pagesOn, 900_718), endIdx, endChar),
            makePage(strs)
          );

          let last = strs.length - 1;
          while (strs[last] === '') last--;
          expect(selection).toEqual({
            page,
            range: [
              [start.idx, start.char],
              [last, strs[last].length],
            ],
          });
        }
      )
    );
  });

  it("is null for text that runs onto a later page when its first page's text isn't given, or has none", () => {
    fc.assert(
      fc.property(
        pageArb.filter((page) => page < 900_718),
        fc.integer({ min: 1, max: 100 }),
        fc.option(fc.array(fc.constant(''), { maxLength: 4 }), {
          nil: undefined,
        }),
        (page, pagesOn, emptyStrs) => {
          const selection = pageSelection(
            at(page, 0, 0),
            at(Math.min(page + pagesOn, 900_718), 0, 1),
            emptyStrs && makePage(emptyStrs)
          );

          expect(selection).toBeNull();
        }
      )
    );
  });
});

describe('pageSelectionSubpath', () => {
  it("links to the selection in the grammar Obsidian's own selection links use", () => {
    fc.assert(
      fc.property(
        pageArb,
        fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
        (page, [a, b, c, d]) => {
          expect(
            pageSelectionSubpath({
              page,
              range: [
                [a, b],
                [c, d],
              ],
            })
          ).toBe(`#page=${page}&selection=${a},${b},${c},${d}`);
        }
      )
    );
  });
});

describe('parseSelectionSubpath', () => {
  it('reads back the selection pageSelectionSubpath links to, as the anchors of its ends', () => {
    fc.assert(
      fc.property(pageArb, orderedArb, (page, [a, b, c, d]) => {
        const subpath = pageSelectionSubpath({
          page,
          range: [
            [a, b],
            [c, d],
          ],
        });
        expect(parseSelectionSubpath(subpath)).toEqual({
          start: at(page, a, b),
          end: at(page, c, d),
        });
      })
    );
  });

  it('ignores parameters other than page and selection, in any order, and a missing #', () => {
    fc.assert(
      fc.property(
        pageArb,
        orderedArb,
        fc.array(extraArb, { maxLength: 3 }),
        fc.boolean(),
        fc.boolean(),
        (page, [a, b, c, d], extras, selectionFirst, hash) => {
          const own = [`page=${page}`, `selection=${a},${b},${c},${d}`];
          if (selectionFirst) own.reverse();
          const params = [...extras, ...own];
          const subpath = (hash ? '#' : '') + params.join('&');
          expect(parseSelectionSubpath(subpath)).toEqual({
            start: at(page, a, b),
            end: at(page, c, d),
          });
        }
      )
    );
  });

  it('reads nothing from a selection that ends where it starts, or before', () => {
    fc.assert(
      fc.property(
        pageArb,
        fc
          .tuple(partArb, partArb, partArb, partArb)
          .filter(([a, b, c, d]) => a > c || (a === c && b >= d)),
        (page, [a, b, c, d]) => {
          expect(
            parseSelectionSubpath(`#page=${page}&selection=${a},${b},${c},${d}`)
          ).toBeNull();
        }
      )
    );
  });

  it.each([
    ['no subpath', ''],
    ['only a page', '#page=3'],
    ['no page', '#selection=0,1,0,4'],
    ['an empty page', '#page=&selection=0,1,0,4'],
    ['page 0', '#page=0&selection=0,1,0,4'],
    ['a page past what an anchor holds', '#page=900719&selection=0,1,0,4'],
    ['a fractional page', '#page=1.5&selection=0,1,0,4'],
    ['a negative page', '#page=-1&selection=0,1,0,4'],
    ['an empty selection', '#page=1&selection='],
    ['three numbers', '#page=1&selection=0,1,4'],
    ['five numbers', '#page=1&selection=0,1,0,4,5'],
    ['an empty number', '#page=1&selection=0,,0,4'],
    ['a negative number', '#page=1&selection=0,-1,0,4'],
    ['a fractional number', '#page=1&selection=0,1,0,4.5'],
    ['a number in exponent form', '#page=1&selection=0,1,0,1e3'],
    ['a hexadecimal number', '#page=1&selection=0,1,0,0x4'],
    ['a number with spaces', '#page=1&selection=0, 1,0,4'],
    ['an index past what an anchor holds', '#page=1&selection=0,1,100000,4'],
    ['a character past what an anchor holds', '#page=1&selection=0,1,0,100000'],
    ['a heading', '#Chapter 1'],
    ['a # inside the page, not before it', 'page=1#&selection=0,1,0,4'],
  ])('reads nothing from a subpath with %s', (_, subpath) => {
    expect(parseSelectionSubpath(subpath)).toBeNull();
  });

  it('reads nothing from a selection that is not four non-negative integers', () => {
    fc.assert(
      fc.property(pageArb, fc.string(), (page, selection) => {
        fc.pre(!/^\d+,\d+,\d+,\d+$/.test(selection));
        expect(
          parseSelectionSubpath(
            `#page=${page}&selection=${encodeURIComponent(selection)}`
          )
        ).toBeNull();
      })
    );
  });
});

describe('pageLinkAlias', () => {
  it("names the page as Obsidian's own PDF links do", () => {
    fc.assert(
      fc.property(fc.string(), pageArb, (basename, page) => {
        expect(pageLinkAlias(basename, page)).toBe(`${basename}, page ${page}`);
      })
    );
  });
});

describe('readPdfSelection', () => {
  const fixture = loadTextFixture('PDF fixture');

  it('reads a paragraph carried over a page break as it reads, without the running heads between', async () => {
    const viewerEl = buildViewer(fixture.pages);
    const endText = 'ends here, on the second page,';
    const range = rangeBetween(
      [spanAt(viewerEl, 1, 9).firstChild!, 0],
      [spanAt(viewerEl, 2, 3).firstChild!, endText.length]
    );

    const read = await readPdfSelection(
      range,
      viewerEl,
      makeDocument(fixture.pages)
    );

    expect(read).toEqual({
      start: at(1, 9, 0),
      end: at(2, 3, endText.length),
      text:
        'A paragraph that begins near the foot of one page is common in ' +
        'papers and books alike. Whatever reads the text has to carry the ' +
        'sentence over the page break, past the footer of this page and the ' +
        'header of the next, without mistaking either of them for part of ' +
        'the paragraph itself. It ends here, on the second page,',
      subpath: '#page=1&selection=9,0,13,11',
    });
  });

  it('rejoins a word hyphenated across lines, and links to just those lines', async () => {
    const viewerEl = buildViewer(fixture.pages);
    const range = rangeBetween(
      [spanAt(viewerEl, 1, 7).firstChild!, 0],
      [spanAt(viewerEl, 1, 8).firstChild!, 10]
    );

    expect(
      await readPdfSelection(range, viewerEl, makeDocument(fixture.pages))
    ).toEqual({
      start: at(1, 7, 0),
      end: at(1, 8, 10),
      text: 'fine example of one',
      subpath: '#page=1&selection=7,0,8,10',
    });
  });

  it('is the anchors of any selection in the viewer, its text, and the link to it', async () => {
    const viewerEl = buildViewer(fixture.pages);
    const doc = makeDocument(fixture.pages);
    const points = pointsIn(viewerEl);
    const texts = await readPageTexts(doc, at(1, 0, 0), at(3, 0, 0));
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...points),
        fc.constantFrom(...points),
        async (a, b) => {
          const [from, to] = comparePoints(a, b) < 0 ? [b, a] : [a, b];
          const range = rangeBetween(from, to);

          const read = await readPdfSelection(range, viewerEl, doc);

          const anchors = rangeToAnchors(range, viewerEl);
          const text =
            anchors && extractText(texts, anchors.start, anchors.end);
          if (!anchors || !text?.trim()) {
            expect(read).toBeNull();
            return;
          }
          const { page, idx, char } = decodeAnchor(anchors.start);
          // What the link and the anchors must agree on, whatever the parts
          expect(read!.start).toBeLessThan(read!.end);
          expect(read!.text).toMatch(/\S/);
          expect(read!.subpath).toMatch(
            new RegExp(`^#page=${page}&selection=${idx},${char},\\d+,\\d+$`)
          );
          expect(read).toEqual({
            ...anchors,
            text,
            subpath: selectionSubpath(
              anchors.start,
              anchors.end,
              texts.get(page)!
            ),
          });
        }
      ),
      { numRuns: 60 }
    );
  });

  it('is null for a page with no text layer, a scan, and reads nothing', async () => {
    const scanned = loadTextFixture('PDF fixture - no text');
    const viewerEl = buildViewer(scanned.pages);
    const doc = makeDocument(scanned.pages);
    const pageEl = viewerEl.querySelector('.page')!;

    const read = await readPdfSelection(
      rangeBetween([pageEl, 0], [pageEl, pageEl.childNodes.length]),
      viewerEl,
      doc
    );

    expect(read).toBeNull();
    expect(doc.getPage).not.toHaveBeenCalled();
  });

  it('is null for a selection of nothing but blank text', async () => {
    const pages = [
      {
        view: [0, 0, 612, 792],
        items: ['Hello', ' ', 'world'].map((s) => makeItem(s)),
      },
    ];
    const viewerEl = buildViewer(pages);
    const blank = spanAt(viewerEl, 1, 1).firstChild!;

    const read = await readPdfSelection(
      rangeBetween([blank, 0], [blank, 1]),
      viewerEl,
      makeDocument(pages)
    );

    expect(read).toBeNull();
  });

  it('is null, and says why in the console, for a text layer no anchor can hold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viewerEl = buildViewer(fixture.pages);
    const span = spanAt(viewerEl, 1, 2);
    span.setAttribute('data-idx', '100000');
    const doc = makeDocument(fixture.pages);

    const read = await readPdfSelection(
      rangeBetween([span.firstChild!, 0], [span.firstChild!, 4]),
      viewerEl,
      doc
    );

    expect(read).toBeNull();
    expect(doc.getPage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/^Incremental Reading: \S/);
    expect(warn.mock.calls[0][1]).toBeInstanceOf(RangeError);
  });

  it("is null, and says why in the console, when the document's text disagrees with the text layer", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viewerEl = buildViewer(fixture.pages);
    const span = spanAt(viewerEl, 1, 13);
    // The text layer of another file than the one the document holds
    const doc = makeDocument(
      fixture.pages.map((page) => ({ ...page, items: page.items.slice(0, 3) }))
    );

    const read = await readPdfSelection(
      rangeBetween([span.firstChild!, 0], [span.firstChild!, 4]),
      viewerEl,
      doc
    );

    expect(read).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/^Incremental Reading: \S/);
    expect(warn.mock.calls[0][1]).toBeInstanceOf(RangeError);
  });

  it('fails as mapping the selection fails, for anything but a range no anchor holds', async () => {
    const viewerEl = buildViewer(fixture.pages);
    const span = spanAt(viewerEl, 1, 2);
    const error = new TypeError('changed');
    vi.spyOn(pdfAnchor, 'rangeToAnchors').mockImplementation(() => {
      throw error;
    });

    await expect(
      readPdfSelection(
        rangeBetween([span.firstChild!, 0], [span.firstChild!, 4]),
        viewerEl,
        makeDocument(fixture.pages)
      )
    ).rejects.toBe(error);
  });

  it('fails as reading the document fails', async () => {
    const viewerEl = buildViewer(fixture.pages);
    const span = spanAt(viewerEl, 1, 2);
    const error = new Error('worker gone');
    const doc = makeDocument(fixture.pages);
    doc.getPage.mockRejectedValue(error);

    await expect(
      readPdfSelection(
        rangeBetween([span.firstChild!, 0], [span.firstChild!, 4]),
        viewerEl,
        doc
      )
    ).rejects.toBe(error);
  });
});

describe('pageHasText', () => {
  it('is whether any text item on the page has more than whitespace', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(
            fc.oneof(
              fc.string().map((str) => makeItem(str)),
              fc.constantFrom(' ', '	', ' ', '').map((str) => makeItem(str)),
              // Marked content, which has no text of its own
              fc.constant({ type: 'beginMarkedContent', tag: 'P' })
            ),
            { maxLength: 6 }
          ),
          { minLength: 1, maxLength: 4 }
        ),
        fc.nat(),
        async (pageItems, pick) => {
          const page = (pick % pageItems.length) + 1;
          const doc = makeDocument(
            pageItems.map((items) => ({ view: [0, 0, 612, 792], items }))
          );

          const expected = pageItems[page - 1].some(
            (item) => 'str' in item && /\S/.test(item.str)
          );
          expect(await pageHasText(doc, page)).toBe(expected);
          expect(doc.getPage).toHaveBeenCalledExactlyOnceWith(page);
        }
      )
    );
  });

  it('is false for a scan, and true for a page of text', async () => {
    const scanned = loadTextFixture('PDF fixture - no text');
    const fixture = loadTextFixture('PDF fixture');

    expect(await pageHasText(makeDocument(scanned.pages), 1)).toBe(false);
    expect(await pageHasText(makeDocument(fixture.pages), 3)).toBe(true);
  });
});
