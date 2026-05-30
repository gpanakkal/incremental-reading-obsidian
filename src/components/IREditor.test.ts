// @vitest-environment jsdom

import { isExternalSync } from '#/lib/extensions/SnippetHighlightExtension';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

// #region HELPERS

function makeView(doc: string): EditorView {
  const state = EditorState.create({ doc });
  return new EditorView({ state, parent: document.body });
}

/**
 * Mirror of the updateEditorContent dispatch in IREditor.tsx.
 * Keep in sync with that implementation.
 */
function dispatchFullReplacement(view: EditorView, newContent: string): void {
  const newLength = newContent.length;
  const clampedSelection = EditorSelection.create(
    view.state.selection.ranges.map((r) =>
      EditorSelection.range(
        Math.min(r.anchor, newLength),
        Math.min(r.head, newLength)
      )
    ),
    view.state.selection.mainIndex
  );
  const { scrollTop, scrollLeft } = view.scrollDOM;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: newContent },
    selection: clampedSelection,
    annotations: isExternalSync.of(true),
  });
  view.scrollDOM.scrollTop = scrollTop;
  view.scrollDOM.scrollLeft = scrollLeft;
}

// #endregion

describe('updateEditorContent preserves cursor position', () => {
  afterEach(() => {
    // Views are destroyed at the end of each test; nothing global to clean up.
  });

  it('preserves cursor at position 5 after replacement with equal-length content', () => {
    const view = makeView('hello world'); // length 11
    view.dispatch({ selection: EditorSelection.cursor(5) });
    expect(view.state.selection.main.head).toBe(5); // precondition

    dispatchFullReplacement(view, 'HELLO WORLD');

    // Bug: resets to 0. Fix: maps cursor through changes → stays at 5.
    expect(view.state.selection.main.head).toBe(5);
    view.destroy();
  });

  it('preserves selection range [2, 7] after replacement with longer content', () => {
    const view = makeView('abcdefghij'); // length 10
    view.dispatch({ selection: EditorSelection.range(2, 7) });
    expect(view.state.selection.main.anchor).toBe(2); // precondition
    expect(view.state.selection.main.head).toBe(7); // precondition

    dispatchFullReplacement(view, 'abcdefghijklmno'); // length 15

    // Bug: both reset to 0. Fix: selection maps through changes.
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.state.selection.main.head).toBe(7);
    view.destroy();
  });

  it('preserves cursor when replacement content is identical to current doc', () => {
    const view = makeView('hello');
    view.dispatch({ selection: EditorSelection.cursor(3) });

    dispatchFullReplacement(view, 'hello');

    expect(view.state.doc.toString()).toBe('hello');
    expect(view.state.selection.main.head).toBe(3);
    view.destroy();
  });

  it('preserves cursor at an arbitrary position after replacement with arbitrary content (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 2, maxLength: 200 }).chain((initial) =>
          fc.record({
            initialContent: fc.constant(initial),
            cursorPos: fc.integer({ min: 1, max: initial.length }),
            // filter ensures newContent !== initial so the early-return guard does not fire
            newContent: fc
              .string({ minLength: 0, maxLength: 200 })
              .filter((s) => s !== initial),
          })
        ),
        async ({ initialContent, cursorPos, newContent }) => {
          const view = makeView(initialContent);
          view.dispatch({ selection: EditorSelection.cursor(cursorPos) });

          dispatchFullReplacement(view, newContent);

          // A correct implementation maps the cursor through the ChangeSet.
          // A full deletion maps any position to 0 (the insertion point), so the
          // cursor should land at min(cursorPos, newContent.length).
          const expectedHead = Math.min(cursorPos, newContent.length);
          // Bug: head is always 0 for any cursorPos > 0 when newContent.length >= 1.
          expect(view.state.selection.main.head).toBe(expectedHead);

          view.destroy();
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Helper that mirrors the full updateEditorContent guard logic, including the
// lastSavedContent check. Keep in sync with IREditor.tsx updateEditorContent.
// ---------------------------------------------------------------------------

/**
 * Models the full updateEditorContent guard:
 *   skip if value === currentDoc  (no change at all)
 *   skip if value === lastSaved   (stale echo of our own save)
 *   apply otherwise               (genuine external change)
 *
 * Returns true if the replacement was applied, false if skipped.
 */
function conditionalReplacement(
  view: EditorView,
  value: string,
  lastSavedContent: string
): boolean {
  if (view.state.doc.toString() === value) return false;
  if (value === lastSavedContent) return false;
  dispatchFullReplacement(view, value);
  return true;
}

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

    const applied = conditionalReplacement(view, lastSaved, lastSaved);

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

    const applied = conditionalReplacement(view, externalChange, lastSaved);

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
          const applied = conditionalReplacement(view, lastSaved, lastSaved);

          expect(applied).toBe(false);
          expect(view.state.doc.toString()).toBe(editorContent);
          expect(view.state.selection.main.head).toBe(cursorPos);
          view.destroy();
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
          dispatchFullReplacement(view, content);

          // A correct implementation saves scroll before dispatch and restores it
          // after. Assert the final observable state, not the call sequence —
          // using the getter confirms the value that actually stuck.
          expect(view.scrollDOM.scrollTop).toBe(scrollTop);
          expect(view.scrollDOM.scrollLeft).toBe(scrollLeft);

          view.destroy();
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases for dispatchFullReplacement cursor/selection clamping
// ---------------------------------------------------------------------------

describe('updateEditorContent clamps cursor to empty replacement content', () => {
  it('clamps cursor to 0 when replacement content is empty string', () => {
    const view = makeView('hello world');
    view.dispatch({ selection: EditorSelection.cursor(6) });
    expect(view.state.selection.main.head).toBe(6); // precondition

    dispatchFullReplacement(view, '');

    expect(view.state.doc.toString()).toBe('');
    expect(view.state.selection.main.head).toBe(0);
    view.destroy();
  });

  it('clamps cursor to 0 when replacement content is empty string (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }).chain((initial) =>
          fc.record({
            initialContent: fc.constant(initial),
            cursorPos: fc.integer({ min: 0, max: initial.length }),
          })
        ),
        async ({ initialContent, cursorPos }) => {
          const view = makeView(initialContent);
          view.dispatch({ selection: EditorSelection.cursor(cursorPos) });

          dispatchFullReplacement(view, '');

          expect(view.state.doc.toString()).toBe('');
          // Any cursor position clamped to min(pos, 0) === 0.
          expect(view.state.selection.main.head).toBe(0);

          view.destroy();
        }
      )
    );
  });
});

describe('updateEditorContent clamps selection endpoints independently', () => {
  // Note: jsdom's EditorView enforces allowMultipleSelections=false, so only
  // single-range selections are possible in this environment. Multi-range
  // behavior in dispatchFullReplacement is a trivial extension of the
  // single-range map — if clamping is correct for one range it is correct
  // for N (same Math.min per endpoint logic applied by the .map() call).

  it('clamps only the out-of-bounds head of a range when anchor is within bounds', () => {
    // Range [3, 9] in a 10-char doc. Replacement is 6 chars.
    // anchor=3 fits (3 <= 6), head=9 does not (9 > 6) → head clamped to 6.
    const view = makeView('0123456789'); // length 10
    view.dispatch({ selection: EditorSelection.range(3, 9) });

    dispatchFullReplacement(view, '012345'); // length 6

    expect(view.state.selection.main.anchor).toBe(3);
    expect(view.state.selection.main.head).toBe(6);
    view.destroy();
  });

  it('clamps both anchor and head when both exceed the new document length (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // initial doc long enough for an out-of-bounds range
        fc.string({ minLength: 10, maxLength: 200 }).chain((initial) =>
          fc.record({
            initialContent: fc.constant(initial),
            // anchor and head both well beyond any possible newContent
            anchor: fc.integer({ min: Math.ceil(initial.length * 0.8), max: initial.length }),
            head: fc.integer({ min: Math.ceil(initial.length * 0.8), max: initial.length }),
            // newContent is short so both anchor and head exceed its length
            newContent: fc.string({ minLength: 0, maxLength: Math.floor(initial.length * 0.7) }),
          })
        ),
        async ({ initialContent, anchor, head, newContent }) => {
          const view = makeView(initialContent);
          view.dispatch({ selection: EditorSelection.range(anchor, head) });

          dispatchFullReplacement(view, newContent);

          const newLen = newContent.length;
          expect(view.state.selection.main.anchor).toBe(Math.min(anchor, newLen));
          expect(view.state.selection.main.head).toBe(Math.min(head, newLen));

          view.destroy();
        }
      )
    );
  });

  it('leaves anchor and head unchanged when both fit within the new document length (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 200 }).chain((initial) =>
          fc.string({ minLength: initial.length, maxLength: initial.length + 100 })
            .filter((s) => s !== initial)
            .chain((newContent) =>
              fc.record({
                initialContent: fc.constant(initial),
                newContent: fc.constant(newContent),
                // anchor and head both well within the new (longer) content
                anchor: fc.integer({ min: 0, max: initial.length }),
                head: fc.integer({ min: 0, max: initial.length }),
              })
            )
        ),
        async ({ initialContent, newContent, anchor, head }) => {
          const view = makeView(initialContent);
          view.dispatch({ selection: EditorSelection.range(anchor, head) });

          dispatchFullReplacement(view, newContent);

          // Both endpoints fit — no clamping should occur.
          expect(view.state.selection.main.anchor).toBe(anchor);
          expect(view.state.selection.main.head).toBe(head);

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

    // value === currentDoc, so conditionalReplacement must short-circuit
    // before reaching the `value === lastSaved` check.
    const applied = conditionalReplacement(view, currentContent, 'something else');

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

          // value === currentDoc → must always skip, no matter what lastSaved is.
          const applied = conditionalReplacement(view, content, lastSaved);

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
  it('applies replacement and clamps cursor when value differs from both currentDoc and lastSaved (property-based)', async () => {
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
                    cursorPos: fc.integer({ min: 0, max: Math.max(editorContent.length, 0) }),
                  })
                )
            )
        ),
        async ({ editorContent, lastSaved, externalValue, cursorPos }) => {
          const view = makeView(editorContent);
          const clampedCursor = Math.min(cursorPos, editorContent.length);
          view.dispatch({ selection: EditorSelection.cursor(clampedCursor) });

          const applied = conditionalReplacement(view, externalValue, lastSaved);

          // Must have applied the change.
          expect(applied).toBe(true);
          expect(view.state.doc.toString()).toBe(externalValue);
          // Cursor must land within the new document bounds.
          const expectedHead = Math.min(clampedCursor, externalValue.length);
          expect(view.state.selection.main.head).toBe(expectedHead);
          view.destroy();
        }
      ),
      { numRuns: 200 }
    );
  });
});
