import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_TESTED_REVIEW_COUNT,
  MAX_VALID_TIMESTAMP_DATE,
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  MS_PER_YEAR,
  TEXT_BASE_REVIEW_INTERVAL,
} from './constants';
import IRScheduler from './IRScheduler';
import type { IArticleBase, ISnippetBase } from './types';
import { clamp, intSequence } from './utils';

const validDisplayPriorityPattern = /^\d(\.\d)?$/;

describe('transformPriority', () => {
  it(`converts inputs into valid internal priorities`, () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.float({ noNaN: true }),
          fc.stringMatching(validDisplayPriorityPattern)
        ),
        (displayValue) => {
          const clampedDisplayValue = clamp(
            Number(displayValue),
            MINIMUM_PRIORITY / 10,
            MAXIMUM_PRIORITY / 10
          );
          const result = IRScheduler.transformPriority(displayValue);
          expect(result).toSatisfy((v: number) =>
            IRScheduler.isValidPriority(v)
          );
          expect(result).toEqual(Math.round(clampedDisplayValue * 10));
        }
      ),
      { numRuns: 1_000 }
    );
  });
});

describe('toDisplayPriority', () => {
  it(`converts valid priorities into decimal values with one decimal place`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (priority) => {
          const result = IRScheduler.toDisplayPriority(priority);
          expect(result).toMatch(/^\d\.\d$/);
        }
      )
    );
  });
  it(`throws given invalid priorities`, () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: MINIMUM_PRIORITY - 1 }),
          fc.integer({ min: MAXIMUM_PRIORITY + 1 }),
          fc.float({ noInteger: true })
        ),
        (priority) => {
          expect(() => IRScheduler.toDisplayPriority(priority)).toThrow();
        }
      )
    );
  });
});

describe('adjustDisplayPriorityOnChange', () => {
  const displayPriorityPattern = /^\d+(\.\d*)?$|^\.\d*$/;
  it(`converts valid inputs into decimal values with one decimal place`, () => {
    fc.assert(
      fc.property(fc.stringMatching(displayPriorityPattern), (priority) => {
        const result = IRScheduler.adjustDisplayPriorityOnChange(priority);
        expect(result.toString()).toMatch(validDisplayPriorityPattern);
        expect(IRScheduler.transformPriority(result));
      })
    );
  });
  it(`throws given invalid priorities`, () => {
    fc.assert(
      fc.property(fc.string(), (priority) => {
        try {
          const adjusted = IRScheduler.adjustDisplayPriorityOnChange(priority);
          // verify that `adjusted` is just internal priority / 10
          expect(IRScheduler.transformPriority(adjusted)).toBe(
            Math.round(adjusted * 10)
          );
        } catch (_e) {
          // verify that the throw was caused by adjustDisplayPriorityOnChange
          expect(() =>
            IRScheduler.adjustDisplayPriorityOnChange(priority)
          ).toThrow();
        }
      })
    );
  });
});

describe('nextInterval', () => {
  it('never produces decreasing intervals', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: 0,
          max: MS_PER_YEAR * 10,
        }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (interval, priority) => {
          const fakeArticle = {
            interval,
            fixed_interval_days: null,
            priority,
          } as IArticleBase;
          const newInterval = IRScheduler.nextInterval(fakeArticle);
          expect(newInterval).toBeGreaterThan(0);
          expect(newInterval).toBeGreaterThan(interval);
        }
      )
    );
  });
  it('uses fixed intervals if provided', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (fixedIntervalDays, priority) => {
          const fakeArticle = {
            interval: TEXT_BASE_REVIEW_INTERVAL,
            fixed_interval_days: fixedIntervalDays,
            priority,
          } as IArticleBase;
          const newInterval = IRScheduler.nextInterval(fakeArticle);
          expect(newInterval).toEqual(fixedIntervalDays * MS_PER_DAY);
        }
      )
    );
  });
});

describe('forecastReviewTime', () => {
  it('returns the next due date if n equals 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -MS_PER_YEAR, max: MS_PER_YEAR }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (dueOffset, priority) => {
          const now = Date.now();
          const due = now + dueOffset;
          const forecast = IRScheduler.forecastReviewTime(
            {
              due,
              priority,
              fixed_interval_days: null,
              reference: 'fake-article',
            } as unknown as IArticleBase,
            1
          );
          expect(forecast).toBe(due);
        }
      )
    );
  });

  it(`uses the fixed interval if it's not null`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -MS_PER_YEAR, max: MS_PER_YEAR }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 2, max: MAX_TESTED_REVIEW_COUNT }),
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        (dueOffset, priority, n, fixed_interval_days) => {
          const now = Date.now();
          const due = now + dueOffset;
          const forecast = IRScheduler.forecastReviewTime(
            {
              due,
              priority,
              fixed_interval_days,
              reference: 'fake-article',
            } as unknown as IArticleBase,
            n
          );
          expect(forecast).toBe(
            due + fixed_interval_days * (n - 1) * MS_PER_DAY
          );
          expect(new Date(forecast).toDateString()).not.toBe('Invalid Date');
        }
      )
    );
  });

  it('returns a time after the next due date for n > 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -MS_PER_YEAR, max: MS_PER_YEAR }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 2, max: MAX_TESTED_REVIEW_COUNT }),
        (dueOffset, priority, n) => {
          const now = Date.now();
          const due = now + dueOffset;
          const forecast = IRScheduler.forecastReviewTime(
            {
              due,
              priority,
              fixed_interval_days: null,
              reference: 'fake-article',
            } as unknown as IArticleBase,
            n
          );
          expect(forecast).toBeGreaterThan(due);
          if (forecast <= MAX_VALID_TIMESTAMP_DATE) {
            expect(new Date(forecast).toDateString()).not.toBe('Invalid Date');
          }
        }
      )
    );
  });
});

describe('childPriorityFromFixedInterval', () => {
  const now = Date.now();

  /** Iteratively finds the best priority. Slower than the production method */
  const getPriority = (
    parent: IArticleBase,
    targetReviewCount: number,
    childDueTime: number
  ) => {
    if (parent.due === null) throw new Error(`Parent must have a due time`);

    const child = {
      due: childDueTime,
      reference: '',
    } as ISnippetBase;

    const reversePriorities = intSequence(MAXIMUM_PRIORITY, MINIMUM_PRIORITY);

    const parentReviewTime = IRScheduler.forecastReviewTime(
      parent,
      targetReviewCount
    );

    const iterativeMatch = reversePriorities.find((priority) => {
      const childReviewTime = IRScheduler.forecastReviewTime(
        {
          ...child,
          priority,
        },
        targetReviewCount
      );
      return childReviewTime - parentReviewTime < 0;
    });
    return iterativeMatch ?? MINIMUM_PRIORITY;
  };

  it('gets the priority that best fits without overshooting', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 365 }),
        fc.integer({ min: now - MS_PER_YEAR, max: now + MS_PER_YEAR }),
        fc.integer({ min: 2, max: MAX_TESTED_REVIEW_COUNT }),
        (fixed_interval_days, due, targetReviewCount) => {
          const fakeParentItem = {
            fixed_interval_days,
            due,
          } as unknown as IArticleBase;

          const childDueTime = now + MS_PER_DAY;
          const priority = IRScheduler.childPriorityFromFixedInterval(
            fakeParentItem,
            targetReviewCount,
            childDueTime
          );

          expect(IRScheduler.isValidPriority(priority)).toBe(true);

          const iterativelyFoundPriority = getPriority(
            fakeParentItem,
            targetReviewCount,
            childDueTime
          );
          expect(priority).toEqual(iterativelyFoundPriority);
        }
      ),
      { numRuns: 1_000 }
    );
  });
});
