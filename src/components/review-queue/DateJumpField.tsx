import { startOfDay } from '#/lib/utils';
import { useRef, useState } from 'react';
import { CalendarPopup } from './CalendarPopup';

/**
 * A calendar glyph, drawn inline rather than taken from `lucide-react`.
 *
 * The icon package resolves its own copy of preact under Vitest — it is
 * required straight out of `node_modules`, where the config's aliases do not
 * reach — so a component that renders one cannot be mounted in a test at all.
 * Nothing here needs the icon set: it is a box, a spine, two hangers, and two
 * rows of marks.
 */
function CalendarIcon() {
  return (
    <svg
      className="ir-calendar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      // Labelled on the button that holds it. An aria-label here would reach
      // Obsidian's tooltip handler, which assumes an HTMLElement and throws on
      // an SVG.
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18M8 2v4M16 2v4" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
    </svg>
  );
}

interface DateJumpFieldProps {
  /** The date the field currently shows. Empty when omitted. */
  value?: Date;
  /**
   * The review day in progress, which the calendar's "Today" jumps to. See
   * `CalendarPopup`: a review day is not always the current calendar day.
   */
  today: Date;
  /** Earliest selectable date. Omitted when the queue has no lower bound. */
  min?: Date;
  /** Latest selectable date. Omitted when the queue has no upper bound. */
  max?: Date;
  /**
   * Whether the plugin is running on a phone or tablet. Leaves out the text
   * box, so the calendar button is the whole control — see the note below on
   * why the box has no place there.
   */
  isMobile?: boolean;
  /** Called with local midnight of the entered date, clamped to [min, max]. */
  onJump: (date: Date) => void;
}

/** Format a date as the `yyyy-mm-dd` a date input expects, in local time. */
function toInputValue(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A date entry that jumps the queue to the page holding the first item due on
 * or after the chosen date, and shows the review day currently in view.
 *
 * Picking a date from the calendar jumps; so does pressing enter in the text
 * box, which additionally covers re-requesting the date already displayed.
 *
 * On mobile the box is left out altogether and the calendar button is the
 * whole control. A segmented date input cannot be typed into on a phone, so
 * the calendar was already the only way to name a date there; what the box
 * added was a fixed slice of a controls bar that has none to spare, spent
 * restating a date the range label beside it already gives — and that label,
 * being the only thing on the bar that yields, is what got truncated to pay
 * for it. Leaving it out is also what finally closes off WebKit's own picker,
 * which it raises on any tap of a date input, read-only included, with no way
 * to decline: a read-only *text* box was the fix before this one, and no box
 * at all needs no fix.
 *
 * Chromium's picker is still there to suppress on desktop. It accepts no page
 * CSS, so it cannot be made to match the calendar beside it, and it opens by
 * two routes:
 *
 * - The picker indicator is hidden in CSS, which is its click target.
 * - Its alt+down shortcut is intercepted in `handleKeyDown` below.
 *
 * Dates outside `[min, max]` are clamped to the nearest bound. The `min`/`max`
 * attributes alone are not enough: they are *validation only* — a browser
 * marks an out-of-range value invalid and never rewrites it, so a date typed
 * or pasted past the end would otherwise still be reported as-is.
 *
 * Tooltips use `aria-label` rather than `title` since Obsidian renders its own
 * themed tooltip for aria-labelled elements.
 */
export function DateJumpField({
  value,
  today,
  min,
  max,
  isMobile = false,
  onJump,
}: DateJumpFieldProps) {
  /**
   * Where the open calendar is rendered, and null when it is closed — one
   * piece of state rather than a boolean beside it, since the two can never
   * disagree that way.
   *
   * The calendar is portalled out of this subtree rather than nested in it.
   * Two things in the review view make an in-place popup unworkable:
   * `.view-content` is `overflow: hidden` and would clip it, and some ancestor
   * Obsidian owns establishes a containing block — a transform, filter, or
   * `contain` anywhere above makes `position: fixed` resolve against that
   * element instead of the viewport, which put the calendar hundreds of pixels
   * from its own field. Rendered under `<body>`, nothing is left to offset it.
   */
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const isOpen = portalTarget !== null;
  const anchorRef = useRef<HTMLDivElement>(null);
  /** What to hand focus back to when the calendar closes. */
  const openerRef = useRef<HTMLElement | null>(null);

  /**
   * Pull `date` inside the bounds, comparing on the calendar day so a bound
   * carrying a time of day cannot push a same-day entry across it.
   */
  function clamp(date: Date) {
    if (min && startOfDay(date) < startOfDay(min)) return startOfDay(min);
    if (max && startOfDay(date) > startOfDay(max)) return startOfDay(max);
    return date;
  }

  function openCalendar(opener: HTMLElement) {
    openerRef.current = opener;
    // The opener's own document, not this module's: Obsidian can move a view
    // into a pop-out window, and `document` there still names the main one.
    setPortalTarget(opener.ownerDocument.body);
  }

  function closeCalendar() {
    setPortalTarget(null);
    openerRef.current?.focus();
  }

  /** Read the field's current value and report it, if it holds a whole date. */
  function jumpTo(input: HTMLInputElement) {
    const { value: entered } = input;
    // Empty while a partial date is typed or the box is being cleared.
    if (!entered) return;

    const [year, month, day] = entered.split('-').map(Number);
    // Built from parts rather than `new Date(entered)`, which parses a bare
    // yyyy-mm-dd as UTC midnight and so lands on the previous local day for
    // anyone west of Greenwich.
    const clamped = clamp(new Date(year, month - 1, day));

    // Write the clamp back to the node itself. The parent re-renders this
    // field from the day the resulting page opens on, but when that day is
    // unchanged — which is precisely the out-of-range case, where every date
    // past the end resolves to the same last page — the rendered value is
    // unchanged too, so Preact diffs it away and never touches the DOM. The
    // box would keep displaying the rejected date.
    const clampedValue = toInputValue(clamped);
    if (input.value !== clampedValue) input.value = clampedValue;

    onJump(clamped);
  }

  function handleInput(event: Event) {
    jumpTo(event.currentTarget as HTMLInputElement);
  }

  /** Report a day chosen in the calendar, and close it. */
  function handleSelect(day: Date) {
    closeCalendar();
    onJump(clamp(day));
  }

  /**
   * Enter is an explicit "go", and the only way to ask for a date the field is
   * already showing. That case matters: the field displays the day the visible
   * page opens on, so re-entering it emits no `input` event at all, yet the
   * user may well be on a later page of that day and want the first one.
   */
  function handleKeyDown(event: KeyboardEvent) {
    // Chromium's shortcut for its own picker. Intercepted so the calendar it
    // would raise is ours; without this the one control the plugin cannot
    // style is still one keystroke away.
    if ((event.altKey || event.metaKey) && event.key === 'ArrowDown') {
      event.preventDefault();
      openCalendar(event.currentTarget as HTMLElement);
      return;
    }

    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      closeCalendar();
      return;
    }

    if (event.key !== 'Enter') return;
    // Nothing here submits a form, but the field can sit inside one in a
    // modal, and an implicit submit would tear the view down mid-jump.
    event.preventDefault();
    jumpTo(event.currentTarget as HTMLInputElement);
  }

  return (
    <div className="ir-queue-date-jump-anchor" ref={anchorRef}>
      {/* Desktop only. See the note above: on a phone this box could not be
          typed into, said nothing the range label beside it does not, and cost
          that label the width it needed to say it. */}
      {!isMobile && (
        <input
          type="date"
          className="ir-queue-date-jump"
          aria-label="Jump to date"
          value={value ? toInputValue(value) : ''}
          min={min ? toInputValue(min) : undefined}
          max={max ? toInputValue(max) : undefined}
          // `onInput` rather than `onChange`: plain Preact treats `onChange` as
          // the DOM `change` event while preact/compat rewrites it to `input`,
          // so its meaning depends on whether compat is in the module graph.
          // `onInput` is the `input` event in both, and a date input emits it
          // once per committed value — one jump per date the user picks.
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
      )}
      <button
        type="button"
        className="clickable-icon ir-queue-date-jump-trigger"
        // Labelled here rather than on the icon: Obsidian's tooltip handler
        // assumes an aria-labelled node is an HTMLElement, and an SVG is not.
        aria-label="Open calendar"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={(event) => {
          if (isOpen) closeCalendar();
          else openCalendar(event.currentTarget);
        }}
      >
        <CalendarIcon />
      </button>
      {portalTarget && (
        <CalendarPopup
          container={portalTarget}
          value={value}
          today={today}
          min={min}
          max={max}
          anchorRef={anchorRef}
          onSelect={handleSelect}
          onDismiss={closeCalendar}
        />
      )}
    </div>
  );
}
