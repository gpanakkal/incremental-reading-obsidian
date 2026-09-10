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

/**
 * How far a drag must travel across the grid to page the month on release, in
 * px. Under it the track springs back, so a hesitant drag is a look rather
 * than a move.
 *
 * A fixed distance rather than a share of the panel's width. A CSS pixel is
 * the closest thing a web view has to a real-world unit — a phone and a tablet
 * both scale their viewport so that one comes out at roughly the same size
 * under a thumb — whereas a share of the panel asks for a longer drag on
 * whichever screen draws the calendar wider, and the calendar is drawn from
 * `rem`, so that is a matter of the reader's font size as much as their
 * device. The distance is also about a third shorter than the quarter-panel it
 * replaces, which read as the month being magnetised to where it started.
 */
const COMMIT_DISTANCE = 42;

/**
 * The most of a panel's width the distance above may claim. Only reached on a
 * popup squeezed by a narrow screen, where a fifth of the month is already a
 * long way to drag and a fixed distance could ask for more grid than there is.
 */
const MAX_COMMIT_FRACTION = 0.2;

/**
 * How far a finger must move before the gesture is called horizontal or
 * vertical, in px. Below it nothing moves at all, so the first pixel of a
 * vertical scroll cannot nudge the month sideways.
 */
const AXIS_LOCK_SLOP = 8;

/**
 * How much a drag is damped past the end of the queue, where there is no month
 * to pull in. The track still answers the finger, at a quarter of its travel.
 */
const EDGE_RESISTANCE = 4;

/** The months rendered at once: the one on screen and its two neighbours. */
const PANEL_OFFSETS = [-1, 0, 1];

/**
 * Marks the track as travelling to rest rather than following a finger. The
 * transition itself lives in the stylesheet, which is also where it is turned
 * off for a reader who has asked for less motion — and where it stays the only
 * thing that has to know the duration.
 */
const SETTLING_CLASS = 'ir-calendar-track-settling';

/**
 * Marks the day a pointer is currently held on, which the stylesheet tints.
 *
 * Owned here rather than left to `:active`, which cannot tell a press from the
 * first moment of a swipe and which the engine keeps on the node itself — and
 * the nodes either grid shares with the next month survive the re-render that
 * pages it, carrying the tint into a month the finger never pressed on.
 */
const PRESSED_ATTRIBUTE = 'data-pressed';

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

/** A month's grid, split into the six rows it is drawn as. */
function weeksOf(month: Date) {
  const days = buildMonthGrid(month);
  const weeks: Date[][] = [];
  for (let week = 0; week < WEEKS_SHOWN; week++) {
    weeks.push(days.slice(week * DAYS_PER_WEEK, (week + 1) * DAYS_PER_WEEK));
  }
  return weeks;
}

/**
 * How far a drag must travel to page the month, for a panel `width` px wide.
 *
 * Read once per gesture, from the width measured when the pointer went down.
 */
export function commitThreshold(width: number) {
  const cap = width * MAX_COMMIT_FRACTION;
  // A panel of no width is one nothing has laid out: every box under a test
  // runner, and the popup itself for the frame before it is placed. There is
  // no share of it to take, so the distance stands on its own.
  return cap > 0 ? Math.min(COMMIT_DISTANCE, cap) : COMMIT_DISTANCE;
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
  const trackRef = useRef<HTMLDivElement>(null);
  /** The gesture in progress, while a pointer is still down on the grid. */
  const dragRef = useRef<{
    x: number;
    y: number;
    width: number;
    axis: 'undecided' | 'x' | 'y';
    offset: number;
  } | null>(null);
  /**
   * Where the settle has to begin, in px, once a committed month has been
   * re-centred. Null when nothing is waiting to settle.
   */
  const settleFromRef = useRef<number | null>(null);
  /**
   * Whether the gesture that just ended was a drag rather than a tap — which
   * is to say whether it ever settled on an axis, since nothing below the
   * axis lock moves anything. A drag finishes with the pointer over some day,
   * and both the click the engine sends afterwards and the focus that comes
   * with it would otherwise be taken for a choice. It holds for a drag that
   * sprang back as much as for one that paged: once the grid has moved under
   * the finger, letting go is a cancel.
   */
  const draggedRef = useRef(false);
  /**
   * The day currently marked as pressed, so the mark can be lifted off the
   * same node later. Written onto the node rather than held in state: this is
   * feedback on a press, and routing it through a render would rebuild all
   * three months' worth of cells on every touch.
   */
  const pressedDayRef = useRef<HTMLElement | null>(null);

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

  /**
   * Carry the track through a committed month change.
   *
   * The new month is centred by the render that has just happened, which would
   * drop it into place instantly. So the track is put back where the finger
   * left it — one panel further along, since everything shifted by a month —
   * and then released, and it travels the rest of the way on its own.
   *
   * A layout effect, so both writes land before the browser paints and the
   * jump is never seen. The reflow between them is what makes the second a
   * transition rather than the two collapsing into a single no-op.
   */
  useLayoutEffect(() => {
    const settleFrom = settleFromRef.current;
    if (settleFrom === null) return;
    settleFromRef.current = null;

    const track = trackRef.current;
    if (!track) return;

    track.classList.remove(SETTLING_CLASS);
    track.style.transform = `translateX(${settleFrom}px)`;
    track.getBoundingClientRect();
    settleTrack();
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

  /**
   * Whether the month one step away holds anything reachable. Measured at that
   * month's nearest edge — the last day of the one before, the first day of
   * the one after — since that is the closest the queue's range can be
   * approached from either side.
   */
  function canPage(months: number) {
    const edge =
      months < 0
        ? new Date(viewYear, viewMonth, 0)
        : new Date(viewYear, viewMonth + 1, 1);
    return !isOutOfRange(edge, min, max);
  }

  /**
   * Page the grid by whole months, stopping at the queue's range.
   *
   * Deliberately does not take focus with it: the arrows move the grid under a
   * mouse user whose focus belongs on the arrow they are clicking, and a swipe
   * has no focus to move at all.
   */
  function pageMonth(months: number) {
    if (!canPage(months)) return;
    setFocusedDay(addMonths(focusedDay, months));
  }

  /** Slide the track to `offset` px from rest, without animating. */
  function moveTrack(offset: number) {
    const track = trackRef.current;
    if (!track) return;
    track.classList.remove(SETTLING_CLASS);
    track.style.transform = `translateX(${offset}px)`;
  }

  /** Let the track travel back to rest under the settle transition. */
  function settleTrack() {
    const track = trackRef.current;
    if (!track) return;
    track.classList.add(SETTLING_CLASS);
    // Removed rather than set to a zero translation: rest is the stylesheet's
    // business, and writing a fixed value here would be a static style
    // assignment in a file that keeps those in CSS.
    track.style.removeProperty('transform');
  }

  /**
   * Move the pressed mark to `day`, or lift it off with null.
   *
   * Only ever one day carries it, and it is taken off before any state change
   * that could page the month: two grids a month apart share the days in the
   * week they overlap on, so the node under the finger is one the re-render
   * may well keep — mark and all.
   */
  function markPressed(day: HTMLElement | null) {
    pressedDayRef.current?.removeAttribute(PRESSED_ATTRIBUTE);
    pressedDayRef.current = day;
    day?.setAttribute(PRESSED_ATTRIBUTE, '');
  }

  function cancelDrag() {
    dragRef.current = null;
    markPressed(null);
    settleTrack();
  }

  function handlePointerDown(event: PointerEvent) {
    // Cleared here rather than after the click it suppresses, so a gesture the
    // browser never follows with a click cannot leave the next tap swallowed.
    draggedRef.current = false;
    dragRef.current = null;
    const track = trackRef.current;
    // The primary button only: a right or middle press is after a context
    // menu or a paste, and moving the month under one would be a surprise.
    // Touch reports zero here, so this costs a finger nothing.
    if (event.button > 0 || !track) return;

    // Every modality drags — finger, mouse and pen alike. The month arrows
    // stay where they are for anyone who would rather click to page.
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      // Measured once at the start: it decides both how far a drag must travel
      // to commit and where the settle begins, and re-reading it mid-gesture
      // would force a layout on every frame.
      width: track.offsetWidth,
      axis: 'undecided',
      offset: 0,
    };

    const target = event.target as HTMLElement | null;
    markPressed(target?.closest<HTMLElement>('.ir-calendar-day') ?? null);
  }

  /**
   * Route the rest of the gesture to the grid, wherever the pointer wanders —
   * which for a swipe that spans the popup it very often does.
   *
   * Taken at the axis lock rather than at the press, because capture also
   * retargets the click the engine sends on release: from the press it would
   * land every ordinary click on the grid instead of on the day aimed at.
   * By the time an axis is locked the gesture is a drag, and that click is one
   * being suppressed anyway.
   */
  function capturePointer(event: PointerEvent) {
    const grid = event.currentTarget as HTMLElement;
    if (event.pointerId == null || !grid.setPointerCapture) return;
    grid.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;

    const acrossX = event.clientX - drag.x;
    const acrossY = event.clientY - drag.y;

    // Which way the gesture is going is decided once, at the first movement
    // big enough to mean anything, and never revisited. Without the lock a
    // finger scrolling the queue behind the popup drags the month sideways
    // every time it wavers.
    if (drag.axis === 'undecided') {
      if (Math.max(Math.abs(acrossX), Math.abs(acrossY)) < AXIS_LOCK_SLOP) {
        return;
      }
      drag.axis = Math.abs(acrossX) > Math.abs(acrossY) ? 'x' : 'y';
      // The press is over. What the pointer is doing now is a gesture, and the
      // day it started from must stop answering as though it were being
      // chosen — a mark still standing when the month pages is one the new
      // month inherits.
      markPressed(null);
      if (drag.axis === 'x') capturePointer(event);
    }
    if (drag.axis === 'y') return;

    // Beyond the end of the queue there is no month to pull in, so the track
    // gives only a little and springs back — enough to answer the finger,
    // little enough to say there is nothing there.
    const wanted = acrossX < 0 ? 1 : -1;
    drag.offset = canPage(wanted) ? acrossX : acrossX / EDGE_RESISTANCE;
    moveTrack(drag.offset);
  }

  function handlePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    markPressed(null);
    // A gesture that never locked an axis never moved anything, so it is a tap
    // and the click after it is the user's choice of day. Returning here is
    // also what keeps the settle transition off a plain tap, which would
    // otherwise leave it armed for the drag after it.
    if (!drag || drag.axis === 'undecided') return;

    // Anything past the axis lock ends as a cancel rather than a choice,
    // whether or not it goes on to page the month: the grid has moved under
    // the pointer, and the day it happens to be over on release is not one
    // that was aimed at.
    draggedRef.current = true;
    // Only a horizontal gesture ever moves the track, so a vertical one has
    // nothing to put back.
    if (drag.axis !== 'x') return;

    const threshold = commitThreshold(drag.width);
    const months = drag.offset < 0 ? 1 : -1;

    if (Math.abs(drag.offset) < threshold || !canPage(months)) {
      settleTrack();
      return;
    }

    // The month changes now, not when the animation ends: the state is what
    // the rest of the component reads, and leaving it behind the transition
    // would mean a keystroke landing on a month that is on its way out. What
    // the layout effect below does is purely visual — it puts the track back
    // where the finger left it and lets it travel to rest from there.
    settleFromRef.current = drag.offset + months * drag.width;
    setFocusedDay(addMonths(focusedDay, months));
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

  // A month arrow is dead when nothing in the month it leads to is reachable.
  // The same test gates the swipe, so the two ways of paging stop in the same
  // place — a gesture that silently did nothing would read as a dropped input.
  const canPageBack = canPage(-1);
  const canPageForward = canPage(1);

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
          onClick={() => pageMonth(-1)}
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
          onClick={() => pageMonth(1)}
        >
          {'>'}
        </button>
      </div>

      <div
        className="ir-calendar-grid"
        role="grid"
        onKeyDown={handleGridKeyDown}
        // Pointer events rather than touch ones: one set of handlers covers
        // the finger, the mouse and the pen, so dragging the month is the same
        // gesture on a phone and on a desktop rather than a mobile feature
        // that happens to be reachable on a touchscreen laptop.
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        // A pointer lifted outside the grid, or a gesture the browser took
        // over — either way there is no drag to finish, and the track goes back.
        onPointerCancel={cancelDrag}
        // A press that leaves without letting go: a mouse button held down
        // and taken off the calendar before it travelled far enough to be a
        // drag, whose release lands somewhere this never hears about. The
        // gesture itself is left alone — a drag is captured by the time it can
        // leave, and boundary events are held back until it ends — but the
        // mark has to come off, or the day it was on stays lit indefinitely.
        onPointerLeave={() => markPressed(null)}
      >
        {/* Outside the track, so the weekday names hold still while the days
            slide under them — the labels are the same in every month, and
            sliding identical content only reads as a smear. */}
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
        {/* The month on screen and the two either side of it, so a drag has
            something to pull into view. `presentation`, so the panel below
            does not come between the grid and its rows in the a11y tree. */}
        <div className="ir-calendar-track" role="presentation" ref={trackRef}>
          {PANEL_OFFSETS.map((panelOffset) => {
            const panelMonth = addMonths(focusedDay, panelOffset);
            const isCurrentMonth = panelOffset === 0;
            const weeks = weeksOf(panelMonth);

            return (
              <div
                key={`panel-${panelOffset}`}
                className="ir-calendar-month-panel"
                role="presentation"
                data-panel={panelOffset}
                // The neighbours are scenery: hidden from assistive
                // technology, and out of reach of the pointer so a drag cannot
                // end by clicking a day that was never really on screen.
                aria-hidden={!isCurrentMonth}
              >
                {weeks.map((week) => (
                  <div
                    key={`week-${week[0].getTime()}`}
                    className="ir-calendar-week"
                    role="row"
                  >
                    {week.map((day) => {
                      const isOutsideMonth =
                        day.getMonth() !== panelMonth.getMonth();
                      const isSelected = value ? isSameDay(day, value) : false;
                      const isToday = isSameDay(day, today);
                      const isDisabled = isOutOfRange(day, min, max);

                      return (
                        <button
                          key={day.getTime()}
                          type="button"
                          role="gridcell"
                          className="ir-calendar-day"
                          // A full date, because the digit alone says nothing
                          // about which month or year it belongs to — and in
                          // the leading and trailing weeks that is exactly
                          // what is ambiguous.
                          aria-label={`${WEEKDAY_NAMES[day.getDay()]}, ${MONTH_NAMES[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`}
                          aria-selected={isSelected}
                          // `aria-disabled` rather than the `disabled`
                          // attribute: unreachable days stay focusable, so
                          // arrowing across the edge of the queue's range does
                          // not skip a hole in the grid.
                          aria-disabled={isDisabled}
                          aria-current={isToday ? 'date' : undefined}
                          data-outside-month={isOutsideMonth ? '' : undefined}
                          data-today={isToday ? '' : undefined}
                          // Roving tabindex: one stop for the whole grid, so
                          // tab moves past the calendar rather than through 42
                          // buttons. Only the month on screen offers it — the
                          // neighbouring panels repeat some of the same days,
                          // and a second stop on one of those would be a tab
                          // into a month nobody is looking at.
                          tabIndex={
                            isCurrentMonth && isSameDay(day, focusedDay)
                              ? 0
                              : -1
                          }
                          onClick={() => {
                            // The click that ends a drag. Swallowed once, so
                            // a gesture that moved the grid — whether it went
                            // on to page the month or sprang back to it —
                            // does not also pick whichever day the pointer
                            // happened to come to rest on.
                            if (draggedRef.current) {
                              draggedRef.current = false;
                              return;
                            }
                            choose(day);
                          }}
                          // Keeps the cursor under focus that arrived some
                          // other way — a click, or focus restored by the
                          // browser.
                          //
                          // Confined to the month on screen and to the days
                          // that month owns, which is what stops a press on a
                          // day from either side of it paging the grid.
                          // Pressing a mouse button focuses the day under it,
                          // so an unguarded sync moved the whole month while
                          // the button was still down — under a drag, out from
                          // under the drag itself. That jump belongs on
                          // release, with every other action. Guarded against
                          // the focused day as well, so the focus the effect
                          // above just moved does not set the state that moved
                          // it all over again, and against a drag, whose own
                          // release is what decides the month.
                          onFocus={() => {
                            if (!isCurrentMonth || isOutsideMonth) return;
                            if (draggedRef.current) return;
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
            );
          })}
        </div>
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
