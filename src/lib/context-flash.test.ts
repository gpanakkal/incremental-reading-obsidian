// @vitest-environment jsdom

import {
  CONTEXT_FADE_MS,
  CONTEXT_SCROLL_WAIT_MS,
  contextFlashEffect,
} from '#/lib/extensions/ContextFlashExtension';
import type { StateEffect, TransactionSpec } from '@codemirror/state';
import fc from 'fast-check';
import { MarkdownView, type TFile, type View } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flashElements, flashSnippetContext } from './context-flash';
import type { MatchEphemeralState } from './item-context';
import type { ReviewSnippet } from './types';

// #region HELPERS

/** One animation frame, as fake timers run them. */
const FRAME_MS = 16;

/**
 * Two frames: one to find the targets on screen, one to find them still where
 * they were, the scroll done.
 */
const SETTLE_MS = FRAME_MS * 2;

/**
 * Stand in for layout, which jsdom has none of: a reading view's container
 * (`.root`, `.markdown-reading-view`) shows rows 0-100px, and every element in
 * it is drawn at 10-20px, on screen, unless {@link offScreen}.
 */
function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      if (this.matches('.root, .markdown-reading-view')) {
        return new DOMRect(0, 0, 100, 100);
      }
      // A scroller from that many px down to 100px
      const box = this.getAttribute('data-box');
      if (box !== null)
        return new DOMRect(0, Number(box), 100, 100 - Number(box));
      const top = this.getAttribute('data-top');
      if (top !== null) return new DOMRect(0, Number(top), 10, 10);
      return this.hasAttribute('data-off-screen')
        ? new DOMRect(0, 500, 10, 10)
        : new DOMRect(0, 10, 10, 10);
    }
  );
}

/** Draw `el` at `top`px. */
const drawAt = (el: Element, top: number) =>
  el.setAttribute('data-top', String(top));

/** Draw `el` out of the view's sight, or back in it. */
const offScreen = (el: Element, off: boolean) =>
  el.toggleAttribute('data-off-screen', off);

/** A reading view's container, with `count` targets in it. */
function makeRoot(count = 1) {
  const root = document.body.createDiv('root');
  for (let i = 0; i < count; i++) root.createSpan('target');
  return root;
}

const findTargets = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('.target'),
];

/** Each target's flash, as the classes on it say. */
const flashOf = (root: HTMLElement) =>
  findTargets(root).map((el) =>
    el.classList.contains('ir-context-flash-lit')
      ? 'lit'
      : el.classList.contains('ir-context-flash')
        ? 'fading'
        : 'none'
  );

/** Let the mutation observer's callbacks run. */
const settle = () => Promise.resolve();

const CONTEXT_PATH = 'notes/Context.md';

const snippet = {
  data: { id: 'snippet-1', type: 'snippet' },
  file: { path: 'ir/snippets/Snippet.md' },
} as unknown as ReviewSnippet;

/** A note tab on the context, in `mode`, recording what is done to it. */
function makeNoteTab(mode: 'source' | 'preview', doc = '') {
  const dispatch = vi.fn<(spec: TransactionSpec) => void>();
  const editor = {
    getValue: () => doc,
    removeHighlights: vi.fn(),
    cm: { dispatch },
  };
  const containerEl = document.body.createDiv('markdown-reading-view');
  const view = Object.assign(Object.create(MarkdownView.prototype) as object, {
    file: { path: CONTEXT_PATH },
    getMode: () => mode,
    editor,
    previewMode: { containerEl },
  }) as unknown as View;
  const flashes = () =>
    dispatch.mock.calls.flatMap(([spec]) =>
      [spec.effects ?? []]
        .flat()
        .filter((effect: StateEffect<unknown>) => effect.is(contextFlashEffect))
        .map((effect) => effect.value)
    );
  return { view, editor, containerEl, flashes };
}

/** The context, as the note it is in. */
const contextFile = { path: CONTEXT_PATH } as TFile;

/** Go to context's context in the note `doc`, at `[from, to]`. */
const contextAt = (doc: string, from: number, to: number) => ({
  file: contextFile,
  eState: {
    match: { content: doc, matches: [[from, to]] },
  } satisfies MatchEphemeralState,
});

/** Whether `el` is lit. */
const isLit = (el: Element) => el.classList.contains('ir-context-flash-lit');

// #endregion

describe('flashElements', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubLayout();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('lights the targets on screen at the next frame, eases them in, then out, and leaves them as they were', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (count) => {
        const root = makeRoot(count);

        flashElements(root, findTargets);

        // Not before the view has had a frame to scroll
        expect(flashOf(root)).toEqual(Array(count).fill('none'));
        vi.advanceTimersByTime(SETTLE_MS);
        expect(flashOf(root)).toEqual(Array(count).fill('lit'));
        vi.advanceTimersByTime(CONTEXT_FADE_MS - SETTLE_MS);
        expect(flashOf(root)).toEqual(Array(count).fill('lit'));
        vi.advanceTimersByTime(SETTLE_MS);
        expect(flashOf(root)).toEqual(Array(count).fill('fading'));
        vi.advanceTimersByTime(CONTEXT_FADE_MS - SETTLE_MS);
        expect(flashOf(root)).toEqual(Array(count).fill('fading'));
        vi.advanceTimersByTime(SETTLE_MS);
        expect(flashOf(root)).toEqual(Array(count).fill('none'));
        root.remove();
      })
    );
  });

  it('waits for targets the view paints later and scrolls on screen, and flashes them in full from then', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: CONTEXT_SCROLL_WAIT_MS / 2 }),
        fc.integer({ min: 0, max: CONTEXT_SCROLL_WAIT_MS / 2 - SETTLE_MS * 2 }),
        async (paintedAt, scrolledAfter) => {
          const root = makeRoot(0);
          flashElements(root, findTargets);

          await vi.advanceTimersByTimeAsync(paintedAt);
          const target = root.createSpan('target');
          offScreen(target, true);
          await vi.advanceTimersByTimeAsync(scrolledAfter);
          expect(flashOf(root)).toEqual(['none']);
          offScreen(target, false);
          await vi.advanceTimersByTimeAsync(SETTLE_MS);

          expect(flashOf(root)).toEqual(['lit']);
          await vi.advanceTimersByTimeAsync(CONTEXT_FADE_MS - SETTLE_MS);
          expect(flashOf(root)).toEqual(['lit']);
          await vi.advanceTimersByTimeAsync(SETTLE_MS);
          expect(flashOf(root)).toEqual(['fading']);
          await vi.advanceTimersByTimeAsync(CONTEXT_FADE_MS);
          expect(flashOf(root)).toEqual(['none']);
          root.remove();
        }
      ),
      { numRuns: 40 }
    );
  });

  it('lights nothing while the targets are still moving on screen, and lights them once they stay put', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (movingFrames) => {
        const root = makeRoot(1);
        const [target] = findTargets(root);
        flashElements(root, findTargets);

        // Scrolling: on screen, but somewhere else each frame
        for (let i = 0; i < movingFrames; i++) {
          drawAt(target, 50 - i * 2);
          vi.advanceTimersByTime(FRAME_MS);
          expect(flashOf(root)).toEqual(['none']);
        }
        vi.advanceTimersByTime(FRAME_MS);

        expect(flashOf(root)).toEqual(['lit']);
        vi.advanceTimersByTime(CONTEXT_FADE_MS * 2);
        root.remove();
      })
    );
  });

  it("measures what is on screen against the view's scroller, where it has one", () => {
    for (const [top, lit] of [
      [30, true],
      [5, false],
    ] as const) {
      const root = makeRoot(1);
      // The scroller sits under a bar 20px tall, the find bar say
      const scroller = root.createDiv('markdown-preview-view');
      scroller.setAttribute('data-box', '20');
      const [target] = findTargets(root);
      drawAt(target, top);

      flashElements(root, findTargets);
      vi.advanceTimersByTime(SETTLE_MS);

      expect(flashOf(root)).toEqual([lit ? 'lit' : 'none']);
      vi.advanceTimersByTime(CONTEXT_SCROLL_WAIT_MS + CONTEXT_FADE_MS * 2);
      root.remove();
    }
  });

  it('counts a target as on screen when it overlaps the view, not when it only touches its edge', () => {
    for (const [top, bottom, lit] of [
      [90, 110, true],
      [-10, 5, true],
      [100, 110, false],
      [-10, 0, false],
    ] as const) {
      const root = makeRoot(1);
      const target = findTargets(root)[0];
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: Element) {
          return this === target
            ? new DOMRect(0, top, 10, bottom - top)
            : new DOMRect(0, 0, 100, 100);
        }
      );

      flashElements(root, findTargets);
      vi.advanceTimersByTime(SETTLE_MS);

      expect(flashOf(root)).toEqual([lit ? 'lit' : 'none']);
      vi.advanceTimersByTime(CONTEXT_SCROLL_WAIT_MS + CONTEXT_FADE_MS * 2);
      root.remove();
    }
  });

  it('gives up on targets that have not shown on screen within the wait, lighting none', () => {
    fc.assert(
      fc.property(fc.boolean(), (painted) => {
        const root = makeRoot(painted ? 1 : 0);
        for (const target of findTargets(root)) offScreen(target, true);
        flashElements(root, findTargets);

        vi.advanceTimersByTime(CONTEXT_SCROLL_WAIT_MS + FRAME_MS);
        for (const target of findTargets(root)) offScreen(target, false);
        root.createSpan('target');
        vi.advanceTimersByTime(SETTLE_MS * 2);

        expect(flashOf(root)).toEqual(
          Array(findTargets(root).length).fill('none')
        );
        root.remove();
      })
    );
  });

  it('lights targets redrawn while it is lit, and only while it is lit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: CONTEXT_FADE_MS * 3 }),
        async (redrawnAfter) => {
          const root = makeRoot(1);
          flashElements(root, findTargets);
          vi.advanceTimersToNextFrame();
          vi.advanceTimersToNextFrame();
          expect(flashOf(root)).toEqual(['lit']);

          await vi.advanceTimersByTimeAsync(redrawnAfter);
          root.replaceChildren(createSpan('target'));
          await settle();

          const litFor = CONTEXT_FADE_MS - redrawnAfter;
          if (litFor <= 0) {
            expect(flashOf(root)).toEqual(['none']);
          } else {
            expect(flashOf(root)).toEqual(['lit']);
            // For no longer than the flash it was redrawn in
            await vi.advanceTimersByTimeAsync(litFor);
            expect(flashOf(root)).toEqual(['fading']);
            await vi.advanceTimersByTimeAsync(CONTEXT_FADE_MS);
          }
          expect(flashOf(root)).toEqual(['none']);
          root.remove();
        }
      )
    );
  });

  it('still lights, eases out and ends in a document that has no window of its own', () => {
    // A document built this way has a null `defaultView`
    const detached = document.implementation.createHTMLDocument();
    const root = detached.body.createDiv('root');
    root.createSpan('target');

    flashElements(root, findTargets);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(flashOf(root)).toEqual(['lit']);
    vi.advanceTimersByTime(CONTEXT_FADE_MS);
    expect(flashOf(root)).toEqual(['fading']);
    vi.advanceTimersByTime(CONTEXT_FADE_MS);
    expect(flashOf(root)).toEqual(['none']);
  });

  it("puts out the reading view's own flash of the block, lit before the targets or while they are, once they are lit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 0, max: CONTEXT_FADE_MS - 1 }), {
          nil: null,
        }),
        fc.boolean(),
        async (blockLitAfter, targetShown) => {
          const root = makeRoot(targetShown ? 1 : 0);
          const block = root.createEl('p');
          flashElements(root, findTargets);
          // Before the targets are lit, or so long after they are
          if (blockLitAfter === null) block.classList.add('is-flashing');
          vi.advanceTimersToNextFrame();
          vi.advanceTimersToNextFrame();
          if (blockLitAfter !== null) {
            await vi.advanceTimersByTimeAsync(blockLitAfter);
            block.classList.add('is-flashing');
          }
          await settle();

          // With nothing of its own to light, the view's flash is all there is
          expect(block.classList.contains('is-flashing')).toBe(!targetShown);
          await vi.advanceTimersByTimeAsync(
            CONTEXT_SCROLL_WAIT_MS + CONTEXT_FADE_MS * 2
          );
          root.remove();
        }
      )
    );
  });

  it('looks for targets again while lit only for changes that are not its own lighting', async () => {
    const root = makeRoot(2);
    const find = vi.fn(findTargets);

    flashElements(root, find);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    const looked = find.mock.calls.length;
    await settle();
    expect(find).toHaveBeenCalledTimes(looked);

    root.createSpan('target');
    // Its lighting of the new one is a batch of its own, a turn later
    for (let i = 0; i < 3; i++) await settle();
    expect(find).toHaveBeenCalledTimes(looked + 1);
    expect(flashOf(root)).toEqual(['lit', 'lit', 'lit']);
    await vi.advanceTimersByTimeAsync(CONTEXT_FADE_MS * 2);
    root.remove();
  });

  it('lights targets the view paints alongside its own lighting, or inside a lit one', async () => {
    const root = makeRoot(1);
    flashElements(root, findTargets);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    // In the same batch of changes as lighting one it painted
    root.createSpan('target');
    root.createSpan('target');
    await settle();
    expect(flashOf(root)).toEqual(['lit', 'lit', 'lit']);

    // Painted inside a target it lit
    root.querySelector('.target')!.createSpan('target');
    await settle();
    expect(flashOf(root)).toEqual(['lit', 'lit', 'lit', 'lit']);
    await vi.advanceTimersByTimeAsync(CONTEXT_FADE_MS * 2);
    root.remove();
  });

  it('flashes again in place of a flash still showing, for a full flash of its own', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: SETTLE_MS + CONTEXT_FADE_MS * 2 - 1 }),
        async (into) => {
          const root = makeRoot(1);
          flashElements(root, findTargets);
          await vi.advanceTimersByTimeAsync(into);

          flashElements(root, findTargets);

          expect(flashOf(root)).toEqual(['none']);
          await vi.advanceTimersByTimeAsync(SETTLE_MS);
          expect(flashOf(root)).toEqual(['lit']);
          await vi.advanceTimersByTimeAsync(CONTEXT_FADE_MS - SETTLE_MS);
          expect(flashOf(root)).toEqual(['lit']);
          await vi.advanceTimersByTimeAsync(SETTLE_MS);
          expect(flashOf(root)).toEqual(['fading']);
          await vi.advanceTimersByTimeAsync(CONTEXT_FADE_MS);
          expect(flashOf(root)).toEqual(['none']);
          root.remove();
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe('flashSnippetContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubLayout();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it("in an editor, flashes the context's range in place of the highlight Obsidian leaves until a click", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.integer({ min: -3, max: 40 }),
        fc.integer({ min: -3, max: 40 }),
        (doc, a, b) => {
          const tab = makeNoteTab('source', doc);

          flashSnippetContext(tab.view, snippet, contextAt(doc, a, b));

          expect(tab.editor.removeHighlights).toHaveBeenCalledExactlyOnceWith(
            'is-flashing'
          );
          const inside = (n: number) => Math.min(Math.max(n, 0), doc.length);
          const [from, to] = [inside(a), inside(b)].sort((x, y) => x - y);
          expect(tab.flashes()).toEqual([[{ from, to }]]);
          tab.containerEl.remove();
        }
      )
    );
  });

  it('flashes nothing, and leaves the note as it is, for a context with no known place', () => {
    for (const mode of ['source', 'preview'] as const) {
      const tab = makeNoteTab(mode, 'Some text');
      tab.containerEl.createSpan({
        cls: 'ir-snippet-highlight',
        attr: { 'data-snippet-id': snippet.data.id },
      });

      flashSnippetContext(tab.view, snippet, {
        file: contextFile,
        eState: null,
      });
      vi.advanceTimersByTime(SETTLE_MS);

      expect(tab.editor.removeHighlights).not.toHaveBeenCalled();
      expect(tab.flashes()).toEqual([]);
      expect(tab.containerEl.querySelector('.ir-context-flash')).toBeNull();
    }
  });

  it('leaves the note as it is for a context that names no range in it', () => {
    // A PDF's page, which Go to context opens no note at
    const noRange = [
      { match: { content: 'Some text', matches: [] } },
      { subpath: '#page=2' },
    ];
    for (const eState of noRange) {
      const tab = makeNoteTab('source', 'Some text');

      flashSnippetContext(tab.view, snippet, { file: contextFile, eState });

      expect(tab.editor.removeHighlights).not.toHaveBeenCalled();
      expect(tab.flashes()).toEqual([]);
    }
  });

  it('flashes nothing in a tab still showing another note, or none', () => {
    // As a tab whose `openFile` was still busy with another file is left
    for (const mode of ['source', 'preview'] as const) {
      for (const file of [{ path: 'notes/Other.md' }, null]) {
        const tab = makeNoteTab(mode, 'Some text');
        (tab.view as unknown as { file: unknown }).file = file;
        const highlight = tab.containerEl.createSpan({
          cls: 'ir-snippet-highlight',
          attr: { 'data-snippet-id': snippet.data.id },
        });

        flashSnippetContext(tab.view, snippet, contextAt('Some text', 0, 4));
        vi.advanceTimersByTime(SETTLE_MS);

        expect(tab.editor.removeHighlights).not.toHaveBeenCalled();
        expect(tab.flashes()).toEqual([]);
        expect(isLit(highlight)).toBe(false);
      }
    }
  });

  it('flashes nothing in a tab that is no note', () => {
    const tab = makeNoteTab('source', 'Some text');
    const pdf = { ...tab.view } as View;

    flashSnippetContext(pdf, snippet, contextAt('Some text', 0, 4));

    expect(tab.editor.removeHighlights).not.toHaveBeenCalled();
    expect(tab.flashes()).toEqual([]);
  });

  it("in reading view, flashes the snippet's own highlight, wherever the view paints it, and not one in an embedded note", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            own: fc.boolean(),
            // How many embeds deep, 0 for the note itself
            embedded: fc.nat(2),
            // How many blocks deep inside the note or the embed
            depth: fc.nat(2),
          }),
          { maxLength: 6 }
        ),
        (highlights) => {
          const tab = makeNoteTab('preview');
          const painted = highlights.map(({ own, embedded, depth }) => {
            let parent = tab.containerEl;
            for (let i = 0; i < embedded; i++) {
              parent = parent.createDiv('internal-embed');
            }
            for (let i = 0; i < depth; i++) parent = parent.createDiv();
            return parent.createSpan({
              cls: 'ir-snippet-highlight',
              attr: { 'data-snippet-id': own ? snippet.data.id : 'snippet-2' },
            });
          });

          flashSnippetContext(tab.view, snippet, contextAt('', 0, 0));
          vi.advanceTimersByTime(SETTLE_MS);

          expect(painted.map(isLit)).toEqual(
            highlights.map(({ own, embedded }) => own && embedded === 0)
          );
          expect(tab.editor.removeHighlights).not.toHaveBeenCalled();
          tab.containerEl.remove();
        }
      )
    );
  });
});
