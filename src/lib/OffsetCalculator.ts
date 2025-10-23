import type { Editor, MarkdownView } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type ReviewView from '#/views/ReviewView';

/**
 * Utilities for calculating character offsets from editor selections
 * Works for both Markdown (CodeMirror) and PDF views
 */

export interface TextOffsets {
  start: number;
  end: number;
}

/**
 * Get character offsets from a Markdown editor selection
 * @param editor The Obsidian editor instance
 * @param view The view containing the editor
 * @returns Character offsets from document start, or null if no selection
 */
export function getMarkdownOffsets(
  editor: Editor,
  view: MarkdownView | ReviewView
): TextOffsets | null {
  // Check if we can access the CodeMirror instance
  const cm = (editor as any).cm as EditorView | undefined;

  if (!cm) {
    console.warn('Could not access CodeMirror instance from editor');
    return null;
  }

  // Get the selection ranges
  const selection = cm.state.selection;
  if (!selection || selection.ranges.length === 0) {
    return null;
  }

  // Use the first selection range (Obsidian typically has single selections)
  const range = selection.ranges[0];

  return {
    start: range.from,
    end: range.to,
  };
}

/**
 * Get character offsets from a PDF viewer selection
 * TODO: Implement when PDF support is added
 * @param view The PDF view
 * @returns Character offsets from document start, or null if no selection
 */
export function getPDFOffsets(view: any): TextOffsets | null {
  // Placeholder for PDF implementation
  // This will be implemented when adding PDF support

  console.warn('PDF offset calculation not yet implemented');
  return null;

  /*
   * Future implementation will:
   * 1. Get window.getSelection() to find selected text
   * 2. Traverse PDF.js text layer to find selection bounds
   * 3. Calculate cumulative character offset from document start
   * 4. Account for page breaks and whitespace
   */
}

/**
 * Convert character offsets to a position in the editor
 * Useful for scrolling to a highlight or positioning the cursor
 * @param cm The CodeMirror editor view
 * @param offset Character offset from document start
 * @returns The position in the editor
 */
export function offsetToPosition(cm: EditorView, offset: number) {
  return cm.posAtCoords({ x: 0, y: 0 }, false);
}

/**
 * Get the text content between two offsets
 * @param cm The CodeMirror editor view
 * @param offsets The character offsets
 * @returns The text content
 */
export function getTextAtOffsets(
  cm: EditorView,
  offsets: TextOffsets
): string {
  return cm.state.doc.sliceString(offsets.start, offsets.end);
}
