/** Character offsets into a piece of text, start first. */
export type TextBounds = readonly [start: number, end: number];

/**
 * Where `range` falls in the text of `container`, as offsets counted from the
 * start of that text, with any part of it outside the container cut off.
 * `null` when the range lies wholly outside the container, or in another
 * document.
 *
 * Counted through `Range.toString`, so the offsets index the concatenated text
 * nodes: exactly the source text when the container holds that text and
 * nothing else, however the browser has split it into nodes.
 */
export function rangeOffsetsWithin(
  container: Node,
  range: AbstractRange
): TextBounds | null {
  const doc = container.ownerDocument;
  if (!doc) return null;
  const whole = doc.createRange();
  whole.selectNodeContents(container);

  let startSide: number;
  let endSide: number;
  try {
    startSide = whole.comparePoint(range.startContainer, range.startOffset);
    endSide = whole.comparePoint(range.endContainer, range.endOffset);
  } catch {
    // A point in another tree, or on a node that cannot hold one.
    return null;
  }
  if (startSide > 0 || endSide < 0) return null;

  const lengthTo = (node: Node, offset: number) => {
    const before = doc.createRange();
    before.setStart(whole.startContainer, whole.startOffset);
    before.setEnd(node, offset);
    return before.toString().length;
  };
  const total = whole.toString().length;
  const start =
    startSide < 0 ? 0 : lengthTo(range.startContainer, range.startOffset);
  const end =
    endSide > 0 ? total : lengthTo(range.endContainer, range.endOffset);
  return [start, end];
}

/**
 * The text selected in `container` once the selection has changed to
 * `selection`, given what was selected there before.
 *
 * A selection inside the text replaces what came before, and one collapsed
 * inside it clears it: that is the user tapping the text to deselect. One
 * outside the text leaves the previous one standing, since pressing a button
 * moves the selection out of the text on some platforms, and must not lose
 * what the button was pressed to confirm.
 */
export function trackSelection(
  previous: TextBounds | null,
  container: Node,
  selection: Pick<Selection, 'rangeCount' | 'getRangeAt'> | null
): TextBounds | null {
  if (!selection || selection.rangeCount === 0) return previous;
  const bounds = rangeOffsetsWithin(container, selection.getRangeAt(0));
  if (!bounds) return previous;
  return bounds[0] === bounds[1] ? null : bounds;
}
