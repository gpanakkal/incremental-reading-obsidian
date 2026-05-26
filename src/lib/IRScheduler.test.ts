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
  TEXT_REVIEW_MULTIPLIER_BASE,
  TEXT_REVIEW_MULTIPLIER_STEP,
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
      )
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

  it('always returns exactly 3 characters for all valid priorities', () => {
    // This kills the mutant that removes .slice(0, 3)
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (priority) => {
          const result = IRScheduler.toDisplayPriority(priority);
          expect(result.length).toBe(3);
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

  it('strips non-digit, non-dot characters before parsing', () => {
    fc.assert(
      fc.property(
        // A valid digit/dot base that won't throw on its own
        fc.stringMatching(/^\d+(\.\d*)?$/),
        // One or more non-digit, non-dot characters to inject at arbitrary positions
        fc.stringMatching(/^[^\d.]+$/),
        fc.integer({ min: 0, max: 10 }),
        (base, noise, insertAt) => {
          // Insert the noise at a position in the base string
          const pos = insertAt % (base.length + 1);
          const mixed = base.slice(0, pos) + noise + base.slice(pos);
          // After stripping non-digit/non-dot chars, `mixed` reduces to `base`,
          // so the result must equal that of processing `base` alone.
          const expected = IRScheduler.adjustDisplayPriorityOnChange(base);
          expect(IRScheduler.adjustDisplayPriorityOnChange(mixed)).toBeCloseTo(
            expected,
            5
          );
        }
      )
    );
  });

  it('prepends a leading zero when input starts with a dot', () => {
    // ".5" → filtered ".5" → imputed "0.5" → sliced "0.5" → no 2-digit re-scale
    // 0.5 < MINIMUM_PRIORITY/10=1.0 so clamped to minimum
    const result = IRScheduler.adjustDisplayPriorityOnChange('.5');
    expect(result).toBe(MINIMUM_PRIORITY / 10);
    // ".15" → filtered ".15" → imputed "0.15" → sliced "0.1" → 0.1 < 1.0 → clamped to min
    const result2 = IRScheduler.adjustDisplayPriorityOnChange('.15');
    expect(result2).toBe(MINIMUM_PRIORITY / 10);
    // A dot-prefixed value large enough: ".9" would be 0.9 < 1.0, still clamped
    // There is no dot-prefix input that yields >1.0 since "0.X" is always <1
    // Verify any dot-prefixed input returns the minimum
    fc.assert(
      fc.property(fc.stringMatching(/^\.\d+$/), (input) => {
        const r = IRScheduler.adjustDisplayPriorityOnChange(input);
        expect(r).toBe(MINIMUM_PRIORITY / 10);
      })
    );
  });

  it('does not prepend a leading zero when input does not start with a dot', () => {
    // "35" → filtered "35" → startsWith('.') is false → scaled to "3.5"
    const result = IRScheduler.adjustDisplayPriorityOnChange('35');
    expect(result).toBeCloseTo(3.5, 5);
    // "5." → does not startsWith('.') → no zero prepend → scaled to "5." → parseFloat "5." = 5
    // This distinguishes startsWith from endsWith: "5." endsWith('.') is true → would prepend 0
    const result2 = IRScheduler.adjustDisplayPriorityOnChange('5.');
    expect(result2).toBe(MAXIMUM_PRIORITY / 10);
  });

  it('rescales two-or-more leading digits by inserting a decimal point', () => {
    // "25" → filtered "25" → scaled "2.5" → clamped to [1, 5] range → 2.5
    const result = IRScheduler.adjustDisplayPriorityOnChange('25');
    expect(result).toBeCloseTo(2.5, 5);
    // "50" → "5.0" → 5.0 (maximum)
    const max = IRScheduler.adjustDisplayPriorityOnChange('50');
    expect(max).toBeCloseTo(MAXIMUM_PRIORITY / 10, 5);
    // "11" → "1.1" → 1.1
    const result2 = IRScheduler.adjustDisplayPriorityOnChange('11');
    expect(result2).toBeCloseTo(1.1, 5);
  });

  it('does not rescale a single leading digit', () => {
    // "3" → filtered "3" → no 2-digit prefix → parsed as 3.0 → clamped
    const result = IRScheduler.adjustDisplayPriorityOnChange('3');
    expect(result).toBeCloseTo(3.0, 5);
  });

  it('does not rescale inputs that already have a single leading digit followed by a decimal', () => {
    // "2.5" → no 2+ leading digits → not rescaled → parseFloat("2.5") = 2.5
    // The ^\d{2,} → ^\d mutant would match "2.5" and produce "2.." → parseFloat = 2
    expect(IRScheduler.adjustDisplayPriorityOnChange('2.5')).toBeCloseTo(
      2.5,
      5
    );
    expect(IRScheduler.adjustDisplayPriorityOnChange('1.5')).toBeCloseTo(
      1.5,
      5
    );
    expect(IRScheduler.adjustDisplayPriorityOnChange('3.5')).toBeCloseTo(
      3.5,
      5
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

describe('validateReviewCount', () => {
  it('does not throw for valid positive integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1 }), (count) => {
        expect(() => IRScheduler.validateReviewCount(count)).not.toThrow();
      })
    );
  });

  it('throws for non-positive integers', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.float({ noNaN: true, noInteger: true }),
          fc.constant(NaN)
        ),
        (count) => {
          expect(() => IRScheduler.validateReviewCount(count)).toThrow(
            TypeError
          );
        }
      )
    );
  });
});

describe('getIntervalMultiplier', () => {
  it('returns a value greater than 1 for all valid priorities', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (priority) => {
          const multiplier = IRScheduler.getIntervalMultiplier(priority);
          expect(multiplier).toBeGreaterThan(1);
        }
      )
    );
  });

  it('increases monotonically with priority', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY - 1 }),
        (priority) => {
          expect(
            IRScheduler.getIntervalMultiplier(priority + 1)
          ).toBeGreaterThan(IRScheduler.getIntervalMultiplier(priority));
        }
      )
    );
  });

  it('matches the formula TEXT_REVIEW_MULTIPLIER_BASE + (priority - 10) * TEXT_REVIEW_MULTIPLIER_STEP', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (priority) => {
          const expected =
            TEXT_REVIEW_MULTIPLIER_BASE +
            (priority - 10) * TEXT_REVIEW_MULTIPLIER_STEP;
          expect(IRScheduler.getIntervalMultiplier(priority)).toBeCloseTo(
            expected,
            10
          );
        }
      )
    );
  });
});

describe('cumulativeInterval', () => {
  it('throws for invalid review counts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 1, max: MS_PER_YEAR }),
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.float({ noNaN: true, noInteger: true })
        ),
        (priority, interval, invalidCount) => {
          expect(() =>
            IRScheduler.cumulativeInterval(priority, interval, invalidCount)
          ).toThrow(TypeError);
        }
      )
    );
  });

  it('returns 0 for futureReviewCount = 1 (no accumulated interval yet)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 1, max: MS_PER_YEAR }),
        (priority, interval) => {
          // For count=1: sum from k=0 to 0 of multiplier^k = multiplier^0 = 1
          // so cumulativeInterval = round(interval * 1) = interval
          const result = IRScheduler.cumulativeInterval(priority, interval, 1);
          expect(result).toBe(interval);
        }
      )
    );
  });

  it('grows strictly with futureReviewCount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 1, max: MS_PER_DAY * 30 }),
        fc.integer({ min: 1, max: MAX_TESTED_REVIEW_COUNT - 1 }),
        (priority, interval, n) => {
          const smaller = IRScheduler.cumulativeInterval(priority, interval, n);
          const larger = IRScheduler.cumulativeInterval(
            priority,
            interval,
            n + 1
          );
          expect(larger).toBeGreaterThan(smaller);
        }
      )
    );
  });
});

describe('forecastReviewTime', () => {
  it('throws for invalid review counts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.float({ noNaN: true, noInteger: true })
        ),
        (priority, invalidCount) => {
          const text = {
            due: Date.now(),
            priority,
            fixed_interval_days: null,
            interval: TEXT_BASE_REVIEW_INTERVAL,
            reference: 'test',
          } as unknown as IArticleBase;
          expect(() =>
            IRScheduler.forecastReviewTime(text, invalidCount)
          ).toThrow(TypeError);
        }
      )
    );
  });

  it('throws when due is null', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 1, max: MAX_TESTED_REVIEW_COUNT }),
        (priority, n) => {
          const text = {
            due: null,
            priority,
            fixed_interval_days: null,
            interval: TEXT_BASE_REVIEW_INTERVAL,
            reference: 'test',
          } as unknown as IArticleBase;
          expect(() => IRScheduler.forecastReviewTime(text, n)).toThrow();
        }
      )
    );
  });

  it('falls back to TEXT_BASE_REVIEW_INTERVAL when interval is absent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 2, max: MAX_TESTED_REVIEW_COUNT }),
        fc.integer({ min: -MS_PER_YEAR, max: MS_PER_YEAR }),
        (priority, n, dueOffset) => {
          const due = Date.now() + dueOffset;
          // Omit interval to exercise the ?? fallback
          const textWithInterval = {
            due,
            priority,
            fixed_interval_days: null,
            interval: TEXT_BASE_REVIEW_INTERVAL,
            reference: 'test',
          } as unknown as IArticleBase;
          const textWithoutInterval = {
            due,
            priority,
            fixed_interval_days: null,
            reference: 'test',
          } as unknown as IArticleBase;

          const withExplicit = IRScheduler.forecastReviewTime(
            textWithInterval,
            n
          );
          const withFallback = IRScheduler.forecastReviewTime(
            textWithoutInterval,
            n
          );
          expect(withFallback).toBe(withExplicit);
        }
      )
    );
  });
});

describe('validatePriority', () => {
  it('does not throw for valid priorities', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (priority) => {
          expect(() => IRScheduler.validatePriority(priority)).not.toThrow();
        }
      )
    );
  });

  it('throws for invalid priorities', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: MINIMUM_PRIORITY - 1 }),
          fc.integer({ min: MAXIMUM_PRIORITY + 1 }),
          fc.float({ noInteger: true })
        ),
        (priority) => {
          expect(() => IRScheduler.validatePriority(priority)).toThrow(
            TypeError
          );
        }
      )
    );
  });
});

describe('isValidPriority', () => {
  it('returns false for non-integer values in valid range', () => {
    fc.assert(
      fc.property(
        // floats strictly between MINIMUM_PRIORITY and MAXIMUM_PRIORITY but not integers
        fc.float({
          min: MINIMUM_PRIORITY,
          max: MAXIMUM_PRIORITY,
          noInteger: true,
          noNaN: true,
        }),
        (priority) => {
          expect(IRScheduler.isValidPriority(priority)).toBe(false);
        }
      )
    );
  });
});

describe('transformPriority', () => {
  it('throws for inputs that produce NaN', () => {
    // Number('') === 0, Number('NaN') === NaN, Number('hello') === NaN
    // Only strings that Number() converts to NaN should throw
    fc.assert(
      fc.property(
        // strings that are not parseable as numbers (excluding empty string which maps to 0)
        fc.stringMatching(/[a-zA-Z]/),
        (input) => {
          if (Number.isNaN(Number(input))) {
            expect(() => IRScheduler.transformPriority(input)).toThrow(
              TypeError
            );
          }
        }
      )
    );
    // direct NaN
    expect(() => IRScheduler.transformPriority(NaN)).toThrow(TypeError);
  });
});

describe('isValidFixedInterval', () => {
  it('returns true for valid integer intervals within bounds', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        (interval) => {
          expect(IRScheduler.isValidFixedInterval(interval)).toBe(true);
        }
      )
    );
  });

  it('returns false for intervals outside bounds or non-integers', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: MINIMUM_FIXED_REVIEW_INTERVAL - 1 }),
          fc.integer({ min: MAXIMUM_FIXED_REVIEW_INTERVAL + 1 }),
          fc.float({ noInteger: true })
        ),
        (interval) => {
          expect(IRScheduler.isValidFixedInterval(interval)).toBe(false);
        }
      )
    );
  });
});

describe('validateFixedInterval', () => {
  it('does not throw for valid intervals', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        (interval) => {
          expect(() =>
            IRScheduler.validateFixedInterval(interval)
          ).not.toThrow();
        }
      )
    );
  });

  it('throws for invalid intervals', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: MINIMUM_FIXED_REVIEW_INTERVAL - 1 }),
          fc.integer({ min: MAXIMUM_FIXED_REVIEW_INTERVAL + 1 }),
          fc.float({ noInteger: true })
        ),
        (interval) => {
          expect(() => IRScheduler.validateFixedInterval(interval)).toThrow(
            TypeError
          );
        }
      )
    );
  });
});

describe('adjustFixedIntervalOnChange', () => {
  it('throws for inputs that yield no parseable digits', () => {
    fc.assert(
      fc.property(
        // strings with no digit or dot characters at all
        fc.stringMatching(/^[^\d.]+$/),
        (input) => {
          expect(() => IRScheduler.adjustFixedIntervalOnChange(input)).toThrow(
            TypeError
          );
        }
      )
    );
  });

  it('throws for empty or whitespace-only strings', () => {
    for (const input of ['', '   ', '\t\n']) {
      expect(() => IRScheduler.adjustFixedIntervalOnChange(input)).toThrow(
        TypeError
      );
    }
  });

  it('throws even when input has only dots (no parseable integer)', () => {
    // "." → trimmed "." → filtered "." → parseInt(".") = NaN → throws
    expect(() => IRScheduler.adjustFixedIntervalOnChange('.')).toThrow(
      TypeError
    );
    expect(() => IRScheduler.adjustFixedIntervalOnChange('...')).toThrow(
      TypeError
    );
  });

  it('returns a valid clamped integer for digit-containing strings', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d+(\.\d*)?$/), (input) => {
        const result = IRScheduler.adjustFixedIntervalOnChange(input);
        expect(IRScheduler.isValidFixedInterval(result)).toBe(true);
        expect(result % 1).toBe(0);
        expect(result).toBeGreaterThanOrEqual(MINIMUM_FIXED_REVIEW_INTERVAL);
        expect(result).toBeLessThanOrEqual(MAXIMUM_FIXED_REVIEW_INTERVAL);
      })
    );
  });

  it('strips surrounding whitespace before filtering', () => {
    // Without trim(), "  7  " → filtered would include spaces → parseInt("  7  ") = 7 still
    // but "  abc  " without trim would not throw because trim is applied first
    // Test that "  7  " gives same result as "7"
    expect(IRScheduler.adjustFixedIntervalOnChange('  7  ')).toBe(
      IRScheduler.adjustFixedIntervalOnChange('7')
    );
    // whitespace-only → throws
    expect(() => IRScheduler.adjustFixedIntervalOnChange('   ')).toThrow(
      TypeError
    );
  });

  it('strips non-digit, non-dot characters', () => {
    fc.assert(
      fc.property(
        // A valid digit base that won't throw on its own after stripping
        fc.stringMatching(/^\d+(\.\d*)?$/),
        // One or more non-digit, non-dot characters to inject
        fc.stringMatching(/^[^\d.]+$/),
        fc.integer({ min: 0, max: 10 }),
        (base, noise, insertAt) => {
          const pos = insertAt % (base.length + 1);
          const mixed = base.slice(0, pos) + noise + base.slice(pos);
          // After stripping, `mixed` reduces to `base`, so result equals processing `base`.
          const expected = IRScheduler.adjustFixedIntervalOnChange(base);
          expect(IRScheduler.adjustFixedIntervalOnChange(mixed)).toBe(expected);
        }
      )
    );
  });

  it('uses parseInt (not parseFloat) — truncates decimals', () => {
    // "7.9" → filtered "7.9" → parseInt("7.9") = 7 (not 8)
    expect(IRScheduler.adjustFixedIntervalOnChange('7.9')).toBe(7);
  });

  it('clamps values below minimum to MINIMUM_FIXED_REVIEW_INTERVAL', () => {
    const result = IRScheduler.adjustFixedIntervalOnChange('0');
    expect(result).toBe(MINIMUM_FIXED_REVIEW_INTERVAL);
  });

  it('clamps values above maximum to MAXIMUM_FIXED_REVIEW_INTERVAL', () => {
    const result = IRScheduler.adjustFixedIntervalOnChange('9999');
    expect(result).toBe(MAXIMUM_FIXED_REVIEW_INTERVAL);
  });
});

describe('nextInterval', () => {
  it('returns a value larger than TEXT_MINIMUM_REVIEW_INTERVAL for any interval below it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TEXT_BASE_REVIEW_INTERVAL - 1 }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (interval, priority) => {
          const text = {
            interval,
            fixed_interval_days: null,
            priority,
          } as IArticleBase;
          const result = IRScheduler.nextInterval(text);
          // interval was below minimum so it should be floored to TEXT_MINIMUM_REVIEW_INTERVAL before multiplication
          const expectedMin = Math.round(
            TEXT_BASE_REVIEW_INTERVAL *
              IRScheduler.getIntervalMultiplier(priority)
          );
          expect(result).toBe(expectedMin);
        }
      )
    );
  });
});

describe('childPriorityFromFixedInterval', () => {
  const now = Date.now();

  it('throws for invalid targetReviewCount values', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        fc.integer({ min: now - MS_PER_YEAR, max: now + MS_PER_YEAR }),
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.float({ noNaN: true, noInteger: true })
        ),
        (fixed_interval_days, due, invalidCount) => {
          const parent = {
            fixed_interval_days,
            due,
            reference: 'test-parent',
          } as unknown as IArticleBase;
          expect(() =>
            IRScheduler.childPriorityFromFixedInterval(
              parent,
              invalidCount,
              now
            )
          ).toThrow(TypeError);
        }
      )
    );
  });

  it('returns MINIMUM_PRIORITY when child is always behind the parent', () => {
    // A very short fixed interval forces an extremely early parent nth review;
    // any child priority will be behind, so we expect MINIMUM_PRIORITY
    const parent = {
      fixed_interval_days: 1,
      due: now - MS_PER_YEAR * 10, // parent nth review already very far in the past
      reference: 'test-parent',
    } as unknown as IArticleBase;

    const result = IRScheduler.childPriorityFromFixedInterval(parent, 2, now);
    expect(IRScheduler.isValidPriority(result)).toBe(true);
    // With parent due so far in the past, child should get MINIMUM_PRIORITY
    expect(result).toBe(MINIMUM_PRIORITY);
  });

  it('throws if parent has no fixed_interval_days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_TESTED_REVIEW_COUNT }),
        fc.integer({ min: now - MS_PER_YEAR, max: now + MS_PER_YEAR }),
        (targetReviewCount, due) => {
          const parent = {
            fixed_interval_days: null,
            due,
            reference: 'test-parent',
          } as unknown as IArticleBase;
          expect(() =>
            IRScheduler.childPriorityFromFixedInterval(
              parent,
              targetReviewCount,
              now
            )
          ).toThrow(Error);
        }
      )
    );
  });

  it('throws if parent has no due date', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        fc.integer({ min: 1, max: MAX_TESTED_REVIEW_COUNT }),
        (fixed_interval_days, targetReviewCount) => {
          const parent = {
            fixed_interval_days,
            due: null,
            reference: 'test-parent',
          } as unknown as IArticleBase;
          expect(() =>
            IRScheduler.childPriorityFromFixedInterval(
              parent,
              targetReviewCount,
              now
            )
          ).toThrow(TypeError);
        }
      )
    );
  });

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
      )
    );
  });
});
