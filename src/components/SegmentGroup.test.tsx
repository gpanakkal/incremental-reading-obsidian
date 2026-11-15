// @vitest-environment jsdom
import fc from 'fast-check';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmsOnEnter, SegmentGroup, type Segment } from './SegmentGroup';

// #region HELPERS

const containers: HTMLElement[] = [];

/** Render a group into a jsdom container and return the container. */
function mount<T extends string | boolean>(
  segments: Segment<T>[],
  value: T,
  onChange: (value: T) => void = () => {}
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  void act(() => {
    render(
      <SegmentGroup segments={segments} value={value} onChange={onChange} />,
      container
    );
  });
  return container;
}

/**
 * A group that holds its own value, starting at `initial`, as a modal holds
 * its strategy; every value it changes to is also reported to `onChange`.
 */
function StatefulGroup<T>({
  segments,
  initial,
  onChange,
}: {
  segments: Segment<T>[];
  initial: T;
  onChange: (value: T) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentGroup
      segments={segments}
      value={value}
      onChange={(chosen) => {
        onChange(chosen);
        setValue(() => chosen);
      }}
    />
  );
}

/** Render a {@link StatefulGroup} into a jsdom container; returns the container. */
function mountStateful<T extends string | boolean>(
  segments: Segment<T>[],
  initial: T,
  onChange: (value: T) => void
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  void act(() => {
    render(
      <StatefulGroup
        segments={segments}
        initial={initial}
        onChange={onChange}
      />,
      container
    );
  });
  return container;
}

/**
 * Dispatch a bubbling, cancelable keydown on `target`, an auto-repeat of a
 * held key when `repeat`; returns the event.
 */
function press(target: HTMLElement, key: string, repeat = false) {
  const event = new KeyboardEvent('keydown', {
    key,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  void act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Keys other than Space and Enter, which a group leaves alone. */
const otherKey = fc
  .oneof(
    fc.constantFrom('Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'Spacebar'),
    fc.string({ minLength: 1 })
  )
  .filter((key) => key !== ' ' && key !== 'Enter');

function groups(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>('.ir-segments[role="group"]'),
  ];
}

function segmentsOf(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      '.ir-segments[role="group"] > button.ir-segment'
    ),
  ];
}

const isPressed = (segment: HTMLElement) =>
  segment.getAttribute('aria-pressed') === 'true';

/**
 * Two to four segments with distinct labels and distinct values, of either
 * kind a group chooses between, and the index of the chosen one, or -1 for
 * a value no segment carries.
 */
const anyGroup = fc
  .oneof(
    fc.uniqueArray(fc.string({ minLength: 1 }), {
      minLength: 2,
      maxLength: 4,
    }),
    fc.constant([false, true]),
    fc.constant([true, false])
  )
  .chain((values: readonly (string | boolean)[]) =>
    fc.record({
      segments: fc
        .uniqueArray(fc.string({ minLength: 1 }), {
          minLength: values.length,
          maxLength: values.length,
        })
        .map((labels) =>
          values.map((value, i) => ({ value, label: labels[i] }))
        ),
      chosen: fc.integer({ min: -1, max: values.length - 1 }),
    })
  );

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

describe('SegmentGroup', () => {
  it('renders one group of a button a segment, in order, each with its label', () => {
    fc.assert(
      fc.property(anyGroup, ({ segments, chosen }) => {
        const value = chosen < 0 ? '\u0000none' : segments[chosen].value;
        const container = mount(segments as Segment<string | boolean>[], value);

        expect(groups(container)).toHaveLength(1);
        expect(segmentsOf(container).map((el) => el.textContent)).toEqual(
          segments.map((segment) => segment.label)
        );
      }),
      { numRuns: 30 }
    );
  });

  it('presses and marks active exactly the segment carrying the value', () => {
    fc.assert(
      fc.property(anyGroup, ({ segments, chosen }) => {
        const value = chosen < 0 ? '\u0000none' : segments[chosen].value;
        const container = mount(segments as Segment<string | boolean>[], value);

        segmentsOf(container).forEach((el, i) => {
          expect(isPressed(el)).toBe(i === chosen);
          expect(el.getAttribute('aria-pressed')).toBe(String(i === chosen));
          expect(el.classList.contains('is-active')).toBe(i === chosen);
        });
      }),
      { numRuns: 30 }
    );
  });

  it("reports a pressed segment's value, pressed or not, once a press", () => {
    fc.assert(
      fc.property(
        anyGroup,
        fc.array(fc.nat(), { minLength: 1, maxLength: 5 }),
        ({ segments, chosen }, presses) => {
          const value = chosen < 0 ? '\u0000none' : segments[chosen].value;
          const onChange = vi.fn();
          const container = mount(
            segments as Segment<string | boolean>[],
            value,
            onChange
          );

          for (const press of presses) {
            const at = press % segments.length;
            void act(() => {
              segmentsOf(container)[at].click();
            });
          }

          expect(onChange.mock.calls).toEqual(
            presses.map((press) => [segments[press % segments.length].value])
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('selects the segment after the pressed one on Space, wrapping, and moves focus to it', () => {
    fc.assert(
      fc.property(
        anyGroup,
        fc.nat(),
        fc.integer({ min: 1, max: 6 }),
        ({ segments, chosen }, focused, spaces) => {
          const value = chosen < 0 ? '\u0000none' : segments[chosen].value;
          const onChange = vi.fn();
          const container = mountStateful(
            segments as Segment<string | boolean>[],
            value,
            onChange
          );
          void act(() => {
            segmentsOf(container)[focused % segments.length].focus();
          });

          // No segment pressed yet: the first one is next
          const expected = Array.from(
            { length: spaces },
            (_, i) => (chosen + 1 + i) % segments.length
          );
          for (const at of expected) {
            const event = press(document.activeElement as HTMLElement, ' ');

            expect(event.defaultPrevented).toBe(true);
            const shown = segmentsOf(container);
            expect(shown.map(isPressed)).toEqual(
              segments.map((_, j) => j === at)
            );
            expect(
              shown.map((el) => el.classList.contains('is-active'))
            ).toEqual(segments.map((_, j) => j === at));
            expect(document.activeElement).toBe(shown[at]);
          }
          expect(onChange.mock.calls).toEqual(
            expected.map((at) => [segments[at].value])
          );
        }
      ),
      { numRuns: 40 }
    );
  });

  it('steps once for a held Space, however often it repeats', () => {
    // A held Space would otherwise spin through the segments and stop on
    // whichever the release happens to land on
    fc.assert(
      fc.property(
        anyGroup,
        fc.nat(),
        fc.integer({ min: 1, max: 6 }),
        ({ segments, chosen }, focused, repeats) => {
          const value = chosen < 0 ? ' none' : segments[chosen].value;
          const onChange = vi.fn();
          const container = mountStateful(
            segments as Segment<string | boolean>[],
            value,
            onChange
          );
          void act(() => {
            segmentsOf(container)[focused % segments.length].focus();
          });
          const next = (chosen + 1) % segments.length;

          press(document.activeElement as HTMLElement, ' ');
          const held = Array.from({ length: repeats }, () =>
            press(document.activeElement as HTMLElement, ' ', true)
          );

          // Still prevented: the button's own Space press stays off
          expect(held.every((e) => e.defaultPrevented)).toBe(true);
          expect(onChange.mock.calls).toEqual([[segments[next].value]]);
          expect(segmentsOf(container).map(isPressed)).toEqual(
            segments.map((_, j) => j === next)
          );
          expect(document.activeElement).toBe(segmentsOf(container)[next]);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('reports the segment after the pressed one on Space, from any segment focused', () => {
    fc.assert(
      fc.property(anyGroup, fc.nat(), ({ segments, chosen }, focused) => {
        const value = chosen < 0 ? '\u0000none' : segments[chosen].value;
        const onChange = vi.fn();
        const container = mount(
          segments as Segment<string | boolean>[],
          value,
          onChange
        );

        press(segmentsOf(container)[focused % segments.length], ' ');

        expect(onChange.mock.calls).toEqual([
          [segments[(chosen + 1) % segments.length].value],
        ]);
      }),
      { numRuns: 30 }
    );
  });

  it('lets Enter bubble on, keeping only its native press from running', () => {
    fc.assert(
      fc.property(anyGroup, fc.nat(), ({ segments, chosen }, focused) => {
        const value = chosen < 0 ? '\u0000none' : segments[chosen].value;
        const onChange = vi.fn();
        const container = mount(
          segments as Segment<string | boolean>[],
          value,
          onChange
        );
        const target = segmentsOf(container)[focused % segments.length];
        void act(() => {
          target.focus();
        });
        const seen = vi.fn((e: KeyboardEvent) => e.key);
        container.addEventListener('keydown', seen);

        const event = press(target, 'Enter');

        // Prevented: a focused button would otherwise press itself
        expect(event.defaultPrevented).toBe(true);
        expect(seen.mock.results.map((r) => r.value as string)).toEqual([
          'Enter',
        ]);
        expect(onChange).not.toHaveBeenCalled();
        expect(segmentsOf(container).map(isPressed)).toEqual(
          segments.map((_, j) => j === chosen)
        );
        expect(document.activeElement).toBe(target);
      }),
      { numRuns: 30 }
    );
  });

  it('leaves keys other than Space and Enter alone', () => {
    fc.assert(
      fc.property(
        anyGroup,
        fc.nat(),
        otherKey,
        ({ segments, chosen }, focused, key) => {
          const value = chosen < 0 ? '\u0000none' : segments[chosen].value;
          const onChange = vi.fn();
          const container = mount(
            segments as Segment<string | boolean>[],
            value,
            onChange
          );
          const target = segmentsOf(container)[focused % segments.length];
          void act(() => {
            target.focus();
          });

          const event = press(target, key);

          expect(event.defaultPrevented).toBe(false);
          expect(onChange).not.toHaveBeenCalled();
          expect(document.activeElement).toBe(target);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('carries no class or state beyond the segment class while unpressed', () => {
    const container = mount(
      [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      'a'
    );
    const [pressed, unpressed] = segmentsOf(container);
    expect(pressed.className).toBe('ir-segment is-active');
    expect(unpressed.className).toBe('ir-segment');
    expect(groups(container)[0].className).toBe('ir-segments');
  });
});

describe('confirmsOnEnter', () => {
  /** A segment of a group mounted in the document. */
  function aSegment() {
    const container = mount(
      [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      'a'
    );
    return segmentsOf(container)[1];
  }

  /** `el`, put in a mounted group beside its segments. */
  function inAGroup(el: HTMLElement) {
    aSegment().parentElement!.append(el);
    return el;
  }

  /** A button inside `parent`, which is not a segment group. */
  function buttonIn(parent: HTMLElement) {
    const button = document.createElement('button');
    parent.append(button);
    document.body.append(parent);
    containers.push(parent);
    return button;
  }

  /** Where Enter can come from in a dialog, and whether it confirms there. */
  const sources = fc.constantFrom(
    { make: aSegment, confirms: true },
    { make: () => inAGroup(document.createElement('span')), confirms: true },
    { make: () => document.createElement('input'), confirms: true },
    { make: () => document.createElement('div'), confirms: true },
    { make: () => document.createElement('button'), confirms: false },
    { make: () => buttonIn(document.createElement('div')), confirms: false },
    {
      // A button in a container styled like a segment, not in a group
      make: () => {
        const parent = document.createElement('div');
        parent.className = 'ir-segments';
        return buttonIn(parent);
      },
      confirms: false,
    }
  );

  it('confirms on Enter from anywhere but a button outside a segment group', () => {
    fc.assert(
      fc.property(sources, ({ make, confirms }) => {
        expect(confirmsOnEnter({ key: 'Enter', target: make() })).toBe(
          confirms
        );
      }),
      { numRuns: 20 }
    );
  });

  it('confirms on no key but Enter', () => {
    fc.assert(
      fc.property(
        sources,
        fc.oneof(otherKey, fc.constant(' ')),
        ({ make }, key) => {
          expect(confirmsOnEnter({ key, target: make() })).toBe(false);
        }
      ),
      { numRuns: 30 }
    );
  });
});
