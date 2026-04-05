import {
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  TEXT_BASE_REVIEW_INTERVAL,
  TEXT_REVIEW_MULTIPLIER_BASE,
  TEXT_REVIEW_MULTIPLIER_STEP,
} from './constants';
import type { IArticleBase, ISnippetBase } from './types';
import { clamp, isInteger, sequenceSum } from './utils';

/**
 * Logic for scheduling future reviews of non-SRS items
 */
export default class IRScheduler {
  /**
   * Calculates the interval between the next two reviews using the current
   * due time and the last review time
   *
   * TODO:
   * - ensure this is not used when calculating the first due time
   */
  static nextInterval(text: IArticleBase | ISnippetBase): number {
    const intervalMultiplier = this.getIntervalMultiplier(text.priority);
    const lastInterval = text.interval ?? TEXT_BASE_REVIEW_INTERVAL;
    const nextInterval = Math.round(lastInterval * intervalMultiplier);
    return nextInterval;
  }

  static getIntervalMultiplier(priority: number): number {
    return (
      TEXT_REVIEW_MULTIPLIER_BASE +
      (priority - 10) * TEXT_REVIEW_MULTIPLIER_STEP
    );
  }

  /**
   * Get the time until the nth review from now as a Unix timestamp, assuming
   * all reviews happen on time and the priority is never changed
   *
   * @param futureReviewCount the number of reviews into the future to project
   */
  static cumulativeInterval(
    priority: number,
    currentInterval: number,
    futureReviewCount: number
  ) {
    this.validateReviewCount(futureReviewCount);

    const totalIntervalMs = Math.round(
      currentInterval *
        sequenceSum(
          0,
          futureReviewCount - 1,
          (k) => this.getIntervalMultiplier(priority) ** k
        )
    );

    return totalIntervalMs;
  }

  static validateReviewCount(count: number) {
    if (!isInteger(count) || count < 1) {
      throw new TypeError(
        `Expected a positive integer review count; received ${count}`
      );
    }
  }

  static isValidPriority(priority: number) {
    return (
      priority % 1 === 0 &&
      priority >= MINIMUM_PRIORITY &&
      priority <= MAXIMUM_PRIORITY
    );
  }
  /**
   * @throws if passed an invalid priority
   */
  static validatePriority(priority: number) {
    if (!this.isValidPriority(priority))
      throw new TypeError(
        `Priority must be an integer between ${MINIMUM_PRIORITY} and ` +
          `${MAXIMUM_PRIORITY} inclusive; received "${priority}"`
      );
  }

  /** Clamp a possibly invalid display value and convert to integer priority */
  static transformPriority(displayPriority: string | number) {
    const priorityNum = Number(displayPriority);
    if (Number.isNaN(priorityNum)) {
      throw new TypeError(`Priority cannot be NaN`);
    }

    const clampedDisplayValue = clamp(
      priorityNum,
      MINIMUM_PRIORITY / 10,
      MAXIMUM_PRIORITY / 10
    );

    return Math.round(clampedDisplayValue * 10);
  }

  static toDisplayPriority(priority: number): string {
    this.validatePriority(priority);
    let displayPriority = (priority / 10).toString().slice(0, 3);
    if (displayPriority.length === 1) displayPriority += `.0`;
    return displayPriority;
  }
}
