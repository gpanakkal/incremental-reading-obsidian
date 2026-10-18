import type { TFile } from 'obsidian';
import type { TreeEntry, TreeFolder } from './tree';

/**
 * Which rows of a bulk import tree are ticked: each file seen so far, and,
 * by path, whether a folder was last left on (ticked or partly ticked). A
 * folder's own tick only counts while it holds no file, as it does when it
 * has only just been found or a rescan has yet to bring its files back.
 *
 * Both outlive the tree they were set on, so a rescan leaves every row as
 * it was.
 */
export interface Ticks {
  readonly files: ReadonlyMap<TFile, boolean>;
  readonly folders: ReadonlyMap<string, boolean>;
}

/** What a folder's checkbox shows. */
export type CheckState = 'checked' | 'partial' | 'unchecked';

/**
 * - `found`: the tree now shows `tree`; each file in it not seen before is
 *   ticked as its folder was before it came, top-level files always;
 * - `toggle-file`: `file` was clicked;
 * - `toggle-folder`: `folder` was clicked, ticking everything under it
 *   unless it was fully ticked, and unticking it all if it was.
 *
 * Each says what the tree shows, which a click is judged by, and is
 * `found` first.
 */
export type TicksAction =
  | { type: 'found'; tree: readonly TreeEntry[] }
  | { type: 'toggle-file'; tree: readonly TreeEntry[]; file: TFile }
  | { type: 'toggle-folder'; tree: readonly TreeEntry[]; folder: TreeFolder };

export const NO_TICKS: Ticks = { files: new Map(), folders: new Map() };

/** A folder's state, and how many of the files under it have been seen. */
interface Judgement {
  state: CheckState;
  seen: number;
}

/**
 * Each folder of `tree` judged by the files under it that `ticks` has
 * seen: checked if all are ticked, unchecked if none are, partial otherwise;
 * holding none, as it was last left, or else as its folder is (on, unless
 * unchecked), a top-level one on.
 */
function judge(
  ticks: Ticks,
  tree: readonly TreeEntry[]
): Map<string, Judgement> {
  const tallies = new Map<TreeFolder, { ticked: number; seen: number }>();
  const tally = (entries: readonly TreeEntry[]) => {
    let ticked = 0;
    let seen = 0;
    for (const entry of entries) {
      if (entry.kind === 'folder') {
        const inner = tally(entry.entries);
        tallies.set(entry, inner);
        ticked += inner.ticked;
        seen += inner.seen;
      } else {
        const tick = ticks.files.get(entry.file);
        if (tick === undefined) continue;
        seen++;
        if (tick) ticked++;
      }
    }
    return { ticked, seen };
  };
  tally(tree);

  const judged = new Map<string, Judgement>();
  const visit = (entries: readonly TreeEntry[], parentOn: boolean) => {
    for (const entry of entries) {
      if (entry.kind === 'file') continue;
      const { ticked, seen } = tallies.get(entry)!;
      let state: CheckState;
      if (seen === 0) {
        state =
          (ticks.folders.get(entry.path) ?? parentOn) ? 'checked' : 'unchecked';
      } else if (ticked === seen) state = 'checked';
      else state = ticked === 0 ? 'unchecked' : 'partial';
      judged.set(entry.path, { state, seen });
      visit(entry.entries, state !== 'unchecked');
    }
  };
  visit(tree, true);
  return judged;
}

/** What each folder of `tree` shows, by path. */
export function folderStates(
  ticks: Ticks,
  tree: readonly TreeEntry[]
): ReadonlyMap<string, CheckState> {
  return new Map(
    [...judge(ticks, tree)].map(([path, { state }]) => [path, state])
  );
}

/** The files `ticks` has seen and left unticked. */
export function untickedFiles(ticks: Ticks): ReadonlySet<TFile> {
  return new Set(
    [...ticks.files].filter(([, tick]) => !tick).map(([file]) => file)
  );
}

/** `ticks`, each file of `tree` it has not seen ticked as its folder was. */
function adopt(ticks: Ticks, tree: readonly TreeEntry[]): Ticks {
  const judged = judge(ticks, tree);
  let files: Map<TFile, boolean> | undefined;
  const visit = (entries: readonly TreeEntry[], on: boolean) => {
    for (const entry of entries) {
      if (entry.kind === 'folder') {
        visit(entry.entries, judged.get(entry.path)!.state !== 'unchecked');
      } else if (!ticks.files.has(entry.file)) {
        files ??= new Map(ticks.files);
        files.set(entry.file, on);
      }
    }
  };
  visit(tree, true);
  return files ? { files, folders: ticks.folders } : ticks;
}

/**
 * `ticks`, each folder of `tree` holding a file remembered as on or off,
 * so that it shows the same while a rescan has yet to bring its files back.
 */
function remember(ticks: Ticks, tree: readonly TreeEntry[]): Ticks {
  let folders: Map<string, boolean> | undefined;
  for (const [path, { state, seen }] of judge(ticks, tree)) {
    if (seen === 0) continue;
    const on = state !== 'unchecked';
    if (ticks.folders.get(path) === on) continue;
    folders ??= new Map(ticks.folders);
    folders.set(path, on);
  }
  return folders ? { files: ticks.files, folders } : ticks;
}

/** `ticks` with everything under `folder`, and it, ticked as `on`. */
function setAll(ticks: Ticks, folder: TreeFolder, on: boolean): Ticks {
  const files = new Map(ticks.files);
  const folders = new Map(ticks.folders);
  const visit = (current: TreeFolder) => {
    folders.set(current.path, on);
    for (const entry of current.entries) {
      if (entry.kind === 'folder') visit(entry);
      else files.set(entry.file, on);
    }
  };
  visit(folder);
  return { files, folders };
}

/**
 * The ticks after `action`. It is `ticks` itself when nothing
 * changed, so a component holding it renders no more.
 */
export function ticksReducer(ticks: Ticks, action: TicksAction): Ticks {
  const { tree } = action;
  let next = adopt(ticks, tree);
  if (action.type === 'toggle-file') {
    const files = new Map(next.files);
    files.set(action.file, !files.get(action.file));
    next = { files, folders: next.folders };
  } else if (action.type === 'toggle-folder') {
    const was = judge(next, tree).get(action.folder.path)!.state;
    next = setAll(next, action.folder, was !== 'checked');
  }
  return remember(next, tree);
}
