import { DATA_DIRECTORY } from '#/lib/constants';
import type { ExplorerComparator } from '#/lib/explorer-order';
import ReviewManager from '#/lib/items/ReviewManager';
import { TestRepository } from '#/test/item-vault';
import { makeLinkVault } from '#/test/link-vault';
import fc from 'fast-check';
import { TFile, TFolder, type TAbstractFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  folderSource,
  isCandidate,
  isImportCandidate,
  unimportChecks,
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

/** A generated folder: its files and its subfolders, each with a rank. */
interface TreeSpec {
  files: [FileSpec, number][];
  folders: [string, number, TreeSpec][];
}

const fileNameOf = (spec: FileSpec) =>
  spec.extension ? `${spec.name}.${spec.extension}` : spec.name;

/**
 * The contents of a folder at most `depth` levels deep, its subfolders now
 * and then named as the data directory is, each entry ranked for an order
 * with ties in it.
 */
function treeSpecArb(depth: number): fc.Arbitrary<TreeSpec> {
  return fc
    .record({
      files: fc.uniqueArray(fc.tuple(fileSpecArb, fc.nat({ max: 3 })), {
        selector: ([spec]) => fileNameOf(spec),
        maxLength: 4,
      }),
      folders:
        depth > 0
          ? fc.uniqueArray(
              fc.tuple(
                fc.oneof(
                  fc.constant(DATA_DIRECTORY),
                  fc
                    .string({ minLength: 1, maxLength: 6 })
                    .filter((s) => !s.includes('/'))
                ),
                fc.nat({ max: 3 })
              ),
              { selector: ([name]) => name, maxLength: 3 }
            )
          : fc.constant<[string, number][]>([]),
    })
    .chain(({ files, folders }) =>
      fc
        .tuple<TreeSpec[]>(...folders.map(() => treeSpecArb(depth - 1)))
        .map((subtrees) => ({
          // A file and a folder can't share a name
          files: files.filter(
            ([spec]) => !folders.some(([name]) => name === fileNameOf(spec))
          ),
          folders: folders.map(
            ([name, rank], i): [string, number, TreeSpec] => [
              name,
              rank,
              subtrees[i],
            ]
          ),
        }))
    );
}

/**
 * A vault folder at `path` filled from `spec`, its children held in an
 * order of their own, and what the scan needs to know: each file's spec and
 * each entry's rank.
 */
function makeTree(path: string, spec: TreeSpec) {
  const specs = new Map<string, FileSpec>();
  const rank = new Map<TAbstractFile, number>();
  const build = (folder: TFolder, tree: TreeSpec) => {
    const files = tree.files.map(([fileSpec, r]) => {
      const file = makeFile(folder, fileSpec);
      specs.set(file.path, fileSpec);
      rank.set(file, r);
      return file;
    });
    const folders = tree.folders.map(([name, r, sub]) => {
      const child = makeFolder(
        folder.path === '/' ? name : `${folder.path}/${name}`
      );
      child.parent = folder;
      rank.set(child, r);
      build(child, sub);
      return child;
    });
    // Children come in whatever order the vault holds them in
    folder.children = [...files, ...folders].reverse();
  };
  const root = makeFolder(path);
  build(root, spec);
  const rankOf = (entry: TAbstractFile) => rank.get(entry) ?? -1;
  const order: ExplorerComparator = (a, b) => rankOf(a) - rankOf(b);
  return { root, specs, order, rankOf };
}

/** `folder`'s children of one kind, as an explorer ordering by rank lists them. */
function sorted<T extends TAbstractFile>(
  folder: TFolder,
  kind: abstract new () => T,
  rankOf: (entry: TAbstractFile) => number
): T[] {
  const held = (entry: TAbstractFile) => folder.children.indexOf(entry);
  return folder.children
    .filter((child): child is T => child instanceof kind)
    .sort((a, b) => rankOf(a) - rankOf(b) || held(a) - held(b));
}

/**
 * What a scan of `root` should report, and every file it should check, in
 * turn: with `subfolders`, `root`'s subfolders announced; its eligible files;
 * `root` done; then, with `subfolders`, breadth-first, top to bottom, each
 * folder's subfolders announced, its eligible files, and the folder done.
 * The data directory is never entered.
 */
function expectedScan(
  root: TFolder,
  specs: ReadonlyMap<string, FileSpec>,
  rankOf: (entry: TAbstractFile) => number,
  subfolders: boolean
) {
  const events: ScanEvent[] = [];
  const checked: TFile[] = [];
  const enter = (folder: TFolder) => {
    const subs = subfolders
      ? sorted(folder, TFolder, rankOf).filter(
          (sub) => !inDataDirectory(sub.path)
        )
      : [];
    for (const sub of subs) {
      events.push({ type: 'folder', path: sub.path, parent: folder.path });
    }
    for (const file of sorted(folder, TFile, rankOf)) {
      const spec = specs.get(file.path)!;
      if (!ruledOutCheaply(spec, folder.path)) checked.push(file);
      if (eligible(spec, inDataDirectory(folder.path))) {
        events.push({
          type: 'file',
          file,
          parent: folder.path,
          relativePath:
            root.path === '/'
              ? file.path
              : file.path.slice(root.path.length + 1),
        });
      }
    }
    events.push({ type: 'folder-done', path: folder.path });
    return subs;
  };
  const queue = enter(root);
  for (const folder of queue) queue.push(...enter(folder));
  return { events, checked };
}

/** An event as data to compare, its file by path. */
const plain = (event: ScanEvent) =>
  event.type === 'file' ? { ...event, file: event.file.path } : event;

/** Whether `spec`, directly in `folderPath`, is ruled out before its content is read. */
function ruledOutCheaply(spec: FileSpec, folderPath: string): boolean {
  const extension = spec.extension.toLowerCase();
  return (
    inDataDirectory(folderPath) ||
    !['md', 'pdf'].includes(extension) ||
    (extension === 'md' ? typeof spec.irId === 'string' : spec.hasRow)
  );
}
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

  it('yields every eligible direct file once, in the order given, then the folder done, and nothing else', async () => {
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
          // Then the folder is done; its subfolders go unmentioned
          expect(events.at(-1)).toEqual({ type: 'folder-done', path });
          const yielded = events.slice(0, -1);
          expect(yielded.map((e) => (e.type === 'file' ? e.file : e))).toEqual(
            expected
          );
          for (const event of yielded) {
            if (event.type !== 'file') continue;
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

  it('leaves out a file that cannot be read, still checking the rest, and says so once', async () => {
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

          const source = folderSource(folder, checks, byName);
          // Again, the toggle switched, say: it isn't read nor logged again
          for (let run = 0; run < 2; run++) {
            const events = await collect(
              source.scan(new AbortController().signal)
            );

            expect(
              events.flatMap((e) => (e.type === 'file' ? [e.file] : []))
            ).toEqual(files.filter((file) => file !== unreadable));
          }
          expect(readBinary).toHaveBeenCalledTimes(count);
          expect(console.error).toHaveBeenCalledExactlyOnceWith(gone);
        }
      )
    );
  });
});

describe('folderSource scan, subfolders included or not', () => {
  it("offers subfolders, and reports, breadth-first and top to bottom in the order given, each folder's subfolders, then its eligible files, then it done; the data directory never entered", async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        folderPathArb,
        fc.boolean(),
        async (spec, path, subfolders) => {
          const { root, specs, order, rankOf } = makeTree(path, spec);
          const { checks } = makeChecks(specs);
          const source = folderSource(root, checks, order);

          const events = await collect(
            source.scan(new AbortController().signal, { subfolders })
          );

          expect(source.canIncludeSubfolders).toBe(true);
          expect(events.map(plain)).toEqual(
            expectedScan(root, specs, rankOf, subfolders).events.map(plain)
          );
        }
      )
    );
  });

  it("checks one file at a time, each folder's files before the next folder's, and nothing in the data directory", async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        folderPathArb,
        fc.boolean(),
        async (spec, path, subfolders) => {
          const { root, specs, order, rankOf } = makeTree(path, spec);
          const { checks, readBinary } = makeChecks(specs);
          const read = readBinary.getMockImplementation()!;
          let reading = 0;
          let overlapped = false;
          readBinary.mockImplementation(async (file: TFile) => {
            reading += 1;
            overlapped ||= reading > 1;
            await Promise.resolve();
            await Promise.resolve();
            reading -= 1;
            return read(file);
          });

          await collect(
            folderSource(root, checks, order).scan(
              new AbortController().signal,
              { subfolders }
            )
          );

          expect(overlapped).toBe(false);
          expect(readBinary.mock.calls.map(([file]) => file)).toEqual(
            expectedScan(root, specs, rankOf, subfolders).checked
          );
        }
      )
    );
  });

  it('run again, the toggle switched, reports as it would have, checking only files no run before it checked', async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        folderPathArb,
        fc.array(fc.boolean(), { minLength: 2, maxLength: 3 }),
        async (spec, path, runs) => {
          const { root, specs, order, rankOf } = makeTree(path, spec);
          const { checks, readBinary } = makeChecks(specs);
          const source = folderSource(root, checks, order);
          const checkedBefore = new Set<TFile>();

          for (const subfolders of runs) {
            readBinary.mockClear();
            const events = await collect(
              source.scan(new AbortController().signal, { subfolders })
            );

            const expected = expectedScan(root, specs, rankOf, subfolders);
            expect(events.map(plain)).toEqual(expected.events.map(plain));
            expect(readBinary.mock.calls.map(([file]) => file)).toEqual(
              expected.checked.filter((file) => !checkedBefore.has(file))
            );
            for (const file of expected.checked) checkedBefore.add(file);
          }
        }
      )
    );
  });

  it('stops once aborted, checking and reporting nothing more', async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        folderPathArb,
        fc.boolean(),
        fc.nat(),
        fc.boolean(),
        async (spec, path, subfolders, cut, duringCheck) => {
          const { root, specs, order, rankOf } = makeTree(path, spec);
          const { checks, readBinary } = makeChecks(specs);
          const { events: expected, checked } = expectedScan(
            root,
            specs,
            rankOf,
            subfolders
          );
          // After that many reports, or while that file is read
          const stopAt = cut % ((duringCheck ? checked : expected).length + 1);
          const controller = new AbortController();
          let readsWhenAborted: number | null = null;
          const abort = () => {
            controller.abort();
            readsWhenAborted = readBinary.mock.calls.length;
          };
          const read = readBinary.getMockImplementation()!;
          readBinary.mockImplementation(async (file: TFile) => {
            // Aborted while the file after the last one kept is being read
            if (duringCheck && readBinary.mock.calls.length === stopAt + 1) {
              abort();
            }
            return read(file);
          });

          const yielded: ScanEvent[] = [];
          let afterAbort = 0;
          if (!duringCheck && stopAt === 0) abort();
          for await (const event of folderSource(root, checks, order).scan(
            controller.signal,
            { subfolders }
          )) {
            if (controller.signal.aborted) afterAbort += 1;
            yielded.push(event);
            if (!duringCheck && yielded.length === stopAt) abort();
          }

          expect(afterAbort).toBe(0);
          expect(yielded.map(plain)).toEqual(
            expected.slice(0, yielded.length).map(plain)
          );
          if (!duringCheck) {
            expect(yielded).toHaveLength(Math.min(stopAt, expected.length));
          }
          if (readsWhenAborted !== null) {
            expect(readBinary.mock.calls).toHaveLength(readsWhenAborted);
          }
        }
      )
    );
  });
});

describe('isCandidate', () => {
  it("answers as an import's checks do for checks with no test of their own", async () => {
    await fc.assert(
      fc.asyncProperty(fileSpecArb, folderPathArb, async (spec, path) => {
        const file = makeFile(makeFolder(path), spec);
        const { checks } = makeChecks(new Map([[file.path, spec]]));

        expect(await isCandidate(file, checks)).toBe(
          await isImportCandidate(file, checks)
        );
      })
    );
  });

  it("answers with the checks' own test when they have one, sync or not, asking nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(
        fileSpecArb,
        fc.boolean(),
        fc.boolean(),
        async (spec, answer, later) => {
          const file = makeFile(makeFolder('notes'), spec);
          const { checks, readBinary } = makeChecks(
            new Map([[file.path, spec]])
          );
          const eligible = vi.fn(() =>
            later ? Promise.resolve(answer) : answer
          );

          expect(await isCandidate(file, { ...checks, eligible })).toBe(answer);
          expect(eligible).toHaveBeenCalledExactlyOnceWith(file);
          expect(readBinary).not.toHaveBeenCalled();
          expect(checks.isItemAtPath).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('folderSource with unimportChecks', () => {
  it('lists exactly the live articles the item layer names, in order, whatever their type, content or place, reading none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.tuple(fileSpecArb, fc.boolean()), {
          selector: ([spec]) => fileNameOf(spec),
          maxLength: 8,
        }),
        folderPathArb,
        async (marked, path) => {
          const folder = makeFolder(path);
          const files = marked.map(([spec]) => makeFile(folder, spec));
          folder.children = files;
          const articles = new Set(
            files.filter((_, i) => marked[i][1]).map(({ path }) => path)
          );
          const { checks, readBinary } = makeChecks(
            new Map(files.map((file, i) => [file.path, marked[i][0]]))
          );
          const articleIdAt = vi.fn((file: TFile) =>
            articles.has(file.path) ? 'id' : null
          );

          const events = await collect(
            folderSource(
              folder,
              unimportChecks(checks, { articleIdAt }),
              byName
            ).scan(new AbortController().signal)
          );

          expect(
            events.flatMap((e) => (e.type === 'file' ? [e.file] : []))
          ).toEqual(
            [...files].sort(byName).filter(({ path }) => articles.has(path))
          );
          expect(articleIdAt.mock.calls.map(([file]) => file)).toEqual(
            [...files].sort(byName)
          );
          expect(readBinary).not.toHaveBeenCalled();
          expect(checks.isItemAtPath).not.toHaveBeenCalled();
        }
      )
    );
  });

  it("lists a live note or PDF article, never a snippet's or card's note, a plain note, a deleted article or a note whose ir-id is another's", async () => {
    // What the review manager answers, as the plugin wires it
    const notes: Record<string, Record<string, unknown> | null> = {
      'n/live.md': { 'ir-id': 'live' },
      'n/live.pdf': null,
      'n/snippet.md': { 'ir-id': 'snippet' },
      'n/card.md': { 'ir-id': 'card' },
      'n/plain.md': null,
      'n/deleted.md': { 'ir-id': 'deleted' },
      // The ir-id of the article at `n/live.md`: a copy of its note
      'n/copy.md': { 'ir-id': 'live' },
    };
    const vault = makeLinkVault(notes);
    const repo = await TestRepository.create();
    const article = (id: string, reference: string, deleted = 0) =>
      repo.mutate(
        `INSERT INTO article (id, reference, due, interval, priority, deleted)
         VALUES ($1, $2, 0, 86400000, 30, $3)`,
        [id, reference, deleted]
      );
    article('live', 'n/live.md');
    article('pdf', 'n/live.pdf');
    article('deleted', 'n/deleted.md', 1);
    repo.mutate(
      `INSERT INTO snippet (id, reference, parent, due, interval, priority)
       VALUES ('snippet', 'n/snippet.md', 'live', 0, 86400000, 30)`
    );
    repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state)
       VALUES ('card', 'n/card.md', 'live', 0, 0, 0, 0, 0, 0, 0)`
    );
    const manager = new ReviewManager(
      {
        app: vault.app,
        settings: { dayRolloverOffset: 4 },
        registerEvent: vi.fn(),
      } as never,
      repo
    );
    const folder = makeFolder('n');
    folder.children = Object.keys(notes).map((path) => {
      const name = path.slice(2);
      const dot = name.lastIndexOf('.');
      return makeFile(folder, {
        name: name.slice(0, dot),
        extension: name.slice(dot + 1),
        pdfBytes: false,
        irId: undefined,
        hasRow: false,
      });
    });
    const checks: CandidateChecks = {
      app: vault.app as never,
      isItemAtPath: () => false,
    };

    const events = await collect(
      folderSource(folder, unimportChecks(checks, manager), byName).scan(
        new AbortController().signal
      )
    );

    expect(
      events.flatMap((e) => (e.type === 'file' ? [e.file.path] : []))
    ).toEqual(['n/live.md', 'n/live.pdf']);
    repo.dispose();
  });
});
