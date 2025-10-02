import { insertBlankLine } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import { EditorSelection, Prec } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import {
  keymap,
  placeholder as placeholderExt,
  EditorView,
} from '@codemirror/view';
import classcat from 'classcat';
import type { EditorPosition, Editor as ObsidianEditor } from 'obsidian';
import { Platform } from 'obsidian';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type ReviewView from '../views/ReviewView';
import { prefixedClasses, isEditing } from './helpers';
import type { EditState } from './types';
import { useReviewContext } from './ReviewContext';
import { getBaseMarkdownExtensions } from '../lib/utils';
import type { ReviewItem } from '#/db/types';

// TODO: attribution and license update to GPL
interface IREditorProps {
  item: ReviewItem;
  editorRef?: MutableRefObject<EditorView | null>;
  editState?: EditState;
  onEnter: (cm: EditorView, mod: boolean, shift: boolean) => boolean;
  onEscape: (cm: EditorView) => void;
  onSubmit: (cm: EditorView) => void;
  onPaste?: (e: ClipboardEvent, cm: EditorView) => void;
  onChange?: (update: ViewUpdate) => void;
  value?: string;
  className: string;
  placeholder?: string;
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

function getEditorAppProxy(view: ReviewView) {
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

function setInsertMode(cm: EditorView) {
  const vim = getVimPlugin(cm);
  if (vim) {
    (window as any).CodeMirrorAdapter?.Vim?.enterInsertMode(vim);
  }
}

function getVimPlugin(cm: EditorView): string {
  return (cm as any)?.plugins?.find((p: any) => {
    if (!p?.value) return false;
    return 'useNextTextInput' in p.value && 'waitForCopy' in p.value;
  })?.value?.cm;
}

export function IREditor({
  item,
  editorRef,
  onEnter,
  onEscape,
  onChange,
  onPaste,
  className,
  onSubmit,
  editState,
  value,
  placeholder,
}: IREditorProps) {
  const { reviewView } = useReviewContext();
  const elRef = useRef<HTMLDivElement | null>(null);
  const internalRef = useRef<EditorView | null>(null);
  const getMarkdownController = useCallback(
    (
      view: ReviewView,
      getEditor: () => ObsidianEditor,
      currentItem: ReviewItem
    ) => {
      return {
        app: view.app,
        showSearch: () => {},
        toggleMode: () => {},
        onMarkdownScroll: () => {},
        getMode: () => 'source',
        scroll: 0,
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
    },
    []
  );

  useEffect(() => {
    class Editor extends reviewView.plugin.MarkdownEditor {
      isIncrementalReadingEditor = true;

      // // Override getSelection to provide proper context
      // getSelection() {
      //   return window.getSelection();
      // }

      onUpdate(update: ViewUpdate, changed: boolean) {
        super.onUpdate(update, changed);
        onChange && onChange(update);
      }
      buildLocalExtensions(): Extension[] {
        const extensions = super.buildLocalExtensions();
        try {
          const baseExtensions = getBaseMarkdownExtensions(reviewView.app);
          extensions.push(...baseExtensions);
        } catch (error) {
          console.warn('Could not load base markdown extensions:', error);
          console.error('Extension loading error details:', error);
        }

        // extensions.push(stateManagerField.init(() => stateManager));
        // extensions.push(datePlugins);
        extensions.push(
          Prec.highest(
            EditorView.domEventHandlers({
              focus: (evt) => {
                reviewView.activeEditor = this.owner;
                if (Platform.isMobile) {
                  reviewView.contentEl.addClass('is-mobile-editing');
                }

                evt.win.setTimeout(() => {
                  this.app.workspace.activeEditor = this.owner;
                  if (Platform.isMobile) {
                    this.app.mobileToolbar.update();
                  }
                });
                return true;
              },
              blur: () => {
                if (Platform.isMobile) {
                  reviewView.contentEl.removeClass('is-mobile-editing');
                  this.app.mobileToolbar.update();
                }
                return true;
              },
            })
          )
        );

        if (placeholder) extensions.push(placeholderExt(placeholder));
        if (onPaste) {
          extensions.push(
            Prec.high(
              EditorView.domEventHandlers({
                paste: onPaste,
              })
            )
          );
        }

        const makeEnterHandler =
          (mod: boolean, shift: boolean) => (cm: EditorView) => {
            const didRun = onEnter(cm, mod, shift);
            if (didRun) return true;
            if (this.app.vault.getConfig('smartIndentList')) {
              this.editor.newlineAndIndentContinueMarkdownList();
            } else {
              insertBlankLine(cm as any);
            }
            return true;
          };

        extensions.push(
          Prec.highest(
            keymap.of([
              {
                key: 'Enter',
                run: makeEnterHandler(false, false),
                shift: makeEnterHandler(false, true),
                preventDefault: true,
              },
              {
                key: 'Mod-Enter',
                run: makeEnterHandler(true, false),
                shift: makeEnterHandler(true, true),
                preventDefault: true,
              },
              {
                key: 'Escape',
                run: (cm) => {
                  onEscape(cm);
                  return false;
                },
                preventDefault: true,
              },
            ])
          )
        );

        return extensions;
      }
    }

    const controller = getMarkdownController(
      reviewView,
      () => editor.editor,
      item
    );
    const app = getEditorAppProxy(reviewView);

    let editor: any;
    let cm: EditorView;

    try {
      editor = new (Editor as any)(app, elRef.current, controller);
      cm = editor.cm;
    } catch (error) {
      console.error('Error creating editor:', error);
      console.error('Error stack:', error.stack);
      throw error;
    }

    internalRef.current = cm;
    if (editorRef) editorRef.current = cm;

    controller.editMode = editor;
    editor.set(value ?? '');
    if (isEditing(editState)) {
      cm.dispatch({
        userEvent: 'select.pointer',
        selection: EditorSelection.single(cm.posAtCoords(editState, false)),
      });

      cm.dom.win.setTimeout(() => {
        setInsertMode(cm);
      });
    }

    const onShow = () => {
      elRef.current?.scrollIntoView({ block: 'end' });
    };

    if (Platform.isMobile) {
      cm.dom.win.addEventListener('keyboardDidShow', onShow);
    }

    return () => {
      if (Platform.isMobile) {
        cm.dom.win.removeEventListener('keyboardDidShow', onShow);

        if (reviewView.activeEditor === controller) {
          reviewView.activeEditor = null;
        }

        if (app.workspace.activeEditor === controller) {
          app.workspace.activeEditor = null;
          (app as any).mobileToolbar.update();
          reviewView.contentEl.removeClass('is-mobile-editing');
        }
      }
      elRef.current?.removeChild(elRef.current?.children[0]);
      internalRef.current = null;
      if (editorRef) editorRef.current = null;
    };
  }, [value, item]);

  const cls = [
    'markdown-source-view',
    'is-live-preview',
    'markdown-rendered',
    'cm-s-obsidian',
    'mod-cm6',
    'node-insert-event',
    'is-readable-line-width',
    'is-folding',
    'allow-fold-headings',
    'allow-fold-lists',
    'show-indentation-guide',
    'show-properties',
    'cm-sizer',
  ];
  if (className) cls.push(className);

  const currentInternalRef = internalRef.current;
  return (
    <>
      <div className={classcat(cls)} ref={elRef}></div>
      {Platform.isMobile && currentInternalRef && (
        // TODO: mobile support
        <button
          onClick={() => onSubmit(currentInternalRef)}
          className={classcat([
            prefixedClasses('item-submit-button'),
            'mod-cta',
          ])}
        >
          Submit
        </button>
      )}
    </>
  );
}
