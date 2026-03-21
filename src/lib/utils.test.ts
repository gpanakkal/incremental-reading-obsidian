import * as fc from 'fast-check';
import { deepCopy, deepMerge } from './utils';
import { describe, expect, it } from 'vitest';

const safeStringKey = () => fc.stringMatching(/^[a-zA-Z$][a-zA-Z0-9$_]*$/);

describe('deepCopy', () => {
  it('copies nested objects and iterables', () => {
    fc.assert(
      fc.property(fc.object(), (obj1) => {
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
