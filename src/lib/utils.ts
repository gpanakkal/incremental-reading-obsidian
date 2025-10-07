import type { App, Editor, TFile } from 'obsidian';
import { CONTENT_TITLE_SLICE_LENGTH, FORBIDDEN_TITLE_CHARS } from './constants';
import { FRONTMATTER_PATTERN } from './constants.js';

export async function createFile(
  app: App,
  absolutePath: string
): Promise<TFile> {
  if (app.vault.getAbstractFileByPath(absolutePath)) {
    throw new Error(`File already exists at ${absolutePath}`);
  }

  const folderPath = absolutePath.slice(0, absolutePath.lastIndexOf('/'));
  if (!app.vault.getAbstractFileByPath(folderPath)) {
    await app.vault.createFolder(folderPath);
  }

  try {
    const file = await app.vault.create(absolutePath, '');
    return file;
  } catch (e) {
    console.error(`Failed to create file at ${absolutePath}`);
    throw e;
  }
}

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
export function getDateTimeString(date?: Date) {
  const dateToUse = date ?? new Date();
  let formatted = `${dateToUse.getUTCFullYear()}-${dateToUse.getUTCMonth() + 1}-${dateToUse.getUTCDate()}`;
  formatted += `T${dateToUse.getHours()}H${dateToUse.getMinutes()}M`;
  return formatted;
}

/**
 * Replace characters that cannot be used for file names
 * or Obsidian note titles with spaces
 */
export function sanitizeForTitle(text: string, checkFinalChar: boolean) {
  return text
    .trim()
    .split('')
    .map((char, i) => {
      if (
        !FORBIDDEN_TITLE_CHARS.has(char) &&
        (!checkFinalChar || i !== text.length - 1 || !' .'.includes(char))
      )
        return char;
      return ' ';
    })
    .join('');
}

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

/**
 * Creates a title with an ISO timestamp and a slice of the content,
 * or a random ID if no content is passed
 * TODO: handle file system name length limitations?
 */
export function createTitle(content?: string) {
  const time = getDateTimeString();
  const TITLE_SEGMENT_SEPARATOR = ' - ';
  const segments = [];
  if (content) {
    const contentSlice = content.trim().slice(0, CONTENT_TITLE_SLICE_LENGTH);
    const sanitized = sanitizeForTitle(contentSlice, false).trim();
    if (sanitized.length > 0) segments.push(sanitized);
  }
  segments.push(time, generateId());
  return segments.join(TITLE_SEGMENT_SEPARATOR);
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
 * If text is selected, returns an object of the EditorPositions and offsets
 * of the selection, or `null` otherwise.
 */
export function getSelectionWithBounds(editor: Editor) {
  const selection = editor.getSelection();
  if (!selection) return null;

  const [start, end] = [editor.getCursor('from'), editor.getCursor('to')];
  return {
    selection,
    start,
    end,
    startOffset: editor.posToOffset(start),
    endOffset: editor.posToOffset(end),
  };
}

/**
 * Get the starting index and text of every match to a pattern
 */
export function searchAll(text: string, pattern: RegExp) {
  let results: { match: string; index: number }[] = [];
  const matches = text.matchAll(pattern);
  while (true) {
    const next = matches.next();
    if (next.done) break;
    const { index } = next.value;
    const matchText = next.value[0];
    if (index === undefined) throw new TypeError(`Index must be a number`);
    results.push({ match: matchText, index });
  }

  return results;
}
export function splitFrontMatter(
  noteText: string
): { frontMatter: string; body: string } | null {
  const matches = noteText.match(FRONTMATTER_PATTERN);
  if (!matches) return null;
  return { frontMatter: matches[1], body: matches[2] };
}
/** Get Obsidian's internal MarkdownEditor */
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
    const originalBuildExtensions = MarkdownEditor.prototype.buildExtensions;

    return MarkdownEditor;
  } finally {
    md.unload();
  }
}

/**
 * Get base extensions that would be used in a standard MarkdownEditor
 */
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
