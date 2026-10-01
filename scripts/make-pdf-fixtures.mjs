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

function articlePdf() {
  const pageCount = ARTICLE_PAGES.length;
  // 1 catalog, 2 page tree, 3 font, then a page and its contents per page
  const pageNumbers = ARTICLE_PAGES.map((_, i) => 4 + i * 2);
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pageNumbers.map((n) => `${n} 0 R`).join(' ')}]/Count ${pageCount}>>`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
  ];
  ARTICLE_PAGES.forEach((lines, i) => {
    const content =
      textBlock([HEADER], { x: MARGIN_LEFT, y: 750, size: 9 }) +
      textBlock(lines, { x: MARGIN_LEFT, y: BODY_TOP, size: BODY_SIZE }) +
      textBlock([`Page ${i + 1} of ${pageCount}`], {
        x: 280,
        y: 40,
        size: 9,
      });
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
        `/Resources<</Font<</F1 3 0 R>>>>/Contents ${pageNumbers[i] + 1} 0 R>>`,
      { dict: '<<>>', data: Buffer.from(content, 'latin1') }
    );
  });
  return buildPdf(objects, 1);
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

const FIXTURES = {
  'PDF fixture.pdf': articlePdf,
  'PDF fixture - no text.pdf': imageOnlyPdf,
};

await mkdir(OUT_DIR, { recursive: true });
for (const [name, build] of Object.entries(FIXTURES)) {
  const path = join(OUT_DIR, name);
  await writeFile(path, build());
  console.log(`wrote ${path}`);
}
