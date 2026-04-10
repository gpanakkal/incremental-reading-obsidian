import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  TEXT_BASE_REVIEW_INTERVAL,
  TEXT_MINIMUM_REVIEW_INTERVAL,
  TEXT_REVIEW_MULTIPLIER_BASE,
  TEXT_REVIEW_MULTIPLIER_STEP,
} from './constants';
import type { IArticleBase, ISnippetBase } from './types';
import {
  binarySearch,
  clamp,
  intSequence,
  isInteger,
  sequenceSum,
} from './utils';

/**
 * Logic for scheduling future reviews of non-SRS items
 */
export default class IRScheduler {
  /**
   * Calculates the priority required for the next `targetReviewCount` reviews of the child to
   * occur before the next `targetReviewCount` reviews of the parent.
   *
   * TODO:
   * - decide if nth child review should occur on same day or day before nth parent review
   * @param targetReviewCount the number of future reviews of the child meant
   * to occur before the same number of reviews in the parent
   * @param childDue Child's next review date as a Unix timestamp
   * @returns the calculated priority and how far ahead the child's nth review
   * falls of the desired target
   * @throws if either `parent.due` or `parent.fixed_interval_days` are null
   */
  static childPriorityFromFixedInterval(
    parent: IArticleBase,
    targetReviewCount: number,
    childDue: number
  ): number {
    this.validateReviewCount(targetReviewCount);

    const { fixed_interval_days, due } = parent;
    if (fixed_interval_days === null) {
      throw new Error(`Parent "${parent.reference}" has no fixed interval`);
    }

    if (due === null) {
      throw new TypeError(`Parent "${parent.reference}" has no due date`);
    }

    const totalIntervalMs =
      fixed_interval_days * (targetReviewCount - 1) * MS_PER_DAY;
    const parentNthDueTimeMs = due + totalIntervalMs;

    const upperBound = 0;

    const getPrioDiff = (priority: number) => {
      // return 0 if it yields a negative diff and the next-highest priority returns a positive one
      const forecastedDueTimeMs =
        childDue +
        this.cumulativeInterval(
          priority,
          TEXT_BASE_REVIEW_INTERVAL,
          targetReviewCount
        );
      const diffMs = forecastedDueTimeMs - parentNthDueTimeMs;
      return diffMs;
    };

    const prioComparator = (priority: number): number => {
      const currentDiff = getPrioDiff(priority);
      if (currentDiff > upperBound) {
        // look for a lower priority unless we're at the minimum
        if (priority === MINIMUM_PRIORITY) {
          return 0;
        } else return -1;
      }

      if (priority === MAXIMUM_PRIORITY) {
        return 0;
      }
      const nextDiff = getPrioDiff(priority + 1);

      // current diff is in the desired range; check the next priority, if any
      if (nextDiff < upperBound && nextDiff > currentDiff) {
        // the next priority is a better fit, so search to the right
        return 1;
      }

      return 0;
    };

    // use binary search to find the priority that best aligns with the target
    const result = binarySearch(
      intSequence(MINIMUM_PRIORITY, MAXIMUM_PRIORITY),
      (priority: number) => prioComparator(priority)
    );

    if (result === null) {
      throw new Error(
        `Priority search returned null. This shouldn't happen.\n` +
          JSON.stringify({ parent, targetReviewCount, childDue })
      );
    }

    return result.match;
  }

  /**
   * Calculates the interval between the next two reviews using the current
   * due time and the last review time
   *
   */
  static nextInterval(text: IArticleBase | ISnippetBase): number {
    if ('fixed_interval_days' in text && text.fixed_interval_days !== null) {
      return text.fixed_interval_days * MS_PER_DAY;
    }

    const intervalMultiplier = this.getIntervalMultiplier(text.priority);
    const lastInterval = Math.max(text.interval, TEXT_MINIMUM_REVIEW_INTERVAL);
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

  /**
   * Get the due time for the nth review from now as a Unix timestamp, assuming
   *  all reviews happen on time and the priority is never changed
   *
   * @param futureReviewCount the number of reviews into the future to project
   * TODO:
   * - fuzz review times for more realistic forecasts
   */
  static forecastReviewTime(
    text: IArticleBase | ISnippetBase,
    futureReviewCount: number
  ) {
    this.validateReviewCount(futureReviewCount);
    if (!text.due)
      throw new Error(
        `Passed text (${text.reference}) is not scheduled for review`
      );

    if (futureReviewCount === 1) return text.due;
    if ('fixed_interval_days' in text && text.fixed_interval_days !== null) {
      return (
        text.due +
        (futureReviewCount - 1) * text.fixed_interval_days * MS_PER_DAY
      );
    }

    const totalIntervalMs = this.cumulativeInterval(
      text.priority,
      text.interval ?? TEXT_BASE_REVIEW_INTERVAL,
      futureReviewCount
    );

    const forecastedReviewTime = text.due + totalIntervalMs;
    return forecastedReviewTime;
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

  /** Use this to transform priorities in the priority field's onChange callback */
  static adjustDisplayPriorityOnChange(displayPriority: string) {
    // remove invalid characters
    const filtered = displayPriority.replaceAll(/(?![\d.])/g, '');
    // add a leading zero if needed
    const implicitZeroImputed = filtered.startsWith('.')
      ? '0' + filtered
      : filtered;

    if (Number.isNaN(Number.parseFloat(implicitZeroImputed))) {
      throw new TypeError(`Received invalid priority "${displayPriority}"`);
    }

    // ensure the decimal point is after the first digit
    let scaled = implicitZeroImputed.slice(0, 3);
    if (/^\d{2,}/.test(scaled)) {
      scaled = scaled[0] + '.' + scaled[1];
    }

    const clamped = Math.min(
      MAXIMUM_PRIORITY / 10,
      Math.max(MINIMUM_PRIORITY / 10, Number.parseFloat(scaled))
    );

    return clamped;
  }

  static isValidFixedInterval(interval: number) {
    return (
      interval % 1 === 0 &&
      interval >= MINIMUM_FIXED_REVIEW_INTERVAL &&
      interval <= MAXIMUM_FIXED_REVIEW_INTERVAL
    );
  }

  /**
   * @throws if passed an invalid fixed interval
   */
  static validateFixedInterval(interval: number) {
    if (!this.isValidFixedInterval(interval)) {
      throw new TypeError(
        `Fixed interval must be an integer from ${MINIMUM_FIXED_REVIEW_INTERVAL}` +
          ` to ${MAXIMUM_FIXED_REVIEW_INTERVAL}; received "${interval}"`
      );
    }
  }
}
