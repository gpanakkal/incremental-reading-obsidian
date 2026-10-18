import fc from 'fast-check';
import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
  folderStates,
  NO_TICKS,
  ticksReducer,
  untickedFiles,
  type CheckState,
  type Ticks,
  type TicksAction,
} from './ticks';
import { treeFiles, type TreeEntry, type TreeFolder } from './tree';

// #region HELPERS
function makeFile(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign(new TFile(), { path, name, basename: name });
}

function file(path: string): TreeEntry {
  return { kind: 'file', file: makeFile(path), relativePath: path };
}

function folder(path: string, entries: TreeEntry[] = []): TreeFolder {
  return {
    kind: 'folder',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    scanning: false,
    entries,
  };
}

/** Every folder of `entries`, top to bottom. */
function foldersOf(entries: readonly TreeEntry[]): TreeFolder[] {
  return entries.flatMap((entry) =>
    entry.kind === 'file' ? [] : [entry, ...foldersOf(entry.entries)]
  );
}

/** The folder at `path` in `entries`. */
function folderAt(entries: readonly TreeEntry[], path: string): TreeFolder {
  const found = foldersOf(entries).find((entry) => entry.path === path);
  if (!found) throw new Error(`no folder ${path}`);
  return found;
}

/** The file at `path` in `entries`. */
function fileAt(entries: readonly TreeEntry[], path: string): TFile {
  const found = treeFiles(entries).find((entry) => entry.path === path);
  if (!found) throw new Error(`no file ${path}`);
  return found;
}

/** `selection` after each of `actions`, from none. */
function run(actions: TicksAction[], selection = NO_TICKS) {
  return actions.reduce(ticksReducer, selection);
}

/** Whether each file of `tree` is ticked, by path. */
function ticks(selection: Ticks, tree: readonly TreeEntry[]) {
  const unticked = untickedFiles(selection);
  return Object.fromEntries(
    treeFiles(tree).map((entry) => [entry.path, !unticked.has(entry)])
  );
}

/** A generated folder: when each row shows up, and what it holds. */
interface NodeSpec {
  /** The step a row shows from, never before its folder's. */
  at: number;
  files: { at: number; file: TFile }[];
  folders: NodeSpec[];
  path: string;
}

const STEPS = 8;

/** The contents of a folder at `path`, at most `depth` levels deep. */
function nodeArb(path: string, depth: number): fc.Arbitrary<NodeSpec> {
  const prefix = path === '' ? '' : `${path}/`;
  return fc
    .record({
      at: fc.nat({ max: STEPS }),
      fileSteps: fc.array(fc.nat({ max: STEPS }), { maxLength: 3 }),
      folderCount: depth > 0 ? fc.nat({ max: 2 }) : fc.constant(0),
    })
    .chain(({ at, fileSteps, folderCount }) =>
      fc
        .tuple<
          NodeSpec[]
        >(...Array.from({ length: folderCount }, (_, i) => nodeArb(`${prefix}d${i}`, depth - 1)))
        .map((folders) => ({
          at,
          path,
          folders,
          // Fresh files for each value, so no two trees share one
          files: fileSteps.map((step, i) => ({
            at: step,
            file: makeFile(`${prefix}n${i}.md`),
          })),
        }))
    );
}

/** A vault folder's tree, its top level's own rows there from the start. */
const specArb = nodeArb('', 3).map((root) => ({ ...root, at: 0 }));

/**
 * The tree `spec` shows at `step`: the rows that have shown up by then,
 * a folder's subfolders above its files, as `buildTree` lists them.
 */
function treeAt(spec: NodeSpec, step: number): TreeEntry[] {
  const shown = (at: number) => at <= step;
  return [
    ...spec.folders
      .filter((sub) => shown(sub.at))
      .map((sub) => folder(sub.path, treeAt(sub, step))),
    ...spec.files
      .filter((entry) => shown(entry.at))
      .map(
        ({ file: found }): TreeEntry => ({
          kind: 'file',
          file: found,
          relativePath: found.path,
        })
      ),
  ];
}

type Step =
  | { kind: 'grow' }
  | { kind: 'file'; pick: number }
  | { kind: 'folder'; pick: number };

const stepsArb = fc.array(
  fc.oneof(
    fc.constant<Step>({ kind: 'grow' }),
    fc.record({ kind: fc.constant('file' as const), pick: fc.nat() }),
    fc.record({ kind: fc.constant('folder' as const), pick: fc.nat() })
  ),
  { maxLength: 14 }
);

/**
 * The selection as the task states it, worked out the slow way: each file's
 * tick, and the tick a folder was last given by a click on it or on a folder
 * above it.
 */
interface Model {
  ticks: Map<TFile, boolean>;
  set: Map<string, boolean>;
}

/**
 * A folder of `tree` by what it holds that `model` knows: all ticked,
 * none, or some; holding none, as last set, or else as its folder is.
 */
function modelState(
  model: Model,
  tree: readonly TreeEntry[],
  path: string
): CheckState {
  const known = treeFiles(folderAt(tree, path).entries).filter((entry) =>
    model.ticks.has(entry)
  );
  if (known.length === 0) {
    const parent = path.includes('/')
      ? modelState(model, tree, path.slice(0, path.lastIndexOf('/')))
      : 'checked';
    return (model.set.get(path) ?? parent !== 'unchecked')
      ? 'checked'
      : 'unchecked';
  }
  const ticked = known.filter((entry) => model.ticks.get(entry)).length;
  if (ticked === known.length) return 'checked';
  return ticked === 0 ? 'unchecked' : 'partial';
}

/** `model` once it has seen `tree`: each new file ticked as its folder was. */
function modelFound(model: Model, tree: readonly TreeEntry[]): Model {
  const ticks = new Map(model.ticks);
  const visit = (entries: readonly TreeEntry[], parent: string | null) => {
    for (const entry of entries) {
      if (entry.kind === 'folder') visit(entry.entries, entry.path);
      else if (!model.ticks.has(entry.file)) {
        ticks.set(
          entry.file,
          parent === null || modelState(model, tree, parent) !== 'unchecked'
        );
      }
    }
  };
  visit(tree, null);
  return { ticks, set: model.set };
}
// #endregion

describe('ticksReducer', () => {
  it('derives each folder from its files, sets everything under a clicked folder, and ticks a late file as its folder was', () => {
    fc.assert(
      fc.property(specArb, stepsArb, (spec, steps) => {
        let selection = NO_TICKS;
        let model: Model = { ticks: new Map(), set: new Map() };
        let step = 0;
        let tree = treeAt(spec, step);
        for (const next of [{ kind: 'grow' } as const, ...steps]) {
          if (next.kind === 'grow') tree = treeAt(spec, ++step);
          model = modelFound(model, tree);
          if (next.kind === 'grow') {
            selection = ticksReducer(selection, { type: 'found', tree });
          } else if (next.kind === 'file') {
            const files = treeFiles(tree);
            if (files.length === 0) continue;
            const picked = files[next.pick % files.length];
            const before = ticks(
              ticksReducer(selection, { type: 'found', tree }),
              tree
            );
            selection = ticksReducer(selection, {
              type: 'toggle-file',
              tree,
              file: picked,
            });
            model.ticks.set(picked, !model.ticks.get(picked));
            // That file alone changes
            expect(ticks(selection, tree)).toEqual({
              ...before,
              [picked.path]: !before[picked.path],
            });
          } else {
            const folders = foldersOf(tree);
            if (folders.length === 0) continue;
            const picked = folders[next.pick % folders.length];
            const was = modelState(model, tree, picked.path);
            selection = ticksReducer(selection, {
              type: 'toggle-folder',
              tree,
              folder: picked,
            });
            const on = was !== 'checked';
            for (const entry of treeFiles(picked.entries)) {
              model.ticks.set(entry, on);
            }
            for (const sub of [picked, ...foldersOf(picked.entries)]) {
              model.set.set(sub.path, on);
            }
            // Everything under it as it now is
            const states = folderStates(selection, tree);
            for (const sub of [picked, ...foldersOf(picked.entries)]) {
              expect(states.get(sub.path)).toBe(on ? 'checked' : 'unchecked');
            }
          }
          const unticked = untickedFiles(selection);
          for (const entry of treeFiles(tree)) {
            expect(unticked.has(entry)).toBe(!model.ticks.get(entry));
          }
          const states = folderStates(selection, tree);
          for (const sub of foldersOf(tree)) {
            expect(states.get(sub.path)).toBe(
              modelState(model, tree, sub.path)
            );
          }
          expect(states.size).toBe(foldersOf(tree).length);
          // The count is of the ticked files
          expect(treeFiles(tree).filter((f) => !unticked.has(f)).length).toBe(
            [...model.ticks.values()].filter(Boolean).length
          );
        }
      }),
      { numRuns: 300 }
    );
  });

  it('judges a folder by its files: checked when all are ticked, unchecked when none are, partial otherwise', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 3 }),
        (wanted, depth) => {
          // The files sit `depth` folders under the one judged
          const base = Array.from({ length: depth }, (_, i) => `s${i}`).reduce(
            (path, name) => `${path}/${name}`,
            'top'
          );
          const files = wanted.map((_, i) => file(`${base}/f${i}.md`));
          let inner: TreeEntry[] = files;
          for (let path = base; path !== 'top'; ) {
            inner = [folder(path, inner)];
            path = path.slice(0, path.lastIndexOf('/'));
          }
          const tree = [folder('top', inner)];
          let selection = run([{ type: 'found', tree }]);
          for (const [i, on] of wanted.entries()) {
            if (on) continue;
            selection = ticksReducer(selection, {
              type: 'toggle-file',
              tree,
              file: fileAt(tree, `${base}/f${i}.md`),
            });
          }

          const expected = wanted.every(Boolean)
            ? 'checked'
            : wanted.some(Boolean)
              ? 'partial'
              : 'unchecked';
          const states = folderStates(selection, tree);
          expect(states.get('top')).toBe(expected);
          for (const sub of foldersOf(tree)) {
            expect(states.get(sub.path)).toBe(expected);
          }
        }
      )
    );
  });

  it('ticks everything under a partly ticked folder when it is clicked, and unticks everything under a ticked one', () => {
    const tree = [
      folder('top', [
        folder('top/sub', [file('top/sub/a.md'), file('top/sub/b.md')]),
        file('top/c.md'),
      ]),
      file('d.md'),
    ];
    const top = folderAt(tree, 'top');
    const partly = run([
      { type: 'found', tree },
      { type: 'toggle-file', tree, file: fileAt(tree, 'top/sub/a.md') },
    ]);
    expect(folderStates(partly, tree).get('top')).toBe('partial');
    expect(folderStates(partly, tree).get('top/sub')).toBe('partial');

    const all = ticksReducer(partly, {
      type: 'toggle-folder',
      tree,
      folder: top,
    });
    expect(ticks(all, tree)).toEqual({
      'top/sub/a.md': true,
      'top/sub/b.md': true,
      'top/c.md': true,
      'd.md': true,
    });

    const none = ticksReducer(all, {
      type: 'toggle-folder',
      tree,
      folder: top,
    });
    expect(ticks(none, tree)).toEqual({
      'top/sub/a.md': false,
      'top/sub/b.md': false,
      'top/c.md': false,
      'd.md': true,
    });
    expect(folderStates(none, tree).get('top/sub')).toBe('unchecked');
  });

  it('ticks a file found later as its folder is: unticked under an unticked folder, ticked under a ticked or partly ticked one', () => {
    const before = [
      folder('off', [file('off/a.md')]),
      folder('part', [file('part/a.md'), file('part/b.md')]),
      folder('on', [file('on/a.md')]),
    ];
    const selection = run([
      { type: 'found', tree: before },
      {
        type: 'toggle-folder',
        tree: before,
        folder: folderAt(before, 'off'),
      },
      { type: 'toggle-file', tree: before, file: fileAt(before, 'part/a.md') },
    ]);
    const later = (path: string): TreeEntry => ({
      kind: 'file',
      file: makeFile(path),
      relativePath: path,
    });
    const after: TreeEntry[] = before.map((entry) =>
      entry.kind === 'folder'
        ? { ...entry, entries: [...entry.entries, later(`${entry.path}/z.md`)] }
        : entry
    );
    after.push(later('top.md'));

    const found = ticksReducer(selection, { type: 'found', tree: after });

    expect(ticks(found, after)).toMatchObject({
      'off/z.md': false,
      'part/z.md': true,
      'on/z.md': true,
      'top.md': true,
    });
  });

  it('judges a folder still holding nothing as last clicked, or else as the folder it is in', () => {
    const tree = [
      folder('top', [
        folder('top/empty', [folder('top/empty/deeper')]),
        file('top/a.md'),
      ]),
      folder('bare'),
    ];
    const found = run([{ type: 'found', tree }]);
    expect(Object.fromEntries(folderStates(found, tree))).toEqual({
      top: 'checked',
      'top/empty': 'checked',
      'top/empty/deeper': 'checked',
      bare: 'checked',
    });

    // Unticked through its file, the folder takes the empty ones with it
    const offByFile = ticksReducer(found, {
      type: 'toggle-file',
      tree,
      file: fileAt(tree, 'top/a.md'),
    });
    expect(folderStates(offByFile, tree).get('top/empty/deeper')).toBe(
      'unchecked'
    );

    // Clicked, an empty folder holds its tick whatever the folder above does
    const emptyOn = ticksReducer(offByFile, {
      type: 'toggle-folder',
      tree,
      folder: folderAt(tree, 'top/empty'),
    });
    expect(folderStates(emptyOn, tree).get('top/empty')).toBe('checked');
    expect(folderStates(emptyOn, tree).get('top/empty/deeper')).toBe('checked');
    expect(folderStates(emptyOn, tree).get('top')).toBe('unchecked');

    const bareOff = ticksReducer(emptyOn, {
      type: 'toggle-folder',
      tree,
      folder: folderAt(tree, 'bare'),
    });
    expect(folderStates(bareOff, tree).get('bare')).toBe('unchecked');
    const bareOn = ticksReducer(bareOff, {
      type: 'toggle-folder',
      tree,
      folder: folderAt(tree, 'bare'),
    });
    expect(folderStates(bareOn, tree).get('bare')).toBe('checked');
  });

  it('remembers how a folder was while it held files, once a rescan shows it empty again', () => {
    const full = [
      folder('top', [
        folder('top/sub', [file('top/sub/a.md')]),
        file('top/b.md'),
      ]),
    ];
    const a = fileAt(full, 'top/sub/a.md');
    const b = fileAt(full, 'top/b.md');
    const unticked = run([
      { type: 'found', tree: full },
      { type: 'toggle-file', tree: full, file: a },
    ]);
    // A rescan starts from nothing; the folders show up before their files
    const rescanned = [
      folder('top', [
        folder('top/sub'),
        { kind: 'file', file: b, relativePath: b.path } as TreeEntry,
      ]),
    ];
    const restarted = run(
      [
        { type: 'found', tree: [] },
        { type: 'found', tree: rescanned },
      ],
      unticked
    );
    expect(folderStates(restarted, rescanned).get('top/sub')).toBe('unchecked');
    expect(ticks(restarted, rescanned)).toEqual({ 'top/b.md': true });

    // A file new to it comes in unticked, and the one it had stays so
    const back = [
      folder('top', [
        folder('top/sub', [
          { kind: 'file', file: a, relativePath: a.path },
          file('top/sub/new.md'),
        ]),
        { kind: 'file', file: b, relativePath: b.path },
      ]),
    ] as TreeEntry[];
    const found = ticksReducer(restarted, { type: 'found', tree: back });
    expect(ticks(found, back)).toEqual({
      'top/sub/a.md': false,
      'top/sub/new.md': false,
      'top/b.md': true,
    });
  });

  it('remembers a folder left ticked, once a rescan shows it empty under a folder now unticked', () => {
    const full = [
      folder('top', [
        folder('top/sub', [file('top/sub/a.md')]),
        file('top/b.md'),
      ]),
    ];
    const b = fileAt(full, 'top/b.md');
    const selection = run([
      { type: 'found', tree: full },
      { type: 'toggle-file', tree: full, file: b },
    ]);
    const rescanned: TreeEntry[] = [
      folder('top', [
        folder('top/sub'),
        { kind: 'file', file: b, relativePath: b.path },
      ]),
    ];
    const restarted = run(
      [
        { type: 'found', tree: [] },
        { type: 'found', tree: rescanned },
      ],
      selection
    );
    expect(Object.fromEntries(folderStates(restarted, rescanned))).toEqual({
      top: 'unchecked',
      'top/sub': 'checked',
    });
  });

  it('keeps every file it has seen, ticked as it was, while a rescan has yet to show it', () => {
    const tree = [file('a.md'), file('b.md')];
    const selection = run([
      { type: 'found', tree },
      { type: 'toggle-file', tree, file: fileAt(tree, 'a.md') },
      { type: 'found', tree: [] },
      { type: 'found', tree },
    ]);
    expect(ticks(selection, tree)).toEqual({ 'a.md': false, 'b.md': true });
  });

  it('gives back the selection it was given when the action changes nothing', () => {
    fc.assert(
      fc.property(specArb, fc.nat({ max: STEPS }), (spec, step) => {
        const tree = treeAt(spec, step);
        const found = ticksReducer(NO_TICKS, { type: 'found', tree });
        expect(ticksReducer(found, { type: 'found', tree })).toBe(found);
        // And what it holds stays as it was
        expect(found.files.size).toBe(treeFiles(tree).length);
      })
    );
    expect(ticksReducer(NO_TICKS, { type: 'found', tree: [] })).toBe(NO_TICKS);
  });

  it('starts with nothing seen, and so nothing unticked', () => {
    expect(untickedFiles(NO_TICKS).size).toBe(0);
    expect(folderStates(NO_TICKS, []).size).toBe(0);
  });
});
