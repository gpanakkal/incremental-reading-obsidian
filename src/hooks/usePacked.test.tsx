// @vitest-environment jsdom
import fc from 'fast-check';
import { type ComponentChildren, render } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPacked, isZonePacked, usePacked } from './usePacked';

// #region HELPERS

/**
 * Chromium lays out in 1/64 px units, so most widths a real bar has are
 * multiples of one — and every sum of them is exact in a double, which keeps
 * the 1 px threshold free of rounding noise. Not all, though: a zoomed window
 * or a scaled ancestor reports widths off that grid, so any double is drawn
 * too.
 */
const LAYOUT_UNIT = 1 / 64;

/** A laid-out width from 0 to `maxPx`. */
const widthArb = (maxPx = 2000) =>
  fc.oneof(
    fc.integer({ min: 0, max: maxPx * 64 }).map((n) => n * LAYOUT_UNIT),
    fc.double({ min: 0, max: maxPx, noNaN: true })
  );

/** A margin, which CSS lets run negative, from -`maxPx` to `maxPx`. */
const marginArb = (maxPx = 16) =>
  fc.oneof(
    fc
      .integer({ min: -maxPx * 64, max: maxPx * 64 })
      .map((n) => n * LAYOUT_UNIT),
    fc.double({ min: -maxPx, max: maxPx, noNaN: true })
  );

/** How far the zone's own width runs past its content, either way. */
const slackArb = fc.oneof(
  fc.integer({ min: -64 * 500, max: 64 * 500 }).map((n) => n * LAYOUT_UNIT),
  fc.double({ min: -500, max: 500, noNaN: true }),
  // The threshold itself, and a layout unit either side of it
  fc.constantFrom(1 - LAYOUT_UNIT, 1, 1 + LAYOUT_UNIT)
);

/**
 * Skip the one case the oracle cannot judge: off-grid widths summed in another
 * order than the code sums them can land a rounding error either side of the
 * threshold, so a slack within a hair of it is only checked on the grid.
 */
function assumeJudgeable(values: readonly number[], slack: number): void {
  const onGrid = values.every((v) => Number.isInteger(v / LAYOUT_UNIT));
  fc.pre(onGrid || Math.abs(slack - 1) > 1e-6);
}

/** The width a flex row's children take: theirs, plus a gap between each. */
function contentOf(widths: readonly number[], gap: number): number {
  const sum = widths.reduce((total, w) => total + w, 0);
  return sum + gap * Math.max(0, widths.length - 1);
}

/**
 * A child as the zone lays it out: its border-box width, its left and right
 * margins (none unless given), and whether it is displayed.
 */
type ChildBox = {
  width: number;
  shown: boolean;
  margins?: readonly [number, number];
};

const childArb: fc.Arbitrary<ChildBox> = fc.record({
  width: widthArb(),
  shown: fc.boolean(),
  margins: fc.tuple(marginArb(), marginArb()),
});

/** The room each child that takes part in layout takes, margins and all. */
const shownWidths = (children: readonly ChildBox[]) =>
  children
    .filter((c) => c.shown)
    .map((c) => c.width + (c.margins?.[0] ?? 0) + (c.margins?.[1] ?? 0));

/** Every number a child's layout is drawn from. */
const boxValues = (children: readonly ChildBox[]) =>
  children.flatMap((c) => [c.width, ...(c.margins ?? [])]);

/** A child's margins as inline style. */
const marginStyle = (box: ChildBox) => ({
  marginLeft: `${box.margins?.[0] ?? 0}px`,
  marginRight: `${box.margins?.[1] ?? 0}px`,
});

/**
 * Stand in for the layout jsdom does not do: every element is as wide as its
 * `data-width` says, and one marked `data-hidden` is `display: none` — no
 * client rects, though its bounding box keeps that width, so a zone that
 * measured it anyway would be caught out.
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

/** A zone in the document holding `children`, `columnGap` apart. */
function makeZone(
  children: readonly ChildBox[],
  width: number,
  columnGap: string,
  doc: Document = document
): HTMLElement {
  const zone = doc.createElement('div');
  zone.style.columnGap = columnGap;
  zone.dataset.width = String(width);
  doc.body.appendChild(zone);
  for (const child of children) {
    const el = zone.appendChild(doc.createElement('button'));
    el.dataset.width = String(child.width);
    Object.assign(el.style, marginStyle(child));
    if (!child.shown) el.dataset.hidden = '';
  }
  return zone;
}

/** Which of an element's boxes a layout changed the size of. */
type ResizedBox = 'content-box' | 'border-box' | 'both';

/**
 * A ResizeObserver that reports only when told to: `resize(el, box)` tells
 * each observer watching that box of `el` — the content box unless asked for
 * another, as the real one defaults to — as the browser does after a layout
 * that changed its size, and nobody else.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Map<Element, ResizeObserverBoxOptions>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element, options?: ResizeObserverOptions) {
    this.observed.set(el, options?.box ?? 'content-box');
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  static resize(el: Element, changed: ResizedBox = 'both') {
    for (const observer of FakeResizeObserver.instances) {
      const box = observer.observed.get(el);
      if (box === undefined || (changed !== 'both' && changed !== box)) {
        continue;
      }
      observer.callback(
        [{ target: el } as ResizeObserverEntry],
        observer as unknown as ResizeObserver
      );
    }
  }
  /** Elements any observer still watches. */
  static watched(): Element[] {
    return FakeResizeObserver.instances.flatMap((o) => [...o.observed.keys()]);
  }
}

/** The ResizeObserver of another window, for a tab moved into it. */
class PopoutResizeObserver extends FakeResizeObserver {}

/**
 * Give every element Obsidian's `onWindowMigrated` (a DOM extension of its
 * own, declared in obsidian.d.ts), and return a way to move the zone into a
 * window whose ResizeObserver is {@link PopoutResizeObserver}.
 */
function stubWindowMigration() {
  const listeners = new Map<(win: Window) => void, HTMLElement>();
  const unsubscribe = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'onWindowMigrated', {
    configurable: true,
    value(this: HTMLElement, listener: (win: Window) => void) {
      // As Obsidian hears of the move: an animation keyed to this class
      this.classList.add('node-insert-event');
      listeners.set(listener, this);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    },
  });
  const popout = {
    ResizeObserver: PopoutResizeObserver,
    MutationObserver,
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    document: {},
  } as unknown as Window;
  Object.assign(popout.document, { defaultView: popout });
  return {
    unsubscribe,
    migrate: () =>
      listeners.forEach((el, listener) => {
        // A class rewritten away takes the animation, and the news, with it
        if (el.classList.contains('node-insert-event')) listener(popout);
      }),
  };
}

/** Calls the hook with a ref it never attaches to anything. */
function Unattached() {
  const ref = useRef<HTMLDivElement>(null);
  return <output data-packed={String(usePacked(ref))} />;
}

/** Renders the hook's answer onto the zone it measures. */
function Zone({
  width,
  hidden = false,
  children,
}: {
  width: number;
  /** Out of layout, as a zone in a background tab is. */
  hidden?: boolean;
  children?: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const packed = usePacked(ref);
  return (
    <div
      ref={ref}
      data-width={String(width)}
      data-packed={String(packed)}
      data-hidden={hidden ? '' : undefined}
      style={{ columnGap: '8px' }}
    >
      {children}
    </div>
  );
}

/** One child of {@link Zone}, laid out as `box` says. */
function Child({ box }: { box: ChildBox }) {
  return (
    <button
      data-width={String(box.width)}
      data-hidden={box.shown ? undefined : ''}
      style={marginStyle(box)}
    />
  );
}

let container: HTMLElement;

/** Render a zone of `children`, `width` wide, into the shared container. */
function renderZone(
  width: number,
  children: readonly ChildBox[],
  { hidden = false } = {}
) {
  void act(() => {
    render(
      <Zone width={width} hidden={hidden}>
        {children.map((box, i) => (
          // eslint-disable-next-line @eslint-react/no-array-index-key -- positional on purpose: a child is the slot it lays out in
          <Child key={i} box={box} />
        ))}
      </Zone>,
      container
    );
  });
}

const zoneEl = () => container.firstElementChild as HTMLElement;
const packedShown = () => zoneEl().dataset.packed;

/** Lets MutationObserver callbacks run. */
const flushMutations = () => new Promise<void>((r) => setTimeout(r, 0));

// #endregion

beforeEach(() => {
  layOutFromData();
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  container = document.body.appendChild(document.createElement('div'));
});

afterEach(() => {
  render(null, container);
  Reflect.deleteProperty(HTMLElement.prototype, 'onWindowMigrated');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('isPacked', () => {
  it('is packed when the zone is no more than 1px wider than its children and the gaps between them', () => {
    fc.assert(
      fc.property(
        // Margins included, so a child can take less than its box, or none
        fc.array(fc.oneof(widthArb(), marginArb(64)), { maxLength: 12 }),
        widthArb(64),
        slackArb,
        (widths, gap, slack) => {
          assumeJudgeable([...widths, gap], slack);
          const zoneWidth = contentOf(widths, gap) + slack;
          expect(isPacked(widths, gap, zoneWidth)).toBe(slack <= 1);
        }
      )
    );
  });
});

describe('isZonePacked', () => {
  it('measures the displayed children, their margins and the gaps between them against the zone', () => {
    fc.assert(
      fc.property(
        fc.array(childArb, { maxLength: 12 }),
        widthArb(64),
        slackArb,
        (children, gap, slack) => {
          assumeJudgeable([...boxValues(children), gap], slack);
          const zone = makeZone(
            children,
            contentOf(shownWidths(children), gap) + slack,
            `${gap}px`
          );
          expect(isZonePacked(zone)).toBe(slack <= 1);
        }
      )
    );
  });

  it('measures a zone in a document with no window of its own', () => {
    // One built by `createHTMLDocument`: styles resolve through this window
    fc.assert(
      fc.property(
        fc.array(childArb, { maxLength: 12 }),
        widthArb(64),
        slackArb,
        (children, gap, slack) => {
          assumeJudgeable([...boxValues(children), gap], slack);
          const doc = document.implementation.createHTMLDocument('');
          expect(doc.defaultView).toBeNull();
          const zone = makeZone(
            children,
            contentOf(shownWidths(children), gap) + slack,
            `${gap}px`,
            doc
          );
          expect(isZonePacked(zone)).toBe(slack <= 1);
        }
      )
    );
  });

  it('counts no gap for a zone whose column-gap is `normal`', () => {
    fc.assert(
      fc.property(
        fc.array(widthArb(), { minLength: 2, maxLength: 12 }),
        slackArb,
        (widths, slack) => {
          assumeJudgeable(widths, slack);
          const zone = makeZone(
            widths.map((width) => ({ width, shown: true })),
            contentOf(widths, 0) + slack,
            'normal'
          );
          expect(isZonePacked(zone)).toBe(slack <= 1);
        }
      )
    );
  });
});

describe('usePacked', () => {
  it('reports whether the zone is packed from its first render', () => {
    fc.assert(
      fc.property(
        fc.array(childArb, { maxLength: 8 }),
        slackArb,
        (children, slack) => {
          assumeJudgeable(boxValues(children), slack);
          renderZone(contentOf(shownWidths(children), 8) + slack, children);
          expect(packedShown()).toBe(String(slack <= 1));
          render(null, container);
        }
      )
    );
  });
});

describe('usePacked as the layout changes', () => {
  /** Two 40px buttons, 8px apart: 88px of content. */
  const PAIR: ChildBox[] = [
    { width: 40, shown: true },
    { width: 40, shown: true },
  ];

  it('measures again when the zone resizes, and only then', () => {
    renderZone(200, PAIR);
    expect(packedShown()).toBe('false');

    // Laid out narrower, but not yet reported
    renderZone(88, PAIR);
    expect(packedShown()).toBe('false');

    void act(() => FakeResizeObserver.resize(zoneEl()));
    expect(packedShown()).toBe('true');

    renderZone(300, PAIR);
    void act(() => FakeResizeObserver.resize(zoneEl()));
    expect(packedShown()).toBe('false');
  });

  it('measures again when a child resizes or leaves layout', () => {
    renderZone(100, PAIR);
    expect(packedShown()).toBe('false');

    renderZone(100, [PAIR[0], { width: 60, shown: true }]);
    void act(() => FakeResizeObserver.resize(zoneEl().children[1]));
    expect(packedShown()).toBe('true');

    // `display: none` takes it and its gap out: 40px against 100px
    renderZone(100, [PAIR[0], { width: 60, shown: false }]);
    void act(() => FakeResizeObserver.resize(zoneEl().children[1]));
    expect(packedShown()).toBe('false');
  });

  it('measures again when children come and go, and watches the new ones', async () => {
    renderZone(140, PAIR);
    expect(packedShown()).toBe('false');

    // 40 + 8 + 40 + 8 + 50 = 146px
    renderZone(140, [...PAIR, { width: 50, shown: true }]);
    await act(flushMutations);
    expect(packedShown()).toBe('true');

    const added = zoneEl().children[2];
    renderZone(140, [...PAIR, { width: 20, shown: true }]);
    void act(() => FakeResizeObserver.resize(added));
    expect(packedShown()).toBe('false');

    renderZone(140, [PAIR[0]]);
    await act(flushMutations);
    expect(packedShown()).toBe('false');
    expect(FakeResizeObserver.watched()).toEqual([
      zoneEl(),
      zoneEl().children[0],
    ]);
  });

  it('stops watching once unmounted', async () => {
    renderZone(100, PAIR);
    const zone = zoneEl();
    void act(() => render(null, container));
    expect(FakeResizeObserver.watched()).toEqual([]);

    // A child appended after unmount wakes nothing up
    zone.appendChild(document.createElement('button'));
    await flushMutations();
    expect(FakeResizeObserver.watched()).toEqual([]);
  });

  it('keeps its last answer while the zone is out of layout', () => {
    // A background tab's zone measures 0px wide, which is not packed
    renderZone(200, PAIR);
    renderZone(0, PAIR, { hidden: true });
    void act(() => FakeResizeObserver.resize(zoneEl()));
    expect(packedShown()).toBe('false');

    renderZone(88, PAIR);
    void act(() => FakeResizeObserver.resize(zoneEl()));
    expect(packedShown()).toBe('true');
    renderZone(500, [], { hidden: true });
    void act(() => FakeResizeObserver.resize(zoneEl()));
    expect(packedShown()).toBe('true');
  });

  it('reports not packed, and watches nothing, with nothing under the ref', () => {
    void act(() => render(<Unattached />, container));
    expect(container.querySelector('output')?.getAttribute('data-packed')).toBe(
      'false'
    );
    expect(FakeResizeObserver.instances).toEqual([]);
  });

  it('reports not packed, and does not throw, where there is no ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    renderZone(0, PAIR);
    expect(packedShown()).toBe('false');
  });
});

describe('usePacked across boxes and windows', () => {
  const PAIR: ChildBox[] = [
    { width: 40, shown: true },
    { width: 40, shown: true },
  ];

  it("measures again when only a child's padding or border changes", () => {
    // The icon inside stays put, so only the border box the zone sums grows
    renderZone(100, PAIR);
    renderZone(100, [PAIR[0], { width: 60, shown: true }]);
    void act(() =>
      FakeResizeObserver.resize(zoneEl().children[1], 'border-box')
    );
    expect(packedShown()).toBe('true');
  });

  it("measures again when only the zone's border box changes", () => {
    renderZone(200, PAIR);
    renderZone(88, PAIR);
    void act(() => FakeResizeObserver.resize(zoneEl(), 'border-box'));
    expect(packedShown()).toBe('true');
  });

  it('follows the tab into another window', () => {
    const { migrate } = stubWindowMigration();
    renderZone(200, PAIR);
    const before = FakeResizeObserver.instances.slice();

    void act(migrate);
    // Watched from the new window alone, zone and children alike
    expect(before.flatMap((o) => [...o.observed.keys()])).toEqual([]);
    const popout = FakeResizeObserver.instances.filter(
      (o) => o instanceof PopoutResizeObserver
    );
    expect(popout.flatMap((o) => [...o.observed.keys()])).toEqual([
      zoneEl(),
      ...Array.from(zoneEl().children),
    ]);

    renderZone(88, PAIR);
    void act(() => FakeResizeObserver.resize(zoneEl()));
    expect(packedShown()).toBe('true');
  });

  it('measures on arrival in the other window', () => {
    const { migrate } = stubWindowMigration();
    renderZone(200, PAIR);
    renderZone(88, PAIR);
    expect(packedShown()).toBe('false');

    void act(migrate);
    expect(packedShown()).toBe('true');
  });

  it('stops following windows once unmounted', () => {
    const { migrate, unsubscribe } = stubWindowMigration();
    renderZone(200, PAIR);
    void act(() => render(null, container));
    expect(unsubscribe).toHaveBeenCalledOnce();

    migrate();
    expect(FakeResizeObserver.watched()).toEqual([]);
  });
});
