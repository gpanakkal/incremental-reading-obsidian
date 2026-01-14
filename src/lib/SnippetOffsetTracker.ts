import type { TFile } from 'obsidian';
import type { ChangeSpec } from '@codemirror/state';
import type { ISnippetBase } from './types';

/**
 * Service for tracking snippet highlights and updating their offsets in real-time
 * as documents are edited
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

  // Track if a file's highlights might be corrupted
  private corruptedHighlights: Set<string> = new Set();

  /**
   * Load highlights for a file into the cache
   * @param filePath The file path
   * @param highlights The snippet highlights for this file
   */
  loadHighlights(filePath: string, highlights: SnippetHighlight[]) {
    this.highlightCache.set(filePath, highlights);
    this.corruptedHighlights.delete(filePath);
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
   * Check if a file's highlights might be corrupted
   * @param filePath The file path
   */
  isCorrupted(filePath: string): boolean {
    return this.corruptedHighlights.has(filePath);
  }

  /**
   * Clear all cached highlights for a file
   * Called when file is modified outside Obsidian
   * @param filePath The file path
   */
  invalidateCache(filePath: string) {
    this.highlightCache.delete(filePath);
    this.corruptedHighlights.delete(filePath);
  }

  /**
   * Update highlight offsets based on a document change.
   * Offsets are body-relative (excluding frontmatter).
   *
   * @param filePath The file being edited
   * @param changes Array of changes made to the document (body-relative positions)
   */
  updateOffsetsForChanges(filePath: string, changes: ChangeSpec[]) {
    const highlights = this.highlightCache.get(filePath);
    if (!highlights || highlights.length === 0) {
      return;
    }

    let hasCorruption = false;

    // Process each change
    for (const change of changes) {
      if (typeof change !== 'object' || !('from' in change)) {
        continue;
      }

      const changeStart = change.from;
      const changeEnd =
        'to' in change && change.to !== undefined ? change.to : changeStart;
      const insertedLength =
        'insert' in change ? change.insert?.toString().length || 0 : 0;

      const deletedLength = changeEnd - changeStart;
      const lengthDelta = insertedLength - deletedLength;

      // Update each highlight based on change position
      for (const highlight of highlights) {
        // A change affects a highlight if it occurs before the highlight ends
        if (changeStart >= highlight.end_offset) {
          // Change is completely after this highlight - no adjustment needed
          continue;
        }

        if (changeEnd <= highlight.start_offset) {
          // Change is completely before this highlight - shift both offsets
          highlight.start_offset += lengthDelta;
          highlight.end_offset += lengthDelta;
        } else if (changeStart <= highlight.start_offset) {
          // Change overlaps the start of the highlight - this is destructive
          // (deleting or replacing text at the beginning of the highlighted region)
          hasCorruption = true;
          highlight.start_offset = Math.max(
            changeStart,
            highlight.start_offset + lengthDelta
          );
          highlight.end_offset += lengthDelta;
        } else {
          // Change is inside the highlight (changeStart > highlight.start_offset)
          // This is normal editing within highlighted text - just adjust end offset
          highlight.end_offset += lengthDelta;
        }

        // Ensure offsets stay valid
        if (highlight.end_offset < highlight.start_offset) {
          highlight.end_offset = highlight.start_offset;
          hasCorruption = true;
        }
      }
    }

    if (hasCorruption) {
      this.corruptedHighlights.add(filePath);
    }

    // Update cache
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
    this.corruptedHighlights.clear();
  }
}
