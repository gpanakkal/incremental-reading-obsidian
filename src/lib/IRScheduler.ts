import { MAXIMUM_PRIORITY, MINIMUM_PRIORITY } from './constants';
import { clamp, isInteger } from './utils';

/**
 * Logic for scheduling future reviews of non-SRS items
 */
export default class IRScheduler {
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
