/* eslint-disable @typescript-eslint/no-explicit-any */
import { insertBlankLine } from '@codemirror/commands';
import { EditorSelection, Prec } from '@codemirror/state';
import {
  keymap,
  placeholder as placeholderExt,
  EditorView,
  scrollPastEnd,
} from '@codemirror/view';
import classcat from 'classcat';
import { Platform } from 'obsidian';
import { useEffect, useRef, type MutableRefObject } from 'react';
import { useDispatch } from 'react-redux';
import { useAppSelector, useAppStore } from '#/hooks/useAppSelector';
import {
  setReviewModeEffect,
  setShowAnswerEffect,
  setReviewCallbacks,
  isExternalSync,
  isReviewInterfaceFacet,
  type ReviewCallbacks,
} from '#/lib/extensions';
import { isEditing, setShowAnswer } from '#/lib/store';
import type {
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
} from '#/lib/types';
import { isReviewArticle } from '#/lib/types';
import { getBaseMarkdownExtensions } from '../lib/utils';
import { setInsertMode, getMarkdownController } from './helpers';
import { useReviewContext } from './ReviewContext';
import { TitleEditor } from './TitleEditor';
import type { EditCoordinates } from './types';
import type { Extension } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import type { Grade } from 'ts-fsrs';

/**
 * Credit goes to mgmeyers for figuring out how to get the editor prototype.
 * See the original code here:
 * https://github.com/mgmeyers/obsidian-kanban/blob/main/src/components/Editor/MarkdownEditor.tsx
 *
 * Changes made to the original implementation:
 * - all CodeMirror extensions loaded by Obsidian are now added
 * - enabled editor commands
 * - fixed a bug causing the editor to not be cleaned up on component unmount
 * - added classes to make styling more consistent with Obsidian's note interface
 */
interface IREditorProps {
  item: ReviewItem;
  editorRef?: MutableRefObject<EditorView | null>;
  onEnter: (cm: EditorView, mod: boolean, shift: boolean) => boolean;
  onEscape: (cm: EditorView) => void;
  onPaste?: (e: ClipboardEvent, cm: EditorView) => void;
  value?: string;
  className: string;
  placeholder?: string;
}

export function IREditor({
  item,
  editorRef,
  onEnter,
  onEscape,
  onPaste,
  className,
  value,
  placeholder,
}: IREditorProps) {
  const dispatch = useDispatch();

  const {
    reviewView,
    reviewManager,
    reviewArticle,
    reviewSnippet,
    gradeCard,
    dismissItem,
    skipItem,
  } = useReviewContext();
  const elRef = useRef<HTMLDivElement | null>(null);
  const internalRef = useRef<EditorView | null>(null);
  const { saveNote } = useReviewContext();
  const store = useAppStore();
  const showAnswer = useAppSelector((state) => state.showAnswer);

  const handleChange = async (update: ViewUpdate) => {
    if (!update.docChanged) return;

    const docText = update.state.doc.toString();
    await saveNote(item, docText);
  };

  // extend the MarkdownEditor extracted from Obsidian
  useEffect(() => {
    const setupEditor = () => {
      class Editor extends reviewView.plugin.MarkdownEditor {
        isIncrementalReadingEditor = true;

        // // Override getSelection to provide proper context
        // getSelection() {
        //   return window.getSelection();
        // }

        onUpdate(update: ViewUpdate, changed: boolean) {
          super.onUpdate(update, changed);
          handleChange(update);
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

          extensions.push(isReviewInterfaceFacet.of(true));

          // extensions.push(stateManagerField.init(() => stateManager));
          // extensions.push(datePlugins);
          extensions.push(
            Prec.highest(scrollPastEnd()),
            Prec.highest(
              EditorView.theme({
                '.cm-scroller': {
                  overflow: 'auto',
                },
              })
            ),
            Prec.highest(
              EditorView.domEventHandlers({
                focus: (evt) => {
                  reviewView.activeEditor = this.owner;
                  if (Platform.isMobile) {
                    reviewView.contentEl.addClass('is-mobile-editing');
                  }

                  evt.win.setTimeout(() => {
                    this.app.workspace.activeEditor = this.owner;
                    if (Platform.isMobile && this.app.mobileToolbar) {
                      this.app.mobileToolbar.update();
                    }
                  });
                  return true;
                },
                blur: () => {
                  if (Platform.isMobile) {
                    reviewView.contentEl.removeClass('is-mobile-editing');
                    this.app.mobileToolbar?.update();
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

      const app = reviewView.plugin.app;
      let editor: any;
      let cm: EditorView;
      const controller = getMarkdownController(
        reviewView,
        () => editor.editor,
        item
      );
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

      // Store editor view reference in ReviewManager for highlight refresh
      if (item.file) {
        reviewManager.currentEditorView = {
          view: cm,
          file: item.file,
        };
      }

      controller.editMode = editor;
      editor.set(value ?? '');

      // Enable review mode in the action bar extension
      // This tells the extension we're in the review interface context
      const reviewCallbacks: ReviewCallbacks = {
        reviewArticle: async (item: ReviewArticle) => reviewArticle(item),
        reviewSnippet: async (item: ReviewSnippet) => reviewSnippet(item),
        gradeCard: async (item: ReviewCard, grade: Grade) =>
          gradeCard(item, grade),
        dismissItem: async (reviewItem: ReviewItem) => dismissItem(reviewItem),
        skipItem: (reviewItem: ReviewItem) => skipItem(reviewItem),
        setShowAnswer: (show) => dispatch(setShowAnswer(show)),
        getCurrentItem: () => store.getState().currentItem,
      };

      cm.dispatch({
        effects: [
          setReviewModeEffect.of(true),
          setReviewCallbacks.of(reviewCallbacks),
        ],
      });

      const { editState } = store.getState();
      if (isEditing({ editState })) {
        cm.dispatch({
          userEvent: 'select.pointer',
          selection: EditorSelection.single(
            cm.posAtCoords(editState as EditCoordinates, false)
          ),
        });

        cm.dom.win.setTimeout(() => {
          setInsertMode(cm);
        });
      }

      const onShow = () => {
        // elRef.current?.scrollIntoView({ block: 'end' });
      };

      // Add iOS keyboard event listener with defensive check
      if (Platform.isMobile) {
        try {
          cm.dom.win.addEventListener('keyboardDidShow', onShow);
        } catch (error) {
          console.warn(
            'Incremental Reading - Failed to add keyboardDidShow listener:',
            error
          );
        }
      }

      const cleanupEffect = () => {
        if (Platform.isMobile) {
          try {
            cm.dom.win.removeEventListener('keyboardDidShow', onShow);
          } catch (error) {
            console.warn(
              'Incremental Reading - Failed to remove keyboardDidShow listener:',
              error
            );
          }

          try {
            if (reviewView.activeEditor === controller) {
              reviewView.activeEditor = null;
            }

            if ((app.workspace.activeEditor as unknown) === controller) {
              app.workspace.activeEditor = null;
              (app as any).mobileToolbar?.update();
              reviewView.contentEl.removeClass('is-mobile-editing');
            }
          } catch (error) {
            console.warn(
              'Incremental Reading - Error during mobile cleanup:',
              error
            );
          }
          elRef.current?.removeChild(elRef.current?.children[0]);
          internalRef.current = null;
          if (editorRef) editorRef.current = null;
          // Clear editor view reference from ReviewManager if it matches this file
          if (reviewManager.currentEditorView?.file === item.file) {
            reviewManager.currentEditorView = null;
          }
        }
      };
      return cleanupEffect;
    };

    const cleanup = setupEditor();
    return () => {
      cleanup();
    };
  }, [reviewView, reviewManager, store]);

  useEffect(
    function updateEditorContent() {
      // Defer the dispatch to avoid "update in progress" errors
      setTimeout(() => {
        if (!internalRef.current) return;

        const view = internalRef.current;
        // Only update if the content actually changed
        if (view.state.doc.toString() !== (value ?? '')) {
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: value ?? '',
            },
            annotations: isExternalSync.of(true),
          });
        }
      }, 0);
    },
    [internalRef.current, value]
  );

  // Sync showAnswer state to the action bar extension
  useEffect(() => {
    if (!internalRef.current) return;
    internalRef.current.dispatch({
      effects: setShowAnswerEffect.of(showAnswer),
    });
  }, [item, showAnswer]);

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

  return (
    <>
      {isReviewArticle(item) && <TitleEditor item={item} />}
      <div className={classcat(cls)} ref={elRef}></div>
    </>
  );
}
