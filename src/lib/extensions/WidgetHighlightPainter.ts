import { openBlockAtEnd } from '#/lib/block-delimiters';
import {
  clearMath,
  displayMath,
  mathMarkCount,
  paintMath,
  paintSectionMath,
  type MathHighlight,
  type MathSpan,
  type RenderMath,
} from '#/lib/math-highlights';
import { isNestedEditor } from '#/lib/nested-editor';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  paintSectionHighlights,
  type ReadingSection,
  type RenderSection,
} from '#/lib/reading-highlights';
import type { SnippetHighlight } from '#/lib/SnippetOffsetTracker';
import {
  ViewPlugin,
  type EditorView,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import {
  Component,
  MarkdownRenderer,
  editorInfoField,
  finishRenderMath,
  renderMath,
} from 'obsidian';
import { irPluginFacet } from './irPluginFacet';
import {
  MIDDLE_MOUSE_BUTTON,
  openHighlightFromEvent,
} from './SnippetHighlightExtension';

const HIGHLIGHT = '.ir-snippet-highlight';

/*
 * Undocumented (seen in Obsidian 1.14.5): live preview draws a callout and a
 * table the cursor is out of as block widgets in place of their lines,
 *   div.cm-embed-block.cm-callout > div.markdown-rendered > div.callout…
 *   div.cm-embed-block.cm-table-widget > div.table-wrapper > table
 * so the marks of the editor's own highlights over those lines are never
 * drawn. A table cell holds its rendered text in a div.table-cell-wrapper,
 * hidden while the cell is being edited, when a second div.table-cell-wrapper
 * holds the cell's own nested editor.
 */
const CALLOUT_WIDGET = '.cm-embed-block.cm-callout';
const TABLE_WIDGET = '.cm-embed-block.cm-table-widget';
const WIDGET = `${CALLOUT_WIDGET}, ${TABLE_WIDGET}`;
const CELL_CONTENT = 'table-cell-wrapper';
/*
 * Undocumented (seen in Obsidian 1.14.5): `$$ … $$` math the cursor is out
 * of is a widget, div.math.math-block.cm-embed-block, over the lines from one
 * `$$` to the other, holding MathJax's rendering of the TeX between them and
 * the widget's edit button. A click on it puts the cursor in the math.
 */
const MATH_WIDGET = '.cm-embed-block.math-block';
const ANY_WIDGET = `${WIDGET}, ${MATH_WIDGET}`;
/** A highlight span in a widget: one painted, or a cell editor's mark */
const PAINTED = `${CALLOUT_WIDGET} ${HIGHLIGHT}, ${TABLE_WIDGET} ${HIGHLIGHT}, ${MATH_WIDGET} ${HIGHLIGHT}`;

/** Draw TeX as `$$ … $$` math is drawn. */
const renderDisplayMath: RenderMath = (tex) => renderMath(tex, true);

/** A widget's rendered text, and the part of the note it was rendered from. */
export interface WidgetTarget {
  el: HTMLElement;
  section: ReadingSection;
  /** Whether it is a table cell's, rendered as one */
  cell: boolean;
}

/**
 * Where the cells of a table row lie in it: cell `i` between bound `i` and
 * bound `i + 1`, each an unescaped pipe's offset, or, at a side of the row
 * with no pipe, where its text starts (less one) or ends.
 *
 * TODO(0213 merge): `cellBounds` in `#/lib/block-delimiters` (task 0210) is
 * this for a row of a whole note; export it and use it here instead.
 */
function cellBoundsOf(line: string): number[] {
  const pipes = Array.from(line.matchAll(/(?<!\\)\|/g), ({ index }) => index);
  const lead = /^\s*\|/.test(line);
  // A row of one pipe has it at its start only
  const trail = pipes.length > (lead ? 1 : 0) && /(?<!\\)\|\s*$/.test(line);
  return [...(lead ? [] : [-1]), ...pipes, ...(trail ? [] : [line.length])];
}

/**
 * The cells of a table whose text is `text`, starting at `bodyOffset` in the
 * note's body, row by row as the table shows them (its separator row left
 * out): each the text between its pipes, less the spaces and tabs around
 * it.
 */
export function tableCellSections(
  text: string,
  bodyOffset: number
): ReadingSection[][] {
  const rows: ReadingSection[][] = [];
  let lineStart = 0;
  text.split('\n').forEach((line, k) => {
    if (k !== 1) {
      const bounds = cellBoundsOf(line);
      rows.push(
        bounds.slice(1).map((end, i) => {
          const start = bounds[i] + 1;
          // Padded with spaces and tabs only: any other space, as a
          // no-break one, is the cell's own text, there and in its editor
          const [, lead, source] = /^([ \t]*)(.*?)[ \t]*$/.exec(
            line.slice(start, end)
          )!;
          return {
            source,
            bodyOffset: bodyOffset + lineStart + start + lead.length,
          };
        })
      );
    }
    lineStart += line.length + 1;
  });
  return rows;
}

/** Render a table cell's markdown as Obsidian renders a cell's text alone. */
export function asCell(markdown: string): string {
  // Whatever follows the cell's own line (footnote definitions) goes after
  // the table, where it would have ended the cell
  const cut = markdown.indexOf('\n');
  const own = cut < 0 ? markdown : markdown.slice(0, cut);
  const rest = cut < 0 ? '' : markdown.slice(cut);
  return `| ${own} |\n| - |${rest}`;
}

/**
 * The note's lines a widget replaces: CodeMirror's block for it. A position
 * inside the widget's DOM can land anywhere in those lines, not only at
 * their start, so the block is looked up rather than the position trusted.
 */
function widgetRange(view: EditorView, widget: HTMLElement) {
  // Never throws for a node in `contentDOM`, which CodeMirror's views hold
  return view.lineBlockAt(view.posAtDOM(widget));
}

/** The rendered text of `cell`, unless the cell is being edited. */
function cellContent(cell: HTMLElement): HTMLElement | null {
  // Its editor shows its text as the note has it, with the editor's marks
  if (cell.querySelector('.cm-editor')) return null;
  return (
    Array.from(cell.children).find((child): child is HTMLElement =>
      child.classList.contains(CELL_CONTENT)
    ) ?? null
  );
}

/**
 * A table widget's cells, each with its source: none of a table it reads
 * otherwise than the note does.
 */
function tableCells(
  widget: HTMLElement,
  text: string,
  bodyOffset: number
): { cell: HTMLTableCellElement; section: ReadingSection }[] {
  const table = widget.querySelector('table');
  if (!table) return [];
  const sections = tableCellSections(text, bodyOffset);
  const rows = Array.from(table.rows);
  // Rows it reads unlike the note does: none can be placed
  if (rows.length !== sections.length) return [];
  return rows.flatMap((row, r) =>
    Array.from(row.cells).flatMap((cell, c) => {
      const section = sections[r][c];
      return section ? [{ cell, section }] : [];
    })
  );
}

/** A table widget's cells' rendered texts, each with its cell's source. */
function tableTargets(
  widget: HTMLElement,
  text: string,
  bodyOffset: number
): WidgetTarget[] {
  return tableCells(widget, text, bodyOffset).flatMap(({ cell, section }) => {
    const el = cellContent(cell);
    return el ? [{ el, section, cell: true }] : [];
  });
}

/** The widgets `view` shows of its own note, none a nested editor's. */
function ownWidgets(view: EditorView, selector: string): HTMLElement[] {
  return Array.from(
    view.contentDOM.querySelectorAll<HTMLElement>(selector)
  ).filter((widget) => widget.closest('.cm-editor') === view.dom);
}

/**
 * The part of the note `cell`, a cell of a table widget `view` shows, holds:
 * its text between pipes, trimmed, where it is in the note's body, which
 * starts at `bodyStart`. Null for a cell of no such widget, one before the
 * body, or one the table reads otherwise than the note does.
 */
export function cellSection(
  view: EditorView,
  cell: HTMLTableCellElement,
  bodyStart: number
): ReadingSection | null {
  const widget = ownWidgets(view, TABLE_WIDGET).find((own) =>
    own.contains(cell)
  );
  if (!widget) return null;
  const range = widgetRange(view, widget);
  if (range.from < bodyStart) return null;
  const text = view.state.doc.sliceString(range.from, range.to);
  return (
    tableCells(widget, text, range.from - bodyStart).find(
      (found) => found.cell === cell
    )?.section ?? null
  );
}

/**
 * The rendered texts of the callout and table widgets `view` shows of its
 * note's body, which starts at `bodyStart`; none of a nested editor's.
 */
export function widgetTargets(
  view: EditorView,
  bodyStart: number
): WidgetTarget[] {
  return ownWidgets(view, WIDGET).flatMap((widget) => {
    const range = widgetRange(view, widget);
    if (range.from < bodyStart) return [];
    const text = view.state.doc.sliceString(range.from, range.to);
    const bodyOffset = range.from - bodyStart;
    if (!widget.matches(CALLOUT_WIDGET)) {
      return tableTargets(widget, text, bodyOffset);
    }
    const el = Array.from(widget.children).find((child): child is HTMLElement =>
      child.classList.contains('markdown-rendered')
    );
    return el && /^\s*>/.test(text)
      ? [{ el, section: { source: text, bodyOffset }, cell: false }]
      : [];
  });
}

/** A math widget, with its TeX and where that starts in the note's body. */
export interface MathTarget {
  el: HTMLElement;
  tex: string;
  bodyOffset: number;
}

/**
 * The `$$ … $$` math widgets `view` shows of its note's body, which starts
 * at `bodyStart`, each over lines of one formula; none of a nested editor's.
 */
export function mathTargets(view: EditorView, bodyStart: number): MathTarget[] {
  const { doc } = view.state;
  return ownWidgets(view, MATH_WIDGET).flatMap((el) => {
    const range = widgetRange(view, el);
    const text = doc.sliceString(range.from, range.to);
    const spans = displayMath(text);
    const span =
      spans.length === 1
        ? {
            texStart: range.from + spans[0].texStart,
            texEnd: range.from + spans[0].texEnd,
          }
        : spans.length === 0
          ? previewedMath(doc.toString(), range.to)
          : null;
    if (!span) return [];
    return [
      {
        el,
        tex: doc.sliceString(span.texStart, span.texEnd),
        bodyOffset: span.texStart - bodyStart,
      },
    ];
  });
}

/**
 * The TeX of the math whose closing `$$` ends at `at` in `doc`, where
 * Obsidian draws its preview while the cursor is in it (see
 * {@link MATH_WIDGET}); null if no top-level math closes there.
 *
 * Read line by line as the metadata cache reads math blocks (see
 * `openBlockAtEnd`): math opens on a line starting with `$$` and holds no
 * other `$$` until it closes. Math in a quote or callout opens on no such
 * line, so its preview finds none.
 */
function previewedMath(doc: string, at: number): MathSpan | null {
  if (doc.slice(at - 2, at) !== '$$') return null;
  const before = doc.slice(0, at - 2);
  if (openBlockAtEnd(before) !== 'math') return null;
  return { texStart: openerEnd(before), texEnd: at - 2 };
}

/**
 * The end of the last `$$` in `text` that no backslash escapes: the editor's
 * TeX mode reads `\$` as a dollar sign, which closes nothing.
 */
function openerEnd(text: string): number {
  let at = text.lastIndexOf('$$');
  for (;;) {
    let slashes = 0;
    while (text[at - 1 - slashes] === '\\') slashes += 1;
    if (slashes % 2 === 0) return at + 2;
    at = text.lastIndexOf('$$', at - 1);
  }
}

/** The parts of `highlights` in a formula of TeX `tex` at `bodyOffset`. */
function mathHighlights(
  { tex, bodyOffset }: MathTarget,
  highlights: readonly SnippetHighlight[]
): MathHighlight[] {
  return highlights.flatMap((highlight) => {
    const start = Math.max(highlight.start_offset - bodyOffset, 0);
    const end = Math.min(highlight.end_offset - bodyOffset, tex.length);
    return start < end ? [{ highlight, start, end }] : [];
  });
}

/**
 * The highlight spans painted in `el`: none in an embed of another note, nor
 * a mark of the editor of a cell being edited, which that editor draws, nor
 * one on rendered math, which `math-highlights.ts` marks.
 */
function ownSpans(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(HIGHLIGHT)).filter(
    (span) => {
      if (span.closest('mjx-container')) return false;
      const foreign = span.closest('.internal-embed, .cm-editor');
      return !foreign || !el.contains(foreign);
    }
  );
}

/** How many marks painting left in `el`, text and math alike. */
const markCount = (el: HTMLElement) => ownSpans(el).length + mathMarkCount(el);

/** Take the highlight spans out of `el`, their text left in place. */
export function stripHighlights(el: HTMLElement): void {
  for (const span of ownSpans(el)) {
    const parent = span.parentNode;
    span.replaceWith(...Array.from(span.childNodes));
    // The text painting cut apart, whole again
    parent?.normalize();
  }
}

/**
 * What painting `section` with `highlights` paints: one differing from the
 * last means painting it again.
 */
export function paintKey(
  section: ReadingSection,
  highlights: readonly SnippetHighlight[]
): string {
  const { source, bodyOffset } = section;
  const clamp = (offset: number) =>
    Math.min(Math.max(offset - bodyOffset, 0), source.length);
  return JSON.stringify([
    source,
    highlights
      .map((h) => [
        h.id,
        h.reference,
        clamp(h.start_offset),
        clamp(h.end_offset),
      ])
      .filter(([, , start, end]) => start < end),
  ]);
}

interface Painted {
  key: string;
  /** How many spans painting left in it */
  count: number;
}

/**
 * Paints snippet highlights into the callouts and table cells live preview
 * draws as widgets, as reading view paints them, and opens a snippet from a
 * click on its highlight there.
 *
 * Runs only in a note's own editor: a table cell's nested editor shows its
 * own text, where `cellEditorHighlights` marks the note's highlights.
 */
class WidgetHighlightPainter implements PluginValue {
  private readonly nested: boolean;
  private readonly painted = new WeakMap<HTMLElement, Painted>();
  private readonly observer: MutationObserver | null = null;
  private queued = false;
  private running = false;
  private again = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.nested = isNestedEditor(
      view,
      view.state.field(editorInfoField, false) ?? null
    );
    if (this.nested) return;
    // Widgets are built, rebuilt, and re-rendered in place (a cell when it
    // is left, a callout as post-processors finish) with no update to tell
    const win = view.dom.ownerDocument.defaultView ?? window;
    this.observer = new win.MutationObserver(() => this.schedule());
    this.observer.observe(view.contentDOM, { childList: true, subtree: true });
    // Captured: Obsidian's own handlers on a widget would enter the callout
    // or start editing the cell, and CodeMirror's leave widgets' events alone
    view.contentDOM.addEventListener('pointerdown', this.onPointerDown, true);
    view.contentDOM.addEventListener('click', this.onClick, true);
    view.contentDOM.addEventListener('auxclick', this.onAuxClick, true);
    this.schedule();
  }

  update(update: ViewUpdate) {
    // Edits and new highlights (`refreshHighlightsEffect`, the load's empty
    // dispatch) come in transactions; widgets scrolled into view the
    // observer sees
    if (update.transactions.length > 0) this.schedule();
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    const { contentDOM } = this.view;
    contentDOM.removeEventListener('pointerdown', this.onPointerDown, true);
    contentDOM.removeEventListener('click', this.onClick, true);
    contentDOM.removeEventListener('auxclick', this.onAuxClick, true);
    for (const widget of Array.from(
      contentDOM.querySelectorAll<HTMLElement>(ANY_WIDGET)
    )) {
      stripHighlights(widget);
      clearMath(widget, renderDisplayMath);
    }
  }

  /** The painted highlight span an event is on, if any. */
  private paintedSpan(event: MouseEvent): HTMLElement | null {
    const target = event.target as Element | null;
    const span = target?.closest?.<HTMLElement>(HIGHLIGHT);
    if (!span || span.closest('.cm-editor') !== this.view.dom) return null;
    // A widget of this editor's own: a cell's editor, which can't always
    // tell it is nested (see the constructor), lies in another's widget
    return this.view.contentDOM.contains(span.closest(WIDGET)) ? span : null;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== MIDDLE_MOUSE_BUTTON) return;
    // A table cell would start editing, or select itself, before the click
    if (this.paintedSpan(event)) event.preventDefault();
  };

  private readonly onClick = (event: MouseEvent) => this.open(event);

  private readonly onAuxClick = (event: MouseEvent) => {
    if (event.button === MIDDLE_MOUSE_BUTTON) this.open(event);
  };

  private open(event: MouseEvent) {
    const span = this.paintedSpan(event);
    const plugin = this.view.state.facet(irPluginFacet);
    if (span && plugin) openHighlightFromEvent(plugin, event, span);
  }

  /** Paint once whatever is under way settles: many changes, one pass. */
  private schedule() {
    if (this.queued || this.nested) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      void this.run();
    });
  }

  private async run() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.paintAll();
      } while (this.again && !this.destroyed);
    } catch (error) {
      console.error('Incremental Reading: could not paint highlights', error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Mark `highlights` on the math widgets `targets`, each only when what it
   * shows changed: its highlights, or its rendering, drawn anew by Obsidian.
   * The marks open nothing: a click there edits the math, as it always has.
   */
  private paintMath(
    targets: readonly MathTarget[],
    highlights: readonly SnippetHighlight[]
  ) {
    let drawn = false;
    for (const target of targets) {
      const keyOf = (own: readonly MathHighlight[]) =>
        JSON.stringify([
          target.tex,
          own.map(({ highlight, start, end }) => [
            highlight.id,
            highlight.reference,
            start,
            end,
          ]),
        ]);
      const own = mathHighlights(target, highlights);
      const key = keyOf(own);
      const { el } = target;
      const last = this.painted.get(el) ?? { key: keyOf([]), count: 0 };
      if (last.key === key && mathMarkCount(el) === last.count) continue;
      if (!paintMath(el, target.tex, own, renderDisplayMath, { inert: true })) {
        continue;
      }
      drawn = true;
      this.painted.set(el, { key, count: mathMarkCount(el) });
    }
    if (drawn) void finishRenderMath();
  }

  private async paintAll() {
    const { view } = this;
    if (this.destroyed || !view.contentDOM.querySelector(ANY_WIDGET)) return;
    const plugin = view.state.facet(irPluginFacet);
    const path = Obsidian.getFileInfoFromState(view.state).info?.file?.path;
    // Never painted then: each file has an editor state, and plugins, of its own
    if (!plugin?.reviewManager || !path) return;
    const tracker = plugin.reviewManager.snippets.offsetTracker;
    const all = tracker.getHighlights(path);
    // Most notes have none, and this runs on every keystroke: a big table's
    // cells aren't each looked at unless there is something to take away
    if (all.length === 0 && !view.contentDOM.querySelector(PAINTED)) return;
    const doc = view.state.doc.toString();
    const bodyStart = Obsidian.getBodyStartOffset(doc);
    const highlights = all.filter((h) =>
      tracker.shownRange(path, h, bodyStart, doc.length)
    );
    // Before any render is awaited, so math the cursor just left is marked
    // as it is drawn, never shown a moment without its marks
    this.paintMath(mathTargets(view, bodyStart), highlights);
    const targets = widgetTargets(view, bodyStart);

    const component = new Component();
    component.load();
    try {
      for (const { el, section, cell } of targets) {
        const key = paintKey(section, highlights);
        const last = this.painted.get(el) ?? {
          key: paintKey(section, []),
          count: 0,
        };
        if (last.key === key && markCount(el) === last.count) continue;
        stripHighlights(el);
        const render: RenderSection = (markdown, into) =>
          MarkdownRenderer.render(
            plugin.app,
            cell ? asCell(markdown) : markdown,
            into,
            path,
            component
          );
        await paintSectionHighlights(el, section, highlights, render);
        if (this.destroyed) {
          stripHighlights(el);
          return;
        }
        // Opening a snippet on a click, as the callout's other marks do
        paintSectionMath(el, section, highlights, renderDisplayMath);
        this.painted.set(el, { key, count: markCount(el) });
      }
    } finally {
      component.unload();
    }
  }
}

export const widgetHighlightPainter = ViewPlugin.fromClass(
  WidgetHighlightPainter
);
