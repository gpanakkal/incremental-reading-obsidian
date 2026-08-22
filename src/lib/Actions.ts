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
import { ObsidianHelpers } from './ObsidianHelpers';
import {
  fetchCurrentItem,
  invalidateCurrentItemQuery,
  invalidateItemQuery,
  queryClient,
} from './query-client';
import {
  addSeenId,
  removeSeenId,
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
      const beforeReview = { ...snippet.data };
      const reviewId = await this.plugin.reviewManager.reviewSnippet(
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
      this.pushUndo({
        item: snippet,
        description: `reviewing "${snippet.file.basename}"`,
        undo: async () => {
          await this.plugin.reviewManager.snippets.undoReview(
            beforeReview,
            reviewId
          );
          await invalidateItemQuery(snippet.data.id);
          this.getNext();
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
    const reviewRowId = await this.plugin.reviewManager.reviewCard(
      card.data,
      grade
    );
    const wasDismissed = card.data.dismissed;
    if (wasDismissed) {
      await this.unDismissItem(card);
    }

    this.pushUndo({
      item: card,
      description: `grading "${card.file.basename}" ${Rating[grade]}`,
      undo: async () => {
        await this.plugin.reviewManager.cards.rollbackBeforeReview(
          card.data,
          reviewRowId
        );
        if (wasDismissed) {
          await this.dismissItem(card);
        }

        await invalidateItemQuery(card.data.id);
        this.getNext();
      },
    });

    new Notice(`Graded as: ${Rating[grade]}`);
    this.getNext();
  };

  dismissItem = async (item: ReviewItem) => {
    await this.plugin.reviewManager.dismissItem(item);
    await invalidateItemQuery(item.data.id);

    this.pushUndo({
      item,
      description: `dismissing "${item.file.basename}"`,
      undo: async () => {
        await this.plugin.reviewManager.unDismissItem(item);
        await invalidateItemQuery(item.data.id);
        this.getNext();
      },
    });

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

    this.pushUndo({
      item,
      description: `skipping "${item.file.basename}"`,
      undo: () => {
        this.plugin.store.dispatch(removeSeenId({ id: item.data.id }));
        this.getNext();
      },
    });
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

    const parentFile = view.file;
    if (!parentFile) return null;

    const snippet = await this.plugin.reviewManager.createSnippet(
      editor,
      view,
      firstReview
    );

    if (snippet !== null) {
      this.pushUndo({
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

      this.pushUndo({
        item: result.reviewCard,
        description: `creating card "${result.reviewCard.file.basename}"`,
        undo: async () => {
          // restore the original text
          const before = await this.plugin.app.vault.read(sourceFile);
          const after = await ObsidianHelpers.editNote(
            this.plugin.app,
            sourceFile,
            (data) => {
              const cardEmbed = ObsidianHelpers.findEmbeds(
                this.plugin.app,
                sourceFile,
                reviewCard.file
              );

              if (!cardEmbed) return data;

              const startOffset = cardEmbed.position.start.offset;
              const endOffset = cardEmbed.position.end.offset;

              const prefix = data.slice(0, startOffset);
              const replacement = data.slice(startOffset, endOffset);
              console.log({ replacement, line });
              const suffix = data.slice(endOffset);
              return prefix + line + suffix;
            }
          );

          console.log(
            '[undo] write changed:',
            before !== after,
            before.length,
            '→',
            after.length
          );

          // remove the card file and row
          const success = await this.plugin.reviewManager.cards.delete(
            reviewCard.data.id
          );

          const { parent } = reviewCard.data;
          console.log(
            '[undo] parent id:',
            parent,
            'current:',
            store.getState().currentItemId
          );
          if (parent) {
            const key = ['item', parent, 'file-text'];
            const q0 = queryClient.getQueryCache().find({ queryKey: key });
            console.log(
              '[undo] before:',
              !!q0,
              '| len:',
              (q0?.state.data as string)?.length,
              '| updatedAt:',
              q0?.state.dataUpdatedAt,
              '| observers:',
              q0?.observers.length
            );

            await invalidateItemQuery(parent);

            const q1 = queryClient.getQueryCache().find({ queryKey: key });
            console.log(
              '[undo] after:',
              '| len:',
              (q1?.state.data as string)?.length,
              '| updatedAt:',
              q1?.state.dataUpdatedAt,
              '| stale:',
              q1?.isStale()
            );
          }
        },
      });
    }

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
    if (actionEntry === undefined) {
      new Notice(`Nothing to undo!`, SUCCESS_NOTICE_DURATION_MS);
      return;
    }
    // Emitted before the reversal runs, not after: the entry is already off the
    // stack, and an undo that throws partway would otherwise leave subscribers
    // reading an entry that is no longer there.
    this.emitter.emit();
    await actionEntry.undo();
    new Notice(`Undid ${actionEntry.description}`, SUCCESS_NOTICE_DURATION_MS);
  };
}
