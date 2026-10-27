// @vitest-environment jsdom
import type { CandidateSource, ScanEvent } from '#/lib/bulk-import/types';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import fc from 'fast-check';
import { TFile, type App } from 'obsidian';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilteredBulkImport, type FilterSegment } from './BulkImportFilterBar';
import { TAG_FILTER_DEBOUNCE_MS, tagFilter } from './TagFilter';

// #region HELPERS
function makeFile(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign(new TFile(), {
    path,
    name,
    basename: name.replace(/\.[^.]*$/, ''),
    extension: 'md',
  });
}

/** Let `ms` pass, and the scans and renders it sets off run. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  // What the scan a timer set off renders
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** The name of the row a source for a tag lists. */
const rowName = (tag: string) => tag.replace(/\//g, '_');

/**
 * A source for `tags` whose every run yields a row per tag, named for it, at
 * the top level and ends; each run's signal is kept.
 */
function makeSource(tags: readonly string[]) {
  const signals: AbortSignal[] = [];
  const source: CandidateSource = {
    title: tags.join(','),
    async *scan(signal) {
      signals.push(signal);
      for (const tag of tags) {
        const name = rowName(tag);
        yield {
          type: 'file',
          file: makeFile(`${name}.md`),
          parent: '/',
          relativePath: `${name}.md`,
        } satisfies ScanEvent;
      }
      yield { type: 'folder-done', path: '/' } satisfies ScanEvent;
    },
  };
  return { source, signals };
}

/**
 * The tag filter, behind a segment that comes first, over a vault whose
 * tags are `vaultTags`; each source it makes is kept in `made`.
 */
function tagSegments(
  initialTags?: readonly string[],
  vaultTags: string[] = []
) {
  const app = {
    metadataCache: {
      getTags: () => Object.fromEntries(vaultTags.map((tag) => [tag, 1])),
    },
  } as unknown as App;
  const sources: ReturnType<typeof makeSource>[] = [];
  const made = vi.fn((tags: readonly string[]) => {
    const made = makeSource(tags);
    sources.push(made);
    return made.source;
  });
  const first: FilterSegment = {
    id: 'first',
    label: 'First',
    row: () => <div className="first-row" />,
  };
  return {
    segments: [first, tagFilter(app, made, initialTags)],
    made,
    sources,
  };
}

function mount(segments: readonly FilterSegment[]) {
  const onConfirm = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  void act(() => {
    render(
      <FilteredBulkImport
        segments={segments}
        defaults={{
          priority: DEFAULT_SETTINGS.defaultPriority,
          makeCopy: false,
          includeSubfolders: false,
        }}
        onIncludeSubfoldersChange={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
      container
    );
  });
  return { container, onConfirm };
}

function segmentButtons(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('.ir-segment')];
}

/** Press the tag segment, the second. */
async function pressTag(container: HTMLElement) {
  await act(() => segmentButtons(container)[1].click());
  await advance();
}

function tagInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    '.ir-bulk-import-filter-row input[type="text"]'
  )!;
}

/** Type `text` over what the tag field holds, without waiting. */
async function type(container: HTMLElement, text: string) {
  const input = tagInput(container);
  input.focus();
  input.value = text;
  await act(() => {
    input.dispatchEvent(new Event('input'));
  });
}

function rowNames(container: HTMLElement) {
  return [...container.querySelectorAll('.ir-bulk-import-row')].map(
    (row) => row.querySelector('.ir-bulk-import-name')?.textContent
  );
}

function rowBoxes(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLInputElement>(
      '.ir-bulk-import-row input[type="checkbox"]'
    ),
  ];
}

function suggestions() {
  return [...document.querySelectorAll<HTMLElement>('.suggestion-item')];
}

const prompt = (container: HTMLElement) =>
  container.querySelector('.ir-bulk-import-prompt');

/** Tags as the field reads them: lower case, with no `#`. */
const tagsArb = fc.uniqueArray(
  fc.constantFrom('read', 'read/later', 'x', 'to-do'),
  { maxLength: 3 }
);
// #endregion

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tagFilter', () => {
  it('holds the tags it starts with once pressed, listing what they make at once, or nothing for none', async () => {
    await fc.assert(
      fc.asyncProperty(tagsArb, async (initial) => {
        const { segments, made } = tagSegments(initial);
        const { container } = mount(segments);

        await pressTag(container);

        expect(tagInput(container).value).toBe(
          initial.map((tag) => `#${tag}`).join(', ')
        );
        if (initial.length === 0) {
          expect(made).not.toHaveBeenCalled();
          expect(prompt(container)).not.toBeNull();
        } else {
          expect(made).toHaveBeenCalledExactlyOnceWith(initial);
          expect(rowNames(container)).toEqual(initial.map(rowName));
        }
        document.body.replaceChildren();
      }),
      { numRuns: 12 }
    );
  });

  it('starts out empty when given no tags', async () => {
    const { segments, made } = tagSegments();
    const { container } = mount(segments);

    await pressTag(container);

    expect(tagInput(container).value).toBe('');
    expect(made).not.toHaveBeenCalled();
  });

  it('lists the tags typed once typing has paused for the debounce, not before', async () => {
    const { segments, made } = tagSegments();
    const { container } = mount(segments);
    await pressTag(container);

    await type(container, '#Read');
    await advance(TAG_FILTER_DEBOUNCE_MS - 1);
    // More typing starts the wait over
    await type(container, '#Read, x');
    await advance(TAG_FILTER_DEBOUNCE_MS - 1);
    expect(made).not.toHaveBeenCalled();
    expect(prompt(container)).not.toBeNull();

    await advance(1);

    expect(made).toHaveBeenCalledExactlyOnceWith(['read', 'x']);
    expect(rowNames(container)).toEqual(['read', 'x']);
  });

  it('scans afresh for other tags, the last scan stopped and every row ticked again', async () => {
    const { segments, made, sources } = tagSegments(['read', 'x']);
    const { container } = mount(segments);
    await pressTag(container);
    await act(() => rowBoxes(container)[0].click());
    expect(rowBoxes(container).map((box) => box.checked)).toEqual([
      false,
      true,
    ]);

    await type(container, 'x, read, to-do');
    await advance(TAG_FILTER_DEBOUNCE_MS);

    expect(made).toHaveBeenLastCalledWith(['x', 'read', 'to-do']);
    expect(sources[0].signals[0].aborted).toBe(true);
    expect(rowNames(container)).toEqual(['x', 'read', 'to-do']);
    expect(rowBoxes(container).every((box) => box.checked)).toBe(true);
  });

  it('changes nothing for the same tags written another way', async () => {
    const { segments, made } = tagSegments(['read', 'x']);
    const { container } = mount(segments);
    await pressTag(container);
    await act(() => rowBoxes(container)[0].click());

    await type(container, '  READ x,,#x ');
    await advance(TAG_FILTER_DEBOUNCE_MS);

    expect(made).toHaveBeenCalledOnce();
    expect(rowBoxes(container).map((box) => box.checked)).toEqual([
      false,
      true,
    ]);
  });

  it('lists nothing once the field is cleared, and the tags again once typed back', async () => {
    const { segments, made } = tagSegments(['read']);
    const { container } = mount(segments);
    await pressTag(container);

    await type(container, ' , ');
    await advance(TAG_FILTER_DEBOUNCE_MS);

    expect(rowNames(container)).toEqual([]);
    expect(prompt(container)).not.toBeNull();

    await type(container, 'read');
    await advance(TAG_FILTER_DEBOUNCE_MS);

    expect(made).toHaveBeenCalledTimes(2);
    expect(rowNames(container)).toEqual(['read']);
  });

  it('puts a picked suggestion in place of the tag being typed, listing at once', async () => {
    const { segments, made } = tagSegments([], ['#read', '#read/later', '#x']);
    const { container } = mount(segments);
    await pressTag(container);

    await type(container, 'x, LAT');
    await advance();
    const items = suggestions();
    expect(items.map((item) => item.textContent)).toEqual(['#read/later']);
    await act(() => items[0].click());
    await advance();

    expect(tagInput(container).value).toBe('x, #read/later');
    expect(suggestions()).toEqual([]);
    expect(made).toHaveBeenCalledExactlyOnceWith(['x', 'read/later']);
    // The wait typing set off finds nothing new to list
    await advance(TAG_FILTER_DEBOUNCE_MS);
    expect(made).toHaveBeenCalledOnce();
  });

  it('lists nothing typed into it after another segment is pressed, nor once the dialog goes', async () => {
    const { segments, made } = tagSegments();
    const { container } = mount(segments);
    await pressTag(container);

    await type(container, 'read');
    await act(() => segmentButtons(container)[0].click());
    await advance(TAG_FILTER_DEBOUNCE_MS);
    expect(made).not.toHaveBeenCalled();

    await pressTag(container);
    await type(container, 'read');
    const input = tagInput(container);
    await act(() => render(null, container));
    await advance(TAG_FILTER_DEBOUNCE_MS);
    // Typing into the field the row left behind sets nothing off either
    input.value = 'other';
    input.dispatchEvent(new Event('input'));
    await advance(TAG_FILTER_DEBOUNCE_MS);
    expect(made).not.toHaveBeenCalled();
  });

  it('reports no source for a field that starts out empty', () => {
    const { segments } = tagSegments();
    const onSource = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);

    void act(() => {
      render(
        <>{segments[1].row({ onSource, subfoldersToggle: null })}</>,
        container
      );
    });

    expect(onSource).not.toHaveBeenCalled();
  });

  it('reports to the handler it was last handed', async () => {
    const { segments } = tagSegments();
    const [first, second] = [vi.fn(), vi.fn()];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const show = (onSource: typeof first) =>
      act(() => {
        render(
          <>{segments[1].row({ onSource, subfoldersToggle: null })}</>,
          container
        );
      });
    await show(first);
    await show(second);

    await type(container, 'read');
    await advance(TAG_FILTER_DEBOUNCE_MS);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('tells apart lists that run together without their separators', async () => {
    const { segments, made } = tagSegments(['a', 'b']);
    const { container } = mount(segments);
    await pressTag(container);

    await type(container, 'ab');
    await advance(TAG_FILTER_DEBOUNCE_MS);

    expect(made).toHaveBeenLastCalledWith(['ab']);
    expect(made).toHaveBeenCalledTimes(2);
  });

  it('confirms the ticked rows with the source the tags made', async () => {
    const { segments, sources } = tagSegments(['read']);
    const { container, onConfirm } = mount(segments);
    await pressTag(container);

    await act(() =>
      container.querySelector<HTMLButtonElement>('button.mod-cta')!.click()
    );

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ path: 'read.md' })],
      expect.anything(),
      sources[0].source
    );
  });
});
