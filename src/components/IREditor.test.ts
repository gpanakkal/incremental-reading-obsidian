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
 * Verbatim copy of the buggy dispatch in IREditor.tsx updateEditorContent
 * (lines 363-370). This is the subject under test.
 * When the fix is applied to IREditor.tsx, update this helper to match.
 */
function dispatchFullReplacement(view: EditorView, newContent: string): void {
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: newContent,
    },
    annotations: isExternalSync.of(true),
  });
}

interface ScrollSpy {
  /** Values passed to the scrollTop setter after the spy was attached. */
  topCalls: number[];
  /** Values passed to the scrollLeft setter after the spy was attached. */
  leftCalls: number[];
  /** Remove the own-property overrides so the element falls back to the prototype. */
  restore(): void;
}

/**
 * Installs getter/setter spies directly on `element` for both scrollTop and
 * scrollLeft. Walks the prototype chain to locate the real descriptors (they
 * live on Element.prototype in jsdom 29), then shadows them with own-property
 * overrides so the original implementation still runs and the stored value
 * stays consistent.
 */
function spyOnScroll(element: Element): ScrollSpy {
  const topCalls: number[] = [];
  const leftCalls: number[] = [];

  function findDescriptor(name: string): PropertyDescriptor | undefined {
    let proto: object | null = Object.getPrototypeOf(element);
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc) return desc;
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return undefined;
  }

  const topDesc = findDescriptor('scrollTop');
  const leftDesc = findDescriptor('scrollLeft');

  Object.defineProperty(element, 'scrollTop', {
    get() {
      return topDesc?.get?.call(this) ?? 0;
    },
    set(v: number) {
      topCalls.push(v);
      topDesc?.set?.call(this, v);
    },
    configurable: true,
  });

  Object.defineProperty(element, 'scrollLeft', {
    get() {
      return leftDesc?.get?.call(this) ?? 0;
    },
    set(v: number) {
      leftCalls.push(v);
      leftDesc?.set?.call(this, v);
    },
    configurable: true,
  });

  return {
    topCalls,
    leftCalls,
    restore() {
      delete (element as unknown as Record<string, unknown>).scrollTop;
      delete (element as unknown as Record<string, unknown>).scrollLeft;
    },
  };
}

// #endregion

describe('Bug — updateEditorContent destroys cursor position', () => {
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

  it('does not disturb cursor when content is unchanged (early-return guard)', () => {
    // When value === doc content, the guard in updateEditorContent skips the dispatch.
    // This test documents that branch and confirms the guard itself is safe.
    const view = makeView('hello');
    view.dispatch({ selection: EditorSelection.cursor(3) });

    if (view.state.doc.toString() !== 'hello') {
      dispatchFullReplacement(view, 'hello');
    }

    expect(view.state.selection.main.head).toBe(3); // guard fires → no dispatch → passes in both buggy and fixed
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

describe('Bug — updateEditorContent does not restore scrollDOM scroll position', () => {
  it('explicitly reassigns scrollTop and scrollLeft after dispatch to restore pre-dispatch values (property-based)', async () => {
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
          const spy = spyOnScroll(view.scrollDOM);

          // Set the pre-dispatch scroll position.
          view.scrollDOM.scrollTop = scrollTop;
          view.scrollDOM.scrollLeft = scrollLeft;

          // Reset spy call logs — we only care about calls made during/after dispatch.
          spy.topCalls.length = 0;
          spy.leftCalls.length = 0;

          // Ensure the dispatch actually fires (guard: newContent must differ from current doc).
          const content =
            newContent !== initialContent ? newContent : newContent + '\x00';
          dispatchFullReplacement(view, content);

          // A correct implementation saves scroll before dispatch and restores it after:
          //   const savedTop = scrollDOM.scrollTop;
          //   const savedLeft = scrollDOM.scrollLeft;
          //   view.dispatch(...);
          //   scrollDOM.scrollTop = savedTop;   ← this call is what we detect
          //   scrollDOM.scrollLeft = savedLeft; ← this call is what we detect
          //
          // Bug: neither setter is called after dispatch → spy.topCalls is empty → fails.
          expect(spy.topCalls).toContain(scrollTop);
          expect(spy.leftCalls).toContain(scrollLeft);

          spy.restore();
          view.destroy();
        }
      )
    );
  });
});
