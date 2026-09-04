// @vitest-environment jsdom

import {
  computeMinimalChange,
  isPersistableChange,
  reconcileIncomingValue,
} from '#/components/IREditor';
import { isExternalSync } from '#/lib/extensions/SnippetHighlightExtension';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// #region HELPERS

function makeView(doc: string): EditorView {
  const state = EditorState.create({ doc });
  return new EditorView({ state, parent: document.body });
}

/**
 * Capture the ViewUpdate produced by `dispatch`, the same object IREditor's
 * `onUpdate` override receives.
 */
function captureUpdate(
  doc: string,
  dispatch: (view: EditorView) => void
): ViewUpdate {
  let captured: ViewUpdate | null = null;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        EditorView.updateListener.of((update) => {
          captured = update;
        }),
      ],
    }),
    parent: document.body,
  });
  dispatch(view);
  view.destroy();
  if (captured === null) throw new Error('no ViewUpdate was produced');
  return captured;
}

/**
 * Mirror of the updateEditorContent dispatch in IREditor.tsx.
 * Keep in sync with that implementation.
 */
function dispatchExternalSync(view: EditorView, newContent: string): void {
  const change = computeMinimalChange(view.state.doc.toString(), newContent);
  if (!change) return;
  const { scrollTop, scrollLeft } = view.scrollDOM;
  view.dispatch({
    changes: change,
    annotations: isExternalSync.of(true),
  });
  view.scrollDOM.scrollTop = scrollTop;
  view.scrollDOM.scrollLeft = scrollLeft;
}

/**
 * The updateEditorContent branch, driven by the real reconcileIncomingValue:
 *   skip if value echoes one of our own in-flight saves (consumes it)
 *   skip if value === currentDoc (no change at all)
 *   apply otherwise (genuine external change)
 *
 * `pendingSaves` is mutated in place, exactly as the component's ref is.
 * Returns true if the replacement was applied, false if skipped.
 */
function conditionalReplacement(
  view: EditorView,
  value: string,
  pendingSaves: string[]
): boolean {
  if (
    reconcileIncomingValue(view.state.doc.toString(), value, pendingSaves) ===
    'skip'
  ) {
    return false;
  }
  dispatchExternalSync(view, value);
  return true;
}

/** Applies a change the way CodeMirror's ChangeSet does, for round-tripping. */
function applyChange(
  current: string,
  change: { from: number; to: number; insert: string }
): string {
  return (
    current.slice(0, change.from) + change.insert + current.slice(change.to)
  );
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** True when position `i` falls between the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, i: number): boolean {
  return (
    isHighSurrogate(text.charCodeAt(i - 1)) &&
    isLowSurrogate(text.charCodeAt(i))
  );
}

/**
 * A document built from a shared head, a differing middle, and a shared tail —
 * the shape every real external sync takes, since a note edited elsewhere keeps
 * most of its text.
 */
const localEditArb = fc
  .record({
    head: fc.string({ minLength: 1, maxLength: 60 }),
    tail: fc.string({ minLength: 1, maxLength: 60 }),
    oldMiddle: fc.string({ minLength: 1, maxLength: 30 }),
    newMiddle: fc.string({ minLength: 1, maxLength: 30 }),
  })
  // The middles must differ at both ends, or the algorithm legitimately
  // absorbs the matching characters into the shared prefix/suffix and the
  // exact boundary assertions below would not hold.
  .filter(
    ({ oldMiddle, newMiddle }) =>
      oldMiddle[0] !== newMiddle[0] &&
      oldMiddle[oldMiddle.length - 1] !== newMiddle[newMiddle.length - 1]
  );

// #endregion

describe('computeMinimalChange narrows a whole-document swap to the differing span', () => {
  it('returns null when the incoming text already matches the document', () => {
    expect(computeMinimalChange('same text', 'same text')).toBeNull();
  });

  it('returns null for two empty strings', () => {
    expect(computeMinimalChange('', '')).toBeNull();
  });

  it('reports the exact span when a card line is undone out of the middle of a note', () => {
    const before = 'intro\ncard line\noutro';
    const after = 'intro\noutro';

    expect(computeMinimalChange(before, after)).toEqual({
      from: 6,
      to: 16,
      insert: '',
    });
  });

  it('reports an insertion as a zero-width replacement at the insertion point', () => {
    expect(computeMinimalChange('ab', 'aXb')).toEqual({
      from: 1,
      to: 1,
      insert: 'X',
    });
  });

  it('replaces the whole document when nothing at all is shared', () => {
    expect(computeMinimalChange('abc', 'xyz')).toEqual({
      from: 0,
      to: 3,
      insert: 'xyz',
    });
  });

  it('reconstructs the incoming text exactly (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 120 }),
        fc.string({ unit: 'binary', maxLength: 120 }),
        async (current, next) => {
          const change = computeMinimalChange(current, next);
          // A null result must mean the texts already match; anything else
          // would silently drop an external edit.
          if (change === null) {
            expect(current).toBe(next);
            return;
          }
          expect(applyChange(current, change)).toBe(next);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('keeps from and to inside the current document and in order (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 120 }),
        fc.string({ unit: 'binary', maxLength: 120 }),
        async (current, next) => {
          const change = computeMinimalChange(current, next);
          if (change === null) return;
          expect(change.from).toBeGreaterThanOrEqual(0);
          expect(change.to).toBeGreaterThanOrEqual(change.from);
          expect(change.to).toBeLessThanOrEqual(current.length);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('leaves the shared head and tail outside the changed span (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        localEditArb,
        async ({ head, tail, oldMiddle, newMiddle }) => {
          const current = head + oldMiddle + tail;
          const next = head + newMiddle + tail;

          const change = computeMinimalChange(current, next);

          // Anything less than this and the scroll anchor — a position in the
          // head — would fall inside the deleted range and collapse.
          expect(change).not.toBeNull();
          expect(change!.from).toBeGreaterThanOrEqual(head.length);
          expect(change!.to).toBeLessThanOrEqual(
            head.length + oldMiddle.length
          );
        }
      ),
      { numRuns: 300 }
    );
  });

  it('never places a boundary inside a surrogate pair (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 80 }),
        fc.string({ unit: 'binary', maxLength: 80 }),
        async (current, next) => {
          const change = computeMinimalChange(current, next);
          if (change === null) return;
          // A boundary inside an astral character hands CodeMirror a position
          // that is not a valid cursor location.
          expect(splitsSurrogatePair(current, change.from)).toBe(false);
          expect(splitsSurrogatePair(current, change.to)).toBe(false);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('widens past a shared astral character rather than splitting it', () => {
    // Both strings start with the same emoji, so a naive scan would stop the
    // prefix between its two code units.
    const change = computeMinimalChange('\u{1F600}a', '\u{1F600}b');

    expect(change).toEqual({ from: 2, to: 3, insert: 'b' });
  });

  it('widens when the two texts share only the leading half of a pair', () => {
    // \u{1F600} and \u{1F601} share their high surrogate but differ in the low
    // one, so the scan would otherwise cut the pair in half.
    const change = computeMinimalChange('\u{1F600}', '\u{1F601}');

    expect(change).not.toBeNull();
    expect(change!.from).toBe(0);
    expect(applyChange('\u{1F600}', change!)).toBe('\u{1F601}');
  });

  it('widens when the two texts share only the trailing half of a pair', () => {
    // \u{1F600} is D83D DE00 and \u{1FA00} is D83E DE00: the suffix scan matches
    // the shared low surrogate and stops mid-pair, putting the boundary between
    // the halves of the character still in the document.
    const change = computeMinimalChange('\u{1F600}', '\u{1FA00}');

    expect(change).toEqual({ from: 0, to: 2, insert: '\u{1FA00}' });
  });

  it('handles astral characters that share either surrogate half (property-based)', async () => {
    // Emoji drawn at random almost never share a surrogate half, so a pool of
    // characters chosen to share one or the other is needed to reach the
    // boundary adjustments at all. D83D DE00 / D83E DE00 share the low half;
    // D83D DE00 / D83D DE01 share the high half.
    const astralText = fc
      .array(
        fc.constantFrom(
          '\u{1F600}',
          '\u{1FA00}',
          '\u{1F601}',
          '\u{1F9A0}',
          'a',
          '\n'
        ),
        { maxLength: 12 }
      )
      .map((chars) => chars.join(''));

    await fc.assert(
      fc.asyncProperty(astralText, astralText, async (current, next) => {
        const change = computeMinimalChange(current, next);
        if (change === null) {
          expect(current).toBe(next);
          return;
        }
        expect(applyChange(current, change)).toBe(next);
        expect(splitsSurrogatePair(current, change.from)).toBe(false);
        expect(splitsSurrogatePair(current, change.to)).toBe(false);
      }),
      { numRuns: 1000 }
    );
  });
});

describe('updateEditorContent keeps CodeMirror scroll anchor mappable', () => {
  // CodeMirror holds the viewport still by remapping the position of the line
  // at the top of the screen through the ChangeSet. These tests assert on that
  // mapping directly: jsdom has no layout, so scrollTop itself proves nothing.

  const makeDoc = (lines: number, marker = 'body') =>
    Array.from({ length: lines }, (_, i) => `line ${i} ${marker}`).join('\n');

  it('maps a viewport-top anchor to itself when the edit is below it', () => {
    const before = makeDoc(60);
    const after = before.replace('line 50 body', 'line 50 edited elsewhere');
    const anchorPos = before.indexOf('line 30 body');

    const update = captureUpdate(before, (view) =>
      dispatchExternalSync(view, after)
    );

    // The regression: a full-document replacement collapsed this to 0, and the
    // next measure pass scrolled line 0 back under the viewport top.
    expect(update.changes.mapPos(anchorPos, -1)).toBe(anchorPos);
  });

  it('maps a viewport-top anchor onto the same line when the edit is above it', () => {
    const before = makeDoc(60);
    const after = before.replace('line 10 body', 'line 10 body\ninserted line');
    const anchorPos = before.indexOf('line 30 body');

    const update = captureUpdate(before, (view) =>
      dispatchExternalSync(view, after)
    );

    const mapped = update.changes.mapPos(anchorPos, -1);

    // The anchor shifts by the inserted text, which is exactly what lets
    // CodeMirror adjust scrollTop so the line stays put on screen.
    expect(mapped).toBe(anchorPos + '\ninserted line'.length);
    expect(after.slice(mapped, mapped + 'line 30 body'.length)).toBe(
      'line 30 body'
    );
  });

  it('maps an anchor at any untouched position to itself (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        localEditArb.chain((edit) =>
          fc.record({
            edit: fc.constant(edit),
            // Any position within the shared head, where a scroll anchor above
            // the edit would sit.
            anchorPos: fc.integer({ min: 0, max: edit.head.length }),
          })
        ),
        async ({ edit, anchorPos }) => {
          const { head, tail, oldMiddle, newMiddle } = edit;
          const current = head + oldMiddle + tail;

          const update = captureUpdate(current, (view) =>
            dispatchExternalSync(view, head + newMiddle + tail)
          );

          expect(update.changes.mapPos(anchorPos, -1)).toBe(anchorPos);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('isPersistableChange keeps fetched content from being written back', () => {
  it('rejects the change updateEditorContent dispatches', () => {
    // The regression: this carries text fetched for whichever item is current
    // now, while the editor still saves to the item it mounted with.
    // Persisting it overwrites that item's note with the other's text.
    const update = captureUpdate('article body', (view) =>
      dispatchExternalSync(view, 'card body {{answer}}')
    );

    expect(isPersistableChange(update)).toBe(false);
  });

  it('accepts a change the user typed', () => {
    const update = captureUpdate('article body', (view) =>
      view.dispatch({
        changes: { from: 12, insert: ' extended' },
        userEvent: 'input.type',
      })
    );

    expect(isPersistableChange(update)).toBe(true);
  });

  it('accepts a user edit that arrives without a userEvent annotation', () => {
    // Editor commands and plugin-issued edits often carry no userEvent. They
    // are still this editor's own content and must reach disk.
    const update = captureUpdate('article body', (view) =>
      view.dispatch({ changes: { from: 0, insert: '# ' } })
    );

    expect(isPersistableChange(update)).toBe(true);
  });

  it('rejects a selection-only update', () => {
    const update = captureUpdate('article body', (view) =>
      view.dispatch({ selection: EditorSelection.cursor(3) })
    );

    expect(isPersistableChange(update)).toBe(false);
  });

  it('rejects any sync carrying the external-sync annotation, whatever the content (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(
            fc.string({ minLength: 0, maxLength: 200 }),
            fc.string({ minLength: 0, maxLength: 200 })
          )
          .filter(([initial, incoming]) => initial !== incoming),
        async ([initial, incoming]) => {
          const update = captureUpdate(initial, (view) =>
            dispatchExternalSync(view, incoming)
          );

          // Every value pushed in from outside is already on disk, so none of
          // them may be saved — regardless of which item's file it came from.
          expect(isPersistableChange(update)).toBe(false);
        }
      )
    );
  });

  it('accepts every unannotated document change (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        async (inserted) => {
          const update = captureUpdate('doc', (view) =>
            view.dispatch({ changes: { from: 0, insert: inserted } })
          );

          expect(isPersistableChange(update)).toBe(true);
        }
      )
    );
  });
});

describe('updateEditorContent preserves cursor position', () => {
  it('leaves a cursor sitting before the edit exactly where it was', () => {
    const view = makeView('intro\ncard line\noutro');
    view.dispatch({ selection: EditorSelection.cursor(3) });

    dispatchExternalSync(view, 'intro\noutro');

    expect(view.state.selection.main.head).toBe(3);
    view.destroy();
  });

  it('shifts a cursor sitting after the edit by the length the edit removed', () => {
    const before = 'intro\ncard line\noutro';
    const view = makeView(before);
    const cursor = before.indexOf('outro') + 2;
    view.dispatch({ selection: EditorSelection.cursor(cursor) });

    dispatchExternalSync(view, 'intro\noutro');

    // 'card line\n' (10 chars) disappeared from above the cursor, so the
    // cursor must move back by 10 to stay on the same character.
    expect(view.state.selection.main.head).toBe(cursor - 10);
    expect(
      view.state.doc.toString().slice(0, view.state.selection.main.head)
    ).toBe('intro\nou');
    view.destroy();
  });

  it('keeps a selection range anchored to the same characters across an edit above it', () => {
    const before = 'HEAD\nmiddle\nTAIL';
    const view = makeView(before);
    const anchor = before.indexOf('TAIL');
    view.dispatch({ selection: EditorSelection.range(anchor, anchor + 4) });

    dispatchExternalSync(view, 'HEAD\nmiddle text\nTAIL');

    const { from, to } = view.state.selection.main;
    expect(view.state.doc.toString().slice(from, to)).toBe('TAIL');
    view.destroy();
  });

  it('keeps the cursor on the same character for any edit above it (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        localEditArb,
        async ({ head, tail, oldMiddle, newMiddle }) => {
          const current = head + oldMiddle + tail;
          const view = makeView(current);
          // Cursor in the tail, i.e. below the edit.
          const cursor = head.length + oldMiddle.length + tail.length;
          view.dispatch({ selection: EditorSelection.cursor(cursor) });

          dispatchExternalSync(view, head + newMiddle + tail);

          expect(view.state.selection.main.head).toBe(
            head.length + newMiddle.length + tail.length
          );
          view.destroy();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('clamps the cursor into the document when the incoming text is empty', () => {
    const view = makeView('hello world');
    view.dispatch({ selection: EditorSelection.cursor(6) });

    dispatchExternalSync(view, '');

    expect(view.state.doc.toString()).toBe('');
    expect(view.state.selection.main.head).toBe(0);
    view.destroy();
  });

  it('leaves the cursor inside the document for any incoming text (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 2, maxLength: 200 }).chain((initial) =>
          fc.record({
            initialContent: fc.constant(initial),
            cursorPos: fc.integer({ min: 0, max: initial.length }),
            newContent: fc
              .string({ minLength: 0, maxLength: 200 })
              .filter((s) => s !== initial),
          })
        ),
        async ({ initialContent, cursorPos, newContent }) => {
          const view = makeView(initialContent);
          view.dispatch({ selection: EditorSelection.cursor(cursorPos) });

          dispatchExternalSync(view, newContent);

          expect(view.state.doc.toString()).toBe(newContent);
          expect(view.state.selection.main.head).toBeGreaterThanOrEqual(0);
          expect(view.state.selection.main.head).toBeLessThanOrEqual(
            newContent.length
          );
          view.destroy();
        }
      )
    );
  });
});

describe('updateEditorContent skips stale own-save echoes and applies genuine external changes', () => {
  it('does not apply a replacement when the fetched value equals the last saved content (own-save echo)', () => {
    // Scenario: user saved "hello" then typed " world" → editor now has "hello world".
    // A stale fetch returns "hello" (matching lastSaved). The guard must detect this
    // as our own echo and skip — otherwise the editor reverts to "hello" and
    // the cursor lands in the wrong place.
    const lastSaved = 'hello';
    const editorContent = 'hello world'; // user has typed " world" since last save
    const view = makeView(editorContent);
    view.dispatch({ selection: EditorSelection.cursor(11) }); // cursor at end

    const applied = conditionalReplacement(view, lastSaved, [lastSaved]);

    expect(applied).toBe(false);
    expect(view.state.doc.toString()).toBe(editorContent);
    expect(view.state.selection.main.head).toBe(11);
    view.destroy();
  });

  it('applies a replacement when the fetched value differs from both editor and last save (external change)', () => {
    // Someone else edited the file externally. The fetch returns content the
    // editor has never seen → must apply.
    const lastSaved = 'hello';
    const externalChange = 'hello (edited externally)';
    const view = makeView('hello world');
    view.dispatch({ selection: EditorSelection.cursor(5) });

    const applied = conditionalReplacement(view, externalChange, [lastSaved]);

    expect(applied).toBe(true);
    expect(view.state.doc.toString()).toBe(externalChange);
    view.destroy();
  });

  it('preserves editor content and cursor when a stale-echo replacement is correctly skipped (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }).chain((saved) =>
          // suffix represents characters typed since the last save
          fc.string({ minLength: 1, maxLength: 50 }).chain((suffix) => {
            const editorContent = saved + suffix;
            return fc.record({
              lastSaved: fc.constant(saved),
              editorContent: fc.constant(editorContent),
              // cursor can be anywhere in the full typed content, including the suffix
              cursorPos: fc.integer({ min: 0, max: editorContent.length }),
            });
          })
        ),
        async ({ lastSaved, editorContent, cursorPos }) => {
          const view = makeView(editorContent);
          view.dispatch({ selection: EditorSelection.cursor(cursorPos) });

          // Stale fetch returns the last-saved content.
          // conditionalReplacement (the fixed guard) must skip.
          const applied = conditionalReplacement(view, lastSaved, [lastSaved]);

          expect(applied).toBe(false);
          expect(view.state.doc.toString()).toBe(editorContent);
          expect(view.state.selection.main.head).toBe(cursorPos);
          view.destroy();
        }
      )
    );
  });

  it('skips the echo of an earlier save still round-tripping when a newer save is pending (the swallowed-write bug)', () => {
    // The pasted paragraph's disk write ("para") is still in flight when the
    // next keystroke saves ("para x"); both are unacknowledged.
    const pending = ['para', 'para x'];
    const view = makeView('para x'); // editor already shows the newer text
    view.dispatch({ selection: EditorSelection.cursor('para x'.length) });

    // The slow paste-write echoes back first, carrying the OLDER "para".
    const applied = conditionalReplacement(view, 'para', pending);

    // A single-slot "last saved" guard (holding only "para x") would treat this
    // as external and delete the " x". It must be recognised as our own echo.
    expect(applied).toBe(false);
    expect(view.state.doc.toString()).toBe('para x');
    expect(view.state.selection.main.head).toBe('para x'.length);
    // The consumed echo is removed; the newer save stays pending for its echo.
    expect(pending).toEqual(['para x']);
    view.destroy();
  });

  it('still applies a genuine external edit while our own saves are in flight', () => {
    const pending = ['para', 'para x'];
    const view = makeView('para x');
    view.dispatch({ selection: EditorSelection.cursor('para x'.length) });

    // Content we never wrote — edited in another pane — is not in the list.
    const applied = conditionalReplacement(view, 'para y', pending);

    expect(applied).toBe(true);
    expect(view.state.doc.toString()).toBe('para y');
    // No pending save is consumed by an unrelated external edit.
    expect(pending).toEqual(['para', 'para x']);
    view.destroy();
  });
});

describe('reconcileIncomingValue consumes each own-save echo exactly once', () => {
  it('skips and removes the matched save, leaving the rest pending', () => {
    const pending = ['a', 'ab', 'abc'];
    expect(reconcileIncomingValue('abc', 'ab', pending)).toBe('skip');
    expect(pending).toEqual(['a', 'abc']);
  });

  it('removes only one occurrence when the same content was saved twice', () => {
    // Type x, delete x, type x again → "hello" is saved twice. Two echoes come
    // back; each must consume exactly one entry, so a later doc-advancing state
    // is not misread as a third echo.
    const pending = ['hello', 'hello'];
    expect(reconcileIncomingValue('hello!', 'hello', pending)).toBe('skip');
    expect(pending).toEqual(['hello']);
    expect(reconcileIncomingValue('hello!', 'hello', pending)).toBe('skip');
    expect(pending).toEqual([]);
    // A third identical value has nothing left to match and, with the doc moved
    // on, is treated as an external edit.
    expect(reconcileIncomingValue('hello!', 'hello', pending)).toBe('apply');
  });

  it('applies content that was never saved and leaves the pending list intact', () => {
    const pending = ['a', 'b'];
    expect(reconcileIncomingValue('a', 'external', pending)).toBe('apply');
    expect(pending).toEqual(['a', 'b']);
  });

  it('skips when value equals currentDoc even with nothing pending', () => {
    const pending: string[] = [];
    expect(reconcileIncomingValue('same', 'same', pending)).toBe('skip');
    expect(pending).toEqual([]);
  });

  it('never applies an echo of any in-flight save, and consumes one entry (property-based)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 8 }),
        fc.string({ maxLength: 60 }),
        fc.nat(),
        (saves, currentDoc, pick) => {
          // The incoming value is one of the in-flight saves — its own echo.
          const echo = saves[pick % saves.length];
          const pending = [...saves];
          const before = pending.length;

          const result = reconcileIncomingValue(currentDoc, echo, pending);

          // An echo of one of our writes is never applied over the document,
          // whatever the document has since become...
          expect(result).toBe('skip');
          // ...and exactly one matching entry is consumed.
          expect(pending.length).toBe(before - 1);
        }
      )
    );
  });
});

describe('updateEditorContent restores scrollDOM scroll position after replacement', () => {
  it('restores scrollTop and scrollLeft to their pre-dispatch values after replacement (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          initialContent: fc.string({ minLength: 0, maxLength: 100 }),
          scrollTop: fc.integer({ min: 1, max: 5000 }),
          scrollLeft: fc.integer({ min: 0, max: 1000 }),
          newContent: fc.string({ minLength: 0, maxLength: 100 }),
        }),
        async ({ initialContent, scrollTop, scrollLeft, newContent }) => {
          const view = makeView(initialContent);

          // Set the pre-dispatch scroll position.
          view.scrollDOM.scrollTop = scrollTop;
          view.scrollDOM.scrollLeft = scrollLeft;

          // Ensure the dispatch actually fires (content must differ from current doc).
          const content =
            newContent !== initialContent ? newContent : newContent + '\x00';
          dispatchExternalSync(view, content);

          // Keeping scrollTop equal to the value CodeMirror recorded at its
          // last measure is what stops it discarding the scroll anchor.
          expect(view.scrollDOM.scrollTop).toBe(scrollTop);
          expect(view.scrollDOM.scrollLeft).toBe(scrollLeft);

          view.destroy();
        }
      )
    );
  });
});

describe('updateEditorContent skips when currentDoc already equals the incoming value', () => {
  it('does not apply a replacement when the fetched value equals the current editor content (no-op guard)', () => {
    // The editor already has the content that arrived from the prop.
    // Applying would be a no-op, but dispatching anyway wastes cycles and
    // resets scroll — the guard should skip.
    const currentContent = 'unchanged content';
    const view = makeView(currentContent);
    view.dispatch({ selection: EditorSelection.cursor(5) });

    // value === currentDoc, so conditionalReplacement must skip even though the
    // pending list holds an unrelated save that will never match.
    const applied = conditionalReplacement(view, currentContent, [
      'something else',
    ]);

    expect(applied).toBe(false);
    expect(view.state.doc.toString()).toBe(currentContent);
    expect(view.state.selection.main.head).toBe(5);
    view.destroy();
  });

  it('does not apply a replacement when fetched value matches current doc regardless of lastSaved (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          content: fc.string({ minLength: 0, maxLength: 100 }),
          lastSaved: fc.string({ minLength: 0, maxLength: 100 }),
          cursorPos: fc.integer({ min: 0, max: 100 }),
        }),
        async ({ content, lastSaved, cursorPos }) => {
          const view = makeView(content);
          const clampedCursor = Math.min(cursorPos, content.length);
          view.dispatch({ selection: EditorSelection.cursor(clampedCursor) });

          // value === currentDoc → must always skip, whatever the pending list holds.
          const applied = conditionalReplacement(view, content, [lastSaved]);

          expect(applied).toBe(false);
          expect(view.state.doc.toString()).toBe(content);
          expect(view.state.selection.main.head).toBe(clampedCursor);
          view.destroy();
        }
      )
    );
  });
});

describe('updateEditorContent applies genuine external changes (property-based)', () => {
  it('applies the change when value differs from both currentDoc and lastSaved (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 100 }).chain((editorContent) =>
          fc
            .string({ minLength: 0, maxLength: 100 })
            // lastSaved must differ from externalValue to avoid the echo guard.
            .chain((lastSaved) =>
              fc
                .string({ minLength: 0, maxLength: 100 })
                .filter((v) => v !== editorContent && v !== lastSaved)
                .chain((externalValue) =>
                  fc.record({
                    editorContent: fc.constant(editorContent),
                    lastSaved: fc.constant(lastSaved),
                    externalValue: fc.constant(externalValue),
                    cursorPos: fc.integer({
                      min: 0,
                      max: Math.max(editorContent.length, 0),
                    }),
                  })
                )
            )
        ),
        async ({ editorContent, lastSaved, externalValue, cursorPos }) => {
          const view = makeView(editorContent);
          const clampedCursor = Math.min(cursorPos, editorContent.length);
          view.dispatch({ selection: EditorSelection.cursor(clampedCursor) });

          const applied = conditionalReplacement(view, externalValue, [
            lastSaved,
          ]);

          // Must have applied the change.
          expect(applied).toBe(true);
          expect(view.state.doc.toString()).toBe(externalValue);
          // Cursor must land within the new document bounds.
          expect(view.state.selection.main.head).toBeLessThanOrEqual(
            externalValue.length
          );
          view.destroy();
        }
      ),
      { numRuns: 200 }
    );
  });
});
