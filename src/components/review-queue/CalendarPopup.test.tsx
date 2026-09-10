// @vitest-environment jsdom
import { isSameDay } from '#/lib/utils';
import fc from 'fast-check';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMonthGrid,
  CalendarPopup,
  commitThreshold,
} from './CalendarPopup';

// #region HELPERS

/** A fixed review day, so nothing here depends on the clock. */
const TODAY = new Date(2026, 6, 15);

/** Where every gesture here starts. Well inside a popup of any size. */
const ORIGIN = { x: 200, y: 200 };

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
 * The days of the month actually on screen.
 *
 * Two lookups in one: the popup is portalled to `<body>`, so nothing is inside
 * the container it was mounted from; and the grid renders the neighbouring
 * months either side of the visible one, which repeat some of the same dates.
 * Only the centre panel is what a user can see or reach.
 */
function dayButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.ownerDocument.querySelectorAll(
      "[data-panel='0'] .ir-calendar-day"
    )
  );
}

/** Every day rendered, including the two months parked off screen. */
function allDayButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.ownerDocument.querySelectorAll('.ir-calendar-day')
  );
}

/** The strip carrying the three months, which is what a drag moves. */
function track(container: HTMLElement): HTMLElement {
  return container.ownerDocument.querySelector(
    '.ir-calendar-track'
  ) as HTMLElement;
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

/**
 * A pointer event at a point, carrying a modality.
 *
 * Built from `MouseEvent` rather than `PointerEvent`, which jsdom does not
 * construct. The component reads only `pointerType` and the client
 * coordinates, and a `MouseEvent` of the right type reaches the same listener.
 */
function pointerEvent(
  type: string,
  { x, y, pointerType }: { x: number; y: number; pointerType: string }
) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

/**
 * Drag across the grid from a fixed origin and lift. Positive `acrossX` drags
 * rightwards.
 */
function swipe(
  container: HTMLElement,
  {
    acrossX,
    acrossY = 0,
    pointerType = 'touch',
    from,
  }: {
    acrossX: number;
    acrossY?: number;
    pointerType?: string;
    from?: HTMLElement;
  }
) {
  drag(container, { acrossX, acrossY, pointerType, from });
  release(container);
}

/**
 * Press and move, without letting go. The moves matter: the gesture reads its
 * direction and its distance from the path, not from where the finger lifts,
 * so a press-and-release alone is a tap however far apart the two points are.
 */
function drag(
  container: HTMLElement,
  {
    acrossX,
    acrossY = 0,
    pointerType = 'touch',
    from,
  }: {
    acrossX: number;
    acrossY?: number;
    pointerType?: string;
    from?: HTMLElement;
  }
) {
  const grid = container.ownerDocument.querySelector(
    '.ir-calendar-grid'
  ) as HTMLElement;
  press(container, { pointerType, from });
  // Halfway, then all the way, so the axis is decided on the path rather than
  // in one jump.
  for (const fraction of [0.5, 1]) {
    grid.dispatchEvent(
      pointerEvent('pointermove', {
        x: ORIGIN.x + acrossX * fraction,
        y: ORIGIN.y + acrossY * fraction,
        pointerType,
      })
    );
  }
}

/**
 * Put a pointer down and hold it there. Pressed on the day named when there is
 * one, so both the mark a held day wears and the click a real gesture ends
 * with can be modelled.
 */
function press(
  container: HTMLElement,
  {
    pointerType = 'touch',
    from,
  }: { pointerType?: string; from?: HTMLElement } = {}
) {
  const grid = container.ownerDocument.querySelector(
    '.ir-calendar-grid'
  ) as HTMLElement;
  (from ?? grid).dispatchEvent(
    pointerEvent('pointerdown', { ...ORIGIN, pointerType })
  );
}

/**
 * Move the finger to a point, without pressing first. Used to hold it still,
 * or to continue a drag already under way.
 */
function moveTo(
  container: HTMLElement,
  { acrossX, acrossY = 0 }: { acrossX: number; acrossY?: number }
) {
  const grid = container.ownerDocument.querySelector(
    '.ir-calendar-grid'
  ) as HTMLElement;
  grid.dispatchEvent(
    pointerEvent('pointermove', {
      x: ORIGIN.x + acrossX,
      y: ORIGIN.y + acrossY,
      pointerType: 'touch',
    })
  );
}

/** Hand the gesture to the browser, as a scroll taking it over would. */
function cancel(container: HTMLElement) {
  const grid = container.ownerDocument.querySelector(
    '.ir-calendar-grid'
  ) as HTMLElement;
  grid.dispatchEvent(
    pointerEvent('pointercancel', { ...ORIGIN, pointerType: 'touch' })
  );
}

/** Take the pointer off the grid, still held down. */
function leave(container: HTMLElement, pointerType = 'mouse') {
  const grid = container.ownerDocument.querySelector(
    '.ir-calendar-grid'
  ) as HTMLElement;
  grid.dispatchEvent(pointerEvent('pointerleave', { ...ORIGIN, pointerType }));
}

/** The days wearing the mark a held one gets, across all three months. */
function pressedDays(container: HTMLElement): HTMLButtonElement[] {
  return allDayButtons(container).filter((day) =>
    day.hasAttribute('data-pressed')
  );
}

/**
 * Report a laid-out width for the strip of months, which jsdom — having no
 * layout engine — otherwise measures as zero. It is the width the commit
 * distance is capped against.
 */
function measureTrack(container: HTMLElement, width: number) {
  Object.defineProperty(track(container), 'offsetWidth', {
    value: width,
    configurable: true,
  });
}

/**
 * Whether a drag of `acrossX` px pages a calendar whose months measure `width`
 * across. Mounts and tears down its own popup, since the two it compares
 * cannot be on screen at once.
 */
async function pages({ width, acrossX }: { width: number; acrossX: number }) {
  const container = mount(<CalendarPopup {...makeProps()} />);
  measureTrack(container, width);
  swipe(container, { acrossX });
  await flush();
  const paged = monthLabel(container) !== 'July 2026';
  document.body.innerHTML = '';
  return paged;
}

/** Lift the finger, ending whatever gesture is in progress. */
function release(container: HTMLElement, pointerType = 'touch') {
  const grid = container.ownerDocument.querySelector(
    '.ir-calendar-grid'
  ) as HTMLElement;
  grid.dispatchEvent(pointerEvent('pointerup', { x: 0, y: 0, pointerType }));
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

describe('commitThreshold', () => {
  // Any panel a layout engine could report, from the unmeasured zero up past
  // the widest screen the popup could be opened on. Whole pixels, because the
  // only source of these is `offsetWidth`, which rounds to them — a fractional
  // width small enough to be interesting here is one no engine can produce.
  const anyWidth = fc.integer({ min: 0, max: 4000 });

  it('always asks for some travel', () => {
    // A threshold of zero would page the month on the first pixel of a drag,
    // which is every gesture that touches the grid at all.
    fc.assert(
      fc.property(anyWidth, (width) => {
        expect(commitThreshold(width)).toBeGreaterThan(0);
      })
    );
  });

  it('never asks for more than a fifth of a panel it can measure', () => {
    // The cap is what keeps the gesture possible on a popup squeezed onto a
    // narrow screen, where the fixed distance could be most of the month.
    fc.assert(
      fc.property(
        anyWidth.filter((width) => width > 0),
        (width) => {
          expect(commitThreshold(width)).toBeLessThanOrEqual(width * 0.2);
        }
      )
    );
  });

  it('never asks for more than the fixed distance, however wide the panel', () => {
    // The point of the change. A share of the month asked for a longer drag on
    // whichever screen drew the calendar wider; this bound is what makes the
    // gesture the same flick of the thumb on a phone and on a tablet.
    fc.assert(
      fc.property(anyWidth, (width) => {
        expect(commitThreshold(width)).toBeLessThanOrEqual(commitThreshold(0));
      })
    );
  });

  it('asks no more of a narrow panel than of a wide one', () => {
    // Only the cap moves with the width, and it only ever gives ground.
    fc.assert(
      fc.property(anyWidth, anyWidth, (a, b) => {
        const [narrow, wide] = a < b ? [a, b] : [b, a];
        // Zero is the unmeasured panel below, which is not on this scale.
        if (narrow === 0) return;
        expect(commitThreshold(narrow)).toBeLessThanOrEqual(
          commitThreshold(wide)
        );
      })
    );
  });

  it('asks the full distance of a panel nothing has measured', () => {
    // Zero is what every box reports before it is laid out, and under a test
    // runner with no layout engine at all. There is no share of it to cap
    // against, so the fixed distance has to stand on its own.
    expect(commitThreshold(0)).toBe(commitThreshold(4000));
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

  it('does not page the month when a day either side of it takes focus', async () => {
    // The bug this guards: pressing a mouse button focuses the day under it,
    // and the cursor sync that followed moved the whole grid to that day's
    // month while the button was still down — under a drag, out from under the
    // drag itself. Every other action here happens on release, and so must
    // this one.
    //
    // Awaited, because the sync runs through state: an assertion made in the
    // same tick passes whether or not the month is on its way out.
    const container = mount(
      <CalendarPopup {...makeProps({ value: new Date(2026, 6, 15) })} />
    );

    dayNamed(container, 'June 30, 2026').focus();
    await flush();

    expect(monthLabel(container)).toBe('July 2026');
  });

  it('still reports a day either side of the month once released', () => {
    // The press must do nothing; the click that follows must still jump.
    const onSelect = vi.fn();
    const container = mount(
      <CalendarPopup
        {...makeProps({ value: new Date(2026, 6, 15), onSelect })}
      />
    );
    const day = dayNamed(container, 'June 30, 2026');

    day.focus();
    click(day);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 5, 30));
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

  describe('swipe', () => {
    it('pages forward when the grid is dragged left', async () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      swipe(container, { acrossX: -80 });
      await flush();

      expect(monthLabel(container)).toBe('August 2026');
    });

    it('pages back when the grid is dragged right', async () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      swipe(container, { acrossX: 80 });
      await flush();

      expect(monthLabel(container)).toBe('June 2026');
    });

    it('ignores a drag too short to be meant', async () => {
      // A finger slides a little on the way off a tap. That is a tap.
      const container = mount(<CalendarPopup {...makeProps()} />);

      swipe(container, { acrossX: -12 });
      await flush();

      expect(monthLabel(container)).toBe('July 2026');
    });

    it('ignores a drag that is mostly vertical', async () => {
      // Scrolling the queue behind the popup drifts sideways; that must not
      // page the month out from under the finger.
      const container = mount(<CalendarPopup {...makeProps()} />);

      swipe(container, { acrossX: -60, acrossY: 90 });
      await flush();

      expect(monthLabel(container)).toBe('July 2026');
    });

    it('pages for a drag made with a mouse', async () => {
      // Paging by dragging is not a mobile feature that a touchscreen laptop
      // happens to reach: a mouse drags the month exactly as a finger does,
      // and the arrows stay there for anyone who would rather click.
      const container = mount(<CalendarPopup {...makeProps()} />);

      swipe(container, { acrossX: -80, pointerType: 'mouse' });
      await flush();

      expect(monthLabel(container)).toBe('August 2026');
    });

    it('does not pick the day a mouse drag comes to rest on', async () => {
      // The press that starts a mouse drag lands on a day and the release
      // lands on another, and a click between the two is the engine's default
      // reading of that. It is a drag, not a choice.
      const onSelect = vi.fn();
      const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);
      const day = dayNamed(container, 'July 20, 2026');

      swipe(container, { acrossX: -80, pointerType: 'mouse', from: day });
      await flush();
      click(day);

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('stops at the last month the queue reaches', async () => {
      // The same bound the forward arrow stops at, so the two ways of paging
      // agree.
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            max: new Date(2026, 6, 31),
          })}
        />
      );

      swipe(container, { acrossX: -80 });
      await flush();

      expect(monthLabel(container)).toBe('July 2026');
    });

    it('stops at the first month the queue reaches', async () => {
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            min: new Date(2026, 6, 1),
          })}
        />
      );

      swipe(container, { acrossX: 80 });
      await flush();

      expect(monthLabel(container)).toBe('July 2026');
    });

    it('does not pick the day the finger comes to rest on', async () => {
      // A swipe ends over some day, and the click that follows it would
      // otherwise select that day as well as paging the month.
      const onSelect = vi.fn();
      const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);
      const day = dayNamed(container, 'July 20, 2026');

      swipe(container, { acrossX: -80, from: day });
      await flush();
      click(day);

      expect(onSelect).not.toHaveBeenCalled();
      expect(monthLabel(container)).toBe('August 2026');
    });

    it('does not pick the day a drag that sprang back rested on', async () => {
      // A drag short of the commit distance puts the month back where it was.
      // It must not take the day under the finger with it and close the popup:
      // the grid moved, which makes the release a cancel rather than a choice.
      const onSelect = vi.fn();
      const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);
      const day = dayNamed(container, 'July 20, 2026');

      swipe(container, { acrossX: -20, from: day });
      await flush();
      click(day);

      expect(onSelect).not.toHaveBeenCalled();
      expect(monthLabel(container)).toBe('July 2026');
    });

    it('does not pick the day a mostly vertical drag rested on', async () => {
      // Scrolling the queue behind the popup starts on some day and ends on
      // another. Once a gesture has an axis it is a gesture, whichever axis
      // that turned out to be.
      const onSelect = vi.fn();
      const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);
      const day = dayNamed(container, 'July 20, 2026');

      swipe(container, { acrossX: 0, acrossY: -60, from: day });
      await flush();
      click(day);

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('still picks the day a tap lands on', async () => {
      // The guard above must cost nothing when the finger did not travel.
      const onSelect = vi.fn();
      const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);
      const day = dayNamed(container, 'July 20, 2026');

      swipe(container, { acrossX: 0, from: day });
      await flush();
      click(day);

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 6, 20));
    });

    it('picks normally on the tap after a swipe that produced no click', async () => {
      // A drag often ends without the browser synthesising a click at all, so
      // the suppression cannot rely on one arriving to clear it. The next
      // gesture's own press is what clears it, and that tap must go through.
      const onSelect = vi.fn();
      const container = mount(<CalendarPopup {...makeProps({ onSelect })} />);

      swipe(container, { acrossX: -80 });
      await flush();

      const day = dayNamed(container, 'August 20, 2026');
      // A tap is the same gesture with no travel.
      swipe(container, { acrossX: 0, from: day });
      click(day);

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(selectedDay(onSelect).getTime()).toBe(midnight(2026, 7, 20));
    });

    it('does not page when the browser takes the gesture over', async () => {
      const container = mount(<CalendarPopup {...makeProps()} />);
      const grid = container.ownerDocument.querySelector(
        '.ir-calendar-grid'
      ) as HTMLElement;

      grid.dispatchEvent(
        pointerEvent('pointerdown', { x: 200, y: 200, pointerType: 'touch' })
      );
      grid.dispatchEvent(
        pointerEvent('pointercancel', { x: 200, y: 200, pointerType: 'touch' })
      );
      grid.dispatchEvent(
        pointerEvent('pointerup', { x: 120, y: 200, pointerType: 'touch' })
      );
      await flush();

      expect(monthLabel(container)).toBe('July 2026');
    });
  });

  describe('dragging', () => {
    it('renders the months either side of the one on screen', () => {
      // There has to be something to pull into view; a drag cannot reveal a
      // month that is not rendered yet.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const doc = container.ownerDocument;

      expect(doc.querySelector("[data-panel='-1']")).not.toBeNull();
      expect(doc.querySelector("[data-panel='1']")).not.toBeNull();
      expect(allDayButtons(container)).toHaveLength(42 * 3);
    });

    it('hides the months either side from assistive technology', () => {
      // They are scenery. Left exposed they would triple the grid and read out
      // dates nobody is looking at.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const doc = container.ownerDocument;

      expect(
        doc.querySelector("[data-panel='-1']")?.getAttribute('aria-hidden')
      ).toBe('true');
      expect(
        doc.querySelector("[data-panel='1']")?.getAttribute('aria-hidden')
      ).toBe('true');
      expect(
        doc.querySelector("[data-panel='0']")?.getAttribute('aria-hidden')
      ).toBe('false');
    });

    it('offers only one tab stop across all three months', () => {
      // The neighbouring panels repeat some of the same dates, so an unscoped
      // roving tabindex would put a second stop on a month off screen.
      const container = mount(<CalendarPopup {...makeProps()} />);

      const stops = allDayButtons(container).filter(
        (day) => day.tabIndex === 0
      );

      expect(stops).toHaveLength(1);
    });

    it('follows the finger while it moves', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      drag(container, { acrossX: -30 });

      expect(track(container).style.transform).toBe('translateX(-30px)');
    });

    it('stops where the finger stops', () => {
      // The whole point of tracking the drag rather than waiting for release:
      // a finger held still leaves the month held still.
      const container = mount(<CalendarPopup {...makeProps()} />);

      drag(container, { acrossX: -30 });
      moveTo(container, { acrossX: -30 });

      expect(track(container).style.transform).toBe('translateX(-30px)');
    });

    it('keeps following a finger that turns back', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      drag(container, { acrossX: -60 });
      moveTo(container, { acrossX: -10 });

      expect(track(container).style.transform).toBe('translateX(-10px)');
    });

    it('does not move for a drag that is mostly vertical', () => {
      // The axis is decided once, on the first movement worth reading, and
      // never revisited — so a scroll that wavers cannot start dragging the
      // month halfway through.
      const container = mount(<CalendarPopup {...makeProps()} />);

      drag(container, { acrossX: -60, acrossY: 90 });
      moveTo(container, { acrossX: -120, acrossY: 90 });

      expect(track(container).style.transform).toBe('');
    });

    it('follows a mouse while it moves', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      drag(container, { acrossX: -60, pointerType: 'mouse' });

      expect(track(container).style.transform).toBe('translateX(-60px)');
    });

    it('gives only a little where there is no month to pull in', () => {
      // Past the end of the queue the track answers the finger, at a quarter
      // of its travel, rather than either sticking or revealing an empty month.
      const container = mount(
        <CalendarPopup
          {...makeProps({
            value: new Date(2026, 6, 15),
            max: new Date(2026, 6, 31),
          })}
        />
      );

      drag(container, { acrossX: -40 });

      expect(track(container).style.transform).toBe('translateX(-10px)');
    });

    it('springs back when the finger lifts short of the threshold', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      drag(container, { acrossX: -12 });
      expect(track(container).style.transform).toBe('translateX(-12px)');

      release(container);

      expect(track(container).style.transform).toBe('');
      expect(track(container).classList).toContain(
        'ir-calendar-track-settling'
      );
      expect(monthLabel(container)).toBe('July 2026');
    });

    it('settles into the committed month when the finger lifts past it', async () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      swipe(container, { acrossX: -80 });
      await flush();

      expect(monthLabel(container)).toBe('August 2026');
      // At rest again: the layout effect puts the track back where the finger
      // left it and then releases it, so what is left behind is the resting
      // position plus the transition that carried it there.
      expect(track(container).style.transform).toBe('');
      expect(track(container).classList).toContain(
        'ir-calendar-track-settling'
      );
    });

    it('does not arm the settle transition for a plain tap', () => {
      // Left armed, the next drag would ease along behind the finger instead
      // of tracking it.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const day = dayNamed(container, 'July 20, 2026');

      swipe(container, { acrossX: 0, from: day });

      expect(track(container).classList).not.toContain(
        'ir-calendar-track-settling'
      );
    });

    it('tracks the next drag from rest rather than easing into it', async () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      swipe(container, { acrossX: -80 });
      await flush();
      drag(container, { acrossX: -30 });

      expect(track(container).classList).not.toContain(
        'ir-calendar-track-settling'
      );
      expect(track(container).style.transform).toBe('translateX(-30px)');
    });
  });

  describe('press feedback', () => {
    it('marks the day a pointer is held on', () => {
      // The only feedback a tap gets before the popup closes. The stylesheet
      // tints the mark; what matters here is that exactly one day wears it.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const day = dayNamed(container, 'July 20, 2026');

      press(container, { from: day });

      expect(pressedDays(container)).toEqual([day]);
    });

    it('lifts the mark as soon as the pointer starts to drag', () => {
      // The bug this guards: a day held part-way through a swipe wore the same
      // fill as the selected day, so the calendar looked as though the finger
      // had already chosen something it had not. A mark still standing when
      // the month pages is worse — the two grids share the days of the week
      // they overlap on, so the node under the finger survives the re-render
      // and carries the tint into a month nobody pressed on.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const day = dayNamed(container, 'July 20, 2026');

      drag(container, { acrossX: -30, from: day });

      expect(pressedDays(container)).toEqual([]);
    });

    it('lifts the mark for a vertical drag too', () => {
      // A finger scrolling the queue behind the popup is not choosing a day
      // either, even though the calendar itself holds still.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const day = dayNamed(container, 'July 20, 2026');

      drag(container, { acrossX: 0, acrossY: -60, from: day });

      expect(pressedDays(container)).toEqual([]);
    });

    it('lifts the mark when the pointer is released', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);
      const day = dayNamed(container, 'July 20, 2026');

      press(container, { from: day });
      release(container);

      expect(pressedDays(container)).toEqual([]);
    });

    it('lifts the mark when the browser takes the gesture over', () => {
      // No release is coming, so nothing else would ever take it off.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const day = dayNamed(container, 'July 20, 2026');

      press(container, { from: day });
      cancel(container);

      expect(pressedDays(container)).toEqual([]);
    });

    it('lifts the mark when a held pointer leaves the grid', () => {
      // A mouse button held down and taken off the calendar releases somewhere
      // the grid never hears about, so nothing else would take it off.
      const container = mount(<CalendarPopup {...makeProps()} />);
      const day = dayNamed(container, 'July 20, 2026');

      press(container, { pointerType: 'mouse', from: day });
      leave(container);

      expect(pressedDays(container)).toEqual([]);
    });

    it('moves the mark rather than leaving the last one behind', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);
      const first = dayNamed(container, 'July 20, 2026');
      const second = dayNamed(container, 'July 21, 2026');

      press(container, { from: first });
      press(container, { from: second });

      expect(pressedDays(container)).toEqual([second]);
    });

    it('marks nothing when the press lands between the days', () => {
      const container = mount(<CalendarPopup {...makeProps()} />);

      press(container);

      expect(pressedDays(container)).toEqual([]);
    });
  });

  describe('commit distance', () => {
    it('asks the same travel of a wide calendar as of a narrow one', async () => {
      // A quarter of the month's width asked for a longer drag on whichever
      // screen drew the calendar wider — and the calendar is drawn from `rem`,
      // so that was a matter of the reader's font size as much as their
      // device. The same 50px pages either.
      expect(await pages({ width: 240, acrossX: -50 })).toBe(true);
      expect(await pages({ width: 480, acrossX: -50 })).toBe(true);
    });

    it('holds the month for a drag short of it, whatever the width', async () => {
      expect(await pages({ width: 240, acrossX: -30 })).toBe(false);
      expect(await pages({ width: 480, acrossX: -30 })).toBe(false);
    });

    it('takes less of a calendar too narrow to give the full distance', async () => {
      // A fifth of the panel, where the fixed distance would be most of the
      // month and the drag could run out of grid before it ever committed.
      expect(await pages({ width: 100, acrossX: -25 })).toBe(true);
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
