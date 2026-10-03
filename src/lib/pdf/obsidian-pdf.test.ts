// @vitest-environment jsdom
import fc from 'fast-check';
import { type App, Platform, Scope, type TFile, type View } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPdfViewer,
  getPdfLocation,
  highlightPdfSelection,
  isPdfView,
  onPdfViewChange,
  pdfTabDocument,
  type PdfViewer,
} from './obsidian-pdf';
import type { PageSelection } from './pdf-selection';

// #region HELPERS

/** What the fake viewer component's child (Obsidian's `PdfViewerChild`) holds. */
interface FakeChild {
  loadFile: ReturnType<typeof vi.fn>;
  findBar: { showSearch: ReturnType<typeof vi.fn> };
}

function makeChild(overrides: Partial<FakeChild> = {}): FakeChild {
  return {
    loadFile: vi.fn().mockResolvedValue(undefined),
    findBar: { showSearch: vi.fn() },
    ...overrides,
  };
}

/**
 * A stand-in for Obsidian's `PdfViewerComponent`, as far as the adapter uses
 * it: `then` queues until the test calls {@link FakeViewerComponent.ready},
 * which is when the real one has built its child.
 */
class FakeViewerComponent {
  static instances: FakeViewerComponent[] = [];
  scope = new Scope();
  load = vi.fn();
  unload = vi.fn();
  loadFile = vi.fn();
  queued: ((child: unknown) => void)[] = [];
  child: unknown = null;

  constructor(
    readonly app: unknown,
    readonly containerEl: HTMLElement,
    readonly opts: unknown
  ) {
    FakeViewerComponent.instances.push(this);
  }

  then(cb: (child: unknown) => void) {
    if (this.child) cb(this.child);
    else this.queued.push(cb);
  }

  ready(child: unknown) {
    this.child = child;
    for (const cb of this.queued.splice(0)) cb(child);
  }
}

/** The embed Obsidian's `embedByExtension.pdf` returns: it holds a viewer. */
function pdfEmbedFactory(
  viewer: unknown = new FakeViewerComponent(null, createDiv(), {})
) {
  return vi.fn(() => ({ viewer }));
}

/**
 * An embed's viewer whose class builds components missing `member`, as a
 * changed Obsidian might.
 */
function viewerWithout(member: keyof FakeViewerComponent): object {
  class Changed {
    constructor(app: unknown, el: HTMLElement, opts: unknown) {
      const component = new FakeViewerComponent(app, el, opts);
      Object.assign(component, { [member]: undefined });
      return component;
    }
  }
  return Object.create(Changed.prototype) as object;
}

/** An app whose embed registry has `pdf` set to `factory`. */
function makeApp(factory: unknown = pdfEmbedFactory()): App {
  return {
    embedRegistry: { embedByExtension: { pdf: factory } },
  } as unknown as App;
}

const file = { path: 'papers/a.pdf', extension: 'pdf' } as TFile;

/**
 * A fake `ResizeObserver` the test fires by hand, standing in for the browser
 * reporting that the review tab came into view. jsdom has none.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.callback();
  }
}

/** jsdom reports no layout, so `offsetParent` is pinned per element. */
function setShown(el: HTMLElement, shown: boolean) {
  Object.defineProperty(el, 'offsetParent', {
    configurable: true,
    get: () => (shown ? el.ownerDocument.body : null),
  });
}

/** A viewer built over a fake component, already loaded. */
function makeViewer(): { viewer: PdfViewer; component: FakeViewerComponent } {
  const viewer = createPdfViewer(makeApp())!;
  const component = FakeViewerComponent.instances.at(-1)!;
  viewer.load();
  return { viewer, component };
}

/**
 * A viewer built over a fake component, with `prepare` run on its container
 * before it is loaded.
 */
function makeViewerWith(prepare: (containerEl: HTMLElement) => void) {
  const viewer = createPdfViewer(makeApp())!;
  const component = FakeViewerComponent.instances.at(-1)!;
  prepare(viewer.containerEl);
  viewer.load();
  return { viewer, component };
}

/** A viewer whose container holds `inside` and sits next to `outside`. */
function withText(inside: string, outside: string) {
  const { viewer } = makeViewer();
  const insideEl = document.createElement('span');
  insideEl.textContent = inside;
  viewer.containerEl.append(insideEl);
  const outsideEl = document.createElement('span');
  outsideEl.textContent = outside;
  document.body.append(viewer.containerEl, outsideEl);
  return { viewer, insideEl, outsideEl };
}

/** Select from `start`/`startOffset` to `end`/`endOffset` in the document. */
function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * The pdf.js `PDFViewer` a loaded child reaches through
 * `child.pdfViewer.pdfViewer`, as far as page turning uses it.
 */
function makePdfJsViewer(currentScaleValue: string) {
  return { currentScaleValue, previousPage: vi.fn(), nextPage: vi.fn() };
}

/**
 * Press `key` on the viewer's scope, as Obsidian's keymap would while the
 * view holding it is active, with the event aimed at `target`.
 */
function pressKey(viewer: PdfViewer, key: string, target: EventTarget) {
  const evt = new KeyboardEvent('keydown', { key, cancelable: true });
  Object.defineProperty(evt, 'target', { value: target });
  const answer = (viewer.scope as unknown as Scope).handleKey(evt, {
    modifiers: '',
    key,
  });
  return { answer, evt };
}

/**
 * A loaded child whose pdf.js app object is `app` and whose eventBus the test
 * dispatches on by hand, through `child.on`/`off` as Obsidian's own code does.
 */
function makeEventChild(app: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(evt: unknown) => void>>();
  return {
    loadFile: vi.fn(),
    pdfViewer: app,
    on: vi.fn((name: string, cb: (evt: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
    }),
    off: vi.fn((name: string, cb: (evt: unknown) => void) => {
      listeners.get(name)?.delete(cb);
    }),
    dispatch(name: string, evt: unknown) {
      for (const cb of listeners.get(name) ?? []) cb(evt);
    },
    count: (name: string) => listeners.get(name)?.size ?? 0,
  };
}

/** Anything pdf.js's `location.pageNumber` could hold, valid or not. */
const pageNumberArb = () =>
  fc.oneof(
    fc.integer({ min: 1, max: 100000 }),
    fc.integer({ max: 0 }),
    fc.double(),
    fc.constant(Number.MAX_SAFE_INTEGER + 1),
    fc.string(),
    fc.constantFrom(null, undefined)
  );

/** Anything pdf.js's `location.top` could hold, valid or not. */
const topArb = () =>
  fc.oneof(
    fc.integer({ min: -1000, max: 100000 }),
    fc.double(),
    fc.string(),
    fc.constantFrom(null, undefined, Number.NaN, Infinity, -Infinity)
  );

/** The position a pdf.js location names, as the adapter should read it. */
function expectedPosition(
  initialViewSet: unknown,
  pageNumber: unknown,
  top: unknown
) {
  const valid =
    initialViewSet === true &&
    Number.isSafeInteger(pageNumber) &&
    (pageNumber as number) >= 1 &&
    Number.isFinite(top);
  return valid ? { page: pageNumber, top } : null;
}

/** pdf.js's `updateviewarea` event, with the view's top at `top` on a page. */
const at = (pageNumber: unknown, top: unknown) => ({
  source: {},
  location: { pageNumber, top, left: 0, scale: 125 },
});

/**
 * A pdf.js viewer whose pages are `height` points tall, shown at `scale`
 * CSS pixels per point inside a border `border` pixels wide, mapping points
 * as an unrotated pdf.js page view does.
 */
function bordered(border: unknown, scale: number, height = 792) {
  const getPageView = vi.fn((_index: number) => ({
    div: { clientTop: border },
    getPagePoint: (x: number, y: number) => [x / scale, height - y / scale],
  }));
  return { getPageView };
}

/** Let promise callbacks queued so far run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Obsidian's PDF tab as far as the adapter reaches into it: its view type,
 * and its viewer component (`PdfView.viewer`).
 */
function makePdfTab(
  viewer: unknown = new FakeViewerComponent(null, createDiv(), {})
) {
  return { getViewType: () => 'pdf', viewer } as unknown as View & {
    viewer: FakeViewerComponent;
  };
}

/**
 * A PDF tab's viewer child that can highlight text, with page `rendered`'s
 * text layer done rendering (none when 0).
 */
function makeHighlightingChild(rendered = 0) {
  return {
    ...makeChild(),
    subpathHighlight: null as unknown,
    highlightText: vi.fn(),
    getPage: vi.fn((page: number): unknown => ({
      textLayer: { renderingDone: page === rendered },
    })),
  };
}

const pageSelectionArb: fc.Arbitrary<PageSelection> = fc.record({
  page: fc.integer({ min: 1, max: 900_718 }),
  range: fc.tuple(
    fc.tuple(fc.nat(99_999), fc.nat(99_999)),
    fc.tuple(fc.nat(99_999), fc.nat(99_999))
  ),
});

const SELECTION: PageSelection = {
  page: 2,
  range: [
    [1, 0],
    [3, 4],
  ],
};

// #endregion

beforeEach(() => {
  FakeViewerComponent.instances = [];
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('isPdfView', () => {
  it("is true exactly for a view of Obsidian's PDF type", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant('pdf'), fc.string()), (viewType) => {
        const view = { getViewType: () => viewType } as View;
        expect(isPdfView(view)).toBe(viewType === 'pdf');
      })
    );
  });

  it('is false for no view at all', () => {
    expect(isPdfView(null)).toBe(false);
    expect(isPdfView(undefined)).toBe(false);
  });
});

describe('createPdfViewer — feature detection', () => {
  /**
   * Every way the internals can be missing or changed shape. Only the ones
   * that throw are worth a warning; a missing piece is simply a no.
   */
  const brokenApps: [string, () => App, boolean?][] = [
    ['no embed registry', () => ({}) as App],
    ['no extension map', () => ({ embedRegistry: {} }) as unknown as App],
    [
      'no pdf embed',
      () => ({ embedRegistry: { embedByExtension: {} } }) as unknown as App,
    ],
    ['a pdf embed that is not a function', () => makeApp({})],
    [
      'a pdf embed that throws',
      () =>
        makeApp(() => {
          throw new Error('changed');
        }),
      true,
    ],
    ['an embed with no viewer', () => makeApp(() => ({}))],
    ['an embed that is not an object', () => makeApp(() => null)],
    [
      'a viewer whose constructor throws',
      () =>
        makeApp(
          pdfEmbedFactory(
            new (class {
              constructor(app?: unknown) {
                if (app) throw new Error('changed');
              }
            })()
          )
        ),
      true,
    ],
    [
      'a viewer with no constructor',
      () => makeApp(pdfEmbedFactory(Object.create(null))),
    ],
    [
      'a viewer whose constructor is not a function',
      () => makeApp(pdfEmbedFactory({ constructor: 'changed' })),
    ],
    // `{}`'s constructor is `Object`, which builds a bare object
    ['a viewer of no particular class', () => makeApp(pdfEmbedFactory({}))],
    ...(['load', 'unload', 'then', 'loadFile', 'scope'] as const).map(
      (member): [string, () => App] => [
        `a viewer without ${member}`,
        () => makeApp(pdfEmbedFactory(viewerWithout(member))),
      ]
    ),
  ];

  it.each(brokenApps)('is null for %s', (_, app, throws = false) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(createPdfViewer(app())).toBeNull();

    if (throws) {
      expect(warn).toHaveBeenCalledOnce();
      const [message, error] = warn.mock.calls[0] as unknown[];
      expect(message).toMatch(/^Incremental Reading: \S/);
      expect(error).toEqual(new Error('changed'));
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("builds Obsidian's own viewer component into a fresh, detached container", () => {
    const factory = pdfEmbedFactory();
    const app = makeApp(factory);

    const viewer = createPdfViewer(app);

    // The probe embed gets a container of its own, never the viewer's
    expect(factory).toHaveBeenCalledOnce();
    const [ctx, probeFile, subpath] = factory.mock.calls[0] as unknown as [
      { app: App; containerEl: HTMLElement },
      unknown,
      string,
    ];
    expect(ctx.app).toBe(app);
    expect(probeFile).toBeNull();
    expect(subpath).toBe('');
    const component = FakeViewerComponent.instances.at(-1)!;
    expect(component.app).toBe(app);
    expect(component.containerEl).toBe(viewer!.containerEl);
    expect(ctx.containerEl).not.toBe(viewer!.containerEl);
    expect(viewer!.containerEl.isConnected).toBe(false);
    expect(viewer!.containerEl.classList.contains('ir-pdf-viewer')).toBe(true);
    expect(viewer!.scope).toBe(component.scope);
  });

  it.each([true, false])(
    'builds it with pdf.js history off, full height, and page borders as a PDF tab has them (mobile: %s)',
    (isMobile) => {
      const previous = Platform.isMobile;
      Platform.isMobile = isMobile;
      try {
        createPdfViewer(makeApp());
      } finally {
        Platform.isMobile = previous;
      }

      // `isEmbed` keeps pdf.js from restoring and writing the last position in
      // the global `pdfjs.history`; no `height` keeps the viewer full height.
      expect(FakeViewerComponent.instances.at(-1)!.opts).toStrictEqual({
        isEmbed: true,
        removePageBorders: isMobile,
      });
    }
  );
});

describe('PdfViewer lifecycle', () => {
  it('loads and unloads the component', () => {
    const viewer = createPdfViewer(makeApp())!;
    const component = FakeViewerComponent.instances.at(-1)!;

    viewer.load();
    expect(component.load).toHaveBeenCalledOnce();
    viewer.unload();
    expect(component.unload).toHaveBeenCalledOnce();
  });

  it('settles every open as unsupported once the component fails to load, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viewer = createPdfViewer(makeApp())!;
    const component = FakeViewerComponent.instances.at(-1)!;
    const failure = new Error('pdf.js changed');
    let fail: (error: unknown) => void = () => {};
    component.load.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      })
    );
    setShown(viewer.containerEl, true);

    viewer.load();
    const pending = viewer.open(file);
    fail(failure);

    await expect(pending).resolves.toBe('unsupported');
    await expect(viewer.open(file)).resolves.toBe('unsupported');
    expect(warn).toHaveBeenCalledOnce();
    const [message, detail] = warn.mock.calls[0] as unknown[];
    expect(message).toMatch(/^Incremental Reading: \S/);
    expect(detail).toBe(failure);
  });

  it('opens as before once the component has loaded', async () => {
    const { viewer, component } = makeViewer();
    component.load.mockResolvedValue(undefined);
    setShown(viewer.containerEl, true);
    const child = makeChild();
    component.ready(child);
    await flush();

    await expect(viewer.open(file)).resolves.toBe('loaded');
  });

  it('opens a file at once once the viewer is ready, when its container is shown', async () => {
    const { viewer, component } = makeViewer();
    setShown(viewer.containerEl, true);
    const child = makeChild();

    const opened = viewer.open(file, '#page=2');
    expect(child.loadFile).not.toHaveBeenCalled();
    component.ready(child);

    await expect(opened).resolves.toBe('loaded');
    expect(child.loadFile.mock.calls).toEqual([[file, '#page=2']]);
    expect(FakeResizeObserver.instances).toEqual([]);
  });

  it('opens only the latest file asked for before the viewer was ready', async () => {
    const { viewer, component } = makeViewer();
    setShown(viewer.containerEl, true);
    const child = makeChild();
    const other = { path: 'papers/b.pdf', extension: 'pdf' } as TFile;

    const first = viewer.open(file);
    const second = viewer.open(other);
    component.ready(child);

    await expect(first).resolves.toBe('cancelled');
    await expect(second).resolves.toBe('loaded');
    expect(child.loadFile.mock.calls).toEqual([[other, undefined]]);
  });

  it('opens without a subpath when none is given', async () => {
    const { viewer, component } = makeViewer();
    setShown(viewer.containerEl, true);
    const child = makeChild();
    component.ready(child);

    await viewer.open(file);

    expect(child.loadFile.mock.calls).toEqual([[file, undefined]]);
  });

  it('waits for a hidden container to be shown, then opens the latest file asked for', async () => {
    const { viewer, component } = makeViewer();
    setShown(viewer.containerEl, false);
    const child = makeChild();
    component.ready(child);
    const other = { path: 'papers/b.pdf', extension: 'pdf' } as TFile;

    const first = viewer.open(file);
    const second = viewer.open(other, '#page=3');
    await flush();
    expect(child.loadFile).not.toHaveBeenCalled();
    // One observer for the container, however many opens wait on it
    expect(FakeResizeObserver.instances).toHaveLength(1);
    const [observer] = FakeResizeObserver.instances;
    expect(observer.observed).toEqual([viewer.containerEl]);

    // A resize that leaves it hidden changes nothing
    observer.fire();
    await flush();
    expect(child.loadFile).not.toHaveBeenCalled();

    setShown(viewer.containerEl, true);
    observer.fire();

    await expect(first).resolves.toBe('cancelled');
    await expect(second).resolves.toBe('loaded');
    expect(child.loadFile.mock.calls).toEqual([[other, '#page=3']]);
    expect(observer.disconnected).toBe(true);
  });

  it('opens at once where the window has no ResizeObserver to wait with', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { viewer, component } = makeViewer();
    setShown(viewer.containerEl, false);
    const child = makeChild();
    component.ready(child);

    await expect(viewer.open(file)).resolves.toBe('loaded');
    expect(child.loadFile).toHaveBeenCalledOnce();
  });

  it('settles a wait cut short by unloading, and stops watching', async () => {
    const { viewer, component } = makeViewer();
    setShown(viewer.containerEl, false);
    const child = makeChild();
    component.ready(child);

    const opened = viewer.open(file);
    await flush();
    viewer.unload();

    await expect(opened).resolves.toBe('cancelled');
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
    setShown(viewer.containerEl, true);
    FakeResizeObserver.instances[0].fire();
    await flush();
    expect(child.loadFile).not.toHaveBeenCalled();
  });

  it('settles an open still waiting on the component when unloaded', async () => {
    const { viewer } = makeViewer();

    const opened = viewer.open(file);
    viewer.unload();

    await expect(opened).resolves.toBe('cancelled');
  });

  it('ignores opens after unloading', async () => {
    const { viewer, component } = makeViewer();
    setShown(viewer.containerEl, true);
    const child = makeChild();
    viewer.unload();
    component.ready(child);

    await expect(viewer.open(file)).resolves.toBe('cancelled');
    expect(child.loadFile).not.toHaveBeenCalled();
  });

  it.each<[string, () => unknown, 'child' | 'error']>([
    ['no loadFile', () => ({ findBar: {} }), 'child'],
    ['no child at all', () => null, 'child'],
    [
      'a loadFile that throws',
      () =>
        makeChild({
          loadFile: vi.fn(() => {
            throw new Error('changed');
          }),
        }),
      'error',
    ],
    [
      'a loadFile that rejects',
      () =>
        makeChild({
          loadFile: vi.fn().mockRejectedValue(new Error('changed')),
        }),
      'error',
    ],
  ])(
    'reports the viewer unsupported for a child with %s',
    async (_, makeChildFor, cause) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { viewer, component } = makeViewer();
      setShown(viewer.containerEl, true);

      const child = makeChildFor();
      const opened = viewer.open(file);
      component.ready(child);

      await expect(opened).resolves.toBe('unsupported');
      expect(warn).toHaveBeenCalledOnce();
      const [message, detail] = warn.mock.calls[0] as unknown[];
      expect(message).toMatch(/^Incremental Reading: \S/);
      // What changed, or what went wrong
      expect(detail).toEqual(cause === 'child' ? child : new Error('changed'));
    }
  );
});

describe('PdfViewer.showSearch', () => {
  it("opens the viewer's find bar once it is ready", () => {
    const { viewer, component } = makeViewer();
    const child = makeChild();

    viewer.showSearch();
    expect(child.findBar.showSearch).not.toHaveBeenCalled();
    component.ready(child);

    expect(child.findBar.showSearch).toHaveBeenCalledOnce();
  });

  it.each([
    ['no find bar', {}],
    ['a find bar that cannot be shown', { findBar: {} }],
  ])('does nothing for a child with %s', (_, extra) => {
    const { viewer, component } = makeViewer();
    component.ready({ loadFile: vi.fn(), ...extra });

    expect(() => viewer.showSearch()).not.toThrow();
  });

  it('does nothing for no child at all', () => {
    const { viewer, component } = makeViewer();

    viewer.showSearch();

    expect(() => component.ready(null)).not.toThrow();
  });
});

describe('PdfViewer.selectedText', () => {
  it('is the text selected inside the viewer', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat(),
        fc.nat(),
        (text, a, b) => {
          document.body.innerHTML = '';
          const { viewer, insideEl } = withText(text, 'elsewhere');
          const [from, to] = [
            a % (text.length + 1),
            b % (text.length + 1),
          ].sort((x, y) => x - y);
          select(insideEl.firstChild!, from, insideEl.firstChild!, to);

          expect(viewer.selectedText()).toBe(text.slice(from, to));
        }
      )
    );
  });

  it('is empty for a selection that reaches outside the viewer', () => {
    const { viewer, insideEl, outsideEl } = withText('inside', 'outside');

    select(insideEl.firstChild!, 0, outsideEl.firstChild!, 3);
    expect(viewer.selectedText()).toBe('');

    select(outsideEl.firstChild!, 0, outsideEl.firstChild!, 3);
    expect(viewer.selectedText()).toBe('');
  });

  it('is empty with nothing selected', () => {
    const { viewer } = withText('inside', 'outside');

    document.getSelection()!.removeAllRanges();
    expect(viewer.selectedText()).toBe('');
  });
});

describe('PdfViewer.selection', () => {
  /**
   * A viewer in a tab of its own, as review shows it: two pages whose text
   * layers hold `first` and `second`, an action bar button beside the viewer
   * in the same tab, and text outside the tab.
   */
  function inTab(first = 'inside', second = 'second') {
    const { viewer } = makeViewer();
    const tab = document.body.appendChild(document.createElement('div'));
    tab.className = 'workspace-leaf';
    tab.append(viewer.containerEl);
    const pages = [first, second].map((text, i) => {
      const page = viewer.containerEl.appendChild(
        document.createElement('div')
      );
      page.className = 'page';
      page.dataset.pageNumber = String(i + 1);
      const layer = page.appendChild(document.createElement('div'));
      layer.className = 'textLayer';
      const span = layer.appendChild(document.createElement('span'));
      span.textContent = text;
      return { page, layer, text: span.firstChild! };
    });
    const button = tab.appendChild(document.createElement('button'));
    const outsideEl = document.body.appendChild(document.createElement('p'));
    outsideEl.textContent = 'outside';
    return { viewer, tab, pages, button, outside: outsideEl.firstChild! };
  }

  /** Select as the user does: the browser then reports the change. */
  function userSelects(
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
    doc: Document = document
  ) {
    const range = doc.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const selection = doc.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
  }

  /** A press starting at `target`, as a tap or a click begins. */
  function press(target: EventTarget) {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  }

  const boundsOf = (range: Range | null) =>
    range && [
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    ];

  /** Text and two distinct offsets into it, in order. */
  const textWithSpanArb = fc
    .string({ minLength: 1 })
    .chain((text) =>
      fc
        .uniqueArray(fc.nat(text.length), { minLength: 2, maxLength: 2 })
        .map(([a, b]) => ({ text, from: Math.min(a, b), to: Math.max(a, b) }))
    );

  it('is what was last selected in the text layers', () => {
    fc.assert(
      fc.property(
        textWithSpanArb,
        fc.boolean(),
        ({ text, from, to }, across) => {
          document.body.innerHTML = '';
          const { viewer, pages } = inTab(text, text);
          const end = across ? pages[1].text : pages[0].text;

          userSelects(pages[0].text, from, end, to);

          expect(boundsOf(viewer.selection())).toEqual([
            pages[0].text,
            from,
            end,
            to,
          ]);
          viewer.unload();
        }
      )
    );
  });

  it('keeps the selection when it moves out of the viewer, as pressing a button in the tab does', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('button', 'outside', 'none'),
        fc.boolean(),
        (where, collapsed) => {
          document.body.innerHTML = '';
          const { viewer, pages, button, outside } = inTab();
          userSelects(pages[0].text, 1, pages[0].text, 4);
          press(button);

          if (where === 'none') {
            document.getSelection()!.removeAllRanges();
            document.dispatchEvent(new Event('selectionchange'));
          } else {
            const node = where === 'button' ? button : outside;
            userSelects(node, 0, node, collapsed ? 0 : node.childNodes.length);
          }

          expect(boundsOf(viewer.selection())).toEqual([
            pages[0].text,
            1,
            pages[0].text,
            4,
          ]);
          viewer.unload();
        }
      )
    );
  });

  it('is dropped by a press in another tab or on the bare tab around the viewer, and kept through any other', () => {
    /** Where a press drops the selection: the user has moved on from it. */
    const DROPS = [
      'another tab',
      'button in another tab',
      'tab header',
      'bar background',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...DROPS,
          'own tab button',
          'icon in a button',
          'clickable icon',
          'input',
          'title being edited',
          'link',
          'viewer',
          'modal',
          'outside'
        ),
        (where) => {
          document.body.innerHTML = '';
          const { viewer, tab, pages, button, outside } = inTab();
          const add = (parent: Element, html: string) => {
            const el = parent.appendChild(document.createElement('div'));
            el.innerHTML = html;
            return el.firstElementChild!;
          };
          const header = add(
            tab,
            '<div class="view-header"><div class="view-header-title" contenteditable="true">Title</div><div class="clickable-icon"><svg></svg></div><a href="#">link</a></div>'
          );
          const bar = add(tab, '<div class="ir-action-bar"><input></div>');
          const icon = button.appendChild(document.createElement('span'));
          // The file explorer, say, which is a tab of the sidebar
          const otherTab = document.body.appendChild(
            document.createElement('div')
          );
          otherTab.className = 'workspace-leaf';
          const fileRow = otherTab.appendChild(document.createElement('div'));
          // One that keeps the press to itself, as many of Obsidian's do
          const otherButton = otherTab.appendChild(
            document.createElement('button')
          );
          otherButton.addEventListener('pointerdown', (evt) =>
            evt.stopPropagation()
          );
          // The command palette, which picks the command that extracts
          const modal = document.body.appendChild(
            document.createElement('div')
          );
          modal.className = 'modal-container';
          userSelects(pages[0].text, 1, pages[0].text, 4);

          press(
            {
              'another tab': fileRow,
              'button in another tab': otherButton,
              'tab header': header,
              'bar background': bar,
              'own tab button': button,
              'icon in a button': icon,
              'clickable icon': header.querySelector('.clickable-icon svg')!,
              input: bar.querySelector('input')!,
              'title being edited': header.querySelector('[contenteditable]')!,
              link: header.querySelector('a')!,
              viewer: pages[1].layer,
              modal,
              outside: outside.parentNode!,
            }[where]!
          );

          expect(viewer.selection() === null).toBe(DROPS.includes(where));
          viewer.unload();
        }
      )
    );
  });

  it('is kept through a press in any tab when the viewer is in none', () => {
    const { viewer, tab, pages } = inTab();
    tab.classList.remove('workspace-leaf');
    const otherTab = document.body.appendChild(document.createElement('div'));
    otherTab.className = 'workspace-leaf';
    userSelects(pages[0].text, 1, pages[0].text, 4);

    press(otherTab);

    expect(viewer.selection()).not.toBeNull();
  });

  it('is null once the selection collapses inside the viewer', () => {
    const { viewer, pages } = inTab();
    userSelects(pages[0].text, 1, pages[0].text, 4);

    userSelects(pages[0].text, 2, pages[0].text, 2);

    expect(viewer.selection()).toBeNull();
  });

  it('is null with nothing selected yet', () => {
    const { viewer } = inTab();
    expect(viewer.selection()).toBeNull();
  });

  it('keeps a selection with an end outside the text layers, for reading it to snap', () => {
    const { viewer, pages } = inTab();
    // A drag that ends between two pages, or a keyboard selection, which
    // Obsidian doesn't snap into the text
    const gap = pages[1].page;

    userSelects(pages[0].text, 1, gap, 0);
    expect(boundsOf(viewer.selection())).toEqual([pages[0].text, 1, gap, 0]);

    // Nor does unloading another page's text drop it
    pages[1].layer.remove();
    expect(boundsOf(viewer.selection())).toEqual([pages[0].text, 1, gap, 0]);
  });

  it('is null once the text at either end of it is gone, as when pdf.js unloads a page', () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 1), (gone) => {
        document.body.innerHTML = '';
        const { viewer, pages } = inTab();
        userSelects(pages[0].text, 1, pages[1].text, 4);

        pages[gone].layer.remove();

        expect(viewer.selection()).toBeNull();
        viewer.unload();
      })
    );
  });

  it('is null once a text layer it ends on, not in its text, is gone', () => {
    const { viewer, pages } = inTab();
    // An end between two items: in the layer itself, as an element offset
    userSelects(pages[0].text, 1, pages[1].layer, 1);

    pages[1].layer.remove();

    expect(viewer.selection()).toBeNull();
  });

  it('hands out a copy, which leaves what it tracks alone', () => {
    const { viewer, pages } = inTab();
    userSelects(pages[0].text, 1, pages[0].text, 4);

    viewer.selection()!.collapse(true);

    expect(viewer.selection()!.collapsed).toBe(false);
  });

  it('stops following the selection once unloaded, and forgets it', () => {
    const { viewer, pages, outside } = inTab();
    userSelects(pages[0].text, 0, pages[0].text, 2);
    viewer.unload();
    expect(viewer.selection()).toBeNull();

    userSelects(pages[0].text, 1, pages[0].text, 4);
    expect(viewer.selection()).toBeNull();

    // Nor does a press reach it
    userSelects(pages[0].text, 1, pages[0].text, 4);
    press(outside);
    expect(viewer.selection()).toBeNull();
  });

  it('follows the selection into the window its tab is moved to', () => {
    const migrated: ((win: Window) => void)[] = [];
    const stopMigrated = vi.fn();
    const { viewer } = makeViewerWith((containerEl) => {
      (
        containerEl as unknown as {
          onWindowMigrated(cb: (win: Window) => void): () => void;
        }
      ).onWindowMigrated = (cb) => {
        migrated.push(cb);
        return stopMigrated;
      };
    });
    // A window of its own, as a popout is
    const frame = document.body.appendChild(document.createElement('iframe'));
    const popoutWin = frame.contentWindow!;
    const popout = popoutWin.document;
    const layer = popout.body.appendChild(popout.createElement('div'));
    layer.className = 'textLayer';
    const span = layer.appendChild(popout.createElement('span'));
    span.textContent = 'moved';
    const mainText = document.body.appendChild(document.createElement('p'));
    mainText.textContent = 'main';

    // Obsidian moves the tab's DOM, then tells it which window it's in now
    popout.body.prepend(viewer.containerEl);
    viewer.containerEl.append(layer);
    expect(migrated).toHaveLength(1);
    migrated[0](popoutWin);

    userSelects(span.firstChild!, 0, span.firstChild!, 4, popout);
    expect(viewer.selection()?.toString()).toBe('move');

    // The old window's selection no longer reaches it
    userSelects(mainText.firstChild!, 0, mainText.firstChild!, 2);
    document.dispatchEvent(new Event('selectionchange'));
    expect(viewer.selection()?.toString()).toBe('move');

    viewer.unload();
    expect(stopMigrated).toHaveBeenCalledOnce();
    userSelects(span.firstChild!, 1, span.firstChild!, 2, popout);
    expect(viewer.selection()).toBeNull();
  });

  it('is cleared, on screen too, by clearSelection', () => {
    const { viewer, pages } = inTab();
    userSelects(pages[0].text, 1, pages[0].text, 4);

    viewer.clearSelection();

    expect(viewer.selection()).toBeNull();
    expect(document.getSelection()!.rangeCount).toBe(0);
  });

  it('leaves a selection outside the viewer on screen when cleared', () => {
    const { viewer, pages, button } = inTab();
    userSelects(pages[0].text, 1, pages[0].text, 4);
    const label = button.appendChild(document.createTextNode('button'));
    userSelects(label, 0, label, 3);

    viewer.clearSelection();

    expect(viewer.selection()).toBeNull();
    expect(document.getSelection()!.toString()).toBe('but');
  });

  it('clears with nothing selected on screen', () => {
    const { viewer } = inTab();
    document.getSelection()!.removeAllRanges();

    expect(() => viewer.clearSelection()).not.toThrow();
    expect(viewer.selection()).toBeNull();
  });
});

describe('PdfViewer.visiblePages', () => {
  /** pdf.js's own `PDFViewer` as far as telling the visible pages goes. */
  const withPdfJs = (pdfJs: unknown) => {
    const { viewer, component } = makeViewer();
    component.ready({ ...makeChild(), pdfViewer: { pdfViewer: pdfJs } });
    return viewer;
  };

  it('is the pages pdf.js has on screen, in order, once it is ready', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1e6 }), { maxLength: 5 }),
        fc.integer({ min: 1, max: 1e6 }),
        (ids, current) => {
          const getVisiblePages = vi.fn(function (this: unknown) {
            expect(this).toBe(pdfJs);
            return { ids: new Set(ids) };
          });
          const pdfJs = {
            currentPageNumber: current,
            _getVisiblePages: getVisiblePages,
          };

          expect(withPdfJs(pdfJs).visiblePages()).toEqual(
            [...ids].sort((a, b) => a - b)
          );
        }
      )
    );
  });

  it('is the current page where pdf.js tells no visible pages', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.constantFrom<unknown>(
          undefined,
          'changed',
          () => null,
          () => ({}),
          () => ({ ids: [1, 2] })
        ),
        (current, getVisiblePages) => {
          const pdfJs = {
            currentPageNumber: current,
            _getVisiblePages: getVisiblePages,
          };

          expect(withPdfJs(pdfJs).visiblePages()).toEqual([current]);
        }
      )
    );
  });

  it('is none before the viewer is ready', () => {
    const { viewer } = makeViewer();
    expect(viewer.visiblePages()).toEqual([]);
  });

  it.each([
    ['no app object', {}],
    ['no pdf.js viewer', { pdfViewer: {} }],
    ['a pdf.js viewer that is not one', { pdfViewer: { pdfViewer: 3 } }],
    ['no page number', { pdfViewer: { pdfViewer: {} } }],
    [
      'a page number that is not a number',
      { pdfViewer: { pdfViewer: { currentPageNumber: '2' } } },
    ],
    ['no page yet', { pdfViewer: { pdfViewer: { currentPageNumber: 0 } } }],
  ])('is none for a child with %s', (_, child) => {
    const { viewer, component } = makeViewer();

    component.ready({ ...makeChild(), ...child });

    expect(viewer.visiblePages()).toEqual([]);
  });

  it('leaves out ids that are no page numbers', () => {
    const pdfJs = {
      currentPageNumber: 1,
      _getVisiblePages: () => ({ ids: new Set([0, 2, '3', 1.5, 4]) }),
    };

    expect(withPdfJs(pdfJs).visiblePages()).toEqual([2, 4]);
  });
});

describe('PdfViewer.pdfDocument', () => {
  const pdfDocument = { numPages: 3, getPage: vi.fn() };

  it("is the pdf.js document the viewer has open, once it's ready", () => {
    const { viewer, component } = makeViewer();
    expect(viewer.pdfDocument()).toBeNull();

    component.ready({ ...makeChild(), pdfViewer: { pdfDocument } });

    expect(viewer.pdfDocument()).toBe(pdfDocument);
  });

  it.each([
    ['no app object', {}],
    ['an app object that is not one', { pdfViewer: 'changed' }],
    ['no document open', { pdfViewer: { pdfDocument: null } }],
    [
      'a document without a page count',
      { pdfViewer: { pdfDocument: { getPage: vi.fn() } } },
    ],
    [
      'a document without getPage',
      { pdfViewer: { pdfDocument: { numPages: 3, getPage: 'changed' } } },
    ],
  ])('is null for a child with %s', (_, child) => {
    const { viewer, component } = makeViewer();

    component.ready({ ...makeChild(), ...child });

    expect(viewer.pdfDocument()).toBeNull();
  });
});

describe('PdfViewer page keys', () => {
  /** Zoom modes that fit a whole page, and so leave nothing to scroll. */
  const PAGE_FIT = ['page-width', 'page-height'];
  const scaleArb = fc.oneof(
    fc.constantFrom(...PAGE_FIT, 'page-fit', 'auto', 'page-actual', '1.25'),
    fc.string()
  );
  const keyArb = fc.constantFrom('ArrowLeft', 'ArrowRight');

  it('turns the page in a page-fit zoom, as a PDF tab does, and leaves the key alone otherwise', () => {
    fc.assert(
      fc.property(scaleArb, keyArb, (scale, key) => {
        const { viewer, component } = makeViewer();
        const pdfJs = makePdfJsViewer(scale);
        component.child = { pdfViewer: { pdfViewer: pdfJs } };

        const { answer, evt } = pressKey(viewer, key, document.body);

        const turns = PAGE_FIT.includes(scale);
        const turned =
          key === 'ArrowLeft' ? pdfJs.previousPage : pdfJs.nextPage;
        const other = key === 'ArrowLeft' ? pdfJs.nextPage : pdfJs.previousPage;
        expect(turned).toHaveBeenCalledTimes(turns ? 1 : 0);
        expect(other).not.toHaveBeenCalled();
        expect(evt.defaultPrevented).toBe(turns);
        expect(answer).toBe(turns ? false : undefined);
      })
    );
  });

  it('leaves the key to an element that edits text', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const targets = [
      document.createElement('input'),
      document.createElement('textarea'),
      editable.appendChild(document.createElement('span')),
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...PAGE_FIT),
        keyArb,
        fc.constantFrom(...targets),
        (scale, key, target) => {
          const { viewer, component } = makeViewer();
          const pdfJs = makePdfJsViewer(scale);
          component.child = { pdfViewer: { pdfViewer: pdfJs } };

          const { answer, evt } = pressKey(viewer, key, target);

          expect(pdfJs.previousPage).not.toHaveBeenCalled();
          expect(pdfJs.nextPage).not.toHaveBeenCalled();
          expect(evt.defaultPrevented).toBe(false);
          expect(answer).toBeUndefined();
        }
      )
    );
  });

  it.each([
    ['no child yet', null],
    ['a child without pdf.js', {}],
    ['a pdf.js app without its viewer', { pdfViewer: {} }],
    [
      'a viewer that cannot turn pages',
      { pdfViewer: { pdfViewer: { currentScaleValue: 'page-width' } } },
    ],
  ])('does nothing with %s', (_, child) => {
    const { viewer, component } = makeViewer();
    component.child = child;

    const { answer, evt } = pressKey(viewer, 'ArrowRight', document.body);

    expect(answer).toBeUndefined();
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('getPdfLocation', () => {
  it("reads the page and top of pdf.js's location once the file's initial view is set", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.boolean(), fc.constantFrom(undefined, 1)),
        pageNumberArb(),
        topArb(),
        (initialViewSet, pageNumber, top) => {
          const { viewer, component } = makeViewer();
          component.ready(
            makeEventChild({
              isInitialViewSet: initialViewSet,
              location: { pageNumber, top, left: 0, scale: 'page-width' },
            })
          );

          expect(getPdfLocation(viewer)).toEqual(
            expectedPosition(initialViewSet, pageNumber, top)
          );
        }
      )
    );
  });

  it.each([
    ['no child yet', null],
    ['a child without pdf.js', {}],
    [
      'a pdf.js app with no location yet',
      { pdfViewer: { isInitialViewSet: true } },
    ],
    [
      'a location that is not an object',
      { pdfViewer: { isInitialViewSet: true, location: 'page=3' } },
    ],
  ])('is null with %s', (_, child) => {
    const { viewer, component } = makeViewer();
    component.child = child;

    expect(getPdfLocation(viewer)).toBeNull();
  });

  it('is null for a viewer it did not build', () => {
    const { viewer, component } = makeViewer();
    component.ready(
      makeEventChild({
        isInitialViewSet: true,
        location: { pageNumber: 3, top: 700 },
      })
    );

    expect(getPdfLocation({ ...viewer })).toBeNull();
  });
});

describe('onPdfViewChange', () => {
  it("reports each view change's position once the file's initial view is set", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            initialViewSet: fc.boolean(),
            pageNumber: pageNumberArb(),
            top: topArb(),
          })
        ),
        (changes) => {
          const { viewer, component } = makeViewer();
          const app: Record<string, unknown> = {};
          const child = makeEventChild(app);
          const listener = vi.fn();
          onPdfViewChange(viewer, listener);
          component.ready(child);

          for (const { initialViewSet, pageNumber, top } of changes) {
            app.isInitialViewSet = initialViewSet;
            child.dispatch('updateviewarea', at(pageNumber, top));
          }

          const expected = changes
            .map((c) => expectedPosition(c.initialViewSet, c.pageNumber, c.top))
            .filter((p) => p !== null)
            .map((p) => [p]);
          expect(listener.mock.calls).toEqual(expected);
        }
      )
    );
  });

  it('listens on a child that is already built', () => {
    const { viewer, component } = makeViewer();
    const child = makeEventChild({ isInitialViewSet: true });
    component.ready(child);
    const listener = vi.fn();

    onPdfViewChange(viewer, listener);
    child.dispatch('updateviewarea', at(3, 700));
    child.dispatch('updateviewarea', at(1, 0));

    expect(listener.mock.calls).toEqual([
      [{ page: 3, top: 700 }],
      [{ page: 1, top: 0 }],
    ]);
  });

  it('ignores an event with no location in it', () => {
    const { viewer, component } = makeViewer();
    const child = makeEventChild({ isInitialViewSet: true });
    component.ready(child);
    const listener = vi.fn();
    onPdfViewChange(viewer, listener);

    child.dispatch('updateviewarea', undefined);
    child.dispatch('updateviewarea', { location: null });

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops listening once stopped', () => {
    const { viewer, component } = makeViewer();
    const child = makeEventChild({ isInitialViewSet: true });
    component.ready(child);
    const listener = vi.fn();

    const stop = onPdfViewChange(viewer, listener);
    stop();
    child.dispatch('updateviewarea', at(3, 700));

    expect(listener).not.toHaveBeenCalled();
    expect(child.count('updateviewarea')).toBe(0);
    expect(child.off).toHaveBeenCalledExactlyOnceWith(
      'updateviewarea',
      child.on.mock.calls[0][1]
    );
  });

  it('never starts listening when stopped before the child is built', () => {
    const { viewer, component } = makeViewer();
    const child = makeEventChild({ isInitialViewSet: true });

    onPdfViewChange(viewer, vi.fn())();
    component.ready(child);

    expect(child.on).not.toHaveBeenCalled();
    expect(child.off).not.toHaveBeenCalled();
  });

  it('stops quietly when the viewer was torn down first', () => {
    const { viewer, component } = makeViewer();
    const child = makeEventChild({ isInitialViewSet: true });
    // Obsidian's `off` reaches `this.pdfViewer.eventBus`, gone after unload
    child.off.mockImplementation(() => {
      throw new TypeError('Cannot read properties of null');
    });
    component.ready(child);
    const stop = onPdfViewChange(viewer, vi.fn());

    expect(stop).not.toThrow();
  });

  it.each([
    ['a child without events', { loadFile: vi.fn() }],
    ['a child that is not an object', 'child'],
  ])('does nothing with %s', (_, child) => {
    const { viewer, component } = makeViewer();
    const listener = vi.fn();
    const stop = onPdfViewChange(viewer, listener);

    component.ready(child);

    expect(stop).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ['on', { on: vi.fn() }],
    ['off', { off: vi.fn() }],
  ])('leaves alone a child that has only %s', (_, events) => {
    const { viewer, component } = makeViewer();
    const child = { loadFile: vi.fn(), ...events };
    const stop = onPdfViewChange(viewer, vi.fn());

    component.ready(child);
    stop();

    for (const method of Object.values(events)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('does nothing for a viewer it did not build', () => {
    const { viewer, component } = makeViewer();
    const child = makeEventChild({ isInitialViewSet: true });
    component.ready(child);

    const stop = onPdfViewChange({ ...viewer }, vi.fn());

    expect(child.on).not.toHaveBeenCalled();
    expect(stop).not.toThrow();
  });
});

describe('PDF position on a page with borders', () => {
  it('aims a border lower than pdf.js reports, so opening there shows the same view', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: -1000, max: 100000 }),
        fc.integer({ min: 0, max: 40 }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        (pageNumber, top, border, scale) => {
          const { viewer, component } = makeViewer();
          const pdfViewer = bordered(border, scale);
          component.ready(
            makeEventChild({
              isInitialViewSet: true,
              location: { pageNumber, top },
              pdfViewer,
            })
          );

          const position = getPdfLocation(viewer);

          expect(position?.page).toBe(pageNumber);
          expect(position?.top).toBeCloseTo(top - border / scale, 9);
          expect(pdfViewer.getPageView.mock.calls).toEqual([[pageNumber - 1]]);
        }
      )
    );
  });

  it('aims the same way for each view change it reports', () => {
    const { viewer, component } = makeViewer();
    const child = makeEventChild({
      isInitialViewSet: true,
      pdfViewer: bordered(9, 2),
    });
    component.ready(child);
    const listener = vi.fn();
    onPdfViewChange(viewer, listener);

    child.dispatch('updateviewarea', {
      location: { pageNumber: 1, top: 600 },
    });

    expect(listener.mock.calls).toEqual([[{ page: 1, top: 595.5 }]]);
  });

  it.each([
    ['no pdf.js viewer', undefined],
    ['a pdf.js viewer without page views', {}],
    ['no view for the page', { getPageView: () => undefined }],
    [
      'a view that cannot map points',
      { getPageView: () => ({ div: { clientTop: 9 } }) },
    ],
    [
      'a view with no page element',
      { getPageView: () => ({ getPagePoint: () => [0, 0] }) },
    ],
    ['a border that is not a number', bordered('9px', 2)],
    [
      'points that are not pairs',
      {
        getPageView: () => ({
          div: { clientTop: 9 },
          getPagePoint: () => null,
        }),
      },
    ],
    [
      'a point that is only half a pair',
      {
        getPageView: () => ({
          div: { clientTop: 9 },
          getPagePoint: (_: number, y: number) => (y === 0 ? [0, 792] : [0]),
        }),
      },
    ],
  ])('reports the top as is with %s', (_, pdfViewer) => {
    const { viewer, component } = makeViewer();
    component.ready(
      makeEventChild({
        isInitialViewSet: true,
        location: { pageNumber: 3, top: 700 },
        pdfViewer,
      })
    );

    expect(getPdfLocation(viewer)).toEqual({ page: 3, top: 700 });
  });
});

describe('pdfTabDocument', () => {
  const pdfDocument = { numPages: 3, getPage: vi.fn() };

  it('is the document a PDF tab has open, once its viewer is ready', async () => {
    const tab = makePdfTab();
    const resolved = vi.fn();
    void pdfTabDocument(tab).then(resolved);
    await flush();
    expect(resolved).not.toHaveBeenCalled();

    tab.viewer.ready(makeEventChild({ pdfDocument }));
    await flush();

    expect(resolved).toHaveBeenCalledExactlyOnceWith(pdfDocument);
    await expect(pdfTabDocument(tab)).resolves.toBe(pdfDocument);
  });

  it('waits for the document to open, then stops listening', async () => {
    const tab = makePdfTab();
    const app: Record<string, unknown> = { pdfDocument: null };
    const child = makeEventChild(app);
    tab.viewer.ready(child);
    const resolved = vi.fn();
    void pdfTabDocument(tab).then(resolved);
    await flush();
    expect(resolved).not.toHaveBeenCalled();

    app.pdfDocument = pdfDocument;
    child.dispatch('pagesinit', {});
    await flush();

    expect(resolved).toHaveBeenCalledExactlyOnceWith(pdfDocument);
    expect(child.count('pagesinit')).toBe(0);
  });

  it('is null once the tab closes before its document opens, and stops listening', async () => {
    const tab = makePdfTab();
    const onUnload: (() => void)[] = [];
    Object.assign(tab, { register: (cb: () => void) => onUnload.push(cb) });
    const child = makeEventChild({ pdfDocument: null });
    tab.viewer.ready(child);
    const resolved = vi.fn();
    void pdfTabDocument(tab).then(resolved);
    await flush();
    expect(child.count('pagesinit')).toBe(1);

    for (const cb of onUnload) cb();
    await flush();

    expect(resolved).toHaveBeenCalledExactlyOnceWith(null);
    expect(child.count('pagesinit')).toBe(0);
  });

  it('is null once the tab closes before its viewer is ready', async () => {
    const tab = makePdfTab();
    const onUnload: (() => void)[] = [];
    Object.assign(tab, { register: (cb: () => void) => onUnload.push(cb) });
    const resolved = vi.fn();
    void pdfTabDocument(tab).then(resolved);

    for (const cb of onUnload) cb();
    await flush();

    expect(resolved).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('closes cleanly when its viewer is already torn down', async () => {
    const tab = makePdfTab();
    const onUnload: (() => void)[] = [];
    Object.assign(tab, { register: (cb: () => void) => onUnload.push(cb) });
    const child = makeEventChild({ pdfDocument: null });
    child.off.mockImplementation(() => {
      throw new TypeError(
        "Cannot read properties of null (reading 'eventBus')"
      );
    });
    tab.viewer.ready(child);
    const resolved = vi.fn();
    void pdfTabDocument(tab).then(resolved);
    await flush();

    expect(() => {
      for (const cb of onUnload) cb();
    }).not.toThrow();
    await flush();

    expect(resolved).toHaveBeenCalledExactlyOnceWith(null);
  });

  it.each([
    [
      'a view of another type',
      {
        getViewType: (): string => 'markdown',
        viewer: new FakeViewerComponent(null, createDiv(), {}),
      },
    ],
    ['no view', null],
    ['a PDF tab without a viewer', { getViewType: (): string => 'pdf' }],
    [
      'a PDF tab whose viewer has no then',
      makePdfTab(
        Object.assign(new FakeViewerComponent(null, createDiv(), {}), {
          then: undefined,
        })
      ),
    ],
  ])('is null for %s', async (_, view) => {
    await expect(pdfTabDocument(view as unknown as View)).resolves.toBeNull();
  });

  it.each([
    ['is not an object', 'changed'],
    ['has no document and no events', { ...makeChild(), pdfViewer: {} }],
  ])('is null for a tab whose viewer child %s', async (_, child) => {
    const tab = makePdfTab();
    tab.viewer.ready(child);

    await expect(pdfTabDocument(tab)).resolves.toBeNull();
  });
});

describe('highlightPdfSelection', () => {
  it('highlights the selection once its page renders its text layer, as a link to it would', () => {
    fc.assert(
      fc.property(pageSelectionArb, (selection) => {
        const tab = makePdfTab();
        const child = makeHighlightingChild();

        highlightPdfSelection(tab, selection);
        expect(child.subpathHighlight).toBeNull();
        tab.viewer.ready(child);

        expect(child.subpathHighlight).toEqual({ type: 'text', ...selection });
        expect(child.getPage).toHaveBeenCalledWith(selection.page);
        expect(child.highlightText).not.toHaveBeenCalled();
      })
    );
  });

  it('highlights it at once too when its page has already rendered its text layer', () => {
    fc.assert(
      fc.property(pageSelectionArb, (selection) => {
        const tab = makePdfTab();
        const child = makeHighlightingChild(selection.page);
        tab.viewer.ready(child);

        highlightPdfSelection(tab, selection);

        expect(child.subpathHighlight).toEqual({ type: 'text', ...selection });
        expect(child.highlightText).toHaveBeenCalledExactlyOnceWith(
          selection.page,
          selection.range
        );
      })
    );
  });

  it.each([
    ['no page view', () => null],
    ['a page view without a text layer', () => ({})],
    [
      'a text layer still rendering',
      () => ({ textLayer: { renderingDone: false } }),
    ],
    [
      'a renderingDone that is not true',
      () => ({ textLayer: { renderingDone: 1 } }),
    ],
    [
      'getPage throwing',
      () => {
        throw new Error('no pdfViewer');
      },
    ],
  ])('leaves the highlight to the text layer with %s', (_, getPage) => {
    const tab = makePdfTab();
    const child = { ...makeHighlightingChild(), getPage: vi.fn(getPage) };
    tab.viewer.ready(child);

    highlightPdfSelection(tab, SELECTION);

    expect(child.subpathHighlight).toEqual({ type: 'text', ...SELECTION });
    expect(child.highlightText).not.toHaveBeenCalled();
  });

  it('leaves the highlight to the text layer when the child has no getPage', () => {
    const tab = makePdfTab();
    const child = { ...makeHighlightingChild(2), getPage: undefined };
    tab.viewer.ready(child);

    highlightPdfSelection(tab, SELECTION);

    expect(child.subpathHighlight).toEqual({ type: 'text', ...SELECTION });
    expect(child.highlightText).not.toHaveBeenCalled();
  });

  it('logs a highlight that fails, as on a page whose text has changed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tab = makePdfTab();
    const child = makeHighlightingChild(2);
    const error = new TypeError('no such item');
    child.highlightText.mockImplementation(() => {
      throw error;
    });
    tab.viewer.ready(child);

    expect(() => highlightPdfSelection(tab, SELECTION)).not.toThrow();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Incremental Reading: can't highlight the PDF selection",
      error
    );
  });

  it('touches nothing on a child without highlightText', () => {
    const tab = makePdfTab();
    const child = { ...makeHighlightingChild(2), highlightText: undefined };
    tab.viewer.ready(child);

    highlightPdfSelection(tab, SELECTION);

    expect(child.subpathHighlight).toBeNull();
    expect(child.getPage).not.toHaveBeenCalled();
  });

  it('touches nothing on a child without a subpath highlight', () => {
    const tab = makePdfTab();
    const { subpathHighlight, ...child } = makeHighlightingChild(2);
    void subpathHighlight;
    tab.viewer.ready(child);

    highlightPdfSelection(tab, SELECTION);

    expect('subpathHighlight' in child).toBe(false);
    expect(child.getPage).not.toHaveBeenCalled();
    expect(child.highlightText).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a view of another type',
      {
        getViewType: (): string => 'markdown',
        viewer: new FakeViewerComponent(null, createDiv(), {}),
      },
    ],
    ['no view', null],
    ['a PDF tab without a viewer', { getViewType: (): string => 'pdf' }],
  ])('does nothing for %s', (_, view) => {
    const viewer = (view as { viewer?: FakeViewerComponent } | null)?.viewer;
    const child = makeHighlightingChild(1);
    viewer?.ready(child);

    highlightPdfSelection(view as unknown as View, SELECTION);

    expect(child.subpathHighlight).toBeNull();
    expect(child.highlightText).not.toHaveBeenCalled();
  });

  it('does nothing for a tab whose viewer child is not an object', () => {
    const tab = makePdfTab();
    tab.viewer.ready('changed');

    expect(() => highlightPdfSelection(tab, SELECTION)).not.toThrow();
  });
});
