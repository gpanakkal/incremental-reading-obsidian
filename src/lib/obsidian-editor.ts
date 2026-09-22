// Helpers for using Obsidian's internal MarkdownEditor

import type ReviewView from '#/views/ReviewView';
import type { Extension } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { App, Editor, MarkdownView } from 'obsidian';
import type { EmbedMarkdownComponent, MobileToolbar } from 'obsidian-typings';
import type { ReviewItem } from './types';

export interface ExtractedEditMode {
  /**
   * Obsidian's frontmatter extension: hides the raw YAML block, and in a real
   * note pane stands the properties widget in its place. Built lazily inside
   * {@link ExtractedEditMode.getDynamicExtensions}, and only on its
   * `!sourceMode` branch, so an editor that has never been in live preview
   * does not have one. See {@link ensurePropertiesExtension}.
   */
  propertiesExtension?: Extension[];
  /** @see ExtractedMarkdownEditor.sourceMode */
  sourceMode?: boolean;
  /**
   * The half of the extension set Obsidian rebuilds whenever the editing mode
   * or a vault setting changes. Calling it is what builds
   * {@link ExtractedEditMode.propertiesExtension}.
   */
  getDynamicExtensions?: () => Extension[];
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
   * Whether live preview rendering is off — raw markdown instead of rendered
   * inline. Seeded in the base constructor from the `livePreview` vault config,
   * so an editor built while the global setting is on starts `false`.
   *
   * Assignable before the first {@link set}, which is what builds the CodeMirror
   * state: `getDynamicExtensions` reads it there to decide whether to include
   * the live preview plugin and the `is-live-preview` class. Afterwards it has
   * to be changed through {@link toggleSource}, which reconfigures both.
   */
  sourceMode: boolean;
  /**
   * Obsidian's own source-mode switch. Flips {@link sourceMode}, reconfigures the
   * dynamic extensions around the new value, and redraws. This is what
   * `MarkdownView.setState` calls when a tab's `source` state changes.
   */
  toggleSource(): void {}
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
 * Builds `editMode`'s properties extension whatever editing mode it is in.
 *
 * Obsidian builds that extension lazily inside `getDynamicExtensions`, and only
 * where `sourceMode` is false — a note pane is meant to show raw YAML in source
 * mode. Every editor seeds `sourceMode` from the `livePreview` vault config, so
 * with "Default editing mode" set to Source the throwaway editor below never
 * reaches that branch and has no extension to hand over, and review renders the
 * note's frontmatter. Review has no use for the YAML in either mode, so the
 * flag is flipped for the length of one call and the extension gets built
 * either way.
 *
 * Only the caching side effect is wanted; the returned extensions belong to the
 * throwaway editor and are discarded. The extension itself still honours the
 * `propertiesInDocument` setting, so a user who has asked to see raw properties
 * keeps seeing them.
 */
export function ensurePropertiesExtension(editMode: ExtractedEditMode): void {
  if (editMode.propertiesExtension || !editMode.getDynamicExtensions) return;

  const { sourceMode } = editMode;
  editMode.sourceMode = false;
  try {
    editMode.getDynamicExtensions();
  } finally {
    editMode.sourceMode = sourceMode;
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
      ensurePropertiesExtension(editMode);
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
