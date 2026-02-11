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
    console.log(
      `[SnippetOffsetTracker] Loading ${highlights.length} highlights for ${filePath}`,
      highlights.map((h) => ({
        id: h.id.slice(0, 8),
        start: h.start_offset,
        end: h.end_offset,
      }))
    );
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
      console.log(
        `[SnippetOffsetTracker] No highlights cached for ${filePath}, skipping offset update`
      );
      return;
    }

    console.log(
      `[SnippetOffsetTracker] Updating ${highlights.length} highlights for ${filePath}`,
      { oldBodyStart, newBodyStart }
    );

    for (const highlight of highlights) {
      // Convert body-relative to absolute positions in old document
      const absoluteStart = highlight.start_offset + oldBodyStart;
      const absoluteEnd = highlight.end_offset + oldBodyStart;

      // mapPos transforms position through ALL changes atomically
      // assoc=1 means "if at change boundary, stay with content to the right"
      // assoc=-1 means "stay with content to the left"
      const newAbsoluteStart = changes.mapPos(absoluteStart, 1);
      const newAbsoluteEnd = changes.mapPos(absoluteEnd, -1);
      console.log({ newAbsoluteStart, newAbsoluteEnd });

      // Convert back to body-relative offsets in new document
      const newStart = Math.max(0, newAbsoluteStart - newBodyStart);
      // Ensure end is always at least start + 1 to prevent zero-width highlights
      // (which become invisible and effectively destroy the snippet highlight)
      const newEnd = Math.max(newStart + 1, newAbsoluteEnd - newBodyStart);

      console.log(
        `[SnippetOffsetTracker] Highlight update: (${highlight.start_offset}, ${highlight.end_offset}) -> (${newStart}, ${newEnd})`
      );

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
   * Clear all caches
   */
  clearAll() {
    this.highlightCache.clear();
  }
}
