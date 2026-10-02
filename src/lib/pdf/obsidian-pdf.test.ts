// @vitest-environment jsdom
import fc from 'fast-check';
import { type App, Platform, Scope, type TFile, type View } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPdfViewer, isPdfView, type PdfViewer } from './obsidian-pdf';

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

/** Let promise callbacks queued so far run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
