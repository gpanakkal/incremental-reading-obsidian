// @vitest-environment jsdom
import type { CandidateSource } from '#/lib/bulk-import/types';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type { VaultSearch } from '#/lib/vault-search';
import fc from 'fast-check';
import { TFile } from 'obsidian';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilteredBulkImport } from './BulkImportFilterBar';
import { SEARCH_DEBOUNCE_MS, searchFilter } from './SearchFilter';

// #region HELPERS
function makeFile(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign(new TFile(), {
    path,
    name,
    basename: name.replace(/\.[^.]*$/, ''),
    extension: name.slice(name.lastIndexOf('.') + 1),
  });
}

/** One search the engine was asked for, which the test settles. */
interface Run {
  query: string;
  signal: AbortSignal;
  progress: (matched: number) => void;
  resolve: (files: TFile[]) => void;
  reject: (error: unknown) => void;
}

/** An engine whose every search waits for the test to settle it. */
function makeSearch() {
  const runs: Run[] = [];
  const search: VaultSearch = {
    run: (query, signal, onProgress) =>
      new Promise((resolve, reject) => {
        runs.push({
          query,
          signal,
          progress: (n) => onProgress?.(n),
          resolve,
          reject,
        });
      }),
  };
  return { search, runs };
}

/** Sources listing the files a search matched as top-level rows. */
function makeSources() {
  const made = vi.fn(
    (files: readonly TFile[]): CandidateSource => ({
      title: 'search',
      async *scan() {
        for (const file of files) {
          yield { type: 'file', file, parent: '/', relativePath: file.path };
        }
        yield { type: 'folder-done', path: '/' };
      },
    })
  );
  return made;
}

/** Let what is due run: timers up to `ms` from now, promises, renders. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Let a settled search's rows show: Preact runs effects on a timer where
 * there is no animation frame, as in jsdom.
 */
const EFFECTS_MS = 100;
async function settle() {
  // The source the search makes, then the effects its rows set off
  for (let step = 0; step < 3; step++) await advance(EFFECTS_MS);
}

function mount(search: VaultSearch, makeSource = makeSources()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  void act(() => {
    render(
      <FilteredBulkImport
        segments={[searchFilter(search, makeSource)]}
        defaults={{
          priority: DEFAULT_SETTINGS.defaultPriority,
          makeCopy: false,
          includeSubfolders: false,
        }}
        onIncludeSubfoldersChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      container
    );
  });
  const input = container.querySelector<HTMLInputElement>(
    '.ir-bulk-import-search-input'
  )!;
  return {
    container,
    makeSource,
    /** Type `text` as the field's whole value, as the user would. */
    type: async (text: string) => {
      input.value = text;
      await act(() => {
        input.dispatchEvent(new Event('input'));
      });
    },
    rowPaths: () =>
      [...container.querySelectorAll('.ir-bulk-import-row')].map(
        (row) =>
          (row.querySelector('input[type="checkbox"]') as HTMLInputElement)
            .checked && row.textContent
      ),
    progress: () => container.querySelector('.ir-bulk-import-search-progress'),
    error: () => container.querySelector('.ir-bulk-import-search-error'),
    prompt: () => container.querySelector('.ir-bulk-import-prompt'),
    unmount: () => act(() => render(null, container)),
  };
}

const files = (...paths: string[]) => paths.map(makeFile);
// #endregion

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('searchFilter', () => {
  it('searches what was typed last once typing has paused, and not before', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc
              .string({ minLength: 1, maxLength: 4 })
              .filter((s) => s.trim() !== ''),
            fc.integer({ min: 0, max: SEARCH_DEBOUNCE_MS - 1 })
          ),
          { minLength: 1, maxLength: 5 }
        ),
        async (typing) => {
          document.body.replaceChildren();
          const { search, runs } = makeSearch();
          const row = mount(search);

          for (const [text, pause] of typing) {
            await row.type(text);
            await advance(pause);
          }
          expect(runs).toEqual([]);
          const [last, lastPause] = typing[typing.length - 1];
          await advance(SEARCH_DEBOUNCE_MS - lastPause - 1);
          expect(runs).toEqual([]);
          await advance(1);

          expect(runs.map((run) => run.query)).toEqual([last]);
          await row.unmount();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('says how many have matched while it searches, then lists what matched, every row ticked', async () => {
    const { search, runs } = makeSearch();
    const row = mount(search);
    await row.type('spaced');
    await advance(SEARCH_DEBOUNCE_MS);

    expect(row.progress()?.textContent).toMatch(/\b0\b/);
    await act(() => runs[0].progress(2));
    expect(row.progress()?.textContent).toMatch(/\b2\b/);
    expect(row.prompt()).not.toBeNull();

    const matched = files('a.md', 'b/c.md');
    runs[0].resolve(matched);
    await settle();

    expect(row.progress()).toBeNull();
    expect(row.makeSource).toHaveBeenCalledExactlyOnceWith(matched);
    expect(row.rowPaths()).toEqual([
      expect.stringContaining('a'),
      expect.stringContaining('c'),
    ]);
  });

  it("shows the engine's own error under the field for a query it can't parse, listing nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ minLength: 1 }).map((message) => new Error(message)),
          fc.string({ minLength: 1 })
        ),
        async (thrown) => {
          document.body.replaceChildren();
          const { search, runs } = makeSearch();
          const row = mount(search);
          // Listing something first
          await row.type('good');
          await advance(SEARCH_DEBOUNCE_MS);
          runs[0].resolve(files('a.md'));
          await settle();
          expect(row.rowPaths()).toHaveLength(1);

          await row.type('x:bad');
          await advance(SEARCH_DEBOUNCE_MS);
          runs[1].reject(thrown);
          await settle();

          const message = thrown instanceof Error ? thrown.message : thrown;
          expect(row.error()?.textContent).toBe(message);
          expect(row.progress()).toBeNull();
          expect(row.rowPaths()).toEqual([]);
          expect(row.prompt()).not.toBeNull();

          // Gone once a query searches again
          await row.type('good');
          await advance(SEARCH_DEBOUNCE_MS);
          expect(row.error()).toBeNull();
          await row.unmount();
        }
      ),
      { numRuns: 10 }
    );
  });

  it('stops the search running on another edit, listing nothing it finds after', async () => {
    const { search, runs } = makeSearch();
    const row = mount(search);
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);

    await row.type('two');
    expect(runs[0].signal.aborted).toBe(true);
    runs[0].resolve(files('stale.md'));
    await act(() => runs[0].progress(5));
    // Long enough for rows to show, before the next search starts
    await advance(SEARCH_DEBOUNCE_MS - 1);
    expect(row.rowPaths()).toEqual([]);
    expect(row.progress()).toBeNull();

    await advance(1);
    runs[1].reject(new Error('late'));
    await settle();
    expect(runs.map((run) => run.query)).toEqual(['one', 'two']);
    expect(row.error()?.textContent).toBe('late');
  });

  it('ignores the failure of a search stopped by another edit', async () => {
    const { search, runs } = makeSearch();
    const row = mount(search);
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);
    await row.type('two');

    runs[0].reject(new Error('stopped'));
    // Before the next search starts
    await advance(SEARCH_DEBOUNCE_MS - 1);

    expect(row.error()).toBeNull();
    expect(runs).toHaveLength(1);
  });

  it('keeps the list while the next query is searched, then ticks every row of its matches again', async () => {
    const { search, runs } = makeSearch();
    const row = mount(search);
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);
    runs[0].resolve(files('a.md', 'b.md'));
    await settle();
    const box = row.container.querySelector<HTMLInputElement>(
      '.ir-bulk-import-row input[type="checkbox"]'
    )!;
    await act(() => box.click());
    expect(row.rowPaths()[0]).toBe(false);

    await row.type('one ');
    await advance(SEARCH_DEBOUNCE_MS);
    expect(row.rowPaths()).toEqual([false, expect.stringContaining('b')]);
    runs[1].resolve(files('a.md', 'b.md'));
    await settle();

    expect(row.rowPaths()).toEqual([
      expect.stringContaining('a'),
      expect.stringContaining('b'),
    ]);
    expect(row.makeSource).toHaveBeenCalledTimes(2);
  });

  it('keeps the list and its ticks, searching nothing, when the query listed is typed again', async () => {
    const { search, runs } = makeSearch();
    const row = mount(search);
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);
    runs[0].resolve(files('a.md', 'b.md'));
    await settle();
    const box = row.container.querySelector<HTMLInputElement>(
      '.ir-bulk-import-row input[type="checkbox"]'
    )!;
    await act(() => box.click());

    // Edited and put back, searched in between or not
    await row.type('onex');
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);
    await row.type('two');
    await advance(SEARCH_DEBOUNCE_MS);
    await row.type('one');
    await settle();

    expect(runs.map((run) => run.query)).toEqual(['one', 'two']);
    expect(runs[1].signal.aborted).toBe(true);
    expect(row.rowPaths()).toEqual([false, expect.stringContaining('b')]);
    expect(row.progress()).toBeNull();
    expect(row.makeSource).toHaveBeenCalledTimes(1);
  });

  it('searches again a query typed after it failed or the field was cleared', async () => {
    const { search, runs } = makeSearch();
    const row = mount(search);
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);
    runs[0].reject(new Error('bad'));
    await settle();
    await row.type('one ');
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);
    runs[1].resolve(files('a.md'));
    await settle();

    await row.type('');
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);

    expect(runs.map((run) => run.query)).toEqual(['one', 'one', 'one']);
  });

  it('lists nothing, searching nothing, once the field holds nothing but spaces', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('', ' ', '  \t'), async (blank) => {
        document.body.replaceChildren();
        const { search, runs } = makeSearch();
        const row = mount(search);
        await row.type('one');
        await advance(SEARCH_DEBOUNCE_MS);
        runs[0].resolve(files('a.md'));
        await settle();
        await row.type('two');
        await advance(SEARCH_DEBOUNCE_MS);

        await row.type(blank);
        await advance(SEARCH_DEBOUNCE_MS);

        expect(runs).toHaveLength(2);
        expect(runs[1].signal.aborted).toBe(true);
        expect(row.rowPaths()).toEqual([]);
        expect(row.progress()).toBeNull();
        expect(row.prompt()).not.toBeNull();
        await row.unmount();
      }),
      // Each of them, whatever is drawn
      { examples: [[''], [' '], ['  \t']], numRuns: 3 }
    );
  });

  it('stops the search once the dialog goes, and starts none still waiting', async () => {
    const { search, runs } = makeSearch();
    const row = mount(search);
    await row.type('one');
    await advance(SEARCH_DEBOUNCE_MS);
    await row.type('two');
    await advance(SEARCH_DEBOUNCE_MS);

    await row.type('three');
    await row.unmount();
    await advance(SEARCH_DEBOUNCE_MS);

    expect(runs.map((run) => run.signal.aborted)).toEqual([true, true]);
  });
});
