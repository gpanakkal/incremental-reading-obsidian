import { DATA_DIRECTORY } from '#/lib/constants';
import { explorerComparator } from '#/lib/explorer-order';
import fc from 'fast-check';
import { TFile, TFolder, type TAbstractFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderSource, type CandidateChecks } from './candidates';
import {
  itemCount,
  selectionMayImport,
  selectionRoots,
  selectionSource,
} from './selection';
import type { ScanEvent } from './types';

// #region HELPERS
const NOTE_BYTES = new TextEncoder().encode('# Content');
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%\n1 0 obj');

/** One generated file, and everything that decides whether it can import. */
interface FileSpec {
  extension: string;
  /** Its bytes open as a PDF's do. */
  pdfBytes: boolean;
  /** It carries a cached `ir-id`. */
  irId: boolean;
  /** A live row is at its path. */
  hasRow: boolean;
  /** Reading it throws. */
  unreadable: boolean;
  mtime: number;
  ctime: number;
}

/** A generated folder's contents, by name. */
interface TreeSpec {
  files: [string, FileSpec][];
  folders: [string, TreeSpec][];
}

/** Names that tie, differ by case or digits only, and the data directory's. */
const nameArb = fc.constantFrom('a', 'A', 'b', 'note 2', 'note 10');

const fileSpecArb: fc.Arbitrary<FileSpec> = fc.record({
  extension: fc.constantFrom('md', 'pdf', 'png', 'canvas', ''),
  pdfBytes: fc.boolean(),
  irId: fc.boolean(),
  hasRow: fc.boolean(),
  unreadable: fc.nat({ max: 7 }).map((n) => n === 0),
  mtime: fc.nat({ max: 3 }),
  ctime: fc.nat({ max: 3 }),
});

function treeSpecArb(depth: number): fc.Arbitrary<TreeSpec> {
  return fc.record({
    files: fc.uniqueArray(fc.tuple(nameArb, fileSpecArb), {
      selector: ([name, spec]) => `${name}.${spec.extension}`,
      maxLength: 3,
    }),
    folders:
      depth > 0
        ? fc.uniqueArray(
            fc.tuple(
              fc.oneof(nameArb, fc.constant(DATA_DIRECTORY)),
              treeSpecArb(depth - 1)
            ),
            { selector: ([name]) => name, maxLength: 3 }
          )
        : fc.constant([]),
  });
}

const join = (folder: TFolder, name: string) =>
  folder.path === '/' ? name : `${folder.path}/${name}`;

/** A vault filled from `spec`: its root, every other entry, and the files' specs. */
function makeVault(spec: TreeSpec) {
  const specs = new Map<string, FileSpec>();
  const entries: TAbstractFile[] = [];
  const build = (folder: TFolder, tree: TreeSpec) => {
    const files = tree.files.map(([basename, fileSpec]) => {
      const name = fileSpec.extension
        ? `${basename}.${fileSpec.extension}`
        : basename;
      const file = Object.assign(new TFile(), {
        path: join(folder, name),
        name,
        basename,
        extension: fileSpec.extension,
        parent: folder,
        stat: { mtime: fileSpec.mtime, ctime: fileSpec.ctime, size: 0 },
      });
      specs.set(file.path, fileSpec);
      return file;
    });
    const folders = tree.folders
      // A file and a folder can't share a path
      .filter(([name]) => !files.some((file) => file.name === name))
      .map(([name, sub]) => {
        const child = Object.assign(new TFolder(), {
          path: join(folder, name),
          name,
          parent: folder,
        });
        build(child, sub);
        return child;
      });
    // Held in an order of the vault's own
    folder.children = [...files, ...folders].reverse();
    entries.push(...files, ...folders);
  };
  const root = Object.assign(new TFolder(), { path: '/', name: '' });
  build(root, spec);
  return { root, entries, specs };
}

/** The checks a scan runs over `specs`: bytes, frontmatter, rows. */
function makeChecks(specs: ReadonlyMap<string, FileSpec>) {
  const readBinary = vi.fn(async (file: TFile) => {
    const spec = specs.get(file.path);
    if (spec?.unreadable) throw new Error(`Can't read ${file.path}`);
    return (spec?.pdfBytes ? PDF_BYTES : NOTE_BYTES).slice().buffer;
  });
  const checks: CandidateChecks = {
    app: {
      vault: {
        readBinary,
        getResourcePath: (file: TFile) => `app://vault/${file.path}`,
      },
      metadataCache: {
        getFileCache: (file: TFile) =>
          specs.get(file.path)?.irId ? { frontmatter: { 'ir-id': 'x' } } : null,
      },
    } as never,
    isItemAtPath: (file: TFile) => specs.get(file.path)?.hasRow ?? false,
  };
  return { checks, readBinary };
}

/** `entry` and the folders above it, nearest first. */
function selfAndAncestors(entry: TAbstractFile): TAbstractFile[] {
  const chain: TAbstractFile[] = [];
  for (let at: TAbstractFile | null = entry; at; at = at.parent) chain.push(at);
  return chain;
}

/** Whether `file`, a selected file, should be a row. */
function eligible(file: TFile, specs: ReadonlyMap<string, FileSpec>) {
  const spec = specs.get(file.path)!;
  if (selfAndAncestors(file).some((at) => at.path === DATA_DIRECTORY)) {
    return false;
  }
  if (spec.extension === 'md') {
    return !spec.irId && !spec.pdfBytes && !spec.unreadable;
  }
  if (spec.extension === 'pdf') {
    return !spec.hasRow && spec.pdfBytes && !spec.unreadable;
  }
  return false;
}

const sortOrderArb = fc.constantFrom(
  'alphabetical',
  'alphabeticalReverse',
  'byModifiedTime',
  'byModifiedTimeReverse',
  'byCreatedTime',
  'byCreatedTimeReverse'
) as fc.Arbitrary<Parameters<typeof explorerComparator>[0]>;

/**
 * A vault and a Files-view selection of it: anything in it, the same item
 * now and then twice, nested items and the data directory included, the
 * vault root once in a while.
 */
const selectionCaseArb = fc
  .tuple(treeSpecArb(3), sortOrderArb)
  .map(([spec, order]) => ({ ...makeVault(spec), order }))
  .chain((vault) =>
    fc
      .array(
        fc.oneof(
          { weight: 1, arbitrary: fc.constant(vault.root as TAbstractFile) },
          {
            weight: 12,
            arbitrary:
              vault.entries.length > 0
                ? fc.constantFrom(...vault.entries)
                : fc.constant(vault.root as TAbstractFile),
          }
        ),
        { maxLength: 6 }
      )
      .map((selection) => ({ ...vault, selection }))
  );

async function collect(events: AsyncIterable<ScanEvent>): Promise<ScanEvent[]> {
  const all: ScanEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

/** An event as data to compare, its file by path. */
const plain = (event: ScanEvent) =>
  event.type === 'file' ? { ...event, file: event.file.path } : event;

/**
 * What a scan of `roots` (deduped, in order) should report: the folders
 * announced at the top, the eligible files there, the top done; then, for
 * each folder in turn, what the folder source on it reports up to its own
 * end; then, for each in turn, the rest of it.
 */
async function expectedScan(
  roots: readonly TAbstractFile[],
  specs: ReadonlyMap<string, FileSpec>,
  order: Parameters<typeof explorerComparator>[0],
  subfolders: boolean
): Promise<ScanEvent[]> {
  const events: ScanEvent[] = [];
  const folders = roots.filter((r): r is TFolder => r instanceof TFolder);
  for (const folder of folders) {
    events.push({ type: 'folder', path: folder.path, parent: null });
  }
  for (const file of roots) {
    if (file instanceof TFile && eligible(file, specs)) {
      events.push({ type: 'file', file, parent: '/', relativePath: file.name });
    }
  }
  events.push({ type: 'folder-done', path: '/' });
  const tails: ScanEvent[][] = [];
  for (const folder of folders) {
    const walk = await collect(
      folderSource(
        folder,
        makeChecks(specs).checks,
        explorerComparator(order)
      ).scan(new AbortController().signal, { subfolders })
    );
    const end = walk.findIndex(
      (e) => e.type === 'folder-done' && e.path === folder.path
    );
    events.push(...walk.slice(0, end + 1));
    tails.push(walk.slice(end + 1));
  }
  return [...events, ...tails.flat()];
}
// #endregion

beforeEach(() => {
  // Sniffing falls back to `readBinary`, which these tests control
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new TypeError('Failed to fetch')
  );
  vi.spyOn(console, 'error').mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('selectionRoots', () => {
  it('keeps each selected item once, in order, unless a selected folder or the data directory holds it', () => {
    fc.assert(
      fc.property(selectionCaseArb, ({ root, selection }) => {
        const roots = selectionRoots(selection);

        if (selection.includes(root)) {
          expect(roots).toEqual([root]);
          return;
        }
        const covered = (entry: TAbstractFile) =>
          selfAndAncestors(entry)
            .slice(1)
            .some((above) => selection.includes(above));
        const inData = (entry: TAbstractFile) =>
          selfAndAncestors(entry).some((at) => at.path === DATA_DIRECTORY);
        expect(roots).toEqual(
          selection.filter(
            (entry, i) =>
              selection.indexOf(entry) === i &&
              !covered(entry) &&
              !inData(entry)
          )
        );
      })
    );
  });

  it('drops a second item at the same path, the vault holding one per path', () => {
    const a = Object.assign(new TFile(), { path: 'n/a.md', extension: 'md' });
    const again = Object.assign(new TFile(), {
      path: 'n/a.md',
      extension: 'md',
    });

    expect(selectionRoots([a, again])).toEqual([a]);
  });

  it('does not take a folder for the parent of a sibling whose name it begins', () => {
    const folder = Object.assign(new TFolder(), { path: 'notes' });
    const sibling = Object.assign(new TFile(), { path: 'notes 2.md' });

    expect(selectionRoots([folder, sibling])).toEqual([folder, sibling]);
  });
});

describe('selectionMayImport', () => {
  it('is true for a selection holding a folder, or a file of a type that imports', () => {
    fc.assert(
      fc.property(selectionCaseArb, ({ selection }) => {
        expect(selectionMayImport(selection)).toBe(
          selection.some(
            (entry) =>
              entry instanceof TFolder ||
              ['md', 'pdf'].includes((entry as TFile).extension)
          )
        );
      })
    );
  });
});

describe('itemCount', () => {
  it('counts in the singular for one, the plural otherwise', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(1), fc.nat()), (count) => {
        expect(itemCount(count)).toMatch(
          new RegExp(`^${count} item${count === 1 ? '' : 's'}$`)
        );
      })
    );
  });
});

describe('selectionSource', () => {
  it('is titled and headed with the deduped count, and offers subfolders only with a folder selected', () => {
    fc.assert(
      fc.property(selectionCaseArb, ({ selection, order }) => {
        const roots = selectionRoots(selection);
        const source = selectionSource(
          selection,
          makeChecks(new Map()).checks,
          explorerComparator(order)
        );

        expect(source.title).toBe(itemCount(roots.length));
        expect(source.heading).toContain(itemCount(roots.length));
        expect(source.canIncludeSubfolders).toBe(
          roots.some((entry) => entry instanceof TFolder)
        );
      })
    );
  });

  it("reports the selected folders, then the selected files that can import, the top done, then each folder's own rows, then what is under each, as the folder source would", async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionCaseArb,
        fc.option(fc.boolean(), { nil: undefined }),
        async ({ root, selection, specs, order }, subfolders) => {
          fc.pre(!selection.includes(root));
          const source = selectionSource(
            selection,
            makeChecks(specs).checks,
            explorerComparator(order)
          );
          const roots = selectionRoots(selection).sort(
            explorerComparator(order)
          );

          const events = await collect(
            // Left out, the scan stays at the top level
            subfolders === undefined
              ? source.scan(new AbortController().signal)
              : source.scan(new AbortController().signal, { subfolders })
          );

          expect(events.map(plain)).toEqual(
            (await expectedScan(roots, specs, order, subfolders ?? false)).map(
              plain
            )
          );
        }
      )
    );
  });

  it('puts the top level in Files-view order, folders first, ties as selected', async () => {
    await fc.assert(
      fc.asyncProperty(selectionCaseArb, async ({ root, selection, order }) => {
        fc.pre(!selection.includes(root));
        // Every file of a type that imports passes, so every such root shows
        const { checks, readBinary } = makeChecks(new Map());
        readBinary.mockImplementation(
          async (file: TFile) =>
            (file.extension === 'pdf' ? PDF_BYTES : NOTE_BYTES).slice().buffer
        );
        const compare = explorerComparator(order);
        const deduped = selectionRoots(selection);
        const shown = (
          await collect(
            selectionSource(selection, checks, compare).scan(
              new AbortController().signal
            )
          )
        ).flatMap((event) =>
          event.type === 'folder' && event.parent === null
            ? [event.path]
            : event.type === 'file' && event.parent === '/'
              ? [event.file.path]
              : []
        );

        const expected = deduped.filter(
          (entry) =>
            entry instanceof TFolder ||
            (['md', 'pdf'].includes((entry as TFile).extension) &&
              !selfAndAncestors(entry).some((at) => at.path === DATA_DIRECTORY))
        );
        expect([...shown].sort()).toEqual(
          expected.map((entry) => entry.path).sort()
        );
        const byPath = new Map(expected.map((entry) => [entry.path, entry]));
        for (let i = 1; i < shown.length; i++) {
          const a = byPath.get(shown[i - 1])!;
          const b = byPath.get(shown[i])!;
          const cmp = compare(a, b);
          expect(cmp).toBeLessThanOrEqual(0);
          if (cmp === 0) {
            expect(deduped.indexOf(a)).toBeLessThan(deduped.indexOf(b));
          }
        }
      })
    );
  });

  it("gives each row its path from the nearest selected item, a selected file's its name", async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionCaseArb,
        fc.boolean(),
        async ({ selection, specs, order }, subfolders) => {
          const roots = selectionRoots(selection);
          const events = await collect(
            selectionSource(
              selection,
              makeChecks(specs).checks,
              explorerComparator(order)
            ).scan(new AbortController().signal, { subfolders })
          );

          for (const event of events) {
            if (event.type !== 'file') continue;
            const nearest = selfAndAncestors(event.file).find((at) =>
              roots.includes(at)
            )!;
            expect(event.relativePath).toBe(
              nearest === event.file
                ? event.file.name
                : nearest.path === '/'
                  ? event.file.path
                  : event.file.path.slice(nearest.path.length + 1)
            );
          }
        }
      )
    );
  });

  it('reads as the folder source on the vault when the root is selected', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionCaseArb,
        fc.boolean(),
        async ({ root, selection, specs, order }, subfolders) => {
          const withRoot = [...selection, root];
          const source = selectionSource(
            withRoot,
            makeChecks(specs).checks,
            explorerComparator(order)
          );

          expect(source.title).toBe(itemCount(1));
          expect(source.canIncludeSubfolders).toBe(true);
          expect(
            (
              await collect(
                source.scan(new AbortController().signal, { subfolders })
              )
            ).map(plain)
          ).toEqual(
            (
              await collect(
                folderSource(
                  root,
                  makeChecks(specs).checks,
                  explorerComparator(order)
                ).scan(new AbortController().signal, { subfolders })
              )
            ).map(plain)
          );
        }
      )
    );
  });

  it('checks a file once for its life, however often the scan runs again', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionCaseArb,
        fc.array(fc.boolean(), { minLength: 2, maxLength: 4 }),
        async ({ root, selection, specs, order }, runs) => {
          fc.pre(!selection.includes(root));
          const { checks, readBinary } = makeChecks(specs);
          const source = selectionSource(
            selection,
            checks,
            explorerComparator(order)
          );
          const roots = selectionRoots(selection).sort(
            explorerComparator(order)
          );

          for (const subfolders of runs) {
            const events = await collect(
              source.scan(new AbortController().signal, { subfolders })
            );
            expect(events.map(plain)).toEqual(
              (await expectedScan(roots, specs, order, subfolders)).map(plain)
            );
          }

          const read = readBinary.mock.calls.map(([file]) => file);
          expect(new Set(read).size).toBe(read.length);
        }
      )
    );
  });

  it('says once that a selected file could not be read, and leaves it out', async () => {
    const specs = new Map<string, FileSpec>([
      [
        'n/x.md',
        {
          extension: 'md',
          pdfBytes: false,
          irId: false,
          hasRow: false,
          unreadable: true,
          mtime: 0,
          ctime: 0,
        },
      ],
    ]);
    const file = Object.assign(new TFile(), {
      path: 'n/x.md',
      name: 'x.md',
      extension: 'md',
    });
    const source = selectionSource(
      [file],
      makeChecks(specs).checks,
      explorerComparator('alphabetical')
    );

    await collect(source.scan(new AbortController().signal));
    const events = await collect(source.scan(new AbortController().signal));

    expect(events).toEqual([{ type: 'folder-done', path: '/' }]);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('checks no selected file once aborted after announcing the folders', async () => {
    const folder = Object.assign(new TFolder(), { path: 'n', name: 'n' });
    const file = Object.assign(new TFile(), {
      path: 'm/x.md',
      name: 'x.md',
      extension: 'md',
    });
    const { checks, readBinary } = makeChecks(new Map());
    const controller = new AbortController();

    const yielded: ScanEvent[] = [];
    for await (const event of selectionSource(
      [file, folder],
      checks,
      explorerComparator('alphabetical')
    ).scan(controller.signal)) {
      yielded.push(event);
      controller.abort();
    }

    expect(yielded).toEqual([{ type: 'folder', path: 'n', parent: null }]);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('stops once aborted, reporting and checking nothing more', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionCaseArb,
        fc.boolean(),
        fc.nat(),
        fc.boolean(),
        async (
          { root, selection, specs, order },
          subfolders,
          cut,
          duringCheck
        ) => {
          fc.pre(!selection.includes(root));
          const roots = selectionRoots(selection).sort(
            explorerComparator(order)
          );
          const expected = await expectedScan(roots, specs, order, subfolders);
          const { checks, readBinary } = makeChecks(specs);
          const fullReads = (
            await (async () => {
              const probe = makeChecks(specs);
              await collect(
                selectionSource(
                  selection,
                  probe.checks,
                  explorerComparator(order)
                ).scan(new AbortController().signal, { subfolders })
              );
              return probe.readBinary.mock.calls;
            })()
          ).length;
          const stopAt =
            cut % ((duringCheck ? fullReads : expected.length) + 1);
          const controller = new AbortController();
          let readsWhenAborted: number | null = null;
          const abort = () => {
            controller.abort();
            readsWhenAborted = readBinary.mock.calls.length;
          };
          const read = readBinary.getMockImplementation()!;
          readBinary.mockImplementation(async (file: TFile) => {
            if (duringCheck && readBinary.mock.calls.length === stopAt + 1) {
              abort();
            }
            return read(file);
          });

          const yielded: ScanEvent[] = [];
          let afterAbort = 0;
          if (!duringCheck && stopAt === 0) abort();
          for await (const event of selectionSource(
            selection,
            checks,
            explorerComparator(order)
          ).scan(controller.signal, { subfolders })) {
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
