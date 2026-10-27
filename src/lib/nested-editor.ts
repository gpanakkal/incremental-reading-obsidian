import type { EditorView } from '@codemirror/view';
import type { MarkdownFileInfo } from 'obsidian';

/**
 * Whether `view` is an editor Obsidian nests inside a note's editor, rather
 * than a note's editor itself: the one Live Preview opens in a table cell
 * while it is being edited.
 *
 * That editor is built with every extension `registerEditorExtension` added,
 * and its `editorInfoField` is the note's view, so to the plugin's extensions
 * it looks like the note. Its document is only the cell's text, though, and
 * anything file-level done there goes wrong: a reading position restored in it
 * clamps to the end of the cell and scrolls the note to put the cell at the
 * top, and highlight offsets mapped through its edits are cell offsets.
 *
 * Either sign settles it:
 * - Its owner's editor is a different one. The cell editor's owner is the
 *   note's view, whose `editor.cm` is the note's own EditorView. This holds
 *   from the moment the editor is built, when its DOM is not attached yet.
 *   Undocumented: `Editor.cm` (Obsidian's EditorView behind the `Editor`
 *   API), and that the cell editor is given the note's view as its owner.
 * - Its DOM sits inside another `.cm-editor` (CodeMirror's own class), once
 *   Obsidian has put it into the table.
 *
 * Neither holds for a note's own editor: in a tab, a hover preview, a canvas
 * card or the review tab, the owner's `editor.cm` is that same EditorView (or
 * there is no `editor` yet), and Obsidian mounts it outside any other editor.
 */
export function isNestedEditor(
  view: EditorView,
  info: MarkdownFileInfo | null
): boolean {
  if (view.dom.parentElement?.closest('.cm-editor')) return true;
  let ownersView: unknown;
  try {
    ownersView = (info?.editor as { cm?: unknown } | undefined)?.cm;
  } catch {
    // An owner whose `editor` is a getter that throws, as the review tab's
    // does until its editor is assigned: it says nothing either way, and
    // calling the editor nested on its account would leave every extension
    // dead in a note's own editor. Left unset, it settles nothing.
  }
  return !!ownersView && ownersView !== view;
}
