import type IncrementalReadingPlugin from '#/main';
import { MarkdownView } from 'obsidian';
import type { Grade } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import {
  CONTENT_TITLE_SLICE_LENGTH,
  ERROR_NOTICE_DURATION_MS,
  MS_PER_DAY,
  SUCCESS_NOTICE_DURATION_MS,
} from './constants';
import IRScheduler from './IRScheduler';
import {
  fetchCurrentItem,
  invalidateCurrentItemQuery,
  invalidateItemQuery,
} from './query-client';
import {
  addSeenId,
  resetCurrentItem,
  resetTypesToReview,
  setTypesToReview,
  store,
} from './store';
import type { ReviewText } from './types';
import {
  type ReviewArticle,
  type ReviewCard,
  type ReviewItem,
  type ReviewSnippet,
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
    this.emitter = this.createEmitter();
    this.subscribe = this.emitter.subscribe;
  }

  /** Call this after reviewing, skipping, dismissing, or deleting an open item */
  getNext = () => {
    this.plugin.store.dispatch(resetCurrentItem());
  };

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
      if (article.data.dismissed) {
        await this.unDismissItem(article);
      }
      if (nextInterval) {
        new Notice(
          `Next article review manually scheduled for ` +
            `${Math.round((10 * nextInterval) / MS_PER_DAY) / 10} days from now`,
          SUCCESS_NOTICE_DURATION_MS
        );
      }
      this.getNext();
      this.pushUndo({
        item: article,
        description: `reviewing "${article.file.basename}"`,
        undo: async () => {
          await this.plugin.reviewManager.articles.undoReview(
            beforeReview,
            reviewId
          );
          await invalidateItemQuery(article.data.id);
          this.getNext();
        },
      });
    } catch (error) {
      console.error(error);
    }
  };

  reviewSnippet = async (snippet: ReviewSnippet, nextInterval?: number) => {
    try {
      await this.plugin.reviewManager.reviewSnippet(
        snippet.data,
        Date.now(),
        nextInterval
      );
      if (snippet.data.dismissed) {
        await this.unDismissItem(snippet);
      }
      if (nextInterval) {
        new Notice(
          `Next snippet review manually scheduled for ` +
            `${Math.round((10 * nextInterval) / MS_PER_DAY) / 10} days from now`,
          SUCCESS_NOTICE_DURATION_MS
        );
      }
      this.getNext();
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
      new Notice(
        `Priority set to ${priority / 10}`,
        SUCCESS_NOTICE_DURATION_MS
      );
    } catch (_error) {
      new Notice(
        `Failed to update priority for "${item.data.reference}"`,
        ERROR_NOTICE_DURATION_MS
      );
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
    await this.plugin.reviewManager.reviewCard(card.data, grade);
    new Notice(`Graded as: ${Rating[grade]}`);
    if (card.data.dismissed) {
      await this.unDismissItem(card);
    }
    this.getNext();
  };

  dismissItem = async (item: ReviewItem) => {
    await this.plugin.reviewManager.dismissItem(item);
    await invalidateItemQuery(item.data.id);

    new Notice(
      `Dismissed "${getContentSlice(item.file.basename, CONTENT_TITLE_SLICE_LENGTH, true)}"`
    );
    const { currentItemId } = store.getState();
    if (item.data.id === currentItemId) {
      this.getNext();
    }
  };

  unDismissItem = async (item: ReviewItem) => {
    await this.plugin.reviewManager.unDismissItem(item);
    await invalidateItemQuery(item.data.id);
    const { currentItemId } = store.getState();
    if (currentItemId === null) {
      // TODO: set the now-undismissed item as the current one?
      this.getNext();
    }

    new Notice(
      `Restored "${getContentSlice(item.file.basename, CONTENT_TITLE_SLICE_LENGTH, true)}" to queue`
    );
  };

  /**
   * Asks for confirmation if enabled in settings; moves file to trash
   */
  deleteItem = async (item: ReviewItem) => {
    await this.plugin.app.fileManager.promptForFileDeletion(item.file);
    const { currentItemId } = store.getState();
    if (item.data.id === currentItemId) {
      this.getNext();
    }
  };

  skipItem = (item: ReviewItem) => {
    const resetTime = getEndOfDay(this.plugin.settings.dayRolloverOffset);
    this.plugin.store.dispatch(addSeenId({ id: item.data.id, resetTime }));

    new Notice(
      `Skipping ${getContentSlice(item.file.basename, CONTENT_TITLE_SLICE_LENGTH + 5, true)} until next session`
    );
    this.getNext();
  };

  createSnippet = async (firstReview?: number) => {
    const editor = this.plugin.app.workspace.activeEditor?.editor;
    if (!editor) return null;
    const view =
      this.plugin.getActiveReviewView() ??
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    const result = await this.plugin.reviewManager.createSnippet(
      editor,
      view,
      firstReview
    );
    return result;
  };

  createCard = async () => {
    const editor = this.plugin.app.workspace.activeEditor?.editor;
    if (!editor) return null;
    const view =
      this.plugin.getActiveReviewView() ??
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    const result = await this.plugin.reviewManager.createCard(editor, view);
    return result;
  };

  setCardsOnly = async (cardsOnly: boolean) => {
    const currentItem = await fetchCurrentItem(this.plugin.reviewManager);
    if (cardsOnly) {
      this.plugin.store.dispatch(setTypesToReview(['card']));
    } else {
      this.plugin.store.dispatch(resetTypesToReview());
    }

    if (currentItem === null) {
      await invalidateCurrentItemQuery();
    } else if (cardsOnly && currentItem.data.type !== 'card') {
      this.getNext();
    }
  };

  createEmitter() {
    const listeners = new Set<() => void>();
    return {
      subscribe(fn: () => void) {
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
  pushUndo = (entry: ActionStackEntry) => {
    this.undoStack.push(entry);
    this.emitter.emit();
  };

  undo = async () => {
    const actionEntry = this.undoStack.pop();
    if (actionEntry === undefined) return;
    // Emitted before the reversal runs, not after: the entry is already off the
    // stack, and an undo that throws partway would otherwise leave subscribers
    // reading an entry that is no longer there.
    this.emitter.emit();
    await actionEntry.undo();
    new Notice(`Undid ${actionEntry.description}`, SUCCESS_NOTICE_DURATION_MS);
  };
}
