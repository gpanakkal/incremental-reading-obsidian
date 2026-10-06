// Records what Obsidian's own pdf.js reads out of the fixture PDFs, for the
// unit tests of src/lib/pdf/pdf-text.ts. Run with `pnpm run fixtures:pdf-text`
// after `pnpm run fixtures:pdf`, and commit what it writes.
//
// The plugin never ships a pdf.js of its own: it uses the one bundled in
// Obsidian. That build isn't published to npm, so rather than test against a
// near version from there, this script loads the bundled one out of a local
// Obsidian install and saves its `getTextContent` output as JSON. The tests
// read the JSON, so they run anywhere; only this script needs Obsidian.
//
// Where it looks for Obsidian's `obsidian.asar`, first match wins:
//   1. $OBSIDIAN_PATH, the Obsidian install folder (holding `resources/`)
//   2. .obsidian-unpacked/obsidian.asar (see scripts/setup-obsidian.ps1)
//   3. the default install folder for this platform

import { extractFile } from '@electron/asar';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(ROOT, 'e2e-tests/setup/test-vault/sources');
const OUT_DIR = join(ROOT, 'src/test/fixtures/pdf-text');

const FIXTURES = [
  'PDF fixture.pdf',
  'PDF fixture - layout.pdf',
  'PDF fixture - no text.pdf',
  'PDF fixture - hostile.pdf',
  'PDF fixture - controls.pdf',
];

/** The options Obsidian's text layer renders with, as in pdf-text.ts. */
const TEXT_CONTENT_OPTIONS = {
  includeMarkedContent: true,
  disableNormalization: true,
};

/**
 * `json` with every invisible character written as a `\uXXXX` escape, which
 * reads back the same: a raw bidi control would reorder the file as shown.
 */
function escapeInvisible(json) {
  return json.replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, (char) =>
    Array.from(
      { length: char.length },
      (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`
    ).join('')
  );
}

function findAsar() {
  const candidates = [
    process.env.OBSIDIAN_PATH &&
      join(process.env.OBSIDIAN_PATH, 'resources/obsidian.asar'),
    join(ROOT, '.obsidian-unpacked/obsidian.asar'),
    {
      win32: 'C:/Program Files/Obsidian/resources/obsidian.asar',
      darwin: '/Applications/Obsidian.app/Contents/Resources/obsidian.asar',
      linux: '/opt/Obsidian/resources/obsidian.asar',
    }[process.platform],
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `No obsidian.asar found; set OBSIDIAN_PATH. Looked in:\n${candidates.join('\n')}`
    );
  }
  return found;
}

const asar = findAsar();
// Undocumented Obsidian internals, as of 1.13.7: the asar keeps pdf.js under
// lib/pdfjs/ (pdf.min.mjs, pdf.worker.min.mjs) with its build in version.json
const version = JSON.parse(
  extractFile(asar, join('lib', 'pdfjs', 'version.json')).toString('utf8')
);
const obsidianVersion = JSON.parse(
  extractFile(asar, 'package.json').toString('utf8')
).version;

// pdf.js loads as an ES module, so it has to sit in a file of its own
const dir = await mkdtemp(join(tmpdir(), 'obsidian-pdfjs-'));
try {
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    await writeFile(join(dir, name), extractFile(asar, join('lib', 'pdfjs', name)));
  }
  // Only rendering uses DOMMatrix, but pdf.js wants one to load in Node
  globalThis.DOMMatrix ??= class DOMMatrix {};
  const pdfjs = await import(pathToFileURL(join(dir, 'pdf.min.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(dir, 'pdf.worker.min.mjs')
  ).href;

  await mkdir(OUT_DIR, { recursive: true });
  for (const name of FIXTURES) {
    const data = new Uint8Array(await readFile(join(SOURCES, name)));
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false })
      .promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent(TEXT_CONTENT_OPTIONS);
      pages.push({ view: page.view, items });
    }
    await doc.destroy();
    const out = join(OUT_DIR, `${basename(name, '.pdf')}.json`);
    const json = {
      source: `e2e-tests/setup/test-vault/sources/${name}`,
      obsidian: obsidianVersion,
      pdfjs: version,
      getTextContent: TEXT_CONTENT_OPTIONS,
      pages,
    };
    await writeFile(out, `${escapeInvisible(JSON.stringify(json, null, 2))}\n`);
    console.log(`wrote ${out}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
