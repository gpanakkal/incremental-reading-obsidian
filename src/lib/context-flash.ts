import {
  CONTEXT_FADE_MS,
  CONTEXT_SCROLL_WAIT_MS,
  flashRanges,
} from '#/lib/extensions/ContextFlashExtension';
import type { EditorView } from '@codemirror/view';
import { MarkdownView, type View } from 'obsidian';
import type { ItemContext } from './item-context';
import { arrivalRanges } from './review-position';
import type { ReviewSnippet } from './types';

/** Eases a flashed element's colors (styles.css). */
const FLASH_CLASS = 'ir-context-flash';
/** Lights a flashed element. */
const LIT_CLASS = 'ir-context-flash-lit';

/** Ends the flash showing in a reading view at once, by the view's root. */
const showing = new WeakMap<HTMLElement, () => void>();

/**
 * Flash the elements `find` answers in `root`, a reading view, once they have
 * been scrolled to: eased in over {@link CONTEXT_FADE_MS}, then out over as
 * long, in place of any flash still showing there.
 *
 * Scrolled to: one of them overlaps the box of the view's scroller (its
 * `.markdown-preview-view`, or `root` itself without one), and the first that
 * does is where it was the frame before. Checked each animation frame from the
 * first after the call. The view paints its sections, and the plugin its
 * highlights in them, some time after it opens, and scrolls to the passage
 * once they are painted; targets not painted or not scrolled to yet are waited
 * for, for up to {@link CONTEXT_SCROLL_WAIT_MS} from that first frame, and
 * none flash after that. The view paints them again as they scroll back into
 * view: any painted again while they are lit are lit too.
 *
 * While they are lit, the view's own flash of the block a link lands in
 * (`is-flashing`, which it lights for a `match` as well) is put out, for the
 * targets to stand out in it.
 */
export function flashElements(
  root: HTMLElement,
  find: (root: HTMLElement) => HTMLElement[]
): void {
  showing.get(root)?.();
  const win = root.ownerDocument.defaultView ?? window;
  const timers: number[] = [];
  let frame: number | null = null;
  const after = (ms: number, fn: () => void) =>
    timers.push(win.setTimeout(fn, ms));
  const unmark = (cls: string) => {
    for (const el of root.querySelectorAll(`.${cls}`)) el.classList.remove(cls);
  };
  // Not for a batch of only its own lighting, which would find nothing new
  const observer = new MutationObserver((records) => {
    const ownOnly = records.every(
      (record) =>
        record.type === 'attributes' &&
        (record.target as Element).classList.contains(LIT_CLASS)
    );
    if (!ownOnly) light(find(root));
  });
  const end = () => {
    observer.disconnect();
    for (const timer of timers) win.clearTimeout(timer);
    if (frame !== null) win.cancelAnimationFrame(frame);
    unmark(LIT_CLASS);
    unmark(FLASH_CLASS);
    showing.delete(root);
  };

  const light = (targets: HTMLElement[]) => {
    for (const el of targets) {
      if (!el.classList.contains(LIT_CLASS)) {
        el.classList.add(FLASH_CLASS, LIT_CLASS);
      }
    }
    unmark('is-flashing');
  };

  const scroller =
    root.querySelector<HTMLElement>(':scope > .markdown-preview-view') ?? root;
  let lastTop: number | null = null;
  /** Whether the first target on screen is where it was the frame before. */
  const scrolledTo = (targets: HTMLElement[]) => {
    const box = scroller.getBoundingClientRect();
    const drawn = targets
      .map((el) => el.getBoundingClientRect())
      .find((at) => at.bottom > box.top && at.top < box.bottom);
    const top = drawn ? drawn.top : null;
    const settled = top !== null && top === lastTop;
    lastTop = top;
    return settled;
  };

  let waitUntil: number | null = null;
  const check = () => {
    frame = win.requestAnimationFrame(() => {
      frame = null;
      // From the first frame: time the page spent busy before it is not time
      // the view had to scroll
      waitUntil ??= Date.now() + CONTEXT_SCROLL_WAIT_MS;
      const targets = find(root);
      if (scrolledTo(targets)) {
        light(targets);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        });
        after(CONTEXT_FADE_MS, () => {
          observer.disconnect();
          unmark(LIT_CLASS);
          after(CONTEXT_FADE_MS, end);
        });
      } else if (Date.now() < waitUntil) {
        check();
      } else {
        end();
      }
    });
  };

  showing.set(root, end);
  check();
}

/**
 * `snippet`'s highlight in `root`, a reading view, wherever the view paints
 * it. Not one inside an embed, which shows another note.
 */
function snippetHighlights(
  snippet: ReviewSnippet,
  root: HTMLElement
): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('.ir-snippet-highlight'),
  ].filter(
    (el) =>
      el.getAttribute('data-snippet-id') === snippet.data.id &&
      !el.closest('.internal-embed .ir-snippet-highlight')
  );
}

/**
 * Flash, in the note tab `view` Go to context opened `snippet`'s context in,
 * the passage it opened at, in place of the highlight Obsidian leaves there.
 *
 * Obsidian marks a `match` it opens a note at until the next click in an
 * editor (`highlightSearchMatches`, obsidian.asar 1.13), over the snippet's
 * own highlight, which is then hard to read; its reading view flashes the
 * block the match is in. Here the range flashes in an editor, and in reading
 * view the snippet's highlight does.
 *
 * Nothing flashes in a tab that is not showing the context: one whose
 * `openFile` was still busy with another file, which Obsidian then ignores.
 *
 * `removeHighlights` and `editor.cm` are undocumented: the editor's
 * highlights of a class, and its CodeMirror view.
 */
export function flashSnippetContext(
  view: View,
  snippet: ReviewSnippet,
  { file, eState }: Pick<ItemContext, 'file' | 'eState'>
): void {
  if (!(view instanceof MarkdownView) || !eState) return;
  if (view.file?.path !== file.path) return;
  if (view.getMode() === 'preview') {
    flashElements(view.previewMode.containerEl, (root) =>
      snippetHighlights(snippet, root)
    );
    return;
  }
  const { editor } = view;
  const ranges = arrivalRanges(eState, editor.getValue().length, () => null);
  if (ranges.length === 0) return;
  editor.removeHighlights('is-flashing');
  // obsidian-typings types `cm` against CodeMirror's CommonJS declarations,
  // which TypeScript keeps apart from the ES ones imported here
  flashRanges(editor.cm as unknown as EditorView, ranges);
}
