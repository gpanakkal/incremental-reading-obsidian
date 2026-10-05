import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { type AnchorParts, encodeAnchor } from './pdf-anchor';
import {
  extractText,
  type PdfDocument,
  type PdfPageText,
  type PdfTextItem,
  readPageText,
  readPageTexts,
} from './pdf-text';

// #region HELPERS

/** US Letter, in PDF points. */
const LETTER = [0, 0, 612, 792];

interface ItemOptions {
  x?: number;
  y?: number;
  /** Defaults to 5.5pt per character, about what 11pt Helvetica takes. */
  width?: number;
  size?: number;
  eol?: boolean;
}

function makeItem(str: string, options: ItemOptions = {}): PdfTextItem {
  const { x = 72, y = 400, size = 11, eol = false } = options;
  return {
    str,
    hasEOL: eol,
    transform: [size, 0, 0, size, x, y],
    width: options.width ?? str.length * 5.5,
    height: str === '' ? 0 : size,
  };
}

function makePage(items: PdfTextItem[], view: number[] = LETTER): PdfPageText {
  return { items, view };
}

const HEADER = 'Journal of Incremental Reading';

/**
 * A page laid out like a journal's: item 0 is a running header, then one item
 * per line of `body`, then a footer.
 */
function makeJournalPage(
  body: string[],
  { header = HEADER, footer = '' }: { header?: string; footer?: string } = {}
): PdfPageText {
  return makePage([
    makeItem(header, { y: 750, size: 9, eol: true }),
    ...body.map((line, i) =>
      makeItem(line, { y: 700 - 15 * i, eol: i < body.length - 1 })
    ),
    makeItem(footer, { x: 280, y: 40, size: 9 }),
  ]);
}

function at(page: number, idx: number, char: number) {
  return encodeAnchor({ page, idx, char });
}

/** Document order of the items two anchors are in. */
function compareItems(
  a: Pick<AnchorParts, 'page' | 'idx'>,
  b: Pick<AnchorParts, 'page' | 'idx'>
) {
  return a.page - b.page || a.idx - b.idx;
}

/**
 * A stand-in for a pdf.js document with `pageItems` as each page's text
 * content, marked content included, and by default a view as wide as 600 plus
 * its page number.
 */
function makeDocument(
  pageItems: object[][],
  views = pageItems.map((_, i) => [0, 0, 601 + i, 800])
) {
  const getTextContent = vi.fn((params: object) => {
    void params;
  });
  const getPage = vi.fn((n: number) =>
    Promise.resolve({
      view: views[n - 1],
      getTextContent: (params: object) => {
        getTextContent(params);
        return Promise.resolve({ items: pageItems[n - 1] });
      },
    })
  );
  return {
    doc: { numPages: pageItems.length, getPage } satisfies PdfDocument,
    getTextContent,
  };
}

/**
 * What the pdf.js bundled in Obsidian reads out of a fixture PDF, as
 * `pnpm run fixtures:pdf-text` records it.
 */
interface TextFixture {
  pdfjs: { version: string };
  pages: { view: number[]; items: object[] }[];
}

/** The version of pdf.js that Obsidian 1.13 bundles. */
const OBSIDIAN_PDFJS = '5.3.34';

/**
 * @throws {Error} when the fixture was recorded with another pdf.js than
 *   Obsidian's, so it can't stand in for what Obsidian reads.
 */
function loadTextFixture(name: string): TextFixture {
  const url = new URL(
    `../../test/fixtures/pdf-text/${name}.json`,
    import.meta.url
  );
  const fixture = JSON.parse(readFileSync(url, 'utf8')) as TextFixture;
  if (fixture.pdfjs.version !== OBSIDIAN_PDFJS) {
    throw new Error(
      `${name}.json was recorded with pdf.js ${fixture.pdfjs.version}, not ${OBSIDIAN_PDFJS}`
    );
  }
  return fixture;
}

/** A pdf.js document stand-in that serves a recorded fixture. */
function fixtureDocument({ pages }: TextFixture) {
  return makeDocument(
    pages.map((page) => page.items),
    pages.map((page) => page.view)
  ).doc;
}

/** The anchor of `char` in the item on `page` whose text starts with `start`. */
function anchorAt(
  { pages }: TextFixture,
  page: number,
  start: string,
  char: number
) {
  const items = pages[page - 1].items.filter((item) => 'str' in item);
  const idx = items.findIndex((item) =>
    (item as PdfTextItem).str.startsWith(start)
  );
  if (idx === -1) throw new Error(`No item starts with "${start}"`);
  return at(page, idx, char);
}

/** One item per line, each ending its line but the last, at 10pt. */
function linesAt(lines: [str: string, y: number, size?: number][]) {
  return lines.map(([str, y, size = 10], i) =>
    makeItem(str, { y, size, eol: i < lines.length - 1 })
  );
}

/** The text of all of `items`, as the one page of a PDF. */
function extractAll(items: PdfTextItem[]) {
  const pages = new Map([[1, makePage(items)]]);
  const last = items[items.length - 1];
  return extractText(
    pages,
    at(1, 0, 0),
    at(1, items.length - 1, last.str.length)
  );
}

/** The anchors around the whole of `pages`. */
function wholeRange(pages: PdfTextItem[][]) {
  const last = pages[pages.length - 1];
  return [
    at(1, 0, 0),
    at(pages.length, last.length - 1, last[last.length - 1].str.length),
  ] as const;
}

const HYPHENS = ['-', String.fromCharCode(0xad), String.fromCharCode(0x2010)];

const LIGATURE_CHARS = Array.from({ length: 7 }, (_, i) =>
  String.fromCharCode(0xfb00 + i)
);

/** Spells out the ligatures in `text`. */
const spellOut = (text: string) =>
  Array.from(text, (c) =>
    LIGATURE_CHARS.includes(c) ? c.normalize('NFKC') : c
  ).join('');

const compact = (text: string) => text.replace(/\s/g, '');

const withoutHyphens = (text: string) =>
  Array.from(text)
    .filter((c) => !HYPHENS.includes(c))
    .join('');

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase Roman numerals. */
function toRoman(n: number) {
  const numerals: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let rest = n;
  return numerals
    .map(([value, numeral]) => {
      const times = Math.floor(rest / value);
      rest -= times * value;
      return numeral.repeat(times);
    })
    .join('');
}

// Arbitraries

const LIGATURE_PATTERN = new RegExp(`[${LIGATURE_CHARS.join('')}]`);

/** A finite number of PDF points, as wide as any page's coordinates. */
const coordArb = fc.double({ min: -1e5, max: 1e5, noNaN: true });

/** Any item height: pdf.js gives zero to text set at size 0, as OCR layers are. */
const heightArb = fc.double({ min: 0, max: 100, noNaN: true });

/** A page's view, `[x0, y0, x1, y1]`: anywhere, at least `minSize` across. */
const viewArb = (minSize = 1) =>
  fc
    .tuple(
      coordArb,
      coordArb,
      fc.double({ min: minSize, max: 1e4, noNaN: true }),
      fc.double({ min: minSize, max: 1e4, noNaN: true })
    )
    .map(([x0, y0, width, height]) => [x0, y0, x0 + width, y0 + height]);

/**
 * A word that can't be a page number, so stays in the text wherever it sits:
 * it starts with a capital and ends with `mark`, which differs per page so
 * that no line repeats on another page.
 */
const wordArb = (mark: string) =>
  fc.stringMatching(/^[A-Z][A-Za-z]{0,6}$/).map((word) => `${word}${mark}`);

/** Items of any text, size and place on a page, empty ones included. */
function itemsArb(strArb: fc.Arbitrary<string>, yArb: fc.Arbitrary<number>) {
  return fc.array(
    fc
      .record({
        str: fc.oneof(
          { weight: 1, arbitrary: fc.constant('') },
          { weight: 4, arbitrary: strArb }
        ),
        eol: fc.boolean(),
        x: coordArb,
        y: yArb,
        width: fc.double({ min: 0, max: 1000, noNaN: true }),
        height: heightArb,
      })
      .map(({ str, height, ...options }) => ({
        ...makeItem(str, options),
        height,
      })),
    { minLength: 1, maxLength: 12 }
  );
}

/**
 * How two neighbouring items with text must be joined, judged with margins
 * either side of the thresholds: `\s+` when they are clearly apart or a
 * line ends between them, nothing when they clearly touch, else either.
 */
function separatorPattern(
  prev: PdfTextItem,
  next: PdfTextItem,
  lineEnds: boolean
) {
  if (lineEnds) return '\\s+';
  const size = Math.max(prev.height, next.height);
  const shift = Math.abs(prev.transform[5] - next.transform[5]);
  const gap = Math.max(
    next.transform[4] - (prev.transform[4] + prev.width),
    prev.transform[4] - (next.transform[4] + next.width)
  );
  if (shift > 0.6 * size) return '\\s+';
  if (shift < 0.4 * size || shift === 0) {
    if (gap > 0.2 * size) return '\\s+';
    if (gap <= 0) return '';
  }
  return '\\s*';
}

/** The pattern the whole of `pages`, all of it body text, extracts to. */
function wholeTextPattern(pages: PdfTextItem[][]) {
  let pattern = '';
  let prev: PdfTextItem | undefined;
  let lineEnds = false;
  pages.forEach((items, p) => {
    let firstOnPage = true;
    for (const item of items) {
      if (item.str !== '') {
        if (prev) {
          pattern +=
            firstOnPage && p > 0
              ? '\\s+'
              : separatorPattern(prev, item, lineEnds);
        }
        pattern += escapeRegExp(item.str);
        prev = item;
        lineEnds = false;
        firstOnPage = false;
      }
      lineEnds ||= item.hasEOL;
    }
  });
  return new RegExp(`^${pattern}$`);
}

/** Where a Letter page's body text goes, clear of the furniture bands. */
const bodyYArb = fc.double({ min: 80, max: 712, noNaN: true });

/** Any text, rich in the characters extraction rewrites. */
const rewrittenTextArb = fc.string({
  unit: fc.oneof(
    fc.constantFrom(...HYPHENS, ...LIGATURE_CHARS),
    fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })
  ),
  maxLength: 10,
});

/** One character of a word: letters of every case and script, and others. */
const wordCharArb = fc.oneof(
  fc.constantFrom(
    'a',
    'Z',
    String.fromCharCode(0xe4),
    String.fromCharCode(0x416),
    String.fromCharCode(0x436),
    String.fromCharCode(0x1c5),
    String.fromCodePoint(0x1d41a),
    String.fromCodePoint(0x1d400),
    ...LIGATURE_CHARS,
    ...HYPHENS,
    '7',
    '.',
    '"',
    '('
  ),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 })
);

/** A word to split with a hyphen: anything without whitespace. */
const hyphenWordArb = fc
  .string({ unit: wordCharArb, minLength: 1, maxLength: 8 })
  .filter((word) => /^\S+$/.test(word));

/**
 * A running head: any text around a word, with `#` where its page's number
 * goes, if anywhere.
 */
const runningHeadArb = fc
  .tuple(
    fc.string({ unit: 'grapheme', maxLength: 8 }),
    fc.oneof(
      fc.stringMatching(/^[A-Za-z]{2,8}$/),
      fc.constantFrom(
        `R${String.fromCharCode(0xe9)}vue`,
        String.fromCharCode(0x413, 0x43b, 0x430, 0x432, 0x430)
      )
    ),
    fc.boolean(),
    fc.string({ unit: 'grapheme', maxLength: 8 })
  )
  .map(([before, word, numbered, after]) =>
    `${before}${word}${numbered ? '#' : ''}${after}`.replace(/#(?=.*#)/g, '')
  );

/** The ways a footer gives the page number `n`. */
const footerFormArb = fc.constantFrom(
  (n: number) => `${n}`,
  (n: number) => toRoman(n),
  (n: number) =>
    `${String.fromCharCode(0x2013)} ${n} ${String.fromCharCode(0x2013)}`,
  (n: number) => `-${toRoman(n)}-`,
  (n: number) => `Page ${n} of 99`
);

/** A page's text content from pdf.js, marked content and all. */
const textContentArb = fc.array(
  fc.oneof(
    fc.constantFrom(
      { type: 'beginMarkedContent' },
      { type: 'beginMarkedContentProps', id: 'p1' },
      { type: 'endMarkedContent' }
    ),
    fc
      .record({ str: fc.string({ maxLength: 4 }), eol: fc.boolean() })
      .map(({ str, eol }) => makeItem(str, { eol }))
  ),
  { maxLength: 6 }
);

/** Paragraphs of lines of words, each line one to three items. */
const paragraphsArb = fc.array(
  fc.array(fc.array(wordArb(''), { minLength: 1, maxLength: 3 }), {
    minLength: 1,
    maxLength: 6,
  }),
  { minLength: 1, maxLength: 4 }
);

/** The count of hyphens in `text`. */
const hyphenCount = (text: string) =>
  Array.from(text).filter((c) => HYPHENS.includes(c)).length;

// #endregion

describe('extractText', () => {
  it('returns the text between two anchors in one item', () => {
    const pages = new Map([[1, makePage([makeItem('Incremental reading')])]]);
    expect(extractText(pages, at(1, 0, 4), at(1, 0, 15))).toBe('emental rea');
  });

  it('puts a space where a line ends', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('keeps what', { y: 400, eol: true }),
          makeItem('matters most', { y: 385 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 6), at(1, 1, 7))).toBe('what matters');
  });

  it('puts a space where an empty item ends the line', () => {
    // pdf.js often marks a line break with an empty item of its own
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('keeps what', { y: 400 }),
          makeItem('', { y: 385, eol: true }),
          makeItem('matters most', { y: 385 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 6), at(1, 2, 7))).toBe('what matters');
  });

  it('keeps a line end across the empty items after it', () => {
    // Laid out to touch, so only `hasEOL` tells the lines apart
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('what', { x: 72, width: 22, eol: true }),
          makeItem('', { x: 94 }),
          makeItem('matters', { x: 94 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 2, 7))).toBe('what matters');
  });

  it('adds no separator after the last text in the range', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('what', { eol: true }),
          makeItem(''),
          makeItem('matters', { y: 385 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 1, 0))).toBe('what');
    expect(extractText(pages, at(1, 0, 0), at(1, 2, 0))).toBe('what');
  });

  it('adds no separator before the first text in the range', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('what', { eol: true }),
          makeItem('matters', { y: 385 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 4), at(1, 1, 7))).toBe('matters');
  });

  it('puts a space where text moves to a new baseline without a line end', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('what', { x: 72, y: 400, width: 22 }),
          makeItem('matters', { x: 72, y: 385 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 1, 7))).toBe('what matters');
  });

  it('puts a space between items on a line with a gap between them', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('what', { x: 72, width: 22 }),
          makeItem('matters', { x: 97 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 1, 7))).toBe('what matters');
  });

  it('joins items on a line that touch, superscripts included', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('effi', { x: 72, width: 22 }),
          makeItem('cient', { x: 94, width: 27.5 }),
          makeItem('2', { x: 121.5, y: 404, size: 7, width: 4 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 2, 1))).toBe('efficient2');
  });

  it('rejoins a word hyphenated across a line break', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('fine exam-', { y: 400, eol: true }),
          makeItem('ple of one', { y: 385 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 1, 10))).toBe(
      'fine example of one'
    );
  });

  it('keeps the hyphen of a compound broken before a capital or digit', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('Anglo-', { y: 400, eol: true }),
          makeItem('Saxon and pre-', { y: 385, eol: true }),
          makeItem('2020 texts', { y: 370 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 2, 10))).toBe(
      'Anglo-Saxon and pre-2020 texts'
    );
  });

  it('starts a paragraph where the gap between lines is wider than usual', () => {
    const pages = new Map([
      [
        1,
        makePage(
          [
            'Each review reads a little.',
            'It keeps what matters. ',
            null,
            'Extracting the passages',
            'worth keeping is the heart',
            'of the method.',
          ].flatMap((line, i, lines) =>
            line === null
              ? []
              : [
                  makeItem(line, {
                    y: 700 - 15 * i,
                    eol: lines[i + 1] !== undefined,
                  }),
                ]
          )
        ),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 4, 14))).toBe(
      'Each review reads a little. It keeps what matters.\n\n' +
        'Extracting the passages worth keeping is the heart of the method.'
    );
  });

  it('keeps double-spaced lines in one paragraph', () => {
    const lines = ['Each review reads', 'a little and keeps', 'what matters.'];
    const pages = new Map([
      [
        1,
        makePage(
          lines.map((line, i) =>
            makeItem(line, { y: 700 - 22 * i, eol: i < lines.length - 1 })
          )
        ),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 2, 13))).toBe(
      'Each review reads a little and keeps what matters.'
    );
  });

  it('measures line spacing over every page it is given', () => {
    // Page 2 alone has no ordinary line advance to tell a paragraph by
    const pages = new Map([
      [1, makeJournalPage(['One line', 'after another', 'and another.'])],
      [2, makeJournalPage(['The end of one.', '', 'Another one.'])],
    ]);
    expect(extractText(pages, at(2, 1, 0), at(2, 3, 12))).toBe(
      'The end of one.\n\nAnother one.'
    );
  });

  it('carries text across pages as across a line break', () => {
    const pages = new Map([
      [1, makePage([makeItem('the footer of this', { y: 100 })])],
      [2, makePage([makeItem('page, and an exam-', { y: 700 })])],
      [3, makePage([makeItem('ple of it', { y: 700 })])],
    ]);
    expect(extractText(pages, at(1, 0, 4), at(3, 0, 9))).toBe(
      'footer of this page, and an example of it'
    );
  });

  it('ignores where text sits on the page before it', () => {
    // A drop this far on one page would start a paragraph
    const pages = new Map([
      [1, makePage([makeItem('without', { y: 700 }), makeItem('')])],
      [2, makePage([makeItem('', { eol: true }), makeItem('it', { y: 100 })])],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(2, 1, 2))).toBe('without it');
  });

  it('drops running headers and footers between pages', () => {
    const pages = new Map(
      [
        ['the page break, past the footer'],
        ['and the header of the next.'],
        ['The third page.'],
      ].map((body, i) => [
        i + 1,
        makeJournalPage(body, { footer: `Page ${i + 1} of 3` }),
      ])
    );
    expect(extractText(pages, at(1, 1, 0), at(2, 1, 27))).toBe(
      'the page break, past the footer and the header of the next.'
    );
  });

  it('drops bare page numbers in the top and bottom bands', () => {
    const pages = new Map([
      [1, makeJournalPage(['the page break'], { header: 'xii', footer: '1' })],
      [2, makeJournalPage(['past the footer'], { header: '- xiii -' })],
      [3, makeJournalPage(['of this page'], { header: 'xiv', footer: '– 3' })],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(3, 1, 12))).toBe(
      'the page break past the footer of this page'
    );
  });

  it('keeps text in the bands that repeats on no nearby page', () => {
    const pages = new Map([
      [1, makeJournalPage(['the page break'], { footer: 'A footnote.' })],
      [2, makeJournalPage(['past the footer'], { header: 'Section 2' })],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(2, 1, 15))).toBe(
      'the page break\n\nA footnote. Section 2\n\npast the footer'
    );
  });

  it('keeps text that repeats in the other band or outside the bands', () => {
    const repeated = 'Figure 1';
    const pages = new Map([
      [1, makeJournalPage([repeated], { header: 'Top', footer: repeated })],
      [2, makeJournalPage([repeated], { header: repeated })],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(2, 1, 8))).toBe(
      'Figure 1\n\nFigure 1 Figure 1\n\nFigure 1'
    );
  });

  it('drops running heads that alternate between odd and even pages', () => {
    const pages = new Map(
      ['Book Title', 'Chapter 1', 'Book Title', 'Chapter 1'].map(
        (header, i) => [
          i + 1,
          makeJournalPage([`body ${i + 1}`], {
            header,
            footer: `${100 + i}`,
          }),
        ]
      )
    );
    expect(extractText(pages, at(1, 1, 0), at(4, 1, 6))).toBe(
      'body 1 body 2 body 3 body 4'
    );
  });

  it('keeps furniture the range starts or ends in', () => {
    const pages = new Map(
      [['the page break'], ['past the footer']].map((body, i) => [
        i + 1,
        makeJournalPage(body, { footer: `Page ${i + 1}` }),
      ])
    );
    expect(extractText(pages, at(1, 0, 8), at(1, 1, 3))).toBe(
      'of Incremental Reading\n\nthe'
    );
    expect(extractText(pages, at(1, 1, 9), at(2, 2, 4))).toBe(
      'break past the footer\n\nPage'
    );
  });

  it('spells out ligatures', () => {
    // Text content is fetched with `disableNormalization`, which keeps them
    const pages = new Map([
      [1, makePage([makeItem('e\uFB03cient \uFB02ow, \uFB00ord \uFB06')])],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(1, 0, 19))).toBe(
      'efficient flow, fford st'
    );
  });

  it('adds no space where one is already at the line end', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('keeps what ', { y: 400, eol: true }),
          makeItem('matters most', { y: 385 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 6), at(1, 1, 7))).toBe('what matters');
  });
});

describe('extractText at the edges of its rules', () => {
  it('measures line spacing on items with text only', () => {
    // Empty items sit 9pt under each line, where no text is
    const items = linesAt([
      ['a', 700],
      ['', 691],
      ['b', 685],
      ['', 676],
      ['c', 670],
      ['d', 640],
      ['', 631],
      ['e', 625],
    ]);
    expect(extractAll(items)).toBe('a b c\n\nd e');
  });

  it('measures line spacing against the taller of two lines', () => {
    const items = linesAt([
      ['a', 700, 10],
      ['b', 688, 9],
      ['c', 676, 10],
      ['d', 664, 9],
      ['e', 652, 10],
      ['f', 635, 9],
    ]);
    expect(extractAll(items)).toBe('a b c d e\n\nf');
  });

  it('measures a paragraph gap against the smaller of two lines', () => {
    const items = linesAt([
      ['Methods', 700, 14],
      ['We collected', 678],
      ['data.', 666],
      ['Results', 642, 14],
    ]);
    expect(extractAll(items)).toBe('Methods\n\nWe collected data.\n\nResults');
  });

  it('keeps small text on the line it shares with larger text', () => {
    expect(
      extractAll([
        makeItem('E = mc', { x: 72, y: 400, size: 10, width: 30 }),
        makeItem('2', { x: 102.8, y: 404, size: 1, width: 1 }),
      ])
    ).toBe('E = mc2');
  });

  it('counts line advances of 0.8 and 3 times the text height as spacing', () => {
    expect(
      extractAll(
        linesAt([
          ['a', 700],
          ['b', 692],
          ['c', 684],
          ['d', 664],
        ])
      )
    ).toBe('a b c\n\nd');
    expect(
      extractAll(
        linesAt([
          ['a', 700],
          ['b', 670],
          ['c', 640],
          ['d', 590],
        ])
      )
    ).toBe('a b c\n\nd');
  });

  it('starts a paragraph only past 1.5 times the usual spacing', () => {
    expect(
      extractAll(
        linesAt([
          ['a', 700],
          ['b', 685],
          ['c', 670],
          ['d', 647.5],
        ])
      )
    ).toBe('a b c d');
  });

  it('keeps text shifted by up to half its height on the same line', () => {
    expect(
      extractAll([
        makeItem('a', { x: 72, y: 400, size: 10, width: 5 }),
        makeItem('b', { x: 77, y: 395, size: 10, width: 5 }),
      ])
    ).toBe('ab');
  });

  it('joins items on a line up to a tenth of their height apart', () => {
    expect(
      extractAll([
        makeItem('ef', { x: 72, size: 10, width: 10 }),
        makeItem('fi', { x: 82.5, size: 10, width: 10 }),
        makeItem('cient', { x: 93.5, size: 10, width: 25 }),
      ])
    ).toBe('efficient');
  });

  it('rejoins a hyphenated word whatever space surrounds the line break', () => {
    expect(
      extractAll(
        linesAt([
          ['fine exam- ', 700],
          [' ple of one', 685],
        ])
      )
    ).toBe('fine example of one');
    expect(
      extractAll(
        linesAt([
          ['Anglo- ', 700],
          ['Saxon', 685],
        ])
      )
    ).toBe('Anglo-Saxon');
  });

  it('rejoins a hyphenated word set in items of its own', () => {
    const bold = String.fromCodePoint(0x1d41a);
    expect(
      extractAll([
        makeItem(`exam${bold}`, { x: 72, width: 25 }),
        makeItem('-', { x: 97, width: 3 }),
        makeItem(' ', { x: 100, width: 3, eol: true }),
        makeItem(' ', { x: 72, y: 385, width: 3 }),
        makeItem('ple', { x: 75, y: 385 }),
      ])
    ).toBe(`exam${bold}ple`);
  });

  it('rejoins a hyphenated word whose line ends with no move down', () => {
    expect(
      extractAll([
        makeItem('exam-', { x: 72, eol: true }),
        makeItem('ple', { x: 300 }),
      ])
    ).toBe('example');
  });

  it('reads an item of nothing but whitespace as a space', () => {
    expect(
      extractAll([
        makeItem('what', { x: 72, width: 20 }),
        makeItem('  ', { x: 92, width: 0 }),
        makeItem('matters', { x: 92 }),
      ])
    ).toBe('what matters');
    // Before any text, it is left out
    expect(extractAll([makeItem(' ', { width: 0 }), makeItem('what')])).toBe(
      'what'
    );
  });

  it('keeps hyphens inside a line', () => {
    expect(
      extractAll([
        makeItem('well-', { x: 72, width: 25 }),
        makeItem('known', { x: 97 }),
      ])
    ).toBe('well-known');
    expect(
      extractAll([
        makeItem('well-', { x: 72, width: 25 }),
        makeItem('known', { x: 120 }),
      ])
    ).toBe('well- known');
  });

  it('starts a paragraph with no space before its first word', () => {
    expect(
      extractAll(
        linesAt([
          ['a', 700],
          ['b', 685],
          [' c', 600],
        ])
      )
    ).toBe('a b\n\nc');
  });

  it('measures the furniture bands from where the page starts', () => {
    // The bands are the top and bottom 79.2pt of this 792pt-tall page
    const view = [0, 100, 612, 892];
    const pages = new Map(
      [1, 2].map((n) => [
        n,
        makePage(
          [
            makeItem(`body ${n}`, { y: 500 }),
            makeItem('Continued', { y: 185 }),
            makeItem(`${n}`, { y: 120, size: 9 }),
          ],
          view
        ),
      ])
    );
    expect(extractText(pages, at(1, 0, 0), at(2, 0, 6))).toBe(
      'body 1\n\nContinued body 2'
    );
  });

  it('puts the edges of the furniture bands outside them', () => {
    const depth = 0.1 * 792;
    const pages = new Map(
      [1, 2].map((n) => [
        n,
        makePage([
          makeItem('Top', { y: 792 - depth }),
          makeItem(`body ${n}`, { y: 500 }),
          makeItem('Bottom', { y: depth }),
        ]),
      ])
    );
    expect(extractText(pages, at(1, 1, 0), at(2, 1, 6))).toBe(
      'body 1\n\nBottom Top\n\nbody 2'
    );
  });

  it('tells running heads apart by everything but their numbers', () => {
    const pages = new Map([
      [1, makeJournalPage(['body 1'], { header: 'Volume 3 ' })],
      [2, makeJournalPage(['body 2'], { header: 'Volume 4' })],
      [3, makeJournalPage(['body 3'], { header: 'Volume' })],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(3, 1, 6))).toBe(
      'body 1 body 2 Volume\n\nbody 3'
    );
  });

  it('drops page numbers set tight between dashes or padded with spaces', () => {
    const pages = new Map([
      [1, makeJournalPage(['body 1'], { header: 'A', footer: '–12–' })],
      [2, makeJournalPage(['body 2'], { header: 'B', footer: ' 13 ' })],
      [3, makeJournalPage(['body 3'], { header: 'C', footer: '14 Notes' })],
      [4, makeJournalPage(['body 4'], { header: 'D' })],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(4, 1, 6))).toBe(
      'body 1 B\n\nbody 2 C\n\nbody 3\n\n14 Notes D\n\nbody 4'
    );
  });

  it('drops blank items in the furniture bands', () => {
    const pages = new Map([
      [1, makeJournalPage(['body 1'], { header: 'A', footer: '   ' })],
      [2, makeJournalPage(['body 2'], { header: 'B', footer: 'X' })],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(2, 1, 6))).toBe(
      'body 1 B\n\nbody 2'
    );
  });

  it('drops furniture at the start index of the range on later pages', () => {
    const pages = new Map([
      [
        1,
        makePage([
          makeItem(HEADER, { y: 750 }),
          makeItem('first', { y: 700, eol: true }),
          makeItem('second', { y: 685 }),
          makeItem('Page 1', { y: 40 }),
        ]),
      ],
      [
        2,
        makePage([
          makeItem(HEADER, { y: 750 }),
          makeItem('third', { y: 700 }),
          makeItem('Page 2', { y: 40 }),
          makeItem('fourth', { y: 685 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 2, 0), at(2, 3, 6))).toBe(
      'second third fourth'
    );
  });

  it('keeps the line end of furniture it drops', () => {
    // "one" and "two" touch: only the header's line end parts them
    const pages = new Map(
      [1, 2].map((n) => [
        n,
        makePage([
          makeItem('one', { x: 72, y: 400, width: 15 }),
          makeItem(HEADER, { y: 760, eol: true }),
          makeItem('two', { x: 87, y: 400 }),
        ]),
      ])
    );
    expect(extractText(pages, at(1, 0, 0), at(1, 2, 3))).toBe('one two');
  });

  it('keeps body lines that reach into the bands, item by item', () => {
    // A 1in margin puts the last body line in the bottom band, with a math
    // variable and a citation set as items of their own
    const pages = new Map(
      [
        ['summed over x', 'i', 'as in', '[12]'],
        ['summed over y', 'i', 'see', '[3]'],
      ].map((words, i) => [
        i + 1,
        makePage([
          makeItem(`body ${i + 1}`, { y: 400, eol: true }),
          ...words.map((word, w) =>
            makeItem(word, { x: 72 + 80 * w, y: 74, width: 60 })
          ),
        ]),
      ])
    );
    expect(extractText(pages, at(1, 0, 0), at(2, 4, 3))).toBe(
      'body 1\n\nsummed over x i as in [12] body 2\n\nsummed over y i see [3]'
    );
  });

  it('takes only Roman numerals in their proper form for page numbers', () => {
    const pages = new Map(
      ['did', 'civil', 'xiv', 'xv'].map((footer, i) => [
        i + 1,
        makeJournalPage([`body ${i + 1}`], { header: `${i}`, footer }),
      ])
    );
    expect(extractText(pages, at(1, 1, 0), at(4, 1, 6))).toBe(
      'body 1\n\ndid body 2\n\ncivil body 3 body 4'
    );
  });

  it('adds no space for an empty item between items that touch', () => {
    expect(
      extractAll([
        makeItem('effi', { x: 72, width: 20 }),
        makeItem('', { x: 92 }),
        makeItem('cient', { x: 92 }),
      ])
    ).toBe('efficient');
  });

  it('keeps a hyphen in an item of its own after anything but a letter', () => {
    expect(
      extractAll([
        makeItem('exam1', { x: 72, width: 25 }),
        makeItem('-', { x: 97, width: 3, eol: true }),
        makeItem('ple', { x: 72, y: 385 }),
      ])
    ).toBe('exam1- ple');
  });

  it('reads a footer set in several items as one line', () => {
    // The blank item sits off the line, as pdf.js can place spaces
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('body 1', { y: 400 }),
          makeItem('Page', { x: 280, y: 40, width: 20 }),
          makeItem(' ', { x: 300, y: 60, width: 3 }),
          makeItem('1', { x: 303, y: 40 }),
        ]),
      ],
      [
        2,
        makePage([
          makeItem('body 2', { y: 400 }),
          makeItem('Page 2', { x: 280, y: 40 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(2, 0, 6))).toBe('body 1 body 2');
  });

  it('keeps a line that straddles the edge of a band', () => {
    const pages = new Map(
      [1, 2].map((n) => [
        n,
        makePage([
          makeItem(`body ${n}`, { y: 400 }),
          makeItem('Notes', { x: 72, y: 79, width: 30 }),
          makeItem('go on', { x: 102, y: 80 }),
        ]),
      ])
    );
    expect(extractText(pages, at(1, 0, 0), at(2, 0, 6))).toBe(
      'body 1\n\nNotesgo on body 2'
    );
  });

  it('ends a furniture line where pdf.js ends it', () => {
    // A left and a right footer on one baseline
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('body 1', { y: 400 }),
          makeItem('Draft', { x: 72, y: 40, eol: true }),
          makeItem('1', { x: 500, y: 40 }),
        ]),
      ],
      [
        2,
        makePage([
          makeItem('body 2', { y: 400 }),
          makeItem('Draft', { x: 72, y: 40, eol: true }),
          makeItem('2', { x: 500, y: 40 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(2, 0, 6))).toBe('body 1 body 2');
  });

  it('compares furniture with its runs of whitespace as single spaces', () => {
    const pages = new Map([
      [1, makeJournalPage(['body 1'], { header: 'A', footer: 'Page  1' })],
      [2, makeJournalPage(['body 2'], { header: 'B', footer: 'Page 2' })],
      [3, makeJournalPage(['body 3'], { header: 'C', footer: 'Page3' })],
      [4, makeJournalPage(['body 4'], { header: 'D', footer: 'Notes' })],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(4, 1, 6))).toBe(
      'body 1 B\n\nbody 2 C\n\nbody 3\n\nPage3 D\n\nbody 4'
    );
  });

  it('measures the gap between lines from their main text, not a superscript', () => {
    const items = [
      makeItem('the speed of light c', { y: 700, size: 10, width: 100 }),
      makeItem('2', { x: 172, y: 704, size: 6, width: 3, eol: true }),
      ...linesAt([
        ['goes on here', 688],
        ['and here.', 676],
        ['New paragraph.', 652],
      ]),
    ];
    expect(extractAll(items)).toBe(
      'the speed of light c2 goes on here and here.\n\nNew paragraph.'
    );
  });

  it('reads text of no height as lines, with no paragraphs to tell', () => {
    const items = linesAt([
      ['a', 700],
      ['b', 690],
      ['c', 600],
    ]).map((item) => ({ ...item, height: 0 }));
    expect(extractAll(items)).toBe('a b c');
  });

  it('measures a gap next to text of no height by the other line', () => {
    const items = linesAt([
      ['a', 700],
      ['b', 685],
      ['c', 670],
      ['d', 640],
    ]);
    items[3] = { ...items[3], height: 0 };
    expect(extractAll(items)).toBe('a b c\n\nd');
  });

  it('drops a repeated line only where it sits in the same place nearby', () => {
    // A table row at the foot of page 1 reads like page 2's, once its numbers
    // go, but sits elsewhere; the footers sit alike, centred
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('body 1', { y: 400 }),
          makeItem('Total 12 34', { x: 72, y: 70, width: 60 }),
          makeItem('Page 1 of 9', { x: 280, y: 40, width: 52 }),
        ]),
      ],
      [
        2,
        makePage([
          makeItem('body 2', { y: 400 }),
          makeItem('Total 56 78', { x: 300, y: 70, width: 60 }),
          makeItem('Total 90 12', { x: 72, y: 20, width: 60 }),
          makeItem('Page 10 of 99', { x: 276, y: 40, width: 60 }),
          makeItem('end', { y: 300 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(2, 4, 3))).toBe(
      'body 1\n\nTotal 12 34 body 2\n\nTotal 56 78\n\nTotal 90 12 end'
    );
  });

  it('takes no line without a word in it for a running head', () => {
    // Table rows set at the same place on every page
    const pages = new Map(
      [
        ['12.5 3.1 0.4', 'a 1'],
        ['17.2 4.8 0.9', 'a 2'],
      ].map(([row, label], i) => [
        i + 1,
        makePage([
          makeItem(`body ${i + 1}`, { y: 400 }),
          makeItem(row, { y: 60, eol: true }),
          makeItem(label, { x: 300, y: 50 }),
        ]),
      ])
    );
    expect(extractText(pages, at(1, 0, 0), at(2, 0, 6))).toBe(
      'body 1\n\n12.5 3.1 0.4 a 1 body 2'
    );
  });

  it('finds running heads that shift between pages, wherever the page starts', () => {
    // As in a scan: the head sits 14pt lower on page 2, on a page whose
    // view starts 18pt in
    const head = 'CHAPTER 3. METHODS';
    const pages = new Map([
      [
        1,
        makePage([
          makeItem(head, { x: 72, y: 752, eol: true }),
          makeItem('the text con-', { x: 72, y: 400 }),
        ]),
      ],
      [
        2,
        makePage(
          [
            makeItem(head, { x: 90, y: 756, eol: true }),
            makeItem('tinues', { x: 90, y: 700 }),
          ],
          [18, 18, 630, 810]
        ),
      ],
    ]);
    expect(extractText(pages, at(1, 1, 0), at(2, 1, 6))).toBe(
      'the text continues'
    );
  });

  it('takes a bare number for a page number only as the outermost line of its band', () => {
    // Display maths at the foot of the page, over the page number
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('body 1', { y: 400 }),
          makeItem('xi', { x: 300, y: 70 }),
          makeItem('2', { x: 300, y: 60 }),
          makeItem('iv', { x: 300, y: 40 }),
        ]),
      ],
      [
        2,
        makePage([
          makeItem('body 2', { y: 400 }),
          makeItem('3', { x: 300, y: 60 }),
          makeItem('v', { x: 300, y: 40 }),
        ]),
      ],
    ]);
    // "2" numbers on to page 2's "3", but sits over the page number
    expect(extractText(pages, at(1, 0, 0), at(2, 0, 6))).toBe(
      'body 1\n\nxi 2 body 2'
    );
  });

  it('takes a bare number for a page number only where the pages around it number on', () => {
    // A display fraction's denominator ends a page with no page numbers
    const pages = new Map([
      [
        1,
        makePage([
          makeItem('body 1', { y: 400 }),
          makeItem('2', { x: 300, y: 40 }),
        ]),
      ],
      [
        2,
        makePage([
          makeItem('body 2', { y: 400 }),
          makeItem('2', { x: 300, y: 40 }),
        ]),
      ],
      [
        3,
        makePage([
          makeItem('body 3', { y: 400 }),
          makeItem('v', { x: 300, y: 40 }),
        ]),
      ],
    ]);
    expect(extractText(pages, at(1, 0, 0), at(3, 0, 6))).toBe(
      'body 1\n\n2 body 2\n\n2 body 3'
    );
  });

  it('finds the main text of a line that starts with a footnote mark', () => {
    const items = [
      makeItem('1', { x: 72, y: 705, size: 6, width: 3 }),
      makeItem('text', { x: 75, y: 700, size: 10, width: 20, eol: true }),
      ...linesAt([
        ['goes on', 691],
        ['and on', 682],
        ['and on.', 673],
        ['New.', 655],
      ]),
    ];
    expect(extractAll(items)).toBe('1text goes on and on and on.\n\nNew.');
  });

  /**
   * Two pages of body text whose footers read alike, numbers aside, as
   * `footers` lays them out, on pages with the given views.
   */
  function withFooters(
    footers: PdfTextItem[][],
    views: number[][] = [LETTER, LETTER]
  ) {
    return new Map(
      footers.map((footer, i) => [
        i + 1,
        makePage([makeItem(`body ${i + 1}`, { y: 400 }), ...footer], views[i]),
      ])
    );
  }

  it('finds running footers aligned left, right or centre', () => {
    const extract = (pages: Map<number, PdfPageText>) =>
      extractText(pages, at(1, 0, 0), at(2, 0, 6));
    // Left: the numbers make the second item start further right
    expect(
      extract(
        withFooters([
          [
            makeItem('Page', { x: 72, y: 40, size: 9, width: 20 }),
            makeItem('9', { x: 95, y: 40, size: 9, width: 5 }),
          ],
          [
            makeItem('Page', { x: 72, y: 40, size: 9, width: 20 }),
            makeItem('1000', { x: 150, y: 40, size: 9, width: 100 }),
          ],
        ])
      )
    ).toBe('body 1 body 2');
    // Right
    expect(
      extract(
        withFooters([
          [
            makeItem('Page', { x: 480, y: 40, size: 9, width: 20 }),
            makeItem('9', { x: 530, y: 40, size: 9, width: 10 }),
          ],
          [
            makeItem('Page', { x: 380, y: 40, size: 9, width: 20 }),
            makeItem('1000', { x: 500, y: 40, size: 9, width: 40 }),
          ],
        ])
      )
    ).toBe('body 1 body 2');
    expect(
      extract(
        withFooters([
          [makeItem('Page 9', { x: 400, y: 40, size: 9, width: 140 })],
          [makeItem('Page 1000', { x: 300, y: 40, size: 9, width: 240 })],
        ])
      )
    ).toBe('body 1 body 2');
    // Centre, 45pt off: within half the taller page's band, not the other's
    expect(
      extract(
        withFooters(
          [
            [makeItem('Page 9', { x: 280, y: 40, size: 9, width: 52 })],
            [makeItem('Page 1000', { x: 201, y: 40, size: 9, width: 300 })],
          ],
          [LETTER, [0, 0, 612, 1000]]
        )
      )
    ).toBe('body 1 body 2');
  });

  it('places lines from where each page starts', () => {
    // Pages whose views start 50pt and 150pt in
    const views = [
      [50, 50, 662, 842],
      [150, 150, 762, 942],
    ];
    const extract = (footers: PdfTextItem[][]) =>
      extractText(withFooters(footers, views), at(1, 0, 0), at(2, 0, 6));
    // Aligned left, 40pt up
    expect(
      extract([
        [makeItem('Notes', { x: 122, y: 90, width: 100 })],
        [makeItem('Notes', { x: 222, y: 190, width: 200 })],
      ])
    ).toBe('body 1 body 2');
    // Aligned right
    expect(
      extract([
        [makeItem('Notes', { x: 122, y: 90, width: 100 })],
        [makeItem('Notes', { x: 122, y: 190, width: 200 })],
      ])
    ).toBe('body 1 body 2');
    // 45pt apart: more than half of these pages' bands
    expect(
      extract([
        [makeItem('Notes', { x: 122, y: 50 })],
        [makeItem('Notes', { x: 222, y: 195 })],
      ])
    ).toBe('body 1\n\nNotes body 2');
  });

  it('takes footers up to half a band apart as in the same place', () => {
    const extract = (pages: Map<number, PdfPageText>) =>
      extractText(pages, at(1, 0, 0), at(2, 0, 6));
    const halfBand = (0.1 * 792) / 2;
    expect(
      extract(
        withFooters([
          [makeItem('Notes', { x: 72, y: 0 })],
          [makeItem('Notes', { x: 72, y: halfBand })],
        ])
      )
    ).toBe('body 1 body 2');
    expect(
      extract(
        withFooters([
          [makeItem('Notes', { x: 0, y: 40, width: 0 })],
          [makeItem('Notes', { x: halfBand, y: 40, width: 0 })],
        ])
      )
    ).toBe('body 1 body 2');
  });

  it('takes a page number at the top for one only above the other lines there', () => {
    // Page numbers over the chapter title: dropped
    const over = new Map(
      [1, 2].map((n) => [
        n,
        makePage([
          makeItem(`${10 + n}`, { x: 300, y: 760 }),
          makeItem(`Chapter ${'AB'[n - 1]}`, { y: 745, eol: true }),
          makeItem(`body ${n}`, { y: 400 }),
        ]),
      ])
    );
    expect(extractText(over, at(1, 2, 0), at(2, 2, 6))).toBe(
      'body 1 Chapter B\n\nbody 2'
    );
    // Under the running title: kept
    const under = new Map(
      [1, 2].map((n) => [
        n,
        makePage([
          makeItem('Running Title', { y: 760 }),
          makeItem(`${2 + n}`, { x: 300, y: 745, eol: true }),
          makeItem(`body ${n}`, { y: 400 }),
        ]),
      ])
    );
    expect(extractText(under, at(1, 2, 0), at(2, 2, 6))).toBe(
      'body 1 4\n\nbody 2'
    );
  });

  it('returns nothing for an empty range, even on a page it lacks', () => {
    expect(extractText(new Map(), at(7, 1, 2), at(7, 1, 2))).toBe('');
  });

  it('returns nothing for a range of empty items and furniture', () => {
    const pages = new Map(
      [1, 2].map((n) => [n, makeJournalPage([''], { footer: `${n}` })])
    );
    expect(extractText(pages, at(1, 1, 0), at(2, 1, 0))).toBe('');
  });
});

describe('extractText properties', () => {
  it('separates words whose boxes do not touch, and joins those that do', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 3 })
          .chain((pageCount) =>
            fc.tuple(
              ...Array.from({ length: pageCount }, (_, i) =>
                viewArb().chain((view) =>
                  fc.tuple(
                    fc.constant(view),
                    itemsArb(
                      wordArb('XYZ'[i]),
                      fc.double({ min: view[1], max: view[3], noNaN: true })
                    )
                  )
                )
              )
            )
          ),
        (pageList) => {
          const pages = new Map(
            pageList.map(([view, items], i) => [i + 1, makePage(items, view)])
          );
          const pageItems = pageList.map(([, items]) => items);
          const [start, end] = wholeRange(pageItems);
          expect(extractText(pages, start, end)).toMatch(
            wholeTextPattern(pageItems)
          );
        }
      )
    );
  });

  it('keeps every character of the body text between the anchors', () => {
    // Body text only: furniture has a property of its own
    fc.assert(
      fc.property(
        fc
          .array(itemsArb(rewrittenTextArb, bodyYArb), {
            minLength: 1,
            maxLength: 3,
          })
          .chain((pageItems) => {
            const anchorArb = fc
              .integer({ min: 1, max: pageItems.length })
              .chain((page) =>
                fc
                  .integer({ min: 0, max: pageItems[page - 1].length - 1 })
                  .chain((idx) =>
                    fc
                      .integer({
                        min: 0,
                        max: pageItems[page - 1][idx].str.length,
                      })
                      .map((char) => ({ page, idx, char }))
                  )
              );
            return fc.tuple(fc.constant(pageItems), anchorArb, anchorArb);
          }),
        ([pageItems, from, to]) => {
          const pages = new Map(
            pageItems.map((items, i) => [i + 1, makePage(items)])
          );
          let raw = '';
          // Rejoining a word drops the hyphen that ends an item's text
          let droppable = 0;
          pageItems.forEach((items, p) =>
            items.forEach((item, idx) => {
              const here = { page: p + 1, idx };
              if (compareItems(here, from) < 0 || compareItems(here, to) > 0) {
                return;
              }
              const slice = item.str.slice(
                compareItems(here, from) === 0 ? from.char : 0,
                compareItems(here, to) === 0 ? to.char : undefined
              );
              raw += slice;
              if (hyphenCount(slice.trimEnd().slice(-1)) === 1) droppable++;
            })
          );
          const start = encodeAnchor(from);
          const end = encodeAnchor(to);
          const text = extractText(pages, start, end);
          if (start >= end) {
            expect(text).toBe('');
            return;
          }
          const expected = spellOut(raw);
          expect(withoutHyphens(compact(text))).toBe(
            withoutHyphens(compact(expected))
          );
          const dropped = hyphenCount(expected) - hyphenCount(text);
          expect(dropped).toBeGreaterThanOrEqual(0);
          expect(dropped).toBeLessThanOrEqual(droppable);
          expect(text).not.toMatch(LIGATURE_PATTERN);
        }
      )
    );
  });

  it('rejoins words hyphenated across lines, keeping compound hyphens', () => {
    fc.assert(
      fc.property(
        hyphenWordArb,
        hyphenWordArb,
        fc.constantFrom(...HYPHENS),
        fc.boolean(),
        fc.boolean(),
        (head, tail, hyphen, eol, emptyBetween) => {
          const items = [
            makeItem(`${head}${hyphen}`, { y: 400, eol }),
            ...(emptyBetween ? [makeItem('', { eol: true })] : []),
            makeItem(tail, { y: 385 }),
          ];
          const rejoin = new RegExp(`\\p{L}[${HYPHENS.join('')}]$`, 'u').test(
            `${head}${hyphen}`
          );
          let expected = `${head}${hyphen} ${tail}`;
          if (rejoin) {
            expected = /^\p{Ll}/u.test(tail)
              ? `${head}${tail}`
              : `${head}${hyphen}${tail}`;
          }
          expect(extractAll(items)).toBe(spellOut(expected));
        }
      )
    );
  });

  it('joins lines with spaces and paragraphs with blank lines', () => {
    fc.assert(
      fc.property(
        paragraphsArb,
        // Each line's size; text of no height has no spacing to measure
        fc.array(
          fc.oneof(
            fc.constant(0),
            fc.double({ min: 0.5, max: 50, noNaN: true })
          ),
          { minLength: 24, maxLength: 24 }
        ),
        fc.double({ min: 1, max: 2, noNaN: true }),
        // Paragraph gaps, and the jitter of each line's leading
        fc.double({ min: 1.8, max: 5, noNaN: true }),
        fc.array(fc.double({ min: -0.1, max: 0.1, noNaN: true }), {
          minLength: 24,
          maxLength: 24,
        }),
        fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
        (paragraphs, sizes, spacing, gap, jitter, eols) => {
          const items: PdfTextItem[] = [];
          // Each line break: whether it starts a paragraph, the drop to the
          // next line, and the smaller (else larger) of the two lines' sizes
          const breaks: { starts: boolean; drop: number; size: number }[] = [];
          let y = 0;
          let line = 0;
          paragraphs.forEach((lines, p) => {
            lines.forEach((words, i) => {
              const size = sizes[line];
              if (line > 0) {
                const prevSize = sizes[line - 1];
                const advance =
                  i > 0 ? spacing * (1 + jitter[line]) : gap * spacing;
                // Text of no height still sits on lines of its own
                const drop = advance * (Math.max(prevSize, size) || 10);
                y -= drop;
                breaks.push({
                  starts: i === 0 && p > 0,
                  drop,
                  size: Math.min(prevSize, size) || Math.max(prevSize, size),
                });
              }
              let x = 72;
              words.forEach((word, w) => {
                const width = word.length * 0.5 * size;
                const eol = w === words.length - 1 && eols[line];
                items.push(makeItem(word, { x, y, size, width, eol }));
                x += width + 0.3 * size + 0.5;
              });
              line++;
            });
          });
          // Ordinary line advances set the line spacing once they outnumber
          // paragraph gaps: then its value is known to within the jitter
          const measured = breaks.filter((b) => !b.starts && b.size > 0);
          const known = measured.length > breaks.filter((b) => b.starts).length;
          const separators = breaks.map(({ drop, size }) => {
            if (size === 0) return ' ';
            if (!known) return '\\s+';
            if (drop > 1.5 * 1.1 * spacing * size * (1 + 1e-9)) return '\\n\\n';
            if (drop < 1.5 * 0.9 * spacing * size * (1 - 1e-9)) return ' ';
            return '\\s+';
          });
          const lineTexts = paragraphs.flatMap((lines) =>
            lines.map((words) => words.map(escapeRegExp).join(' '))
          );
          const pattern = lineTexts
            .map((text, i) => (i === 0 ? text : separators[i - 1] + text))
            .join('');
          const pages = new Map([[1, makePage(items, [0, -1e5, 612, 1e5])]]);
          const last = items[items.length - 1];
          expect(
            extractText(
              pages,
              at(1, 0, 0),
              at(1, items.length - 1, last.str.length)
            )
          ).toMatch(new RegExp(`^${pattern}$`));
        }
      )
    );
  });

  it('drops running heads and page numbers between pages', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        // Tall enough that the bands lie well clear of the body text
        viewArb(200),
        runningHeadArb,
        footerFormArb,
        // Where in its band the header and footer sit, from 0 to 1
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        (pageCount, view, head, footer, depth) => {
          const [, bottom, , top] = view;
          const band = 0.1 * (top - bottom);
          const pages = new Map(
            Array.from({ length: pageCount }, (_, i) => {
              const n = i + 1;
              return [
                n,
                makePage(
                  [
                    makeItem(head.replace('#', `${n * 7}`), {
                      y: top - band * depth,
                      eol: true,
                    }),
                    makeItem(`Body${'ABCDE'[i]}`, { y: (top + bottom) / 2 }),
                    makeItem(footer(n), { y: bottom + band * depth }),
                  ],
                  view
                ),
              ];
            })
          );
          expect(extractText(pages, at(1, 1, 0), at(pageCount, 1, 5))).toBe(
            Array.from(
              { length: pageCount },
              (_, i) => `Body${'ABCDE'[i]}`
            ).join(' ')
          );
        }
      )
    );
  });
});

describe('extractText given anchors it cannot read', () => {
  const pages = new Map([
    [1, makePage([makeItem('keeps what'), makeItem('matters')])],
    [3, makePage([makeItem('later')])],
  ]);

  it('returns nothing for a range that ends before it starts', () => {
    expect(extractText(pages, at(1, 0, 6), at(1, 0, 2))).toBe('');
    expect(extractText(pages, at(1, 1, 0), at(1, 0, 4))).toBe('');
    expect(extractText(pages, at(3, 0, 0), at(1, 0, 4))).toBe('');
    expect(extractText(pages, at(9, 0, 0), at(1, 0, 4))).toBe('');
    expect(extractText(pages, at(1, 0, 4), at(1, 0, 4))).toBe('');
  });

  it('throws when a page of the range is missing', () => {
    expect(() => extractText(pages, at(1, 0, 0), at(3, 0, 2))).toThrow(
      new RangeError('No text content for PDF page 2')
    );
  });

  it('throws when an anchor lies past the text of its page', () => {
    expect(() => extractText(pages, at(1, 0, 0), at(1, 2, 0))).toThrow(
      new RangeError('PDF anchor past the text of page 1: item 2, char 0')
    );
    expect(() => extractText(pages, at(1, 0, 11), at(1, 1, 2))).toThrow(
      new RangeError('PDF anchor past the text of page 1: item 0, char 11')
    );
  });
});

describe('readPageTexts', () => {
  it("reads the range's pages and two on either side, as far as they go", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(textContentArb, { minLength: 1, maxLength: 12 })
          .chain((content) =>
            fc.tuple(
              fc.constant(content),
              fc.integer({ min: 1, max: content.length }),
              fc.integer({ min: 1, max: content.length })
            )
          ),
        async ([content, startPage, endPage]) => {
          const { doc } = makeDocument(content);
          const pages = await readPageTexts(
            doc,
            at(startPage, 0, 0),
            at(endPage, 0, 0)
          );
          const first = Math.max(1, startPage - 2);
          const last = Math.min(content.length, endPage + 2);
          expect([...pages]).toEqual(
            Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => [
              first + i,
              {
                items: content[first + i - 1].filter((item) => 'str' in item),
                view: [0, 0, 600 + first + i, 800],
              },
            ])
          );
        }
      )
    );
  });

  it('asks pdf.js for the items the text layer numbers', async () => {
    const { doc, getTextContent } = makeDocument([[]]);
    await readPageTexts(doc, at(1, 0, 0), at(1, 0, 1));
    expect(getTextContent).toHaveBeenCalledWith({
      includeMarkedContent: true,
      disableNormalization: true,
    });
  });
});

describe('readPageText', () => {
  it('reads one page, numbering its items as the text layer does', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(textContentArb, { minLength: 1, maxLength: 12 })
          .chain((content) =>
            fc.tuple(
              fc.constant(content),
              fc.integer({ min: 1, max: content.length })
            )
          ),
        async ([content, page]) => {
          const { doc, getTextContent } = makeDocument(content);

          const text = await readPageText(doc, page);

          expect(text).toEqual({
            items: content[page - 1].filter((item) => 'str' in item),
            view: [0, 0, 600 + page, 800],
          });
          expect(doc.getPage).toHaveBeenCalledExactlyOnceWith(page);
          expect(getTextContent).toHaveBeenCalledExactlyOnceWith({
            includeMarkedContent: true,
            disableNormalization: true,
          });
        }
      )
    );
  });
});

describe('extractText on a long range', () => {
  it('extracts a 400-page range within five seconds', { timeout: 5000 }, () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `Line ${i} of a long page, with a word broken at its end ex-`
    );
    const pages = new Map(
      Array.from({ length: 400 }, (_, i) => [i + 1, makeJournalPage(lines)])
    );
    const text = extractText(pages, at(1, 1, 0), at(400, 60, 5));
    expect(text.length).toBeGreaterThan(400 * 60 * 30);
  });
});

describe("extractText over the text content of Obsidian's pdf.js", () => {
  const article = loadTextFixture('PDF fixture');
  const layout = loadTextFixture('PDF fixture - layout');
  const noText = loadTextFixture('PDF fixture - no text');
  const hostile = loadTextFixture('PDF fixture - hostile');

  async function extract(fixture: TextFixture, start: number, end: number) {
    const pages = await readPageTexts(fixtureDocument(fixture), start, end);
    return extractText(pages, start, end);
  }

  it('reads nothing from a page that is only a picture', async () => {
    const start = at(1, 0, 0);
    const pages = await readPageTexts(fixtureDocument(noText), start, start);
    expect([...pages]).toEqual([[1, { items: [], view: [0, 0, 612, 792] }]]);
    expect(extractText(pages, start, start)).toBe('');
  });

  it('reads a paragraph across a page break, without its furniture', async () => {
    const start = anchorAt(article, 1, 'A paragraph that begins', 0);
    const end = anchorAt(article, 2, 'ends here', 61);
    expect(await extract(article, start, end)).toBe(
      'A paragraph that begins near the foot of one page is common in ' +
        'papers and books alike. Whatever reads the text has to carry the ' +
        'sentence over the page break, past the footer of this page and the ' +
        'header of the next, without mistaking either of them for part of ' +
        'the paragraph itself. It ends here, on the second page, where the ' +
        'text picks up again.'
    );
  });

  it('rejoins a hyphenated word, and ends a range mid-word', async () => {
    const start = anchorAt(article, 1, 'good snippet', 0);
    expect(
      await extract(article, start, anchorAt(article, 1, 'ple of one', 10))
    ).toBe(
      'good snippet stands on its own; a definition with its context is a ' +
        'fine example of one'
    );
    expect(
      await extract(
        article,
        anchorAt(article, 1, 'fine exam-', 5),
        anchorAt(article, 1, 'ple of one', 2)
      )
    ).toBe('exampl');
  });

  it('reads a hostile PDF as it holds its text, Markdown and all', async () => {
    const last =
      '<%* app.vault.create("Pwned.md", "") %> a_b_c costs $5, AT&T, C# and x < 5';
    const start = anchorAt(hostile, 1, '# Heading', 0);
    const end = anchorAt(hostile, 1, '<%* app', last.length);
    expect(await extract(hostile, start, end)).toBe(
      '# Heading #ir-card #ir-text-snippet ![[Secret note]] ' +
        '![t](https://e.x/t.png) [[Note|alias]] [link](https://e.x/) ' +
        '<img src=x onerror=alert(1)> &amp; (} cloze {) $x^2$ `code` ' +
        '%%hidden%% ==mark== ~~del~~ *em* _u_ {{legacy}} [^1] ^blockid\n\n' +
        '> quoted -- a callout? [!note] | table | \\ backslash\n\n' +
        '--- 1. a list - item + more\n\n' +
        last
    );
  });

  it('reads columns in turn, rejoining words across the gutter and the page', async () => {
    const start = anchorAt(layout, 1, 'A two-column page', 0);
    const end = anchorAt(layout, 2, 'A new paragraph', 35);
    expect(await extract(layout, start, end)).toBe(
      'A two-column page sets its text in narrow columns, which a reader ' +
        'takes one after the other.\n\n' +
        'The first words flow down the left column, an efficient layout, ' +
        'and a word that ends the column is hyphenated across the gutter. ' +
        'The right column then runs to the foot of the page, where its last ' +
        'sentence continues on the next page, past the page number and the ' +
        'header.\n\nA new paragraph closes the fixture.'
    );
  });
});
