import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPY_IMPORTABLE_MIME_TYPES,
  EDITABLE_TEXT_MIME_TYPES,
  extensionOfPath,
  FRONTMATTER_MIME_TYPES,
  getMimeType,
  IMPORTABLE_MIME_TYPES,
  isCopyImportable,
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

/**
 * Any content at all, half the time behind a PDF header so the signature
 * branch is exercised as often as the text one.
 */
const contentArb = fc
  .tuple(fc.boolean(), fc.uint8Array())
  .map(([pdf, rest]) =>
    pdf ? Uint8Array.from([...PDF_MAGIC, ...rest]) : rest
  );

/**
 * Any way a response body could be cut into chunks: the sizes of the first
 * few, empty ones included, and the rest of the body in one last chunk.
 */
const chunkSizesArb = fc.array(fc.nat({ max: 8 }), { maxLength: 6 });

/**
 * What `sniffMimeType` made of a file when it read all of it: the table's
 * type, when the content opens with that type's signature or, for text, with
 * none.
 */
function sniffWhole(extension: string, bytes: Uint8Array): string | null {
  const table = getMimeType(makeFile(extension));
  const isPdf = PDF_MAGIC.every((byte, i) => bytes[i] === byte);
  return table === (isPdf ? 'application/pdf' : 'text/markdown') ? table : null;
}

/** The most leading bytes any signature needs: `%PDF-`'s length. */
const SIGNATURE_LENGTH = PDF_MAGIC.length;

/** A file whose vault metadata says it holds `size` bytes. */
function makeSizedFile(extension: string, size: number): TFile {
  return { extension, path: `a.${extension}`, stat: { size } } as TFile;
}

/** Where the fake vault serves every file from. */
const RESOURCE_URL = 'app://vault/a?1700000000000';

/**
 * An app whose vault hands back `bytes` for any file, counting the reads, and
 * serves every file at {@link RESOURCE_URL}.
 */
function makeApp(bytes: Uint8Array) {
  const readBinary = vi.fn((_file: TFile) =>
    // A fresh buffer holding exactly `bytes`, whatever view it came from.
    Promise.resolve(bytes.slice().buffer)
  );
  const getResourcePath = vi.fn((_file: TFile) => RESOURCE_URL);
  return { app: { vault: { readBinary, getResourcePath } }, readBinary };
}

/** The chunks a body of `body` arrives in: `sizes` first, then the rest. */
function chunksOf(body: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= body.length) break;
    chunks.push(body.slice(at, at + size));
    at += size;
  }
  if (at < body.length) chunks.push(body.slice(at));
  return chunks;
}

/**
 * The reads it takes to get `length` bytes out of `chunks`, or, when they hold
 * fewer, to find that they have ended.
 */
function readsToGet(length: number, chunks: readonly Uint8Array[]): number {
  let got = 0;
  for (const [i, chunk] of chunks.entries()) {
    got += chunk.length;
    if (got >= length) return i + 1;
  }
  return chunks.length + 1;
}

/**
 * A response body that hands out `chunks` one per read, recording how many
 * times it was pulled and whether it was cancelled. Nothing is pulled ahead of
 * a read, so the pulls are exactly the reads that reached it.
 */
function bodyOf(chunks: readonly Uint8Array[]) {
  const log = { pulls: 0, cancelled: false };
  let next = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        log.pulls += 1;
        if (next < chunks.length) controller.enqueue(chunks[next++]);
        else controller.close();
      },
      cancel() {
        log.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, log };
}

/**
 * Serve `bytes` to `fetch`, in chunks of `chunkSizes` then the rest. With
 * `honorsRange`, as desktop's `app://` handler does: a `206` holding the range
 * asked for, or a `416` for one that runs past the end of the file. Without
 * it, a `200` holding the whole file whatever was asked for.
 */
function serve(
  bytes: Uint8Array,
  {
    honorsRange,
    chunkSizes = [],
  }: { honorsRange: boolean; chunkSizes?: readonly number[] }
) {
  const requests: { url: string; range: string | null }[] = [];
  const bodies: ReturnType<typeof bodyOf>['log'][] = [];
  const respond = (status: number, body: Uint8Array) => {
    const { stream, log } = bodyOf(chunksOf(body, chunkSizes));
    bodies.push(log);
    return new Response(stream, { status });
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) => {
      const range = new Headers(init?.headers).get('Range');
      requests.push({
        url: input instanceof Request ? input.url : input.toString(),
        range,
      });
      const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!honorsRange || match === null) {
        return Promise.resolve(respond(200, bytes));
      }
      const [start, end] = [Number(match[1]), Number(match[2])];
      if (end > bytes.length - 1 || end < start) {
        return Promise.resolve(respond(416, new Uint8Array()));
      }
      return Promise.resolve(respond(206, bytes.slice(start, end + 1)));
    });
  return { fetch, requests, bodies };
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extensionOfPath', () => {
  it.each([
    ['a.pdf', 'pdf'],
    ['notes/a.MD', 'MD'],
    ['a.tar.gz', 'gz'],
    ['folder.d/file', ''],
    ['noext', ''],
    ['trailing.', ''],
  ])('takes %j to have the extension %j', (path, expected) => {
    expect(extensionOfPath(path)).toBe(expected);
  });

  it('reads the extension off the name alone, whatever folders it sits in', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 3 }),
        fc
          .string()
          .filter((name) => !name.includes('/') && !name.includes('.')),
        fc.string().filter((ext) => !ext.includes('/') && !ext.includes('.')),
        (folders, name, extension) => {
          const path = [...folders, `${name}.${extension}`].join('/');

          expect(extensionOfPath(path)).toBe(extension);
        }
      )
    );
  });
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
  it('asks for only the leading bytes a signature needs, and stops reading once it has them', async () => {
    const bytes = Uint8Array.from([...PDF_MAGIC, ...new Uint8Array(1000)]);
    const { app, readBinary } = makeApp(bytes);
    // A server that ignores the range, sending the file in chunks
    const server = serve(bytes, { honorsRange: false, chunkSizes: [3, 4] });

    await expect(
      sniffMimeType(app, makeSizedFile('pdf', bytes.length))
    ).resolves.toBe('application/pdf');

    expect(server.requests).toEqual([
      { url: RESOURCE_URL, range: `bytes=0-${SIGNATURE_LENGTH - 1}` },
    ]);
    // The second chunk completes the signature; nothing after it is read
    expect(server.bodies).toEqual([{ pulls: 2, cancelled: true }]);
    expect(readBinary).not.toHaveBeenCalled();
  });

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
    for (const honorsRange of [true, false]) {
      const content = Uint8Array.from(bytes);
      const { app } = makeApp(content);
      serve(content, { honorsRange });

      await expect(
        sniffMimeType(app, makeSizedFile(extension, content.length))
      ).resolves.toBe(expected);
    }
  });

  it('asks for the signature alone, and reads no further than it or the end', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.mixedCase(fc.constantFrom(...Object.keys(KNOWN))),
        contentArb,
        fc.boolean(),
        chunkSizesArb,
        fc.nat({ max: 24 }),
        async (extension, bytes, honorsRange, chunkSizes, statSize) => {
          const { app, readBinary } = makeApp(bytes);
          const server = serve(bytes, { honorsRange, chunkSizes });
          const short = bytes.length < SIGNATURE_LENGTH;
          // What came back: the signature's bytes; a refusal, with nothing
          // read of it, for a file too short to hold them; or the whole file
          const sent = honorsRange
            ? short
              ? null
              : bytes.slice(0, SIGNATURE_LENGTH)
            : bytes;

          await sniffMimeType(app, makeSizedFile(extension, statSize));

          expect(server.requests).toEqual([
            { url: RESOURCE_URL, range: `bytes=0-${SIGNATURE_LENGTH - 1}` },
          ]);
          expect(server.bodies).toEqual([
            sent === null
              ? { pulls: 0, cancelled: false }
              : {
                  pulls: readsToGet(
                    SIGNATURE_LENGTH,
                    chunksOf(sent, chunkSizes)
                  ),
                  // Left open only when it ended before the signature could
                  cancelled: !short,
                },
          ]);
          // Too short to hold a signature: read whole, which is cheap
          expect(readBinary).toHaveBeenCalledTimes(short ? 1 : 0);
        }
      )
    );
  });

  it('reads the whole file once, as before, when the leading bytes cannot be fetched', async () => {
    /** Every way the fetch can fail to hand back a body to read. */
    const failures: Record<string, () => Promise<Response>> = {
      'fetch rejects': () => Promise.reject(new TypeError('Failed to fetch')),
      'range not satisfiable': () =>
        Promise.resolve(new Response('Range Not Satisfiable', { status: 416 })),
      'not found': () =>
        Promise.resolve(new Response('Not Found', { status: 404 })),
      'server error': () =>
        Promise.resolve(new Response('Internal error', { status: 500 })),
      'no body': () => Promise.resolve(new Response(null, { status: 200 })),
      'no partial body': () =>
        Promise.resolve(new Response(null, { status: 206 })),
      'body fails partway': () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new TypeError('network error'));
              },
            }),
            { status: 200 }
          )
        ),
    };
    await fc.assert(
      fc.asyncProperty(
        fc.mixedCase(fc.constantFrom(...Object.keys(KNOWN))),
        contentArb.filter((bytes) => bytes.length > 0),
        fc.constantFrom(...Object.keys(failures)),
        async (extension, bytes, failure) => {
          const { app, readBinary } = makeApp(bytes);
          vi.spyOn(globalThis, 'fetch').mockImplementation(failures[failure]);
          const file = makeSizedFile(extension, bytes.length);

          await expect(sniffMimeType(app, file)).resolves.toBe(
            sniffWhole(extension, bytes)
          );
          expect(readBinary.mock.calls).toEqual([[file]]);
        }
      )
    );
  });

  it('shrugs off a body that fails to cancel once the signature is in', async () => {
    const bytes = Uint8Array.from([...PDF_MAGIC, 0x31]);
    const { app, readBinary } = makeApp(bytes);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(bytes);
          },
          cancel() {
            throw new TypeError('cannot cancel');
          },
        }),
        { status: 200 }
      )
    );

    await expect(
      sniffMimeType(app, makeSizedFile('pdf', bytes.length))
    ).resolves.toBe('application/pdf');
    expect(readBinary).not.toHaveBeenCalled();
    // A rejection left unhandled would surface after the test, failing it
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it.each([
    ['md', 'text/markdown'],
    ['pdf', null],
  ])(
    'reads an empty .%s whole once the range is refused, giving %j',
    async (extension, expected) => {
      const { app, readBinary } = makeApp(new Uint8Array());
      const file = makeSizedFile(extension, 0);
      const server = serve(new Uint8Array(), { honorsRange: true });

      await expect(sniffMimeType(app, file)).resolves.toBe(expected);

      expect(server.requests).toEqual([
        { url: RESOURCE_URL, range: `bytes=0-${SIGNATURE_LENGTH - 1}` },
      ]);
      expect(readBinary.mock.calls).toEqual([[file]]);
    }
  );

  it('knows a PDF that has grown since the vault last saw its size by its leading bytes alone', async () => {
    // Still being written, say, when the vault last looked at it
    const bytes = Uint8Array.from([...PDF_MAGIC, ...bytesOf('1.7 ')]);
    const { app, readBinary } = makeApp(bytes);
    const server = serve(bytes, { honorsRange: true });

    await expect(sniffMimeType(app, makeSizedFile('pdf', 3))).resolves.toBe(
      'application/pdf'
    );
    expect(server.requests).toEqual([
      { url: RESOURCE_URL, range: `bytes=0-${SIGNATURE_LENGTH - 1}` },
    ]);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('reads a file the same as the whole of it would, however it is served', async () => {
    await fc.assert(
      fc.asyncProperty(
        extensionArb,
        contentArb,
        fc.boolean(),
        chunkSizesArb,
        // The size the vault last saw, which the file may since have grown
        // or shrunk from
        fc.oneof(fc.constant(0), fc.nat({ max: 24 })),
        async (extension, bytes, honorsRange, chunkSizes, statSize) => {
          const { app, readBinary } = makeApp(bytes);
          const server = serve(bytes, { honorsRange, chunkSizes });
          const known = getMimeType(makeFile(extension)) !== null;
          // Too short to hold a signature: read whole, which is cheap
          const short = bytes.length < SIGNATURE_LENGTH;

          await expect(
            sniffMimeType(app, makeSizedFile(extension, statSize))
          ).resolves.toBe(sniffWhole(extension, bytes));
          expect(server.requests).toHaveLength(known ? 1 : 0);
          expect(readBinary).toHaveBeenCalledTimes(known && short ? 1 : 0);
        }
      )
    );
  });
});

describe('capabilities', () => {
  const CAPABILITIES = [
    ['supportsFrontmatter', supportsFrontmatter, FRONTMATTER_MIME_TYPES],
    ['isEditableText', isEditableText, EDITABLE_TEXT_MIME_TYPES],
    ['isImportable', isImportable, IMPORTABLE_MIME_TYPES],
    ['isCopyImportable', isCopyImportable, COPY_IMPORTABLE_MIME_TYPES],
  ] as const;

  /** The capabilities a PDF can import by: as an article, and as a copy. */
  const IMPORTS = new Set(['isImportable', 'isCopyImportable']);

  /** The capabilities only a note has: a PDF has none of them yet. */
  const NOTE_ONLY = CAPABILITIES.filter(([name]) => !IMPORTS.has(name));

  it.each(NOTE_ONLY)(
    '%s holds only markdown, the one type Obsidian parses frontmatter of',
    (_name, _has, types) => {
      expect([...types]).toEqual(['text/markdown']);
    }
  );

  it.each([
    ['IMPORTABLE_MIME_TYPES', IMPORTABLE_MIME_TYPES],
    ['COPY_IMPORTABLE_MIME_TYPES', COPY_IMPORTABLE_MIME_TYPES],
  ])('%s holds a note and a PDF, and nothing else', (_name, types) => {
    expect([...types]).toEqual(['text/markdown', 'application/pdf']);
  });

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

  it.each(NOTE_ONLY)('%s holds for a note and not a PDF', (_name, has) => {
    expect(has(makeFile('md'))).toBe(true);
    expect(has(makeFile('pdf'))).toBe(false);
  });

  it('can import a PDF in place and as a copy', () => {
    expect(isImportable(makeFile('pdf'))).toBe(true);
    expect(isCopyImportable(makeFile('pdf'))).toBe(true);
  });
});
