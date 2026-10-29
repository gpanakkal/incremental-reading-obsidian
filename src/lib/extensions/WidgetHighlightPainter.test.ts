// @vitest-environment jsdom

import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from '#/lib/SnippetOffsetTracker';
import { gridArb, wordsArb } from '#/test/table-arbitraries';
import { EditorState, StateField, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import fc from 'fast-check';
import { Component, MarkdownRenderer } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { irPluginFacet } from './irPluginFacet';
import {
  asCell,
  paintKey,
  stripHighlights,
  tableCellSections,
  widgetHighlightPainter,
  widgetTargets,
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

/** A line's quote markers and callout marker, which render as no text. */
const QUOTE_PREFIX = /^[ \t]*(?:>[ \t]?)*(?:\[![^\]]*\][+-]?[ \t]*)?/;
const TABLE_SEPARATOR = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+$/;

/**
 * A model of Obsidian's renderer, enough for the notes made here: each line
 * a paragraph of its text, less a callout's markers, a table row's outer
 * pipes, and a table's separator row.
 */
function modelRender(markdown: string, into: HTMLElement) {
  for (const line of markdown.split('\n')) {
    if (TABLE_SEPARATOR.test(line)) continue;
    const text = line.startsWith('| ')
      ? line.slice(2, -2)
      : line.replace(QUOTE_PREFIX, '');
    into.createEl('p', { text });
  }
}

/** A callout widget as live preview draws one: its source, rendered. */
class CalloutWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: CalloutWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const widget = createDiv({ cls: 'cm-embed-block cm-callout' });
    modelRender(this.source, widget.createDiv({ cls: 'markdown-rendered' }));
    widget.createDiv({ cls: 'embed-actions', text: 'edit' });
    return widget;
  }
}

/** A table widget as live preview draws one: each cell's trimmed text. */
class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const widget = createDiv({
      cls: 'cm-embed-block cm-table-widget markdown-rendered',
    });
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

type Block = { kind: 'callout' | 'table' | 'text'; text: string };

/** Block widgets over the callout and table blocks of a note. */
function widgetsField(blocks: Block[], bodyStart: number) {
  const build = () => {
    const ranges: Range<Decoration>[] = [];
    let at = bodyStart;
    for (const { kind, text } of blocks) {
      if (kind !== 'text') {
        const widget =
          kind === 'callout' ? new CalloutWidget(text) : new TableWidget(text);
        ranges.push(
          Decoration.replace({ widget, block: true }).range(
            at,
            at + text.length
          )
        );
      }
      at += text.length + 2;
    }
    return Decoration.set(ranges);
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco) => deco,
    provide: (field) => EditorView.decorations.from(field),
  });
}

const noteOf = (frontmatter: string, blocks: Block[]) =>
  frontmatter + blocks.map(({ text }) => text).join('\n\n');

function makePlugin(tracker = new SnippetOffsetTracker()) {
  return {
    app: {
      workspace: { openLinkText: vi.fn() },
      vault: { getFileByPath: (path: string) => ({ path }) },
    },
    reviewManager: { snippets: { offsetTracker: tracker } } as {
      snippets: { offsetTracker: SnippetOffsetTracker };
    } | null,
    getOpenReviewLeaf: () => null,
  };
}

type FakePlugin = ReturnType<typeof makePlugin>;

/** A note's editor showing `blocks` as live preview does, painter and all. */
function makeView(
  frontmatter: string,
  blocks: Block[],
  highlights: SnippetHighlight[] = [],
  {
    plugin = makePlugin(),
    parent = document.body,
    path = FILE_PATH as string | null,
  }: {
    plugin?: FakePlugin | null;
    parent?: HTMLElement;
    path?: string | null;
  } = {}
) {
  vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({
    info: (path ? { file: { path } } : null) as never,
    editorView: null,
  });
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(
    async (_app, markdown, into) => modelRender(markdown, into)
  );
  plugin?.reviewManager?.snippets.offsetTracker.loadHighlights(
    FILE_PATH,
    highlights
  );
  const state = EditorState.create({
    doc: noteOf(frontmatter, blocks),
    extensions: [
      widgetsField(blocks, frontmatter.length),
      irPluginFacet.of(plugin as never),
      widgetHighlightPainter,
    ],
  });
  const view = new EditorView({ state, parent });
  views.push(view);
  return { view, plugin };
}

const views: EditorView[] = [];

/** Let every scheduled pass, and the renders it awaits, run. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Each highlight's painted text, by id, in document order. */
function paintedText(root: HTMLElement) {
  const texts = new Map<string, string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    // Each span it is in, nested ones too, paints it
    let span = node.parentElement?.closest<HTMLElement>(
      '.ir-snippet-highlight'
    );
    while (span && root.contains(span)) {
      const id = span.dataset.snippetId!;
      texts.set(id, (texts.get(id) ?? '') + node.textContent);
      span = span.parentElement?.closest<HTMLElement>('.ir-snippet-highlight');
    }
  }
  return texts;
}

const wordArb = fc.stringMatching(/^[a-z]{1,4}$/);

const calloutArb: fc.Arbitrary<Block> = fc
  .record({
    indent: fc.constantFrom('', ' ', '   '),
    kind: wordArb,
    fold: fc.constantFrom('', '+', '-'),
    title: fc.oneof(
      fc.constant(''),
      wordsArb.map((w) => ` ${w}`)
    ),
    lines: fc.array(
      fc.tuple(fc.constantFrom('> ', '>', '> > ', '   > '), wordsArb),
      { minLength: 1, maxLength: 3 }
    ),
  })
  .map(({ indent, kind, fold, title, lines }) => ({
    kind: 'callout',
    text: [
      `${indent}> [!${kind}]${fold}${title}`,
      ...lines.map(([markers, words]) => markers + words),
    ].join('\n'),
  }));

const tableBlockArb: fc.Arbitrary<Block> = gridArb.map(({ doc }) => ({
  kind: 'table',
  text: doc,
}));

const textArb: fc.Arbitrary<Block> = wordsArb.map((text) => ({
  kind: 'text',
  text,
}));

const frontmatterArb = fc.constantFrom('', '---\na: b\n---\n');

/** A note of paragraphs, callouts and tables, blank lines between them. */
const noteArb = fc.record({
  frontmatter: frontmatterArb,
  blocks: fc.array(fc.oneof(textArb, calloutArb, tableBlockArb), {
    minLength: 1,
    maxLength: 4,
  }),
});

/** Whether each character of a callout's source shows in its rendered text. */
function calloutVisible(source: string): boolean[] {
  return source.split('\n').flatMap((line, k, lines) => {
    const prefix = line.match(QUOTE_PREFIX)![0].length;
    const shown = Array.from(line, (_, i) => i >= prefix);
    return k < lines.length - 1 ? [...shown, false] : shown;
  });
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// #endregion

describe('tableCellSections', () => {
  it("gives each cell of each shown row its text between pipes, trimmed, where it is in the note's body", () => {
    fc.assert(
      fc.property(
        gridArb,
        fc.integer({ min: 0, max: 1000 }),
        ({ doc, lines }, bodyOffset) => {
          const expected = lines
            .filter((_, k) => k !== 1)
            .map(({ cells }) =>
              cells.map(({ start, end }) => {
                const raw = doc.slice(start, end);
                const lead = raw.length - raw.replace(/^[ \t]+/, '').length;
                return {
                  source: raw.replace(/^[ \t]+|[ \t]+$/g, ''),
                  bodyOffset: bodyOffset + start + lead,
                };
              })
            );
          expect(tableCellSections(doc, bodyOffset)).toEqual(expected);
        }
      )
    );
  });

  it('places each cell at its own text, whatever space other than spaces and tabs it starts or ends with', () => {
    fc.assert(
      fc.property(
        gridArb,
        fc.constantFrom('\u00a0', '\u3000', '\u2003'),
        fc.integer({ min: 0, max: 1000 }),
        ({ doc, lines }, space, bodyOffset) => {
          // Each cell's text, wrapped in a space a table pads no cell with
          const wrapped = lines
            .flatMap(({ cells }) => cells)
            .reduceRight(
              (text, { start, end }) =>
                text.slice(0, start) +
                text
                  .slice(start, end)
                  .replace(
                    /^([ \t]*)(.*?)([ \t]*)$/,
                    `$1${space}$2${space}$3`
                  ) +
                text.slice(end),
              doc
            );
          const sections = tableCellSections(wrapped, bodyOffset).flat();
          expect(sections.length).toBeGreaterThan(0);
          for (const { source, bodyOffset: at } of sections) {
            expect(source.startsWith(space)).toBe(true);
            expect(source.endsWith(space)).toBe(true);
            expect(
              wrapped.slice(at - bodyOffset, at - bodyOffset + source.length)
            ).toBe(source);
          }
        }
      )
    );
  });

  it('reads a row of a lone pipe as one empty cell', () => {
    expect(tableCellSections('| a |\n| - |\n|\n  |  ', 0)).toEqual([
      [{ source: 'a', bodyOffset: 2 }],
      [{ source: '', bodyOffset: 13 }],
      [{ source: '', bodyOffset: 19 }],
    ]);
  });
});

describe('asCell', () => {
  it("puts a cell's text in a table of its own, anything after its line after the table", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes('\n')),
        fc.option(
          fc.string().map((s) => `\n${s}`),
          { nil: '' }
        ),
        (cell, rest) => {
          expect(asCell(cell + rest)).toBe(`| ${cell} |\n| - |${rest}`);
        }
      )
    );
  });
});

describe('paintKey', () => {
  const sectionArb = fc.record({
    source: fc.string({ minLength: 1, maxLength: 20 }),
    bodyOffset: fc.integer({ min: 0, max: 100 }),
  });
  const highlightArb = fc
    .tuple(
      fc.integer({ min: 0, max: 140 }),
      fc.integer({ min: 0, max: 140 }),
      fc.constantFrom('h1', 'h2')
    )
    .map(([a, b, id]) => makeHighlight(id, Math.min(a, b), Math.max(a, b)));

  it('is the same for highlights that paint the section alike, and differs otherwise', () => {
    fc.assert(
      fc.property(
        sectionArb,
        fc.array(highlightArb, { maxLength: 3 }),
        fc.integer({ min: -50, max: 50 }),
        (section, highlights, shift) => {
          const { source, bodyOffset } = section;
          const shown = (h: SnippetHighlight) => {
            const start = Math.max(h.start_offset - bodyOffset, 0);
            const end = Math.min(h.end_offset - bodyOffset, source.length);
            return start < end ? [h.id, h.reference, start, end] : null;
          };
          // Moved with the section, the highlights paint it the same
          const moved = highlights.map((h) =>
            makeHighlight(h.id, h.start_offset + shift, h.end_offset + shift)
          );
          expect(
            paintKey({ source, bodyOffset: bodyOffset + shift }, moved)
          ).toBe(paintKey(section, highlights));
          // Those out of the section count for nothing
          expect(paintKey(section, highlights)).toBe(
            paintKey(
              section,
              highlights.filter((h) => shown(h) !== null)
            )
          );
          // Any that shows anew paints it differently, as does other text
          const extra = makeHighlight('h3', bodyOffset, bodyOffset + 1);
          expect(paintKey(section, [...highlights, extra])).not.toBe(
            paintKey(section, highlights)
          );
          expect(
            paintKey({ ...section, source: `${source}x` }, highlights)
          ).not.toBe(paintKey(section, highlights));
        }
      )
    );
  });

  it('tells highlights apart by their snippet and by where they cover', () => {
    const section = { source: 'abcdef', bodyOffset: 10 };
    const key = paintKey(section, [makeHighlight('h1', 11, 13)]);
    expect(paintKey(section, [makeHighlight('h2', 11, 13)])).not.toBe(key);
    expect(
      paintKey(section, [{ ...makeHighlight('h1', 11, 13), reference: 'x' }])
    ).not.toBe(key);
    expect(paintKey(section, [makeHighlight('h1', 12, 13)])).not.toBe(key);
    expect(paintKey(section, [makeHighlight('h1', 11, 14)])).not.toBe(key);
    // Cut to the section at either end
    expect(paintKey(section, [makeHighlight('h1', 0, 13)])).toBe(
      paintKey(section, [makeHighlight('h1', 10, 13)])
    );
    expect(paintKey(section, [makeHighlight('h1', 11, 99)])).toBe(
      paintKey(section, [makeHighlight('h1', 11, 16)])
    );
  });
});

describe('stripHighlights', () => {
  it("takes the spans out, their text whole again, and leaves an embed's and a cell editor's alone", () => {
    const el = createDiv();
    const embedded =
      '<div class="internal-embed"><span class="ir-snippet-highlight">e</span></div>';
    // A cell being edited: its editor's marks are that editor's to draw
    const cellEditor =
      '<div class="cm-editor"><span class="ir-snippet-highlight">f</span></div>';
    el.innerHTML =
      '<p>a<span class="ir-snippet-highlight">b<span class="ir-snippet-highlight">c</span></span>d</p>' +
      embedded +
      cellEditor;
    stripHighlights(el);
    expect(el.innerHTML).toBe('<p>abcd</p>' + embedded + cellEditor);
    expect(el.querySelector('p')!.childNodes).toHaveLength(1);

    // In an embed itself, its spans are its own
    const embed = createDiv({ cls: 'internal-embed' });
    const inner = embed.createDiv();
    inner.innerHTML = '<p>a<span class="ir-snippet-highlight">b</span></p>';
    stripHighlights(inner);
    expect(inner.innerHTML).toBe('<p>ab</p>');
  });
});

describe('widgetTargets', () => {
  it("finds each callout's and each table cell's rendered text, with the part of the note it shows", () => {
    fc.assert(
      fc.property(noteArb, ({ frontmatter, blocks }) => {
        const { view } = makeView(frontmatter, blocks);
        const targets = widgetTargets(view, frontmatter.length);

        const expected: { text: string; source: string; bodyOffset: number }[] =
          [];
        let at = 0;
        for (const { kind, text } of blocks) {
          if (kind === 'callout') {
            const el = createDiv();
            modelRender(text, el);
            expected.push({
              text: el.textContent,
              source: text,
              bodyOffset: at,
            });
          } else if (kind === 'table') {
            for (const row of tableCellSections(text, at)) {
              for (const section of row) {
                expected.push({ text: section.source, ...section });
              }
            }
          }
          at += text.length + 2;
        }
        expect(
          targets.map(({ el, section }) => ({
            text: el.textContent,
            ...section,
          }))
        ).toEqual(expected);
        expect(targets.map(({ cell }) => cell)).toEqual(
          blocks.flatMap(({ kind, text }) =>
            kind === 'callout'
              ? [false]
              : kind === 'table'
                ? tableCellSections(text, 0)
                    .flat()
                    .map(() => true)
                : []
          )
        );
        view.destroy();
      })
    );
  });

  it('skips a cell being edited, a table it reads otherwise than the note, and lines no callout starts', () => {
    const table = '| a | b |\n| - | - |\n| c | d |';
    const { view } = makeView('', [
      { kind: 'table', text: table },
      { kind: 'text', text: 'x' },
    ]);
    const cells = view.contentDOM.querySelectorAll('td');
    cells[0].createDiv({ cls: 'table-cell-wrapper' }).createDiv({
      cls: 'cm-editor',
    });
    expect(widgetTargets(view, 0).map(({ el }) => el.textContent)).toEqual([
      'a',
      'b',
      'd',
    ]);
    // A row more than the note has
    view.contentDOM.querySelector('tbody')!.insertRow();
    expect(widgetTargets(view, 0)).toEqual([]);
  });

  it('skips a callout widget over lines that are no quote, and one past its body', () => {
    // A callout widget drawn over a paragraph, as no callout would be
    const blocks: Block[] = [{ kind: 'callout', text: 'not > a quote' }];
    const { view } = makeView('', blocks);
    expect(widgetTargets(view, 0)).toEqual([]);
    const { view: inFrontmatter } = makeView('', [
      { kind: 'callout', text: '> [!note]\n> a' },
    ]);
    expect(widgetTargets(inFrontmatter, 1)).toEqual([]);
  });

  it("skips a widget whose rendered block is missing, and another editor's", () => {
    const { view } = makeView('', [
      { kind: 'callout', text: '> [!note]\n> a' },
      { kind: 'text', text: 'x' },
      { kind: 'table', text: '| a |\n| - |' },
    ]);
    view.contentDOM.querySelector('.markdown-rendered')!.remove();
    view.contentDOM.querySelector('table')!.remove();
    expect(widgetTargets(view, 0)).toEqual([]);

    // A callout of a nested editor's, inside this one's DOM
    const { view: nested } = makeView('', [
      { kind: 'callout', text: '> [!note]\n> a' },
    ]);
    const { view: host } = makeView('', [
      { kind: 'callout', text: '> [!note]\n> b' },
    ]);
    host.contentDOM.append(nested.dom);
    expect(widgetTargets(host, 0).map(({ el }) => el.textContent)).toEqual([
      'b',
    ]);
    expect(widgetTargets(nested, 0)).toHaveLength(1);
  });
});

describe('widgetHighlightPainter', () => {
  it("paints each highlight's shown text in the callouts, and only that, however often it runs", async () => {
    await fc.assert(
      fc.asyncProperty(
        frontmatterArb,
        fc.array(fc.oneof(textArb, calloutArb), { minLength: 1, maxLength: 3 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 3 }),
        async (frontmatter, blocks, picks) => {
          const body = noteOf('', blocks);
          // Where each callout's first line, with its marker, is
          const firstLines: [number, number][] = [];
          let at = 0;
          for (const { kind, text } of blocks) {
            const end = text.indexOf('\n');
            if (kind === 'callout') firstLines.push([at, at + end]);
            at += text.length + 2;
          }
          // Anywhere but inside a callout's marker or title, whose text a
          // marker there would no longer read as a callout's
          const place = (offset: number) => {
            const line = firstLines.find(([s, e]) => s < offset && offset < e);
            return line ? line[1] : offset;
          };
          const highlights = picks.flatMap(([a, b], i) => {
            const start = place(a % body.length);
            const end = place(start + 1 + (b % (body.length - start)));
            return start < end ? [makeHighlight(`h${i}`, start, end)] : [];
          });
          const { view } = makeView(frontmatter, blocks, highlights);
          await settle();

          const expected = new Map<string, string>();
          at = 0;
          for (const { kind, text } of blocks) {
            if (kind === 'callout') {
              const visible = calloutVisible(text);
              for (const h of highlights) {
                const from = Math.max(h.start_offset - at, 0);
                const to = Math.min(h.end_offset - at, text.length);
                let shown = '';
                for (let i = from; i < to; i++)
                  if (visible[i]) shown += text[i];
                if (shown)
                  expected.set(h.id, (expected.get(h.id) ?? '') + shown);
              }
            }
            at += text.length + 2;
          }
          expect(paintedText(view.contentDOM)).toEqual(expected);
          const html = view.contentDOM.innerHTML;
          view.dispatch({});
          await settle();
          expect(view.contentDOM.innerHTML).toBe(html);
          view.destroy();
        }
      ),
      { numRuns: 25 }
    );
  });

  it("paints a highlight in a cell's shown text, cut to each cell it spans", async () => {
    await fc.assert(
      fc.asyncProperty(gridArb, fc.nat(), fc.nat(), async ({ doc }, a, b) => {
        const start = a % doc.length;
        const end = start + 1 + (b % (doc.length - start));
        const { view } = makeView(
          '',
          [{ kind: 'table', text: doc }],
          [makeHighlight('h', start, end)]
        );
        await settle();
        const cells = Array.from(
          view.contentDOM.querySelectorAll<HTMLElement>('th, td')
        );
        const sections = tableCellSections(doc, 0).flat();
        sections.forEach(({ source, bodyOffset }, i) => {
          const from = Math.max(start - bodyOffset, 0);
          const to = Math.min(end - bodyOffset, source.length);
          const shown = from < to ? source.slice(from, to) : '';
          expect(paintedText(cells[i]).get('h') ?? '').toBe(shown);
        });
        view.destroy();
      }),
      { numRuns: 25 }
    );
  });

  it('paints anew when highlights change, and takes them away when they go', async () => {
    const callout = '> [!note]\n> one two three';
    const { view, plugin } = makeView(
      '',
      [{ kind: 'callout', text: callout }],
      [makeHighlight('h1', 12, 15)]
    );
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h1', 'one']]));

    const tracker = plugin!.reviewManager!.snippets.offsetTracker;
    tracker.loadHighlights(FILE_PATH, [makeHighlight('h2', 16, 19)]);
    view.dispatch({});
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h2', 'two']]));

    tracker.loadHighlights(FILE_PATH, []);
    view.dispatch({});
    await settle();
    expect(view.contentDOM.querySelector('.ir-snippet-highlight')).toBeNull();
    expect(
      view.contentDOM.querySelector('p:last-child')!.childNodes
    ).toHaveLength(1);
  });

  it("reads no widget of a note with no highlights, as it's typed in, until it has some", async () => {
    const table = '| a | bb |\n| - | - |\n| cc | dd |';
    const { view, plugin } = makeView('', [
      { kind: 'text', text: 'x' },
      { kind: 'table', text: table },
    ]);
    await settle();
    const read = vi.spyOn(view, 'posAtDOM');
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\ny' } });
    await settle();
    expect(read).not.toHaveBeenCalled();

    // Past the text block's 'x\n\n'
    const at = 3 + table.indexOf('dd');
    plugin!.reviewManager!.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight('h', at, at + 2),
    ]);
    view.dispatch({});
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h', 'dd']]));
  });

  it('follows the note as an edit before a widget moves it', async () => {
    const callout = '> [!note]\n> one two';
    const { view, plugin } = makeView(
      '',
      [
        { kind: 'text', text: 'x' },
        { kind: 'callout', text: callout },
      ],
      [makeHighlight('h1', 15, 18)]
    );
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h1', 'one']]));
    // The tracker moves the highlight with the text; the widget stays
    plugin!.reviewManager!.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight('h1', 16, 19),
    ]);
    view.dispatch({ changes: { from: 0, insert: 'y' } });
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h1', 'one']]));
  });

  it('paints a cell once it is no longer edited, and again once its text is rendered anew', async () => {
    const table = '| a | bb |\n| - | - |\n| cc | dd |';
    const { view } = makeView(
      '',
      [{ kind: 'table', text: table }],
      [makeHighlight('h', table.indexOf('dd'), table.indexOf('dd') + 1)]
    );
    const cell = () => view.contentDOM.querySelectorAll('td')[1];
    await settle();
    expect(paintedText(cell()).get('h')).toBe('d');

    // Being edited: its text is hidden and its editor beside it
    const editor = cell().createDiv({ cls: 'table-cell-wrapper' });
    editor.createDiv({ cls: 'cm-editor' });
    const content = cell().firstElementChild as HTMLElement;
    content.textContent = 'dd';
    await settle();
    expect(paintedText(cell()).get('h')).toBeUndefined();

    editor.remove();
    await settle();
    expect(paintedText(cell()).get('h')).toBe('d');

    // Rendered anew in place, as Obsidian does a cell whose text changed
    content.textContent = 'dd';
    await settle();
    expect(paintedText(cell()).get('h')).toBe('d');
  });

  it('opens the snippet on a click or middle click on a painted highlight, and lets other clicks be', async () => {
    const { view, plugin } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', 12, 15)]
    );
    await settle();
    const span = view.contentDOM.querySelector<HTMLElement>(
      '.ir-snippet-highlight'
    )!;
    const open = plugin!.app.workspace.openLinkText;

    const down = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    // Before the widget's own handlers, which would start editing a cell
    const seenPrevented: boolean[] = [];
    span.parentElement!.addEventListener('pointerdown', (event) =>
      seenPrevented.push(event.defaultPrevented)
    );
    span.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(seenPrevented).toEqual([true]);
    const middleDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    span.dispatchEvent(middleDown);
    expect(middleDown.defaultPrevented).toBe(true);
    const rightDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    span.dispatchEvent(rightDown);
    expect(rightDown.defaultPrevented).toBe(false);

    // Nothing past the editor hears it: the widget would enter the callout
    const heard = vi.fn();
    span.parentElement!.addEventListener('click', heard);
    span.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenLastCalledWith('snippets/h1.md', '', false);
    expect(heard).not.toHaveBeenCalled();

    const heardAux = vi.fn();
    span.parentElement!.addEventListener('auxclick', heardAux);
    span.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(heardAux).not.toHaveBeenCalled();
    span.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    );
    expect(open).toHaveBeenCalledTimes(2);

    // Not on a highlight, or on one out of any widget: not the painter's
    const plain = view.contentDOM.querySelector('.markdown-rendered p')!;
    const plainDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    plain.dispatchEvent(plainDown);
    plain.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(plainDown.defaultPrevented).toBe(false);
    const outside = view.contentDOM.createSpan({ cls: 'ir-snippet-highlight' });
    outside.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("leaves a highlight of a nested editor's to that editor", async () => {
    const { view: host, plugin } = makeView('', [
      { kind: 'callout', text: '> [!note]\n> one two' },
    ]);
    await settle();
    const rendered = host.contentDOM.querySelector('.markdown-rendered')!;
    const nested = rendered.createDiv({ cls: 'cm-editor' });
    const span = nested.createSpan({ cls: 'ir-snippet-highlight' });
    span.setAttribute('data-snippet-ref', 'snippets/x.md');
    span.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(plugin!.app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it('does nothing in an editor nested in another', async () => {
    const outer = document.body.createDiv({ cls: 'cm-editor' });
    const { view, plugin } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one' }],
      [makeHighlight('h1', 12, 15)],
      { parent: outer }
    );
    view.dispatch({});
    await settle();
    expect(view.contentDOM.querySelector('.ir-snippet-highlight')).toBeNull();
    // Nor opens one painted in it
    const span = view.contentDOM
      .querySelector('.markdown-rendered')!
      .createSpan({ cls: 'ir-snippet-highlight' });
    span.setAttribute('data-snippet-ref', 'snippets/h1.md');
    span.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(plugin!.app.workspace.openLinkText).not.toHaveBeenCalled();
    view.destroy();
  });

  it("leaves the highlights of a cell's editor, built apart and then put in the cell, to that editor", async () => {
    const table = '| a | bb |\n| - | - |\n| cc | dd |';
    const { view: host } = makeView('', [{ kind: 'table', text: table }]);
    await settle();
    // As Obsidian's `editTableCell` does: built in a detached wrapper, so it
    // can't tell yet it is nested, then put in the cell
    const wrapper = document.createElement('div');
    wrapper.className = 'table-cell-wrapper';
    const { view: cellEditor, plugin } = makeView(
      '',
      [{ kind: 'text', text: 'dd' }],
      [],
      { parent: wrapper }
    );
    host.contentDOM.querySelectorAll('td')[1].append(wrapper);
    // A highlight's mark, as the cell editor's own highlight extension draws
    const mark = cellEditor.contentDOM
      .querySelector('.cm-line')!
      .createSpan({ cls: 'ir-snippet-highlight' });
    mark.setAttribute('data-snippet-ref', 'snippets/h.md');

    const down = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    mark.dispatchEvent(down);
    // Its cursor goes where the mark was pressed, as anywhere in the editor
    expect(down.defaultPrevented).toBe(false);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    mark.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(plugin!.app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it('paints nothing, and fails at nothing, with no plugin, review manager or file', async () => {
    const error = vi.spyOn(console, 'error');
    for (const options of [
      { plugin: null },
      { plugin: { ...makePlugin(), reviewManager: null } },
      { path: null },
    ]) {
      const { view } = makeView(
        '',
        [{ kind: 'callout', text: '> [!note]\n> one' }],
        [makeHighlight('h1', 12, 15)],
        { plugin: makePlugin(), ...options }
      );
      view.dispatch({});
      await settle();
      expect(view.contentDOM.querySelector('.ir-snippet-highlight')).toBeNull();
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("paints no highlight the editor wouldn't show: one starting before the note's body", async () => {
    const { view } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', -5, 15), makeHighlight('h2', 16, 19)]
    );
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h2', 'two']]));
  });

  it('paints in one pass however many changes come at once, and unloads what it rendered with', async () => {
    const unload = vi.spyOn(Component.prototype, 'unload');
    const load = vi.spyOn(Component.prototype, 'load');
    const { view } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', 12, 15)]
    );
    await settle();
    const passes = vi.spyOn(Obsidian, 'getFileInfoFromState');
    passes.mockClear();
    view.dispatch({});
    view.dispatch({});
    view.dispatch({});
    await settle();
    expect(passes).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalled();
    expect(unload).toHaveBeenCalledTimes(load.mock.calls.length);
  });

  it('paints again what changed while it was painting', async () => {
    let release = () => {};
    const { view, plugin } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', 12, 15)]
    );
    vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(
      async (_app, markdown, into) => {
        await new Promise<void>((resolve) => (release = resolve));
        modelRender(markdown, into);
      }
    );
    await settle();
    plugin!.reviewManager!.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight('h2', 16, 19),
    ]);
    view.dispatch({});
    await settle();
    release();
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h2', 'two']]));
  });

  it('leaves nothing painted when destroyed mid-pass, or with a pass about to run', async () => {
    let release = () => {};
    const { view } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', 12, 15)]
    );
    vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(
      async (_app, markdown, into) => {
        await new Promise<void>((resolve) => (release = resolve));
        modelRender(markdown, into);
      }
    );
    await settle();
    const widget = view.contentDOM.querySelector<HTMLElement>('.cm-callout')!;
    view.destroy();
    release();
    await settle();
    expect(widget.querySelector('.ir-snippet-highlight')).toBeNull();

    const { view: queued } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', 12, 15)]
    );
    const queuedWidget =
      queued.contentDOM.querySelector<HTMLElement>('.cm-callout')!;
    queued.destroy();
    await settle();
    expect(queuedWidget.querySelector('.ir-snippet-highlight')).toBeNull();
  });

  it('takes its spans away and stops when destroyed', async () => {
    const { view, plugin } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', 12, 15)]
    );
    await settle();
    const widget = view.contentDOM.querySelector<HTMLElement>('.cm-callout')!;
    view.destroy();
    expect(widget.querySelector('.ir-snippet-highlight')).toBeNull();

    // Neither painting nor opening anything after
    widget.querySelector('p:last-child')!.textContent = 'one two';
    await settle();
    expect(widget.querySelector('.ir-snippet-highlight')).toBeNull();
    const span = widget.createSpan({ cls: 'ir-snippet-highlight' });
    span.setAttribute('data-snippet-ref', 'snippets/h1.md');
    view.contentDOM.append(widget);
    span.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    span.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    );
    const down = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    span.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(plugin!.app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it('logs a pass that fails, and paints on after', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { view } = makeView(
      '',
      [{ kind: 'callout', text: '> [!note]\n> one two' }],
      [makeHighlight('h1', 12, 15)]
    );
    vi.spyOn(MarkdownRenderer, 'render').mockRejectedValueOnce(new Error('x'));
    await settle();
    expect(error).toHaveBeenCalled();
    view.dispatch({});
    await settle();
    expect(paintedText(view.contentDOM)).toEqual(new Map([['h1', 'one']]));
  });
});
