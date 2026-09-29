import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDITABLE_TEXT_MIME_TYPES,
  FRONTMATTER_MIME_TYPES,
  getMimeType,
  IMPORTABLE_MIME_TYPES,
  isEditableText,
  isImportable,
  sniffMimeType,
  supportsFrontmatter,
} from './mime';

// #region HELPERS

/** The helpers read only the extension off a file. */
function makeFile(extension: string): TFile {
  return { extension } as TFile;
}

/** The types the table knows, keyed by their lowercase extension. */
const KNOWN = { md: 'text/markdown', pdf: 'application/pdf' } as const;

/**
 * Any extension a vault file could carry: a known one in any casing, or any
 * string at all, which includes the empty one of a file with no extension and
 * names like `constructor` that live on `Object.prototype`.
 */
const extensionArb = fc.oneof(
  fc.mixedCase(fc.constantFrom(...Object.keys(KNOWN))),
  fc.string(),
  fc.constantFrom('constructor', 'toString', '__proto__', 'markdown', 'txt')
);

/** `%PDF-`, the header every PDF opens with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

const bytesOf = (text: string) => new TextEncoder().encode(text);

/** An app whose vault hands back `bytes` for any file, counting the reads. */
function makeApp(bytes: Uint8Array) {
  const readBinary = vi.fn((_file: TFile) =>
    // A fresh buffer holding exactly `bytes`, whatever view it came from.
    Promise.resolve(bytes.slice().buffer)
  );
  return { app: { vault: { readBinary } }, readBinary };
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getMimeType', () => {
  it.each([
    ['md', 'text/markdown'],
    ['MD', 'text/markdown'],
    ['pdf', 'application/pdf'],
    ['PDF', 'application/pdf'],
    ['png', null],
    ['', null],
  ])('maps the extension %j to %j', (extension, expected) => {
    expect(getMimeType(makeFile(extension))).toBe(expected);
  });

  it('knows only its own extensions, in any casing', () => {
    fc.assert(
      fc.property(extensionArb, (extension) => {
        const lower = extension.toLowerCase();
        const expected =
          lower === 'md' || lower === 'pdf' ? KNOWN[lower] : null;

        expect(getMimeType(makeFile(extension))).toBe(expected);
      })
    );
  });
});

describe('sniffMimeType', () => {
  it.each([
    [
      'a real PDF',
      'pdf',
      [...PDF_MAGIC, ...bytesOf('1.7\n%âãÏÓ\n')],
      'application/pdf',
    ],
    [
      'a PDF that is nothing but its header',
      'PDF',
      PDF_MAGIC,
      'application/pdf',
    ],
    ['markdown text', 'md', [...bytesOf('# Title\n\nBody')], 'text/markdown'],
    ['an empty note', 'md', [], 'text/markdown'],
    ['a .pdf holding text', 'pdf', [...bytesOf('# Title')], null],
    ['an empty .pdf', 'pdf', [], null],
    ['a .pdf cut off inside its header', 'pdf', PDF_MAGIC.slice(0, 4), null],
    ['a .md holding a PDF', 'md', [...PDF_MAGIC, ...bytesOf('1.7')], null],
    ['an unknown extension', 'png', [...PDF_MAGIC], null],
  ])('reads %s as %j', async (_label, extension, bytes, expected) => {
    const { app } = makeApp(Uint8Array.from(bytes));

    await expect(sniffMimeType(app, makeFile(extension))).resolves.toBe(
      expected
    );
  });

  it('agrees with the table only when the content bears it out', async () => {
    // Any content at all, half the time behind a PDF header so the signature
    // branch is exercised as often as the text one.
    const contentArb = fc
      .tuple(fc.boolean(), fc.uint8Array())
      .map(([pdf, rest]) =>
        pdf ? Uint8Array.from([...PDF_MAGIC, ...rest]) : rest
      );
    await fc.assert(
      fc.asyncProperty(extensionArb, contentArb, async (extension, bytes) => {
        const { app, readBinary } = makeApp(bytes);
        const file = makeFile(extension);
        const table = getMimeType(file);
        const isPdf = PDF_MAGIC.every((byte, i) => bytes[i] === byte);
        const expected =
          table === (isPdf ? 'application/pdf' : 'text/markdown')
            ? table
            : null;

        await expect(sniffMimeType(app, file)).resolves.toBe(expected);
        // One read of a file the table knows; none of one it doesn't.
        expect(readBinary.mock.calls).toEqual(table === null ? [] : [[file]]);
      })
    );
  });
});

describe('capabilities', () => {
  const CAPABILITIES = [
    ['supportsFrontmatter', supportsFrontmatter, FRONTMATTER_MIME_TYPES],
    ['isEditableText', isEditableText, EDITABLE_TEXT_MIME_TYPES],
    ['isImportable', isImportable, IMPORTABLE_MIME_TYPES],
  ] as const;

  it.each(CAPABILITIES)(
    '%s holds only markdown, the one type Obsidian parses frontmatter of',
    (_name, _has, types) => {
      // Importing a PDF lands with task 0009, which adds it to the import set.
      expect([...types]).toEqual(['text/markdown']);
    }
  );

  it.each(CAPABILITIES)(
    '%s is true of a file exactly when its type is in the set',
    (_name, has, types) => {
      fc.assert(
        fc.property(extensionArb, (extension) => {
          const file = makeFile(extension);
          const type = getMimeType(file);

          expect(has(file)).toBe(type !== null && types.has(type));
        })
      );
    }
  );

  it.each(CAPABILITIES)('%s holds for a note and not a PDF', (_name, has) => {
    expect(has(makeFile('md'))).toBe(true);
    expect(has(makeFile('pdf'))).toBe(false);
  });
});
