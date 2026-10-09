import { type App, type TAbstractFile, TFile, TFolder } from 'obsidian';
import { FORBIDDEN_TITLE_CHARS } from './constants';
import type { Timer } from './ir-id-warning-notice';
import { afterLinkUpdates } from './link-update-queue';

/**
 * The characters an item file's path may not gain, nor that of a folder
 * holding one: those a title can't hold, but `/`, which parts a path. Some end
 * a link's path early: `|` a wikilink's, `>` an angled markdown target's, `#`
 * any link's.
 */
export const REFUSED_PATH_CHARS: ReadonlySet<string> = new Set(
  [...FORBIDDEN_TITLE_CHARS].filter((char) => char !== '/')
);

/** Each refused character `path` holds, once, in the order they first appear. */
export function refusedCharsIn(path: string): string[] {
  return [
    ...new Set(Array.from(path).filter((char) => REFUSED_PATH_CHARS.has(char))),
  ];
}

const countOf = (text: string, char: string) =>
  Array.from(text).filter((c) => c === char).length;

/**
 * The refused characters `to` gains over `from`, once each, in the order `to`
 * first holds them. A path made before the rule may keep what it had, so the
 * two are compared name by name, from the end: the file's (or folder's) name
 * against its old name, and each folder above it against the folder as far
 * above it before, or against nothing where the old path was shallower. A
 * folder name the old path already held, at any level, passes as it is, so
 * moving into, out of or within a folder made before the rule needs no
 * renaming. A character only moving from one name to another is gained by
 * the name it moved to.
 */
export function addedRefusedChars(from: string, to: string): string[] {
  const old = from.split('/');
  const now = to.split('/');
  const oldFolders = new Set(old.slice(0, -1));
  const gained = new Set<string>();
  now.forEach((name, i) => {
    if (i < now.length - 1 && oldFolders.has(name)) return;
    const counterpart = old[old.length - now.length + i] ?? '';
    for (const char of refusedCharsIn(name)) {
      if (countOf(name, char) > countOf(counterpart, char)) gained.add(char);
    }
  });
  return refusedCharsIn(to).filter((char) => gained.has(char));
}

/** `chars` as a sentence lists them: `#, | or >`. */
export function listChars(chars: readonly string[]): string {
  const named = chars.map((char) => (char === '\n' ? 'a line break' : char));
  const last = named.pop();
  return named.length > 0 ? `${named.join(' ')} or ${last}` : `${last}`;
}

/** How many paths {@link refusedPathsWarning} names before counting the rest. */
const SHOWN_PATHS = 3;

/**
 * The notice for item files whose paths already hold a refused character,
 * made before the rule, or moved while Obsidian was closed or in a way it saw
 * as a new file: they are left as they are. `null` when there are none.
 */
export function refusedPathsWarning(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const shown = paths
    .slice(0, SHOWN_PATHS)
    .map((path) => `"${path}"`)
    .join(', ');
  const more =
    paths.length > SHOWN_PATHS ? ` and ${paths.length - SHOWN_PATHS} more` : '';
  const refused = [...REFUSED_PATH_CHARS]
    .map((char) => (char === '\n' ? 'line breaks' : char))
    .join(' ');
  return (
    `Incremental reading: IR files and their folders cannot contain any of ` +
    `these characters: ${refused}. Rename ${shown}${more}`
  );
}

/**
 * The notice for one item's file now at `path`, when its path breaks links to
 * it (see {@link refusedPathsWarning}); `null` when it doesn't.
 */
export function refusedPathWarning(path: string): string | null {
  return refusedCharsIn(path).length > 0 ? refusedPathsWarning([path]) : null;
}

/**
 * What the startup check does with `paths`, the item paths that break links
 * now, given `warned`, those the user was last told of: `warn` only when
 * there is one the user hasn't heard of, so the notice doesn't come back each
 * launch for the same files; and `remember`, the list to keep from here on,
 * or `null` when it is the same as before.
 */
export function startupWarning(
  paths: readonly string[],
  warned: readonly string[]
): { warn: boolean; remember: string[] | null } {
  const before = new Set(warned);
  const now = new Set(paths);
  const same =
    now.size === before.size && [...now].every((path) => before.has(path));
  return {
    warn: [...now].some((path) => !before.has(path)),
    remember: same ? null : [...now],
  };
}

/**
 * How long after the last item file arriving at a path that breaks links the
 * one notice naming them all waits: a folder that sync delivers as new files
 * arrives as many, a read apart.
 */
export const REFUSED_ARRIVALS_DELAY_MS = 1000;

/**
 * Gathers the paths of item files that arrive where their paths break links
 * into one {@link refusedPathsWarning} notice, sent with those paths once none
 * has come for {@link REFUSED_ARRIVALS_DELAY_MS}.
 */
export function createArrivalWarning({
  notify,
  timer,
}: {
  notify: (message: string, paths: string[]) => void;
  timer: Timer;
}) {
  const paths = new Set<string>();
  let cancel: (() => void) | null = null;
  return {
    add(path: string) {
      paths.add(path);
      cancel?.();
      cancel = timer(() => {
        cancel = null;
        const arrived = [...paths];
        paths.clear();
        const warning = refusedPathsWarning(arrived);
        if (warning) notify(warning, arrived);
      }, REFUSED_ARRIVALS_DELAY_MS);
    },
    /** Drop what is waiting, unsaid. */
    dispose() {
      cancel?.();
      cancel = null;
      paths.clear();
    },
  };
}

/**
 * Every file and folder in `folder`, which is at `path`, at any depth, with
 * its path there. By name: what is in a folder that just moved may still
 * have its old path, or its new one.
 */
function within(folder: TFolder, path: string): [TAbstractFile, string][] {
  return folder.children.flatMap((child): [TAbstractFile, string][] => {
    const at = `${path}/${child.name}`;
    return child instanceof TFolder
      ? [[child, at], ...within(child, at)]
      : [[child, at]];
  });
}

const parentOf = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** A rename being put back: `entry` moved from `good` to `bad`. */
interface Undo {
  entry: TFile | TFolder;
  bad: string;
  good: string;
  /**
   * `entry` and all that was in it then: where the database has each (its
   * path before any bad rename still being put back), where this undo puts it
   * back, and where the bad rename put it. One that moves on, or is deleted,
   * is no longer the undo's.
   */
  moved: Map<TAbstractFile, { before: string; back: string; put: string }>;
  /** Names the rename, to put it back once. */
  key: string;
  /** `entry` moved on or went before its turn: the rest is followed, unsaid. */
  abandoned: boolean;
  /** Whether the undo has been tried; and whether it put `entry` back. */
  tried: boolean;
  renamed: boolean;
  /** Settles once the undo has been tried. */
  done: Promise<void>;
  /** Settles once the undo is over, and has said what it did. */
  settled: Promise<void>;
  /**
   * The undos of files in `entry` whose own bad rename was still being put
   * back when `entry`'s came: run once `entry` is back, and told of in the
   * one notice with it.
   */
  inside: Undo[];
  /** The folder undo this one is told of with, should it be in one. */
  folder?: Undo;
  /**
   * The undo whose move this one's path counts on, to go first. Waited on
   * before this one asks for its rename, never inside a job: a job waiting
   * on one queued after it would hold up Obsidian's queue for good.
   */
  after?: Promise<void>;
}

/** The parts of `FileManager` an undo is run through. */
interface LinkUpdater {
  /**
   * Undocumented (read from obsidian.asar): what `renameFile` runs its
   * `Vault.rename` through. Called while one of its jobs renames (its
   * `inProgressUpdates` is an array then), it adds `op` to that job, which
   * updates links once, after all its renames, against where links resolved
   * before any of them; called otherwise, it queues a job of its own, which
   * runs `op` once the metadata cache is clean.
   */
  runAsyncLinkUpdate?: (op: () => Promise<void>) => unknown;
}

export interface ItemPathGuardOptions {
  app: App;
  /**
   * Whether `file`, which was at `path` until the rename at hand, is an item's
   * file. Asked from inside the `rename` event, so it answers at once.
   */
  isItemFile(file: TFile, path: string): boolean;
  /**
   * The paths in the folder at `folder` that live item rows name, so a folder
   * of many files costs one look. Answers at once, as `isItemFile` does.
   */
  referencesUnder(folder: string): ReadonlySet<string>;
  /** Follow `file`'s move from `oldPath`, as the rename handler does. */
  follow(file: TFile, oldPath: string): void;
  notify(message: string): void;
}

/**
 * Puts back a rename or move that gives an item file, or a folder holding
 * one, a path that gains a {@link REFUSED_PATH_CHARS refused character} (see
 * {@link addedRefusedChars}): links to it would end early there. Files that
 * are no item are left alone.
 *
 * The undo is a `Vault.rename` back, run as `FileManager.renameFile` runs one,
 * through its undocumented `runAsyncLinkUpdate` (see {@link LinkUpdater}),
 * asked for from inside the `rename` event. A rename made through
 * `renameFile` is still in its job then, so the undo joins it: links are
 * updated once, after both, and since the file is back, none changes, whether
 * Obsidian updates links at once, asks first, or not at all. Hence
 * {@link ItemPathGuardOptions.isItemFile} answers at once: any wait and the
 * job is over. A rename made outside it (by sync, say) updated no links; its
 * undo is a job of its own. Not `renameFile` itself, since an undo that fails
 * inside a job fails the whole job, and it would then update no links for the
 * user's own rename; nor one that renames a file the guard never judged: the
 * undo is tried only on the very file the bad rename moved, still where that
 * left it.
 *
 * A folder's `rename` fires before those of what is in it (both of Obsidian's
 * adapters), which keep their old paths until their own fire: the folder's
 * judges them all. Neither the bad rename's events nor the undo's are
 * followed, so `ReviewManager.handleExternalRename` sees neither; one moved
 * again meanwhile is judged afresh, and followed from where the database has
 * it. A rename is undone once a session: should a sync client put it back
 * again, it stays, and the undo can't loop.
 */
export class ItemPathGuard {
  readonly #options: ItemPathGuardOptions;
  /** Undos under way, whose events are the guard's own. */
  readonly #pending: Undo[] = [];
  /** Renames undone already this session, by key. */
  readonly #undone = new Set<string>();

  constructor(options: ItemPathGuardOptions) {
    this.#options = options;
  }

  /**
   * Judge a `rename` event, undoing it if it must be.
   * @returns whether the guard has the event: the caller follows nothing
   */
  handleRename(entry: TAbstractFile, oldPath: string): boolean {
    const holders = this.#pending.filter((undo) => undo.moved.has(entry));
    if (holders.length > 0) {
      // Where the database has it, back where an undo puts it, or where a
      // bad rename put it while its undo waits: the undos' own
      const own = holders.some((undo) => {
        const { before, back, put } = undo.moved.get(entry)!;
        // Once tried, only where the database has it: anything else is a
        // move of someone else's
        const own = undo.tried ? [before] : [before, back, put];
        return own.includes(entry.path);
      });
      if (!own) this.#movedOn(entry, holders[0]);
      return true;
    }
    if (!(entry instanceof TFile || entry instanceof TFolder)) return false;
    if (addedRefusedChars(oldPath, entry.path).length === 0) return false;
    // In a folder that moved, whose own event judged it first
    if (!this.#folderExists(parentOf(oldPath))) return false;
    return this.#judge(entry, oldPath, entry.path);
  }

  /**
   * Where the database has `entry`, deleted while an undo held it, which is
   * not where it was deleted from; `null` for any other. It is the undo's no
   * longer.
   */
  pathBeforeDeletion(entry: TAbstractFile): string | null {
    return this.#release(entry)?.before ?? null;
  }

  /**
   * Take `entry` from every undo holding it. The undo of its own bad rename,
   * unless it put it back already, is given up: moved on or gone, it says
   * nothing of it; taken over by a folder's undo, it is the folder's to run,
   * or to run again should it have failed. One that put it back still tells
   * what it did.
   * @returns where the database has it, and the undo of its own bad rename
   *   when that one is given up here; `null` when no undo held it
   */
  #release(entry: TAbstractFile): { before: string; own: Undo | null } | null {
    let found: { before: string; own: Undo | null } | null = null;
    for (const undo of this.#pending) {
      const held = undo.moved.get(entry);
      if (held === undefined) continue;
      undo.moved.delete(entry);
      found ??= { before: held.before, own: null };
      // Put back already, it tells what it did
      if (entry !== undo.entry || undo.renamed) continue;
      undo.abandoned = true;
      found.own = undo;
    }
    return found;
  }

  /**
   * `entry`, held by `undo`, moved again before the undo's turn: no longer
   * the undo's, and judged where it will be once the undo puts the rest back,
   * against where the database has it. Followed from there if let stand.
   */
  #movedOn(entry: TAbstractFile, undo: Undo) {
    const { before } = this.#release(entry)!;
    // Only what is in a folder is under where the folder was put. What the
    // folder held is put back after it, whose old path counts on it
    const eventual = entry.path.startsWith(`${undo.bad}/`)
      ? undo.good + entry.path.slice(undo.bad.length)
      : entry.path;
    const waitFor = entry === undo.entry ? undefined : undo;
    if (entry instanceof TFolder) {
      // Its files are judged by their own events, unless an undo takes them
      this.#judge(entry, before, eventual, waitFor);
    } else if (entry instanceof TFile) {
      if (!this.#judge(entry, before, eventual, waitFor)) {
        this.#options.follow(entry, before);
      }
    }
  }

  /**
   * Undo `entry`'s move from `from` to `to` if it gains a refused character
   * and is, or holds, an item's file. `waitFor` is an undo whose move `to`
   * counts on.
   * @returns whether it is to be undone
   */
  #judge(
    entry: TFile | TFolder,
    from: string,
    to: string,
    waitFor?: Undo
  ): boolean {
    const added = addedRefusedChars(from, to);
    if (added.length === 0 || !this.#holdsItem(entry, from)) return false;
    const key = `${from}\0${to}`;
    if (this.#undone.has(key)) {
      this.#options.notify(
        `Incremental reading: "${to}" was already moved back once, so it ` +
          `stays. Rename it without ${listChars(added)}`
      );
      return false;
    }
    const moved: Undo['moved'] = new Map([
      [entry, { before: from, back: from, put: to }],
    ]);
    // Files whose own bad rename was still to be put back: put back too,
    // once the folder is
    const owns: [TFile | TFolder, Undo][] = [];
    if (entry instanceof TFolder) {
      for (const [inside, rest] of within(entry, '')) {
        // Where the database has it, should another undo hold it
        const held = this.#release(inside);
        const back = from + rest;
        moved.set(inside, {
          before: held?.before ?? back,
          back,
          put: to + rest,
        });
        if (held?.own) owns.push([held.own.entry, held.own]);
      }
    }
    const undo = this.#undo(entry, from, to, moved, key, waitFor);
    // Outermost first, as `within` lists a folder before what is in it: each
    // after the undo of the folder it is in, from where that one leaves it
    const inners: Undo[] = [];
    for (const [inside, own] of owns) {
      let after = undo;
      let left = moved.get(inside)!.back;
      for (const inner of inners) {
        if (!left.startsWith(`${inner.bad}/`)) continue;
        after = inner;
        left = inner.good + left.slice(inner.bad.length);
      }
      const again: Undo['moved'] = new Map([
        [inside, { before: own.good, back: own.good, put: left }],
      ]);
      if (inside instanceof TFolder) {
        for (const [deeper, at] of within(inside, own.good)) {
          // From where the folder's undo leaves it
          const { before, back } = moved.get(deeper)!;
          again.set(deeper, { before, back: at, put: back });
        }
      }
      const inner = this.#undo(inside, own.good, left, again, own.key, after);
      inner.folder = undo;
      undo.inside.push(inner);
      inners.push(inner);
    }
    return true;
  }

  #folderExists(path: string): boolean {
    if (path === '') return true;
    return (
      this.#options.app.vault.getAbstractFileByPath(path) instanceof TFolder
    );
  }

  /**
   * Whether `entry`, which was at `path`, is an item's file, or a folder with
   * one anywhere in it.
   */
  #holdsItem(entry: TFile | TFolder, path: string): boolean {
    const options = this.#options;
    if (entry instanceof TFile) return options.isItemFile(entry, path);
    const references = options.referencesUnder(path);
    // By name: what is in it still has its old path, or may have its new one.
    // One whose own bad rename is still being put back is where the database
    // has it
    const holds = (folder: TFolder, at: string): boolean =>
      folder.children.some((child) => {
        const childPath = `${at}/${child.name}`;
        if (child instanceof TFolder) return holds(child, childPath);
        const path = this.#heldBefore(child) ?? childPath;
        return (
          child instanceof TFile &&
          references.has(path) &&
          options.isItemFile(child, path)
        );
      });
    return holds(entry, path);
  }

  /** Where the database has `entry`, should an undo hold it. */
  #heldBefore(entry: TAbstractFile): string | null {
    for (const undo of this.#pending) {
      const held = undo.moved.get(entry);
      if (held) return held.before;
    }
    return null;
  }

  /**
   * Put `entry` back from `bad` to `good`, once `after` is over: a job of its
   * own, or the one under way.
   */
  #undo(
    entry: TFile | TFolder,
    good: string,
    bad: string,
    moved: Undo['moved'],
    key: string,
    after?: Undo
  ): Undo {
    const { app } = this.#options;
    const { vault, fileManager } = app;
    let finish!: () => void;
    let over!: () => void;
    const undo: Undo = {
      entry,
      bad,
      good,
      moved,
      key,
      abandoned: false,
      tried: false,
      renamed: false,
      done: new Promise((done) => (finish = done)),
      settled: new Promise((done) => (over = done)),
      inside: [],
      after: after?.done,
    };
    this.#pending.push(undo);
    // Its failure is the undo's alone, read from where the file ends up
    const putBack = (rename: () => Promise<unknown>) => async () => {
      try {
        // Renamed again, it stays; gone, what is at its path now is not
        // the guard's to move; taken over by a folder's undo, it is that
        // one's to put back
        if (
          !undo.abandoned &&
          vault.getAbstractFileByPath(undo.bad) === entry
        ) {
          await rename();
          undo.renamed = true;
          // Undone once: should it come back, even before this settles, it
          // stays
          this.#undone.add(undo.key);
        }
      } catch {
        // See `#settle`
      } finally {
        undo.tried = true;
        finish();
      }
    };
    const linkUpdater = fileManager as LinkUpdater;
    // Should Obsidian lose it, the public rename, once every job queued so far
    // is done: links still update, and a failure fails only its own job
    const run = () =>
      typeof linkUpdater.runAsyncLinkUpdate === 'function'
        ? linkUpdater.runAsyncLinkUpdate(
            putBack(() => vault.rename(entry, undo.good))
          )
        : afterLinkUpdates(app).then(
            putBack(() => fileManager.renameFile(entry, undo.good))
          );
    const started = undo.after ? undo.after.then(run) : run();
    // Once the job it ran in, or joined, is done
    void Promise.resolve(started)
      // A job that fails before its op runs tries nothing: what waits on it
      // goes on
      .catch(finish)
      .then(() => afterLinkUpdates(app))
      .then(() => {
        // Over by now: an op Obsidian dropped with a failed job never runs
        finish();
        return this.#settle(undo);
      })
      .finally(over);
    return undo;
  }

  /** Once the undo is over: say what happened, and follow what it left. */
  async #settle(undo: Undo) {
    this.#pending.splice(this.#pending.indexOf(undo), 1);
    const { entry, good, bad } = undo;
    const { vault } = this.#options.app;
    const live = (file: TAbstractFile) =>
      vault.getAbstractFileByPath(file.path) === file;
    // What it still holds that isn't where the database has it: the undo
    // failed. Followed from there, as the rename handler would have, unless
    // another undo, of its own name, has it yet
    for (const [moved, { before }] of undo.moved) {
      if (
        moved instanceof TFile &&
        moved.path !== before &&
        live(moved) &&
        this.#heldBefore(moved) === null
      ) {
        this.#options.follow(moved, before);
      }
    }
    // What was put back inside it is told of with it
    await Promise.all(undo.inside.map((inner) => inner.settled));
    if (undo.abandoned || !live(entry)) return;
    // Told of with the folder it is in, if that is
    const told = undo.folder?.renamed === true && !undo.folder.abandoned;
    if (!undo.renamed) {
      // Moved by someone else's hand, back or on, there is nothing to tell
      // of it, and what was put back inside it tells of itself. Left in a
      // folder that couldn't be put back, it isn't where it would have
      // been put back from either: the folder's notice names what it holds
      if (entry.path !== bad) return;
      const chars = listChars([
        ...new Set(
          [undo, ...undo.inside].flatMap((one) =>
            addedRefusedChars(one.good, one.bad)
          )
        ),
      ]);
      this.#options.notify(
        `Incremental reading: couldn't move "${entry.path}" back. Rename it ` +
          `without ${chars}`
      );
      return;
    }
    if (told) return;
    const inside = undo.inside.filter((one) => one.renamed);
    const chars = listChars([
      ...new Set(
        [undo, ...inside].flatMap((one) => addedRefusedChars(one.good, one.bad))
      ),
    ]);
    // Files put back with it make it about files too
    this.#options.notify(
      entry instanceof TFolder && inside.length === 0
        ? `Incremental reading: folders with items cannot contain ${chars}`
        : `Incremental reading: IR files and their folders cannot contain ${chars}`
    );
  }
}
