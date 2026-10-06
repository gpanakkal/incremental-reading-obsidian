// @vitest-environment jsdom
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import * as ObsidianPdf from '#/lib/pdf/obsidian-pdf';
import { encodeAnchor } from '#/lib/pdf/pdf-anchor';
import type { PdfHighlight } from '#/lib/pdf/pdf-highlights';
import * as PdfHighlights from '#/lib/pdf/pdf-highlights';
import {
  type SnippetHighlight,
  SnippetOffsetTracker,
} from '#/lib/SnippetOffsetTracker';
import type { DataChangeEvent } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import {
  charsRect,
  fakePdfLayout,
  FakeResizeObserver,
} from '#/test/pdf-layout';
import { FileView, type TFile, type WorkspaceLeaf } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerPdfLeafHighlights,
  showPdfItemHighlights,
} from './PdfItemHighlights';
import * as SnippetHighlightExtension from './SnippetHighlightExtension';

// #region HELPERS

const PDF = { path: 'papers/Paper.pdf', extension: 'pdf' } as TFile;

/** Where every page's highlight overlay is on screen. */
const FRAME = { left: 0, top: 0, width: 600, height: 800 };

/**
 * A viewer's page 1, its canvas wrapper, and its text layer holding "Hello
 * world", laid out as `fakePdfLayout` has it.
 */
function makeViewer() {
  const containerEl = document.body.appendChild(document.createElement('div'));
  const pageEl = containerEl.appendChild(document.createElement('div'));
  pageEl.className = 'page';
  pageEl.dataset.pageNumber = '1';
  const wrapper = pageEl.appendChild(document.createElement('div'));
  wrapper.className = 'canvasWrapper';
  wrapper.appendChild(document.createElement('canvas'));
  const textLayer = pageEl.appendChild(document.createElement('div'));
  textLayer.className = 'textLayer';
  const item = textLayer.appendChild(document.createElement('span'));
  item.className = 'textLayerNode';
  item.dataset.idx = '0';
  item.textContent = 'Hello world';
  return { containerEl, item };
}

/**
 * The references and text the highlight boxes in `el` matching `selector`
 * mark, bottom of the stack first.
 */
const boxesIn = (el: Element, selector: string) =>
  Array.from(el.querySelectorAll<HTMLElement>(selector), (box) => {
    const item = box
      .closest('.page')!
      .querySelector(`.textLayer [data-idx="${box.dataset.item}"]`)!;
    return [
      box.dataset.snippetRef,
      item.textContent.slice(
        Number(box.dataset.start),
        Number(box.dataset.end)
      ),
    ];
  });

/** The references and text the viewer's highlights mark. */
const marked = (el: Element) =>
  boxesIn(el, '.ir-pdf-highlights > .ir-snippet-highlight');

/** The references the viewer's card highlights mark, and their text. */
const markedCards = (el: Element) =>
  boxesIn(el, '.ir-pdf-highlights > .ir-snippet-highlight.ir-card-highlight');

/** A card of page 1's item 0, characters `from` to `to`. */
function makeCard(ref: string, from: number, to: number): PdfHighlight {
  return {
    ref,
    kind: 'card',
    start: encodeAnchor({ page: 1, idx: 0, char: from }),
    end: encodeAnchor({ page: 1, idx: 0, char: to }),
  };
}

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
 * offset tracker as `ReviewManager.getSnippetHighlights` does, and the
 * highlights of `cards` per PDF path, as `CardManager.getPdfHighlights` reads
 * them.
 */
function makePlugin(leaves: { view: unknown }[] = []) {
  const rows = new Map<string, SnippetHighlight[]>();
  const cards = new Map<string, PdfHighlight[]>();
  const tracker = new SnippetOffsetTracker();
  const dataListeners = new Set<(event: DataChangeEvent) => void>();
  const workspaceHandlers = new Map<
    string,
    Set<(...args: unknown[]) => void>
  >();
  const metadataHandlers = new Set<(file: TFile) => void>();
  const cleanups: (() => void)[] = [];

  const getSnippetHighlights = vi.fn(async (file: TFile) => {
    // Answers after a turn, as the database does
    await Promise.resolve();
    const found = rows.get(file.path) ?? [];
    tracker.loadHighlights(file.path, found);
    return found;
  });
  const getPdfHighlights = vi.fn(async (file: TFile) => {
    await Promise.resolve();
    return [...(cards.get(file.path) ?? [])];
  });
  const metadataCache = {
    on: vi.fn((_name: string, cb: (file: TFile) => void) => {
      metadataHandlers.add(cb);
      return cb;
    }),
    offref: vi.fn((ref: (file: TFile) => void) => {
      metadataHandlers.delete(ref);
    }),
  };
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
    app: { workspace, metadataCache },
    reviewManager: {
      getSnippetHighlights,
      snippets: { offsetTracker: tracker },
      cards: { getPdfHighlights },
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
    cards,
    tracker,
    workspace,
    getSnippetHighlights,
    getPdfHighlights,
    /** The metadata cache reports `file` changed. */
    metadataChanged: (file: TFile) =>
      [...metadataHandlers].forEach((cb) => cb(file)),
    metadataHandlerCount: () => metadataHandlers.size,
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

/** A card note, tagged as one or not, whose source resolves to `source`. */
function cardNote(
  path: string,
  source: TFile | null,
  tags: string[] = ['ir-card']
) {
  const note = { path, extension: 'md' } as TFile;
  return { note, source, tags };
}

/** The metadata cache holding `notes`' tags and resolved source links. */
function withNotes(notes: ReturnType<typeof cardNote>[]) {
  const find = (file: TFile) => notes.find(({ note }) => note === file);
  vi.spyOn(Obsidian, 'getFrontMatter').mockImplementation(
    (file) => ({ tags: find(file)?.tags ?? [] }) as never
  );
  vi.spyOn(Obsidian, 'getSourceFile').mockImplementation(
    (file) => find(file)?.source ?? null
  );
}

// #endregion

let layout: ReturnType<typeof fakePdfLayout>;

beforeEach(() => {
  layout = fakePdfLayout(() => FRAME);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  layout.restore();
  document.body.replaceChildren();
  delete (document as Partial<Document>).elementFromPoint;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('showPdfItemHighlights', () => {
  it("marks the PDF's snippets once they are read from the database", async () => {
    const { plugin, rows } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    const { containerEl } = makeViewer();

    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    expect(marked(containerEl)).toEqual([]);
    await flush();

    expect(marked(containerEl)).toEqual([['Snippets/a.md', 'Hello']]);
    stop();
  });

  it('reads them again when a snippet row changes, and only then', async () => {
    const { plugin, rows, getSnippetHighlights, dataChange } = makePlugin();
    const { containerEl } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
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
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
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
    const stop = showPdfItemHighlights(plugin, file, containerEl);
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
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
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
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
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

describe('showPdfItemHighlights, for cards', () => {
  it("marks the PDF's cards beside its snippets, as cards, once read", async () => {
    const { plugin, rows, cards } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    const { containerEl } = makeViewer();

    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();

    expect(marked(containerEl)).toEqual([
      ['Snippets/a.md', 'Hello'],
      ['Cards/c.md', 'world'],
    ]);
    expect(markedCards(containerEl)).toEqual([['Cards/c.md', 'world']]);
    stop();
  });

  it('stacks a card over a snippet over the very same text', async () => {
    const { plugin, rows, cards } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/z.md', 0, 5)]);
    cards.set(PDF.path, [makeCard('Cards/a.md', 0, 5)]);
    const { containerEl } = makeViewer();

    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();

    expect(marked(containerEl)).toEqual([
      ['Snippets/z.md', 'Hello'],
      ['Cards/a.md', 'Hello'],
    ]);
    stop();
  });

  it('reads the cards again when a card row changes, and only then', async () => {
    const { plugin, cards, getPdfHighlights, dataChange } = makePlugin();
    const { containerEl } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();
    expect(getPdfHighlights).toHaveBeenCalledExactlyOnceWith(PDF);

    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    dataChange('snippet');
    dataChange('article');
    await flush();
    expect(markedCards(containerEl)).toEqual([]);
    expect(getPdfHighlights).toHaveBeenCalledOnce();

    dataChange('card');
    await flush();
    expect(markedCards(containerEl)).toEqual([['Cards/c.md', 'world']]);

    // Soft-deleted with its note, say
    cards.set(PDF.path, []);
    dataChange('card');
    await flush();
    expect(markedCards(containerEl)).toEqual([]);
    stop();
  });

  it('reads the cards once more, not once each, for changes made while it reads', async () => {
    const { plugin, cards, getPdfHighlights, dataChange } = makePlugin();
    const { containerEl } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    dataChange('card');
    dataChange('card');
    dataChange('card');
    await flush();
    await flush();

    expect(getPdfHighlights).toHaveBeenCalledTimes(2);
    expect(markedCards(containerEl)).toEqual([['Cards/c.md', 'world']]);
    stop();
  });

  it('reads the cards again when told its highlights changed, at its path as it is now, and for no other path', async () => {
    const { plugin, cards, workspace, getPdfHighlights } = makePlugin();
    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    const file = { ...PDF } as TFile;
    const { containerEl } = makeViewer();
    const stop = showPdfItemHighlights(plugin, file, containerEl);
    await flush();

    // Undoing a card deletes its row outright, then says so
    cards.set(PDF.path, []);
    workspace.trigger('ir-highlights-changed', 'papers/Other.pdf');
    await flush();
    expect(getPdfHighlights).toHaveBeenCalledOnce();
    expect(markedCards(containerEl)).toEqual([['Cards/c.md', 'world']]);
    workspace.trigger('ir-highlights-changed', file.path);
    await flush();
    expect(markedCards(containerEl)).toEqual([]);

    (file as { path: string }).path = 'papers/Renamed.pdf';
    cards.set(file.path, [makeCard('Cards/d.md', 0, 1)]);
    workspace.trigger('ir-highlights-changed', file.path);
    await flush();
    expect(markedCards(containerEl)).toEqual([['Cards/d.md', 'H']]);
    stop();
  });

  it("reads the cards again when a shown card's note changes, or a card note's link comes to name this PDF, and for no other note", async () => {
    const { plugin, cards, metadataChanged, getPdfHighlights } = makePlugin();
    const shown = cardNote('Cards/c.md', null);
    const other = { path: 'papers/Other.pdf' } as TFile;
    const elsewhere = cardNote('Cards/e.md', other);
    const notACard = cardNote('Notes/n.md', PDF, ['ir-snippet']);
    const untagged = cardNote('Notes/u.md', PDF, []);
    const moved = cardNote('Cards/m.md', PDF);
    withNotes([shown, elsewhere, notACard, untagged, moved]);
    // Another card shown beside it, whose note doesn't change
    cards.set(PDF.path, [
      makeCard('Cards/b.md', 0, 1),
      makeCard('Cards/c.md', 6, 11),
    ]);
    const { containerEl } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();

    for (const { note } of [elsewhere, notACard, untagged]) {
      metadataChanged(note);
    }
    await flush();
    expect(getPdfHighlights).toHaveBeenCalledOnce();

    // Its link edited to name another selection, or none: it stays shown
    // until read again, which finds where it now is
    cards.set(PDF.path, [makeCard('Cards/c.md', 0, 5)]);
    metadataChanged(shown.note);
    await flush();
    expect(getPdfHighlights).toHaveBeenCalledTimes(2);
    expect(markedCards(containerEl)).toEqual([['Cards/c.md', 'Hello']]);

    // A card's link edited to name this PDF
    cards.set(PDF.path, [
      makeCard('Cards/c.md', 0, 5),
      makeCard('Cards/m.md', 6, 11),
    ]);
    metadataChanged(moved.note);
    await flush();
    expect(getPdfHighlights).toHaveBeenCalledTimes(3);
    expect(markedCards(containerEl)).toEqual([
      ['Cards/c.md', 'Hello'],
      ['Cards/m.md', 'world'],
    ]);
    stop();
  });

  it('keeps the cards it shows when reading them fails, and says so', async () => {
    const { plugin, cards, getPdfHighlights, dataChange } = makePlugin();
    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { containerEl } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();

    const error = new Error('locked');
    getPdfHighlights.mockRejectedValueOnce(error);
    dataChange('card');
    await flush();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/PDF highlights/),
      error
    );
    expect(markedCards(containerEl)).toEqual([['Cards/c.md', 'world']]);
    stop();
  });

  it('sets nothing new on the page when what it reads is what it shows', async () => {
    const set = vi.fn();
    const create = PdfHighlights.createPdfHighlightLayer;
    vi.spyOn(PdfHighlights, 'createPdfHighlightLayer').mockImplementation(
      (el) => {
        const layer = create(el);
        return {
          set: (highlights) => {
            set(highlights);
            layer.set(highlights);
          },
          destroy: () => layer.destroy(),
        };
      }
    );
    const { plugin, rows, cards, dataChange, workspace } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    const { containerEl } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();
    const shown = set.mock.calls.length;

    // A review updates the card's row each grade
    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    dataChange('card');
    dataChange('snippet');
    workspace.trigger('ir-highlights-changed', PDF.path);
    await flush();
    await flush();
    expect(set).toHaveBeenCalledTimes(shown);

    // Anything else that differs is set: its end, its start, its ref, or its
    // kind
    const changes: [SnippetHighlight[], PdfHighlight[]][] = [
      [[makeHighlight('Snippets/a.md', 0, 5)], [makeCard('Cards/c.md', 6, 10)]],
      [[makeHighlight('Snippets/a.md', 0, 5)], [makeCard('Cards/c.md', 7, 10)]],
      [[makeHighlight('Snippets/a.md', 0, 5)], [makeCard('Cards/d.md', 7, 10)]],
      [
        [
          makeHighlight('Snippets/a.md', 0, 5),
          makeHighlight('Cards/d.md', 7, 10),
        ],
        [],
      ],
    ];
    for (const [i, [snippetRows, cardRows]] of changes.entries()) {
      rows.set(PDF.path, snippetRows);
      cards.set(PDF.path, cardRows);
      dataChange('snippet');
      dataChange('card');
      await flush();
      await flush();
      expect(set).toHaveBeenCalledTimes(shown + i + 1);
    }
    expect(marked(containerEl)).toEqual([
      ['Snippets/a.md', 'Hello'],
      ['Cards/d.md', 'orl'],
    ]);
    expect(markedCards(containerEl)).toEqual([]);
    stop();
  });

  it('when stopped, listens to the metadata cache no more, and shows no cards read after', async () => {
    const {
      plugin,
      cards,
      dataChange,
      metadataChanged,
      metadataHandlerCount,
      getPdfHighlights,
    } = makePlugin();
    const shown = cardNote('Cards/c.md', PDF);
    withNotes([shown]);
    cards.set(PDF.path, [makeCard('Cards/c.md', 6, 11)]);
    const { containerEl, item } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();
    expect(metadataHandlerCount()).toBe(1);
    // Read under way as it stops, finding what it never shows
    cards.set(PDF.path, [makeCard('Cards/d.md', 0, 5)]);
    dataChange('card');

    stop();
    await flush();
    expect(metadataHandlerCount()).toBe(0);
    expect(markedCards(containerEl)).toEqual([]);
    metadataChanged(shown.note);
    item.textContent = 'Hello world';
    await flush();
    expect(getPdfHighlights).toHaveBeenCalledTimes(2);
    expect(markedCards(containerEl)).toEqual([]);
  });
});

describe('a press on a highlight shown by showPdfItemHighlights', () => {
  /** A point over "Hello" (characters 0 to 5 of item 0), and one over "world". */
  const ON_HELLO = { clientX: charsRect(0, 0, 5).left + 10, clientY: 35 };
  const ON_WORLD = { clientX: charsRect(0, 6, 11).left + 10, clientY: 35 };

  /**
   * The PDF's viewer, in whichever window, with "Hello" highlighted, and the
   * snippet opener spied on.
   */
  async function setUp(cardRows: PdfHighlight[] = []) {
    const { plugin, rows, cards } = makePlugin();
    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    cards.set(PDF.path, cardRows);
    const { containerEl, item } = makeViewer();
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();
    const open = vi
      .spyOn(SnippetHighlightExtension, 'openHighlightFromEvent')
      .mockReturnValue(true);
    const reached = vi.fn();
    document.addEventListener('click', reached);
    document.addEventListener('auxclick', reached);
    const boxes = containerEl.querySelectorAll('.ir-snippet-highlight');
    const select = (node: Node, from: number, to: number) => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    return {
      plugin,
      containerEl,
      item,
      box: boxes[0],
      boxes,
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

  /** A press of `button` on `el`, at `point` on screen. */
  const press = (
    el: Element,
    type: string,
    button = 0,
    point: { clientX: number; clientY: number } = ON_HELLO
  ) => {
    const evt = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button,
      ...point,
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
    const popoutWindow = frame.contentWindow!;
    // Obsidian gives every window its DOM helpers; the test setup only the main one
    Object.assign(popoutWindow, { createDiv: window.createDiv });
    const popoutLayout = fakePdfLayout(
      () => FRAME,
      popoutWindow as unknown as typeof globalThis
    );
    const { containerEl, item } = makeViewer();
    popout.body.append(popout.adoptNode(containerEl));
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();
    const open = vi
      .spyOn(SnippetHighlightExtension, 'openHighlightFromEvent')
      .mockReturnValue(true);
    const reached = vi.fn();
    document.addEventListener('click', reached);

    const box = containerEl.querySelector('.ir-snippet-highlight')!;
    const click = press(item, 'click');

    expect(open.mock.calls).toEqual([[plugin, click, box]]);
    expect(reached).not.toHaveBeenCalled();
    document.removeEventListener('click', reached);
    stop();
    popoutLayout.restore();
  });

  it('opens its snippet on a click or a middle click on the text over it, as markdown highlights do', async () => {
    const { plugin, item, box, open, done, stop } = await setUp();
    const click = press(item, 'click');
    const middle = press(item, 'auxclick', 1);
    press(item, 'auxclick', 2);

    expect(open.mock.calls).toEqual([
      [plugin, click, box],
      [plugin, middle, box],
    ]);
    done();
    stop();
  });

  it('opens its snippet on a click on the page while pdf.js hides the text over it through a zoom', async () => {
    const { plugin, containerEl, box, open, done, stop } = await setUp();
    containerEl.querySelector<HTMLElement>('.textLayer')!.hidden = true;
    const canvas = containerEl.querySelector('.canvasWrapper > canvas')!;
    const click = press(canvas, 'click');

    expect(open.mock.calls).toEqual([[plugin, click, box]]);
    done();
    stop();
  });

  it('opens the card over a snippet, the topmost highlight there', async () => {
    const { plugin, item, boxes, open, done, stop } = await setUp([
      makeCard('Cards/c.md', 1, 3),
    ]);
    const onCard = { clientX: charsRect(0, 1, 3).left + 1, clientY: 35 };
    const click = press(item, 'click', 0, onCard);

    expect(boxes).toHaveLength(2);
    expect(open.mock.calls).toEqual([[plugin, click, boxes[1]]]);
    done();
    stop();
  });

  it('opens nothing for a click that ends a drag selecting text, and keeps it from every other handler, so the text can be extracted', async () => {
    const { item, open, reached, select, done, stop } = await setUp();
    select(item.firstChild!, 1, 4);
    press(item, 'click');
    press(item, 'auxclick', 1);

    expect(open).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
    done();
    stop();
  });

  it('opens its snippet with an empty selection in it', async () => {
    const { item, open, select, done, stop } = await setUp();
    select(item.firstChild!, 2, 2);
    press(item, 'click');

    expect(open).toHaveBeenCalledOnce();
    done();
    stop();
  });

  it('leaves alone a press elsewhere in the text, or on anything over the text layer, such as a link, selection or not', async () => {
    const { containerEl, item, open, reached, select, done, stop } =
      await setUp();
    // A link annotation, in pdf.js's annotation layer over the text
    const page = containerEl.querySelector('.page')!;
    const annotations = page.appendChild(document.createElement('div'));
    annotations.className = 'annotationLayer';
    const link = annotations.appendChild(document.createElement('a'));
    select(item.firstChild!, 1, 4);

    const middle = press(item, 'mousedown', 1, ON_WORLD);
    press(item, 'click', 0, ON_WORLD);
    const onLink = press(link, 'mousedown', 1);
    press(link, 'click');
    // Beside the page, in the toolbar, say
    press(containerEl, 'click');

    expect(open).not.toHaveBeenCalled();
    expect(reached).toHaveBeenCalledTimes(3);
    expect(middle.defaultPrevented).toBe(false);
    expect(onLink.defaultPrevented).toBe(false);
    done();
    stop();
  });

  it('keeps a middle press over it from scrolling or pasting, and nothing else', async () => {
    const { item, done, stop } = await setUp();

    expect(press(item, 'mousedown', 1).defaultPrevented).toBe(true);
    expect(press(item, 'mousedown', 0).defaultPrevented).toBe(false);
    done();
    stop();
  });

  it('rings the highlight under the mouse, listening for it only while the PDF has highlights', async () => {
    const { plugin, rows, dataChange } = makePlugin();
    const { containerEl, item } = makeViewer();
    const listen = vi.spyOn(containerEl, 'addEventListener');
    const unlisten = vi.spyOn(containerEl, 'removeEventListener');
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    document.elementFromPoint = () => item;
    const moveTo = ({ clientX, clientY }: typeof ON_HELLO) => {
      item.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'mouse',
          clientX,
          clientY,
        })
      );
      frames.splice(0).forEach((cb) => cb(0));
    };
    const stop = showPdfItemHighlights(plugin, PDF, containerEl);
    await flush();
    const pointerListeners = () =>
      listen.mock.calls.filter(([type]) => type.startsWith('pointer'));
    expect(pointerListeners()).toEqual([]);

    rows.set(PDF.path, [makeHighlight('Snippets/a.md', 0, 5)]);
    dataChange('snippet');
    await flush();
    expect(pointerListeners()).not.toEqual([]);
    moveTo(ON_HELLO);
    const box = containerEl.querySelector('.ir-snippet-highlight')!;
    expect(box.classList.contains('ir-hovered')).toBe(true);
    expect(containerEl.classList.contains('ir-pdf-highlight-pointer')).toBe(
      true
    );
    moveTo(ON_WORLD);
    expect(box.classList.contains('ir-hovered')).toBe(false);
    expect(containerEl.classList.contains('ir-pdf-highlight-pointer')).toBe(
      false
    );

    moveTo(ON_HELLO);
    stop();
    expect(containerEl.classList.contains('ir-pdf-highlight-pointer')).toBe(
      false
    );
    expect(
      unlisten.mock.calls.filter(([type]) => type.startsWith('pointer'))
    ).toEqual(pointerListeners());
  });

  it('once stopped, leaves every press alone', async () => {
    const { containerEl, item, open, reached, select, done, stop } =
      await setUp();
    stop();
    // Someone else's box over the text, say another viewer's layer's
    const overlay = containerEl
      .querySelector('.canvasWrapper')!
      .appendChild(document.createElement('div'));
    overlay.className = 'ir-pdf-highlights';
    const box = overlay.appendChild(document.createElement('div'));
    box.className = 'ir-snippet-highlight';
    Object.assign(box.style, {
      left: '0%',
      top: '0%',
      width: '50%',
      height: '50%',
    });
    select(item.firstChild!, 0, 2);

    press(item, 'click');
    press(item, 'auxclick', 1);
    expect(press(item, 'mousedown', 1).defaultPrevented).toBe(false);
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

  it('follows the selection in every PDF tab, article or not, from when it is first found, and in no other view', async () => {
    // A press on the command palette, or a tap on mobile, moves the browser's
    // selection out of the PDF before the snippet or card is made of it
    const tabSelection = vi
      .spyOn(ObsidianPdf, 'pdfTabSelection')
      .mockReturnValue(null);
    const pdfLeaf = makePdfLeaf(PDF);
    const otherViewLeaf = makePdfLeaf(PDF, 'markdown');
    const leaves = [pdfLeaf, otherViewLeaf];
    const { plugin, workspace } = makePlugin(leaves);

    registerPdfLeafHighlights(plugin);
    expect(tabSelection.mock.calls).toEqual([[pdfLeaf.view]]);

    const opened = makePdfLeaf(PDF);
    leaves.push(opened);
    workspace.trigger('layout-change');
    await flush();
    expect(tabSelection).toHaveBeenLastCalledWith(opened.view);
    expect(tabSelection.mock.calls.map(([view]) => view)).not.toContain(
      otherViewLeaf.view
    );
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
