import type { EditorView } from '@codemirror/view';

/** How long, at most, a held line is kept in place after its change. */
export const HOLD_MS = 1000;

/**
 * Input by which the user scrolls, edits, or moves elsewhere, which ends a
 * hold at once, wherever in the editor's window it lands: a scrollbar drag,
 * a jump from the sidebar or a hotkey with focus outside the editor scroll
 * it as surely as the wheel does. `mousedown` too, since a press on a
 * scrollbar is not certain to fire `pointerdown`.
 */
export const RELEASE_EVENTS = [
  'wheel',
  'touchstart',
  'pointerdown',
  'mousedown',
  'keydown',
] as const;

/** The top of `pos`'s line, in the units of `scrollTop`. */
const lineTop = (view: EditorView, pos: number) =>
  view.lineBlockAt(pos).top / view.scaleY;

/**
 * Keep the line at `pos` where it is on screen while a change made there
 * renders, rather than whatever line is at the top of the view.
 *
 * CodeMirror keeps the line at the top of the view in place as heights change
 * (its scroll anchor). A change that shrinks a span crossing the top of the
 * view to one line, such as a card's embed in place of its text, leaves that
 * anchor on the text after the span. Live preview then fills the embed in
 * asynchronously, at about the text's height, and the embed grows upward out
 * of view while the text after it stays: the note jumps by the card's height.
 *
 * Call this before dispatching the change, at its start: the line's offset
 * from the top of the view is read now. Call what it returns once the change
 * is dispatched. From then on, the line is put back at that offset after
 * every measure, until {@link HOLD_MS} has passed, the user scrolls, types or
 * clicks anywhere in the window (see {@link RELEASE_EVENTS}), or the document
 * changes again. The hold has no way to tell the embed settling from slower
 * content in it, such as an image, so it lasts the full time unless let go.
 *
 * It is put back in a microtask queued by the measure, once CodeMirror has
 * anchored the view its own way in it: a scroll written in the measure itself
 * would come before that anchoring, which then moves it, and one made in the
 * next frame would leave the jump on screen for a frame. A microtask runs
 * before the frame is painted, whether the measure ran in an animation frame
 * or was forced by a read of the layout.
 *
 * @returns what starts the hold
 */
export function holdLine(view: EditorView, pos: number): () => void {
  const line = view.state.doc.lineAt(pos).from;
  const offset = lineTop(view, line) - view.scrollDOM.scrollTop;
  return () => {
    const doc = view.state.doc;
    const released = new AbortController();
    const win = view.scrollDOM.ownerDocument.defaultView ?? window;
    // Also what lets go of the listeners when the view is gone, and so
    // measures no more
    const timeout = win.setTimeout(() => released.abort(), HOLD_MS);
    const release = () => {
      win.clearTimeout(timeout);
      released.abort();
    };
    for (const type of RELEASE_EVENTS) {
      win.addEventListener(type, release, {
        capture: true,
        passive: true,
        signal: released.signal,
      });
    }
    const held = () => !released.signal.aborted && view.state.doc === doc;
    const restore = (top: number) => {
      if (!held()) {
        release();
        return;
      }
      const scrollTop = top - offset;
      if (Math.abs(view.scrollDOM.scrollTop - scrollTop) > 1) {
        view.scrollDOM.scrollTop = scrollTop;
      }
      view.requestMeasure(request);
    };
    const request = {
      // Not in another document, where the line may be past its end
      read: (view: EditorView) => (held() ? lineTop(view, line) : null),
      write: (top: number | null) => {
        if (top === null) release();
        else queueMicrotask(() => restore(top));
      },
    };
    view.requestMeasure(request);
  };
}
