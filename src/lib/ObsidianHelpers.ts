import type { App, Editor, TFile } from 'obsidian';
import {
  CONTENT_TITLE_SLICE_LENGTH,
  FORBIDDEN_TITLE_CHARS,
  literal,
  SOURCE_TAG,
} from './constants';
import { FRONTMATTER_PATTERN } from './constants.js';
import { generateId } from './utils';

export class ObsidianHelpers {
  /**
   * Calculate the character offset where the body starts (after frontmatter).
   * Returns 0 if no frontmatter is present.
   * @param fileContent The full file content
   */
  static getBodyStartOffset(fileContent: string): number {
    const result = this.splitFrontMatter(fileContent);
    if (result) {
      return fileContent.length - result.body.length;
    }
    return 0;
  }

  static async createFile(app: App, absolutePath: string): Promise<TFile> {
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
   * Remove characters that cannot be used for file names
   * or Obsidian note titles
   * @param checkFinalChar if true, removes spaces and periods from the end
   */
  static sanitizeForTitle(
    text: string,
    checkFinalChar: boolean,
    maxLength?: number
  ) {
    const cleaned = text
      .split('')
      .map((char, i) => {
        if (checkFinalChar && i === text.length - 1) {
          if (' .'.includes(char)) return '';
        }
        if (FORBIDDEN_TITLE_CHARS.has(char)) {
          return ' ';
        } else return char;
      })
      .join('')
      .trim();

    return maxLength ? cleaned.slice(0, maxLength) : cleaned;
  }

  /**
   * Creates a title from a slice of the content and a random ID
   * TODO: handle file system name length limitations?
   */
  static createTitle(content?: string) {
    const TITLE_SEGMENT_SEPARATOR = ' - ';
    const segments = [];
    if (content) {
      const sanitized = this.sanitizeForTitle(
        content,
        false,
        CONTENT_TITLE_SLICE_LENGTH
      );
      if (sanitized.length > 0) segments.push(sanitized);
    }
    segments.push(generateId());
    return segments.join(TITLE_SEGMENT_SEPARATOR);
  }
  /**
   * If text is selected, returns an object of the EditorPositions and offsets
   * of the selection, or `null` otherwise.
   */
  static getSelectionWithBounds(editor: Editor) {
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

  static splitFrontMatter(
    noteText: string
  ): { frontMatter: string; body: string } | null {
    const matches = noteText.match(FRONTMATTER_PATTERN);
    if (!matches) return null;
    return { frontMatter: matches[1], body: matches[2] };
  }

  static transcludeLink(editor: Editor, link: string, blockLine: number) {
    const line = editor.getLine(blockLine);
    editor.replaceRange(
      `!${link}`,
      { line: blockLine, ch: 0 },
      { line: blockLine, ch: line.length }
    );
  }
}
