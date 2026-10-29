import { isNestedEditor } from '#/lib/nested-editor';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type { ReadingSection } from '#/lib/reading-highlights';
import type { SnippetHighlight } from '#/lib/SnippetOffsetTracker';
import { ChangeSet, StateEffect, Text } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import { editorInfoField, type EventRef } from 'obsidian';
import { irPluginFacet } from './irPluginFacet';
import { cellSection } from './WidgetHighlightPainter';

/**
 * The text a table cell's editor shows for a cell whose markdown is
 * `source`, and how each place in `source` moves to get there.
 *
 * Undocumented (seen in Obsidian 1.14.5): the editor Live Preview opens in a
 * table cell is given the cell's text with each escaped pipe (`\|`, after an
 * odd run of backslashes) unescaped, and each `<br>`, in any case and outside
 * code, made a line break; typing in it escapes them again on the way back to
 * the note.
 */
export function cellEditorText(source: string): {
  text: string;
  changes: ChangeSet;
} {
  const code = Array.from(source.matchAll(/(`+)[^`]+\1/g), (m) => ({
    from: m.index,
    to: m.index + m[0].length,
  }));
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const { 0: match, index } of source.matchAll(/\\+\||<br>/gi)) {
    const end = index + match.length;
    if (match.endsWith('|')) {
      // An even run of backslashes (the match odd in length) escapes itself,
      // and leaves the pipe a pipe
      if (match.length % 2 === 1) continue;
      changes.push({ from: end - 2, to: end - 1, insert: '' });
    } else if (!code.some((span) => span.from < index && span.to > end)) {
      changes.push({ from: index, to: end, insert: '\n' });
    }
  }
  const set = ChangeSet.of(changes, source.length);
  const text = set.apply(Text.of(source.split('\n'))).toString();
  return { text, changes: set };
}

/** A highlight's mark in a cell editor. */
export interface CellMark {
  id: string;
  from: number;
  to: number;
}

/**
 * Where, in a cell editor showing `doc`, the note's `highlights` fall that
 * cover part of the cell whose markdown is `section`: each cut to the cell,
 * on the text the cell editor shows for the highlighted markdown. None where
 * `doc` isn't that cell's text, less any space typed at its sides, which the
 * note keeps out of the cell until Obsidian pads the table anew.
 */
export function cellMarks(
  section: ReadingSection,
  highlights: readonly SnippetHighlight[],
  doc: string
): CellMark[] {
  const { source, bodyOffset } = section;
  const { text, changes } = cellEditorText(source);
  const lead = /^[ \t]*/.exec(doc)![0].length;
  if (
    doc.slice(lead, lead + text.length) !== text ||
    !/^[ \t]*$/.test(doc.slice(lead + text.length))
  ) {
    return [];
  }
  const local = (offset: number) =>
    Math.min(Math.max(offset - bodyOffset, 0), source.length);
  return highlights.flatMap((h) => {
    const start = local(h.start_offset);
    const end = local(h.end_offset);
    if (start >= end) return [];
    // A line break made of a `<br>` is marked if any of it is
    const from = lead + changes.mapPos(start, -1);
    const to = lead + changes.mapPos(end, 1);
    return from < to ? [{ id: h.id, from, to }] : [];
  });
}

const setCellMarks = StateEffect.define<DecorationSet>();

/** What a mark here is made with. */
type MarkSpec = { attributes: Record<string, string> };

const markOf = (id: string) =>
  Decoration.mark({
    // Shown as the note shows it, but inert: a click places the cursor
    class: 'ir-snippet-highlight ir-inert-highlight',
    attributes: { 'data-snippet-id': id },
  });

/** What a set of marks marks, to tell whether it changed. */
function marksKey(set: DecorationSet): string {
  const marks: unknown[] = [];
  for (let it = set.iter(); it.value; it.next()) {
    const { attributes } = it.value.spec as MarkSpec;
    marks.push([attributes['data-snippet-id'], it.from, it.to]);
  }
  return JSON.stringify(marks);
}

/**
 * Shows, in the editor Live Preview opens in a table cell, the note's snippet
 * highlights that fall in that cell, where the cell's own highlight extension
 * shows none (its offsets would be cell offsets; see `isNestedEditor`).
 *
 * Read only: the marks follow the note's offset tracker, which the note's own
 * editor moves as the cell's edits reach it, and nothing here writes to the
 * tracker or the database, nor handles a pointer on a mark.
 */
class CellEditorHighlights implements PluginValue {
  decorations: DecorationSet = Decoration.none;
  private readonly nested: boolean;
  private readonly highlightsChanged: EventRef | null = null;
  private queued = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.nested = isNestedEditor(
      view,
      view.state.field(editorInfoField, false) ?? null
    );
    if (!this.nested) return;
    const plugin = view.state.facet(irPluginFacet);
    this.highlightsChanged =
      plugin?.app.workspace.on('ir-highlights-changed', () =>
        this.schedule()
      ) ?? null;
    // Built before Obsidian puts it in its cell, which it does right after
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (!this.nested) return;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setCellMarks)) this.decorations = effect.value;
      }
      // Moved with the text until the note's editor, which the edit reaches
      // only after this update, has moved the tracker
      this.decorations = this.decorations.map(tr.changes);
    }
    if (update.docChanged) this.schedule();
  }

  destroy() {
    this.destroyed = true;
    if (this.highlightsChanged) {
      this.view.state
        .facet(irPluginFacet)
        ?.app.workspace.offref(this.highlightsChanged);
    }
  }

  private schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.destroyed) return;
      const marks = this.build();
      if (marksKey(marks) !== marksKey(this.decorations)) {
        this.view.dispatch({ effects: setCellMarks.of(marks) });
      }
    });
  }

  /** The marks of the note's highlights in the cell, as the tracker has them. */
  private build(): DecorationSet {
    const { view } = this;
    const tracker =
      view.state.facet(irPluginFacet)?.reviewManager?.snippets.offsetTracker;
    // Undocumented (seen in Obsidian 1.14.5): the cell editor's DOM is put in
    // the cell of the note's table widget it edits (see `editTableCell`)
    const cell =
      view.dom.parentElement?.closest<HTMLTableCellElement>('td, th');
    const host = cell?.closest<HTMLElement>('.cm-editor');
    const note = host && EditorView.findFromDOM(host);
    if (!tracker || !cell || !note) return Decoration.none;
    const path = Obsidian.getFileInfoFromState(note.state).info?.file?.path;
    const highlights = path ? tracker.getHighlights(path) : [];
    // Most notes have none, and this runs on every keystroke in a cell
    if (highlights.length === 0) return Decoration.none;
    const bodyStart = Obsidian.getBodyStartOffset(note.state.doc.toString());
    const section = cellSection(note, cell, bodyStart);
    if (!section) return Decoration.none;
    return Decoration.set(
      cellMarks(section, highlights, view.state.doc.toString()).map(
        ({ id, from, to }) => markOf(id).range(from, to)
      ),
      true
    );
  }
}

export const cellEditorHighlights = ViewPlugin.fromClass(CellEditorHighlights, {
  decorations: (plugin) => plugin.decorations,
});
