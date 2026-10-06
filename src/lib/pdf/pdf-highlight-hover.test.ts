// @vitest-environment jsdom
import { fakePdfLayout, type FakeRect } from '#/test/pdf-layout';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPdfHighlightHover,
  HOVERED_CLASS,
  POINTER_CLASS,
} from './pdf-highlight-hover';

// #region HELPERS

/** Where the page's overlay is on screen. */
const FRAME: FakeRect = { left: 20, top: 10, width: 600, height: 800 };

/** A box in an overlay, in percent of the page. */
interface PercentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const boxArb = fc.record({
  left: fc.nat({ max: 90 }),
  top: fc.nat({ max: 90 }),
  width: fc.integer({ min: 1, max: 70 }),
  height: fc.integer({ min: 1, max: 70 }),
});

/** Where the fake layout puts `box`, as a browser lays it out. */
function onScreen(box: PercentBox) {
  const left = FRAME.left + (box.left / 100) * FRAME.width;
  const top = FRAME.top + (box.top / 100) * FRAME.height;
  return {
    left,
    top,
    right: left + (box.width / 100) * FRAME.width,
    bottom: top + (box.height / 100) * FRAME.height,
  };
}

/** Put a box for each of `boxes` in `overlay`, in place of what it held. */
function fillOverlay(overlay: Element, boxes: readonly PercentBox[]) {
  overlay.replaceChildren(
    ...boxes.map((box, i) => {
      const el = document.createElement('div');
      // Every other one a card's, as the layer draws them
      el.className =
        i % 2
          ? 'ir-snippet-highlight ir-card-highlight'
          : 'ir-snippet-highlight';
      Object.assign(el.style, {
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      });
      return el;
    })
  );
  return Array.from(overlay.children);
}

/**
 * A page div as pdf.js builds one, with a canvas wrapper holding a canvas
 * and the plugin's overlay of `boxes`, a text layer holding an item, and an
 * annotation layer holding a link.
 */
function buildPage(parent: Element, boxes: readonly PercentBox[]) {
  const pageEl = parent.appendChild(document.createElement('div'));
  pageEl.className = 'page';
  pageEl.dataset.pageNumber = '1';
  const wrapper = pageEl.appendChild(document.createElement('div'));
  wrapper.className = 'canvasWrapper';
  const canvas = wrapper.appendChild(document.createElement('canvas'));
  const overlay = wrapper.appendChild(document.createElement('div'));
  overlay.className = 'ir-pdf-highlights';
  const textLayer = pageEl.appendChild(document.createElement('div'));
  textLayer.className = 'textLayer';
  const item = textLayer.appendChild(document.createElement('span'));
  item.className = 'textLayerNode';
  item.dataset.idx = '0';
  item.textContent = 'Hello world';
  const annotations = pageEl.appendChild(document.createElement('div'));
  annotations.className = 'annotationLayer';
  const link = annotations.appendChild(document.createElement('a'));
  return {
    pageEl,
    canvas,
    overlay,
    textLayer,
    item,
    link,
    els: fillOverlay(overlay, boxes),
  };
}

/**
 * A PDF viewer: a toolbar and a page of `boxes`. Beside it, outside it, the
 * page of another viewer, a box over the whole of it.
 */
function buildViewer(boxes: readonly PercentBox[]) {
  const containerEl = document.body.appendChild(document.createElement('div'));
  const toolbar = containerEl.appendChild(document.createElement('div'));
  toolbar.className = 'pdf-toolbar';
  const viewerEl = containerEl.appendChild(document.createElement('div'));
  viewerEl.className = 'pdfViewer';
  const page = buildPage(viewerEl, boxes);
  const elsewhere = buildPage(document.body, [
    { left: 0, top: 0, width: 100, height: 100 },
  ]);
  return { containerEl, toolbar, viewerEl, page, elsewhere };
}

/** What lies on top at a point, as `elementFromPoint` reports it. */
const TARGETS = [
  'item',
  'textLayer',
  'canvas',
  'link',
  'toolbar',
  // Another viewer laid over this one, as a popover may be
  'elsewhere',
  'nothing',
] as const;
type Target = (typeof TARGETS)[number];

/**
 * A coordinate from `min` to `max`, whole or fractional, spread evenly:
 * `fc.double` crowds its values next to 0 and the bounds, here off the page.
 */
const coordArb = (min: number, max: number) =>
  fc
    .tuple(fc.integer({ min, max }), fc.constantFrom(0, 0.25, 0.5, 0.999))
    .map(([whole, part]) => whole + part);

/** A point on screen, mostly over the page, and what is on top there. */
const pointArb = fc.record({
  x: coordArb(FRAME.left - 10, FRAME.left + FRAME.width + 10),
  y: coordArb(FRAME.top - 10, FRAME.top + FRAME.height + 10),
  target: fc.constantFrom(...TARGETS),
});
type Point = { x: number; y: number; target: Target };

/** Mostly a mouse; now and then a finger, a pen, or a device of no type. */
const pointerTypeArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant('mouse') },
  { weight: 1, arbitrary: fc.constantFrom('touch', 'pen', '') }
);

/** Mostly none down; now and then primary, secondary, middle, or two. */
const buttonsArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constantFrom(1, 2, 4, 3) }
);

/** Mostly a move; now and then a press or a release. */
const pointerEventArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant('pointermove') },
  { weight: 1, arbitrary: fc.constantFrom('pointerdown', 'pointerup') }
);

/**
 * Something a reader, pdf.js or the plugin's layer does: mostly the mouse
 * moving, and frames passing. A pointer event says which buttons are down
 * after it, as browsers do: a press, at least one; a release, maybe none.
 */
const actionArb = (points: number) =>
  fc.oneof(
    {
      weight: 8,
      arbitrary: fc.record({
        type: fc.constant('pointer' as const),
        event: pointerEventArb,
        pointerType: pointerTypeArb,
        buttons: buttonsArb,
        at: fc.nat({ max: points - 1 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({ type: fc.constant('frame' as const) }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        type: fc.constant('leave' as const),
        pointerType: pointerTypeArb,
      }),
    },
    fc.record({ type: fc.constant('scroll' as const) }),
    fc.record({ type: fc.constant('refresh' as const) }),
    fc.record({ type: fc.constant('enable' as const), on: fc.boolean() }),
    // The layer draws the boxes afresh, maybe elsewhere
    fc.record({
      type: fc.constant('redraw' as const),
      boxes: fc.array(boxArb, { maxLength: 4 }),
    })
  );

/** What the hover should show: the topmost box over a point on a page here. */
function expectedAt(
  point: Point,
  boxes: readonly { el: Element; box: PercentBox }[]
) {
  if (!['item', 'textLayer', 'canvas'].includes(point.target)) return null;
  for (let i = boxes.length - 1; i >= 0; i--) {
    const { left, top, right, bottom } = onScreen(boxes[i].box);
    if (
      point.x >= left &&
      point.x < right &&
      point.y >= top &&
      point.y < bottom
    ) {
      return boxes[i].el;
    }
  }
  return null;
}

// #endregion

let layout: ReturnType<typeof fakePdfLayout>;

beforeEach(() => {
  vi.useFakeTimers();
  layout = fakePdfLayout(() => FRAME);
});

afterEach(() => {
  layout.restore();
  document.body.replaceChildren();
  delete (document as Partial<Document>).elementFromPoint;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createPdfHighlightHover', () => {
  it('marks the topmost box under a resting mouse, at most once a frame, frozen while a button is down, and only while enabled', () => {
    fc.assert(
      fc.property(
        fc.array(boxArb, { maxLength: 4 }),
        fc.uniqueArray(pointArb, {
          minLength: 1,
          maxLength: 4,
          selector: ({ x, y }) => `${x},${y}`,
        }),
        fc.boolean(),
        fc
          .nat({ max: 3 })
          .chain((n) =>
            fc.array(actionArb(n + 1), { minLength: 10, maxLength: 40 })
          ),
        (initial, points, startOn, actions) => {
          const { containerEl, toolbar, viewerEl, page, elsewhere } =
            buildViewer(initial);
          const elementOf: Record<Target, Element | null> = {
            item: page.item,
            textLayer: page.textLayer,
            canvas: page.canvas,
            link: page.link,
            toolbar,
            elsewhere: elsewhere.textLayer,
            nothing: null,
          };
          const pointAt = (i: number) => points[i % points.length];
          const elementFromPoint = vi.fn((x: number, y: number) => {
            const point = points.find((p) => p.x === x && p.y === y);
            return point ? elementOf[point.target] : null;
          });
          document.elementFromPoint = elementFromPoint;
          const textLayerBefore = page.textLayer.outerHTML;
          let boxes = page.els.map((el, i) => ({ el, box: initial[i] }));

          // The model
          let on = false;
          /** Where the mouse rests, with no button down. */
          let at: Point | null = null;
          let scheduled = false;
          let hovered: Element | null = null;
          /** Whether the container shows the pointer cursor. */
          let pointer = false;
          let looks = 0;

          const hover = createPdfHighlightHover(containerEl);
          const enable = (next: boolean) => {
            hover.enable(next);
            if (next === on) return;
            on = next;
            if (!on) {
              at = null;
              hovered = null;
              pointer = false;
            }
          };
          const schedule = () => {
            if (at) scheduled = true;
          };
          enable(startOn);

          for (const action of actions) {
            switch (action.type) {
              case 'pointer': {
                const point = pointAt(action.at);
                const evt = new PointerEvent(action.event, {
                  bubbles: true,
                  pointerType: action.pointerType,
                  buttons: action.buttons,
                  clientX: point.x,
                  clientY: point.y,
                });
                // An event over another viewer reaches this one only when
                // that one was laid over it since
                const target = elementOf[point.target];
                (target && containerEl.contains(target)
                  ? target
                  : containerEl
                ).dispatchEvent(evt);
                if (!on || action.pointerType !== 'mouse') break;
                // A drag: the ring stays as it is until no button is down,
                // the pointer cursor giving way meanwhile
                at = action.buttons === 0 ? point : null;
                if (at) schedule();
                else pointer = false;
                break;
              }
              case 'leave':
                // Fired at the container alone; it doesn't bubble
                containerEl.dispatchEvent(
                  new PointerEvent('pointerleave', {
                    pointerType: action.pointerType,
                  })
                );
                if (on && action.pointerType === 'mouse') {
                  at = null;
                  hovered = null;
                  pointer = false;
                }
                break;
              case 'scroll':
                // Scrolls don't bubble: fired at the scrolled element
                viewerEl.dispatchEvent(new Event('scroll'));
                if (on) schedule();
                break;
              case 'refresh':
                hover.refresh();
                schedule();
                break;
              case 'frame':
                vi.advanceTimersToNextFrame();
                if (scheduled) {
                  scheduled = false;
                  if (at) {
                    looks++;
                    hovered = expectedAt(at, boxes);
                    pointer = hovered !== null;
                  }
                }
                break;
              case 'enable':
                enable(action.on);
                break;
              case 'redraw':
                boxes = fillOverlay(page.overlay, action.boxes).map(
                  (el, i) => ({ el, box: action.boxes[i] })
                );
                break;
            }

            const marked = document.querySelectorAll(`.${HOVERED_CLASS}`);
            expect(Array.from(marked)).toEqual(
              hovered?.isConnected ? [hovered] : []
            );
            if (hovered) {
              expect(hovered.classList.contains(HOVERED_CLASS)).toBe(true);
            }
            expect(containerEl.classList.contains(POINTER_CLASS)).toBe(pointer);
          }

          expect(elementFromPoint).toHaveBeenCalledTimes(looks);
          // Nothing of pdf.js's text layer touched
          expect(page.textLayer.outerHTML).toBe(textLayerBefore);
          hover.enable(false);
          vi.clearAllTimers();
          containerEl.remove();
          elsewhere.pageEl.remove();
        }
      ),
      { numRuns: 300 }
    );
  });

  it('keeps the mark as it is from a mouse press, whatever is drawn under it, until the button is let go; a finger pressing changes nothing', () => {
    const WHOLE = { left: 0, top: 0, width: 100, height: 100 };
    const { containerEl, viewerEl, page } = buildViewer([WHOLE]);
    document.elementFromPoint = () => page.item;
    const hover = createPdfHighlightHover(containerEl);
    hover.enable(true);
    const point = { clientX: FRAME.left + 5, clientY: FRAME.top + 5 };
    const fire = (type: string, pointerType: string, buttons = 0) =>
      page.item.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerType,
          buttons,
          ...point,
        })
      );
    fire('pointermove', 'mouse');
    vi.advanceTimersToNextFrame();
    expect(page.els[0].classList.contains(HOVERED_CLASS)).toBe(true);

    // Moving over the same box changes no class at all
    const classes = new MutationObserver(() => {});
    classes.observe(containerEl, { subtree: true, attributeFilter: ['class'] });
    fire('pointermove', 'mouse');
    vi.advanceTimersToNextFrame();
    expect(classes.takeRecords()).toEqual([]);
    classes.disconnect();

    // Pressed, then the layer draws the box afresh
    fire('pointerdown', 'mouse', 1);
    const [fresh] = fillOverlay(page.overlay, [WHOLE]);
    hover.refresh();
    viewerEl.dispatchEvent(new Event('scroll'));
    vi.advanceTimersToNextFrame();
    expect(fresh.classList.contains(HOVERED_CLASS)).toBe(false);
    expect(page.els[0].classList.contains(HOVERED_CLASS)).toBe(true);
    expect(containerEl.classList.contains(POINTER_CLASS)).toBe(false);
    // A second button let go, the first still down
    fire('pointerup', 'mouse', 1);
    vi.advanceTimersToNextFrame();
    expect(fresh.classList.contains(HOVERED_CLASS)).toBe(false);
    expect(containerEl.classList.contains(POINTER_CLASS)).toBe(false);

    // Every button let go, the mouse at rest
    fire('pointerup', 'mouse');
    vi.advanceTimersToNextFrame();
    expect(fresh.classList.contains(HOVERED_CLASS)).toBe(true);
    expect(containerEl.classList.contains(POINTER_CLASS)).toBe(true);

    // A finger leaving the viewer leaves the mouse's mark be
    containerEl.dispatchEvent(
      new PointerEvent('pointerleave', { pointerType: 'touch' })
    );
    expect(fresh.classList.contains(HOVERED_CLASS)).toBe(true);

    // A finger down, and the box drawn afresh again
    fire('pointerdown', 'touch', 1);
    const [again] = fillOverlay(page.overlay, [WHOLE]);
    hover.refresh();
    vi.advanceTimersToNextFrame();
    expect(again.classList.contains(HOVERED_CLASS)).toBe(true);
    hover.enable(false);
  });

  it('listens to nothing while not enabled, and takes off all it listens to', () => {
    const { containerEl } = buildViewer([
      { left: 0, top: 0, width: 50, height: 50 },
    ]);
    const add = vi.spyOn(containerEl, 'addEventListener');
    const remove = vi.spyOn(containerEl, 'removeEventListener');
    // Nothing on pdf.js's own layers, or anywhere else: spied on second, so
    // the container's own spy calls past it
    const anywhere = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const hover = createPdfHighlightHover(containerEl);
    hover.enable(false);
    hover.refresh();
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    hover.enable(true);
    hover.enable(true);
    expect(add.mock.calls.map(([type]) => type).sort()).toEqual([
      'pointerdown',
      'pointerleave',
      'pointermove',
      'pointerup',
      'scroll',
    ]);
    // A scroll doesn't bubble: caught on its way down
    const scroll = add.mock.calls.find(([type]) => type === 'scroll')!;
    expect(scroll[2]).toMatchObject({ capture: true, passive: true });
    expect(anywhere).not.toHaveBeenCalled();

    hover.enable(false);
    hover.enable(false);
    expect(remove.mock.calls).toEqual(add.mock.calls);
  });

  it("asks for frames from the viewer's own window, as in a popout", () => {
    const frame = document.body.appendChild(document.createElement('iframe'));
    const popout = frame.contentDocument!;
    const popoutWindow = frame.contentWindow!;
    const popoutLayout = fakePdfLayout(
      () => FRAME,
      popoutWindow as unknown as typeof globalThis
    );
    const { containerEl, page } = buildViewer([
      { left: 0, top: 0, width: 100, height: 100 },
    ]);
    popout.body.append(popout.adoptNode(containerEl));
    let frameCallback: FrameRequestCallback | undefined;
    const request = vi
      .spyOn(popoutWindow, 'requestAnimationFrame')
      .mockImplementation((cb) => {
        frameCallback = cb;
        return 1;
      });
    popout.elementFromPoint = () => page.item;
    const hover = createPdfHighlightHover(containerEl);
    hover.enable(true);

    page.item.dispatchEvent(
      new (popoutWindow as unknown as typeof globalThis).PointerEvent(
        'pointermove',
        {
          bubbles: true,
          pointerType: 'mouse',
          clientX: FRAME.left + 1,
          clientY: FRAME.top + 1,
        }
      )
    );
    expect(request).toHaveBeenCalledOnce();
    frameCallback!(0);
    expect(page.els[0].classList.contains(HOVERED_CLASS)).toBe(true);
    hover.enable(false);
    popoutLayout.restore();
  });
});
