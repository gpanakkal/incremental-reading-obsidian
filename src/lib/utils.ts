import {
  DAY_ROLLOVER_OFFSET_HOURS,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  MS_PER_MINUTE,
} from './constants';
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
  formatted += `T${dateToUse.getHours()}H${dateToUse.getMinutes()}M`;
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
 * Get the rollover-adjusted end of day as a Unix timestamp.
 */
export function getEndOfToday() {
  const date = new Date();
  // get start of day in local time zone
  const startOfToday = Date.parse(date.toDateString());
  const rolloverOffsetMs = DAY_ROLLOVER_OFFSET_HOURS * 60 * MS_PER_MINUTE;
  let endOfDayLocal = startOfToday + rolloverOffsetMs;
  if (Date.parse(date.toUTCString()) - startOfToday >= rolloverOffsetMs) {
    // add a full day since we're past the rollover point
    endOfDayLocal += MS_PER_DAY;
  }
  return endOfDayLocal;
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

export const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && !Number.isNaN(value) && value % 1 === 0;

export function compareDates(a: number | Date | null, b: number | Date | null) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const [aNum, bNum] = [a, b].map((val) =>
    typeof val === 'number' ? val : Date.parse(val.toUTCString())
  );

  return aNum - bNum;
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
      done = false;
      break;
    }
    const { index } = next.value;
    const matchText = next.value[0];
    if (index === undefined) throw new TypeError(`Index must be a number`);
    results.push({ match: matchText, index });
  }

  return results;
}

export const isValidPriority = (priority: number) =>
  priority % 1 === 0 &&
  priority >= MINIMUM_PRIORITY &&
  priority <= MAXIMUM_PRIORITY;

export const validatePriority = (priority: number) => {
  if (!isValidPriority(priority))
    throw new TypeError(
      `Priority must be an integer between ${MINIMUM_PRIORITY} and ` +
        `${MAXIMUM_PRIORITY} inclusive; received "${priority}"`
    );
};

/** Clamp display value and convert to integer */
export const transformPriority = (displayPriority: string | number) => {
  const priorityNum = Number(displayPriority);
  if (Number.isNaN(priorityNum)) {
    throw new TypeError(`Priority cannot be NaN`);
  }

  let withDecimal = Number(priorityNum.toString().slice(0, 3));
  while (withDecimal >= 10) {
    withDecimal = withDecimal / 10;
  }
  const asInt = withDecimal * 10;
  const clamped = Math.min(MAXIMUM_PRIORITY, Math.max(MINIMUM_PRIORITY, asInt));
  return Math.round(clamped);
};

export const toDisplayPriority = (priority: number): string => {
  validatePriority(priority);
  let displayPriority = (priority / 10).toString().slice(0, 3);
  if (displayPriority.length === 1) displayPriority += `.0`;
  return displayPriority;
};
