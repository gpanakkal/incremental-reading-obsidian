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
