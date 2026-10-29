// @vitest-environment jsdom
import fc from 'fast-check';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentGroup, type Segment } from './SegmentGroup';

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
