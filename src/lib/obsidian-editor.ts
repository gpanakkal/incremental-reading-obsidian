// Helpers for using Obsidian's internal MarkdownEditor

import type ReviewView from '#/views/ReviewView';
import type { Extension } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { App, Editor, MarkdownView } from 'obsidian';
import type { EmbedMarkdownComponent, MobileToolbar } from 'obsidian-typings';
import type { ReviewItem } from './types';

interface ExtractedEditMode {
  propertiesExtension?: Extension[];
}

interface ExtractedEmbedMarkdownComponent extends EmbedMarkdownComponent {
  editable: boolean;
  showEditor: () => void;
  editMode?: ExtractedEditMode;
}

export interface ExtractedMobileToolbar extends MobileToolbar {
  update: () => void;
}

interface ExtractedApp extends App {
  mobileToolbar: ExtractedMobileToolbar;
}

export class ExtractedMarkdownEditor {
  constructor(...args: unknown[]) {
    void args;
  }
  onUpdate(_update: ViewUpdate, _changed: boolean): void {}
  buildLocalExtensions(): Extension[] {
    return [];
  }
  /** Opens Obsidian's native find bar. `search` is built in the base constructor. */
  showSearch(_replace?: boolean): void {}
  /**
   * Obsidian's own teardown. Destroys the CodeMirror view, closes the editor
   * suggest, and pops the keymap scope the find bar pushes while open.
   */
  destroy(): void {}
  owner: MarkdownView | null;
  app: ExtractedApp;
  editor: Editor;
  cm: EditorView;
  set: (data: string) => void;
}

function getExtractedEmbedMd(app: App): ExtractedEmbedMarkdownComponent {
  // Create a temporary editor instance
  const md = app.embedRegistry.embedByExtension.md(
    {
      app,
      containerEl: createDiv(),
      state: {},
    },
    null!,
    ''
  ) as ExtractedEmbedMarkdownComponent;

  return md;
}

export function getEditorClass(app: App): typeof ExtractedMarkdownEditor {
  const md = getExtractedEmbedMd(app);
  try {
    // Create a temporary editor instance
    md.load();
    md.editable = true;
    md.showEditor();

    const MarkdownEditor = (
      Object.getPrototypeOf(
        Object.getPrototypeOf(md.editMode) as object
      ) as object
    ).constructor as typeof ExtractedMarkdownEditor;
    return MarkdownEditor;
  } finally {
    md.unload();
  }
}
/**
 * Get base extensions that would be used in a standard MarkdownEditor
 */

export function getBaseMarkdownExtensions(app: App) {
  const md = getExtractedEmbedMd(app);

  try {
    md.load();
    md.editable = true;
    md.showEditor();

    // Try to get extensions from the edit mode
    const editMode = md.editMode;
    let extensions: Extension[] = [];

    if (editMode) {
      if (editMode.propertiesExtension) {
        try {
          extensions.push(editMode.propertiesExtension);
        } catch (error) {
          console.error('Error examining propertiesExtension:', error);
        }
      }
    }

    return extensions;
  } catch (error) {
    console.warn('Could not extract base markdown extensions:', error);
    return [];
  } finally {
    md.unload();
  }
}

export function setInsertMode(cm: EditorView) {
  const vim = getVimPlugin(cm);
  if (vim) {
    window.CodeMirrorAdapter?.Vim?.enterInsertMode(vim);
  }
}

export function getVimPlugin(cm: EditorView): unknown {
  return (
    (
      cm as unknown as { plugins: Array<{ value?: { cm: unknown } }> }
    ).plugins.find((p) => {
      if (!p?.value) return false;
      return 'useNextTextInput' in p.value && 'waitForCopy' in p.value;
    })?.value?.cm ?? null
  );
}

/**
 * `getCurrentItem` is read on every access rather than captured: the item is
 * refetched on an interval and can come back with a renamed file, and Obsidian
 * resolves links and embeds against whatever `file`/`path` report at the time.
 */
export const getMarkdownController = (
  view: ReviewView,
  getEditor: () => Editor,
  getCurrentItem: () => ReviewItem
) => {
  const controller = {
    ...view,
    /**
     * Obsidian's `editor:open-search` command only checks that `showSearch` is a
     * function, then calls it — so a stub here makes Ctrl+F a silent no-op.
     * Mirrors `MarkdownView.showSearch`: the find bar lives on the edit mode, so
     * this forwards to it. Safe before `editMode` is assigned; it runs on user
     * action, long after construction.
     */
    showSearch: (replace = false) => controller.editMode?.showSearch(replace),
    toggleMode: () => {},
    onMarkdownScroll: () => {},
    syncScroll: () => {}, // Prevent "syncScroll is not a function" error
    getMode: () => 'source',
    scroll: 1,
    editMode: null as ExtractedMarkdownEditor | null,
    // Add getSelection method to provide context for properties extension
    getSelection: () => {
      // TODO: replace placeholder implementation
      return window.getSelection();
    },
    get editor() {
      return getEditor();
    },
    get file() {
      return getCurrentItem()?.file;
    },
    get path() {
      return getCurrentItem()?.file.path;
    },
  };
  return controller;
};
