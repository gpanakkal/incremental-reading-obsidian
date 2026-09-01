import { useAppSelector, useAppStore } from '#/hooks/useAppSelector';
import {
  isExternalSync,
  isReviewInterfaceFacet,
  setReviewCallbacks,
  setReviewModeEffect,
  setShowAnswerEffect,
  type ReviewCallbacks,
} from '#/lib/extensions';
import { type ExtractedMobileToolbar,
  getBaseMarkdownExtensions,
  getMarkdownController,
  setInsertMode } from '#/lib/obsidian-editor';
import { isEditing, setShowAnswer } from '#/lib/store';
import {
  type ReviewArticle,
  type ReviewCard,
  type ReviewItem,
  type ReviewSnippet, isReviewArticle 
} from '#/lib/types';
import { insertBlankLine } from '@codemirror/commands';
import { type Extension, EditorSelection, Prec  } from '@codemirror/state';
import { type ViewUpdate,
  EditorView,
  keymap,
  placeholder as placeholderExt,
  scrollPastEnd } from '@codemirror/view';
import { Platform } from 'obsidian';
import {
  createPortal,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { useDispatch } from 'react-redux';
import type { Grade } from 'ts-fsrs';
import { useReviewContext } from './ReviewContext';
import { TitleEditor } from './TitleEditor';
import type { EditCoordinates } from './types';

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

/**
 * Whether a document change originated in this editor and so belongs on disk.
 *
 * `updateEditorContent` pushes freshly fetched file text in as a full-document
 * replacement, which reaches `onUpdate` looking exactly like typing. Writing
 * that back would save content the editor was *handed* into whichever note the
 * editor is currently pointed at, so any moment where the displayed text and
 * the target note disagree becomes an overwrite of the target. Content that
 * came from disk never needs to be written to disk, so it is skipped.
 */
export function isPersistableChange(update: ViewUpdate): boolean {
  if (!update.docChanged) return false;
  return !update.transactions.some((tr) => tr.annotation(isExternalSync));
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The narrowest replacement that turns `current` into `next`, or `null` when
 * they already match.
 *
 * CodeMirror holds the viewport still across a document change by remembering
 * the line at the top of the screen and re-locating it afterwards: `ViewState`
 * saves `scrollAnchorPos = changes.mapPos(anchor.from, -1)`, then the next
 * measure pass shifts `scrollDOM.scrollTop` by however far that line moved. A
 * `{from: 0, to: doc.length}` replacement deletes the anchor along with the
 * rest of the document, so `mapPos` collapses it to 0 and the measure pass
 * dutifully scrolls line 0 back under the viewport top — the jump to the top of
 * the note. That correction lands on the next animation frame, which is why
 * restoring `scrollTop` by hand right after the dispatch cannot prevent it.
 *
 * Trimming the shared prefix and suffix leaves the anchor outside the changed
 * range, where it maps to itself. It also lets the selection map correctly
 * instead of collapsing, and spares undo history and decorations from a
 * needless rebuild.
 */
export function computeMinimalChange(
  current: string,
  next: string
): { from: number; to: number; insert: string } | null {
  if (current === next) return null;

  const shorter = Math.min(current.length, next.length);
  let prefix = 0;
  while (
    prefix < shorter &&
    current.charCodeAt(prefix) === next.charCodeAt(prefix)
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    current.charCodeAt(current.length - 1 - suffix) ===
      next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }

  // Both boundaries are code-unit offsets, so either can land between the
  // halves of a surrogate pair and hand CodeMirror a position inside an
  // astral character. Widening the changed range by one unit swallows the pair
  // whole; it can never underflow, since `charCodeAt` off either end is NaN.
  if (isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;
  if (isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--;

  return {
    from: prefix,
    to: current.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
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

  const { reviewView, reviewManager, actions } = useReviewContext();
  const elRef = useRef<HTMLDivElement | null>(null);
  const internalRef = useRef<EditorView | null>(null);
  const [titlePortalEl, setTitlePortalEl] = useState<Element | null>(null);
  const itemRef = useRef(item);
  const { saveNote } = useReviewContext();
  const store = useAppStore();
  const showAnswer = useAppSelector((state) => state.showAnswer);
  // Tracks the content of the last successful save. updateEditorContent uses
  // this to distinguish a stale re-fetch of our own write (skip) from a
  // genuine external modification (apply).
  const lastSavedContentRef = useRef<string>(value ?? '');

  // The current-item query refetches on an interval and after every mutation,
  // so `item` is a new object — with a possibly renamed TFile — on many
  // renders even though its id, and therefore this mount, stays the same.
  // Saves must land on the latest one.
  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  const handleChange = async (update: ViewUpdate) => {
    if (!isPersistableChange(update)) return;

    const docText = update.state.doc.toString();
    lastSavedContentRef.current = docText;
    // TODO: don't save if changes occurred outside review
    await saveNote(itemRef.current, docText);
  };

  // extend the MarkdownEditor extracted from Obsidian
  useEffect(() => {
    const setupEditor = () => {
      /* eslint-disable-next-line react-hooks/unsupported-syntax --
       * Required since we have to create CustomEditor at runtime
       **/
      class CustomEditor extends reviewView.plugin.MarkdownEditor {
        isIncrementalReadingEditor = true;

        // // Override getSelection to provide proper context
        // getSelection() {
        //   return window.getSelection();
        // }

        onUpdate(update: ViewUpdate, changed: boolean) {
          super.onUpdate(update, changed);
          void handleChange(update);
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
                    reviewView.app.workspace.activeEditor = this.owner;
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
                insertBlankLine(cm);
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

      const app = reviewView.app;
      let editor: CustomEditor;
      let cm: EditorView;
      let titleContainer: HTMLDivElement | null = null;

      const controller = getMarkdownController(
        reviewView,
        () => editor.editor,
        () => itemRef.current
      );
      try {
        editor = new CustomEditor(app, elRef.current, controller);
        cm = editor.cm;
        cm.scrollDOM.classList.add('ir-review-scroller');
        internalRef.current = cm;
        controller.editMode = editor;
        editor.set(value ?? '');

        if (editorRef) editorRef.current = cm;
      } catch (error) {
        console.error('Error creating editor:', error);
        throw error;
      }

      // Enable review mode in the action bar extension
      // This tells the extension we're in the review interface context
      const reviewCallbacks: ReviewCallbacks = {
        reviewArticle: async (item: ReviewArticle) =>
          actions.reviewArticle(item),
        reviewSnippet: async (item: ReviewSnippet) =>
          actions.reviewSnippet(item),
        gradeCard: async (item: ReviewCard, grade: Grade) =>
          actions.gradeCard(item, grade),
        dismissItem: async (reviewItem: ReviewItem) =>
          actions.dismissItem(reviewItem),
        skipItem: (reviewItem: ReviewItem) => actions.skipItem(reviewItem),
        setShowAnswer: (show) => dispatch(setShowAnswer(show)),
        getCurrentItem: () => itemRef.current,
      };

      cm.dispatch({
        effects: [
          setReviewModeEffect.of(true),
          setReviewCallbacks.of(reviewCallbacks),
        ],
      });

      // Render TitleEditor via React portal into a container prepended to
      // .cm-sizer, so it appears above the note body. .cm-sizer is created
      // synchronously by CodeMirror's constructor, so it's always present here.
      if (isReviewArticle(item)) {
        const cmSizer = cm.dom.querySelector('.cm-sizer');
        if (cmSizer) {
          titleContainer = createDiv();
          cmSizer.prepend(titleContainer);
          setTitlePortalEl(titleContainer);
        }
      }

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
        titleContainer?.remove();
        setTitlePortalEl(null);

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
            if (reviewView.activeEditor === (controller as unknown)) {
              reviewView.activeEditor = null;
            }

            if ((app.workspace.activeEditor as unknown) === controller) {
              app.workspace.activeEditor = null;
              (app.mobileToolbar as ExtractedMobileToolbar)?.update();
              reviewView.contentEl.removeClass('is-mobile-editing');
            }
          } catch (error) {
            console.warn(
              'Incremental Reading - Error during mobile cleanup:',
              error
            );
          }
        }
        elRef.current?.removeChild(elRef.current?.children[0]);
        internalRef.current = null;
        if (editorRef) editorRef.current = null;
      };
      return cleanupEffect;
    };

    const cleanup = setupEditor();
    return () => {
      cleanup();
    };
  }, [reviewView, reviewManager, store]);

  useLayoutEffect(
    function updateEditorContent() {
      if (!internalRef.current) return;

      const view = internalRef.current;
      const currentDoc = view.state.doc.toString();
      if (currentDoc === value || value === lastSavedContentRef.current) return;

      const change = computeMinimalChange(currentDoc, value ?? '');
      if (!change) return;

      // No `selection` is passed: with the change narrowed to the span that
      // actually differs, CodeMirror's own mapping moves the cursor by exactly
      // the amount the text before it grew or shrank.
      const { scrollTop, scrollLeft } = view.scrollDOM;
      view.dispatch({
        changes: change,
        annotations: isExternalSync.of(true),
      });
      // The scroll anchor is only honoured while `scrollDOM.scrollTop` still
      // agrees with the value CodeMirror recorded at its last measure; a
      // disagreement of more than a pixel makes it discard the anchor. Putting
      // back whatever the DOM rewrite disturbed is what keeps the correction
      // above armed.
      view.scrollDOM.scrollTop = scrollTop;
      view.scrollDOM.scrollLeft = scrollLeft;
    },
    [value]
  );

  // Sync showAnswer state to the action bar extension
  useEffect(() => {
    if (!internalRef.current) return;
    internalRef.current.dispatch({
      effects: setShowAnswerEffect.of(showAnswer),
    });
  }, [showAnswer]);

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
      <div className={cls.join(' ')} ref={elRef}></div>
      {titlePortalEl &&
        createPortal(
          <TitleEditor item={item as ReviewArticle} />,
          titlePortalEl
        )}
    </>
  );
}
