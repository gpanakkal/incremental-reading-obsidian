import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CARD_DIRECTORY,
  CARD_TAG,
  CONTENT_TITLE_MAX_BYTES,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  FORBIDDEN_TITLE_CHARS,
  INVALID_TITLE_MESSAGE,
  SNIPPET_DIRECTORY,
  SNIPPET_TAG,
  SOURCE_TAG,
} from '#/lib/constants';
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import type { NoteType } from '#/lib/types';
import type { EditorState } from '@codemirror/state';
import fc from 'fast-check';
import {
  type App,
  type Editor,
  type EditorPosition,
  type FrontMatterCache,
  type TFile,
  normalizePath,
} from 'obsidian';
import { posix } from 'path';
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
    posToOffset: vi
      .fn()
      .mockImplementation(({ line, ch }: EditorPosition) => line * 100 + ch),
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

/**
 * An app whose `processFrontMatter` runs every callback against the one live
 * `frontmatter` object, the way successive writes to one note see each other.
 */
function makeFrontmatterApp(frontmatter: Record<string, unknown>): App {
  return makeApp({
    fileManager: {
      processFrontMatter: vi
        .fn()
        .mockImplementation(
          async (_file: TFile, cb: (fm: Record<string, unknown>) => void) => {
            cb(frontmatter);
          }
        ),
      renameFile: vi.fn(),
      generateMarkdownLink: vi.fn(),
    } as unknown as App['fileManager'],
  });
}

/** Builds a frontmatter object with `tags` absent when `tags` is `ABSENT`. */
const ABSENT = Symbol('absent');
function makeFrontmatter(tags: unknown): Record<string, unknown> {
  return tags === ABSENT ? { title: 'x' } : { title: 'x', tags };
}

/** YAML leaves an empty `tags:` or `- ` entry as null; blank strings are empty tags */
function isEmptyTag(tag: unknown) {
  return (
    tag === null ||
    tag === undefined ||
    (typeof tag === 'string' && tag.trim() === '')
  );
}

const itemTagArb = fc.constantFrom(
  ARTICLE_TAG,
  SNIPPET_TAG,
  CARD_TAG,
  SOURCE_TAG
);
/** Any tag string a user or the plugin may write, `#`-prefixed or blank included */
const tagArb = fc.oneof(
  itemTagArb,
  fc.string(),
  fc.string().map((s) => `#${s}`)
);
const emptyTagArb = fc.constantFrom(null, undefined, '', ' ', '\t');
/** Anything YAML can put in a `tags` list, plus what a JS writer could */
const tagEntryArb = fc.oneof(tagArb, emptyTagArb, fc.integer(), fc.object());
/** Every value a note's raw `tags` key can hold */
const rawTagsArb = fc.oneof(
  emptyTagArb,
  tagArb,
  fc.array(tagEntryArb),
  fc.object()
);
/** Every shape a note's raw `tags` value can take, key absence included */
const existingTagsArb = fc.oneof(fc.constant(ABSENT), rawTagsArb);
const tagUpdateArb = fc.oneof(tagArb, fc.array(tagArb));

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Any extension of a file with no frontmatter: `pdf` in every casing, and any
 * other string that isn't some casing of `md`, the empty one included.
 */
const binaryExtensionArb = fc.oneof(
  fc.mixedCase(fc.constant('pdf')),
  fc.string().filter((ext) => ext.toLowerCase() !== 'md')
);

/** Both forms `updateFrontMatter` takes: a callback, or properties to merge. */
const frontMatterUpdatesArb = fc.oneof(
  fc.constant((_frontmatter: Record<string, unknown>) => {}),
  fc.record(
    { 'ir-id': fc.string(), tags: tagUpdateArb, source: fc.string() },
    { requiredKeys: [] }
  )
);

/**
 * C0 controls (`\x00`–`\x1f`), DEL, C1 controls (U+0080–U+009F) and the
 * line and paragraph separators (U+2028, U+2029): invalid or invisible in a
 * file name, or breaking it across lines.
 */
const controlCharArb = fc
  .oneof(
    fc.integer({ min: 0x00, max: 0x1f }),
    fc.integer({ min: 0x7f, max: 0x9f }),
    fc.constantFrom(0x2028, 0x2029)
  )
  .map((code) => String.fromCharCode(code));
/**
 * Default-ignorable code points that a title always drops: the bidi controls
 * (U+202A–U+202E, U+2066–U+2069), LRM, RLM and ALM, and the soft hyphen,
 * Hangul fillers, CGJ, zero-width space, BOM and the like. Not the joiners,
 * variation selectors or tag characters: emoji and scripts need those, where
 * they stand in a sequence.
 */
const invisibleCharArb = fc
  .oneof(
    fc.integer({ min: 0x202a, max: 0x202e }),
    fc.integer({ min: 0x2066, max: 0x2069 }),
    fc.constantFrom(0x200e, 0x200f, 0x061c),
    fc.constantFrom(
      0xad,
      0x34f,
      0x115f,
      0x1160,
      0x17b4,
      0x17b5,
      0x180e,
      0x200b,
      0x2060,
      0x206f,
      0x3164,
      0xfeff,
      0xffa0,
      0xfff0,
      0xfff8,
      0x1bca0,
      0x1bca3,
      0x1d173,
      0x1d17a
    ),
    fc.integer({ min: 0xe0000, max: 0xe001f }),
    fc.integer({ min: 0xe0080, max: 0xe00ff }),
    fc.integer({ min: 0xe01f0, max: 0xe0fff })
  )
  .map((code) => String.fromCodePoint(code));
/** Zero-width non-joiner and joiner: invisible, but emoji and scripts need them. */
const joinerArb = fc
  .constantFrom(0x200c, 0x200d)
  .map((code) => String.fromCodePoint(code));
/** Variation selectors, standard and ideographic, and Mongolian ones. */
const variationSelectorArb = fc
  .oneof(
    fc.integer({ min: 0xfe00, max: 0xfe0f }),
    fc.integer({ min: 0xe0100, max: 0xe01ef }),
    fc.constantFrom(0x180b, 0x180c, 0x180d, 0x180f)
  )
  .map((code) => String.fromCodePoint(code));
/** Tag characters, and the cancel tag that ends an emoji tag sequence. */
const tagCharArb = fc
  .integer({ min: 0xe0020, max: 0xe007f })
  .map((code) => String.fromCodePoint(code));
/** Half of a surrogate pair, alone: text from a PDF can hold one. */
const loneSurrogateArb = fc
  .integer({ min: 0xd800, max: 0xdfff })
  .map((code) => String.fromCharCode(code));
/**
 * Code points NFC turns into more of them (U+1D160 into three), combining
 * marks that compose with what comes before, and code points at the edges of
 * each UTF-8 length.
 */
const unicodeEdgeArb = fc
  .oneof(
    fc.constantFrom(0x1d160, 0x1d15e, 0x0958, 0xfb2a, 0x2adc, 0x0344),
    fc.integer({ min: 0x300, max: 0x36f }),
    fc.constantFrom(0x7e, 0xa0, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff)
  )
  .map((code) => String.fromCodePoint(code));

const fromCodes = (...codes: number[]) => String.fromCodePoint(...codes);
const BLACK_FLAG = fromCodes(0x1f3f4);
const CANCEL_TAG = fromCodes(0xe007f);
/** Sequences a title must keep whole: emoji, and scripts that need a joiner. */
const SEQUENCES = {
  heart: fromCodes(0x2764, 0xfe0f),
  keycap: fromCodes(0x31, 0xfe0f, 0x20e3),
  rainbowFlag: fromCodes(0x1f3f3, 0xfe0f, 0x200d, 0x1f308),
  englandFlag: fromCodes(
    0x1f3f4,
    0xe0067,
    0xe0062,
    0xe0065,
    0xe006e,
    0xe0067,
    0xe007f
  ),
  family: fromCodes(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
  heartOnFire: fromCodes(0x2764, 0xfe0f, 0x200d, 0x1f525),
  persianZwnj: fromCodes(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647),
  devanagariZwj: fromCodes(0x915, 0x94d, 0x200d, 0x937),
  ideographicVariant: fromCodes(0x845b, 0xe0100),
  mongolianVariant: fromCodes(0x1820, 0x180b),
};
const sequenceArb = fc.constantFrom(...Object.values(SEQUENCES));

function isControlChar(char: string) {
  const code = char.charCodeAt(0);
  return (
    char.length === 1 &&
    (code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029)
  );
}
const isJoiner = (char: string | undefined) =>
  char === fromCodes(0x200c) || char === fromCodes(0x200d);
function isVariationSelector(char: string | undefined) {
  const code = char?.codePointAt(0) ?? -1;
  return (
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    (code >= 0x180b && code <= 0x180d) ||
    code === 0x180f
  );
}
/** A tag character other than the cancel tag. */
function isTag(char: string | undefined) {
  const code = char?.codePointAt(0) ?? -1;
  return code >= 0xe0020 && code <= 0xe007e;
}
/** Kept by a title only where a sequence around it needs it. */
const isSequenceChar = (char: string) =>
  isJoiner(char) ||
  isVariationSelector(char) ||
  isTag(char) ||
  char === CANCEL_TAG;
/** A default-ignorable code point that a title drops wherever it stands. */
function isInvisibleChar(char: string) {
  return (
    /\p{Default_Ignorable_Code_Point}/u.test(char) && !isSequenceChar(char)
  );
}
/** A character a sequence can build on: something that shows, not a dot. */
function isBase(char: string | undefined) {
  return (
    char !== undefined &&
    !/\s/.test(char) &&
    char !== '.' &&
    !isControlChar(char) &&
    !/\p{Default_Ignorable_Code_Point}/u.test(char)
  );
}
/**
 * Where in `text` a joiner, variation selector or tag character stands
 * outside a sequence that needs it, or `null`.
 */
function strayInSequence(text: string): number | null {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const [prev, char, next] = [chars[i - 1], chars[i], chars[i + 1]];
    if (isVariationSelector(char) && !isBase(prev)) return i;
    if (
      isJoiner(char) &&
      (prev === undefined ||
        /\s/.test(prev) ||
        prev === '.' ||
        isJoiner(prev) ||
        !isBase(next))
    ) {
      return i;
    }
    if (isTag(char) || char === CANCEL_TAG) {
      let start = i;
      while (isTag(chars[start - 1])) start--;
      let end = i;
      while (isTag(chars[end])) end++;
      const whole =
        chars[start - 1] === BLACK_FLAG &&
        end > start &&
        chars[end] === CANCEL_TAG &&
        (char === CANCEL_TAG ? end === i : true);
      if (!whole) return i;
    }
  }
  return null;
}
/** A code point, as `for…of` yields them, that is half a surrogate pair. */
function isLoneSurrogate(char: string) {
  const code = char.charCodeAt(0);
  return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
}
/** How many bytes `text` takes in UTF-8. */
function utf8Length(text: string) {
  return new TextEncoder().encode(text).length;
}
/** The longest run of `text`'s first code points that fits in `maxBytes`. */
function takeBytes(text: string, maxBytes: number) {
  let taken = '';
  for (const char of text) {
    if (utf8Length(taken + char) > maxBytes) break;
    taken += char;
  }
  return taken;
}

/** One code point of any kind, but none that only a sequence keeps. */
const sequenceFreeUnitArb = fc.oneof(
  controlCharArb,
  invisibleCharArb,
  loneSurrogateArb,
  unicodeEdgeArb,
  fc.constantFrom(...FORBIDDEN_TITLE_CHARS, '.', ' '),
  fc
    .string({ unit: 'binary', minLength: 1, maxLength: 1 })
    .filter((char) => !isSequenceChar(char))
);
/**
 * Any text, thick with control and invisible characters, and with every other
 * code point (the forbidden title characters, astral ones, ones NFC changes)
 * in the mix too, but none that only a sequence keeps.
 */
const controlRichTextArb = fc.string({ unit: sequenceFreeUnitArb });
/**
 * Any text at all: that, with joiners, variation selectors and tag
 * characters, whole emoji and script sequences, and the black flag that
 * starts a tag sequence, anywhere in it.
 */
const anyTextArb = fc.string({
  unit: fc.oneof(
    sequenceFreeUnitArb,
    joinerArb,
    variationSelectorArb,
    tagCharArb,
    sequenceArb,
    fc.constantFrom(BLACK_FLAG, 'a')
  ),
});

/** What one code point of NFC text, in no sequence, becomes in a title. */
function expectedMidTitleChar(char: string) {
  if (isControlChar(char)) return ' ';
  if (isInvisibleChar(char)) return '';
  if (isLoneSurrogate(char)) return '';
  if (FORBIDDEN_TITLE_CHARS.has(char)) return '';
  return char;
}
/** What the middle of a title holding `text`, in no sequence, reads, as NFC. */
function expectedMidTitle(text: string) {
  return Array.from(text.normalize('NFC'))
    .map(expectedMidTitleChar)
    .join('')
    .normalize('NFC');
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
  it('deletes a forbidden character rather than replacing it with a space', () => {
    // Mutant: return '' → return ' ' — 'a#b' must not gain a separator
    const result = ObsidianHelpers.sanitizeForTitle('a#b', false);
    expect(result).toBe('ab');
  });

  it('replaces a forbidden whitespace character with a space', () => {
    // Mutant: return ' ' → return '' — words either side would run together
    const result = ObsidianHelpers.sanitizeForTitle(
      'line one\nline two',
      false
    );
    expect(result).toBe('line one line two');
  });

  it('deletes non-whitespace forbidden chars and spaces out whitespace ones', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...[...FORBIDDEN_TITLE_CHARS]),
        (forbidden) => {
          const result = ObsidianHelpers.sanitizeForTitle(
            `a${forbidden}b`,
            false
          );
          expect(result).toBe(/\s/.test(forbidden) ? 'a b' : 'ab');
        }
      )
    );
  });

  it('leaves no forbidden character in the output', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (text, checkFinalChar) => {
        const result = ObsidianHelpers.sanitizeForTitle(text, checkFinalChar);
        [...FORBIDDEN_TITLE_CHARS].forEach((ch) => {
          expect(result).not.toContain(ch);
        });
      })
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

  it('checkFinalChar=true removes leading whitespace', () => {
    // Mutant: cleaned.trim() → cleaned — a rename to '  hello' must be rejected
    expect(ObsidianHelpers.sanitizeForTitle('  hello', true)).toBe('hello');
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
    const result = ObsidianHelpers.sanitizeForTitle('hello ', false);
    expect(result).toBe('hello ');
  });

  it('checkFinalChar=false preserves trailing period', () => {
    const result = ObsidianHelpers.sanitizeForTitle('hello.', false);
    expect(result).toBe('hello.');
  });

  it('trims leading whitespace but preserves the trailing character', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const padded = `   ${text}`;
        const result = ObsidianHelpers.sanitizeForTitle(padded, false);
        // The last char is always preserved as-is (possibly whitespace).
        // Everything before it has leading whitespace stripped, so if the result
        // is longer than 1 char it must start with a non-whitespace character.
        expect(result.length <= 1 || result === result.trimStart()).toBe(true);
      })
    );
  });

  it('cuts a name to maxLength code points, never splitting a surrogate pair', () => {
    fc.assert(
      fc.property(
        controlRichTextArb,
        fc.boolean(),
        fc.integer({ min: 1, max: 60 }),
        (text, checkFinalChar, maxLength) => {
          const whole = ObsidianHelpers.sanitizeForTitle(text, checkFinalChar);
          expect(
            ObsidianHelpers.sanitizeForTitle(text, checkFinalChar, maxLength)
          ).toBe(Array.from(whole).slice(0, maxLength).join(''));
        }
      )
    );
  });

  it('keeps every character either side of the surrogate range', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 0xa0, max: 0xd7ff }),
          fc.integer({ min: 0xe000, max: 0xffff })
        ),
        (code) => {
          const char = String.fromCharCode(code);
          fc.pre(
            !isInvisibleChar(char) &&
              !isControlChar(char) &&
              !/\s/.test(char) &&
              char.normalize('NFC') === char
          );
          expect(ObsidianHelpers.sanitizeForTitle(`a${char}b`, false)).toBe(
            `a${char}b`
          );
        }
      )
    );
    for (const code of [0xd7ff, 0xe000, 0xfffd, 0xffff]) {
      const char = String.fromCharCode(code);
      expect(ObsidianHelpers.sanitizeForTitle(`a${char}b`, false)).toBe(
        `a${char}b`
      );
    }
  });

  it('drops half a surrogate pair standing alone', () => {
    fc.assert(
      fc.property(loneSurrogateArb, (half) => {
        expect(ObsidianHelpers.sanitizeForTitle(`a${half}b`, false)).toBe('ab');
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

  it('returns a blank string for input containing only forbidden chars', () => {
    const input = [...FORBIDDEN_TITLE_CHARS].join('');
    const result = ObsidianHelpers.sanitizeForTitle(input, false);
    // Every forbidden char is deleted except the newline, which becomes a space
    expect(result.trim()).toBe('');
    // No forbidden chars remain
    [...FORBIDDEN_TITLE_CHARS].forEach((c) => expect(result).not.toContain(c));
  });

  it('leaves no control, DEL or bidi character in the output', () => {
    fc.assert(
      fc.property(
        controlRichTextArb,
        fc.boolean(),
        fc.option(fc.nat(), { nil: undefined }),
        (text, checkFinalChar, maxLength) => {
          const result = ObsidianHelpers.sanitizeForTitle(
            text,
            checkFinalChar,
            maxLength
          );
          for (const char of result) {
            expect(isControlChar(char)).toBe(false);
            expect(isInvisibleChar(char)).toBe(false);
            expect(isLoneSurrogate(char)).toBe(false);
          }
        }
      )
    );
  });

  it('turns a control or DEL character into a space so the words around it stay apart', () => {
    fc.assert(
      fc.property(controlCharArb, fc.boolean(), (control, checkFinalChar) => {
        expect(
          ObsidianHelpers.sanitizeForTitle(`a${control}b`, checkFinalChar)
        ).toBe('a b');
      })
    );
  });

  it('drops an invisible character outright', () => {
    fc.assert(
      fc.property(invisibleCharArb, fc.boolean(), (bidi, checkFinalChar) => {
        expect(
          ObsidianHelpers.sanitizeForTitle(`a${bidi}b`, checkFinalChar)
        ).toBe('ab');
      })
    );
  });

  it('keeps the zero-width joiner and non-joiner that emoji and scripts need', () => {
    fc.assert(
      fc.property(joinerArb, fc.boolean(), (joiner, checkFinalChar) => {
        expect(
          ObsidianHelpers.sanitizeForTitle(`a${joiner}b`, checkFinalChar)
        ).toBe(`a${joiner}b`);
      })
    );
  });

  it('returns NFC text, whatever it is given', () => {
    fc.assert(
      fc.property(
        controlRichTextArb,
        fc.boolean(),
        fc.option(fc.nat(), { nil: undefined }),
        fc.option(fc.nat(), { nil: undefined }),
        (text, checkFinalChar, maxLength, maxBytes) => {
          const result = ObsidianHelpers.sanitizeForTitle(
            text,
            checkFinalChar,
            maxLength,
            maxBytes
          );
          expect(result.normalize('NFC')).toBe(result);
        }
      )
    );
  });

  it('reads the text as NFC before dropping anything, so a composed character survives', () => {
    // `<` and a combining long solidus overlay compose to U+226E, which a name can hold
    const lessThan = '<' + String.fromCodePoint(0x338);
    expect(ObsidianHelpers.sanitizeForTitle(`a${lessThan}b`, false)).toBe(
      `a${String.fromCodePoint(0x226e)}b`
    );
  });

  it('composes what a dropped character stood between', () => {
    const rlm = String.fromCodePoint(0x200f);
    const acute = String.fromCodePoint(0x301);
    expect(ObsidianHelpers.sanitizeForTitle(`ae${rlm}${acute}`, false)).toBe(
      `a${String.fromCodePoint(0xe9)}`
    );
  });

  it('cuts a name to maxBytes of UTF-8, by whole code points', () => {
    fc.assert(
      fc.property(
        controlRichTextArb,
        fc.boolean(),
        fc.nat({ max: 80 }),
        (text, checkFinalChar, maxBytes) => {
          const whole = ObsidianHelpers.sanitizeForTitle(text, checkFinalChar);
          const result = ObsidianHelpers.sanitizeForTitle(
            text,
            checkFinalChar,
            undefined,
            maxBytes
          );
          expect(result).toBe(takeBytes(whole, maxBytes));
          expect(utf8Length(result)).toBeLessThanOrEqual(maxBytes);
        }
      )
    );
  });

  it('counts each code point at its UTF-8 length when cutting by bytes', () => {
    // One code point of each length either side of its edge, then a letter
    const cases: [number, number][] = [
      [0x7e, 1],
      [0xa1, 2],
      [0x7ff, 2],
      [0x800, 3],
      [0xffff, 3],
      [0x10000, 4],
      [0x10ffff, 4],
    ];
    for (const [code, bytes] of cases) {
      const char = String.fromCodePoint(code);
      expect(
        ObsidianHelpers.sanitizeForTitle(`${char}z`, false, undefined, bytes)
      ).toBe(char);
      expect(
        ObsidianHelpers.sanitizeForTitle(
          `${char}z`,
          false,
          undefined,
          bytes - 1
        )
      ).toBe('');
    }
  });

  it('keeps emoji and script sequences whole: variation selectors, joiners and tag sequences', () => {
    fc.assert(
      fc.property(sequenceArb, fc.boolean(), (sequence, checkFinalChar) => {
        expect(
          ObsidianHelpers.sanitizeForTitle(`x ${sequence} y`, checkFinalChar)
        ).toBe(`x ${sequence} y`);
        expect(ObsidianHelpers.sanitizeForTitle(sequence, checkFinalChar)).toBe(
          sequence
        );
      })
    );
  });

  it('leaves no joiner, variation selector or tag character outside a sequence that needs it', () => {
    fc.assert(
      fc.property(
        anyTextArb,
        fc.boolean(),
        fc.option(fc.nat(), { nil: undefined }),
        fc.option(fc.nat({ max: 80 }), { nil: undefined }),
        (text, checkFinalChar, maxLength, maxBytes) => {
          const result = ObsidianHelpers.sanitizeForTitle(
            text,
            checkFinalChar,
            maxLength,
            maxBytes
          );
          expect(strayInSequence(result)).toBeNull();
        }
      )
    );
  });

  it('keeps one variation selector after something that shows, and no other', () => {
    fc.assert(
      fc.property(
        variationSelectorArb,
        fc.array(variationSelectorArb, { minLength: 1 }),
        (first, more) => {
          const heart = fromCodes(0x2764);
          expect(
            ObsidianHelpers.sanitizeForTitle(
              `a ${heart}${first}${more.join('')} ${more.join('')}b`,
              false
            )
          ).toBe(`a ${heart}${first} b`);
        }
      )
    );
  });

  it('keeps one joiner between two characters that show, and drops runs and strays', () => {
    fc.assert(
      fc.property(
        joinerArb,
        fc.array(joinerArb, { minLength: 1 }),
        fc.constantFrom(' ', '.', ''),
        (joiner, more, edge) => {
          expect(
            ObsidianHelpers.sanitizeForTitle(
              `a${joiner}${more.join('')}b${edge}${joiner}c${joiner}`,
              false
            )
          ).toBe(
            `a${more[more.length - 1]}b${edge}${edge === '' ? joiner : ''}c`
          );
        }
      )
    );
  });

  it('keeps tag characters only in a whole tag sequence after the black flag', () => {
    const tags = fromCodes(0xe0067, 0xe0062);
    const cases: [string, string][] = [
      [
        `a${BLACK_FLAG}${tags}${CANCEL_TAG}b`,
        `a${BLACK_FLAG}${tags}${CANCEL_TAG}b`,
      ],
      [`a${BLACK_FLAG}${tags}b`, `a${BLACK_FLAG}b`],
      [`a${BLACK_FLAG}${CANCEL_TAG}b`, `a${BLACK_FLAG}b`],
      [`a${tags}${CANCEL_TAG}b`, 'ab'],
      [`a${BLACK_FLAG}${tags} ${CANCEL_TAG}b`, `a${BLACK_FLAG} b`],
      [`a${CANCEL_TAG}${tags}b`, 'ab'],
    ];
    for (const [text, expected] of cases) {
      expect(ObsidianHelpers.sanitizeForTitle(text, false)).toBe(expected);
    }
  });

  it('tells each kind of sequence character by its whole range', () => {
    // Kept after a letter: the first and last of each range
    for (const code of [
      0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x180b, 0x180d, 0x180f,
    ]) {
      expect(
        ObsidianHelpers.sanitizeForTitle(`a${fromCodes(code)}b`, false)
      ).toBe(`a${fromCodes(code)}b`);
    }
    // Dropped after a letter: just outside them
    for (const code of [0xe01f0, 0x180e, 0xe001f, 0xe0080]) {
      expect(
        ObsidianHelpers.sanitizeForTitle(`a${fromCodes(code)}b`, false)
      ).toBe('ab');
    }
    const edgeTags = fromCodes(0xe0020, 0xe007e);
    expect(
      ObsidianHelpers.sanitizeForTitle(
        `a${BLACK_FLAG}${edgeTags}${CANCEL_TAG}b`,
        false
      )
    ).toBe(`a${BLACK_FLAG}${edgeTags}${CANCEL_TAG}b`);
  });

  it('builds no sequence on a dot, or on nothing at all', () => {
    const selector = fromCodes(0xfe0f);
    const joiner = fromCodes(0x200d);
    expect(ObsidianHelpers.sanitizeForTitle(`a.${selector}b`, false)).toBe(
      'a.b'
    );
    expect(ObsidianHelpers.sanitizeForTitle(`a${joiner}.b`, false)).toBe('a.b');
    expect(ObsidianHelpers.sanitizeForTitle(`${selector}a`, false)).toBe('a');
    expect(ObsidianHelpers.sanitizeForTitle(`${joiner}a`, false)).toBe('a');
  });

  it('joins across what is dropped between a joiner and the next character', () => {
    const joiner = fromCodes(0x200d);
    const rlm = fromCodes(0x200f);
    expect(ObsidianHelpers.sanitizeForTitle(`a${joiner}${rlm}b`, false)).toBe(
      `a${joiner}b`
    );
    expect(ObsidianHelpers.sanitizeForTitle(`a${joiner}${rlm}`, false)).toBe(
      'a'
    );
  });

  it('cuts a tag sequence or joined emoji down to what still stands whole', () => {
    const { englandFlag, family } = SEQUENCES;
    expect(ObsidianHelpers.sanitizeForTitle(`a${englandFlag}`, false, 4)).toBe(
      `a${BLACK_FLAG}`
    );
    expect(ObsidianHelpers.sanitizeForTitle(`a${family}`, false, 3)).toBe(
      `a${fromCodes(0x1f468)}`
    );
  });

  it('cuts text holding sequences to a prefix within maxBytes', () => {
    fc.assert(
      fc.property(
        anyTextArb,
        fc.boolean(),
        fc.nat({ max: 80 }),
        (text, checkFinalChar, maxBytes) => {
          const whole = ObsidianHelpers.sanitizeForTitle(text, checkFinalChar);
          const result = ObsidianHelpers.sanitizeForTitle(
            text,
            checkFinalChar,
            undefined,
            maxBytes
          );
          expect(whole.startsWith(result)).toBe(true);
          expect(utf8Length(result)).toBeLessThanOrEqual(maxBytes);
        }
      )
    );
  });

  it('names a reversed-extension spoof so that it reads in order', () => {
    expect(ObsidianHelpers.sanitizeForTitle('report\u202efdp.exe', false)).toBe(
      'reportfdp.exe'
    );
  });

  it('maps each character inside a title on its own, keeping every one that is allowed', () => {
    // Bracketed by letters, so the leading-dot and end-of-title rules stay out of it
    fc.assert(
      fc.property(controlRichTextArb, fc.boolean(), (text, checkFinalChar) => {
        expect(
          ObsidianHelpers.sanitizeForTitle(`x${text}y`, checkFinalChar)
        ).toBe(expectedMidTitle(`x${text}y`));
      })
    );
  });

  it('never starts a name with a dot or whitespace, whatever was dropped before it', () => {
    // A note whose name starts with a dot is hidden, and Obsidian never indexes it
    fc.assert(
      fc.property(
        controlRichTextArb,
        fc.boolean(),
        fc.option(fc.nat(), { nil: undefined }),
        (text, checkFinalChar, maxLength) => {
          const result = ObsidianHelpers.sanitizeForTitle(
            text,
            checkFinalChar,
            maxLength
          );
          expect(result).not.toMatch(/^[\s.]/);
        }
      )
    );
  });

  it('checkFinalChar=true never ends a name with whitespace or a dot, whatever was dropped after it', () => {
    fc.assert(
      fc.property(controlRichTextArb, (text) => {
        expect(ObsidianHelpers.sanitizeForTitle(text, true)).not.toMatch(
          /[\s.]$/
        );
      })
    );
  });

  it('checkFinalChar=true keeps what precedes the dots and whitespace a name would end with', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.oneof(
            controlCharArb,
            invisibleCharArb,
            fc.constantFrom('.', ' ', '#')
          ),
        }),
        (suffix) => {
          expect(ObsidianHelpers.sanitizeForTitle(`name${suffix}`, true)).toBe(
            'name'
          );
        }
      )
    );
  });

  it('keeps what follows the dots and whitespace a name would start with', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.oneof(
            controlCharArb,
            invisibleCharArb,
            fc.constantFrom('.', ' ', '#')
          ),
        }),
        fc.boolean(),
        (prefix, checkFinalChar) => {
          expect(
            ObsidianHelpers.sanitizeForTitle(`${prefix}name`, checkFinalChar)
          ).toBe('name');
        }
      )
    );
  });

  it('leaves clean strings unchanged', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => {
          if ([...FORBIDDEN_TITLE_CHARS].some((c) => s.includes(c))) {
            return false;
          }
          if (s.startsWith('.')) return false;
          // Leading whitespace is trimmed, a lone whitespace char included
          if (s !== s.trimStart()) return false;
          return true;
        }),
        (text) => {
          const result = ObsidianHelpers.sanitizeForTitle(text, false);
          expect(result).toBe(text);
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

  it('keeps the content segment within CONTENT_TITLE_SLICE_LENGTH code points, astral ones whole', () => {
    fc.assert(
      fc.property(controlRichTextArb, (content) => {
        const title = ObsidianHelpers.createTitle(content);
        const sep = title.lastIndexOf(' - ');
        const segment = sep === -1 ? '' : title.slice(0, sep);
        expect(Array.from(segment).length).toBeLessThanOrEqual(
          CONTENT_TITLE_SLICE_LENGTH
        );
      })
    );
    const emoji = '😀';
    const title = ObsidianHelpers.createTitle(
      `${'a'.repeat(CONTENT_TITLE_SLICE_LENGTH - 1)}${emoji}rest`
    );
    expect(title.split(' - ')[0]).toBe(
      `${'a'.repeat(CONTENT_TITLE_SLICE_LENGTH - 1)}${emoji}`
    );
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
        const idSegment =
          sepIdx === -1 ? title : title.slice(sepIdx + sep.length);
        expect(idSegment).toMatch(/^[a-z0-9]+$/);
      })
    );
  });

  it('omits content segment when sanitized content is empty (all forbidden chars)', () => {
    const allForbidden = [...FORBIDDEN_TITLE_CHARS].join('');
    const title = ObsidianHelpers.createTitle(allForbidden);
    expect(title).not.toContain(' - ');
  });

  it('keeps only the label of an inline link in the content segment', () => {
    const title = ObsidianHelpers.createTitle(
      'See [my site](www.example.com) now'
    );
    expect(title.split(' - ')[0]).toBe('See my site now');
  });

  it('strips a footnote reference from the content segment', () => {
    const title = ObsidianHelpers.createTitle('A claim[^1] worth reviewing');
    expect(title.split(' - ')[0]).toBe('A claim worth reviewing');
  });

  it('keeps only the alias of an aliased wikilink in the content segment', () => {
    const title = ObsidianHelpers.createTitle('About [[Some Note|the alias]]');
    expect(title.split(' - ')[0]).toBe('About the alias');
  });

  it('keeps the target of a plain wikilink in the content segment', () => {
    const title = ObsidianHelpers.createTitle('About [[Some Note]]');
    expect(title.split(' - ')[0]).toBe('About Some Note');
  });

  it('measures the slice length after links are stripped', () => {
    // A link whose target alone exceeds the slice length still yields its label
    const url = `www.example.com/${'a'.repeat(CONTENT_TITLE_SLICE_LENGTH)}`;
    const title = ObsidianHelpers.createTitle(`[short label](${url})`);
    expect(title.split(' - ')[0]).toBe('short label');
  });

  it('names a note in at most 255 bytes of UTF-8, after NFC, whatever its text', () => {
    // U+1D160 is one code point, and three once NFC has read it
    const expandingArb = fc.string({
      unit: fc
        .constantFrom(0x1d160, 0x0958, 0x10000, 0x41)
        .map((code) => String.fromCodePoint(code)),
      minLength: CONTENT_TITLE_SLICE_LENGTH,
    });
    fc.assert(
      fc.property(fc.oneof(controlRichTextArb, expandingArb), (content) => {
        const fileName = `${ObsidianHelpers.createTitle(content)}.md`;
        expect(utf8Length(fileName.normalize('NFC'))).toBeLessThanOrEqual(255);
        expect(fileName.normalize('NFC')).toBe(fileName);
      })
    );
    const title = ObsidianHelpers.createTitle(
      String.fromCodePoint(0x1d160).repeat(CONTENT_TITLE_SLICE_LENGTH)
    );
    const segment = title.split(' - ')[0];
    expect(Array.from(segment)).toHaveLength(CONTENT_TITLE_SLICE_LENGTH);
    expect(utf8Length(segment)).toBeLessThanOrEqual(CONTENT_TITLE_MAX_BYTES);
  });

  it('never holds a control, DEL or bidi character', () => {
    fc.assert(
      fc.property(controlRichTextArb, (content) => {
        for (const char of ObsidianHelpers.createTitle(content)) {
          expect(isControlChar(char)).toBe(false);
          expect(isInvisibleChar(char)).toBe(false);
          expect(isLoneSurrogate(char)).toBe(false);
        }
      })
    );
  });

  it('names a note after its text, less its control and bidi characters', () => {
    // No link syntax, and short enough that the whole text makes the name
    const textArb = fc.string({
      unit: fc.oneof(
        controlCharArb,
        invisibleCharArb,
        fc.constantFrom('a', 'Z', '7', ' ', '.', '-', 'é')
      ),
      maxLength: CONTENT_TITLE_SLICE_LENGTH - 2,
    });
    fc.assert(
      fc.property(textArb, (text) => {
        const title = ObsidianHelpers.createTitle(`x${text}y`);
        expect(title.slice(0, title.lastIndexOf(' - '))).toBe(
          expectedMidTitle(`x${text}y`)
        );
      })
    );
  });

  it('preserves a trailing period in the content segment (checkFinalChar=false)', () => {
    // Kills mutant: false → true in sanitizeForTitle call — trailing period would be stripped
    const title = ObsidianHelpers.createTitle('content ending in period.');
    const contentSegment = title.split(' - ')[0];
    expect(contentSegment).toMatch(/\.$/);
  });
});

// ---------------------------------------------------------------------------
// getDirectory
// ---------------------------------------------------------------------------
describe('getDirectory', () => {
  it('returns article directory path for "article" type', () => {
    const result = ObsidianHelpers.getDirectory('article');
    expect(result).toBe(
      normalizePath(`${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`)
    );
  });

  it('returns snippet directory path for "snippet" type', () => {
    const result = ObsidianHelpers.getDirectory('snippet');
    expect(result).toBe(
      normalizePath(`${DATA_DIRECTORY}/${SNIPPET_DIRECTORY}`)
    );
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
    const state = {
      field,
    } as unknown as EditorState;

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
    } as unknown as EditorState;

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
      activeElement: {
        isContentEditable: false,
        tagName: 'INPUT',
      } as HTMLElement,
    } as unknown as Document;
    expect(ObsidianHelpers.inEditMode(doc)).toBe(true);
  });

  it('returns true when activeElement is TEXTAREA', () => {
    const doc = {
      activeElement: {
        isContentEditable: false,
        tagName: 'TEXTAREA',
      } as HTMLElement,
    } as unknown as Document;
    expect(ObsidianHelpers.inEditMode(doc)).toBe(true);
  });

  it('returns false for non-editable elements', () => {
    const tags = ['DIV', 'SPAN', 'P', 'BUTTON', 'A'];
    fc.assert(
      fc.property(fc.constantFrom(...tags), (tag) => {
        const doc = {
          activeElement: {
            isContentEditable: false,
            tagName: tag,
          } as HTMLElement,
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
            activeElement: {
              isContentEditable: false,
              tagName: tag,
            } as HTMLElement,
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
    const getCursor = vi
      .fn()
      .mockImplementation((pos: 'from' | 'to') => (pos === 'from' ? from : to));
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
      getCursor: vi
        .fn()
        .mockImplementation((pos: 'from' | 'to') =>
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

  it('calls getFileByPath with the vault-relative reference path', () => {
    const file = makeTFile();
    const app = makeApp({
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
      } as unknown as App['vault'],
    });
    const result = ObsidianHelpers.getNote(
      `${DATA_DIRECTORY}/articles/note.md`,
      app
    );
    expect(app.vault.getFileByPath).toHaveBeenCalledWith(
      `${DATA_DIRECTORY}/articles/note.md`
    );
    expect(result).toBe(file);
  });

  it('returns null when vault has no matching file', () => {
    const app = makeApp();
    const result = ObsidianHelpers.getNote(
      `${DATA_DIRECTORY}/nonexistent.md`,
      app
    );
    expect(result).toBeNull();
  });

  it('does not strip fragment suffixes from the reference path', () => {
    const fragmentRef = `${DATA_DIRECTORY}/snippets/snip.md#h1`;
    const file = makeTFile();
    const app = makeApp({
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
      } as unknown as App['vault'],
    });
    const result = ObsidianHelpers.getNote(fragmentRef, app);
    expect(app.vault.getFileByPath).toHaveBeenCalledWith(fragmentRef);
    expect(result).toBe(file);
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
    const fm = {
      tags: ['ir-article'],
      position: {
        start: { line: 0, col: 0, offset: 0 },
        end: { line: 3, col: 3, offset: 30 },
      },
    } as unknown as FrontMatterCache;
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: fm }),
      } as unknown as App['metadataCache'],
    });
    const result = ObsidianHelpers.getFrontMatter(makeTFile(), app);
    expect(result).toBeDefined();
  });

  it('normalizes a single-string tags field to an array', () => {
    const fm = {
      tags: 'ir-article',
      position: {
        start: { line: 0, col: 0, offset: 0 },
        end: { line: 3, col: 3, offset: 30 },
      },
    };
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
    const fm = {
      tags: ['ir-article', 'ir-source'],
      position: {
        start: { line: 0, col: 0, offset: 0 },
        end: { line: 3, col: 3, offset: 30 },
      },
    } as unknown as FrontMatterCache;
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
    return makeApp({
      fileManager: {
        processFrontMatter: vi
          .fn()
          .mockImplementation(
            async (
              _file: unknown,
              cb: (fm: Record<string, unknown>) => void
            ) => {
              cb(tags !== undefined ? { tags } : {});
            }
          ),
      } as unknown as App['fileManager'],
    });
  }

  it('returns null when frontmatter has no tags', async () => {
    const app = makeAppWithTags(undefined);
    await expect(
      ObsidianHelpers.getNoteType(makeTFile(), app)
    ).resolves.toBeNull();
  });

  it('returns "article" when tags include ARTICLE_TAG', async () => {
    const app = makeAppWithTags([ARTICLE_TAG]);
    await expect(ObsidianHelpers.getNoteType(makeTFile(), app)).resolves.toBe(
      'article'
    );
  });

  it('returns "snippet" when tags include SNIPPET_TAG', async () => {
    const app = makeAppWithTags([SNIPPET_TAG]);
    await expect(ObsidianHelpers.getNoteType(makeTFile(), app)).resolves.toBe(
      'snippet'
    );
  });

  it('returns "card" when tags include CARD_TAG', async () => {
    const app = makeAppWithTags([CARD_TAG]);
    await expect(ObsidianHelpers.getNoteType(makeTFile(), app)).resolves.toBe(
      'card'
    );
  });

  it('returns null when tags do not include any known type tag', async () => {
    const app = makeAppWithTags(['random-tag', 'another-tag']);
    await expect(
      ObsidianHelpers.getNoteType(makeTFile(), app)
    ).resolves.toBeNull();
  });

  it('prioritizes "article" over "snippet" when both tags are present', async () => {
    const app = makeAppWithTags([ARTICLE_TAG, SNIPPET_TAG]);
    await expect(ObsidianHelpers.getNoteType(makeTFile(), app)).resolves.toBe(
      'article'
    );
  });

  it('prioritizes "snippet" over "card" when both tags are present', async () => {
    const app = makeAppWithTags([SNIPPET_TAG, CARD_TAG]);
    await expect(ObsidianHelpers.getNoteType(makeTFile(), app)).resolves.toBe(
      'snippet'
    );
  });

  it('answers null for a file without frontmatter, never reading it', async () => {
    await fc.assert(
      fc.asyncProperty(binaryExtensionArb, async (extension) => {
        const processFrontMatter = vi.fn();
        const app = makeApp({ fileManager: { processFrontMatter } as never });
        await expect(
          ObsidianHelpers.getNoteType(makeTFile({ extension }), app)
        ).resolves.toBeNull();
        expect(processFrontMatter).not.toHaveBeenCalled();
      })
    );
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
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: {
            tags: [SOURCE_TAG],
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 3, col: 3, offset: 30 },
            },
          },
        }),
      } as unknown as App['metadataCache'],
    });
    expect(ObsidianHelpers.isSourceNote(makeTFile(), app)).toBe(true);
  });

  it('returns false when tags do not include SOURCE_TAG', () => {
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: {
            tags: [ARTICLE_TAG],
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 3, col: 3, offset: 30 },
            },
          },
        }),
      } as unknown as App['metadataCache'],
    });
    expect(ObsidianHelpers.isSourceNote(makeTFile(), app)).toBe(false);
  });
});

describe('parseLinkTarget', () => {
  it('takes the target of a wikilink, dropping alias and subpath', () => {
    expect(ObsidianHelpers.parseLinkTarget('[[notes/Foo]]')).toBe('notes/Foo');
    expect(ObsidianHelpers.parseLinkTarget('[[notes/Foo|Foo]]')).toBe(
      'notes/Foo'
    );
    expect(ObsidianHelpers.parseLinkTarget('[[notes/Foo#Heading]]')).toBe(
      'notes/Foo'
    );
  });

  it('takes the target of a markdown link, decoded and without its subpath', () => {
    expect(ObsidianHelpers.parseLinkTarget('[Foo](notes/My%20Foo.md)')).toBe(
      'notes/My Foo.md'
    );
    expect(ObsidianHelpers.parseLinkTarget('[Foo](<notes/My Foo.md>)')).toBe(
      'notes/My Foo.md'
    );
    expect(ObsidianHelpers.parseLinkTarget('[Foo](notes/Foo.md#Head)')).toBe(
      'notes/Foo.md'
    );
  });

  it('returns anything else trimmed, so a bare path still resolves', () => {
    expect(ObsidianHelpers.parseLinkTarget('  notes/Foo.md  ')).toBe(
      'notes/Foo.md'
    );
    expect(ObsidianHelpers.parseLinkTarget('https://example.com')).toBe(
      'https://example.com'
    );
  });

  it('never returns a string carrying link syntax for a well-formed link', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9 /-]{1,20}$/),
        fc.boolean(),
        (target, wiki) => {
          const link = wiki ? `[[${target}|alias]]` : `[alias](${target})`;
          const parsed = ObsidianHelpers.parseLinkTarget(link);
          expect(parsed).toBe(target.trim());
        }
      )
    );
  });
});

describe('getSourceFile', () => {
  afterEach(() => vi.restoreAllMocks());

  /** An app whose cache reports `source` and resolves links to `dest`. */
  function makeSourceApp(source: unknown, dest: TFile | null): App {
    return makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: { source } }),
        getFirstLinkpathDest: vi.fn().mockReturnValue(dest),
      } as unknown as App['metadataCache'],
    });
  }

  it('resolves the link in the source property', () => {
    const dest = makeTFile({ path: 'notes/origin.md', basename: 'origin' });
    const app = makeSourceApp('[[notes/origin|origin]]', dest);

    expect(ObsidianHelpers.getSourceFile(makeTFile(), app)).toBe(dest);
    expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
      'notes/origin',
      expect.any(String)
    );
  });

  /** An app whose cache reports `source`, and the link lookup it makes. */
  function makeLookingUpApp(source: string, dest: TFile | null) {
    const getFirstLinkpathDest = vi.fn().mockReturnValue(dest);
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: { source } }),
        getFirstLinkpathDest,
      } as unknown as App['metadataCache'],
    });
    return { app, getFirstLinkpathDest };
  }

  it('resolves a markdown link to a name with brackets in it by the whole name', () => {
    // Obsidian leaves brackets in a markdown link's target unencoded
    const dest = makeTFile({
      path: 'Smith (2020).pdf',
      basename: 'Smith (2020)',
    });
    const { app, getFirstLinkpathDest } = makeLookingUpApp(
      '[Smith (2020), page 3](Smith%20(2020).pdf#page=3&selection=1,2,3,4)',
      dest
    );

    expect(ObsidianHelpers.getSourceFile(makeTFile(), app)).toBe(dest);
    expect(getFirstLinkpathDest).toHaveBeenCalledWith(
      'Smith (2020).pdf',
      expect.any(String)
    );
  });

  it('resolves a wikilink with spaces around its path by the path alone', () => {
    const { app, getFirstLinkpathDest } = makeLookingUpApp(
      '[[ notes/origin |origin]]',
      makeTFile()
    );

    ObsidianHelpers.getSourceFile(makeTFile(), app);

    expect(getFirstLinkpathDest).toHaveBeenCalledWith(
      'notes/origin',
      expect.any(String)
    );
  });

  it('returns null when the note has no source property', () => {
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ frontmatter: {} }),
        getFirstLinkpathDest: vi.fn(),
      } as unknown as App['metadataCache'],
    });

    expect(ObsidianHelpers.getSourceFile(makeTFile(), app)).toBeNull();
    expect(app.metadataCache.getFirstLinkpathDest).not.toHaveBeenCalled();
  });

  it('returns null when the source is not a link to a note', () => {
    // a clipped article keeps the URL it came from in the same property
    const app = makeSourceApp('https://example.com/post', null);

    expect(ObsidianHelpers.getSourceFile(makeTFile(), app)).toBeNull();
  });

  it('returns null for a non-string source, rather than resolving it', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.array(fc.string())
        ),
        (source) => {
          const app = makeSourceApp(source, makeTFile());
          expect(ObsidianHelpers.getSourceFile(makeTFile(), app)).toBeNull();
        }
      )
    );
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
    const target = makeTFile({
      path: 'incremental-reading/articles/target.md',
      basename: 'target',
    });
    const source = makeTFile({
      path: 'incremental-reading/articles/source.md',
    });

    const result = ObsidianHelpers.generateMarkdownLink(
      target,
      source,
      app,
      'myAlias'
    );
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
// ensureParentFolder
// ---------------------------------------------------------------------------
describe('ensureParentFolder', () => {
  /** A vault path: segments of any text but a slash, joined by slashes. */
  const segmentArb = fc
    .string({ minLength: 1 })
    .filter((s) => !s.includes('/'));

  it('makes the folder a path goes in when nothing is there, and only then', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
        segmentArb,
        fc.boolean(),
        async (folders, name, exists) => {
          const folderPath = folders.join('/');
          const createFolder = vi.fn().mockResolvedValue(undefined);
          const getAbstractFileByPath = vi.fn((path: string) =>
            exists && path === folderPath ? { path } : null
          );
          const app = makeApp({
            vault: {
              getAbstractFileByPath,
              createFolder,
            } as unknown as App['vault'],
          });

          await ObsidianHelpers.ensureParentFolder(
            app,
            `${folderPath}/${name}`
          );

          expect(createFolder.mock.calls).toEqual(exists ? [] : [[folderPath]]);
        }
      )
    );
  });

  it('makes no folder for a path at the vault root', async () => {
    await fc.assert(
      fc.asyncProperty(segmentArb, async (name) => {
        const createFolder = vi.fn();
        const getAbstractFileByPath = vi.fn(() => null);
        const app = makeApp({
          vault: {
            getAbstractFileByPath,
            createFolder,
          } as unknown as App['vault'],
        });

        await ObsidianHelpers.ensureParentFolder(app, name);

        expect(createFolder).not.toHaveBeenCalled();
        expect(getAbstractFileByPath).not.toHaveBeenCalled();
      })
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

    await ObsidianHelpers.createFile(
      app,
      'incremental-reading/articles/note.md'
    );
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

    await ObsidianHelpers.createFile(
      app,
      'incremental-reading/articles/note.md'
    );
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

    const result = await ObsidianHelpers.createFile(
      app,
      'incremental-reading/articles/note.md'
    );
    // Kills string literal mutant: '' → "Stryker was here!"
    expect(create).toHaveBeenCalledWith(
      'incremental-reading/articles/note.md',
      ''
    );
    expect(result).toBe(createdFile);
  });

  it('rethrows when vault.create fails and logs the correct path', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const path = 'incremental-reading/articles/note.md';
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockRejectedValue(new Error('disk error')),
      } as unknown as App['vault'],
    });

    await expect(ObsidianHelpers.createFile(app, path)).rejects.toThrow(
      'disk error'
    );
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

  it('never edits a file that is not text', async () => {
    await fc.assert(
      fc.asyncProperty(binaryExtensionArb, async (extension) => {
        const process = vi.fn().mockResolvedValue('transformed');
        const fn = vi.fn((data: string) => data);
        const app = makeApp({ vault: { process } as never });

        const result = await ObsidianHelpers.editNote(
          app,
          makeTFile({ extension, path: `a.${extension}` }),
          fn
        );

        expect(result).toBeNull();
        expect(process).not.toHaveBeenCalled();
        expect(fn).not.toHaveBeenCalled();
      })
    );
  });
});

// ---------------------------------------------------------------------------
// isValidRename
// ---------------------------------------------------------------------------
describe('isValidRename', () => {
  /**
   * A character that titles refuse since task 0040, and an old name may hold
   * from before: a control or invisible character, or half a surrogate pair.
   */
  const newlyRefusedCharArb = fc.oneof(
    controlCharArb.filter((char) => !FORBIDDEN_TITLE_CHARS.has(char)),
    invisibleCharArb,
    loneSurrogateArb
  );
  /** A character a new title can't hold. */
  const refusedCharArb = fc.oneof(
    newlyRefusedCharArb,
    fc.constantFrom(...FORBIDDEN_TITLE_CHARS)
  );
  /** Text a title can hold anywhere in it. */
  const plainArb = fc.string({
    unit: fc.constantFrom('a', 'Z', '7', '-', 'é', ' ', '.'),
  });
  /**
   * A name with the `refused` characters inside it, each after a letter: two
   * halves of a surrogate pair side by side would make one character.
   */
  const nameWith = (refused: string[], plain: string[]) =>
    `a${refused.map((char, i) => `${plain[i] ?? ''}b${char}`).join('')}z`;

  it('accepts a name holding only characters a title can hold, start and end clean', () => {
    fc.assert(
      fc.property(plainArb, fc.string(), (plain, oldName) => {
        expect(ObsidianHelpers.isValidRename(`a${plain}z`, oldName)).toBe(true);
      })
    );
  });

  it('accepts a name holding emoji and script sequences whole', () => {
    fc.assert(
      fc.property(fc.array(sequenceArb), plainArb, (sequences, plain) => {
        expect(
          ObsidianHelpers.isValidRename(
            `a${plain}${sequences.join(' ')}z`,
            'Old name'
          )
        ).toBe(true);
      })
    );
  });

  it('refuses a name adding a joiner, variation selector or tag character outside a sequence', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          joinerArb.map((joiner) => `a ${joiner}b`),
          variationSelectorArb.map((selector) => `a ${selector}b`),
          variationSelectorArb.map(
            (selector) => `a${fromCodes(0x2764, 0xfe0f)}${selector}`
          ),
          tagCharArb.map((tag) => `a${tag}b`)
        ),
        (name) => {
          expect(ObsidianHelpers.isValidRename(name, 'Old name')).toBe(false);
        }
      )
    );
  });

  it('accepts a name keeping characters titles newly refuse that the old name held, as many times', () => {
    fc.assert(
      fc.property(
        fc.array(newlyRefusedCharArb, { minLength: 1 }),
        fc.array(plainArb),
        fc.array(plainArb),
        (refused, plainOld, plainNew) => {
          const oldName = nameWith(refused, plainOld);
          // The same characters, in reverse and fewer of them
          const kept = refused.slice(1).reverse();
          expect(
            ObsidianHelpers.isValidRename(nameWith(kept, plainNew), oldName)
          ).toBe(true);
        }
      )
    );
  });

  it('refuses a name holding a character titles always refused, though the old name held it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN_TITLE_CHARS),
        fc.array(plainArb),
        (char, plain) => {
          const oldName = nameWith([char], plain);
          expect(ObsidianHelpers.isValidRename(`${oldName}2`, oldName)).toBe(
            false
          );
          expect(ObsidianHelpers.isValidRename(oldName, oldName)).toBe(false);
        }
      )
    );
  });

  it('refuses a name holding a newly refused character more times than the old name', () => {
    const rlm = fromCodes(0x200f);
    expect(ObsidianHelpers.isValidRename(`a${rlm}b${rlm}c`, `a${rlm}b`)).toBe(
      false
    );
    expect(ObsidianHelpers.isValidRename(`a${rlm}c`, `a${rlm}b`)).toBe(true);
  });

  it('allows only what the old name held outside a sequence, not what a sequence there needed', () => {
    const selector = fromCodes(0xfe0f);
    const joiner = fromCodes(0x200d);
    const heart = `${fromCodes(0x2764)}${selector}`;
    const family = fromCodes(0x1f468, 0x200d, 0x1f469);
    expect(
      ObsidianHelpers.isValidRename(`${selector}Heart`, `${heart} Heart`)
    ).toBe(false);
    expect(
      ObsidianHelpers.isValidRename(`${joiner}${fromCodes(0x1f469)}`, family)
    ).toBe(false);
    // A stray in the old name grants one in the new
    expect(
      ObsidianHelpers.isValidRename(`a ${selector}b2`, `a ${selector}b`)
    ).toBe(true);
  });

  it('refuses to keep the path an imported note name can hide in backslashes', () => {
    const oldName = 'Paper\\..\\..\\pwn';
    expect(ObsidianHelpers.isValidRename('Paper\\..\\..\\pwn2', oldName)).toBe(
      false
    );
    expect(ObsidianHelpers.isValidRename('Paper 2', oldName)).toBe(true);
  });

  it('refuses a name adding a character a title can not hold, more times than the old name had it', () => {
    fc.assert(
      fc.property(
        fc.array(newlyRefusedCharArb),
        refusedCharArb,
        fc.array(plainArb),
        fc.array(plainArb),
        (refused, added, plainOld, plainNew) => {
          const oldName = nameWith(refused, plainOld);
          expect(
            ObsidianHelpers.isValidRename(
              nameWith([...refused, added], plainNew),
              oldName
            )
          ).toBe(false);
        }
      )
    );
  });

  it('refuses an empty name, which would leave only the extension', () => {
    fc.assert(
      fc.property(fc.string(), (oldName) => {
        expect(ObsidianHelpers.isValidRename('', oldName)).toBe(false);
      })
    );
  });

  it('refuses a name starting or ending with whitespace or a dot, whatever the old name was', () => {
    fc.assert(
      fc.property(
        plainArb,
        fc.constantFrom(' ', '.', '\t'),
        fc.boolean(),
        (plain, edge, atStart) => {
          const name = atStart ? `${edge}a${plain}` : `a${plain}${edge}`;
          expect(ObsidianHelpers.isValidRename(name, name)).toBe(false);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// restoreName
// ---------------------------------------------------------------------------
describe('restoreName', () => {
  /** No parent, the vault root, or a folder any number of levels deep. */
  const parentArb = fc.oneof(
    fc.constant(null),
    fc.constant('/'),
    fc
      .array(
        fc
          .string({ minLength: 1 })
          .filter((s) => !/[\\/]/.test(s) && s !== '..' && s !== '.'),
        { minLength: 1 }
      )
      .map((segments) => segments.join('/'))
  );
  const extensionArb = fc.oneof(
    fc.constantFrom('md', 'pdf'),
    fc.string().filter((ext) => !/[\\/]/.test(ext))
  );
  /** Any name, path separators, dots and `..` included. */
  const nameArb = fc.string({
    unit: fc.oneof(
      controlCharArb,
      invisibleCharArb,
      fc.constantFrom(
        ...FORBIDDEN_TITLE_CHARS,
        '.',
        ' ',
        '..',
        '\\..\\',
        '/../'
      ),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })
    ),
  });

  function makeRestore(parentPath: string | null, extension: string) {
    const renameFile = vi
      .fn<(file: TFile, path: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const app = makeApp({
      fileManager: { renameFile } as unknown as App['fileManager'],
    });
    const file = makeTFile({
      extension,
      parent: (parentPath === null
        ? null
        : { path: parentPath }) as TFile['parent'],
    });
    return { renameFile, app, file };
  }

  it('puts back any name without a path separator in place, one renameFile would refuse included', async () => {
    await fc.assert(
      fc.asyncProperty(
        nameArb.filter((name) => !/[\\/]/.test(name)),
        parentArb,
        extensionArb,
        async (name, parentPath, extension) => {
          const { renameFile, app, file } = makeRestore(parentPath, extension);

          await ObsidianHelpers.restoreName(file, name, app);

          const folder =
            parentPath === null || parentPath === '/' ? '' : `${parentPath}/`;
          expect(renameFile.mock.calls).toEqual([
            [file, `${folder}${name}.${extension}`],
          ]);
        }
      )
    );
  });

  it('refuses a name holding `/` or `\\`, which Obsidian reads as a path', async () => {
    await fc.assert(
      fc.asyncProperty(
        nameArb,
        fc.constantFrom('/', '\\'),
        nameArb,
        parentArb,
        async (before, separator, after, parentPath) => {
          const { renameFile, app, file } = makeRestore(parentPath, 'md');
          await expect(
            ObsidianHelpers.restoreName(
              file,
              `${before}${separator}${after}`,
              app
            )
          ).rejects.toThrow(INVALID_TITLE_MESSAGE);
          expect(renameFile).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('never moves a note out of its folder, whatever the name', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, parentArb, async (name, parentPath) => {
        const { renameFile, app, file } = makeRestore(parentPath, 'md');
        await ObsidianHelpers.restoreName(file, name, app).catch(() => {});
        for (const [, path] of renameFile.mock.calls) {
          // As Obsidian's normalizePath reads it, `\` a separator too
          const resolved = posix.normalize(path.replace(/\\/g, '/'));
          const folder =
            parentPath === null || parentPath === '/' ? '.' : parentPath;
          expect(posix.dirname(resolved)).toBe(posix.normalize(folder));
        }
      })
    );
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

    await expect(
      ObsidianHelpers.renameFile(file, nameWithForbidden, app)
    ).rejects.toThrow(INVALID_TITLE_MESSAGE);
  });

  it('throws for any name containing a forbidden title char', async () => {
    const app = makeApp();
    const file = makeTFile();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...[...FORBIDDEN_TITLE_CHARS]),
        async (ch) => {
          const name = `valid${ch}name`;
          await expect(
            ObsidianHelpers.renameFile(file, name, app)
          ).rejects.toThrow();
        }
      )
    );
  });

  it('refuses a name holding a control, DEL or bidi character', async () => {
    const renameFile = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      fileManager: {
        renameFile,
        processFrontMatter: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(controlCharArb, invisibleCharArb),
        async (ch) => {
          await expect(
            ObsidianHelpers.renameFile(makeTFile(), `valid${ch}name`, app)
          ).rejects.toThrow(INVALID_TITLE_MESSAGE);
        }
      )
    );
    expect(renameFile).not.toHaveBeenCalled();
  });

  it('renames a note whose name already holds a control or invisible character, kept in the new name', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          controlCharArb.filter((char) => !FORBIDDEN_TITLE_CHARS.has(char)),
          invisibleCharArb
        ),
        async (ch) => {
          const renameFile = vi
            .fn<(file: TFile, path: string) => Promise<void>>()
            .mockResolvedValue(undefined);
          const app = makeApp({
            fileManager: { renameFile } as unknown as App['fileManager'],
          });
          const file = makeTFile({ basename: `old${ch}name` });
          await ObsidianHelpers.renameFile(file, `old${ch}name 2`, app);
          expect(renameFile.mock.calls).toEqual([
            [file, `${file.parent!.path}/old${ch}name 2.md`],
          ]);
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
      parent: {
        path: 'incremental-reading/articles',
        name: 'articles',
      } as TFile['parent'],
      extension: 'md',
    });

    await ObsidianHelpers.renameFile(file, 'new-name', app);
    expect(renameFile).toHaveBeenCalledWith(
      file,
      'incremental-reading/articles/new-name.md'
    );
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
    const file = makeTFile({
      parent: null as unknown as TFile['parent'],
      extension: 'md',
    });

    await ObsidianHelpers.renameFile(file, 'new-name', app);
    expect(renameFile).toHaveBeenCalledWith(file, 'new-name.md');
  });

  it('throws when sanitized name differs from the input (trailing period)', async () => {
    const app = makeApp();
    const file = makeTFile();
    await expect(
      ObsidianHelpers.renameFile(file, 'name.', app)
    ).rejects.toThrow(INVALID_TITLE_MESSAGE);
  });

  it('throws when sanitized name differs from the input (trailing space)', async () => {
    const app = makeApp();
    const file = makeTFile();
    await expect(
      ObsidianHelpers.renameFile(file, 'name ', app)
    ).rejects.toThrow(INVALID_TITLE_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// _mergeTags
// ---------------------------------------------------------------------------
describe('_mergeTags', () => {
  it('drops tags already present', () => {
    expect(ObsidianHelpers._mergeTags(['tag-a'], ['tag-a', 'tag-b'])).toEqual([
      'tag-a',
      'tag-b',
    ]);
  });

  it('accepts a lone string on either side', () => {
    expect(ObsidianHelpers._mergeTags('tag-a', 'tag-b')).toEqual([
      'tag-a',
      'tag-b',
    ]);
  });

  it('returns only the added tags when there are none yet', () => {
    expect(ObsidianHelpers._mergeTags(undefined, ['new-tag'])).toEqual([
      'new-tag',
    ]);
  });

  it('holds no empty entries and no duplicates', () => {
    fc.assert(
      fc.property(rawTagsArb, tagUpdateArb, (existing, added) => {
        const result = ObsidianHelpers._mergeTags(existing, added);
        expect(result.filter(isEmptyTag)).toEqual([]);
        expect(new Set(result).size).toBe(result.length);
      })
    );
  });

  it('keeps every existing entry in order, then adds the new ones', () => {
    fc.assert(
      fc.property(rawTagsArb, tagUpdateArb, (existing, added) => {
        const kept = [
          ...new Set(toList(existing).filter((tag) => !isEmptyTag(tag))),
        ];
        const fresh = toList(added).filter(
          (tag) => !isEmptyTag(tag) && !kept.includes(tag)
        );
        expect(ObsidianHelpers._mergeTags(existing, added)).toEqual([
          ...kept,
          ...new Set(fresh),
        ]);
      })
    );
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

  it('writes the merge of the existing and updated tags', async () => {
    await fc.assert(
      fc.asyncProperty(
        existingTagsArb,
        tagUpdateArb,
        fc.array(fc.string()),
        async (existing, tags, merged) => {
          const mergeTags = vi
            .spyOn(ObsidianHelpers, '_mergeTags')
            .mockReturnValue(merged);
          const fm = makeFrontmatter(existing);
          await ObsidianHelpers.updateFrontMatter(
            makeTFile(),
            { tags },
            makeFrontmatterApp(fm)
          );
          expect(mergeTags).toHaveBeenCalledTimes(1);
          expect(mergeTags).toHaveBeenCalledWith(
            existing === ABSENT ? undefined : existing,
            tags
          );
          expect(fm.tags).toBe(merged);
          mergeTags.mockRestore();
        }
      )
    );
  });

  it('leaves tags untouched when the update carries none', async () => {
    await fc.assert(
      fc.asyncProperty(existingTagsArb, fc.string(), async (existing, id) => {
        const fm = makeFrontmatter(existing);
        await ObsidianHelpers.updateFrontMatter(
          makeTFile(),
          { 'ir-id': id },
          makeFrontmatterApp(fm)
        );
        expect(fm['ir-id']).toBe(id);
        expect('tags' in fm).toBe(existing !== ABSENT);
        expect(fm.tags).toBe(existing === ABSENT ? undefined : existing);
      })
    );
  });

  it('never writes to a file without frontmatter', async () => {
    await fc.assert(
      fc.asyncProperty(
        binaryExtensionArb,
        frontMatterUpdatesArb,
        async (extension, updates) => {
          const processFrontMatter = vi.fn();
          const process = vi.fn();
          const app = makeApp({
            fileManager: { processFrontMatter } as never,
            vault: { process } as never,
          });
          await ObsidianHelpers.updateFrontMatter(
            makeTFile({ extension, path: `a.${extension}` }),
            updates,
            app
          );
          expect(processFrontMatter).not.toHaveBeenCalled();
          expect(process).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('writes the other updated properties alongside the tags', async () => {
    await fc.assert(
      fc.asyncProperty(
        existingTagsArb,
        tagUpdateArb,
        fc.string(),
        async (existing, tags, id) => {
          const fm = makeFrontmatter(existing);
          await ObsidianHelpers.updateFrontMatter(
            makeTFile(),
            { 'ir-id': id, tags },
            makeFrontmatterApp(fm)
          );
          expect(fm['ir-id']).toBe(id);
          expect(fm.title).toBe('x');
        }
      )
    );
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
    expect(create).toHaveBeenCalledWith(
      `${DATA_DIRECTORY}/articles/note.md`,
      ''
    );
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
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
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

  // Import-as-copy: the copy carries the source's frontmatter, gets `created`
  // from createNote, then the item tag
  it('an untagged note created then tagged holds only the item tag', async () => {
    const fm = makeFrontmatter(ABSENT);
    const app = makeFrontmatterApp(fm);
    const file = await ObsidianHelpers.createNote({
      content: 'body',
      frontmatter: { created: '2026-01-01T00:00:00.000Z' },
      fileName: 'note.md',
      directory: `${DATA_DIRECTORY}/articles`,
      app,
    });
    await ObsidianHelpers.updateFrontMatter(file!, { tags: ARTICLE_TAG }, app);
    expect(fm.tags).toEqual([ARTICLE_TAG]);
  });

  it('a note created then tagged keeps its own tags and gains the item tag', async () => {
    await fc.assert(
      fc.asyncProperty(
        existingTagsArb,
        itemTagArb,
        async (existing, itemTag) => {
          const fm = makeFrontmatter(existing);
          const app = makeFrontmatterApp(fm);
          const file = await ObsidianHelpers.createNote({
            content: 'body',
            frontmatter: { created: '2026-01-01T00:00:00.000Z' },
            fileName: 'note.md',
            directory: `${DATA_DIRECTORY}/articles`,
            app,
          });
          await ObsidianHelpers.updateFrontMatter(
            file!,
            { tags: itemTag },
            app
          );
          const result = fm.tags as unknown[];
          expect(result.filter(isEmptyTag)).toEqual([]);
          expect(result).toContain(itemTag);
          const userTags = existing === ABSENT ? [] : toList(existing);
          for (const tag of userTags.filter((t) => !isEmptyTag(t))) {
            expect(result).toContain(tag);
          }
        }
      )
    );
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

    const result = await ObsidianHelpers.createFromText(
      'some text',
      `${DATA_DIRECTORY}/articles`,
      app
    );
    expect(result).toBe(createdFile);
    // Kills string mutant: `${newNoteName}.md` → `""` — path must end with .md
    const calledPath = (create.mock.calls[0] as string[])[0];
    expect(calledPath).toMatch(/\.md$/);
  });

  it('names the note after the title text when given one, holding the text itself', async () => {
    const create = vi.fn().mockResolvedValue(makeTFile());
    const append = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create,
        append,
      } as unknown as App['vault'],
      fileManager: {
        processFrontMatter: vi.fn().mockResolvedValue(undefined),
        renameFile: vi.fn(),
        generateMarkdownLink: vi.fn(),
      } as unknown as App['fileManager'],
    });

    await ObsidianHelpers.createFromText(
      String.raw`\[\[Note\|alias]] more`,
      `${DATA_DIRECTORY}/snippets`,
      app,
      '[[Note|alias]] more'
    );

    const [path] = create.mock.calls[0] as [string];
    expect(path).toMatch(
      new RegExp(`^${DATA_DIRECTORY}/snippets/alias more - [^/]+\\.md$`)
    );
    const written = (append.mock.calls as [unknown, string][])
      .map(([, text]) => text)
      .join('');
    expect(written).toBe(String.raw`\[\[Note\|alias]] more`);
  });

  it('names the note without the tabs, carriage returns and bidi overrides in its text', async () => {
    const create = vi.fn().mockResolvedValue(makeTFile());
    const app = makeApp({
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        createFolder: vi.fn().mockResolvedValue(undefined),
        create,
        append: vi.fn().mockResolvedValue(undefined),
      } as unknown as App['vault'],
    });

    await ObsidianHelpers.createFromText(
      '\tOne\r\ntwo\tthree report\u202efdp.exe',
      `${DATA_DIRECTORY}/snippets`,
      app
    );

    const [path] = create.mock.calls[0] as [string];
    expect(path).toMatch(
      new RegExp(
        `^${DATA_DIRECTORY}/snippets/One  two three reportfdp\\.exe - [^/]+\\.md$`
      )
    );
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
      ObsidianHelpers.createFromText(
        'content',
        `${DATA_DIRECTORY}/articles`,
        app
      )
    ).rejects.toThrow('Failed to create note');
  });

  it('uses a created timestamp in the frontmatter', async () => {
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
    let capturedFm: Record<string, unknown> = {};
    const processFrontMatter = vi
      .fn()
      .mockImplementation(
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

    await ObsidianHelpers.createFromText(
      'text',
      `${DATA_DIRECTORY}/articles`,
      app
    );
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
      {
        position: {
          start: { line: 0, col: 0, offset: 0 },
          end: { line: 0, col: 10, offset: 10 },
        },
      },
      {
        position: {
          start: { line: 1, col: 0, offset: 0 },
          end: { line: 1, col: 10, offset: 10 },
        },
      },
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
      {
        position: {
          start: { line: 0, col: 0, offset: 0 },
          end: { line: 0, col: bulletLine.length, offset: bulletLine.length },
        },
      },
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
      {
        position: {
          start: { line: 5, col: 0, offset: 0 },
          end: { line: 5, col: 10, offset: 10 },
        },
      },
      {
        position: {
          start: { line: 6, col: 0, offset: 0 },
          end: { line: 6, col: 10, offset: 10 },
        },
      },
      {
        position: {
          start: { line: 7, col: 0, offset: 0 },
          end: { line: 7, col: 10, offset: 10 },
        },
      },
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
      {
        position: {
          start: { line: 2, col: 0, offset: 0 },
          end: { line: 2, col: 10, offset: 10 },
        },
      },
      {
        position: {
          start: { line: 3, col: 0, offset: 0 },
          end: { line: 3, col: 10, offset: 10 },
        },
      },
      {
        position: {
          start: { line: 4, col: 0, offset: 0 },
          end: { line: 4, col: 10, offset: 10 },
        },
      },
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
      {
        position: {
          start: { line: 1, col: 0, offset: 0 },
          end: { line: 1, col: 5, offset: 5 },
        },
      },
      {
        position: {
          start: { line: 4, col: 0, offset: 0 },
          end: { line: 4, col: bulletLine.length, offset: bulletLine.length },
        },
      },
      {
        position: {
          start: { line: 7, col: 0, offset: 0 },
          end: { line: 7, col: 5, offset: 5 },
        },
      },
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
      {
        position: {
          start: { line: 1, col: 0, offset: 0 },
          end: { line: 1, col: bulletLine.length, offset: bulletLine.length },
        },
      },
      {
        position: {
          start: { line: 4, col: 0, offset: 0 },
          end: { line: 4, col: 5, offset: 5 },
        },
      },
      {
        position: {
          start: { line: 7, col: 0, offset: 0 },
          end: { line: 7, col: 5, offset: 5 },
        },
      },
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
      {
        position: {
          start: { line: 1, col: 0, offset: 0 },
          end: { line: 1, col: 5, offset: 5 },
        },
      },
      {
        position: {
          start: { line: 4, col: 0, offset: 0 },
          end: { line: 4, col: 5, offset: 5 },
        },
      },
      {
        position: {
          start: { line: 7, col: 0, offset: 0 },
          end: { line: 7, col: bulletLine.length, offset: bulletLine.length },
        },
      },
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
      {
        position: {
          start: { line: 1, col: 0, offset: 0 },
          end: { line: 1, col: 5, offset: 5 },
        },
      },
      {
        position: {
          start: { line: 4, col: 0, offset: 0 },
          end: { line: 4, col: 5, offset: 5 },
        },
      },
      {
        position: {
          start: { line: 7, col: 0, offset: 0 },
          end: { line: 7, col: 5, offset: 5 },
        },
      },
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

  it('returns defaultReturn without stripping bullet when cursor is before all list items', () => {
    // Kills mutant: `if (block.lineNumber < start.line) return -1` → `if (false) return -1`
    // With the mutant, the binary search comparator never returns -1, so it goes right/matches
    // the mid-item (returning a truthy match) instead of returning null, causing the bullet
    // prefix to be stripped incorrectly.
    const bulletLine = '- item before all list items';
    const editor = makeEditor({
      getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
      getLine: vi.fn().mockReturnValue(bulletLine),
    });
    const listItems = [
      {
        position: {
          start: { line: 5, col: 0, offset: 0 },
          end: { line: 5, col: 10, offset: 10 },
        },
      },
      {
        position: {
          start: { line: 6, col: 0, offset: 0 },
          end: { line: 6, col: 10, offset: 10 },
        },
      },
      {
        position: {
          start: { line: 7, col: 0, offset: 0 },
          end: { line: 7, col: 10, offset: 10 },
        },
      },
    ];
    const app = makeApp({
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({ listItems }),
      } as unknown as App['metadataCache'],
    });

    const result = ObsidianHelpers.smartGetline(editor, makeTFile(), app);
    // No match → defaultReturn; bullet prefix must NOT be stripped
    expect(result.start).toBe(0);
    expect(result.line).toBe(bulletLine);
    expect(result.end).toBe(bulletLine.length);
  });
});
