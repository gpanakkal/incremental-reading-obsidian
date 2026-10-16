import { DATA_DIRECTORY } from '#/lib/constants';
import type { ExplorerComparator } from '#/lib/explorer-order';
import fc from 'fast-check';
import { TFile, TFolder, type TAbstractFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  folderSource,
  isImportCandidate,
  type CandidateChecks,
} from './candidates';
import type { ScanEvent } from './types';

// #region HELPERS
/** What a note opens with: no binary format's signature. */
const NOTE_BYTES = new TextEncoder().encode('# Content');
/** What a PDF opens with. */
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%\n1 0 obj');

/** One file of a generated folder, and everything that decides its fate. */
interface FileSpec {
  name: string;
  extension: string;
  /** Its bytes open as a PDF's do, whatever its extension says. */
  pdfBytes: boolean;
  /** Its cached frontmatter `ir-id`, if any. */
  irId: unknown;
  /** A live item row is at its path. */
  hasRow: boolean;
}

function makeFolder(path: string): TFolder {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign(new TFolder(), { path, name });
}

function makeFile(folder: TFolder, spec: FileSpec): TFile {
  const name = spec.extension ? `${spec.name}.${spec.extension}` : spec.name;
  return Object.assign(new TFile(), {
    path: folder.path === '/' ? name : `${folder.path}/${name}`,
    name,
    basename: spec.name,
    extension: spec.extension,
    parent: folder,
  });
}

/**
 * The checks a scan runs, over `specs` keyed by path: their bytes, their
 * cached frontmatter and their rows.
 */
function makeChecks(specs: ReadonlyMap<string, FileSpec>) {
  const readBinary = vi.fn(async (file: TFile) => {
    const spec = specs.get(file.path);
    return (spec?.pdfBytes ? PDF_BYTES : NOTE_BYTES).slice().buffer;
  });
  const checks: CandidateChecks = {
    app: {
      vault: {
        readBinary,
        getResourcePath: (file: TFile) => `app://vault/${file.path}`,
      },
      metadataCache: {
        getFileCache: (file: TFile) => {
          const spec = specs.get(file.path);
          return spec && spec.irId !== undefined
            ? { frontmatter: { 'ir-id': spec.irId } }
            : null;
        },
      },
    } as never,
    isItemAtPath: vi.fn((file: TFile) => specs.get(file.path)?.hasRow ?? false),
  };
  return { checks, readBinary };
}

/** Whether `spec`, wherever it is, is a file a folder import should list. */
function eligible(spec: FileSpec, inDataDirectory: boolean): boolean {
  if (inDataDirectory) return false;
  const extension = spec.extension.toLowerCase();
  if (extension === 'md')
    return typeof spec.irId !== 'string' && !spec.pdfBytes;
  if (extension === 'pdf') return !spec.hasRow && spec.pdfBytes;
  return false;
}

async function collect(events: AsyncIterable<ScanEvent>): Promise<ScanEvent[]> {
  const all: ScanEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const fileSpecArb: fc.Arbitrary<FileSpec> = fc.record({
  name: fc
    .string({ minLength: 1, maxLength: 8 })
    .filter((s) => !s.includes('/')),
  extension: fc.oneof(
    fc.mixedCase(fc.constantFrom('md', 'pdf')),
    fc.constantFrom('png', 'canvas', ''),
    fc.string({ maxLength: 4 }).filter((s) => !s.includes('/'))
  ),
  pdfBytes: fc.boolean(),
  irId: fc.option(fc.oneof(fc.string(), fc.integer(), fc.constant(null)), {
    nil: undefined,
  }),
  hasRow: fc.boolean(),
});

/** A folder anywhere, the data directory and what is under it included. */
const folderPathArb = fc.oneof(
  fc.constant('/'),
  fc.constantFrom('notes', 'a/b', `${DATA_DIRECTORY}-notes`),
  fc.constantFrom(DATA_DIRECTORY, `${DATA_DIRECTORY}/articles`)
);

/** Whether files directly in the folder at `path` are in the data directory. */
function inDataDirectory(path: string) {
  return path === DATA_DIRECTORY || path.startsWith(`${DATA_DIRECTORY}/`);
}

/** An order to list a folder's entries in: by name, digits as numbers. */
const byName: ExplorerComparator = (a, b) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });
// #endregion

beforeEach(() => {
  // The leading bytes can't be fetched here, so sniffing falls back to
  // `readBinary`, which these tests control (mime.test.ts covers the fetch).
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new TypeError('Failed to fetch')
  );
  vi.spyOn(console, 'error').mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isImportCandidate', () => {
  it('accepts an importable file whose content matches and that is no item yet, outside the data directory', async () => {
    await fc.assert(
      fc.asyncProperty(fileSpecArb, folderPathArb, async (spec, path) => {
        const folder = makeFolder(path);
        const file = makeFile(folder, spec);
        const { checks } = makeChecks(new Map([[file.path, spec]]));

        await expect(isImportCandidate(file, checks)).resolves.toBe(
          eligible(spec, inDataDirectory(path))
        );
      })
    );
  });

  it('reads the content of no file the cheaper checks rule out, and asks the database only about a PDF', async () => {
    await fc.assert(
      fc.asyncProperty(fileSpecArb, folderPathArb, async (spec, path) => {
        const folder = makeFolder(path);
        const file = makeFile(folder, spec);
        const { checks, readBinary } = makeChecks(new Map([[file.path, spec]]));
        const extension = spec.extension.toLowerCase();
        const ruledOut =
          inDataDirectory(path) ||
          !['md', 'pdf'].includes(extension) ||
          (extension === 'md' ? typeof spec.irId === 'string' : spec.hasRow);

        await isImportCandidate(file, checks);

        expect(readBinary.mock.calls.length > 0).toBe(!ruledOut);
        expect(vi.mocked(checks.isItemAtPath).mock.calls.length).toBe(
          !inDataDirectory(path) && extension === 'pdf' ? 1 : 0
        );
      })
    );
  });

  it("asks the item layer about a PDF, never about a note's path", async () => {
    // A note is an item by its `ir-id`; a row at its path that its note
    // doesn't carry the id of is someone else's leftover, not this note
    const folder = makeFolder('notes');
    const note: FileSpec = {
      name: 'a',
      extension: 'md',
      pdfBytes: false,
      irId: undefined,
      hasRow: true,
    };
    const pdf: FileSpec = { ...note, extension: 'pdf', pdfBytes: true };
    const noteFile = makeFile(folder, note);
    const pdfFile = makeFile(folder, pdf);
    const { checks } = makeChecks(
      new Map([
        [noteFile.path, note],
        [pdfFile.path, pdf],
      ])
    );

    await expect(isImportCandidate(noteFile, checks)).resolves.toBe(true);
    await expect(isImportCandidate(pdfFile, checks)).resolves.toBe(false);
    expect(checks.isItemAtPath).toHaveBeenCalledExactlyOnceWith(pdfFile);
  });
});

describe('folderSource', () => {
  it("is titled with the folder's name", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !s.includes('/')),
        fc.constantFrom('', 'a/', 'a/b/'),
        (name, parent) => {
          const source = folderSource(
            makeFolder(`${parent}${name}`),
            makeChecks(new Map()).checks,
            byName
          );
          expect(source.title).toBe(name);
        }
      )
    );
  });

  it('is titled "/" for the vault root, which has no name', () => {
    const root = Object.assign(new TFolder(), { path: '/', name: '' });
    expect(folderSource(root, makeChecks(new Map()).checks, byName).title).toBe(
      '/'
    );
  });

  it('yields every eligible direct file once, in the order given, and nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.tuple(fileSpecArb, fc.nat({ max: 3 })), {
          // One file per name a folder can hold
          selector: ([spec]) =>
            spec.extension ? `${spec.name}.${spec.extension}` : spec.name,
          maxLength: 8,
        }),
        folderPathArb,
        fc.nat({ max: 3 }),
        async (ranked, path, subfolderCount) => {
          const specs = ranked.map(([spec]) => spec);
          const folder = makeFolder(path);
          const files = specs.map((spec) => makeFile(folder, spec));
          const subfolders = Array.from({ length: subfolderCount }, (_, i) => {
            const sub = makeFolder(`${path === '/' ? '' : `${path}/`}sub${i}`);
            // Eligible in every way but depth
            sub.children = [
              makeFile(sub, { ...specs[0], name: `deep${i}`, extension: 'md' }),
            ];
            return sub;
          });
          // Children come in whatever order the vault holds them in
          folder.children = [...subfolders, ...files].reverse();
          const bySpec = new Map(files.map((f, i) => [f.path, specs[i]]));
          // An order with ties in it: files of the same rank are left as the
          // folder holds them
          const rank = new Map<TAbstractFile, number>(
            files.map((file, i) => [file, ranked[i][1]])
          );
          const rankOf = (entry: TAbstractFile) => rank.get(entry) ?? -1;
          const order: ExplorerComparator = (a, b) => rankOf(a) - rankOf(b);
          const { checks } = makeChecks(bySpec);

          const events = await collect(
            folderSource(folder, checks, order).scan(
              new AbortController().signal
            )
          );

          const held = (file: TFile) => folder.children.indexOf(file);
          const expected = files
            .filter((file) =>
              eligible(bySpec.get(file.path)!, inDataDirectory(path))
            )
            .sort((a, b) => rankOf(a) - rankOf(b) || held(a) - held(b));
          expect(events.every((e) => e.type === 'file')).toBe(true);
          const yielded = events.flatMap((e) => (e.type === 'file' ? [e] : []));
          expect(yielded.map((e) => e.file)).toEqual(expected);
          for (const event of yielded) {
            expect(event.parent).toBe(path);
            expect(event.relativePath).toBe(event.file.name);
          }
        }
      )
    );
  });

  it('checks one file at a time, in the order it lists them', async () => {
    const folder = makeFolder('notes');
    const spec: FileSpec = {
      name: '',
      extension: 'md',
      pdfBytes: false,
      irId: undefined,
      hasRow: false,
    };
    const files = ['c', 'a', 'b'].map((name) =>
      makeFile(folder, { ...spec, name })
    );
    folder.children = files;
    const { checks, readBinary } = makeChecks(
      new Map(files.map((f) => [f.path, spec]))
    );
    let reading = 0;
    let overlapped = false;
    readBinary.mockImplementation(async () => {
      reading += 1;
      overlapped ||= reading > 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      reading -= 1;
      return NOTE_BYTES.slice().buffer;
    });

    await collect(
      folderSource(folder, checks, byName).scan(new AbortController().signal)
    );

    expect(overlapped).toBe(false);
    expect(readBinary.mock.calls.map(([file]) => file.name)).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ]);
  });

  it('leaves out a file that cannot be read, still checking the rest', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.nat(),
        async (count, seed) => {
          vi.mocked(console.error).mockClear();
          const folder = makeFolder('notes');
          const spec: FileSpec = {
            name: '',
            extension: 'md',
            pdfBytes: false,
            irId: undefined,
            hasRow: false,
          };
          const files = Array.from({ length: count }, (_, i) =>
            makeFile(folder, { ...spec, name: `n${i}` })
          );
          folder.children = files;
          const { checks, readBinary } = makeChecks(
            new Map(files.map((f) => [f.path, spec]))
          );
          // Gone since the scan began, say
          const unreadable = files[seed % count];
          const gone = new Error('ENOENT');
          readBinary.mockImplementation(async (file: TFile) => {
            if (file === unreadable) throw gone;
            return NOTE_BYTES.slice().buffer;
          });

          const events = await collect(
            folderSource(folder, checks, byName).scan(
              new AbortController().signal
            )
          );

          expect(
            events.map((e) => (e.type === 'file' ? e.file : null))
          ).toEqual(files.filter((file) => file !== unreadable));
          expect(console.error).toHaveBeenCalledExactlyOnceWith(gone);
        }
      )
    );
  });

  it('stops once aborted, checking and yielding nothing more', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.nat({ max: 6 }),
        fc.boolean(),
        async (count, abortAfter, duringCheck) => {
          const folder = makeFolder('notes');
          const spec: FileSpec = {
            name: '',
            extension: 'md',
            pdfBytes: false,
            irId: undefined,
            hasRow: false,
          };
          const files = Array.from({ length: count }, (_, i) =>
            makeFile(folder, { ...spec, name: `n${i}` })
          );
          folder.children = files;
          const { checks, readBinary } = makeChecks(
            new Map(files.map((f) => [f.path, spec]))
          );
          const controller = new AbortController();
          const stopAt = Math.min(abortAfter, count);
          if (duringCheck) {
            // Aborted while the file after the last one kept is being read
            readBinary.mockImplementation(async () => {
              if (readBinary.mock.calls.length > stopAt) controller.abort();
              return NOTE_BYTES.slice().buffer;
            });
          }

          const yielded: ScanEvent[] = [];
          if (!duringCheck && stopAt === 0) controller.abort();
          for await (const event of folderSource(folder, checks, byName).scan(
            controller.signal
          )) {
            yielded.push(event);
            if (!duringCheck && yielded.length === stopAt) controller.abort();
          }

          expect(yielded).toHaveLength(stopAt);
          expect(readBinary.mock.calls.length).toBe(
            duringCheck ? Math.min(stopAt + 1, count) : stopAt
          );
        }
      )
    );
  });
});
