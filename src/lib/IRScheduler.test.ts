import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAXIMUM_PRIORITY, MINIMUM_PRIORITY } from './constants';
import IRScheduler from './IRScheduler';
import { clamp } from './utils';

describe('transformPriority', () => {
  it(
    `converts inputs into integers between ${MINIMUM_PRIORITY} and ` +
      `${MAXIMUM_PRIORITY}, inclusive`,
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer(),
            fc.float({ noNaN: true }),
            fc.stringMatching(/^[0-9]+(\.[0-9]*)?$/)
          ),
          (displayValue) => {
            const clampedDisplayValue = clamp(
              Number(displayValue),
              MINIMUM_PRIORITY / 10,
              MAXIMUM_PRIORITY / 10
            );
            const result = IRScheduler.transformPriority(displayValue);
            expect(result).toBeGreaterThanOrEqual(MINIMUM_PRIORITY);
            expect(result).toBeLessThanOrEqual(MAXIMUM_PRIORITY);
            expect(result % 1).toEqual(0);
            expect(result).toEqual(Math.round(clampedDisplayValue * 10));
          }
        ),
        { numRuns: 1_000 }
      );
    }
  );
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
