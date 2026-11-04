// @vitest-environment jsdom

import {
  ensurePropertiesExtension,
  getBaseMarkdownExtensions,
  getMarkdownController,
  retireEditor,
  type ExtractedEditMode,
  type ExtractedMarkdownEditor,
} from '#/lib/obsidian-editor';
import type { ReviewItem } from '#/lib/types';
import type ReviewView from '#/views/ReviewView';
import {
  history,
  historyField,
  isolateHistory,
  undo,
  undoDepth,
} from '@codemirror/commands';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import type { App, Editor } from 'obsidian';
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
  fc.oneof(fc.string({ minLength: 1 }), fc.constantFrom(...CONTROLLER_KEYS)),
  fc.anything()
);

/**
 * Obsidian's edit mode, as far as `ensurePropertiesExtension` can see it:
 * `getDynamicExtensions` builds the properties extension lazily, and only on
 * the `!sourceMode` branch — the same condition the real implementation uses,
 * and the reason an editor opened straight into source mode never gets one.
 */
function makeLazyEditMode(sourceMode: boolean) {
  const editMode = {
    sourceMode,
    getDynamicExtensions: vi.fn(() => {
      if (!editMode.sourceMode) {
        editMode.propertiesExtension ??= [{}] as Extension[];
      }
      return [] as Extension[];
    }),
  } as ExtractedEditMode & {
    getDynamicExtensions: ReturnType<typeof vi.fn>;
  };
  return editMode;
}

/** An app whose only embedded markdown component carries `editMode`. */
function makeEmbedApp(editMode: ExtractedEditMode | undefined) {
  const md = {
    load: vi.fn(),
    unload: vi.fn(),
    showEditor: vi.fn(),
    editable: false,
    editMode,
  };
  const app = {
    embedRegistry: { embedByExtension: { md: vi.fn(() => md) } },
  } as unknown as App;
  return { app, md };
}

/**
 * Obsidian's editor as `retireEditor` meets it, over a real CodeMirror view.
 * `saveHistory` files the live undo history away as Obsidian's does: as JSON,
 * with the length of the text it belongs to. `destroy` swaps in an empty state
 * before tearing the view down, as Obsidian's does, which is what loses the
 * history for good.
 */
function makeRetiringEditor(doc: string) {
  const cm = new EditorView({
    state: EditorState.create({ doc, extensions: [history()] }),
  });
  const filed: { json: unknown; length: number }[] = [];
  const editor = {
    cm,
    saveHistory: vi.fn(() => {
      const { history: json } = cm.state.toJSON({ history: historyField }) as {
        history: unknown;
      };
      filed.push({ json, length: cm.state.doc.length });
    }),
    destroy: vi.fn(() => {
      cm.setState(EditorState.create({}));
      cm.destroy();
    }),
  };
  return { editor, filed };
}

/** A fresh editor state on `doc` that takes back history filed for it. */
function restoreFiled(doc: string, json: unknown): EditorState {
  return EditorState.fromJSON(
    {
      doc,
      selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
      history: json,
    },
    { extensions: [history()] },
    { history: historyField }
  );
}

/** Undo in `state` until there is nothing left to undo. */
function undoAll(state: EditorState): EditorState {
  let current = state;
  const run = () =>
    undo({
      state: current,
      dispatch: (tr) => {
        current = tr.state;
      },
    });
  while (run()) {
    // Each pass takes back one group.
  }
  return current;
}

/** One insertion: where, as a fraction of the text, and what. */
type Keystrokes = { at: number; text: string; newGroup: boolean };

/**
 * Typing as a reader does it: insertions anywhere in the text, each either
 * joining the group before it or starting one of its own.
 */
const typingArb: fc.Arbitrary<Keystrokes[]> = fc.array(
  fc.record({
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    text: fc.string({ minLength: 1, maxLength: 8 }),
    newGroup: fc.boolean(),
  }),
  { maxLength: 12 }
);

function type(cm: EditorView, typing: Keystrokes[]): void {
  for (const { at, text, newGroup } of typing) {
    const pos = Math.floor(at * cm.state.doc.length);
    cm.dispatch({
      changes: { from: pos, insert: text },
      userEvent: 'input.type',
      annotations: newGroup ? isolateHistory.of('before') : [],
    });
  }
}

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
      const spy = vi.spyOn(window, 'getSelection').mockReturnValue(selection);

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

describe('ensurePropertiesExtension', () => {
  it('builds the frontmatter-hiding extension on an editor that starts in source mode', () => {
    // The reported bug: with "Default editing mode" set to Source every editor
    // starts `sourceMode` true, so Obsidian never builds the extension and
    // review renders the note's raw YAML.
    const editMode = makeLazyEditMode(true);

    ensurePropertiesExtension(editMode);

    expect(editMode.propertiesExtension).toBeDefined();
  });

  it('leaves the editing mode as it found it', () => {
    fc.assert(
      fc.property(fc.boolean(), (sourceMode) => {
        const editMode = makeLazyEditMode(sourceMode);

        ensurePropertiesExtension(editMode);

        expect(editMode.sourceMode).toBe(sourceMode);
      })
    );
  });

  it('restores the editing mode when building throws', () => {
    const editMode: ExtractedEditMode = {
      sourceMode: true,
      getDynamicExtensions: () => {
        throw new Error('boom');
      },
    };

    expect(() => ensurePropertiesExtension(editMode)).toThrow('boom');
    expect(editMode.sourceMode).toBe(true);
  });

  it('keeps the extension an editor has already built rather than rebuilding it', () => {
    const editMode = makeLazyEditMode(false);
    const existing = [{}] as Extension[];
    editMode.propertiesExtension = existing;

    ensurePropertiesExtension(editMode);

    expect(editMode.propertiesExtension).toBe(existing);
    expect(editMode.getDynamicExtensions).not.toHaveBeenCalled();
  });

  it('does nothing on an edit mode that exposes no extension builder', () => {
    const editMode: ExtractedEditMode = { sourceMode: true };

    expect(() => ensurePropertiesExtension(editMode)).not.toThrow();
    expect(editMode.propertiesExtension).toBeUndefined();
  });
});

describe('getBaseMarkdownExtensions', () => {
  it('hands back the frontmatter-hiding extension whatever mode the vault defaults to', () => {
    fc.assert(
      fc.property(fc.boolean(), (sourceMode) => {
        // Editors seed `sourceMode` from the `livePreview` vault config, so this
        // stands in for both settings of "Default editing mode".
        const editMode = makeLazyEditMode(sourceMode);
        const { app } = makeEmbedApp(editMode);

        const extensions = getBaseMarkdownExtensions(app);

        expect(extensions).toEqual([editMode.propertiesExtension]);
      })
    );
  });

  it('unloads the throwaway editor it built the extension with', () => {
    const { app, md } = makeEmbedApp(makeLazyEditMode(true));

    getBaseMarkdownExtensions(app);

    expect(md.unload).toHaveBeenCalledTimes(1);
  });

  it('returns nothing, rather than throwing, when no edit mode is exposed', () => {
    const { app } = makeEmbedApp(undefined);

    expect(getBaseMarkdownExtensions(app)).toEqual([]);
  });
});

describe('retireEditor', () => {
  it('files the history the editor has on teardown, so a new editor on the same text undoes it all', () => {
    fc.assert(
      fc.property(fc.string(), typingArb, (original, typing) => {
        const { editor, filed } = makeRetiringEditor(original);
        type(editor.cm, typing);
        const depth = undoDepth(editor.cm.state);
        const typed = editor.cm.state.doc.toString();

        retireEditor(editor);

        expect(filed).toHaveLength(1);
        expect(filed[0].length).toBe(typed.length);
        const restored = restoreFiled(typed, filed[0].json);
        expect(undoDepth(restored)).toBe(depth);
        expect(undoAll(restored).doc.toString()).toBe(original);
      })
    );
  });

  it('tears the editor down once, after filing its history', () => {
    const { editor } = makeRetiringEditor('text');

    retireEditor(editor);

    expect(editor.saveHistory).toHaveBeenCalledTimes(1);
    expect(editor.destroy).toHaveBeenCalledTimes(1);
    expect(editor.saveHistory.mock.invocationCallOrder[0]).toBeLessThan(
      editor.destroy.mock.invocationCallOrder[0]
    );
  });

  it('still tears the editor down when Obsidian has no history to file it with', () => {
    const destroy = vi.fn();

    retireEditor({ destroy });

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('goes on to each step when the one before it throws, and throws nothing itself', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (saveThrows, destroyThrows) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const failure = (fails: boolean) =>
          vi.fn(() => {
            if (fails) throw new Error('teardown failed');
          });
        const editor = {
          saveHistory: failure(saveThrows),
          destroy: failure(destroyThrows),
        };

        expect(() => retireEditor(editor)).not.toThrow();

        expect(editor.destroy).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(
          Number(saveThrows) + Number(destroyThrows)
        );
        warn.mockRestore();
      })
    );
  });
});
