import type { ChangeSet } from '@codemirror/state';
import type { ISnippetBase } from './types';

type Span = [start: number, end: number];

/** Whether two spans share any text; a zero-length one shares none. */
const overlaps = (a: Span, b: Span) =>
  Math.max(a[0], b[0]) < Math.min(a[1], b[1]);

/** Whether `pos` lies inside `span`, not at either end. */
const inside = (pos: number, [start, end]: Span) => start < pos && pos < end;

/**
 * Whether a live span shares text with another, or the other sits collapsed
 * inside it — as overlapping snippets the user made, or a nested one erased,
 * do. Mapping keeps such pairs as they come; it only keeps the rest from
 * meeting. The other starting inside the live span covers both: a live one
 * there overlaps it, a collapsed one there is nested in it.
 */
const related = (live: Span, other: Span) =>
  overlaps(live, other) || inside(other[0], live);

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
   * The last edit each highlight went into live, by id, as a count of edits
   * mapped this session: for a collapsed one, the edit that erased it. Of
   * collapsed highlights re-expanding over the same text, the one erased last
   * takes it back; one not seen live since the tracker was made has no
   * count, and yields to any that has.
   */
  private lastLive = new Map<string, number>();
  private edits = 0;

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
   * Every file path holding a cache entry, including those cached as having no
   * highlights — an empty entry still means "this file was read from the
   * database", so it goes stale exactly like a populated one.
   *
   * Returns a snapshot rather than the live key iterator so a caller can reload
   * or invalidate entries while walking the result.
   */
  getTrackedPaths(): string[] {
    return [...this.highlightCache.keys()];
  }

  /**
   * Update highlight offsets using CodeMirror's position mapping.
   * This correctly handles multiple changes in a single transaction (e.g., undo).
   *
   * Two highlights that shared no text, neither collapsed inside the other,
   * share none after, and neither collapses inside the other. Pairs that did
   * — snippets the user made overlapping, or a nested one erased — map as
   * they come: nothing here weighs them. Mapping alone keeps the rest apart,
   * except where collapsed highlights at one place all re-expand over the
   * text put in there: the last of them erased takes it (by id, among those
   * loaded collapsed), and the rest stay collapsed. Where taking the
   * alternative would overlap a neighbour, the highlight that would move
   * yields, keeping the edit's placement — the text can't say whose like
   * character an edit took, and shrinking one highlight loses less than
   * doubling a character into two. (Undo and redo map here like any edit;
   * then `restoreHighlights` puts back exactly what they return to.)
   *
   * @param filePath The file being edited
   * @param changes The CodeMirror ChangeSet from the transaction
   * @param oldBodyStart Body start offset in the old document (before changes)
   * @param newBodyStart Body start offset in the new document (after changes)
   * @param alternative The same edit placed elsewhere, where it could go just
   *   as well (`a` put into `aa`, say). A highlight `changes` would grow or
   *   shrink takes this placement instead when it keeps the highlight's length,
   *   as an edit beside the highlight does — unless that would take it into
   *   another highlight's text. A collapsed highlight never takes it: whether
   *   it re-expands is the edit's to say.
   */
  updateOffsetsWithMapping(
    filePath: string,
    changes: ChangeSet,
    oldBodyStart: number,
    newBodyStart: number,
    alternative?: ChangeSet
  ) {
    const highlights = this.highlightCache.get(filePath);
    if (!highlights || highlights.length === 0) {
      return;
    }

    const mapped = highlights.map((highlight) => {
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

      const map = (through: ChangeSet): Span => {
        // mapPos transforms position through ALL changes atomically
        const newAbsoluteStart = through.mapPos(absoluteStart, startAssoc);
        const newAbsoluteEnd = through.mapPos(absoluteEnd, endAssoc);

        // Convert back to body-relative offsets in new document
        const newStart = Math.max(0, newAbsoluteStart - newBodyStart);
        // Allow zero-length highlights. Erasing the entire highlighted range
        // collapses it to zero length, which hides it (buildDecorations skips
        // ranges where start >= end) without destroying the record — so
        // deleting a highlight's text removes the highlight, and undo can
        // restore it. Clamping to `newStart` (not `newStart + 1`) also
        // prevents inverted ranges when the mapped end would fall before the
        // start.
        const newEnd = Math.max(newStart, newAbsoluteEnd - newBodyStart);
        return [newStart, newEnd];
      };

      const length = highlight.end_offset - highlight.start_offset;
      const span = map(changes);
      let wanted: Span | null = null;
      if (alternative && !isCollapsed && span[1] - span[0] !== length) {
        const alt = map(alternative);
        if (alt[1] - alt[0] === length) wanted = alt;
      }
      const before: Span = [highlight.start_offset, highlight.end_offset];
      return { span, wanted, isCollapsed, highlight, before };
    });

    // Ties go by id, whatever order the rows were loaded in
    const order = [...mapped].sort((a, b) =>
      a.highlight.id.localeCompare(b.highlight.id)
    );

    // Of re-expansions over the same text put back, the one erased last
    // takes it — typing back what was just erased gives it back to what it
    // erased (undo puts every one back itself) — and the rest stay
    // collapsed. One inside a live highlight re-expands along with it: that's
    // the nesting that was there before the erasure, coming back.
    const erasedAt = (m: (typeof mapped)[number]) =>
      this.lastLive.get(m.highlight.id) ?? 0;
    const collapsed = order
      .filter((m) => m.isCollapsed)
      .sort((a, b) => erasedAt(b) - erasedAt(a));
    collapsed.forEach((m, i) => {
      const taken = collapsed
        .slice(0, i)
        .some((other) => overlaps(m.span, other.span));
      if (taken) m.span = [m.span[0], m.span[0]];
    });
    // Take the alternative unless, for some highlight unrelated to this one
    // before the edit, it would overlap that one's new span, or newly hold
    // that one's start inside it (a collapsed one there would re-expand into
    // this one's text later). A highlight never blocks itself: a live span is
    // related to itself.
    order.forEach((m) => {
      const wanted = m.wanted;
      if (!wanted) return;
      const blocked = order.some(
        (other) =>
          !related(m.before, other.before) &&
          (overlaps(wanted, other.span) ||
            (inside(other.span[0], wanted) && !inside(other.span[0], m.span)))
      );
      if (!blocked) m.span = wanted;
    });

    // Those erased in one edit rank alike, then by id
    const now = ++this.edits;
    mapped.forEach(({ highlight, span, isCollapsed }) => {
      [highlight.start_offset, highlight.end_offset] = span;
      if (!isCollapsed) this.lastLive.set(highlight.id, now);
    });

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
   * Put highlights back at body-relative offsets, by id, as they were before
   * an edit undo or redo returns to. Those not among them stay where they are.
   */
  restoreHighlights(
    filePath: string,
    spans: readonly (readonly [id: string, start: number, end: number])[]
  ) {
    const byId = new Map(spans.map(([id, start, end]) => [id, [start, end]]));
    for (const highlight of this.getHighlights(filePath)) {
      const span = byId.get(highlight.id);
      if (span) [highlight.start_offset, highlight.end_offset] = span;
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
