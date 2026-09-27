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
 * Get local midnight on a date's own calendar day.
 *
 * Built from date parts rather than by zeroing the time fields, which is what
 * makes it correct across a daylight-saving transition: on a day whose
 * midnight does not exist, the constructor lands on the hour the clock jumps
 * to, while `setHours(0, 0, 0, 0)` would land on the previous day.
 */
export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whether two instants fall on the same calendar date, in local time. */
export function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Where the review day named for a calendar date begins: `offsetHours` past
 * midnight on that date, read off the local wall clock.
 *
 * Built with the `Date` constructor, which normalizes out-of-range hours onto
 * a neighboring date (-5 on the 15th is 19:00 on the 14th), rather than by
 * adding milliseconds to midnight. A day the clocks change on is 23 or 25
 * hours long, so millisecond arithmetic lands an hour off the rollover the
 * user set. When the rollover hour itself is skipped by the clocks going
 * forward, the constructor lands on the hour they jump to.
 */
function reviewDayStart(
  offsetHours: number,
  year: number,
  month: number,
  date: number
) {
  return new Date(year, month, date, offsetHours).getTime();
}

/**
 * Get the rollover-adjusted end of a review day as a Unix timestamp.
 *
 * A review day begins at `offsetHours` past midnight, by the local clock, on
 * the calendar date it is named for, and ends where the next one begins: with
 * a +4-hour offset, review day D runs from D 04:00 to D+1 04:00; with a
 * -5-hour offset, from D-1 19:00 to D 19:00. That is 24 hours except across a
 * daylight-saving change. Passing D-1 gives the start of review day D.
 *
 * @param day the review day to measure, as any time on its calendar date.
 * @default the review day in progress
 */
export function getEndOfDay(offsetHours: number, day?: Date) {
  // Date parts rather than parsing `date.toDateString()`: the format
  // `toDateString` emits is implementation-defined, and `Date.parse` on a
  // non-ISO string is too. This plugin runs in both Electron and mobile
  // webviews, which are separate engines.
  const named = day ?? currentReviewDay(offsetHours);
  return reviewDayStart(
    offsetHours,
    named.getFullYear(),
    named.getMonth(),
    named.getDate() + 1
  );
}

/**
 * Get the review day a given instant falls in, as a `Date` at local midnight
 * on that day's calendar date. The inverse of {@link getEndOfDay}: the
 * returned day always satisfies
 * `getEndOfDay(offsetHours, dayBefore) <= instant < getEndOfDay(offsetHours, day)`.
 *
 * Under a +4h offset an instant at 02:00 belongs to the previous review day;
 * under a -5h offset one at 20:00 already belongs to the next.
 */
export function reviewDayOf(instant: Date, offsetHours: number) {
  const year = instant.getFullYear();
  const month = instant.getMonth();
  const date = instant.getDate();
  const time = instant.getTime();
  // An offset is under a day either way, so the instant is at most one day
  // off its calendar date: before that date's own rollover, it still belongs
  // to the day before; at or past the next one, it already belongs to the
  // day after.
  let shift = 0;
  if (time < reviewDayStart(offsetHours, year, month, date)) shift = -1;
  else if (time >= reviewDayStart(offsetHours, year, month, date + 1)) {
    shift = 1;
  }
  return new Date(year, month, date + shift);
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
