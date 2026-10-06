/**
 * A ring around the PDF highlight under the mouse, and a pointer cursor over
 * it, as markdown highlights have (task 0053).
 *
 * A PDF's highlight boxes lie under its text layer and take no pointer events
 * (task 0047), so CSS `:hover` never reaches them. Instead the box under the
 * mouse is looked up by where the mouse is, as a click is ({@link
 * highlightUnder}), at most once an animation frame. Nothing is written into
 * pdf.js's text layer: the ring is a class on the plugin's own box, and the
 * cursor a class on the viewer's container that styles.css turns into a
 * pointer over the text layer and canvas.
 */
import { type HighlightBoxWatcher, highlightUnder } from './pdf-highlights';

/** The class of the highlight box under the mouse. */
export const HOVERED_CLASS = 'ir-hovered';
/** The class the viewer's container has while the mouse is over a box. */
export const POINTER_CLASS = 'ir-pdf-highlight-pointer';

/**
 * Follow the mouse over the PDF viewer in `containerEl`, once enabled, and
 * mark the highlight box under it (see the module's comment). The topmost box
 * there wins, as for a click.
 *
 * - Only a mouse hovers: touch and pen moves are let be.
 * - While a button is down the ring stays as it is, so a drag selecting text
 *   neither flickers nor costs anything, and the pointer cursor gives way to
 *   the text's own; both follow the mouse again once the last button is let
 *   go.
 * - `refresh` looks again at where the mouse last was, as does a scroll in the
 *   viewer: boxes drawn afresh, or carried under a mouse at rest.
 * - The mouse leaving the viewer, or disabling it, clears the mark.
 * - Only what is under the point in this viewer counts.
 *
 * Disabled, it listens to nothing at all.
 */
export function createPdfHighlightHover(
  containerEl: HTMLElement
): HighlightBoxWatcher {
  let enabled = false;
  /**
   * Where the mouse last was in the viewer with no button down. None while a
   * button is down, which leaves the mark as it is.
   */
  let point: { x: number; y: number } | null = null;
  let framePending = false;
  let hovered: Element | null = null;

  const mark = (box: Element | null) => {
    // Most moves stay over the same box, or none: restyle nothing. Neither
    // does a toggle that leaves the class as it is
    if (box !== hovered) {
      hovered?.classList.remove(HOVERED_CLASS);
      box?.classList.add(HOVERED_CLASS);
      hovered = box;
    }
    containerEl.classList.toggle(POINTER_CLASS, box !== null);
  };

  const look = () => {
    framePending = false;
    if (!point) return;
    const { x, y } = point;
    const el = containerEl.ownerDocument.elementFromPoint(x, y);
    mark(el && containerEl.contains(el) ? highlightUnder(el, x, y) : null);
  };

  const lookNextFrame = () => {
    if (framePending || !point) return;
    framePending = true;
    // The viewer's own window: a popout paints on its own frames
    containerEl.ownerDocument.defaultView!.requestAnimationFrame(look);
  };

  /** A mouse moved, pressed or let go: follow it while no button is down. */
  const onMouse = (evt: PointerEvent) => {
    if (evt.pointerType !== 'mouse') return;
    if (evt.buttons === 0) {
      point = { x: evt.clientX, y: evt.clientY };
      lookNextFrame();
      return;
    }
    point = null;
    containerEl.classList.remove(POINTER_CLASS);
  };
  const onLeave = (evt: PointerEvent) => {
    if (evt.pointerType !== 'mouse') return;
    point = null;
    mark(null);
  };

  // A scroll doesn't bubble: caught on its way down to the scrolled element
  const scrollOptions = { capture: true, passive: true };
  const listeners = [
    ['pointermove', onMouse],
    ['pointerdown', onMouse],
    ['pointerup', onMouse],
    ['pointerleave', onLeave],
  ] as const;

  return {
    enable(on) {
      if (on === enabled) return;
      enabled = on;
      if (on) {
        for (const [type, listener] of listeners) {
          containerEl.addEventListener(type, listener);
        }
        containerEl.addEventListener('scroll', lookNextFrame, scrollOptions);
        return;
      }
      for (const [type, listener] of listeners) {
        containerEl.removeEventListener(type, listener);
      }
      containerEl.removeEventListener('scroll', lookNextFrame, scrollOptions);
      // A frame already asked for finds no point, and does nothing
      point = null;
      mark(null);
    },
    refresh: lookNextFrame,
  };
}
