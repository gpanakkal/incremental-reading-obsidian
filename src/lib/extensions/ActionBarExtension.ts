import {
  ERROR_NOTICE_DURATION_MS,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { fetchByFile, invalidateCacheOnMatch } from '#/lib/query-client';
import type { NoteType, ReviewCard } from '#/lib/types';
import {
  isReviewArticle,
  isReviewCard,
  isReviewSnippet,
  type ReviewArticle,
  type ReviewItem,
  type ReviewSnippet,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import type { EditorView, Panel } from '@codemirror/view';
import { showPanel, ViewPlugin } from '@codemirror/view';
import type { App, EventRef, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import { irPluginFacet } from './irPluginFacet';

/**
 * State effect to toggle review mode on/off.
 * When in review mode, the action bar shows review-specific buttons.
 * When not in review mode (standalone), shows simpler actions like dismiss/un-dismiss.
 */
export const setReviewModeEffect = StateEffect.define<boolean>();

/**
 * State effect to set whether the answer is shown (for cards).
 */
export const setShowAnswerEffect = StateEffect.define<boolean>();

/**
 * State effect to provide review context callbacks.
 * This allows ReviewView to inject its context methods into the extension.
 */
export interface ReviewCallbacks {
  reviewArticle?: (article: ReviewArticle) => Promise<void>;
  reviewSnippet?: (snippet: ReviewSnippet) => Promise<void>;
  gradeCard?: (card: ReviewCard, grade: number) => Promise<void>;
  dismissItem?: (item: ReviewItem) => Promise<void>;
  skipItem?: (item: ReviewItem) => void;
  setShowAnswer?: (show: boolean) => void;
  getCurrentItem?: () => ReviewItem | null;
}

export const setReviewCallbacks = StateEffect.define<ReviewCallbacks>();

const setNoteTypeEffect = StateEffect.define<NoteType | null>();

/**
 * State field tracking action bar state.
 */
interface ActionBarState {
  isReviewMode: boolean;
  showAnswer: boolean;
  callbacks: ReviewCallbacks;
  noteType: NoteType | null;
}

export const actionBarStateField = StateField.define<ActionBarState>({
  create: () => ({
    isReviewMode: false,
    showAnswer: false,
    callbacks: {},
    noteType: null,
  }),
  update(value, tr) {
    let newValue = value;
    for (const effect of tr.effects) {
      if (effect.is(setReviewModeEffect)) {
        newValue = { ...newValue, isReviewMode: effect.value };
      } else if (effect.is(setShowAnswerEffect)) {
        newValue = { ...newValue, showAnswer: effect.value };
      } else if (effect.is(setReviewCallbacks)) {
        newValue = { ...newValue, callbacks: effect.value };
      } else if (effect.is(setNoteTypeEffect)) {
        newValue = { ...newValue, noteType: effect.value };
      }
    }
    return newValue;
  },
});

/**
 * Creates the action bar panel for IR notes.
 * The noteType is pre-validated by the compute function,
 * so we can assume it's valid.
 */
function createActionBarPanel(
  noteType: NoteType,
  app: App
): (view: EditorView) => Panel {
  return (view: EditorView): Panel => {
    const dom = document.createElement('div');
    dom.className = 'ir-action-bar ir-action-bar-panel';

    // Initial render
    renderActionBar(view, dom, noteType);

    return {
      dom,
      top: !app.isMobile,
      update(update) {
        // Re-render if state changed
        const prevState = update.startState.field(actionBarStateField);
        const newState = update.state.field(actionBarStateField);

        if (
          prevState.isReviewMode !== newState.isReviewMode ||
          prevState.showAnswer !== newState.showAnswer
        ) {
          const { info } = Obsidian.getFileInfoFromState(update.state);
          if (!info) return;

          const { file } = info;
          if (!file) return;

          renderActionBar(update.view, dom, noteType);
        }
      },
    };
  };
}

/**
 * Render the action bar contents based on context.
 */
function renderActionBar(
  view: EditorView,
  container: HTMLElement,
  noteType: NoteType
) {
  const state = view.state.field(actionBarStateField);
  const plugin = view.state.facet(irPluginFacet);

  container.empty();

  if (state.isReviewMode) {
    // Review mode: use callbacks from ReviewContext
    renderReviewModeActions(view, container, noteType, state);
  } else {
    // Standalone mode: basic actions via ReviewManager
    renderStandaloneModeActions(view, container, plugin);
  }
}

/**
 * Render actions for review mode (inside ReviewView).
 * NOTE: this is not used; see ActionBar.tsx instead.
 */
function renderReviewModeActions(
  view: EditorView,
  container: HTMLElement,
  noteType: NoteType,
  state: ActionBarState
) {
  const { callbacks } = state;

  if (noteType === 'card') {
    if (state.showAnswer) {
      // Grade buttons
      const grades = [
        { label: '🔁 Again', grade: 1 },
        { label: '👎 Hard', grade: 2 },
        { label: '👍 Good', grade: 3 },
        { label: '✅ Easy', grade: 4 },
      ];

      for (const { label, grade } of grades) {
        const btn = createButton(label, async () => {
          const item = callbacks.getCurrentItem?.();
          if (item && isReviewCard(item) && callbacks.gradeCard) {
            await callbacks.gradeCard(item, grade);
          }
        });
        container.appendChild(btn);
      }
    } else {
      // Show answer button
      const btn = createButton('Show Answer', () => {
        callbacks.setShowAnswer?.(true);
        view.dispatch({ effects: setShowAnswerEffect.of(true) });
      });
      container.appendChild(btn);
    }
  } else {
    // Article or Snippet: Continue button
    const continueBtn = createButton('Continue', async () => {
      const item = callbacks.getCurrentItem?.();
      if (!item) return;

      if (isReviewArticle(item)) {
        await callbacks.reviewArticle?.(item);
      } else if (isReviewSnippet(item)) {
        await callbacks.reviewSnippet?.(item);
      }
    });
    container.appendChild(continueBtn);

    // Priority input for articles and snippets
    const item = callbacks.getCurrentItem?.();
    if (item) {
      const plugin = view.state.facet(irPluginFacet);
      const reviewManager = plugin?.reviewManager;
      if (reviewManager && !isReviewCard(item)) {
        const priorityEl = createPriorityInput(
          item.data.priority / 10,
          async (newPriority) => {
            try {
              if (noteType === 'article') {
                await reviewManager.reprioritize(
                  item.data as ReviewArticle['data'],
                  newPriority
                );
              } else if (noteType === 'snippet') {
                await reviewManager.reprioritize(
                  item.data as ReviewSnippet['data'],
                  newPriority
                );
              }
              new Notice(
                `Priority set to ${newPriority / 10}`,
                SUCCESS_NOTICE_DURATION_MS
              );
            } catch (error) {
              new Notice(`Failed to update priority`, ERROR_NOTICE_DURATION_MS);
              console.error(error);
            }
          },
          item.data.priority / 10, // Reset value on Escape
          view // EditorView for returning focus after Enter
        );
        container.appendChild(priorityEl);
      }
    }
  }

  // Common actions for all types
  // Check if item is already dismissed to show appropriate label
  const currentItem = callbacks.getCurrentItem?.();
  const isDismissed = currentItem?.data?.dismissed ?? null;
  if (isDismissed === null) {
    const error = `Above item has no data.dismissed property`;
    console.error(currentItem);
    throw new Error(error);
  }
  const dismissBtn = createButton(
    isDismissed ? 'Un-dismiss' : 'Dismiss',
    async () => {
      const item = callbacks.getCurrentItem?.();
      if (item && callbacks.dismissItem) {
        await callbacks.dismissItem(item);
      }
    }
  );
  container.appendChild(dismissBtn);

  const skipBtn = createButton('Skip', () => {
    const item = callbacks.getCurrentItem?.();
    if (item && callbacks.skipItem) {
      callbacks.skipItem(item);
    }
  });
  container.appendChild(skipBtn);
}

/**
 * Render actions for standalone mode (normal Obsidian tabs).
 * Can be called from both CodeMirror panel (edit mode) and reading mode DOM injection.
 */
export function renderStandaloneActionBarDOM(
  file: TFile,
  plugin: IncrementalReadingPlugin,
  container: HTMLElement
): void {
  const { reviewManager } = plugin;
  if (!reviewManager) return;

  // Create dismiss button with loading state, then fetch actual status
  const dismissToggleBtn = createButton('Loading...', async () => {});
  dismissToggleBtn.disabled = true;
  container.appendChild(dismissToggleBtn);

  // Fetch dismissed status and update button
  void (async () => {
    try {
      const item = await reviewManager.getReviewItemFromFile(file);

      if (!item) {
        dismissToggleBtn.textContent = 'Not in database';
        return;
      }

      // Update button label based on dismissed status
      const updateButtonLabel = (isDismissed: boolean) => {
        dismissToggleBtn.textContent = isDismissed ? 'Un-dismiss' : 'Dismiss';
      };

      updateButtonLabel(item.data.dismissed);
      dismissToggleBtn.disabled = false;

      // Set up click handler with current item reference
      dismissToggleBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
          // Re-fetch to get current status (may have changed)
          const item: ReviewItem | null =
            await reviewManager.getReviewItemFromFile(file);

          if (!item) {
            new Notice('Item not found in database', ERROR_NOTICE_DURATION_MS);
            return;
          }

          const isDismissed = item.data.dismissed;
          if (isDismissed) {
            await reviewManager.unDismissItem(item);
            new Notice('Item restored to queue', SUCCESS_NOTICE_DURATION_MS);
            updateButtonLabel(false);
          } else {
            await reviewManager.dismissItem(item);
            new Notice('Item dismissed', SUCCESS_NOTICE_DURATION_MS);
            updateButtonLabel(true);
          }

          await invalidateCacheOnMatch(item.file, reviewManager);
        } catch (error) {
          console.error('Failed to toggle dismiss status:', error);
          new Notice('Failed to update item', ERROR_NOTICE_DURATION_MS);
        }
      };
    } catch (error) {
      console.error('Failed to fetch item status:', error);
      dismissToggleBtn.textContent = 'Error';
    }
  })();

  // Open in review button
  const openInReviewBtn = createButton('Review', async () => {
    // Build a ReviewItem from this file to pass to the review interface
    const reviewItem = await fetchByFile(file, reviewManager);
    if (reviewItem) {
      await plugin.learn(reviewItem, false);
    } else {
      // Item not in database, just open the review interface
      await plugin.learn();
    }
  });
  container.appendChild(openInReviewBtn);
}

/**
 * Render actions for standalone mode (normal Obsidian tabs) from a CodeMirror EditorView.
 */
function renderStandaloneModeActions(
  view: EditorView,
  container: HTMLElement,
  plugin: IncrementalReadingPlugin | null
) {
  if (!plugin) return;
  const { info } = Obsidian.getFileInfoFromState(view.state);
  if (!info?.file) return;
  renderStandaloneActionBarDOM(info.file, plugin, container);
}

/**
 * Helper to create a button element.
 */
function createButton(
  label: string,
  onClick: () => void | Promise<void>
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ir-review-button';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onClick();
  });
  return btn;
}

/**
 * Creates a priority input field with label.
 * Handles Enter to save, Escape to reset, blur to save.
 * Converts multi-digit input to decimal in real-time (e.g., "21" -> "2.1").
 */
function createPriorityInput(
  initialValue: number,
  onSave: (newPriority: number) => Promise<void>,
  resetValue: number,
  editorView: EditorView
): HTMLElement {
  const container = document.createElement('label');
  container.className = 'ir-priority-label';
  container.textContent = 'Priority';

  const input = document.createElement('input');
  input.id = 'ir-priority-input';
  input.className = 'ir-priority-input';
  input.type = 'text';
  input.inputMode = 'decimal';
  input.value = String(initialValue);

  // Track the current transformed priority (stored as integer * 10)
  let currentPriority = Math.round(initialValue * 10);

  const saveValue = async () => {
    try {
      await onSave(currentPriority);
    } catch (error) {
      console.error(error);
      // Reset on error
      currentPriority = Math.round(resetValue * 10);
      input.value = String(resetValue);
    }
  };

  // Transform input in real-time as user types (e.g., "21" -> "2.1")
  input.addEventListener('input', () => {
    try {
      const priority = IRScheduler.transformPriority(input.value);
      currentPriority = priority;
      // Update display to show decimal form
      input.value = String(priority / 10);
    } catch (_error) {
      // Invalid input - ignore
    }
  });

  input.addEventListener('blur', () => {
    void saveValue();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveValue()
        .then(() => editorView.focus())
        .catch(() => {});
      // Return focus to the editor body
    } else if (e.key === 'Escape') {
      e.preventDefault();
      currentPriority = Math.round(resetValue * 10);
      input.value = String(resetValue);
      input.select();
    }
  });

  input.addEventListener('focus', () => {
    input.select();
  });

  // Prevent clicks from propagating to panel
  input.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  container.appendChild(input);
  return container;
}

/**
 * ViewPlugin that resolves the note type once per file and writes it into
 * actionBarStateField via setNoteTypeEffect. Keeping this out of compute()
 * ensures compute stays a pure state→value function with no side effects.
 */
const noteTypePlugin = ViewPlugin.define((view) => {
  let destroyed = false;
  let lastFilePath: string | undefined;
  let metadataCacheRef: EventRef | undefined;

  const lookup = (filePath: string) => {
    const { info } = Obsidian.getFileInfoFromState(view.state);
    if (!info?.file || !info.app) return;
    void Obsidian.getNoteType(info.file, info.app).then((resolved) => {
      if (destroyed) return;
      const current = view.state.field(actionBarStateField).noteType;
      if (resolved !== current) {
        view.dispatch({ effects: setNoteTypeEffect.of(resolved) });
      }
    });
    lastFilePath = filePath;
  };

  const subscribeToMetadataChanges = (app: App, filePath: string) => {
    if (metadataCacheRef) {
      app.metadataCache.offref(metadataCacheRef);
    }
    metadataCacheRef = app.metadataCache.on('changed', (changedFile) => {
      if (changedFile.path === filePath) lookup(filePath);
    });
  };

  // Initial lookup on mount
  const { info } = Obsidian.getFileInfoFromState(view.state);
  if (info?.file && info.app) {
    lookup(info.file.path);
    subscribeToMetadataChanges(info.app, info.file.path);
  }

  return {
    update() {
      const { info: newInfo } = Obsidian.getFileInfoFromState(view.state);
      if (!newInfo?.file || !newInfo.app) return;
      // Re-resolve only when the open file actually changes
      if (newInfo.file.path !== lastFilePath) {
        lookup(newInfo.file.path);
        subscribeToMetadataChanges(newInfo.app, newInfo.file.path);
      }
    },
    destroy() {
      destroyed = true;
      const { info } = Obsidian.getFileInfoFromState(view.state);
      if (metadataCacheRef && info?.app) {
        info.app.metadataCache.offref(metadataCacheRef);
      }
    },
  };
});

/**
 * Facet for conditionally showing the action bar panel.
 * Only shows for files with IR tags when NOT in review mode.
 * In review mode, the React ActionBar component handles the UI instead.
 * Pure state→panel derivation; all async work lives in noteTypePlugin.
 */
const actionBarPanelFacet = showPanel.compute(
  [actionBarStateField],
  (state) => {
    const actionBarState = state.field(actionBarStateField);
    if (actionBarState.isReviewMode) return null;

    const { info, editorView } = Obsidian.getFileInfoFromState(state);
    if (!info?.file) return null;

    const inSubEditor = !editorView?.dom.parentElement?.hasClass(
      'markdown-source-view'
    );
    if (inSubEditor) return null;

    const { noteType } = actionBarState;
    if (!noteType) return null;

    return createActionBarPanel(noteType, info.app);
  }
);

/**
 * The action bar extension bundle.
 */
export const actionBarExtension: Extension = [
  actionBarStateField,
  noteTypePlugin,
  actionBarPanelFacet,
];
