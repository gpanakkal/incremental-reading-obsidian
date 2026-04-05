import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAXIMUM_PRIORITY, MINIMUM_PRIORITY } from './constants';
import {
  binarySearch,
  clamp,
  deepCopy,
  deepMerge,
  sequenceSum,
  toDisplayPriority,
  transformPriority,
} from './utils';

const safeStringKey = () => fc.stringMatching(/^[a-zA-Z$][a-zA-Z0-9$_]*$/);

describe('deepCopy', () => {
  it('copies nested objects and iterables', () => {
    fc.assert(
      fc.property(fc.object({ key: safeStringKey() }), (obj1) => {
        const copy = deepCopy(obj1);
        expect(copy).toEqual(obj1);
        expect(copy).not.toBe(obj1);
      })
    );
  });
});

describe('deepMerge', () => {
  it('overwrites properties on obj1 with those on obj2', () => {
    fc.assert(
      fc.property(
        fc.object({ key: safeStringKey() }),
        fc.object({ key: safeStringKey() }),
        (obj1, obj2) => {
          expect(deepMerge({}, obj2)).toEqual(obj2);
          expect(deepMerge(obj1, obj2)).toMatchObject(obj2);
        }
      )
    );
  });
});

describe('transformPriority', () => {
  it(
    `converts inputs into integers between ${MINIMUM_PRIORITY} and ` +
      `${MAXIMUM_PRIORITY}, inclusive`,
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer(),
            fc.float(),
            fc.stringMatching(/^[0-9]+(\.[0-9]*)?$/)
          ),
          (displayValue) => {
            const result = transformPriority(displayValue);
            expect(result).toBeGreaterThanOrEqual(MINIMUM_PRIORITY);
            expect(result).toBeLessThanOrEqual(MAXIMUM_PRIORITY);
            expect(result % 1).toEqual(0);
          }
        )
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
          const result = toDisplayPriority(priority);
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
          expect(() => toDisplayPriority(priority)).toThrow();
        }
      )
    );
  });
});

describe('sequenceSum', () => {
  it(`adds all terms including those at the start and end indices`, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -99, max: 99 }),
        fc.integer({ min: -99, max: 99 }),
        fc.func(fc.float({ noNaN: true })),
        (a, b, mockFunc) => {
          const mockReductions = new Array(Math.abs(b - a) + 1)
            .fill(null)
            .map(mockFunc);

          const dir = b >= a ? 1 : -1;
          const result = sequenceSum(
            a,
            b,
            (k) => mockReductions[dir * (k - a)]
          );

          const manualResult = mockReductions.reduce((acc, el) => acc + el, 0);
          expect(result).toEqual(manualResult);
        }
      ),
      { numRuns: 1_000 }
    );
  });
});

describe('binarySearch', () => {
  it(`returns the desired value if in the passed array, or null otherwise`, () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 0 }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        (values, target) => {
          const sorted = values.sort((a, b) => a - b);
          const result = binarySearch(
            sorted,
            (compareValue) => target - compareValue
          );

          const foundIndex = sorted.indexOf(target);
          if (foundIndex !== -1) {
            expect(result!.match).toBe(target);
            expect(result!.i).toBe(foundIndex);
          } else {
            expect(result).toBeNull();
          }
        }
      ),
      { numRuns: 10_000 }
    );
  });
});

describe('clamp', () => {
  it('always limits valid number inputs to the bounds', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.float({ noNaN: true })),
        fc.oneof(fc.integer(), fc.float({ noNaN: true })),
        fc.oneof(fc.integer(), fc.float({ noNaN: true })),
        (value, boundA, boundB) => {
          const clamped = clamp(value, boundA, boundB);
          const min = Math.min(boundA, boundB);
          const max = Math.max(boundA, boundB);
          expect(clamped).toBeLessThanOrEqual(max);
          expect(clamped).toBeGreaterThanOrEqual(min);
        }
      ),
      { numRuns: 10_000 }
    );
  });

  it('throws if any of the passed values are NaN', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.float()),
        fc.oneof(fc.integer(), fc.float()),
        fc.oneof(fc.integer(), fc.float()),
        (value, boundA, boundB) => {
          expect(() => clamp(NaN, boundA, boundB)).toThrow();
          expect(() => clamp(value, NaN, boundB)).toThrow();
          expect(() => clamp(value, boundA, NaN)).toThrow();
        }
      )
    );
  });
});
