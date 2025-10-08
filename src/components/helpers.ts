import type { Editor as ObsidianEditor } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { CSS_CLASS_PREFIX } from '#/lib/constants';
import type ReviewView from '#/views/ReviewView';
import type { EditCoordinates, EditState } from './types';
import type { ReviewItem } from '#/lib/types';

/** Adds the plugin prefix to each of a space-separated list of classes */
export const prefixedClasses = (classes: string) =>
  classes
    .split(' ')
    .map((cls) => `${CSS_CLASS_PREFIX}-${cls.trim()}`)
    .join(' ');

export function isEditing(state?: EditState): state is EditCoordinates {
  if (!state) return false;
  if (typeof state === 'number') return false;
  return true;
}

// export function allowNewLine(
//   stateManager: StateManager,
//   mod: boolean,
//   shift: boolean
// ) {
//   if (Platform.isMobile) return !(mod || shift);
//   return stateManager.getSetting('new-line-trigger') === 'enter'
//     ? !(mod || shift)
//     : mod || shift;
// }

export function getEditorAppProxy(view: ReviewView) {
  return new Proxy(view.app, {
    get(target, prop, reveiver) {
      if (prop === 'vault') {
        return new Proxy(view.app.vault, {
          get(target, prop, reveiver) {
            if (prop === 'config') {
              return new Proxy((view.app.vault as any).config, {
                get(target, prop, reveiver) {
                  if (
                    ['showLineNumber', 'foldHeading', 'foldIndent'].includes(
                      prop as string
                    )
                  ) {
                    return false;
                  }
                  return Reflect.get(target, prop, reveiver);
                },
              });
            }
            return Reflect.get(target, prop, reveiver);
          },
        });
      }
      return Reflect.get(target, prop, reveiver);
    },
  });
}

export function setInsertMode(cm: EditorView) {
  const vim = getVimPlugin(cm);
  if (vim) {
    (window as any).CodeMirrorAdapter?.Vim?.enterInsertMode(vim);
  }
}

export function getVimPlugin(cm: EditorView): string {
  return (cm as any)?.plugins?.find((p: any) => {
    if (!p?.value) return false;
    return 'useNextTextInput' in p.value && 'waitForCopy' in p.value;
  })?.value?.cm;
}

export const getMarkdownController = (
  view: ReviewView,
  getEditor: () => ObsidianEditor,
  currentItem: ReviewItem
) => {
  return {
    app: view.app,
    showSearch: () => {},
    toggleMode: () => {},
    onMarkdownScroll: () => {},
    syncScroll: () => {}, // Prevent "syncScroll is not a function" error
    getMode: () => 'source',
    scroll: 1,
    editMode: null,
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
