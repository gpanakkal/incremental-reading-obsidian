// @vitest-environment jsdom
import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
} from '#/lib/constants';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import fc from 'fast-check';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedulingModalContent } from './SchedulingModalContent';
import type { SchedulingModalProps } from './types';

// #region HELPERS

type OnClose = SchedulingModalProps['onClose'];

const containers: HTMLElement[] = [];

/** Render the modal content into a jsdom container and return the container. */
function mount({
  type = 'snippet',
  priority = 30,
  intervalDays = null,
  defaultPriority = DEFAULT_SETTINGS.defaultPriority,
  onClose = vi.fn<OnClose>(),
}: {
  type?: SchedulingModalProps['type'];
  priority?: number;
  intervalDays?: number | null;
  defaultPriority?: number;
  onClose?: OnClose;
} = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  void act(() => {
    render(
      <SchedulingModalContent
        plugin={{ settings: { ...DEFAULT_SETTINGS, defaultPriority } } as never}
        type={type}
        schedule={{ priority, intervalDays }}
        onClose={onClose}
      />,
      container
    );
  });
  return container;
}

function priorityInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input.ir-priority-input');
}

function intervalInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    'input.ir-fixed-interval-input'
  );
}

function modalRoot(container: HTMLElement) {
  return container.querySelector<HTMLElement>('.ir-scheduling-modal')!;
}

function strategyToggle(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    '.ir-toggle input[type="checkbox"]'
  );
}

/** Focus `input` and type `text` over its value, as a user would. */
function typeInto(input: HTMLInputElement, text: string) {
  void act(() => {
    input.focus();
  });
  void act(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Dispatch a bubbling keydown on `target`; returns the event. */
function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  void act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function cancelButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(
    '.modal-button-container button:not(.mod-cta)'
  )!;
}

function confirmButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button.mod-cta')!;
}

/** Elements of an article's modal, other than a button, that Enter can come from. */
const nonButtonEnterSources = fc.constantFrom(
  (c: HTMLElement) => modalRoot(c),
  (c: HTMLElement) => strategyToggle(c)!,
  (c: HTMLElement) => c.querySelector<HTMLElement>('.ir-scheduling-tooltip')!,
  (c: HTMLElement) => c.querySelector<HTMLElement>('.ir-toggle-label')!
);

function click(target: HTMLElement) {
  void act(() => {
    target.click();
  });
}

/** Text with no digit or decimal point, which neither field can parse. */
const unparsable = fc
  .string({ maxLength: 8 })
  .filter((text) => !/[\d.]/.test(text));

const anyPriority = fc.integer({
  min: MINIMUM_PRIORITY,
  max: MAXIMUM_PRIORITY,
});

const anyInterval = fc.integer({
  min: MINIMUM_FIXED_REVIEW_INTERVAL,
  max: MAXIMUM_FIXED_REVIEW_INTERVAL,
});

// #endregion

afterEach(() => {
  for (const container of containers.splice(0)) {
    void act(() => {
      render(null, container);
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('SchedulingModalContent', () => {
  describe('Enter in the priority field', () => {
    it('confirms the priority just typed', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ priority: 30, onClose });
      const input = priorityInput(container)!;

      typeInto(input, '4');
      press(input, 'Enter');

      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledWith({ strategy: 'priority', value: 40 });
    });

    it('confirms any valid priority typed, exactly once', () => {
      fc.assert(
        fc.property(anyPriority, anyPriority, (initial, typed) => {
          const onClose = vi.fn<OnClose>();
          const container = mount({ priority: initial, onClose });
          const input = priorityInput(container)!;

          typeInto(input, String(typed / 10));
          press(input, 'Enter');

          expect(onClose.mock.calls).toEqual([
            [{ strategy: 'priority', value: typed }],
          ]);
        }),
        { numRuns: 30 }
      );
    });

    it('confirms the prior priority, not unparsable text', () => {
      fc.assert(
        fc.property(anyPriority, unparsable, (initial, typed) => {
          const onClose = vi.fn<OnClose>();
          const container = mount({ priority: initial, onClose });
          const input = priorityInput(container)!;

          typeInto(input, typed);
          press(input, 'Enter');

          expect(onClose.mock.calls).toEqual([
            [{ strategy: 'priority', value: initial }],
          ]);
        }),
        { numRuns: 30 }
      );
    });

    it('confirms a typed priority beyond the range as the nearest bound', () => {
      fc.assert(
        fc.property(
          anyPriority,
          fc.constantFrom('0', '0.5', '6', '9', '99', '5.5'),
          (initial, typed) => {
            const onClose = vi.fn<OnClose>();
            const container = mount({ priority: initial, onClose });
            const input = priorityInput(container)!;

            typeInto(input, typed);
            press(input, 'Enter');

            const expected =
              Number(typed.slice(0, 1)) >= 5
                ? MAXIMUM_PRIORITY
                : MINIMUM_PRIORITY;
            expect(onClose.mock.calls).toEqual([
              [{ strategy: 'priority', value: expected }],
            ]);
          }
        ),
        { numRuns: 20 }
      );
    });

    it('keeps the native Enter action from running', () => {
      const container = mount();
      const input = priorityInput(container)!;

      typeInto(input, '2');

      expect(press(input, 'Enter').defaultPrevented).toBe(true);
    });
  });

  describe('Enter in the fixed-interval field', () => {
    it('confirms the interval just typed', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ type: 'article', intervalDays: 3, onClose });
      const input = intervalInput(container)!;

      typeInto(input, '12');
      press(input, 'Enter');

      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledWith({
        strategy: 'fixed-interval',
        value: 12,
      });
    });

    it('confirms any valid interval typed, exactly once', () => {
      fc.assert(
        fc.property(anyInterval, anyInterval, (initial, typed) => {
          const onClose = vi.fn<OnClose>();
          const container = mount({
            type: 'article',
            intervalDays: initial,
            onClose,
          });
          const input = intervalInput(container)!;

          typeInto(input, String(typed));
          press(input, 'Enter');

          expect(onClose.mock.calls).toEqual([
            [{ strategy: 'fixed-interval', value: typed }],
          ]);
        }),
        { numRuns: 30 }
      );
    });

    it('confirms the prior interval, not unparsable text', () => {
      fc.assert(
        fc.property(anyInterval, unparsable, (initial, typed) => {
          const onClose = vi.fn<OnClose>();
          const container = mount({
            type: 'article',
            intervalDays: initial,
            onClose,
          });
          const input = intervalInput(container)!;

          typeInto(input, typed);
          press(input, 'Enter');

          expect(onClose.mock.calls).toEqual([
            [{ strategy: 'fixed-interval', value: initial }],
          ]);
        }),
        { numRuns: 30 }
      );
    });

    it('confirms a typed interval beyond the range as the nearest bound', () => {
      fc.assert(
        fc.property(
          anyInterval,
          fc.oneof(
            fc.integer({ min: 0, max: MINIMUM_FIXED_REVIEW_INTERVAL - 1 }),
            fc.integer({ min: MAXIMUM_FIXED_REVIEW_INTERVAL + 1, max: 100000 })
          ),
          (initial, typed) => {
            const onClose = vi.fn<OnClose>();
            const container = mount({
              type: 'article',
              intervalDays: initial,
              onClose,
            });
            const input = intervalInput(container)!;

            typeInto(input, String(typed));
            press(input, 'Enter');

            const expected = Math.min(
              Math.max(typed, MINIMUM_FIXED_REVIEW_INTERVAL),
              MAXIMUM_FIXED_REVIEW_INTERVAL
            );
            expect(onClose.mock.calls).toEqual([
              [{ strategy: 'fixed-interval', value: expected }],
            ]);
          }
        ),
        { numRuns: 30 }
      );
    });

    it('confirms an interval typed before toggling away and back', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ type: 'article', intervalDays: 3, onClose });

      typeInto(intervalInput(container)!, '9');
      void act(() => {
        intervalInput(container)!.blur();
      });
      click(strategyToggle(container)!);
      click(strategyToggle(container)!);

      expect(intervalInput(container)!.value).toBe('9');
      press(modalRoot(container), 'Enter');
      expect(onClose).toHaveBeenCalledWith({
        strategy: 'fixed-interval',
        value: 9,
      });
    });
  });

  describe('Enter outside the fields', () => {
    it('confirms the stored priority untouched', () => {
      fc.assert(
        fc.property(anyPriority, (initial) => {
          const onClose = vi.fn<OnClose>();
          const container = mount({ priority: initial, onClose });

          const event = press(modalRoot(container), 'Enter');

          expect(event.defaultPrevented).toBe(true);
          expect(onClose.mock.calls).toEqual([
            [{ strategy: 'priority', value: initial }],
          ]);
        }),
        { numRuns: 20 }
      );
    });

    it('confirms the stored interval untouched', () => {
      fc.assert(
        fc.property(anyInterval, (initial) => {
          const onClose = vi.fn<OnClose>();
          const container = mount({
            type: 'article',
            intervalDays: initial,
            onClose,
          });

          press(modalRoot(container), 'Enter');

          expect(onClose.mock.calls).toEqual([
            [{ strategy: 'fixed-interval', value: initial }],
          ]);
        }),
        { numRuns: 20 }
      );
    });

    it('confirms a priority committed by leaving its field', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ priority: 30, onClose });
      const input = priorityInput(container)!;

      typeInto(input, '1.5');
      void act(() => {
        input.blur();
      });
      press(modalRoot(container), 'Enter');

      expect(onClose.mock.calls).toEqual([
        [{ strategy: 'priority', value: 15 }],
      ]);
    });

    it('falls back to the default priority when the item has none', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({
        priority: null as never,
        defaultPriority: 25,
        onClose,
      });

      press(modalRoot(container), 'Enter');

      expect(onClose).toHaveBeenCalledWith({ strategy: 'priority', value: 25 });
    });

    it('confirms the minimum interval for an article switched to fixed intervals', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ type: 'article', intervalDays: null, onClose });

      click(strategyToggle(container)!);
      press(modalRoot(container), 'Enter');

      expect(onClose).toHaveBeenCalledWith({
        strategy: 'fixed-interval',
        value: MINIMUM_FIXED_REVIEW_INTERVAL,
      });
    });

    it('confirms the priority for an article switched to priority scheduling', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({
        type: 'article',
        priority: 45,
        intervalDays: 7,
        onClose,
      });

      click(strategyToggle(container)!);
      press(modalRoot(container), 'Enter');

      expect(onClose).toHaveBeenCalledWith({ strategy: 'priority', value: 45 });
    });

    it('ignores keys other than Enter', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('a', ' ', 'Tab', 'ArrowUp', 'Backspace'),
          (key) => {
            const onClose = vi.fn<OnClose>();
            const container = mount({ onClose });

            const event = press(modalRoot(container), key);

            expect(event.defaultPrevented).toBe(false);
            expect(onClose).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  describe('Enter from other elements', () => {
    it('confirms the committed value from any element but a button', () => {
      fc.assert(
        fc.property(
          nonButtonEnterSources,
          anyPriority,
          anyPriority,
          (source, initial, typed) => {
            const onClose = vi.fn<OnClose>();
            const container = mount({
              type: 'article',
              priority: initial,
              onClose,
            });
            const input = priorityInput(container)!;
            typeInto(input, String(typed / 10));
            void act(() => {
              input.blur();
            });

            const event = press(source(container), 'Enter');

            expect(event.defaultPrevented).toBe(true);
            expect(onClose.mock.calls).toEqual([
              [{ strategy: 'priority', value: typed }],
            ]);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("leaves Enter on a button to the button's own activation", () => {
      fc.assert(
        fc.property(fc.constantFrom(cancelButton, confirmButton), (button) => {
          const onClose = vi.fn<OnClose>();
          const container = mount({ onClose });

          const event = press(button(container), 'Enter');

          expect(event.defaultPrevented).toBe(false);
          expect(onClose).not.toHaveBeenCalled();
        }),
        { numRuns: 4 }
      );
    });
  });

  describe('closing once', () => {
    it('ignores any Enter, Confirm or Cancel after the first confirm', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom(
              (c: HTMLElement) => press(modalRoot(c), 'Enter'),
              (c: HTMLElement) => press(priorityInput(c)!, 'Enter'),
              (c: HTMLElement) => click(confirmButton(c)),
              (c: HTMLElement) => click(cancelButton(c))
            ),
            { minLength: 1, maxLength: 4 }
          ),
          (repeats) => {
            const onClose = vi.fn<OnClose>();
            const container = mount({ priority: 30, onClose });

            press(modalRoot(container), 'Enter');
            for (const repeat of repeats) repeat(container);

            expect(onClose.mock.calls).toEqual([
              [{ strategy: 'priority', value: 30 }],
            ]);
          }
        ),
        { numRuns: 20 }
      );
    });

    it('ignores a confirm after Cancel', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ onClose });

      click(cancelButton(container));
      click(confirmButton(container));
      press(modalRoot(container), 'Enter');

      expect(onClose.mock.calls).toEqual([['cancel']]);
    });
  });

  describe('strategy toggle', () => {
    it('shows only for articles', () => {
      expect(strategyToggle(mount({ type: 'snippet' }))).toBeNull();
      expect(strategyToggle(mount({ type: 'article' }))).not.toBeNull();
    });

    it('starts on fixed intervals iff the article has one', () => {
      const fixed = mount({ type: 'article', intervalDays: 5 });
      expect(strategyToggle(fixed)!.checked).toBe(false);
      expect(intervalInput(fixed)).not.toBeNull();
      expect(priorityInput(fixed)).toBeNull();
      expect(
        fixed.querySelector('.checkbox-container')!.classList
      ).not.toContain('is-enabled');

      const prio = mount({ type: 'article', intervalDays: null });
      expect(strategyToggle(prio)!.checked).toBe(true);
      expect(priorityInput(prio)).not.toBeNull();
      expect(intervalInput(prio)).toBeNull();
      expect(prio.querySelector('.checkbox-container')!.classList).toContain(
        'is-enabled'
      );
    });
  });

  describe('Escape and Cancel', () => {
    it('never confirms on Escape, in a field or out of one', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ onClose });
      const input = priorityInput(container)!;

      typeInto(input, '4');
      press(input, 'Escape');
      press(modalRoot(container), 'Escape');

      expect(onClose).not.toHaveBeenCalled();
    });

    it('cancels from the Cancel button', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ onClose });
      click(cancelButton(container));

      expect(onClose.mock.calls).toEqual([['cancel']]);
    });

    it('confirms the typed priority from the Confirm button', () => {
      const onClose = vi.fn<OnClose>();
      const container = mount({ priority: 30, onClose });
      const input = priorityInput(container)!;

      typeInto(input, '2');
      void act(() => {
        input.blur();
      });
      click(confirmButton(container));

      expect(onClose.mock.calls).toEqual([
        [{ strategy: 'priority', value: 20 }],
      ]);
    });
  });
});
