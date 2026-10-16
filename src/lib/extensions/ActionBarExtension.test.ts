// @vitest-environment jsdom
import { DISMISS_ICON_STROKE, PLUGIN_ICON } from '#/lib/constants';
import { configureSuccessNotices } from '#/lib/notices';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { registerPluginIcon } from '#/lib/plugin-icon';
import type {
  DataChangeEvent,
  DataChangeListener,
  IArticleBase,
  ReviewItem,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import { Notice, removeIcon } from '#/test/__mocks__/obsidian';
import {
  showSuccessNotices,
  SUCCESS_NOTICE_LEVELS,
} from '#/test/success-notices';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import { type MarkdownFileInfo, type TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actionBarExtension,
  renderStandaloneActionBarDOM,
  setReviewCallbacks,
  setReviewModeEffect,
  setShowAnswerEffect,
} from './ActionBarExtension';
import { irPluginFacet } from './irPluginFacet';

// #region HELPERS

/**
 * Obsidian adds these to `HTMLElement` at runtime and jsdom has neither. The
 * panel path calls both, so this file installs them for itself rather than in
 * the shared setup, where they would silently change every other suite.
 */
function installObsidianElementExtensions() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.empty = function empty(this: HTMLElement) {
    this.replaceChildren();
  };
  proto.hasClass = function hasClass(this: HTMLElement, cls: string) {
    return this.classList.contains(cls);
  };
}
installObsidianElementExtensions();

/** A row as the standalone bar reads it: only `id` and `dismissed` are used. */
function makeItem(overrides: {
  id?: string;
  dismissed?: boolean;
  file?: TFile;
}): ReviewItem {
  const file = overrides.file ?? makeFile();
  return {
    data: {
      id: overrides.id ?? 'item-1',
      type: 'article',
      dismissed: overrides.dismissed ?? false,
      priority: 50,
      reference: file.path,
    } as IArticleBase,
    file,
  };
}

function makeFile(path = 'notes/article.md'): TFile {
  return { path, basename: path.split('/').pop() } as TFile;
}

/**
 * A plugin whose `reviewManager` reads one mutable row, so a test can change
 * the stored state the way another surface would and then emit the repository
 * change event that write would have produced.
 */
function makeHarness(
  options: {
    item?: ReviewItem | null;
    lookupRejects?: boolean;
  } = {}
) {
  const listeners = new Set<DataChangeListener>();
  let row: ReviewItem | null =
    options.item === undefined ? makeItem({}) : options.item;

  const getReviewItemFromFile = vi.fn(async (): Promise<ReviewItem | null> => {
    if (options.lookupRejects) throw new Error('db unavailable');
    return row;
  });

  const reviewManager = {
    getReviewItemFromFile,
    dismissItem: vi.fn(async (item: ReviewItem) => {
      setStored(item.data.id, true);
    }),
    unDismissItem: vi.fn(async (item: ReviewItem) => {
      setStored(item.data.id, false);
    }),
    repo: {
      onDataChange: vi.fn((listener: DataChangeListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
  };

  /** Write `dismissed` straight to the row, as any other surface would. */
  function setStored(id: string, dismissed: boolean) {
    if (row && row.data.id === id) row.data.dismissed = dismissed;
  }

  /** Fire the change event the repository emits after such a write. */
  function emit(event: Partial<DataChangeEvent> & { ids: string[] }) {
    const full: DataChangeEvent = {
      table: event.table ?? 'article',
      op: event.op ?? 'update',
      ids: event.ids,
    };
    for (const listener of [...listeners]) listener(full);
  }

  return {
    plugin: { reviewManager } as unknown as IncrementalReadingPlugin,
    reviewManager,
    setStored,
    emit,
    listenerCount: () => listeners.size,
    setRow: (next: ReviewItem | null) => {
      row = next;
    },
  };
}

/**
 * Flush the pending microtask chains the bar kicked off. Every await under test
 * settles on an already-resolved promise, so draining the microtask queue is
 * enough — and unlike a `setTimeout` hop it stays cheap across a property's
 * hundreds of runs.
 */
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll('button')] as HTMLButtonElement[];

const dismissButton = (container: HTMLElement) => buttons(container)[0];

const reviewButton = (container: HTMLElement) => buttons(container)[1];

/**
 * What a button is called, as `getByRole(name)` and Obsidian's tooltip read
 * it: its `aria-label`, or failing that its text.
 */
const buttonName = (btn: Element) =>
  btn.getAttribute('aria-label') ?? btn.textContent;

/** The `<svg>` Obsidian's `setIcon` put in a button, if any. */
const iconSvg = (btn: Element) => btn.querySelector(':scope > svg.svg-icon');

/** The Lucide icon a button shows, by its `lucide-*` class, or null. */
const iconOf = (btn: Element) =>
  [...(iconSvg(btn)?.classList ?? [])].find((c) => c.startsWith('lucide-')) ??
  null;

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** Editors mounted by {@link mountPanel}, torn down after each test. */
const mountedViews: EditorView[] = [];

/**
 * Mount the real CodeMirror panel the edit-mode bar lives in, so the teardown
 * plumbing around it is exercised rather than described.
 *
 * `getFileInfoFromState` is stubbed because the mocked `obsidian` module has no
 * real editor-info state fields, so the extension would otherwise see no file
 * and never build a panel at all.
 */
function mountPanel(
  harness: ReturnType<typeof makeHarness>,
  options: { providePlugin?: boolean } = {}
) {
  const file = makeFile();
  const app = {
    isMobile: false,
    metadataCache: { on: vi.fn(() => ({})), offref: vi.fn() },
  };
  const parent = document.createElement('div');
  // Satisfies the extension's "not a sub-editor" check.
  parent.className = 'markdown-source-view';
  document.body.appendChild(parent);

  let view: EditorView | null = null;
  let info: MarkdownFileInfo | null = {
    file,
    app,
  } as unknown as MarkdownFileInfo;
  vi.spyOn(Obsidian, 'getFileInfoFromState').mockImplementation(() => ({
    info,
    editorView: view,
  }));
  vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');

  view = new EditorView({
    state: EditorState.create({
      doc: 'note body',
      extensions: [
        ...(options.providePlugin === false
          ? []
          : [irPluginFacet.of(harness.plugin)]),
        actionBarExtension,
      ],
    }),
    parent,
  });
  mountedViews.push(view);

  return {
    view,
    file,
    /** Drop the file info, as a detached editor would. */
    clearInfo: () => {
      info = null;
    },
    barButtons: () =>
      [...parent.querySelectorAll('.ir-action-bar button')].map(buttonName),
    /** The CodeMirror panel slot the bar was mounted into. */
    host: () => parent.querySelector('.ir-action-bar-host'),
    topSlotBar: () => parent.querySelector('.cm-panels-top .ir-action-bar'),
  };
}

/**
 * Assert `btn` shows the review bar's dismiss or restore icon — whichever
 * names the action a click would take on an item stored as `dismissed` — in
 * the same amber stroke, with the old text label kept as its name.
 */
function expectDismissFace(btn: HTMLButtonElement, dismissed: boolean) {
  expect(iconOf(btn)).toBe(dismissed ? 'lucide-archive-restore' : 'lucide-ban');
  expect(iconSvg(btn)?.getAttribute('stroke')).toBe(DISMISS_ICON_STROKE);
  expect(btn.getAttribute('aria-label')).toBe(
    dismissed ? 'Un-dismiss' : 'Dismiss'
  );
  expect(btn.classList.contains('clickable-icon')).toBe(true);
  expect(btn.classList.contains('ir-action-bar-status')).toBe(false);
  expect(btn.textContent).toBe('');
  expect(btn.childNodes).toHaveLength(1);
}

/**
 * Assert `btn` reads `text` as plain muted status text: no icon, and no
 * `aria-label` tooltip repeating what is already on screen.
 */
function expectStatusText(btn: HTMLButtonElement, text: string) {
  expect(btn.textContent).toBe(text);
  expect(iconSvg(btn)).toBeNull();
  expect(btn.hasAttribute('aria-label')).toBe(false);
  expect(btn.classList.contains('clickable-icon')).toBe(false);
  expect(btn.classList.contains('ir-action-bar-status')).toBe(true);
  expect(btn.classList.contains('ir-review-button')).toBe(true);
  expect(btn.disabled).toBe(true);
}

// #endregion

beforeEach(() => {
  Notice.reset();
});

afterEach(() => {
  while (mountedViews.length) mountedViews.pop()?.destroy();
  document.body.replaceChildren();
  removeIcon(PLUGIN_ICON);
  vi.restoreAllMocks();
});

describe('renderStandaloneActionBarDOM', () => {
  it('shows a disabled placeholder until the lookup resolves', () => {
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);

    expect(buttonName(dismissButton(container))).toBe('Loading...');
    expect(dismissButton(container).disabled).toBe(true);
  });

  it('labels the button to match the stored state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.string({ minLength: 1 }),
        async (dismissed, id) => {
          const file = makeFile();
          const { plugin } = makeHarness({
            item: makeItem({ id, dismissed, file }),
          });
          const container = makeContainer();

          renderStandaloneActionBarDOM(file, plugin, container);
          await tick();

          expect(buttonName(dismissButton(container))).toBe(
            dismissed ? 'Un-dismiss' : 'Dismiss'
          );
          expect(dismissButton(container).disabled).toBe(false);
          container.remove();
        }
      )
    );
  });

  it('holds the loader icon in the toggle slot while the lookup runs', () => {
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);

    const btn = dismissButton(container);
    expect(iconOf(btn)).toBe('lucide-loader');
    expect(iconSvg(btn)?.getAttribute('stroke')).toBe('currentColor');
    expect(btn.getAttribute('aria-label')).toBe('Loading...');
    expect(btn.classList.contains('clickable-icon')).toBe(true);
    expect(btn.classList.contains('ir-action-bar-status')).toBe(false);
    expect(btn.textContent).toBe('');
  });

  it('says so when the note has no row, and stays disabled', async () => {
    const { plugin } = makeHarness({ item: null });
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    expectStatusText(dismissButton(container), 'Not in database');
  });

  it('says so when the lookup throws, and reports why', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { plugin } = makeHarness({ lookupRejects: true });
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    expectStatusText(dismissButton(container), 'Error');
    expect(logged).toHaveBeenCalledWith(
      'Failed to fetch item status:',
      expect.any(Error)
    );
  });

  it('reports a row that vanished between render and click, changing nothing', async () => {
    const file = makeFile();
    const harness = makeHarness({ item: makeItem({ file }) });
    const container = makeContainer();
    const notify = vi.spyOn(Obsidian, 'notify');

    renderStandaloneActionBarDOM(file, harness.plugin, container);
    await tick();
    harness.setRow(null);
    dismissButton(container).click();
    await tick();

    expect(Notice.messages).toEqual(['Item not found in database']);
    expect(notify).toHaveBeenCalledWith('Item not found in database', {
      kind: 'error',
    });
    expect(harness.reviewManager.dismissItem).not.toHaveBeenCalled();
    expect(harness.reviewManager.unDismissItem).not.toHaveBeenCalled();
  });

  it('reports a failed write and leaves the label describing the untaken action', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = makeFile();
    const harness = makeHarness({ item: makeItem({ dismissed: false, file }) });
    harness.reviewManager.dismissItem.mockRejectedValueOnce(
      new Error('write failed')
    );
    const container = makeContainer();
    const notify = vi.spyOn(Obsidian, 'notify');

    renderStandaloneActionBarDOM(file, harness.plugin, container);
    await tick();
    dismissButton(container).click();
    await tick();

    expect(Notice.messages).toEqual(['Failed to update item']);
    expect(notify).toHaveBeenCalledWith('Failed to update item', {
      kind: 'error',
    });
    expect(buttonName(dismissButton(container))).toBe('Dismiss');
    expect(logged).toHaveBeenCalledWith(
      'Failed to toggle dismiss status:',
      expect.any(Error)
    );
  });

  it('opens a known item in review in the current tab', async () => {
    const file = makeFile();
    const item = makeItem({ file });
    const harness = makeHarness({ item });
    const learn = vi.fn(async () => {});
    const plugin = Object.assign(harness.plugin, { learn });
    const container = makeContainer();

    renderStandaloneActionBarDOM(file, plugin, container);
    await tick();
    buttons(container)[1].click();
    await tick();

    expect(learn).toHaveBeenCalledWith(item, false);
  });

  it('opens review empty-handed when the note has no row', async () => {
    const file = makeFile();
    const harness = makeHarness({ item: null });
    const learn = vi.fn(async () => {});
    const plugin = Object.assign(harness.plugin, { learn });
    const container = makeContainer();

    renderStandaloneActionBarDOM(file, plugin, container);
    await tick();
    buttons(container)[1].click();
    await tick();

    expect(learn).toHaveBeenCalledWith();
  });

  describe('the Review button', () => {
    /** The bar for a known item, with `learn` stubbed to record its calls. */
    async function renderReviewButton() {
      const file = makeFile();
      const item = makeItem({ file });
      const harness = makeHarness({ item });
      const learn = vi.fn(async () => {});
      const plugin = Object.assign(harness.plugin, { learn });
      const container = makeContainer();
      renderStandaloneActionBarDOM(file, plugin, container);
      await tick();
      return {
        item,
        learn,
        reviewManager: harness.reviewManager,
        button: buttons(container)[1],
        dismiss: dismissButton(container),
      };
    }

    const modifiersArb = fc.record({
      ctrlKey: fc.boolean(),
      metaKey: fc.boolean(),
      altKey: fc.boolean(),
      shiftKey: fc.boolean(),
    });

    /**
     * Where Obsidian's own links open for these keys: a middle click a tab
     * whatever is held, else Mod+Alt+Shift a window, Mod+Alt a split, Mod a
     * tab, anything else in place. Mod is Ctrl or Cmd (the mock accepts
     * either; the app reads the platform's one).
     */
    function expectedPane(
      {
        ctrlKey,
        metaKey,
        altKey,
        shiftKey,
      }: Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>,
      middle: boolean
    ): 'tab' | 'split' | 'window' | false {
      if (middle) return 'tab';
      const mod = ctrlKey || metaKey;
      if (mod && altKey) return shiftKey ? 'window' : 'split';
      return mod ? 'tab' : false;
    }

    function press(
      target: HTMLElement,
      type: 'click' | 'auxclick' | 'mousedown',
      init: MouseEventInit = {}
    ): MouseEvent {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    }

    it('opens review in a new tab on Ctrl+click', async () => {
      const { item, learn, button } = await renderReviewButton();

      press(button, 'click', { ctrlKey: true });
      await tick();

      expect(learn).toHaveBeenCalledWith(item, 'tab');
    });

    it('opens review in a new tab on a middle click', async () => {
      // A middle click never fires `click`: browsers emit `auxclick` for it.
      const { item, learn, button } = await renderReviewButton();

      press(button, 'auxclick', { button: 1 });
      await tick();

      expect(learn).toHaveBeenCalledWith(item, 'tab');
    });

    it('opens review in place on a plain click', async () => {
      const { item, learn, button } = await renderReviewButton();

      press(button, 'click');
      await tick();

      expect(learn).toHaveBeenCalledWith(item, false);
    });

    it('opens review where the modifier keys say, as Obsidian links do', async () => {
      await fc.assert(
        fc.asyncProperty(
          modifiersArb,
          fc.constantFrom(
            { type: 'click', button: 0 } as const,
            { type: 'auxclick', button: 1 } as const
          ),
          async (modifiers, { type, button: mouseButton }) => {
            document.body.replaceChildren();
            const { item, learn, button } = await renderReviewButton();

            press(button, type, { ...modifiers, button: mouseButton });
            await tick();

            expect(learn).toHaveBeenCalledTimes(1);
            expect(learn).toHaveBeenCalledWith(
              item,
              expectedPane(modifiers, mouseButton === 1)
            );
          }
        )
      );
    });

    it('ignores the other non-primary buttons', async () => {
      // `auxclick` fires for the right button too, ahead of the context menu.
      await fc.assert(
        fc.asyncProperty(
          modifiersArb,
          fc.integer({ min: 2, max: 4 }),
          async (modifiers, mouseButton) => {
            document.body.replaceChildren();
            const { learn, button } = await renderReviewButton();

            press(button, 'auxclick', { ...modifiers, button: mouseButton });
            await tick();

            expect(learn).not.toHaveBeenCalled();
          }
        )
      );
    });

    it('claims the middle-button press, and only that one', async () => {
      // Middle-mousedown starts autoscroll on Windows and pastes the primary
      // selection on Linux, neither of which belongs in front of a new tab.
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 4 }),
          async (mouseButton) => {
            document.body.replaceChildren();
            const { button } = await renderReviewButton();

            const event = press(button, 'mousedown', { button: mouseButton });

            expect(event.defaultPrevented).toBe(mouseButton === 1);
          }
        )
      );
    });

    it('leaves the dismiss toggle to plain clicks', async () => {
      // Nothing opens from it, so a middle press keeps its default as well.
      const { reviewManager, learn, dismiss } = await renderReviewButton();

      const pressed = press(dismiss, 'mousedown', { button: 1 });
      press(dismiss, 'auxclick', { button: 1 });
      await tick();

      expect(pressed.defaultPrevented).toBe(false);
      expect(reviewManager.dismissItem).not.toHaveBeenCalled();
      expect(learn).not.toHaveBeenCalled();
    });
  });

  it('shows Review as the plugin icon, named by its tooltip and not by text', async () => {
    registerPluginIcon();
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    const btn = reviewButton(container);
    expect(iconSvg(btn)?.classList.contains(PLUGIN_ICON)).toBe(true);
    expect(btn.classList.contains('ir-review-button')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Review');
    expect(btn.classList.contains('clickable-icon')).toBe(true);
    expect(btn.textContent).toBe('');
    expect(btn.hasAttribute('title')).toBe(false);
    expect(iconSvg(btn)?.hasAttribute('aria-label')).toBe(false);
  });

  it('adds a Review button alongside the dismiss toggle', async () => {
    const { plugin } = makeHarness();
    const container = makeContainer();

    renderStandaloneActionBarDOM(makeFile(), plugin, container);
    await tick();

    expect(buttons(container).map(buttonName)).toEqual(['Dismiss', 'Review']);
  });

  it('toggles the stored state on click and relabels for the opposite action', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (dismissed) => {
        const file = makeFile();
        const harness = makeHarness({ item: makeItem({ dismissed, file }) });
        const container = makeContainer();
        Notice.reset();

        renderStandaloneActionBarDOM(file, harness.plugin, container);
        await tick();
        dismissButton(container).click();
        await tick();

        if (dismissed) {
          expect(harness.reviewManager.unDismissItem).toHaveBeenCalledOnce();
          expect(harness.reviewManager.dismissItem).not.toHaveBeenCalled();
          expect(Notice.messages).toContain('Item restored to queue');
        } else {
          expect(harness.reviewManager.dismissItem).toHaveBeenCalledOnce();
          expect(harness.reviewManager.unDismissItem).not.toHaveBeenCalled();
          expect(Notice.messages).toContain('Item dismissed');
        }
        expect(buttonName(dismissButton(container))).toBe(
          dismissed ? 'Dismiss' : 'Un-dismiss'
        );
        container.remove();
      })
    );
  });

  it('confirms a dismissal or restore only while every success notice shows', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom(...SUCCESS_NOTICE_LEVELS),
        async (dismissed, level) => {
          const file = makeFile();
          const harness = makeHarness({ item: makeItem({ dismissed, file }) });
          const container = makeContainer();
          showSuccessNotices(level);
          Notice.reset();

          renderStandaloneActionBarDOM(file, harness.plugin, container);
          await tick();
          dismissButton(container).click();
          await tick();
          configureSuccessNotices(null);
          container.remove();

          expect(Notice.messages).toEqual(
            level === 'all'
              ? [dismissed ? 'Item restored to queue' : 'Item dismissed']
              : []
          );
        }
      )
    );
  });

  it('keeps showing the icon for the next action through clicks and outside writes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(fc.option(fc.boolean(), { nil: undefined }), {
          maxLength: 6,
        }),
        async (initial, steps) => {
          const file = makeFile();
          const harness = makeHarness({
            item: makeItem({ id: 'watched', dismissed: initial, file }),
          });
          const container = makeContainer();
          let stored = initial;

          renderStandaloneActionBarDOM(file, harness.plugin, container);
          await tick();
          expectDismissFace(dismissButton(container), stored);

          // `undefined` is a click here; a boolean, a write made elsewhere
          for (const step of steps) {
            if (step === undefined) {
              dismissButton(container).click();
              stored = !stored;
            } else {
              harness.setStored('watched', step);
              harness.emit({ ids: ['watched'] });
              stored = step;
            }
            await tick();
            expectDismissFace(dismissButton(container), stored);
          }
          container.remove();
        }
      )
    );
  });

  describe('staying in sync with writes made elsewhere', () => {
    it('relabels when another surface changes the stored state', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
          async (initial, externalWrites) => {
            const file = makeFile();
            const harness = makeHarness({
              item: makeItem({ id: 'watched', dismissed: initial, file }),
            });
            const container = makeContainer();

            renderStandaloneActionBarDOM(file, harness.plugin, container);
            await tick();

            for (const dismissed of externalWrites) {
              harness.setStored('watched', dismissed);
              harness.emit({ ids: ['watched'] });
              await tick();

              expect(buttonName(dismissButton(container))).toBe(
                dismissed ? 'Un-dismiss' : 'Dismiss'
              );
            }
            container.remove();
          }
        )
      );
    });

    it('leaves the label alone for writes to other items', async () => {
      const file = makeFile();
      const harness = makeHarness({
        item: makeItem({ id: 'watched', dismissed: false, file }),
      });
      const container = makeContainer();

      renderStandaloneActionBarDOM(file, harness.plugin, container);
      await tick();
      harness.reviewManager.getReviewItemFromFile.mockClear();

      harness.emit({ ids: ['other-item', 'another'] });
      await tick();

      expect(
        harness.reviewManager.getReviewItemFromFile
      ).not.toHaveBeenCalled();
      expect(buttonName(dismissButton(container))).toBe('Dismiss');
    });

    it('keeps the label and reports why when re-reading the item fails', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.anything(),
          async (dismissed, reason) => {
            logged.mockClear();
            const file = makeFile();
            const harness = makeHarness({
              item: makeItem({ id: 'watched', dismissed, file }),
            });
            const container = makeContainer();

            renderStandaloneActionBarDOM(file, harness.plugin, container);
            await tick();

            harness.reviewManager.getReviewItemFromFile.mockRejectedValueOnce(
              reason
            );
            harness.emit({ ids: ['watched'] });
            await tick();

            expect(buttonName(dismissButton(container))).toBe(
              dismissed ? 'Un-dismiss' : 'Dismiss'
            );
            expect(logged).toHaveBeenCalledExactlyOnceWith(
              'Failed to refresh item status:',
              reason
            );
            container.remove();
          }
        )
      );
    });

    it('keeps the label when the row disappears rather than blanking it', async () => {
      const file = makeFile();
      const harness = makeHarness({
        item: makeItem({ id: 'watched', dismissed: true, file }),
      });
      const container = makeContainer();

      renderStandaloneActionBarDOM(file, harness.plugin, container);
      await tick();

      harness.setRow(null);
      harness.emit({ ids: ['watched'] });
      await tick();

      expect(buttonName(dismissButton(container))).toBe('Un-dismiss');
    });

    it('stops listening once torn down, and leaves no listener behind', async () => {
      const file = makeFile();
      const harness = makeHarness({
        item: makeItem({ id: 'watched', dismissed: false, file }),
      });
      const container = makeContainer();

      const teardown = renderStandaloneActionBarDOM(
        file,
        harness.plugin,
        container
      );
      await tick();
      expect(harness.listenerCount()).toBe(1);

      teardown();
      expect(harness.listenerCount()).toBe(0);

      harness.setStored('watched', true);
      harness.emit({ ids: ['watched'] });
      await tick();

      expect(buttonName(dismissButton(container))).toBe('Dismiss');
    });

    it('never subscribes when torn down before the lookup resolves', async () => {
      const file = makeFile();
      const harness = makeHarness({ item: makeItem({ file }) });
      const container = makeContainer();

      const teardown = renderStandaloneActionBarDOM(
        file,
        harness.plugin,
        container
      );
      teardown();
      await tick();

      expect(harness.listenerCount()).toBe(0);
      expect(harness.reviewManager.repo.onDataChange).not.toHaveBeenCalled();
    });

    it('returns a teardown that is safe to call when there is no review manager', () => {
      const container = makeContainer();
      const teardown = renderStandaloneActionBarDOM(
        makeFile(),
        { reviewManager: undefined } as unknown as IncrementalReadingPlugin,
        container
      );

      expect(() => teardown()).not.toThrow();
      expect(buttons(container)).toHaveLength(0);
    });
  });
});

describe('the edit-mode action bar panel', () => {
  it('watches the item for as long as the panel is on screen', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness);
    await tick();

    expect(panel.barButtons()).toEqual(['Dismiss', 'Review']);
    expect(harness.listenerCount()).toBe(1);
  });

  it('sits above the note on desktop, in a slot marked as its host', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness);
    await tick();

    expect(panel.topSlotBar()).not.toBeNull();
    expect(panel.host()).not.toBeNull();
    expect(panel.host()?.querySelector('.ir-action-bar')).not.toBeNull();
  });

  it('relabels a panel that was built before the item changed elsewhere', async () => {
    // The reported bug: dismiss here, leave for reading mode, restore there,
    // come back. The panel outlives the switch, so only a live label is right.
    const harness = makeHarness({
      item: makeItem({ id: 'watched', dismissed: true }),
    });
    const panel = mountPanel(harness);
    await tick();
    expect(panel.barButtons()).toEqual(['Un-dismiss', 'Review']);

    harness.setStored('watched', false);
    harness.emit({ ids: ['watched'] });
    await tick();

    expect(panel.barButtons()).toEqual(['Dismiss', 'Review']);
  });

  it('stops watching when the editor goes away', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness);
    await tick();
    expect(harness.listenerCount()).toBe(1);

    panel.view.destroy();

    expect(harness.listenerCount()).toBe(0);
  });

  it('replaces rather than stacks the watch when the panel re-renders', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness);
    await tick();

    panel.view.dispatch({ effects: setShowAnswerEffect.of(true) });
    await tick();

    expect(harness.reviewManager.repo.onDataChange).toHaveBeenCalledTimes(2);
    expect(harness.listenerCount()).toBe(1);
  });

  it('releases the watch when the bar switches into review mode', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness);
    await tick();
    expect(harness.listenerCount()).toBe(1);

    panel.view.dispatch({
      effects: [
        setReviewCallbacks.of({
          getCurrentItem: () => makeItem({ id: 'watched' }),
        }),
        setReviewModeEffect.of(true),
      ],
    });
    await tick();

    expect(harness.listenerCount()).toBe(0);
  });

  it('takes the bar, its host marking and its watch away with the file', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness);
    await tick();
    // Held across the teardown: the slot may be detached along with the panel,
    // and a class left behind on a detached node is still a class left behind.
    const host = panel.host();
    expect(host).not.toBeNull();

    panel.clearInfo();
    // Any state change re-derives the panel, which a file-less editor has none of.
    panel.view.dispatch({ effects: setShowAnswerEffect.of(true) });
    await tick();

    expect(panel.barButtons()).toEqual([]);
    expect(host?.classList.contains('ir-action-bar-host')).toBe(false);
    expect(harness.listenerCount()).toBe(0);
  });

  it('renders nothing and watches nothing without a plugin to render for', async () => {
    const harness = makeHarness({ item: makeItem({ id: 'watched' }) });
    const panel = mountPanel(harness, { providePlugin: false });
    await tick();

    expect(panel.barButtons()).toEqual([]);
    expect(harness.listenerCount()).toBe(0);
  });
});
