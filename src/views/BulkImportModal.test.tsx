// @vitest-environment jsdom
import type {
  BulkImportOptions,
  BulkOutcome,
  CandidateSource,
  ScanEvent,
} from '#/lib/bulk-import/types';
import { MINIMUM_FIXED_REVIEW_INTERVAL } from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type IncrementalReadingPlugin from '#/main';
// The mock the vitest config aliases `obsidian` to, imported by path so its
// recorded notices are visible to the type checker
import { Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import { TFile } from 'obsidian';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkImportModal } from './BulkImportModal';

// #region HELPERS
function makePlugin(copyOnImport = DEFAULT_SETTINGS.copyOnImport) {
  const importArticles = vi.fn(
    async (
      entries: { file: TFile }[],
      _options: BulkImportOptions
    ): Promise<BulkOutcome[]> =>
      entries.map(({ file }) => ({ file, status: 'imported' }))
  );
  const plugin = {
    app: {},
    settings: { ...DEFAULT_SETTINGS, copyOnImport },
    reviewManager: { importArticles },
  } as unknown as IncrementalReadingPlugin;
  return { plugin, importArticles };
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
 * ends when told to.
 */
function makeSource(title = 'notes') {
  const pending: (ScanEvent | 'end')[] = [];
  let wake: (() => void) | null = null;
  let signal: AbortSignal | null = null;
  const source: CandidateSource = {
    title,
    async *scan(given) {
      signal = given;
      for (;;) {
        while (pending.length === 0) {
          await new Promise<void>((resolve) => (wake = resolve));
        }
        const next = pending.shift()!;
        if (next === 'end') return;
        yield next;
      }
    },
  };
  const send = async (next: ScanEvent | 'end') => {
    pending.push(next);
    wake?.();
    wake = null;
    await settle();
  };
  return {
    source,
    /** Yield `file` as a row, `relativePath` from where the source starts. */
    add: (file: TFile, relativePath = file.name) =>
      send({ type: 'file', file, parent: 'notes', relativePath }),
    end: () => send('end'),
    /** Yield `event` as it is. */
    send,
    signal: () => signal,
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
      expect(rows(modal).map((row) => row.textContent)).toEqual(
        names.slice(0, i + 1)
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
    modal.close();
  });

  it('shows a deeper file by its name and its path from where the source starts', async () => {
    const scan = makeSource();
    const modal = openModal(makePlugin().plugin, scan.source);
    const deep = makeFile('a.md', 'notes/sub');

    await scan.add(deep, 'sub/a.md');

    const row = rows(modal)[0];
    expect(row.querySelector('.ir-bulk-import-name')?.textContent).toBe('a.md');
    expect(row.querySelector('.ir-bulk-import-path')?.textContent).toBe(
      'sub/a.md'
    );
    modal.close();
  });

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

  it('lists files only, whatever else the scan reports', async () => {
    // Folders are for the tree the subfolder scan fills in
    const scan = makeSource();
    const modal = openModal(makePlugin().plugin, scan.source);

    await scan.send({ type: 'folder', path: 'notes/sub', parent: 'notes' });
    await scan.send({ type: 'folder-done', path: 'notes/sub' });
    await scan.add(makeFile('a.md'));

    expect(rows(modal).map((row) => row.textContent)).toEqual(['a.md']);
    expect(selectedCount(modal)).toBe(1);
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
