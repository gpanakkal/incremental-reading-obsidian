// @vitest-environment jsdom

import {
  getMarkdownController,
  type ExtractedMarkdownEditor,
} from '#/lib/obsidian-editor';
import type { ReviewItem } from '#/lib/types';
import type ReviewView from '#/views/ReviewView';
import fc from 'fast-check';
import type { Editor } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

/** Every key `getMarkdownController` defines on the object it returns. */
const CONTROLLER_KEYS = [
  'showSearch',
  'toggleMode',
  'onMarkdownScroll',
  'syncScroll',
  'getMode',
  'scroll',
  'editMode',
  'getSelection',
  'editor',
  'file',
  'path',
] as const;

function makeView(ownProps: Record<string, unknown> = {}): ReviewView {
  return { ...ownProps } as unknown as ReviewView;
}

function makeItem(path: string): ReviewItem {
  return { file: { path, basename: path } } as unknown as ReviewItem;
}

/** Stand-in for the `CustomEditor` instance IREditor assigns to `editMode`. */
function makeEditMode() {
  return { showSearch: vi.fn() } as unknown as ExtractedMarkdownEditor & {
    showSearch: ReturnType<typeof vi.fn>;
  };
}

function makeController(
  overrides: {
    view?: ReviewView;
    getEditor?: () => Editor;
    getCurrentItem?: () => ReviewItem;
  } = {}
) {
  return getMarkdownController(
    overrides.view ?? makeView(),
    overrides.getEditor ?? (() => ({}) as Editor),
    overrides.getCurrentItem ?? (() => makeItem('articles/a.md'))
  );
}

/** Arbitrary own properties for the view being spread, including keys that
 *  collide with the controller's own API. */
const viewPropsArb = fc.dictionary(
  fc.oneof(
    fc.string({ minLength: 1 }),
    fc.constantFrom(...CONTROLLER_KEYS)
  ),
  fc.anything()
);

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getMarkdownController', () => {
  describe('showSearch', () => {
    it('forwards the requested mode to the edit mode that owns the find bar', () => {
      fc.assert(
        fc.property(fc.boolean(), (replace) => {
          const controller = makeController();
          const editMode = makeEditMode();
          // IREditor assigns editMode only after construction, as here.
          controller.editMode = editMode;

          controller.showSearch(replace);

          expect(editMode.showSearch).toHaveBeenCalledTimes(1);
          expect(editMode.showSearch).toHaveBeenCalledWith(replace);
        })
      );
    });

    it('opens plain find, not find-and-replace, when called with no argument', () => {
      // Obsidian's `editor:open-search` calls `showSearch(false)`, but a caller
      // omitting the argument must not land in replace mode.
      const controller = makeController();
      const editMode = makeEditMode();
      controller.editMode = editMode;

      controller.showSearch();

      expect(editMode.showSearch).toHaveBeenCalledWith(false);
    });

    it('does nothing when no edit mode is attached yet', () => {
      fc.assert(
        fc.property(fc.boolean(), (replace) => {
          const controller = makeController();

          expect(controller.editMode).toBeNull();
          expect(() => controller.showSearch(replace)).not.toThrow();
        })
      );
    });

    it('follows the edit mode currently attached rather than the first one', () => {
      fc.assert(
        fc.property(fc.boolean(), fc.boolean(), (first, second) => {
          const controller = makeController();
          const stale = makeEditMode();
          const live = makeEditMode();

          controller.editMode = stale;
          controller.showSearch(first);
          controller.editMode = live;
          controller.showSearch(second);

          expect(stale.showSearch).toHaveBeenCalledTimes(1);
          expect(stale.showSearch).toHaveBeenCalledWith(first);
          expect(live.showSearch).toHaveBeenCalledTimes(1);
          expect(live.showSearch).toHaveBeenCalledWith(second);
        })
      );
    });
  });

  describe('getMode', () => {
    it("reports source mode, which is what gates Obsidian's find-and-replace command", () => {
      // `editor:open-search-replace` runs only when getMode() === 'source'.
      expect(makeController().getMode()).toBe('source');
    });
  });

  describe('file and path', () => {
    it('report the item currently under review, not the one present at construction', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (firstPath, renamedPath) => {
            let item = makeItem(firstPath);
            const controller = makeController({
              getCurrentItem: () => item,
            });

            expect(controller.file).toBe(item.file);
            expect(controller.path).toBe(firstPath);

            // The item is refetched on an interval and can come back renamed.
            item = makeItem(renamedPath);

            expect(controller.file).toBe(item.file);
            expect(controller.path).toBe(renamedPath);
          }
        )
      );
    });

    it('report nothing when no item is under review', () => {
      const controller = makeController({
        getCurrentItem: () => null as unknown as ReviewItem,
      });

      expect(controller.file).toBeUndefined();
      expect(controller.path).toBeUndefined();
    });
  });

  describe('editor', () => {
    it('resolves the editor on each access so a rebuilt editor is picked up', () => {
      fc.assert(
        fc.property(fc.integer(), fc.integer(), (a, b) => {
          let current = { id: a } as unknown as Editor;
          const controller = makeController({ getEditor: () => current });

          expect(controller.editor).toBe(current);

          current = { id: b } as unknown as Editor;

          expect(controller.editor).toBe(current);
        })
      );
    });
  });

  describe('getSelection', () => {
    it('returns the live window selection', () => {
      const selection = {} as Selection;
      const spy = vi
        .spyOn(window, 'getSelection')
        .mockReturnValue(selection);

      expect(makeController().getSelection()).toBe(selection);
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('the object handed to Obsidian as the active editor', () => {
    it('carries the view’s own properties through', () => {
      fc.assert(
        fc.property(viewPropsArb, (props) => {
          const controller = makeController({ view: makeView(props) });

          for (const [key, value] of Object.entries(props)) {
            if ((CONTROLLER_KEYS as readonly string[]).includes(key)) continue;
            expect(controller[key as keyof typeof controller]).toBe(value);
          }
        })
      );
    });

    it('keeps its own API intact even when the view declares the same keys', () => {
      fc.assert(
        fc.property(viewPropsArb, fc.boolean(), (props, replace) => {
          const controller = makeController({ view: makeView(props) });
          const editMode = makeEditMode();
          controller.editMode = editMode;

          controller.showSearch(replace);

          expect(editMode.showSearch).toHaveBeenCalledWith(replace);
          expect(controller.getMode()).toBe('source');
          expect(controller.scroll).toBe(1);
        })
      );
    });

    it('exposes the no-op hooks Obsidian calls on a markdown view', () => {
      // These exist so Obsidian does not throw; they must stay callable no-ops.
      const controller = makeController();

      expect(controller.toggleMode()).toBeUndefined();
      expect(controller.onMarkdownScroll()).toBeUndefined();
      expect(controller.syncScroll()).toBeUndefined();
      expect(controller.scroll).toBe(1);
      expect(controller.editMode).toBeNull();
    });
  });
});
