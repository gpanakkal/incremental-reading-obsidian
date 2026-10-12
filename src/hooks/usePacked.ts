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
  return isPacked(
    laidOutWidths(Array.from(zone.children)),
    columnGap(zone),
    zone.getBoundingClientRect().width
  );
}

/**
 * The room each of `children`, of a flex row, takes along it: its border box
 * and its margins, and none at all for one out of layout (see
 * {@link isZonePacked}).
 */
export function laidOutWidths(children: readonly Element[]): number[] {
  return children
    .filter((child) => child.getClientRects().length > 0)
    .map((child) => {
      const { marginLeft, marginRight } =
        windowOf(child).getComputedStyle(child);
      return (
        child.getBoundingClientRect().width + px(marginLeft) + px(marginRight)
      );
    });
}

/** The flex row's `column-gap`, which is none when `normal`. */
export function columnGap(zone: HTMLElement): number {
  return px(windowOf(zone).getComputedStyle(zone).columnGap);
}

/** A computed length in px; 0 for one that is not a number, like `normal`. */
export function px(value: string): number {
  return Number.parseFloat(value) || 0;
}

/** The window `el` is laid out in, or this one for a windowless document. */
export function windowOf(el: Element): typeof window {
  return el.ownerDocument.defaultView ?? window;
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
  return useLayoutMeasure(ref, false, isZonePacked);
}

/**
 * `measure` of the element under `ref`, kept current as it lays out again —
 * the machinery under {@link usePacked}, which says what it watches and what
 * it asks of the element and its caller.
 *
 * `depth` is how far down the observers reach: 1 watches the element and its
 * children, 2 their children too. `initial` is the answer until the first
 * measurement, and for good where there is no ResizeObserver to keep one
 * current. A measurement of `undefined` — nothing to measure yet — keeps the
 * last answer. A new `measure` or `depth` watches afresh, so pass a function that
 * keeps its identity — a module-level one, say.
 *
 * `bodyClass` measures again whenever the classes on the window's <body>
 * change too, for a `measure` that reads them: Obsidian flags the platform
 * there, and can change it with no box under `ref` changing size.
 */
export function useLayoutMeasure<T>(
  ref: RefObject<HTMLElement | null>,
  initial: T,
  measure: (el: HTMLElement) => T | undefined,
  depth = 1,
  { bodyClass = false }: { bodyClass?: boolean } = {}
): T {
  const [value, setValue] = useState(initial);

  useLayoutEffect(() => {
    const zone = ref.current;
    if (!zone) return;

    const watch = (win: typeof window | null) =>
      watchLayout(zone, win, depth, bodyClass, () => {
        const measured = measure(zone);
        if (measured !== undefined) setValue(measured);
      });
    let stop = watch(zone.ownerDocument.defaultView);
    // Obsidian's own DOM extension, which a test document lacks. A tab moved
    // to a popout keeps its DOM, and an observer goes on reporting only the
    // layouts of the window it was made in.
    const stopMigrated =
      typeof (zone.onWindowMigrated as unknown) === 'function'
        ? zone.onWindowMigrated((win) => {
            stop();
            stop = watch(win.document.defaultView);
          })
        : null;
    return () => {
      stop();
      stopMigrated?.();
    };
  }, [ref, measure, depth, bodyClass]);

  return value;
}

/**
 * Call `onLayout` now and whenever `root` may have laid out anew, with
 * observers from `win`: whenever it, or anything down to `depth` levels below
 * it, resizes or comes and goes — and with `bodyClass`, whenever the classes
 * on `win`'s <body> change. Returns what stops it.
 */
function watchLayout(
  root: HTMLElement,
  win: typeof window | null,
  depth: number,
  bodyClass: boolean,
  onLayout: () => void
): () => void {
  if (typeof win?.ResizeObserver !== 'function') return () => {};

  // A zone out of layout — its tab in the background — measures 0px wide,
  // which says nothing about the row it is in once shown again
  const measure = () => {
    if (root.getClientRects().length > 0) onLayout();
  };
  const resizes = new win.ResizeObserver(measure);
  const observeAll = () => {
    resizes.disconnect();
    let level: Element[] = [root];
    for (let i = 0; i <= depth; i++) {
      for (const el of level) resizes.observe(el, { box: 'border-box' });
      level = level.flatMap((el) => Array.from(el.children));
    }
  };
  const childChanges = new win.MutationObserver(() => {
    observeAll();
    measure();
  });

  observeAll();
  // The whole subtree, though only `depth` levels are watched for size: a
  // change below them is rare, and costs no more than a measurement
  childChanges.observe(root, { childList: true, subtree: true });
  const bodyChanges = new win.MutationObserver(measure);
  if (bodyClass) {
    bodyChanges.observe(win.document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  measure();
  return () => {
    resizes.disconnect();
    childChanges.disconnect();
    bodyChanges.disconnect();
  };
}
