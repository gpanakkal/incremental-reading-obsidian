import {
  CARD_ANSWER_REPLACEMENT,
  CARD_TAG,
  CLOZE_DELIMITERS,
  MS_PER_DAY,
  MS_PER_YEAR,
  SOURCE_INDEX_TIMEOUT_MS,
  VALID_DELIMITER_PATTERN,
} from '#/lib/constants';
import { Markdown } from '#/lib/Markdown';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  decodeAnchor,
  encodeAnchor,
  MAX_ANCHOR_PAGE,
} from '#/lib/pdf/pdf-anchor';
import { formatSourceLink } from '#/lib/source-link';
import type {
  ISRSCard,
  ISRSCardDisplay,
  SQLiteRepository,
  SRSCardRow,
} from '#/lib/types';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { TFile } from 'obsidian';
import { resolve } from 'path';
import type { Database, SqlJsStatic } from 'sql.js';
import initSqlJs from 'sql.js';
import type { FSRSParameters, Grade } from 'ts-fsrs';
import { fsrs, generatorParameters, Rating, State } from 'ts-fsrs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { CardManager } from './CardManager';

// #region HELPERS

/** Expose protected methods for testing */
class TestableCardManager extends CardManager {
  public delimitTextPublic(
    text: string,
    selectionOffsets: readonly [number, number] | null
  ): string[] {
    return this.delimitText(text, selectionOffsets);
  }
}

const [LEFT, RIGHT] = CLOZE_DELIMITERS;

function makeRepo(): SQLiteRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
  } as unknown as SQLiteRepository;
}

function makePlugin(appOverrides: Record<string, unknown> = {}) {
  return {
    // rowToReviewCard reads frontmatter via metadataCache.getFileCache and
    // fire-and-forgets a setFrontmatter write via fileManager.processFrontMatter.
    // Both stubs must resolve cleanly to avoid unhandled rejections.
    app: {
      metadataCache: { getFileCache: () => ({}) },
      fileManager: { processFrontMatter: async () => undefined },
      ...appOverrides,
    },
    // getFsrs() runs the weight migration, which dereferences
    // settings.fsrsParams.w, so any test that reviews a card needs a
    // fully-formed parameter set here. The generated defaults are already
    // normalized, so the migration finds nothing to rewrite and saveSettings
    // is never reached.
    settings: { dayRolloverOffset: 4, fsrsParams: generatorParameters() },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  } as never;
}

/**
 * App overrides whose note at `claimedPath` carries another item's `ir-id`, so
 * the row pointing there is refused as that note's owner.
 */
function claiming(claimedPath: string): Record<string, unknown> {
  return {
    metadataCache: {
      getFileCache: (file: TFile) =>
        file.path === claimedPath
          ? { frontmatter: { 'ir-id': 'another-item', tags: [CARD_TAG] } }
          : {},
    },
  };
}

/** Each reference's own note, so a claimed one can be told apart. */
function noteAt(reference: string): TFile {
  return { path: reference, extension: 'md' } as TFile;
}

/** Build a minimal SRSCardRow. State is stored as a number (enum value). */
function makeCardRow(overrides: Partial<SRSCardRow> = {}): SRSCardRow {
  return {
    id: 'card-1',
    reference: 'cards/test.md',
    created_at: Date.now(),
    due: Date.now() + MS_PER_DAY,
    last_review: null,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    dismissed: 0,
    deleted: false,
    parent: null,
    ...overrides,
  };
}

/** Build a minimal ISRSCardDisplay */
function makeCardDisplay(
  overrides: Partial<ISRSCardDisplay> = {}
): ISRSCardDisplay {
  return {
    id: 'card-1',
    type: 'card',
    reference: 'cards/test.md',
    created_at: new Date(),
    due: new Date(Date.now() + MS_PER_DAY),
    last_review: undefined,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: 'New',
    dismissed: false,
    deleted: false,
    parent: null,
    ...overrides,
  };
}

/** Build a minimal ISRSCard (uses numeric state) */
function makeCardBase(overrides: Partial<ISRSCard> = {}): ISRSCard {
  return {
    id: 'card-1',
    type: 'card',
    reference: 'cards/test.md',
    created_at: new Date(),
    due: new Date(Date.now() + MS_PER_DAY),
    last_review: undefined,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    dismissed: false,
    deleted: false,
    parent: null,
    ...overrides,
  };
}

/** Returns the [sql, params] tuple from the latest call to repo.mutate */
function lastMutateCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/** Returns the [sql, params] tuple from the latest call to repo.query */
function lastQueryCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/**
 * Positions in the params array passed alongside the `UPDATE srs_card SET ...`
 * statement issued by review() and rollbackBeforeReview(). Both build the same
 * column list, so both share these. Keeping them in one place means inserting a
 * column mid-list is a single edit here instead of a hunt for magic indices.
 */
const UPDATE_PARAM = {
  due: 0,
  lastReview: 1,
  stability: 2,
  difficulty: 3,
  elapsedDays: 4,
  scheduledDays: 5,
  learningSteps: 6,
  reps: 7,
  lapses: 8,
  state: 9,
  id: 10,
} as const;

/** Arbitrary covering all 4 numeric State values */
const stateArb = fc.constantFrom(
  State.New,
  State.Learning,
  State.Review,
  State.Relearning
);

/** Arbitrary covering all StateType string values */
const stateTypeArb = fc.constantFrom('New', 'Learning', 'Review', 'Relearning');

/** Arbitrary for a valid SRSCardRow */
const cardRowArb: fc.Arbitrary<SRSCardRow> = fc.record<SRSCardRow>({
  id: fc.uuid(),
  reference: fc.string({ minLength: 1 }),
  created_at: fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
  due: fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
  last_review: fc.oneof(
    fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
    fc.constant(null)
  ),
  stability: fc.double({ min: 0, max: 1000, noNaN: true }),
  difficulty: fc.double({ min: 0, max: 10, noNaN: true }),
  elapsed_days: fc.integer({ min: 0, max: 36500 }),
  scheduled_days: fc.integer({ min: 0, max: 36500 }),
  learning_steps: fc.nat({ max: 5 }),
  reps: fc.integer({ min: 0, max: 10000 }),
  lapses: fc.integer({ min: 0, max: 10000 }),
  state: stateArb,
  dismissed: fc.oneof(fc.constant(0 as const), fc.constant(1 as const)),
  deleted: fc.boolean(),
  parent: fc.constant(null),
});

/** Valid delimiter pairs for testing getClozeGroupsPattern */
const delimiterArb = fc
  .tuple(
    fc.stringMatching(VALID_DELIMITER_PATTERN),
    fc.stringMatching(VALID_DELIMITER_PATTERN)
  )
  .filter(([l, r]) => l !== r);

/**
 * An `Editor` over a plain string, covering what card creation touches:
 * positions to and from offsets, reads, replacements, and the cursor.
 */
function makeEditor(initial: string) {
  let text = initial;
  const posToOffset = ({ line, ch }: { line: number; ch: number }) =>
    text
      .split('\n')
      .slice(0, line)
      .reduce((sum, l) => sum + l.length + 1, 0) + ch;
  return {
    get text() {
      return text;
    },
    getValue: () => text,
    offsetToPos: (offset: number) => {
      const lines = text.slice(0, offset).split('\n');
      return { line: lines.length - 1, ch: lines[lines.length - 1].length };
    },
    getRange: (
      from: { line: number; ch: number },
      to: { line: number; ch: number }
    ) => text.slice(posToOffset(from), posToOffset(to)),
    replaceRange: vi.fn(
      (
        insert: string,
        from: { line: number; ch: number },
        to: { line: number; ch: number }
      ) => {
        text =
          text.slice(0, posToOffset(from)) +
          insert +
          text.slice(posToOffset(to));
      }
    ),
    setSelection: vi.fn(),
    lastLine: () => text.split('\n').length - 1,
  };
}

/**
 * A note's text with a span in it and an answer in that span, none of it
 * holding cloze delimiters, which `delimitText` would strip. The answer is
 * never empty: the answer prompt refuses to confirm without one.
 */
const cardSelectionArb = fc
  .tuple(
    fc.string({ maxLength: 20 }),
    fc.string({ maxLength: 10 }),
    fc.string({ minLength: 1, maxLength: 10 }),
    fc.string({ maxLength: 10 }),
    fc.string({ maxLength: 20 })
  )
  .filter((parts) =>
    parts.every((p) => !p.includes(LEFT) && !p.includes(RIGHT))
  )
  .map(([before, pre, answer, post, after]) => ({
    before,
    pre,
    answer,
    post,
    after,
    text: pre + answer + post,
    selection: {
      from: before.length,
      to: before.length + pre.length + answer.length + post.length,
      text: pre + answer + post,
    },
    answerBounds: [pre.length, pre.length + answer.length] as const,
  }));

/**
 * {@link cardSelectionArb} with no backslash, whose escapes would move the
 * span and the answer when the card is made of a note: see
 * {@link escapedCardSelectionArb}.
 */
const unescapedCardSelectionArb = cardSelectionArb.filter(
  ({ before, text, after }) => !(before + text + after).includes('\\')
);

/**
 * A note thick with backslashes and what they escape, with a span chosen in
 * it and an answer in that span: either may start or end anywhere, between a
 * backslash and its char included. It holds no cloze delimiters, which
 * `delimitText` strips from the card: a backslash before one the note holds
 * is left to escape the new delimiter (`x\(}y`, answer `y`), a case no
 * snap of the selection sees.
 */
const escapedCardSelectionArb = fc
  .string({
    unit: fc.oneof(
      fc.constantFrom('\\', '\\\\', '#', '[', '(', '}', 'a', ' ', '\n'),
      fc.string({ minLength: 1, maxLength: 1 })
    ),
    minLength: 1,
    maxLength: 30,
  })
  .filter((doc) => !doc.includes(LEFT) && !doc.includes(RIGHT))
  .chain((doc) =>
    fc
      .tuple(fc.nat(doc.length), fc.nat(doc.length))
      .filter(([x, y]) => x !== y)
      .chain(([x, y]) => {
        const [from, to] = [Math.min(x, y), Math.max(x, y)];
        return fc
          .tuple(fc.nat(to - from), fc.nat(to - from))
          .filter(([a, b]) => a !== b)
          .map(([a, b]) => ({
            doc,
            selection: { from, to, text: doc.slice(from, to) },
            answer: [Math.min(a, b), Math.max(a, b)] as const,
          }));
      })
  );

/** Whether `text` ends in a backslash that escapes whatever follows it. */
const endsInEscape = (text: string) => (/\\*$/.exec(text)![0].length & 1) === 1;

/**
 * Text a PDF hands over, rich in Markdown and the cloze delimiters, and the
 * range of its answer.
 */
const pdfTextArb = fc
  .string({
    unit: fc.oneof(
      fc.constantFrom(
        LEFT,
        RIGHT,
        '{{',
        '}}',
        '![[x]]',
        '#tag',
        '_',
        '<%',
        '\\',
        '\n',
        ' ',
        '\u00a0',
        '- ',
        '1. ',
        '(',
        ')',
        '{',
        '}'
      ),
      fc.string({ minLength: 1, maxLength: 1 })
    ),
    minLength: 1,
    maxLength: 30,
  })
  .chain((text) =>
    fc.tuple(fc.nat(text.length), fc.nat(text.length)).map(([x, y]) => ({
      text,
      answer: [Math.min(x, y), Math.max(x, y)] as [number, number],
    }))
  );

/**
 * A repo backed by a real in-memory database. Params are coerced exactly as
 * SQLJSRepository.coerceParams does, so placeholder binding behaves the same
 * way it does in production.
 */
function makeRealRepo(db: Database): SQLiteRepository {
  const run = (sql: string, params: unknown[] = []) => {
    const bound = params.map((param) => {
      if (typeof param === 'boolean') return Number(param);
      if (param === undefined) return null;
      return param;
    });
    const results = db.exec(sql, bound as never);
    if (!results.length) return [];
    const { columns, values } = results[0];
    return values.map((row) =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]]))
    );
  };
  return {
    query: vi.fn().mockImplementation(run),
    mutate: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      run(sql, params);
      return [[]];
    }),
    _execSql: vi.fn(),
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
  } as unknown as SQLiteRepository;
}

// #endregion

describe('rowToDisplay', () => {
  it('converts created_at and due from ms timestamps to Date objects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),

        async (createdAt, due) => {
          const row = { created_at: createdAt, due } as SRSCardRow;
          const display = CardManager.rowToDisplay(row);
          expect(display.created_at).toBeInstanceOf(Date);
          expect(display.due).toBeInstanceOf(Date);
          expect(display.created_at.getTime()).toBe(row.created_at);
          expect(display.due.getTime()).toBe(row.due);
        }
      )
    );
  });

  it('converts last_review from ms to Date when present, omits it when null', async () => {
    const rowArbNonZeroLastReview = cardRowArb.map((r) =>
      r.last_review === 0 ? { ...r, last_review: 1 } : r
    );
    await fc.assert(
      fc.asyncProperty(rowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        if (row.last_review !== null) {
          expect(display.last_review).toBeInstanceOf(Date);
          expect(display.last_review!.getTime()).toBe(row.last_review);
        } else {
          expect(display.last_review).toBeUndefined();
        }
      })
    );
  });

  it('converts dismissed number to boolean', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(display.dismissed).toBe(!!row.dismissed);
      })
    );
  });

  it('converts numeric state to StateType string', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(typeof display.state).toBe('string');
        expect(display.state).toBe(State[row.state]);
      })
    );
  });

  it('sets type to "card"', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(display.type).toBe('card');
      })
    );
  });

  it('passes through non-date scalar fields unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(display.id).toBe(row.id);
        expect(display.reference).toBe(row.reference);
        expect(display.stability).toBe(row.stability);
        expect(display.difficulty).toBe(row.difficulty);
        expect(display.elapsed_days).toBe(row.elapsed_days);
        expect(display.scheduled_days).toBe(row.scheduled_days);
        expect(display.reps).toBe(row.reps);
        expect(display.lapses).toBe(row.lapses);
      })
    );
  });
});

/** last_review=0 is excluded from round-trip tests: rowToDisplay maps 0 to undefined (truthy-check bug).
 * Tests are written for the fixed version (last_review >= 1 when present). */
const cardRowArbNonZeroLastReview = cardRowArb.map((r) =>
  r.last_review === 0 ? { ...r, last_review: 1 } : r
);

describe('displayToRow', () => {
  it('converts created_at and due Date objects back to ms timestamps', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.created_at).toBe(row.created_at);
        expect(backToRow.due).toBe(row.due);
      })
    );
  });

  it('converts last_review Date to ms, null when absent', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        if (row.last_review !== null) {
          expect(backToRow.last_review).toBe(row.last_review);
        } else {
          expect(backToRow.last_review).toBeNull();
        }
      })
    );
  });

  it('converts dismissed boolean to 0 or 1', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.dismissed).toBe(row.dismissed ? 1 : 0);
      })
    );
  });

  it('converts StateType string back to numeric state', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.state).toBe(row.state);
      })
    );
  });

  it('strips the type field', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect('type' in backToRow).toBe(false);
      })
    );
  });

  it('round-trips: displayToRow(rowToDisplay(row)) equals the original row', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.id).toBe(row.id);
        expect(backToRow.reference).toBe(row.reference);
        expect(backToRow.stability).toBe(row.stability);
        expect(backToRow.difficulty).toBe(row.difficulty);
        expect(backToRow.elapsed_days).toBe(row.elapsed_days);
        expect(backToRow.scheduled_days).toBe(row.scheduled_days);
        expect(backToRow.reps).toBe(row.reps);
        expect(backToRow.lapses).toBe(row.lapses);
      })
    );
  });
});

describe('baseToRow', () => {
  it('converts created_at and due Date to ms timestamps', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        // Build an ISRSCard from the row (state stays numeric in ISRSCard)
        const base = makeCardBase({
          id: row.id,
          reference: row.reference,
          created_at: new Date(row.created_at),
          due: new Date(row.due),
          last_review: row.last_review ? new Date(row.last_review) : undefined,
          dismissed: !!row.dismissed,
          stability: row.stability,
          difficulty: row.difficulty,
          elapsed_days: row.elapsed_days,
          scheduled_days: row.scheduled_days,
          reps: row.reps,
          lapses: row.lapses,
          state: row.state,
        });
        const result = CardManager.baseToRow(base);
        expect(result.created_at).toBe(base.created_at.getTime());
        expect(result.due).toBe(base.due.getTime());
      })
    );
  });

  it('converts last_review Date to ms, null when absent', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const base = makeCardBase({
          last_review: row.last_review ? new Date(row.last_review) : undefined,
        });
        const result = CardManager.baseToRow(base);
        if (base.last_review) {
          expect(result.last_review).toBe(base.last_review.getTime());
        } else {
          expect(result.last_review).toBeNull();
        }
      })
    );
  });

  it('converts dismissed boolean to 0 or 1', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (dismissed) => {
        const base = makeCardBase({ dismissed });
        const result = CardManager.baseToRow(base);
        expect(result.dismissed).toBe(dismissed ? 1 : 0);
      })
    );
  });

  it('strips the type field', async () => {
    const base = makeCardBase();
    const result = CardManager.baseToRow(base);
    expect('type' in result).toBe(false);
  });
});

describe('getClozeGroupsPattern', () => {
  it('returns a RegExp that matches a string with the given delimiters', async () => {
    await fc.assert(
      fc.asyncProperty(
        delimiterArb,
        fc.string(),
        fc.string(),
        fc.string(),
        async ([left, right], pre, answer, post) => {
          const pattern = CardManager.getClozeGroupsPattern([left, right]);
          const text = `${pre}${left}${answer}${right}${post}`;
          const match = text.match(pattern);
          expect(match).not.toBeNull();
        }
      )
    );
  });

  it('captures pre, answer, and post in groups 1, 2, 3', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (pre, answer, post) => {
          const pattern = CardManager.getClozeGroupsPattern(CLOZE_DELIMITERS);
          const text = `${pre}${LEFT}${answer}${RIGHT}${post}`;
          const match = text.match(pattern);
          expect(match).not.toBeNull();
          expect(match![1]).toBe(pre);
          expect(match![2]).toBe(answer);
          expect(match![3]).toBe(post);
        }
      )
    );
  });

  it('does not match a string without the delimiters', () => {
    const pattern = CardManager.getClozeGroupsPattern(CLOZE_DELIMITERS);
    const text = 'no cloze delimiters here';
    expect(text.match(pattern)).toBeNull();
  });

  it('treats delimiter characters as literals, not regex metacharacters', () => {
    // Use delimiters that contain regex special chars
    const specialDelimiters: [string, string] = ['(', ')'];
    const pattern = CardManager.getClozeGroupsPattern(specialDelimiters);
    const text = '(answer)';
    const match = text.match(pattern);
    expect(match).not.toBeNull();
    expect(match![2]).toBe('answer');
  });
});

describe('hideAnswer', () => {
  it('replaces the answer between CLOZE_DELIMITERS with the placeholder', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (pre, answer, post) => {
          const content = `${pre}${LEFT}${answer}${RIGHT}${post}`;
          const result = CardManager.hideAnswer(content);
          expect(result).toBe(pre + CARD_ANSWER_REPLACEMENT + post);
        }
      )
    );
  });

  it('throws with a message mentioning the content when no valid cloze delimiters found', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (content) => {
          let caught: unknown;
          try {
            CardManager.hideAnswer(content);
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toContain(content);
        }
      )
    );
  });

  it('does not include the answer text in the output', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter(
          (s) =>
            !s.includes(LEFT) &&
            !s.includes(RIGHT) &&
            !CARD_ANSWER_REPLACEMENT.includes(s) // avoid false positives when answer is a substring of the placeholder
        ),
        async (answer) => {
          const content = `${LEFT}${answer}${RIGHT}`;
          const result = CardManager.hideAnswer(content);
          expect(result).not.toContain(answer);
        }
      )
    );
  });
});

describe('parseCloze', () => {
  it('returns start, answer, end for text with the given delimiters', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (start, answer, end) => {
          const repo = makeRepo();
          const manager = new CardManager(makePlugin(), repo);
          const text = `${start}${LEFT}${answer}${RIGHT}${end}`;
          const result = manager.parseCloze(text, CLOZE_DELIMITERS);
          expect(result.start).toBe(start);
          expect(result.answer).toBe(answer);
          expect(result.end).toBe(end);
        }
      )
    );
  });

  it('throws when the delimiters are not found in the text', () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    expect(() =>
      manager.parseCloze('no delimiters here', CLOZE_DELIMITERS)
    ).toThrow();
  });

  it('throws when given invalid delimiters', async () => {
    const invalidDelimiterArb = fc
      .string({ minLength: 1 })
      .filter((s) => !/^[^\w\s].*[^\w\s]$/.test(s));
    // At least one of the two delimiters must be invalid
    const atLeastOneInvalidArb = fc
      .tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }))
      .filter(
        ([l, r]) =>
          !/^[^\w\s].*[^\w\s]$/.test(l) || !/^[^\w\s].*[^\w\s]$/.test(r)
      );
    await fc.assert(
      fc.asyncProperty(atLeastOneInvalidArb, async ([left, right]) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        expect(() =>
          manager.parseCloze(`${left}answer${right}`, [left, right])
        ).toThrow();
      })
    );
    // Also check that a single invalid delimiter alone always throws
    await fc.assert(
      fc.asyncProperty(invalidDelimiterArb, async (invalid) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        expect(() =>
          manager.parseCloze(`${invalid}answer${invalid}`, [invalid, invalid])
        ).toThrow();
      })
    );
  });

  it('works with valid delimiters', async () => {
    await fc.assert(
      fc.asyncProperty(delimiterArb, async ([left, right]) => {
        const answer = 'myAnswer';
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        const text = `before${left}${answer}${right}after`;
        const result = manager.parseCloze(text, [left, right]);
        expect(result.answer).toBe(answer);
        expect(result.start).toBe('before');
        expect(result.end).toBe('after');
      })
    );
  });
});

describe('delimitText', () => {
  let manager: TestableCardManager;

  beforeEach(() => {
    manager = new TestableCardManager(makePlugin(), makeRepo());
  });

  describe('with a selection', () => {
    it('wraps the selected text in CLOZE_DELIMITERS with spaces', async () => {
      await fc.assert(
        fc.asyncProperty(
          // text with no pre-existing delimiters to keep the test simple
          fc
            .string({ maxLength: 50 })
            .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
          fc.nat({ max: 20 }),
          fc.nat({ max: 20 }),
          async (base, preLen, answerLen) => {
            const pre = base.slice(0, preLen);
            const answer = base.slice(preLen, preLen + answerLen);
            const post = base.slice(preLen + answerLen);
            const text = pre + answer + post;
            const offsets: [number, number] = [
              pre.length,
              pre.length + answer.length,
            ];
            const [result] = manager.delimitTextPublic(text, offsets);
            expect(result).toBe(pre + `${LEFT} ${answer} ${RIGHT}` + post);
          }
        )
      );
    });

    it('strips pre-existing delimiters from the non-selected regions', () => {
      const text = `pre${LEFT}old${RIGHT}answer${LEFT}also${RIGHT}post`;
      // Select "answer" (indices 3+3+3 = 9 to 9+6 = 15 — just select the word)
      // Let's construct a simple, predictable case:
      const pre = `pre${LEFT}x${RIGHT}`; // has delimiters
      const answer = 'answer';
      const post = `${LEFT}y${RIGHT}post`; // has delimiters
      const fullText = pre + answer + post;
      const offsets: [number, number] = [
        pre.length,
        pre.length + answer.length,
      ];
      const [result] = manager.delimitTextPublic(fullText, offsets);
      // pre and post should have delimiters removed; answer is wrapped
      expect(result).not.toContain(`${LEFT}x${RIGHT}`);
      expect(result).not.toContain(`${LEFT}y${RIGHT}`);
      expect(result).toContain(`${LEFT} ${answer} ${RIGHT}`);
    });

    it('returns a single-element array', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .string({ maxLength: 30 })
            .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
          fc.nat({ max: 15 }),
          fc.nat({ max: 15 }),
          async (text, start, len) => {
            const end = Math.min(start + len, text.length);
            const offsets: [number, number] = [start, end];
            const result = manager.delimitTextPublic(text, offsets);
            expect(result).toHaveLength(1);
          }
        )
      );
    });
  });

  describe('without a selection (null)', () => {
    it('returns a result for each existing cloze pair', () => {
      const text = `before ${LEFT}answer1${RIGHT} middle ${LEFT}answer2${RIGHT} after`;
      const results = manager.delimitTextPublic(text, null);
      expect(results).toHaveLength(2);
    });

    it('throws when no cloze delimiters are found', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string().filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
          async (text) => {
            expect(() => manager.delimitTextPublic(text, null)).toThrow();
          }
        )
      );
    });

    it('removes all other delimiters from each result, keeping only one pair', () => {
      const text = `${LEFT}first${RIGHT} between ${LEFT}second${RIGHT}`;
      const results = manager.delimitTextPublic(text, null);
      // Each result should contain exactly one pair of delimiters
      for (const result of results) {
        const leftCount = result.split(LEFT).length - 1;
        const rightCount = result.split(RIGHT).length - 1;
        expect(leftCount).toBe(1);
        expect(rightCount).toBe(1);
      }
    });

    it('preserves the answer text of each cloze pair in its corresponding result', () => {
      const text = `${LEFT}alpha${RIGHT} something ${LEFT}beta${RIGHT}`;
      const results = manager.delimitTextPublic(text, null);
      expect(results[0]).toContain(`${LEFT}alpha${RIGHT}`);
      expect(results[1]).toContain(`${LEFT}beta${RIGHT}`);
    });

    it('slices pre at the match start and post at the match end', () => {
      // "PREFIX{first}MID{second}SUFFIX"
      // For result[0]: pre = "PREFIX", post = "MIDsecondSUFFIX" (delimiters removed from post)
      // For result[1]: pre = "PREFIXfirstMID" (delimiters removed from pre), post = "SUFFIX"
      const prefix = 'PREFIX';
      const mid = 'MID';
      const suffix = 'SUFFIX';
      const text = `${prefix}${LEFT}first${RIGHT}${mid}${LEFT}second${RIGHT}${suffix}`;
      const results = manager.delimitTextPublic(text, null);

      // result[0]: pre slice starts at index 0 (before the first match) = "PREFIX"
      expect(results[0].startsWith(prefix)).toBe(true);
      // result[0]: post slice starts after first match = "MID" + "second" + "SUFFIX"
      expect(results[0]).toContain(mid);
      expect(results[0]).toContain(suffix);

      // result[1]: pre slice ends at start of second match = "PREFIXfirstMID"
      expect(results[1]).toContain(prefix);
      expect(results[1]).toContain(mid);
      // result[1]: post = "SUFFIX"
      expect(results[1].endsWith(suffix)).toBe(true);
    });

    it('does not include delimiter characters in the removed regions of the output', () => {
      const text = `${LEFT}first${RIGHT} between ${LEFT}second${RIGHT}`;
      const [resultFirst, resultSecond] = manager.delimitTextPublic(text, null);
      // In resultFirst, only the first cloze's delimiters should remain; "between" is in post
      // (no delimiter chars in the " between " text anyway — this catches replacement-string mutants)
      expect(resultFirst.replace(`${LEFT}first${RIGHT}`, '')).not.toContain(
        LEFT
      );
      expect(resultFirst.replace(`${LEFT}first${RIGHT}`, '')).not.toContain(
        RIGHT
      );
      expect(resultSecond.replace(`${LEFT}second${RIGHT}`, '')).not.toContain(
        LEFT
      );
      expect(resultSecond.replace(`${LEFT}second${RIGHT}`, '')).not.toContain(
        RIGHT
      );
    });
  });
});

describe('rowToReviewCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the file cannot be found', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const manager = new CardManager(makePlugin(), makeRepo());
        const result = manager.rowToReviewCard(row);
        expect(result).toBeNull();
      })
    );
  });

  it('returns a ReviewCard with data and file when the file exists', async () => {
    const fakeFile = { path: 'cards/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const manager = new CardManager(makePlugin(), makeRepo());
        const result = manager.rowToReviewCard(row);
        expect(result).not.toBeNull();
        expect(result!.file).toBe(fakeFile);
        expect(result!.data.id).toBe(row.id);
        expect(result!.data.type).toBe('card');
        expect(result!.data.dismissed).toBe(!!row.dismissed);
        expect(result!.data.state).toBe(State[row.state]);
      })
    );
  });
});

/**
 * Obsidian's metadata cache answers `null` for a note between hashing its new
 * content and finishing the parse of it, which every edit does — each keystroke
 * saved from review among them. That is a note not readable yet, not one with
 * its frontmatter gone.
 */
describe('rowToReviewCard on a note the metadata cache is still re-reading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the row as a review item without writing to the note or its tombstone', async () => {
    const fakeFile = { path: 'cards/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const processFrontMatter = vi.fn().mockResolvedValue(undefined);
        const repo = makeRepo();
        const manager = new CardManager(
          makePlugin({
            metadataCache: { getFileCache: () => null },
            fileManager: { processFrontMatter },
          }),
          repo
        );

        const result = manager.rowToReviewCard(row);
        await Promise.resolve();

        expect(result).toStrictEqual({
          data: CardManager.rowToDisplay(row),
          file: fakeFile,
        });
        expect(processFrontMatter).not.toHaveBeenCalled();
        const mutated = (
          repo.mutate as ReturnType<typeof vi.fn>
        ).mock.calls.map(([sql]) => sql as string);
        expect(
          mutated.filter((sql) => !sql.includes('SET due_fuzz'))
        ).toStrictEqual([]);
      })
    );
  });

  it('still restores the id and tag of a parsed note that has no frontmatter', async () => {
    const fakeFile = { path: 'cards/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const processFrontMatter = vi.fn().mockResolvedValue(undefined);
        const repo = makeRepo();
        const manager = new CardManager(
          makePlugin({
            metadataCache: { getFileCache: () => ({}) },
            fileManager: { processFrontMatter },
          }),
          repo
        );

        const result = manager.rowToReviewCard(row);
        await Promise.resolve();

        expect(result).toStrictEqual({
          data: CardManager.rowToDisplay(row),
          file: fakeFile,
        });
        expect(processFrontMatter).toHaveBeenCalledTimes(1);
        expect(processFrontMatter.mock.calls[0][0]).toBe(fakeFile);
      })
    );
  });
});

describe('fetchMany', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all rows (as SRSCardRow[]) when called with no options', async () => {
    const rows = [makeCardRow({ id: 'a' }), makeCardRow({ id: 'b' })];
    const repo = {
      query: vi.fn().mockResolvedValue(rows),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    const result = await manager.fetchMany();
    expect(result).toEqual(rows);
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/SELECT \* FROM srs_card/i);
  });

  it('filters out dismissed rows by default', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/dismissed = 0/i);
  });

  it('does not add a dismissed filter when includeDismissed is true', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
  });

  it('adds a due <= filter when dueBy is provided', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    const dueBy = Date.now();
    await manager.fetchMany({ dueBy });
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/due <= \$1/i);
    expect(params[0]).toBe(dueBy);
  });

  it('adds a NOT IN clause when excludeIds are provided', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
        async (excludeIds) => {
          const repo = makeRepo();
          const manager = new CardManager(makePlugin(), repo);
          await manager.fetchMany({ excludeIds });
          const [sql, params] = lastQueryCall(repo);
          expect(sql).toMatch(/id NOT IN/i);
          for (const id of excludeIds) {
            expect(params).toContain(id);
          }
        }
      )
    );
  });

  it('applies a LIMIT clause when limit is provided', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (limit) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        await manager.fetchMany({ limit });
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/LIMIT/i);
        expect(params).toContain(limit);
      })
    );
  });

  it('orders results by due ASC', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ORDER BY due ASC/i);
  });

  it('uses correctly sequenced $N params when dueBy, excludeIds, and limit are all set', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    const dueBy = 1000;
    const excludeIds = ['id-1', 'id-2'];
    const limit = 5;
    await manager.fetchMany({ dueBy, excludeIds, limit });
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).toContain('$3');
    expect(sql).toContain('$4');
    expect(params[0]).toBe(dueBy);
    expect(params[1]).toBe('id-1');
    expect(params[2]).toBe('id-2');
    expect(params[3]).toBe(limit);
  });

  it('omits the dismissed filter when includeDismissed=true, but keeps the default deleted filter', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
    expect(sql).toMatch(/deleted = FALSE/i);
  });

  it('throws when param count exceeds MAX_SQL_QUERY_PARAMS', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    const excludeIds = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await expect(manager.fetchMany({ excludeIds })).rejects.toThrow();
  });

  it('does not throw when param count equals MAX_SQL_QUERY_PARAMS exactly', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    // dueBy=$1 + 998 excludeIds = 999 total, which equals the limit
    const excludeIds = Array.from({ length: 998 }, (_, i) => `id-${i}`);
    await expect(
      manager.fetchMany({ dueBy: 1000, excludeIds })
    ).resolves.not.toThrow();
  });

  it('uses AND to join multiple WHERE conditions', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany({ dueBy: 1000, excludeIds: ['a'] });
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ AND /i);
  });
});

describe('fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no row is found', async () => {
    const repo = makeRepo();
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const manager = new CardManager(makePlugin(), repo);
    const result = await manager.fetch('nonexistent');
    expect(result).toBeNull();
  });

  it('passes the id as a query param and queries the correct table', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        await manager.fetch(id);
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/SELECT \* FROM srs_card WHERE id = \$1/i);
        expect(params[0]).toBe(id);
      })
    );
  });

  it('returns a ReviewCard when a row and its file are found', async () => {
    const row = makeCardRow();
    const fakeFile = { path: 'cards/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const repo = {
      query: vi.fn().mockResolvedValue([row]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    const result = await manager.fetch(row.id);
    expect(result).not.toBeNull();
    expect(result!.data.id).toBe(row.id);
    expect(result!.file).toBe(fakeFile);
  });
});

describe('getDue', () => {
  const YEAR_2000_MS = new Date('2000-01-01T12:00:00Z').getTime();
  const YEAR_2100_MS = new Date('2100-01-01T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'cards/test.md',
      extension: 'md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeRepoWithCards(rows: SRSCardRow[]): SQLiteRepository {
    return {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        const dueBy = params[0] as number | undefined;
        return dueBy !== undefined ? rows.filter((r) => r.due <= dueBy) : rows;
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
  }

  it('returns cards due at or before the given dueBy timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: YEAR_2000_MS, max: YEAR_2100_MS }),
        async (nowMs) => {
          vi.setSystemTime(nowMs);
          const cutoff = nowMs;
          const rowAtCutoff = makeCardRow({ id: 'at', due: cutoff });
          const rowAfterCutoff = makeCardRow({ id: 'after', due: cutoff + 1 });
          const repo = makeRepoWithCards([rowAtCutoff, rowAfterCutoff]);
          const manager = new CardManager(makePlugin(), repo);
          const results = await manager.getDue(cutoff);
          const ids = results.map((r) => r.data.id);
          expect(ids).toContain('at');
          expect(ids).not.toContain('after');
        }
      )
    );
  });

  it('returns a row whose note file is missing as a missing item, without retrying', async () => {
    const rowA = makeCardRow({
      id: 'no-file',
      reference: 'cards/no-file.md',
      due: 0,
    });
    const rowB = makeCardRow({
      id: 'has-file',
      reference: 'cards/has-file.md',
      due: 0,
    });
    const file = { path: 'cards/has-file.md', extension: 'md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) => {
      return ref === rowA.reference ? null : file;
    });

    let callCount = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        callCount++;
        const excluded = params.filter((p) => typeof p === 'string');
        return [rowA, rowB].filter((r) => !excluded.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const manager = new CardManager(makePlugin(), repo);
    const results = await manager.getDue(0);

    expect(results).toEqual([
      { data: CardManager.rowToDisplay(rowA), file: null },
      { data: CardManager.rowToDisplay(rowB), file },
    ]);
    expect(callCount).toBe(1);
    // Missing is never stored
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });

  it('returns an empty array when the repo throws', async () => {
    const repo = {
      query: vi.fn().mockRejectedValue(new Error('db error')),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    const results = await manager.getDue();
    expect(results).toEqual([]);
  });

  it('passes pre-existing excludeIds on the first fetch call', async () => {
    const queryCalls: unknown[][] = [];
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        queryCalls.push(params);
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await manager.getDue(0, undefined, ['excluded-id']);
    expect(queryCalls[0]).toContain('excluded-id');
  });

  it('does not include rows whose note is refused in results', async () => {
    // rowA's note claims another item's id, rowB's is its own — only rowB
    // should appear in results
    const rowA = makeCardRow({
      id: 'null-file',
      reference: 'cards/null-file.md',
      due: 0,
    });
    const rowB = makeCardRow({
      id: 'has-file',
      reference: 'cards/has-file.md',
      due: 0,
    });
    vi.spyOn(Obsidian, 'getNote').mockImplementation(noteAt);

    let call = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        call++;
        if (call === 1) return [rowA, rowB];
        // Exclude rowA on retry
        return [rowA, rowB].filter((r) => !params.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const manager = new CardManager(makePlugin(claiming(rowA.reference)), repo);
    const results = await manager.getDue(0);
    const ids = results.map((r) => r.data.id);
    expect(ids).not.toContain('null-file');
    expect(ids).toContain('has-file');
  });

  it('excludes refused rows on the NEXT retry, not on the same call', async () => {
    // Verifies lastMissingNotes is incremented (+1 not -1), triggering the retry loop
    const rowNoFile = makeCardRow({
      id: 'missing',
      reference: 'cards/missing.md',
      due: 0,
    });
    const rowWithFile = makeCardRow({
      id: 'present',
      reference: 'cards/present.md',
      due: 0,
    });
    vi.spyOn(Obsidian, 'getNote').mockImplementation(noteAt);

    const queryCalls: unknown[][] = [];
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        queryCalls.push(params);
        if (queryCalls.length === 1) return [rowNoFile, rowWithFile];
        return [rowWithFile];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;

    const manager = new CardManager(
      makePlugin(claiming(rowNoFile.reference)),
      repo
    );
    await manager.getDue(0);
    // Should have retried — the refused row's id must appear in the second call's params
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    expect(queryCalls[1]).toContain('missing');
  });
});

describe('review', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates the card in srs_card with all expected columns and WHERE id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(Rating.Again, Rating.Hard, Rating.Good, Rating.Easy),
        async (grade) => {
          const card = makeCardDisplay();
          const storedRow = makeCardRow({ id: card.id });
          const repo = {
            query: vi.fn().mockResolvedValue([storedRow]),
            mutate: vi.fn().mockResolvedValue([[]]),
            _execSql: vi.fn(),
            transaction: vi.fn(async (work: () => unknown) => work()),
            handleFileChange: vi.fn(),
            onDataChange: vi.fn(() => vi.fn()),
          } as unknown as SQLiteRepository;
          const manager = new CardManager(makePlugin(), repo);
          await manager.review(card, grade, new Date());

          const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = mutateCalls.find(([sql]) =>
            sql.includes('UPDATE srs_card SET')
          );
          expect(updateCall).toBeDefined();
          const [updateSql, updateParams] = updateCall!;
          // Verify all expected SET columns are present in the SQL with correct positional params
          expect(updateSql).toMatch(/due = \$1/i);
          expect(updateSql).toMatch(/last_review = \$2/i);
          expect(updateSql).toMatch(/stability = \$3/i);
          expect(updateSql).toMatch(/difficulty = \$4/i);
          expect(updateSql).toMatch(/elapsed_days = \$5/i);
          expect(updateSql).toMatch(/scheduled_days = \$6/i);
          expect(updateSql).toMatch(/learning_steps = \$7/i);
          expect(updateSql).toMatch(/reps = \$8/i);
          expect(updateSql).toMatch(/lapses = \$9/i);
          expect(updateSql).toMatch(/state = \$10/i);
          expect(updateSql).toMatch(/dismissed = 0/i);
          expect(updateSql).toMatch(/WHERE id = \$11/i);
          // Segments must be joined with ", " — verify boundary between adjacent segment pairs
          // Without the joiner: "...last_review = $2stability = $3..."
          // With it: "...last_review = $2, stability = $3..."
          expect(updateSql).toMatch(/last_review = \$2, stability = \$3/i);
          // Verify the WHERE clause targets the right card
          expect(updateParams[UPDATE_PARAM.id]).toBe(card.id);
        }
      )
    );
  });

  it('inserts a review log into srs_card_review with all expected columns and VALUES placeholders', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(Rating.Again, Rating.Hard, Rating.Good, Rating.Easy),
        async (grade) => {
          const card = makeCardDisplay();
          const storedRow = makeCardRow({ id: card.id });
          const repo = {
            query: vi.fn().mockResolvedValue([storedRow]),
            mutate: vi.fn().mockResolvedValue([[]]),
            _execSql: vi.fn(),
            transaction: vi.fn(async (work: () => unknown) => work()),
            handleFileChange: vi.fn(),
            onDataChange: vi.fn(() => vi.fn()),
          } as unknown as SQLiteRepository;
          const manager = new CardManager(makePlugin(), repo);
          await manager.review(card, grade, new Date());

          const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const insertCall = mutateCalls.find(([sql]) =>
            sql.includes('INSERT INTO srs_card_review')
          );
          expect(insertCall).toBeDefined();
          const [insertSql, insertParams] = insertCall!;
          expect(insertSql).toContain('id');
          expect(insertSql).toContain('card_id');
          expect(insertSql).toContain('due');
          expect(insertSql).toContain('review');
          expect(insertSql).toContain('stability');
          expect(insertSql).toContain('difficulty');
          expect(insertSql).toContain('elapsed_days');
          expect(insertSql).toContain('last_elapsed_days');
          expect(insertSql).toContain('scheduled_days');
          expect(insertSql).toContain('rating');
          expect(insertSql).toContain('state');
          // Must include the VALUES placeholder list ($1 through $11)
          expect(insertSql).toContain('$1');
          expect(insertSql).toContain('$11');
          expect(insertParams[1]).toBe(card.id);
        }
      )
    );
  });

  it('writes the FSRS-computed lapses without double-counting storedCard.lapses', async () => {
    // Use realistic stability/difficulty so FSRS produces a valid due date.
    // These values are from running FSRS through 3 Good reviews followed by 3 Again reviews.
    const priorLapses = 3;
    const card = makeCardDisplay({
      lapses: priorLapses,
      state: 'Review',
      stability: 0.415,
      difficulty: 8.494,
      reps: 6,
    });
    const storedRow = makeCardRow({
      id: card.id,
      lapses: priorLapses,
      state: State.Review,
    });
    const repo = {
      query: vi.fn().mockResolvedValue([storedRow]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await manager.review(card, Rating.Again, new Date());

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE srs_card SET')
    )!;
    const params = updateCall[1];
    expect(params[UPDATE_PARAM.lapses]).toBe(priorLapses + 1);
  });

  it('throws without writing when the stored card is not found', async () => {
    const card = makeCardDisplay();
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    // The caller records an undo entry only if this resolves, so a missing
    // card must surface as a rejection rather than a silent no-op.
    await expect(manager.review(card, Rating.Good, new Date())).rejects.toThrow(
      `No card found with id ${card.id}`
    );
    // When storedCard is not found, no UPDATE or INSERT should be issued
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls;
    expect(mutateCalls).toHaveLength(0);
  });

  it('resets dismissed to 0 after review', async () => {
    const card = makeCardDisplay({ dismissed: true });
    const storedRow = makeCardRow({ id: card.id, dismissed: 1 });
    const repo = {
      query: vi.fn().mockResolvedValue([storedRow]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await manager.review(card, Rating.Good, new Date());
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE srs_card SET')
    )!;
    expect(updateCall[0]).toMatch(/dismissed = 0/i);
  });
});

describe('review — FSRS settings', () => {
  // #region FSRS HELPERS

  /**
   * Plugin stub whose settings expose fully-formed fsrsParams. review() reads
   * these via getFsrs() -> generatorParameters(settings.fsrsParams), so every
   * FSRS behavior under test is driven by what we pass here.
   */
  function makePluginWithFsrs(fsrsParams: FSRSParameters) {
    return {
      app: {
        metadataCache: { getFileCache: () => ({}) },
        fileManager: { processFrontMatter: async () => undefined },
      },
      settings: { dayRolloverOffset: 4, fsrsParams },
    } as never;
  }

  /** Repo that returns storedRow for the SELECT and records every mutate call. */
  function makeReviewRepo(storedRow: SRSCardRow): SQLiteRepository {
    return {
      query: vi.fn().mockResolvedValue([storedRow]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
    } as unknown as SQLiteRepository;
  }

  /** Pull the [sql, params] tuple for the srs_card UPDATE issued by review(). */
  function updateParamsFrom(repo: SQLiteRepository): unknown[] {
    const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const update = calls.find(([sql]) => sql.includes('UPDATE srs_card SET'));
    if (!update) throw new Error('review() issued no UPDATE srs_card');
    return update[1];
  }

  /** Pull the [sql, params] tuple for the srs_card_review INSERT. */
  function reviewInsertParamsFrom(repo: SQLiteRepository): unknown[] {
    const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const insert = calls.find(([sql]) =>
      sql.includes('INSERT INTO srs_card_review')
    );
    if (!insert) throw new Error('review() issued no srs_card_review INSERT');
    return insert[1];
  }

  /**
   * Run a single review against the given fsrs params and return the scheduling
   * outputs the plugin persists. A fresh (New-state) card is used unless
   * overridden so behavior is reproducible across param permutations.
   */
  async function runReview(
    fsrsParams: FSRSParameters,
    grade: Grade,
    reviewTime: Date,
    cardOverrides: Partial<ISRSCardDisplay> = {}
  ) {
    const card = makeCardDisplay(cardOverrides);
    const storedRow = makeCardRow({ id: card.id, state: State.New });
    const repo = makeReviewRepo(storedRow);
    const manager = new CardManager(makePluginWithFsrs(fsrsParams), repo);
    await manager.review(card, grade, reviewTime);
    const params = updateParamsFrom(repo);
    return {
      due: params[UPDATE_PARAM.due] as number,
      scheduledDays: params[UPDATE_PARAM.scheduledDays] as number,
      reviewInsertParams: reviewInsertParamsFrom(repo),
      repo,
    };
  }

  const gradeArb = fc.constantFrom<Grade>(
    Rating.Again,
    Rating.Hard,
    Rating.Good,
    Rating.Easy
  );

  /** request_retention slider range from settings.ts (0.8..0.95, step 0.01). */
  const retentionArb = fc
    .integer({ min: 80, max: 95 })
    .map((n) => n / 100)
    .filter((n) => Number.isFinite(n));

  /** maximum_interval text field: any positive integer parsed via parseInt. */
  const maxIntervalArb = fc.integer({ min: 1, max: 36500 });

  /**
   * A mature, already-reviewed card whose stability is high enough that its
   * natural interval spans many days — the regime where interval-shaping
   * settings (retention, maximum_interval, fuzz) have a well-defined,
   * observable effect. elapsedDays sets how long ago the last review was.
   */
  const matureCardArb: fc.Arbitrary<Partial<ISRSCardDisplay>> = fc
    .record({
      stability: fc.double({ min: 10, max: 1000, noNaN: true }),
      difficulty: fc.double({ min: 1, max: 10, noNaN: true }),
      reps: fc.integer({ min: 5, max: 100 }),
      elapsedDays: fc.integer({ min: 1, max: 90 }),
    })
    .map(({ stability, difficulty, reps, elapsedDays }) => ({
      state: 'Review' as const,
      stability,
      difficulty,
      reps,
      last_review: new Date(REVIEW_TIME.getTime() - elapsedDays * MS_PER_DAY),
    }));

  /** An ordered pair (lo < hi) drawn from the retention slider range. */
  const retentionPairArb = fc
    .tuple(retentionArb, retentionArb)
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => (a < b ? ([a, b] as const) : ([b, a] as const)));

  /** An ordered pair (lo < hi) of maximum_interval ceilings. */
  const maxIntervalPairArb = fc
    .tuple(maxIntervalArb, maxIntervalArb)
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => (a < b ? ([a, b] as const) : ([b, a] as const)));

  /** A well-formed params object with the four user-tunable knobs overridable. */
  function fsrsParamsWith(
    overrides: Partial<
      Pick<
        FSRSParameters,
        | 'request_retention'
        | 'maximum_interval'
        | 'enable_fuzz'
        | 'enable_short_term'
      >
    >
  ): FSRSParameters {
    return generatorParameters(overrides);
  }

  const REVIEW_TIME = new Date('2026-01-01T12:00:00Z');

  // #endregion

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always persists a due date at or after the review time, for any setting combination and grade', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionArb,
        maxIntervalArb,
        fc.boolean(),
        fc.boolean(),
        gradeArb,
        async (retention, maxInterval, fuzz, shortTerm, grade) => {
          const params = fsrsParamsWith({
            request_retention: retention,
            maximum_interval: maxInterval,
            enable_fuzz: fuzz,
            enable_short_term: shortTerm,
          });
          const { due } = await runReview(params, grade, REVIEW_TIME);
          expect(typeof due).toBe('number');
          expect(Number.isNaN(due)).toBe(false);
          // A card is never scheduled before the moment it was reviewed.
          expect(due).toBeGreaterThanOrEqual(REVIEW_TIME.getTime());
        }
      )
    );
  });

  it('produces a positive scheduled interval for a card under any maximum_interval', async () => {
    // maximum_interval bounds the stability-derived interval inside FSRS but is
    // not a literal ceiling on scheduled_days once rounding/fuzz are applied, so
    // the honest invariant is that the interval stays a sane non-negative number.
    await fc.assert(
      fc.asyncProperty(
        maxIntervalArb,
        retentionArb,
        fc.boolean(),
        fc.boolean(),
        gradeArb,
        async (maxInterval, retention, fuzz, shortTerm, grade) => {
          const params = fsrsParamsWith({
            maximum_interval: maxInterval,
            request_retention: retention,
            enable_fuzz: fuzz,
            enable_short_term: shortTerm,
          });
          const { scheduledDays } = await runReview(params, grade, REVIEW_TIME);
          expect(Number.isFinite(scheduledDays)).toBe(true);
          expect(scheduledDays).toBeGreaterThanOrEqual(0);
        }
      )
    );
  });

  it('never schedules further out under a tighter maximum_interval than under a looser one', async () => {
    // maximum_interval bounds the natural interval, so for any card and grade a
    // smaller ceiling can only ever pull the interval in (or leave it equal), it
    // can never push it further out than a larger ceiling would.
    await fc.assert(
      fc.asyncProperty(
        matureCardArb,
        maxIntervalPairArb,
        gradeArb,
        retentionArb,
        async (cardOverrides, [tight, loose], grade, retention) => {
          const tightRun = await runReview(
            fsrsParamsWith({
              maximum_interval: tight,
              request_retention: retention,
              enable_fuzz: false,
            }),
            grade,
            REVIEW_TIME,
            cardOverrides
          );
          const looseRun = await runReview(
            fsrsParamsWith({
              maximum_interval: loose,
              request_retention: retention,
              enable_fuzz: false,
            }),
            grade,
            REVIEW_TIME,
            cardOverrides
          );
          expect(tightRun.scheduledDays).toBeLessThanOrEqual(
            looseRun.scheduledDays
          );
        }
      )
    );
  });

  it('never schedules a shorter interval at lower targeted retention than at higher retention', async () => {
    // Tolerating a lower recall target lets reviews spread out, so for any card
    // and grade the lower-retention interval is always at least the
    // higher-retention one (monotonic, holding all else fixed).
    await fc.assert(
      fc.asyncProperty(
        matureCardArb,
        retentionPairArb,
        gradeArb,
        maxIntervalArb,
        async (cardOverrides, [lowRet, highRet], grade, maxInterval) => {
          const lowRetentionRun = await runReview(
            fsrsParamsWith({
              request_retention: lowRet,
              maximum_interval: maxInterval,
              enable_fuzz: false,
            }),
            grade,
            REVIEW_TIME,
            cardOverrides
          );
          const highRetentionRun = await runReview(
            fsrsParamsWith({
              request_retention: highRet,
              maximum_interval: maxInterval,
              enable_fuzz: false,
            }),
            grade,
            REVIEW_TIME,
            cardOverrides
          );
          expect(lowRetentionRun.scheduledDays).toBeGreaterThanOrEqual(
            highRetentionRun.scheduledDays
          );
        }
      )
    );
  });

  it('produces a deterministic interval across repeated reviews when fuzz is disabled', async () => {
    await fc.assert(
      fc.asyncProperty(
        matureCardArb,
        gradeArb,
        retentionArb,
        maxIntervalArb,
        async (cardOverrides, grade, retention, maxInterval) => {
          const params = fsrsParamsWith({
            enable_fuzz: false,
            request_retention: retention,
            maximum_interval: maxInterval,
          });
          const runs = await Promise.all(
            Array.from({ length: 5 }, () =>
              runReview(params, grade, REVIEW_TIME, cardOverrides)
            )
          );
          const intervals = runs.map((r) => r.scheduledDays);
          for (const interval of intervals) {
            expect(interval).toBe(intervals[0]);
          }
        }
      )
    );
  });

  it('keeps a fuzzed interval positive and within a bounded window of the unfuzzed interval', async () => {
    // For any mature card, fuzz jitters the interval around its deterministic
    // value but must keep it positive and within a bounded multiple — it can
    // never zero out a multi-day interval or blow it up unboundedly.
    await fc.assert(
      fc.asyncProperty(
        matureCardArb,
        gradeArb,
        retentionArb,
        async (cardOverrides, grade, retention) => {
          const unfuzzed = await runReview(
            fsrsParamsWith({
              enable_fuzz: false,
              request_retention: retention,
            }),
            grade,
            REVIEW_TIME,
            cardOverrides
          );
          const fuzzed = await runReview(
            fsrsParamsWith({ enable_fuzz: true, request_retention: retention }),
            grade,
            REVIEW_TIME,
            cardOverrides
          );
          expect(fuzzed.scheduledDays).toBeGreaterThanOrEqual(0);
          // FSRS only fuzzes intervals of 3+ days; short intervals are untouched.
          if (unfuzzed.scheduledDays >= 3) {
            expect(fuzzed.scheduledDays).toBeGreaterThan(0);
          }
          expect(fuzzed.scheduledDays).toBeLessThanOrEqual(
            Math.max(unfuzzed.scheduledDays * 2, 1)
          );
        }
      )
    );
  });

  it('schedules non-Easy reviews of a new card at least a full day out when short-term scheduling is disabled', async () => {
    // With enable_short_term=false, FSRS skips sub-day learning steps, so even a
    // freshly-created card graded below Easy advances by whole days.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Grade>(Rating.Again, Rating.Hard, Rating.Good),
        fc.date({
          min: new Date('2000-01-01T00:00:00Z'),
          max: new Date('2100-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        async (grade, reviewTime) => {
          const params = fsrsParamsWith({ enable_short_term: false });
          const { due, scheduledDays } = await runReview(
            params,
            grade,
            reviewTime
          );
          expect(scheduledDays).toBeGreaterThanOrEqual(1);
          expect(due - reviewTime.getTime()).toBeGreaterThanOrEqual(MS_PER_DAY);
        }
      )
    );
  });

  it('schedules a sub-day (minutes-out) review for a non-graduating grade on a new card when short-term scheduling is enabled', async () => {
    // Mirror of the previous test: with short-term steps ON, a below-Easy grade
    // on a new card lands back within the same day (0 scheduled days), for any
    // review time and any of the non-graduating grades.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Grade>(Rating.Again, Rating.Hard, Rating.Good),
        fc.date({
          min: new Date('2000-01-01T00:00:00Z'),
          max: new Date('2100-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        async (grade, reviewTime) => {
          const params = fsrsParamsWith({ enable_short_term: true });
          const { due, scheduledDays } = await runReview(
            params,
            grade,
            reviewTime
          );
          expect(scheduledDays).toBe(0);
          // Still in the future, but within the same day.
          expect(due).toBeGreaterThan(reviewTime.getTime());
          expect(due - reviewTime.getTime()).toBeLessThan(MS_PER_DAY);
        }
      )
    );
  });

  it('routes FSRS card.due to the card row and log.due to the review log, for any setting combination', async () => {
    // review() feeds the display card straight into getFsrs().repeat(). Recompute
    // the same repeat() here with identical params to get the authoritative
    // RecordLogItem, then assert the plugin writes card.due to the srs_card
    // UPDATE and log.due to the srs_card_review INSERT — these are distinct
    // (forward- vs backward-looking) dates and must not be swapped.
    await fc.assert(
      fc.asyncProperty(
        retentionArb,
        maxIntervalArb,
        fc.boolean(),
        fc.boolean(),
        gradeArb,
        async (retention, maxInterval, fuzz, shortTerm, grade) => {
          const params = fsrsParamsWith({
            request_retention: retention,
            maximum_interval: maxInterval,
            enable_fuzz: fuzz,
            enable_short_term: shortTerm,
          });
          // Disable fuzz is NOT required: we drive the reference computation with
          // the very same params, so any fuzz is reproduced identically because
          // FSRS fuzz is seeded from the card's interval, not wall-clock RNG.
          const card = makeCardDisplay();
          const storedRow = makeCardRow({ id: card.id, state: State.New });
          const repo = makeReviewRepo(storedRow);
          const manager = new CardManager(makePluginWithFsrs(params), repo);
          await manager.review(card, grade, REVIEW_TIME);

          const reference = fsrs(generatorParameters(params)).repeat(
            card,
            REVIEW_TIME
          )[grade];

          const cardDue = updateParamsFrom(repo)[UPDATE_PARAM.due] as number;
          const insert = reviewInsertParamsFrom(repo);
          // srs_card_review INSERT column order: id, card_id, due (index 2), ...
          const logDue = insert[2] as number;

          expect(cardDue).toBe(reference.card.due.getTime());
          expect(logDue).toBe(reference.log.due.getTime());
        }
      )
    );
  });
});

describe('review — against the production schema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #region REAL-DB HELPERS

  /**
   * The mock repos above assert the SQL as *text*, so a statement that is
   * well-formed as a string but invalid as SQL — a reused `$N` placeholder, a
   * column list shorter than its VALUES list — passes them and fails only in a
   * real vault. These tests run the same statements through sql.js loaded from
   * the production schema.sql, so malformed SQL surfaces as a thrown error.
   */
  let SQL: SqlJsStatic;

  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  /** Fixed instant so FSRS scheduling is reproducible run to run. */
  const REVIEW_AT = new Date('2026-01-01T00:00:00.000Z');
  const TEN_MINUTES_MS = 10 * 60 * 1000;

  /** A database at the current production schema with one card row in it. */
  function makeDbWithCard(overrides: Partial<SRSCardRow> = {}): {
    db: Database;
    row: SRSCardRow;
  } {
    const db = new SQL.Database();
    db.exec(readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8'));
    const row = makeCardRow({
      created_at: REVIEW_AT.getTime(),
      due: REVIEW_AT.getTime(),
      ...overrides,
    });
    db.exec(
      `INSERT INTO srs_card
        (id, reference, parent, created_at, due, dismissed, deleted, last_review,
         stability, difficulty, elapsed_days, scheduled_days, learning_steps,
         reps, lapses, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        row.id,
        row.reference,
        row.parent,
        row.created_at,
        row.due,
        row.dismissed,
        Number(row.deleted),
        row.last_review,
        row.stability,
        row.difficulty,
        row.elapsed_days,
        row.scheduled_days,
        row.learning_steps,
        row.reps,
        row.lapses,
        row.state,
      ] as never
    );
    return { db, row };
  }

  /** Read the single card row back out as the display shape review() expects. */
  function readCard(db: Database, id: string): ISRSCardDisplay {
    const { columns, values } = db.exec(
      `SELECT * FROM srs_card WHERE id = $1`,
      [id] as never
    )[0];
    const row = Object.fromEntries(
      columns.map((col, i) => [col, values[0][i]])
    ) as unknown as SRSCardRow;
    return CardManager.rowToDisplay(row);
  }

  /** Read all review-log rows for a card, oldest first. */
  function readReviewLogs(db: Database, cardId: string) {
    const results = db.exec(
      `SELECT * FROM srs_card_review WHERE card_id = $1 ORDER BY review ASC`,
      [cardId] as never
    );
    if (!results.length) return [];
    const { columns, values } = results[0];
    return values.map((row) =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]]))
    );
  }

  /** Starting scheduling states a card can be in when it comes up for review. */
  const startingCardArb = fc
    .record({
      state: stateArb,
      reps: fc.nat({ max: 100 }),
      lapses: fc.nat({ max: 50 }),
      learning_steps: fc.nat({ max: 2 }),
    })
    .map(({ state, reps, lapses, learning_steps }) => ({
      state,
      reps,
      lapses,
      learning_steps,
      // New cards carry zeroed FSRS memory state; anything else has been seen
      // at least once, so give it a plausible stability/difficulty pair.
      stability: state === State.New ? 0 : 2.5,
      difficulty: state === State.New ? 0 : 5.2,
    }));

  const anyGradeArb = fc.constantFrom<Grade>(
    Rating.Again,
    Rating.Hard,
    Rating.Good,
    Rating.Easy
  );

  // #endregion

  it('executes both write statements without a SQL error, for every grade and starting state', async () => {
    await fc.assert(
      fc.asyncProperty(
        anyGradeArb,
        startingCardArb,
        async (grade, overrides) => {
          const { db } = makeDbWithCard(overrides);
          const manager = new CardManager(makePlugin(), makeRealRepo(db));

          await manager.review(readCard(db, 'card-1'), grade, REVIEW_AT);

          db.close();
        }
      )
    );
  });

  it('writes exactly one review-log row per review', async () => {
    await fc.assert(
      fc.asyncProperty(
        anyGradeArb,
        startingCardArb,
        async (grade, overrides) => {
          const { db } = makeDbWithCard(overrides);
          const manager = new CardManager(makePlugin(), makeRealRepo(db));

          await manager.review(readCard(db, 'card-1'), grade, REVIEW_AT);

          expect(readReviewLogs(db, 'card-1')).toHaveLength(1);
          db.close();
        }
      )
    );
  });

  it('persists the FSRS-computed due date and state onto the stored card', async () => {
    const { db } = makeDbWithCard();
    const manager = new CardManager(makePlugin(), makeRealRepo(db));
    const before = readCard(db, 'card-1');
    const expected = fsrs(generatorParameters()).repeat(before, REVIEW_AT)[
      Rating.Good
    ];

    await manager.review(before, Rating.Good, REVIEW_AT);

    const after = readCard(db, 'card-1');
    expect(after.due.getTime()).toBe(expected.card.due.getTime());
    expect(State[after.state]).toBe(expected.card.state);
    db.close();
  });

  it('advances learning_steps on the stored card when FSRS moves it to the next step', async () => {
    const { db } = makeDbWithCard();
    const manager = new CardManager(makePlugin(), makeRealRepo(db));
    const before = readCard(db, 'card-1');
    // A New card graded Good moves from learning step 0 to step 1.
    const expected = fsrs(generatorParameters()).repeat(before, REVIEW_AT)[
      Rating.Good
    ].card.learning_steps;
    expect(expected).toBe(1);

    await manager.review(before, Rating.Good, REVIEW_AT);

    expect(readCard(db, 'card-1').learning_steps).toBe(expected);
    db.close();
  });

  it('stores the pre-review learning_steps on the review log', async () => {
    const { db } = makeDbWithCard({ learning_steps: 1, state: State.Learning });
    const manager = new CardManager(makePlugin(), makeRealRepo(db));
    const before = readCard(db, 'card-1');
    // ReviewLog.learning_steps records the step the card was on *before* the
    // grade was applied — that is what rollback() restores from.
    const expected = fsrs(generatorParameters()).repeat(before, REVIEW_AT)[
      Rating.Good
    ].log.learning_steps;

    await manager.review(before, Rating.Good, REVIEW_AT);

    expect(readReviewLogs(db, 'card-1')[0].learning_steps).toBe(expected);
    db.close();
  });

  it('graduates a card out of Learning across two persisted reviews', async () => {
    // The regression this whole column exists to prevent: if learning_steps is
    // not round-tripped through the database, the card reloads at step 0 every
    // time and Good re-schedules it minutes out forever instead of graduating.
    const { db } = makeDbWithCard();
    const manager = new CardManager(makePlugin(), makeRealRepo(db));

    await manager.review(readCard(db, 'card-1'), Rating.Good, REVIEW_AT);
    const afterFirst = readCard(db, 'card-1');
    expect(afterFirst.state).toBe('Learning');

    await manager.review(
      afterFirst,
      Rating.Good,
      new Date(REVIEW_AT.getTime() + TEN_MINUTES_MS)
    );

    expect(readCard(db, 'card-1').state).toBe('Review');
    db.close();
  });

  it('saves a card made from a PDF as a new card due the next day, under its article', async () => {
    const db = new SQL.Database();
    db.exec(readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8'));
    const cardFile = { path: 'cards/c.md', basename: 'c' } as TFile;
    vi.spyOn(Obsidian, 'createFromText').mockResolvedValue(cardFile);
    vi.spyOn(Obsidian, 'updateFrontMatter').mockResolvedValue(
      undefined as never
    );
    const pdf = { path: 'p.pdf', basename: 'p', extension: 'pdf' } as TFile;
    // The cache has the card's link to it at once
    vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(pdf);
    const manager = new CardManager(
      makePlugin({
        fileManager: { generateMarkdownLink: () => '[[p.pdf]]' },
      }),
      makeRealRepo(db)
    );
    onTestFinished(() => db.close());

    await manager.createFromPdf({
      article: { data: { id: 'article-1' }, file: pdf } as never,
      text: 'some text',
      start: 1e10,
      end: 1e10 + 4,
      subpath: '#page=1',
      answer: [0, 4],
    });

    const rows = db.exec('SELECT * FROM srs_card')[0];
    expect(rows.values).toHaveLength(1);
    const row = Object.fromEntries(
      rows.columns.map((col, i) => [col, rows.values[0][i]])
    );
    expect(row).toMatchObject({
      reference: cardFile.path,
      parent: 'article-1',
      due: (row.created_at as number) + MS_PER_DAY,
      last_review: null,
      reps: 0,
      state: State.New,
    });
  });
});

describe('create', () => {
  const sourceFile = { path: 'articles/source.md', extension: 'md' } as TFile;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes a card of the cursor's line, its answer the selection moved off any backslash that would escape a delimiter, its start escaped as cut from the line", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', '- ', '  1. '),
        escapedCardSelectionArb.filter(({ doc }) => !doc.includes('\n')),
        async (marker, { doc: line, selection: { from, to } }) => {
          const manager = new CardManager(makePlugin(), makeRepo());
          const createFileAndEntry = vi
            .spyOn(
              manager as unknown as {
                createFileAndEntry: (text: string) => Promise<unknown>;
              },
              'createFileAndEntry'
            )
            .mockResolvedValue({ file: {}, data: {} });
          vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue('[[c]]');
          vi.spyOn(Obsidian, 'transcludeLink').mockReturnValue(undefined);
          vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
            line,
            lineNumber: 0,
            start: marker.length,
            end: marker.length + line.length,
          });
          vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
            selection: line.slice(from, to),
            start: { line: 0, ch: marker.length + from },
            end: { line: 0, ch: marker.length + to },
            startOffset: marker.length + from,
            endOffset: marker.length + to,
          });

          await manager.create(
            { setSelection: vi.fn() } as never,
            { file: sourceFile } as never
          );

          const [a, b] = Markdown.snapOffEscapes(line, [from, to], {
            delimited: true,
          });
          const answer = Markdown.escapeCutStart(line, [a, b], 'answer');
          expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
            line.slice(0, a) + `${LEFT} ${answer} ${RIGHT}` + line.slice(b),
            sourceFile
          );
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 300 }
    );
  });

  it('makes no tag or emphasis of an answer selected from mid-line that its line did not hold there', async () => {
    const card = async (line: string, from: number) => {
      const manager = new CardManager(makePlugin(), makeRepo());
      const createFileAndEntry = vi
        .spyOn(
          manager as unknown as {
            createFileAndEntry: (text: string) => Promise<unknown>;
          },
          'createFileAndEntry'
        )
        .mockResolvedValue({ file: {}, data: {} });
      vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue('[[c]]');
      vi.spyOn(Obsidian, 'transcludeLink').mockReturnValue(undefined);
      vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
        line,
        lineNumber: 0,
        start: 0,
        end: line.length,
      });
      vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
        selection: line.slice(from),
        start: { line: 0, ch: from },
        end: { line: 0, ch: line.length },
        startOffset: from,
        endOffset: line.length,
      });
      await manager.create(
        { setSelection: vi.fn() } as never,
        { file: sourceFile } as never
      );
      vi.restoreAllMocks();
      return createFileAndEntry.mock.calls[0][0];
    };

    expect(await card('word#evil', 4)).toBe(
      String.raw`word${LEFT} \#evil ${RIGHT}`
    );
    expect(await card('a_b c_', 1)).toBe(String.raw`a${LEFT} \_b c_ ${RIGHT}`);
    // A tag after whitespace was one there too
    expect(await card('see #tag', 4)).toBe(`see ${LEFT} #tag ${RIGHT}`);
  });
});

describe('createFromSelection', () => {
  const sourceFile = { path: 'articles/source.md', extension: 'md' } as TFile;
  const reviewCard = {
    file: { path: 'cards/new.md', extension: 'md' },
    data: { id: 'card-1' },
  };
  const LINK = '[[new|ir-hide-title]]';

  function setUp() {
    const manager = new CardManager(makePlugin(), makeRepo());
    const createFileAndEntry = vi
      .spyOn(
        manager as unknown as {
          createFileAndEntry: (text: string, file: TFile) => Promise<unknown>;
        },
        'createFileAndEntry'
      )
      .mockResolvedValue(reviewCard);
    vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue(LINK);
    const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
    return { manager, createFileAndEntry, notify };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes a card of the span, with the answer hidden, from the note it is in, each start escaped as cut from it', async () => {
    await fc.assert(
      fc.asyncProperty(unescapedCardSelectionArb, async (c) => {
        const { manager, createFileAndEntry } = setUp();
        const doc = c.before + c.text + c.after;
        const editor = makeEditor(doc);

        await manager.createFromSelection(
          editor as never,
          { file: sourceFile } as never,
          c.selection,
          c.answerBounds
        );

        const { from } = c.selection;
        const [a, b] = c.answerBounds;
        const pre = Markdown.escapeCutStart(doc, [from, from + a], 'note');
        const answer = Markdown.escapeCutStart(
          doc,
          [from + a, from + b],
          'answer'
        );
        expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
          pre + `${LEFT} ${answer} ${RIGHT}` + c.post,
          sourceFile
        );
        vi.restoreAllMocks();
      })
    );
  });

  it('replaces the span, and only the span, with the embed', async () => {
    await fc.assert(
      fc.asyncProperty(unescapedCardSelectionArb, async (c) => {
        const { manager } = setUp();
        const editor = makeEditor(c.before + c.text + c.after);

        const result = await manager.createFromSelection(
          editor as never,
          { file: sourceFile } as never,
          c.selection,
          c.answerBounds
        );

        expect(editor.text).toBe(c.before + `!${LINK}` + c.after);
        // Undo puts `line` back where the embed is.
        expect(result).toMatchObject({ reviewCard, line: c.text });
        vi.restoreAllMocks();
      })
    );
  });

  it('makes nothing when the span no longer holds the text chosen', async () => {
    await fc.assert(
      fc.asyncProperty(
        cardSelectionArb,
        fc.string({ minLength: 1, maxLength: 5 }),
        async (c, edit) => {
          const { manager, createFileAndEntry, notify } = setUp();
          // Typed at the start of the span since it was chosen.
          const changed = c.before + edit + c.text + c.after;
          const editor = makeEditor(changed);

          const result = await manager.createFromSelection(
            editor as never,
            { file: sourceFile } as never,
            c.selection,
            c.answerBounds
          );

          expect(result).toBeNull();
          expect(createFileAndEntry).not.toHaveBeenCalled();
          expect(editor.text).toBe(changed);
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            `The selected text changed before the card was made`
          );
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('makes the card of the span widened off the escape pairs it splits, its answer off any backslash that would escape a delimiter, each start escaped as cut from the note', async () => {
    await fc.assert(
      fc.asyncProperty(
        escapedCardSelectionArb,
        async ({ doc, selection, answer }) => {
          const { manager, createFileAndEntry } = setUp();
          const editor = makeEditor(doc);

          const result = await manager.createFromSelection(
            editor as never,
            { file: sourceFile } as never,
            selection,
            answer
          );

          const [start, end] = Markdown.snapOffEscapes(doc, [
            selection.from,
            selection.to,
          ]);
          const text = doc.slice(start, end);
          const shift = selection.from - start;
          const [a, b] = Markdown.snapOffEscapes(
            text,
            [answer[0] + shift, answer[1] + shift],
            { delimited: true }
          );
          const pre = Markdown.escapeCutStart(doc, [start, start + a], 'note');
          const hidden = Markdown.escapeCutStart(
            doc,
            [start + a, start + b],
            'answer'
          );
          expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
            pre + `${LEFT} ${hidden} ${RIGHT}` + text.slice(b),
            sourceFile
          );
          expect(editor.text).toBe(
            doc.slice(0, start) + `!${LINK}` + doc.slice(end)
          );
          // Undo puts `line` back where the embed is.
          expect(result).toMatchObject({ reviewCard, line: text });
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 300 }
    );
  });

  it('shows the hidden answer in review as its placeholder, whatever backslash the note held before it', async () => {
    await fc.assert(
      fc.asyncProperty(
        escapedCardSelectionArb,
        async ({ doc, selection, answer }) => {
          const { manager, createFileAndEntry } = setUp();

          await manager.createFromSelection(
            makeEditor(doc) as never,
            { file: sourceFile } as never,
            selection,
            answer
          );

          const [body] = createFileAndEntry.mock.calls[0];
          const [before] = CardManager.hideAnswer(body).split(
            CARD_ANSWER_REPLACEMENT
          );
          expect(endsInEscape(before)).toBe(false);
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 300 }
    );
  });

  it('keeps each `\\#` whole that the span or the answer would split', async () => {
    const { manager, createFileAndEntry } = setUp();
    const doc = String.raw`a \#b \#c`;
    const editor = makeEditor(doc);

    // The span from the `#` of `\#b` to just after the `\` of `\#c`, its
    // answer from just after the span's added `\`
    const result = await manager.createFromSelection(
      editor as never,
      { file: sourceFile } as never,
      { from: 3, to: 7, text: doc.slice(3, 7) },
      [0, 3]
    );

    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      String.raw`${LEFT} \#b  ${RIGHT}\#`,
      sourceFile
    );
    expect(editor.text).toBe(`a !${LINK}c`);
    expect(result).toMatchObject({
      line: String.raw`\#b \#`,
      start: 2,
      end: 8,
    });
  });

  it('makes no tag, heading, quote or list of a span or answer selected from mid-line that the note did not hold there', async () => {
    const card = async (
      doc: string,
      from: number,
      answer: readonly [number, number]
    ) => {
      const { manager, createFileAndEntry } = setUp();
      await manager.createFromSelection(
        makeEditor(doc) as never,
        { file: sourceFile } as never,
        { from, to: doc.length, text: doc.slice(from) },
        answer
      );
      vi.restoreAllMocks();
      return createFileAndEntry.mock.calls[0][0];
    };

    // The span from the `#` of `word#evil`
    expect(await card('word#evil x', 4, [6, 7])).toBe(
      String.raw`\#evil ${LEFT} x ${RIGHT}`
    );
    expect(await card('a > b c', 2, [4, 5])).toBe(
      String.raw`\> b ${LEFT} c ${RIGHT}`
    );
    expect(await card('a - b c', 2, [4, 5])).toBe(
      String.raw`\- b ${LEFT} c ${RIGHT}`
    );
    // The answer from it
    expect(await card('x word#evil', 0, [6, 11])).toBe(
      String.raw`x word${LEFT} \#evil ${RIGHT}`
    );
    // The span from its `#`, the answer too
    expect(await card('a##b', 1, [0, 3])).toBe(
      String.raw`${LEFT} \#\#b ${RIGHT}`
    );
    // A tag after whitespace was one there too
    expect(await card('see #tag x', 4, [5, 6])).toBe(`#tag ${LEFT} x ${RIGHT}`);
  });

  it('makes nothing without a note to make it from', async () => {
    const { manager, createFileAndEntry } = setUp();
    const editor = makeEditor('some text');

    const result = await manager.createFromSelection(
      editor as never,
      { file: null } as never,
      { from: 0, to: 4, text: 'some' },
      [0, 2]
    );

    expect(result).toBeNull();
    expect(createFileAndEntry).not.toHaveBeenCalled();
    expect(editor.text).toBe('some text');
  });

  it('leaves the note alone when the card cannot be made', async () => {
    const { manager, createFileAndEntry, notify } = setUp();
    createFileAndEntry.mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const editor = makeEditor('some text');

    const result = await manager.createFromSelection(
      editor as never,
      { file: sourceFile } as never,
      { from: 0, to: 4, text: 'some' },
      [0, 2]
    );

    expect(result).toBeNull();
    expect(editor.text).toBe('some text');
    expect(notify).toHaveBeenCalledWith('Failed to create card');
  });
});

describe('createFromPdf', () => {
  const CARD_FILE = { path: 'cards/new card.md', basename: 'new card' };

  /** A PDF article row and its file, in any folder. */
  const pdfArticleArb = fc
    .record({
      id: fc.uuid(),
      folder: fc.constantFrom('', 'papers/', 'a/b/'),
      basename: fc.string({ minLength: 1, maxLength: 12 }),
    })
    .map(({ id, folder, basename }) => {
      const path = `${folder}${basename}.pdf`;
      return {
        data: { id, type: 'article' as const, reference: path },
        file: { path, basename, extension: 'pdf' } as TFile,
      };
    });

  const anchorPartsArb = fc.record({
    page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
    idx: fc.integer({ min: 0, max: 99_999 }),
    char: fc.integer({ min: 0, max: 99_999 }),
  });

  /**
   * What a selection read from a PDF hands over: two anchors in order, the
   * end on the start's page or a later one, and the start's page.
   */
  const anchorsArb = fc
    .uniqueArray(anchorPartsArb.map(encodeAnchor), {
      minLength: 2,
      maxLength: 2,
    })
    .map(([a, b]) => {
      const start = Math.min(a, b);
      return { page: decodeAnchor(start).page, start, end: Math.max(a, b) };
    });

  /**
   * A manager whose app writes wikilinks as Obsidian does by default, with
   * every call that could write to a file spied on, and the row it saves read
   * back as `saved`.
   */
  function wirePdfCard(
    saved: unknown = { data: { id: 'card' } },
    indexedAtOnce = true
  ) {
    const writes = {
      processFrontMatter: vi.fn().mockResolvedValue(undefined),
      process: vi.fn(),
      modify: vi.fn(),
      modifyBinary: vi.fn(),
      append: vi.fn(),
    };
    const { processFrontMatter, ...vault } = writes;
    const generateMarkdownLink = vi.fn(
      (file: TFile, _sourcePath: string, subpath = '', alias = '') =>
        `[[${file.path}${subpath}|${alias}]]`
    );
    const createFromText = vi
      .spyOn(Obsidian, 'createFromText')
      .mockResolvedValue(CARD_FILE as TFile);
    const updateFrontMatter = vi
      .spyOn(Obsidian, 'updateFrontMatter')
      .mockResolvedValue(undefined as never);
    const getNoteType = vi.spyOn(Obsidian, 'getNoteType');
    const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
    const repo = makeRepo();
    // The metadata cache: it has the card note's source link, resolving to
    // the file it was written for, once `index()` says so
    let indexed = indexedAtOnce;
    const listeners = new Set<(file: TFile) => void>();
    const metadataCache = {
      getFileCache: () => ({}),
      on: vi.fn((_name: string, cb: (file: TFile) => void) => {
        listeners.add(cb);
        return cb;
      }),
      offref: vi.fn((ref: (file: TFile) => void) => listeners.delete(ref)),
    };
    const getSourceFile = vi
      .spyOn(Obsidian, 'getSourceFile')
      .mockImplementation((note) =>
        note === CARD_FILE && indexed
          ? (generateMarkdownLink.mock.calls.at(-1)?.[0] ?? null)
          : null
      );
    const index = (file: TFile = CARD_FILE as TFile) => {
      indexed = true;
      for (const cb of [...listeners]) cb(file);
    };
    const app = {
      vault,
      metadataCache,
      fileManager: {
        processFrontMatter,
        generateMarkdownLink,
        trashFile: vi.fn().mockResolvedValue(undefined),
      },
    };
    const manager = new CardManager(
      { app, settings: { dayRolloverOffset: 4 } } as never,
      repo
    );
    const fetch = vi.spyOn(manager, 'fetch').mockResolvedValue(saved as never);
    return {
      manager,
      app,
      repo,
      writes,
      createFromText,
      updateFrontMatter,
      getNoteType,
      notify,
      fetch,
      listeners,
      index,
      getSourceFile,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes a card note of the text, escaped, with its answer hidden, named as it reads, linked to the PDF at the selection, and a row whose parent is the article', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfArticleArb,
        pdfTextArb,
        anchorsArb,
        fc.string(),
        async (article, { text, answer }, { page, start, end }, subpath) => {
          vi.restoreAllMocks();
          const wired = wirePdfCard();

          const result = await wired.manager.createFromPdf({
            article: article as never,
            text,
            start,
            end,
            subpath,
            answer,
          });

          expect(result).toEqual({ data: { id: 'card' } });
          // The answer delimited in the text as escaped around it, and the
          // note named after the raw text, delimited as a card from a note is
          const escaped = Markdown.escapeAround(text, answer);
          const [from, to] = escaped.range;
          const strip = (part: string) =>
            part.replaceAll(LEFT, '').replaceAll(RIGHT, '');
          expect(wired.createFromText).toHaveBeenCalledExactlyOnceWith(
            escaped.text.slice(0, from) +
              `${LEFT} ${escaped.text.slice(from, to)} ${RIGHT}` +
              escaped.text.slice(to),
            Obsidian.getDirectory('card'),
            wired.app,
            strip(text.slice(0, answer[0])) +
              `${LEFT} ${text.slice(...answer)} ${RIGHT}` +
              strip(text.slice(answer[1]))
          );
          // One pair of delimiters, whatever the text held
          const [note] = wired.createFromText.mock.calls[0];
          expect(note.split(LEFT)).toHaveLength(2);
          expect(note.split(RIGHT)).toHaveLength(2);
          const [, [id, reference, parent]] = lastMutateCall(wired.repo);
          expect(reference).toBe(CARD_FILE.path);
          expect(parent).toBe(article.data.id);
          expect(wired.fetch).toHaveBeenCalledExactlyOnceWith(id);
          expect(wired.updateFrontMatter).toHaveBeenCalledExactlyOnceWith(
            CARD_FILE,
            {
              'ir-id': id,
              tags: CARD_TAG,
              source: `[[${article.file.path}${subpath}|${article.file.basename}, page ${page}]]`,
              delimiters: CLOZE_DELIMITERS,
            },
            wired.app
          );
          expect(wired.notify).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('writes what a PDF hides in its text as plain text, around the answer too', async () => {
    const wired = wirePdfCard();
    const text = '#ir-card ![[x]] (} [[y]] {) <%* z %> a_b';
    const answer = text.indexOf('[[y]]');

    await wired.manager.createFromPdf({
      article: {
        data: { id: 'article-1', type: 'article', reference: 'papers/a.pdf' },
        file: { path: 'papers/a.pdf', basename: 'a', extension: 'pdf' },
      } as never,
      text,
      start: 1e10,
      end: 1e10 + text.length,
      subpath: '#page=1',
      answer: [answer, text.length - 1],
    });

    // The `_` beside the answer's end is escaped, a delimiter standing there
    expect(wired.createFromText.mock.calls[0][0]).toBe(
      String.raw`\#ir-card !\[\[x]] (\} ` +
        `${LEFT} ${String.raw`\[\[y]] {\) \<\%\* z %> a\_`} ${RIGHT}` +
        'b'
    );
  });

  it('writes a parentless card of a PDF that is no article escaped, its answer delimited, named after its text as it reads', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfTextArb,
        anchorsArb,
        async ({ text, answer }, { start, end }) => {
          vi.restoreAllMocks();
          const wired = wirePdfCard();
          const pdf = {
            path: 'loose.pdf',
            basename: 'loose',
            extension: 'pdf',
          } as TFile;

          await wired.manager.createFromPdf({
            pdf,
            text,
            start,
            end,
            subpath: '',
            answer,
          });

          const escaped = Markdown.escapeAround(text, answer);
          const [from, to] = escaped.range;
          const strip = (part: string) =>
            part.replaceAll(LEFT, '').replaceAll(RIGHT, '');
          expect(wired.createFromText).toHaveBeenCalledExactlyOnceWith(
            escaped.text.slice(0, from) +
              `${LEFT} ${escaped.text.slice(from, to)} ${RIGHT}` +
              escaped.text.slice(to),
            Obsidian.getDirectory('card'),
            wired.app,
            strip(text.slice(0, answer[0])) +
              `${LEFT} ${text.slice(...answer)} ${RIGHT}` +
              strip(text.slice(answer[1]))
          );
        }
      )
    );
  });

  it('never reads or writes the PDF as a note', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfArticleArb,
        cardSelectionArb,
        anchorsArb,
        async (article, c, anchors) => {
          vi.restoreAllMocks();
          const wired = wirePdfCard();

          await wired.manager.createFromPdf({
            article: article as never,
            text: c.text,
            ...anchors,
            subpath: '#page=1',
            answer: c.answerBounds,
          });

          const touched = Object.values(wired.writes)
            .flatMap((fn) => fn.mock.calls)
            .some(([file]) => file === article.file);
          expect(touched).toBe(false);
          expect(
            wired.updateFrontMatter.mock.calls.some(
              ([file]) => file === article.file
            )
          ).toBe(false);
          // Its parent comes from the row, never from frontmatter it hasn't
          expect(wired.getNoteType).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('says so, answers null, and leaves no card note behind, when the card cannot be made', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfArticleArb,
        cardSelectionArb,
        anchorsArb,
        fc.constantFrom('file', 'properties', 'row', 'read back'),
        async (article, c, anchors, fail) => {
          vi.restoreAllMocks();
          const wired = wirePdfCard();
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});
          const failure = new Error('disk full');
          if (fail === 'file') wired.createFromText.mockRejectedValue(failure);
          else if (fail === 'properties') {
            wired.updateFrontMatter.mockRejectedValue(failure);
          } else if (fail === 'row') {
            vi.spyOn(wired.repo, 'mutate').mockRejectedValue(failure);
          } else wired.fetch.mockRejectedValue(failure);

          expect(
            await wired.manager.createFromPdf({
              article: article as never,
              text: c.text,
              ...anchors,
              subpath: '#page=1',
              answer: c.answerBounds,
            })
          ).toBeNull();
          expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
            'Failed to create card'
          );
          expect(error).toHaveBeenCalledExactlyOnceWith(failure);
          // A note with no row would be a card review never shows; once the
          // row is saved, the note is the card's and stays
          expect(wired.app.fileManager.trashFile.mock.calls).toEqual(
            fail === 'properties' || fail === 'row' ? [[CARD_FILE]] : []
          );
        }
      )
    );
  });

  describe("waiting for the metadata cache to have the card's source link", () => {
    const ARTICLE = {
      data: { id: 'article-1', type: 'article', reference: 'papers/a.pdf' },
      file: { path: 'papers/a.pdf', basename: 'a', extension: 'pdf' },
    } as never;
    const LOOSE = {
      path: 'loose.pdf',
      basename: 'loose',
      extension: 'pdf',
    } as TFile;
    const origins = [
      ['an article', { article: ARTICLE }],
      ['a PDF that is no article', { pdf: LOOSE }],
    ] as const;

    /** Starts making a card of the first 4 characters of page 1. */
    function make(wired: ReturnType<typeof wirePdfCard>, origin: object) {
      return wired.manager.createFromPdf({
        ...(origin as { pdf: TFile }),
        text: 'text',
        start: 1e10,
        end: 1e10 + 4,
        subpath: '#page=1&selection=0,0,0,4',
        answer: [0, 4],
      });
    }

    const inserted = (wired: ReturnType<typeof wirePdfCard>) =>
      (wired.repo.mutate as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([sql]) => String(sql).startsWith('INSERT INTO srs_card')
      ).length;

    beforeEach(() => {
      // Timers are the window's, which Node has none of
      vi.stubGlobal('window', globalThis);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it.each(origins)(
      "saves the row of a card from %s only once its source link is indexed, so the PDF's highlights can read it",
      async (_, origin) => {
        const wired = wirePdfCard(undefined, false);

        const made = make(wired, origin);
        await vi.advanceTimersByTimeAsync(0);
        expect(inserted(wired)).toBe(0);
        expect(wired.listeners.size).toBe(1);

        wired.index();
        await vi.advanceTimersByTimeAsync(0);
        expect(inserted(wired)).toBe(1);
        expect(await made).toEqual({ data: { id: 'card' } });
        expect(wired.listeners.size).toBe(0);
      }
    );

    it.each(origins)(
      'waits for no change but its own note, for a card from %s',
      async (_, origin) => {
        const wired = wirePdfCard(undefined, false);

        void make(wired, origin);
        await vi.advanceTimersByTimeAsync(0);
        wired.index({ path: 'other.md' } as TFile);
        await vi.advanceTimersByTimeAsync(0);
        expect(inserted(wired)).toBe(0);

        wired.index();
        await vi.advanceTimersByTimeAsync(0);
        expect(inserted(wired)).toBe(1);
      }
    );

    it.each(origins)(
      "waits for its note's change to resolve to the PDF, for a card from %s",
      async (_, origin) => {
        const wired = wirePdfCard(undefined, false);
        // The note changed, but its link resolves elsewhere so far
        wired.getSourceFile.mockReturnValue(null);

        void make(wired, origin);
        await vi.advanceTimersByTimeAsync(0);
        for (const cb of [...wired.listeners]) cb(CARD_FILE as TFile);
        await vi.advanceTimersByTimeAsync(0);
        expect(inserted(wired)).toBe(0);
      }
    );

    it.each(origins)(
      'saves the row of a card from %s anyway once the cache has had long enough',
      async (_, origin) => {
        const wired = wirePdfCard(undefined, false);

        const made = make(wired, origin);
        await vi.advanceTimersByTimeAsync(SOURCE_INDEX_TIMEOUT_MS - 1);
        expect(inserted(wired)).toBe(0);
        await vi.advanceTimersByTimeAsync(1);

        expect(await made).toEqual({ data: { id: 'card' } });
        expect(inserted(wired)).toBe(1);
        expect(wired.listeners.size).toBe(0);
      }
    );

    it.each(origins)(
      'waits for nothing when the cache has the link already, for a card from %s',
      async (_, origin) => {
        const wired = wirePdfCard();

        void make(wired, origin);
        await vi.advanceTimersByTimeAsync(0);

        expect(inserted(wired)).toBe(1);
        expect(wired.listeners.size).toBe(0);
      }
    );
  });
});

describe('createFromPdf without an article', () => {
  const CARD_FILE = { path: 'cards/new card.md', basename: 'new card' };

  /** A PDF no row makes an article, in any folder. */
  const pdfArb = fc
    .record({
      folder: fc.constantFrom('', 'papers/', 'a/b/'),
      basename: fc.string({ minLength: 1, maxLength: 12 }),
    })
    .map(
      ({ folder, basename }) =>
        ({
          path: `${folder}${basename}.pdf`,
          basename,
          extension: 'pdf',
        }) as TFile
    );

  const anchorsArb = fc
    .uniqueArray(
      fc
        .record({
          page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
          idx: fc.integer({ min: 0, max: 99_999 }),
          char: fc.integer({ min: 0, max: 99_999 }),
        })
        .map(encodeAnchor),
      { minLength: 2, maxLength: 2 }
    )
    .map(([a, b]) => {
      const start = Math.min(a, b);
      return { page: decodeAnchor(start).page, start, end: Math.max(a, b) };
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes a card linked to the PDF at the selection, with no parent, and writes nothing to the PDF', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfArb,
        cardSelectionArb,
        anchorsArb,
        fc.string(),
        async (pdf, c, { page, start, end }, subpath) => {
          vi.restoreAllMocks();
          const writes = {
            processFrontMatter: vi.fn().mockResolvedValue(undefined),
            process: vi.fn(),
            modify: vi.fn(),
            modifyBinary: vi.fn(),
            append: vi.fn(),
          };
          const { processFrontMatter, ...vault } = writes;
          const app = {
            vault,
            metadataCache: { getFileCache: () => ({}) },
            fileManager: {
              processFrontMatter,
              generateMarkdownLink: (
                file: TFile,
                _sourcePath: string,
                sub = '',
                alias = ''
              ) => `[[${file.path}${sub}|${alias}]]`,
            },
          };
          vi.spyOn(Obsidian, 'createFromText').mockResolvedValue(
            CARD_FILE as TFile
          );
          const updateFrontMatter = vi
            .spyOn(Obsidian, 'updateFrontMatter')
            .mockResolvedValue(undefined as never);
          const getNoteType = vi.spyOn(Obsidian, 'getNoteType');
          // The cache has the card's link to it at once
          vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(pdf);
          const repo = makeRepo();
          const manager = new CardManager(
            { app, settings: { dayRolloverOffset: 4 } } as never,
            repo
          );
          vi.spyOn(manager, 'fetch').mockResolvedValue({
            data: { id: 'card' },
          } as never);

          const result = await manager.createFromPdf({
            pdf,
            text: c.text,
            start,
            end,
            subpath,
            answer: c.answerBounds,
          });

          expect(result).toEqual({ data: { id: 'card' } });
          const [, [id, reference, parent]] = (
            repo.mutate as ReturnType<typeof vi.fn>
          ).mock.calls.at(-1) as [string, unknown[]];
          expect(reference).toBe(CARD_FILE.path);
          expect(parent).toBeNull();
          expect(updateFrontMatter).toHaveBeenCalledExactlyOnceWith(
            CARD_FILE,
            {
              'ir-id': id,
              tags: CARD_TAG,
              source: `[[${pdf.path}${subpath}|${pdf.basename}, page ${page}]]`,
              delimiters: CLOZE_DELIMITERS,
            },
            app
          );
          const touched = Object.values(writes)
            .flatMap((fn) => fn.mock.calls)
            .some(([file]) => file === pdf);
          expect(touched).toBe(false);
          expect(getNoteType).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('adoptOrphans', () => {
  let SQL: SqlJsStatic;

  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const PDF = { path: 'papers/Paper.pdf', extension: 'pdf' } as TFile;

  /** A card as adoption meets it; see the snippet manager's orphan specs. */
  const cardSpecArb = fc.record({
    exists: fc.boolean(),
    source: fc.constantFrom<'target' | 'elsewhere' | null>(
      'target',
      'elsewhere',
      null
    ),
    parent: fc.oneof(fc.uuid(), fc.constant(null)),
    deleted: fc.boolean(),
  });

  it('gives every parentless card taken from the file the new parent, and no other card', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(cardSpecArb, { maxLength: 8 }),
        fc.uuid(),
        async (specs, parentId) => {
          vi.restoreAllMocks();
          const db = new SQL.Database();
          db.exec(
            readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8')
          );
          const query = (
            sql: string,
            params: unknown[] = []
          ): Record<string, unknown>[] => {
            const results = db.exec(sql, params as never);
            if (!results.length) return [];
            const { columns, values } = results[0];
            return values.map(
              (row): Record<string, unknown> =>
                Object.fromEntries(columns.map((col, i) => [col, row[i]]))
            );
          };
          const repo = {
            ...makeRepo(),
            query: vi.fn(async (sql: string, params?: unknown[]) =>
              query(sql, params)
            ),
            mutate: vi.fn(async (sql: string, params?: unknown[]) => {
              query(sql, params);
              return [[]];
            }),
          } as unknown as SQLiteRepository;
          specs.forEach((spec, i) =>
            db.exec(
              `INSERT INTO srs_card (id, reference, parent, created_at, due,
                 stability, difficulty, elapsed_days, scheduled_days, state, deleted)
               VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, $4)`,
              [
                `card-${i}`,
                `cards/card-${i}.md`,
                spec.parent,
                Number(spec.deleted),
              ]
            )
          );
          const specOf = (reference: string) =>
            specs[Number(/card-(\d+)/.exec(reference)?.[1])];
          vi.spyOn(Obsidian, 'getNote').mockImplementation((reference) =>
            specOf(reference)?.exists === false
              ? null
              : ({ path: reference, extension: 'md' } as TFile)
          );
          vi.spyOn(Obsidian, 'getSourceFile').mockImplementation((file) => {
            const source = specOf(file.path)?.source;
            if (!source) return null;
            return {
              path: source === 'target' ? PDF.path : 'papers/Other.pdf',
            } as TFile;
          });
          const manager = new CardManager(makePlugin(), repo);

          const adopted = await manager.adoptOrphans(PDF, parentId);

          const expected = specs
            .map((spec, i) => ({ spec, id: `card-${i}` }))
            .filter(
              ({ spec }) =>
                spec.parent === null &&
                !spec.deleted &&
                spec.exists &&
                spec.source === 'target'
            )
            .map(({ id }) => id);
          expect(adopted.map((row) => row.id).sort()).toEqual(expected.sort());
          expect(adopted.every((row) => row.parent === parentId)).toBe(true);
          const parents = new Map(
            query('SELECT id, parent FROM srs_card').map((row) => [
              row.id,
              row.parent,
            ])
          );
          specs.forEach((spec, i) =>
            expect(parents.get(`card-${i}`)).toBe(
              expected.includes(`card-${i}`) ? parentId : spec.parent
            )
          );
          db.close();
        }
      )
    );
  });
});

describe('getPdfHighlights', () => {
  let SQL: SqlJsStatic;
  /** One database for every case: {@link wire} empties it for each. */
  let db: Database;

  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
    db = new SQL.Database();
    db.exec(readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8'));
  });

  afterAll(() => {
    db.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #region PDF-HIGHLIGHT HELPERS

  const PDF = {
    path: 'papers/Paper.pdf',
    basename: 'Paper',
    extension: 'pdf',
  } as TFile;
  const PDF_ARTICLE_ID = 'pdf-article';

  /** A selection on one page, as the anchors of its ends: begin before end. */
  const selectionArb = fc
    .record({
      page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
      a: fc.integer({ min: 0, max: 99_999 }),
      b: fc.integer({ min: 0, max: 99_999 }),
      c: fc.integer({ min: 0, max: 99_999 }),
      d: fc.integer({ min: 0, max: 99_999 }),
    })
    .filter(({ a, b, c, d }) => a < c || (a === c && b < d));

  /**
   * A card note's `source` property: a link to a selection, written in any
   * form, maybe with a parameter Obsidian may add; a link to no selection, or
   * one no highlight can be read from; or no link at all.
   */
  const sourceArb = fc.oneof(
    fc
      .record({
        selection: selectionArb,
        form: fc.constantFrom<'wiki' | 'markdown' | 'angled'>(
          'wiki',
          'markdown',
          'angled'
        ),
        extra: fc.constantFrom('', '&color=yellow'),
        alias: fc.constantFrom(null, 'Paper, page 1'),
      })
      .map(({ selection, form, extra, alias }) => {
        const { page, a, b, c, d } = selection;
        return {
          value: formatSourceLink({
            form,
            path: 'papers/Some Paper.pdf',
            subpath: `#page=${page}${extra}&selection=${a},${b},${c},${d}`,
            alias,
          }) as unknown,
          range: {
            start: encodeAnchor({ page, idx: a, char: b }),
            end: encodeAnchor({ page, idx: c, char: d }),
          } as { start: number; end: number } | null,
        };
      }),
    fc
      .constantFrom<unknown>(
        '[[papers/Paper.pdf]]',
        '[[papers/Paper.pdf#page=2|Paper, page 2]]',
        '[[papers/Paper.pdf#page=1&selection=0,4,0,1]]',
        '[[papers/Paper.pdf#page=1&selection=0,4,0,4]]',
        '[[papers/Paper.pdf#page=1&selection=0,-1,0,4]]',
        '[[papers/Paper.pdf#selection=0,1,0,4]]',
        'page=1&selection=0,1,0,4',
        '',
        ['[[papers/Paper.pdf#page=1&selection=0,1,0,4]]'],
        42,
        undefined
      )
      .map((value) => ({
        value,
        range: null as { start: number; end: number } | null,
      }))
  );

  /** A card as a PDF's highlights meet it. */
  const cardSpecArb = fc.record({
    parent: fc.constantFrom<'pdf' | 'other' | null>('pdf', 'other', null),
    deleted: fc.boolean(),
    dismissed: fc.boolean(),
    exists: fc.boolean(),
    // The note at its reference may be another item's, which took the path
    // over: its `ir-id` says so. One with none is the card's own.
    irId: fc.constantFrom<'own' | 'other' | 'none'>('own', 'other', 'none'),
    resolves: fc.constantFrom<'pdf' | 'elsewhere' | 'nowhere'>(
      'pdf',
      'elsewhere',
      'nowhere'
    ),
    source: sourceArb,
  });
  type CardSpec = typeof cardSpecArb extends fc.Arbitrary<infer T> ? T : never;

  /** Card `i`'s spec, by its note's path `cards/card-i.md`. */
  const specAt = (specs: CardSpec[], path: string) =>
    specs[Number(/card-(\d+)/.exec(path)?.[1])];

  /**
   * A manager over a database holding `PDF`'s article row when `isArticle`,
   * another article's, and a card row per spec, whose notes are as the specs
   * say. Card `i`'s note is `cards/card-i.md`.
   */
  function wire(specs: CardSpec[], isArticle: boolean) {
    db.exec('DELETE FROM srs_card; DELETE FROM article;');
    const insertArticle = (id: string, reference: string) =>
      db.exec(
        `INSERT INTO article (id, reference, due, interval, priority)
         VALUES ($1, $2, 0, 1, 20)`,
        [id, reference]
      );
    if (isArticle) insertArticle(PDF_ARTICLE_ID, PDF.path);
    insertArticle('other-article', 'papers/Other.pdf');
    specs.forEach((spec, i) =>
      db.exec(
        `INSERT INTO srs_card (id, reference, parent, created_at, due,
           stability, difficulty, elapsed_days, scheduled_days, state,
           dismissed, deleted)
         VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, $4, $5)`,
        [
          `card-${i}`,
          `cards/card-${i}.md`,
          spec.parent === 'pdf'
            ? PDF_ARTICLE_ID
            : spec.parent && 'other-article',
          Number(spec.dismissed),
          Number(spec.deleted),
        ]
      )
    );
    vi.spyOn(Obsidian, 'getNote').mockImplementation((reference) =>
      specAt(specs, reference)?.exists
        ? ({ path: reference, extension: 'md' } as TFile)
        : null
    );
    vi.spyOn(Obsidian, 'getFrontMatter').mockImplementation((note) => {
      const { irId, source } = specAt(specs, note.path);
      const own = /card-\d+/.exec(note.path)![0];
      return {
        ...(irId === 'none' ? {} : { 'ir-id': irId === 'own' ? own : 'other' }),
        source: source.value,
      } as never;
    });
    const getSourceFile = vi
      .spyOn(Obsidian, 'getSourceFile')
      .mockImplementation((note) => {
        const { resolves } = specAt(specs, note.path);
        if (resolves === 'nowhere') return null;
        return (
          resolves === 'pdf' ? PDF : { path: 'papers/Other.pdf' }
        ) as TFile;
      });
    const manager = new CardManager(makePlugin(), makeRealRepo(db));
    return { manager, getSourceFile };
  }

  const byRef = (a: { ref: string }, b: { ref: string }) =>
    a.ref < b.ref ? -1 : 1;

  // #endregion

  it('highlights the selection of each live card of a PDF article, dismissed or not, wherever its link now resolves, and of no other card', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(cardSpecArb, { maxLength: 8 }),
        async (specs) => {
          vi.restoreAllMocks();
          const { manager, getSourceFile } = wire(specs, true);

          const highlights = await manager.getPdfHighlights(PDF);

          const expected = specs.flatMap((spec, i) =>
            spec.parent === 'pdf' &&
            !spec.deleted &&
            spec.exists &&
            spec.irId !== 'other' &&
            spec.source.range
              ? [
                  {
                    ref: `cards/card-${i}.md`,
                    kind: 'card',
                    ...spec.source.range,
                  },
                ]
              : []
          );
          expect([...highlights].sort(byRef)).toEqual(expected.sort(byRef));
          // Its parent says which PDF it is from
          expect(getSourceFile).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('highlights, in a PDF that is no article, the selection of each live parentless card whose link resolves to it, dismissed or not, resolving only links that name a selection', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(cardSpecArb, { maxLength: 8 }),
        async (specs) => {
          vi.restoreAllMocks();
          const { manager, getSourceFile } = wire(specs, false);

          const highlights = await manager.getPdfHighlights(PDF);

          const expected = specs.flatMap((spec, i) =>
            spec.parent === null &&
            !spec.deleted &&
            spec.exists &&
            spec.irId !== 'other' &&
            spec.source.range &&
            spec.resolves === 'pdf'
              ? [
                  {
                    ref: `cards/card-${i}.md`,
                    kind: 'card',
                    ...spec.source.range,
                  },
                ]
              : []
          );
          expect([...highlights].sort(byRef)).toEqual(expected.sort(byRef));
          for (const [note] of getSourceFile.mock.calls) {
            expect(specAt(specs, note.path).source.range).not.toBeNull();
          }
        }
      )
    );
  });

  it('shows a card a copy import took over on the copy, and no longer on the PDF it was copied from', async () => {
    const db = new SQL.Database();
    db.exec(readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8'));
    const copy = { path: 'Articles/Paper.pdf', extension: 'pdf' } as TFile;
    db.exec(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ('copy', $1, 0, 1, 20)`,
      [copy.path]
    );
    db.exec(
      `INSERT INTO srs_card (id, reference, parent, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state)
       VALUES ('card', 'cards/c.md', 'copy', 0, 0, 0, 0, 0, 0, 0)`
    );
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'cards/c.md',
      extension: 'md',
    } as TFile);
    vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
      source: '[[Articles/Paper.pdf#page=1&selection=0,1,0,4|Paper, page 1]]',
    } as never);
    // Re-pointed at the copy, though a stale cache may say otherwise
    vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(PDF);
    const manager = new CardManager(makePlugin(), makeRealRepo(db));
    onTestFinished(() => db.close());

    expect(await manager.getPdfHighlights(PDF)).toEqual([]);
    expect(await manager.getPdfHighlights(copy)).toEqual([
      {
        ref: 'cards/c.md',
        kind: 'card',
        start: encodeAnchor({ page: 1, idx: 0, char: 1 }),
        end: encodeAnchor({ page: 1, idx: 0, char: 4 }),
      },
    ]);
  });
});

describe('delete', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A manager over a srs_card row with `id` whose note is `note`, and the
   * calls by which Obsidian could remove that note.
   */
  function wireDelete(id: string, note: TFile | null) {
    const mutate = vi.fn().mockResolvedValue([[]]);
    const repo = {
      ...makeRepo(),
      query: vi.fn().mockResolvedValue([{ id, reference: 'items/note.md' }]),
      mutate,
    };
    const fileManager = {
      promptForFileDeletion: vi.fn().mockResolvedValue(true),
      trashFile: vi.fn().mockResolvedValue(undefined),
    };
    const app = { fileManager };
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(note);
    const manager = new CardManager({ app } as never, repo);
    return { manager, mutate, fileManager };
  }

  const NOTE = { path: 'items/note.md', extension: 'md' } as TFile;

  it('trashes the note without a word, and drops the row, when told not to prompt', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        vi.restoreAllMocks();
        const { manager, mutate, fileManager } = wireDelete(id, NOTE);

        expect(await manager.delete(id, { prompt: false })).toBe(true);

        // Obsidian's prompt would also offer to delete what the note alone
        // linked to: a PDF its source links to among them
        expect(fileManager.trashFile).toHaveBeenCalledExactlyOnceWith(NOTE);
        expect(fileManager.promptForFileDeletion).not.toHaveBeenCalled();
        expect(mutate).toHaveBeenCalledExactlyOnceWith(
          `DELETE FROM srs_card WHERE id = $1`,
          [id]
        );
      })
    );
  });

  it('deletes the note as Obsidian does, prompts and all, by default', async () => {
    for (const options of [undefined, {}, { prompt: true }]) {
      const { manager, mutate, fileManager } = wireDelete('id-1', NOTE);

      expect(await manager.delete('id-1', options)).toBe(true);

      expect(fileManager.promptForFileDeletion).toHaveBeenCalledExactlyOnceWith(
        NOTE
      );
      expect(fileManager.trashFile).not.toHaveBeenCalled();
      expect(mutate).toHaveBeenCalledOnce();
      vi.restoreAllMocks();
    }
  });

  it('answers false, and deletes nothing, for an id with no row', async () => {
    for (const prompt of [true, false]) {
      const mutate = vi.fn().mockResolvedValue([[]]);
      const repo = { ...makeRepo(), mutate };
      const fileManager = {
        promptForFileDeletion: vi.fn().mockResolvedValue(true),
        trashFile: vi.fn().mockResolvedValue(undefined),
      };
      const manager = new CardManager({ app: { fileManager } } as never, repo);

      expect(await manager.delete('id-1', { prompt })).toBe(false);

      expect(fileManager.trashFile).not.toHaveBeenCalled();
      expect(fileManager.promptForFileDeletion).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    }
  });

  it('drops the row of a note already gone', async () => {
    for (const prompt of [true, false]) {
      const { manager, mutate, fileManager } = wireDelete('id-1', null);

      expect(await manager.delete('id-1', { prompt })).toBe(true);

      expect(fileManager.trashFile).not.toHaveBeenCalled();
      expect(fileManager.promptForFileDeletion).not.toHaveBeenCalled();
      expect(mutate).toHaveBeenCalledOnce();
      vi.restoreAllMocks();
    }
  });
});

describe('createFromSelection — its parent', () => {
  const CARD_FILE = { path: 'cards/new card.md', basename: 'new card' };
  const SOURCE = {
    path: 'notes/source.md',
    basename: 'source',
    extension: 'md',
  } as TFile;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is the row of the article or snippet note the card was made in, which it links to plainly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('article', 'snippet', 'card', null),
        fc.option(fc.uuid(), { nil: null }),
        cardSelectionArb,
        async (noteType, rowId, c) => {
          vi.restoreAllMocks();
          const repo = makeRepo();
          const generateMarkdownLink = vi.fn(() => '[[source]]');
          const app = {
            metadataCache: { getFileCache: () => ({}) },
            fileManager: { generateMarkdownLink },
          };
          vi.spyOn(Obsidian, 'createFromText').mockResolvedValue(
            CARD_FILE as TFile
          );
          vi.spyOn(Obsidian, 'updateFrontMatter').mockResolvedValue(
            undefined as never
          );
          vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(noteType);
          const manager = new CardManager({ app } as never, repo);
          const row = rowId === null ? null : { id: rowId };
          const findArticle = vi
            .spyOn(manager, 'findArticle')
            .mockResolvedValue(row as never);
          const findSnippet = vi
            .spyOn(manager, 'findSnippet')
            .mockResolvedValue(row as never);
          vi.spyOn(manager, 'fetch').mockResolvedValue({
            file: CARD_FILE,
            data: { id: 'card' },
          } as never);
          const editor = makeEditor(c.before + c.text + c.after);

          await manager.createFromSelection(
            editor as never,
            { file: SOURCE } as never,
            c.selection,
            c.answerBounds
          );

          const [, [, , parent]] = lastMutateCall(repo);
          const isParent = noteType === 'article' || noteType === 'snippet';
          expect(parent).toBe(isParent ? rowId : null);
          expect(findArticle).toHaveBeenCalledTimes(
            noteType === 'article' ? 1 : 0
          );
          expect(findSnippet).toHaveBeenCalledTimes(
            noteType === 'snippet' ? 1 : 0
          );
          expect(generateMarkdownLink).toHaveBeenCalledWith(
            SOURCE,
            CARD_FILE.path,
            undefined,
            SOURCE.basename
          );
        }
      )
    );
  });
});
