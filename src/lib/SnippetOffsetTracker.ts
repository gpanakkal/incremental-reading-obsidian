import type { ChangeSet } from '@codemirror/state';
import type { ISnippetBase } from './types';

/**
 * Service for tracking snippet highlights and updating their offsets in real-time
 * as documents are edited.
 *
 * When the user undoes an action, CodeMirror provides a ChangeSet representing
 * the inverse transformation, which we apply via mapPos() just like any other edit.
 * This correctly handles cases where Obsidian groups multiple edits into a single
 * undo action.
 */

export interface SnippetHighlight extends ISnippetBase {
  // These are guaranteed to be non-null for highlights
  start_offset: number;
  end_offset: number;
  parent: string;
}

export class SnippetOffsetTracker {
  // Maps file path -> array of snippet highlights
  private highlightCache: Map<string, SnippetHighlight[]> = new Map();

  /**
   * Load highlights for a file into the cache
   * @param filePath The file path
   * @param highlights The snippet highlights for this file
   */
  loadHighlights(filePath: string, highlights: SnippetHighlight[]) {
    this.highlightCache.set(filePath, highlights);
  }

  /**
   * Get highlights for a file
   * @param filePath The file path
   * @returns Array of highlights, or empty array if none
   */
  getHighlights(filePath: string): SnippetHighlight[] {
    return this.highlightCache.get(filePath) || [];
  }

  /**
   * Clear all cached highlights for a file
   * @param filePath The file path
   */
  invalidateCache(filePath: string) {
    this.highlightCache.delete(filePath);
  }

  /**
   * Update highlight offsets using CodeMirror's position mapping.
   * This correctly handles multiple changes in a single transaction (e.g., undo).
   *
   * @param filePath The file being edited
   * @param changes The CodeMirror ChangeSet from the transaction
   * @param oldBodyStart Body start offset in the old document (before changes)
   * @param newBodyStart Body start offset in the new document (after changes)
   */
  updateOffsetsWithMapping(
    filePath: string,
    changes: ChangeSet,
    oldBodyStart: number,
    newBodyStart: number
  ) {
    const highlights = this.highlightCache.get(filePath);
    if (!highlights || highlights.length === 0) {
      return;
    }

    for (const highlight of highlights) {
      // Convert body-relative to absolute positions in old document
      const absoluteStart = highlight.start_offset + oldBodyStart;
      const absoluteEnd = highlight.end_offset + oldBodyStart;

      // Association controls which side of inserted text a mapped position
      // sticks to. mapPos(pos, 1) stays with content to the RIGHT of the change
      // boundary; mapPos(pos, -1) stays with content to the LEFT.
      //
      // Live (non-zero-length) highlights use INWARD association (start=1,
      // end=-1) so typing exactly at a boundary doesn't extend the highlight.
      //
      // A highlight that has already collapsed to zero length is invisible
      // (buildDecorations skips it) but is kept so undoing the erasure can bring
      // it back. Re-expansion only works if re-inserted text lands INSIDE the
      // range, so a collapsed highlight uses OUTWARD association (start=-1,
      // end=1): its start stays left of the insertion and its end stays right.
      const isCollapsed = highlight.start_offset === highlight.end_offset;
      const startAssoc = isCollapsed ? -1 : 1;
      const endAssoc = isCollapsed ? 1 : -1;

      // mapPos transforms position through ALL changes atomically
      const newAbsoluteStart = changes.mapPos(absoluteStart, startAssoc);
      const newAbsoluteEnd = changes.mapPos(absoluteEnd, endAssoc);

      // Convert back to body-relative offsets in new document
      const newStart = Math.max(0, newAbsoluteStart - newBodyStart);
      // Allow zero-length highlights. Erasing the entire highlighted range
      // collapses it to zero length, which hides it (buildDecorations skips
      // ranges where start >= end) without destroying the record — so deleting
      // a highlight's text removes the highlight, and undo can restore it.
      // Clamping to `newStart` (not `newStart + 1`) also prevents inverted
      // ranges when the mapped end would fall before the start.
      const newEnd = Math.max(newStart, newAbsoluteEnd - newBodyStart);

      highlight.start_offset = newStart;
      highlight.end_offset = newEnd;
    }

    this.highlightCache.set(filePath, highlights);
  }

  /**
   * Update offsets for a single highlight
   * Used when persisting changes back to the database
   *
   * @param snippetId The snippet ID
   * @param newOffsets The updated offsets
   */
  updateHighlight(
    filePath: string,
    snippetId: string,
    newOffsets: { start: number; end: number }
  ) {
    const highlights = this.highlightCache.get(filePath);
    if (!highlights) return;

    const highlight = highlights.find((h) => h.id === snippetId);
    if (highlight) {
      highlight.start_offset = newOffsets.start;
      highlight.end_offset = newOffsets.end;
    }
  }

  /**
   * Remove a highlight from the cache
   * @param filePath The file path
   * @param snippetId The snippet ID to remove
   */
  removeHighlight(filePath: string, snippetId: string) {
    const highlights = this.highlightCache.get(filePath);
    if (!highlights) return;

    const filtered = highlights.filter((h) => h.id !== snippetId);
    this.highlightCache.set(filePath, filtered);
  }

  /**
   * Move the cached highlights from oldPath to newPath.
   * Called when Obsidian renames a file so that open editors
   * using the new path still find their highlight data.
   */
  renameFile(oldPath: string, newPath: string) {
    const highlights = this.highlightCache.get(oldPath);
    if (highlights === undefined) return;
    this.highlightCache.delete(oldPath);
    this.highlightCache.set(newPath, highlights);
  }

  /**
   * Clear all caches
   */
  clearAll() {
    this.highlightCache.clear();
  }
}
