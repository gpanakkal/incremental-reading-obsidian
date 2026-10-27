import type { MarkdownView } from 'obsidian';

/**
 * How long the reading view has to go without a DOM change before its re-render
 * counts as done, in ms.
 */
export const RERENDER_QUIET_MS = 200;

/** The longest scroll anchoring stays off for one re-render, in ms. */
export const RERENDER_FALLBACK_MS = 2000;

/** On the scroller while it refills: turns its scroll anchoring off (styles.css). */
export const RERENDERING_CLASS = 'ir-rerendering';

/** A scroller whose scroll anchoring is off until its re-render settles. */
type Hold = {
  observer: MutationObserver;
  quiet: number | undefined;
  fallback: number;
};

const holds = new WeakMap<HTMLElement, Hold>();

/** Views whose unload already lets go of their scroller. */
const releasedOnUnload = new WeakSet<object>();

/** Turn scroll anchoring back on for `scroller`, and stop watching it. */
function release(scroller: HTMLElement): void {
  const hold = holds.get(scroller);
  if (!hold) return;
  holds.delete(scroller);
  hold.observer.disconnect();
  window.clearTimeout(hold.quiet);
  window.clearTimeout(hold.fallback);
  scroller.classList.remove(RERENDERING_CLASS);
}

/**
 * Re-render `view`'s reading view in full, so the post-processors paint every
 * section again, without moving it.
 *
 * A full re-render empties every section at once and refills them in slices.
 * Chromium's scroll anchoring moves `scrollTop` while that happens, often by
 * hundreds of px, and Obsidian, which never turns anchoring off, takes the
 * result as where the reader is. So anchoring stays off for the scroller until
 * the refill goes quiet, and is back on for whatever loads after it.
 *
 * Unofficial: the `.markdown-preview-view` scroller inside
 * `previewMode.containerEl`.
 */
export function rerenderInPlace(view: MarkdownView): void {
  const scroller = view.previewMode.containerEl.querySelector<HTMLElement>(
    '.markdown-preview-view'
  );
  if (!scroller) {
    view.previewMode.rerender(true);
    return;
  }
  // A refresh while the last one is still refilling starts the wait over
  release(scroller);
  scroller.classList.add(RERENDERING_CLASS);
  view.previewMode.rerender(true);

  // Watched only from here: the emptying above is not the refill
  const hold: Hold = {
    observer: new MutationObserver(() => {
      window.clearTimeout(hold.quiet);
      hold.quiet = window.setTimeout(
        () => release(scroller),
        RERENDER_QUIET_MS
      );
    }),
    quiet: undefined,
    // A refill that never shows up, or never goes quiet
    fallback: window.setTimeout(() => release(scroller), RERENDER_FALLBACK_MS),
  };
  hold.observer.observe(scroller, { childList: true, subtree: true });
  holds.set(scroller, hold);

  if (!releasedOnUnload.has(view)) {
    releasedOnUnload.add(view);
    view.register(() => release(scroller));
  }
}
