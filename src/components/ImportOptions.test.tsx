// @vitest-environment jsdom
import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import type { SchedulingStrategy } from '#/lib/types';
import fc from 'fast-check';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImportOptionsFields,
  useImportOptions,
  type ImportOptionValues,
} from './ImportOptions';

// #region HELPERS

const containers: HTMLElement[] = [];

/** Unmount and drop every container mounted so far. */
function unmountAll() {
  for (const container of containers.splice(0)) {
    void act(() => {
      render(null, container);
    });
    container.remove();
  }
}

/**
 * A fresh container in the page, the only one: the fields carry fixed element
 * ids, and a property runs many cases before `afterEach` does.
 */
function makeContainer() {
  unmountAll();
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  return container;
}

interface Initial {
  priority: number;
  intervalDays: number | null;
  makeCopy: boolean;
}

/** The fields on the options hook, handing its reader out once mounted. */
function Harness({
  initial,
  canCopy,
  onReader,
}: {
  initial: Initial;
  canCopy: boolean;
  onReader: (current: () => ImportOptionValues) => void;
}) {
  const { values, update, current } = useImportOptions(initial);
  useEffect(() => onReader(current));
  return (
    <ImportOptionsFields
      values={values}
      update={update}
      canCopy={canCopy}
      initialInterval={initial.intervalDays}
    />
  );
}

/**
 * Mount the fields on the options hook, as the import dialogs do; returns the
 * container and a reader for the options as last updated.
 */
function mountWithHook(initial: Initial, canCopy: boolean) {
  const container = makeContainer();
  let read: () => ImportOptionValues = () => {
    throw new Error('not rendered');
  };
  void act(() => {
    render(
      <Harness
        initial={initial}
        canCopy={canCopy}
        onReader={(current) => {
          read = current;
        }}
      />,
      container
    );
  });
  return { container, current: () => read() };
}

/** Mount the fields alone on fixed `values`, writing to `update`. */
function mountFields(
  values: ImportOptionValues,
  canCopy: boolean,
  update: (updates: Partial<ImportOptionValues>) => void
) {
  const container = makeContainer();
  void act(() => {
    render(
      <ImportOptionsFields
        values={values}
        update={update}
        canCopy={canCopy}
        initialInterval={null}
      />,
      container
    );
  });
  return container;
}

function groups(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>('.ir-segments[role="group"]'),
  ];
}

/** A group's segments, left to right. */
function segmentsOf(group: HTMLElement) {
  return [
    ...group.querySelectorAll<HTMLButtonElement>(':scope > button.ir-segment'),
  ];
}

/** The strategy segments: priority, then fixed intervals. */
const strategySegments = (container: HTMLElement) =>
  segmentsOf(groups(container)[0]);

/** The copy segments, if offered: in place, then a copy. */
const copySegments = (container: HTMLElement) => {
  const group = groups(container).at(1);
  return group ? segmentsOf(group) : null;
};

const isPressed = (segment: HTMLElement) =>
  segment.getAttribute('aria-pressed') === 'true';

/**
 * The index pressed among `segments`, once checked to be the only one pressed
 * and the only one active.
 */
function pressedIndex(segments: HTMLElement[]) {
  const pressed = segments.flatMap((el, i) => (isPressed(el) ? [i] : []));
  const active = segments.flatMap((el, i) =>
    el.classList.contains('is-active') ? [i] : []
  );
  expect(active).toEqual(pressed);
  expect(pressed).toHaveLength(1);
  return pressed[0];
}

const STRATEGIES: SchedulingStrategy[] = ['priority', 'fixed-interval'];

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

function click(target: HTMLElement) {
  void act(() => {
    target.click();
  });
}

const anyPriority = fc.integer({
  min: MINIMUM_PRIORITY,
  max: MAXIMUM_PRIORITY,
});

const anyInterval = fc.integer({
  min: MINIMUM_FIXED_REVIEW_INTERVAL,
  max: MAXIMUM_FIXED_REVIEW_INTERVAL,
});

const anyInitial = fc.record({
  priority: anyPriority,
  intervalDays: fc.option(anyInterval, { nil: null }),
  makeCopy: fc.boolean(),
});

/** A press on the strategy group (0) or the copy group (1), at a segment. */
const anyPress = fc.record({
  group: fc.constantFrom(0, 1),
  at: fc.constantFrom(0, 1),
});

// #endregion

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe('ImportOptionsFields', () => {
  it('offers no checkbox, a strategy group, and a copy group only when a copy can be made', () => {
    fc.assert(
      fc.property(anyInitial, fc.boolean(), (initial, canCopy) => {
        const { container } = mountWithHook(initial, canCopy);

        expect(container.querySelector('input[type="checkbox"]')).toBeNull();
        expect(groups(container)).toHaveLength(canCopy ? 2 : 1);
        expect(strategySegments(container)).toHaveLength(2);
        expect(copySegments(container)?.length).toBe(canCopy ? 2 : undefined);
      }),
      { numRuns: 20 }
    );
  });

  it('follows every press: the pressed segments, the field shown, and the options written', () => {
    fc.assert(
      fc.property(
        anyInitial,
        fc.boolean(),
        fc.array(anyPress, { maxLength: 6 }),
        (initial, canCopy, presses) => {
          const { container, current } = mountWithHook(initial, canCopy);
          let strategy: SchedulingStrategy = 'priority';
          let makeCopy = initial.makeCopy;

          const check = () => {
            expect(STRATEGIES[pressedIndex(strategySegments(container))]).toBe(
              strategy
            );
            const copy = copySegments(container);
            if (canCopy) expect(pressedIndex(copy!)).toBe(makeCopy ? 1 : 0);
            else expect(copy).toBeNull();
            expect(container.querySelector('#ir-priority-input') !== null).toBe(
              strategy === 'priority'
            );
            expect(
              container.querySelector('#ir-fixed-interval-input') !== null
            ).toBe(strategy === 'fixed-interval');
            expect(current()).toEqual({
              strategy,
              priority: initial.priority,
              fixedIntervalDays:
                initial.intervalDays ?? MINIMUM_FIXED_REVIEW_INTERVAL,
              makeCopy,
            });
          };

          check();
          for (const { group, at } of presses) {
            if (group === 0) {
              click(strategySegments(container)[at]);
              strategy = STRATEGIES[at];
            } else if (canCopy) {
              click(copySegments(container)![at]);
              makeCopy = at === 1;
            }
            check();
          }
        }
      ),
      { numRuns: 40 }
    );
  });

  it('presses the segments of the values given, and writes only the pressed choice', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STRATEGIES),
        fc.boolean(),
        fc.boolean(),
        anyPress,
        (strategy, makeCopy, canCopy, { group, at }) => {
          const update = vi.fn();
          const container = mountFields(
            { strategy, priority: 30, fixedIntervalDays: 1, makeCopy },
            canCopy,
            update
          );

          expect(pressedIndex(strategySegments(container))).toBe(
            STRATEGIES.indexOf(strategy)
          );
          if (canCopy) {
            expect(pressedIndex(copySegments(container)!)).toBe(
              makeCopy ? 1 : 0
            );
          }

          if (group === 0) {
            click(strategySegments(container)[at]);
            expect(update.mock.calls).toEqual([[{ strategy: STRATEGIES[at] }]]);
          } else if (canCopy) {
            click(copySegments(container)![at]);
            expect(update.mock.calls).toEqual([[{ makeCopy: at === 1 }]]);
          }
        }
      ),
      { numRuns: 40 }
    );
  });

  it('writes what is typed into the shown field once it is left, and nothing else', () => {
    fc.assert(
      fc.property(
        anyInitial,
        fc.boolean(),
        fc.constantFrom(...STRATEGIES),
        anyPriority,
        anyInterval,
        (initial, canCopy, strategy, priority, interval) => {
          const { container, current } = mountWithHook(initial, canCopy);
          click(strategySegments(container)[STRATEGIES.indexOf(strategy)]);
          const fixed = strategy === 'fixed-interval';
          const input = container.querySelector<HTMLInputElement>(
            fixed ? '#ir-fixed-interval-input' : '#ir-priority-input'
          )!;

          typeInto(
            input,
            fixed ? String(interval) : IRScheduler.toDisplayPriority(priority)
          );
          void act(() => {
            input.blur();
          });

          expect(current()).toEqual({
            strategy,
            priority: fixed ? initial.priority : priority,
            fixedIntervalDays: fixed
              ? interval
              : (initial.intervalDays ?? MINIMUM_FIXED_REVIEW_INTERVAL),
            makeCopy: initial.makeCopy,
          });
        }
      ),
      { numRuns: 40 }
    );
  });
});
