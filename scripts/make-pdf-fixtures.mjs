// Writes the PDF fixtures the e2e tests import, into the test vault's
// `sources` folder. Run with `pnpm run fixtures:pdf`; commit what it writes.
//
// The PDFs are written by hand rather than through a library: they need only
// the standard Helvetica font, uncompressed page streams and one raw image,
// and a writer this small has no dependency to vet and nothing that stamps
// the time or a random id into the file. The same script always writes the
// same bytes, so a regenerated fixture shows up in git only when this changes.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../e2e-tests/setup/test-vault/sources'
);

/** US Letter, in PDF points. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_LEFT = 72;

const BODY_SIZE = 11;
const LEADING = 15;
const BODY_TOP = 700;

/** Escape text for a PDF literal string. */
function pdfString(text) {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/**
 * A PDF with `objects` as its numbered objects (1-based, in order), `root`
 * the object number of its catalog. Each object is a string or, for a stream,
 * `{ dict, data }` with `data` a Buffer.
 */
function buildPdf(objects, root) {
  const chunks = [];
  let length = 0;
  const push = (chunk) => {
    const buffer =
      typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    chunks.push(buffer);
    length += buffer.length;
  };

  // The second line's high bytes mark the file as binary to transfer tools
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    if (typeof object === 'string') {
      push(object);
    } else {
      push(`${object.dict.slice(0, -2)}/Length ${object.data.length}>>\n`);
      push('stream\n');
      push(object.data);
      push('\nendstream');
    }
    push('\nendobj\n');
  });

  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  // A fixed ID, where a writer would normally hash the time into one
  const id = '<49524649585455524530303030303031>';
  push(
    `trailer\n<</Size ${objects.length + 1}/Root ${root} 0 R/ID[${id}${id}]>>\n`
  );
  push(`startxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/**
 * A content stream's text object: `lines` from (x, y) down, one per line. An
 * empty line only moves down, as a gap between paragraphs does in a real PDF.
 */
function textBlock(lines, { x, y, size, leading = LEADING }) {
  const shown = lines
    .map((line) => (line === '' ? '' : `${pdfString(line)} Tj`))
    .join(' T*\n');
  return `BT\n/F1 ${size} Tf\n${leading} TL\n${x} ${y} Td\n${shown}\nET\n`;
}

/**
 * The main fixture: three pages of body text under a running header, with a
 * page-numbered footer. Its lines end without trailing spaces, so words at
 * line ends run together when lines are joined naively. Page 1 breaks
 * "exam-" / "ple" across two lines, and the third paragraph runs from the
 * foot of page 1 onto page 2.
 */
const ARTICLE_PAGES = [
  [
    'Incremental reading turns a long text into a series of short reviews.',
    'Each review reads a little, keeps what matters, and schedules the rest',
    'for later, so a reader works through many texts at once.',
    '',
    'Extracting the passages worth keeping is the heart of the method. A',
    'good snippet stands on its own; a definition with its context is a',
    'fine exam-',
    'ple of one, and it is ready to become a card the moment it is clear.',
    '',
    'A paragraph that begins near the foot of one page is common in papers',
    'and books alike. Whatever reads the text has to carry the sentence over',
    'the page break, past the footer of this page and the header of the next,',
  ],
  [
    'without mistaking either of them for part of the paragraph itself. It',
    'ends here, on the second page, where the text picks up again.',
    '',
    'Priority decides how soon an article comes back. A high priority keeps',
    'it close; a low one lets the interval grow quickly, so the reader sees',
    'it rarely until it has earned more attention.',
    '',
    'Cards are reviewed on their own schedule, which spaces each repetition',
    'further apart as the answer becomes easier to recall.',
  ],
  [
    'The third page closes the fixture. It holds one last paragraph, so',
    'that every test reading this file has text on each of its pages.',
  ],
];

const HEADER = 'Journal of Incremental Reading Fixtures';

/** A PDF of one page per content stream, all set in `font` as `/F1`. */
function pagesPdf(contents, font) {
  // 1 catalog, 2 page tree, 3 font, then a page and its contents per page
  const pageNumbers = contents.map((_, i) => 4 + i * 2);
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pageNumbers.map((n) => `${n} 0 R`).join(' ')}]/Count ${contents.length}>>`,
    font,
  ];
  contents.forEach((content, i) => {
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
        `/Resources<</Font<</F1 3 0 R>>>>/Contents ${pageNumbers[i] + 1} 0 R>>`,
      { dict: '<<>>', data: Buffer.from(content, 'latin1') }
    );
  });
  return buildPdf(objects, 1);
}

const HELVETICA =
  '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>';

function articlePdf() {
  const pageCount = ARTICLE_PAGES.length;
  return pagesPdf(
    ARTICLE_PAGES.map(
      (lines, i) =>
        textBlock([HEADER], { x: MARGIN_LEFT, y: 750, size: 9 }) +
        textBlock(lines, { x: MARGIN_LEFT, y: BODY_TOP, size: BODY_SIZE }) +
        textBlock([`Page ${i + 1} of ${pageCount}`], {
          x: 280,
          y: 40,
          size: 9,
        })
    ),
    HELVETICA
  );
}

/**
 * Codes WinAnsiEncoding leaves unused, given to Helvetica's "fi" and "fl"
 * ligature glyphs, which pdf.js reads as U+FB01 and U+FB02.
 */
const FI = String.fromCharCode(0x81);
const FL = String.fromCharCode(0x8d);

const LAYOUT_COLUMN_SIZE = 10;
const LAYOUT_COLUMN_LEADING = 13;

/**
 * Text set the way papers set it. Page 1 has two columns, read down the left
 * one and then the right one; a word is hyphenated across the gutter, and
 * another across the page break. Ligatures stand in for "fi" and "fl". Each
 * page has the same running header, and a bare page number for a footer.
 */
const LAYOUT_PAGES = [
  [
    [
      'A two-column page sets its text in',
      'narrow columns, which a reader takes',
      'one after the other.',
      '',
      `The ${FI}rst words ${FL}ow down the left`,
      `column, an ef${FI}cient layout, and a`,
      'word that ends the column is hy-',
    ],
    [
      'phenated across the gutter. The right',
      'column then runs to the foot of the',
      'page, where its last sentence con-',
    ],
  ],
  [
    [
      'tinues on the next page, past the page number and the header.',
      '',
      'A new paragraph closes the fixture.',
    ],
  ],
];

const LAYOUT_HEADER = 'Proceedings of the Fixture Society';

function layoutPdf() {
  const columnX = [MARGIN_LEFT, 318];
  return pagesPdf(
    LAYOUT_PAGES.map(
      (columns, i) =>
        textBlock([LAYOUT_HEADER], { x: MARGIN_LEFT, y: 750, size: 9 }) +
        columns
          .map((lines, column) =>
            textBlock(lines, {
              x: columnX[column],
              y: BODY_TOP,
              size: LAYOUT_COLUMN_SIZE,
              leading: LAYOUT_COLUMN_LEADING,
            })
          )
          .join('') +
        textBlock([`${i + 1}`], { x: 303, y: 40, size: 9 })
    ),
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica' +
      `/Encoding<</Type/Encoding/BaseEncoding/WinAnsiEncoding/Differences[${FI.charCodeAt(0)}/fi ${FL.charCodeAt(0)}/fl]>>>>`
  );
}

/**
 * A one-page PDF with no text layer: only a picture, as a scan would be. An
 * 8x8 grayscale checkerboard, drawn large.
 */
function imageOnlyPdf() {
  const side = 8;
  const pixels = Buffer.alloc(side * side);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      pixels[y * side + x] = (x + y) % 2 === 0 ? 0x20 : 0xe0;
    }
  }
  const draw = `q\n400 0 0 400 106 196 cm\n/Im1 Do\nQ\n`;
  return buildPdf(
    [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
        '/Resources<</XObject<</Im1 5 0 R>>>>/Contents 4 0 R>>',
      { dict: '<<>>', data: Buffer.from(draw, 'latin1') },
      {
        dict:
          `<</Type/XObject/Subtype/Image/Width ${side}/Height ${side}` +
          '/ColorSpace/DeviceGray/BitsPerComponent 8>>',
        data: pixels,
      },
    ],
    1
  );
}

/**
 * Text a hostile PDF could carry into a note made of it: embeds, links, the
 * plugin's own tags, HTML, cloze delimiters, a Templater command and every
 * other kind of Markdown and Obsidian syntax, as four paragraphs on one page,
 * each starting with what Markdown reads at the start of a line.
 */
const HOSTILE_PARAGRAPHS = [
  [
    '# Heading #ir-card #ir-text-snippet ![[Secret note]] ![t](https://e.x/t.png)',
    '[[Note|alias]] [link](https://e.x/) <img src=x onerror=alert(1)> &amp; (} cloze {)',
    '$x^2$ `code` %%hidden%% ==mark== ~~del~~ *em* _u_ {{legacy}} [^1] ^blockid',
  ],
  ['> quoted -- a callout? [!note] | table | \\ backslash'],
  ['--- 1. a list - item + more'],
  ['<%* app.vault.create("Pwned.md", "") %> a_b_c costs $5, AT&T, C# and x < 5'],
];

function hostilePdf() {
  const lines = HOSTILE_PARAGRAPHS.flatMap((paragraph, i) =>
    i === 0 ? paragraph : ['', ...paragraph]
  );
  return pagesPdf(
    [textBlock(lines, { x: MARGIN_LEFT, y: BODY_TOP, size: 8 })],
    HELVETICA
  );
}

/**
 * Codes WinAnsiEncoding leaves unused, given to Helvetica's "d" and "f"
 * glyphs. The controls fixture's ToUnicode CMap reads the first as "d" and a
 * tab, the second as U+202E, the right-to-left override, and "f".
 *
 * Obsidian's pdf.js reads a glyph that maps to a tab alone as a space, and
 * drops one that maps to a bidi control alone, so neither reaches a note that
 * way; a glyph that maps to a control and a letter keeps both.
 */
const D_TAB = String.fromCharCode(0x81);
const RLO_F = String.fromCharCode(0x8d);

const hex = (code) => code.toString(16).toUpperCase().padStart(2, '0');

/** Every printable ASCII code reads as itself, and `D_TAB` and `RLO_F` as above. */
const CONTROLS_TO_UNICODE = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def',
  '/CMapName /Adobe-Identity-UCS def',
  '/CMapType 2 def',
  '1 begincodespacerange',
  '<00> <FF>',
  'endcodespacerange',
  '1 beginbfrange',
  '<20> <7E> <0020>',
  'endbfrange',
  '2 beginbfchar',
  `<${hex(D_TAB.charCodeAt(0))}> <00640009>`,
  `<${hex(RLO_F.charCodeAt(0))}> <202E0066>`,
  'endbfchar',
  'endcmap',
  'CMapName currentdict /CIDInit /ProcSet findresource exch defineresource pop',
  'end',
  'end',
].join('\n');

/**
 * A line whose text holds a tab and a right-to-left override, as pdf.js reads
 * it: "Tabbed", a tab, "here report", the override, "fdp.exe". Named after
 * it, a snippet or card would get a note name that can't be created on
 * Windows and Android, and that shows as "...reportexe.pdf".
 */
const CONTROLS_LINE = `Tabbe${D_TAB}here report${RLO_F}dp.exe`;

function controlsPdf() {
  // 1 catalog, 2 page tree, 3 font, 4 page, 5 its contents, 6 the CMap
  const content = textBlock([CONTROLS_LINE], {
    x: MARGIN_LEFT,
    y: BODY_TOP,
    size: BODY_SIZE,
  });
  return buildPdf(
    [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[4 0 R]/Count 1>>',
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica' +
        '/Encoding<</Type/Encoding/BaseEncoding/WinAnsiEncoding' +
        `/Differences[${D_TAB.charCodeAt(0)}/d ${RLO_F.charCodeAt(0)}/f]>>` +
        '/ToUnicode 6 0 R>>',
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
        '/Resources<</Font<</F1 3 0 R>>>>/Contents 5 0 R>>',
      { dict: '<<>>', data: Buffer.from(content, 'latin1') },
      { dict: '<<>>', data: Buffer.from(CONTROLS_TO_UNICODE, 'latin1') },
    ],
    1
  );
}

const FIXTURES = {
  'PDF fixture.pdf': articlePdf,
  'PDF fixture - no text.pdf': imageOnlyPdf,
  'PDF fixture - layout.pdf': layoutPdf,
  'PDF fixture - hostile.pdf': hostilePdf,
  'PDF fixture - controls.pdf': controlsPdf,
};

await mkdir(OUT_DIR, { recursive: true });
for (const [name, build] of Object.entries(FIXTURES)) {
  const path = join(OUT_DIR, name);
  await writeFile(path, build());
  console.log(`wrote ${path}`);
}
