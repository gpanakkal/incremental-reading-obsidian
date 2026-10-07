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
  getFrontMatterInfo,
  normalizePath,
  Notice,
  parseYaml,
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
  DIRECTION_MARKS,
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
   * Settles once the metadata cache has nothing left to read: a note's cache
   * then describes its text, and links Obsidian has just rewritten are in it.
   *
   * Undocumented: `MetadataCache.onCleanCache`, which Obsidian's own link
   * updater waits on before it reads links (see `main.ts`).
   */
  static settleMetadataCache(app: App): Promise<void> {
    const { metadataCache } = app;
    if (typeof metadataCache.onCleanCache !== 'function') {
      return Promise.resolve();
    }
    return new Promise((done) => {
      metadataCache.onCleanCache(done);
    });
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
   * ones are dropped so a name always reads as its text, and holds nothing
   * that doesn't show: joiners and variation selectors stay only in the emoji
   * and script sequences that need them (see `keepSequences`). So is half a
   * surrogate pair standing alone, which the file system can't store as it is.
   * Leading whitespace, periods and combining marks are always removed.
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
    const kept = titleChars(Array.from(text.normalize('NFC')))
      .join('')
      // What a dropped character stood between may compose
      .normalize('NFC');
    // Settling a joiner changes only what comes after it, and no two kept
    // joiners stand together, so a name cut to `limit` code points needs no
    // more than twice as many settled. Text built to drop one joiner a round
    // would otherwise cost a round per joiner in it.
    const limit = Math.min(maxLength ?? Infinity, maxBytes ?? Infinity);
    const cleaned = settle(
      Array.from(kept)
        .slice(0, 2 * limit + 2)
        .join('')
    );

    let chars = Array.from(cleaned).slice(0, maxLength);
    if (maxBytes !== undefined) {
      let bytes = 0;
      const fits = chars.findIndex((char) => {
        bytes += UTF8.encode(char).length;
        return bytes > maxBytes;
      });
      if (fits >= 0) chars = chars.slice(0, fits);
    }
    const cut = chars.join('');
    // Nor, when asked, a trailing one, whatever was dropped or cut after it
    const trimmed = checkFinalChar ? cut.replace(/[\s.]+$/, '') : cut;
    // A cut can leave a joiner whose sequence is cut off
    return settle(trimmed);
  }

  /**
   * `text` without the invisible characters a title drops, by the same rules:
   * every default-ignorable or format code point (the bidi embeddings,
   * overrides and isolates, and every tag character, among them) but a joiner
   * or variation selector that a sequence around it needs, and a prepended
   * concatenation mark, which shows. Everything else stays as it is,
   * controls, tabs and newlines included, though a sequence can't build on a
   * control any more than in a title. Half a surrogate pair standing alone
   * becomes U+FFFD, as it would written to a file, first: two halves either
   * side of a dropped character would otherwise join, into a tag character
   * or another invisible one no rule judged.
   *
   * @param keepDirectionMarks keep LRM, RLM and ALM too, where they stand,
   *   but only the last of a run. They only move punctuation and digits at a
   *   change of direction, which right-to-left text sets with them. One
   *   breaks an emoji or keycap sequence, or a selector, it stands in, as it
   *   ends a grapheme cluster: the selector or joiner it breaks off is
   *   dropped (a keycap, which shows, stays). A script's
   *   joiner is judged as though it weren't there.
   */
  static stripInvisible(
    text: string,
    { keepDirectionMarks = false }: { keepDirectionMarks?: boolean } = {}
  ): string {
    // By code point, so a surrogate pair is one character
    const chars = Array.from(text, (char) =>
      isLoneSurrogate(char) ? REPLACEMENT_CHAR : char
    );
    // Judged as in a title, where a control is a space: nothing builds on it
    const kept = keepSequences(
      chars.map((char) => {
        if (CONTROL_TITLE_CHARS.has(char)) return ' ';
        if (keepDirectionMarks && DIRECTION_MARKS.has(char)) return char;
        return invisibleChar(char);
      })
    );
    const out = chars.map((char, i) => (kept[i] === '' ? '' : char));
    // A run of marks keeps its last, which sets the direction it leaves
    out.forEach((char, i) => {
      if (
        DIRECTION_MARKS.has(char) &&
        DIRECTION_MARKS.has(out[nextKept(out, i + 1)])
      ) {
        out[i] = '';
      }
    });
    return out.join('');
  }

  /**
   * Whether `newName` may replace `oldName` as a note's name. It may not be
   * empty, start or end with whitespace or a dot, or hold a forbidden title
   * character. A control or invisible character, a joiner or variation
   * selector outside a sequence that needs it, or a combining mark the name
   * starts with, is refused
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
   * A note's frontmatter properties, read and parsed the way
   * `processFrontMatter` parses them, but without writing the note.
   *
   * `processFrontMatter` is a write: it re-serializes the block after its
   * callback even when nothing changed, so a lookup through it rewrites any
   * frontmatter not in Obsidian's own form (flow lists, quotes, comments),
   * strips an empty block, and can recreate a note deleted between its read and
   * its write. The text comes from `cachedRead`, which the vault keeps current
   * with every write made through it, the plugin's own included, so a note just
   * written reads back as written.
   *
   * Values are as the YAML has them, unchecked against `PluginFrontMatter`.
   * @returns the properties, `{}` when the note has no frontmatter block, its
   *   block holds no mapping, or the file can't have frontmatter (a PDF, say,
   *   which is never read)
   * @throws the read's own error when the note can't be read, and the parser's
   *   when its frontmatter isn't valid YAML
   */
  static async readFrontMatter(
    note: TFile,
    app: App
  ): Promise<Record<string, unknown>> {
    if (!supportsFrontmatter(note)) return {};
    const info = getFrontMatterInfo(await app.vault.cachedRead(note));
    // Equivalent to parsing the empty block it reports, which YAML reads as
    // null, but spares the parser, as Obsidian does
    if (!info.exists) return {};
    // Obsidian's own frontmatter parse is this public pair (read from
    // obsidian.asar: `processFrontMatter` runs `getFrontMatterInfo`, then
    // `parseYaml`, then takes a non-object as `{}`). A list it keeps as is,
    // which names no properties either, so it is `{}` here too
    const parsed: unknown = parseYaml(info.frontmatter);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  /**
   * The note type a frontmatter `tags` value names, the article tag ranking
   * over the snippet tag over the card tag; null when it names none, or isn't a
   * list or a string. A lone string is searched rather than compared, as it
   * always has been, so `ir-article, other` names an article.
   */
  static typeOfTags(tags: unknown): NoteType | null {
    if (!Array.isArray(tags) && typeof tags !== 'string') return null;
    if (tags.includes(ARTICLE_TAG)) return 'article';
    if (tags.includes(SNIPPET_TAG)) return 'snippet';
    if (tags.includes(CARD_TAG)) return 'card';
    return null;
  }

  /**
   * Gets the type of a note based on its tags, without writing the note (see
   * {@link readFrontMatter}).
   *
   * Notes only: a file with no frontmatter, a PDF say, has no tags to go by and
   * is never read, so it answers `null` here even when it is an item. Code that
   * can meet one asks the item layer instead (`ItemManager.getItemType`), which
   * knows such a file by the row at its path.
   *
   * A deleted note has no type either, though the vault may still hold its
   * text: any caller can meet one, as the action bar re-reads its note's type
   * when the delete marks the row. Gone is either no longer the vault's file at
   * its path, or, for a note the vault holds no text for and so reads off the
   * disk, already gone from there: a delete reaches the disk before the vault
   * reports it. A failed read of a note still on disk, or one the disk can't
   * answer for, rejects with the read's own error, and frontmatter that isn't
   * valid YAML with the parser's.
   */
  static async getNoteType(note: TFile, app: App): Promise<NoteType | null> {
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = await this.readFrontMatter(note, app);
    } catch (error) {
      // A disk that can't say is taken to still have it
      const onDisk = await app.vault.adapter
        .exists(note.path)
        .catch(() => true);
      if (!onDisk) return null;
      throw error;
    }
    // Deleted once the vault reports it, though its text may still be cached
    if (app.vault.getFileByPath(note.path) !== note) return null;
    return this.typeOfTags(frontmatter.tags);
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
   * @param content the note's text, or what gives it from the note once it
   *   exists, still empty, and before the text is written to it: its text can
   *   then depend on where the note is, and on its being there
   * @param directory path relative to the vault root
   */
  static async createNote({
    content,
    frontmatter,
    fileName,
    directory,
    app,
  }: {
    content: string | ((file: TFile) => string);
    frontmatter?: PluginFrontMatter;
    fileName: string;
    directory: string;
    app: App;
  }) {
    try {
      const fullPath = normalizePath(`${directory}/${fileName}`);
      const file = await ObsidianHelpers.createFile(app, fullPath);
      await app.vault.append(
        file,
        typeof content === 'string' ? content : content(file)
      );
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
   * Write `updates` into `file`'s frontmatter, after `edit` when given, in
   * the same write. A file with no frontmatter, a PDF say, is left alone.
   * `processFrontMatter` skips anything but `.md` silently too (read from
   * obsidian.asar, not documented), but no caller should rest on that.
   */
  static async updateFrontMatter(
    file: TFile,
    updates:
      | FrontMatterUpdates
      | ((frontmatter: Record<string, unknown>) => void),
    app: App,
    edit?: (frontmatter: Record<string, unknown>) => void
  ) {
    if (!supportsFrontmatter(file)) return;
    if (typeof updates === 'function') {
      await app.fileManager.processFrontMatter(
        file,
        edit
          ? (frontmatter: Record<string, unknown>) => {
              edit(frontmatter);
              updates(frontmatter);
            }
          : updates
      );
    } else {
      await app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          edit?.(frontmatter);
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
 * hyphen, Hangul fillers, CGJ, tag characters and the like) can make a name
 * look blank, or hide text in it.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/**
 * Format characters. Those outside Default_Ignorable can draw as nothing too:
 * Chromium draws none for the interlinear annotation marks (U+FFF9–U+FFFB),
 * and the Egyptian hieroglyph format controls (U+13430–U+1343F) only shape a
 * group of signs, though a font that lacks them draws a box.
 */
const FORMAT = /\p{Cf}/u;
/** A combining mark, which draws on the character before it. */
const MARK = /\p{M}/u;

/**
 * Unicode's prepended concatenation marks (PropList.txt, Unicode 17): format
 * characters that show, as a sign over or before the number after them.
 */
const PREPENDED_CONCATENATION_MARKS = new Set(
  [
    0x600, 0x601, 0x602, 0x603, 0x604, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2,
    0x110bd, 0x110cd,
  ].map((code) => String.fromCodePoint(code))
);

/**
 * Whether `char`, one code point, is a prepended concatenation mark: a format
 * character that shows, so a title keeps it.
 */
export function isPrependedConcatenationMark(char: string) {
  return PREPENDED_CONCATENATION_MARKS.has(char);
}

/** U+FFFD, which stands in for a character that can't be read. */
const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd);

/** ZWNJ or ZWJ: emoji sequences and some scripts join with them. */
export function isJoiner(char: string) {
  const code = char.codePointAt(0);
  return code === 0x200c || code === 0x200d;
}
const ZWJ = String.fromCodePoint(0x200d);

/**
 * A variation selector a title can keep, after a base of its kind: U+FE0E
 * and U+FE0F pick an emoji's text or colour form, and the Mongolian free
 * variation selectors (U+180B–U+180D, U+180F) a Mongolian letter's. The rest
 * pick nothing a name needs: U+FE00–U+FE0D math and CJK compatibility forms,
 * and the ideographic ones (U+E0100–U+E01EF) glyphs most fonts lack, so they
 * mostly draw the bare ideograph.
 */
export function isVariationSelector(char: string) {
  const code = char.codePointAt(0) ?? 0;
  return (
    code === 0xfe0e ||
    code === 0xfe0f ||
    (code >= 0x180b && code <= 0x180d) ||
    code === 0x180f
  );
}
/** U+FE0F, which asks for an emoji's colour form. */
const EMOJI_SELECTOR = String.fromCodePoint(0xfe0f);

/** What a selector of each kind must follow: an emoji, or Mongolian. */
const EMOJI = /\p{Emoji}/u;
const MONGOLIAN = /\p{Script=Mongolian}/u;
/**
 * A keycap's base, which U+FE0E or U+FE0F may follow only before the keycap.
 * A title drops `#` and `*`, but text keeps them.
 */
const KEYCAP_BASE = /[0-9#*]/;

/** A pictograph, which a ZWJ joins to another to make one emoji. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** A pictograph that draws as an emoji with no selector after it. */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
/** A skin tone, and an emoji it colours. */
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const EMOJI_MODIFIER_BASE = /\p{Emoji_Modifier_Base}/u;

/**
 * Whether a title keeps `selector`, a variation selector, between `base` and
 * `next`: a Mongolian one after a Mongolian character (they are Mongolian
 * themselves: one only); U+FE0E or U+FE0F after a digit when a keycap
 * follows, or after an emoji pictograph.
 */
function selectorFits(
  selector: string,
  base: string,
  next: string | undefined
) {
  if (isVariationSelector(base)) return false;
  if ((selector.codePointAt(0) ?? 0) < 0xfe00) return MONGOLIAN.test(base);
  if (KEYCAP_BASE.test(base)) return next === KEYCAP;
  return PICTOGRAPH.test(base) && EMOJI.test(base);
}

/**
 * Whether `char`, with `following` after it, draws as an emoji: a pictograph
 * that does so on its own, or one that U+FE0F after it asks to.
 */
function drawsAsEmoji(char: string, following: string | undefined) {
  return (
    PICTOGRAPH.test(char) &&
    (EMOJI_PRESENTATION.test(char) ||
      (EMOJI.test(char) && following === EMOJI_SELECTOR))
  );
}

/**
 * Viramas: the marks of canonical combining class 9 (DerivedCombiningClass.txt,
 * Unicode 17). A joiner after one picks how the consonants around it join,
 * or, at the end of a word, spells a Malayalam chillu as encoded before
 * Unicode 5.1. JavaScript can't read the class, so they are listed.
 */
const VIRAMAS = new Set(
  [
    0x94d, 0x9cd, 0xa4d, 0xacd, 0xb4d, 0xbcd, 0xc4d, 0xccd, 0xd3b, 0xd3c, 0xd4d,
    0xdca, 0xe3a, 0xeba, 0xf84, 0x1039, 0x103a, 0x1714, 0x1715, 0x1734, 0x17d2,
    0x1a60, 0x1b44, 0x1baa, 0x1bab, 0x1bf2, 0x1bf3, 0x2d7f, 0xa806, 0xa82c,
    0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f, 0x11046, 0x11070, 0x1107f,
    0x110b9, 0x11133, 0x11134, 0x111c0, 0x11235, 0x112ea, 0x1134d, 0x113ce,
    0x113cf, 0x113d0, 0x11442, 0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b,
    0x11839, 0x1193d, 0x1193e, 0x119e0, 0x11a34, 0x11a47, 0x11a99, 0x11c3f,
    0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42, 0x1612f,
  ].map((code) => String.fromCodePoint(code))
);

/**
 * The scripts whose letters a joiner may follow, or the marks on them: the
 * cursive ones (ArabicShaping.txt), and the Brahmic ones, which have a
 * virama. By script, not script extension: that would take in the Latin
 * diacritics and the modifier apostrophe some of these scripts share.
 * Only scripts of Unicode 11 or before: a script name the engine doesn't know is a
 * syntax error, and iOS's JavaScriptCore read Unicode 11 tables until 2022.
 * Text in a later script keeps a joiner after its viramas only.
 */
const JOINING_SCRIPT = new RegExp(
  `[${[
    'Arabic',
    'Syriac',
    'Nko',
    'Mongolian',
    'Mandaic',
    'Manichaean',
    'Psalter_Pahlavi',
    'Phags_Pa',
    'Adlam',
    'Hanifi_Rohingya',
    'Sogdian',
    'Devanagari',
    'Bengali',
    'Gurmukhi',
    'Gujarati',
    'Oriya',
    'Tamil',
    'Telugu',
    'Kannada',
    'Malayalam',
    'Sinhala',
    'Thai',
    'Lao',
    'Tibetan',
    'Myanmar',
    'Tagalog',
    'Hanunoo',
    'Khmer',
    'Tai_Tham',
    'Balinese',
    'Sundanese',
    'Batak',
    'Syloti_Nagri',
    'Saurashtra',
    'Rejang',
    'Javanese',
    'Meetei_Mayek',
    'Kharoshthi',
    'Brahmi',
    'Kaithi',
    'Chakma',
    'Sharada',
    'Khojki',
    'Khudawadi',
    'Grantha',
    'Newa',
    'Tirhuta',
    'Siddham',
    'Modi',
    'Takri',
    'Ahom',
    'Dogra',
    'Zanabazar_Square',
    'Soyombo',
    'Bhaiksuki',
    'Masaram_Gondi',
    'Gunjala_Gondi',
  ]
    .map((script) => `\\p{Script=${script}}`)
    .join('')}]`,
  'u'
);
const LETTER = /\p{L}/u;

/** A letter of a script that joins, which a joiner may follow. */
function isJoiningLetter(char: string) {
  return LETTER.test(char) && JOINING_SCRIPT.test(char);
}

/** The index of the first code point in `chars` from `from` on not dropped. */
function nextKept(chars: readonly string[], from: number) {
  let i = from;
  while (chars[i] === '') i++;
  return i;
}

/** The enclosing keycap, drawn around the character before it. */
const KEYCAP = String.fromCodePoint(0x20e3);

/** Something a joiner can join to: it shows, and isn't a dot. */
function isBase(char: string | undefined) {
  return (
    char !== undefined &&
    !/\s/.test(char) &&
    char !== '.' &&
    !DEFAULT_IGNORABLE.test(char)
  );
}

/**
 * Whether `char`, one code point, shows as nothing and is no part of a
 * sequence a title can keep: a default-ignorable or format character, but a
 * joiner, a variation selector a title can keep, or a prepended concatenation
 * mark. A title drops it wherever it stands.
 */
export function isInvisibleTitleChar(char: string) {
  return (
    (DEFAULT_IGNORABLE.test(char) || FORMAT.test(char)) &&
    !isJoiner(char) &&
    !isVariationSelector(char) &&
    !isPrependedConcatenationMark(char)
  );
}

/**
 * What `char`, one code point, becomes in a title: a space for a control or
 * a forbidden whitespace character, nothing for any other forbidden, invisible
 * or lone-surrogate one, and itself otherwise. Joiners and variation
 * selectors stay, for {@link keepSequences} to judge in context.
 */
function titleChar(char: string) {
  if (FORBIDDEN_TITLE_CHARS.has(char)) {
    // whitespace becomes a space so the words around it stay separated;
    // every other forbidden char is dropped
    return /\s/.test(char) ? ' ' : '';
  }
  if (CONTROL_TITLE_CHARS.has(char)) return ' ';
  if (isLoneSurrogate(char)) return '';
  return invisibleChar(char);
}

/**
 * What `char`, one code point, becomes in text that drops invisible
 * characters: nothing for one {@link isInvisibleTitleChar}, and itself
 * otherwise. Joiners and variation selectors stay, for {@link keepSequences}
 * to judge in context.
 */
function invisibleChar(char: string) {
  return isInvisibleTitleChar(char) ? '' : char;
}

/**
 * `chars`, the code points of a name, as a title has them: each mapped by
 * {@link titleChar} (`''` where dropped), then
 * - a keycap dropped whose base, or the selector after it, was;
 * - what the name would start with dropped, until something that shows and
 *   needs nothing before it: whitespace, dots, combining marks and joiners;
 * - the joiners and variation selectors no sequence keeps dropped
 *   ({@link keepSequences}).
 */
function titleChars(chars: readonly string[]): string[] {
  const mapped = chars.map(titleChar);
  chars.forEach((char, i) => {
    if (char !== KEYCAP) return;
    // `#` and `*` are forbidden: their keycap would draw on the character
    // before them, or start the name on a dotted circle. One that starts the
    // name goes as a leading mark below.
    let base = i - 1;
    while (isVariationSelector(chars[base] ?? '')) base--;
    if (mapped[base] === chars[base]) return;
    // Its selectors go with it, or they would fall to the character before
    for (let j = base + 1; j <= i; j++) mapped[j] = '';
  });
  for (let i = 0; i < mapped.length; i++) {
    const char = mapped[i];
    if (char === '') continue;
    // A leading dot hides the note; a mark or joiner has nothing to draw on
    if (!/[\s.]/.test(char) && !MARK.test(char) && !isJoiner(char)) break;
    mapped[i] = '';
  }
  return keepSequences(mapped);
}

/**
 * `chars`, code points as {@link titleChar} leaves them, with every joiner
 * and variation selector dropped (`''`) that no sequence needs:
 * - U+FE0E or U+FE0F right after an emoji pictograph, or after a digit right
 *   before a keycap;
 * - a Mongolian selector right after a Mongolian character, one only;
 * - a ZWJ between two characters that draw as emoji, the first perhaps
 *   coloured by a skin tone;
 * - a joiner right after a virama, whatever follows it;
 * - a joiner after a letter of a script that joins, or a mark on one, and
 *   before something that shows.
 * A run of joiners keeps one at most.
 *
 * A direction mark (only text keeps one; a title drops them first) breaks an
 * emoji or keycap sequence and any selector, as it ends a grapheme cluster,
 * but a script's joiner is judged as though it weren't there.
 */
function keepSequences(chars: readonly string[]): string[] {
  const kept = [...chars];
  // The last two code points kept, and the last kept that is no mark or
  // joiner: the letter a mark after it sits on
  let prev = '';
  let beforePrev = '';
  let letter = '';
  // The last code point kept that is no direction mark
  let shownPrev = '';
  for (let i = 0; i < kept.length; i++) {
    const char = kept[i];
    // What comes next is the next code point not dropped already: one a later
    // step may still drop, but never a base, so what joins to it is sure
    if (isVariationSelector(char)) {
      if (!selectorFits(char, prev, kept[nextKept(kept, i + 1)])) {
        kept[i] = '';
      }
    } else if (isJoiner(char)) {
      const at = nextKept(kept, i + 1);
      const next = kept[at];
      const emojiBefore =
        drawsAsEmoji(prev, undefined) ||
        (prev === EMOJI_SELECTOR && PICTOGRAPH.test(beforePrev)) ||
        (EMOJI_MODIFIER.test(prev) && EMOJI_MODIFIER_BASE.test(beforePrev));
      const joinsEmoji =
        char === ZWJ &&
        emojiBefore &&
        drawsAsEmoji(next, kept[nextKept(kept, at + 1)]);
      // A mark is judged by its letter: a script's own marks follow its
      // letters, but some it shares with Latin and the like
      const scriptBefore =
        isJoiningLetter(shownPrev) ||
        (MARK.test(shownPrev) && isJoiningLetter(letter));
      let shownNext = at;
      while (DIRECTION_MARKS.has(kept[shownNext])) {
        shownNext = nextKept(kept, shownNext + 1);
      }
      const joinsScript =
        VIRAMAS.has(shownPrev) || (scriptBefore && isBase(kept[shownNext]));
      if (!joinsEmoji && !joinsScript) kept[i] = '';
    }
    if (kept[i] !== '') {
      beforePrev = prev;
      prev = kept[i];
      if (!DIRECTION_MARKS.has(prev)) {
        shownPrev = prev;
        if (!MARK.test(prev) && !isJoiner(prev)) letter = prev;
      }
    }
  }
  return kept;
}

/**
 * `text`, NFC, with the joiners and variation selectors no sequence keeps
 * dropped, and NFC again, until neither changes it: a dropped joiner can
 * leave marks out of canonical order, and putting them in order can move
 * another away from the virama a joiner needs before it.
 */
function settle(text: string) {
  for (;;) {
    const next = keepSequences(Array.from(text)).join('').normalize('NFC');
    if (next === text) return next;
    text = next;
  }
}

/** The code points of `name` that a title drops or changes where they stand. */
function refusedChars(name: string) {
  const chars = Array.from(name);
  const kept = titleChars(chars);
  return chars.filter((char, i) => kept[i] !== char);
}

/** To measure text in UTF-8 bytes, as file systems limit a name. */
const UTF8 = new TextEncoder();
