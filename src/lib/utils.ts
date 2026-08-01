import { MS_PER_DAY, MS_PER_MINUTE } from './constants';
import type { DeepPartial } from './utility-types';

/**
 * Generates an alphanumeric ID of the specified length (default 5)
 */
export function generateId(length: number = 5): string {
  if (length <= 0 || length % 1 !== 0) {
    throw new TypeError(
      `Length must be a positive integer; received ${length}`
    );
  }

  return Math.random()
    .toString(36) // letters and digits
    .slice(2, length + 2); // remove the decimal place
}

/**
 * Get a title-safe date and time in UTC.
 * Uses the current time if a Date is not passed
 */
export function getDateTimeStringUTC(date?: Date) {
  const dateToUse = date ?? new Date();
  let formatted = `${dateToUse.getUTCFullYear()}-${dateToUse.getUTCMonth() + 1}-${dateToUse.getUTCDate()}`;
  formatted += `T${dateToUse.getUTCHours()}H${dateToUse.getUTCMinutes()}M`;
  return formatted;
}

/**
 * Get a title-safe date in local time.
 * Uses the current time if a Date is not passed
 */
export function getDateString(date?: Date) {
  const dateToUse = date ?? new Date();
  const formatted = `${dateToUse.getFullYear()}-${dateToUse.getMonth() + 1}-${dateToUse.getDate()}`;
  return formatted;
}

/**
 * Get the rollover-adjusted end of a review day as a Unix timestamp.
 *
 * A review day begins at `midnight + offsetHours` on the calendar date it is
 * named for and ends one day later: with a +4-hour offset, review day D runs
 * from D 04:00 to D+1 04:00; with a -5-hour offset, from D-1 19:00 to D 19:00.
 * Passing D-1 gives the start of review day D.
 *
 * @param day the review day to measure, as any time on its calendar date.
 * @default the review day in progress
 */
export function getEndOfDay(offsetHours: number, day?: Date) {
  const date = day ?? new Date();
  // Built from date parts rather than `Date.parse(date.toDateString())`: the
  // format `toDateString` emits is implementation-defined, and `Date.parse` on
  // a non-ISO string is too. This plugin runs in both Electron and mobile
  // webviews, which are separate engines.
  const midnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ).getTime();
  const boundary = midnight + offsetHours * 60 * MS_PER_MINUTE;

  // The named day ends at the *next* boundary after the one that opens it.
  if (day) return boundary + MS_PER_DAY;
  // Once today's boundary has passed, the day in progress ends at the next one.
  return date.getTime() >= boundary ? boundary + MS_PER_DAY : boundary;
}

/**
 * Get the review day a given instant falls in, as a `Date` on that day's
 * calendar date. The inverse of {@link getEndOfDay}: the returned day always
 * satisfies `instant < getEndOfDay(offsetHours, day)`.
 *
 * Under a +4h offset an instant at 02:00 belongs to the previous review day;
 * under a -5h offset one at 20:00 already belongs to the next.
 */
export function reviewDayOf(instant: Date, offsetHours: number) {
  const day = new Date(
    instant.getFullYear(),
    instant.getMonth(),
    instant.getDate()
  );
  // Before its own day's opening boundary, so it still belongs to the day
  // before; past the next one, so it already belongs to the day after.
  const millisIntoDay = instant.getTime() - day.getTime();
  const offsetMs = offsetHours * 60 * MS_PER_MINUTE;
  if (millisIntoDay < offsetMs) day.setDate(day.getDate() - 1);
  else if (millisIntoDay >= offsetMs + MS_PER_DAY) {
    day.setDate(day.getDate() + 1);
  }
  return day;
}

/** The review day now falls in. See {@link reviewDayOf}. */
export function currentReviewDay(offsetHours: number) {
  return reviewDayOf(new Date(), offsetHours);
}

/**
 * Check if a value is a non-array object
 */
export const isObject = <T extends Record<string | number | symbol, unknown>>(
  val: unknown
): val is T => {
  return typeof val === 'object' && !Array.isArray(val) && val !== null;
};

/**
 * Make a deep copy of an object
 * TODO: handle loops
 */
export const deepCopy = <T>(value: T): T => {
  if (!isObject(value)) return value;

  const clone = {};
  for (const key in value) {
    Object.assign(clone, { [key]: deepCopy(value[key]) });
  }
  return clone as T;
};

/**
 * (WIP) Recursively merge two objects, overwriting primitives and iterables
 * on obj1 with values from obj2 where applicable
 * TODO: handle loops
 */
export const deepMerge = <T extends object>(
  obj1: T,
  obj2: DeepPartial<T>
): T => {
  const merged = deepCopy(obj1);
  const keys = Object.keys(obj2) as Array<keyof typeof obj2>;
  for (const key of keys) {
    const val1 = obj1[key as unknown as keyof T];
    const val2 = obj2[key];
    if (!isObject(val1)) {
      Object.assign(merged, { [key]: val2 });
    } else if (isObject(val2)) {
      Object.assign(merged, {
        [key]: deepMerge(val1, val2 as DeepPartial<T[keyof T] & object>),
      });
    } else {
      // obj1 has an object on the key but obj2 doesn't, so we overwrite
      Object.assign(merged, { [key]: obj2[key] });
    }
  }
  return merged;
};

/**
 * Returns the start of `content` as a string no longer than `sliceLength`,
 * adding ellipses if longer
 */
export function getContentSlice(
  content: string,
  sliceLength: number,
  ellipses: boolean = false
) {
  const trimmed = content.trim();
  if (!ellipses) return trimmed.slice(0, sliceLength);

  return trimmed.length > sliceLength
    ? `${trimmed.slice(0, sliceLength - 3)}...`
    : trimmed;
}

export const isInteger = (value: unknown): boolean =>
  typeof value === 'number' && value % 1 === 0;

export function compareDates(a: number | Date | null, b: number | Date | null) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const [aNum, bNum] = [a, b].map((val) =>
    typeof val === 'number' ? val : val.getTime()
  );

  return aNum - bNum;
}

/** Locale-independent lexicographic string comparison. */
export function compareStrings(a: string, b: string) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order items by fuzzed due timestamp, ascending.
 */
export function compareFuzzedDue(
  a: { due: number | Date | null; due_fuzz?: number | null },
  b: { due: number | Date | null; due_fuzz?: number | null }
) {
  if (b.due === null) return -1;
  if (a.due === null) return 1;
  const aDueTimestamp = typeof a.due === 'number' ? a.due : a.due.getTime();
  const bDueTimestamp = typeof b.due === 'number' ? b.due : b.due.getTime();
  const aFuzzed = aDueTimestamp + (a.due_fuzz ?? 0);
  const bFuzzed = bDueTimestamp + (b.due_fuzz ?? 0);
  return aFuzzed - bFuzzed;
}

/**
 * Get the starting index and text of every match to a pattern
 */
export function searchAll(text: string, pattern: RegExp) {
  let results: { match: string; index: number }[] = [];
  const matches = text.matchAll(pattern);
  let done = false;
  while (!done) {
    const next = matches.next();
    if (next.done) {
      done = true;
    } else {
      const { index } = next.value;
      const matchText = next.value[0];
      results.push({ match: matchText, index });
    }
  }

  return results;
}

/**
 * Generates an array of integers in order from start to end.
 * Iterates negatively if end < start.
 */
export const intSequence = (start: number, end: number): number[] => {
  const isPos = end >= start;
  let seq = new Array(Math.abs(end - start) + 1).fill(start) as number[];
  seq = seq.map((start, i) => start + (isPos ? i : -i));
  return seq;
};

export const sequenceSum = (
  start: number,
  end: number,
  func: (k: number) => number
) => {
  const seq = intSequence(start, end);
  return seq.reduce((acc, el) => acc + func(el), 0);
};

/**
 *
 * @param values an array of numbers, assumed to be sorted in ascending order
 * @param comparator A callback that returns 0 if a match is found, a positive
 * value if the search target is greater than `compareValue`, or a negative
 *  value otherwise.
 */
export const binarySearch = <T>(
  values: Array<T>,
  comparator: (compareValue: T) => number
): { i: number; match: T } | null => {
  let left = 0;
  let right = values.length - 1;

  while (left <= right) {
    const midIndex = Math.floor((left + right) / 2);
    const compareValue = values[midIndex];
    const compareResult = comparator(compareValue);
    if (compareResult < 0) {
      right = midIndex - 1;
    } else if (compareResult > 0) {
      left = midIndex + 1;
    } else {
      return { i: midIndex, match: compareValue };
    }
  }
  return null;
};

export const clamp = (
  value: number,
  lowerBound: number,
  upperBound: number
): number => {
  if ([value, lowerBound, upperBound].some(Number.isNaN))
    throw new TypeError(
      `Attempted to clamp value ${value} within [${lowerBound}, ${upperBound}]` +
        `, but some of these values are NaN`
    );
  const [min, max] = [
    Math.min(lowerBound, upperBound),
    Math.max(lowerBound, upperBound),
  ];
  return Math.max(min, Math.min(max, value));
};
