import { ChangeSet, type ChangeSpec, type Text } from '@codemirror/state';

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The narrowest replacement that turns `current` into `next`, or `null` when
 * they already match.
 *
 * CodeMirror holds the viewport still across a document change by remembering
 * the line at the top of the screen and re-locating it afterwards: `ViewState`
 * saves `scrollAnchorPos = changes.mapPos(anchor.from, -1)`, then the next
 * measure pass shifts `scrollDOM.scrollTop` by however far that line moved. A
 * `{from: 0, to: doc.length}` replacement deletes the anchor along with the
 * rest of the document, so `mapPos` collapses it to 0 and the measure pass
 * dutifully scrolls line 0 back under the viewport top — the jump to the top of
 * the note. That correction lands on the next animation frame, which is why
 * restoring `scrollTop` by hand right after the dispatch cannot prevent it.
 *
 * Trimming the shared prefix and suffix leaves the anchor outside the changed
 * range, where it maps to itself. It also lets the selection map correctly
 * instead of collapsing, and spares undo history and decorations from a
 * needless rebuild.
 *
 * @param placement where to put the change when it could go in more than one
 *   place — putting `a` into `aa` makes `aaa` wherever it goes: `'latest'`
 *   trims the shared prefix first, `'earliest'` the shared suffix.
 */
export function computeMinimalChange(
  current: string,
  next: string,
  placement: 'latest' | 'earliest' = 'latest'
): { from: number; to: number; insert: string } | null {
  if (current === next) return null;

  const shorter = Math.min(current.length, next.length);
  /** How many code units from the start (or end) both texts share, up to `limit`. */
  const shared = (limit: number, fromEnd: boolean) => {
    let n = 0;
    while (
      n < limit &&
      (fromEnd
        ? current.charCodeAt(current.length - 1 - n) ===
          next.charCodeAt(next.length - 1 - n)
        : current.charCodeAt(n) === next.charCodeAt(n))
    ) {
      n++;
    }
    return n;
  };
  let prefix: number;
  let suffix: number;
  if (placement === 'latest') {
    prefix = shared(shorter, false);
    suffix = shared(shorter - prefix, true);
  } else {
    suffix = shared(shorter, true);
    prefix = shared(shorter - suffix, false);
  }

  // Both boundaries are code-unit offsets, so either can land between the
  // halves of a surrogate pair and hand CodeMirror a position inside an
  // astral character. Widening the changed range by one unit swallows the pair
  // whole; it can never underflow, since `charCodeAt` off either end is NaN.
  if (isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;
  if (isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--;

  return {
    from: prefix,
    to: current.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

/**
 * `changes` with each of its replacements narrowed by
 * {@link computeMinimalChange} to the text it really changes. The document it
 * makes of `doc` is the same; only what a position inside a replaced span maps
 * to differs.
 *
 * A position mapped through a replacement can't follow the text it was on:
 * Obsidian's `editor.setValue` replaces the whole document even where it
 * changes a word or nothing at all, and its table editor rewrites a whole
 * table to change one cell, so every position inside lands at one end.
 *
 * @param doc the document `changes` apply to
 * @param placement see {@link computeMinimalChange}
 */
export function narrowChanges(
  changes: ChangeSet,
  doc: Text,
  placement: 'latest' | 'earliest' = 'latest'
): ChangeSet {
  const narrowed: ChangeSpec[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const change = computeMinimalChange(
      doc.sliceString(fromA, toA),
      inserted.toString(),
      placement
    );
    if (change) {
      narrowed.push({
        from: fromA + change.from,
        to: fromA + change.to,
        insert: change.insert,
      });
    }
  });
  return ChangeSet.of(narrowed, changes.length);
}
