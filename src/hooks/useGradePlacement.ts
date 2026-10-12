import { GRADE_GROUP_CLASS } from '#/components/action-bar/GradeGroup';
import type { RefObject } from 'react';
import {
  columnGap,
  isPacked,
  laidOutWidths,
  px,
  useLayoutMeasure,
  windowOf,
} from './usePacked';

/**
 * Where the review bar shows a card's grades: in its middle zone, or in a row
 * of their own beside the bar, between it and the card.
 */
export type GradePlacement = 'inline' | 'row';

/**
 * On the wrapper, last in the bar, around the copy of the grade group laid out
 * only to be measured. styles.css takes it out of the bar's layout — absolute,
 * 0×0, clipped, hidden — so it moves nothing, while the group inside keeps the
 * width it would have inline.
 */
export const GRADE_GHOST_CLASS = 'ir-grade-ghost';

/** A flex row as a placement reads it: its children's widths, and its gap. */
export type ZoneLayout = { widths: readonly number[]; gap: number };

/**
 * The bar as a placement reads it. Nothing in it depends on where the grades
 * are: the middle zone leaves them out, and their width is the ghost's.
 */
export type BarLayout = {
  /** The bar's content box, padding and border off its width. */
  width: number;
  /** The gap between the bar's zones. */
  gap: number;
  lead: ZoneLayout;
  /** The middle zone's children other than the grades. */
  center: ZoneLayout;
  trail: ZoneLayout;
  /** The grade group's width inline, margins included. */
  grades: number;
};

/**
 * Whether the grades fit inline: with them first in the middle zone, the two
 * outer zones would still not be packed ({@link isPacked}), the check that
 * decides whether undo and the middle zone's first button meet.
 *
 * The outer zones split the width the middle zone and the gaps leave them
 * evenly (see styles.css), so each would get half of it.
 */
export function gradesFitInline(bar: BarLayout): boolean {
  const { widths, gap } = bar.center;
  const center =
    widths.reduce((sum, width) => sum + width, bar.grades) +
    gap * widths.length;
  const outer = (bar.width - center - 2 * bar.gap) / 2;
  return (
    !isPacked(bar.lead.widths, bar.lead.gap, outer) &&
    !isPacked(bar.trail.widths, bar.trail.gap, outer)
  );
}

/**
 * {@link BarLayout} of `bar` as laid out now, or null while there is no ghost
 * grade group in it to measure.
 */
export function measureBar(bar: HTMLElement): BarLayout | null {
  const zone = (name: string) =>
    bar.querySelector<HTMLElement>(`:scope > .ir-bar-${name}`);
  const lead = zone('lead');
  const center = zone('center');
  const trail = zone('trail');
  const ghost = bar.querySelector(
    `:scope > .${GRADE_GHOST_CLASS} > .${GRADE_GROUP_CLASS}`
  );
  const [grades] = ghost ? laidOutWidths([ghost]) : [];
  if (!lead || !center || !trail || grades === undefined) return null;

  const row = (el: HTMLElement, children = Array.from(el.children)) => ({
    widths: laidOutWidths(children),
    gap: columnGap(el),
  });
  const style = windowOf(bar).getComputedStyle(bar);
  const sides = [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  ].reduce((sum, value) => sum + px(value), 0);
  return {
    width: bar.getBoundingClientRect().width - sides,
    gap: columnGap(bar),
    lead: row(lead),
    center: row(
      center,
      Array.from(center.children).filter(
        (child) => !child.classList.contains(GRADE_GROUP_CLASS)
      )
    ),
    trail: row(trail),
    grades,
  };
}

/**
 * Where the grades go in `bar` as laid out now: inline when they fit
 * ({@link gradesFitInline}), else their own row — and always the row on a
 * phone, which never has the room. Undefined while there are no grades to
 * measure.
 *
 * `is-phone` is Obsidian's own class on <body> (undocumented; obsidian.asar
 * 1.13.7 toggles it from a `(min-width: 600px) and (min-height: 600px)` media
 * query's `change`, debounced 10ms), read rather than `Platform.isPhone` so
 * the placement follows the same class the CSS does.
 */
export function gradePlacement(bar: HTMLElement): GradePlacement | undefined {
  if (bar.ownerDocument.body.classList.contains('is-phone')) return 'row';
  const layout = measureBar(bar);
  if (!layout) return undefined;
  return gradesFitInline(layout) ? 'inline' : 'row';
}

/**
 * {@link gradePlacement} of the review bar under `ref`, kept current as it
 * lays out again (see `useLayoutMeasure`).
 *
 * Watched two levels down: the zones, and the buttons in them and the ghost
 * group, whose widths are everything the answer reads. None of those depend
 * on the answer — the middle zone is measured without the grades, the ghost
 * stays put — so moving the grades can never move them back, and the bar
 * cannot flicker between the two at the threshold.
 *
 * `body.is-phone` is watched as well: it flips a little after the resize that
 * flips it, and a window that only changes height can flip it with no box
 * in the bar changing size.
 *
 * Between cards, with no grades to measure, it keeps the last placement:
 * the bar rarely changes from one card to the next, so the grades the next
 * Show answer brings up are placed right from their first render. Before any
 * grades at all, and wherever the bar cannot be watched, it is the row,
 * which is never out of reach.
 */
export function useGradePlacement(
  ref: RefObject<HTMLElement | null>
): GradePlacement {
  return useLayoutMeasure(ref, 'row', gradePlacement, 2, { bodyClass: true });
}
