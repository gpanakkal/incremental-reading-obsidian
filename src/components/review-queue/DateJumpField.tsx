interface DateJumpFieldProps {
  /** The date the field currently shows. Empty when omitted. */
  value?: Date;
  /** Earliest selectable date. Omitted when the queue has no lower bound. */
  min?: Date;
  /** Latest selectable date. Omitted when the queue has no upper bound. */
  max?: Date;
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
 * Picking a date jumps; so does pressing enter, which additionally covers
 * re-requesting the date already displayed.
 *
 * Dates outside `[min, max]` are clamped to the nearest bound. The `min`/`max`
 * attributes alone are not enough: they grey out unreachable days in the picker
 * and stop the spinner arrows at the boundary, but they are *validation only* —
 * a browser marks an out-of-range value invalid and never rewrites it, so a
 * date typed or pasted past the end would otherwise still be reported as-is.
 *
 * Tooltips use `aria-label` rather than `title` since Obsidian renders its own
 * themed tooltip for aria-labelled elements.
 */
export function DateJumpField({ value, min, max, onJump }: DateJumpFieldProps) {
  /**
   * Pull `date` inside the bounds, comparing on the calendar day so a bound
   * carrying a time of day cannot push a same-day entry across it.
   */
  function clamp(date: Date) {
    const asDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (min && asDay(date) < asDay(min)) return asDay(min);
    if (max && asDay(date) > asDay(max)) return asDay(max);
    return date;
  }

  /** Read the field's current value and report it, if it holds a whole date. */
  function jumpTo(input: HTMLInputElement) {
    const { value: entered } = input;
    // Empty while the picker is being cleared or a partial date is typed.
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
    // input would keep displaying the rejected date, and its picker would keep
    // that day highlighted, since the picker's selection is internal state no
    // vdom write reaches.
    const clampedValue = toInputValue(clamped);
    if (input.value !== clampedValue) input.value = clampedValue;

    onJump(clamped);
  }

  function handleInput(event: Event) {
    jumpTo(event.currentTarget as HTMLInputElement);
  }

  /**
   * Enter is an explicit "go", and the only way to ask for a date the field is
   * already showing. That case matters: the field displays the day the visible
   * page opens on, so re-entering it emits no `input` event at all, yet the
   * user may well be on a later page of that day and want the first one.
   */
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    // Nothing here submits a form, but the field can sit inside one in a
    // modal, and an implicit submit would tear the view down mid-jump.
    event.preventDefault();
    jumpTo(event.currentTarget as HTMLInputElement);
  }

  return (
    <input
      type="date"
      className="ir-queue-date-jump"
      aria-label="Jump to date"
      value={value ? toInputValue(value) : ''}
      min={min ? toInputValue(min) : undefined}
      max={max ? toInputValue(max) : undefined}
      // `onInput` rather than `onChange`: plain Preact treats `onChange` as
      // the DOM `change` event while preact/compat rewrites it to `input`, so
      // its meaning depends on whether compat is in the module graph.
      // `onInput` is the `input` event in both, and a date input emits it once
      // per committed value — one jump per date the user picks.
      onInput={handleInput}
      onKeyDown={handleKeyDown}
    />
  );
}
