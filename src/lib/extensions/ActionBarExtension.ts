import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { showPanel } from '@codemirror/view';
import { Notice } from 'obsidian';
import {
  ERROR_NOTICE_DURATION_MS,
  SUCCESS_NOTICE_DURATION_MS,
} from '#/lib/constants';
import type { NoteType, ReviewCard } from '#/lib/types';
import {
  isReviewArticle,
  isReviewCard,
  isReviewSnippet,
  type ReviewArticle,
  type ReviewItem,
  type ReviewSnippet,
} from '#/lib/types';
import { transformPriority } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import { irPluginFacet } from './irPluginFacet';
import type { EditorView, Panel } from '@codemirror/view';
import type { App } from 'obsidian';

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

/**
 * State field tracking action bar state.
 */
interface ActionBarState {
  isReviewMode: boolean;
  showAnswer: boolean;
  callbacks: ReviewCallbacks;
}

export const actionBarStateField = StateField.define<ActionBarState>({
  create: () => ({
    isReviewMode: false,
    showAnswer: false,
    callbacks: {},
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
          const info = Obsidian.getFileInfoFromState(update.state);
          if (!info) return;

          const { file, app } = info;
          if (!file) return;

          const currentNoteType = Obsidian.getNoteType(file, app);
          if (currentNoteType) {
            renderActionBar(update.view, dom, currentNoteType);
          }
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
 */
function renderStandaloneModeActions(
  view: EditorView,
  container: HTMLElement,
  plugin: IncrementalReadingPlugin | null
) {
  if (!plugin || !plugin.reviewManager) {
    return;
  }

  const { reviewManager } = plugin;
  const info = Obsidian.getFileInfoFromState(view.state);
  if (!info) return;

  const { file } = info;
  if (!file) return;

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

          await plugin.invalidateCurrentItemCache(item.file);
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
  const openInReviewBtn = createButton('Open in Review', async () => {
    // Build a ReviewItem from this file to pass to the review interface
    const reviewItem = await reviewManager.getReviewItemFromFile(file);
    if (reviewItem) {
      await plugin.learn(reviewItem);
    } else {
      // Item not in database, just open the review interface
      await plugin.learn();
    }
  });
  container.appendChild(openInReviewBtn);
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
      // Reset on error
      currentPriority = Math.round(resetValue * 10);
      input.value = String(resetValue);
    }
  };

  // Transform input in real-time as user types (e.g., "21" -> "2.1")
  input.addEventListener('input', () => {
    try {
      const priority = transformPriority(input.value);
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
 * Facet for conditionally showing the action bar panel.
 * Only shows for files with IR tags when NOT in review mode.
 * In review mode, the React ActionBar component handles the UI instead.
 */
const actionBarPanelFacet = showPanel.compute(
  [actionBarStateField],
  (state) => {
    // Don't show the CM panel when in review mode - the React ActionBar handles that
    const actionBarState = state.field(actionBarStateField);
    if (actionBarState.isReviewMode) return null;

    const info = Obsidian.getFileInfoFromState(state);
    if (!info) return null;

    const { file, app } = info;

    if (!file) return null;

    const noteType = Obsidian.getNoteType(file, app);
    if (!noteType) return null;

    // Return the panel constructor with the noteType pre-bound
    return createActionBarPanel(noteType, app);
  }
);

/**
 * The action bar extension bundle.
 */
export const actionBarExtension: Extension = [
  actionBarStateField,
  actionBarPanelFacet,
];
