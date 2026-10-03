/**
 * The only module that touches Obsidian's PDF internals. Everything here is
 * undocumented API, read from the app bundle (Obsidian 1.13.7, pdf.js 5.3.34);
 * see `plans/reference/obsidian-pdf-internals.md` for the class chain and the
 * search anchors that re-find it after an update.
 *
 * Every entry point is feature-detected and fails soft: when the internals are
 * missing or have changed shape, callers get `null` or `'unsupported'` and fall
 * back to opening the PDF in Obsidian's own tab.
 */
import { trackRange } from '#/lib/text-selection';
import {
  type App,
  Platform,
  type Scope,
  type TFile,
  type View,
} from 'obsidian';
import type { PageSelection } from './pdf-selection';
import type { PdfDocument } from './pdf-text';
import type { PdfPosition } from './position';

// #region INTERNAL SHAPES
// What the adapter relies on, typed as loosely as it is checked. Names follow
// Obsidian's own classes, which the minified bundle does not keep.

/**
 * Undocumented: `PdfViewerChild`, built by the component once loaded. Holds
 * the pdf.js app object (`.pdfViewer`), the toolbar and the find bar.
 */
interface PdfViewerChild {
  /**
   * Opens `file` in pdf.js. When the container has no `offsetParent` it
   * defers itself with `onNodeInserted` and resolves at once, before anything
   * has loaded — see {@link PdfViewer.open}.
   */
  loadFile(file: TFile, subpath?: string): Promise<void>;
  /**
   * Undocumented: the viewer's find bar (`PdfFindBar`), which a PDF tab's
   * `showSearch` opens.
   */
  findBar?: { showSearch?(): void };
  /**
   * Undocumented: the pdf.js app object `createObsidianPDFViewer` returns,
   * whose own `pdfViewer` is pdf.js's `PDFViewer`.
   */
  pdfViewer?: { pdfViewer?: PdfJsViewer };
}

/** The pdf.js `PDFViewer`, as far as page turning uses it. */
interface PdfJsViewer {
  /** `'page-width'`, `'page-height'`, `'auto'`, …, or a scale as a string. */
  currentScaleValue?: unknown;
  previousPage?(): unknown;
  nextPage?(): unknown;
}

/**
 * Undocumented: `PdfViewerComponent`, the `Component` both Obsidian's PDF tab
 * (`PdfView.viewer`) and its PDF embeds build their viewer with.
 */
interface PdfViewerComponent {
  /** `new Scope(app.scope)`: Escape, and the find bar's keys while it is open. */
  scope: Scope;
  /**
   * `Component.load`, which here returns the promise of `onload` building and
   * loading the child (pdf.js scripts included). Rejects if that fails, and
   * the child queued for by {@link then} then never comes.
   */
  load(): unknown;
  unload(): void;
  /** The child once built, `null` before and after. */
  child?: unknown;
  /** Runs `cb` with the child once `onload` has built it; queues until then. */
  then(cb: (child: unknown) => void): void;
  loadFile(file: TFile, subpath?: string): Promise<void>;
}

/**
 * Undocumented: `app.embedRegistry.embedByExtension.pdf`, which builds a
 * `PdfEmbed` holding its viewer component as `viewer`.
 */
type PdfEmbedFactory = (
  ctx: { app: App; containerEl: HTMLElement },
  file: TFile | null,
  subpath: string
) => unknown;

/** Undocumented: `new PdfViewerComponent(app, containerEl, opts)`. */
type PdfViewerComponentCtor = new (
  app: App,
  containerEl: HTMLElement,
  opts: PdfViewerOptions
) => unknown;

/** The options `PdfViewerComponent` passes on to `createObsidianPDFViewer`. */
export interface PdfViewerOptions {
  isEmbed?: boolean;
  removePageBorders?: boolean;
  height?: number | 'page' | 'auto';
}

// #endregion

/**
 * The options the review tab's viewer is built with (decided for task 0014),
 * read on each build since `Platform` is.
 *
 * - `isEmbed: true` keeps pdf.js's ViewHistory out of it: without it the
 *   viewer restores the last position from the global, unsynced
 *   `localStorage["pdfjs.history"]` and writes every scroll back there, over
 *   whatever page review asks for. It also starts with the sidebar closed.
 * - No `height`, so the embed's fixed height is never applied and the viewer
 *   fills the review tab. The `.pdf-embed` class, which turns the sidebar into
 *   an overlay, belongs to the embed's container, not to this one.
 * - `removePageBorders` as Obsidian's PDF tab sets it.
 */
function viewerOptions(): PdfViewerOptions {
  return { isEmbed: true, removePageBorders: Platform.isMobile };
}

/**
 * Whether `view` is Obsidian's own PDF tab. Its view type, `"pdf"`, is
 * undocumented (`PdfView.getViewType` in the app bundle).
 */
export function isPdfView(view: View | null | undefined): boolean {
  return view?.getViewType() === 'pdf';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether `value` has every member the adapter calls on a viewer component.
 */
function isViewerComponent(value: unknown): value is PdfViewerComponent {
  return (
    isObject(value) &&
    isObject(value.scope) &&
    typeof value.load === 'function' &&
    typeof value.unload === 'function' &&
    typeof value.then === 'function' &&
    typeof value.loadFile === 'function'
  );
}

/**
 * What a press may be meant to act on the selection through: a button, or
 * anything else that takes input (`clickable-icon` is Obsidian's own class
 * for an icon button).
 */
const CONTROL_SELECTOR =
  'button, a, input, textarea, select, [role="button"], .clickable-icon, [contenteditable]:not([contenteditable="false"])';

function isPageNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

/**
 * The pdf.js text layer `node` is in, if any. pdf.js removes a page's layer
 * whole when it unloads the page, which moves a range end that was in it out
 * to the page.
 */
function textLayerOf(node: Node): Element | null {
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return el?.closest('.textLayer') ?? null;
}

/**
 * The pdf.js document the viewer child `child` has open, if any.
 *
 * Undocumented: `child.pdfViewer.pdfDocument`, the `PDFDocumentProxy` pdf.js's
 * `PDFViewerApplication` holds once a file is open.
 */
function documentOf(child: unknown): PdfDocument | null {
  const app = isObject(child) ? child.pdfViewer : null;
  const doc = isObject(app) ? app.pdfDocument : null;
  return isObject(doc) &&
    typeof doc.numPages === 'number' &&
    typeof doc.getPage === 'function'
    ? (doc as unknown as PdfDocument)
    : null;
}

function isViewerChild(value: unknown): value is PdfViewerChild {
  return isObject(value) && typeof value.loadFile === 'function';
}

/**
 * Find `PdfViewerComponent`'s constructor, which Obsidian exports nowhere.
 *
 * Undocumented: `app.embedRegistry.embedByExtension.pdf(ctx, file, subpath)`
 * builds a `PdfEmbed`, whose constructor builds its `viewer` with
 * `new PdfViewerComponent(...)`. Neither loads anything until `load()`, so a
 * probe embed over a detached element, never loaded, costs nothing else.
 */
function findViewerComponentCtor(app: App): PdfViewerComponentCtor | null {
  const registry = (app as unknown as { embedRegistry?: unknown })
    .embedRegistry;
  if (!isObject(registry) || !isObject(registry.embedByExtension)) return null;
  const embedPdf = registry.embedByExtension.pdf;
  if (typeof embedPdf !== 'function') return null;
  const probe = (embedPdf as PdfEmbedFactory)(
    { app, containerEl: createDiv() },
    null,
    ''
  );
  if (!isObject(probe) || !isObject(probe.viewer)) return null;
  const ctor = probe.viewer.constructor;
  return typeof ctor === 'function' ? (ctor as PdfViewerComponentCtor) : null;
}

/**
 * How a {@link PdfViewer.open} ended:
 * - `'loaded'`: the file is open in the viewer.
 * - `'cancelled'`: the viewer was unloaded first, or a later `open` took over.
 * - `'unsupported'`: the viewer's internals turned out not to be what this
 *   adapter expects. Show the "Open in PDF tab" fallback instead.
 */
export type PdfOpenResult = 'loaded' | 'cancelled' | 'unsupported';

/** Obsidian's full PDF viewer, built into a container of our own. */
export interface PdfViewer {
  /**
   * Where the viewer renders. Detached when built; the caller attaches it.
   * Its contents belong to Obsidian: render nothing else into it.
   */
  readonly containerEl: HTMLElement;
  /**
   * The viewer's keymap scope: Escape, and the find bar's keys while it is
   * open. Nothing outside a PDF tab activates it, so whoever shows the viewer
   * has to — a view by handing it to Obsidian as its own `scope`.
   */
  readonly scope: Scope;
  /** Start the viewer: loads Obsidian's bundled pdf.js if it isn't yet. */
  load(): void;
  /** Tear the viewer down, emptying its container. Pending opens settle. */
  unload(): void;
  /**
   * Open `file`, at `subpath` (Obsidian's PDF link grammar, e.g.
   * `#page=3&offset=0,700`), once the viewer is ready and its container is on
   * screen (not in a review tab in the background). Waiting here rather than
   * leaving it to Obsidian, which defers a load into a hidden container until
   * the container is shown, means only the latest file asked for in the
   * meantime is opened, and the promise settles only once it has been.
   *
   * Call it again to reload the file after it changes on disk.
   */
  open(file: TFile, subpath?: string): Promise<PdfOpenResult>;
  /** Open the viewer's own find bar, as Ctrl+F does in a PDF tab. */
  showSearch(): void;
  /**
   * The text selected inside the viewer, or `''` when the selection is empty
   * or reaches outside it.
   */
  selectedText(): string;
  /**
   * The text-layer selection to extract from: what was last selected in the
   * viewer, kept when the selection moves out of it (pressing a button, or
   * picking a command from the palette, does that on some platforms).
   * Dropped when it collapses inside the viewer, when a press lands in
   * another tab, and when a text layer it ended in is gone, as pdf.js
   * unloads pages far from view. `null` when there is none. A copy, so the
   * caller may do as it likes with it.
   */
  selection(): Range | null;
  /** Forget {@link selection}, and take it off screen if it is still there. */
  clearSelection(): void;
  /** The pdf.js document the viewer has open, or `null` before it has one. */
  pdfDocument(): PdfDocument | null;
  /** The numbers of the pages on screen, in order: none before there are any. */
  visiblePages(): number[];
}

interface PendingOpen {
  file: TFile;
  subpath: string | undefined;
  settle: (result: PdfOpenResult) => void;
}

class ObsidianPdfViewer implements PdfViewer {
  readonly containerEl: HTMLElement;
  readonly scope: Scope;
  #component: PdfViewerComponent;
  #pending: PendingOpen | null = null;
  #observer: ResizeObserver | null = null;
  #unloaded = false;
  /** Set once the component has failed to load: nothing will ever open. */
  #failed = false;
  /**
   * See {@link selection}: the range, and the text layers its ends were in
   * when it was made.
   */
  #selection: { range: Range; layers: Element[] } | null = null;
  #stopTrackingSelection: (() => void) | null = null;

  constructor(component: PdfViewerComponent, containerEl: HTMLElement) {
    this.#component = component;
    this.containerEl = containerEl;
    this.scope = component.scope;
  }

  load(): void {
    this.#trackSelection();
    const loading = this.#component.load();
    if (!(loading instanceof Promise)) return;
    loading.catch((error: unknown) => {
      console.warn('Incremental Reading: PDF viewer failed to load', error);
      this.#failed = true;
      this.#stopWatching();
      this.#settlePending('unsupported');
    });
  }

  unload(): void {
    this.#unloaded = true;
    this.#stopTrackingSelection?.();
    this.#stopTrackingSelection = null;
    this.#selection = null;
    this.#stopWatching();
    this.#settlePending('cancelled');
    this.#component.unload();
  }

  open(file: TFile, subpath?: string): Promise<PdfOpenResult> {
    if (this.#unloaded) return Promise.resolve('cancelled');
    if (this.#failed) return Promise.resolve('unsupported');
    this.#settlePending('cancelled');
    return new Promise((settle) => {
      const pending: PendingOpen = { file, subpath, settle };
      this.#pending = pending;
      // Queued until the component is ready. Of several queued by then, the
      // first opens the latest file and the rest find nothing left to open.
      this.#component.then((child) => this.#openWhenShown(child));
    });
  }

  showSearch(): void {
    // Undocumented: `child.findBar.showSearch()`, as `PdfView.showSearch` does
    this.#component.then((child) => {
      const findBar = isObject(child) ? child.findBar : null;
      if (isObject(findBar) && typeof findBar.showSearch === 'function') {
        (findBar as { showSearch(): void }).showSearch();
      }
    });
  }

  selectedText(): string {
    const selection = this.containerEl.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    return this.containerEl.contains(range.commonAncestorContainer)
      ? selection.toString()
      : '';
  }

  selection(): Range | null {
    if (!this.#selection) return null;
    const { range, layers } = this.#selection;
    if (
      range.collapsed ||
      layers.some((layer) => !this.containerEl.contains(layer))
    ) {
      return null;
    }
    return range.cloneRange();
  }

  clearSelection(): void {
    this.#selection = null;
    const selection = this.containerEl.ownerDocument.getSelection();
    if (
      selection &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(this.containerEl)
    ) {
      selection.removeAllRanges();
    }
  }

  pdfDocument(): PdfDocument | null {
    return documentOf(this.#component.child);
  }

  visiblePages(): number[] {
    const child = this.#component.child;
    const app = isObject(child) ? child.pdfViewer : null;
    const pdfJs = isObject(app) ? app.pdfViewer : null;
    if (!isObject(pdfJs)) return [];
    // Undocumented: pdf.js's `PDFViewer._getVisiblePages()`, whose `ids` is
    // a Set of the page numbers on screen
    const getVisible = pdfJs._getVisiblePages;
    const visible: unknown =
      typeof getVisible === 'function'
        ? (getVisible as () => unknown).call(pdfJs)
        : null;
    const ids = isObject(visible) ? visible.ids : null;
    if (ids instanceof Set) {
      return Array.from(ids as Set<unknown>)
        .filter(isPageNumber)
        .sort((a, b) => a - b);
    }
    // Undocumented: `PDFViewer.currentPageNumber`, 0 before there are pages
    const page = pdfJs.currentPageNumber;
    return isPageNumber(page) ? [page] : [];
  }

  /**
   * Follow the selection, for {@link selection}: the browser's own goes
   * wherever the user's next tap or click puts it. Follows the tab into
   * another window when it is moved there.
   */
  #trackSelection(): void {
    let stop = this.#trackSelectionIn(this.containerEl.ownerDocument);
    // Obsidian's own DOM extension, which a test document lacks
    const stopMigrated =
      typeof (this.containerEl.onWindowMigrated as unknown) === 'function'
        ? this.containerEl.onWindowMigrated((win) => {
            stop();
            this.#selection = null;
            stop = this.#trackSelectionIn(win.document);
          })
        : null;
    this.#stopTrackingSelection = () => {
      stop();
      stopMigrated?.();
    };
  }

  /** {@link #trackSelection} in `doc`; returns what stops it. */
  #trackSelectionIn(doc: Document): () => void {
    const onChange = () => {
      const previous = this.#selection?.range ?? null;
      const range = trackRange(previous, this.containerEl, doc.getSelection());
      if (range === previous) return;
      this.#selection = range && {
        range,
        layers: [range.startContainer, range.endContainer]
          .map(textLayerOf)
          .filter((layer) => layer !== null),
      };
    };
    // `workspace-leaf` is Obsidian's own class for a tab. A press in another
    // one is the user moving on, as is one on the bare tab around the viewer
    // (its header, the action bar's background), which unselects the text on
    // screen. One on a control, or outside any tab (the command palette, a
    // menu), may be what extracts the selection.
    const onPress = (evt: Event) => {
      const tab = this.containerEl.closest('.workspace-leaf');
      const target = evt.target as Partial<Element> | null;
      const pressed = target?.closest?.('.workspace-leaf');
      if (!tab || !pressed) return;
      if (
        pressed !== tab ||
        (!this.containerEl.contains(target as Node) &&
          !target?.closest?.(CONTROL_SELECTOR))
      ) {
        this.#selection = null;
      }
    };
    doc.addEventListener('selectionchange', onChange);
    doc.addEventListener('pointerdown', onPress, true);
    return () => {
      doc.removeEventListener('selectionchange', onChange);
      doc.removeEventListener('pointerdown', onPress, true);
    };
  }

  #settlePending(result: PdfOpenResult): void {
    this.#pending?.settle(result);
    this.#pending = null;
  }

  /**
   * Hand the pending file to the child once the container is on screen. The
   * check and the call happen together: `PdfViewerChild.loadFile` reads
   * `offsetParent` synchronously on entry.
   */
  #openWhenShown(child: unknown): void {
    if (this.#isShown()) {
      this.#stopWatching();
      void this.#loadInto(child);
      return;
    }
    if (this.#observer) return;
    const Observer = window.ResizeObserver;
    if (typeof Observer !== 'function') {
      // Nothing to wait with: try anyway, which loads once it is inserted.
      void this.#loadInto(child);
      return;
    }
    // Showing a hidden tab takes its container from no size to some size.
    this.#observer = new Observer(() => this.#openWhenShown(child));
    this.#observer.observe(this.containerEl);
  }

  #isShown(): boolean {
    return this.containerEl.offsetParent !== null;
  }

  #stopWatching(): void {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  async #loadInto(child: unknown): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    if (!isViewerChild(child)) {
      console.warn('Incremental Reading: PDF viewer internals changed', child);
      pending.settle('unsupported');
      return;
    }
    try {
      await child.loadFile(pending.file, pending.subpath);
      pending.settle('loaded');
    } catch (error) {
      console.warn('Incremental Reading: PDF viewer failed to open', error);
      pending.settle('unsupported');
    }
  }
}

/**
 * Whether keys pressed at `target` edit text: a form field, or anything inside
 * an element made editable.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    ) !== null
  );
}

/**
 * Give the viewer the page keys a PDF tab has: ArrowLeft and ArrowRight turn
 * the page while the zoom fits a whole page, where there is nothing to scroll.
 *
 * Undocumented: `PdfView`'s constructor registers these on `viewer.scope`
 * itself (anchor `"ArrowLeft",o((function(e){return e.previousPage()`), so a
 * component built outside a PDF tab lacks them. Like those, a bound key ends
 * Obsidian's lookup even when it isn't used.
 */
function registerPageKeys(component: PdfViewerComponent): void {
  const turn =
    (direction: 'previousPage' | 'nextPage') =>
    (evt: KeyboardEvent): false | undefined => {
      if (isEditableTarget(evt.target)) return undefined;
      const child = component.child;
      const app = isObject(child) ? child.pdfViewer : null;
      const pdfJs = isObject(app) ? app.pdfViewer : null;
      if (!isObject(pdfJs)) return undefined;
      const scale = pdfJs.currentScaleValue;
      if (scale !== 'page-width' && scale !== 'page-height') return undefined;
      const step = pdfJs[direction];
      if (typeof step !== 'function') return undefined;
      evt.preventDefault();
      (step as () => unknown).call(pdfJs);
      return false;
    };
  component.scope.register([], 'ArrowLeft', turn('previousPage'));
  component.scope.register([], 'ArrowRight', turn('nextPage'));
}

/**
 * Build Obsidian's own full PDF viewer — toolbar, zoom, find, sidebar — into a
 * fresh, detached container, or `null` when Obsidian's internals
 * aren't what this adapter knows.
 *
 * Undocumented: there is no public way to make one. This takes the
 * `PdfViewerComponent` constructor off a probe PDF embed (see
 * {@link findViewerComponentCtor}) and builds a viewer with
 * {@link viewerOptions}. Nothing loads until {@link PdfViewer.load}.
 */
export function createPdfViewer(app: App): PdfViewer | null {
  try {
    const Ctor = findViewerComponentCtor(app);
    if (!Ctor) return null;
    // Detached, unlike `document.createDiv()`, which appends to the document.
    // Attaching it moves it into whichever window's document it lands in.
    const containerEl = createDiv('ir-pdf-viewer');
    const component = new Ctor(app, containerEl, viewerOptions());
    if (!isViewerComponent(component)) return null;
    registerPageKeys(component);
    const viewer = new ObsidianPdfViewer(component, containerEl);
    viewerComponents.set(viewer, component);
    return viewer;
  } catch (error) {
    console.warn('Incremental Reading: no PDF viewer available', error);
    return null;
  }
}

// #region READING POSITION
// Where the reader is in a viewer's file, for saving and restoring it (task
// 0015). Kept apart from the class so other features extend it independently.

/** The component behind each viewer {@link createPdfViewer} built. */
const viewerComponents = new WeakMap<PdfViewer, PdfViewerComponent>();

/**
 * Undocumented: `PdfViewerChild.on`/`off`, which add and remove a listener on
 * the pdf.js eventBus (`this.pdfViewer.eventBus._on`/`_off`).
 */
interface PdfViewerChildEvents {
  on(name: string, cb: (evt: unknown) => void): void;
  off(name: string, cb: (evt: unknown) => void): void;
}

function hasEvents(child: unknown): child is PdfViewerChildEvents {
  return (
    isObject(child) &&
    typeof child.on === 'function' &&
    typeof child.off === 'function'
  );
}

/**
 * How far, in PDF y, opening at a page's `offset` lands from where pdf.js
 * reports the view to be: add it to a reported `top` to get the `top` that
 * opens on the same view. `0` when the page view can't be measured.
 *
 * pdf.js measures the location from below a page's border
 * (`div.offsetTop + div.clientTop` in `PDFViewer.update`), but scrolls a
 * destination into view from above it (`div.offsetTop` alone in
 * `scrollIntoView`). Opened at the `top` it reported, a page with borders —
 * Obsidian's desktop viewer, not its mobile one — shows a border's width
 * higher, and saving that would creep the position up a little on every
 * visit. The width is converted to PDF units at the page's current scale,
 * through pdf.js's own `PDFPageView.getPagePoint`, rotation and all.
 *
 * Undocumented: `PDFViewer.getPageView(index)` is pdf.js API, reached through
 * Obsidian's `child.pdfViewer.pdfViewer`.
 */
function borderOffset(app: Record<string, unknown>, page: number): number {
  const pdfJs = app.pdfViewer;
  if (!isObject(pdfJs) || typeof pdfJs.getPageView !== 'function') return 0;
  const view: unknown = (pdfJs.getPageView as (index: number) => unknown)(
    page - 1
  );
  if (!isObject(view) || typeof view.getPagePoint !== 'function') return 0;
  const border = isObject(view.div) ? view.div.clientTop : null;
  if (typeof border !== 'number') return 0;
  const pointAt = (y: number): unknown =>
    (view.getPagePoint as (x: number, y: number) => unknown)(0, y);
  const [atEdge, belowBorder] = [pointAt(0), pointAt(border)];
  if (!Array.isArray(atEdge) || !Array.isArray(belowBorder)) return 0;
  const offset = Number(belowBorder[1]) - Number(atEdge[1]);
  return Number.isFinite(offset) ? offset : 0;
}

/**
 * The position `location` names, or `null` while the pdf.js app object `app`
 * hasn't yet put its file's initial view on screen. Its `top` is the one to
 * open at to show the same view again (see {@link borderOffset}).
 *
 * Undocumented: pdf.js's `PDFViewerApplication.isInitialViewSet`, cleared when
 * a file closes and set once a newly opened one is at the page it was opened
 * to. Until then the location says page 1, wherever the file is opening.
 * `location` is pdf.js's `PDFViewer._location`: `pageNumber`, and `top`, the
 * PDF y at the view's top edge in unscaled points from the page's bottom.
 */
function positionAt(app: unknown, location: unknown): PdfPosition | null {
  if (!isObject(app) || app.isInitialViewSet !== true) return null;
  if (!isObject(location)) return null;
  const { pageNumber, top } = location;
  if (typeof pageNumber !== 'number' || typeof top !== 'number') return null;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return null;
  if (!Number.isFinite(top)) return null;
  return { page: pageNumber, top: top + borderOffset(app, pageNumber) };
}

/** The pdf.js app object of `component`'s child, if it has been built. */
function pdfJsApp(component: PdfViewerComponent): unknown {
  const child = component.child;
  return isObject(child) ? child.pdfViewer : null;
}

/**
 * Where the top edge of `viewer`'s view is in the file it has open, or `null`
 * when it has none on screen yet.
 *
 * Undocumented: reads `child.pdfViewer.location`, which pdf.js's own
 * `updateviewarea` handler keeps current.
 */
export function getPdfLocation(viewer: PdfViewer): PdfPosition | null {
  const component = viewerComponents.get(viewer);
  if (!component) return null;
  const app = pdfJsApp(component);
  return positionAt(app, isObject(app) ? app.location : null);
}

/**
 * Call `listener` with the new position each time `viewer`'s view moves —
 * scrolled, zoomed, resized — once its file is on screen. Returns the function
 * that stops it. pdf.js reports every frame of a scroll: debounce anything
 * costly.
 *
 * Undocumented: pdf.js's `updateviewarea` event, `{source, location}`, on the
 * child's eventBus. It fires only while some page is in view, so never while
 * the viewer is hidden.
 */
export function onPdfViewChange(
  viewer: PdfViewer,
  listener: (position: PdfPosition) => void
): () => void {
  const component = viewerComponents.get(viewer);
  if (!component) return () => {};
  let stopped = false;
  let listening: PdfViewerChildEvents | null = null;
  const onUpdate = (evt: unknown) => {
    const location = isObject(evt) ? evt.location : null;
    const position = positionAt(pdfJsApp(component), location);
    if (position) listener(position);
  };
  component.then((child) => {
    if (stopped || !hasEvents(child)) return;
    child.on('updateviewarea', onUpdate);
    listening = child;
  });
  return () => {
    stopped = true;
    try {
      listening?.off('updateviewarea', onUpdate);
    } catch {
      // Unloaded first: its eventBus, and the listener with it, is gone.
    }
    listening = null;
  };
}

// #endregion

// #region PDF TABS
// Obsidian's own PDF tab, as Go to context opens a snippet's PDF in (task
// 0019).

/**
 * The viewer component of Obsidian's PDF tab `view`, if it is one this adapter
 * knows.
 *
 * Undocumented: `PdfView.viewer`, the `PdfViewerComponent` its constructor
 * builds.
 */
function tabComponent(
  view: View | null | undefined
): PdfViewerComponent | null {
  if (!isPdfView(view)) return null;
  const component = (view as unknown as { viewer?: unknown }).viewer;
  return isViewerComponent(component) ? component : null;
}

/**
 * The pdf.js document Obsidian's PDF tab `view` has open, once it has opened
 * one; `null` when `view` isn't a PDF tab this adapter knows, or closes first.
 *
 * Undocumented: pdf.js's `pagesinit` event, which `PDFViewer.setDocument`
 * fires on the child's eventBus once the document it was handed is in place.
 */
export function pdfTabDocument(
  view: View | null | undefined
): Promise<PdfDocument | null> {
  const component = tabComponent(view);
  if (!view || !component) return Promise.resolve(null);
  return new Promise((resolve) => {
    let listening: { child: PdfViewerChildEvents; cb: () => void } | null =
      null;
    const stopListening = () => {
      try {
        listening?.child.off('pagesinit', listening.cb);
      } catch {
        // Unloaded first: its eventBus, and the listener with it, is gone.
      }
      listening = null;
    };
    // Runs when the tab closes. A settled promise ignores it.
    if (typeof view.register === 'function') {
      view.register(() => {
        stopListening();
        resolve(null);
      });
    }
    component.then((child) => {
      const doc = documentOf(child);
      if (doc || !hasEvents(child)) {
        resolve(doc);
        return;
      }
      const onInit = () => {
        stopListening();
        resolve(documentOf(child));
      };
      child.on('pagesinit', onInit);
      listening = { child, cb: onInit };
    });
  });
}

/**
 * Undocumented: what of `PdfViewerChild` highlighting a selection uses.
 */
interface HighlightingChild {
  /**
   * What `applySubpath` makes of a link's `selection=`, or `null`. The
   * child's `textlayerrendered` listener highlights it whenever its page's
   * text layer renders, scrolling to it.
   */
  subpathHighlight: unknown;
  /**
   * Highlight `range` on page `page`, scrolling to it. Needs the page's text
   * layer rendered, and throws when `range` names items it doesn't have.
   */
  highlightText(page: number, range: PageSelection['range']): void;
  /** pdf.js's `PDFPageView` for page `page`: `getPageView(page - 1)`. */
  getPage?(page: number): unknown;
}

function isHighlightingChild(value: unknown): value is HighlightingChild {
  return (
    isObject(value) &&
    'subpathHighlight' in value &&
    typeof value.highlightText === 'function'
  );
}

/**
 * Whether page `page` of `child` has its text layer rendered.
 *
 * Undocumented: `TextLayerBuilder.renderingDone`, which Obsidian's own
 * annotation highlighting checks too.
 */
function textLayerRendered(child: HighlightingChild, page: number): boolean {
  if (typeof child.getPage !== 'function') return false;
  try {
    const pageView = child.getPage(page);
    const textLayer = isObject(pageView) ? pageView.textLayer : null;
    return isObject(textLayer) && textLayer.renderingDone === true;
  } catch {
    // Its pdf.js viewer is gone: the tab is closing
    return false;
  }
}

/**
 * Highlight `selection` in Obsidian's PDF tab `view`, as opening a link to it
 * would: whenever its page's text layer renders, and at once if it already
 * has. Opening the tab at a link does the same, but only for a selection the
 * link names when the tab opens.
 *
 * Undocumented: sets `PdfViewerChild.subpathHighlight` the way its
 * `applySubpath` does for `selection=`, without the jump to the page top that
 * `applySubpath` also makes; Obsidian highlights from it only on
 * `textlayerrendered`, so a page already rendered is highlighted with the
 * child's `highlightText` directly.
 */
export function highlightPdfSelection(
  view: View | null | undefined,
  selection: PageSelection
): void {
  const component = tabComponent(view);
  if (!component) return;
  component.then((child) => {
    if (!isHighlightingChild(child)) return;
    const { page, range } = selection;
    child.subpathHighlight = { type: 'text', page, range };
    if (!textLayerRendered(child, page)) return;
    try {
      child.highlightText(page, range);
    } catch (error) {
      console.warn(
        "Incremental Reading: can't highlight the PDF selection",
        error
      );
    }
  });
}

// #endregion
