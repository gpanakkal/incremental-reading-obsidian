import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  type App,
  type DataWriteOptions,
  type Editor,
  type EditorPosition,
  type FrontMatterCache,
  type MarkdownFileInfo,
  type TFile,
  editorEditorField,
  editorInfoField,
  normalizePath,
  Notice,
} from 'obsidian';
import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CARD_DIRECTORY,
  CARD_TAG,
  CONTENT_TITLE_MAX_BYTES,
  CONTENT_TITLE_SLICE_LENGTH,
  CONTROL_TITLE_CHARS,
  DATA_DIRECTORY,
  FORBIDDEN_TITLE_CHARS,
  FRONTMATTER_PATTERN,
  INVALID_TITLE_MESSAGE,
  NOTICE_MIN_DURATION_MS,
  NOTICE_SCALED_DURATION_PER_WORD_MS,
  SNIPPET_DIRECTORY,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  SOURCE_TAG,
} from './constants';
import { Markdown } from './Markdown';
import { isEditableText, supportsFrontmatter } from './mime';
import { parseSourceLink } from './source-link';
import type { FrontMatterUpdates, NoteType, PluginFrontMatter } from './types';
import { binarySearch, generateId } from './utils';

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

  /**
   * Make the folder `path` goes in, unless it is the vault root or exists
   * already: a copy or a new file can't go in a folder that isn't there.
   */
  static async ensureParentFolder(app: App, path: string): Promise<void> {
    const folderPrefixEnd = path.lastIndexOf('/');
    if (folderPrefixEnd < 0) return;
    const folderPath = path.slice(0, folderPrefixEnd);
    if (!app.vault.getAbstractFileByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }
  }

  static async createFile(app: App, absolutePath: string): Promise<TFile> {
    if (app.vault.getAbstractFileByPath(absolutePath)) {
      throw new Error(`File already exists at ${absolutePath}`);
    }

    await this.ensureParentFolder(app, absolutePath);
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
   * or Obsidian note titles. Control characters become a space, and invisible
   * ones are dropped so a name always reads as its text. So is half a
   * surrogate pair standing alone, which the file system can't store as it is.
   * Leading whitespace and periods are always removed.
   *
   * The text is read as NFC, as Obsidian stores a path, so the cuts measure
   * the name the file will have.
   * @param checkFinalChar if true, also removes trailing whitespace and periods
   * @param maxLength the most code points to keep: a cut never splits a pair
   * @param maxBytes the most UTF-8 bytes to keep, cut by whole code points
   */
  static sanitizeForTitle(
    text: string,
    checkFinalChar: boolean,
    maxLength?: number,
    maxBytes?: number
  ) {
    // By code point, so a surrogate pair is one character
    const cleaned = keepSequences(
      Array.from(text.normalize('NFC')).map(titleChar)
    )
      .join('')
      // What a dropped character stood between may compose
      .normalize('NFC')
      // No leading dot, which hides the note, or whitespace, once what came
      // before them is dropped too
      .replace(/^[\s.]+/, '');

    // Nor, when asked, a trailing one, whatever was dropped after it
    const trimmed = checkFinalChar ? cleaned.replace(/[\s.]+$/, '') : cleaned;

    let chars = Array.from(trimmed).slice(0, maxLength);
    if (maxBytes !== undefined) {
      let bytes = 0;
      const fits = chars.findIndex((char) => {
        bytes += UTF8.encode(char).length;
        return bytes > maxBytes;
      });
      if (fits >= 0) chars = chars.slice(0, fits);
    }
    // A cut can leave a joiner, or tags, whose sequence is cut off
    return keepSequences(chars).join('');
  }

  /**
   * Whether `newName` may replace `oldName` as a note's name. It may not be
   * empty, start or end with whitespace or a dot, or hold a forbidden title
   * character. A control or invisible character, or a joiner, variation
   * selector or tag character outside a sequence that needs it, is refused
   * only where the new name adds it: one the old name held already, made
   * before titles refused it, may stay, as many times as the old name had it.
   */
  static isValidRename(newName: string, oldName: string) {
    if (newName === '' || /^[\s.]|[\s.]$/.test(newName)) return false;

    // How many of each character the old name held where a title can't: one
    // a sequence there needed grants nothing, or it could stray in the new
    const allowed = new Map<string, number>();
    for (const char of refusedChars(oldName)) {
      allowed.set(char, (allowed.get(char) ?? 0) + 1);
    }
    for (const char of refusedChars(newName)) {
      // Refused before titles refused controls and invisible characters, so
      // no old name holds one by right: and `\` or `/` would move the note
      if (FORBIDDEN_TITLE_CHARS.has(char)) return false;
      const left = allowed.get(char) ?? 0;
      if (left === 0) return false;
      allowed.set(char, left - 1);
    }
    return true;
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
        Markdown.stripLinks(content),
        false,
        CONTENT_TITLE_SLICE_LENGTH,
        CONTENT_TITLE_MAX_BYTES
      );
      // It never starts with whitespace, so all whitespace leaves it empty
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

  static transcludeLink(
    editor: Editor,
    link: string,
    start: EditorPosition,
    end: EditorPosition
  ) {
    editor.replaceRange(`!${link}`, start, end);
  }

  /** Retrieves a note from the vault given a vault-relative reference */
  static getNote(reference: string, app: App): TFile | null {
    return app.vault.getFileByPath(normalizePath(reference));
  }

  /**
   * Gets the type of a note based on its tags.
   *
   * Notes only: a file with no frontmatter, a PDF say, has no tags to go by and
   * is never read, so it answers `null` here even when it is an item. Code that
   * can meet one asks the item layer instead (`ItemManager.getItemType`), which
   * knows such a file by the row at its path.
   */
  static async getNoteType(note: TFile, app: App): Promise<NoteType | null> {
    if (!supportsFrontmatter(note)) return null;

    let type: NoteType | null = null;
    await app.fileManager.processFrontMatter(
      note,
      (frontmatter: PluginFrontMatter) => {
        if (frontmatter.tags === undefined) type = null;
        else if (frontmatter.tags.includes(ARTICLE_TAG)) type = 'article';
        else if (frontmatter.tags.includes(SNIPPET_TAG)) type = 'snippet';
        else if (frontmatter.tags.includes(CARD_TAG)) type = 'card';
      }
    );
    return type;
  }

  /**
   * The link target of a wikilink or a markdown link, stripped of its alias
   * and any subpath. Anything else is returned as-is, which is what a bare
   * path — hand-written, or left behind by an older version — needs.
   */
  static parseLinkTarget(link: string): string {
    const wikilink = link.match(/\[\[([^\]|#]+)/)?.[1];
    if (wikilink) return wikilink.trim();

    const markdown = link.match(/\]\(<?([^)>]+)>?\)/)?.[1];
    if (markdown) {
      return decodeURIComponent(markdown.split('#')[0]).trim();
    }

    return link.trim();
  }

  /**
   * The note a `source` property points at, or null when the property is
   * missing or resolves nowhere — an external URL, say, or a link to a note
   * that has since been deleted.
   *
   * This is the plugin's own record of where an item came from, written when
   * the item was created. Prefer it over `metadataCache.resolvedLinks` for
   * provenance: the link index is rebuilt asynchronously and need not have
   * caught up with a note written moments ago.
   */
  static getSourceFile(file: TFile, app: App): TFile | null {
    const source = this.getFrontMatter(file, app)?.[SOURCE_PROPERTY_NAME];
    if (typeof source !== 'string') return null;
    // A link as the plugin writes one, or failing that, whatever it holds
    const linkPath = parseSourceLink(source)?.path.trim();
    return app.metadataCache.getFirstLinkpathDest(
      linkPath ?? this.parseLinkTarget(source),
      file.path
    );
  }

  /**
   * Whether the metadata cache has the `source` link of the note `note`
   * resolving to `file` (see {@link getSourceFile}): how an item taken from a
   * file that is no item is known to be that file's.
   */
  static sourceIs(note: TFile, file: TFile, app: App): boolean {
    return this.getSourceFile(note, app)?.path === file.path;
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
    frontmatter?: PluginFrontMatter;
    fileName: string;
    directory: string;
    app: App;
  }) {
    try {
      const fullPath = normalizePath(`${directory}/${fileName}`);
      const file = await ObsidianHelpers.createFile(app, fullPath);
      await app.vault.append(file, content);
      if (frontmatter) {
        await this.updateFrontMatter(file, frontmatter, app);
      }
      return file;
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Shared logic for creating items from (possibly empty) text.
   * Throws if it fails to create the file.
   *
   * @param titleText the text to name the note after, when not `textContent`
   *   itself: the text as it reads, say, when `textContent` is escaped.
   */
  static async createFromText(
    textContent: string,
    directory: string,
    app: App,
    titleText?: string
  ) {
    const newNoteName = ObsidianHelpers.createTitle(titleText ?? textContent);
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
   * Atomically modify a note, resolving to its new text. A file that isn't
   * text, a PDF say, is left alone and resolves to `null`: text written over
   * one corrupts it.
   */
  static async editNote(
    app: App,
    file: TFile,
    fn: (data: string) => string,
    options?: DataWriteOptions
  ): Promise<string | null> {
    if (!isEditableText(file)) return null;
    return app.vault.process(file, fn, options);
  }

  /**
   * Rename a file without moving it
   * @throws if the new name adds characters a title can't hold (see
   * {@link isValidRename})
   * or if the rename operation fails
   */
  static async renameFile(file: TFile, newName: string, app: App) {
    if (!ObsidianHelpers.isValidRename(newName, file.basename)) {
      throw new Error(`${INVALID_TITLE_MESSAGE}. Title was ${newName}`);
    }

    await this.restoreName(file, newName, app);
  }

  /**
   * Rename a file without moving it, unchecked: to put back a name it had,
   * which may be one a new note could no longer take.
   * @throws if the name holds `/` or `\`, which would move the note
   */
  static async restoreName(file: TFile, name: string, app: App) {
    // Obsidian's normalizePath reads `\` as `/`: either would move the note
    // to another folder, or out of the vault
    if (/[\\/]/.test(name)) {
      throw new Error(`${INVALID_TITLE_MESSAGE}. Title was ${name}`);
    }
    // The vault root's path is `/`, and a file there has no folder to prefix.
    const newPath =
      file.parent && file.parent.path !== '/'
        ? `${file.parent.path}/${name}.${file.extension}`
        : `${name}.${file.extension}`;

    await app.fileManager.renameFile(file, newPath);
  }

  /** Get the vault absolute directory for a type of review item */
  static getDirectory(type: NoteType) {
    let subDirectory;
    if (type === 'article') subDirectory = ARTICLE_DIRECTORY;
    else if (type === 'snippet') subDirectory = SNIPPET_DIRECTORY;
    else if (type === 'card') subDirectory = CARD_DIRECTORY;
    return normalizePath(`${DATA_DIRECTORY}/${subDirectory}`);
  }

  static getTargetPath(fileName: string, noteType: NoteType) {
    const dir = this.getDirectory(noteType);
    return normalizePath(`${dir}/${fileName}`);
  }

  static findEmbeds(app: App, parent: TFile, target: TFile) {
    const { metadataCache } = app;
    const embeds = metadataCache.getFileCache(parent)?.embeds;
    if (!embeds) return null;
    const match = embeds.find((embed) => {
      const linkPath = metadataCache.getFirstLinkpathDest(
        embed.link,
        parent.path
      )?.path;
      return linkPath === target.path;
    });
    return match ?? null;
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

  /**
   * Adds tags to a note's raw frontmatter `tags` value. Obsidian takes a lone
   * string or a list there, and YAML reads an empty `tags:` or `- ` entry as
   * null, so empty entries are dropped (which also cleans nulls earlier writes
   * left behind) and duplicates removed. Every other entry keeps its exact form.
   */
  static _mergeTags(existing: unknown, added: string | string[]): unknown[] {
    const toList = (value: unknown): unknown[] =>
      Array.isArray(value) ? value : [value];
    const merged = [...toList(existing), ...toList(added)].filter(
      (tag: unknown) =>
        tag !== null &&
        tag !== undefined &&
        !(typeof tag === 'string' && tag.trim() === '')
    );
    return [...new Set(merged)];
  }

  /**
   * Write `updates` into `file`'s frontmatter. A file with no frontmatter, a
   * PDF say, is left alone. `processFrontMatter` skips anything but `.md`
   * silently too (read from obsidian.asar, not documented), but no caller
   * should rest on that.
   */
  static async updateFrontMatter(
    file: TFile,
    updates:
      | FrontMatterUpdates
      | ((frontmatter: Record<string, unknown>) => void),
    app: App
  ) {
    if (!supportsFrontmatter(file)) return;
    if (typeof updates === 'function') {
      await app.fileManager.processFrontMatter(file, updates);
    } else {
      await app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          const { tags, ...rest } = updates;
          Object.assign(frontmatter, rest);
          // An update without tags leaves the note's tags as they are
          if (tags !== undefined) {
            frontmatter.tags = this._mergeTags(frontmatter.tags, tags);
          }
        }
      );
    }
  }

  /**
   * Get the line the cursor is currently in,
   * subtracting leading bullet points
   * TODO: handle multi-line formatting
   */
  static smartGetline(editor: Editor, file: TFile, app: App) {
    const cursor = editor.getCursor();
    const block = this.getCurrentLine(editor);
    // check if we're in a bullet list
    const listItems = app.metadataCache.getFileCache(file)?.listItems;
    const defaultReturn = {
      line: block.line,
      lineNumber: block.lineNumber,
      start: 0,
      end: block.line.length,
    };
    if (!listItems) {
      return defaultReturn;
    }
    const matchingBullet = binarySearch(listItems, (item) => {
      const { start, end } = item.position;
      if (block.lineNumber < start.line) return -1;
      if (block.lineNumber > end.line) return 1;
      return 0;
    });

    if (!matchingBullet) return defaultReturn;
    const withoutBullet = Markdown.getListItemText(block.line);
    const newStart = block.line.length - withoutBullet.length;
    return {
      line: withoutBullet,
      lineNumber: cursor.line,
      start: newStart,
      end: block.line.length,
    };
  }

  /**
   * Get the line the cursor is currently in
   */
  static getCurrentLine(editor: Editor) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);

    return { line, lineNumber: cursor.line };
  }

  /**
   * Get the file associated with the current editor state.
   * Returns null if no file is associated (e.g., in a new unsaved buffer).
   */
  static getFileInfoFromState(state: EditorState): {
    info: MarkdownFileInfo | null;
    editorView: EditorView | null;
  } {
    const info = state.field(editorInfoField, false);
    const editorView = state.field(editorEditorField, false);
    return { info: info ?? null, editorView: editorView ?? null };
  }

  static inEditMode(document: Document): boolean {
    const el = document.activeElement as HTMLElement | null;
    return !!(
      el &&
      (el.isContentEditable ||
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA')
    );
  }

  /**
   * Create an Obsidian Notice, scaling the visibility duration to the number
   * of words in the message.
   */
  static notify(message: string, persist?: boolean) {
    const wordCount = message.split(' ').length;
    const duration = Math.max(
      NOTICE_MIN_DURATION_MS,
      wordCount * NOTICE_SCALED_DURATION_PER_WORD_MS
    );
    new Notice(message, persist ? 0 : duration);
  }
}

/**
 * Whether `char`, a code point as `Array.from` splits text, is half a
 * surrogate pair standing alone.
 */
function isLoneSurrogate(char: string) {
  const code = char.charCodeAt(0);
  return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
}

/**
 * Default-ignorable code points, which show as nothing. Among them are the
 * bidi controls (U+202A–U+202E, U+2066–U+2069) and the implicit marks LRM, RLM
 * and ALM, which reorder how a name reads: `report`, U+202E, `fdp.exe` shows
 * as `reportexe.pdf`, and `1`, RLM, `-`, RLM, `2` as `12-`. The rest (soft
 * hyphen, Hangul fillers, CGJ and the like) can make a name look blank, or
 * hide text in it.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** ZWNJ or ZWJ: emoji sequences and some scripts join with them. */
function isJoiner(char: string) {
  const code = char.codePointAt(0);
  return code === 0x200c || code === 0x200d;
}

/**
 * A variation selector, standard (U+FE00–U+FE0F) or ideographic
 * (U+E0100–U+E01EF), or a Mongolian free variation selector: each picks a
 * form of the character before it, an emoji's colour one among them.
 */
function isVariationSelector(char: string) {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    (code >= 0x180b && code <= 0x180d) ||
    code === 0x180f
  );
}

/** A tag character, which spells out a flag after the black flag emoji. */
function isTag(char: string) {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0xe0020 && code <= 0xe007e;
}
/** The black flag emoji, which a tag sequence turns into a region's flag. */
const BLACK_FLAG = String.fromCodePoint(0x1f3f4);
/** The cancel tag, which ends a tag sequence. */
const CANCEL_TAG = String.fromCodePoint(0xe007f);

/** Something a sequence can build on: it shows, and isn't a dot. */
function isBase(char: string) {
  return (
    char !== '' &&
    !/\s/.test(char) &&
    char !== '.' &&
    !DEFAULT_IGNORABLE.test(char)
  );
}

/**
 * What `char`, one code point, becomes in a title: a space for a control or
 * a forbidden whitespace character, nothing for any other forbidden, invisible
 * or lone-surrogate one, and itself otherwise. Joiners, variation selectors
 * and tag characters stay, for {@link keepSequences} to judge in context.
 */
function titleChar(char: string) {
  if (FORBIDDEN_TITLE_CHARS.has(char)) {
    // whitespace becomes a space so the words around it stay separated;
    // every other forbidden char is dropped
    return /\s/.test(char) ? ' ' : '';
  }
  if (CONTROL_TITLE_CHARS.has(char)) return ' ';
  if (isLoneSurrogate(char)) return '';
  if (
    isJoiner(char) ||
    isVariationSelector(char) ||
    isTag(char) ||
    char === CANCEL_TAG
  ) {
    return char;
  }
  if (DEFAULT_IGNORABLE.test(char)) return '';
  return char;
}

/**
 * `chars`, code points as {@link titleChar} leaves them, with every joiner,
 * variation selector and tag character dropped (`''`) that no sequence needs:
 * - a variation selector right after something that shows, one only;
 * - a joiner between something that shows and the next that does, one only;
 * - tag characters after the black flag, ended by the cancel tag.
 */
function keepSequences(chars: readonly string[]): string[] {
  const kept = [...chars];
  let prev = '';
  // Where the code point a joiner joins to is: it only moves on, so a run of
  // joiners costs no more than the text
  let scan = 0;
  for (let i = 0; i < kept.length; i++) {
    const char = kept[i];
    if (char === BLACK_FLAG) {
      let end = i + 1;
      while (end < kept.length && isTag(kept[end])) end++;
      if (end > i + 1 && kept[end] === CANCEL_TAG) {
        prev = CANCEL_TAG;
        i = end;
        continue;
      }
    } else if (isVariationSelector(char)) {
      if (!isBase(prev)) kept[i] = '';
    } else if (isJoiner(char)) {
      const joinsOn =
        prev !== '' && !/\s/.test(prev) && prev !== '.' && !isJoiner(prev);
      // The next code point not dropped already, past this one
      while (scan <= i || kept[scan] === '') scan++;
      if (!joinsOn || !isBase(kept[scan] ?? '')) kept[i] = '';
    } else if (isTag(char) || char === CANCEL_TAG) {
      kept[i] = '';
    }
    if (kept[i] !== '') prev = kept[i];
  }
  return kept;
}

/** The code points of `name` that a title drops or changes where they stand. */
function refusedChars(name: string) {
  const chars = Array.from(name);
  const kept = keepSequences(chars.map(titleChar));
  return chars.filter((char, i) => kept[i] !== char);
}

/** To measure text in UTF-8 bytes, as file systems limit a name. */
const UTF8 = new TextEncoder();
