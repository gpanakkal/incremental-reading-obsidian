import { DISMISS_ICON_STROKE, PLUGIN_ICON } from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { fetchByFile, invalidateCacheOnMatch } from '#/lib/query-client';
import { isRefusal } from '#/lib/readiness';
import {
  isReviewArticle,
  isReviewCard,
  isReviewSnippet,
  type NoteType,
  type ReviewArticle,
  type ReviewCard,
  type ReviewItem,
  type ReviewSnippet,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import { type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  type EditorView,
  type Panel,
  showPanel,
  ViewPlugin,
} from '@codemirror/view';
import { type App, type EventRef, Keymap, setIcon, type TFile } from 'obsidian';
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
    const dom = createDiv();
    dom.className = 'ir-action-bar ir-action-bar-panel';

    // Initial render
    let teardown = renderActionBar(view, dom, noteType);

    return {
      dom,
      top: !app.isMobile,
      mount() {
        dom.parentElement?.classList.add('ir-action-bar-host');
      },
      destroy() {
        teardown();
        const host = dom.parentElement;
        dom.remove();
        if (host && !host.querySelector('.ir-action-bar')) {
          host.classList.remove('ir-action-bar-host');
        }
      },
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

          teardown();
          teardown = renderActionBar(update.view, dom, noteType);
        }
      },
    };
  };
}

/** Teardown for a bar that subscribed to nothing. */
const noTeardown = () => {};

/**
 * Render the action bar contents based on context.
 *
 * @returns a teardown for whatever the rendered bar subscribed to. Call it
 * before re-rendering into the same container, and when the bar goes away.
 */
function renderActionBar(
  view: EditorView,
  container: HTMLElement,
  noteType: NoteType
): () => void {
  const state = view.state.field(actionBarStateField);
  const plugin = view.state.facet(irPluginFacet);

  container.empty();

  if (state.isReviewMode) {
    // Review mode: use callbacks from ReviewContext
    renderReviewModeActions(view, container, noteType, state);
    return noTeardown;
  }
  // Standalone mode: basic actions via ReviewManager
  return renderStandaloneModeActions(view, container, plugin);
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
        { label: 'ðŸ” Again', grade: 1 },
        { label: 'ðŸ‘Ž Hard', grade: 2 },
        { label: 'ðŸ‘ Good', grade: 3 },
        { label: 'âœ… Easy', grade: 4 },
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
                await reviewManager.reprioritize(item.data, newPriority);
              } else if (noteType === 'snippet') {
                await reviewManager.reprioritize(item.data, newPriority);
              }
              Obsidian.notify(`Priority set to ${newPriority / 10}`, {
                kind: 'success',
              });
            } catch (error) {
              // A refusal has said why already (see `requireReady`)
              if (isRefusal(error)) return;
              Obsidian.notify(`Failed to update priority`, { kind: 'error' });
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
 *
 * @returns a teardown that stops watching the item. Call it whenever this DOM
 * is discarded or re-rendered, or the bar goes on reacting to writes for a
 * button that is no longer on screen.
 */
export function renderStandaloneActionBarDOM(
  file: TFile,
  plugin: IncrementalReadingPlugin,
  container: HTMLElement
): () => void {
  const { reviewManager } = plugin;
  if (!reviewManager) return noTeardown;

  // Create dismiss button with loading state, then fetch actual status
  const dismissToggleBtn = createFaceButton(FACES.loading, async () => {});
  dismissToggleBtn.disabled = true;
  container.appendChild(dismissToggleBtn);

  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const dispose = () => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  // Fetch dismissed status and update button
  void (async () => {
    try {
      const item = await reviewManager.getReviewItemFromFile(file);
      if (disposed) return;

      if (!item) {
        showFace(dismissToggleBtn, FACES.notInDatabase);
        return;
      }

      // Update button label based on dismissed status
      const updateButtonLabel = (isDismissed: boolean) => {
        showFace(
          dismissToggleBtn,
          isDismissed ? FACES.unDismiss : FACES.dismiss
        );
      };

      updateButtonLabel(item.data.dismissed);
      dismissToggleBtn.disabled = false;

      // This DOM outlives the single read above. The edit-mode bar is a
      // CodeMirror panel built once per editor and kept across switches to
      // reading mode and back, so a label painted from one read is whatever
      // was true when the editor was created â€” or when this button was last
      // clicked. Anything else that dismisses or restores the item (the
      // reading-mode bar, review, the queue table, a command) leaves it
      // describing the wrong action, while the click handler below re-reads
      // and does the right one. Re-read on every write touching this row so
      // the label keeps naming the action a click would actually take.
      const watchedId = item.data.id;
      unsubscribe = reviewManager.repo.onDataChange((event) => {
        if (!event.ids.includes(watchedId)) return;
        void (async () => {
          try {
            const current = await reviewManager.getReviewItemFromFile(file);
            // A row that has gone (deleted, or the note untagged) leaves the
            // last known label alone: the click handler re-reads before
            // acting and reports for itself, which beats a button relabelled
            // by a lookup that found nothing.
            if (disposed || !current) return;
            updateButtonLabel(current.data.dismissed);
          } catch (error) {
            // A failed re-read leaves the label alone too. Nothing awaits
            // this, so an error let through would surface as an uncaught one.
            console.error('Failed to refresh item status:', error);
          }
        })();
      });

      // Set up click handler with current item reference
      dismissToggleBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
          // Re-fetch to get current status (may have changed)
          const item: ReviewItem | null =
            await reviewManager.getReviewItemFromFile(file);

          if (!item) {
            Obsidian.notify('Item not found in database', { kind: 'error' });
            return;
          }

          const isDismissed = item.data.dismissed;
          if (isDismissed) {
            await reviewManager.unDismissItem(item);
            Obsidian.notify('Item restored to queue', { kind: 'success' });
            updateButtonLabel(false);
          } else {
            await reviewManager.dismissItem(item);
            Obsidian.notify('Item dismissed', { kind: 'success' });
            updateButtonLabel(true);
          }

          await invalidateCacheOnMatch(item.file, reviewManager);
        } catch (error) {
          if (isRefusal(error)) return;
          console.error('Failed to toggle dismiss status:', error);
          Obsidian.notify('Failed to update item', { kind: 'error' });
        }
      };
    } catch (error) {
      console.error('Failed to fetch item status:', error);
      showFace(dismissToggleBtn, FACES.error);
    }
  })();

  // Open in review button. Modifier keys and a middle click pick the pane the
  // way Obsidian's own links do; `learn` still reuses an open review tab, so
  // they only matter when there is none.
  const openInReviewBtn = createFaceButton(
    FACES.review,
    async (evt) => {
      // Build a ReviewItem from this file to pass to the review interface
      const reviewItem = await fetchByFile(file, reviewManager);
      if (reviewItem) {
        await plugin.learn(reviewItem, Keymap.isModEvent(evt));
      } else {
        // Item not in database, just open the review interface
        await plugin.learn();
      }
    },
    { middleClick: true }
  );
  container.appendChild(openInReviewBtn);

  return dispose;
}

/**
 * Render actions for standalone mode (normal Obsidian tabs) from a CodeMirror EditorView.
 *
 * @returns the bar's teardown, or a no-op when there was nothing to render.
 */
function renderStandaloneModeActions(
  view: EditorView,
  container: HTMLElement,
  plugin: IncrementalReadingPlugin | null
): () => void {
  if (!plugin) return noTeardown;
  const { info } = Obsidian.getFileInfoFromState(view.state);
  if (!info?.file) return noTeardown;
  return renderStandaloneActionBarDOM(info.file, plugin, container);
}

const MIDDLE_MOUSE_BUTTON = 1;

/**
 * Helper to create a button element.
 *
 * @param options.middleClick whether a middle click counts as a click too, for
 * a button that opens something and so can open it in a new tab.
 */
function createButton(
  label: string,
  onClick: (evt: MouseEvent) => void | Promise<void>,
  { middleClick = false }: { middleClick?: boolean } = {}
): HTMLButtonElement {
  const btn = createEl('button');
  btn.className = 'ir-review-button';
  btn.textContent = label;
  const handle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void onClick(e);
  };
  btn.addEventListener('click', handle);
  if (middleClick) {
    // A middle click never fires `click` — browsers emit `auxclick` for every
    // non-primary button, the right one included, hence the button check.
    btn.addEventListener('auxclick', (e) => {
      if (e.button === MIDDLE_MOUSE_BUTTON) handle(e);
    });
    // Middle-mousedown starts autoscroll on Windows and pastes the primary
    // selection on Linux. Claim it so the auxclick that follows only opens.
    btn.addEventListener('mousedown', (e) => {
      if (e.button === MIDDLE_MOUSE_BUTTON) e.preventDefault();
    });
  }
  return btn;
}

/**
 * What a standalone bar button shows: an Obsidian icon, named for its tooltip
 * and for screen readers by `label`, or — for a status with no action behind
 * it — plain text, which needs no tooltip to be read.
 */
type ButtonFace =
  | { icon: string; label: string; stroke?: string }
  | { text: string };

const FACES = {
  // Same size as the icon that replaces it, so the bar doesn't shift when the
  // lookup lands
  loading: { icon: 'loader', label: 'Loading...' },
  notInDatabase: { text: 'Not in database' },
  error: { text: 'Error' },
  dismiss: { icon: 'ban', label: 'Dismiss', stroke: DISMISS_ICON_STROKE },
  unDismiss: {
    icon: 'archive-restore',
    label: 'Un-dismiss',
    stroke: DISMISS_ICON_STROKE,
  },
  review: { icon: PLUGIN_ICON, label: 'Review' },
} satisfies Record<string, ButtonFace>;

/**
 * Paint `face` onto `btn`, replacing whatever it showed before.
 *
 * An icon's label goes on the button, never the `<svg>`: Obsidian shows a
 * tooltip for any `[aria-label]` under the pointer, and its handler throws on
 * an SVG target. No `title` either, which would stack the browser's own
 * tooltip on Obsidian's.
 */
function showFace(btn: HTMLButtonElement, face: ButtonFace) {
  btn.replaceChildren();
  const isIcon = 'icon' in face;
  btn.classList.toggle('clickable-icon', isIcon);
  btn.classList.toggle('ir-action-bar-status', !isIcon);
  if (!isIcon) {
    btn.removeAttribute('aria-label');
    btn.textContent = face.text;
    return;
  }
  btn.setAttribute('aria-label', face.label);
  setIcon(btn, face.icon);
  if (face.stroke)
    btn.querySelector('svg')?.setAttribute('stroke', face.stroke);
}

/** {@link createButton}, showing `face` instead of a text label. */
function createFaceButton(
  face: ButtonFace,
  onClick: Parameters<typeof createButton>[1],
  options?: Parameters<typeof createButton>[2]
): HTMLButtonElement {
  const btn = createButton('', onClick, options);
  showFace(btn, face);
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
  const container = createEl('label');
  container.className = 'ir-priority-label';
  container.textContent = 'Priority';

  const input = createEl('input');
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
 *
 * The type of a file just opened is read from the note, since the metadata
 * cache may not have parsed it yet; every change after that is typed from the
 * parse the cache's `changed` event carries. The newest answer wins: a read
 * still under way when a newer answer lands is dropped, so a note opened just
 * before it is un-imported can't get its bar back from the tagged text.
 */
const noteTypePlugin = ViewPlugin.define((view) => {
  let destroyed = false;
  let lastFilePath: string | undefined;
  let metadataCacheRef: EventRef | undefined;
  /** Bumped by each answer started, so only the newest is applied. */
  let latest = 0;

  const apply = (resolved: NoteType | null) => {
    const current = view.state.field(actionBarStateField).noteType;
    if (resolved !== current) {
      view.dispatch({ effects: setNoteTypeEffect.of(resolved) });
    }
  };

  const lookup = (filePath: string) => {
    const { info } = Obsidian.getFileInfoFromState(view.state);
    if (!info?.file || !info.app) return;
    const thisLookup = ++latest;
    void Obsidian.getNoteType(info.file, info.app).then((resolved) => {
      if (destroyed || thisLookup !== latest) return;
      apply(resolved);
    });
    lastFilePath = filePath;
  };

  const subscribeToMetadataChanges = (app: App, filePath: string) => {
    if (metadataCacheRef) {
      app.metadataCache.offref(metadataCacheRef);
    }
    metadataCacheRef = app.metadataCache.on(
      'changed',
      (changedFile, _data, cache) => {
        if (destroyed || changedFile.path !== filePath) return;
        latest += 1;
        apply(Obsidian.noteTypeFromCache(changedFile, cache, app));
      }
    );
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
 * Pure stateâ†’panel derivation; all async work lives in noteTypePlugin.
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
