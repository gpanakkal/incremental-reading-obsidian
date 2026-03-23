import type IncrementalReadingPlugin from '#/main';
import type { Grade } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import {
  MS_PER_DAY,
  SUCCESS_NOTICE_DURATION_MS,
  ERROR_NOTICE_DURATION_MS,
  CONTENT_TITLE_SLICE_LENGTH,
} from './constants';
import { updateQueryCache } from './query-client';
import { resetCurrentItem, store, addSeenId } from './store';
import {
  type ReviewArticle,
  type ReviewSnippet,
  type ReviewCard,
  type ReviewItem,
  isReviewArticle,
} from './types';
import { transformPriority, getContentSlice } from './utils';

/**
 * Coordinates review operations with store and query cache updates
 */
export class Actions {
  plugin: IncrementalReadingPlugin;

  constructor(plugin: IncrementalReadingPlugin) {
    this.plugin = plugin;
  }

  /** Call this after reviewing, skipping, or dismissing an item */
  getNext = () => {
    this.plugin.store.dispatch(resetCurrentItem());
  };

  review = async (
    item: ReviewArticle | ReviewSnippet,
    nextInterval?: number
  ) => {
    if (isReviewArticle(item)) return this.reviewArticle(item, nextInterval);
    return this.reviewSnippet(item, nextInterval);
  };

  reviewArticle = async (article: ReviewArticle, nextInterval?: number) => {
    try {
      await this.plugin.reviewManager.reviewArticle(
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
  reprioritize = async (
    item: ReviewArticle | ReviewSnippet,
    newPriority: number
  ) => {
    const priority = transformPriority(newPriority);
    try {
      await this.plugin.reviewManager.reprioritize(item.data, priority);
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
    updateQueryCache(item.data.id, { dismissed: true });

    const [_folder, subRef] = item.data.reference.split('/');
    new Notice(
      `Dismissed "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}"`
    );
    this.getNext();
  };

  unDismissItem = async (item: ReviewItem) => {
    await this.plugin.reviewManager.unDismissItem(item);
    updateQueryCache(item.data.id, { dismissed: false });
    const { currentItemId } = store.getState();
    if (currentItemId === null) {
      // TODO: set the now-undismissed item as the current one?
      this.getNext();
    }

    const [_folder, subRef] = item.data.reference.split('/');
    new Notice(
      `Restored "${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH, true)}" to queue`
    );
  };

  skipItem = (item: ReviewItem) => {
    this.plugin.store.dispatch(addSeenId(item.data.id));

    const { reference } = item.data;
    const [folder, subRef] = reference.split('/');
    new Notice(
      `Skipping ${folder}/${getContentSlice(subRef, CONTENT_TITLE_SLICE_LENGTH + 5, true)} until next session`
    );
    this.getNext();
  };
}
