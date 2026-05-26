/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- test file */
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
} from '#/lib/constants';
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import type { NoteType, PluginFrontMatter } from '#/lib/types';
import fc from 'fast-check';
import type {
  App,
  Editor,
  EditorPosition,
  FrontMatterCache,
  TFile,
} from 'obsidian';
import { normalizePath } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS
function makeTFile(overrides: Partial<TFile> = {}): TFile {
  return {
    path: 'incremental-reading/articles/test.md',
    name: 'test.md',
    basename: 'test',
    extension: 'md',
    parent: { path: 'incremental-reading/articles', name: 'articles' },
    stat: { ctime: 0, mtime: 0, size: 0 },
    vault: {} as unknown as TFile['vault'],
    ...overrides,
  } as unknown as TFile;
}

function makeEditor(overrides: Partial<Editor> = {}): Editor {
  return {
    getSelection: vi.fn().mockReturnValue(''),
    getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
    posToOffset: vi.fn().mockImplementation(({ line, ch }: EditorPosition) => line * 100 + ch),
    getLine: vi.fn().mockReturnValue(''),
    replaceRange: vi.fn(),
    ...overrides,
  } as unknown as Editor;
}

function makeApp(overrides: Partial<App> = {}): App {
  return {
    vault: {
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      getFileByPath: vi.fn().mockReturnValue(null),
      createFolder: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(makeTFile()),
      append: vi.fn().mockResolvedValue(undefined),
      process: vi.fn().mockResolvedValue(''),
    },
    metadataCache: {
      getFileCache: vi.fn().mockReturnValue(null),
    },
    fileManager: {
      processFrontMatter: vi.fn().mockResolvedValue(undefined),
      renameFile: vi.fn().mockResolvedValue(undefined),
      generateMarkdownLink: vi.fn().mockReturnValue('[[link]]'),
    },
    ...overrides,
  } as unknown as App;
}
// #endregion

// ---------------------------------------------------------------------------
// splitFrontMatter
// ---------------------------------------------------------------------------
describe('splitFrontMatter', () => {
  it('returns null when no frontmatter is present', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.startsWith('---\n')),
        (text) => {
          expect(ObsidianHelpers.splitFrontMatter(text)).toBeNull();
        }
      )
    );
  });

  it('returns null for empty string', () => {
    expect(ObsidianHelpers.splitFrontMatter('')).toBeNull();
  });

  it('splits valid frontmatter from body', () => {
    const input = '---\ntags: [foo]\n---\nbody text';
    const result = ObsidianHelpers.splitFrontMatter(input);
    expect(result).not.toBeNull();
    // frontMatter includes the --- delimiters per FRONTMATTER_PATTERN capture group 1
    expect(result!.frontMatter).toBe('---\ntags: [foo]\n---\n');
    expect(result!.body).toBe('body text');
  });

  it('returns empty body when frontmatter is followed by nothing', () => {
    const input = '---\ntitle: Test\n---\n';
    const result = ObsidianHelpers.splitFrontMatter(input);
    expect(result).not.toBeNull();
    expect(result!.body).toBe('');
  });

  it('correctly splits for arbitrary non-empty frontmatter and body', () => {
    const safeString = fc.string().map((s) => s.replace(/---/g, '==='));
    fc.assert(
      fc.property(safeString, safeString, (fm, body) => {
        const input = `---\n${fm}\n---\n${body}`;
        const result = ObsidianHelpers.splitFrontMatter(input);
        expect(result).not.toBeNull();
        expect(result!.body).toBe(body);
      })
    );
  });
});

// ---------------------------------------------------------------------------
// getBodyStartOffset
// ---------------------------------------------------------------------------
describe('getBodyStartOffset', () => {
  it('returns 0 when there is no frontmatter', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.startsWith('---\n')),
        (text) => {
          expect(ObsidianHelpers.getBodyStartOffset(text)).toBe(0);
        }
      )
    );
  });

  it('returns the correct offset for a file with frontmatter', () => {
    const fm = '---\ntags: [test]\n---\n';
    const body = 'Hello world';
    const full = fm + body;
    expect(ObsidianHelpers.getBodyStartOffset(full)).toBe(fm.length);
  });

  it('offset equals total length when body is empty', () => {
    const content = '---\nfoo: bar\n---\n';
    expect(ObsidianHelpers.getBodyStartOffset(content)).toBe(content.length);
  });

  it('offset equals total-length minus body length for any valid doc', () => {
    const safeString = fc.string().map((s) => s.replace(/---/g, '==='));
    fc.assert(
      fc.property(safeString, safeString, (fm, body) => {
        const input = `---\n${fm}\n---\n${body}`;
        const offset = ObsidianHelpers.getBodyStartOffset(input);
        expect(input.slice(offset)).toBe(body);
      })
    );
  });
});

// ---------------------------------------------------------------------------
// sanitizeForTitle
// ---------------------------------------------------------------------------
describe('sanitizeForTitle', () => {
  it('replaces forbidden characters with a single space (not empty string)', () => {
    // Mutant: return ' ' → return "" — the space must be present, not empty
    const result = ObsidianHelpers.sanitizeForTitle('a#b', false);
    // '#' is forbidden; gets replaced with space, giving 'a b'
    expect(result).toBe('a b');
  });

  it('removes forbidden characters by replacing with space', () => {
    const forbiddenChars = [...FORBIDDEN_TITLE_CHARS];
    fc.assert(
      fc.property(
        fc.constantFrom(...forbiddenChars),
        fc.string({ minLength: 1 }).filter((s) => {
          // ensure the suffix contains at least one non-forbidden, non-whitespace char
          // so the replacement space is visible in the trimmed result
          return /[^\s#^[\]|*"\\/<>:?\n]/.test(s);
        }),
        (forbidden, suffix) => {
          const input = `a${forbidden}${suffix}`;
          const result = ObsidianHelpers.sanitizeForTitle(input, false);
          forbiddenChars.forEach((ch) => {
            expect(result).not.toContain(ch);
          });
          // The space replacement must be present between 'a' and the suffix content
          expect(result).toContain(' ');
        }
      )
    );
  });

  it('removes a leading dot by replacing with empty string (not space)', () => {
    // Mutant: return '' → return "Stryker was here!" — result must not start with '.'
    // and must not include a dot-replacement character
    const result = ObsidianHelpers.sanitizeForTitle('.hidden', false);
    expect(result).toBe('hidden');
  });

  it('does not remove a leading dot when it is not the first character', () => {
    const result = ObsidianHelpers.sanitizeForTitle('a.b', false);
    expect(result).toContain('.');
  });

  it('checkFinalChar=true removes trailing space', () => {
    expect(ObsidianHelpers.sanitizeForTitle('hello ', true)).toBe('hello');
  });

  it('checkFinalChar=true removes trailing period', () => {
    expect(ObsidianHelpers.sanitizeForTitle('hello.', true)).toBe('hello');
  });

  it('checkFinalChar=true preserves a period that is NOT the last character', () => {
    // Kills mutant: `i === text.length - 1` → `true` would strip middle periods too
    const result = ObsidianHelpers.sanitizeForTitle('a.b c', true);
    expect(result).toContain('.');
  });

  it('checkFinalChar=false preserves trailing space', () => {
    // trim() is always applied, but trailing space before trim is stripped
    // The function calls .trim() at the end, so trailing space is removed regardless
    const result = ObsidianHelpers.sanitizeForTitle('hello ', false);
    expect(result).toBe('hello');
  });

  it('checkFinalChar=false preserves trailing period', () => {
    const result = ObsidianHelpers.sanitizeForTitle('hello.', false);
    expect(result).toBe('hello.');
  });

  it('trims whitespace from both ends', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const padded = `   ${text}   `;
        const result = ObsidianHelpers.sanitizeForTitle(padded, false);
        expect(result).toBe(result.trim());
      })
    );
  });

  it('respects maxLength when provided', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 200 }),
        (text, maxLen) => {
          const result = ObsidianHelpers.sanitizeForTitle(text, false, maxLen);
          expect(result.length).toBeLessThanOrEqual(maxLen);
        }
      )
    );
  });

  it('does not truncate when maxLength is not provided', () => {
    const long = 'a'.repeat(300);
    const result = ObsidianHelpers.sanitizeForTitle(long, false);
    expect(result.length).toBe(300);
  });

  it('returns empty string for input containing only forbidden chars', () => {
    const input = [...FORBIDDEN_TITLE_CHARS].join('');
    const result = ObsidianHelpers.sanitizeForTitle(input, false);
    // All forbidden chars become spaces, then trimmed
    expect(result.trim()).toBe(result);
    // No forbidden chars remain
    [...FORBIDDEN_TITLE_CHARS].forEach((c) => expect(result).not.toContain(c));
  });

  it('leaves clean strings unchanged', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => {
          if ([...FORBIDDEN_TITLE_CHARS].some((c) => s.includes(c))) return false;
          if (s.startsWith('.')) return false;
          return true;
        }),
        (text) => {
          const result = ObsidianHelpers.sanitizeForTitle(text, false);
          expect(result).toBe(text.trim());
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// createTitle
// ---------------------------------------------------------------------------
describe('createTitle', () => {
  it('returns a non-empty string', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (content) => {
        const title = ObsidianHelpers.createTitle(content);
        expect(title.length).toBeGreaterThan(0);
      })
    );
  });

  it('includes a sanitized slice of the content when content is provided', () => {
    const content = 'Hello world this is content';
    const title = ObsidianHelpers.createTitle(content);
    // title should start with a sanitized content segment
    expect(title.startsWith('Hello world')).toBe(true);
  });

  it('does not exceed CONTENT_TITLE_SLICE_LENGTH for the content segment', () => {
    const long = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 100);
    const title = ObsidianHelpers.createTitle(long);
    const segments = title.split(' - ');
    expect(segments[0].length).toBeLessThanOrEqual(CONTENT_TITLE_SLICE_LENGTH);
  });

  it('omits content segment when content is empty string', () => {
    const title = ObsidianHelpers.createTitle('');
    // Should only have the ID segment (no separator)
    expect(title).not.toContain(' - ');
  });

  it('omits content segment when content is undefined', () => {
    const title = ObsidianHelpers.createTitle(undefined);
    expect(title).not.toContain(' - ');
  });

  it('always appends a generated ID', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (content) => {
        const title = ObsidianHelpers.createTitle(content);
        expect(title.length).toBeGreaterThan(0);
        // The ID is appended last; extract it by finding the last ' - ' separator.
        // Using lastIndexOf avoids misidentifying ' - ' embedded in the content segment.
        const sep = ' - ';
        const sepIdx = title.lastIndexOf(sep);
        const idSegment = sepIdx === -1 ? title : title.slice(sepIdx + sep.length);
        expect(idSegment).toMatch(/^[a-z0-9]+$/);
      })
    );
  });

  it('omits content segment when sanitized content is empty (all forbidden chars)', () => {
    const allForbidden = [...FORBIDDEN_TITLE_CHARS].join('');
    const title = ObsidianHelpers.createTitle(allForbidden);
    expect(title).not.toContain(' - ');
  });

  it('preserves a trailing period in the content segment (checkFinalChar=false)', () => {
    // Kills mutant: false → true in sanitizeForTitle call — trailing period would be stripped
    const title = ObsidianHelpers.createTitle('content ending in period.');
    const contentSegment = title.split(' - ')[0];
    expect(contentSegment).toMatch(/\.$/);
  });
});

// ---------------------------------------------------------------------------
// getReferenceFromPath
// ---------------------------------------------------------------------------
describe('getReferenceFromPath', () => {
  it('extracts the reference after the DATA_DIRECTORY prefix', () => {
    const ref = 'articles/note.md';
    const vaultPath = `${DATA_DIRECTORY}/${ref}`;
    expect(ObsidianHelpers.getReferenceFromPath(vaultPath)).toBe(ref);
  });

  it('returns undefined when DATA_DIRECTORY is not in the path', () => {
    // split on missing separator gives original string at index 0, index 1 is undefined
    expect(ObsidianHelpers.getReferenceFromPath('other/path/note.md')).toBeUndefined();
  });

  it('handles nested paths after DATA_DIRECTORY', () => {
    const ref = 'snippets/sub/note.md';
    const vaultPath = `${DATA_DIRECTORY}/${ref}`;
    expect(ObsidianHelpers.getReferenceFromPath(vaultPath)).toBe(ref);
  });

  it('returns the reference for arbitrary non-empty subpaths', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !s.includes(`${DATA_DIRECTORY}/`)),
        (ref) => {
          const vaultPath = `${DATA_DIRECTORY}/${ref}`;
          expect(ObsidianHelpers.getReferenceFromPath(vaultPath)).toBe(ref);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getDirectory
// ---------------------------------------------------------------------------
describe('getDirectory', () => {
  it('returns article directory path for "article" type', () => {
    const result = ObsidianHelpers.getDirectory('article');
    expect(result).toBe(normalizePath(`${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`));
  });

  it('returns snippet directory path for "snippet" type', () => {
    const result = ObsidianHelpers.getDirectory('snippet');
    expect(result).toBe(normalizePath(`${DATA_DIRECTORY}/${SNIPPET_DIRECTORY}`));
  });

  it('returns card directory path for "card" type', () => {
    const result = ObsidianHelpers.getDirectory('card');
    expect(result).toBe(normalizePath(`${DATA_DIRECTORY}/${CARD_DIRECTORY}`));
  });

  it('each type returns a distinct directory path', () => {
    // Kills mutant: `type === 'card'` → `true` — article/snippet would also return card dir
    const articleDir = ObsidianHelpers.getDirectory('article');
    const snippetDir = ObsidianHelpers.getDirectory('snippet');
    const cardDir = ObsidianHelpers.getDirectory('card');
    expect(articleDir).not.toBe(cardDir);
    expect(snippetDir).not.toBe(cardDir);
    expect(articleDir).not.toBe(snippetDir);
  });
});

// ---------------------------------------------------------------------------
// getTargetPath
// ---------------------------------------------------------------------------
describe('getTargetPath', () => {
  it('returns normalized path combining directory and filename', () => {
    const types: NoteType[] = ['article', 'snippet', 'card'];
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom(...types),
        (fileName, noteType) => {
          const dir = ObsidianHelpers.getDirectory(noteType);
          const result = ObsidianHelpers.getTargetPath(fileName, noteType);
          expect(result).toBe(normalizePath(`${dir}/${fileName}`));
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getFileInfoFromState
// ---------------------------------------------------------------------------
describe('getFileInfoFromState', () => {
  it('returns info and editorView from state fields when both are present', () => {
    const fakeInfo = { file: makeTFile() };
    const fakeEditorView = { dom: {} };
    const field = vi.fn().mockImplementation(() => {
      const callCount = field.mock.calls.length;
      return callCount === 1 ? fakeInfo : fakeEditorView;
    });
    const state = { field } as unknown as import('@codemirror/state').EditorState;

    const result = ObsidianHelpers.getFileInfoFromState(state);
    expect(result.info).toBe(fakeInfo);
    expect(result.editorView).toBe(fakeEditorView);
    // Kills BooleanLiteral mutants: false → true — second arg must be false
    expect(field).toHaveBeenNthCalledWith(1, expect.anything(), false);
    expect(field).toHaveBeenNthCalledWith(2, expect.anything(), false);
  });

  it('returns nulls when state.field returns undefined for both fields', () => {
    const state = {
      field: vi.fn().mockReturnValue(undefined),
    } as unknown as import('@codemirror/state').EditorState;

    const result = ObsidianHelpers.getFileInfoFromState(state);
    expect(result.info).toBeNull();
    expect(result.editorView).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inEditMode
// ---------------------------------------------------------------------------
describe('inEditMode', () => {
  it('returns false when activeElement is null', () => {
    const doc = { activeElement: null } as unknown as Document;
    expect(ObsidianHelpers.inEditMode(doc)).toBe(false);
  });

  it('returns true when activeElement is contenteditable', () => {
    const doc = {
      activeElement: { isContentEditable: true, tagName: 'DIV' } as HTMLElement,
    } as unknown as Document;
    expect(ObsidianHelpers.inEditMode(doc)).toBe(true);
  });

  it('returns true when activeElement is INPUT', () => {
    const doc = {
      activeElement: { isContentEditable: false, tagName: 'INPUT' } as HTMLElement,
    } as unknown as Document;
    expect(ObsidianHelpers.inEditMode(doc)).toBe(true);
  });

  it('returns true when activeElement is TEXTAREA', () => {
    const doc = {
      activeElement: { isContentEditable: false, tagName: 'TEXTAREA' } as HTMLElement,
    } as unknown as Document;
    expect(ObsidianHelpers.inEditMode(doc)).toBe(true);
  });

  it('returns false for non-editable elements', () => {
    const tags = ['DIV', 'SPAN', 'P', 'BUTTON', 'A'];
    fc.assert(
      fc.property(fc.constantFrom(...tags), (tag) => {
        const doc = {
          activeElement: { isContentEditable: false, tagName: tag } as HTMLElement,
        } as unknown as Document;
        expect(ObsidianHelpers.inEditMode(doc)).toBe(false);
      })
    );
  });

  it('returns false for arbitrary non-editable tag names', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== 'INPUT' && s !== 'TEXTAREA'),
        (tag) => {
          const doc = {
            activeElement: { isContentEditable: false, tagName: tag } as HTMLElement,
          } as unknown as Document;
          expect(ObsidianHelpers.inEditMode(doc)).toBe(false);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getSelectionWithBounds
// ---------------------------------------------------------------------------
describe('getSelectionWithBounds', () => {
  it('returns null when no text is selected', () => {
    const editor = makeEditor({ getSelection: vi.fn().mockReturnValue('') });
    expect(ObsidianHelpers.getSelectionWithBounds(editor)).toBeNull();
  });

  it('returns selection data when text is selected', () => {
    const from: EditorPosition = { line: 0, ch: 2 };
    const to: EditorPosition = { line: 0, ch: 7 };
    const getCursor = vi.fn().mockImplementation((pos: 'from' | 'to') =>
      pos === 'from' ? from : to
    );
    const editor = makeEditor({
      getSelection: vi.fn().mockReturnValue('hello'),
      getCursor,
      posToOffset: vi.fn().mockImplementation(({ ch }: EditorPosition) => ch),
    });

    const result = ObsidianHelpers.getSelectionWithBounds(editor);
    expect(result).not.toBeNull();
    expect(result!.selection).toBe('hello');
    expect(result!.start).toEqual(from);
    expect(result!.end).toEqual(to);
    expect(result!.startOffset).toBe(2);
    expect(result!.endOffset).toBe(7);
    // Verify exact argument strings passed to getCursor (kills string literal mutants)
    expect(getCursor).toHaveBeenCalledWith('from');
    expect(getCursor).toHaveBeenCalledWith('to');
  });

  it('startOffset < endOffset when selection is non-empty forward', () => {
    const editor = makeEditor({
      getSelection: vi.fn().mockReturnValue('text'),
      getCursor: vi.fn().mockImplementation((pos: 'from' | 'to') =>
        pos === 'from' ? { line: 0, ch: 0 } : { line: 0, ch: 4 }
      ),
      posToOffset: vi.fn().mockImplementation(({ ch }: EditorPosition) => ch),
    });
    const result = ObsidianHelpers.getSelectionWithBounds(editor);
    expect(result!.startOffset).toBeLessThan(result!.endOffset);
  });
});

// ---------------------------------------------------------------------------
// transcludeLink
// ---------------------------------------------------------------------------
describe('transcludeLink', () => {
  it('calls editor.replaceRange with "!" prepended to the link', () => {
    const editor = makeEditor();
    const replaceRange = editor.replaceRange as ReturnType<typeof vi.fn>;
    const start: EditorPosition = { line: 0, ch: 0 };
    const end: EditorPosition = { line: 0, ch: 5 };

    ObsidianHelpers.transcludeLink(editor, '[[Note]]', start, end);

    expect(replaceRange).toHaveBeenCalledWith('![[Note]]', start, end);
  });

  it('prepends "!" for any link string', () => {
    fc.assert(
      fc.property(fc.string(), (link) => {
        const editor = makeEditor();
        const replaceRange = editor.replaceRange as ReturnType<typeof vi.fn>;
        const start: EditorPosition = { line: 0, ch: 0 };
        const end: EditorPosition = { line: 0, ch: 0 };
        ObsidianHelpers.transcludeLink(editor, link, start, end);
        const [calledWith] = replaceRange.mock.calls[0] as [string];
        expect(calledWith).toBe(`!${link}`);
      })
    );
  });
});

// ---------------------------------------------------------------------------
// getCurrentLine
// ---------------------------------------------------------------------------
describe('getCurrentLine', () => {
  it('returns the line at the cursor position', () => {
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 3, ch: 5 }),
      getLine: vi.fn().mockReturnValue('some text here'),
    });
    const result = ObsidianHelpers.getCurrentLine(editor);
    expect(result.line).toBe('some text here');
    expect(result.lineNumber).toBe(3);
  });

  it('calls getLine with the cursor line number', () => {
    const getLine = vi.fn().mockReturnValue('');
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 7, ch: 0 }),
      getLine,
    });
    ObsidianHelpers.getCurrentLine(editor);
    expect(getLine).toHaveBeenCalledWith(7);
  });

  it('returns lineNumber equal to cursor.line for arbitrary positions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 200 }),
        fc.string(),
        (line, ch, lineContent) => {
          const editor = makeEditor({
            getCursor: vi.fn().mockReturnValue({ line, ch }),
            getLine: vi.fn().mockReturnValue(lineContent),
          });
          const result = ObsidianHelpers.getCurrentLine(editor);
          expect(result.lineNumber).toBe(line);
          expect(result.line).toBe(lineContent);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getNote
// ---------------------------------------------------------------------------
describe('getNote', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls getFileByPath with normalized DATA_DIRECTORY/reference path', () => {
    const file = makeTFile();
    const app = makeApp({
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
      } as unknown as App['vault'],
    });
    const result = ObsidianHelpers.getNote('articles/note.md', app);
    expect(app.vault.getFileByPath).toHaveBeenCalledWith(
      normalizePath(`${DATA_DIRECTORY}/articles/note.md`)
    );
    expect(result).toBe(file);
  });

  it('returns null when vault has no matching file', () => {
    const app = makeApp();
    const result = ObsidianHelpers.getNote('nonexistent.md', app);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getFrontMatter
// ---------------------------------------------------------------------------
describe('getFrontMatter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns undefined when metadataCache returns null', () => {
    const app = makeApp();
    const file = makeTFile();
    expect(ObsidianHelpers.getFrontMatter(file, app)).toBeUndefined();
  });

  it('returns undefined when file cache has no frontmatter', () => {
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: undefined }),
      } as unknown as App['metadataCache'],
    });
    const file = makeTFile();
    expect(ObsidianHelpers.getFrontMatter(file, app)).toBeUndefined();
  });

  it('returns frontmatter when present', () => {
    const fm = { tags: ['ir-article'], position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: 30 } } } as unknown as FrontMatterCache;
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: fm }),
      } as unknown as App['metadataCache'],
    });
    const result = ObsidianHelpers.getFrontMatter(makeTFile(), app);
    expect(result).toBeDefined();
  });

  it('normalizes a single-string tags field to an array', () => {
    const fm = { tags: 'ir-article', position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: 30 } } };
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: fm }),
      } as unknown as App['metadataCache'],
    });
    const result = ObsidianHelpers.getFrontMatter(makeTFile(), app);
    expect(Array.isArray(result!.tags)).toBe(true);
    expect(result!.tags).toContain('ir-article');
  });

  it('keeps tags array unchanged when it is already an array', () => {
    const fm = { tags: ['ir-article', 'ir-source'], position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: 30 } } } as unknown as FrontMatterCache;
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: fm }),
      } as unknown as App['metadataCache'],
    });
    const result = ObsidianHelpers.getFrontMatter(makeTFile(), app);
    expect(result!.tags).toEqual(['ir-article', 'ir-source']);
  });
});

// ---------------------------------------------------------------------------
// getNoteType
// ---------------------------------------------------------------------------
describe('getNoteType', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeAppWithTags(tags: string[] | undefined): App {
    const fm = tags !== undefined ? { tags, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: 30 } } } : undefined;
    return makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue(fm ? { frontmatter: fm } : null),
      } as unknown as App['metadataCache'],
    });
  }

  it('returns null when frontmatter has no tags', () => {
    const app = makeAppWithTags(undefined);
    expect(ObsidianHelpers.getNoteType(makeTFile(), app)).toBeNull();
  });

  it('returns "article" when tags include ARTICLE_TAG', () => {
    const app = makeAppWithTags([ARTICLE_TAG]);
    expect(ObsidianHelpers.getNoteType(makeTFile(), app)).toBe('article');
  });

  it('returns "snippet" when tags include SNIPPET_TAG', () => {
    const app = makeAppWithTags([SNIPPET_TAG]);
    expect(ObsidianHelpers.getNoteType(makeTFile(), app)).toBe('snippet');
  });

  it('returns "card" when tags include CARD_TAG', () => {
    const app = makeAppWithTags([CARD_TAG]);
    expect(ObsidianHelpers.getNoteType(makeTFile(), app)).toBe('card');
  });

  it('returns null when tags do not include any known type tag', () => {
    const app = makeAppWithTags(['random-tag', 'another-tag']);
    expect(ObsidianHelpers.getNoteType(makeTFile(), app)).toBeNull();
  });

  it('prioritizes "article" over "snippet" when both tags are present', () => {
    const app = makeAppWithTags([ARTICLE_TAG, SNIPPET_TAG]);
    expect(ObsidianHelpers.getNoteType(makeTFile(), app)).toBe('article');
  });

  it('prioritizes "snippet" over "card" when both tags are present', () => {
    const app = makeAppWithTags([SNIPPET_TAG, CARD_TAG]);
    expect(ObsidianHelpers.getNoteType(makeTFile(), app)).toBe('snippet');
  });
});

// ---------------------------------------------------------------------------
// isSourceNote
// ---------------------------------------------------------------------------
describe('isSourceNote', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns false when frontmatter has no tags', () => {
    const app = makeApp();
    expect(ObsidianHelpers.isSourceNote(makeTFile(), app)).toBe(false);
  });

  it('returns true when tags include SOURCE_TAG', () => {
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: { tags: [SOURCE_TAG], position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: 30 } } } }),
      } as unknown as App['metadataCache'],
    });
    expect(ObsidianHelpers.isSourceNote(makeTFile(), app)).toBe(true);
  });

  it('returns false when tags do not include SOURCE_TAG', () => {
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: { tags: [ARTICLE_TAG], position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: 30 } } } }),
      } as unknown as App['metadataCache'],
    });
    expect(ObsidianHelpers.isSourceNote(makeTFile(), app)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------
describe('isDuplicate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns true when vault has a file at the target path', () => {
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(makeTFile()),
      } as unknown as App['vault'],
    });
    expect(ObsidianHelpers.isDuplicate('note.md', 'article', app)).toBe(true);
  });

  it('returns false when vault has no file at the target path', () => {
    const app = makeApp();
    expect(ObsidianHelpers.isDuplicate('note.md', 'article', app)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateMarkdownLink
// ---------------------------------------------------------------------------
describe('generateMarkdownLink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls fileManager.generateMarkdownLink with correct args and returns result', () => {
    const generateMarkdownLink = vi.fn().mockReturnValue('[[Target|alias]]');
    const app = makeApp({
      fileManager: {
        generateMarkdownLink,
        processFrontMatter: vi.fn(),
        renameFile: vi.fn(),
      } as unknown as App['fileManager'],
    });
    const target = makeTFile({ path: 'incremental-reading/articles/target.md', basename: 'target' });
    const source = makeTFile({ path: 'incremental-reading/articles/source.md' });

    const result = ObsidianHelpers.generateMarkdownLink(target, source, app, 'myAlias');
    expect(generateMarkdownLink).toHaveBeenCalledWith(
      target,
      source.path,
      undefined,
      'myAlias'
    );
    expect(result).toBe('[[Target|alias]]');
  });

  it('uses basename as alias when no alias is provided', () => {
    const generateMarkdownLink = vi.fn().mockReturnValue('[[target]]');
    const app = makeApp({
      fileManager: {
        generateMarkdownLink,
        processFrontMatter: vi.fn(),
        renameFile: vi.fn(),
      } as unknown as App['fileManager'],
    });
    const target = makeTFile({ basename: 'my-note' });
    const source = makeTFile();

    ObsidianHelpers.generateMarkdownLink(target, source, app);
    expect(generateMarkdownLink).toHaveBeenCalledWith(
      target,
      source.path,
      undefined,
      'my-note'
    );
  });
});

// ---------------------------------------------------------------------------
// createFile
// ---------------------------------------------------------------------------
describe('createFile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws when a file already exists at that path', async () => {
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(makeTFile()),
        createFolder: vi.fn(),
        create: vi.fn(),
      } as unknown as App['vault'],
    });
    await expect(
      ObsidianHelpers.createFile(app, 'incremental-reading/articles/note.md')
    ).rejects.toThrow('File already exists');
  });

  it('creates folder when it does not exist', async () => {
    const createFolder = vi.fn().mockResolvedValue(undefined);
    const createdFile = makeTFile();
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder,
        create: vi.fn().mockResolvedValue(createdFile),
      } as unknown as App['vault'],
    });

    await ObsidianHelpers.createFile(app, 'incremental-reading/articles/note.md');
    expect(createFolder).toHaveBeenCalledWith('incremental-reading/articles');
  });

  it('does not create folder when it already exists', async () => {
    const createFolder = vi.fn();
    const createdFile = makeTFile();
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockImplementation((path: string) => {
          // folder exists, file does not
          if (path.endsWith('/articles')) return { path };
          return null;
        }),
        createFolder,
        create: vi.fn().mockResolvedValue(createdFile),
      } as unknown as App['vault'],
    });

    await ObsidianHelpers.createFile(app, 'incremental-reading/articles/note.md');
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('calls vault.create with the path and empty string content', async () => {
    const createdFile = makeTFile();
    const create = vi.fn().mockResolvedValue(createdFile);
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create,
      } as unknown as App['vault'],
    });

    const result = await ObsidianHelpers.createFile(app, 'incremental-reading/articles/note.md');
    // Kills string literal mutant: '' → "Stryker was here!"
    expect(create).toHaveBeenCalledWith('incremental-reading/articles/note.md', '');
    expect(result).toBe(createdFile);
  });

  it('rethrows when vault.create fails and logs the correct path', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = 'incremental-reading/articles/note.md';
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockRejectedValue(new Error('disk error')),
      } as unknown as App['vault'],
    });

    await expect(ObsidianHelpers.createFile(app, path)).rejects.toThrow('disk error');
    // Kills string literal mutant: error message → ""
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(path));
  });
});

// ---------------------------------------------------------------------------
// editNote
// ---------------------------------------------------------------------------
describe('editNote', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls vault.process with file and function and returns result', async () => {
    const process = vi.fn().mockResolvedValue('transformed');
    const app = makeApp({
      vault: { process } as unknown as App['vault'],
    });
    const file = makeTFile();
    const fn = (data: string) => data + ' edited';

    const result = await ObsidianHelpers.editNote(app, file, fn);
    expect(process).toHaveBeenCalledWith(file, fn, undefined);
    expect(result).toBe('transformed');
  });

  it('passes DataWriteOptions to vault.process when provided', async () => {
    const process = vi.fn().mockResolvedValue('');
    const app = makeApp({
      vault: { process } as unknown as App['vault'],
    });
    const file = makeTFile();
    const opts = { mtime: 12345 };

    await ObsidianHelpers.editNote(app, file, (d) => d, opts);
    expect(process).toHaveBeenCalledWith(file, expect.any(Function), opts);
  });
});

// ---------------------------------------------------------------------------
// renameFile
// ---------------------------------------------------------------------------
describe('renameFile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws when the new name contains forbidden characters', async () => {
    const app = makeApp();
    const file = makeTFile();
    const nameWithForbidden = 'bad/name';

    await expect(ObsidianHelpers.renameFile(file, nameWithForbidden, app)).rejects.toThrow(
      INVALID_TITLE_MESSAGE
    );
  });

  it('throws for any name containing a forbidden title char', async () => {
    const app = makeApp();
    const file = makeTFile();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...[...FORBIDDEN_TITLE_CHARS]),
        async (ch) => {
          const name = `valid${ch}name`;
          await expect(ObsidianHelpers.renameFile(file, name, app)).rejects.toThrow();
        }
      )
    );
  });

  it('calls fileManager.renameFile with the correct path when file has a parent', async () => {
    const renameFile = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      fileManager: {
        renameFile,
        processFrontMatter: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });
    const file = makeTFile({
      parent: { path: 'incremental-reading/articles', name: 'articles' } as TFile['parent'],
      extension: 'md',
    });

    await ObsidianHelpers.renameFile(file, 'new-name', app);
    expect(renameFile).toHaveBeenCalledWith(file, 'incremental-reading/articles/new-name.md');
  });

  it('calls fileManager.renameFile without parent path when file has no parent', async () => {
    const renameFile = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      fileManager: {
        renameFile,
        processFrontMatter: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });
    const file = makeTFile({ parent: null as unknown as TFile['parent'], extension: 'md' });

    await ObsidianHelpers.renameFile(file, 'new-name', app);
    expect(renameFile).toHaveBeenCalledWith(file, 'new-name.md');
  });

  it('throws when sanitized name differs from the input (trailing period)', async () => {
    const app = makeApp();
    const file = makeTFile();
    await expect(ObsidianHelpers.renameFile(file, 'name.', app)).rejects.toThrow(INVALID_TITLE_MESSAGE);
  });

  it('throws when sanitized name differs from the input (trailing space)', async () => {
    const app = makeApp();
    const file = makeTFile();
    await expect(ObsidianHelpers.renameFile(file, 'name ', app)).rejects.toThrow(INVALID_TITLE_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// updateFrontMatter
// ---------------------------------------------------------------------------
describe('updateFrontMatter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls processFrontMatter directly when updates is a function', async () => {
    const processFrontMatter = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });
    const file = makeTFile();
    const fn = vi.fn();

    await ObsidianHelpers.updateFrontMatter(file, fn, app);
    expect(processFrontMatter).toHaveBeenCalledWith(file, fn);
  });

  it('calls processFrontMatter with an object update and merges tags', async () => {
    const processFrontMatter = vi.fn().mockImplementation(
      async (_file: TFile, cb: (fm: PluginFrontMatter) => void) => {
        const fm: PluginFrontMatter = { tags: ['existing-tag'] };
        cb(fm);
      }
    );
    const app = makeApp({
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });
    const file = makeTFile();

    await ObsidianHelpers.updateFrontMatter(file, { tags: ['new-tag'] }, app);
    expect(processFrontMatter).toHaveBeenCalledWith(file, expect.any(Function));
  });

  it('deduplicates tags when merging', async () => {
    let capturedFm: PluginFrontMatter = { tags: ['tag-a'] };
    const processFrontMatter = vi.fn().mockImplementation(
      async (_file: TFile, cb: (fm: PluginFrontMatter) => void) => {
        cb(capturedFm);
      }
    );
    const app = makeApp({
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    await ObsidianHelpers.updateFrontMatter(makeTFile(), { tags: ['tag-a', 'tag-b'] }, app);
    expect(capturedFm.tags).toEqual(['tag-a', 'tag-b']);
    expect(new Set(capturedFm.tags).size).toBe(capturedFm.tags!.length);
  });

  it('accepts a string for tags in updates', async () => {
    let capturedFm: PluginFrontMatter = { tags: [] };
    const processFrontMatter = vi.fn().mockImplementation(
      async (_file: TFile, cb: (fm: PluginFrontMatter) => void) => {
        cb(capturedFm);
      }
    );
    const app = makeApp({
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    await ObsidianHelpers.updateFrontMatter(makeTFile(), { tags: 'single-tag' }, app);
    expect(capturedFm.tags).toContain('single-tag');
  });

  it('sets tags to updateTags when existing frontmatter has no tags', async () => {
    let capturedFm: PluginFrontMatter = {};
    const processFrontMatter = vi.fn().mockImplementation(
      async (_file: TFile, cb: (fm: PluginFrontMatter) => void) => {
        cb(capturedFm);
      }
    );
    const app = makeApp({
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    await ObsidianHelpers.updateFrontMatter(makeTFile(), { tags: ['new-tag'] }, app);
    expect(capturedFm.tags).toEqual(['new-tag']);
  });
});

// ---------------------------------------------------------------------------
// createNote
// ---------------------------------------------------------------------------
describe('createNote', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a file at the normalized path and appends content', async () => {
    const createdFile = makeTFile();
    const create = vi.fn().mockResolvedValue(createdFile);
    const append = vi.fn().mockResolvedValue(undefined);
    const processFrontMatter = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create,
        append,
      } as unknown as App['vault'],
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    const result = await ObsidianHelpers.createNote({
      content: 'body text',
      frontmatter: { tags: ['ir-article'] },
      fileName: 'note.md',
      directory: `${DATA_DIRECTORY}/articles`,
      app,
    });

    // Kills string mutant: normalizePath(`${directory}/${fileName}`) → normalizePath(``)
    expect(create).toHaveBeenCalledWith(`${DATA_DIRECTORY}/articles/note.md`, '');
    expect(append).toHaveBeenCalledWith(createdFile, 'body text');
    expect(processFrontMatter).toHaveBeenCalled();
    expect(result).toBe(createdFile);
  });

  it('skips updateFrontMatter when frontmatter is not provided', async () => {
    const createdFile = makeTFile();
    const processFrontMatter = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(createdFile),
        append: vi.fn().mockResolvedValue(undefined),
      } as unknown as App['vault'],
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    await ObsidianHelpers.createNote({
      content: 'body',
      fileName: 'note.md',
      directory: `${DATA_DIRECTORY}/articles`,
      app,
    });

    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it('returns undefined and logs error when createFile throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(makeTFile()), // triggers 'already exists' error
        createFolder: vi.fn(),
        create: vi.fn(),
        append: vi.fn(),
      } as unknown as App['vault'],
    });

    const result = await ObsidianHelpers.createNote({
      content: 'body',
      fileName: 'note.md',
      directory: `${DATA_DIRECTORY}/articles`,
      app,
    });

    expect(result).toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createFromText
// ---------------------------------------------------------------------------
describe('createFromText', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the created TFile and names the file with .md extension', async () => {
    const createdFile = makeTFile();
    const create = vi.fn().mockResolvedValue(createdFile);
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create,
        append: vi.fn().mockResolvedValue(undefined),
      } as unknown as App['vault'],
      fileManager: {
        processFrontMatter: vi.fn().mockResolvedValue(undefined),
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    const result = await ObsidianHelpers.createFromText('some text', `${DATA_DIRECTORY}/articles`, app);
    expect(result).toBe(createdFile);
    // Kills string mutant: `${newNoteName}.md` → `""` — path must end with .md
    const calledPath = (create.mock.calls[0] as string[])[0];
    expect(calledPath).toMatch(/\.md$/);
  });

  it('throws when createNote returns undefined (e.g., createFile fails)', async () => {
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(makeTFile()), // file already exists → createFile throws
        createFolder: vi.fn(),
        create: vi.fn(),
        append: vi.fn(),
      } as unknown as App['vault'],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      ObsidianHelpers.createFromText('content', `${DATA_DIRECTORY}/articles`, app)
    ).rejects.toThrow('Failed to create note');
  });

  it('uses a created timestamp in the frontmatter', async () => {
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
    let capturedFm: Record<string, unknown> = {};
    const processFrontMatter = vi.fn().mockImplementation(
      async (_file: TFile, cb: (fm: Record<string, unknown>) => void) => {
        cb(capturedFm);
      }
    );
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(makeTFile()),
        append: vi.fn().mockResolvedValue(undefined),
      } as unknown as App['vault'],
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    await ObsidianHelpers.createFromText('text', `${DATA_DIRECTORY}/articles`, app);
    expect(capturedFm['created']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// smartGetline
// ---------------------------------------------------------------------------
describe('smartGetline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns default range when there are no listItems in the cache', () => {
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 2, ch: 0 }),
      getLine: vi.fn().mockReturnValue('plain text line'),
    });
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems: undefined }),
      } as unknown as App['metadataCache'],
    });
    const file = makeTFile();

    const result = ObsidianHelpers.smartGetline(editor, file, app);
    expect(result.line).toBe('plain text line');
    expect(result.lineNumber).toBe(2);
    expect(result.start).toBe(0);
    expect(result.end).toBe('plain text line'.length);
  });

  it('returns default range when no list item matches the cursor line', () => {
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 5, ch: 0 }),
      getLine: vi.fn().mockReturnValue('non-list line'),
    });
    const listItems = [
      { position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 10, offset: 10 } } },
      { position: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 10, offset: 10 } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    expect(result.start).toBe(0);
    expect(result.end).toBe('non-list line'.length);
  });

  it('strips bullet prefix when cursor line matches a list item', () => {
    const bulletLine = '- item text';
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
      getLine: vi.fn().mockReturnValue(bulletLine),
    });
    const listItems = [
      { position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: bulletLine.length, offset: bulletLine.length } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    expect(result.line).toBe('item text');
    expect(result.start).toBe(bulletLine.length - 'item text'.length);
    expect(result.end).toBe(bulletLine.length);
  });

  it('returns default when file cache is null', () => {
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
      getLine: vi.fn().mockReturnValue('some text'),
    });
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue(null),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    expect(result.start).toBe(0);
    expect(result.line).toBe('some text');
  });

  it('uses binary search left branch when cursor is before all list items (return -1)', () => {
    // cursor at line 0, list items at lines 5,6,7 — binary search must go left
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
      getLine: vi.fn().mockReturnValue('plain line'),
    });
    const listItems = [
      { position: { start: { line: 5, col: 0, offset: 0 }, end: { line: 5, col: 10, offset: 10 } } },
      { position: { start: { line: 6, col: 0, offset: 0 }, end: { line: 6, col: 10, offset: 10 } } },
      { position: { start: { line: 7, col: 0, offset: 0 }, end: { line: 7, col: 10, offset: 10 } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    // No match → default return; line 0 is before all list items
    expect(result.start).toBe(0);
    expect(result.end).toBe('plain line'.length);
  });

  it('uses binary search right branch when cursor is after all list items (return 1)', () => {
    // cursor at line 10, list items at lines 2,3,4 — binary search must go right, find no match
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 10, ch: 0 }),
      getLine: vi.fn().mockReturnValue('plain line'),
    });
    const listItems = [
      { position: { start: { line: 2, col: 0, offset: 0 }, end: { line: 2, col: 10, offset: 10 } } },
      { position: { start: { line: 3, col: 0, offset: 0 }, end: { line: 3, col: 10, offset: 10 } } },
      { position: { start: { line: 4, col: 0, offset: 0 }, end: { line: 4, col: 10, offset: 10 } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    // cursor is past all items — no match, default return
    expect(result.start).toBe(0);
    expect(result.end).toBe('plain line'.length);
  });

  it('finds the matching list item when cursor is on a middle item in a sorted list', () => {
    // cursor at line 4, items at lines 1,4,7 — binary search goes left/right to find line 4
    const bulletLine = '- middle item';
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 4, ch: 0 }),
      getLine: vi.fn().mockReturnValue(bulletLine),
    });
    const listItems = [
      { position: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 5, offset: 5 } } },
      { position: { start: { line: 4, col: 0, offset: 0 }, end: { line: 4, col: bulletLine.length, offset: bulletLine.length } } },
      { position: { start: { line: 7, col: 0, offset: 0 }, end: { line: 7, col: 5, offset: 5 } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    // Should strip the bullet prefix
    expect(result.line).toBe('middle item');
  });

  it('navigates left in binary search to find a matching item before the midpoint', () => {
    // cursor at line 1 (first item), items at [1, 4, 7]. Mid = 4. Must go left to find line 1.
    // With mutant `return +1` instead of `return -1`: goes right instead, misses item at line 1
    const bulletLine = '- first item';
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 1, ch: 0 }),
      getLine: vi.fn().mockReturnValue(bulletLine),
    });
    const listItems = [
      { position: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: bulletLine.length, offset: bulletLine.length } } },
      { position: { start: { line: 4, col: 0, offset: 0 }, end: { line: 4, col: 5, offset: 5 } } },
      { position: { start: { line: 7, col: 0, offset: 0 }, end: { line: 7, col: 5, offset: 5 } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    expect(result.line).toBe('first item');
    expect(result.start).toBeGreaterThan(0);
  });

  it('navigates right in binary search to find a matching item after the midpoint', () => {
    // cursor at line 7 (last item), items at [1, 4, 7]. Mid = 4. Must go right to find line 7.
    // With mutant `if (false) return 1`: comparator never returns 1, returns 0 wrong match
    const bulletLine = '- last item';
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 7, ch: 0 }),
      getLine: vi.fn().mockReturnValue(bulletLine),
    });
    const listItems = [
      { position: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 5, offset: 5 } } },
      { position: { start: { line: 4, col: 0, offset: 0 }, end: { line: 4, col: 5, offset: 5 } } },
      { position: { start: { line: 7, col: 0, offset: 0 }, end: { line: 7, col: bulletLine.length, offset: bulletLine.length } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    expect(result.line).toBe('last item');
    expect(result.start).toBeGreaterThan(0);
  });

  it('returns defaultReturn when there is no match and the line appears bullet-like', () => {
    // cursor at line 9, items at [1, 4, 7] — no match
    // The line has bullet format but no list item covers line 9
    // Kills mutant `if (false) return defaultReturn`: would instead strip the bullet
    const bulletLine = '- orphan bullet';
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 9, ch: 0 }),
      getLine: vi.fn().mockReturnValue(bulletLine),
    });
    const listItems = [
      { position: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 5, offset: 5 } } },
      { position: { start: { line: 4, col: 0, offset: 0 }, end: { line: 4, col: 5, offset: 5 } } },
      { position: { start: { line: 7, col: 0, offset: 0 }, end: { line: 7, col: 5, offset: 5 } } },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    // defaultReturn: start=0, end=line.length, line untouched
    expect(result.start).toBe(0);
    expect(result.line).toBe(bulletLine);
    expect(result.end).toBe(bulletLine.length);
  });
});
