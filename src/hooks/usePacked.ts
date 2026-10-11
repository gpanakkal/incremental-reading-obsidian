import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * Slack, in px, a zone may have and still count as packed. Widths are
 * fractional and a zone's own box is laid out to the nearest layout unit, so
 * one that is exactly as wide as its children can measure a hair either way.
 */
const PACKED_TOLERANCE_PX = 1;

/**
 * Whether a flex row has shrunk to its content: its children, and the gap
 * between each pair of them, take its whole width.
 *
 * A zone that may grow but never shrinks past its content (`flex: 1 1 0` with
 * `min-width: auto`) is wider than that only while the row has room to spare,
 * so this is also whether its neighbours have been pushed up against it.
 *
 * @param childWidths the room each child that takes part in layout takes
 *   along the row, margins included — none for a child that is
 *   `display: none`, which takes no gap either
 * @param gap the row's `column-gap`
 * @param zoneWidth the row's own width
 */
export function isPacked(
  childWidths: readonly number[],
  gap: number,
  zoneWidth: number
): boolean {
  const gaps = gap * Math.max(0, childWidths.length - 1);
  const content = childWidths.reduce((sum, width) => sum + width, gaps);
  return content >= zoneWidth - PACKED_TOLERANCE_PX;
}

/**
 * {@link isPacked}, measured off `zone` as it is laid out now.
 *
 * Each child takes its border box and its margins — a theme may give the
 * buttons some. A child with no client rects is `display: none`, and takes
 * neither room nor a gap; one that is only `visibility: hidden` still takes
 * both, as it does in layout. A `column-gap` of `normal` is no gap in a flex
 * row.
 */
export function isZonePacked(zone: HTMLElement): boolean {
  const win = zone.ownerDocument.defaultView ?? window;
  const px = (value: string) => Number.parseFloat(value) || 0;
  const widths = Array.from(zone.children)
    .filter((child) => child.getClientRects().length > 0)
    .map((child) => {
      const { marginLeft, marginRight } = win.getComputedStyle(child);
      return (
        child.getBoundingClientRect().width + px(marginLeft) + px(marginRight)
      );
    });
  const gap = px(win.getComputedStyle(zone).columnGap);
  return isPacked(widths, gap, zone.getBoundingClientRect().width);
}

/**
 * Whether the element under `ref` is packed ({@link isZonePacked}), kept
 * current as it lays out again.
 *
 * Its own box changes whenever its row's free space does — the row resized, a
 * neighbour grew — and each child's box when the child changes width or goes
 * in or out of `display: none`, which is everything the answer reads but the
 * gap. So both are observed, border boxes as the answer sums them, and the
 * children again as they come and go. Measured once up front too, before the
 * first paint, rather than a frame late from the observer's first report.
 *
 * Whatever the caller does with the answer must not change any of those
 * widths, or the two would chase each other across the threshold — show and
 * hide with `visibility`, say, never `display`.
 *
 * The element must be mounted with the component and stay so: the hook reads
 * the ref once, after the first render. It may move to another window, as a
 * tab does, and is watched from there. Obsidian's `onWindowMigrated` hears of
 * the move by a class it adds to the element, `node-insert-event`, whose CSS
 * animation fires on insertion — undocumented internals, read from its
 * source. So the element's `className` must not be rendered anew while it is
 * mounted, which would wipe that class: toggle classes on it instead.
 */
export function usePacked(ref: RefObject<HTMLElement | null>): boolean {
  const [packed, setPacked] = useState(false);

  useLayoutEffect(() => {
    const zone = ref.current;
    if (!zone) return;

    let stop = watchZone(zone, zone.ownerDocument.defaultView, setPacked);
    // Obsidian's own DOM extension, which a test document lacks. A tab moved
    // to a popout keeps its DOM, and an observer goes on reporting only the
    // layouts of the window it was made in.
    const stopMigrated =
      typeof (zone.onWindowMigrated as unknown) === 'function'
        ? zone.onWindowMigrated((win) => {
            stop();
            stop = watchZone(zone, win.document.defaultView, setPacked);
          })
        : null;
    return () => {
      stop();
      stopMigrated?.();
    };
  }, [ref]);

  return packed;
}

/**
 * Report whether `zone` is packed, now and whenever it may have changed, with
 * observers from `win`. Returns what stops it.
 */
function watchZone(
  zone: HTMLElement,
  win: typeof window | null,
  report: (packed: boolean) => void
): () => void {
  if (typeof win?.ResizeObserver !== 'function') return () => {};

  // A zone out of layout — its tab in the background — measures 0px wide,
  // which says nothing about the row it is in once shown again
  const measure = () => {
    if (zone.getClientRects().length > 0) report(isZonePacked(zone));
  };
  const resizes = new win.ResizeObserver(measure);
  const observeAll = () => {
    resizes.disconnect();
    for (const el of [zone, ...Array.from(zone.children)]) {
      resizes.observe(el, { box: 'border-box' });
    }
  };
  const childChanges = new win.MutationObserver(() => {
    observeAll();
    measure();
  });

  observeAll();
  childChanges.observe(zone, { childList: true });
  measure();
  return () => {
    resizes.disconnect();
    childChanges.disconnect();
  };
}
