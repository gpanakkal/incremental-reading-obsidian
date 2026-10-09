import fc from 'fast-check';
import { type App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_TITLE_CHARS } from './constants';
import {
  addedRefusedChars,
  createArrivalWarning,
  ItemPathGuard,
  listChars,
  REFUSED_ARRIVALS_DELAY_MS,
  REFUSED_PATH_CHARS,
  refusedCharsIn,
  refusedPathsWarning,
  startupWarning,
} from './item-path-guard';

// #region HELPERS

const dirname = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** What a vault holds that is neither file nor folder, should it hold one. */
class OddEntry extends TAbstractFile {}

/** Give `entry` the path `path`, and the names Obsidian derives from it. */
function setPath(entry: TAbstractFile, path: string) {
  entry.path = path;
  entry.name = path.slice(path.lastIndexOf('/') + 1);
  if (!(entry instanceof TFile)) return;
  const dot = entry.name.lastIndexOf('.');
  entry.basename = dot > 0 ? entry.name.slice(0, dot) : entry.name;
  entry.extension = dot > 0 ? entry.name.slice(dot + 1) : '';
}

/** `entry`, at `path` in `parent`. */
function place<T extends TAbstractFile>(
  entry: T,
  path: string,
  parent: TFolder
): T {
  setPath(entry, path);
  entry.parent = parent;
  parent.children.push(entry);
  return entry;
}

/**
 * A vault of `files` and the folders they are in, renamed as Obsidian's
 * desktop adapter renames (read from obsidian.asar): the file or folder moves
 * and its `rename` fires; then, after a pause, each file and folder in it
 * fires its own, its path changed only as it does. Events go to `listener`.
 */
function makeVault(files: readonly string[]) {
  const root = Object.assign(new TFolder(), { path: '/' });
  const byPath = new Map<string, TAbstractFile>([['/', root]]);
  let listener: (entry: TAbstractFile, oldPath: string) => void = () => {};
  let deleted: (entry: TAbstractFile) => void = () => {};

  const folderAt = (path: string): TFolder => {
    if (path === '') return root;
    const found = byPath.get(path);
    if (found instanceof TFolder) return found;
    const folder = place(new TFolder(), path, folderAt(dirname(path)));
    byPath.set(path, folder);
    return folder;
  };
  /** Put `entry`, a file unless given, at `path`. */
  const add = (path: string, entry: TAbstractFile = new TFile()) => {
    place(entry, path, folderAt(dirname(path)));
    byPath.set(path, entry);
    return entry;
  };
  for (const path of files) add(path);

  const within = (entry: TAbstractFile): TAbstractFile[] =>
    entry instanceof TFolder
      ? entry.children.flatMap((child) => [child, ...within(child)])
      : [];

  const rename = async (entry: TAbstractFile, to: string) => {
    await Promise.resolve();
    if (byPath.has(to)) throw new Error('Destination file already exists!');
    const parent = byPath.get(dirname(to) || '/');
    if (!(parent instanceof TFolder)) throw new Error(`ENOENT: ${to}`);
    const from = entry.path;
    const inside = within(entry);
    const siblings = entry.parent!.children;
    siblings.splice(siblings.indexOf(entry), 1);
    byPath.delete(from);
    place(entry, to, parent);
    byPath.set(to, entry);
    listener(entry, from);
    if (inside.length === 0) return;
    await Promise.resolve();
    for (const child of inside) {
      const old = child.path;
      byPath.delete(old);
      setPath(child, to + old.slice(from.length));
      byPath.set(child.path, child);
      listener(child, old);
    }
  };

  /**
   * Delete what is at `path`, and all in it, as Obsidian does before it fires
   * `delete`: for it alone, say what is in it hears nothing.
   */
  const remove = (path: string) => {
    const entry = byPath.get(path)!;
    const siblings = entry.parent!.children;
    siblings.splice(siblings.indexOf(entry), 1);
    for (const gone of [entry, ...within(entry)]) byPath.delete(gone.path);
    deleted(entry);
  };

  return {
    root,
    add,
    rename,
    remove,
    get: (path: string) => byPath.get(path)!,
    files: () => within(root).filter((entry) => entry instanceof TFile),
    listen: (fn: typeof listener) => (listener = fn),
    onDelete: (fn: typeof deleted) => (deleted = fn),
    vault: {
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      rename,
    },
  };
}

/**
 * Obsidian's `FileManager` (read from obsidian.asar). `runAsyncLinkUpdate`
 * queues a job on `updateQueue` that waits for the metadata cache to be clean
 * (`state.cacheClean`), then runs its op; an op asked for while a job runs its
 * ops joins that job instead (`inProgressUpdates`). Once its ops are done,
 * the job updates links to each file that is no longer where it started
 * (`updateAllLinks`, recorded in `linkUpdates`). A job whose op fails updates
 * no links. `renameFile` is a `Vault.rename` run through it.
 */
function makeFileManager(vault: ReturnType<typeof makeVault>) {
  const state: {
    inProgress: (() => Promise<unknown>)[] | null;
    cacheClean: () => Promise<void>;
  } = { inProgress: null, cacheClean: () => Promise.resolve() };
  let tail: Promise<unknown> = Promise.resolve();
  const linkUpdates: string[][] = [];
  const updateQueue = {
    queue: (job: () => Promise<void>) => (tail = tail.then(job, job)),
  };
  const runAsyncLinkUpdate = vi.fn(
    (op: () => Promise<unknown>): Promise<unknown> => {
      if (state.inProgress) {
        state.inProgress.push(op);
        return Promise.resolve();
      }
      return updateQueue.queue(async () => {
        await state.cacheClean();
        const before = vault.files().map((file) => [file, file.path] as const);
        state.inProgress = [];
        try {
          await op();
          while (state.inProgress.length > 0) {
            const ops = state.inProgress;
            state.inProgress = [];
            await Promise.all(ops.map((run) => run()));
          }
        } finally {
          state.inProgress = null;
        }
        linkUpdates.push(
          before
            .filter(([file, path]) => file.path !== path)
            .map(([f]) => f.path)
        );
      });
    }
  );
  const renameFile = vi.fn((entry: TAbstractFile, to: string) =>
    runAsyncLinkUpdate(() => vault.rename(entry, to))
  );
  /** Settles once every job queued so far has, the ones they queue too. */
  const drained = async () => {
    let seen: Promise<unknown>;
    do {
      seen = tail;
      await seen.catch(() => {});
      await new Promise((done) => setTimeout(done, 0));
    } while (seen !== tail);
  };
  /** Hold the queue, as a rename waiting on Obsidian's prompt does. */
  const hold = () => {
    let release!: () => void;
    void updateQueue.queue(() => new Promise<void>((done) => (release = done)));
    return () => release();
  };
  /** Hold every job at its wait for a clean metadata cache. */
  const holdCache = () => {
    let release!: () => void;
    const clean = new Promise<void>((done) => (release = done));
    state.cacheClean = () => clean;
    return () => release();
  };
  return {
    renameFile,
    runAsyncLinkUpdate,
    updateQueue,
    linkUpdates,
    drained,
    hold,
    holdCache,
  };
}

/** A timer run by hand: `fire` runs every one still set. */
function makeTimer() {
  const set = new Map<number, () => void>();
  let next = 0;
  const timer = vi.fn((run: () => void, _ms: number) => {
    const id = next++;
    set.set(id, run);
    return () => void set.delete(id);
  });
  const fire = () => {
    const runs = [...set.values()];
    set.clear();
    runs.forEach((run) => run());
  };
  return { timer, fire, pending: () => set.size };
}

/**
 * A guard over a vault of `files`, the ones in `items` items' files by path,
 * as the database knows them. Every `rename` goes to the guard, as `main.ts`
 * hands it over; `passed` is each one it left to be followed as usual, which
 * moves the reference of a file that has one. Every `delete` asks the guard
 * where the database has the file, as `main.ts` does; `deleted` records it.
 * Without `linkUpdater`, the `FileManager` has no `runAsyncLinkUpdate`, as a
 * later Obsidian might not.
 */
function wire(
  files: readonly string[],
  items: readonly string[],
  { linkUpdater = true } = {}
) {
  const vault = makeVault(files);
  const fileManager = makeFileManager(vault);
  const references = new Set(items);
  const notify = vi.fn<(message: string) => void>();
  const follow = vi.fn((file: TFile, oldPath: string) => {
    if (references.delete(oldPath)) references.add(file.path);
  });
  const app = {
    vault: vault.vault,
    fileManager: {
      renameFile: fileManager.renameFile,
      updateQueue: fileManager.updateQueue,
      ...(linkUpdater
        ? { runAsyncLinkUpdate: fileManager.runAsyncLinkUpdate }
        : {}),
    },
  } as unknown as App;
  const isItemFile = vi.fn((_file: TFile, path: string) =>
    references.has(path)
  );
  const referencesUnder = vi.fn(
    (folder: string) =>
      new Set([...references].filter((path) => path.startsWith(`${folder}/`)))
  );
  const guard = new ItemPathGuard({
    app,
    isItemFile,
    referencesUnder,
    follow,
    notify,
  });
  const passed: [string, string][] = [];
  const hooks: { after?: (entry: TAbstractFile, oldPath: string) => void } = {};
  vault.listen((entry, oldPath) => {
    if (!guard.handleRename(entry, oldPath)) {
      passed.push([entry.path, oldPath]);
      // Followed, the database's reference moves with the file
      if (references.delete(oldPath)) references.add(entry.path);
    }
    hooks.after?.(entry, oldPath);
  });
  const deleted: [string, string][] = [];
  vault.onDelete((entry) => {
    const at = guard.pathBeforeDeletion(entry) ?? entry.path;
    deleted.push([entry.path, at]);
    references.delete(at);
  });
  /** Rename as the file explorer or a title does, through `renameFile`. */
  const renameFile = async (from: string, to: string) => {
    await fileManager.renameFile(vault.get(from), to);
    await fileManager.drained();
  };
  return {
    ...vault,
    ...fileManager,
    renameFile,
    /** `FileManager.renameFile`: the user's renames */
    renameFileSpy: fileManager.renameFile,
    deleted,
    references,
    isItemFile,
    referencesUnder,
    notify,
    follow,
    passed,
    hooks,
    guard,
  };
}

/** A plain name for a file or folder: no refused character, no slash. */
const plainName = fc
  .string({ unit: 'binary', minLength: 1, maxLength: 8 })
  .filter(
    (name) =>
      !Array.from(name).some((char) => FORBIDDEN_TITLE_CHARS.has(char)) &&
      name.trim() === name &&
      !name.startsWith('.')
  );

const refusedChar = fc.constantFrom(...REFUSED_PATH_CHARS);

/** What the guard tells, by what happened. */
const said = {
  /** A file put back */
  file: (chars: string) =>
    `Incremental reading: IR files and their folders cannot contain ${chars}`,
  /** A folder put back */
  folder: (chars: string) =>
    `Incremental reading: folders with items cannot contain ${chars}`,
  /** Not put back: where it is, and what to drop */
  failed: (path: string, chars: string) =>
    `Incremental reading: couldn't move "${path}" back. Rename it without ${chars}`,
  /** Put back once already, so left */
  stays: (path: string, chars: string) =>
    `Incremental reading: "${path}" was already moved back once, so it ` +
    `stays. Rename it without ${chars}`,
};

/** Text for within one name: refused characters and plain ones, no slash. */
const nameText = fc
  .array(
    fc.oneof(
      refusedChar,
      fc
        .string({ unit: 'binary', maxLength: 3 })
        .filter((text) => !text.includes('/'))
    )
  )
  .map((parts) => parts.join(''));

/** Text mixing refused characters, slashes and plain ones. */
const pathText = fc
  .array(
    fc.oneof(
      refusedChar,
      fc.constant('/'),
      fc.string({ unit: 'binary', maxLength: 3 })
    )
  )
  .map((parts) => parts.join(''));

// #endregion

describe('REFUSED_PATH_CHARS', () => {
  it('holds every character a title cannot, but the slash that parts a path', () => {
    // `|` ends a wikilink's path, `>` an angled markdown target's
    expect(REFUSED_PATH_CHARS).toStrictEqual(
      new Set([
        '#',
        '^',
        '[',
        ']',
        '|',
        '*',
        '"',
        '\\',
        '<',
        '>',
        ':',
        '?',
        '\n',
      ])
    );
    // And it follows the title rule, should that change
    for (const char of FORBIDDEN_TITLE_CHARS) {
      expect(REFUSED_PATH_CHARS.has(char)).toBe(char !== '/');
    }
    expect(REFUSED_PATH_CHARS.size).toBe(FORBIDDEN_TITLE_CHARS.size - 1);
  });
});

describe('refusedCharsIn', () => {
  it('names each refused character a path holds once, in the order they first appear', () => {
    fc.assert(
      fc.property(pathText, (path) => {
        const found = refusedCharsIn(path);
        const held = new Set(Array.from(path));
        for (const char of REFUSED_PATH_CHARS) {
          expect(found.includes(char)).toBe(held.has(char));
        }
        expect(new Set(found).size).toBe(found.length);
        const firsts = found.map((char) => path.indexOf(char));
        expect(firsts).toStrictEqual([...firsts].sort((a, b) => a - b));
      })
    );
  });
});

describe('addedRefusedChars', () => {
  it('names nothing for a path compared with itself', () => {
    fc.assert(
      fc.property(pathText, (path) => {
        expect(addedRefusedChars(path, path)).toStrictEqual([]);
      })
    );
  });

  it('names the refused characters added to a name', () => {
    fc.assert(
      fc.property(pathText, nameText, (path, extra) => {
        const added = addedRefusedChars(path, path + extra);
        expect([...added].sort()).toStrictEqual(refusedCharsIn(extra).sort());
      })
    );
  });

  it('names nothing taken out of a name', () => {
    fc.assert(
      fc.property(pathText, nameText, (path, extra) => {
        expect(addedRefusedChars(path + extra, path)).toStrictEqual([]);
      })
    );
  });

  it('names nothing for a path moved into plain folders, or out of any', () => {
    fc.assert(
      fc.property(
        pathText,
        fc.array(plainName, { minLength: 1, maxLength: 3 }),
        (path, folders) => {
          expect(
            addedRefusedChars(path, `${folders.join('/')}/${path}`)
          ).toStrictEqual([]);
          expect(
            addedRefusedChars(`${folders.join('/')}/${path}`, path)
          ).toStrictEqual([]);
        }
      )
    );
  });

  it('names each character once, a refused one, in the order the new path first holds it', () => {
    fc.assert(
      fc.property(pathText, pathText, (from, to) => {
        const added = addedRefusedChars(from, to);
        expect(added.every((char) => REFUSED_PATH_CHARS.has(char))).toBe(true);
        expect(new Set(added).size).toBe(added.length);
        const firsts = added.map((char) => to.indexOf(char));
        expect(firsts).toStrictEqual([...firsts].sort((a, b) => a - b));
      })
    );
  });

  it.each([
    // Name against old name
    ['C# notes.md', 'C# notes 2.md', []],
    ['C# notes.md', 'C# #2.md', ['#']],
    ['a.md', 'a|b>.md', ['|', '>']],
    // A folder the old path held passes, at any level
    ['C# notes.md', 'x/C# notes.md', []],
    ['x#/a.md', 'x#/sub/a.md', []],
    ['x#/a.md', 'y/x#/a.md', []],
    ['a/b#/c.md', 'b#/c.md', []],
    ['x#/a.md', 'x#y/a.md', []],
    // A character moved to another name is gained by it
    ['x#/a.md', 'y/a#.md', ['#']],
    ['x#/a.md', 'x#.md', ['#']],
    // A new folder against nothing
    ['a.md', 'x>y/a.md', ['>']],
    ['notes', 'x[y]/notes', ['[', ']']],
    ['notes', 'no|tes', ['|']],
    // Only a folder's name passes as one the old path held
    ['x/a#', 'a#/y', ['#']],
    ['x#/a', 'x#', ['#']],
    ['p/x#/a.md', 'x#/q/r/a.md', []],
  ])('compares %s with %s name by name', (from, to, added) => {
    expect(addedRefusedChars(from, to)).toStrictEqual(added);
  });
});

describe('startupWarning', () => {
  it('warns only of a path the user has not heard of, and keeps the list only when it changed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a|.md', 'b#.md', 'c>.md', 'd^.md')),
        fc.array(fc.constantFrom('a|.md', 'b#.md', 'c>.md', 'd^.md')),
        (paths, warned) => {
          // Heard of already, in any order or number: nothing to say or keep
          expect(
            startupWarning(paths, [...warned, ...paths].reverse())
          ).toMatchObject({ warn: false });
          expect(
            startupWarning([...paths, ...paths], [...paths].reverse())
          ).toStrictEqual({ warn: false, remember: null });
          // A path not heard of is told of, and kept with the rest
          const fresh = 'new|.md';
          const told = startupWarning([...paths, fresh], warned);
          expect(told.warn).toBe(true);
          expect(told.remember).toContain(fresh);
          // What it keeps, once kept, is the same list next time
          const { remember } = startupWarning(paths, warned);
          if (remember) {
            expect(new Set(remember).size).toBe(remember.length);
            expect(startupWarning(paths, remember)).toStrictEqual({
              warn: false,
              remember: null,
            });
          }
          // Gone from the list: kept shorter, said nothing
          const gone = startupWarning([], [...warned, fresh]);
          expect(gone).toStrictEqual({ warn: false, remember: [] });
        }
      )
    );
  });
});

describe('listChars', () => {
  it('names every character once, in order, the last after "or" and the rest after spaces', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...REFUSED_PATH_CHARS), { minLength: 1 }),
        (chars) => {
          const given = [...chars];
          const listed = listChars(chars);
          expect(chars).toStrictEqual(given);
          const halves = listed.split(' or ');
          expect(halves).toHaveLength(chars.length > 1 ? 2 : 1);
          // With "or" taken out, what is left is each one in turn
          expect(halves.join(' ')).toBe(
            chars
              .map((char) => (char === '\n' ? 'a line break' : char))
              .join(' ')
          );
          expect(listed).not.toContain(',');
        }
      )
    );
  });

  it('lists characters as a sentence names them, a line break by name', () => {
    expect(listChars(['|'])).toBe('|');
    expect(listChars(['|', '>'])).toBe('| or >');
    expect(listChars(['#', '|', '>'])).toBe('# | or >');
    expect(listChars(['\n', ':'])).toBe('a line break or :');
  });
});

describe('refusedPathsWarning', () => {
  it('says nothing when no item path holds a refused character', () => {
    expect(refusedPathsWarning([])).toBeNull();
  });

  it('names up to three paths, counts the rest, and lists the characters to drop', () => {
    const chars = '# ^ [ ] * " \\ < > : | ? line breaks';
    expect(refusedPathsWarning(['a|b.md'])).toBe(
      `Incremental reading: IR files and their folders cannot contain any ` +
        `of these characters: ${chars}. Rename "a|b.md"`
    );
    expect(refusedPathsWarning(['a', 'b', 'c', 'd', 'e'])).toBe(
      `Incremental reading: IR files and their folders cannot contain any ` +
        `of these characters: ${chars}. Rename "a", "b", "c" and 2 more`
    );
    expect(refusedPathsWarning(['a', 'b', 'c'])).toMatch(
      /Rename "a", "b", "c"$/
    );
  });
});

describe('createArrivalWarning', () => {
  it('names every path a burst brings in one notice, once none has come for a while', () => {
    fc.assert(
      fc.property(fc.array(pathText, { minLength: 1 }), (paths) => {
        const { timer, fire, pending } = makeTimer();
        const notify = vi.fn<(message: string, paths: string[]) => void>();
        const arrivals = createArrivalWarning({ notify, timer });

        paths.forEach((path) => arrivals.add(path));
        expect(notify).not.toHaveBeenCalled();
        // Each arrival puts the notice off again
        expect(pending()).toBe(1);
        expect(
          timer.mock.calls.every(([, ms]) => ms === REFUSED_ARRIVALS_DELAY_MS)
        ).toBe(true);
        fire();

        expect(notify).toHaveBeenCalledExactlyOnceWith(
          refusedPathsWarning([...new Set(paths)]),
          [...new Set(paths)]
        );
        // And the next burst starts afresh
        arrivals.add('next|.md');
        fire();
        expect(notify).toHaveBeenLastCalledWith(
          refusedPathsWarning(['next|.md']),
          ['next|.md']
        );
      })
    );
  });

  it('says nothing of a burst it is disposed of during, nor after', () => {
    const { timer, fire, pending } = makeTimer();
    const notify = vi.fn<(message: string) => void>();
    const arrivals = createArrivalWarning({ notify, timer });

    arrivals.add('a|.md');
    arrivals.dispose();
    expect(pending()).toBe(0);
    arrivals.dispose();
    fire();

    expect(notify).not.toHaveBeenCalled();
  });
});

describe('ItemPathGuard.handleRename', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts an item file renamed to a name adding a refused character back, in the rename's own link update, following neither move", async () => {
    await fc.assert(
      fc.asyncProperty(plainName, refusedChar, plainName, async (a, c, b) => {
        const path = `cards/${a}.md`;
        const wired = wire([path], [path]);
        const file = wired.get(path);

        await wired.renameFile(path, `cards/${a}${c}${b}.md`);

        expect(file.path).toBe(path);
        expect(wired.passed).toStrictEqual([]);
        expect(wired.follow).not.toHaveBeenCalled();
        // One job, which found every file where it began: no link rewritten
        expect(wired.linkUpdates).toStrictEqual([[]]);
        expect(wired.renameFileSpy).toHaveBeenCalledOnce();
        // The user's rename and the undo, which joined its job
        expect(wired.runAsyncLinkUpdate).toHaveBeenCalledTimes(2);
        expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
          said.file(listChars([c]))
        );
      })
    );
  });

  it('moves an item file moved into a folder whose path adds a refused character back to its folder', async () => {
    const wired = wire(['x>y/other.md', 'articles/a.md'], ['articles/a.md']);
    const file = wired.get('articles/a.md');

    await wired.renameFile('articles/a.md', 'x>y/a.md');

    expect(file.path).toBe('articles/a.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.linkUpdates).toStrictEqual([[]]);
    expect(wired.notify).toHaveBeenCalledOnce();
  });

  it('leaves a file that is no item where it was renamed to, to be followed as usual', async () => {
    await fc.assert(
      fc.asyncProperty(plainName, refusedChar, async (a, c) => {
        const wired = wire([`${a}.md`, 'cards/card.md'], ['cards/card.md']);

        await wired.renameFile(`${a}.md`, `${a}${c}.md`);

        expect(wired.get(`${a}${c}.md`)).toBeDefined();
        expect(wired.passed).toStrictEqual([[`${a}${c}.md`, `${a}.md`]]);
        expect(wired.renameFileSpy).toHaveBeenCalledOnce();
        expect(wired.notify).not.toHaveBeenCalled();
      })
    );
  });

  it('leaves an item file whose new path adds no refused character, one its old path held included', async () => {
    await fc.assert(
      fc.asyncProperty(
        plainName,
        refusedChar,
        plainName,
        async (a, c, folder) => {
          // Made before this rule: it may still move, as it is
          const path = `${a}${c}.md`;
          const wired = wire([path, `${folder}/keep.md`], [path]);

          await wired.renameFile(path, `${folder}/${path}`);

          expect(wired.passed).toStrictEqual([[`${folder}/${path}`, path]]);
          expect(wired.notify).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('puts back a folder renamed to a name adding a refused character when an item file is anywhere under it, following none of the moves', async () => {
    await fc.assert(
      fc.asyncProperty(refusedChar, async (c) => {
        const files = ['notes/plain.md', 'notes/deep/er/card.md'];
        const wired = wire(files, ['notes/deep/er/card.md']);
        const folder = wired.get('notes');

        await wired.renameFile('notes', `no${c}tes`);

        expect(folder.path).toBe('notes');
        expect(
          wired
            .files()
            .map((file) => file.path)
            .sort()
        ).toStrictEqual([...files].sort());
        expect(wired.passed).toStrictEqual([]);
        expect(wired.follow).not.toHaveBeenCalled();
        expect(wired.linkUpdates).toStrictEqual([[]]);
        expect(wired.renameFileSpy).toHaveBeenCalledOnce();
        // The user's rename and the undo, which joined its job
        expect(wired.runAsyncLinkUpdate).toHaveBeenCalledTimes(2);
        expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
          said.folder(listChars([c]))
        );
      })
    );
  });

  it('puts back a folder moved into one whose path adds a refused character', async () => {
    const wired = wire(['x[y]/keep.md', 'notes/card.md'], ['notes/card.md']);

    await wired.renameFile('notes', 'x[y]/notes');

    expect(wired.get('notes').path).toBe('notes');
    expect(wired.get('notes/card.md').path).toBe('notes/card.md');
    expect(wired.passed).toStrictEqual([]);
  });

  it('leaves alone what is neither file nor folder, and does not look for items in it', async () => {
    const wired = wire(['notes/card.md'], ['notes/card.md', 'odd']);
    const odd = wired.add('odd', new OddEntry());
    wired.add('notes/odd', new OddEntry());

    setPath(odd, 'o|dd');
    expect(wired.guard.handleRename(odd, 'odd')).toBe(false);
    expect(wired.isItemFile).not.toHaveBeenCalled();
    await wired.renameFile('notes', 'no|tes');
    // The folder is put back for its file, never asking after the other entry
    expect(wired.get('notes/odd')).toBeDefined();
    expect(wired.isItemFile).toHaveBeenCalledExactlyOnceWith(
      wired.get('notes/card.md'),
      'notes/card.md'
    );
  });

  it('leaves a folder holding no item file renamed, and its files followed as usual', async () => {
    const wired = wire(['notes/a.md', 'notes/sub/b.md'], ['cards/c.md']);

    await wired.renameFile('notes', 'no|tes');

    expect(wired.passed).toStrictEqual([
      ['no|tes', 'notes'],
      ['no|tes/a.md', 'notes/a.md'],
      ['no|tes/sub', 'notes/sub'],
      ['no|tes/sub/b.md', 'notes/sub/b.md'],
    ]);
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it('puts the same rename back once a session: made again, as a sync client might, it stays and is followed, with a notice', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');

    await wired.renameFile('cards/a.md', 'cards/a|b.md');
    await wired.renameFile('cards/a.md', 'cards/a|b.md');

    expect(file.path).toBe('cards/a|b.md');
    expect(wired.passed).toStrictEqual([['cards/a|b.md', 'cards/a.md']]);
    // Once by each rename asked for, once by the one undo
    expect(wired.renameFileSpy).toHaveBeenCalledTimes(2);
    // The two renames asked for, and the one undo
    expect(wired.runAsyncLinkUpdate).toHaveBeenCalledTimes(3);
    expect(wired.notify).toHaveBeenLastCalledWith(
      said.stays('cards/a|b.md', '|')
    );
    // Another rename of it is judged afresh
    await wired.renameFile('cards/a|b.md', 'cards/a|b>.md');
    expect(file.path).toBe('cards/a|b.md');
  });

  it('leaves a folder put back once where it is the second time, judging none of its files on their own', async () => {
    const wired = wire(['notes/card.md'], ['notes/card.md']);

    await wired.renameFile('notes', 'no>tes');
    await wired.renameFile('notes', 'no>tes');

    expect(wired.get('no>tes/card.md')).toBeDefined();
    expect(wired.passed).toStrictEqual([
      ['no>tes', 'notes'],
      ['no>tes/card.md', 'notes/card.md'],
    ]);
    expect(wired.notify).toHaveBeenLastCalledWith(said.stays('no>tes', '>'));
  });

  it('puts back a rename made outside any link update, as by sync or another plugin, in a link update of its own', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');

    await wired.rename(file, 'cards/a^b.md');
    await wired.drained();

    expect(file.path).toBe('cards/a.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.linkUpdates).toStrictEqual([['cards/a.md']]);
    expect(wired.notify).toHaveBeenCalledOnce();
  });

  it('follows other renames as usual while an undo waits its turn, those into or onto where it moves too', async () => {
    const wired = wire(
      ['cards/a.md', 'notes/card.md', 'other.md', 'x.md', 'z.md'],
      ['cards/a.md', 'notes/card.md']
    );
    const release = wired.hold();
    await wired.rename(wired.get('cards/a.md'), 'cards/a|b.md');
    await wired.rename(wired.get('notes'), 'no|tes');
    wired.passed.length = 0;

    await wired.rename(wired.get('other.md'), 'other 2.md');
    // Into the folder being put back, and onto the path a file goes back to
    await wired.rename(wired.get('x.md'), 'no|tes/x.md');
    await wired.rename(wired.get('z.md'), 'z2.md');
    await wired.rename(wired.get('z2.md'), 'cards/a.md');

    expect(wired.passed).toStrictEqual([
      ['other 2.md', 'other.md'],
      ['no|tes/x.md', 'x.md'],
      ['z2.md', 'z.md'],
      ['cards/a.md', 'z2.md'],
    ]);
    release();
    await wired.drained();
  });

  it('asks after no file in a folder whose path no item row names, and undoes nothing for a file whose row is not its own', async () => {
    const wired = wire(
      ['notes/a.md', 'notes/b.md', 'other/c.md'],
      ['other/c.md', 'notes/b.md']
    );
    // `notes/b.md` is named by a row whose note it isn't
    wired.isItemFile.mockImplementation((_file, path) => path === 'other/c.md');

    await wired.renameFile('notes', 'no|tes');

    expect(wired.referencesUnder).toHaveBeenCalledWith('notes');
    expect(wired.isItemFile.mock.calls.map(([, path]) => path)).toStrictEqual([
      'notes/b.md',
    ]);
    expect(wired.get('no|tes/a.md')).toBeDefined();
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it('follows a file moved into a folder while the folder waits to be put back, wherever the undo takes it', async () => {
    // A plain note, as snippets are taken from
    const wired = wire(['notes/card.md', 'x.md'], ['notes/card.md']);
    const x = wired.get('x.md');
    const release = wired.hold();
    await wired.rename(wired.get('notes'), 'no|tes');
    await wired.rename(x, 'no|tes/x.md');

    release();
    await wired.drained();

    expect(x.path).toBe('notes/x.md');
    expect(wired.passed).toStrictEqual([
      ['no|tes/x.md', 'x.md'],
      ['notes/x.md', 'no|tes/x.md'],
    ]);
    expect(wired.references).toStrictEqual(new Set(['notes/card.md']));
  });

  it('lets a rename made while the undo waits its turn stand, following the file there from where it was', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    const release = wired.hold();
    await wired.rename(file, 'cards/a|b.md');
    await wired.rename(file, 'cards/a2.md');

    release();
    await wired.drained();

    expect(file.path).toBe('cards/a2.md');
    expect(wired.follow).toHaveBeenCalledExactlyOnceWith(file, 'cards/a.md');
    expect(wired.references).toStrictEqual(new Set(['cards/a2.md']));
    expect(wired.notify).not.toHaveBeenCalled();
    // Only the user's renames
    expect(wired.renameFileSpy).not.toHaveBeenCalled();
  });

  it('judges a rename made while the undo waits afresh, putting it back from there when it still breaks links', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    const release = wired.hold();
    await wired.rename(file, 'cards/a|b.md');
    await wired.rename(file, 'cards/z|.md');

    release();
    await wired.drained();

    expect(file.path).toBe('cards/a.md');
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.passed).toStrictEqual([]);
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('|'));
  });

  it('judges a file renamed in a folder waiting to be put back where it will be, and puts it back once the folder is', async () => {
    const wired = wire(['notes/card.md'], ['notes/card.md']);
    const card = wired.get('notes/card.md');
    const release = wired.hold();
    await wired.rename(wired.get('notes'), 'no|tes');
    await wired.rename(card, 'no|tes/ca?rd.md');

    release();
    await wired.drained();

    expect(wired.get('notes')).toBeDefined();
    expect(card.path).toBe('notes/card.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).toHaveBeenCalledTimes(2);
    expect(wired.notify).toHaveBeenCalledWith(said.folder('|'));
    expect(wired.notify).toHaveBeenCalledWith(said.file('?'));
  });

  it('puts back a file moved out of a folder waiting to be put back once the folder is, without holding up Obsidian queue', async () => {
    const wired = wire(
      ['A/x.md', 'A/y.md', 'B#/keep.md'],
      ['A/x.md', 'A/y.md']
    );
    const x = wired.get('A/x.md');
    const release = wired.holdCache();
    // Waits for a clean cache, ahead of the folder's undo
    const moving = wired.renameFile('A/x.md', 'B#/x.md');
    await wired.rename(wired.get('A'), 'A|z');

    release();
    await moving;

    expect(wired.get('A')).toBeDefined();
    expect(x.path).toBe('A/x.md');
    expect(wired.get('A/y.md')).toBeDefined();
    expect(wired.passed).toStrictEqual([]);
    expect(wired.follow).not.toHaveBeenCalled();
  });

  it('says nothing, and keeps its one undo, when the rename is put back by someone else first', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    const release = wired.hold();
    await wired.rename(file, 'cards/a|b.md');
    await wired.rename(file, 'cards/a.md');
    release();
    await wired.drained();

    expect(wired.notify).not.toHaveBeenCalled();
    expect(wired.passed).toStrictEqual([]);
    await wired.renameFile('cards/a.md', 'cards/a|b.md');
    expect(file.path).toBe('cards/a.md');
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('|'));
  });

  it('judges a file renamed back onto where the bad rename put it, once the undo has run, afresh', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    const release = wired.hold();
    await wired.rename(file, 'cards/a|b.md');
    // Queued behind the undo, before it settles
    void wired.updateQueue.queue(() => wired.rename(file, 'cards/a|b.md'));

    release();
    await wired.drained();

    expect(file.path).toBe('cards/a|b.md');
    // Each of what happened: put back, then back again and left
    expect(wired.notify).toHaveBeenCalledTimes(2);
    expect(wired.notify).toHaveBeenCalledWith(said.stays('cards/a|b.md', '|'));
    expect(wired.notify).toHaveBeenCalledWith(said.file('|'));
    expect(wired.references).toStrictEqual(new Set(['cards/a|b.md']));
  });

  it.each([
    ['its only item', ['A/x.md'], ['A/x.md']],
    [
      'other items too',
      ['A/x.md', 'A/y.md', 'A/sub/z.md'],
      ['A/x.md', 'A/y.md', 'A/sub/z.md'],
    ],
  ])(
    'puts back a folder renamed while a file in it, %s, waited to be put back itself, then the file, in one notice',
    async (_, files, items) => {
      await fc.assert(
        fc.asyncProperty(
          refusedChar,
          refusedChar,
          plainName,
          async (fileChar, folderChar, extra) => {
            const wired = wire(files, items);
            const x = wired.get('A/x.md');
            const release = wired.hold();
            const bad = `x${fileChar}${extra}.md`;
            await wired.rename(x, `A/${bad}`);
            await wired.rename(wired.get('A'), `A${folderChar}`);

            release();
            await wired.drained();

            expect(wired.get('A')).toBeDefined();
            expect(
              wired
                .files()
                .map((file) => file.path)
                .sort()
            ).toStrictEqual([...files].sort());
            expect(wired.references).toStrictEqual(new Set(items));
            expect(wired.passed).toStrictEqual([]);
            expect(wired.follow).not.toHaveBeenCalled();
            expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
              said.file(listChars([...new Set([folderChar, fileChar])]))
            );
          }
        ),
        { numRuns: 30 }
      );
    }
  );

  it('puts back the folder, then the file, in one notice, where it has no link update to join', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md'], {
      linkUpdater: false,
    });
    const x = wired.get('A/x.md');
    const release = wired.hold();
    await wired.rename(x, 'A/x#.md');
    await wired.rename(wired.get('A'), 'A^');

    release();
    await wired.drained();

    expect(x.path).toBe('A/x.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('^ or #'));
  });

  it.each([true, false])(
    'puts back a folder in a folder waiting to be put back, and what is in it, after the outer one (link update to join: %s)',
    async (linkUpdater) => {
      const wired = wire(['A/S/x.md', 'A/y.md'], ['A/S/x.md', 'A/y.md'], {
        linkUpdater,
      });
      const sub = wired.get('A/S');
      const release = wired.hold();
      await wired.rename(sub, 'A/S#');
      await wired.rename(wired.get('A'), 'A^');

      release();
      await wired.drained();

      expect(sub.path).toBe('A/S');
      expect(wired.get('A/S/x.md')).toBeDefined();
      expect(wired.passed).toStrictEqual([]);
      expect(wired.follow).not.toHaveBeenCalled();
      expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('^ or #'));
    }
  );

  it.each([true, false])(
    'puts back folders in folders and a file in them, each after the one it is in, in one notice (link update to join: %s)',
    async (linkUpdater) => {
      const wired = wire(['A/B/x.md'], ['A/B/x.md'], { linkUpdater });
      const x = wired.get('A/B/x.md');
      const b = wired.get('A/B');
      const release = wired.hold();
      await wired.rename(x, 'A/B/x#.md');
      await wired.rename(b, 'A/B|');
      await wired.rename(wired.get('A'), 'A^');

      release();
      await wired.drained();

      expect(wired.get('A')).toBeDefined();
      expect(b.path).toBe('A/B');
      expect(x.path).toBe('A/B/x.md');
      expect(wired.passed).toStrictEqual([]);
      expect(wired.follow).not.toHaveBeenCalled();
      expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
        said.file('^ | or #')
      );
    }
  );

  it("tells only of the folder when it couldn't be put back, following its files from where they were", async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const folder = wired.get('A');
    const release = wired.hold();
    await wired.rename(x, 'A/x#.md');
    wired.hooks.after = (entry) => {
      if (entry === folder && folder.path === 'A^') wired.add('A/taken.md');
    };
    await wired.rename(folder, 'A^');

    release();
    await wired.drained();

    expect(x.path).toBe('A^/x#.md');
    expect(
      wired.follow.mock.calls.map(([file, from]) => [file.path, from]).sort()
    ).toStrictEqual([
      ['A^/x#.md', 'A/x.md'],
      ['A^/y.md', 'A/y.md'],
    ]);
    // Naming what its file still holds too
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
      said.failed('A^', '^ or #')
    );
  });

  it('tells of the folder and the file it put back, though the folder moved on before telling of it', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const folder = wired.get('A');
    const release = wired.hold();
    await wired.rename(x, 'A/x#.md');
    await wired.rename(folder, 'A^');
    // Once the folder's undo has run, before it is over
    void wired.updateQueue.queue(() => wired.rename(folder, 'B'));

    release();
    await wired.drained();

    expect(folder.path).toBe('B');
    expect(x.path).toBe('B/x.md');
    expect(wired.references).toStrictEqual(new Set(['B/x.md', 'B/y.md']));
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('^ or #'));
  });

  it('puts back folders three deep and the file in them, each after the folder it is in', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(refusedChar, { minLength: 4, maxLength: 4 }),
        async ([a, b, c, d]) => {
          const wired = wire(['A/B/C/x.md'], ['A/B/C/x.md']);
          const x = wired.get('A/B/C/x.md');
          const release = wired.hold();
          await wired.rename(x, `A/B/C/x${d}.md`);
          await wired.rename(wired.get('A/B/C'), `A/B/C${c}`);
          await wired.rename(wired.get('A/B'), `A/B${b}`);
          await wired.rename(wired.get('A'), `A${a}`);

          release();
          await wired.drained();

          expect(x.path).toBe('A/B/C/x.md');
          expect(wired.passed).toStrictEqual([]);
          expect(wired.follow).not.toHaveBeenCalled();
          expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
            said.file(listChars([...new Set([a, b, c, d])]))
          );
        }
      ),
      { numRuns: 15 }
    );
  });

  it('judges afresh a file renamed bad again after its folder and it were put back, before telling of them', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const release = wired.hold();
    await wired.rename(x, 'A/x#.md');
    await wired.rename(wired.get('A'), 'A^');
    // After both are put back, before either is over: as a sync client might
    void wired.updateQueue.queue(() => wired.rename(x, 'A/x#.md'));

    release();
    await wired.drained();

    expect(x.path).toBe('A/x#.md');
    expect(wired.references).toStrictEqual(new Set(['A/x#.md', 'A/y.md']));
    expect(wired.notify).toHaveBeenCalledTimes(2);
    expect(wired.notify).toHaveBeenCalledWith(said.stays('A/x#.md', '#'));
    expect(wired.notify).toHaveBeenCalledWith(said.file('^ or #'));
  });

  it('runs again, once its folder is back, the undo of a file that failed before the folder was renamed', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const folder = wired.get('A');
    wired.hooks.after = (entry) => {
      if (entry !== x || x.path !== 'A/x#.md') return;
      wired.hooks.after = undefined;
      // Its old name taken: the undo fails
      wired.add('A/x.md');
    };
    await wired.rename(x, 'A/x#.md');
    // After the undo is tried, before it is over
    void wired.updateQueue.queue(() => wired.rename(folder, 'A^'));

    await wired.drained();

    expect(folder.path).toBe('A');
    expect(x.path).toBe('A/x#.md');
    expect(wired.follow).toHaveBeenCalledExactlyOnceWith(x, 'A/x.md');
    expect(wired.notify).toHaveBeenCalledTimes(2);
    expect(wired.notify).toHaveBeenCalledWith(said.failed('A/x#.md', '#'));
    expect(wired.notify).toHaveBeenCalledWith(said.folder('^'));
  });

  it('takes a file put back by hand after its undo failed as back where the database has it, following and telling nothing', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    wired.hooks.after = (entry) => {
      if (entry !== file || file.path !== 'cards/a|b.md') return;
      wired.hooks.after = undefined;
      wired.add('cards/a.md');
    };
    await wired.rename(file, 'cards/a|b.md');
    // After the undo failed, before it is over
    void wired.updateQueue.queue(async () => {
      wired.remove('cards/a.md');
      await wired.rename(file, 'cards/a.md');
    });

    await wired.drained();

    expect(file.path).toBe('cards/a.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it('lets go of what waits on an undo whose op Obsidian dropped with its failed job', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const release = wired.hold();
    await wired.rename(wired.get('A/x.md'), 'A/x#.md');
    // The folder's undo is taken in, and never run
    wired.runAsyncLinkUpdate.mockImplementationOnce(() => Promise.resolve());
    await wired.rename(wired.get('A'), 'A^');

    release();
    await wired.drained();

    expect(
      wired.follow.mock.calls.map(([file, from]) => [file.path, from]).sort()
    ).toStrictEqual([
      ['A^/x#.md', 'A/x.md'],
      ['A^/y.md', 'A/y.md'],
    ]);
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
      said.failed('A^', '^ or #')
    );
  });

  it('puts back the folder, then the file, when the folder is renamed through a link update while the file waits', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const y = wired.get('A/y.md');
    const release = wired.hold();
    // Its link update is queued ahead of the files' undos
    const moving = wired.renameFile('A', 'A>');
    await wired.rename(x, 'A/x#.md');
    await wired.rename(y, 'A/y|.md');

    release();
    await moving;
    await wired.drained();

    expect(x.path).toBe('A/x.md');
    expect(y.path).toBe('A/y.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('> # or |'));
  });

  it("tells of a file it couldn't put back once its folder was, apart from the folder", async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const release = wired.hold();
    await wired.rename(x, 'A/x#.md');
    await wired.rename(wired.get('A'), 'A^');
    // Something takes the file's old name once the folder is back
    wired.hooks.after = (entry) => {
      if (entry === x && x.path === 'A/x#.md') wired.add('A/x.md');
    };

    release();
    await wired.drained();

    expect(x.path).toBe('A/x#.md');
    expect(wired.follow).toHaveBeenCalledExactlyOnceWith(x, 'A/x.md');
    expect(wired.notify.mock.calls).toStrictEqual([
      [said.failed('A/x#.md', '#')],
      [said.folder('^')],
    ]);
  });

  it('puts back a folder renamed while a file in it waits inside the link update of its own bad rename, then the file, in one notice', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const folder = wired.get('A');
    // Renamed as the file's undo joins the job, before it is tried
    wired.hooks.after = (entry) => {
      if (entry !== x || x.path !== 'A/x#.md') return;
      wired.hooks.after = undefined;
      void wired.rename(folder, 'A^');
    };

    await wired.renameFile('A/x.md', 'A/x#.md');

    expect(folder.path).toBe('A');
    expect(x.path).toBe('A/x.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('^ or #'));
  });

  it('tells of a file put back before its folder was renamed, and of the folder, each on its own', async () => {
    const wired = wire(['A/x.md'], ['A/x.md']);
    const x = wired.get('A/x.md');
    const folder = wired.get('A');
    await wired.rename(x, 'A/x#.md');
    // Behind the file's undo, before it is over
    void wired.updateQueue.queue(() => wired.rename(folder, 'A^'));

    await wired.drained();

    expect(folder.path).toBe('A');
    expect(x.path).toBe('A/x.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).toHaveBeenCalledTimes(2);
    expect(wired.notify).toHaveBeenCalledWith(said.file('#'));
    expect(wired.notify).toHaveBeenCalledWith(said.folder('^'));
  });

  it('tells of a file put back on its own when someone else put its folder back first', async () => {
    const wired = wire(['A/x.md', 'A/y.md'], ['A/x.md', 'A/y.md']);
    const x = wired.get('A/x.md');
    const folder = wired.get('A');
    const release = wired.hold();
    await wired.rename(x, 'A/x#.md');
    await wired.rename(folder, 'A^');
    await wired.rename(folder, 'A');

    release();
    await wired.drained();

    expect(x.path).toBe('A/x.md');
    expect(wired.passed).toStrictEqual([]);
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.file('#'));
  });

  it('puts back a folder renamed again while it waited, taking over what is in it', async () => {
    const wired = wire(['notes/card.md'], ['notes/card.md']);
    const folder = wired.get('notes');
    const release = wired.hold();
    await wired.rename(folder, 'no|tes');
    await wired.rename(folder, 'no|t|es');

    release();
    await wired.drained();

    expect(folder.path).toBe('notes');
    expect(wired.get('notes/card.md')).toBeDefined();
    expect(wired.passed).toStrictEqual([]);
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(said.folder('|'));
  });

  it('leaves alone a file now at the path a file waiting to be put back was deleted from, and marks that one deleted where the database has it', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const release = wired.hold();
    await wired.rename(wired.get('cards/a.md'), 'cards/a|b.md');
    wired.remove('cards/a|b.md');
    const other = wired.add('cards/a|b.md');

    release();
    await wired.drained();

    expect(other.path).toBe('cards/a|b.md');
    expect(wired.vault.getAbstractFileByPath('cards/a.md')).toBeNull();
    expect(wired.deleted).toStrictEqual([['cards/a|b.md', 'cards/a.md']]);
    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it('marks a file deleted from a folder waiting to be put back deleted where the database has it, and puts the rest back', async () => {
    const wired = wire(
      ['notes/card.md', 'notes/other.md'],
      ['notes/card.md', 'notes/other.md']
    );
    const release = wired.hold();
    await wired.rename(wired.get('notes'), 'no|tes');
    wired.remove('no|tes/card.md');

    release();
    await wired.drained();

    expect(wired.deleted).toStrictEqual([['no|tes/card.md', 'notes/card.md']]);
    expect(wired.get('notes/other.md')).toBeDefined();
    expect(wired.references).toStrictEqual(new Set(['notes/other.md']));
    expect(wired.follow).not.toHaveBeenCalled();
  });

  it('follows nothing of a folder deleted while it waited to be put back, nor tells of it', async () => {
    const wired = wire(['notes/card.md'], ['notes/card.md']);
    const release = wired.hold();
    await wired.rename(wired.get('notes'), 'no|tes');
    wired.remove('no|tes');

    release();
    await wired.drained();

    expect(wired.follow).not.toHaveBeenCalled();
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it('marks a file deleted where it is when no undo holds it', () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);

    wired.remove('cards/a.md');

    expect(wired.deleted).toStrictEqual([['cards/a.md', 'cards/a.md']]);
  });

  it('lets a rename made while the undo waits for a clean cache stand', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    const release = wired.holdCache();
    await wired.rename(file, 'cards/a|b.md');
    await new Promise((done) => setTimeout(done, 0));
    await wired.rename(file, 'cards/y.md');

    release();
    await wired.drained();

    expect(file.path).toBe('cards/y.md');
    expect(wired.follow).toHaveBeenCalledExactlyOnceWith(file, 'cards/a.md');
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it('puts a rename back through the public rename, once Obsidian is past its queue, where it has no link update to join', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md'], { linkUpdater: false });
    const file = wired.get('cards/a.md');

    await wired.renameFile('cards/a.md', 'cards/a|b.md');

    expect(file.path).toBe('cards/a.md');
    expect(wired.renameFileSpy.mock.calls).toStrictEqual([
      [file, 'cards/a|b.md'],
      [file, 'cards/a.md'],
    ]);
    expect(wired.passed).toStrictEqual([]);
    expect(wired.notify).toHaveBeenCalledOnce();
  });

  it('tells nothing of an undo it had no file left to try', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md'], { linkUpdater: false });
    const release = wired.hold();
    await wired.rename(wired.get('cards/a.md'), 'cards/a|b.md');
    wired.remove('cards/a|b.md');

    release();
    await wired.drained();

    expect(wired.renameFileSpy).not.toHaveBeenCalled();
    expect(wired.notify).not.toHaveBeenCalled();
  });

  it('follows a file renamed within, or moved out of, a folder waiting to be put back, from where it was before the folder moved', async () => {
    const wired = wire(
      ['notes/card.md', 'notes/paper.pdf', 'out/keep.md'],
      ['notes/card.md', 'notes/paper.pdf']
    );
    const card = wired.get('notes/card.md');
    const paper = wired.get('notes/paper.pdf');
    const release = wired.hold();
    await wired.rename(wired.get('notes'), 'no|tes');
    await wired.rename(card, 'no|tes/card 2.md');
    await wired.rename(paper, 'out/paper.pdf');

    release();
    await wired.drained();

    expect(card.path).toBe('notes/card 2.md');
    expect(paper.path).toBe('out/paper.pdf');
    expect(wired.references).toStrictEqual(
      new Set(['notes/card 2.md', 'out/paper.pdf'])
    );
    // Its move back with the folder is no longer the undo's
    expect(wired.passed).toStrictEqual([
      ['notes/card 2.md', 'no|tes/card 2.md'],
    ]);
  });

  it('puts the same rename back again when it could not be the first time', async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    const release = wired.hold();
    await wired.rename(file, 'cards/a|b.md');
    await wired.rename(file, 'cards/b.md');
    release();
    await wired.drained();
    await wired.renameFile('cards/b.md', 'cards/a.md');

    await wired.renameFile('cards/a.md', 'cards/a|b.md');

    expect(file.path).toBe('cards/a.md');
    expect(wired.notify).toHaveBeenLastCalledWith(said.file('|'));
  });

  it("follows a file it couldn't put back, once Obsidian is past the attempt, and says so", async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    // Something takes the old path before the undo's own link update runs
    wired.hooks.after = (entry) => {
      if (entry === file) wired.add('cards/a.md');
    };

    await wired.rename(file, 'cards/a:b.md');
    await wired.drained();

    expect(file.path).toBe('cards/a:b.md');
    expect(wired.follow).toHaveBeenCalledExactlyOnceWith(file, 'cards/a.md');
    expect(wired.references).toStrictEqual(new Set(['cards/a:b.md']));
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
      said.failed('cards/a:b.md', ':')
    );
  });

  it("follows every file in a folder it couldn't put back, from where each was", async () => {
    const wired = wire(
      ['notes/card.md', 'notes/sub/plain.md'],
      ['notes/card.md']
    );
    // Neither file nor folder: nothing to follow
    wired.add('notes/sub/odd', new OddEntry());
    const folder = wired.get('notes');

    wired.hooks.after = (entry) => {
      if (entry === folder) wired.add('notes/taken.md');
    };
    await wired.rename(folder, 'no*tes');
    await wired.drained();

    expect(folder.path).toBe('no*tes');
    expect(
      wired.follow.mock.calls.map(([file, from]) => [file.path, from])
    ).toStrictEqual([
      ['no*tes/card.md', 'notes/card.md'],
      ['no*tes/sub/plain.md', 'notes/sub/plain.md'],
    ]);
    expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
      said.failed('no*tes', '*')
    );
  });

  it("follows a file whose undo failed inside the rename's own link update, which still updates links for that rename", async () => {
    const wired = wire(['cards/a.md'], ['cards/a.md']);
    const file = wired.get('cards/a.md');
    // Taken while the job that renamed it still runs, before its undo does
    wired.hooks.after = (entry) => {
      if (entry === file && entry.path !== 'cards/a.md') {
        wired.add('cards/a.md');
      }
    };

    await wired.renameFile('cards/a.md', 'cards/a"b.md');

    expect(file.path).toBe('cards/a"b.md');
    expect(wired.linkUpdates).toStrictEqual([['cards/a"b.md']]);
    expect(wired.follow).toHaveBeenCalledExactlyOnceWith(file, 'cards/a.md');
    expect(wired.notify).toHaveBeenCalledOnce();
  });
});
