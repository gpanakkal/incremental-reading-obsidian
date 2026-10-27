// @vitest-environment jsdom

import fc from 'fast-check';
import type { MarkdownView } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RERENDER_FALLBACK_MS,
  RERENDER_QUIET_MS,
  RERENDERING_CLASS,
  rerenderInPlace,
} from './preview-rerender';

// #region HELPERS

/**
 * A reading view as `rerenderInPlace` reaches it: the mode's container, with
 * the scroller inside it unless `scroller` is false.
 */
function makeView({ scroller = true } = {}) {
  const containerEl = document.createElement('div');
  containerEl.className = 'markdown-reading-view';
  let scrollerEl: HTMLElement | null = null;
  if (scroller) {
    scrollerEl = containerEl.createDiv('markdown-preview-view');
    scrollerEl.createDiv('markdown-preview-sizer');
  }
  document.body.append(containerEl);
  const rerender = vi.fn();
  const register = vi.fn();
  const view = {
    previewMode: { containerEl, rerender },
    register,
  } as unknown as MarkdownView;
  return { view, containerEl, scroller: scrollerEl, rerender, register };
}

/** 'none' while the scroller's anchoring is off, else ''. */
const anchoring = (el: HTMLElement) =>
  el.classList.contains(RERENDERING_CLASS) ? 'none' : '';

/**
 * A change inside `el`, delivered to observers. Under the scroller, it lands in
 * the sizer, where the sections are, as a refilled section does.
 */
async function mutate(el: HTMLElement) {
  (el.querySelector('.markdown-preview-sizer') ?? el).append(
    document.createElement('p')
  );
  // MutationObserver callbacks run as microtasks
  await vi.advanceTimersByTimeAsync(0);
}

// #endregion

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('rerenderInPlace', () => {
  it('re-renders in full, and nothing more, when the view has no scroller', () => {
    const { view, rerender, register, containerEl } = makeView({
      scroller: false,
    });

    rerenderInPlace(view);

    expect(rerender).toHaveBeenCalledExactlyOnceWith(true);
    expect(register).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(containerEl.querySelector('.' + RERENDERING_CLASS)).toBeNull();
  });

  it('turns scroll anchoring off before the re-render, and re-renders in full', () => {
    const { view, scroller, rerender } = makeView();
    let during = '';
    rerender.mockImplementation(() => {
      during = anchoring(scroller!);
    });

    rerenderInPlace(view);

    expect(rerender).toHaveBeenCalledExactlyOnceWith(true);
    expect(during).toBe('none');
    expect(anchoring(scroller!)).toBe('none');
  });

  it('turns it back on once the refill has gone quiet, however the refill is spaced', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Gaps between refill slices, each short of the quiet period
        fc.array(fc.integer({ min: 0, max: RERENDER_QUIET_MS - 1 }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (gaps) => {
          const { view, scroller } = makeView();
          rerenderInPlace(view);
          for (const gap of gaps) {
            await vi.advanceTimersByTimeAsync(gap);
            await mutate(scroller!);
            expect(anchoring(scroller!)).toBe('none');
          }
          await vi.advanceTimersByTimeAsync(RERENDER_QUIET_MS - 1);
          expect(anchoring(scroller!)).toBe('none');
          await vi.advanceTimersByTimeAsync(1);
          expect(anchoring(scroller!)).toBe('');
          expect(vi.getTimerCount()).toBe(0);
          vi.clearAllTimers();
          document.body.replaceChildren();
        }
      )
    );
  });

  it('turns it back on after the fallback when the refill never goes quiet', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: RERENDER_QUIET_MS - 1 }),
        async (every) => {
          const { view, scroller } = makeView();
          rerenderInPlace(view);
          let elapsed = 0;
          while (elapsed + every < RERENDER_FALLBACK_MS) {
            await vi.advanceTimersByTimeAsync(every);
            elapsed += every;
            await mutate(scroller!);
          }
          expect(anchoring(scroller!)).toBe('none');
          await vi.advanceTimersByTimeAsync(RERENDER_FALLBACK_MS - elapsed);
          expect(anchoring(scroller!)).toBe('');
          expect(vi.getTimerCount()).toBe(0);
          document.body.replaceChildren();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('turns it back on after the fallback when no refill shows up', async () => {
    const { view, scroller } = makeView();
    rerenderInPlace(view);

    await vi.advanceTimersByTimeAsync(RERENDER_FALLBACK_MS - 1);
    expect(anchoring(scroller!)).toBe('none');
    await vi.advanceTimersByTimeAsync(1);
    expect(anchoring(scroller!)).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count the emptying the re-render does itself as the refill', async () => {
    const { view, scroller, rerender } = makeView();
    rerender.mockImplementation(() => scroller!.replaceChildren());

    rerenderInPlace(view);
    await vi.advanceTimersByTimeAsync(RERENDER_QUIET_MS);

    expect(anchoring(scroller!)).toBe('none');
  });

  it('does not count changes outside the scroller', async () => {
    const { view, scroller, containerEl } = makeView();

    rerenderInPlace(view);
    containerEl.append(document.createElement('p'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RERENDER_QUIET_MS);

    expect(anchoring(scroller!)).toBe('none');
  });

  it('stops watching once anchoring is back on', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { view, scroller } = makeView();
    rerenderInPlace(view);
    await mutate(scroller!);
    await vi.advanceTimersByTimeAsync(RERENDER_QUIET_MS);
    expect(disconnect).toHaveBeenCalledOnce();

    // A later change starts no wait
    await mutate(scroller!);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the wait over on a second refresh, without a second watcher', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { view, scroller, rerender } = makeView();
    rerenderInPlace(view);
    await vi.advanceTimersByTimeAsync(RERENDER_FALLBACK_MS - 100);
    await mutate(scroller!);

    rerenderInPlace(view);

    expect(rerender).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledOnce();
    // The new fallback, and nothing left of the first refresh
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(RERENDER_FALLBACK_MS - 1);
    expect(anchoring(scroller!)).toBe('none');
    await vi.advanceTimersByTimeAsync(1);
    expect(anchoring(scroller!)).toBe('');
  });

  it('lets go when the view unloads, registering that once per view', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { view, scroller, register } = makeView();
    rerenderInPlace(view);
    rerenderInPlace(view);
    expect(register).toHaveBeenCalledOnce();
    disconnect.mockClear();

    const [[onUnload]] = register.mock.calls as [[() => void]];
    onUnload();

    expect(anchoring(scroller!)).toBe('');
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    // Nothing left to let go of
    onUnload();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
