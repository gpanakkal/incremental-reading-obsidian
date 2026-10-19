import { DATA_DIRECTORY } from '#/lib/constants';
import {
  explorerComparator,
  type ExplorerComparator,
} from '#/lib/explorer-order';
import fc from 'fast-check';
import { TFile, TFolder } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unimportChecks, type CandidateChecks } from './candidates';
import { arrangeList, listSource } from './list-source';
import { buildTree, type TreeEntry } from './tree';
import type { ScanEvent } from './types';

// #region HELPERS
/** What a note opens with: no binary format's signature. */
const NOTE_BYTES = new TextEncoder().encode('# Content');

const isDataPath = (path: string) =>
  path === DATA_DIRECTORY || path.startsWith(`${DATA_DIRECTORY}/`);

/** One listed file as generated: where it is and what decides its fate. */
interface FileSpec {
  /** Its folders' names from the vault root, outermost first. */
  dirs: string[];
  name: string;
  extension: string;
  mtime: number;
  /** Its cached frontmatter `ir-id`, which makes it an item already. */
  irId: string | undefined;
}

/**
 * The vault the specs make: each folder once, with its parent, the root's
 * own folder at `/`, and each file, in the order given, with its parent;
 * a vault root file's parent is the root, or `null` when `rootless` says so.
 */
function makeVault(specs: readonly FileSpec[], rootless = false) {
  const root = Object.assign(new TFolder(), { path: '/', name: '' });
  const folders = new Map<string, TFolder>([['/', root]]);
  const folderAt = (dirs: readonly string[]): TFolder => {
    if (dirs.length === 0) return root;
    const path = dirs.join('/');
    let folder = folders.get(path);
    if (!folder) {
      folder = Object.assign(new TFolder(), {
        path,
        name: dirs[dirs.length - 1],
        parent: folderAt(dirs.slice(0, -1)),
      });
      folders.set(path, folder);
    }
    return folder;
  };
  const byPath = new Map<string, TFile>();
  const files = specs.map((spec) => {
    const parent = folderAt(spec.dirs);
    const name = `${spec.name}.${spec.extension}`;
    const path = [...spec.dirs, name].join('/');
    // The same path twice is the same file
    const known = byPath.get(path);
    if (known) return known;
    const file = Object.assign(new TFile(), {
      path,
      name,
      basename: spec.name,
      extension: spec.extension,
      stat: { mtime: spec.mtime, ctime: -spec.mtime, size: 0 },
      parent: rootless && parent === root ? null : parent,
    });
    byPath.set(path, file);
    return file;
  });
  return {
    files,
    folders,
    specOf: new Map(files.map((f, i) => [f, specs[i]])),
  };
}

const folderNameArb = fc.constantFrom(
  'a',
  'B',
  'c',
  'a1',
  'a10',
  DATA_DIRECTORY
);

const fileSpecArb: fc.Arbitrary<FileSpec> = fc.record({
  dirs: fc.array(folderNameArb, { maxLength: 3 }),
  name: fc.constantFrom('x', 'Y', 'z', 'n2', 'n10'),
  extension: fc.constantFrom('md', 'pdf'),
  mtime: fc.integer({ min: 0, max: 3 }),
  irId: fc.option(fc.constantFrom('id-1', 'id-2'), { nil: undefined }),
});

/** Files as a list gives them: any order, some twice. */
const specsArb = fc.array(fileSpecArb, { maxLength: 14 });

/** An order for a folder's entries: the explorer's under any sort, or none. */
const compareArb = fc.oneof(
  fc
    .constantFrom(
      'alphabetical',
      'alphabeticalReverse',
      'byModifiedTime',
      'byModifiedTimeReverse',
      'byCreatedTime',
      'byCreatedTimeReverse'
    )
    .map(explorerComparator),
  fc.constant<ExplorerComparator>(() => 0)
);

/** The folders a file is under, the vault root aside, outermost first. */
function ancestors(file: TFile): string[] {
  const parts = file.path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

const parentPath = (file: TFile) =>
  file.path.includes('/')
    ? file.path.slice(0, file.path.lastIndexOf('/'))
    : '/';

/** Each of `files` once, as first given, none in the data directory. */
const listed = (files: readonly TFile[]) =>
  [...new Set(files)].filter((file) => !isDataPath(file.path));

/**
 * The checks a scan runs: each note is an item when its spec gives it an
 * `ir-id`; no live row is at any path.
 */
function makeChecks(specOf: ReadonlyMap<TFile, FileSpec>) {
  const readBinary = vi.fn(async (_file: TFile) => NOTE_BYTES.slice().buffer);
  const checks: CandidateChecks = {
    app: {
      vault: {
        readBinary,
        getResourcePath: (file: TFile) => `app://vault/${file.path}`,
      },
      metadataCache: {
        getFileCache: (file: TFile) => {
          const irId = specOf.get(file)?.irId;
          return irId === undefined ? null : { frontmatter: { 'ir-id': irId } };
        },
      },
    } as never,
    isItemAtPath: () => false,
  };
  return { checks, readBinary };
}

/** Whether a note with `spec` can be imported: markdown, not an item yet. */
const importable = (spec: FileSpec | undefined) =>
  spec?.extension === 'md' && spec.irId === undefined;

async function collect(events: AsyncIterable<ScanEvent>): Promise<ScanEvent[]> {
  const all: ScanEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

/** Every folder row of `entries`, however deep, with the rows under it. */
function folderRows(entries: readonly TreeEntry[]): TreeEntry[][] {
  return [
    entries as TreeEntry[],
    ...entries.flatMap((entry) =>
      entry.kind === 'folder' ? folderRows(entry.entries) : []
    ),
  ];
}
/** Files in path order, for comparing lists as sets. */
const byPath = (a: TFile, b: TFile) => a.path.localeCompare(b.path);
// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('arrangeList', () => {
  it('reports each folder that holds a listed file, however deep, once, and no other', () => {
    fc.assert(
      fc.property(
        specsArb,
        compareArb,
        fc.boolean(),
        (specs, compare, rootless) => {
          const { files } = makeVault(specs, rootless);

          const folders = arrangeList(files, compare).flatMap((event) =>
            event.type === 'folder' ? [event.path] : []
          );

          expect(folders.sort()).toEqual(
            [...new Set(listed(files).flatMap(ancestors))].sort()
          );
        }
      )
    );
  });

  it('lists each file once, under its own folder or the vault root, by its path from the root, the data directory left out', () => {
    fc.assert(
      fc.property(
        specsArb,
        compareArb,
        fc.boolean(),
        (specs, compare, rootless) => {
          const { files } = makeVault(specs, rootless);

          const rows = arrangeList(files, compare).filter(
            (event) => event.type === 'file'
          );

          expect(rows.map(({ file }) => file).sort(byPath)).toEqual(
            listed(files).sort(byPath)
          );
          for (const { file, parent, relativePath } of rows) {
            expect(parent).toBe(parentPath(file));
            expect(relativePath).toBe(file.path);
          }
        }
      )
    );
  });

  it('announces a folder before anything in it, its subfolders before its files, and ends it, the vault root first, once all of them are reported', () => {
    fc.assert(
      fc.property(
        specsArb,
        compareArb,
        fc.boolean(),
        (specs, compare, rootless) => {
          const { files } = makeVault(specs, rootless);
          const events = arrangeList(files, compare);

          const announced = new Map<string, number>();
          const ended = new Map<string, number>();
          events.forEach((event, i) => {
            if (event.type === 'folder') announced.set(event.path, i);
            else if (event.type === 'folder-done') {
              expect(ended.has(event.path)).toBe(false);
              ended.set(event.path, i);
            }
          });
          // Every folder ends, and the vault root, never announced, too
          expect([...ended.keys()].sort()).toEqual(
            ['/', ...announced.keys()].sort()
          );
          const firstFile = new Map<string, number>();
          events.forEach((event, i) => {
            const parent =
              event.type === 'folder'
                ? (event.parent ?? '/')
                : event.type === 'file'
                  ? event.parent
                  : null;
            if (parent === null) return;
            expect(i).toBeGreaterThan(announced.get(parent) ?? -1);
            expect(i).toBeLessThan(ended.get(parent)!);
            if (event.type === 'file' && !firstFile.has(parent))
              firstFile.set(parent, i);
            if (event.type === 'folder') {
              expect(i).toBeLessThan(firstFile.get(parent) ?? Infinity);
              // Under its own parent, not a vault-root `/`
              expect(event.parent).toBe(
                event.path.includes('/')
                  ? event.path.slice(0, event.path.lastIndexOf('/'))
                  : null
              );
            }
          });
        }
      )
    );
  });

  it('goes breadth-first: folders end in the order they were announced, after the top level', () => {
    fc.assert(
      fc.property(specsArb, compareArb, (specs, compare) => {
        const { files } = makeVault(specs);
        const events = arrangeList(files, compare);

        const announced = events.flatMap((event) =>
          event.type === 'folder' ? [event.path] : []
        );
        const ended = events.flatMap((event) =>
          event.type === 'folder-done' ? [event.path] : []
        );

        expect(ended).toEqual(['/', ...announced]);
      })
    );
  });

  it('puts each level in the order compare does, files it ties in the order given', () => {
    fc.assert(
      fc.property(specsArb, compareArb, (specs, compare) => {
        const { files, folders } = makeVault(specs);
        const order = listed(files);

        const tree = buildTree(arrangeList(files, compare), true);

        for (const rows of folderRows(tree)) {
          const entries = rows.map((row) =>
            row.kind === 'file' ? row.file : folders.get(row.path)!
          );
          for (let i = 1; i < entries.length; i++) {
            const [a, b] = [entries[i - 1], entries[i]];
            // Folders first, each kind as compare has it
            if (a instanceof TFile && b instanceof TFolder) {
              throw new Error(`${b.path} after ${a.path}`);
            }
            if (a instanceof TFolder !== b instanceof TFolder) continue;
            expect(compare(a, b)).toBeLessThanOrEqual(0);
            if (a instanceof TFile && compare(a, b) === 0) {
              expect(order.indexOf(a)).toBeLessThan(order.indexOf(b as TFile));
            }
          }
        }
      })
    );
  });

  it('reports only the end of the top level for no files', () => {
    expect(arrangeList([], explorerComparator('alphabetical'))).toEqual([
      { type: 'folder-done', path: '/' },
    ]);
  });
});

describe('listSource', () => {
  it('lists the files of the arrangement that can be imported, with all its folders, in its order', async () => {
    await fc.assert(
      fc.asyncProperty(specsArb, compareArb, async (specs, compare) => {
        const { files, specOf } = makeVault(specs);
        const { checks } = makeChecks(specOf);

        const events = await collect(
          listSource(files, checks, compare, 'title').scan(
            new AbortController().signal
          )
        );

        expect(events).toEqual(
          arrangeList(files, compare).filter(
            (event) =>
              event.type !== 'file' || importable(specOf.get(event.file))
          )
        );
      })
    );
  });

  it('lists, for an un-import, the files of the arrangement that are live articles alone, reading none', async () => {
    await fc.assert(
      fc.asyncProperty(
        specsArb,
        compareArb,
        fc.array(fc.boolean(), { minLength: 1 }),
        async (specs, compare, picks) => {
          const { files, specOf } = makeVault(specs);
          const { checks, readBinary } = makeChecks(specOf);
          const articles = new Set(
            files.filter((_, i) => picks[i % picks.length])
          );

          const events = await collect(
            listSource(
              files,
              unimportChecks(checks, {
                articleIdAt: (file) => (articles.has(file) ? 'id' : null),
              }),
              compare,
              'title'
            ).scan(new AbortController().signal)
          );

          expect(events).toEqual(
            arrangeList(files, compare).filter(
              (event) => event.type !== 'file' || articles.has(event.file)
            )
          );
          expect(readBinary).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('checks each file once for its life, however often it scans', async () => {
    await fc.assert(
      fc.asyncProperty(specsArb, async (specs) => {
        const { files, specOf } = makeVault(specs);
        const { checks, readBinary } = makeChecks(specOf);
        const source = listSource(
          files,
          checks,
          explorerComparator('alphabetical'),
          't'
        );

        const first = await collect(source.scan(new AbortController().signal));
        const second = await collect(source.scan(new AbortController().signal));

        expect(second).toEqual(first);
        // Every note not an item yet, and every PDF, has its bytes read, once
        const read = readBinary.mock.calls.map(([file]) => file);
        expect(read.sort(byPath)).toEqual(
          listed(files)
            .filter(
              (file) => file.extension === 'pdf' || importable(specOf.get(file))
            )
            .sort(byPath)
        );
      })
    );
  });

  it('is titled as told, with no Include subfolders', () => {
    fc.assert(
      fc.property(fc.string(), (title) => {
        const source = listSource(
          [],
          makeChecks(new Map()).checks,
          () => 0,
          title
        );

        expect(source.title).toBe(title);
        expect(source.canIncludeSubfolders).toBeFalsy();
      })
    );
  });

  it('stops once the signal aborts, before or while a file is checked', async () => {
    const { files, specOf } = makeVault([
      { dirs: ['a'], name: 'x', extension: 'md', mtime: 0, irId: undefined },
      { dirs: [], name: 'y', extension: 'md', mtime: 0, irId: undefined },
      { dirs: [], name: 'z', extension: 'md', mtime: 0, irId: undefined },
    ]);
    const { checks, readBinary } = makeChecks(specOf);
    const source = listSource(
      files,
      checks,
      explorerComparator('alphabetical'),
      't'
    );

    const before = new AbortController();
    before.abort();
    expect(await collect(source.scan(before.signal))).toEqual([]);

    // Aborted while the first root file is being read
    const during = new AbortController();
    readBinary.mockImplementationOnce(async () => {
      during.abort();
      return NOTE_BYTES.slice().buffer;
    });
    expect(await collect(source.scan(during.signal))).toEqual([
      { type: 'folder', path: 'a', parent: null },
    ]);

    // Aborted after a row
    const after = new AbortController();
    const seen: ScanEvent[] = [];
    for await (const event of source.scan(after.signal)) {
      seen.push(event);
      if (event.type === 'file') after.abort();
    }
    expect(seen.map((event) => event.type)).toEqual(['folder', 'file']);
  });

  it('hides a file that cannot be read, and only that one', async () => {
    const { files, specOf } = makeVault([
      { dirs: [], name: 'x', extension: 'md', mtime: 0, irId: undefined },
      { dirs: [], name: 'y', extension: 'md', mtime: 0, irId: undefined },
    ]);
    const { checks, readBinary } = makeChecks(specOf);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    readBinary.mockRejectedValueOnce(new Error('gone'));

    const events = await collect(
      listSource(files, checks, explorerComparator('alphabetical'), 't').scan(
        new AbortController().signal
      )
    );

    expect(events.filter((event) => event.type === 'file')).toEqual([
      { type: 'file', file: files[1], parent: '/', relativePath: 'y.md' },
    ]);
    expect(error).toHaveBeenCalledOnce();
  });
});
