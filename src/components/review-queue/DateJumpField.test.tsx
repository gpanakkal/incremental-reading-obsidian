// @vitest-environment jsdom
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateJumpField } from './DateJumpField';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

function dateInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="date"]') as HTMLInputElement;
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
    const container = mount(<DateJumpField onJump={onJump} />);

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
    const container = mount(<DateJumpField onJump={onJump} />);

    enterDate(container, '');

    expect(onJump).not.toHaveBeenCalled();
  });

  it('reports exactly one jump per date pick', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField onJump={onJump} />);

    enterDate(container, '2026-07-13');

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('reports one jump per pick regardless of a trailing change event', () => {
    // preact/compat and plain Preact disagree about which event `onChange`
    // means, so the field listens only for `input`. A trailing `change` from
    // the same pick must not double-jump.
    const onJump = vi.fn();
    const container = mount(<DateJumpField onJump={onJump} />);

    enterDate(container, '2026-07-13');
    dateInput(container).dispatchEvent(new Event('change', { bubbles: true }));

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('reports a jump again when the same date is re-picked', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField onJump={onJump} />);

    // Jump to a date, page away manually, then re-pick the same date to get
    // back. The second pick must still jump.
    enterDate(container, '2026-07-13');
    enterDate(container, '2026-07-13');

    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it('reports a new jump when the date changes again', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField onJump={onJump} />);

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
    const container = mount(<DateJumpField onJump={onJump} />);

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
      <DateJumpField value={new Date(2026, 7, 1)} onJump={onJump} />
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
      <DateJumpField value={new Date(2026, 7, 1)} onJump={onJump} />
    );

    pressKey(container, 'Enter');
    pressKey(container, 'Enter');

    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it('does not report a jump on enter when the field is empty', () => {
    const onJump = vi.fn();
    const container = mount(<DateJumpField onJump={onJump} />);

    pressKey(container, 'Enter');

    expect(onJump).not.toHaveBeenCalled();
  });

  it('does not report a jump for keys other than enter', () => {
    const onJump = vi.fn();
    const container = mount(
      <DateJumpField value={new Date(2026, 7, 1)} onJump={onJump} />
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
    const container = mount(<DateJumpField onJump={onJump} />);

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
    const container = mount(<DateJumpField onJump={onJump} />);

    enterDate(container, '2026-07-13');
    render(
      <DateJumpField value={new Date(2026, 6, 20)} onJump={onJump} />,
      container
    );
    pressKey(container, 'Enter');

    expect(onJump).toHaveBeenCalledTimes(2);
    const [second] = onJump.mock.calls[1] as [Date];
    expect(second.getDate()).toBe(20);
  });

  it('shows the date it is given', () => {
    const container = mount(
      <DateJumpField value={new Date(2026, 6, 13)} onJump={() => {}} />
    );

    expect(dateInput(container).value).toBe('2026-07-13');
  });

  it('formats a single-digit month and day with leading zeroes', () => {
    // A bare `${month}` would render 2026-3-4, which a date input rejects.
    const container = mount(
      <DateJumpField value={new Date(2026, 2, 4)} onJump={() => {}} />
    );

    expect(dateInput(container).value).toBe('2026-03-04');
  });

  it('renders empty when given no date', () => {
    const container = mount(<DateJumpField onJump={() => {}} />);

    expect(dateInput(container).value).toBe('');
  });

  it('reflects a new date pushed from the parent', () => {
    const container = mount(
      <DateJumpField value={new Date(2026, 6, 13)} onJump={() => {}} />
    );

    render(
      <DateJumpField value={new Date(2026, 6, 20)} onJump={() => {}} />,
      container
    );

    expect(dateInput(container).value).toBe('2026-07-20');
  });

  it('is labelled for screen readers and tooltips', () => {
    const container = mount(<DateJumpField onJump={() => {}} />);

    expect(dateInput(container).getAttribute('aria-label')).toBeTruthy();
  });

  describe('bounds', () => {
    it('publishes the bounds as min and max attributes', () => {
      // These are what grey out unreachable days in the native picker and stop
      // the spinner arrows at the boundary.
      const container = mount(
        <DateJumpField
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
      const container = mount(<DateJumpField onJump={() => {}} />);

      const input = dateInput(container);
      expect(input.hasAttribute('min')).toBe(false);
      expect(input.hasAttribute('max')).toBe(false);
    });

    it('reports the max when a later date is entered', () => {
      // `max` is validation only — a browser flags the value out of range but
      // never rewrites it — so the clamp has to happen here.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField max={new Date(2026, 6, 31)} onJump={onJump} />
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
        <DateJumpField min={new Date(2026, 6, 1)} onJump={onJump} />
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
        <DateJumpField max={new Date(2026, 6, 31, 18, 30)} onJump={onJump} />
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
        <DateJumpField max={new Date(2026, 6, 31)} onJump={() => {}} />
      );

      enterDate(container, '2026-07-13');

      expect(dateInput(container).value).toBe('2026-07-13');
    });

    it('clamps a date committed with enter', () => {
      // Typing the segments fires no `input` event, so enter is the other way
      // an out-of-range date can arrive.
      const onJump = vi.fn();
      const container = mount(
        <DateJumpField max={new Date(2026, 6, 31)} onJump={onJump} />
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
          min={new Date(2026, 6, 1)}
          max={new Date(2026, 6, 31)}
          onJump={onJump}
        />
      );

      enterDate(container, '');

      expect(onJump).not.toHaveBeenCalled();
    });
  });
});
