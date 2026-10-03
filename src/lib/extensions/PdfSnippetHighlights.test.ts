// @vitest-environment jsdom
import { encodeAnchor } from '#/lib/pdf/pdf-anchor';
import {
  type SnippetHighlight,
  SnippetOffsetTracker,
} from '#/lib/SnippetOffsetTracker';
import type { DataChangeEvent } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import { FileView, type TFile, type WorkspaceLeaf } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerPdfLeafHighlights,
  showPdfSnippetHighlights,
} from './PdfSnippetHighlights';
import * as SnippetHighlightExtension from './SnippetHighlightExtension';

// #region HELPERS

const PDF = { path: 'papers/Paper.pdf', extension: 'pdf' } as TFile;

/** A viewer's page 1, its text layer holding "Hello world". */
function makeViewer() {
  const containerEl = document.body.appendChild(document.createElement('div'));
  const pageEl = containerEl.appendChild(document.createElement('div'));
  pageEl.className = 'page';
  pageEl.dataset.pageNumber = '1';
  const textLayer = pageEl.appendChild(document.createElement('div'));
  textLayer.className = 'textLayer';
  const item = textLayer.appendChild(document.createElement('span'));
  item.className = 'textLayerNode';
  item.dataset.idx = '0';
  item.textContent = 'Hello world';
  return { containerEl, item };
}

/** The references and text the viewer's highlights mark. */
const marked = (el: Element) =>
  Array.from(el.querySelectorAll('.ir-snippet-highlight'), (span) => [
    span.getAttribute('data-snippet-ref'),
    span.textContent,
  ]);

/** A snippet of page 1's item 0, characters `from` to `to`. */
function makeHighlight(
  reference: string,
  from: number,
  to: number
): SnippetHighlight {
  return {
    id: `id-${reference}`,
    reference,
    type: 'snippet',
    due: null,
    interval: 1,
    priority: 20,
    dismissed: false,
    parent: 'pdf-article',
    start_offset: encodeAnchor({ page: 1, idx: 0, char: from }),
    end_offset: encodeAnchor({ page: 1, idx: 0, char: to }),
  } as unknown as SnippetHighlight;
}

/**
 * A plugin whose database holds `rows` per parent path, read into a real
 * offset tracker as `ReviewManager.getSnippetHighlights` does.
 */
function makePlugin(leaves: { view: unknown }[] = []) {
  const rows = new Map<string, SnippetHighlight[]>();
  const tracker = new SnippetOffsetTracker();
  const dataListeners = new Set<(event: DataChangeEvent) => void>();
  const workspaceHandlers = new Map<
    string,
    Set<(...args: unknown[]) => void>
  >();
  const cleanups: (() => void)[] = [];

  const getSnippetHighlights = vi.fn(async (file: TFile) => {
    // Answers after a turn, as the database does
    await Promise.resolve();
    const found = rows.get(file.path) ?? [];
    tracker.loadHighlights(file.path, found);
    return found;
  });
  const workspace = {
    on: vi.fn((name: string, cb: (...args: unknown[]) => void) => {
      const set = workspaceHandlers.get(name) ?? new Set();
      set.add(cb);
      workspaceHandlers.set(name, set);
      return { name, cb };
    }),
    offref: vi.fn((ref: { name: string; cb: () => void }) => {
      workspaceHandlers.get(ref.name)?.delete(ref.cb);
    }),
    trigger: (name: string, ...args: unknown[]) =>
      workspaceHandlers.get(name)?.forEach((cb) => cb(...args)),
    iterateAllLeaves: (cb: (leaf: WorkspaceLeaf) => void) =>
      leaves.forEach((leaf) => cb(leaf as WorkspaceLeaf)),
  };
  const plugin = {
    app: { workspace },
    reviewManager: {
      getSnippetHighlights,
      snippets: { offsetTracker: tracker },
      repo: {
        onDataChange: (listener: (event: DataChangeEvent) => void) => {
          dataListeners.add(listener);
          return () => dataListeners.delete(listener);
        },
      },
    },
    registerEvent: vi.fn(),
    register: (cb: () => void) => cleanups.push(cb),
  };
  return {
    plugin: plugin as unknown as IncrementalReadingPlugin,
    rows,
    tracker,
    workspace,
    getSnippetHighlights,
    dataChange: (table: DataChangeEvent['table']) =>
      dataListeners.forEach((cb) => cb({ table, op: 'update', ids: [] })),
    dataListenerCount: () => dataListeners.size,
    workspaceHandlerCount: () =>
      [...workspaceHandlers.values()].reduce((n, set) => n + set.size, 0),
    unload: () => cleanups.forEach((cb) => cb()),
  };
}

/** Lets loads, and the observer's repaints, settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// #endregion

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('showPdfSnippetHighlights', () => {
  it("marks the PDF's snippets once they are read from the database", async () => {
    const { plugin, rows } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    const { containerEl } = makeViewer();

    const stop = showPdfSnippetHighlights(plugin, PDF, containerEl);
    expect(marked(containerEl)).toEqual([]);
    await flush();

    expect(marked(containerEl)).toEqual([['Snippets/a.md', 'Hello']]);
    stop();
  });

  it('reads them again when a snippet row changes, and only then', async () => {
    const { plugin, rows, getSnippetHighlights, dataChange } = makePlugin();
    const { containerEl } = makeViewer();
    const stop = showPdfSnippetHighlights(plugin, PDF, containerEl);
    await flush();

    rows.set(PDF.path, [makeHighlight('Snippets/b.md', 6, 11)]);
    dataChange('article');
    dataChange('card');
    await flush();
    expect(marked(containerEl)).toEqual([]);
    expect(getSnippetHighlights).toHaveBeenCalledTimes(1);

    dataChange('snippet');
    await flush();
    expect(marked(containerEl)).toEqual([['Snippets/b.md', 'world']]);
    stop();
  });

  it('reads them once more, not once each, for changes made while it reads', async () => {
    const { plugin, rows, getSnippetHighlights, dataChange } = makePlugin();
    const { containerEl } = makeViewer();
    const stop = showPdfSnippetHighlights(plugin, PDF, containerEl);
    rows.set(PDF.path, [makeHighlight('Snippets/b.md', 6, 11)]);
    dataChange('snippet');
    dataChange('snippet');
    dataChange('snippet');
    await flush();
    await flush();

    expect(getSnippetHighlights).toHaveBeenCalledTimes(2);
    expect(marked(containerEl)).toEqual([['Snippets/b.md', 'world']]);
    stop();
  });

  it('shows what the tracker holds when told its highlights changed, at its path as it is now', async () => {
    const { plugin, rows, tracker, workspace } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    const file = { ...PDF } as TFile;
    const { containerEl } = makeViewer();
    const stop = showPdfSnippetHighlights(plugin, file, containerEl);
    await flush();

    // Undoing a snippet takes it out of the tracker, then says so
    tracker.loadHighlights(file.path, []);
    workspace.trigger('ir-highlights-changed', 'papers/Other.pdf');
    await flush();
    expect(marked(containerEl)).toEqual([['Snippets/a.md', 'Hello']]);
    workspace.trigger('ir-highlights-changed', file.path);
    await flush();
    expect(marked(containerEl)).toEqual([]);

    // Renamed: the tracker follows the file, and so does this
    (file as { path: string }).path = 'papers/Renamed.pdf';
    tracker.loadHighlights(file.path, [makeHighlight('Snippets/c.md', 0, 1)]);
    workspace.trigger('ir-highlights-changed', file.path);
    await flush();
    expect(marked(containerEl)).toEqual([['Snippets/c.md', 'H']]);
    stop();
  });

  it('when stopped, takes its marks off and listens no more, even for a read under way', async () => {
    const {
      plugin,
      rows,
      tracker,
      workspace,
      dataChange,
      dataListenerCount,
      workspaceHandlerCount,
    } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    const { containerEl, item } = makeViewer();
    const stop = showPdfSnippetHighlights(plugin, PDF, containerEl);
    await flush();
    dataChange('snippet');

    stop();
    await flush();
    expect(marked(containerEl)).toEqual([]);
    expect(dataListenerCount()).toBe(0);
    expect(workspaceHandlerCount()).toBe(0);
    tracker.loadHighlights(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    workspace.trigger('ir-highlights-changed', PDF.path);
    item.textContent = 'Hello world';
    await flush();
    expect(marked(containerEl)).toEqual([]);
  });

  it('keeps what it shows when reading fails, and says so', async () => {
    const { plugin, rows, getSnippetHighlights, dataChange } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { containerEl } = makeViewer();
    const stop = showPdfSnippetHighlights(plugin, PDF, containerEl);
    await flush();

    const error = new Error('locked');
    getSnippetHighlights.mockRejectedValueOnce(error);
    dataChange('snippet');
    await flush();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/PDF highlights/),
      error
    );
    expect(marked(containerEl)).toEqual([['Snippets/a.md', 'Hello']]);
    stop();
  });
});

describe('a press on a highlight shown by showPdfSnippetHighlights', () => {
  /**
   * The PDF's viewer, in whichever window, with "Hello" highlighted, and the
   * snippet opener spied on.
   */
  async function setUp() {
    const { plugin, rows } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    const { containerEl, item } = makeViewer();
    const stop = showPdfSnippetHighlights(plugin, PDF, containerEl);
    await flush();
    const open = vi
      .spyOn(SnippetHighlightExtension, 'openSnippetFromEvent')
      .mockReturnValue(true);
    const reached = vi.fn();
    document.addEventListener('click', reached);
    document.addEventListener('auxclick', reached);
    const span = containerEl.querySelector('.ir-snippet-highlight')!;
    const select = (node: Node, from: number, to: number) => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    return {
      plugin,
      item,
      span,
      open,
      reached,
      select,
      stop,
      done: () => {
        document.removeEventListener('click', reached);
        document.removeEventListener('auxclick', reached);
        document.getSelection()!.removeAllRanges();
      },
    };
  }

  const press = (el: Element, type: string, button = 0) => {
    const evt = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button,
    });
    el.dispatchEvent(evt);
    return evt;
  };

  it('opens its snippet from a viewer in another window, whose presses never reach the main document', async () => {
    const { plugin, rows } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    // A popout: a document of its own, with its own window and selection
    const frame = document.body.appendChild(document.createElement('iframe'));
    const popout = frame.contentDocument!;
    // Obsidian gives every window its DOM helpers; the test setup only the main one
    Object.assign(frame.contentWindow!, { createSpan: window.createSpan });
    const { containerEl } = makeViewer();
    popout.body.append(popout.adoptNode(containerEl));
    const stop = showPdfSnippetHighlights(plugin, PDF, containerEl);
    await flush();
    const open = vi
      .spyOn(SnippetHighlightExtension, 'openSnippetFromEvent')
      .mockReturnValue(true);
    const reached = vi.fn();
    document.addEventListener('click', reached);

    const span = containerEl.querySelector('.ir-snippet-highlight')!;
    const click = new MouseEvent('click', { bubbles: true });
    span.dispatchEvent(click);

    expect(open.mock.calls).toEqual([[plugin, click]]);
    expect(reached).not.toHaveBeenCalled();
    document.removeEventListener('click', reached);
    stop();
  });

  it('opens its snippet on a click or a middle click, as markdown highlights do', async () => {
    const { plugin, span, open, done, stop } = await setUp();
    const click = press(span, 'click');
    const middle = press(span, 'auxclick', 1);
    press(span, 'auxclick', 2);

    expect(open.mock.calls).toEqual([
      [plugin, click],
      [plugin, middle],
    ]);
    done();
    stop();
  });

  it('opens nothing for a click that ends a drag selecting text, and keeps it from every other handler, so the text can be extracted', async () => {
    const { span, open, reached, select, done, stop } = await setUp();
    select(span.firstChild!, 1, 4);
    press(span, 'click');
    press(span, 'auxclick', 1);

    expect(open).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
    done();
    stop();
  });

  it('opens its snippet with an empty selection in it', async () => {
    const { span, open, select, done, stop } = await setUp();
    select(span.firstChild!, 2, 2);
    press(span, 'click');

    expect(open).toHaveBeenCalledOnce();
    done();
    stop();
  });

  it('leaves a press elsewhere in the viewer alone, selection or not', async () => {
    const { item, span, open, reached, select, done, stop } = await setUp();
    select(span.firstChild!, 1, 4);
    const evt = press(item, 'mousedown', 1);
    press(item, 'click');

    expect(open).not.toHaveBeenCalled();
    expect(reached).toHaveBeenCalledOnce();
    expect(evt.defaultPrevented).toBe(false);
    done();
    stop();
  });

  it('keeps a middle press from scrolling or pasting, and nothing else', async () => {
    const { span, done, stop } = await setUp();

    expect(press(span, 'mousedown', 1).defaultPrevented).toBe(true);
    expect(press(span, 'mousedown', 0).defaultPrevented).toBe(false);
    done();
    stop();
  });

  it('once stopped, leaves every press alone', async () => {
    const { item, open, reached, select, done, stop } = await setUp();
    stop();
    // Someone else's span of the same class, say a markdown embed's
    const span = item.appendChild(document.createElement('span'));
    span.className = 'ir-snippet-highlight';
    span.textContent = 'more';
    select(span.firstChild!, 0, 2);

    press(span, 'click');
    press(span, 'auxclick', 1);
    expect(press(span, 'mousedown', 1).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(reached).toHaveBeenCalledTimes(2);
    done();
  });
});

describe('registerPdfLeafHighlights', () => {
  /** A leaf showing Obsidian's own PDF view, a `FileView` of type `pdf`. */
  function makePdfLeaf(file: TFile | null, viewType = 'pdf') {
    const { containerEl } = makeViewer();
    const view = Object.assign(
      new (FileView as unknown as new () => FileView)(),
      { file, contentEl: containerEl, getViewType: () => viewType }
    );
    return { view, containerEl };
  }

  it('marks the snippets of the PDF each PDF tab shows, and of no other view', async () => {
    const pdfLeaf = makePdfLeaf(PDF);
    const otherFile = { path: 'papers/Other.pdf', extension: 'pdf' } as TFile;
    const otherViewLeaf = makePdfLeaf(otherFile, 'markdown');
    const { plugin, rows } = makePlugin([pdfLeaf, otherViewLeaf]);
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    rows.set(otherFile.path, [makeHighlight('Snippets/o.md', 0, 5)]);

    registerPdfLeafHighlights(plugin);
    await flush();

    expect(marked(pdfLeaf.containerEl)).toEqual([['Snippets/a.md', 'Hello']]);
    expect(marked(otherViewLeaf.containerEl)).toEqual([]);
  });

  it.each(['layout-change', 'file-open', 'active-leaf-change'])(
    'follows a tab to another PDF, and off PDFs, on %s',
    async (event) => {
      const leaf = makePdfLeaf(PDF);
      const { plugin, rows, workspace } = makePlugin([leaf]);
      const other = { path: 'papers/Other.pdf', extension: 'pdf' } as TFile;
      rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
      rows.set(other.path, [makeHighlight('Snippets/o.md', 6, 11)]);
      registerPdfLeafHighlights(plugin);
      await flush();

      leaf.view.file = other;
      workspace.trigger(event);
      await flush();
      expect(marked(leaf.containerEl)).toEqual([['Snippets/o.md', 'world']]);

      leaf.view.file = null;
      workspace.trigger(event);
      await flush();
      expect(marked(leaf.containerEl)).toEqual([]);
    }
  );

  it('reads a tab once however many events one switch fires, and leaves a tab that still shows its PDF alone', async () => {
    const leaf = makePdfLeaf(PDF);
    const { plugin, rows, workspace, getSnippetHighlights } = makePlugin([
      leaf,
    ]);
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    registerPdfLeafHighlights(plugin);
    await flush();
    workspace.trigger('active-leaf-change');
    workspace.trigger('file-open');
    workspace.trigger('layout-change');
    await flush();

    expect(getSnippetHighlights).toHaveBeenCalledTimes(1);
    expect(marked(leaf.containerEl)).toEqual([['Snippets/a.md', 'Hello']]);
  });

  it('lets go of a closed tab, and of every tab once the plugin unloads', async () => {
    const closing = makePdfLeaf(PDF);
    const staying = makePdfLeaf(PDF);
    const leaves = [closing, staying];
    const { plugin, rows, workspace, unload, dataListenerCount } =
      makePlugin(leaves);
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    registerPdfLeafHighlights(plugin);
    await flush();
    expect(dataListenerCount()).toBe(2);

    leaves.splice(0, 1);
    workspace.trigger('layout-change');
    await flush();
    expect(marked(closing.containerEl)).toEqual([]);
    expect(dataListenerCount()).toBe(1);

    unload();
    expect(marked(staying.containerEl)).toEqual([]);
    expect(dataListenerCount()).toBe(0);
    workspace.trigger('layout-change');
    await flush();
    expect(marked(staying.containerEl)).toEqual([]);
  });
});
