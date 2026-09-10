// @vitest-environment jsdom
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateJumpField } from './DateJumpField';

// #region HELPERS

/**
 * The review day the field is told is today. Fixed, so nothing here depends on
 * the clock — and distinct from the dates the tests enter, so a "Today" that
 * silently read `new Date()` would be visible.
 */
const TODAY = new Date(2026, 6, 15);

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

/**
 * Let Preact's queued re-render land. State updates are scheduled on a
 * microtask, so nothing an event handler sets is in the DOM until this
 * resolves.
 */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function dateInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="date"]') as HTMLInputElement;
}

/**
 * The text box, found by class rather than by type — so a test can ask what
 * type it carries, or whether there is a box at all, without the lookup
 * having assumed the answer.
 */
function field(container: HTMLElement): HTMLInputElement {
  return container.querySelector('.ir-queue-date-jump') as HTMLInputElement;
}

/** The button that opens the calendar. */
function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector(
    '.ir-queue-date-jump-trigger'
  ) as HTMLButtonElement;
}

/**
 * The calendar, when it is open. Looked up in the document rather than in the
 * field's own container: it is portalled out to `<body>`.
 */
function calendar(): HTMLElement | null {
  return document.querySelector('.ir-calendar');
}

/** A day cell in the open calendar, by the date its label ends with. */
function calendarDay(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.ir-calendar-day')
  ).find((day) => day.getAttribute('aria-label')?.endsWith(label));
  if (!match) throw new Error(`No day cell for ${label}`);
  return match;
}

function click(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Set the input's value and commit it, as picking a date does. */
function enterDate(container: HTMLElement, value: string) {
  const input = dateInput(container);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Type a value into the field without committing it, as editing the segments
 * does. A date input emits no `input` event until every segment is filled, and
 * none at all when the typed value matches what is already shown.
 */
function typeDate(container: HTMLElement, value: string) {
  dateInput(container).value = value;
}

/** Press a key in the field. */
function pressKey(container: HTMLElement, key: string) {
  dateInput(container).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true })
  );
}

// #endregion

describe('DateJumpField', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reports the entered date as a local Date at midnight', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    enterDate(container, '2026-07-13');

    expect(onJump).toHaveBeenCalledTimes(1);
    const [jumped] = onJump.mock.calls[0] as [Date];
    // Parsed in local time: `new Date('2026-07-13')` would be UTC midnight and
    // can land on the previous local day west of Greenwich.
    expect(jumped.getFullYear()).toBe(2026);
    expect(jumped.getMonth()).toBe(6);
    expect(jumped.getDate()).toBe(13);
  });

  it('does not report a jump when the field is cleared', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    enterDate(container, '');

    expect(onJump).not.toHaveBeenCalled();
  });

  it('reports exactly one jump per date pick', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    enterDate(container, '2026-07-13');

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('reports one jump per pick regardless of a trailing change event', () => {
    // preact/compat and plain Preact disagree about which event `onChange`
    // means, so the field listens only for `input`. A trailing `change` from
    // the same pick must not double-jump.
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    enterDate(container, '2026-07-13');
    dateInput(container).dispatchEvent(new Event('change', { bubbles: true }));

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('reports a jump again when the same date is re-picked', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    // Jump to a date, page away manually, then re-pick the same date to get
    // back. The second pick must still jump.
    enterDate(container, '2026-07-13');
    enterDate(container, '2026-07-13');

    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it('reports a new jump when the date changes again', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    enterDate(container, '2026-07-13');
    enterDate(container, '2026-07-20');

    expect(onJump).toHaveBeenCalledTimes(2);
    const [second] = onJump.mock.calls[1] as [Date];
    expect(second.getDate()).toBe(20);
  });

  it('reports a jump when enter is pressed in the text box', () => {
    // Typing the segments fires no `input` event until the value is complete,
    // and enter is how a keyboard user says "go" — without this the typed date
    // is simply ignored.
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    typeDate(container, '2026-07-13');
    pressKey(container, 'Enter');

    expect(onJump).toHaveBeenCalledTimes(1);
    const [jumped] = onJump.mock.calls[0] as [Date];
    expect(jumped.getFullYear()).toBe(2026);
    expect(jumped.getMonth()).toBe(6);
    expect(jumped.getDate()).toBe(13);
  });

  it('reports a jump on enter even when the date already shown is re-entered', () => {
    // The field displays the day the current page opens on, so re-picking that
    // day is a no-op change and emits no `input`. Enter must still jump: the
    // page in view may not be the first page holding that day's items.
    const onJump = vi.fn();
    const container = mount(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 7, 1)}
        onJump={onJump}
      />
    );

    pressKey(container, 'Enter');

    expect(onJump).toHaveBeenCalledTimes(1);
    const [jumped] = onJump.mock.calls[0] as [Date];
    expect(jumped.getMonth()).toBe(7);
    expect(jumped.getDate()).toBe(1);
  });

  it('reports a jump on enter each time it is pressed', () => {
    // Repeated enters are repeated explicit requests, not one debounced one.
    const onJump = vi.fn();
    const container = mount(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 7, 1)}
        onJump={onJump}
      />
    );

    pressKey(container, 'Enter');
    pressKey(container, 'Enter');

    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it('does not report a jump on enter when the field is empty', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    pressKey(container, 'Enter');

    expect(onJump).not.toHaveBeenCalled();
  });

  it('does not report a jump for keys other than enter', () => {
    const onJump = vi.fn();
    const container = mount(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 7, 1)}
        onJump={onJump}
      />
    );

    pressKey(container, 'ArrowUp');
    pressKey(container, 'Tab');
    pressKey(container, 'Escape');
    pressKey(container, ' ');

    expect(onJump).not.toHaveBeenCalled();
  });

  it('reports a jump for enter pressed after a date was already committed', () => {
    // Filling the last segment commits the date and jumps; the enter that
    // follows is a separate keystroke asking for the same jump again. It is
    // reported again for the same reason a re-pick is: the jump is idempotent,
    // and suppressing it would also suppress a genuine second request.
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    enterDate(container, '2026-07-13');
    pressKey(container, 'Enter');

    expect(onJump).toHaveBeenCalledTimes(2);
    for (const [jumped] of onJump.mock.calls as [Date][]) {
      expect(jumped.getDate()).toBe(13);
    }
  });

  it('reports a jump on enter after a date was committed and paged away from', () => {
    // Commit a date, let the parent move the view elsewhere, then press enter
    // on the field's own value again. The second request must reach the parent.
    const onJump = vi.fn();
    const container = mount(<DateJumpField today={TODAY} onJump={onJump} />);

    enterDate(container, '2026-07-13');
    render(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 6, 20)}
        onJump={onJump}
      />,
      container
    );
    pressKey(container, 'Enter');

    expect(onJump).toHaveBeenCalledTimes(2);
    const [second] = onJump.mock.calls[1] as [Date];
    expect(second.getDate()).toBe(20);
  });

  it('shows the date it is given', () => {
    const container = mount(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 6, 13)}
        onJump={() => {}}
      />
    );

    expect(dateInput(container).value).toBe('2026-07-13');
  });

  it('formats a single-digit month and day with leading zeroes', () => {
    // A bare `${month}` would render 2026-3-4, which a date input rejects.
    const container = mount(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 2, 4)}
        onJump={() => {}}
      />
    );

    expect(dateInput(container).value).toBe('2026-03-04');
  });

  it('renders empty when given no date', () => {
    const container = mount(<DateJumpField today={TODAY} onJump={() => {}} />);

    expect(dateInput(container).value).toBe('');
  });

  it('reflects a new date pushed from the parent', () => {
    const container = mount(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 6, 13)}
        onJump={() => {}}
      />
    );

    render(
      <DateJumpField
        today={TODAY}
        value={new Date(2026, 6, 20)}
        onJump={() => {}}
      />,
      container
    );

    expect(dateInput(container).value).toBe('2026-07-20');
  });

  it('is labelled for screen readers and tooltips', () => {
    const container = mount(<DateJumpField today={TODAY} onJump={() => {}} />);

    expect(dateInput(container).getAttribute('aria-label')).toBeTruthy();
  });

  describe('bounds', () => {
    it('publishes the bounds as min and max attributes', () => {
      // These are what grey out unreachable days in the native picker and stop
      // the spinner arrows at the boundary.
      const container = mount(
        <DateJumpField
          today={TODAY}
          min={new Date(2026, 6, 1)}
          max={new Date(2026, 6, 31)}
          onJump={() => {}}
        />
      );

      const input = dateInput(container);
      expect(input.getAttribute('min')).toBe('2026-07-01');
      expect(input.getAttribute('max')).toBe('2026-07-31');
    });

    it('sets no min or max when the queue has no bounds', () => {
      const container = mount(
        <DateJumpField today={TODAY} onJump={() => {}} />
      );

      const input = dateInput(container);
      expect(input.hasAttribute('min')).toBe(false);
      expect(input.hasAttribute('max')).toBe(false);
    });

    it('reports the max when a later date is entered', () => {
      // `max` is validation only — a browser flags the value out of range but
      // never rewrites it — so the clamp has to happen here.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={TODAY}
          max={new Date(2026, 6, 31)}
          onJump={onJump}
        />
      );

      enterDate(container, '2026-09-15');

      expect(onJump).toHaveBeenCalledTimes(1);
      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getMonth()).toBe(6);
      expect(jumped.getDate()).toBe(31);
    });

    it('reports the min when an earlier date is entered', () => {
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={TODAY}
          min={new Date(2026, 6, 1)}
          onJump={onJump}
        />
      );

      enterDate(container, '2026-01-05');

      expect(onJump).toHaveBeenCalledTimes(1);
      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getMonth()).toBe(6);
      expect(jumped.getDate()).toBe(1);
    });

    it('reports a date inside the bounds unchanged', () => {
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={TODAY}
          min={new Date(2026, 6, 1)}
          max={new Date(2026, 6, 31)}
          onJump={onJump}
        />
      );

      enterDate(container, '2026-07-13');

      expect(onJump).toHaveBeenCalledTimes(1);
      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getDate()).toBe(13);
    });

    it('reports each bound itself unchanged', () => {
      // The bounds are inclusive: the first and last days with items are both
      // reachable, so neither may be nudged inward.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={TODAY}
          min={new Date(2026, 6, 1)}
          max={new Date(2026, 6, 31)}
          onJump={onJump}
        />
      );

      enterDate(container, '2026-07-01');
      enterDate(container, '2026-07-31');

      const [first] = onJump.mock.calls[0] as [Date];
      const [second] = onJump.mock.calls[1] as [Date];
      expect(first.getDate()).toBe(1);
      expect(second.getDate()).toBe(31);
    });

    it('compares against the bound by calendar day, not time of day', () => {
      // A bound carrying a time of day must not push a same-day entry across
      // it: entering the max's own day is in range however late that day the
      // bound falls.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={TODAY}
          max={new Date(2026, 6, 31, 18, 30)}
          onJump={onJump}
        />
      );

      enterDate(container, '2026-07-31');

      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getMonth()).toBe(6);
      expect(jumped.getDate()).toBe(31);
      // Clamping must not smuggle the bound's time of day into the result.
      expect(jumped.getHours()).toBe(0);
      expect(jumped.getMinutes()).toBe(0);
    });

    it('shows the clamped date in the field', () => {
      // The bug this guards: the parent re-renders the field from the day the
      // resulting page opens on, which for any out-of-range date is the same
      // day every time. The vdom value never changes, so Preact writes nothing
      // and the field would keep displaying the rejected date.
      const container = mount(
        <DateJumpField
          today={TODAY}
          value={new Date(2026, 6, 31)}
          max={new Date(2026, 6, 31)}
          onJump={() => {}}
        />
      );

      enterDate(container, '2026-09-15');

      expect(dateInput(container).value).toBe('2026-07-31');
    });

    it('shows the clamped date after repeated out-of-range entries', () => {
      // Pushing further past the end must not drift the field: every attempt
      // lands back on the bound.
      const container = mount(
        <DateJumpField
          today={TODAY}
          value={new Date(2026, 6, 31)}
          max={new Date(2026, 6, 31)}
          onJump={() => {}}
        />
      );

      enterDate(container, '2026-09-15');
      enterDate(container, '2026-11-20');

      expect(dateInput(container).value).toBe('2026-07-31');
    });

    it('leaves the displayed value of an in-range entry alone', () => {
      const container = mount(
        <DateJumpField
          today={TODAY}
          max={new Date(2026, 6, 31)}
          onJump={() => {}}
        />
      );

      enterDate(container, '2026-07-13');

      expect(dateInput(container).value).toBe('2026-07-13');
    });

    it('clamps a date committed with enter', () => {
      // Typing the segments fires no `input` event, so enter is the other way
      // an out-of-range date can arrive.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={TODAY}
          max={new Date(2026, 6, 31)}
          onJump={onJump}
        />
      );

      typeDate(container, '2026-09-15');
      pressKey(container, 'Enter');

      expect(onJump).toHaveBeenCalledTimes(1);
      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getDate()).toBe(31);
      expect(dateInput(container).value).toBe('2026-07-31');
    });

    it('still reports nothing when a bounded field is cleared', () => {
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={TODAY}
          min={new Date(2026, 6, 1)}
          max={new Date(2026, 6, 31)}
          onJump={onJump}
        />
      );

      enterDate(container, '');

      expect(onJump).not.toHaveBeenCalled();
    });
  });

  describe('calendar', () => {
    it('renders the calendar outside the field’s own subtree', async () => {
      // The bug this guards: nested in the controls bar, the calendar was both
      // clipped by `.view-content`'s `overflow: hidden` and positioned against
      // an Obsidian ancestor that establishes a containing block, which put it
      // hundreds of pixels away from the field it belongs to. `position:
      // fixed` only means the viewport when nothing above it has a transform,
      // filter, or `contain` — and under `<body>` nothing can.
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      click(trigger(container));
      await flush();

      const popup = calendar();
      expect(popup).not.toBeNull();
      expect(container.contains(popup)).toBe(false);
      expect(popup?.parentElement).toBe(document.body);
    });

    it('takes the calendar back out of the document when it closes', async () => {
      // A portalled node is not removed by unmounting the field's own subtree,
      // so a leak here would leave dead calendars stacked under `<body>`.
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      click(trigger(container));
      await flush();
      click(trigger(container));
      await flush();

      expect(document.querySelectorAll('.ir-calendar')).toHaveLength(0);
    });

    it('opens the calendar from the trigger', async () => {
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      expect(calendar()).toBeNull();
      click(trigger(container));
      await flush();

      expect(calendar()).not.toBeNull();
    });

    it('closes the calendar from the trigger', async () => {
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      click(trigger(container));
      await flush();
      click(trigger(container));
      await flush();

      expect(calendar()).toBeNull();
    });

    it('closes the calendar as soon as a day is picked', async () => {
      // The headline iOS defect: WebKit's picker stayed up after a tap, and
      // the calendar has to close on the press that chose a day, not later.
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      click(trigger(container));
      await flush();
      click(calendarDay('July 20, 2026'));
      await flush();

      expect(calendar()).toBeNull();
    });

    it('reports the day picked in the calendar', async () => {
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={onJump} />
      );

      click(trigger(container));
      await flush();
      click(calendarDay('July 20, 2026'));

      expect(onJump).toHaveBeenCalledTimes(1);
      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getTime()).toBe(new Date(2026, 6, 20).getTime());
    });

    it('reports a second day picked after reopening the calendar', async () => {
      // The other half of the iOS defect: the first pick landed, and every
      // pick after it was swallowed because the picker and the box it mirrored
      // had gone out of step.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={onJump} />
      );

      click(trigger(container));
      await flush();
      click(calendarDay('July 20, 2026'));
      await flush();

      click(trigger(container));
      await flush();
      click(calendarDay('July 22, 2026'));

      expect(onJump).toHaveBeenCalledTimes(2);
      const [second] = onJump.mock.calls[1] as [Date];
      expect(second.getDate()).toBe(22);
    });

    it('opens the calendar on alt+down instead of the browser’s picker', async () => {
      // Chromium's shortcut for the picker this replaced. Left alone, the one
      // control the plugin cannot style is a keystroke away.
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      dateInput(container).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          altKey: true,
          bubbles: true,
        })
      );
      await flush();

      expect(calendar()).not.toBeNull();
    });

    it('does not report a jump when alt+down opens the calendar', async () => {
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={onJump} />
      );

      dateInput(container).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          altKey: true,
          bubbles: true,
        })
      );
      await flush();

      expect(onJump).not.toHaveBeenCalled();
    });

    it('closes the calendar on escape', async () => {
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      click(trigger(container));
      await flush();
      calendarDay('July 15, 2026').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await flush();

      expect(calendar()).toBeNull();
    });

    it('hands the queue’s bounds to the calendar', async () => {
      const container = mount(
        <DateJumpField
          today={TODAY}
          value={TODAY}
          min={new Date(2026, 6, 10)}
          max={new Date(2026, 6, 20)}
          onJump={() => {}}
        />
      );

      click(trigger(container));
      await flush();

      expect(calendarDay('July 21, 2026').getAttribute('aria-disabled')).toBe(
        'true'
      );
      expect(calendarDay('July 9, 2026').getAttribute('aria-disabled')).toBe(
        'true'
      );
    });

    it('clamps a day the calendar reports past the end', async () => {
      // Only "Today" can name a day outside the range — the grid's own cells
      // are inert there — and it is clamped for the same reason a typed date
      // is: every date past the end resolves to the last page.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField
          today={new Date(2026, 8, 1)}
          value={TODAY}
          max={new Date(2026, 6, 31)}
          onJump={onJump}
        />
      );

      click(trigger(container));
      await flush();
      click(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('.ir-calendar-action')
        ).find((button) => button.textContent === 'Today') as HTMLButtonElement
      );

      expect(onJump).toHaveBeenCalledTimes(1);
      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getMonth()).toBe(6);
      expect(jumped.getDate()).toBe(31);
    });

    it('returns focus to the trigger when the calendar closes', async () => {
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} onJump={() => {}} />
      );

      click(trigger(container));
      await flush();
      click(calendarDay('July 20, 2026'));
      await flush();

      expect(document.activeElement).toBe(trigger(container));
    });
  });

  describe('mobile', () => {
    it('keeps a real date input on desktop', () => {
      const container = mount(
        <DateJumpField today={TODAY} isMobile={false} onJump={() => {}} />
      );

      expect(field(container).type).toBe('date');
    });

    it('leaves the text box writable on desktop', () => {
      const container = mount(
        <DateJumpField today={TODAY} isMobile={false} onJump={() => {}} />
      );

      expect(field(container).readOnly).toBe(false);
    });

    it('shows no text box at all on mobile', () => {
      // It could not be typed into there — a segmented date input takes no
      // keyboard on a phone — so all it did was restate the date the range
      // label beside it already gives, out of a controls bar narrow enough
      // that the label was truncated to make room. Its absence is also what
      // finally rules out WebKit's own picker, which any tap of a date input
      // raises, read-only included, with no way to decline.
      const container = mount(
        <DateJumpField today={TODAY} isMobile onJump={() => {}} />
      );

      expect(container.querySelector('.ir-queue-date-jump')).toBeNull();
      expect(container.querySelector('input')).toBeNull();
    });

    it('still offers the calendar on mobile', async () => {
      // With the box gone the trigger is the only way in, so it has to be
      // there and it has to open.
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} isMobile onJump={() => {}} />
      );

      click(trigger(container));
      await flush();

      expect(calendar()).not.toBeNull();
    });

    it('still reports a day picked on mobile', async () => {
      // The whole jump path there now runs through the calendar, with no box
      // left to read a value back out of.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField today={TODAY} value={TODAY} isMobile onJump={onJump} />
      );

      click(trigger(container));
      await flush();
      click(calendarDay('July 20, 2026'));

      expect(onJump).toHaveBeenCalledTimes(1);
      const [jumped] = onJump.mock.calls[0] as [Date];
      expect(jumped.getTime()).toBe(new Date(2026, 6, 20).getTime());
    });

    it('leaves a click on the text box alone on desktop', async () => {
      // Clicking a segment there means "edit this segment"; a calendar
      // appearing over it would be in the way.
      const container = mount(
        <DateJumpField
          today={TODAY}
          value={TODAY}
          isMobile={false}
          onJump={() => {}}
        />
      );

      click(dateInput(container));
      await flush();

      expect(calendar()).toBeNull();
    });
  });
});
