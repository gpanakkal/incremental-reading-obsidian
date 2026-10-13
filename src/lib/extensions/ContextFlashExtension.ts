import type { OffsetRange } from '#/lib/review-position';
import {
  type Extension,
  StateEffect,
  type StateEffectType,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * How long the light takes to ease in, and then to ease out again, in
 * milliseconds: the transition of `.ir-context-flash` in styles.css.
 */
export const CONTEXT_FADE_MS = 750;

/**
 * How long a flash waits for its place to be scrolled on screen before it is
 * dropped, in milliseconds.
 */
export const CONTEXT_SCROLL_WAIT_MS = 3000;

/**
 * Marks each of the ranges, unlit, in place of any flash before, for the
 * light to ease in on once they are on screen.
 */
export const contextFlashEffect = StateEffect.define<readonly OffsetRange[]>();

/** Lights the marks. */
const lightContextFlashEffect = StateEffect.define<null>();

/** Puts the light out, leaving the marks for their colors to ease out on. */
const fadeContextFlashEffect = StateEffect.define<null>();

/** Drops the marks, by then unlit. */
const clearContextFlashEffect = StateEffect.define<null>();

/** The flash's marks, and whether they are lit. */
type ContextFlash = { marks: DecorationSet; lit: boolean };

const flashMark = Decoration.mark({ class: 'ir-context-flash' });

const NO_FLASH: ContextFlash = { marks: Decoration.none, lit: false };

const LIT_ATTRIBUTES: Record<string, string> = { class: 'ir-context-flashing' };
const NO_ATTRIBUTES: Record<string, string> = {};

/**
 * The marks over the place Go to context opened, lit for a moment.
 *
 * Lit by a class on the editor rather than on the marks: CodeMirror redraws a
 * mark that scrolls out of view and back, and a redrawn mark that played its
 * own animation would play it again. One drawn under a lit editor comes up
 * lit, and the light goes out the moment the class does, wherever the marks
 * are.
 */
export const contextFlashField = StateField.define<ContextFlash>({
  create: () => NO_FLASH,
  update(flash, tr) {
    // Most transactions, in most editors, have no flash to touch
    if (tr.effects.length === 0 && (!tr.docChanged || flash.marks.size === 0)) {
      return flash;
    }
    let next: ContextFlash = {
      marks: flash.marks.map(tr.changes),
      lit: flash.lit,
    };
    for (const effect of tr.effects) {
      if (effect.is(contextFlashEffect)) {
        next = { marks: marksOver(effect.value, tr.newDoc.length), lit: false };
      } else if (effect.is(lightContextFlashEffect)) {
        next = { marks: next.marks, lit: true };
      } else if (effect.is(fadeContextFlashEffect)) {
        next = { marks: next.marks, lit: false };
      } else if (effect.is(clearContextFlashEffect)) {
        next = NO_FLASH;
      }
    }
    return next;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (flash) => flash.marks),
    EditorView.editorAttributes.from(field, (flash) =>
      flash.lit ? LIT_ATTRIBUTES : NO_ATTRIBUTES
    ),
  ],
});

/** `a` to `b` kept inside a document `length` long, the lesser first. */
function inside(a: number, b: number, length: number): OffsetRange {
  const clamp = (n: number) => Math.min(Math.max(n, 0), length);
  const [from, to] = [clamp(a), clamp(b)].sort((x, y) => x - y);
  return { from, to };
}

/** A mark over each range with text in it, kept inside a document `length` long. */
function marksOver(ranges: readonly OffsetRange[], length: number) {
  return Decoration.set(
    ranges.flatMap(({ from, to }) => {
      const range = inside(from, to, length);
      return range.from < range.to
        ? [flashMark.range(range.from, range.to)]
        : [];
    }),
    true
  );
}

/**
 * Lights the flash once its place has been scrolled to, then puts the light
 * out and drops the marks, on time.
 *
 * Scrolled to: the start or the end of the range handed over first — the one
 * the editor scrolls to — is drawn within the scroller's box, and where it was
 * drawn the frame before. Checked each animation frame from the first after
 * the flash, for up to {@link CONTEXT_SCROLL_WAIT_MS} from then; one not
 * scrolled to by then is dropped unlit.
 */
const contextFlashTimer = ViewPlugin.fromClass(
  class ContextFlashTimer {
    private view: EditorView;
    private win: Window;
    private timeouts: number[] = [];
    private frame: number | null = null;
    /** The range the flash waits on, mapped through edits meanwhile. */
    private target: OffsetRange | null = null;
    /** Where the target was drawn the frame before, if on screen. */
    private lastTop: number | null = null;
    private waitUntil: number | null = null;

    constructor(view: EditorView) {
      this.view = view;
      // The view's own window, so a popped-out tab's timer is its own
      this.win = view.dom.ownerDocument.defaultView ?? window;
    }

    update(update: ViewUpdate) {
      if (this.target && update.docChanged) {
        this.target = {
          from: update.changes.mapPos(this.target.from),
          to: update.changes.mapPos(this.target.to),
        };
      }
      const flash = update.transactions
        .flatMap((tr) => tr.effects)
        .filter((effect) => effect.is(contextFlashEffect))
        .pop();
      if (!flash) return;
      this.cancel();
      const length = update.state.doc.length;
      this.target =
        flash.value
          .map(({ from, to }) => inside(from, to, length))
          .find(({ from, to }) => from < to) ?? null;
      if (!this.target) return;
      this.lastTop = null;
      this.waitUntil = null;
      this.nextFrame();
    }

    private nextFrame() {
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = null;
        // From the first frame: time the page spent busy before it is not
        // time the editor had to scroll
        this.waitUntil ??= Date.now() + CONTEXT_SCROLL_WAIT_MS;
        if (this.scrolledTo()) {
          this.dispatch(lightContextFlashEffect);
          this.after(CONTEXT_FADE_MS, () => {
            this.dispatch(fadeContextFlashEffect);
            this.after(CONTEXT_FADE_MS, () =>
              this.dispatch(clearContextFlashEffect)
            );
          });
        } else if (Date.now() < this.waitUntil) {
          this.nextFrame();
        } else {
          this.dispatch(clearContextFlashEffect);
        }
      });
    }

    /**
     * Whether the target is drawn within the scroller's box, where it was
     * the frame before.
     */
    private scrolledTo() {
      if (!this.target) return false;
      const box = this.view.scrollDOM.getBoundingClientRect();
      const drawn = [this.target.from, this.target.to]
        .map((pos) => this.view.coordsAtPos(pos))
        .find(
          (at) => at !== null && at.bottom > box.top && at.top < box.bottom
        );
      const top = drawn ? drawn.top : null;
      const settled = top !== null && top === this.lastTop;
      this.lastTop = top;
      return settled;
    }

    private dispatch(effect: StateEffectType<null>) {
      this.view.dispatch({ effects: effect.of(null) });
    }

    private after(ms: number, fn: () => void) {
      this.timeouts.push(this.win.setTimeout(fn, ms));
    }

    destroy() {
      this.cancel();
    }

    private cancel() {
      for (const timeout of this.timeouts.splice(0)) {
        this.win.clearTimeout(timeout);
      }
      if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
);

/**
 * Flash the passage Go to context opened in an editor once it has been
 * scrolled to: eased in over {@link CONTEXT_FADE_MS}, then out again over as
 * long.
 */
export const contextFlashExtension: Extension = [
  contextFlashField,
  contextFlashTimer,
];

/** Flash `ranges` in `view`, in place of any flash still showing. */
export function flashRanges(
  view: EditorView,
  ranges: readonly OffsetRange[]
): void {
  view.dispatch({ effects: contextFlashEffect.of(ranges) });
}
