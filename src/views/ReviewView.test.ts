// @vitest-environment jsdom

import type { ExtractedMarkdownEditor } from '#/lib/obsidian-editor';
import ReviewView, { refocusWithoutScroll } from '#/views/ReviewView';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

/**
 * `showSearch` reads only `activeEditor`, so it can be exercised against a bare
 * receiver. Constructing a real ReviewView is not possible under the obsidian
 * mock, whose `FileView` is an empty class with no `register`.
 */
function callShowSearch(
  activeEditor: unknown,
  ...args: [replace?: boolean]
): void {
  ReviewView.prototype.showSearch.call(
    { activeEditor } as unknown as ReviewView,
    ...args
  );
}

function makeActiveEditor() {
  return { showSearch: vi.fn() };
}

/** Bare receiver for `setActiveEditor`, which touches only these two slots. */
function makeSetActiveEditorReceiver() {
  const receiver = {
    activeEditor: null as unknown,
    app: { workspace: { activeEditor: 'someone else' as unknown } },
  };
  return receiver;
}

function callSetActiveEditor(
  receiver: ReturnType<typeof makeSetActiveEditorReceiver>,
  owner: unknown
): void {
  ReviewView.prototype.setActiveEditor.call(
    receiver as unknown as ReviewView,
    owner as ExtractedMarkdownEditor['owner']
  );
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewView.showSearch', () => {
  it("forwards the requested mode to the review view's active editor", () => {
    fc.assert(
      fc.property(fc.boolean(), (replace) => {
        const activeEditor = makeActiveEditor();

        callShowSearch(activeEditor, replace);

        expect(activeEditor.showSearch).toHaveBeenCalledTimes(1);
        expect(activeEditor.showSearch).toHaveBeenCalledWith(replace);
      })
    );
  });

  it('opens plain find, not find-and-replace, when called with no argument', () => {
    // Obsidian's activeLeaf.view fallback calls showSearch(false); a caller
    // omitting the argument must not land in replace mode either.
    const activeEditor = makeActiveEditor();

    callShowSearch(activeEditor);

    expect(activeEditor.showSearch).toHaveBeenCalledWith(false);
  });

  it('does nothing when no editor is mounted', () => {
    // True on the home screen, the queue table, and un-revealed cards, and after
    // IREditor unmounts and clears the reference.
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom(null, undefined),
        (replace, absent) => {
          expect(() => callShowSearch(absent, replace)).not.toThrow();
        }
      )
    );
  });

  it('is defined on the prototype so spreading the view does not copy it', () => {
    // getMarkdownController builds its controller with `{...view}`, which copies
    // own enumerable properties. A class-field arrow here would be copied and
    // would shadow the controller's own forwarder, re-creating the no-op bug.
    expect(
      Object.getOwnPropertyDescriptor(ReviewView.prototype, 'showSearch')?.value
    ).toBeTypeOf('function');

    const activeEditor = makeActiveEditor();
    const view = { activeEditor } as unknown as ReviewView;
    expect(Object.prototype.hasOwnProperty.call(view, 'showSearch')).toBe(false);
    expect({ ...view }).not.toHaveProperty('showSearch');
  });

  it('satisfies the duck-type check Obsidian uses to enable the search command', () => {
    // editor:open-search does: `var t = e.showSearch; return t && typeof t == "function"`
    // against activeLeaf.view, so an actual instance must answer through its
    // prototype chain. Object.create stands in for a constructed view, which the
    // obsidian mock cannot produce.
    const view = Object.create(ReviewView.prototype) as ReviewView;
    // Reading the method off the instance unbound is precisely what Obsidian does,
    // so the lint rule's concern is the behaviour under test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const candidate = (view as unknown as ExtractedMarkdownEditor).showSearch;

    expect(candidate && typeof candidate === 'function').toBe(true);
  });
});

describe('ReviewView.setActiveEditor', () => {
  it('publishes the editor to the workspace so search resolves before any click', () => {
    // The bug this fixes: publishing only from CodeMirror's focus handler left
    // workspace.activeEditor null at the start of a review, so editor:open-search
    // found nothing and dropped out of the command palette entirely.
    const owner = makeActiveEditor();
    const receiver = makeSetActiveEditorReceiver();

    callSetActiveEditor(receiver, owner);

    expect(receiver.activeEditor).toBe(owner);
    expect(receiver.app.workspace.activeEditor).toBe(owner);
  });

  it('keeps the view and the workspace pointing at the same editor', () => {
    fc.assert(
      fc.property(fc.integer(), (id) => {
        const owner = { showSearch: vi.fn(), id };
        const receiver = makeSetActiveEditorReceiver();

        callSetActiveEditor(receiver, owner);

        expect(receiver.activeEditor).toBe(receiver.app.workspace.activeEditor);
      })
    );
  });

  it('releases the workspace slot when handed no editor', () => {
    // Reactivating the tab with no editor mounted must not leave a previous
    // owner installed as the workspace's active editor.
    const receiver = makeSetActiveEditorReceiver();

    callSetActiveEditor(receiver, null);

    expect(receiver.activeEditor).toBeNull();
    expect(receiver.app.workspace.activeEditor).toBeNull();
  });

  it('feeds showSearch, so a freshly published editor is searchable', () => {
    fc.assert(
      fc.property(fc.boolean(), (replace) => {
        const owner = makeActiveEditor();
        const receiver = makeSetActiveEditorReceiver();

        callSetActiveEditor(receiver, owner);
        ReviewView.prototype.showSearch.call(
          receiver as unknown as ReviewView,
          replace
        );

        expect(owner.showSearch).toHaveBeenCalledWith(replace);
      })
    );
  });
});

describe('refocusWithoutScroll', () => {
  it('refocuses the element without scrolling it into view', () => {
    // The whole point of the fix: focus() defaults to scrolling the element into
    // view, which pulls the editor to the top on every tab reactivation.
    const el = document.createElement('button');
    document.body.appendChild(el);
    const focusSpy = vi.spyOn(el, 'focus');

    refocusWithoutScroll(el);

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    el.remove();
  });

  it('does nothing when there is no last-focused element (null)', () => {
    expect(() => refocusWithoutScroll(null)).not.toThrow();
  });

  it('does nothing for a non-HTMLElement (e.g. an SVG element)', () => {
    // #lastFocusedEl is typed Element; only HTMLElement has focus() with options.
    const svg = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg'
    );
    // jsdom SVGElement lacks a focus method; the guard must skip it, not throw.
    expect(() => refocusWithoutScroll(svg)).not.toThrow();
  });
});
