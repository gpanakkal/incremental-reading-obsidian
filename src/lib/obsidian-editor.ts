// Helpers for using Obsidian's internal MarkdownEditor

import type ReviewView from '#/views/ReviewView';
import type { Extension, Facet } from '@codemirror/state';
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

type FacetProvider = {
  dependencies: readonly unknown[];
  facet: Facet<unknown>;
  type: 0 | 1 | 2;
  id: number;
  value: unknown;
};

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
  owner: MarkdownView | null;
  app: ExtractedApp;
  editor: Editor;
  cm: EditorView;
  set: (data: string) => void;
}

interface MarkdownEditorPrototype {
  constructor: () => ExtractedMarkdownEditor;
  /** Original extension building method (use to copy extensions) */
  buildLocalExtensions: () => FacetProvider[];
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

export const getMarkdownController = (
  view: ReviewView,
  getEditor: () => Editor,
  currentItem: ReviewItem
) => {
  return {
    ...view,
    showSearch: () => {},
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
      return currentItem?.file;
    },
    get path() {
      return currentItem?.file.path;
    },
  };
};
