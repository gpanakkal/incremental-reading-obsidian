import type IncrementalReadingPlugin from '#/main';
import { MarkdownView, type TFile } from 'obsidian';
import { type Grade, Rating } from 'ts-fsrs';
import { CONTENT_TITLE_SLICE_LENGTH, MS_PER_DAY } from './constants';
import IRScheduler from './IRScheduler';
import {
  type MatchEphemeralState,
  findArticleSource,
  resolveItemContext,
} from './item-context';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import {
  fetchCurrentItem,
  invalidateCurrentItemQuery,
  invalidateItemQuery,
  queryClient,
} from './query-client';
import {
  addCompletedReview,
  addSeenId,
  removeCompletedReview,
  removeSeenId,
  resetCurrentItem,
  setCurrentItemId,
  setTypesToReview,
  store,
} from './store';
import {
  NOTE_TYPES,
  type NoteType,
  type ReviewArticle,
  type ReviewCard,
  type ReviewItem,
  type ReviewSnippet,
  type ReviewText,
  isReviewArticle,
} from './types';
import { getContentSlice, getEndOfDay } from './utils';

export type ActionStackEntry = {
  item: ReviewItem;
  description: string;
  undo: () => void | Promise<void>;
};

/**
 * Coordinates review operations with store and query cache updates
 */
export class Actions {
  plugin: IncrementalReadingPlugin;
  undoStack: ActionStackEntry[];
  emitter;
  subscribe;

  constructor(plugin: IncrementalReadingPlugin) {
    this.plugin = plugin;
    this.undoStack = [];
    this.emitter = this._createEmitter();
    this.subscribe = this.emitter.subscribe;
  }

  review = async (item: ReviewText, nextInterval?: number) => {
    if (isReviewArticle(item)) return this.reviewArticle(item, nextInterval);
    return this.reviewSnippet(item, nextInterval);
  };

  reviewArticle = async (article: ReviewArticle, nextInterval?: number) => {
    try {
      const beforeReview = { ...article.data };
      const reviewId = await this.plugin.reviewManager.reviewArticle(
        article.data,
        Date.now(),
        nextInterval
      );
      this._recordReview(reviewId, 'article');
      if (article.data.dismissed) {
        await this.unDismissItem(article);
      }
      if (nextInterval) {
        Obsidian.notify(
          `Next article review manually scheduled for ` +
            `${Math.round((10 * nextInterval) / MS_PER_DAY) / 10} days from now`
        );
      }
      this._getNext();
      this._pushUndo({
        item: article,
        description: `reviewing "${article.file.basename}"`,
        undo: async () => {
          await this.plugin.reviewManager.articles.undoReview(
            beforeReview,
            reviewId
          );
          this._unrecordReview(reviewId);
          await invalidateItemQuery(article.data.id);
          this._returnToItem(article);
        },
      });
    } catch (error) {
      console.error(error);
    }
  };

  reviewSnippet = async (snippet: ReviewSnippet, nextInterval?: number) => {
    try {
      const beforeReview = { ...snippet.data };
      const reviewId = await this.plugin.reviewManager.reviewSnippet(
        snippet.data,
        Date.now(),
        nextInterval
      );
      this._recordReview(reviewId, 'snippet');
      if (snippet.data.dismissed) {
        await this.unDismissItem(snippet);
      }
      if (nextInterval) {
        Obsidian.notify(
          `Next snippet review manually scheduled for ` +
            `${Math.round((10 * nextInterval) / MS_PER_DAY) / 10} days from now`
        );
      }
      this._getNext();
      this._pushUndo({
        item: snippet,
        description: `reviewing "${snippet.file.basename}"`,
        undo: async () => {
          await this.plugin.reviewManager.snippets.undoReview(
            beforeReview,
            reviewId
          );
          this._unrecordReview(reviewId);
          await invalidateItemQuery(snippet.data.id);
          this._returnToItem(snippet);
        },
      });
    } catch (error) {
      console.error(error);
    }
  };

  /**
   * @param newPriority decimal number from 1.0 to 5.0, inclusive
   */
  reprioritize = async (item: ReviewText, priority: number) => {
    IRScheduler.validatePriority(priority);
    if (priority === item.data.priority) return;
    try {
      await this.plugin.reviewManager.reprioritize(item.data, priority);
      await invalidateItemQuery(item.data.id);
      Obsidian.notify(`Priority set to ${priority / 10}`);
    } catch (_error) {
      Obsidian.notify(`Failed to update priority for "${item.data.reference}"`);
    }
  };

  /** Set or remove a fixed interval on an article */
  manageFixedInterval = async (
    article: ReviewArticle,
    changes: { newIntervalDays: number } | { newPriority: number }
  ) => {
    await this.plugin.reviewManager.manageFixedInterval(article.data, changes);
    await invalidateItemQuery(article.data.id);
  };

  gradeCard = async (card: ReviewCard, grade: Grade) => {
    const reviewRowId = await this.plugin.reviewManager.reviewCard(
      card.data,
      grade
    );
    this._recordReview(reviewRowId, 'card');
    const wasDismissed = card.data.dismissed;
    if (wasDismissed) {
      await this.unDismissItem(card);
    }

    this._pushUndo({
      item: card,
      description: `grading "${card.file.basename}" ${Rating[grade]}`,
      undo: async () => {
        await this.plugin.reviewManager.cards.rollbackBeforeReview(
          card.data,
          reviewRowId
        );
        this._unrecordReview(reviewRowId);
        if (wasDismissed) {
          await this.dismissItem(card);
        }

        await invalidateItemQuery(card.data.id);
        this._returnToItem(card);
      },
    });

    Obsidian.notify(`Graded as: ${Rating[grade]}`);
    this._getNext();
  };

  dismissItem = async (item: ReviewItem) => {
    // Check if it was being reviewed to conditionally navigate review back to
    // item upon undoing, since items can also be dismissed outside review
    const wasBeingReviewed = item.data.id === store.getState().currentItemId;
    await this.plugin.reviewManager.dismissItem(item);
    await invalidateItemQuery(item.data.id);

    this._pushUndo({
      item,
      description: `dismissing "${item.file.basename}"`,
      undo: async () => {
        await this.plugin.reviewManager.unDismissItem(item);
        await invalidateItemQuery(item.data.id);
        if (wasBeingReviewed) this._returnToItem(item);
      },
    });

    const itemTitle = getContentSlice(
      item.file.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );
    Obsidian.notify(`Dismissed "${itemTitle}"`);
    if (wasBeingReviewed) {
      this._getNext();
    }
  };

  unDismissItem = async (item: ReviewItem) => {
    await this.plugin.reviewManager.unDismissItem(item);
    await invalidateItemQuery(item.data.id);
    const { currentItemId } = store.getState();
    if (currentItemId === null) {
      // TODO: set the now-undismissed item as the current one?
      this._getNext();
    }

    const itemTitle = getContentSlice(
      item.file.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );
    Obsidian.notify(`Restored "${itemTitle}" to queue`);
  };

  /**
   * Asks for confirmation if enabled in settings; moves file to trash
   */
  deleteItem = async (item: ReviewItem) => {
    await this.plugin.app.fileManager.promptForFileDeletion(item.file);
    const { currentItemId } = store.getState();
    if (item.data.id === currentItemId) {
      this._getNext();
    }
  };

  skipItem = (item: ReviewItem) => {
    const resetTime = getEndOfDay(this.plugin.settings.dayRolloverOffset);
    this.plugin.store.dispatch(addSeenId({ id: item.data.id, resetTime }));

    this._pushUndo({
      item,
      description: `skipping "${item.file.basename}"`,
      undo: () => {
        this.plugin.store.dispatch(removeSeenId({ id: item.data.id }));
        this._returnToItem(item);
      },
    });
    const itemTitle = getContentSlice(
      item.file.basename,
      CONTENT_TITLE_SLICE_LENGTH + 5,
      true
    );
    Obsidian.notify(`Skipping ${itemTitle}`);
    this._getNext();
  };

  createSnippet = async (firstReview?: number) => {
    const editor = this.plugin.app.workspace.activeEditor?.editor;
    if (!editor) return null;

    const view =
      this.plugin.getActiveReviewView() ??
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;

    const parentFile = view.file;
    if (!parentFile) return null;

    const snippet = await this.plugin.reviewManager.createSnippet(
      editor,
      view,
      firstReview
    );

    if (snippet !== null) {
      this._pushUndo({
        item: snippet,
        description: `creating snippet "${snippet.file.basename}"`,
        undo: async () => {
          const success = await this.plugin.reviewManager.snippets.delete(
            snippet.data.id
          );
          if (!success) return;

          this.plugin.reviewManager.snippets.offsetTracker.removeHighlight(
            parentFile.path,
            snippet.data.id
          );

          // trigger a re-paint so the highlight disappears
          this.plugin.app.workspace.trigger(
            'ir-highlights-changed',
            parentFile.path
          );
        },
      });
    }
    return snippet;
  };

  createCard = async () => {
    const editor = this.plugin.app.workspace.activeEditor?.editor;
    if (!editor) return null;
    const view =
      this.plugin.getActiveReviewView() ??
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;

    const sourceFile = view.file;
    if (!sourceFile) return null;

    const result = await this.plugin.reviewManager.createCard(editor, view);

    if (result) {
      const { reviewCard, line } = result;

      this._pushUndo({
        item: result.reviewCard,
        description: `creating card "${result.reviewCard.file.basename}"`,
        undo: async () => {
          // restore the original text
          await this.plugin.app.vault.read(sourceFile);
          await Obsidian.editNote(this.plugin.app, sourceFile, (data) => {
            const cardEmbed = Obsidian.findEmbeds(
              this.plugin.app,
              sourceFile,
              reviewCard.file
            );

            if (!cardEmbed) return data;

            const startOffset = cardEmbed.position.start.offset;
            const endOffset = cardEmbed.position.end.offset;

            const prefix = data.slice(0, startOffset);
            data.slice(startOffset, endOffset);
            const suffix = data.slice(endOffset);
            return prefix + line + suffix;
          });

          // remove the card file and row
          await this.plugin.reviewManager.cards.delete(reviewCard.data.id);

          const { parent } = reviewCard.data;
          if (parent) {
            const key = ['item', parent, 'file-text'];
            queryClient.getQueryCache().find({ queryKey: key });

            await invalidateItemQuery(parent);

            queryClient.getQueryCache().find({ queryKey: key });
          }
        },
      });
    }

    return result;
  };

  setCardsOnly = async (cardsOnly: boolean) => {
    await this._setReviewTypes(cardsOnly ? ['card'] : NOTE_TYPES);
  };

  /**
   * Flip one item type in or out of review, leaving the others as they are.
   * Turning the last one off is allowed: review then has nothing to draw from
   * and shows the summary, which the filter stays visible above.
   */
  toggleReviewType = async (type: NoteType) => {
    const { typesToReview } = store.getState();
    // Rebuilt from NOTE_TYPES rather than from the current keys, so the set
    // keeps its canonical order however it was last written.
    await this._setReviewTypes(
      NOTE_TYPES.filter((t) =>
        t === type ? !typesToReview[t] : typesToReview[t]
      )
    );
  };

  /**
   * Open the location of a snippet's highlight or a card's embed in its parent.
   * If the highlight or embed doesn't exist, fall back to opening the parent.
   * If there's no parent and the source is a local link, open the source.
   *
   * An article opens its source, if that is a file in the vault.
   *
   * Takes the item's note rather than a view, since it is reached from
   * anywhere a file menu opens — the file explorer included, where no view
   * shows the note at all. Always opens in a new tab, so wherever it was
   * reached from stays as it was.
   */
  goToContext = async (file: TFile) => {
    const itemTitle = getContentSlice(
      file.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );
    // Read fresh rather than from the query cache: highlight offsets move as
    // the parent is edited, and the cached row may predate those edits.
    const item = await this.plugin.reviewManager.getReviewItemFromFile(file);
    if (!item) {
      Obsidian.notify(`"${itemTitle}" is not an incremental reading item`);
      return;
    }

    if (isReviewArticle(item)) {
      const source = findArticleSource(this.plugin.app, item);
      if (source.file === null) {
        Obsidian.notify(
          source.reason === 'none'
            ? `"${itemTitle}" has no source`
            : `The source of "${itemTitle}" is outside the vault`
        );
        return;
      }
      await this._openInNewTab(source.file, null);
      return;
    }

    const context = await resolveItemContext(
      this.plugin.app,
      this.plugin.reviewManager,
      item
    );
    if (!context) {
      Obsidian.notify(`"${itemTitle}" has no parent or local source to open`);
      return;
    }
    await this._openInNewTab(context.file, context.eState);
  };

  undo = async () => {
    const actionEntry = this.undoStack.pop();
    if (actionEntry === undefined) {
      Obsidian.notify(`Nothing to undo!`);
      return;
    }
    // Emitted before the reversal runs, not after: the entry is already off the
    // stack, and an undo that throws partway would otherwise leave subscribers
    // reading an entry that is no longer there.
    this.emitter.emit();
    await actionEntry.undo();
    Obsidian.notify(`Undid ${actionEntry.description}`);
  };

  // #region HELPERS
  /** Call this after reviewing, skipping, dismissing, or deleting an open item */
  _getNext = () => {
    // The one place that knows an item was *finished* rather than merely taken
    // off screen. `SessionTracker` cannot read that off the store — see its
    // `finish` — so it is told here, on the path every finishing action ends on.
    this.plugin.sessionTracker?.finish();
    const { currentItemId } = store.getState();
    this.plugin.store.dispatch(resetCurrentItem());

    // The reset is what normally refetches: it changes the id `useCurrentItem`
    // keys on, and the hook asks the queue for the next item off that. Called
    // with review already holding no item — the completion screen above all —
    // it changes nothing, so nothing refetches and the advance landed only when
    // the `CURRENT_ITEM_REFETCH_TIME` poll next came around. Ask directly.
    if (currentItemId === null) void invalidateCurrentItemQuery();
  };

  /**
   * Put review back on `item`: its turn is being given back, not finished.
   *
   * Undoing an action ends here rather than on {@link _getNext}, which asks the
   * queue for whatever is due next instead. That lands on the item only by
   * coincidence — the reversal makes it eligible again, and usually first — and
   * only from another item, where the advance is a store transition at all. On
   * the completion screen the store already holds no item, so the same dispatch
   * changes nothing and nothing refetches: the summary sat there until
   * `CURRENT_ITEM_REFETCH_TIME` came around and the poll happened to pick the
   * item back up.
   *
   * The reset goes first, so arriving drops the per-item state the way arriving
   * from the queue does — an undone grade puts the card back with its answer
   * hidden. The session tracker is told nothing: it mirrors the item arrived
   * at, and that lifts any hold over the one left.
   */
  _returnToItem = (item: ReviewItem) => {
    this.plugin.store.dispatch(resetCurrentItem());
    this.plugin.store.dispatch(setCurrentItemId(item.data.id));
  };

  /**
   * Count a finished review toward the session summary.
   *
   * Call before {@link _getNext}: advancing past the last item due is what puts
   * the summary on screen, and it must not render without the review that
   * emptied the queue.
   */
  _recordReview = (reviewId: string, type: NoteType) => {
    const resetTime = getEndOfDay(this.plugin.settings.dayRolloverOffset);
    this.plugin.store.dispatch(
      addCompletedReview({ reviewId, type, resetTime })
    );
  };

  /** Take back a review counted by {@link _recordReview}, once it is undone. */
  _unrecordReview = (reviewId: string) => {
    this.plugin.store.dispatch(removeCompletedReview({ reviewId }));
  };

  /**
   * Narrow or widen what review draws from, and move off the current item when
   * the change excludes its type — otherwise the filter would leave an item on
   * screen that it says is no longer being reviewed.
   *
   * The item is read *before* the dispatch: afterwards the current-item query
   * is already keyed on the new filter, and fetching through it would advance
   * the queue as a side effect of asking what is on screen.
   */
  private _setReviewTypes = async (types: readonly NoteType[]) => {
    const currentItem = await fetchCurrentItem(this.plugin.reviewManager);
    this.plugin.store.dispatch(setTypesToReview(types));

    if (currentItem === null) {
      await invalidateCurrentItemQuery();
    } else if (!types.includes(currentItem.data.type)) {
      this._getNext();
    }
  };

  /**
   * Open a vault file the way following a link to it would, in a new tab: in
   * whichever view is registered for its extension — markdown, PDF, or one a
   * core or community plugin adds.
   *
   * A file no view is registered for goes straight to the system's default
   * app. `WorkspaceLeaf.openFile` would do the same, but only after the new
   * tab exists, leaving it behind empty.
   */
  _openInNewTab = async (file: TFile, eState: MatchEphemeralState | null) => {
    const { app } = this.plugin;
    if (!app.viewRegistry.isExtensionRegistered(file.extension)) {
      app.openWithDefaultApp(file.path);
      return;
    }
    await app.workspace.getLeaf('tab').openFile(file, {
      active: true,
      ...(eState && { eState }),
    });
  };

  _createEmitter() {
    const listeners = new Set<() => void>();
    return {
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
      emit() {
        listeners.forEach((fn) => fn());
      },
    };
  }

  /**
   * Record an undoable action. Every push goes through here: the stack is a
   * plain array subscribers cannot watch, so a push that skips the emit leaves
   * the undo button showing the action before it.
   */
  _pushUndo = (entry: ActionStackEntry) => {
    this.undoStack.push(entry);
    this.emitter.emit();
  };
  // #endregion
}
