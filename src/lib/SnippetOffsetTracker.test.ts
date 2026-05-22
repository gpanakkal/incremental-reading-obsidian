import { ChangeSet, Text } from '@codemirror/state';
import * as fc from 'fast-check';
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

    it('should do nothing when no highlights are cached for the file', () => {
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 0, to: 10 }, oldDoc.length);
      // Must not throw and cache must remain empty
      expect(() =>
        tracker.updateOffsetsWithMapping('nonexistent.md', changes, 0, 0)
      ).not.toThrow();
      expect(tracker.getHighlights('nonexistent.md')).toEqual([]);
    });

    it('should do nothing when highlights array is empty', () => {
      tracker.loadHighlights(filePath, []);
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 0, to: 10 }, oldDoc.length);
      expect(() =>
        tracker.updateOffsetsWithMapping(filePath, changes, 0, 0)
      ).not.toThrow();
      expect(tracker.getHighlights(filePath)).toEqual([]);
    });

    it('should account for body start offset when mapping positions', () => {
      // Highlights are body-relative; body starts at offset 50 in the doc
      const highlight = createHighlight('1', 10, 30); // body-relative
      tracker.loadHighlights(filePath, [highlight]);

      // Insert 5 chars at absolute position 60 (body-relative 10 — snippet start)
      const oldDoc = Text.of(['x'.repeat(200)]);
      const changes = ChangeSet.of({ from: 60, insert: 'abcde' }, oldDoc.length);

      // oldBodyStart = 50, newBodyStart = 50 (frontmatter unchanged)
      tracker.updateOffsetsWithMapping(filePath, changes, 50, 50);

      const updated = tracker.getHighlights(filePath);
      // Absolute start was 60 (=10+50); assoc=1 maps it to 65 after insert; body-relative = 15
      expect(updated[0].start_offset).toBe(15);
      // Absolute end was 80 (=30+50); shifts to 85; body-relative = 35
      expect(updated[0].end_offset).toBe(35);
    });

    it('should clamp start_offset to 0 when mapping would produce a negative body-relative position', () => {
      // Highlight at body-relative 5-20, body starts at 50 (absolute 55-70).
      // Delete absolute 0-60 — would map start below newBodyStart.
      const highlight = createHighlight('1', 5, 20);
      tracker.loadHighlights(filePath, [highlight]);

      const oldDocLen = 200;
      const changes = ChangeSet.of({ from: 0, to: 60 }, oldDocLen);

      // newBodyStart also shrinks: frontmatter (50 chars) remains but body now at 50-60=...
      // Keep newBodyStart = 0 to trigger the Math.max(0, ...) guard
      tracker.updateOffsetsWithMapping(filePath, changes, 50, 0);

      const updated = tracker.getHighlights(filePath);
      expect(updated[0].start_offset).toBeGreaterThanOrEqual(0);
      expect(updated[0].end_offset).toBeGreaterThan(updated[0].start_offset);
    });

    it('should not extend end_offset when text is inserted exactly at the snippet end boundary', () => {
      // assoc=-1 for end means it stays LEFT of the insertion (end does not grow).
      // assoc=+1 would move to the RIGHT, making end_offset larger than expected.
      const highlight = createHighlight('1', 10, 20);
      tracker.loadHighlights(filePath, [highlight]);

      // Insert 5 chars exactly at position 20 (= absoluteEnd when bodyStart=0)
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 20, insert: 'hello' }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // start: assoc=1, at position 10 (no change nearby) → stays 10
      expect(updated[0].start_offset).toBe(10);
      // end: assoc=-1, at right edge of insertion → stays at 20, not 25
      expect(updated[0].end_offset).toBe(20);
    });

    it('should extend start_offset rightward when text is inserted exactly at the snippet start boundary', () => {
      // assoc=+1 for start means it stays RIGHT of the insertion (start grows past inserted text).
      // assoc=-1 would stay LEFT, absorbing the new text into the snippet.
      const highlight = createHighlight('1', 10, 20);
      tracker.loadHighlights(filePath, [highlight]);

      // Insert 5 chars exactly at position 10 (= absoluteStart when bodyStart=0)
      const oldDoc = Text.of(['x'.repeat(100)]);
      const changes = ChangeSet.of({ from: 10, insert: 'hello' }, oldDoc.length);

      tracker.updateOffsetsWithMapping(filePath, changes, 0, 0);

      const updated = tracker.getHighlights(filePath);
      // start: assoc=+1 → jumps to right of insertion = 15
      expect(updated[0].start_offset).toBe(15);
      // end: assoc=-1, at position 20, insertion was before it → shifts to 25
      expect(updated[0].end_offset).toBe(25);
    });

    it('should update all highlights in cache and persist them (property-based)', () => {
      fc.assert(
        fc.property(
          // Generate between 1 and 5 non-overlapping highlights within a 1000-char body
          fc
            .array(fc.nat({ max: 998 }), { minLength: 1, maxLength: 5 })
            .map((starts) =>
              starts
                .sort((a, b) => a - b)
                .map((start, i) =>
                  createHighlight(String(i), start, start + 1 + (i % 10))
                )
            ),
          (highlights) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(filePath, highlights);

            // No-op change: insert nothing
            const docLen = 2000;
            const changes = ChangeSet.of({ from: 0, insert: '' }, docLen);
            t.updateOffsetsWithMapping(filePath, changes, 0, 0);

            const result = t.getHighlights(filePath);
            // Every highlight must have end > start
            for (const h of result) {
              expect(h.end_offset).toBeGreaterThan(h.start_offset);
            }
            // Count must be preserved
            expect(result.length).toBe(highlights.length);
          }
        )
      );
    });
  });

  // #region HELPERS
  const highlightArb = fc
    .record({
      id: fc.uuid(),
      start: fc.nat({ max: 9000 }),
      width: fc.integer({ min: 1, max: 100 }),
    })
    .map(({ id, start, width }) => createHighlight(id, start, start + width));
  // #endregion

  describe('loadHighlights / getHighlights', () => {
    it('should return empty array when no highlights loaded for a path', () => {
      fc.assert(
        fc.property(fc.string(), (path) => {
          const t = new SnippetOffsetTracker();
          expect(t.getHighlights(path)).toEqual([]);
        })
      );
    });

    it('should return the loaded highlights for the correct path', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 10 }),
          (path, highlights) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(path, highlights);
            expect(t.getHighlights(path)).toEqual(highlights);
          }
        )
      );
    });

    it('should not leak highlights between different file paths', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (pathA, pathB, hlA, hlB) => {
            fc.pre(pathA !== pathB);
            const t = new SnippetOffsetTracker();
            t.loadHighlights(pathA, hlA);
            t.loadHighlights(pathB, hlB);
            expect(t.getHighlights(pathA)).toEqual(hlA);
            expect(t.getHighlights(pathB)).toEqual(hlB);
          }
        )
      );
    });

    it('should overwrite previously loaded highlights when loaded again for the same path', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (path, first, second) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(path, first);
            t.loadHighlights(path, second);
            expect(t.getHighlights(path)).toEqual(second);
          }
        )
      );
    });
  });

  describe('invalidateCache', () => {
    it('should remove highlights for the given path', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (path, highlights) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(path, highlights);
            t.invalidateCache(path);
            expect(t.getHighlights(path)).toEqual([]);
          }
        )
      );
    });

    it('should not affect highlights for other paths', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (pathA, pathB, hlA, hlB) => {
            fc.pre(pathA !== pathB);
            const t = new SnippetOffsetTracker();
            t.loadHighlights(pathA, hlA);
            t.loadHighlights(pathB, hlB);
            t.invalidateCache(pathA);
            expect(t.getHighlights(pathB)).toEqual(hlB);
          }
        )
      );
    });

    it('should be a no-op when no highlights are cached for the path', () => {
      fc.assert(
        fc.property(fc.string(), (path) => {
          const t = new SnippetOffsetTracker();
          expect(() => t.invalidateCache(path)).not.toThrow();
          expect(t.getHighlights(path)).toEqual([]);
        })
      );
    });
  });

  describe('updateHighlight', () => {
    it('should update start and end offsets of the matching highlight', () => {
      const h = createHighlight('abc', 10, 20);
      tracker.loadHighlights(filePath, [h]);
      tracker.updateHighlight(filePath, 'abc', { start: 50, end: 80 });
      const result = tracker.getHighlights(filePath);
      expect(result[0].start_offset).toBe(50);
      expect(result[0].end_offset).toBe(80);
    });

    it('should not modify other highlights in the same file', () => {
      const h1 = createHighlight('a', 10, 20);
      const h2 = createHighlight('b', 30, 40);
      tracker.loadHighlights(filePath, [h1, h2]);
      tracker.updateHighlight(filePath, 'a', { start: 100, end: 110 });
      const result = tracker.getHighlights(filePath);
      expect(result[1].start_offset).toBe(30);
      expect(result[1].end_offset).toBe(40);
    });

    it('should be a no-op when the snippetId does not exist in the file', () => {
      const h = createHighlight('real-id', 10, 20);
      tracker.loadHighlights(filePath, [h]);
      tracker.updateHighlight(filePath, 'nonexistent', { start: 99, end: 200 });
      const result = tracker.getHighlights(filePath);
      expect(result[0].start_offset).toBe(10);
      expect(result[0].end_offset).toBe(20);
    });

    it('should be a no-op when no highlights are cached for the path', () => {
      expect(() =>
        tracker.updateHighlight(filePath, 'any', { start: 0, end: 1 })
      ).not.toThrow();
    });

    it('should apply arbitrary valid offsets (property-based)', () => {
      fc.assert(
        fc.property(
          highlightArb,
          fc.nat({ max: 9000 }),
          fc.integer({ min: 1, max: 100 }),
          (h, newStart, width) => {
            const t = new SnippetOffsetTracker();
            t.loadHighlights(filePath, [h]);
            t.updateHighlight(filePath, h.id, {
              start: newStart,
              end: newStart + width,
            });
            const result = t.getHighlights(filePath);
            expect(result[0].start_offset).toBe(newStart);
            expect(result[0].end_offset).toBe(newStart + width);
          }
        )
      );
    });
  });

  describe('removeHighlight', () => {
    it('should remove the highlight with the matching id', () => {
      const h1 = createHighlight('x', 0, 5);
      const h2 = createHighlight('y', 10, 15);
      tracker.loadHighlights(filePath, [h1, h2]);
      tracker.removeHighlight(filePath, 'x');
      const result = tracker.getHighlights(filePath);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('y');
    });

    it('should be a no-op when id does not match any highlight', () => {
      const h = createHighlight('known', 0, 5);
      tracker.loadHighlights(filePath, [h]);
      tracker.removeHighlight(filePath, 'unknown');
      expect(tracker.getHighlights(filePath)).toHaveLength(1);
    });

    it('should be a no-op when no highlights are cached for the path', () => {
      expect(() =>
        tracker.removeHighlight(filePath, 'any')
      ).not.toThrow();
    });

    it('should not affect highlights for other paths (property-based)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { minLength: 1, maxLength: 5 }),
          fc.array(highlightArb, { minLength: 1, maxLength: 5 }),
          (pathA, pathB, hlA, hlB) => {
            fc.pre(pathA !== pathB);
            const t = new SnippetOffsetTracker();
            t.loadHighlights(pathA, hlA);
            t.loadHighlights(pathB, hlB);
            // Remove every highlight from pathA
            for (const h of hlA) t.removeHighlight(pathA, h.id);
            expect(t.getHighlights(pathB)).toEqual(hlB);
          }
        )
      );
    });
  });

  describe('renameFile', () => {
    it('should move highlights from oldPath to newPath', () => {
      const highlights = [createHighlight('1', 0, 10)];
      tracker.loadHighlights('old.md', highlights);
      tracker.renameFile('old.md', 'new.md');
      expect(tracker.getHighlights('new.md')).toEqual(highlights);
      expect(tracker.getHighlights('old.md')).toEqual([]);
    });

    it('should be a no-op when oldPath has no cached highlights', () => {
      tracker.renameFile('missing.md', 'new.md');
      expect(tracker.getHighlights('new.md')).toEqual([]);
    });

    it('should preserve highlights for unrelated paths (property-based)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.array(highlightArb, { maxLength: 5 }),
          fc.array(highlightArb, { maxLength: 5 }),
          (oldPath, newPath, otherPath, hlOld, hlOther) => {
            fc.pre(
              oldPath !== newPath &&
                oldPath !== otherPath &&
                newPath !== otherPath
            );
            const t = new SnippetOffsetTracker();
            t.loadHighlights(oldPath, hlOld);
            t.loadHighlights(otherPath, hlOther);
            t.renameFile(oldPath, newPath);
            expect(t.getHighlights(otherPath)).toEqual(hlOther);
          }
        )
      );
    });

    it('should transfer the exact same array reference (highlights mutated after rename are visible)', () => {
      const highlights = [createHighlight('1', 0, 10)];
      tracker.loadHighlights('old.md', highlights);
      tracker.renameFile('old.md', 'new.md');
      // Mutate the original array reference
      highlights[0].start_offset = 999;
      // The cache holds the same reference, so the mutation is visible
      expect(tracker.getHighlights('new.md')[0].start_offset).toBe(999);
    });
  });

  describe('clearAll', () => {
    it('should remove all cached highlights', () => {
      tracker.loadHighlights('a.md', [createHighlight('1', 0, 5)]);
      tracker.loadHighlights('b.md', [createHighlight('2', 0, 5)]);
      tracker.clearAll();
      expect(tracker.getHighlights('a.md')).toEqual([]);
      expect(tracker.getHighlights('b.md')).toEqual([]);
    });

    it('should be a no-op when cache is already empty', () => {
      expect(() => tracker.clearAll()).not.toThrow();
    });

    it('should clear highlights for all arbitrary paths (property-based)', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              path: fc.string({ minLength: 1 }),
              highlights: fc.array(highlightArb, { maxLength: 5 }),
            }),
            { minLength: 1, maxLength: 8 }
          ),
          (entries) => {
            const t = new SnippetOffsetTracker();
            for (const { path, highlights } of entries) {
              t.loadHighlights(path, highlights);
            }
            t.clearAll();
            for (const { path } of entries) {
              expect(t.getHighlights(path)).toEqual([]);
            }
          }
        )
      );
    });
  });
});
