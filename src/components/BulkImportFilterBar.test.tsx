// @vitest-environment jsdom
import type { CandidateSource, ScanEvent } from '#/lib/bulk-import/types';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import fc from 'fast-check';
import { TFile, TFolder, type App } from 'obsidian';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BulkImportFilterBar,
  FilteredBulkImport,
  folderFilter,
  type FilterRowProps,
  type FilterSegment,
} from './BulkImportFilterBar';

// #region HELPERS
function makeFolder(path: string): TFolder {
  return Object.assign(new TFolder(), {
    path,
    name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1),
  });
}

function makeFile(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign(new TFile(), {
    path,
    name,
    basename: name.replace(/\.[^.]*$/, ''),
    extension: name.slice(name.lastIndexOf('.') + 1),
  });
}

/** Let scans and the renders they cause run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * A source titled `title` whose every run yields `files` as top-level rows
 * and ends, unless `hold` keeps it open; each run is recorded.
 */
function makeSource(
  title: string,
  files: readonly TFile[] = [],
  { hold = false } = {}
) {
  const runs: { signal: AbortSignal; subfolders: boolean | undefined }[] = [];
  const source: CandidateSource = {
    title,
    canIncludeSubfolders: true,
    async *scan(signal, options) {
      runs.push({ signal, subfolders: options?.subfolders });
      for (const file of files) {
        yield {
          type: 'file',
          file,
          parent: title,
          relativePath: file.name,
        } satisfies ScanEvent;
      }
      if (hold) await new Promise(() => {});
      yield { type: 'folder-done', path: title } satisfies ScanEvent;
    },
  };
  return { source, runs };
}

/** A vault of `paths`, as the folder filter's suggestions read it. */
function makeApp(paths: readonly string[]) {
  const folders = paths.map(makeFolder);
  return {
    app: {
      vault: { getAllFolders: (root?: boolean) => (root ? folders : []) },
    } as unknown as App,
    folders,
  };
}

/** Mount the dialog's content with `segments`; what it was handed is spied. */
function mount(
  segments: readonly FilterSegment[],
  { includeSubfolders = false } = {}
) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onIncludeSubfoldersChange = vi.fn((_on: boolean) => {});
  const container = document.createElement('div');
  document.body.appendChild(container);
  void act(() => {
    render(
      <FilteredBulkImport
        segments={segments}
        defaults={{
          priority: DEFAULT_SETTINGS.defaultPriority,
          makeCopy: false,
          includeSubfolders,
        }}
        onIncludeSubfoldersChange={onIncludeSubfoldersChange}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
      container
    );
  });
  return { container, onConfirm, onCancel, onIncludeSubfoldersChange };
}

/**
 * The folder filter over a vault of `paths`, each folder's source from
 * `sourceFor`, kept in `made` as made.
 */
function folderSegment(
  paths: readonly string[],
  sourceFor: (folder: TFolder) => CandidateSource = (folder) =>
    makeSource(folder.path).source
) {
  const { app, folders } = makeApp(paths);
  const made = vi.fn(sourceFor);
  return { segment: folderFilter(app, made), made, folders };
}

function folderInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    '.ir-bulk-import-filter-row input[type="text"]'
  )!;
}

function suggestions() {
  return [...document.querySelectorAll<HTMLElement>('.suggestion-item')];
}

/** Type `text` into the folder field and pick the suggestion for `path`. */
async function chooseFolder(container: HTMLElement, path: string, text = path) {
  const input = folderInput(container);
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event('input'));
  await settle();
  const item = suggestions().find((el) => el.textContent === path);
  if (!item) throw new Error(`no suggestion for ${path}`);
  await act(() => item.click());
  await settle();
}

function rows(container: HTMLElement) {
  return [...container.querySelectorAll('.ir-bulk-import-row')];
}

function rowNames(container: HTMLElement) {
  return rows(container).map(
    (row) => row.querySelector('.ir-bulk-import-name')?.textContent
  );
}

function rowBox(container: HTMLElement, index: number) {
  return rows(container)[index].querySelector('input')!;
}

function selectedCount(container: HTMLElement) {
  const text = container.querySelector('.ir-bulk-import-count')?.textContent;
  return Number(/\d+/.exec(text ?? '')?.[0]);
}

function confirmButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button.mod-cta')!;
}

/** Every "Include subfolders" checkbox in the content. */
function subfolderToggles(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLInputElement>(
      '.ir-bulk-import-subfolders input'
    ),
  ];
}

function segmentButtons(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      '.ir-bulk-import-filter-segment'
    ),
  ];
}

/**
 * A second filter for the bar: a row with a button that reports `source`,
 * and no "Include subfolders" toggle.
 */
function otherSegment(source: CandidateSource): FilterSegment {
  return {
    id: 'other',
    label: 'Other',
    row: ({ onSource }: FilterRowProps) => (
      <div className="other-row">
        <button className="other-choose" onClick={() => onSource(source)} />
        <button className="other-clear" onClick={() => onSource(null)} />
      </div>
    ),
  };
}
// #endregion

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('FilteredBulkImport', () => {
  it('lists nothing until a folder is chosen, saying so, with nothing to confirm', async () => {
    const { segment, made } = folderSegment(['notes']);
    const { container } = mount([segment]);
    await settle();

    expect(container.querySelector('.ir-bulk-import-prompt')).not.toBeNull();
    expect(rows(container)).toEqual([]);
    // Neither scanning nor done finding nothing
    expect(container.querySelector('.ir-loading')).toBeNull();
    expect(container.querySelector('.ir-bulk-import-empty')).toBeNull();
    expect(selectedCount(container)).toBe(0);
    expect(confirmButton(container).disabled).toBe(true);
    expect(made).not.toHaveBeenCalled();
  });

  it("suggests the vault's folders, and lists the one picked once it is picked", async () => {
    const files = [makeFile('notes/a.md'), makeFile('notes/b.md')];
    const { segment, made, folders } = folderSegment(
      ['/', 'notes', 'other'],
      () => makeSource('notes', files).source
    );
    const { container } = mount([segment]);

    await chooseFolder(container, 'notes', 'NOT');

    expect(made).toHaveBeenCalledExactlyOnceWith(folders[1]);
    expect(folderInput(container).value).toBe('notes');
    // The popup closes on the pick
    expect(suggestions()).toEqual([]);
    expect(container.querySelector('.ir-bulk-import-prompt')).toBeNull();
    expect(rowNames(container)).toEqual(['a', 'b']);
    expect(selectedCount(container)).toBe(2);
  });

  it('takes `/` for the vault root', async () => {
    const { segment, made, folders } = folderSegment(['/', 'notes']);
    const { container } = mount([segment]);

    await chooseFolder(container, '/');

    expect(made).toHaveBeenCalledExactlyOnceWith(folders[0]);
  });

  it('stops the last scan on another folder, listing the new one with every row ticked again', async () => {
    const shared = makeFile('notes/shared.md');
    const first = makeSource('notes', [shared, makeFile('notes/a.md')], {
      hold: true,
    });
    const second = makeSource('other', [shared, makeFile('other/b.md')]);
    const { segment } = folderSegment(['notes', 'other'], (folder) =>
      folder.path === 'notes' ? first.source : second.source
    );
    const { container } = mount([segment]);
    await chooseFolder(container, 'notes');
    await act(() => rowBox(container, 0).click());
    expect(selectedCount(container)).toBe(1);

    await chooseFolder(container, 'other');

    expect(first.runs).toHaveLength(1);
    expect(first.runs[0].signal.aborted).toBe(true);
    expect(second.runs).toHaveLength(1);
    expect(rowNames(container)).toEqual(['shared', 'b']);
    expect(rowBox(container, 0).checked).toBe(true);
    expect(selectedCount(container)).toBe(2);

    // Unticking there starts from every row ticked, not the last folder's
    await act(() => rowBox(container, 1).click());
    expect(rowBox(container, 0).checked).toBe(true);
    expect(rowBox(container, 1).checked).toBe(false);
    expect(selectedCount(container)).toBe(1);
  });

  it('keeps the list, unticked rows and all, when the same folder is picked again', async () => {
    const { segment, made } = folderSegment(
      ['notes'],
      () => makeSource('notes', [makeFile('notes/a.md')]).source
    );
    const { container } = mount([segment]);
    await chooseFolder(container, 'notes');
    await act(() => rowBox(container, 0).click());

    await chooseFolder(container, 'notes');

    expect(made).toHaveBeenCalledOnce();
    expect(rowBox(container, 0).checked).toBe(false);
    expect(selectedCount(container)).toBe(0);
  });

  it('ticks every folder again on a new source, though its folders have the same paths', async () => {
    /** A fresh source on each pick, listing `Sub` and a file in it. */
    const sourceFor = (folder: TFolder): CandidateSource => ({
      title: folder.path,
      canIncludeSubfolders: true,
      async *scan() {
        const sub = `${folder.path}/Sub`;
        const file = makeFile(`${sub}/a.md`);
        yield { type: 'folder', path: sub, parent: folder.path };
        yield { type: 'folder-done', path: folder.path };
        yield { type: 'file', file, parent: sub, relativePath: 'Sub/a.md' };
        yield { type: 'folder-done', path: sub };
      },
    });
    const { segment, made } = folderSegment(['notes', 'other'], sourceFor);
    const { container } = mount([segment]);
    const folderBox = () =>
      container.querySelector<HTMLInputElement>(
        '.ir-bulk-import-folder-title input[type="checkbox"]'
      )!;
    await chooseFolder(container, 'notes');
    await act(() => folderBox().click());
    expect(selectedCount(container)).toBe(0);

    await chooseFolder(container, 'other');
    await chooseFolder(container, 'notes');

    expect(made).toHaveBeenCalledTimes(3);
    expect(folderBox().checked).toBe(true);
    expect(rowBox(container, 0).checked).toBe(true);
    expect(selectedCount(container)).toBe(1);
  });

  it('confirms the ticked rows with the source they came from', async () => {
    const files = [makeFile('notes/a.md'), makeFile('notes/b.md')];
    const chosen = makeSource('notes', files);
    const { segment } = folderSegment(['notes'], () => chosen.source);
    const { container, onConfirm } = mount([segment]);
    await chooseFolder(container, 'notes');
    await act(() => rowBox(container, 0).click());

    await act(() => confirmButton(container).click());

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
      [files[1]],
      expect.objectContaining({ makeCopy: false }),
      chosen.source
    );
  });

  it('puts Include subfolders in the folder row alone, as it was last left', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (includeSubfolders) => {
        const { segment } = folderSegment(['notes']);
        const { container } = mount([segment], { includeSubfolders });

        const toggles = subfolderToggles(container);
        expect(toggles).toHaveLength(1);
        expect(toggles[0].closest('.ir-bulk-import-filter-row')).not.toBeNull();
        expect(toggles[0].checked).toBe(includeSubfolders);
        render(null, container);
      }),
      { numRuns: 4 }
    );
  });

  it('scans the folder chosen as deep as Include subfolders says, over again on each switch, reporting each', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(fc.boolean(), { maxLength: 3 }),
        fc.integer({ min: 0, max: 2 }),
        async (startOn, beforeFolder, after) => {
          const chosen = makeSource('notes');
          const { segment } = folderSegment(['notes'], () => chosen.source);
          const { container, onIncludeSubfoldersChange } = mount([segment], {
            includeSubfolders: startOn,
          });
          let on = startOn;
          const reported: boolean[] = [];
          const flip = async () => {
            await act(() => subfolderToggles(container)[0].click());
            on = !on;
            reported.push(on);
          };
          // Switches with no folder chosen scan nothing
          for (const _ of beforeFolder) await flip();
          expect(chosen.runs).toEqual([]);

          await chooseFolder(container, 'notes');
          const expected = [on];
          for (let i = 0; i < after; i++) {
            await flip();
            expected.push(on);
          }
          await settle();

          expect(chosen.runs.map((run) => run.subfolders)).toEqual(expected);
          expect(
            onIncludeSubfoldersChange.mock.calls.map(([value]) => value)
          ).toEqual(reported);
          render(null, container);
          document.body.replaceChildren();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('puts the folder listed back in the field on leaving it after typing another', async () => {
    const { segment, made } = folderSegment(['notes', 'other']);
    const { container } = mount([segment]);
    const input = folderInput(container);
    // Nothing chosen yet: what was typed stays
    input.focus();
    input.value = 'oth';
    input.blur();
    expect(input.value).toBe('oth');
    await chooseFolder(container, 'notes');

    input.focus();
    input.value = 'oth';
    input.dispatchEvent(new Event('input'));
    await settle();
    input.blur();

    expect(input.value).toBe('notes');
    expect(made).toHaveBeenCalledOnce();
    expect(rowNames(container)).toEqual([]);
    expect(container.querySelector('.ir-bulk-import-prompt')).toBeNull();
  });

  it('closes the suggestions once the dialog goes', async () => {
    const { segment } = folderSegment(['notes']);
    const { container } = mount([segment]);
    const input = folderInput(container);
    input.focus();
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(suggestions()).toHaveLength(1);

    void act(() => render(null, container));

    expect(suggestions()).toEqual([]);
  });
});

describe('BulkImportFilterBar', () => {
  it('presses the first segment to start with, showing its row alone', () => {
    const { segment } = folderSegment(['notes']);
    const { container } = mount([
      segment,
      otherSegment(makeSource('x').source),
    ]);

    expect(segmentButtons(container).map((b) => b.ariaPressed)).toEqual([
      'true',
      'false',
    ]);
    expect(
      segmentButtons(container).map((b) => b.classList.contains('is-active'))
    ).toEqual([true, false]);
    expect(segmentButtons(container)[0].closest('[role="group"]')).not.toBe(
      null
    );
    expect(folderInput(container)).not.toBeNull();
    expect(container.querySelector('.other-row')).toBeNull();
  });

  it('on another segment, drops the source the last one made and shows the new row, fresh each time', async () => {
    const file = makeFile('notes/a.md');
    const folderScan = makeSource('notes', [file], { hold: true });
    const other = makeSource('other', [makeFile('other/b.md')]);
    const { segment } = folderSegment(['notes'], () => folderScan.source);
    const { container } = mount([segment, otherSegment(other.source)]);
    await chooseFolder(container, 'notes');

    await act(() => segmentButtons(container)[1].click());
    await settle();

    expect(folderScan.runs[0].signal.aborted).toBe(true);
    expect(rows(container)).toEqual([]);
    expect(container.querySelector('.ir-bulk-import-prompt')).not.toBeNull();
    expect(segmentButtons(container).map((b) => b.ariaPressed)).toEqual([
      'false',
      'true',
    ]);
    expect(container.querySelector('.ir-bulk-import-filter-row')).toBeNull();
    // A filter that places no toggle leaves the dialog without one
    expect(subfolderToggles(container)).toEqual([]);

    await act(() =>
      container.querySelector<HTMLButtonElement>('.other-choose')!.click()
    );
    await settle();
    expect(rowNames(container)).toEqual(['b']);

    // Back on the folder filter: its field starts empty again
    await act(() => segmentButtons(container)[0].click());
    await settle();
    expect(folderInput(container).value).toBe('');
    expect(rows(container)).toEqual([]);
  });

  it('lists nothing again when the row reports no source', async () => {
    const other = makeSource('other', [makeFile('other/b.md')]);
    const { container } = mount([otherSegment(other.source)]);
    await act(() =>
      container.querySelector<HTMLButtonElement>('.other-choose')!.click()
    );
    await settle();
    expect(rowNames(container)).toEqual(['b']);

    await act(() =>
      container.querySelector<HTMLButtonElement>('.other-clear')!.click()
    );
    await settle();

    expect(rows(container)).toEqual([]);
    expect(container.querySelector('.ir-bulk-import-prompt')).not.toBeNull();
  });

  it('keeps the pressed segment and its row when the segments are made afresh with the same ids', async () => {
    const onSource = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const draw = () =>
      render(
        <BulkImportFilterBar
          segments={[
            folderSegment(['notes']).segment,
            otherSegment(makeSource('x').source),
          ]}
          onSource={onSource}
          subfoldersToggle={null}
        />,
        container
      );
    void act(draw);
    await act(() => segmentButtons(container)[1].click());
    onSource.mockClear();

    void act(draw);
    await act(() => segmentButtons(container)[1].click());

    expect(segmentButtons(container).map((b) => b.ariaPressed)).toEqual([
      'false',
      'true',
    ]);
    expect(container.querySelector('.other-row')).not.toBeNull();
    expect(onSource).not.toHaveBeenCalled();
  });

  it('keeps the source on pressing the segment already pressed', async () => {
    const onSource = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const other = otherSegment(makeSource('x').source);
    void act(() => {
      render(
        <BulkImportFilterBar
          segments={[other]}
          onSource={onSource}
          subfoldersToggle={null}
        />,
        container
      );
    });

    await act(() => segmentButtons(container)[0].click());

    expect(onSource).not.toHaveBeenCalled();
    expect(segmentButtons(container)[0].ariaPressed).toBe('true');
  });
});
