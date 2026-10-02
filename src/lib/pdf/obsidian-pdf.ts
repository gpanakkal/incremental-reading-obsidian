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
import {
  type App,
  Platform,
  type Scope,
  type TFile,
  type View,
} from 'obsidian';

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

  constructor(component: PdfViewerComponent, containerEl: HTMLElement) {
    this.#component = component;
    this.containerEl = containerEl;
    this.scope = component.scope;
  }

  load(): void {
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
    return new ObsidianPdfViewer(component, containerEl);
  } catch (error) {
    console.warn('Incremental Reading: no PDF viewer available', error);
    return null;
  }
}
