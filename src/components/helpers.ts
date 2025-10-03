import { CSS_CLASS_PREFIX } from '#/lib/constants';
import type ReviewView from '#/views/ReviewView';
import type { EditorView } from '@codemirror/view';
import type { EditCoordinates, EditState } from './types';

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
