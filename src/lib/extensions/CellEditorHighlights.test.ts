// @vitest-environment jsdom

import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from '#/lib/SnippetOffsetTracker';
import { gridArb } from '#/test/table-arbitraries';
import {
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import fc from 'fast-check';
import { editorInfoField } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cellEditorHighlights,
  cellEditorText,
  cellMarks,
  type CellMark,
} from './CellEditorHighlights';
import { irPluginFacet } from './irPluginFacet';
import { snippetHighlightExtension } from './SnippetHighlightExtension';
import {
  tableCellSections,
  widgetHighlightPainter,
} from './WidgetHighlightPainter';

// #region HELPERS

const FILE_PATH = 'notes/a.md';

function makeHighlight(
  id: string,
  start: number,
  end: number
): SnippetHighlight {
  return {
    id,
    type: 'snippet',
    reference: `snippets/${id}.md`,
    due: null,
    due_fuzz: null,
    interval: 1,
    dismissed: false,
    deleted: false,
    priority: 50,
    parent: FILE_PATH,
    start_offset: start,
    end_offset: end,
    scroll_top: 0,
  };
}

/**
 * A part of a cell's markdown, with the text a cell editor shows for it and,
 * for each of its characters, which character of that text it shows as
 * (null for one shown as nothing).
 */
type Piece = { src: string; text: string; shownAs: (number | null)[] };

const oneToOne = (src: string): Piece => ({
  src,
  text: src,
  shownAs: Array.from(src, (_, i) => i),
});

/** Plain text: nothing a cell editor shows otherwise. */
const plainArb = fc.stringMatching(/^[a-z0-9 .,*_#~=:!-]{1,3}$/).map(oneToOne);

const escapedPipe: Piece = { src: '\\|', text: '|', shownAs: [null, 0] };
/** An escaped backslash, then an escaped pipe. */
const escapedBackslashAndPipe: Piece = {
  src: '\\\\\\|',
  text: '\\\\|',
  shownAs: [0, 1, null, 2],
};
const backslashLetter = oneToOne('\\a');
const lineBreakArb = fc
  .constantFrom('<br>', '<BR>', '<Br>', '<bR>')
  .map((src): Piece => ({ src, text: '\n', shownAs: [0, 0, 0, 0] }));
/** An HTML tag that is no line break. */
const otherTag = oneToOne('<i>');

/** Code: a `<br>` in it stays as it is, an escaped pipe is unescaped. */
const codeArb = fc
  .tuple(
    fc.constantFrom('`', '``'),
    fc.array(
      fc.oneof(
        fc.stringMatching(/^[a-z ]{1,2}$/).map(oneToOne),
        fc.constant(oneToOne('<br>')),
        fc.constant(escapedPipe)
      ),
      { minLength: 1, maxLength: 3 }
    )
  )
  .map(([fence, inner]) => join([oneToOne(fence), ...inner, oneToOne(fence)]));

function join(pieces: Piece[]): Piece {
  let src = '';
  let text = '';
  const shownAs: (number | null)[] = [];
  for (const piece of pieces) {
    for (const at of piece.shownAs) {
      shownAs.push(at === null ? null : text.length + at);
    }
    src += piece.src;
    text += piece.text;
  }
  return { src, text, shownAs };
}

/** A cell's markdown, trimmed as the note's table gives it, and what it shows as. */
const cellArb = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: plainArb },
      fc.constant(escapedPipe),
      fc.constant(escapedBackslashAndPipe),
      fc.constant(backslashLetter),
      lineBreakArb,
      fc.constant(otherTag),
      codeArb
    ),
    { maxLength: 6 }
  )
  .map(join)
  .filter(({ src }) => src === src.trim());

/** Space typed at a side of a cell's editor, which the note keeps out of the cell. */
const sideArb = fc.constantFrom('', ' ', '\t', '  ');

/** Highlights around a cell `length` long at `bodyOffset`: in it, across its sides, or out of it. */
const highlightsAround = (bodyOffset: number, length: number) =>
  fc
    .array(
      fc
        .tuple(
          fc.integer({
            min: Math.max(0, bodyOffset - 3),
            max: bodyOffset + length + 3,
          }),
          fc.integer({ min: 0, max: length + 6 })
        )
        .map(([start, size]) => [start, start + size] as const),
      { maxLength: 4 }
    )
    .map((spans) =>
      spans.map(([start, end], i) => makeHighlight(`h${i}`, start, end))
    );

/**
 * The marks a cell editor showing `cell.text`, between `lead` and any
 * trailing space, should have: each highlight's on just the shown text of the
 * markdown it covers.
 */
function expectedMarks(
  cell: Piece,
  bodyOffset: number,
  lead: number,
  highlights: SnippetHighlight[]
): CellMark[] {
  return highlights.flatMap(({ id, start_offset, end_offset }) => {
    const shown = cell.shownAs.filter(
      (at, i): at is number =>
        at !== null &&
        bodyOffset + i >= start_offset &&
        bodyOffset + i < end_offset
    );
    return shown.length === 0
      ? []
      : [
          {
            id,
            from: lead + Math.min(...shown),
            to: lead + Math.max(...shown) + 1,
          },
        ];
  });
}

/** Marks a cell editor's state as one, for the stand-ins of Obsidian's below. */
const inCell = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** Marks a note's editor as one of a note with no file, as a new buffer. */
const fileless = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** An effect of someone else's. */
const otherEffect = StateEffect.define<null>();

function makePlugin(tracker = new SnippetOffsetTracker()) {
  type Ref = { name: string; callback: (...args: unknown[]) => unknown };
  const handlers = new Set<Ref>();
  return {
    reviewManager: {
      snippets: { offsetTracker: tracker, getItemType: vi.fn() },
      getSnippetHighlights: vi.fn(),
      updateSnippetOffsets: vi.fn(),
    } as {
      snippets: {
        offsetTracker: SnippetOffsetTracker;
        getItemType: ReturnType<typeof vi.fn>;
      };
      getSnippetHighlights: ReturnType<typeof vi.fn>;
      updateSnippetOffsets: ReturnType<typeof vi.fn>;
    } | null,
    getOpenReviewLeaf: () => null,
    app: {
      vault: { getFileByPath: (path: string) => ({ path }) },
      workspace: {
        openLinkText: vi.fn(),
        on: vi.fn((name: string, callback: Ref['callback']) => {
          const ref = { name, callback };
          handlers.add(ref);
          return ref;
        }),
        offref: vi.fn((ref: Ref) => handlers.delete(ref)),
        trigger: (name: string, ...args: unknown[]) => {
          for (const ref of handlers)
            if (ref.name === name) ref.callback(...args);
        },
      },
    },
  };
}

type FakePlugin = ReturnType<typeof makePlugin>;

/** A table widget as live preview draws one: each cell's trimmed text. */
class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const widget = createDiv({ cls: 'cm-embed-block cm-table-widget' });
    const table = widget.createDiv({ cls: 'table-wrapper' }).createEl('table');
    tableCellSections(this.source, 0).forEach((row, r) => {
      const tr = (
        r === 0 ? table.createTHead() : table.createTBody()
      ).insertRow();
      for (const { source } of row) {
        const cell = r === 0 ? tr.createEl('th') : tr.insertCell();
        cell.createDiv({ cls: 'table-cell-wrapper', text: source });
      }
    });
    return widget;
  }
}

/** The note whose editor the cell editors below are nested in. */
let note: EditorView | null = null;

/**
 * Stand in for what Obsidian gives its editors: a note's has its file; a
 * cell's has the note's view as its owner, whose editor is the note's, and
 * no file of its own once the nested guard has had its say.
 */
function standInForObsidian() {
  vi.spyOn(Obsidian, 'getFileInfoFromState').mockImplementation((state) => ({
    info: (state.facet(inCell) || state.facet(fileless)
      ? null
      : { file: { path: FILE_PATH } }) as never,
    editorView: null,
  }));
  const field = Object.getOwnPropertyDescriptor(EditorState.prototype, 'field')
    ?.value as (
    this: EditorState,
    wanted: unknown,
    require?: boolean
  ) => unknown;
  vi.spyOn(EditorState.prototype, 'field').mockImplementation(function (
    this: EditorState,
    wanted: unknown,
    require?: boolean
  ) {
    if (wanted === editorInfoField) {
      return this.facet(inCell)
        ? { file: { path: FILE_PATH }, editor: { cm: note } }
        : { file: { path: FILE_PATH } };
    }
    return field.call(this, wanted, require) as unknown;
  } as never);
}

/**
 * A note's editor showing `table`, after `before`, as a live preview table
 * widget, with the note's `highlights` in the tracker.
 */
function makeNote(
  table: string,
  highlights: SnippetHighlight[],
  {
    before = 'Intro\n\n',
    plugin = makePlugin() as FakePlugin | null,
    extensions = [] as Extension[],
  } = {}
) {
  plugin?.reviewManager?.snippets.offsetTracker.loadHighlights(
    FILE_PATH,
    highlights
  );
  const widgets = StateField.define<DecorationSet>({
    create: () =>
      Decoration.set([
        Decoration.replace({
          widget: new TableWidget(table),
          block: true,
        }).range(before.length, before.length + table.length),
      ]),
    update: (deco, tr) => deco.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  });
  note?.destroy();
  note = new EditorView({
    state: EditorState.create({
      doc: `${before}${table}\n\nAfter.`,
      extensions: [widgets, irPluginFacet.of(plugin as never), ...extensions],
    }),
    parent: document.body,
  });
  return { note, plugin };
}

const cells: EditorView[] = [];

/**
 * Open an editor on cell `col` of row `row` (counting the header, not the
 * separator) showing `doc`, as Obsidian's `editTableCell` does: built apart,
 * then put in the cell beside its hidden rendered text.
 */
function openCell(
  row: number,
  col: number,
  doc: string,
  { plugin = null as FakePlugin | null, extensions = [] as Extension[] } = {}
) {
  const table = note!.contentDOM.querySelector('table')!;
  const cell = table.rows[row].cells[col];
  const wrapper = createDiv({ cls: 'table-cell-wrapper' });
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        inCell.of(true),
        irPluginFacet.of((plugin ?? note!.state.facet(irPluginFacet)) as never),
        cellEditorHighlights,
        ...extensions,
      ],
    }),
    parent: wrapper,
  });
  cells.push(view);
  (cell.firstElementChild as HTMLElement).hidden = true;
  cell.append(wrapper);
  return view;
}

/** Each mark's text, by highlight, in the cell editor's document order. */
function marksOf(view: EditorView) {
  const marks = new Map<string, string>();
  const set = view.plugin(cellEditorHighlights)?.decorations;
  for (let it = set?.iter(); it?.value; it.next()) {
    const spec = it.value.spec as { attributes: Record<string, string> };
    const id = spec.attributes['data-snippet-id'];
    marks.set(id, view.state.sliceDoc(it.from, it.to));
  }
  return marks;
}

/** Let every scheduled refresh run. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The tracker's methods that change what it holds. */
const TRACKER_WRITES = [
  'loadHighlights',
  'invalidateCache',
  'updateOffsetsWithMapping',
  'updateHighlight',
  'restoreHighlights',
  'removeHighlight',
  'renameFile',
  'clearAll',
] as const;

// #endregion

afterEach(() => {
  for (const view of cells.splice(0)) view.destroy();
  note?.destroy();
  note = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('cellEditorText', () => {
  it('shows each escaped pipe unescaped and each line break tag outside code as a line break, the rest as it is', () => {
    fc.assert(
      fc.property(cellArb, (cell) => {
        expect(cellEditorText(cell.src).text).toBe(cell.text);
      })
    );
  });

  it('leaves a pipe after an even run of backslashes, and one escaped pipe of an odd run', () => {
    expect(cellEditorText('a\\\\|b').text).toBe('a\\\\|b');
    expect(cellEditorText('a\\\\\\\\\\|b').text).toBe('a\\\\\\\\|b');
  });

  it('ends code where its own run of backticks closes it', () => {
    expect(cellEditorText('``x``<br>`y`').text).toBe('``x``\n`y`');
  });
});

describe('cellMarks', () => {
  it("marks, of each highlight cut to the cell, the shown text of what it covers, past space typed at the cell's sides", () => {
    fc.assert(
      fc.property(
        cellArb,
        fc.nat(40),
        sideArb,
        sideArb,
        (cell, bodyOffset, lead, trail) =>
          fc.assert(
            fc.property(
              highlightsAround(bodyOffset, cell.src.length),
              (highlights) => {
                expect(
                  cellMarks(
                    { source: cell.src, bodyOffset },
                    highlights,
                    lead + cell.text + trail
                  )
                ).toEqual(
                  expectedMarks(cell, bodyOffset, lead.length, highlights)
                );
              }
            ),
            { numRuns: 5 }
          )
      )
    );
  });

  it("marks nothing in an editor whose text isn't the cell's", () => {
    const section = { source: 'one two', bodyOffset: 10 };
    const all = [makeHighlight('h', 10, 17)];
    expect(cellMarks(section, all, 'one two')).toHaveLength(1);
    for (const doc of ['one tw', 'one twoo', 'xone two', 'one two x', '']) {
      expect(cellMarks(section, all, doc)).toEqual([]);
    }
  });
});

describe('cellEditorHighlights', () => {
  beforeEach(standInForObsidian);

  it("marks the note's highlights in the cell it edits, wherever the table is in the note", async () => {
    await fc.assert(
      fc.asyncProperty(
        gridArb,
        fc.constantFrom('', 'Intro\n\n', '---\na: b\n---\nIntro\n\n'),
        fc.nat(),
        fc.nat(),
        fc.array(fc.tuple(fc.nat(), fc.nat(8)), { maxLength: 4 }),
        async ({ doc: table }, before, rowPick, colPick, spans) => {
          const bodyStart = Obsidian.getBodyStartOffset(before);
          const tableAt = before.length - bodyStart;
          const highlights = spans.map(([start, size], i) => {
            const at = tableAt + (start % (table.length + 1));
            return makeHighlight(`h${i}`, at, at + size);
          });
          makeNote(table, highlights, { before });
          const rows = tableCellSections(table, tableAt);
          const row = rowPick % rows.length;
          const col = colPick % rows[row].length;
          const section = rows[row][col];
          const text = cellEditorText(section.source).text;
          const view = openCell(row, col, text);
          await settle();

          const expected = new Map(
            cellMarks(section, highlights, text).map(({ id, from, to }) => [
              id,
              text.slice(from, to),
            ])
          );
          expect(marksOf(view)).toEqual(expected);
          view.destroy();
        }
      ),
      { numRuns: 60 }
    );
  });

  it('shows its marks with the look of the note’s highlights, opening nothing', async () => {
    const table = '| a | b |\n| - | - |\n| cc | dd |';
    const at = 'Intro\n\n'.length + table.indexOf('dd');
    makeNote(table, [makeHighlight('h', at, at + 2)]);
    const view = openCell(1, 1, 'dd');
    await settle();
    const mark = view.contentDOM.querySelector<HTMLElement>(
      '.ir-snippet-highlight'
    )!;
    expect(mark.textContent).toBe('dd');
    expect(mark.dataset.snippetId).toBe('h');
    expect(mark.hasAttribute('data-snippet-ref')).toBe(false);
  });

  it('marks a cell that starts with a space other than a space or tab on its own text', async () => {
    // A no-break space is no padding: the cell's editor shows it
    const table = '| a | b |\n| - | - |\n| cc | \u00a0one two |';
    const at = 'Intro\n\n'.length + table.indexOf('one');
    makeNote(table, [makeHighlight('h', at, at + 3)]);
    const view = openCell(1, 1, '\u00a0one two');
    await settle();
    expect(marksOf(view)).toEqual(new Map([['h', 'one']]));
  });

  it('marks anew as the note’s highlights change', async () => {
    const table = '| a | b |\n| - | - |\n| cc | one two |';
    const at = 'Intro\n\n'.length + table.indexOf('one');
    const { plugin } = makeNote(table, [makeHighlight('h', at, at + 3)]);
    const view = openCell(1, 1, 'one two');
    await settle();
    expect(marksOf(view)).toEqual(new Map([['h', 'one']]));

    plugin!.reviewManager!.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight('h', at + 4, at + 7),
      makeHighlight('k', at, at + 1),
    ]);
    plugin!.app.workspace.trigger('ir-highlights-changed', FILE_PATH);
    await settle();
    expect(marksOf(view)).toEqual(
      new Map([
        ['k', 'o'],
        ['h', 'two'],
      ])
    );

    plugin!.reviewManager!.snippets.offsetTracker.loadHighlights(FILE_PATH, []);
    plugin!.app.workspace.trigger('ir-highlights-changed', FILE_PATH);
    await settle();
    expect(marksOf(view)).toEqual(new Map());
  });

  it('keeps its marks on their text as the cell is typed in, then follows the tracker', async () => {
    const table = '| a | b |\n| - | - |\n| cc | one two |';
    const cellAt = 'Intro\n\n'.length + table.indexOf('one');
    const { plugin } = makeNote(table, [
      makeHighlight('h', cellAt + 4, cellAt + 7),
    ]);
    const tracker = plugin!.reviewManager!.snippets.offsetTracker;
    const view = openCell(1, 1, 'one two');
    await settle();
    // Someone else's effect leaves them be
    view.dispatch({ effects: otherEffect.of(null) });
    expect(marksOf(view)).toEqual(new Map([['h', 'two']]));

    view.dispatch({ changes: { from: 0, insert: 'X' } });
    // Before the note has the edit: moved with the text
    expect(marksOf(view)).toEqual(new Map([['h', 'two']]));
    // The note's editor then has it, and moves the tracker
    note!.dispatch({ changes: { from: cellAt, insert: 'X' } });
    tracker.loadHighlights(FILE_PATH, [
      makeHighlight('h', cellAt + 5, cellAt + 8),
    ]);
    await settle();
    expect(marksOf(view)).toEqual(new Map([['h', 'two']]));

    // Where the tracker says otherwise, the tracker it is
    view.dispatch({ changes: { from: 0, insert: 'Y' } });
    note!.dispatch({ changes: { from: cellAt, insert: 'Y' } });
    tracker.loadHighlights(FILE_PATH, [
      makeHighlight('h', cellAt + 2, cellAt + 5),
    ]);
    await settle();
    expect(marksOf(view)).toEqual(new Map([['h', 'one']]));
  });

  it('writes nothing to the tracker or the database, and warns of nothing, however the cell and the note change', async () => {
    const table = '| a | b |\n| - | - |\n| cc | one two |';
    const at = 'Intro\n\n'.length + table.indexOf('one');
    // One past the note's end too, which the note's editor would warn of
    const { plugin } = makeNote(table, [
      makeHighlight('h', at, at + 3),
      makeHighlight('far', at + 4, at + 500),
    ]);
    const tracker = plugin!.reviewManager!.snippets.offsetTracker;
    const writes = TRACKER_WRITES.map((name) => vi.spyOn(tracker, name));
    const shown = vi.spyOn(tracker, 'shownRange');
    const warn = vi.spyOn(console, 'warn');
    const view = openCell(1, 1, 'one two');
    await settle();
    expect(marksOf(view)).toEqual(
      new Map([
        ['h', 'one'],
        ['far', 'two'],
      ])
    );

    view.dispatch({ changes: { from: 0, insert: 'X' } });
    view.dispatch({ changes: { from: 0, to: 1 } });
    plugin!.app.workspace.trigger('ir-highlights-changed', FILE_PATH);
    await settle();
    view.destroy();
    await settle();

    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(shown).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(plugin!.reviewManager!.updateSnippetOffsets).not.toHaveBeenCalled();
  });

  it("leaves pointers on its marks to the cell's editor, with the note's highlight extension and painter about", async () => {
    const table = '| a | b |\n| - | - |\n| cc | one two |';
    const at = 'Intro\n\n'.length + table.indexOf('one');
    const { plugin } = makeNote(table, [makeHighlight('h', at, at + 3)], {
      extensions: [widgetHighlightPainter],
    });
    const view = openCell(1, 1, 'one two', {
      extensions: [snippetHighlightExtension],
    });
    await settle();
    const mark = view.contentDOM.querySelector('.ir-snippet-highlight')!;
    expect(mark.textContent).toBe('one');
    // The cell's line, where none of the mark is: what the editor does there
    const line = view.contentDOM.querySelector('.cm-line')!;
    const press = (target: Element, type: string, button: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };

    // Not a primary mousedown: CodeMirror's own selection, which needs layout
    // jsdom lacks, and which no extension here sees before it
    for (const [type, button] of [
      ['pointerdown', 0],
      ['pointerdown', 1],
      ['mousedown', 1],
      ['click', 0],
      ['auxclick', 1],
    ] as const) {
      expect(press(mark, type, button), `${type} ${button}`).toBe(
        press(line, type, button)
      );
    }
    expect(plugin!.app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it('does nothing in a note’s own editor', async () => {
    const table = '| a | b |\n| - | - |\n| cc | dd |';
    const at = 'Intro\n\n'.length + table.indexOf('dd');
    const { note: view, plugin } = makeNote(
      table,
      [makeHighlight('h', 0, at + 2)],
      {
        extensions: [cellEditorHighlights],
      }
    );
    await settle();
    view.dispatch({ changes: { from: 0, insert: 'X' } });
    await settle();
    expect(view.plugin(cellEditorHighlights)!.decorations.size).toBe(0);
    expect(plugin!.app.workspace.on).not.toHaveBeenCalled();
  });

  it('reads none of the note as the cell is typed in, while the note has no highlights', async () => {
    makeNote('| a | b |\n| - | - |\n| cc | dd |', []);
    const view = openCell(1, 1, 'dd');
    await settle();
    const body = vi.spyOn(Obsidian, 'getBodyStartOffset');
    view.dispatch({ changes: { from: 0, insert: 'X' } });
    await settle();
    expect(body).not.toHaveBeenCalled();
    expect(marksOf(view)).toEqual(new Map());
  });

  it('marks nothing, and fails at nothing, out of a table cell or without a plugin or review manager', async () => {
    const table = '| a | b |\n| - | - |\n| cc | dd |';
    const highlight = makeHighlight('h', 0, 100);

    // In a cell of a table the note doesn't show as a widget of its own
    makeNote(table, [highlight]);
    const elsewhere = createDiv().createEl('table').insertRow().insertCell();
    document.body.append(elsewhere.closest('table')!);
    const stray = new EditorView({
      state: EditorState.create({
        doc: 'dd',
        extensions: [
          inCell.of(true),
          irPluginFacet.of(note!.state.facet(irPluginFacet) as never),
          cellEditorHighlights,
        ],
      }),
      parent: elsewhere,
    });
    cells.push(stray);
    // Not in a cell at all
    const loose = new EditorView({
      state: EditorState.create({
        doc: 'dd',
        extensions: [
          inCell.of(true),
          irPluginFacet.of(note!.state.facet(irPluginFacet) as never),
          cellEditorHighlights,
        ],
      }),
      parent: document.body.createDiv(),
    });
    cells.push(loose);
    await settle();
    expect(marksOf(stray)).toEqual(new Map());
    expect(marksOf(loose)).toEqual(new Map());

    // In a row the note's table doesn't have: the table reads otherwise
    makeNote(table, [highlight]);
    note!.contentDOM
      .querySelector('table')!
      .insertRow()
      .insertCell()
      .createDiv({ cls: 'table-cell-wrapper', text: 'dd' });
    const extra = openCell(2, 0, 'dd');
    await settle();
    expect(marksOf(extra)).toEqual(new Map());

    // In a note with no file
    makeNote(table, [highlight], { extensions: [fileless.of(true)] });
    const unsaved = openCell(1, 1, 'dd');
    await settle();
    expect(marksOf(unsaved)).toEqual(new Map());

    const noManager = makePlugin();
    noManager.reviewManager = null;
    makeNote(table, [highlight]);
    const without = openCell(1, 1, 'dd', { plugin: noManager });
    makeNote(table, [highlight], { plugin: null });
    const none = openCell(1, 1, 'dd');
    await settle();
    expect(marksOf(without)).toEqual(new Map());
    expect(marksOf(none)).toEqual(new Map());
  });

  it('stops listening once destroyed, and marks nothing after', async () => {
    const table = '| a | b |\n| - | - |\n| cc | dd |';
    const at = 'Intro\n\n'.length + table.indexOf('dd');
    const { plugin } = makeNote(table, [makeHighlight('h', at, at + 2)]);
    const view = openCell(1, 1, 'dd');
    await settle();
    expect(marksOf(view)).toEqual(new Map([['h', 'dd']]));
    const dispatch = vi.spyOn(view, 'dispatch');
    const [ref] = plugin!.app.workspace.on.mock.results.map(
      (r) => r.value as unknown
    );
    // Destroyed with a refresh queued, which would take its marks away
    plugin!.reviewManager!.snippets.offsetTracker.loadHighlights(FILE_PATH, []);
    plugin!.app.workspace.trigger('ir-highlights-changed', FILE_PATH);
    view.destroy();
    await settle();
    expect(plugin!.app.workspace.offref).toHaveBeenCalledExactlyOnceWith(ref);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('marks anew a highlight that changes for another in the same place', async () => {
    const table = '| a | b |\n| - | - |\n| cc | dd |';
    const at = 'Intro\n\n'.length + table.indexOf('dd');
    const { plugin } = makeNote(table, [makeHighlight('h', at, at + 2)]);
    const view = openCell(1, 1, 'dd');
    await settle();
    plugin!.reviewManager!.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight('k', at, at + 2),
    ]);
    plugin!.app.workspace.trigger('ir-highlights-changed', FILE_PATH);
    await settle();
    expect(marksOf(view)).toEqual(new Map([['k', 'dd']]));
  });

  it('dispatches nothing where its marks stay as they are, and reads the note once for many changes at once', async () => {
    const table = '| a | b |\n| - | - |\n| cc | one two |';
    const at = 'Intro\n\n'.length + table.indexOf('two');
    const { plugin } = makeNote(table, [makeHighlight('h', at, at + 3)]);
    const view = openCell(1, 1, 'one two');
    await settle();
    const dispatch = vi.spyOn(view, 'dispatch');
    const body = vi.spyOn(Obsidian, 'getBodyStartOffset');

    plugin!.app.workspace.trigger('ir-highlights-changed', FILE_PATH);
    plugin!.app.workspace.trigger('ir-highlights-changed', FILE_PATH);
    await settle();
    expect(dispatch).not.toHaveBeenCalled();
    expect(body).toHaveBeenCalledTimes(1);
    expect(marksOf(view)).toEqual(new Map([['h', 'two']]));
  });

  it('schedules nothing in a note’s own editor, nor for a cell editor’s cursor moves', async () => {
    const table = '| a | b |\n| - | - |\n| cc | dd |';
    const at = 'Intro\n\n'.length + table.indexOf('dd');
    const { note: own } = makeNote(table, [makeHighlight('h', at, at + 2)], {
      extensions: [cellEditorHighlights],
    });
    const view = openCell(1, 1, 'dd');
    await settle();
    const queued = vi.spyOn(globalThis, 'queueMicrotask');
    own.dispatch({ changes: { from: 0, insert: 'X' } });
    view.dispatch({ selection: { anchor: 1 } });
    expect(queued).not.toHaveBeenCalled();
  });
});
