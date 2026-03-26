import * as fc from 'fast-check';
import {
  deepCopy,
  deepMerge,
  toDisplayPriority,
  transformPriority,
} from './utils';
import { describe, expect, it } from 'vitest';
import { MAXIMUM_PRIORITY, MINIMUM_PRIORITY } from './constants';

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
