import { ChangeSet, Text } from '@codemirror/state';
import { beforeEach, describe, expect, it } from 'vitest';
import { SnippetOffsetTracker } from './SnippetOffsetTracker';
import type { SnippetHighlight } from './SnippetOffsetTracker';

function createHighlight(
  id: string,
  start: number,
  end: number
): SnippetHighlight {
  return {
    id,
    reference: `test-ref-${id}`,
    start_offset: start,
    end_offset: end,
    parent: 'parent-article',
  } as SnippetHighlight;
}

describe('SnippetOffsetTracker', () => {
  let tracker: SnippetOffsetTracker;
  const filePath = 'test/file.md';

  beforeEach(() => {
    tracker = new SnippetOffsetTracker();
  });

  describe('updateOffsetsWithMapping', () => {
    it('should prevent zero-width highlights when content before snippet is deleted', () => {
      // Scenario: Two snippets both at offset 100-150, deleting content before them
      // that causes them to collapse to the same position
      const highlight1 = createHighlight('1', 100, 150);
      const highlight2 = createHighlight('2', 100, 150);
      tracker.loadHighlights(filePath, [highlight1, highlight2]);

      // Simulate deleting 100 characters before the snippets, which would
      // map both start and end to position 0
      const oldDoc = Text.of(['x'.repeat(200)]);
      const _newDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 0, to: 100 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // Both highlights should have at least 1 character width
      expect(updated[0].start_offset).toBe(0);
      expect(updated[0].end_offset).toBe(50); // 150 - 100 = 50
      expect(updated[1].start_offset).toBe(0);
      expect(updated[1].end_offset).toBe(50);
    });

    it('should prevent zero-width highlights when entire snippet content is deleted', () => {
      // Scenario: Snippet spans 100-200, and we delete exactly that range
      const highlight = createHighlight('1', 100, 200);
      tracker.loadHighlights(filePath, [highlight]);

      // Delete the entire snippet content (positions 100-200)
      const oldDoc = Text.of(['x'.repeat(300)]);
      const changes = ChangeSet.of({ from: 100, to: 200 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // When entire content is deleted, start and end would both map to 100
      // But we should ensure end_offset = start_offset + 1 minimum
      expect(updated[0].end_offset).toBeGreaterThan(updated[0].start_offset);
      expect(updated[0].end_offset).toBe(updated[0].start_offset + 1);
    });

    it('should maintain proper offsets when content is deleted before snippet', () => {
      // Normal case: snippet at 200-300, delete 50 chars at start
      const highlight = createHighlight('1', 200, 300);
      tracker.loadHighlights(filePath, [highlight]);

      const oldDoc = Text.of(['x'.repeat(400)]);
      const changes = ChangeSet.of({ from: 0, to: 50 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(150); // 200 - 50
      expect(updated[0].end_offset).toBe(250); // 300 - 50
    });

    it('should handle deletion that partially overlaps snippet start', () => {
      // Snippet at 100-200, delete 80-120 (overlaps start)
      const highlight = createHighlight('1', 100, 200);
      tracker.loadHighlights(filePath, [highlight]);

      const oldDoc = Text.of(['x'.repeat(300)]);
      const changes = ChangeSet.of({ from: 80, to: 120 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // Start maps to 80 (deletion point), end maps to 160 (200 - 40)
      expect(updated[0].start_offset).toBe(80);
      expect(updated[0].end_offset).toBe(160);
    });

    it('should correctly shift snippets when deleting large content before them (image deletion scenario)', () => {
      // Scenario: Document has images from 0-8000, then text with snippets at 8244-8300 and 8400-8500
      // User deletes all images (0-8000)
      const highlight1 = createHighlight('1', 8244, 8300);
      const highlight2 = createHighlight('2', 8400, 8500);
      tracker.loadHighlights(filePath, [highlight1, highlight2]);

      // Document is 10000 chars, delete first 8000
      const oldDoc = Text.of(['x'.repeat(10000)]);
      const changes = ChangeSet.of({ from: 0, to: 8000 }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // Snippets should shift left by 8000
      expect(updated[0].start_offset).toBe(244); // 8244 - 8000
      expect(updated[0].end_offset).toBe(300); // 8300 - 8000
      expect(updated[1].start_offset).toBe(400); // 8400 - 8000
      expect(updated[1].end_offset).toBe(500); // 8500 - 8000
    });

    it('should handle incremental backspacing (multiple small deletions)', () => {
      // Scenario: User backspaces character by character
      const highlight = createHighlight('1', 100, 150);
      tracker.loadHighlights(filePath, [highlight]);

      // First backspace: delete char at position 50
      let oldDoc = Text.of(['x'.repeat(200)]);
      let changes = ChangeSet.of({ from: 50, to: 51 }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      let updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(99);
      expect(updated[0].end_offset).toBe(149);

      // Second backspace: delete char at position 49
      oldDoc = Text.of(['x'.repeat(199)]);
      changes = ChangeSet.of({ from: 49, to: 50 }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(98);
      expect(updated[0].end_offset).toBe(148);
    });

    it('should correctly handle undo of multiple combined edits', () => {
      // Scenario: User types "abc" (3 chars at position 50), which Obsidian may group
      // into a single undo action. When undone, the ChangeSet represents all 3
      // deletions combined - we need to handle this correctly via mapPos().
      const highlight = createHighlight('1', 100, 150);
      tracker.loadHighlights(filePath, [highlight]);

      // Step 1: User types "abc" at position 50 (inserts 3 chars)
      // This shifts the highlight from 100-150 to 103-153
      let oldDoc = Text.of(['x'.repeat(200)]);
      let changes = ChangeSet.of({ from: 50, insert: 'abc' }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      let updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(103); // 100 + 3
      expect(updated[0].end_offset).toBe(153); // 150 + 3

      // Step 2: User hits undo - Obsidian provides a ChangeSet that deletes "abc"
      // This is the INVERSE transformation: delete 3 chars at position 50
      oldDoc = Text.of(['x'.repeat(203)]);
      changes = ChangeSet.of({ from: 50, to: 53 }, oldDoc.length);
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      updated = tracker.getHighlights(filePath);
      // Should return to original positions
      expect(updated[0].start_offset).toBe(100);
      expect(updated[0].end_offset).toBe(150);
    });

    it('should handle undo of find-replace with multiple replacements', () => {
      // Scenario: Find-replace changes "aa" to "bbbb" at multiple locations in one action.
      // The ChangeSet contains multiple changes that are applied atomically.
      const highlight = createHighlight('1', 100, 150);
      tracker.loadHighlights(filePath, [highlight]);

      // Find-replace: "aa" -> "bbbb" at positions 20 and 60 (before the highlight)
      // Each replacement adds 2 chars, total +4 to positions after both
      const oldDoc = Text.of(['x'.repeat(200)]);
      const changes = ChangeSet.of(
        [
          { from: 20, to: 22, insert: 'bbbb' }, // +2 chars
          { from: 60, to: 62, insert: 'bbbb' }, // +2 chars
        ],
        oldDoc.length
      );
      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      let updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBe(104); // 100 + 4
      expect(updated[0].end_offset).toBe(154); // 150 + 4

      // Undo: "bbbb" -> "aa" at positions 20 and 62 (note: second position shifted)
      // This is the inverse: each replacement removes 2 chars
      const newDoc = Text.of(['x'.repeat(204)]);
      const undoChanges = ChangeSet.of(
        [
          { from: 20, to: 24, insert: 'aa' }, // -2 chars
          { from: 62, to: 66, insert: 'aa' }, // -2 chars
        ],
        newDoc.length
      );
      tracker.updateOffsetsWithMapping(filePath, undoChanges, 0, 0);

      updated = tracker.getHighlights(filePath);
      // Should return to original positions
      expect(updated[0].start_offset).toBe(100);
      expect(updated[0].end_offset).toBe(150);
    });
  });
});
