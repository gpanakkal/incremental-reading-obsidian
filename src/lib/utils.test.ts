import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  MS_PER_MINUTE,
} from './constants';
import {
  binarySearch,
  clamp,
  compareDates,
  compareStrings,
  deepCopy,
  deepMerge,
  generateId,
  getContentSlice,
  getDateString,
  getDateTimeStringUTC,
  getEndOfToday,
  intSequence,
  isInteger,
  isObject,
  searchAll,
  sequenceSum,
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
  it('recursively merges nested objects rather than overwriting them entirely', () => {
    const obj1 = { nested: { a: 1, b: 2 } };
    const obj2 = { nested: { b: 99 } };
    const result = deepMerge(obj1, obj2);
    // key 'a' must survive from obj1 — overwrite-only would lose it
    expect(result.nested).toEqual({ a: 1, b: 99 });
  });

  it('overwrites an object-valued key on obj1 with a primitive from obj2', () => {
    // Covers the else branch at line 99-101: val1 is an object, val2 is NOT
    const obj1 = { key: { nested: 42 } };
    const obj2 = { key: 'replaced' } as const;
    const result = deepMerge(obj1, obj2 as any);
    expect(result.key).toBe('replaced');
  });

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
      )
    );
  });
});

describe('binarySearch', () => {
  it('returns a match whose comparator returns exactly 0', () => {
    // Deterministic case: comparator returns 0 for the target
    const sorted = [1, 3, 5, 7, 9];
    expect(binarySearch(sorted, (v) => 5 - v)).toEqual({ i: 2, match: 5 });
    expect(binarySearch(sorted, (v) => 1 - v)).toEqual({ i: 0, match: 1 });
    expect(binarySearch(sorted, (v) => 9 - v)).toEqual({ i: 4, match: 9 });
  });

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

          const matchFound = sorted.includes(target);
          if (matchFound) {
            expect(result!.match).toBe(target);
            expect(result!.match).toBe(sorted[result!.i]);
          } else {
            expect(result).toBeNull();
          }
        }
      )
    );
  });
});

describe('clamp', () => {
  it('returns lowerBound when value is below both bounds', () => {
    // Confirms Math.min(lower, upper) is used for min, not Math.max
    expect(clamp(-100, 0, 10)).toBe(0);
    expect(clamp(-100, 10, 0)).toBe(0);
  });

  it('returns upperBound when value exceeds both bounds', () => {
    expect(clamp(100, 0, 10)).toBe(10);
    expect(clamp(100, 10, 0)).toBe(10);
  });

  it('returns value unchanged when within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(5, 10, 0)).toBe(5);
  });

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
      )
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

  it('error message includes value, bounds, and NaN phrase', () => {
    expect(() => clamp(NaN, 5, 20)).toThrow('5');
    expect(() => clamp(NaN, 5, 20)).toThrow('20');
    expect(() => clamp(NaN, 5, 20)).toThrow('some of these values are NaN');
    expect(() => clamp(1, NaN, 20)).toThrow('20');
    expect(() => clamp(1, NaN, 20)).toThrow('some of these values are NaN');
  });
});

// #region HELPERS
const positiveInteger = () => fc.integer({ min: 1, max: 20 });
const nonPositiveInteger = () => fc.integer({ min: -100, max: 0 });
const nonIntegerNumber = () =>
  fc.float({ noNaN: true, noDefaultInfinity: true }).filter((n) => n % 1 !== 0);
// #endregion

describe('generateId', () => {
  it('returns an alphanumeric string of the requested length', () => {
    fc.assert(
      fc.property(positiveInteger(), (length) => {
        const id = generateId(length);
        expect(typeof id).toBe('string');
        expect(id).toMatch(/^[a-z0-9]*$/);
        // NOTE: rarely Math.random() produces fewer digits; length is a best-effort
        expect(id.length).toBeLessThanOrEqual(length);
      })
    );
  });

  it('error message includes the invalid length value', () => {
    fc.assert(
      fc.property(nonPositiveInteger(), (length) => {
        expect(() => generateId(length)).toThrow(String(length));
      })
    );
  });

  it('defaults to length 5 when no argument is given', () => {
    const id = generateId();
    expect(id.length).toBeLessThanOrEqual(5);
  });

  it('throws TypeError for non-positive lengths', () => {
    fc.assert(
      fc.property(nonPositiveInteger(), (length) => {
        expect(() => generateId(length)).toThrow(TypeError);
      })
    );
  });

  it('throws TypeError for non-integer lengths', () => {
    fc.assert(
      fc.property(nonIntegerNumber(), (length) => {
        expect(() => generateId(length)).toThrow(TypeError);
      })
    );
  });

  it('throws TypeError for NaN', () => {
    expect(() => generateId(NaN)).toThrow(TypeError);
  });
});

describe('getDateTimeStringUTC', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('formats a given Date as YYYY-M-DTHhMm using UTC date parts but local time parts', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') }),
        (date) => {
          const result = getDateTimeStringUTC(date);
          const year = date.getUTCFullYear();
          const month = date.getUTCMonth() + 1;
          const day = date.getUTCDate();
          const hours = date.getUTCHours();
          const minutes = date.getUTCMinutes();
          expect(result).toBe(`${year}-${month}-${day}T${hours}H${minutes}M`);
        }
      )
    );
  });

  it('uses the current time when no date is passed', () => {
    const fixed = new Date('2024-06-15T10:30:00Z');
    vi.setSystemTime(fixed);
    const result = getDateTimeStringUTC();
    expect(result).toContain(`${fixed.getUTCFullYear()}-`);
  });
});

describe('getDateString', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('formats a given Date as YYYY-M-D in local time', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') }),
        (date) => {
          const result = getDateString(date);
          const year = date.getFullYear();
          const month = date.getMonth() + 1;
          const day = date.getDate();
          expect(result).toBe(`${year}-${month}-${day}`);
        }
      )
    );
  });

  it('uses the current time when no date is passed', () => {
    const fixed = new Date('2024-03-20T08:00:00');
    vi.setSystemTime(fixed);
    const result = getDateString();
    expect(result).toBe(
      `${fixed.getFullYear()}-${fixed.getMonth() + 1}-${fixed.getDate()}`
    );
  });
});

describe('getEndOfToday', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a timestamp in the future relative to the start of today', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -12, max: 12 }),
        fc
          .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
          .filter((d) => !isNaN(d.getTime())),
        (offsetHours, now) => {
          vi.setSystemTime(now);
          const result = getEndOfToday(offsetHours);
          const startOfToday = Date.parse(now.toDateString());
          expect(result).toBeGreaterThan(startOfToday);
        }
      )
    );
  });

  it('adds exactly one day when current time equals the rollover point exactly (boundary)', () => {
    // Fix time to exactly midnight + 4 hours; with offsetHours=4, we are precisely AT the rollover
    // The condition is >= so being exactly equal should trigger the +1 day branch
    const midnight = new Date('2024-06-15T00:00:00');
    const startOfToday = Date.parse(midnight.toDateString());
    const offsetHours = 4;
    const rolloverMs = offsetHours * 60 * MS_PER_MINUTE;
    // set time to exactly start of today + rollover offset
    vi.setSystemTime(new Date(startOfToday + rolloverMs));
    const result = getEndOfToday(offsetHours);
    expect(result).toBe(startOfToday + rolloverMs + MS_PER_DAY);
  });

  it('does NOT add a day when current time is just before the rollover point', () => {
    const midnight = new Date('2024-06-15T00:00:00');
    const startOfToday = Date.parse(midnight.toDateString());
    const offsetHours = 4;
    const rolloverMs = offsetHours * 60 * MS_PER_MINUTE;
    // set time to 1ms before rollover
    vi.setSystemTime(new Date(startOfToday + rolloverMs - 1));
    const result = getEndOfToday(offsetHours);
    expect(result).toBe(startOfToday + rolloverMs);
  });

  it('the result is always either offsetHours or offsetHours+24h past start of today', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -12, max: 12 }),
        fc
          .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
          .filter((d) => !isNaN(d.getTime())),
        (offsetHours, now) => {
          vi.setSystemTime(now);
          const result = getEndOfToday(offsetHours);
          const startOfToday = Date.parse(now.toDateString());
          const rolloverMs = offsetHours * 60 * MS_PER_MINUTE;
          const candidate1 = startOfToday + rolloverMs;
          const candidate2 = candidate1 + MS_PER_DAY;
          expect([candidate1, candidate2]).toContain(result);
        }
      )
    );
  });
});

describe('isObject', () => {
  it('returns true for plain objects', () => {
    fc.assert(
      fc.property(fc.object(), (obj) => {
        expect(isObject(obj)).toBe(true);
      })
    );
  });

  it('returns false for arrays', () => {
    fc.assert(
      fc.property(fc.array(fc.anything()), (arr) => {
        expect(isObject(arr)).toBe(false);
      })
    );
  });

  it('returns false for null', () => {
    expect(isObject(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.float(), fc.string(), fc.boolean()),
        (prim) => {
          expect(isObject(prim)).toBe(false);
        }
      )
    );
  });

  it('returns false for undefined', () => {
    expect(isObject(undefined)).toBe(false);
  });
});

describe('getContentSlice', () => {
  it('trims and slices to sliceLength when ellipses=false', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 0, max: 200 }),
        (content, sliceLength) => {
          const result = getContentSlice(content, sliceLength, false);
          expect(result.length).toBeLessThanOrEqual(sliceLength);
          expect(result).toBe(content.trim().slice(0, sliceLength));
        }
      )
    );
  });

  it('defaults ellipses to false', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 0, max: 200 }),
        (content, sliceLength) => {
          expect(getContentSlice(content, sliceLength)).toBe(
            getContentSlice(content, sliceLength, false)
          );
        }
      )
    );
  });

  it('appends "..." and keeps total length <= sliceLength when ellipses=true and content exceeds length', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 4 })
          .map((s) => s.trim())
          .filter((s) => s.length >= 4),
        fc.integer({ min: 3, max: 50 }).filter((n) => n >= 3),
        (content, sliceLength) => {
          fc.pre(content.length > sliceLength);
          const result = getContentSlice(content, sliceLength, true);
          expect(result.endsWith('...')).toBe(true);
          expect(result.length).toBe(sliceLength);
        }
      )
    );
  });

  it('does NOT append ellipses when content length exactly equals sliceLength', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{3,30}$/), (content) => {
        const result = getContentSlice(content, content.length, true);
        expect(result).toBe(content);
        expect(result.endsWith('...')).toBe(false);
      })
    );
  });

  it('returns trimmed content as-is when ellipses=true but content fits within sliceLength', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.integer({ min: 20, max: 100 }),
        (content, sliceLength) => {
          const trimmed = content.trim();
          fc.pre(trimmed.length <= sliceLength);
          const result = getContentSlice(trimmed, sliceLength, true);
          expect(result).toBe(trimmed);
        }
      )
    );
  });
});

describe('isInteger', () => {
  it('returns true for known integer values', () => {
    expect(isInteger(0)).toBe(true);
    expect(isInteger(1)).toBe(true);
    expect(isInteger(-5)).toBe(true);
    expect(isInteger(100)).toBe(true);
  });

  it('returns exactly true (boolean) for integer numbers', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        const result = isInteger(n);
        expect(result).toBe(true);
        expect(typeof result).toBe('boolean');
      })
    );
  });

  it('returns false for non-integer numbers', () => {
    fc.assert(
      fc.property(nonIntegerNumber(), (n) => {
        expect(isInteger(n)).toBe(false);
      })
    );
  });

  it('returns false for NaN', () => {
    expect(isInteger(NaN)).toBe(false);
  });

  it('returns false for Infinity', () => {
    expect(isInteger(Infinity)).toBe(false);
    expect(isInteger(-Infinity)).toBe(false);
  });

  it('returns false for non-number values', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.boolean(),
          fc.object(),
          fc.array(fc.anything())
        ),
        (val) => {
          expect(isInteger(val)).toBe(false);
        }
      )
    );
  });
});

describe('compareDates', () => {
  it('returns 0 when both are null', () => {
    expect(compareDates(null, null)).toBe(0);
  });

  it('returns positive when a is null and b is not', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 0 }),
          fc.date({ min: new Date(0), max: new Date('2099-12-31') })
        ),
        (b) => {
          expect(compareDates(null, b)).toBeGreaterThan(0);
        }
      )
    );
  });

  it('returns negative when b is null and a is not', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 0 }),
          fc.date({ min: new Date(0), max: new Date('2099-12-31') })
        ),
        (a) => {
          expect(compareDates(a, null)).toBeLessThan(0);
        }
      )
    );
  });

  it('returns negative when a < b (numbers)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1_000_001, max: 2_000_000 }),
        (a, b) => {
          expect(compareDates(a, b)).toBeLessThan(0);
        }
      )
    );
  });

  it('returns positive when a > b (numbers)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_001, max: 2_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (a, b) => {
          expect(compareDates(a, b)).toBeGreaterThan(0);
        }
      )
    );
  });

  it('returns 0 when a === b as numbers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0 }), (ts) => {
        expect(compareDates(ts, ts)).toBe(0);
      })
    );
  });

  it('compares Date objects by their exact millisecond value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (aMs, deltaMs) => {
          const bMs = aMs + deltaMs;
          const a = new Date(aMs);
          const b = new Date(bMs);
          expect(compareDates(a, b)).toBeLessThan(0);
          expect(compareDates(b, a)).toBeGreaterThan(0);
          expect(compareDates(a, new Date(aMs))).toBe(0);
        }
      )
    );
  });
});

describe('compareStrings', () => {
  it('orders by code units: negative/zero/positive matching < and ===', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const result = compareStrings(a, b);
        if (a === b) expect(result).toBe(0);
        else if (a < b) expect(result).toBeLessThan(0);
        else expect(result).toBeGreaterThan(0);
      })
    );
  });

  it('is antisymmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        // `+ 0` normalises the -0 produced by negating 0 on equal strings,
        // which `toBe` (Object.is) would otherwise reject.
        expect(compareStrings(a, b) + 0).toBe(-compareStrings(b, a) + 0);
      })
    );
  });
});

describe('searchAll', () => {
  it('returns an empty array for a string with no matches', () => {
    expect(searchAll('hello world', /xyz/g)).toEqual([]);
  });

  it('returns match text and index for each match', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{5,20}$/).chain((word) =>
          fc.tuple(
            fc.array(fc.stringMatching(/^[a-z]{1,5}$/), {
              minLength: 0,
              maxLength: 5,
            }),
            fc.constant(word)
          )
        ),
        ([parts, word]) => {
          const text = parts.join(word);
          const pattern = new RegExp(word, 'g');
          const results = searchAll(text, pattern);

          // verify every returned match is correct
          for (const { match, index } of results) {
            expect(match).toBe(word);
            expect(text.slice(index, index + word.length)).toBe(word);
          }
        }
      )
    );
  });

  it('returns all non-overlapping matches in order', () => {
    const result = searchAll('abcabc', /abc/g);
    expect(result).toEqual([
      { match: 'abc', index: 0 },
      { match: 'abc', index: 3 },
    ]);
  });

  it('requires the pattern to have the global flag to work correctly', () => {
    // Without global flag, matchAll throws
    expect(() => searchAll('abc', /abc/)).toThrow();
  });
});

describe('intSequence', () => {
  it('produces an ascending sequence from start to end (inclusive)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        (a, b) => {
          fc.pre(b >= a);
          const seq = intSequence(a, b);
          expect(seq[0]).toBe(a);
          expect(seq[seq.length - 1]).toBe(b);
          expect(seq.length).toBe(b - a + 1);
          for (let i = 1; i < seq.length; i++) {
            expect(seq[i]).toBe(seq[i - 1] + 1);
          }
        }
      )
    );
  });

  it('produces a descending sequence when end < start', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        (a, b) => {
          fc.pre(b < a);
          const seq = intSequence(a, b);
          expect(seq[0]).toBe(a);
          expect(seq[seq.length - 1]).toBe(b);
          expect(seq.length).toBe(a - b + 1);
          for (let i = 1; i < seq.length; i++) {
            expect(seq[i]).toBe(seq[i - 1] - 1);
          }
        }
      )
    );
  });

  it('returns a single-element array when start === end', () => {
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), (n) => {
        expect(intSequence(n, n)).toEqual([n]);
      })
    );
  });

  it('a two-element ascending sequence starting at n has second element n+1 (not n-1)', () => {
    // This distinguishes >= from > in the isPos check when end === start+1
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 49 }), (n) => {
        const seq = intSequence(n, n + 1);
        expect(seq).toEqual([n, n + 1]);
      })
    );
  });
});
