// @vitest-environment jsdom
import fc from 'fast-check';
import { render } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BarLayout,
  gradePlacement,
  gradesFitInline,
  measureBar,
  useGradePlacement,
} from './useGradePlacement';

// #region HELPERS

/**
 * Chromium lays out in 1/64 px units, so most widths are multiples of one, and
 * sums of them are exact in a double. A zoomed window reports widths off that
 * grid, so any double is drawn too.
 */
const LAYOUT_UNIT = 1 / 64;

const widthArb = (maxPx = 400) =>
  fc.oneof(
    fc.integer({ min: 0, max: maxPx * 64 }).map((n) => n * LAYOUT_UNIT),
    fc.double({ min: 0, max: maxPx, noNaN: true })
  );

/** A zone's children, as the room each takes, and its gap. */
const zoneArb = fc.record({
  widths: fc.array(widthArb(), { maxLength: 8 }),
  gap: widthArb(24),
});

/** How much more than its content each outer zone would get, either way. */
const slackArb = fc.oneof(
  fc.integer({ min: -64 * 300, max: 64 * 300 }).map((n) => n * LAYOUT_UNIT),
  fc.double({ min: -300, max: 300, noNaN: true }),
  fc.constantFrom(1 - LAYOUT_UNIT, 1, 1 + LAYOUT_UNIT)
);

/** The width a flex row's children take: theirs, plus a gap between each. */
function contentOf(widths: readonly number[], gap: number): number {
  const sum = widths.reduce((total, w) => total + w, 0);
  return sum + gap * Math.max(0, widths.length - 1);
}

/**
 * Off-grid values summed in another order than the code sums them can land a
 * rounding error either side of the 1px threshold: near it, check on the grid
 * only.
 */
function assumeJudgeable(values: readonly number[], slack: number): void {
  const onGrid = values.every((v) => Number.isInteger(v / LAYOUT_UNIT));
  fc.pre(onGrid || Math.abs(slack - 1) > 1e-6);
}

/** Every number a layout is drawn from. */
const layoutValues = (l: Omit<BarLayout, 'width'>) => [
  l.gap,
  l.grades,
  ...[l.lead, l.center, l.trail].flatMap((z) => [z.gap, ...z.widths]),
];

/**
 * A bar laid out as `layout` says, minus its width; and the width that, with
 * the grades inline, leaves the fuller of the two outer zones `slack` px wider
 * than its content.
 */
const barArb = fc
  .record({
    gap: widthArb(24),
    lead: zoneArb,
    center: zoneArb,
    trail: zoneArb,
    grades: widthArb(),
  })
  .chain((layout) =>
    fc.tuple(fc.constant(layout), slackArb).map(([l, slack]) => {
      const center =
        l.center.widths.reduce((sum, w) => sum + w, 0) +
        l.grades +
        l.center.gap * l.center.widths.length;
      const outer = Math.max(
        contentOf(l.lead.widths, l.lead.gap),
        contentOf(l.trail.widths, l.trail.gap)
      );
      return {
        layout: { ...l, width: center + 2 * l.gap + 2 * (outer + slack) },
        slack,
      };
    })
  );

/**
 * Stand in for the layout jsdom does not do: every element is as wide as its
 * `data-width` says, and one marked `data-hidden` is `display: none`.
 */
function layOutFromData(): void {
  const box = (el: HTMLElement) =>
    new DOMRect(0, 0, Number(el.dataset.width ?? 0), 30);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return box(this);
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    function (this: HTMLElement) {
      return (this.dataset.hidden === undefined
        ? [box(this)]
        : []) as unknown as DOMRectList;
    }
  );
}

/** A ResizeObserver that reports only when told to (see usePacked.test). */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  static resize(el: Element) {
    for (const observer of FakeResizeObserver.instances) {
      if (!observer.observed.has(el)) continue;
      observer.callback(
        [{ target: el } as ResizeObserverEntry],
        observer as unknown as ResizeObserver
      );
    }
  }
}

/** What a bar's DOM is built from. */
type BarSpec = {
  /** Border-box width; the padding below comes off it. */
  width: number;
  padding?: readonly [number, number];
  lead?: readonly number[];
  center?: readonly number[];
  trail?: readonly number[];
  /** The ghost group's width, or no ghost. */
  ghost?: number | null;
  /** Where the real grade group is, and how wide. */
  real?: { at: 'center' | 'row'; width: number } | null;
};

const zoneEl = (name: string, widths: readonly number[]) => (
  <div className={`ir-bar-${name}`} style={{ columnGap: '8px' }}>
    {widths.map((w, i) => (
      // eslint-disable-next-line @eslint-react/no-array-index-key -- positional on purpose: a child is the slot it lays out in
      <button key={i} data-width={String(w)} />
    ))}
  </div>
);

/** The bar, built as ActionBar builds it, with the real group where told. */
function Bar({
  spec,
  barRef,
}: {
  spec: BarSpec;
  barRef?: preact.RefObject<HTMLDivElement>;
}) {
  const { padding = [15, 15], real = null, ghost = null } = spec;
  const group = (width: number) => (
    <div className="ir-grade-group" data-width={String(width)} />
  );
  return (
    <>
      <div
        ref={barRef}
        className="ir-action-bar"
        data-width={String(spec.width)}
        style={{
          columnGap: '8px',
          paddingLeft: `${padding[0]}px`,
          paddingRight: `${padding[1]}px`,
        }}
      >
        {zoneEl('lead', spec.lead ?? [])}
        <div className="ir-bar-center" style={{ columnGap: '8px' }}>
          {real?.at === 'center' && group(real.width)}
          {(spec.center ?? []).map((w, i) => (
            // eslint-disable-next-line @eslint-react/no-array-index-key -- positional on purpose
            <button key={i} data-width={String(w)} />
          ))}
        </div>
        {zoneEl('trail', spec.trail ?? [])}
        {ghost !== null && <div className="ir-grade-ghost">{group(ghost)}</div>}
      </div>
      {real?.at === 'row' && <div className="ir-grade-row">{group(400)}</div>}
    </>
  );
}

/** Renders the hook's answer next to the bar it measures. */
function Measured({ spec }: { spec: BarSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useGradePlacement(ref);
  return (
    <div data-placement={placement}>
      <Bar spec={spec} barRef={ref} />
    </div>
  );
}

let container: HTMLElement;

function renderBar(spec: BarSpec): HTMLElement {
  render(<Bar spec={spec} />, container);
  return container.querySelector<HTMLElement>('.ir-action-bar')!;
}

function renderMeasured(spec: BarSpec) {
  void act(() => {
    render(<Measured spec={spec} />, container);
  });
}

const placementShown = () =>
  container.querySelector<HTMLElement>('[data-placement]')?.dataset.placement;
const barEl = () => container.querySelector<HTMLElement>('.ir-action-bar')!;
const flushMutations = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A 400px bar: 15px padding each side leaves 370px, less two 8px gaps between
 * zones. The lead holds 100px of content (46 + 8 + 46), so each outer zone
 * must get more than 101px; the center holds a 40px button and a gap besides
 * the grades. Grades under 104px wide fit.
 */
const BASE: BarSpec = {
  width: 400,
  lead: [46, 46],
  center: [40],
  trail: [30],
};
const FITTING_GRADES = 100;
const OVERFLOWING_GRADES = 110;

// #endregion

beforeEach(() => {
  layOutFromData();
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  container = document.body.appendChild(document.createElement('div'));
});

afterEach(() => {
  render(null, container);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.body.className = '';
});

describe('gradesFitInline', () => {
  it('property: fits exactly when, grades inline, both outer zones keep more than 1px beyond their content', () => {
    fc.assert(
      fc.property(barArb, ({ layout, slack }) => {
        assumeJudgeable([...layoutValues(layout)], slack);
        expect(gradesFitInline(layout)).toBe(slack > 1);
      })
    );
  });

  it('property: a wider bar never stops fitting, and wider content never starts to', () => {
    fc.assert(
      fc.property(
        barArb,
        widthArb(),
        fc.constantFrom('lead', 'center', 'trail', 'grades', 'gap'),
        ({ layout }, more, grown) => {
          const fits = gradesFitInline(layout);
          if (fits) {
            expect(
              gradesFitInline({ ...layout, width: layout.width + more })
            ).toBe(true);
          }
          const bigger =
            grown === 'grades' || grown === 'gap'
              ? { ...layout, [grown]: layout[grown] + more }
              : {
                  ...layout,
                  [grown]: {
                    ...layout[grown],
                    widths: [...layout[grown].widths, more],
                  },
                };
          if (!fits) expect(gradesFitInline(bigger)).toBe(false);
        }
      )
    );
  });
});

describe('measureBar', () => {
  it('reads the content box, each zone, and the ghost, leaving the real grades out of the center', () => {
    const bar = renderBar({
      ...BASE,
      padding: [10, 20],
      ghost: 90,
      real: { at: 'center', width: 500 },
    });

    expect(measureBar(bar)).toEqual({
      width: 370,
      gap: 8,
      lead: { widths: [46, 46], gap: 8 },
      center: { widths: [40], gap: 8 },
      trail: { widths: [30], gap: 8 },
      grades: 90,
    });
  });

  it('takes the bar’s borders off its width as well', () => {
    const bar = renderBar({ ...BASE, padding: [10, 20], ghost: 90 });
    bar.style.borderLeft = '2px solid';
    bar.style.borderRight = '3px solid';

    expect(measureBar(bar)?.width).toBe(365);
  });

  it('counts the ghost’s margins, as a theme may give the group some', () => {
    const bar = renderBar({ ...BASE, ghost: 90 });
    const group = bar.querySelector<HTMLElement>('.ir-grade-ghost > *')!;
    group.style.marginLeft = '3px';
    group.style.marginRight = '4px';

    expect(measureBar(bar)?.grades).toBe(97);
  });

  it('has nothing to measure without a ghost, or with one out of layout', () => {
    expect(measureBar(renderBar(BASE))).toBeNull();

    const bar = renderBar({ ...BASE, ghost: 90 });
    bar.querySelector<HTMLElement>('.ir-grade-ghost > *')!.dataset.hidden = '';
    expect(measureBar(bar)).toBeNull();
  });
});

describe('gradePlacement', () => {
  it('puts the grades inline where they fit, and in their own row where not', () => {
    expect(gradePlacement(renderBar({ ...BASE, ghost: FITTING_GRADES }))).toBe(
      'inline'
    );
    expect(
      gradePlacement(renderBar({ ...BASE, ghost: OVERFLOWING_GRADES }))
    ).toBe('row');
  });

  it('property: answers the same wherever the real grades are, so moving them never moves them back', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 1200 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 1200 }),
        (width, ghost, realWidth) => {
          const answers = (['center', 'row'] as const).map((at) =>
            gradePlacement(
              renderBar({
                ...BASE,
                width,
                ghost,
                real: { at, width: realWidth },
              })
            )
          );
          expect(answers[0]).toBe(answers[1]);
          expect(answers[0]).toBe(
            gradePlacement(renderBar({ ...BASE, width, ghost }))
          );
        }
      )
    );
    // Three bars rendered per case: slow under coverage or a loaded machine
  }, 20_000);

  it('always uses the row on a phone', () => {
    document.body.classList.add('is-phone');

    expect(
      gradePlacement(renderBar({ ...BASE, width: 4000, ghost: FITTING_GRADES }))
    ).toBe('row');
  });

  it('has no answer while there are no grades to measure', () => {
    expect(gradePlacement(renderBar({ ...BASE, width: 4000 }))).toBeUndefined();
  });
});

describe('useGradePlacement', () => {
  it('places the grades from the first render', () => {
    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    expect(placementShown()).toBe('inline');

    render(null, container);
    renderMeasured({ ...BASE, ghost: OVERFLOWING_GRADES });
    expect(placementShown()).toBe('row');
  });

  it('places them again when the bar resizes', () => {
    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    renderMeasured({ ...BASE, width: 300, ghost: FITTING_GRADES });
    void act(() => FakeResizeObserver.resize(barEl()));
    expect(placementShown()).toBe('row');
  });

  it('places them again when a button in a zone resizes', () => {
    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    renderMeasured({ ...BASE, lead: [46, 80], ghost: FITTING_GRADES });
    void act(() =>
      FakeResizeObserver.resize(
        barEl().querySelector('.ir-bar-lead')!.children[1]
      )
    );
    expect(placementShown()).toBe('row');
  });

  it('places them again when the grades themselves resize', () => {
    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    renderMeasured({ ...BASE, ghost: OVERFLOWING_GRADES });
    void act(() =>
      FakeResizeObserver.resize(barEl().querySelector('.ir-grade-ghost > *')!)
    );
    expect(placementShown()).toBe('row');
  });

  it('places them once the grades appear, and watches the ghost', async () => {
    renderMeasured(BASE);
    expect(placementShown()).toBe('row');

    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    await act(flushMutations);
    expect(placementShown()).toBe('inline');

    renderMeasured({ ...BASE, ghost: OVERFLOWING_GRADES });
    void act(() =>
      FakeResizeObserver.resize(barEl().querySelector('.ir-grade-ghost > *')!)
    );
    expect(placementShown()).toBe('row');
  });

  it('places them again when the window turns into a phone, or back, with nothing resized', async () => {
    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    expect(placementShown()).toBe('inline');

    document.body.classList.add('is-phone');
    await act(flushMutations);
    expect(placementShown()).toBe('row');

    document.body.classList.remove('is-phone');
    await act(flushMutations);
    expect(placementShown()).toBe('inline');
  });

  it('keeps its last placement while there are no grades, ready for the next card', async () => {
    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    expect(placementShown()).toBe('inline');

    renderMeasured({ ...BASE, width: 100 });
    await act(flushMutations);
    void act(() => FakeResizeObserver.resize(barEl()));
    expect(placementShown()).toBe('inline');
  });

  it('places them again when a zone gains a button', async () => {
    renderMeasured({ ...BASE, ghost: FITTING_GRADES });
    expect(placementShown()).toBe('inline');

    renderMeasured({ ...BASE, center: [40, 40], ghost: FITTING_GRADES });
    await act(flushMutations);
    expect(placementShown()).toBe('row');
  });

  it('uses the row where there is no ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    renderMeasured({ ...BASE, width: 4000, ghost: FITTING_GRADES });
    expect(placementShown()).toBe('row');
  });
});
