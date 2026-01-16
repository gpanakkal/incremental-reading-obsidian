import type { TFile } from 'obsidian';
import type { ChangeSet } from '@codemirror/state';
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

/** Snapshot of highlight offsets for undo/redo restoration */
interface OffsetSnapshot {
  offsets: Map<string, { start: number; end: number }>;
}

const MAX_HISTORY_SIZE = 50;

export class SnippetOffsetTracker {
  // Maps file path -> array of snippet highlights
  private highlightCache: Map<string, SnippetHighlight[]> = new Map();

  // Per-file undo/redo history stacks
  private undoHistory: Map<string, OffsetSnapshot[]> = new Map();
  private redoHistory: Map<string, OffsetSnapshot[]> = new Map();

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
   * Save current offset state to undo history before applying changes.
   * Called before normal edits (not undo/redo).
   */
  pushUndoState(filePath: string) {
    const highlights = this.highlightCache.get(filePath);
    if (!highlights || highlights.length === 0) return;

    // Create snapshot of current offsets
    const snapshot: OffsetSnapshot = {
      offsets: new Map(
        highlights.map((h) => [h.id, { start: h.start_offset, end: h.end_offset }])
      ),
    };

    // Push to undo stack
    const undoStack = this.undoHistory.get(filePath) || [];
    undoStack.push(snapshot);

    // Limit stack size to prevent memory bloat
    if (undoStack.length > MAX_HISTORY_SIZE) {
      undoStack.shift();
    }
    this.undoHistory.set(filePath, undoStack);

    // Clear redo stack on new edit (standard undo/redo behavior)
    this.redoHistory.delete(filePath);
  }

  /**
   * Restore highlight offsets from undo history.
   * Called when an undo transaction is detected.
   */
  restoreFromUndo(filePath: string) {
    const undoStack = this.undoHistory.get(filePath);
    if (!undoStack || undoStack.length === 0) return;

    const highlights = this.highlightCache.get(filePath);
    if (!highlights) return;

    // Save current state to redo stack before restoring
    const currentSnapshot: OffsetSnapshot = {
      offsets: new Map(
        highlights.map((h) => [h.id, { start: h.start_offset, end: h.end_offset }])
      ),
    };
    const redoStack = this.redoHistory.get(filePath) || [];
    redoStack.push(currentSnapshot);
    this.redoHistory.set(filePath, redoStack);

    // Pop and apply undo state
    const undoSnapshot = undoStack.pop()!;
    this.applySnapshot(filePath, undoSnapshot);
  }

  /**
   * Restore highlight offsets from redo history.
   * Called when a redo transaction is detected.
   */
  restoreFromRedo(filePath: string) {
    const redoStack = this.redoHistory.get(filePath);
    if (!redoStack || redoStack.length === 0) return;

    const highlights = this.highlightCache.get(filePath);
    if (!highlights) return;

    // Save current state back to undo stack before restoring
    const currentSnapshot: OffsetSnapshot = {
      offsets: new Map(
        highlights.map((h) => [h.id, { start: h.start_offset, end: h.end_offset }])
      ),
    };
    const undoStack = this.undoHistory.get(filePath) || [];
    undoStack.push(currentSnapshot);
    this.undoHistory.set(filePath, undoStack);

    // Pop and apply redo state
    const redoSnapshot = redoStack.pop()!;
    this.applySnapshot(filePath, redoSnapshot);
  }

  /**
   * Apply a snapshot of offsets to the current highlights.
   */
  private applySnapshot(filePath: string, snapshot: OffsetSnapshot) {
    const highlights = this.highlightCache.get(filePath);
    if (!highlights) return;

    for (const h of highlights) {
      const offsets = snapshot.offsets.get(h.id);
      if (offsets) {
        h.start_offset = offsets.start;
        h.end_offset = offsets.end;
      }
    }
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

      // mapPos transforms position through ALL changes atomically
      // assoc=1 means "if at change boundary, stay with content to the right"
      // assoc=-1 means "stay with content to the left"
      const newAbsoluteStart = changes.mapPos(absoluteStart, 1);
      const newAbsoluteEnd = changes.mapPos(absoluteEnd, -1);

      // Convert back to body-relative offsets in new document
      highlight.start_offset = Math.max(0, newAbsoluteStart - newBodyStart);
      highlight.end_offset = Math.max(
        highlight.start_offset,
        newAbsoluteEnd - newBodyStart
      );
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
