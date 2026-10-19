import fc from 'fast-check';
import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
  buildTree,
  subtreeScanning,
  topLevelScanning,
  treeFiles,
  type TreeEntry,
  type TreeFolder,
} from './tree';
import type { ScanEvent } from './types';

// #region HELPERS
/** A folder of a generated vault: the files that pass, and its subfolders. */
interface FolderSpec {
  name: string;
  files: string[];
  folders: FolderSpec[];
}

/** Names a folder can hold side by side: none empty, none with a slash. */
const namesArb = (maxLength: number) =>
  fc.uniqueArray(
    fc.string({ minLength: 1, maxLength: 4 }).filter((s) => !s.includes('/')),
    { maxLength }
  );

/** The contents of a folder at most `depth` levels deep. */
function folderArb(depth: number): fc.Arbitrary<FolderSpec> {
  return fc
    .record({
      files: namesArb(3),
      folderNames: depth > 0 ? namesArb(3) : fc.constant<string[]>([]),
    })
    .chain(({ files, folderNames }) =>
      fc
        .tuple<FolderSpec[]>(...folderNames.map(() => folderArb(depth - 1)))
        .map((folders) => ({
          name: '',
          // A file and a folder can't share a name
          files: files.filter((name) => !folderNames.includes(name)),
          folders: folders.map((folder, i) => ({
            ...folder,
            name: folderNames[i],
          })),
        }))
    );
}

/** Where a scan starts: the vault root, or a folder somewhere in it. */
const rootPathArb = fc.constantFrom('/', 'notes', 'a/b');

const join = (parent: string, name: string) =>
  parent === '/' ? name : `${parent}/${name}`;

const relativeTo = (rootPath: string, path: string) =>
  rootPath === '/' ? path : path.slice(rootPath.length + 1);

function makeFile(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign(new TFile(), { path, name, basename: name });
}

/**
 * What a folder source reports for the tree under `root`: with `subfolders`,
 * the root's subfolders announced; its files; the root done; then, with
 * `subfolders`, breadth-first, each folder's subfolders announced, its files,
 * and the folder done.
 */
function contractEvents(
  root: FolderSpec,
  rootPath: string,
  subfolders = true
): ScanEvent[] {
  const events: ScanEvent[] = [];
  const enter = (spec: FolderSpec, path: string) => {
    const subs: (readonly [FolderSpec, string])[] = subfolders
      ? spec.folders.map((sub) => {
          const subPath = join(path, sub.name);
          events.push({ type: 'folder', path: subPath, parent: path });
          return [sub, subPath] as const;
        })
      : [];
    for (const name of spec.files) {
      const filePath = join(path, name);
      events.push({
        type: 'file',
        file: makeFile(filePath),
        parent: path,
        relativePath: relativeTo(rootPath, filePath),
      });
    }
    events.push({ type: 'folder-done', path });
    return subs;
  };
  const queue = enter(root, rootPath);
  for (const [spec, path] of queue) queue.push(...enter(spec, path));
  return events;
}

/** A tree as plain data, to compare. */
type Shape =
  | { file: string; relativePath: string }
  | { folder: string; name: string; scanning: boolean; entries: Shape[] };

function shape(entries: readonly TreeEntry[]): Shape[] {
  return entries.map((entry) =>
    entry.kind === 'file'
      ? { file: entry.file.path, relativePath: entry.relativePath }
      : {
          folder: entry.path,
          name: entry.name,
          scanning: entry.scanning,
          entries: shape(entry.entries),
        }
  );
}

/**
 * What the tree under `root` should show once `seen` has been reported:
 * each folder's subfolders, then its files, as reported; a subfolder until
 * its scan finishes, and after only while some file is under it.
 */
function expectedShape(
  root: FolderSpec,
  rootPath: string,
  seen: readonly ScanEvent[],
  finished = false
): Shape[] {
  const filesSeen = new Set(
    seen.flatMap((e) => (e.type === 'file' ? [e.file.path] : []))
  );
  const announced = new Set(
    seen.flatMap((e) => (e.type === 'folder' ? [e.path] : []))
  );
  const done = new Set(
    seen.flatMap((e) => (e.type === 'folder-done' ? [e.path] : []))
  );
  const entries = (spec: FolderSpec, path: string): Shape[] => [
    ...spec.folders.flatMap((sub): Shape[] => {
      const subPath = join(path, sub.name);
      if (!announced.has(subPath)) return [];
      const inner = entries(sub, subPath);
      const scanning = !finished && !done.has(subPath);
      return scanning || inner.length > 0
        ? [{ folder: subPath, name: sub.name, scanning, entries: inner }]
        : [];
    }),
    ...spec.files
      .map((name) => join(path, name))
      .filter((filePath) => filesSeen.has(filePath))
      .map((filePath) => ({
        file: filePath,
        relativePath: relativeTo(rootPath, filePath),
      })),
  ];
  return entries(root, rootPath);
}

/** Every folder shown in `entries`, at any depth. */
function shownFolders(entries: readonly Shape[]): string[] {
  return entries.flatMap((entry) =>
    'folder' in entry ? [entry.folder, ...shownFolders(entry.entries)] : []
  );
}

/** What each shown folder lists directly, by path, the top level under ''. */
function listings(
  entries: readonly Shape[],
  path = '',
  into = new Map<string, string[]>()
): Map<string, string[]> {
  into.set(
    path,
    entries.map((entry) => ('file' in entry ? entry.file : entry.folder))
  );
  for (const entry of entries) {
    if ('folder' in entry) listings(entry.entries, entry.folder, into);
  }
  return into;
}

/** The tree after each event of `events` in turn. */
function snapshots(events: readonly ScanEvent[]): Shape[][] {
  return events.map((_, i) => shape(buildTree(events.slice(0, i + 1))));
}

const scanArb = fc
  .record({
    root: folderArb(3),
    rootPath: rootPathArb,
    subfolders: fc.boolean(),
  })
  .map(({ root, rootPath, subfolders }) => ({
    root,
    rootPath,
    events: contractEvents(root, rootPath, subfolders),
  }));
const pathArb = fc.constantFrom('a', 'b', 'a/c', 'b/c', 'a/c/d');

/** Any report at all, in no order a source keeps to. */
const eventArb: fc.Arbitrary<ScanEvent> = fc.oneof(
  fc.record({
    type: fc.constant('file' as const),
    file: fc.string({ maxLength: 3 }).map((name) => makeFile(name)),
    parent: pathArb,
    relativePath: fc.constant(''),
  }),
  fc.record({
    type: fc.constant('folder' as const),
    path: pathArb,
    parent: fc.option(pathArb, { nil: null }),
  }),
  fc.record({ type: fc.constant('folder-done' as const), path: pathArb })
);
// #endregion

describe('buildTree', () => {
  it('mirrors the folders reported, each listing its subfolders then its files, as far as the scan has got', () => {
    fc.assert(
      fc.property(scanArb, fc.nat(), ({ root, rootPath, events }, cut) => {
        const seen = events.slice(0, cut % (events.length + 1));

        expect(shape(buildTree(seen))).toEqual(
          expectedShape(root, rootPath, seen)
        );
      })
    );
  });

  it('shows no folder still scanning once the scan has finished, however far it got', () => {
    fc.assert(
      fc.property(scanArb, fc.nat(), ({ root, rootPath, events }, cut) => {
        const seen = events.slice(0, cut % (events.length + 1));

        expect(shape(buildTree(seen, true))).toEqual(
          expectedShape(root, rootPath, seen, true)
        );
      })
    );
  });

  it('shows nothing before anything is reported', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('never hides a folder and shows it again: once gone, it stays gone', () => {
    fc.assert(
      fc.property(scanArb, ({ events }) => {
        const gone = new Set<string>();
        let shown = new Set<string>();
        for (const snapshot of snapshots(events)) {
          const now = new Set(shownFolders(snapshot));
          for (const path of now) expect(gone.has(path)).toBe(false);
          for (const path of shown) if (!now.has(path)) gone.add(path);
          shown = now;
        }
      })
    );
  });

  it('only ever adds a row to the bottom of its folder, and none to a folder whose scan finished', () => {
    fc.assert(
      fc.property(scanArb, ({ events }) => {
        const all = snapshots(events);
        all.forEach((snapshot, i) => {
          const before = listings(all[i - 1] ?? []);
          const after = listings(snapshot);
          const done = new Set(
            events
              .slice(0, i)
              .flatMap((e) => (e.type === 'folder-done' ? [e.path] : []))
          );
          for (const [path, rows] of after) {
            const had = before.get(path) ?? [];
            // A row may go only when it is a folder found empty; the rest
            // keep their order, with anything new after them
            const kept = had.filter((row) => rows.includes(row));
            expect(rows.slice(0, kept.length)).toEqual(kept);
            if (done.has(path)) {
              expect(rows.filter((row) => !had.includes(row))).toEqual([]);
            }
          }
        });
      })
    );
  });

  it('puts a file or folder whose parent was never reported at the top', () => {
    const file = makeFile('x/a.md');
    const tree = buildTree([
      { type: 'folder', path: 'y', parent: null },
      { type: 'folder', path: 'z', parent: 'unknown' },
      { type: 'file', file, parent: 'x', relativePath: 'a.md' },
    ]);
    expect(shape(tree)).toEqual([
      { folder: 'y', name: 'y', scanning: true, entries: [] },
      { folder: 'z', name: 'z', scanning: true, entries: [] },
      { file: 'x/a.md', relativePath: 'a.md' },
    ]);
  });

  it('keeps the first report of a folder reported twice, and ignores a finish for a folder never reported', () => {
    const file = makeFile('d/a.md');
    const tree = buildTree([
      { type: 'folder', path: 'd', parent: null },
      { type: 'file', file, parent: 'd', relativePath: 'd/a.md' },
      { type: 'folder', path: 'd', parent: null },
      { type: 'folder-done', path: 'elsewhere' },
    ]);
    expect(shape(tree)).toEqual([
      {
        folder: 'd',
        name: 'd',
        scanning: true,
        entries: [{ file: 'd/a.md', relativePath: 'd/a.md' }],
      },
    ]);
  });

  it('shows every file reported exactly once, whatever order the reports come in', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        const reported = events.flatMap((e) =>
          e.type === 'file' ? [e.file] : []
        );
        const shown = treeFiles(buildTree(events));
        expect(shown).toHaveLength(reported.length);
        expect(new Set(shown)).toEqual(new Set(reported));
      })
    );
  });
});

describe('topLevelScanning', () => {
  it('is on until the scan reports the folder it starts from done, or finishes', () => {
    fc.assert(
      fc.property(
        scanArb,
        fc.nat(),
        fc.boolean(),
        ({ rootPath, events }, cut, finished) => {
          const seen = events.slice(0, cut % (events.length + 1));
          const rootDone = seen.some(
            (e) => e.type === 'folder-done' && e.path === rootPath
          );

          expect(topLevelScanning(seen, finished)).toBe(!finished && !rootDone);
        }
      )
    );
  });

  it('takes the end of a folder reported before it for the end of that folder only', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        const ends = events.some(
          (e, i) =>
            e.type === 'folder-done' &&
            !events
              .slice(0, i)
              .some((f) => f.type === 'folder' && f.path === e.path)
        );

        expect(topLevelScanning(events)).toBe(!ends);
      })
    );
  });
});

describe('treeFiles', () => {
  it('lists the files of a tree top to bottom, as the tree shows them', () => {
    fc.assert(
      fc.property(scanArb, fc.nat(), ({ root, rootPath, events }, cut) => {
        const seen = events.slice(0, cut % (events.length + 1));
        const topToBottom = (entries: readonly Shape[]): string[] =>
          entries.flatMap((entry) =>
            'file' in entry ? [entry.file] : topToBottom(entry.entries)
          );

        expect(treeFiles(buildTree(seen)).map((file) => file.path)).toEqual(
          topToBottom(expectedShape(root, rootPath, seen))
        );
      })
    );
  });
});

describe('subtreeScanning', () => {
  /**
   * Folder paths over `a` and `b`, each with its parent folder, and the ones
   * still being scanned.
   */
  const foldersArb = fc
    .uniqueArray(
      fc
        .array(fc.constantFrom('a', 'b'), { minLength: 1, maxLength: 3 })
        .map((parts) => parts.join('/'))
    )
    .map((paths) => {
      const all = new Set<string>();
      for (const path of paths) {
        const parts = path.split('/');
        parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join('/')));
      }
      // Parents before their children, as a source reports them
      return [...all].sort((x, y) => x.length - y.length);
    })
    .chain((paths) =>
      fc.record({
        paths: fc.constant(paths),
        scanning: fc.subarray(paths).map((sub) => new Set(sub)),
      })
    );

  const findFolder = (
    entries: readonly TreeEntry[],
    path: string
  ): TreeFolder | undefined => {
    for (const entry of entries) {
      if (entry.kind !== 'folder') continue;
      if (entry.path === path) return entry;
      const found = findFolder(entry.entries, path);
      if (found) return found;
    }
    return undefined;
  };

  it('is whether the folder or any folder under it is still being scanned', () => {
    fc.assert(
      fc.property(foldersArb, ({ paths, scanning }) => {
        const parentOf = (path: string) =>
          path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
        const events: ScanEvent[] = [
          ...paths.map(
            (path): ScanEvent => ({
              type: 'folder',
              path,
              parent: parentOf(path),
            })
          ),
          // A file in each, so no finished folder is left out as empty
          ...paths.map(
            (path): ScanEvent => ({
              type: 'file',
              file: makeFile(`${path}/f`),
              parent: path,
              relativePath: `${path}/f`,
            })
          ),
          ...paths
            .filter((path) => !scanning.has(path))
            .map((path): ScanEvent => ({ type: 'folder-done', path })),
        ];
        const tree = buildTree(events);

        for (const path of paths) {
          expect(subtreeScanning(findFolder(tree, path)!)).toBe(
            [...scanning].some(
              (other) => other === path || other.startsWith(`${path}/`)
            )
          );
        }
      })
    );
  });
});
