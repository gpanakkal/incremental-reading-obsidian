import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from '#/lib/constants';
import type { IrIdWarning } from '#/lib/ir-id-warning-notice';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type IncrementalReadingPlugin from '#/main';
import {
  EditorSelection,
  EditorState,
  Text,
  type Extension,
} from '@codemirror/state';
import fc from 'fast-check';
import type { App, MarkdownFileInfo, TFile } from 'obsidian';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import {
  IR_ID_LOCKED_NOTICE,
  irIdGuardExtension,
  irIdProtectedRange,
} from './IrIdGuardExtension';
import { irPluginFacet } from './irPluginFacet';
import { isExternalSync } from './SnippetHighlightExtension';

// #region HELPERS

const ID = '01234567-89ab-cdef-0123-456789abcdef';

/** The lines of one frontmatter entry, or of a body. */
type Entry = readonly string[];

/** Both line endings a note on disk can use. */
const LINE_BREAKS = ['\n', '\r\n'] as const;

/**
 * A document that keeps its CR characters. `EditorState.create` splits its input
 * on /\r\n?|\n/, so a CRLF file loses every CR before a filter ever sees it;
 * building the `Text` with a `\n` split leaves them in the lines, which is the
 * harsher input for code that walks lines and slices offsets.
 */
function docOf(text: string): Text {
  return Text.of(text.split('\n'));
}

/**
 * Frontmatter entries other than `ir-id`, including keys that merely contain the
 * name, a key whose value mentions it, lines that make the block invalid YAML,
 * and a blank line.
 */
function otherEntryArb(): fc.Arbitrary<Entry> {
  return fc.constantFrom(
    ['tags: ir-article'],
    ['tags:', '  - ir-card', '  - inbox'],
    ['source: "[[Some note]]"'],
    ['my-ir-id: 11111111-1111-1111-1111-111111111111'],
    ['ir-id-old: 22222222-2222-2222-2222-222222222222'],
    ['irid: 3333'],
    ['ir_id: 4444'],
    ['"not-ir-id": 5555'],
    ['priority: 50'],
    ['note: ir-id: not a key here'],
    [': : :'],
    ['tags: [unclosed'],
    ['- stray sequence item'],
    ['']
  );
}

/** Values the plugin or a user could leave on the right of `ir-id:`. */
function valueArb(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant(ID),
    fc.constant(`"${ID}"`),
    fc.constant(`'${ID}'`),
    fc.constant(''),
    fc.constant('{a: 1}'),
    fc.constant('[1, 2]'),
    fc.constant('value # with a comment'),
    fc.constant('---'),
    fc.string({ maxLength: 20 }).filter((value) => !/[\n\r]/.test(value))
  );
}

/**
 * Every shape the `ir-id` entry itself can take: a quoted or bare key, an
 * indented key, any spacing after the colon, and values that run onto later
 * lines as a block scalar, a nested sequence or a wrapped flow collection.
 */
function idEntryArb(): fc.Arbitrary<Entry> {
  const singleLine = fc
    .tuple(
      fc.constantFrom('', ' ', '  ', '\t'),
      fc.constantFrom('ir-id', "'ir-id'", '"ir-id"'),
      fc.constantFrom('', ' ', '  ', '\t'),
      valueArb()
    )
    .map(([indent, key, space, value]) => [`${indent}${key}:${space}${value}`]);

  const multiLine = fc.constantFrom(
    ['ir-id: |', '  aaaa-bbbb', '  cccc-dddd'],
    ['ir-id: >-', '  aaaa-bbbb'],
    ['ir-id: |', '  aaaa', '', '  bbbb'],
    ['ir-id:', '  - aaaa', '  - bbbb'],
    ['ir-id: [', '  aaaa,', '  bbbb ]'],
    ['  ir-id: |', '    indented block scalar']
  );

  return fc.oneof(singleLine, multiLine);
}

/** Body lines, including decoys that would match if the body were searched. */
function bodyArb(): fc.Arbitrary<Entry> {
  return fc.array(
    fc.constantFrom(
      'Some body text.',
      '',
      'ir-id: decoy-in-the-body',
      '---',
      'tags: not-frontmatter'
    ),
    { maxLength: 4 }
  );
}

interface Note {
  before: Entry[];
  after: Entry[];
  body: Entry;
  br: string;
  trailingBreak: boolean;
}

function noteArb(): fc.Arbitrary<Note> {
  return fc.record({
    before: fc.array(otherEntryArb(), { maxLength: 3 }),
    after: fc.array(otherEntryArb(), { maxLength: 3 }),
    body: bodyArb(),
    br: fc.constantFrom(...LINE_BREAKS),
    trailingBreak: fc.boolean(),
  });
}

/** A note whose frontmatter holds `id` among `before` and `after`. */
function assemble(note: Note, id: Entry): string {
  const lines = [
    '---',
    ...note.before.flat(),
    ...id,
    ...note.after.flat(),
    '---',
    ...note.body,
  ];
  return lines.join(note.br) + (note.trailingBreak ? note.br : '');
}

/**
 * Where {@link irIdProtectedRange} should put the span for `id` in a note built
 * by {@link assemble}, and the text that span holds.
 *
 * The span runs from the line break before the entry to just past the one after
 * it. Each bound is the `\n` of its break, since CodeMirror counts only that
 * character as the separator; a CR before it belongs to the line, which is why
 * the guarded text keeps the CR of its last line.
 */
function expectedSpan(
  note: Note,
  id: Entry
): { from: number; to: number; text: string } {
  const prefix = ['---', ...note.before.flat()].join(note.br);
  const cr = note.br.slice(0, -1);
  const text = id.join(note.br) + cr;
  const from = prefix.length + note.br.length - 1;
  return { from, to: from + 1 + text.length + 1, text };
}

const IR_TAGS = [ARTICLE_TAG, SNIPPET_TAG, CARD_TAG] as const;

/** A snippet note with the `ir-id` entry between two editable entries. */
const NOTE = [
  '---',
  'tags: ir-text-snippet',
  `ir-id: ${ID}`,
  'source: "[[Source note]]"',
  '---',
  'Body text.',
  '',
].join('\n');

const ID_LINE = `ir-id: ${ID}`;
/** Offset of the line break before the entry. */
const GUARD_FROM = NOTE.indexOf(ID_LINE) - 1;
/** Offset just past the line break after the entry. */
const GUARD_TO = NOTE.indexOf(ID_LINE) + ID_LINE.length + 1;

interface WireOptions {
  tags?: unknown;
  hasFrontMatter?: boolean;
  hasFile?: boolean;
  hasApp?: boolean;
  /**
   * What the editor knows of the plugin: the whole of it (the default), a
   * plugin with no refusal warning on it yet, or no plugin at all, as in an
   * editor built without {@link irPluginFacet}.
   */
  plugin?: 'full' | 'no-warning' | 'none';
}

const file = { path: 'Snippets/note.md' } as TFile;
const app = {} as App;

/** The stubbed frontmatter read, so a test can assert what it was asked for. */
let frontMatterSpy: MockInstance;

/** The refusal warning's `warn`, as the last {@link wire} installed it. */
let warn: Mock<IrIdWarning['warn']>;

/** The facet a real editor gets from `createIRExtensions`, over `warning`. */
function pluginExtension(
  plugin: WireOptions['plugin'],
  warning: IrIdWarning
): Extension {
  if (plugin === 'none') return [];
  const provided = plugin === 'full' ? { irIdLockedWarning: warning } : {};
  return irPluginFacet.of(provided as unknown as IncrementalReadingPlugin);
}

/**
 * Stubs the metadata-cache reads the guard makes, and returns a state carrying
 * it and a plugin whose refusal warning is a fresh spy.
 *
 * Spies are re-installed and the warning replaced on every call rather than in
 * `afterEach`, which runs once per `it` and not once per generated fast-check
 * case — call counts would otherwise pile up across a property's runs.
 */
function wire(text: string, options: WireOptions = {}): EditorState {
  const {
    hasFrontMatter = true,
    hasFile = true,
    hasApp = true,
    plugin = 'full',
  } = options;
  // Not a destructuring default: `{ tags: undefined }` is a case in its own
  // right — a cached frontmatter block with no tags property.
  const tags = 'tags' in options ? options.tags : [ARTICLE_TAG];

  vi.restoreAllMocks();
  warn = vi.fn<IrIdWarning['warn']>();
  const warning: IrIdWarning = { warn, dispose: vi.fn() };

  const info = {
    file: hasFile ? file : null,
    app: hasApp ? app : undefined,
  } as unknown as MarkdownFileInfo;
  vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({
    info: hasFile || hasApp ? info : null,
    editorView: null,
  });
  frontMatterSpy = vi
    .spyOn(Obsidian, 'getFrontMatter')
    .mockReturnValue(
      hasFrontMatter
        ? ({ tags } as unknown as ReturnType<typeof Obsidian.getFrontMatter>)
        : undefined
    );

  return EditorState.create({
    doc: text,
    extensions: [pluginExtension(plugin, warning), irIdGuardExtension],
  });
}

/** The text `spec` would produce if nothing filtered it. */
function splice(
  text: string,
  from: number,
  to: number,
  insert: string
): string {
  return text.slice(0, from) + insert + text.slice(to);
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('irIdProtectedRange', () => {
  it('covers the ir-id entry and the line break on each side, wherever the entry sits in the block', () => {
    fc.assert(
      fc.property(noteArb(), idEntryArb(), (note, id) => {
        const doc = docOf(assemble(note, id));
        const expected = expectedSpan(note, id);

        const range = irIdProtectedRange(doc);

        expect(range).toEqual([expected.from, expected.to]);
        const [from, to] = range ?? [0, 0];
        expect(doc.sliceString(from, from + 1)).toBe('\n');
        expect(doc.sliceString(from + 1, to - 1)).toBe(expected.text);
        expect(doc.sliceString(to - 1, to)).toBe('\n');
      })
    );
  });

  it('leaves a frontmatter block with no ir-id entry unprotected', () => {
    fc.assert(
      fc.property(noteArb(), (note) => {
        // `assemble` with no entry of its own: `before` and `after` never hold
        // one, and neither does the body.
        expect(irIdProtectedRange(docOf(assemble(note, [])))).toBeNull();
      })
    );
  });

  it('ignores an ir-id entry in frontmatter that does not open on the first line', () => {
    fc.assert(
      fc.property(
        noteArb(),
        idEntryArb(),
        fc.constantFrom('# Title', 'text', '', ' ---', '----'),
        (note, id, lead) => {
          const text = lead + note.br + assemble(note, id);

          expect(irIdProtectedRange(docOf(text))).toBeNull();
        }
      )
    );
  });

  it('ignores an ir-id entry in a frontmatter block that is never closed', () => {
    fc.assert(
      fc.property(noteArb(), idEntryArb(), (note, id) => {
        const lines = [
          '---',
          ...note.before.flat(),
          ...id,
          ...note.after.flat(),
        ];
        const text = lines.join(note.br) + (note.trailingBreak ? note.br : '');

        expect(irIdProtectedRange(docOf(text))).toBeNull();
      })
    );
  });

  it('protects only the first ir-id entry when the block holds more than one', () => {
    const doc = docOf(`---\nir-id: first\nir-id: second\n---\nBody\n`);

    expect(irIdProtectedRange(doc)).toEqual([3, 17]);
    expect(doc.sliceString(4, 16)).toBe('ir-id: first');
  });

  it('protects an ir-id entry nested under another key, erring towards the guard', () => {
    const doc = docOf(`---\nnested:\n  ir-id: ${ID}\ntags: ir-card\n---\n`);

    const range = irIdProtectedRange(doc);

    expect(doc.sliceString((range?.[0] ?? 0) + 1, (range?.[1] ?? 0) - 1)).toBe(
      `  ir-id: ${ID}`
    );
  });

  it.each([
    ['runs on past the fence', '----'],
    ['carries text after the fence', '--- x'],
  ])('does not close the block at a line that %s', (_case, line) => {
    // Obsidian's parser only closes at `---` followed by a line break, so the
    // block runs past this line and the entry below it is still frontmatter.
    const doc = docOf(`---\n${line}\nir-id: ${ID}\n---\nBody\n`);

    const range = irIdProtectedRange(doc);

    expect(doc.sliceString((range?.[0] ?? 0) + 1, (range?.[1] ?? 0) - 1)).toBe(
      `ir-id: ${ID}`
    );
  });

  it('takes the first --- line as the closing fence, the way Obsidian does', () => {
    // No closing fence of its own, so the block runs to the body's rule and the
    // entry inside it is protected.
    const doc = docOf(`---\nir-id: ${ID}\nBody text\n---\nMore body\n`);

    const range = irIdProtectedRange(doc);

    expect(doc.sliceString((range?.[0] ?? 0) + 1, (range?.[1] ?? 0) - 1)).toBe(
      `ir-id: ${ID}`
    );
  });

  it.each([
    ['an empty document', ''],
    ['a document with no frontmatter at all', `Body text\nir-id: ${ID}\n`],
    ['an empty frontmatter block', '---\n---\nBody\n'],
    ['an unterminated fence', '---\n'],
    ['a lone fence', '---'],
    ['a fence pair with no break between them', '---\n---'],
    ['frontmatter holding only invalid YAML', '---\n: : :\n\t- x\n---\n'],
  ])('leaves %s unprotected', (_case, text) => {
    expect(irIdProtectedRange(docOf(text))).toBeNull();
  });

  it('keeps the span inside the document', () => {
    fc.assert(
      fc.property(noteArb(), idEntryArb(), (note, id) => {
        const doc = docOf(assemble(note, id));
        const range = irIdProtectedRange(doc);

        expect(range).not.toBeNull();
        const [from, to] = range ?? [-1, -1];
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeGreaterThan(from);
        expect(to).toBeLessThanOrEqual(doc.length);
      })
    );
  });
});

describe('irIdGuardExtension', () => {
  it('refuses a change that reaches inside the entry, and says why', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // An insertion strictly inside the span.
          fc
            .tuple(
              fc.integer({ min: GUARD_FROM + 1, max: GUARD_TO - 1 }),
              fc.string({ minLength: 1, maxLength: 8 })
            )
            .map(([at, insert]) => ({ from: at, to: at, insert })),
          // A deletion or replacement overlapping it, including one that only
          // takes a line break off either end.
          fc
            .tuple(
              fc.integer({ min: GUARD_FROM, max: GUARD_TO - 1 }),
              fc.integer({ min: 1, max: GUARD_TO - GUARD_FROM }),
              fc.string({ maxLength: 8 })
            )
            .map(([from, length, insert]) => ({
              from,
              to: Math.min(from + length, GUARD_TO),
              insert,
            }))
        ),
        (changes) => {
          const state = wire(NOTE);

          const next = state.update({ changes, userEvent: 'input.type' }).state;

          expect(next.doc.toString()).toBe(NOTE);
          expect(warn).toHaveBeenCalledOnce();
        }
      )
    );
  });

  it('applies a change that stays clear of the entry, including one inserted at either boundary', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .tuple(
              fc.integer({ min: 0, max: GUARD_FROM }),
              fc.integer({ min: 0, max: GUARD_FROM }),
              fc.string({ maxLength: 8 })
            )
            .map(([a, b, insert]) => ({
              from: Math.min(a, b),
              to: Math.max(a, b),
              insert,
            })),
          fc
            .tuple(
              fc.integer({ min: GUARD_TO, max: NOTE.length }),
              fc.integer({ min: GUARD_TO, max: NOTE.length }),
              fc.string({ maxLength: 8 })
            )
            .map(([a, b, insert]) => ({
              from: Math.min(a, b),
              to: Math.max(a, b),
              insert,
            }))
        ),
        ({ from, to, insert }) => {
          const state = wire(NOTE);

          const next = state.update({
            changes: { from, to, insert },
            userEvent: 'input.type',
          }).state;

          expect(next.doc.toString()).toBe(splice(NOTE, from, to, insert));
          expect(warn).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('refuses a change spanning the entry and editable text together, leaving the note as it was', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: GUARD_FROM }),
        fc.integer({ min: GUARD_TO, max: NOTE.length }),
        fc.string({ maxLength: 20 }),
        (from, to, insert) => {
          const state = wire(NOTE);

          const next = state.update({
            changes: { from, to, insert },
            userEvent: 'input.type',
          }).state;

          // Nothing is applied in part: the frontmatter keeps its fences and its
          // other entries rather than being left with a stranded ir-id line.
          expect(next.doc.toString()).toBe(NOTE);
          expect(warn).toHaveBeenCalledOnce();
        }
      )
    );
  });

  it.each([
    ['at the end of the line above the entry', GUARD_FROM],
    ['at the start of the line below the entry', GUARD_TO],
  ])('applies an insertion %s', (_case, at) => {
    const state = wire(NOTE);

    const next = state.update({
      changes: { from: at, insert: 'x' },
      userEvent: 'input.type',
    }).state;

    expect(next.doc.toString()).toBe(splice(NOTE, at, at, 'x'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses select-all-then-type', () => {
    const state = wire(NOTE);

    const next = state.update({
      changes: { from: 0, to: NOTE.length, insert: 'x' },
      selection: EditorSelection.cursor(1),
      userEvent: 'input.type',
    }).state;

    expect(next.doc.toString()).toBe(NOTE);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('lets an external write through, whichever way it arrives', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<('set' | 'external')[]>('set', 'external'),
        fc.string({ maxLength: 12 }),
        (origin, insert) => {
          const state = wire(NOTE);
          const changes = { from: GUARD_FROM + 3, to: GUARD_TO - 2, insert };

          const next = state.update({
            changes,
            // Obsidian pushes a changed file into an open editor as a minimal
            // line diff tagged `set`; IREditor re-syncs its `value` prop under
            // `isExternalSync`.
            ...(origin === 'set'
              ? { userEvent: 'set' }
              : { annotations: isExternalSync.of(true) }),
          }).state;

          expect(next.doc.toString()).toBe(
            splice(NOTE, changes.from, changes.to, insert)
          );
          expect(warn).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('guards a note carrying any of the item tags, alone or among others', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...IR_TAGS),
        // A lone tag sits in the metadata cache as a bare string.
        fc.oneof(
          fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
          fc.constant(null)
        ),
        (itemTag, extraTags) => {
          const state = wire(NOTE, {
            tags: extraTags === null ? itemTag : [...extraTags, itemTag],
          });

          const next = state.update({
            changes: { from: GUARD_FROM + 3, to: GUARD_TO - 2, insert: 'x' },
            userEvent: 'input.type',
          }).state;

          expect(next.doc.toString()).toBe(NOTE);
          expect(warn).toHaveBeenCalledOnce();
        }
      )
    );
  });

  it('leaves a note that is not one of the plugin’s items editable', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .array(
              fc
                .string({ maxLength: 12 })
                .filter((tag) => !IR_TAGS.includes(tag as never)),
              { maxLength: 3 }
            )
            .map((tags) => ({ tags })),
          // Tags absent, not strings at all, and no frontmatter cached at all.
          fc.constant({ tags: undefined }),
          fc.constant({ tags: [1, true, null] }),
          fc.constant({ hasFrontMatter: false }),
          // No file open, and a file with no app on its info.
          fc.constant({ hasFile: false }),
          fc.constant({ hasApp: false })
        ),
        (options: WireOptions) => {
          const state = wire(NOTE, options);

          const next = state.update({
            changes: { from: GUARD_FROM + 3, to: GUARD_TO - 2, insert: 'x' },
            userEvent: 'input.type',
          }).state;

          expect(next.doc.toString()).toBe(
            splice(NOTE, GUARD_FROM + 3, GUARD_TO - 2, 'x')
          );
          expect(warn).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('reads the tags of the file the editor holds', () => {
    const state = wire(NOTE);

    state.update({
      changes: { from: GUARD_FROM + 3, to: GUARD_TO - 2, insert: 'x' },
      userEvent: 'input.type',
    });

    expect(frontMatterSpy).toHaveBeenCalledWith(file, app);
  });

  it('leaves an item note without an ir-id entry fully editable', () => {
    const text = '---\ntags: ir-card\n---\nBody text.\n';
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: text.length }),
        fc.string({ minLength: 1, maxLength: 6 }),
        (at, insert) => {
          const state = wire(text);

          const next = state.update({
            changes: { from: at, to: at, insert },
            userEvent: 'input.type',
          }).state;

          expect(next.doc.toString()).toBe(splice(text, at, at, insert));
          expect(warn).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('passes a transaction that changes nothing but the selection', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: NOTE.length }), (at) => {
        const state = wire(NOTE);

        const next = state.update({
          selection: EditorSelection.cursor(at),
        }).state;

        expect(next.selection.main.head).toBe(at);
        expect(next.doc.toString()).toBe(NOTE);
        expect(warn).not.toHaveBeenCalled();
      })
    );
  });

  it('protects the entry in a file saved with CRLF line endings', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const state = wire(crlf);
    // CodeMirror splits `\r\n` when it builds the document, so the offsets the
    // guard works in are the CR-free ones.
    expect(state.doc.toString()).toBe(NOTE);

    const next = state.update({
      changes: { from: GUARD_FROM + 3, to: GUARD_TO - 2, insert: 'x' },
      userEvent: 'input.type',
    }).state;

    expect(next.doc.toString()).toBe(NOTE);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns once per refused transaction, leaving the folding of repeats to the warning', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (refusals) => {
        const state = wire(NOTE);
        const changes = { from: GUARD_FROM + 3, to: GUARD_TO - 2, insert: 'x' };

        // A key held inside the entry: one refused transaction per repeat
        for (let n = 0; n < refusals; n++) {
          state.update({ changes, userEvent: 'input.type' });
        }

        expect(warn).toHaveBeenCalledTimes(refusals);
      })
    );
  });

  it.each([
    ['has no refusal warning yet', 'no-warning'],
    ['was built without the plugin facet', 'none'],
  ] as const)(
    'still refuses the change, silently, in an editor that %s',
    (_case, plugin) => {
      const state = wire(NOTE, { plugin });

      const next = state.update({
        changes: { from: GUARD_FROM + 3, to: GUARD_TO - 2, insert: 'x' },
        userEvent: 'input.type',
      }).state;

      expect(next.doc.toString()).toBe(NOTE);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it('explains the refusal in a message short enough to read on a phone', () => {
    expect(IR_ID_LOCKED_NOTICE).toContain('ir-id');
    expect(IR_ID_LOCKED_NOTICE.length).toBeLessThanOrEqual(140);
  });
});
