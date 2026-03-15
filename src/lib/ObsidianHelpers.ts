import { editorInfoField, normalizePath } from 'obsidian';
import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CARD_DIRECTORY,
  CARD_TAG,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  FORBIDDEN_TITLE_CHARS,
  INVALID_TITLE_MESSAGE,
  SNIPPET_DIRECTORY,
  SNIPPET_TAG,
  SOURCE_TAG,
} from './constants';
import { FRONTMATTER_PATTERN } from './constants.js';
import { generateId } from './utils';
import type { FrontMatterUpdates, NoteType, PluginFrontMatter } from './types';
import type { EditorState } from '@codemirror/state';
import type {
  App,
  Editor,
  FrontMatterCache,
  MarkdownFileInfo,
  TFile,
} from 'obsidian';

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

  static getReferenceFromPath(vaultPath: string): string {
    const reference = vaultPath.split(`${DATA_DIRECTORY}/`)[1];
    return reference;
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

  /** Retrieves notes from the data directory given a row's reference */
  static getNote(reference: string, app: App): TFile | null {
    return app.vault.getFileByPath(
      normalizePath(`${DATA_DIRECTORY}/${reference}`)
    );
  }

  /**
   * Gets the type of a note based on its tags. Can return a false `null`
   * if performed too soon after note creation.
   * TODO: use more robust approach to getting tags
   */
  static getNoteType(note: TFile, app: App): NoteType | null {
    const { tags } = this.getFrontMatter(note, app) ?? {};
    if (!tags) return null;
    if (tags.includes(ARTICLE_TAG)) return 'article';
    else if (tags.includes(SNIPPET_TAG)) return 'snippet';
    else if (tags.includes(CARD_TAG)) return 'card';
    else return null;
  }

  /**
   * Check if a file has the ir-source tag
   */
  static isSourceNote(file: TFile, app: App): boolean {
    const { tags } = this.getFrontMatter(file, app) ?? {};
    if (!tags) return false;
    return tags.includes(SOURCE_TAG);
  }

  /**
   * @param directory path relative to the vault root
   */
  static async createNote({
    content,
    frontmatter,
    fileName,
    directory,
    app,
  }: {
    content: string;
    frontmatter?: Record<string, any>;
    fileName: string;
    directory: string;
    app: App;
  }) {
    try {
      const fullPath = normalizePath(`${directory}/${fileName}`);
      const file = await ObsidianHelpers.createFile(app, fullPath);
      await app.vault.append(file, content);
      frontmatter && (await this.updateFrontMatter(file, frontmatter, app));
      return file;
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Shared logic for creating snippets and cards.
   * Throws if it fails to create the file.
   */
  static async createFromText(
    textContent: string,
    directory: string,
    app: App
  ) {
    const newNoteName = ObsidianHelpers.createTitle(textContent);
    const newNote = await this.createNote({
      content: textContent,
      frontmatter: {
        created: new Date().toISOString(),
      },
      fileName: `${newNoteName}.md`,
      directory,
      app,
    });

    if (!newNote) {
      const errorMsg = `Failed to create note "${newNoteName}"`;
      throw new Error(errorMsg);
    }

    return newNote;
  }

  /**
   * Rename a file without moving it
   * @throws if the title contains invalid characters
   * or if the rename operation fails
   */
  static async renameFile(file: TFile, newName: string, app: App) {
    const sanitized = ObsidianHelpers.sanitizeForTitle(newName, true);
    if (sanitized !== newName) {
      throw new Error(`${INVALID_TITLE_MESSAGE}. Title was ${newName}`);
    }

    const newPath = file.parent
      ? `${file.parent.path}/${newName}.${file.extension}`
      : `${newName}.${file.extension}`;

    await app.fileManager.renameFile(file, newPath);
  }

  /** Get the vault absolute directory for a type of review item */
  static getDirectory(type: NoteType) {
    let subDirectory;
    if (type === 'article') subDirectory = ARTICLE_DIRECTORY;
    else if (type === 'snippet') subDirectory = SNIPPET_DIRECTORY;
    else if (type === 'card') subDirectory = CARD_DIRECTORY;
    else throw new TypeError(`Type "${type}" is invalid`);
    return normalizePath(`${DATA_DIRECTORY}/${subDirectory}`);
  }

  /**
   * Generates a link with an absolute path and the file name as alias
   */
  static generateMarkdownLink(
    fileLinkedTo: TFile,
    fileContainingLink: TFile,
    app: App,
    alias?: string,
    subpath?: string
  ) {
    return app.fileManager.generateMarkdownLink(
      fileLinkedTo,
      fileContainingLink.path,
      subpath,
      alias || fileLinkedTo.basename
    );
  }

  static getFrontMatter(
    file: TFile,
    app: App
  ): (PluginFrontMatter & FrontMatterCache) | undefined {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (frontmatter && 'tags' in frontmatter) {
      const { tags } = frontmatter;
      frontmatter.tags = Array.isArray(tags) ? tags : [tags];
    }
    return frontmatter;
  }

  static async updateFrontMatter(
    file: TFile,
    updates: FrontMatterUpdates,
    app: App
  ) {
    await app.fileManager.processFrontMatter(
      file,
      (frontmatter: PluginFrontMatter) => {
        const { tags } = frontmatter;
        const updateTags = Array.isArray(updates.tags)
          ? updates.tags
          : [updates.tags];
        const combinedTags = tags
          ? [...new Set([...tags, ...updateTags])]
          : updateTags;
        Object.assign(frontmatter, {
          ...updates,
          tags: combinedTags,
        });
      }
    );
  }

  /**
   * (WIP) Get the block, bullet list item, or code block the cursor is currently within
   */
  static getCurrentContent(editor: Editor, file: TFile) {
    const cursor = editor.getCursor();
    const block = editor.getLine(cursor.line);

    return { content: block, line: cursor.line };
  }

  /**
   * Get the file associated with the current editor state.
   * Returns null if no file is associated (e.g., in a new unsaved buffer).
   */
  static getFileInfoFromState(state: EditorState): MarkdownFileInfo | null {
    const info = state.field(editorInfoField, false);
    return info ?? null;
  }
}
