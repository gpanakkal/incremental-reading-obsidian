// @vitest-environment jsdom
import type { CandidateChecks } from '#/lib/bulk-import/candidates';
import { selectionSource } from '#/lib/bulk-import/selection';
import type {
  BulkImportOptions,
  BulkOutcome,
  CandidateSource,
  ScanEvent,
} from '#/lib/bulk-import/types';
import { MINIMUM_FIXED_REVIEW_INTERVAL } from '#/lib/constants';
import { explorerComparator } from '#/lib/explorer-order';
import IRScheduler from '#/lib/IRScheduler';
import type { UiState } from '#/lib/plugin-data';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type IncrementalReadingPlugin from '#/main';
// The mock the vitest config aliases `obsidian` to, imported by path so its
// recorded notices are visible to the type checker
import { Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import { TFile, TFolder } from 'obsidian';
import { render } from 'preact';
import { useId } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkImportModal } from './BulkImportModal';

// #region HELPERS
/**
 * A plugin whose "Include subfolders" was last left `includeSubfolders`, and
 * which remembers each change to it as the real one does.
 */
function makePlugin(
  copyOnImport = DEFAULT_SETTINGS.copyOnImport,
  { includeSubfolders = false } = {}
) {
  const importArticles = vi.fn(
    async (
      entries: { file: TFile }[],
      _options: BulkImportOptions
    ): Promise<BulkOutcome[]> =>
      entries.map(({ file }) => ({ file, status: 'imported' }))
  );
  const ui: UiState = { folderImportIncludeSubfolders: includeSubfolders };
  const saveUiState = vi.fn((change: Partial<UiState>) => {
    Object.assign(ui, change);
    return Promise.resolve();
  });
  // The entry an import records for an undo, and its notice button
  const entry = { description: 'importing', undo: vi.fn() };
  const undo = { label: 'Undo', onClick: vi.fn() };
  const actions = {
    recordImport: vi.fn<(summary: unknown) => typeof entry | null>(() => entry),
    undoAction: vi.fn(() => undo),
  };
  const plugin = {
    app: {},
    settings: { ...DEFAULT_SETTINGS, copyOnImport },
    data: { ui },
    saveUiState,
    reviewManager: { importArticles },
    actions,
  } as unknown as IncrementalReadingPlugin;
  return { plugin, importArticles, saveUiState, actions, entry, undo };
}

function makeFile(name: string, folder = 'notes'): TFile {
  const dot = name.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path: `${folder}/${name}`,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : '',
  });
}

/** Let the scan and the renders it causes run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * A source whose scan yields what the test sends it, when it sends it, and
 * ends when told to; each run of it, the toggle having changed, takes what is
 * sent from then on. With `deeper`, it offers to include subfolders.
 */
function makeSource(title = 'notes', { deeper = false } = {}) {
  let queue: (ScanEvent | 'end')[] = [];
  const waiting = new Set<() => void>();
  /** Each run, oldest first: its signal, and whether it went deeper. */
  const runs: { signal: AbortSignal; subfolders: boolean | undefined }[] = [];
  const source: CandidateSource = {
    title,
    ...(deeper && { canIncludeSubfolders: true }),
    async *scan(signal, options) {
      runs.push({ signal, subfolders: options?.subfolders });
      const mine: (ScanEvent | 'end')[] = (queue = []);
      for (;;) {
        while (mine.length === 0) {
          await new Promise<void>((resolve) => waiting.add(resolve));
        }
        const next = mine.shift()!;
        if (next === 'end') return;
        yield next;
      }
    },
  };
  const send = async (next: ScanEvent | 'end') => {
    queue.push(next);
    for (const wake of waiting) wake();
    waiting.clear();
    await settle();
  };
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
  return {
    source,
    /** Yield `file` as a top-level row, `relativePath` from where it starts. */
    add: (file: TFile, relativePath = file.name) =>
      send({ type: 'file', file, parent: 'notes', relativePath }),
    end: () => send('end'),
    /** Yield `event` as it is. */
    send,
    signal: () => runs[0]?.signal ?? null,
    runs,
    /** Announce the folder at `path`, under the folder its path names. */
    folder: (path: string) =>
      send({ type: 'folder', path, parent: parentOf(path) }),
    /** Yield `file`, or a new file at a path, a row in its path's folder. */
    file: (file: TFile | string) => {
      const found =
        typeof file === 'string'
          ? makeFile(file.slice(file.lastIndexOf('/') + 1), parentOf(file))
          : file;
      return send({
        type: 'file',
        file: found,
        parent: parentOf(found.path),
        relativePath: found.path.slice('notes/'.length),
      });
    },
    /** Report the folder at `path` done; `notes` is where the source starts. */
    done: (path: string) => send({ type: 'folder-done', path }),
  };
}

/** A modal on `source`, open and in the page. */
function openModal(
  plugin: IncrementalReadingPlugin,
  source: CandidateSource
): BulkImportModal {
  const modal = new BulkImportModal(plugin, { source, mode: 'import' });
  // Close as Obsidian's does: through `onClose`
  vi.spyOn(modal, 'close').mockImplementation(() => modal.onClose());
  // Inside `act`, so the scan's effect runs before the test goes on
  void act(() => modal.onOpen());
  // jsdom only fires a checkbox's change event while it is in the page
  document.body.append(modal.contentEl);
  return modal;
}

function rows(modal: BulkImportModal) {
  return [...modal.contentEl.querySelectorAll('.ir-bulk-import-row')];
}

/** The name a row shows, and the type tag after it, if any. */
function nameOf(row: Element) {
  return row.querySelector('.ir-bulk-import-name')?.textContent;
}

function tagOf(row: Element) {
  return row.querySelector('.ir-bulk-import-tag')?.textContent;
}

function rowBox(modal: BulkImportModal, index: number) {
  return rows(modal)[index].querySelector('input')!;
}

/** The first number in `text`, or NaN when it has none. */
function numberIn(text: string | null | undefined) {
  return Number(/\d+/.exec(text ?? '')?.[0]);
}

function selectedCount(modal: BulkImportModal) {
  return numberIn(
    modal.contentEl.querySelector('.ir-bulk-import-count')?.textContent
  );
}

function emptyState(modal: BulkImportModal) {
  return modal.contentEl.querySelector('.ir-bulk-import-empty');
}

function button(modal: BulkImportModal, text: RegExp) {
  const found = [...modal.contentEl.querySelectorAll('button')].find((el) =>
    text.test(el.textContent ?? '')
  );
  if (!found) throw new Error(`no ${text} button`);
  return found;
}

function confirmButton(modal: BulkImportModal) {
  return button(modal, /^Import \d+$/);
}

function spinner(modal: BulkImportModal) {
  return modal.contentEl.querySelector('.ir-loading');
}

function copyToggle(modal: BulkImportModal) {
  const label = [...modal.contentEl.querySelectorAll('label')].find((el) =>
    el.textContent?.includes('Make a copy')
  );
  return label?.querySelector('input') ?? null;
}

function strategyToggle(modal: BulkImportModal) {
  const label = [...modal.contentEl.querySelectorAll('label')].find((el) =>
    el.textContent?.includes('Priority scheduling')
  );
  return label!.querySelector('input')!;
}

/** What a field reads `typed` as, or `kept` for text it refuses. */
function orKept(read: () => number, kept: number) {
  try {
    return read();
  } catch {
    return kept;
  }
}

async function click(el: HTMLElement) {
  await act(() => {
    el.click();
  });
}
function subfolderToggle(modal: BulkImportModal) {
  const label = [...modal.contentEl.querySelectorAll('label')].find((el) =>
    el.textContent?.includes('Include subfolders')
  );
  return label?.querySelector('input') ?? null;
}

/**
 * The list as text, a line a row, indented two spaces a level: a file by
 * its name and the path it shows, a folder by its name, with `…` after it
 * while its spinner shows.
 */
function outline(modal: BulkImportModal): string[] {
  const lines: string[] = [];
  const walk = (list: Element, depth: number) => {
    for (const item of list.children) {
      const indent = '  '.repeat(depth);
      if (item.classList.contains('ir-bulk-import-row')) {
        const name = item.querySelector('.ir-bulk-import-name')?.textContent;
        const tag = item.querySelector('.ir-bulk-import-tag')?.textContent;
        lines.push(`${indent}${name}${tag === undefined ? '' : ` [${tag}]`}`);
      } else if (item.classList.contains('ir-bulk-import-folder')) {
        const title = item.querySelector(
          ':scope > .ir-bulk-import-folder-title'
        )!;
        const name = title.querySelector('.ir-bulk-import-name')!;
        const spinning = title.querySelector('.ir-loading') !== null;
        // The spinner comes after the name
        if (spinning)
          expect(name.nextElementSibling).toBe(
            title.querySelector('.ir-loading')
          );
        lines.push(`${indent}${name.textContent}${spinning ? ' …' : ''}`);
        const children = item.querySelector(
          ':scope > .ir-bulk-import-children'
        );
        if (children) walk(children, depth + 1);
      }
    }
  };
  walk(modal.contentEl.querySelector('.ir-bulk-import-list')!, 0);
  return lines;
}
// #endregion

beforeEach(() => {
  Notice.reset();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('BulkImportModal', () => {
  it('is titled with where its files come from', () => {
    fc.assert(
      fc.property(fc.string(), (title) => {
        const modal = new BulkImportModal(makePlugin().plugin, {
          source: makeSource(title).source,
          mode: 'import',
        });
        modal.onOpen();
        try {
          expect(modal.titleEl.textContent).toContain(title);
        } finally {
          modal.onClose();
        }
      }),
      { numRuns: 20 }
    );
  });

  it('lists each file as it is found, with a spinner below until the scan ends', async () => {
    const scan = makeSource();
    const modal = openModal(makePlugin().plugin, scan.source);
    await settle();
    expect(rows(modal)).toHaveLength(0);
    expect(spinner(modal)).not.toBeNull();

    const names = ['b.md', 'a.pdf', 'c.md'];
    for (const [i, name] of names.entries()) {
      await scan.add(makeFile(name));
      expect(rows(modal).map(nameOf)).toEqual(
        names.slice(0, i + 1).map((n) => n.slice(0, n.lastIndexOf('.')))
      );
      expect(rowBox(modal, i).checked).toBe(true);
      // The spinner trails the rows
      expect(
        modal.contentEl
          .querySelector('.ir-bulk-import-list')
          ?.lastElementChild?.querySelector('.ir-loading')
      ).not.toBeNull();
      expect(selectedCount(modal)).toBe(i + 1);
    }

    await scan.end();
    expect(spinner(modal)).toBeNull();
    expect(rows(modal)).toHaveLength(names.length);
    expect(emptyState(modal)).toBeNull();
    modal.close();
  });

  it('shows a deeper file by its name alone, its folder row saying where it is', async () => {
    const scan = makeSource();
    const modal = openModal(makePlugin().plugin, scan.source);
    const deep = makeFile('a.md', 'notes/sub');

    await scan.add(deep, 'sub/a.md');

    const row = rows(modal)[0];
    expect(nameOf(row)).toBe('a');
    expect(row.textContent).toBe('a');
    modal.close();
  });

  it('names a file without its extension, tagging every type but Markdown with it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => !s.startsWith('.')),
        fc.oneof(fc.constant('md'), fc.stringMatching(/^[a-zA-Z0-9]{1,5}$/)),
        async (basename, extension) => {
          document.body.replaceChildren();
          const scan = makeSource();
          const modal = openModal(makePlugin().plugin, scan.source);

          await scan.add(makeFile(`${basename}.${extension}`));

          const [row] = rows(modal);
          expect(nameOf(row)).toBe(basename);
          // The full name is the tooltip, for a name cut off by its width
          expect(
            row
              .querySelector('.ir-bulk-import-name')
              ?.getAttribute('aria-label')
          ).toBe(basename);
          expect(tagOf(row)).toBe(extension === 'md' ? undefined : extension);
          modal.close();
        }
      ),
      { numRuns: 25 }
    );
  }, 20_000);

  it('says so when the scan finds nothing', async () => {
    const scan = makeSource();
    const modal = openModal(makePlugin().plugin, scan.source);
    await settle();
    expect(emptyState(modal)).toBeNull();

    await scan.end();

    expect(emptyState(modal)).not.toBeNull();
    expect(confirmButton(modal).disabled).toBe(true);
    modal.close();
  });

  it('counts the ticked rows, and imports exactly them, in order, when confirmed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.nat({ max: 4 }), { maxLength: 8 }),
        async (count, clicks) => {
          document.body.replaceChildren();
          const { plugin, importArticles } = makePlugin();
          const scan = makeSource();
          const modal = openModal(plugin, scan.source);
          const files = Array.from({ length: count }, (_, i) =>
            makeFile(`n${i}.md`)
          );
          for (const file of files) await scan.add(file);
          await scan.end();

          const ticked = files.map(() => true);
          for (const index of clicks.filter((i) => i < count)) {
            await click(rowBox(modal, index));
            ticked[index] = !ticked[index];
            const selected = ticked.filter(Boolean).length;
            expect(selectedCount(modal)).toBe(selected);
            expect(numberIn(confirmButton(modal).textContent)).toBe(selected);
            expect(confirmButton(modal).disabled).toBe(selected === 0);
          }

          const chosen = files.filter((_, i) => ticked[i]);
          await click(confirmButton(modal));
          await settle();

          if (chosen.length === 0) {
            expect(importArticles).not.toHaveBeenCalled();
          } else {
            expect(importArticles).toHaveBeenCalledExactlyOnceWith(
              chosen.map((file) => ({ file })),
              {
                priority: plugin.settings.defaultPriority,
                fixedIntervalDays: null,
                makeCopy: plugin.settings.copyOnImport,
              }
            );
          }
        }
      ),
      { numRuns: 25 }
    );
    // 2-5 s alone; past the 5 s default under a full parallel run
  }, 20_000);

  it('closes on confirm, then says how many it imported from where', async () => {
    const { plugin, importArticles } = makePlugin();
    const scan = makeSource('Reading');
    const modal = openModal(plugin, scan.source);
    // Spied on already: this hands back that spy
    const close = vi.spyOn(modal, 'close');
    const [a, b] = [makeFile('a.md'), makeFile('b.md')];
    await scan.add(a);
    await scan.add(b);
    importArticles.mockResolvedValue([
      { file: a, status: 'imported' },
      { file: b, status: 'failed', reason: 'broken' },
    ]);

    await click(confirmButton(modal));
    await modal.closed;

    expect(close).toHaveBeenCalledOnce();
    expect(Notice.messages).toEqual([
      expect.stringMatching(/\b1\b.*\b2\b.*Reading/),
      expect.stringMatching(/\b1\b[\s\S]*notes\/b\.md[\s\S]*broken/),
    ]);
  });

  it('records the import for an undo, which a button on its count undoes', async () => {
    for (const recorded of [true, false]) {
      Notice.reset();
      const { plugin, importArticles, actions, entry, undo } = makePlugin();
      if (!recorded) actions.recordImport.mockReturnValue(null);
      const scan = makeSource('Reading');
      const modal = openModal(plugin, scan.source);
      const file = makeFile('a.md');
      await scan.add(file);
      const outcomes = [{ file, status: 'imported' as const }];
      importArticles.mockResolvedValue(outcomes);

      await click(confirmButton(modal));
      await modal.closed;

      expect(actions.recordImport).toHaveBeenCalledExactlyOnceWith({
        from: 'Reading',
        outcomes,
      });
      const buttons = [
        ...Notice.instances[0].containerEl.querySelectorAll<HTMLElement>(
          '.notice-cta'
        ),
      ];
      if (!recorded) {
        expect(actions.undoAction).not.toHaveBeenCalled();
        expect(buttons).toEqual([]);
        continue;
      }
      expect(actions.undoAction).toHaveBeenCalledExactlyOnceWith(entry);
      expect(buttons).toHaveLength(1);
      buttons[0].click();
      expect(undo.onClick).toHaveBeenCalledOnce();
    }
  });

  it('imports once, however often it is confirmed', async () => {
    const { plugin, importArticles } = makePlugin();
    const scan = makeSource();
    const modal = openModal(plugin, scan.source);
    await scan.add(makeFile('a.md'));
    const confirm = confirmButton(modal);

    await click(confirm);
    await click(confirm);
    await modal.closed;

    expect(importArticles).toHaveBeenCalledOnce();
  });

  it('imports with the options chosen above the list', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (copyOnImport, fixedInterval, flipCopy) => {
          document.body.replaceChildren();
          const { plugin, importArticles } = makePlugin(copyOnImport);
          const scan = makeSource();
          const modal = openModal(plugin, scan.source);
          const file = makeFile('a.pdf');
          await scan.add(file);

          expect(copyToggle(modal)?.checked).toBe(copyOnImport);
          if (fixedInterval) await click(strategyToggle(modal));
          if (flipCopy) await click(copyToggle(modal)!);
          await click(confirmButton(modal));
          await modal.closed;

          expect(importArticles).toHaveBeenCalledExactlyOnceWith([{ file }], {
            priority: plugin.settings.defaultPriority,
            fixedIntervalDays: fixedInterval
              ? MINIMUM_FIXED_REVIEW_INTERVAL
              : null,
            makeCopy: copyOnImport !== flipCopy,
          });
        }
      ),
      { numRuns: 16 }
    );
  });

  it('imports at the priority or on the fixed interval typed in, confirmed with Enter or the button', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.oneof(
          fc.integer({ min: 0, max: 99 }).map(String),
          fc.constantFrom('2.5', '.5', '10')
        ),
        fc.boolean(),
        async (fixedInterval, typed, withEnter) => {
          document.body.replaceChildren();
          const { plugin, importArticles } = makePlugin();
          const scan = makeSource();
          const modal = openModal(plugin, scan.source);
          const file = makeFile('a.md');
          await scan.add(file);
          if (fixedInterval) await click(strategyToggle(modal));
          const input = modal.contentEl.querySelector<HTMLInputElement>(
            fixedInterval ? '#ir-fixed-interval-input' : '#ir-priority-input'
          )!;

          await act(() => {
            input.focus();
            input.value = typed;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          if (withEnter) {
            await act(() => {
              input.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
              );
            });
          } else {
            await act(() => input.blur());
            await click(confirmButton(modal));
          }
          await modal.closed;

          expect(importArticles).toHaveBeenCalledExactlyOnceWith(
            [{ file }],
            fixedInterval
              ? {
                  priority: plugin.settings.defaultPriority,
                  fixedIntervalDays: orKept(
                    () => IRScheduler.adjustFixedIntervalOnChange(typed),
                    MINIMUM_FIXED_REVIEW_INTERVAL
                  ),
                  makeCopy: plugin.settings.copyOnImport,
                }
              : {
                  priority: orKept(
                    () =>
                      IRScheduler.transformPriority(
                        IRScheduler.adjustDisplayPriorityOnChange(typed)
                      ),
                    plugin.settings.defaultPriority
                  ),
                  fixedIntervalDays: null,
                  makeCopy: plugin.settings.copyOnImport,
                }
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('imports on no key but Enter', async () => {
    const { plugin, importArticles } = makePlugin();
    const scan = makeSource();
    const modal = openModal(plugin, scan.source);
    await scan.add(makeFile('a.md'));
    const input =
      modal.contentEl.querySelector<HTMLInputElement>('#ir-priority-input')!;

    for (const key of ['a', 'Tab', 'Escape', ' ']) {
      await act(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true })
        );
      });
    }

    expect(importArticles).not.toHaveBeenCalled();
    modal.close();
  });

  it('ignores Enter while nothing is ticked', async () => {
    const { plugin, importArticles } = makePlugin();
    const scan = makeSource();
    const modal = openModal(plugin, scan.source);
    await scan.add(makeFile('a.md'));
    await click(rowBox(modal, 0));
    const input =
      modal.contentEl.querySelector<HTMLInputElement>('#ir-priority-input')!;

    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });

    expect(importArticles).not.toHaveBeenCalled();
    modal.close();
  });

  it('offers a copy only while every listed file can be copied, importing in place otherwise', async () => {
    const { plugin, importArticles } = makePlugin(true);
    const scan = makeSource();
    const modal = openModal(plugin, scan.source);
    const note = makeFile('a.md');
    // No importable type is in place only today; a type the source should
    // never list stands in for one
    const inPlaceOnly = makeFile('b.png');

    await scan.add(note);
    expect(copyToggle(modal)?.checked).toBe(true);
    await scan.add(inPlaceOnly);
    expect(copyToggle(modal)).toBeNull();

    await click(confirmButton(modal));
    await modal.closed;
    expect(importArticles.mock.calls[0][1]).toMatchObject({ makeCopy: false });
  });

  it('shows the priority field to start with, and the interval field once fixed intervals are chosen', async () => {
    const scan = makeSource();
    const modal = openModal(makePlugin().plugin, scan.source);
    expect(modal.contentEl.querySelector('#ir-priority-input')).not.toBeNull();

    await click(strategyToggle(modal));

    expect(modal.contentEl.querySelector('#ir-priority-input')).toBeNull();
    expect(
      modal.contentEl.querySelector('#ir-fixed-interval-input')
    ).not.toBeNull();

    await click(strategyToggle(modal));

    expect(modal.contentEl.querySelector('#ir-priority-input')).not.toBeNull();
    expect(
      modal.contentEl.querySelector('#ir-fixed-interval-input')
    ).toBeNull();
    modal.close();
  });

  it('imports nothing when cancelled, and stops the scan once closed', async () => {
    for (const how of ['cancel', 'escape'] as const) {
      const { plugin, importArticles } = makePlugin();
      const scan = makeSource();
      const modal = openModal(plugin, scan.source);
      await scan.add(makeFile('a.md'));
      expect(scan.signal()?.aborted).toBe(false);

      if (how === 'cancel') await click(button(modal, /^Cancel$/));
      else modal.close();
      await modal.closed;

      expect(scan.signal()?.aborted).toBe(true);
      expect(importArticles).not.toHaveBeenCalled();
      expect(Notice.messages).toEqual([]);
    }
  });

  it('keeps the rows it has when the scan fails', async () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const file = makeFile('a.md');
    const source: CandidateSource = {
      title: 'notes',
      async *scan() {
        yield { type: 'file', file, parent: 'notes', relativePath: 'a.md' };
        throw new Error('gone');
      },
    };
    const modal = openModal(makePlugin().plugin, source);
    await settle();

    expect(rows(modal)).toHaveLength(1);
    expect(spinner(modal)).toBeNull();
    expect(error).toHaveBeenCalled();
    modal.close();
  });
});

describe('BulkImportModal: Include subfolders', () => {
  /** A modal whose source can go deeper, its own file found and done. */
  async function openDeeper(plugin = makePlugin().plugin) {
    const scan = makeSource('notes', { deeper: true });
    const modal = openModal(plugin, scan.source);
    const top = makeFile('top.md');
    await scan.add(top);
    await scan.done('notes');
    await scan.end();
    return { scan, modal, top };
  }

  async function setToggle(modal: BulkImportModal, on: boolean) {
    const toggle = subfolderToggle(modal)!;
    if (toggle.checked !== on) await click(toggle);
    await settle();
  }

  const toggleLook = (modal: BulkImportModal) =>
    subfolderToggle(modal)?.closest('.ir-toggle .checkbox-container')
      ?.classList;

  /** Whether the list ends in the top level's spinner. */
  const trailingSpinner = (modal: BulkImportModal) =>
    modal.contentEl.querySelector(
      '.ir-bulk-import-list > li:last-child > .ir-loading'
    ) !== null;

  it('is offered, switched off, only for a source that can go deeper, which then scans no subfolder', async () => {
    const flat = makeSource();
    const flatModal = openModal(makePlugin().plugin, flat.source);
    await flat.end();
    expect(subfolderToggle(flatModal)).toBeNull();
    flatModal.close();

    const { scan, modal } = await openDeeper();
    expect(subfolderToggle(modal)?.checked).toBe(false);
    expect(toggleLook(modal)).not.toContain('is-enabled');
    expect(scan.runs.map((run) => run.subfolders)).toEqual([false]);
    modal.close();
  });

  it("switched on, scans afresh with subfolders: each folder's subfolders above its files, empty with a spinner after the name until scanned", async () => {
    const { scan, modal, top } = await openDeeper();

    await setToggle(modal, true);
    expect(subfolderToggle(modal)?.checked).toBe(true);
    expect(toggleLook(modal)).toContain('is-enabled');
    expect(scan.runs.map((run) => run.subfolders)).toEqual([false, true]);
    expect(scan.runs[0].signal.aborted).toBe(true);
    await scan.folder('notes/Topic');
    await scan.folder('notes/Other');
    expect(outline(modal)).toEqual(['Topic …', 'Other …']);
    expect(
      modal.contentEl
        .querySelector('.ir-bulk-import-folder .ir-loading')
        ?.getAttribute('aria-label')
    ).toContain('Topic');
    await scan.file(top);
    // The top level's own spinner trails the list until its files are in
    expect(trailingSpinner(modal)).toBe(true);
    await scan.done('notes');
    expect(trailingSpinner(modal)).toBe(false);
    expect(outline(modal)).toEqual(['Topic …', 'Other …', 'top']);

    await scan.folder('notes/Topic/Sub');
    await scan.file('notes/Topic/paper.pdf');
    await scan.done('notes/Topic');
    expect(outline(modal)).toEqual([
      'Topic',
      '  Sub …',
      '  paper [pdf]',
      'Other …',
      'top',
    ]);

    await scan.file('notes/Other/b.md');
    await scan.done('notes/Other');
    await scan.file('notes/Topic/Sub/deep.md');
    await scan.done('notes/Topic/Sub');
    await scan.end();
    expect(outline(modal)).toEqual([
      'Topic',
      '  Sub',
      '    deep',
      '  paper [pdf]',
      'Other',
      '  b',
      'top',
    ]);
    expect(selectedCount(modal)).toBe(4);
    expect(spinner(modal)).toBeNull();
    modal.close();
  });

  it('switched on while the top level is still being scanned, starts over with subfolders, saying nothing more of the run it stopped', async () => {
    const scan = makeSource('notes', { deeper: true });
    const modal = openModal(makePlugin().plugin, scan.source);
    await scan.add(makeFile('top.md'));

    await setToggle(modal, true);

    expect(scan.runs.map((run) => run.subfolders)).toEqual([false, true]);
    expect(scan.runs[0].signal.aborted).toBe(true);
    expect(scan.runs[1].signal.aborted).toBe(false);
    expect(outline(modal)).toEqual([]);
    expect(trailingSpinner(modal)).toBe(true);
    await scan.folder('notes/Topic');
    await scan.add(makeFile('top.md'));
    await scan.add(makeFile('later.md'));
    expect(outline(modal)).toEqual(['Topic …', 'top', 'later']);
    expect(trailingSpinner(modal)).toBe(true);
    modal.close();
  });

  it('lists nothing more from a run the toggle stopped, nor takes its end for the end of the scan', async () => {
    const top = makeFile('top.md');
    const late = makeFile('late.md');
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const fresh = makeSource('notes', { deeper: true });
    let runs = 0;
    const source: CandidateSource = {
      title: 'notes',
      canIncludeSubfolders: true,
      async *scan(signal, options) {
        if ((runs += 1) > 1) {
          yield* fresh.source.scan(signal, options);
          return;
        }
        // Deaf to its signal
        yield {
          type: 'file',
          file: top,
          parent: 'notes',
          relativePath: 'top.md',
        };
        await released;
        yield {
          type: 'file',
          file: late,
          parent: 'notes',
          relativePath: 'late.md',
        };
      },
    };
    const modal = openModal(makePlugin().plugin, source);
    await settle();
    expect(outline(modal)).toEqual(['top']);

    await click(subfolderToggle(modal)!);
    release();
    await settle();

    expect(outline(modal)).toEqual([]);
    expect(trailingSpinner(modal)).toBe(true);
    expect(emptyState(modal)).toBeNull();
    await fresh.end();
    expect(emptyState(modal)).not.toBeNull();
    modal.close();
  });

  it('keeps a file unticked across the toggle', async () => {
    const { scan, modal, top } = await openDeeper();
    await click(rowBox(modal, 0));
    expect(selectedCount(modal)).toBe(0);

    await setToggle(modal, true);
    await scan.folder('notes/Topic');
    await scan.file(top);
    await scan.file('notes/Topic/a.md');

    expect(outline(modal)).toEqual(['Topic …', '  a', 'top']);
    expect(rowBox(modal, 0).checked).toBe(true);
    expect(rowBox(modal, 1).checked).toBe(false);
    expect(selectedCount(modal)).toBe(1);
    modal.close();
  });

  it('removes a subfolder with nothing to import once it and everything under it is scanned, never while some of it is still to come', async () => {
    const { scan, modal, top } = await openDeeper();
    await setToggle(modal, true);
    await scan.folder('notes/Empty');
    await scan.folder('notes/Kept');
    await scan.file(top);
    await scan.done('notes');

    await scan.folder('notes/Empty/Deeper');
    await scan.done('notes/Empty');
    // What is under it could still hold something
    expect(outline(modal)).toEqual(['Empty', '  Deeper …', 'Kept …', 'top']);

    await scan.file('notes/Kept/a.md');
    await scan.done('notes/Kept');
    await scan.done('notes/Empty/Deeper');
    expect(outline(modal)).toEqual(['Kept', '  a', 'top']);
    modal.close();
  });

  it('switched off, scans afresh without subfolders, dropping them from the list, the count and the import', async () => {
    const { plugin, importArticles } = makePlugin();
    const { scan, modal, top } = await openDeeper(plugin);
    await setToggle(modal, true);
    await scan.folder('notes/Topic');
    await scan.file(top);
    await scan.done('notes');
    await scan.file('notes/Topic/a.md');
    expect(selectedCount(modal)).toBe(2);

    await setToggle(modal, false);

    expect(scan.runs.map((run) => run.subfolders)).toEqual([
      false,
      true,
      false,
    ]);
    expect(scan.runs[1].signal.aborted).toBe(true);
    expect(outline(modal)).toEqual([]);
    expect(selectedCount(modal)).toBe(0);
    await scan.file(top);
    await scan.done('notes');
    await scan.end();
    expect(outline(modal)).toEqual(['top']);
    expect(selectedCount(modal)).toBe(1);

    await click(confirmButton(modal));
    await modal.closed;
    expect(importArticles).toHaveBeenCalledExactlyOnceWith(
      [{ file: top }],
      expect.anything()
    );
  });

  it('stops the scan once closed', async () => {
    const { scan, modal } = await openDeeper();
    await setToggle(modal, true);
    await scan.folder('notes/Topic');

    modal.close();
    await modal.closed;

    expect(scan.runs[1].signal.aborted).toBe(true);
  });

  it('says there is nothing to import only once the scan has ended, subfolders and all', async () => {
    const scan = makeSource('notes', { deeper: true });
    const modal = openModal(makePlugin().plugin, scan.source);
    await setToggle(modal, true);
    await scan.folder('notes/Empty');
    await scan.done('notes');
    expect(emptyState(modal)).toBeNull();

    await scan.done('notes/Empty');
    expect(outline(modal)).toEqual([]);
    expect(emptyState(modal)).toBeNull();

    await scan.end();
    expect(emptyState(modal)).not.toBeNull();
    modal.close();
  });

  it('stops every spinner and keeps the rows it has when the scan fails', async () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const file = makeFile('a.md', 'notes/Topic');
    const failure = new Error('gone');
    const source: CandidateSource = {
      title: 'notes',
      canIncludeSubfolders: true,
      async *scan(_signal, options) {
        if (!options?.subfolders) return;
        yield { type: 'folder', path: 'notes/Topic', parent: 'notes' };
        yield { type: 'folder', path: 'notes/Empty', parent: 'notes' };
        yield {
          type: 'file',
          file,
          parent: 'notes/Topic',
          relativePath: 'Topic/a.md',
        };
        throw failure;
      },
    };
    const modal = openModal(makePlugin().plugin, source);
    await settle();
    await setToggle(modal, true);
    await settle();

    expect(outline(modal)).toEqual(['Topic', '  a']);
    expect(spinner(modal)).toBeNull();
    expect(selectedCount(modal)).toBe(1);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    modal.close();
  });

  it('counts the ticked files of the whole tree, and imports exactly them, top to bottom', async () => {
    /** The folder's subfolders: how many files each holds, and its one subfolder. */
    const foldersArb = fc.array(
      fc.record({
        files: fc.integer({ min: 0, max: 2 }),
        deeper: fc.integer({ min: 0, max: 2 }),
      }),
      { maxLength: 3 }
    );
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 }),
        foldersArb,
        fc.array(fc.nat({ max: 12 }), { maxLength: 6 }),
        async (topCount, folders, clicks) => {
          document.body.replaceChildren();
          const { plugin, importArticles } = makePlugin();
          const scan = makeSource('notes', { deeper: true });
          const modal = openModal(plugin, scan.source);
          await setToggle(modal, true);
          // As a folder source reports: each folder's subfolders, its files,
          // it done; breadth-first
          for (const [i] of folders.entries()) {
            await scan.folder(`notes/d${i}`);
          }
          for (let i = 0; i < topCount; i++) {
            await scan.add(makeFile(`t${i}.md`));
          }
          await scan.done('notes');
          for (const [i, { files, deeper }] of folders.entries()) {
            if (deeper > 0) await scan.folder(`notes/d${i}/s`);
            for (let j = 0; j < files; j++) {
              await scan.file(`notes/d${i}/f${j}.md`);
            }
            await scan.done(`notes/d${i}`);
          }
          for (const [i, { deeper }] of folders.entries()) {
            if (deeper === 0) continue;
            for (let j = 0; j < deeper; j++) {
              await scan.file(`notes/d${i}/s/g${j}.md`);
            }
            await scan.done(`notes/d${i}/s`);
          }
          await scan.end();

          // Top to bottom: each subfolder's subfolder's files, then its own,
          // then the folder's own files
          const shown = [
            ...folders.flatMap(({ files, deeper }, i) => [
              ...Array.from(
                { length: deeper },
                (_, j) => `notes/d${i}/s/g${j}.md`
              ),
              ...Array.from(
                { length: files },
                (_, j) => `notes/d${i}/f${j}.md`
              ),
            ]),
            ...Array.from({ length: topCount }, (_, i) => `notes/t${i}.md`),
          ];
          const ticked = shown.map(() => true);
          for (const index of clicks.filter((i) => i < shown.length)) {
            await click(rowBox(modal, index));
            ticked[index] = !ticked[index];
          }
          const chosen = shown.filter((_, i) => ticked[i]);
          expect(selectedCount(modal)).toBe(chosen.length);

          await click(confirmButton(modal));
          await settle();

          if (chosen.length === 0) {
            expect(importArticles).not.toHaveBeenCalled();
          } else {
            expect(
              importArticles.mock.calls[0][0].map(({ file }) => file.path)
            ).toEqual(chosen);
          }
          modal.close();
        }
      ),
      { numRuns: 15 }
    );
    // Seconds alone; more under a full parallel run
  }, 30_000);

  /** Each folder row's checkbox, top to bottom. */
  const folderBoxes = (modal: BulkImportModal) => [
    ...modal.contentEl.querySelectorAll<HTMLInputElement>(
      '.ir-bulk-import-folder-title input[type="checkbox"]'
    ),
  ];

  /**
   * What a folder's checkbox shows. Partial is `indeterminate` and unchecked,
   * with the class its half fill is drawn for and never the attribute
   * Obsidian draws its dash for.
   */
  const boxState = (box: HTMLInputElement) => {
    expect(box.classList.contains('ir-partial')).toBe(box.indeterminate);
    expect(box.hasAttribute('data-indeterminate')).toBe(false);
    if (box.indeterminate) {
      expect(box.checked).toBe(false);
      return 'partial';
    }
    return box.checked ? 'checked' : 'unchecked';
  };

  const fileTicks = (modal: BulkImportModal) =>
    rows(modal).map((row) => row.querySelector('input')!.checked);

  /**
   * The tree `Topic (Sub (deep, deeper), a), Other (b), top`, all scanned:
   * file rows 0 to 4 are deep, deeper, a, b, top; folder boxes 0 to 2 are
   * Topic, Sub, Other.
   */
  async function openTree() {
    const { plugin, importArticles } = makePlugin();
    const { scan, modal, top } = await openDeeper(plugin);
    await setToggle(modal, true);
    await scan.folder('notes/Topic');
    await scan.folder('notes/Other');
    await scan.file(top);
    await scan.done('notes');
    await scan.folder('notes/Topic/Sub');
    await scan.file('notes/Topic/a.md');
    await scan.done('notes/Topic');
    await scan.file('notes/Other/b.md');
    await scan.done('notes/Other');
    await scan.file('notes/Topic/Sub/deep.md');
    await scan.file('notes/Topic/Sub/deeper.md');
    await scan.done('notes/Topic/Sub');
    await scan.end();
    return { scan, modal, importArticles };
  }

  it('shows each folder checked when all its files are ticked, unchecked when none are, partly filled otherwise', async () => {
    /** The file rows under each folder box. */
    const under = [[0, 1, 2], [0, 1], [3]];
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.nat({ max: 4 }), { maxLength: 5 }),
        async (unticked) => {
          document.body.replaceChildren();
          const { modal } = await openTree();
          expect(folderBoxes(modal).map(boxState)).toEqual([
            'checked',
            'checked',
            'checked',
          ]);
          for (const index of unticked) await click(rowBox(modal, index));

          const ticks = fileTicks(modal);
          expect(folderBoxes(modal).map(boxState)).toEqual(
            under.map((files) =>
              files.every((i) => ticks[i])
                ? 'checked'
                : files.some((i) => ticks[i])
                  ? 'partial'
                  : 'unchecked'
            )
          );
          expect(selectedCount(modal)).toBe(5 - unticked.length);
          modal.close();
        }
      ),
      { numRuns: 20 }
    );
    // Seconds alone; more under a full parallel run
  }, 30_000);

  it('unticks everything under a folder when it is unticked, leaving it out of the count and the import, and ticks it all again', async () => {
    const { modal, importArticles } = await openTree();

    await click(folderBoxes(modal)[0]);

    expect(fileTicks(modal)).toEqual([false, false, false, true, true]);
    expect(folderBoxes(modal).map(boxState)).toEqual([
      'unchecked',
      'unchecked',
      'checked',
    ]);
    expect(selectedCount(modal)).toBe(2);

    // The folder's name ticks it too, as a file's does
    const subName = modal.contentEl.querySelectorAll<HTMLElement>(
      '.ir-bulk-import-folder-title .ir-bulk-import-name'
    )[1];
    await click(subName);
    expect(fileTicks(modal)).toEqual([true, true, false, true, true]);
    expect(folderBoxes(modal).map(boxState)).toEqual([
      'partial',
      'checked',
      'checked',
    ]);

    await click(folderBoxes(modal)[1]);
    await click(confirmButton(modal));
    await settle();
    expect(
      importArticles.mock.calls[0][0].map(({ file }) => file.path)
    ).toEqual(['notes/Other/b.md', 'notes/top.md']);
  });

  it('ticks everything under a partly ticked folder when it is clicked', async () => {
    const { modal } = await openTree();
    await click(rowBox(modal, 0));
    await click(rowBox(modal, 3));
    expect(folderBoxes(modal).map(boxState)).toEqual([
      'partial',
      'partial',
      'unchecked',
    ]);

    await click(folderBoxes(modal)[0]);

    expect(fileTicks(modal)).toEqual([true, true, true, false, true]);
    expect(folderBoxes(modal).map(boxState)).toEqual([
      'checked',
      'checked',
      'unchecked',
    ]);
    expect(selectedCount(modal)).toBe(4);
    modal.close();
  });

  it('ticks a file found later as its folder is, judging a folder still being scanned by what it holds so far', async () => {
    const { scan, modal } = await openDeeper();
    await setToggle(modal, true);
    await scan.folder('notes/Topic');
    await scan.folder('notes/Other');
    await scan.folder('notes/Third');
    await scan.file('notes/top.md');
    await scan.done('notes');
    await scan.file('notes/Other/b.md');
    await scan.file('notes/Other/c.md');
    await scan.file('notes/Third/e.md');
    // Topic holds nothing yet; Other is partly ticked; Third is unticked
    await click(folderBoxes(modal)[0]);
    await click(rowBox(modal, 0));
    await click(rowBox(modal, 2));
    expect(folderBoxes(modal).map(boxState)).toEqual([
      'unchecked',
      'partial',
      'unchecked',
    ]);

    await scan.folder('notes/Topic/Sub');
    await scan.file('notes/Topic/a.md');
    await scan.file('notes/Other/d.md');
    await scan.file('notes/Third/f.md');
    await scan.file('notes/Topic/Sub/deep.md');

    expect(outline(modal)).toEqual([
      'Topic …',
      '  Sub …',
      '    deep',
      '  a',
      'Other …',
      '  b',
      '  c',
      '  d',
      'Third …',
      '  e',
      '  f',
      'top',
    ]);
    expect(fileTicks(modal)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
    expect(folderBoxes(modal).map(boxState)).toEqual([
      'unchecked',
      'unchecked',
      'partial',
      'unchecked',
    ]);
    expect(selectedCount(modal)).toBe(3);
    modal.close();
  });

  /**
   * Each shown folder's arrow, top to bottom: classed as Obsidian's own, which
   * its app.css draws and turns.
   */
  const arrows = (modal: BulkImportModal) => [
    ...modal.contentEl.querySelectorAll<HTMLButtonElement>(
      '.ir-bulk-import-folder-title > button.ir-bulk-import-collapse.collapse-icon'
    ),
  ];

  /** The arrow named for the folder `name`, as a screen reader names it. */
  const arrowOf = (modal: BulkImportModal, name: string) => {
    const found = arrows(modal).find(
      (arrow) =>
        document.getElementById(arrow.getAttribute('aria-labelledby')!)
          ?.textContent === name
    );
    if (!found) throw new Error(`no arrow for ${name}`);
    return found;
  };

  /** Whether the arrow says its folder is expanded, drawn turned that way. */
  const isExpanded = (arrow: HTMLButtonElement) => {
    const expanded = arrow.getAttribute('aria-expanded') === 'true';
    expect(arrow.getAttribute('aria-expanded')).toBe(String(expanded));
    expect(arrow.classList.contains('is-collapsed')).toBe(!expanded);
    return expanded;
  };

  /** Whether the folder `name` shows its spinner. */
  const spins = (modal: BulkImportModal, name: string) =>
    arrowOf(modal, name).parentElement!.querySelector('.ir-loading') !== null;

  const shownNames = (modal: BulkImportModal) => rows(modal).map(nameOf);

  const folderNames = (modal: BulkImportModal) =>
    [
      ...modal.contentEl.querySelectorAll(
        '.ir-bulk-import-folder-title .ir-bulk-import-name'
      ),
    ].map((name) => name.textContent);

  it('hides everything under a collapsed folder and shows it again once expanded, the ticks, the count and the import as they were', async () => {
    const { modal, importArticles } = await openTree();
    // Every folder starts expanded
    expect(arrows(modal).map(isExpanded)).toEqual([true, true, true]);
    await click(rowBox(modal, 0));

    await click(arrowOf(modal, 'Topic'));

    expect(isExpanded(arrowOf(modal, 'Topic'))).toBe(false);
    expect(shownNames(modal)).toEqual(['b', 'top']);
    expect(folderNames(modal)).toEqual(['Topic', 'Other']);
    // Its box still shows what is ticked under it
    expect(folderBoxes(modal).map(boxState)).toEqual(['partial', 'checked']);
    expect(selectedCount(modal)).toBe(4);

    await click(arrowOf(modal, 'Other'));
    await click(arrowOf(modal, 'Topic'));

    expect(shownNames(modal)).toEqual(['deep', 'deeper', 'a', 'top']);
    expect(fileTicks(modal)).toEqual([false, true, true, true]);
    expect(arrows(modal).map(isExpanded)).toEqual([true, true, false]);
    expect(selectedCount(modal)).toBe(4);

    // A folder collapsed inside a collapsed one stays so once that expands
    await click(arrowOf(modal, 'Sub'));
    await click(arrowOf(modal, 'Topic'));
    await click(arrowOf(modal, 'Topic'));

    expect(shownNames(modal)).toEqual(['a', 'top']);
    expect(arrows(modal).map(isExpanded)).toEqual([true, false, false]);

    await click(confirmButton(modal));
    await settle();
    expect(
      importArticles.mock.calls[0][0].map(({ file }) => file.path)
    ).toEqual([
      'notes/Topic/Sub/deeper.md',
      'notes/Topic/a.md',
      'notes/Other/b.md',
      'notes/top.md',
    ]);
  });

  it('shows only the rows outside collapsed folders, whatever is collapsed, counting and importing the ticked ones all the same', async () => {
    /** The folder's subfolders: how many files each holds, and its one subfolder. */
    const foldersArb = fc.array(
      fc.record({
        files: fc.integer({ min: 0, max: 2 }),
        deeper: fc.integer({ min: 0, max: 2 }),
      }),
      { maxLength: 3 }
    );
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 }),
        foldersArb,
        fc.array(fc.nat({ max: 12 }), { maxLength: 4 }),
        fc.array(fc.nat({ max: 12 }), { maxLength: 6 }),
        async (topCount, folders, tickClicks, arrowClicks) => {
          document.body.replaceChildren();
          const { plugin, importArticles } = makePlugin();
          const scan = makeSource('notes', { deeper: true });
          const modal = openModal(plugin, scan.source);
          await setToggle(modal, true);
          for (const [i] of folders.entries()) {
            await scan.folder(`notes/d${i}`);
          }
          for (let i = 0; i < topCount; i++) {
            await scan.add(makeFile(`t${i}.md`));
          }
          await scan.done('notes');
          for (const [i, { files, deeper }] of folders.entries()) {
            if (deeper > 0) await scan.folder(`notes/d${i}/s`);
            for (let j = 0; j < files; j++) {
              await scan.file(`notes/d${i}/f${i}_${j}.md`);
            }
            await scan.done(`notes/d${i}`);
          }
          for (const [i, { deeper }] of folders.entries()) {
            for (let j = 0; j < deeper; j++) {
              await scan.file(`notes/d${i}/s/g${i}_${j}.md`);
            }
            if (deeper > 0) await scan.done(`notes/d${i}/s`);
          }
          await scan.end();

          // Each folder's files by name, its subfolder's first; a folder
          // holding nothing is left out
          const tree = folders
            .map(({ files, deeper }, i) => ({
              path: `d${i}`,
              sub: Array.from({ length: deeper }, (_, j) => `g${i}_${j}`),
              own: Array.from({ length: files }, (_, j) => `f${i}_${j}`),
            }))
            .filter(({ sub, own }) => sub.length + own.length > 0);
          const tops = Array.from({ length: topCount }, (_, i) => `t${i}`);
          const all = [
            ...tree.flatMap(({ sub, own }) => [...sub, ...own]),
            ...tops,
          ];
          const ticked = new Set(all);
          for (const index of tickClicks.filter((i) => i < all.length)) {
            await click(rowBox(modal, index));
            if (!ticked.delete(all[index])) ticked.add(all[index]);
          }

          const collapsed = new Set<string>();
          const shownFolders = () =>
            tree.flatMap(({ path, sub }) => [
              path,
              ...(sub.length > 0 && !collapsed.has(path) ? [`${path}/s`] : []),
            ]);
          for (const n of arrowClicks) {
            const shown = shownFolders();
            expect(arrows(modal)).toHaveLength(shown.length);
            if (shown.length === 0) break;
            await click(arrows(modal)[n % shown.length]);
            const path = shown[n % shown.length];
            if (!collapsed.delete(path)) collapsed.add(path);
          }

          expect(arrows(modal).map(isExpanded)).toEqual(
            shownFolders().map((path) => !collapsed.has(path))
          );
          expect(shownNames(modal)).toEqual([
            ...tree.flatMap(({ path, sub, own }) =>
              collapsed.has(path)
                ? []
                : [...(collapsed.has(`${path}/s`) ? [] : sub), ...own]
            ),
            ...tops,
          ]);
          const chosen = all.filter((name) => ticked.has(name));
          expect(selectedCount(modal)).toBe(chosen.length);

          await click(confirmButton(modal));
          await settle();

          if (chosen.length === 0) {
            expect(importArticles).not.toHaveBeenCalled();
          } else {
            expect(
              importArticles.mock.calls[0][0].map(({ file }) => file.basename)
            ).toEqual(chosen);
          }
          modal.close();
        }
      ),
      { numRuns: 15 }
    );
  }, 30_000);

  it('keeps the files found under a collapsed folder hidden, yet counts and imports them, its spinner showing while anything under it is being scanned', async () => {
    const { plugin, importArticles } = makePlugin();
    const { scan, modal, top } = await openDeeper(plugin);
    await setToggle(modal, true);
    await scan.folder('notes/Topic');
    await scan.file(top);
    await scan.done('notes');

    await click(arrowOf(modal, 'Topic'));
    expect(spins(modal, 'Topic')).toBe(true);
    await scan.folder('notes/Topic/Sub');
    await scan.file('notes/Topic/a.md');
    await scan.done('notes/Topic');

    expect(shownNames(modal)).toEqual(['top']);
    expect(selectedCount(modal)).toBe(2);
    // Done itself, but not the folder under it
    expect(spins(modal, 'Topic')).toBe(true);

    // Expanded, the spinner is the subfolder's alone
    await click(arrowOf(modal, 'Topic'));
    expect(spins(modal, 'Topic')).toBe(false);
    expect(spins(modal, 'Sub')).toBe(true);

    await click(arrowOf(modal, 'Topic'));
    await scan.file('notes/Topic/Sub/deep.md');
    await scan.done('notes/Topic/Sub');
    await scan.end();

    expect(spins(modal, 'Topic')).toBe(false);
    expect(shownNames(modal)).toEqual(['top']);
    expect(selectedCount(modal)).toBe(3);
    await click(confirmButton(modal));
    await settle();
    expect(
      importArticles.mock.calls[0][0].map(({ file }) => file.path)
    ).toEqual(['notes/Topic/Sub/deep.md', 'notes/Topic/a.md', 'notes/top.md']);
  });

  it('collapses on the arrow alone, a button apart from the checkbox: neither changes the other', async () => {
    const { modal } = await openTree();
    const arrow = arrowOf(modal, 'Topic');
    // Reachable with Tab, and pressed with Enter or Space, as a button is
    expect(arrow.tagName).toBe('BUTTON');
    expect(arrow.disabled).toBe(false);
    expect(arrow.tabIndex).toBe(0);
    expect(arrow.closest('label')).toBeNull();
    // Obsidian's own arrow icon, the Files view's
    const icon = arrow.querySelector('svg.svg-icon');
    expect([...(icon?.classList ?? [])]).toContainEqual(
      expect.stringMatching(/right-triangle$/)
    );

    await click(arrow);

    expect(isExpanded(arrowOf(modal, 'Topic'))).toBe(false);
    expect(folderBoxes(modal).map(boxState)).toEqual(['checked', 'checked']);
    expect(selectedCount(modal)).toBe(5);

    await click(folderBoxes(modal)[0]);

    expect(isExpanded(arrowOf(modal, 'Topic'))).toBe(false);
    expect(folderBoxes(modal).map(boxState)).toEqual(['unchecked', 'checked']);
    expect(selectedCount(modal)).toBe(2);

    // Nor does its name, which ticks it as its box does
    const topicName = modal.contentEl.querySelector<HTMLElement>(
      '.ir-bulk-import-folder-title .ir-bulk-import-name'
    )!;
    await click(topicName);

    expect(isExpanded(arrowOf(modal, 'Topic'))).toBe(false);
    expect(selectedCount(modal)).toBe(5);

    await click(arrowOf(modal, 'Topic'));

    expect(isExpanded(arrowOf(modal, 'Topic'))).toBe(true);
    expect(folderBoxes(modal).map(boxState)).toEqual([
      'checked',
      'checked',
      'checked',
    ]);
    expect(selectedCount(modal)).toBe(5);
  });

  it('names each arrow for its own folder, whatever ids another Preact root on the page hands out', async () => {
    // Another root, say another plugin's, naming its own elements by useId
    function Other() {
      return <span id={useId()} />;
    }
    const other = document.body.createDiv();
    render(
      <>
        <Other />
        <Other />
        <Other />
      </>,
      other
    );

    const { modal } = await openTree();

    for (const arrow of arrows(modal)) {
      const name = document.getElementById(
        arrow.getAttribute('aria-labelledby')!
      );
      expect(name?.closest('.ir-bulk-import-folder-title')).toBe(
        arrow.parentElement
      );
    }
    render(null, other);
  });
});

describe('BulkImportModal: remembering Include subfolders', () => {
  it('opens on and already scanning subfolders when last left on', async () => {
    const { plugin, saveUiState } = makePlugin(undefined, {
      includeSubfolders: true,
    });
    const scan = makeSource('notes', { deeper: true });
    const modal = openModal(plugin, scan.source);

    expect(subfolderToggle(modal)?.checked).toBe(true);
    expect(
      subfolderToggle(modal)?.closest('.checkbox-container')?.classList
    ).toContain('is-enabled');
    expect(scan.runs.map((run) => run.subfolders)).toEqual([true]);
    await scan.folder('notes/Topic');
    await scan.file('notes/Topic/deep.md');
    await scan.done('notes/Topic');
    await scan.done('notes');
    await scan.end();
    expect(outline(modal)).toEqual(['Topic', '  deep']);
    // Opening is no change to remember
    expect(saveUiState).not.toHaveBeenCalled();
    modal.close();
  });

  it('opens off, scanning the top level alone, when last left off', async () => {
    const { plugin } = makePlugin(undefined, { includeSubfolders: false });
    const scan = makeSource('notes', { deeper: true });
    const modal = openModal(plugin, scan.source);
    await scan.end();

    expect(subfolderToggle(modal)?.checked).toBe(false);
    expect(scan.runs.map((run) => run.subfolders)).toEqual([false]);
    modal.close();
  });

  it('scans no subfolder of a source that cannot go deeper, whatever was last left', () => {
    fc.assert(
      fc.property(fc.boolean(), (includeSubfolders) => {
        const scan = makeSource();
        const modal = openModal(
          makePlugin(undefined, { includeSubfolders }).plugin,
          scan.source
        );

        expect(subfolderToggle(modal)).toBeNull();
        expect(scan.runs.map((run) => run.subfolders)).toEqual([false]);
        modal.close();
      })
    );
  });

  it('remembers each switch as it is made, and the next dialog opens the way the last was left', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.integer({ min: 1, max: 4 }),
        async (startOn, clicks) => {
          const { plugin, saveUiState } = makePlugin(undefined, {
            includeSubfolders: startOn,
          });
          const scan = makeSource('notes', { deeper: true });
          const modal = openModal(plugin, scan.source);
          let on = startOn;
          const saved: boolean[] = [];
          for (let i = 0; i < clicks; i++) {
            await click(subfolderToggle(modal)!);
            on = !on;
            saved.push(on);
            expect(saveUiState).toHaveBeenLastCalledWith({
              folderImportIncludeSubfolders: on,
            });
          }
          expect(saveUiState.mock.calls.map(([change]) => change)).toEqual(
            saved.map((value) => ({ folderImportIncludeSubfolders: value }))
          );
          modal.close();

          const next = makeSource('notes', { deeper: true });
          const reopened = openModal(plugin, next.source);
          expect(subfolderToggle(reopened)?.checked).toBe(on);
          expect(next.runs.map((run) => run.subfolders)).toEqual([on]);
          reopened.close();
        }
      ),
      { numRuns: 20 }
    );
  });
});

describe('BulkImportModal on a Files-view selection', () => {
  /**
   * A vault of notes: `sources` with two notes and a subfolder, `testing`
   * and `papers` each with a note and a subfolder, and the source of a dialog
   * on a selection of the two notes in `sources`, `testing`, a note in
   * `testing`, and `papers`.
   */
  function selectionDialog() {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to fetch')
    );
    const folder = (path: string, parent: TFolder | null) =>
      Object.assign(new TFolder(), {
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        parent,
      });
    const note = (name: string, parent: TFolder) => {
      const file = Object.assign(makeFile(name, parent.path), { parent });
      parent.children.push(file);
      return file;
    };
    const root = folder('/', null);
    const sources = folder('sources', root);
    const testing = folder('testing', root);
    const sourcesDeep = folder('sources/deep', sources);
    const testingDeep = folder('testing/deep', testing);
    const papers = folder('papers', root);
    const papersOld = folder('papers/old', papers);
    sources.children.push(sourcesDeep);
    testing.children.push(testingDeep);
    papers.children.push(papersOld);
    const one = note('one.md', sources);
    const two = note('two.md', sources);
    note('hidden.md', sourcesDeep);
    const kept = note('kept.md', testing);
    note('below.md', testingDeep);
    note('p.md', papers);
    note('older.md', papersOld);
    const checks: CandidateChecks = {
      app: {
        vault: {
          readBinary: async () => new TextEncoder().encode('# Note').buffer,
          getResourcePath: (file: TFile) => file.path,
        },
        metadataCache: { getFileCache: () => null },
      } as never,
      isItemAtPath: () => false,
    };
    const source = selectionSource(
      [two, one, testing, kept, papers],
      checks,
      explorerComparator('alphabetical')
    );
    return { source };
  }

  async function openOnSelection(includeSubfolders = false) {
    const { plugin, importArticles } = makePlugin(
      DEFAULT_SETTINGS.copyOnImport,
      { includeSubfolders }
    );
    const modal = openModal(plugin, selectionDialog().source);
    await settle();
    return { modal, importArticles };
  }

  it('is titled with how many items were selected, one a selected folder holds not counted', async () => {
    const { modal } = await openOnSelection();

    expect(modal.titleEl.textContent).toMatch(/\b4\b/);
    modal.close();
  });

  it('lists each selected folder as a folder, then the selected files, and imports exactly the ticked rows', async () => {
    const { modal, importArticles } = await openOnSelection();

    expect(outline(modal)).toEqual([
      'papers',
      '  p',
      'testing',
      '  kept',
      'one',
      'two',
    ]);
    // The fourth file row: `two`
    await click(rowBox(modal, 3));
    expect(selectedCount(modal)).toBe(3);
    await click(confirmButton(modal));
    await settle();

    expect(
      importArticles.mock.calls[0][0].map(({ file }) => file.path)
    ).toEqual(['papers/p.md', 'testing/kept.md', 'sources/one.md']);
  });

  it('takes every selected folder deeper with Include subfolders, and back', async () => {
    const { modal } = await openOnSelection();

    await click(subfolderToggle(modal)!);
    await settle();
    expect(outline(modal)).toEqual([
      'papers',
      '  old',
      '    older',
      '  p',
      'testing',
      '  deep',
      '    below',
      '  kept',
      'one',
      'two',
    ]);
    await click(subfolderToggle(modal)!);
    await settle();
    expect(outline(modal)).toEqual([
      'papers',
      '  p',
      'testing',
      '  kept',
      'one',
      'two',
    ]);
    modal.close();
  });

  it('opens deeper when Include subfolders was last left on', async () => {
    const { modal } = await openOnSelection(true);

    expect(subfolderToggle(modal)?.checked).toBe(true);
    expect(outline(modal)).toEqual(
      expect.arrayContaining(['    older', '    below'])
    );
    modal.close();
  });
});

describe('BulkImportModal: filter bar', () => {
  /**
   * A plugin whose vault holds the folder `notes`, whose source is `scan`'s,
   * made by `bulkImportSources` as the plugin's is.
   */
  function makeFilterPlugin(
    scan: ReturnType<typeof makeSource>,
    {
      includeSubfolders = false,
      copyOnImport = false,
      cli = undefined as unknown,
      explorers = [] as unknown[],
      files = [] as TFile[],
    } = {}
  ) {
    const made = makePlugin(copyOnImport, { includeSubfolders });
    const notes = Object.assign(new TFolder(), {
      path: 'notes',
      name: 'notes',
    });
    const folder = vi.fn((_folder: TFolder) => scan.source);
    const tag = vi.fn((_tags: readonly string[]) => scan.source);
    const search = vi.fn((_files: readonly TFile[]) => scan.source);
    const bulkImportSources = vi.fn(() => ({ folder, tag, search }));
    Object.assign(made.plugin, {
      app: {
        vault: {
          getAllFolders: () => [notes],
          getFileByPath: (path: string) =>
            files.find((file) => file.path === path) ?? null,
        },
        workspace: {
          getLeavesOfType: (type: string) =>
            type === 'file-explorer' ? explorers : [],
        },
        cli,
      },
      bulkImportSources,
    });
    return { ...made, notes, folder, tag, search, bulkImportSources };
  }

  /** Core's `search` command, answering `paths` for any query. */
  function makeCli(paths: readonly string[]) {
    const handler = vi.fn(() => Promise.resolve(JSON.stringify(paths)));
    return { handlers: new Map([['search', { handler }]]) };
  }

  function segments(modal: BulkImportModal) {
    return [
      ...modal.contentEl.querySelectorAll<HTMLButtonElement>(
        '.ir-bulk-import-filter-segment'
      ),
    ];
  }

  function searchInput(modal: BulkImportModal) {
    return modal.contentEl.querySelector<HTMLInputElement>(
      '.ir-bulk-import-search-input'
    );
  }

  function openFiltered(plugin: IncrementalReadingPlugin) {
    const modal = new BulkImportModal(plugin, {
      mode: 'import',
      filterBar: true,
    });
    vi.spyOn(modal, 'close').mockImplementation(() => modal.onClose());
    document.body.append(modal.contentEl);
    void act(() => modal.onOpen());
    return modal;
  }

  async function chooseNotes(modal: BulkImportModal) {
    const input = modal.contentEl.querySelector<HTMLInputElement>(
      '.ir-bulk-import-filter-row input[type="text"]'
    )!;
    input.focus();
    input.value = 'no';
    input.dispatchEvent(new Event('input'));
    await settle();
    await click(document.querySelector<HTMLElement>('.suggestion-item')!);
    await settle();
  }

  function filterToggle(modal: BulkImportModal) {
    return modal.contentEl.querySelector<HTMLInputElement>(
      '.ir-bulk-import-filter-row .ir-bulk-import-subfolders input'
    );
  }

  it('offers the search filter, after the folder and tag filters, only while the search engine can be reached', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (reachable) => {
        const scan = makeSource('search');
        const { plugin } = makeFilterPlugin(scan, {
          cli: reachable ? makeCli([]) : undefined,
        });
        const modal = openFiltered(plugin);
        await settle();

        expect(segments(modal)).toHaveLength(reachable ? 3 : 2);
        if (reachable) {
          await click(segments(modal)[2]);
          expect(searchInput(modal)).not.toBeNull();
        }
        expect(searchInput(modal) !== null).toBe(reachable);
        modal.close();
        document.body.replaceChildren();
      }),
      { numRuns: 4 }
    );
  });

  it('lists what a search matched, as the source the plugin makes of it, and says it imported them from search', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      Notice.reset();
      const file = makeFile('a.md');
      const scan = makeSource('search');
      const { plugin, search } = makeFilterPlugin(scan, {
        cli: makeCli([file.path]),
        files: [file],
      });
      const modal = openFiltered(plugin);
      await click(segments(modal)[2]);
      const input = searchInput(modal)!;
      input.value = 'spaced';
      await act(() => {
        input.dispatchEvent(new Event('input'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(search).toHaveBeenCalledExactlyOnceWith([file]);
      vi.useRealTimers();
      await scan.add(file);
      await click(confirmButton(modal));
      await modal.closed;

      expect(Notice.messages).toEqual([expect.stringMatching(/\bsearch\b/)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds the search filter once a file explorer not loaded yet is, and draws nothing once closed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (closeFirst) => {
        class Query {
          matcher = {};
          match() {
            return null;
          }
        }
        let loaded!: () => void;
        const leaf = {
          view: {} as object,
          isDeferred: true,
          loadIfDeferred: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                loaded = () => {
                  leaf.view = {
                    onSearchChanged(this: { searchQuery: unknown }) {
                      this.searchQuery = new Query();
                    },
                  };
                  leaf.isDeferred = false;
                  resolve();
                };
              })
          ),
        };
        const scan = makeSource('search');
        const { plugin } = makeFilterPlugin(scan, { explorers: [leaf] });
        Object.assign(plugin.app, {
          metadataCache: {
            isUserIgnored: () => false,
            isSupportedFile: () => true,
          },
        });
        const modal = openFiltered(plugin);
        await settle();
        expect(segments(modal)).toHaveLength(2);
        if (closeFirst) modal.close();

        loaded();
        await settle();

        expect(leaf.loadIfDeferred).toHaveBeenCalledOnce();
        expect(segments(modal)).toHaveLength(closeFirst ? 0 : 3);
        modal.close();
        document.body.replaceChildren();
      }),
      { numRuns: 2 }
    );
  });

  it('lists nothing until a folder is picked, then the files the source made for it finds', async () => {
    const scan = makeSource('notes', { deeper: true });
    const { plugin, notes, folder, bulkImportSources } = makeFilterPlugin(scan);
    const modal = openFiltered(plugin);

    expect(rows(modal)).toEqual([]);
    expect(
      modal.contentEl.querySelector('.ir-bulk-import-prompt')
    ).not.toBeNull();
    expect(scan.runs).toEqual([]);
    // The explorer's order, read as the dialog opens
    expect(bulkImportSources).toHaveBeenCalledOnce();

    await chooseNotes(modal);
    await scan.add(makeFile('a.md'));

    expect(folder).toHaveBeenCalledExactlyOnceWith(notes);
    expect(rows(modal).map(nameOf)).toEqual(['a']);
    expect(bulkImportSources).toHaveBeenCalledOnce();
    modal.close();
  });

  it('imports the ticked files with the default options, saying it imported them from the folder picked', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (copyOnImport) => {
        Notice.reset();
        const scan = makeSource('Reading', { deeper: true });
        const { plugin, importArticles } = makeFilterPlugin(scan, {
          copyOnImport,
        });
        const modal = openFiltered(plugin);
        await chooseNotes(modal);
        const file = makeFile('a.md');
        await scan.add(file);

        await click(confirmButton(modal));
        await modal.closed;

        expect(importArticles).toHaveBeenCalledExactlyOnceWith([{ file }], {
          priority: plugin.settings.defaultPriority,
          fixedIntervalDays: null,
          makeCopy: copyOnImport,
        });
        expect(Notice.messages).toEqual([
          expect.stringMatching(/\b1\b.*Reading/),
        ]);
        document.body.replaceChildren();
      }),
      { numRuns: 4 }
    );
  });

  it('imports nothing when cancelled', async () => {
    const scan = makeSource('notes', { deeper: true });
    const { plugin, importArticles } = makeFilterPlugin(scan);
    const modal = openFiltered(plugin);
    // Spied on already: this hands back that spy
    const close = vi.spyOn(modal, 'close');
    await chooseNotes(modal);
    await scan.add(makeFile('a.md'));

    await click(button(modal, /^Cancel$/));
    await modal.closed;

    expect(close).toHaveBeenCalledOnce();
    expect(scan.signal()?.aborted).toBe(true);
    expect(importArticles).not.toHaveBeenCalled();
  });

  it('opens Include subfolders as last left, remembering each switch', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (startOn) => {
        const scan = makeSource('notes', { deeper: true });
        const { plugin, saveUiState } = makeFilterPlugin(scan, {
          includeSubfolders: startOn,
        });
        const modal = openFiltered(plugin);
        expect(filterToggle(modal)?.checked).toBe(startOn);

        await click(filterToggle(modal)!);

        expect(saveUiState).toHaveBeenCalledExactlyOnceWith({
          folderImportIncludeSubfolders: !startOn,
        });
        modal.close();
        document.body.replaceChildren();
      }),
      { numRuns: 4 }
    );
  });

  /** Press the filter bar's segment for tags. */
  async function pressTag(modal: BulkImportModal) {
    const segment = [
      ...modal.contentEl.querySelectorAll<HTMLButtonElement>(
        '.ir-bulk-import-filter-segment'
      ),
    ][1];
    await click(segment);
    await settle();
  }

  it('offers the tags filter second, holding the trigger tags when auto-import by tag is on, and listing them at once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.uniqueArray(fc.constantFrom('to-read', 'later', 'a/b'), {
          minLength: 1,
          maxLength: 2,
        }),
        async (on, triggerTags) => {
          const scan = makeSource('#tags');
          const { plugin, tag } = makeFilterPlugin(scan);
          plugin.settings.autoImportOnTag = on;
          plugin.settings.autoImportTags = triggerTags;
          const modal = openFiltered(plugin);

          await pressTag(modal);

          const input = modal.contentEl.querySelector<HTMLInputElement>(
            '.ir-bulk-import-filter-row input[type="text"]'
          )!;
          if (on) {
            expect(input.value).toBe(
              triggerTags.map((t) => `#${t}`).join(', ')
            );
            expect(tag).toHaveBeenCalledExactlyOnceWith(triggerTags);
          } else {
            expect(input.value).toBe('');
            expect(tag).not.toHaveBeenCalled();
          }
          modal.close();
          document.body.replaceChildren();
        }
      ),
      { numRuns: 6 }
    );
  });

  it('imports the ticked notes a tag lists, saying it imported them from the tags', async () => {
    Notice.reset();
    const scan = makeSource('#to-read, #later');
    const { plugin, importArticles } = makeFilterPlugin(scan);
    plugin.settings.autoImportOnTag = true;
    plugin.settings.autoImportTags = ['to-read', 'later'];
    const modal = openFiltered(plugin);
    await pressTag(modal);
    const file = makeFile('a.md');
    await scan.add(file);

    await click(confirmButton(modal));
    await modal.closed;

    expect(importArticles).toHaveBeenCalledExactlyOnceWith(
      [{ file }],
      expect.anything()
    );
    expect(Notice.messages).toEqual([
      expect.stringMatching(/\b1\b.*#to-read, #later/),
    ]);
  });
});
