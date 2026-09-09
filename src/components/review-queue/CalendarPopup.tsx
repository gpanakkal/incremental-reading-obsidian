import { isSameDay, startOfDay } from '#/lib/utils';
import {
  createPortal,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * Fixed six-week grid. A month needs five weeks or six depending on where its
 * first day lands, and letting the row count follow it would resize the popup
 * as the user pages through months.
 */
const WEEKS_SHOWN = 6;
const DAYS_PER_WEEK = 7;

/** Gap between the popup and both its anchor and the viewport edge, in px. */
const VIEWPORT_MARGIN = 8;

// Spelled out rather than derived from `Intl.DateTimeFormat`. Nothing else in
// the plugin formats dates by locale — `formatQueueDate` in `columns.tsx`
// emits `2026/7/10` on every machine — so a locale-aware calendar would be the
// one place whose wording moved under the user. Fixed names are also the same
// in the two engines this runs in, and in tests.
const WEEKDAY_ABBREVIATIONS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

interface CalendarPopupProps {
  /** The day to open on and mark as chosen. Today, when omitted. */
  value?: Date;
  /**
   * The review day in progress, which "Today" selects and the grid rings.
   * Passed in rather than read from the clock: a review day is the calendar
   * day shifted by the user's rollover offset, so under a +4h offset the
   * current review day at 01:00 is yesterday's date. Only the queue knows the
   * offset.
   */
  today: Date;
  /** Earliest selectable day. Omitted when the queue has no lower bound. */
  min?: Date;
  /** Latest selectable day. Omitted when the queue has no upper bound. */
  max?: Date;
  /** A day was chosen. The parent jumps to it and closes the popup. */
  onSelect: (day: Date) => void;
  /** Cancel, Escape, or a click outside. The parent closes without jumping. */
  onDismiss: () => void;
  /**
   * The element the popup positions itself against. Passed as a ref rather
   * than a node: the popup mounts in the same render that opens it, before the
   * parent's own ref has anything to read.
   */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * The element the calendar is rendered into, out of the field's own subtree.
   * See `DateJumpField`: the review view both clips and re-parents a popup
   * left where it was written.
   */
  container: HTMLElement;
}

/** The 42 days of a month's six-week grid, starting on the Sunday it opens. */
export function buildMonthGrid(month: Date) {
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  // `getDay()` is the weekday of the 1st, so this many days of the previous
  // month lead the grid. Day-of-month arithmetic below zero and past the end
  // rolls into the neighbouring month on its own.
  const firstShown = 1 - firstOfMonth.getDay();
  const days: Date[] = [];
  for (let offset = 0; offset < WEEKS_SHOWN * DAYS_PER_WEEK; offset++) {
    days.push(
      new Date(month.getFullYear(), month.getMonth(), firstShown + offset)
    );
  }
  return days;
}

/**
 * Move `day` by whole months, holding the day of the month where the target
 * has one. Jan 31 back a month is Feb 28, not Mar 3 — the date the raw
 * constructor would roll over to.
 */
function addMonths(day: Date, months: number) {
  const year = day.getFullYear();
  const month = day.getMonth() + months;
  // Day 0 of the following month is the last day of this one.
  const daysInTarget = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day.getDate(), daysInTarget));
}

/** Move `day` by whole days. */
function addDays(day: Date, days: number) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

/**
 * Whether `day` falls outside `[min, max]`. Both bounds are compared on the
 * calendar day, so a bound carrying a time of day cannot rule out its own day.
 */
function isOutOfRange(day: Date, min?: Date, max?: Date) {
  if (min && day.getTime() < startOfDay(min).getTime()) return true;
  if (max && day.getTime() > startOfDay(max).getTime()) return true;
  return false;
}

/**
 * A month calendar anchored to the date field, replacing the picker the
 * browser would otherwise draw.
 *
 * The native picker was unusable on iOS — WebKit's own Reset and confirm
 * buttons, no adjacent-month days, and a selection that desynced from the
 * input — and unstylable on both platforms, since neither engine's picker
 * accepts page CSS. Owning it is the only way the two can match.
 *
 * Choosing a day commits immediately; there is deliberately no confirm button.
 * Cancel, Escape, and a click outside all dismiss without choosing.
 */
export function CalendarPopup({
  value,
  today,
  min,
  max,
  onSelect,
  onDismiss,
  anchorRef,
  container,
}: CalendarPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  /**
   * The day the arrow keys sit on, and the only day in the grid reachable by
   * tab. It doubles as the month cursor: the grid renders whichever month this
   * day falls in, so paging and moving the selection cannot disagree.
   */
  const [focusedDay, setFocusedDay] = useState(() =>
    startOfDay(value ?? today)
  );
  /**
   * Whether the focused day should actually take DOM focus on the next render.
   * Set by opening and by the keys that move the cursor, but not by the month
   * arrows: those move the grid under a mouse user whose focus belongs on the
   * arrow they are clicking.
   */
  const focusPendingRef = useRef(true);

  /**
   * Place the popup under its anchor, clamped inside the viewport and flipped
   * above when there is no room below.
   *
   * Fixed to the viewport rather than positioned inside the controls bar: the
   * review view's `.view-content` is `overflow: hidden`, which would clip an
   * in-flow popup, and fixed coordinates make the clamp a matter of comparing
   * against `innerWidth`/`innerHeight` rather than of tracking offset parents.
   *
   * A layout effect, so the measure-then-place happens before the browser
   * paints and the popup is never seen in the wrong spot.
   *
   * Written onto the node rather than held in state. The position can only be
   * known by measuring a popup that is already in the document, so routing it
   * through state would mean rendering every open twice — and the render that
   * moved it would be the one that also re-ran the focus effect below.
   */
  useLayoutEffect(() => {
    function place() {
      const popup = popupRef.current;
      const anchor = anchorRef.current;
      if (!popup || !anchor) return;

      const bounds = anchor.getBoundingClientRect();
      const { offsetWidth: width, offsetHeight: height } = popup;

      // `Math.max` guards the case where the popup is wider than the viewport:
      // the clamp's upper limit would fall below its lower one, and pinning to
      // the left edge at least keeps the start of it on screen.
      const rightmost = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - width - VIEWPORT_MARGIN
      );
      const left = Math.min(Math.max(bounds.left, VIEWPORT_MARGIN), rightmost);

      const below = bounds.bottom + VIEWPORT_MARGIN;
      const fitsBelow = below + height + VIEWPORT_MARGIN <= window.innerHeight;
      const top = fitsBelow
        ? below
        : Math.max(VIEWPORT_MARGIN, bounds.top - height - VIEWPORT_MARGIN);

      popup.style.top = `${top}px`;
      popup.style.left = `${left}px`;
      // Revealed only now, by a class rather than an inline style so the
      // hidden and placed states both live in the stylesheet. The popup has to
      // be in the document to be measured at all, and the `visibility` that
      // hides it until this point keeps its box — and so its size — where
      // `display: none` would leave nothing to measure.
      popup.classList.add('ir-calendar-placed');
    }

    place();
    // Only resize: the controls bar holding the anchor sits outside the
    // table's scroll container, so nothing scrolls it out from under the
    // popup. Orientation changes on a phone arrive as a resize.
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  /**
   * Dismiss on a press anywhere outside the popup.
   *
   * A layout effect, so the listener is attached the moment the popup is
   * committed. A plain effect would run after the first paint, leaving a frame
   * in which the calendar is on screen and a press outside it does nothing.
   */
  useLayoutEffect(() => {
    function handlePressOutside(event: MouseEvent) {
      const popup = popupRef.current;
      if (!popup) return;
      const target = event.target as Node;
      // The anchor is excluded so that pressing the trigger while the popup is
      // open dismisses it once, rather than closing it here and reopening it
      // on the click that follows.
      if (popup.contains(target) || anchorRef.current?.contains(target)) return;
      onDismiss();
    }

    // `mousedown` rather than `click`, matching the document-level handlers in
    // `main.ts`. Taps synthesise it, and closing on press feels immediate in a
    // way that waiting for the release does not.
    document.addEventListener('mousedown', handlePressOutside);
    return () => document.removeEventListener('mousedown', handlePressOutside);
  }, [anchorRef, onDismiss]);

  /**
   * Give the focused day real DOM focus once the keys have asked for it.
   * Before paint, so the focus ring is never seen a frame behind the key that
   * moved it.
   */
  useLayoutEffect(() => {
    if (!focusPendingRef.current) return;
    focusPendingRef.current = false;
    popupRef.current
      ?.querySelector<HTMLElement>('.ir-calendar-day[tabindex="0"]')
      ?.focus();
  }, [focusedDay]);

  /** Move the cursor and take focus with it. */
  function moveFocus(day: Date) {
    focusPendingRef.current = true;
    setFocusedDay(day);
  }

  function choose(day: Date) {
    if (isOutOfRange(day, min, max)) return;
    onSelect(day);
  }

  function handleGridKeyDown(event: KeyboardEvent) {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focusedDay, -1),
      ArrowRight: () => addDays(focusedDay, 1),
      ArrowUp: () => addDays(focusedDay, -DAYS_PER_WEEK),
      ArrowDown: () => addDays(focusedDay, DAYS_PER_WEEK),
      Home: () => addDays(focusedDay, -focusedDay.getDay()),
      End: () => addDays(focusedDay, DAYS_PER_WEEK - 1 - focusedDay.getDay()),
      PageUp: () => addMonths(focusedDay, -1),
      PageDown: () => addMonths(focusedDay, 1),
    };

    const move = moves[event.key];
    if (move) {
      // Arrows would otherwise scroll the queue behind the popup, and
      // Home/End would jump it to the ends.
      event.preventDefault();
      moveFocus(move());
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(focusedDay);
    }
  }

  const viewYear = focusedDay.getFullYear();
  const viewMonth = focusedDay.getMonth();
  const days = buildMonthGrid(focusedDay);
  const weeks: Date[][] = [];
  for (let week = 0; week < WEEKS_SHOWN; week++) {
    weeks.push(days.slice(week * DAYS_PER_WEEK, (week + 1) * DAYS_PER_WEEK));
  }

  // A month arrow is dead when nothing in the month it leads to is reachable.
  // Measured against that month's nearest edge: the last day of the previous
  // month is the closest the queue's start can be approached from behind.
  const previousMonthEnd = new Date(viewYear, viewMonth, 0);
  const nextMonthStart = new Date(viewYear, viewMonth + 1, 1);
  const canPageBack = !isOutOfRange(previousMonthEnd, min, max);
  const canPageForward = !isOutOfRange(nextMonthStart, min, max);

  return createPortal(
    <div
      ref={popupRef}
      className="ir-calendar"
      role="dialog"
      aria-label="Choose a date"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // The queue's own view would otherwise take the Escape as a request to
        // close the pane behind the popup.
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
    >
      <div className="ir-calendar-header">
        {/* Text arrows rather than icons, matching the pager beside this on
            the same controls bar. */}
        <button
          type="button"
          className="ir-calendar-nav"
          aria-label="Previous month"
          disabled={!canPageBack}
          onClick={() => setFocusedDay(addMonths(focusedDay, -1))}
        >
          {'<'}
        </button>
        {/* Announced on change so a screen reader user paging months hears
            where they landed, which the grid alone does not tell them. */}
        <span className="ir-calendar-month" aria-live="polite">
          {MONTH_NAMES[viewMonth]} {viewYear}
        </span>
        <button
          type="button"
          className="ir-calendar-nav"
          aria-label="Next month"
          disabled={!canPageForward}
          onClick={() => setFocusedDay(addMonths(focusedDay, 1))}
        >
          {'>'}
        </button>
      </div>

      <div
        className="ir-calendar-grid"
        role="grid"
        onKeyDown={handleGridKeyDown}
      >
        <div className="ir-calendar-week ir-calendar-weekdays" role="row">
          {WEEKDAY_ABBREVIATIONS.map((abbreviation, index) => (
            <span
              key={abbreviation}
              className="ir-calendar-weekday"
              role="columnheader"
              aria-label={WEEKDAY_NAMES[index]}
            >
              {abbreviation}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div
            key={`week-${week[0].getTime()}`}
            className="ir-calendar-week"
            role="row"
          >
            {week.map((day) => {
              const isOutsideMonth = day.getMonth() !== viewMonth;
              const isSelected = value ? isSameDay(day, value) : false;
              const isToday = isSameDay(day, today);
              const isDisabled = isOutOfRange(day, min, max);

              return (
                <button
                  key={day.getTime()}
                  type="button"
                  role="gridcell"
                  className="ir-calendar-day"
                  // A full date, because the digit alone says nothing about
                  // which month or year it belongs to — and in the leading and
                  // trailing weeks that is exactly what is ambiguous.
                  aria-label={`${WEEKDAY_NAMES[day.getDay()]}, ${MONTH_NAMES[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`}
                  aria-selected={isSelected}
                  // `aria-disabled` rather than the `disabled` attribute:
                  // unreachable days stay focusable, so arrowing across the
                  // edge of the queue's range does not skip a hole in the grid.
                  aria-disabled={isDisabled}
                  aria-current={isToday ? 'date' : undefined}
                  data-outside-month={isOutsideMonth ? '' : undefined}
                  data-today={isToday ? '' : undefined}
                  // Roving tabindex: one stop for the whole grid, so tab moves
                  // past the calendar rather than through 42 buttons.
                  tabIndex={isSameDay(day, focusedDay) ? 0 : -1}
                  onClick={() => choose(day)}
                  // Keeps the cursor under focus that arrived some other way —
                  // a click, or focus restored by the browser. Guarded so the
                  // focus the effect above just moved does not set the state
                  // that moved it all over again.
                  onFocus={() => {
                    if (!isSameDay(day, focusedDay)) setFocusedDay(day);
                  }}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="ir-calendar-footer">
        {/* Today is not clamped here. An out-of-range today still reports
            itself and the field pulls it to the nearest bound, which is what
            every other way of naming a date already does. */}
        <button
          type="button"
          className="ir-review-button ir-calendar-action"
          onClick={() => onSelect(today)}
        >
          Today
        </button>
        <button
          type="button"
          className="ir-review-button ir-calendar-action"
          onClick={onDismiss}
        >
          Cancel
        </button>
      </div>
    </div>,
    container
  );
}
