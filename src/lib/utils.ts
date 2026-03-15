import {
  DAY_ROLLOVER_OFFSET_HOURS,
  MS_PER_DAY,
  MS_PER_MINUTE,
} from './constants';

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

// /**
//  * Get a title-safe date and time in UTC.
//  * Uses the current time if a Date is not passed
//  */
// function getDateTimeString(date?: Date) {
//   const dateToUse = date ?? new Date();
//   let formatted = `${dateToUse.getUTCFullYear()}-${dateToUse.getUTCMonth() + 1}-${dateToUse.getUTCDate()}`;
//   formatted += `T${dateToUse.getHours()}H${dateToUse.getMinutes()}M`;
//   return formatted;
// }

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
 * Make a deep copy of an object
 * TODO: handle loops
 */
export const deepCopy = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') return value;

  let clone = {};
  for (const key in value) {
    Object.assign(clone, { [key]: deepCopy(value[key]) });
  }
  return clone as T;
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

/** Get Obsidian's internal MarkdownEditor */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getEditorClass(app: any) {
  // Create a temporary editor instance
  const md = app.embedRegistry.embedByExtension.md(
    {
      app,
      containerEl: createDiv(),
      state: {},
    },
    null,
    ''
  );

  try {
    md.load();
    md.editable = true;
    md.showEditor();

    const MarkdownEditor = Object.getPrototypeOf(
      Object.getPrototypeOf(md.editMode)
    ).constructor;

    // Store reference to original buildExtensions method to copy extensions
    const _originalBuildExtensions = MarkdownEditor.prototype.buildExtensions;

    return MarkdownEditor;
  } finally {
    md.unload();
  }
}

/**
 * Get base extensions that would be used in a standard MarkdownEditor
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBaseMarkdownExtensions(app: any) {
  const md = app.embedRegistry.embedByExtension.md(
    {
      app,
      containerEl: createDiv(),
      state: {},
    },
    null,
    ''
  );

  try {
    md.load();
    md.editable = true;
    md.showEditor();

    // Try to get extensions from the edit mode
    const editMode = md.editMode;
    let extensions = [];

    if (editMode) {
      if (editMode.propertiesExtension) {
        try {
          extensions.push(editMode.propertiesExtension);
        } catch (error) {
          console.error('Error examining propertiesExtension:', error);
        }
      }

      // console.log('Total extensions found:', extensions.length);
    }

    return extensions;
  } catch (error) {
    console.warn('Could not extract base markdown extensions:', error);
    return [];
  } finally {
    md.unload();
  }
}

/** Clamp display value and convert to integer */
export const transformPriority = (rawPriority: string | number) => {
  const priorityNum = Number(rawPriority);
  if (Number.isNaN(priorityNum)) {
    throw new TypeError(`Priority cannot be NaN`);
  }

  let withDecimal = Number(priorityNum.toString().slice(0, 3));
  while (withDecimal >= 10) {
    withDecimal = withDecimal / 10;
  }
  const clamped = Math.min(5, Math.max(1, withDecimal));
  const rounded = Math.round(clamped * 10);
  return rounded;
};
