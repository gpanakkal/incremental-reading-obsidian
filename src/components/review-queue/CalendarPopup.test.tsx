// @vitest-environment jsdom
import { isSameDay } from '#/lib/utils';
import fc from 'fast-check';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMonthGrid, CalendarPopup } from './CalendarPopup';

// #region HELPERS

/** A fixed review day, so nothing here depends on the clock. */
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

/** An anchor in the document, since the popup measures against one. */
function makeAnchor(): HTMLElement {
  const anchor = document.createElement('div');
  document.body.appendChild(anchor);
  return anchor;
}

/** The anchor wrapped as the ref the popup expects. */
function makeAnchorRef(anchor: HTMLElement = makeAnchor()) {
  return { current: anchor };
}

type PopupProps = Parameters<typeof CalendarPopup>[0];

function makeProps(overrides: Partial<PopupProps> = {}): PopupProps {
  return {
    container: document.body,
    value: new Date(2026, 6, 15),
    today: TODAY,
    onSelect: vi.fn(),
    onDismiss: vi.fn(),
    anchorRef: makeAnchorRef(),
    ...overrides,
  };
}

/**
 * The popup is portalled to `<body>`, so it is never inside the container it
 * was mounted from — every lookup goes through the owning document instead.
 */
function dayButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.ownerDocument.querySelectorAll('.ir-calendar-day')
  );
}

/** The day cell carrying a given accessible name, e.g. `July 16, 2026`. */
function dayNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const match = dayButtons(container).find((day) =>
    day.getAttribute('aria-label')?.endsWith(label)
  );
  if (!match) throw new Error(`No day cell for ${label}`);
  return match;
}

function monthLabel(container: HTMLElement): string | null | undefined {
  return container.ownerDocument.querySelector('.ir-calendar-month')
    ?.textContent;
}

function navButtons(container: HTMLElement) {
  const [previous, next] = Array.from(
    container.ownerDocument.querySelectorAll<HTMLButtonElement>(
      '.ir-calendar-nav'
    )
  );
  return { previous, next };
}

/** A footer button by its visible text. */
function action(container: HTMLElement, text: string): HTMLButtonElement {
  const match = Array.from(
    container.ownerDocument.querySelectorAll<HTMLButtonElement>(
      '.ir-calendar-action'
    )
  ).find((button) => button.textContent === text);
  if (!match) throw new Error(`No action button labelled ${text}`);
  return match;
}

function click(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Press a key on whatever currently holds focus. */
function pressKey(key: string) {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true })
  );
}

/** The single `Date` a spy was called with. */
function selectedDay(onSelect: ReturnType<typeof vi.fn>): Date {
  const [day] = onSelect.mock.calls[0] as [Date];
  return day;
}

/** Local midnight of a date, for comparing against a reported day. */
function midnight(year: number, month: number, day: number) {
  return new Date(year, month, day).getTime();
}

// #endregion

describe('buildMonthGrid', () => {
  // `noInvalidDate`, because the grid is only ever built from a day the
  // calendar is already showing — `startOfDay` of the queue's own dates — and
  // an Invalid Date cannot reach it. Left in, it would only assert that
  // garbage in gives garbage out.
  const anyMonth = fc.date({
    min: new Date('1970-01-01'),
    max: new Date('2200-12-31'),
    noInvalidDate: true,
  });

  it('always fills six whole weeks, whatever the month', () => {
    // A fixed row count is what stops the popup resizing as the user pages
    // through months: five weeks hold most months but not all.
    fc.assert(
      fc.property(anyMonth, (month) => {
        expect(buildMonthGrid(month)).toHaveLength(42);
      })
    );
  });

  it('opens every grid on a Sunday', () => {
    fc.assert(
      fc.property(anyMonth, (month) => {
        expect(buildMonthGrid(month)[0].getDay()).toBe(0);
      })
    );
  });

  it('runs consecutive calendar days with no gaps or repeats', () => {
    fc.assert(
      fc.property(anyMonth, (month) => {
        const days = buildMonthGrid(month);
        for (let index = 1; index < days.length; index++) {
          const previous = days[index - 1];
          const expected = new Date(
            previous.getFullYear(),
            previous.getMonth(),
            previous.getDate() + 1
          );
          // Compared by calendar day rather than by elapsed milliseconds: a
          // day spanning a daylight-saving change is 23 or 25 hours long.
          expect(isSameDay(days[index], expected)).toBe(true);
        }
      })
    );
  });

  it('places the first of the month under its own weekday', () => {
    fc.assert(
      fc.property(anyMonth, (month) => {
        const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
        const days = buildMonthGrid(month);
        expect(isSameDay(days[firstOfMonth.getDay()], firstOfMonth)).toBe(true);
      })
    );
  });

  it('holds every day of its own month exactly once', () => {
    fc.assert(
      fc.property(anyMonth, (month) => {
        const days = buildMonthGrid(month);
        const daysInMonth = new Date(
          month.getFullYear(),
          month.getMonth() + 1,
          0
        ).getDate();
        const ownDays = days.filter(
          (day) => day.getMonth() === month.getMonth()
        );
        expect(ownDays).toHaveLength(daysInMonth);
      })
    );
  });

  it('returns local midnight for every day', () => {
    // The grid's days are reported straight to the queue, which jumps to the
    // page opening on that review day. A time of day riding along would be
    // compared against the bounds and could cross one.
    fc.assert(
      fc.property(anyMonth, (month) => {
        for (const day of buildMonthGrid(month)) {
          expect(day.getHours()).toBe(0);
          expect(day.getMinutes()).toBe(0);
          expect(day.getSeconds()).toBe(0);
          expect(day.getMilliseconds()).toBe(0);
        }
      })
    );
  });

  it('leads and trails the month with its neighbours, never with blanks', () => {
    // The gap both native pickers leave: iOS omits these days entirely, so its
    // first and last weeks stop mid-row.
    fc.assert(
      fc.property(anyMonth, (month) => {
        const days = buildMonthGrid(month);
        const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
        const leading = days.slice(0, firstOfMonth.getDay());
        for (const day of leading) {
          expect(day.getMonth()).not.toBe(month.getMonth());
          expect(day.getTime()).toBeLessThan(firstOfMonth.getTime());
        }
      })
    );
  });
});

describe('CalendarPopup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders a six-week grid of days', () => {
    const container = mount(<CalendarPopup {...makeProps()} />);

    expect(dayButtons(container)).toHaveLength(42);
  });

  it('names the month and year it is showing', () => {
    const container = mount(
      <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
    );

    expect(monthLabel(container)).toBe('July 2026');
  });

  it('opens on the review day when it has no date of its own', () => {
    const container = mount(
      <CalendarPopup {...makeProps({ value: undefined })} />
    );

    expect(monthLabel(container)).toBe('July 2026');
  });

  it('marks the days belonging to the neighbouring months', () => {
    // July 2026 opens on a Wednesday, so three days of June lead the grid.
    const container = mount(
      <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
    );

    const outside = dayButtons(container).filter((day) =>
      day.hasAttribute('data-outside-month')
    );

    expect(outside.length).toBeGreaterThan(0);
    for (const day of outside) {
      expect(day.getAttribute('aria-label')).not.toContain('July');
    }
  });

  it('reports a day from a neighbouring month like any other', () => {
    // They are rendered to complete the week, not as decoration: clicking one
    // has to jump, or the first and last weeks are half dead.
    const onSelect = vi.fn();
    const container = mount(
      <CalendarPopup
        {...makeProps({ value: new Date(2026, 6, 15), onSelect })}
      />
    );

    click(dayNamed(container, 'June 30, 2026'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 5, 30));
  });

  it('reports the chosen day as a local Date at midnight', () => {
    const onSelect = vi.fn();
    const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);

    click(dayNamed(container, 'July 20, 2026'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 6, 20));
  });

  it('reports one day per click', () => {
    const onSelect = vi.fn();
    const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);

    click(dayNamed(container, 'July 20, 2026'));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks the day it was given as selected, and only that one', () => {
    const container = mount(
      <CalendarPopup {...makeProps({ value: new Date(2026, 6, 20) })} />
    );

    const selected = dayButtons(container).filter(
      (day) => day.getAttribute('aria-selected') === 'true'
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('aria-label')).toContain('July 20, 2026');
  });

  it('marks nothing as selected when it has no date of its own', () => {
    const container = mount(
      <CalendarPopup {...makeProps({ value: undefined })} />
    );

    const selected = dayButtons(container).filter(
      (day) => day.getAttribute('aria-selected') === 'true'
    );

    expect(selected).toHaveLength(0);
  });

  it('marks the review day it was given as today, not the clock’s day', () => {
    // The review day is the calendar day shifted by the rollover offset, so
    // reading the clock here would ring the wrong cell for anyone whose
    // offset has not yet elapsed.
    const container = mount(
      <CalendarPopup
        {...makeProps({
          value: new Date(2026, 6, 15),
          today: new Date(2026, 6, 2),
        })}
      />
    );

    const marked = dayButtons(container).filter((day) =>
      day.hasAttribute('data-today')
    );

    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute('aria-label')).toContain('July 2, 2026');
  });

  it('offers no reset or confirm button', () => {
    // WebKit's picker put both at the foot of the calendar on iOS, and neither
    // did anything. Today and Cancel are the whole footer.
    const container = mount(<CalendarPopup {...makeProps()} />);

    const actions = Array.from(
      container.ownerDocument.querySelectorAll('.ir-calendar-action')
    ).map((button) => button.textContent);

    expect(actions).toEqual(['Today', 'Cancel']);
  });

  describe('bounds', () => {
    it('marks days before the first due day unreachable', () => {
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            min: new Date(2026, 6, 10),
          })}
        />
      );

      expect(
        dayNamed(container, 'July 9, 2026').getAttribute('aria-disabled')
      ).toBe('true');
      expect(
        dayNamed(container, 'July 10, 2026').getAttribute('aria-disabled')
      ).toBe('false');
    });

    it('marks days after the last due day unreachable', () => {
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            max: new Date(2026, 6, 20),
          })}
        />
      );

      expect(
        dayNamed(container, 'July 21, 2026').getAttribute('aria-disabled')
      ).toBe('true');
      expect(
        dayNamed(container, 'July 20, 2026').getAttribute('aria-disabled')
      ).toBe('false');
    });

    it('leaves a bound’s own day reachable however late in it the bound falls', () => {
      // The bounds are inclusive review days. A `max` carrying a time of day
      // must not rule out the day it names.
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            max: new Date(2026, 6, 20, 18, 30),
          })}
        />
      );

      expect(
        dayNamed(container, 'July 20, 2026').getAttribute('aria-disabled')
      ).toBe('false');
    });

    it('reports nothing when an unreachable day is clicked', () => {
      const onSelect = vi.fn();
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            max: new Date(2026, 6, 20),
            onSelect,
          })}
        />
      );

      click(dayNamed(container, 'July 21, 2026'));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps unreachable days focusable', () => {
      // `aria-disabled` rather than the `disabled` attribute, so arrowing
      // across the end of the queue's range does not fall into a hole.
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            max: new Date(2026, 6, 20),
          })}
        />
      );

      expect(dayNamed(container, 'July 21, 2026').disabled).toBe(false);
    });

    it('leaves every day reachable when the queue has no bounds', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      for (const day of dayButtons(container)) {
        expect(day.getAttribute('aria-disabled')).toBe('false');
      }
    });
  });

  describe('month navigation', () => {
    it('moves back a month', async () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      click(navButtons(container).previous);
      await flush();

      expect(monthLabel(container)).toBe('June 2026');
    });

    it('moves forward a month', async () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      click(navButtons(container).next);
      await flush();

      expect(monthLabel(container)).toBe('August 2026');
    });

    it('holds the day of the month across a shorter one', async () => {
      // Jan 31 stepped back must land on Feb 28, not roll over into March.
      const container = mount(
        <CalendarPopup {...makeProps({ value: new Date(2026, 2, 31) })} />
      );

      click(navButtons(container).previous);
      await flush();

      expect(monthLabel(container)).toBe('February 2026');
    });

    it('stops going back when nothing before this month is due', () => {
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            min: new Date(2026, 6, 1),
          })}
        />
      );

      expect(navButtons(container).previous.disabled).toBe(true);
      expect(navButtons(container).next.disabled).toBe(false);
    });

    it('stops going forward when nothing after this month is due', () => {
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            max: new Date(2026, 6, 31),
          })}
        />
      );

      expect(navButtons(container).next.disabled).toBe(true);
      expect(navButtons(container).previous.disabled).toBe(false);
    });

    it('still pages back when part of the previous month is due', () => {
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            min: new Date(2026, 5, 20),
          })}
        />
      );

      expect(navButtons(container).previous.disabled).toBe(false);
    });
  });

  describe('today', () => {
    it('reports the review day it was given', () => {
      const onSelect = vi.fn();
      const container = mount(
        <CalendarPopup
          {...makeProps({ today: new Date(2026, 6, 2), onSelect })}
        />
      );

      click(action(container, 'Today'));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 6, 2));
    });

    it('reports today even when it is outside the queue’s range', () => {
      // Reported unclamped on purpose: the field pulls it to the nearest
      // bound, which is what a typed out-of-range date already does.
      const onSelect = vi.fn();
      const container = mount(
        <CalendarPopup
          {...makeProps({
            today: new Date(2026, 6, 15),
            min: new Date(2026, 7, 1),
            onSelect,
          })}
        />
      );

      click(action(container, 'Today'));

      expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 6, 15));
    });
  });

  describe('dismissal', () => {
    it('dismisses on cancel without reporting a day', () => {
      const onSelect = vi.fn();
      const onDismiss = vi.fn();
      const container = mount(
        <CalendarPopup {...makeProps({ onSelect, onDismiss })} />
      );

      click(action(container, 'Cancel'));

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('dismisses on escape', () => {
      const onSelect = vi.fn();
      const onDismiss = vi.fn();
      const container = mount(
        <CalendarPopup {...makeProps({ onSelect, onDismiss })} />
      );

      dayNamed(container, 'July 15, 2026').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('dismisses on a press outside it', () => {
      const onDismiss = vi.fn();
      mount(<CalendarPopup {...makeProps({ onDismiss })} />);

      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      );

      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('stays open on a press inside it', () => {
      const onDismiss = vi.fn();
      const container = mount(<CalendarPopup {...makeProps({ onDismiss })} />);

      dayNamed(container, 'July 15, 2026').dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      );

      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('stays open on a press on its own anchor', () => {
      // The trigger closes the popup itself. Dismissing here as well would
      // close it on the press and reopen it on the click that follows.
      const onDismiss = vi.fn();
      const anchor = makeAnchor();
      mount(
        <CalendarPopup
          {...makeProps({ anchorRef: makeAnchorRef(anchor), onDismiss })}
        />
      );

      anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('stops listening for outside presses once it is gone', () => {
      const onDismiss = vi.fn();
      const container = document.createElement('div');
      document.body.appendChild(container);
      render(<CalendarPopup {...makeProps({ onDismiss })} />, container);

      render(null, container);
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      );

      expect(onDismiss).not.toHaveBeenCalled();
    });
  });

  describe('keyboard', () => {
    it('focuses the day it opened on', () => {
      const container = mount(
        <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
      );

      expect(document.activeElement).toBe(dayNamed(container, 'July 15, 2026'));
    });

    it('exposes exactly one tab stop for the whole grid', () => {
      // 42 tab stops would make tabbing past the calendar a chore.
      const container = mount(<CalendarPopup {...makeProps()} />);

      const stops = dayButtons(container).filter((day) => day.tabIndex === 0);

      expect(stops).toHaveLength(1);
    });

    it('moves a day right and left with the arrow keys', async () => {
      const container = mount(
        <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
      );

      pressKey('ArrowRight');
      await flush();
      expect(document.activeElement).toBe(dayNamed(container, 'July 16, 2026'));

      pressKey('ArrowLeft');
      await flush();
      expect(document.activeElement).toBe(dayNamed(container, 'July 15, 2026'));
    });

    it('moves a week up and down with the arrow keys', async () => {
      const container = mount(
        <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
      );

      pressKey('ArrowDown');
      await flush();
      expect(document.activeElement).toBe(dayNamed(container, 'July 22, 2026'));

      pressKey('ArrowUp');
      await flush();
      expect(document.activeElement).toBe(dayNamed(container, 'July 15, 2026'));
    });

    it('moves to the ends of the week with home and end', async () => {
      // July 15 2026 is a Wednesday.
      const container = mount(
        <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
      );

      pressKey('Home');
      await flush();
      expect(document.activeElement).toBe(dayNamed(container, 'July 12, 2026'));

      pressKey('End');
      await flush();
      expect(document.activeElement).toBe(dayNamed(container, 'July 18, 2026'));
    });

    it('moves a month with page up and page down', async () => {
      const container = mount(
        <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
      );

      pressKey('PageDown');
      await flush();
      expect(monthLabel(container)).toBe('August 2026');
      expect(document.activeElement).toBe(
        dayNamed(container, 'August 15, 2026')
      );

      pressKey('PageUp');
      await flush();
      expect(monthLabel(container)).toBe('July 2026');
    });

    it('carries the grid into the next month when arrowing off its end', async () => {
      const container = mount(
        <CalendarPopup {...makeProps({ value: new Date(2026, 6, 31) })} />
      );

      pressKey('ArrowRight');
      await flush();

      expect(monthLabel(container)).toBe('August 2026');
      expect(document.activeElement).toBe(
        dayNamed(container, 'August 1, 2026')
      );
    });

    it('reports the focused day on enter', async () => {
      const onSelect = vi.fn();
      mount(
        <CalendarPopup
          {...makeProps({ value: new Date(2026, 6, 15), onSelect })}
        />
      );

      pressKey('ArrowRight');
      await flush();
      pressKey('Enter');

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 6, 16));
    });

    it('reports the focused day on space', async () => {
      const onSelect = vi.fn();
      mount(
        <CalendarPopup
          {...makeProps({ value: new Date(2026, 6, 15), onSelect })}
        />
      );

      pressKey(' ');
      await flush();

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 6, 15));
    });

    it('reports nothing on enter over an unreachable day', async () => {
      const onSelect = vi.fn();
      mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 20),
            max: new Date(2026, 6, 20),
            onSelect,
          })}
        />
      );

      pressKey('ArrowRight');
      await flush();
      pressKey('Enter');

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps focus on the month arrows when they are clicked', async () => {
      // The arrows move the grid for a mouse user, whose focus belongs on the
      // arrow they are still clicking, not on a day in the month it revealed.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const { next } = navButtons(container);

      next.focus();
      click(next);
      await flush();

      expect(document.activeElement).toBe(next);
    });
  });
});
