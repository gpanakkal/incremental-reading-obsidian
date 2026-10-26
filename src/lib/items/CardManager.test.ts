import {
  CARD_ANSWER_REPLACEMENT,
  CARD_ANSWER_REPLACEMENT_IN_CODE,
  CARD_ANSWER_REPLACEMENT_IN_MATH,
  CARD_TAG,
  CLOZE_DELIMITERS,
  DAY_ROLLOVER_OFFSET_HOURS,
  MAX_SQL_QUERY_PARAMS,
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
import { refusalReason } from '#/lib/readiness';
import { initialCard, replayCard } from '#/lib/repository/scheduling-replay';
import { formatSourceLink } from '#/lib/source-link';
import type {
  ISRSCard,
  ISRSCardDisplay,
  SQLiteRepository,
  SRSCardRow,
} from '#/lib/types';
import { excludedIdsOf, seenElsewhereArb } from '#/test/due-query';
import {
  makeItemVault,
  runOutMergeWait,
  TestRepository,
} from '#/test/item-vault';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import {
  type FSRSParameters,
  type Grade,
  type StepUnit,
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  StrategyMode,
} from 'ts-fsrs';
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
import { tombstoneRowStatements } from './row-delete';
import SRSCard from './SRSCard';

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
    writeRefusal: vi.fn(() => null),
    readiness: 'ready',
  } as unknown as SQLiteRepository;
}

function makePlugin(appOverrides: Record<string, unknown> = {}) {
  return {
    // rowToReviewCard reads frontmatter via metadataCache.getFileCache and no
    // longer writes it back (0166). Both stubs resolve cleanly anyway, so a
    // write that came back would not surface as an unhandled rejection.
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
    getLine: (line: number) => text.split('\n')[line],
    posToOffset,
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
    writeRefusal: vi.fn(() => null),
    readiness: 'ready',
  } as unknown as SQLiteRepository;
}

let emptySchemaDb: Promise<{ SQL: SqlJsStatic; bytes: Uint8Array }> | null =
  null;

/**
 * The sql.js module and an empty database at the current production schema,
 * built once. Executing the schema costs far more than deserializing its
 * result, and properties build a fresh database per case.
 */
function getEmptySchemaDb(): Promise<{ SQL: SqlJsStatic; bytes: Uint8Array }> {
  return (emptySchemaDb ??= (async () => {
    const SQL = await initSqlJs({
      wasmBinary: readFileSync(
        require.resolve('sql.js/dist/sql-wasm.wasm')
      ) as unknown as ArrayBuffer,
    });
    const db = new SQL.Database();
    db.exec(readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8'));
    const bytes = db.export();
    db.close();
    return { SQL, bytes };
  })());
}

/** A fresh in-memory database at the current production schema. */
async function makeSchemaDb(): Promise<Database> {
  const { SQL, bytes } = await getEmptySchemaDb();
  return new SQL.Database(bytes);
}

/** Make `rows` the only cards in `db`, each at a note of its own. */
function replaceCards(db: Database, rows: SRSCardRow[]) {
  db.exec('DELETE FROM srs_card');
  for (const row of rows) {
    db.exec(
      `INSERT INTO srs_card
        (id, reference, created_at, due, dismissed, deleted, stability,
         difficulty, elapsed_days, scheduled_days, learning_steps, reps,
         lapses, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        row.id,
        // Unique per row, as the schema requires
        `cards/${row.id}.md`,
        row.created_at,
        row.due,
        row.dismissed,
        Number(row.deleted),
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
  }
}

/** Any of the four grades. */
const gradeArb = fc.constantFrom<Grade>(
  Rating.Again,
  Rating.Hard,
  Rating.Good,
  Rating.Easy
);

const PDF = 'papers/paper.pdf';
const NOTE = 'notes/source.md';

/** A manager over a real database and a vault holding a PDF and a note. */
async function wire() {
  const vault = makeItemVault({ [PDF]: null, [NOTE]: null });
  const repo = await TestRepository.create();
  repo.mutate(
    `INSERT INTO article (id, reference, due, interval, priority) VALUES ($1, $2, $3, $4, $5)`,
    ['article-1', PDF, 0, MS_PER_DAY, 30]
  );
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const manager = new CardManager(
    {
      app: vault.app,
      settings: { dayRolloverOffset: 4, fsrsParams: generatorParameters() },
    } as never,
    repo
  );
  const fromPdf = () =>
    manager.createFromPdf({
      article: {
        data: { id: 'article-1', type: 'article', reference: PDF },
        file: vault.files.get(PDF)!,
      } as never,
      text: 'some text',
      start: 1e10,
      end: 1e10 + 9,
      subpath: '#page=1&selection=0,0,0,9',
      answer: [5, 9],
    });
  return { vault, repo, notify, manager, fromPdf };
}
/**
 * A card graded `grade` once on a real database, dismissed beforehand or
 * not, and the card as it was before the grade.
 */
async function gradedCard(dismissed: boolean, grade: Grade) {
  const repo = await TestRepository.create();
  const manager = new CardManager(makePlugin(), repo);
  const row = makeCardRow({ id: 'card-1', reference: 'cards/c.md' });
  const stored = { ...row, dismissed: Number(dismissed) };
  const columns = Object.keys(stored);
  repo.mutate(
    `INSERT INTO srs_card (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(stored).map((v) =>
      typeof v === 'boolean' ? Number(v) : v
    ) as never
  );
  const before = CardManager.rowToDisplay(
    repo.rows('srs_card')[0] as unknown as SRSCardRow
  );
  const reviewId = await manager.review(before, grade, new Date(0));
  return { repo, manager, before, reviewId, row: repo.rows('srs_card') };
}

/** Moments apart from any wall clock, for grades a test places in time. */
const UNDO_T = 1_790_000_000_000;

/** FSRS parameters a user can set, fuzz on or off. */
const undoParamsArb: fc.Arbitrary<Partial<FSRSParameters>> = fc.record({
  request_retention: fc.double({ min: 0.7, max: 0.99, noNaN: true }),
  maximum_interval: fc.integer({ min: 1, max: 36_500 }),
  enable_fuzz: fc.boolean(),
  enable_short_term: fc.boolean(),
  learning_steps: fc.constantFrom([], ['1m', '10m'], ['10m'], ['1d']),
  relearning_steps: fc.constantFrom([], ['10m'], ['1h', '1d']),
});

/** Gaps between two grades: the same millisecond, minutes, or months. */
const undoGapArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 60_000 }),
  fc.integer({ min: 1, max: 90 * MS_PER_DAY })
);

/**
 * A card made at `createdAt` on a real database, never graded, graded with
 * `params` by `grade`, which notes the card as it was before each grade.
 */
async function undoableCard(
  params: Partial<FSRSParameters>,
  createdAt = UNDO_T
) {
  const repo = await TestRepository.create();
  const plugin = {
    app: {},
    settings: { dayRolloverOffset: 4, fsrsParams: generatorParameters(params) },
  } as never;
  const manager = new CardManager(plugin, repo);
  const card = new SRSCard('cards/c.md', new Date(createdAt));
  card.id = 'c';
  // The row records its note's fingerprint, so the note needs a `stat`
  const file = makeItemVault({ 'cards/c.md': {} }).files.get('cards/c.md')!;
  await (
    manager as unknown as {
      insertRow(card: SRSCard, parent: null, file: TFile): Promise<void>;
    }
  ).insertRow(card, null, file);
  /** The card's row without its stamp. */
  const row = () => repo.rows('srs_card')[0];
  const grade = async (rating: Grade, at: number) => {
    const before = row();
    const id = await manager.review(
      CardManager.rowToDisplay(before as never),
      rating,
      new Date(at)
    );
    return { id, before };
  };
  const undo = (graded: { id: string; before: Record<string, unknown> }) =>
    manager.rollbackBeforeReview(
      CardManager.rowToDisplay(graded.before as never),
      graded.id
    );
  /** Every review of the card, undone ones included. */
  const log = () =>
    repo.storedRows('srs_card_review').map((r) => ({
      id: r.id as string,
      at: r.review as number,
      rating: r.rating as number,
      deleted: r.deleted as number,
      by: r.updated_by as string,
    }));
  /** The FSRS columns the live log implies, graded from a new card. */
  const replayed = () =>
    replayCard(log(), params, initialCard(row().created_at as number));
  return { repo, plugin, manager, row, grade, undo, log, replayed };
}

/** The FSRS columns of a card row. */
function fsrsColumns(row: Record<string, unknown>) {
  const {
    due,
    last_review,
    stability,
    difficulty,
    elapsed_days,
    scheduled_days,
    learning_steps,
    reps,
    lapses,
    state,
  } = row;
  return {
    due,
    last_review,
    stability,
    difficulty,
    elapsed_days,
    scheduled_days,
    learning_steps,
    reps,
    lapses,
    state,
  };
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
          // Outside math or a comment its line would open
          fc.pre(!/^ {0,3}(\$\$|%%)/.test(pre));
          const content = `${pre}${LEFT}${answer}${RIGHT}${post}`;
          const result = CardManager.hideAnswer(content);
          expect(result).toBe(pre + CARD_ANSWER_REPLACEMENT + post);
        }
      )
    );
  });

  it('puts a placeholder that renders as such in code and math in place of an answer there', () => {
    const hidden = (pre: string) =>
      CardManager.hideAnswer(`${pre}${LEFT} x ${RIGHT} y\n${'```'}`);
    expect(hidden('```js\na = ')).toBe(
      `${'```'}js\na = ${CARD_ANSWER_REPLACEMENT_IN_CODE} y\n${'```'}`
    );
    expect(hidden('$$\na = ')).toContain(CARD_ANSWER_REPLACEMENT_IN_MATH);
    // A fence's info string is no code, nor is what follows a closed block
    expect(hidden('```js ')).toContain(CARD_ANSWER_REPLACEMENT);
    expect(hidden('```\na\n```\n\n')).toContain(CARD_ANSWER_REPLACEMENT);
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

  it('writes no id or tag into a parsed note that has no frontmatter', async () => {
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
        expect(processFrontMatter).not.toHaveBeenCalled();
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
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
          expect(excludedIdsOf(params)).toEqual(excludeIds);
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
    // dueBy is $1, the excluded ids $2 as one list, limit $3
    expect(sql).toContain('due <= $1');
    expect(sql).toContain('json_each($2)');
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual([dueBy, JSON.stringify(excludeIds), limit]);
  });

  it('omits the dismissed filter when includeDismissed=true, but keeps the default deleted filter', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
    expect(sql).toMatch(/deleted = FALSE/i);
  });

  it('binds the excluded ids as one parameter, however many there are', async () => {
    await fc.assert(
      fc.asyncProperty(seenElsewhereArb, async (excludeIds) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        await manager.fetchMany({
          dueBy: 1000,
          learningDueBy: 500,
          excludeIds,
        });
        const [, params] = lastQueryCall(repo);
        expect(params).toEqual(
          excludeIds.length
            ? [1000, 500, JSON.stringify(excludeIds)]
            : [1000, 500]
        );
      }),
      { numRuns: 20 }
    );
  });

  describe('against the production schema', () => {
    let db: Database;

    beforeAll(async () => {
      db = await makeSchemaDb();
    });

    afterAll(() => {
      db.close();
    });

    /** The ids `fetchMany(opts)` returns of a live, a dismissed and a deleted card. */
    async function fetchedIds(
      opts: Parameters<CardManager['fetchMany']>[0]
    ): Promise<string[]> {
      replaceCards(db, [
        makeCardRow({ id: 'live', due: 1 }),
        makeCardRow({ id: 'dismissed', due: 2, dismissed: 1 }),
        makeCardRow({ id: 'deleted', due: 3, deleted: true }),
      ]);
      const manager = new CardManager(makePlugin(), makeRealRepo(db));
      return (await manager.fetchMany(opts)).map(({ id }) => id);
    }

    it('leaves out dismissed and deleted cards by default', async () => {
      expect(await fetchedIds(undefined)).toEqual(['live']);
    });

    it('keeps deleted cards when includeDeleted is true', async () => {
      expect(await fetchedIds({ includeDeleted: true })).toEqual([
        'live',
        'deleted',
      ]);
    });

    it('returns every card when nothing filters them', async () => {
      expect(
        await fetchedIds({ includeDismissed: true, includeDeleted: true })
      ).toEqual(['live', 'dismissed', 'deleted']);
    });
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
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
        const excluded = excludedIdsOf(params);
        return [rowA, rowB].filter((r) => !excluded.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
    } as unknown as SQLiteRepository;

    const manager = new CardManager(makePlugin(), repo);
    const results = await manager.getDue();

    expect(results).toEqual([
      { data: CardManager.rowToDisplay(rowA), file: null },
      { data: CardManager.rowToDisplay(rowB), file },
    ]);
    expect(callCount).toBe(1);
    // Missing is never stored
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });

  it('rejects, rather than reporting nothing due, when its query fails', async () => {
    const failure = new Error('db error');
    const repo = {
      // As the repository does: a failed read rejects only when asked to
      query: vi.fn(
        async (
          _sql: string,
          _params: unknown[],
          opts?: { throwOnError?: boolean }
        ) => {
          if (opts?.throwOnError) throw failure;
          return [];
        }
      ),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
    } as unknown as SQLiteRepository;
    // Whatever it is asked for, under whatever settings
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 0, max: 4_102_444_800_000 }), {
          nil: undefined,
        }),
        fc.option(fc.nat({ max: 50 }), { nil: undefined }),
        fc.option(fc.array(fc.uuid(), { maxLength: 5 }), { nil: undefined }),
        fc.integer({
          min: DAY_ROLLOVER_OFFSET_HOURS.MIN,
          max: DAY_ROLLOVER_OFFSET_HOURS.MAX,
        }),
        fc.boolean(),
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        async (
          dueBy,
          limit,
          excludeIds,
          dayRolloverOffset,
          fuzzTextReviews,
          now
        ) => {
          const plugin = makePlugin() as unknown as {
            settings: Record<string, unknown>;
          };
          Object.assign(plugin.settings, {
            dayRolloverOffset,
            fuzzTextReviews,
          });
          const manager = new CardManager(plugin as never, repo);
          await expect(
            manager.getDue(dueBy, limit, excludeIds, now)
          ).rejects.toBe(failure);
        }
      )
    );
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await manager.getDue(undefined, undefined, ['excluded-id']);
    expect(excludedIdsOf(queryCalls[0])).toContain('excluded-id');
  });

  it('excludes nothing on the first fetch when no excludeIds are given', async () => {
    const repo = makeRepoWithCards([]);
    await new CardManager(makePlugin(), repo).getDue();
    const [[sql]] = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
      string,
    ][];
    expect(sql).not.toMatch(/NOT IN/i);
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
        return [rowA, rowB].filter(
          (r) => !excludedIdsOf(params).includes(r.id)
        );
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
    } as unknown as SQLiteRepository;

    const manager = new CardManager(makePlugin(claiming(rowA.reference)), repo);
    const results = await manager.getDue();
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
    } as unknown as SQLiteRepository;

    const manager = new CardManager(
      makePlugin(claiming(rowNoFile.reference)),
      repo
    );
    await manager.getDue();
    // Should have retried — the refused row's id must appear in the second call's params
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    expect(excludedIdsOf(queryCalls[1])).toContain('missing');
  });

  describe('against the production schema', () => {
    /** One database for every case: {@link dueIds} empties it for each. */
    let db: Database;

    beforeAll(async () => {
      db = await makeSchemaDb();
    });

    afterAll(() => {
      db.close();
    });

    // #region REAL-DB GETDUE HELPERS

    const MINUTE = 60 * 1000;
    /** The plugin's rollover offset in {@link makePlugin}. */
    const ROLLOVER = 4;
    /** Noon, well inside its review day, which ends 16 hours later. */
    const NOON = new Date(2026, 0, 15, 12).getTime();
    /** The end of {@link NOON}'s review day: 04:00 the next morning. */
    const END_OF_DAY = new Date(2026, 0, 16, ROLLOVER).getTime();

    /**
     * The ids `getDue` returns, when called at `now` with `rows` as the only
     * cards in the database and the day rolling over at `offset` hours.
     */
    async function dueIds(
      rows: SRSCardRow[],
      now: number,
      {
        dueBy,
        limit,
        excludeIds,
        offset = ROLLOVER,
      }: {
        dueBy?: number;
        limit?: number;
        excludeIds?: string[];
        offset?: number;
      } = {}
    ): Promise<string[]> {
      replaceCards(db, rows);
      const plugin = makePlugin() as unknown as {
        settings: { dayRolloverOffset: number };
      };
      plugin.settings.dayRolloverOffset = offset;
      const manager = new CardManager(plugin as never, makeRealRepo(db));
      const due = await manager.getDue(dueBy, limit, excludeIds, now);
      return due.map(({ data }) => data.id);
    }

    /** A card in the property below, its due time relative to a cutoff. */
    const cardSpecArb = fc.record({
      id: fc.uuid(),
      state: stateArb,
      // Spread over the day either side, with the cutoffs themselves likely
      due: fc.oneof(
        fc.integer({ min: -MS_PER_DAY, max: 2 * MS_PER_DAY }),
        fc.constantFrom(-1, 0, 1)
      ),
      dueFromEndOfDay: fc.boolean(),
      dismissed: fc.boolean(),
      deleted: fc.boolean(),
      excluded: fc.boolean(),
    });

    // #endregion

    it('leaves out a Learning card due a minute from now', async () => {
      const ids = await dueIds(
        [
          makeCardRow({
            id: 'learning',
            state: State.Learning,
            due: NOON + MINUTE,
          }),
        ],
        NOON
      );
      expect(ids).toEqual([]);
    });

    it('returns a Learning card due a minute ago', async () => {
      const ids = await dueIds(
        [
          makeCardRow({
            id: 'learning',
            state: State.Learning,
            due: NOON - MINUTE,
          }),
        ],
        NOON
      );
      expect(ids).toEqual(['learning']);
    });

    it('leaves out a Relearning card due a minute from now', async () => {
      const ids = await dueIds(
        [
          makeCardRow({
            id: 'relearning',
            state: State.Relearning,
            due: NOON + MINUTE,
          }),
        ],
        NOON
      );
      expect(ids).toEqual([]);
    });

    it('returns a Relearning card due a minute ago', async () => {
      const ids = await dueIds(
        [
          makeCardRow({
            id: 'relearning',
            state: State.Relearning,
            due: NOON - MINUTE,
          }),
        ],
        NOON
      );
      expect(ids).toEqual(['relearning']);
    });

    it('returns a Review card due later in the review day', async () => {
      const ids = await dueIds(
        [
          makeCardRow({
            id: 'review',
            state: State.Review,
            due: END_OF_DAY - MINUTE,
          }),
        ],
        NOON
      );
      expect(ids).toEqual(['review']);
    });

    it('returns a New card due later in the review day', async () => {
      const ids = await dueIds(
        [makeCardRow({ id: 'new', state: State.New, due: END_OF_DAY })],
        NOON
      );
      expect(ids).toEqual(['new']);
    });

    it('treats an explicit dueBy of 0 as a cutoff, not as no cutoff', async () => {
      const ids = await dueIds(
        [
          makeCardRow({ id: 'at-zero', state: State.Review, due: 0 }),
          makeCardRow({ id: 'after-zero', state: State.Review, due: 1 }),
        ],
        NOON,
        { dueBy: 0 }
      );
      expect(ids).toEqual(['at-zero']);
    });

    it('returns exactly the live cards due by their own state’s cutoff and not seen, soonest first, however many were seen', async () => {
      await fc.assert(
        fc.asyncProperty(
          // A review day, by its calendar date, and an instant inside it
          fc.date({
            min: new Date(2000, 0, 1),
            max: new Date(2100, 0, 1),
            noInvalidDate: true,
          }),
          fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
          fc.integer({
            min: DAY_ROLLOVER_OFFSET_HOURS.MIN,
            max: DAY_ROLLOVER_OFFSET_HOURS.MAX,
          }),
          fc.option(fc.integer({ min: -MS_PER_DAY, max: 2 * MS_PER_DAY })),
          // Review asks for one at a time, the queue for all; never for none
          fc.option(fc.integer({ min: 1, max: 14 })),
          fc.uniqueArray(cardSpecArb, {
            selector: ({ id }) => id,
            maxLength: 12,
          }),
          seenElsewhereArb,
          async (
            day,
            fraction,
            offset,
            dueByOffset,
            limit,
            specs,
            otherSeen
          ) => {
            const start = new Date(
              day.getFullYear(),
              day.getMonth(),
              day.getDate(),
              offset
            ).getTime();
            const end = new Date(
              day.getFullYear(),
              day.getMonth(),
              day.getDate() + 1,
              offset
            ).getTime();
            const now = start + Math.floor(fraction * (end - start));
            const dueBy = dueByOffset === null ? undefined : now + dueByOffset;
            const rows = specs.map((spec) =>
              makeCardRow({
                id: spec.id,
                state: spec.state,
                due: spec.dueFromEndOfDay ? end + spec.due : now + spec.due,
                dismissed: spec.dismissed ? 1 : 0,
                deleted: spec.deleted,
              })
            );
            const excludeIds = [
              ...otherSeen,
              ...specs.filter(({ excluded }) => excluded).map(({ id }) => id),
            ];

            const ids = await dueIds(rows, now, {
              dueBy,
              limit: limit ?? undefined,
              excludeIds,
              offset,
            });

            const cutoff = dueBy ?? end;
            const learning = new Set<number>([
              State.Learning,
              State.Relearning,
            ]);
            const eligible = rows
              .filter(
                (row) =>
                  !row.dismissed &&
                  !row.deleted &&
                  !excludeIds.includes(row.id) &&
                  row.due <=
                    (learning.has(row.state) ? Math.min(now, cutoff) : cutoff)
              )
              .sort((a, b) => a.due - b.due);
            const expectedDues = eligible
              .slice(0, limit ?? eligible.length)
              .map(({ due }) => due);
            // Ties in `due` may come back in either order, and either side of
            // the limit
            expect(new Set(ids).size).toBe(ids.length);
            for (const id of ids) {
              expect(eligible.map((row) => row.id)).toContain(id);
            }
            expect(
              ids.map((id) => rows.find((row) => row.id === id)!.due)
            ).toEqual(expectedDues);
          }
        )
      );
    });

    it('leaves out a row whose note is another item’s and fetches on, however many were seen', async () => {
      replaceCards(db, [
        makeCardRow({ id: 'claimed', state: State.Review, due: NOON - 2 }),
        makeCardRow({ id: 'own', state: State.Review, due: NOON - 1 }),
      ]);
      vi.spyOn(Obsidian, 'getNote').mockImplementation(noteAt);
      const repo = makeRealRepo(db);
      const manager = new CardManager(
        makePlugin(claiming('cards/claimed.md')),
        repo
      );
      const seen = Array.from(
        { length: MAX_SQL_QUERY_PARAMS + 1 },
        (_, i) => `seen-${i}`
      );

      const due = await manager.getDue(undefined, 1, seen, NOON);

      expect(due.map(({ data }) => data.id)).toEqual(['own']);
      // The claimed row was left out of the second query, not just dropped
      expect((repo.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        2
      );
    });

    it('passes limit and excludeIds on alongside the split cutoff', async () => {
      const rows = [
        makeCardRow({ id: 'a', state: State.Learning, due: NOON - 3 }),
        makeCardRow({ id: 'b', state: State.Review, due: NOON - 2 }),
        makeCardRow({ id: 'c', state: State.New, due: NOON - 1 }),
      ];
      expect(await dueIds(rows, NOON, { limit: 1, excludeIds: ['a'] })).toEqual(
        ['b']
      );
      expect(await dueIds(rows, NOON, { excludeIds: ['a', 'b'] })).toEqual([
        'c',
      ]);
    });
  });
});

describe('countDueLaterToday', () => {
  /** One database for every case: {@link countAt} empties it for each. */
  let db: Database;

  beforeAll(async () => {
    db = await makeSchemaDb();
  });

  afterAll(() => {
    db.close();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // #region COUNT-DUE-LATER HELPERS

  const MINUTE = 60 * 1000;
  /** Noon, well inside its review day under a 4-hour rollover. */
  const NOON = new Date(2026, 0, 15, 12).getTime();
  /** The end of {@link NOON}'s review day under a 4-hour rollover. */
  const END_OF_DAY = new Date(2026, 0, 16, 4).getTime();

  /** What is at a card's reference: its own note, none, or another item's. */
  type NoteAtReference = 'own' | 'missing' | 'claimed';

  /**
   * `countDueLaterToday` at `now`, with `rows` as the only cards in the
   * database, the day rolling over at `offset` hours, and each card's note
   * as `notes` has it (its own by default).
   */
  async function countAt(
    rows: SRSCardRow[],
    now: number | undefined,
    {
      offset = 4,
      notes = {},
    }: { offset?: number; notes?: Record<string, NoteAtReference> } = {}
  ): Promise<number> {
    // Per property case, not per `it`
    vi.restoreAllMocks();
    replaceCards(db, rows);
    const noteOf = (path: string) =>
      notes[/^cards\/(.*)\.md$/.exec(path)![1]] ?? 'own';
    vi.spyOn(Obsidian, 'getNote').mockImplementation((reference) =>
      noteOf(reference) === 'missing' ? null : noteAt(reference)
    );
    const plugin = makePlugin({
      metadataCache: {
        getFileCache: (file: TFile) =>
          noteOf(file.path) === 'claimed'
            ? { frontmatter: { 'ir-id': 'another-item', tags: [CARD_TAG] } }
            : {},
      },
    }) as unknown as { settings: { dayRolloverOffset: number } };
    plugin.settings.dayRolloverOffset = offset;
    const manager = new CardManager(plugin as never, makeRealRepo(db));
    return now === undefined
      ? manager.countDueLaterToday()
      : manager.countDueLaterToday(now);
  }

  /** A card in the property below, its due time relative to a cutoff. */
  const cardSpecArb = fc.record({
    id: fc.uuid(),
    state: stateArb,
    // Spread over the day either side, with the cutoffs themselves likely
    due: fc.oneof(
      fc.integer({ min: -MS_PER_DAY, max: 2 * MS_PER_DAY }),
      fc.constantFrom(-1, 0, 1)
    ),
    dueFromEndOfDay: fc.boolean(),
    dismissed: fc.boolean(),
    deleted: fc.boolean(),
    note: fc.constantFrom<NoteAtReference>('own', 'missing', 'claimed'),
  });

  // #endregion

  it('counts exactly the live Learning and Relearning cards with a note of their own due after now and before the review day ends', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A review day, by its calendar date, and an instant inside it
        fc.date({
          min: new Date(2000, 0, 1),
          max: new Date(2100, 0, 1),
          noInvalidDate: true,
        }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        fc.integer({
          min: DAY_ROLLOVER_OFFSET_HOURS.MIN,
          max: DAY_ROLLOVER_OFFSET_HOURS.MAX,
        }),
        fc.uniqueArray(cardSpecArb, {
          selector: ({ id }) => id,
          maxLength: 12,
        }),
        async (day, fraction, offset, specs) => {
          const start = new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            offset
          ).getTime();
          const end = new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate() + 1,
            offset
          ).getTime();
          const now = start + Math.floor(fraction * (end - start));
          const rows = specs.map((spec) =>
            makeCardRow({
              id: spec.id,
              state: spec.state,
              due: spec.dueFromEndOfDay ? end + spec.due : now + spec.due,
              dismissed: spec.dismissed ? 1 : 0,
              deleted: spec.deleted,
            })
          );
          const notes = Object.fromEntries(
            specs.map(({ id, note }) => [id, note])
          );

          const count = await countAt(rows, now, { offset, notes });

          const learning = new Set<number>([State.Learning, State.Relearning]);
          const expected = rows.filter(
            (row) =>
              learning.has(row.state) &&
              now < row.due &&
              row.due < end &&
              !row.dismissed &&
              !row.deleted &&
              notes[row.id] === 'own'
          ).length;
          expect(count).toBe(expected);
        }
      )
    );
  });

  it('counts a Learning card due a minute from now', async () => {
    const count = await countAt(
      [
        makeCardRow({
          id: 'learning',
          state: State.Learning,
          due: NOON + MINUTE,
        }),
      ],
      NOON
    );
    expect(count).toBe(1);
  });

  it('leaves out a Learning card due as the review day ends, which is the next day’s', async () => {
    const count = await countAt(
      [makeCardRow({ id: 'next-day', state: State.Learning, due: END_OF_DAY })],
      NOON
    );
    expect(count).toBe(0);
  });

  it('counts a Learning card due before the rollover in the small hours as today’s', async () => {
    const twoAm = new Date(2026, 0, 16, 2).getTime();
    const count = await countAt(
      [
        makeCardRow({
          id: 'before-rollover',
          state: State.Learning,
          due: twoAm + MINUTE,
        }),
        makeCardRow({
          id: 'after-rollover',
          state: State.Learning,
          due: END_OF_DAY + MINUTE,
        }),
      ],
      twoAm
    );
    expect(count).toBe(1);
  });

  it('counts from the current time when no time is given', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    const count = await countAt(
      [
        makeCardRow({ id: 'past', state: State.Learning, due: NOON - MINUTE }),
        makeCardRow({ id: 'later', state: State.Learning, due: NOON + MINUTE }),
      ],
      undefined
    );
    expect(count).toBe(1);
  });
});

describe('getFsrs — what getDue relies on', () => {
  // #region SCHEDULING HELPERS

  /**
   * A count of steps or days with no ceiling but the settings tab's: small
   * ones, which are what people use, and huge ones, which it also accepts.
   */
  const countArb = fc.oneof(
    fc.integer({ min: 1, max: 2000 }),
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })
  );

  /** A learning or relearning step, as the settings tab accepts one. */
  const stepArb = fc
    .tuple(countArb, fc.constantFrom('m', 'h', 'd'))
    .map(([count, unit]): StepUnit => `${count}${unit}`);

  /** Every FSRS setting the settings tab exposes, a little past its bounds. */
  const fsrsParamsArb = fc.record({
    request_retention: fc.double({ min: 0.7, max: 0.99, noNaN: true }),
    maximum_interval: countArb,
    enable_fuzz: fc.boolean(),
    enable_short_term: fc.boolean(),
    learning_steps: fc.array(stepArb, { maxLength: 12 }),
    relearning_steps: fc.array(stepArb, { maxLength: 12 }),
  });

  /** A review: its grade, and how long after the one before it came. */
  const reviewArb = fc.record({
    grade: gradeArb,
    delay: fc.integer({ min: 0, max: 400 * MS_PER_DAY }),
  });

  // #endregion

  it('schedules a card less than a day out only while it is Learning or Relearning', () => {
    // A review day lasts at most a day, bar the one the clocks go back on, so
    // a card scheduled a day or more out is never due again in the review day
    // it was graded in. getDue holds back only Learning and Relearning cards
    // to their exact due time; this is why that is enough.
    fc.assert(
      fc.property(
        fsrsParamsArb,
        fc.date({
          min: new Date(2000, 0, 1),
          max: new Date(2100, 0, 1),
          noInvalidDate: true,
        }),
        fc.array(reviewArb, { minLength: 1, maxLength: 12 }),
        (fsrsParams, createdAt, reviews) => {
          const plugin = makePlugin() as unknown as {
            settings: { fsrsParams: unknown };
          };
          plugin.settings.fsrsParams = {
            ...generatorParameters(),
            ...fsrsParams,
          };
          const scheduler = new CardManager(
            plugin as never,
            makeRepo()
          ).getFsrs();
          let card = createEmptyCard(createdAt);
          let time = createdAt.getTime();
          for (const { grade, delay } of reviews) {
            time += delay;
            card = scheduler.next(card, new Date(time), grade).card;
            if (card.due.getTime() - time < MS_PER_DAY) {
              expect([State.Learning, State.Relearning]).toContain(card.state);
            }
          }
        }
      )
    );
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
            writeRefusal: vi.fn(() => null),
            readiness: 'ready',
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
            writeRefusal: vi.fn(() => null),
            readiness: 'ready',
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
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
      writeRefusal: vi.fn(() => null),
      readiness: 'ready',
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
          // the very same params, card and review time, and ts-fsrs seeds its
          // fuzz from those alone (review time, reps, difficulty × stability),
          // so any fuzz is reproduced identically.
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

  // #region PREVIEW HELPERS

  /** A learning or relearning step, as the settings tab accepts one. */
  const stepArb = fc
    .tuple(
      fc.oneof(
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })
      ),
      fc.constantFrom('m', 'h', 'd')
    )
    .map(([count, unit]): StepUnit => `${count}${unit}`);

  /** Every FSRS setting the settings tab exposes. */
  const fsrsParamsArb = fc
    .record({
      request_retention: fc.double({ min: 0.7, max: 0.99, noNaN: true }),
      // The settings tab takes any positive integer
      maximum_interval: fc.oneof(
        fc.integer({ min: 1, max: 36500 }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })
      ),
      enable_fuzz: fc.boolean(),
      enable_short_term: fc.boolean(),
      learning_steps: fc.array(stepArb, { maxLength: 6 }),
      relearning_steps: fc.array(stepArb, { maxLength: 6 }),
    })
    .map((params) => generatorParameters(params));

  /**
   * A card in whatever state a history of reviews under `params` leaves it —
   * New for no history, then Learning, Review or Relearning — in the display
   * shape review reads, and a moment after its last review to preview it at.
   */
  function cardAndTimeArb(params: FSRSParameters) {
    return fc
      .record({
        createdAt: fc.date({
          min: new Date(2000, 0, 1),
          max: new Date(2100, 0, 1),
          noInvalidDate: true,
        }),
        reviews: fc.array(
          fc.record({
            grade: gradeArb,
            delay: fc.integer({ min: 0, max: 400 * MS_PER_DAY }),
          }),
          { maxLength: 8 }
        ),
        previewDelay: fc.integer({ min: 0, max: 800 * MS_PER_DAY }),
      })
      .map(({ createdAt, reviews, previewDelay }) => {
        const scheduler = fsrs(params);
        let card = createEmptyCard(createdAt);
        let time = createdAt.getTime();
        for (const { grade, delay } of reviews) {
          time += delay;
          card = scheduler.next(card, new Date(time), grade).card;
        }
        const display = makeCardDisplay({
          ...card,
          state: State[card.state] as ISRSCardDisplay['state'],
        });
        return { card: display, now: new Date(time + previewDelay) };
      });
  }

  // #endregion

  describe('previewDue', () => {
    it('property: shows the due date grading would write, for each grade, any card and any settings', async () => {
      await fc.assert(
        fc.asyncProperty(
          fsrsParamsArb.chain((params) =>
            fc.tuple(fc.constant(params), cardAndTimeArb(params), gradeArb)
          ),
          async ([params, { card, now }, grade]) => {
            const repo = makeReviewRepo(makeCardRow({ id: card.id }));
            const manager = new CardManager(makePluginWithFsrs(params), repo);

            const preview = manager.previewDue(card, now);
            // A step past the last date a Date can hold leaves the card due
            // at no date at all, which review refuses to write
            const written = await manager.review(card, grade, now).then(
              () => updateParamsFrom(repo)[UPDATE_PARAM.due],
              () => NaN
            );

            expect(preview[grade].getTime()).toBe(written);
          }
        )
      );
    });

    it('property: still shows what grading writes when the grade comes later than the preview, fuzz off', async () => {
      // A preview taken at one moment and a grade made later agree, fuzz
      // off. With fuzz on, ts-fsrs seeds the fuzz from the moment of the
      // review, so the two can differ by a fuzzed interval; the buttons show
      // the unfuzzed interval, marked approximate (see gradePreview).
      await fc.assert(
        fc.asyncProperty(
          fsrsParamsArb
            .map((params) => ({ ...params, enable_fuzz: false }))
            .chain((params) =>
              fc.tuple(
                fc.constant(params),
                cardAndTimeArb(params),
                gradeArb,
                fc.integer({ min: 1, max: 10 * 60_000 })
              )
            ),
          async ([params, { card, now }, grade, later]) => {
            const repo = makeReviewRepo(makeCardRow({ id: card.id }));
            const manager = new CardManager(makePluginWithFsrs(params), repo);

            const gradedAt = new Date(now.getTime() + later);
            // ts-fsrs counts the days since the last review by UTC date, so a
            // grade on the next UTC day is a day further on — and rightly
            // schedules from there
            fc.pre(gradedAt.getUTCDate() === now.getUTCDate());
            const preview = manager.previewDue(card, now);
            const written = await manager.review(card, grade, gradedAt).then(
              () => updateParamsFrom(repo)[UPDATE_PARAM.due] as number,
              () => NaN
            );

            // Every interval is measured from the moment it is graded at
            expect(written - gradedAt.getTime()).toBe(
              preview[grade].getTime() - now.getTime()
            );
          }
        )
      );
    });

    it('property: previews all four grades and nothing else', () => {
      fc.assert(
        fc.property(
          fsrsParamsArb.chain((params) =>
            fc.tuple(fc.constant(params), cardAndTimeArb(params))
          ),
          ([params, { card, now }]) => {
            const manager = new CardManager(
              makePluginWithFsrs(params),
              makeReviewRepo(makeCardRow())
            );

            expect(
              Object.keys(manager.previewDue(card, now)).map(Number)
            ).toEqual([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
          }
        )
      );
    });
  });

  describe('gradePreview', () => {
    // #region GRADE PREVIEW HELPERS

    /**
     * The card as the next poll of the current item hands it over: equal in
     * every field, but a new object, its dates new objects too.
     */
    const repolled = (card: ISRSCardDisplay): ISRSCardDisplay => ({
      ...card,
      created_at: new Date(card.created_at),
      due: new Date(card.due),
      last_review: card.last_review && new Date(card.last_review),
    });

    /** How far past `now` each grade puts `card`, fuzz left out. */
    function unfuzzed(
      params: FSRSParameters,
      card: ISRSCardDisplay,
      now: Date
    ) {
      const log = fsrs({ ...params, enable_fuzz: false }).repeat(card, now);
      return Object.fromEntries(
        ([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const).map(
          (g) => [g, log[g].card.due.getTime() - now.getTime()]
        )
      );
    }

    /** The four grades, in order. */
    const GRADE_LIST = [
      Rating.Again,
      Rating.Hard,
      Rating.Good,
      Rating.Easy,
    ] as const;

    /**
     * How far past `now` each grade puts `card` with fuzz on, its fuzz seeded
     * by `seed` rather than the moment: each seed is one roll of the fuzz.
     */
    function fuzzedWith(
      seed: string,
      params: FSRSParameters,
      card: ISRSCardDisplay,
      now: Date
    ) {
      const log = fsrs({ ...params, enable_fuzz: true })
        .useStrategy(StrategyMode.SEED, () => seed)
        .repeat(card, now);
      return GRADE_LIST.map((g) => log[g].card.due.getTime() - now.getTime());
    }

    /** Preview `card` at `now` under `params`. */
    function previewOf(
      params: FSRSParameters,
      card: ISRSCardDisplay,
      now: Date
    ) {
      return new CardManager(
        makePluginWithFsrs(params),
        makeReviewRepo(makeCardRow())
      ).gradePreview(card, now);
    }

    /** A card in Review, last reviewed `elapsedDays` ago, as of `now`. */
    function reviewCard(now: Date, elapsedDays = 30): ISRSCardDisplay {
      return makeCardDisplay({
        state: 'Review',
        stability: 60,
        difficulty: 5,
        reps: 6,
        last_review: new Date(now.getTime() - elapsedDays * MS_PER_DAY),
        due: now,
      });
    }

    // #endregion

    it('property: shows each grade unfuzzed, approximate only while fuzz is on', () => {
      fc.assert(
        fc.property(
          fsrsParamsArb.chain((params) =>
            fc.tuple(fc.constant(params), cardAndTimeArb(params))
          ),
          ([params, { card, now }]) => {
            const preview = previewOf(params, card, now);

            // NaN where a step runs past the last date a Date can hold
            expect(preview.inMs).toEqual(unfuzzed(params, card, now));
            for (const g of GRADE_LIST) {
              if (preview.approximate[g]) {
                expect(params.enable_fuzz).toBe(true);
                expect(Number.isNaN(preview.inMs[g])).toBe(false);
              }
            }
          }
        )
      );
    });

    it('property: marks approximate every grade some roll of the fuzz moves', () => {
      fc.assert(
        fc.property(
          fsrsParamsArb.chain((params) =>
            fc.tuple(
              fc.constant({ ...params, enable_fuzz: true }),
              cardAndTimeArb(params)
            )
          ),
          ([params, { card, now }]) => {
            const preview = previewOf(params, card, now);
            const exact = unfuzzed(params, card, now);

            for (let roll = 0; roll < 50; roll++) {
              const fuzzed = fuzzedWith(`roll-${roll}`, params, card, now);
              GRADE_LIST.forEach((g, i) => {
                if (!Object.is(fuzzed[i], exact[g])) {
                  expect(preview.approximate[g]).toBe(true);
                }
              });
            }
          }
        )
      );
    });

    it('marks only the grades fuzz can move: a new card’s steps are exact, its first interval is not', () => {
      const now = new Date(2026, 9, 12, 12);
      const preview = previewOf(
        generatorParameters({ enable_fuzz: true }),
        makeCardDisplay(),
        now
      );

      // 1m, 6m, 10m and 8d under ts-fsrs's defaults
      expect(preview.approximate).toEqual({
        [Rating.Again]: false,
        [Rating.Hard]: false,
        [Rating.Good]: false,
        [Rating.Easy]: true,
      });
    });

    it('marks the review intervals of a card in review, not its relearning step', () => {
      const now = new Date(2026, 9, 12, 12);
      const preview = previewOf(
        generatorParameters({ enable_fuzz: true }),
        reviewCard(now),
        now
      );

      expect(preview.approximate).toEqual({
        [Rating.Again]: false,
        [Rating.Hard]: true,
        [Rating.Good]: true,
        [Rating.Easy]: true,
      });
    });

    it('leaves exact the review intervals too short to fuzz', () => {
      const now = new Date(2026, 9, 12, 12);
      const preview = previewOf(
        generatorParameters({ enable_fuzz: true }),
        { ...reviewCard(now, 1), stability: 0.5, difficulty: 8 },
        now
      );

      // 10m (relearning), 1d, 2d, 3d: ts-fsrs fuzzes only the 3d
      expect(preview.inMs).toEqual({
        [Rating.Again]: 10 * 60_000,
        [Rating.Hard]: MS_PER_DAY,
        [Rating.Good]: 2 * MS_PER_DAY,
        [Rating.Easy]: 3 * MS_PER_DAY,
      });
      expect(preview.approximate).toEqual({
        [Rating.Again]: false,
        [Rating.Hard]: false,
        [Rating.Good]: false,
        [Rating.Easy]: true,
      });
    });

    it('leaves exact a learning step days long, which ts-fsrs never fuzzes', () => {
      const now = new Date(2026, 9, 12, 12);
      const preview = previewOf(
        generatorParameters({ enable_fuzz: true, learning_steps: ['3d'] }),
        makeCardDisplay(),
        now
      );

      expect(preview.inMs[Rating.Again]).toBe(3 * MS_PER_DAY);
      expect(preview.approximate[Rating.Again]).toBe(false);
    });

    it('marks every interval it shows approximate when it cannot tell which fuzz moves', () => {
      const manager = new CardManager(
        makePluginWithFsrs(generatorParameters({ enable_fuzz: true })),
        makeReviewRepo(makeCardRow())
      );
      // Private, so reached past its type
      (manager as unknown as { fuzzEdgeDue: () => never }).fuzzEdgeDue = () => {
        throw new Error('ts-fsrs changed under us');
      };

      const preview = manager.gradePreview(
        makeCardDisplay(),
        new Date(2026, 9, 12, 12)
      );

      expect(Object.values(preview.approximate)).toEqual([
        true,
        true,
        true,
        true,
      ]);
    });

    it('marks nothing while fuzz is off', () => {
      const now = new Date(2026, 9, 12, 12);
      const preview = previewOf(
        generatorParameters({ enable_fuzz: false }),
        reviewCard(now),
        now
      );

      expect(Object.values(preview.approximate)).toEqual([
        false,
        false,
        false,
        false,
      ]);
    });

    it('property: previews a card once while it is shown, however often it is asked and whenever', () => {
      fc.assert(
        fc.property(
          fsrsParamsArb.chain((params) =>
            fc.tuple(fc.constant(params), cardAndTimeArb(params))
          ),
          fc.array(fc.integer({ min: 0, max: 400 * MS_PER_DAY }), {
            minLength: 1,
            maxLength: 6,
          }),
          ([params, { card, now }], laterBy) => {
            const manager = new CardManager(
              makePluginWithFsrs(params),
              makeReviewRepo(makeCardRow())
            );
            const previewDue = vi.spyOn(manager, 'previewDue');

            const first = manager.gradePreview(card, now);
            for (const later of laterBy) {
              expect(
                manager.gradePreview(
                  repolled(card),
                  new Date(now.getTime() + later)
                )
              ).toBe(first);
            }

            expect(previewDue).toHaveBeenCalledOnce();
          }
        )
      );
    });

    it('previews again for another card, a graded card, or new settings, holding only the last', () => {
      const params = generatorParameters({ enable_fuzz: true });
      const plugin = makePluginWithFsrs(params) as unknown as {
        settings: { fsrsParams: FSRSParameters };
      };
      const manager = new CardManager(
        plugin as never,
        makeReviewRepo(makeCardRow())
      );
      const previewDue = vi.spyOn(manager, 'previewDue');
      const now = new Date(2026, 9, 12, 12);
      const a = makeCardDisplay({ id: 'card-a' });
      const b = makeCardDisplay({ id: 'card-b' });

      manager.gradePreview(a, now);
      manager.gradePreview(b, now);
      manager.gradePreview(a, now);
      expect(previewDue).toHaveBeenCalledTimes(3);

      // Graded: the same card in another state
      manager.gradePreview({ ...a, reps: 1, state: 'Learning' }, now);
      expect(previewDue).toHaveBeenCalledTimes(4);

      plugin.settings.fsrsParams = { ...params, enable_fuzz: false };
      const unfuzzedPreview = manager.gradePreview(
        { ...a, reps: 1, state: 'Learning' },
        now
      );
      expect(previewDue).toHaveBeenCalledTimes(5);
      expect(Object.values(unfuzzedPreview.approximate)).not.toContain(true);
    });

    it('shows no interval for a card ts-fsrs will not preview, and asks once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = new CardManager(
        makePluginWithFsrs(generatorParameters({ enable_fuzz: true })),
        makeReviewRepo(makeCardRow())
      );
      const previewDue = vi
        .spyOn(manager, 'previewDue')
        .mockImplementation(() => {
          throw new Error('a card ts-fsrs will not schedule');
        });
      const card = makeCardDisplay();

      const preview = manager.gradePreview(card, new Date());
      manager.gradePreview(repolled(card), new Date());

      expect(preview).toEqual({
        approximate: {
          [Rating.Again]: false,
          [Rating.Hard]: false,
          [Rating.Good]: false,
          [Rating.Easy]: false,
        },
        inMs: {
          [Rating.Again]: NaN,
          [Rating.Hard]: NaN,
          [Rating.Good]: NaN,
          [Rating.Easy]: NaN,
        },
      });
      expect(previewDue).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Could not preview the grades of a card',
        expect.any(Error)
      );
    });
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
  /** An empty database at the production schema, reopened per case. */
  let schemaBytes: Uint8Array;

  beforeAll(async () => {
    ({ SQL, bytes: schemaBytes } = await getEmptySchemaDb());
  });

  /** Fixed instant so FSRS scheduling is reproducible run to run. */
  const REVIEW_AT = new Date('2026-01-01T00:00:00.000Z');
  const TEN_MINUTES_MS = 10 * 60 * 1000;

  /** A database at the current production schema with one card row in it. */
  function makeDbWithCard(overrides: Partial<SRSCardRow> = {}): {
    db: Database;
    row: SRSCardRow;
  } {
    const db = new SQL.Database(schemaBytes);
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

  // #endregion

  it('executes both write statements without a SQL error, for every grade and starting state', async () => {
    await fc.assert(
      fc.asyncProperty(gradeArb, startingCardArb, async (grade, overrides) => {
        const { db } = makeDbWithCard(overrides);
        const manager = new CardManager(makePlugin(), makeRealRepo(db));

        await manager.review(readCard(db, 'card-1'), grade, REVIEW_AT);

        db.close();
      })
    );
  });

  it('writes exactly one review-log row per review', async () => {
    await fc.assert(
      fc.asyncProperty(gradeArb, startingCardArb, async (grade, overrides) => {
        const { db } = makeDbWithCard(overrides);
        const manager = new CardManager(makePlugin(), makeRealRepo(db));

        await manager.review(readCard(db, 'card-1'), grade, REVIEW_AT);

        expect(readReviewLogs(db, 'card-1')).toHaveLength(1);
        db.close();
      })
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
          vi.spyOn(Obsidian, 'transcludeLink').mockReturnValue('![[c]]');
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
      vi.spyOn(Obsidian, 'transcludeLink').mockReturnValue('![[c]]');
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

  it('reports a card it could not make as an error, leaving the note alone', async () => {
    const manager = new CardManager(makePlugin(), makeRepo());
    vi.spyOn(
      manager as unknown as {
        createFileAndEntry: (text: string) => Promise<unknown>;
      },
      'createFileAndEntry'
    ).mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
      line: 'some text',
      lineNumber: 0,
      start: 0,
      end: 9,
    });
    vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
      selection: 'some',
      start: { line: 0, ch: 0 },
      end: { line: 0, ch: 4 },
      startOffset: 0,
      endOffset: 4,
    });
    const setSelection = vi.fn();

    const result = await manager.create(
      { setSelection } as never,
      { file: sourceFile } as never
    );

    expect(result).toBeNull();
    expect(setSelection).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      kind: 'error',
    });
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

  it('makes a card of the span, with the answer hidden, from the note it is in, each start escaped as cut from it, and its second line kept from underlining its first', async () => {
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
          Markdown.escapeCutUnderline(
            doc,
            from,
            pre + `${LEFT} ${answer} ${RIGHT}` + c.post
          ),
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
        // Undo puts `line` back where it finds the embed it was told of.
        expect(result).toMatchObject({
          reviewCard,
          line: c.text,
          embed: `!${LINK}`,
        });
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
          expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String));
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('makes the card of the span widened off the escape pairs it splits, its answer off any backslash that would escape a delimiter, each start escaped as cut from the note, and its second line kept from underlining its first', async () => {
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
            Markdown.escapeCutUnderline(
              doc,
              start,
              pre + `${LEFT} ${hidden} ${RIGHT}` + text.slice(b)
            ),
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

  /**
   * The text of the card made of `doc` from `from` to its end, its answer at
   * `answer` in that span.
   */
  async function cardFromSelection(
    doc: string,
    from: number,
    answer: readonly [number, number]
  ) {
    const { manager, createFileAndEntry } = setUp();
    await manager.createFromSelection(
      makeEditor(doc) as never,
      { file: sourceFile } as never,
      { from, to: doc.length, text: doc.slice(from) },
      answer
    );
    vi.restoreAllMocks();
    return createFileAndEntry.mock.calls[0][0];
  }

  it('makes no tag, heading, quote or list of a span or answer selected from mid-line that the note did not hold there', async () => {
    // The span from the `#` of `word#evil`
    expect(await cardFromSelection('word#evil x', 4, [6, 7])).toBe(
      String.raw`\#evil ${LEFT} x ${RIGHT}`
    );
    expect(await cardFromSelection('a > b c', 2, [4, 5])).toBe(
      String.raw`\> b ${LEFT} c ${RIGHT}`
    );
    expect(await cardFromSelection('a - b c', 2, [4, 5])).toBe(
      String.raw`\- b ${LEFT} c ${RIGHT}`
    );
    // The answer from it
    expect(await cardFromSelection('x word#evil', 0, [6, 11])).toBe(
      String.raw`x word${LEFT} \#evil ${RIGHT}`
    );
    // The span from its `#`, the answer too
    expect(await cardFromSelection('a##b', 1, [0, 3])).toBe(
      String.raw`${LEFT} \#\#b ${RIGHT}`
    );
    // A tag after whitespace was one there too
    expect(await cardFromSelection('see #tag x', 4, [5, 6])).toBe(
      `#tag ${LEFT} x ${RIGHT}`
    );
    // Inside inline code, a tag was none
    expect(await cardFromSelection('`see #tag` x', 5, [6, 7])).toBe(
      String.raw`\#tag${'`'} ${LEFT} x ${RIGHT}`
    );
  });

  it('makes no heading of a span from mid-line whose next line would underline it, but where the note showed one', async () => {
    // A rule under a list item stays a rule, and text under a heading text
    expect(await cardFromSelection('- buy milk\n---', 2, [4, 8])).toBe(
      `buy ${LEFT} milk ${RIGHT}\n\n---`
    );
    expect(await cardFromSelection('# T x\n===', 4, [0, 1])).toBe(
      `${LEFT} x ${RIGHT}\n` + String.raw`\===`
    );
    // The underline of a paragraph of one line was one there too
    expect(await cardFromSelection('a x\n---', 2, [0, 1])).toBe(
      `${LEFT} x ${RIGHT}\n---`
    );
  });

  describe('keeps the second line of a span from mid-line what it was in the note: an underline of a heading, a rule, or text', () => {
    const PREFIXES = ['- ', '> ', '# ', '', 'a\n', '- a\n'];
    const UNDERS = ['---', '===', '-', '--', '-----', '---\t'];
    const cases = PREFIXES.flatMap((prefix) =>
      UNDERS.flatMap((under) =>
        ['\n', '\r\n'].map((lineBreak) => ({ prefix, under, lineBreak }))
      )
    );

    // Only `buy milk` after nothing, a one-line paragraph, was a heading (in
    // live preview at least); reading view takes no rule with a tab after it
    it.each(cases)(
      'over $under after $prefix',
      async ({ prefix, under, lineBreak }) => {
        const doc = `${prefix}buy milk${lineBreak}${under}`;
        const from = doc.indexOf('milk');

        const [first, second, third] = (
          await cardFromSelection(doc, from, [0, 4])
        ).split(/\r\n?|\n/);

        expect(first).toBe(`${LEFT} milk ${RIGHT}`);
        if (prefix === '') {
          expect(second).toBe(under);
        } else if (/^-{3,}$/.test(under)) {
          expect([second, third]).toEqual(['', under]);
        } else {
          expect(second).toBe(`\\${under}`);
        }
      }
    );

    it.each(cases)(
      'over $under after $prefix, with the line in its answer',
      async ({ prefix, under, lineBreak }) => {
        const doc = `${prefix}buy milk${lineBreak}${under}`;
        const from = doc.indexOf('milk');

        const lines = (
          await cardFromSelection(doc, from, [
            4,
            4 + lineBreak.length + under.length,
          ])
        ).split(/\r\n?|\n/);

        // The answer's closing delimiter keeps it from underlining anything.
        // Under a heading, text that is no rule or list started a paragraph
        // of its own, which a blank line keeps apart
        const own = prefix === '# ' && ['===', '--', '---\t'].includes(under);
        expect(lines).toEqual(
          own
            ? [`milk${LEFT} `, '', `${under} ${RIGHT}`]
            : [`milk${LEFT} `, `${under} ${RIGHT}`]
        );
      }
    );
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
    expect(notify).toHaveBeenCalledWith(expect.any(String), {
      kind: 'error',
    });
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
            expect.any(String),
            { kind: 'error' }
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
  /** An empty database at the production schema, reopened per case. */
  let schemaBytes: Uint8Array;

  beforeAll(async () => {
    ({ SQL, bytes: schemaBytes } = await getEmptySchemaDb());
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
          const db = new SQL.Database(schemaBytes);
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

  /** The writes that tombstone the row `id` with its history, as mutate gets them. */
  const tombstoned = (id: string) =>
    tombstoneRowStatements('srs_card', id).map(({ query, params }) => [
      query,
      params,
    ]);

  it('trashes the note without a word, and drops the row, when told not to prompt', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        vi.restoreAllMocks();
        const { manager, mutate, fileManager } = wireDelete(id, NOTE);

        expect(await manager.delete(id, { prompt: false })).toBe('deleted');

        // Obsidian's prompt would also offer to delete what the note alone
        // linked to: a PDF its source links to among them
        expect(fileManager.trashFile).toHaveBeenCalledExactlyOnceWith(NOTE);
        expect(fileManager.promptForFileDeletion).not.toHaveBeenCalled();
        expect(mutate.mock.calls).toEqual(tombstoned(id));
      })
    );
  });

  it('deletes the note as Obsidian does, prompts and all, by default', async () => {
    for (const options of [undefined, {}, { prompt: true }]) {
      const { manager, mutate, fileManager } = wireDelete('id-1', NOTE);

      expect(await manager.delete('id-1', options)).toBe('deleted');

      expect(fileManager.promptForFileDeletion).toHaveBeenCalledExactlyOnceWith(
        NOTE
      );
      expect(fileManager.trashFile).not.toHaveBeenCalled();
      expect(mutate.mock.calls).toEqual(tombstoned('id-1'));
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

      expect(await manager.delete('id-1', { prompt })).toBe('failed');

      expect(fileManager.trashFile).not.toHaveBeenCalled();
      expect(fileManager.promptForFileDeletion).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    }
  });

  it('drops the row of a note already gone', async () => {
    for (const prompt of [true, false]) {
      const { manager, mutate, fileManager } = wireDelete('id-1', null);

      expect(await manager.delete('id-1', { prompt })).toBe('deleted');

      expect(fileManager.trashFile).not.toHaveBeenCalled();
      expect(fileManager.promptForFileDeletion).not.toHaveBeenCalled();
      expect(mutate.mock.calls).toEqual(tombstoned('id-1'));
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

describe('making and deleting a card, with its note and its row as one unit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves no card note and no row when a step before the row is saved fails, and keeps both when none does', async () => {
    for (const failure of ['note', 'frontmatter', 'row', null] as const) {
      vi.restoreAllMocks();
      const wired = await wire();
      if (failure === 'note') wired.vault.fail('create');
      if (failure === 'frontmatter') wired.vault.fail('frontmatter');
      if (failure === 'row') {
        wired.repo.failWrite((query) =>
          query.startsWith('INSERT INTO srs_card')
        );
      }

      const card = await wired.fromPdf();

      const rows = wired.repo.rows('srs_card');
      if (failure) {
        expect(card).toBeNull();
        expect(rows).toEqual([]);
        expect(wired.vault.paths()).toEqual([NOTE, PDF]);
      } else {
        expect(rows).toHaveLength(1);
        expect(wired.vault.paths()).toEqual(
          [NOTE, rows[0].reference as string, PDF].sort()
        );
      }
    }
  });

  it.each(['starting', 'merging'] as const)(
    'makes no note, and says why, while not ready (%s)',
    async (state) => {
      const wired = await wire();
      if (state === 'merging') {
        wired.repo.holdMerging();
        runOutMergeWait();
      } else wired.repo.refuseWrites(new Error('Saving is paused.'));
      const refused = expect.stringContaining(refusalReason(state));

      expect(await wired.fromPdf()).toBeNull();
      expect(wired.notify).toHaveBeenLastCalledWith(refused, { kind: 'error' });

      const doc = 'a line of text';
      const editor = makeEditor(doc);
      expect(
        await wired.manager.createFromSelection(
          editor as never,
          { file: wired.vault.files.get(NOTE) } as never,
          { from: 0, to: doc.length, text: doc },
          [2, 6]
        )
      ).toBeNull();
      expect(wired.notify).toHaveBeenLastCalledWith(refused, { kind: 'error' });

      vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
        line: doc,
        lineNumber: 0,
        start: 0,
        end: doc.length,
      });
      vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
        selection: 'line',
        start: { line: 0, ch: 2 },
        end: { line: 0, ch: 6 },
        startOffset: 2,
        endOffset: 6,
      });
      expect(
        await wired.manager.create(
          editor as never,
          { file: wired.vault.files.get(NOTE) } as never
        )
      ).toBeNull();
      expect(wired.notify).toHaveBeenLastCalledWith(refused, { kind: 'error' });

      expect(wired.vault.paths()).toEqual([NOTE, PDF]);
      expect(wired.vault.processFrontMatter).not.toHaveBeenCalled();
      expect(editor.text).toBe(doc);
    }
  );

  it('keeps the row as it was, and the note, when the note is not deleted, and deletes nothing while writes are refused', async () => {
    for (const why of ['cancelled', 'trash fails', 'refused'] as const) {
      vi.restoreAllMocks();
      const wired = await wire();
      const card = (await wired.fromPdf())!;
      const before = wired.repo.rows('srs_card');
      const paths = wired.vault.paths();
      Object.assign(wired.vault.app.fileManager, {
        promptForFileDeletion: vi.fn().mockResolvedValue(false),
      });
      if (why === 'trash fails') wired.vault.fail('trash');
      if (why === 'refused') wired.repo.refuseWrites(new Error('Paused.'));
      wired.notify.mockClear();

      expect(
        await wired.manager.delete(card.data.id, {
          prompt: why === 'cancelled',
        })
      ).toBe(
        { cancelled: 'declined', 'trash fails': 'failed', refused: 'refused' }[
          why
        ]
      );

      expect(wired.repo.rows('srs_card')).toEqual(before);
      expect(wired.vault.paths()).toEqual(paths);
      if (why === 'refused') {
        expect(wired.notify).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('Paused.'),
          { kind: 'error' }
        );
      }
    }
  });
});

describe('rollbackBeforeReview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Found by 0170's review: ts-fsrs `rollback` was handed the card as it was
  // before the grade, not after, so the card came back a rep short and due
  // when the undone grade was made (grades 20 days apart, fuzz off)
  it.each([
    { grades: [Rating.Good, Rating.Good], reps: 1 },
    { grades: [Rating.Good, Rating.Good, Rating.Good], reps: 2 },
    {
      grades: [
        Rating.Good,
        Rating.Good,
        Rating.Good,
        Rating.Good,
        Rating.Again,
      ],
      reps: 4,
    },
  ])(
    'puts a card back exactly as it was before its last grade, $reps reps',
    async ({ grades, reps }) => {
      const card = await undoableCard({});
      const graded = [];
      for (const [i, rating] of grades.entries()) {
        graded.push(
          await card.grade(rating as Grade, UNDO_T + (i + 1) * 20 * MS_PER_DAY)
        );
      }
      const last = graded[graded.length - 1];

      await card.undo(last);

      expect(card.row()).toEqual(last.before);
      expect(card.row().reps).toBe(reps);
    }
  );

  it('keeps what each grade noted for its undo only until it is undone or taken back with an earlier one', async () => {
    const card = await undoableCard({});
    const notes = () =>
      [
        ...(
          card.manager as unknown as { logsBefore: Map<string, unknown> }
        ).logsBefore.keys(),
      ].sort();
    const graded = [];
    for (let i = 1; i <= 4; i++) {
      graded.push(await card.grade(Rating.Good, UNDO_T + i * MS_PER_DAY));
    }
    expect(notes()).toEqual(graded.map((g) => g.id).sort());

    await card.undo(graded[3]);
    expect(notes()).toEqual(
      graded
        .slice(0, 3)
        .map((g) => g.id)
        .sort()
    );

    // Takes back the grades after it too, whose undos are still stacked
    await card.undo(graded[1]);
    expect(notes()).toEqual([graded[0].id]);
  });

  it('property: undoing a grade puts the card back exactly as it was before it, whatever the grades, parameters and gaps', async () => {
    await fc.assert(
      fc.asyncProperty(
        undoParamsArb,
        fc.array(
          fc.oneof(
            fc.record({ grade: gradeArb, gap: undoGapArb }),
            fc.constant('undo' as const)
          ),
          { maxLength: 12 }
        ),
        async (params, steps) => {
          const card = await undoableCard(params);
          const undoable: Awaited<ReturnType<typeof card.grade>>[] = [];
          let at = UNDO_T;
          for (const step of steps) {
            if (step !== 'undo') {
              at += step.gap;
              undoable.push(await card.grade(step.grade, at));
              continue;
            }
            const last = undoable.pop();
            if (!last) continue;

            await card.undo(last);

            expect(card.row()).toEqual(last.before);
          }
        }
      ),
      { numRuns: 40 }
    );
  }, 60_000);

  it('property: undoing any grade takes back the later ones with it, leaving the card as it was before it', async () => {
    await fc.assert(
      fc.asyncProperty(
        undoParamsArb,
        fc.array(fc.record({ grade: gradeArb, gap: undoGapArb }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.nat(),
        async (params, grades, pick) => {
          const card = await undoableCard(params);
          const graded = [];
          let at = UNDO_T;
          for (const { grade, gap } of grades) {
            at += gap;
            graded.push(await card.grade(grade, at));
          }
          const undone = pick % graded.length;

          await card.undo(graded[undone]);

          expect(card.row()).toEqual(graded[undone].before);
          expect(
            card
              .log()
              .filter((r) => r.deleted)
              .map((r) => r.id)
              .sort()
          ).toEqual(
            graded
              .slice(undone)
              .map((g) => g.id)
              .sort()
          );
        }
      ),
      { numRuns: 40 }
    );
  }, 60_000);

  it('property: undoing a grade another session made takes back the grades dated after it, leaving the card as it was before it', async () => {
    await fc.assert(
      fc.asyncProperty(
        undoParamsArb,
        fc.array(
          fc.record({
            grade: gradeArb,
            gap: fc.integer({ min: 1, max: 90 * MS_PER_DAY }),
          }),
          { minLength: 1, maxLength: 8 }
        ),
        fc.nat(),
        async (params, grades, pick) => {
          const card = await undoableCard(params);
          const graded = [];
          let at = UNDO_T;
          for (const { grade, gap } of grades) {
            at += gap;
            graded.push(await card.grade(grade, at));
          }
          const undone = graded[pick % graded.length];

          // As after a reload: the undo has no note of what the card had
          await new CardManager(card.plugin, card.repo).rollbackBeforeReview(
            CardManager.rowToDisplay(undone.before as never),
            undone.id
          );

          expect(card.row()).toEqual(undone.before);
          expect(
            card
              .log()
              .filter((r) => r.deleted)
              .map((r) => r.id)
          ).toEqual(graded.slice(graded.indexOf(undone)).map((g) => g.id));
        }
      ),
      { numRuns: 30 }
    );
  }, 60_000);

  it('property: undoing a grade never takes back another device’s review, whenever its clock dated it, and leaves the card as the reviews left imply', async () => {
    await fc.assert(
      fc.asyncProperty(
        undoParamsArb,
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('grade' as const),
              grade: gradeArb,
              gap: fc.integer({ min: 1, max: 90 * MS_PER_DAY }),
            }),
            // Another device's review, merged in: dated by a clock ahead of
            // this one or behind it
            fc.record({
              kind: fc.constant('theirs' as const),
              grade: gradeArb,
              skew: fc.integer({ min: -90 * MS_PER_DAY, max: 90 * MS_PER_DAY }),
            }),
            fc.record({ kind: fc.constant('undo' as const), pick: fc.nat() })
          ),
          { maxLength: 12 }
        ),
        async (params, events) => {
          const card = await undoableCard(params);
          const graded: Awaited<ReturnType<typeof card.grade>>[] = [];
          const theirs: string[] = [];
          let now = UNDO_T;
          for (const [i, event] of events.entries()) {
            const live = card.log().filter((r) => !r.deleted);
            if (event.kind === 'grade') {
              // Graded after every review the card has, at an even moment:
              // theirs are at odd ones, so no two share one
              const after = Math.max(now, ...live.map((r) => r.at)) + event.gap;
              now = after + (after % 2);
              graded.push(await card.grade(event.grade, now));
            } else if (event.kind === 'theirs') {
              const dated = now + event.skew;
              const id = `theirs-${i}`;
              card.repo.mutate(
                `INSERT INTO srs_card_review (id, card_id, due, review,
                   stability, difficulty, elapsed_days, last_elapsed_days,
                   scheduled_days, rating, state, updated_at, updated_by)
                 VALUES ($1, 'c', 0, $2, 0, 0, 0, 0, 0, $3, 0, 1, 'other')`,
                [id, dated - (dated % 2) + 1, event.grade]
              );
              theirs.push(id);
              // The card as the merge that brought it in leaves it
              const merged = card.replayed();
              card.repo.mutate(
                `UPDATE srs_card SET due = $1, last_review = $2,
                   stability = $3, difficulty = $4, elapsed_days = $5,
                   scheduled_days = $6, learning_steps = $7, reps = $8,
                   lapses = $9, state = $10 WHERE id = 'c'`,
                Object.values(merged) as never
              );
            } else {
              const mine = graded.filter((g) =>
                live.some((r) => r.id === g.id)
              );
              if (mine.length === 0) continue;
              const undone = mine[event.pick % mine.length];

              await card.undo(undone);

              const log = card.log();
              expect(log.find((r) => r.id === undone.id)?.deleted).toBe(1);
              expect(
                log.filter((r) => theirs.includes(r.id) && r.deleted)
              ).toEqual([]);
              expect(fsrsColumns(card.row())).toEqual(card.replayed());
              expect(card.row().dismissed).toBe(undone.before.dismissed);
            }
          }
        }
      ),
      { numRuns: 60 }
    );
  }, 120_000);

  it('puts the card back dismissed or not as it was before the grade, and tombstones the review', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), gradeArb, async (dismissed, grade) => {
        const { repo, manager, before, reviewId } = await gradedCard(
          dismissed,
          grade
        );

        await manager.rollbackBeforeReview(before, reviewId);

        const [card] = repo.rows('srs_card');
        expect(card.dismissed).toBe(Number(dismissed));
        // Kept, flagged, so the undo reaches the other devices
        expect(
          repo
            .storedRows('srs_card_review')
            .map(({ id, deleted }) => [id, deleted])
        ).toEqual([[reviewId, 1]]);
      }),
      { numRuns: 16 }
    );
  });

  it('refuses to undo a review already undone', async () => {
    const { manager, before, reviewId } = await gradedCard(false, Rating.Good);
    await manager.rollbackBeforeReview(before, reviewId);

    await expect(
      manager.rollbackBeforeReview(before, reviewId)
    ).rejects.toThrow(reviewId);
  });

  it('changes nothing when any of its writes fails, the dismissal included', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        gradeArb,
        fc.constantFrom('UPDATE srs_card SET', 'UPDATE srs_card_review'),

        async (dismissed, grade, failing) => {
          const graded = await gradedCard(dismissed, grade);
          const reviews = graded.repo.rows('srs_card_review');
          graded.repo.failWrite((query) => query.startsWith(failing));

          await expect(
            graded.manager.rollbackBeforeReview(graded.before, graded.reviewId)
          ).rejects.toThrow();

          expect(graded.repo.rows('srs_card')).toEqual(graded.row);
          expect(graded.repo.rows('srs_card_review')).toEqual(reviews);
        }
      ),
      { numRuns: 16 }
    );
  });
});

describe('adoptLeftover', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("gives a leftover card a new card's row, due the next day, the child of what its source links to", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.integer({ min: 0, max: 2 ** 40 }),
        async (hasParent, now) => {
          vi.restoreAllMocks();
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(now);
          const vault = makeItemVault({
            'cards/left.md': { 'ir-id': 'left-1', tags: [CARD_TAG] },
            'notes/parent.md': hasParent
              ? { 'ir-id': 'parent-1', tags: ['ir-article'] }
              : null,
          });
          const repo = await TestRepository.create();
          if (hasParent) {
            repo.mutate(
              `INSERT INTO article (id, reference, due, interval, priority) VALUES ('parent-1', 'notes/parent.md', 0, 1, 30)`
            );
          }
          vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(
            vault.files.get('notes/parent.md')!
          );
          const manager = new CardManager(
            { app: vault.app, settings: {} } as never,
            repo
          );

          await manager.adoptLeftover(
            vault.files.get('cards/left.md')!,
            'left-1'
          );

          expect(repo.rows('srs_card')).toEqual([
            expect.objectContaining({
              id: 'left-1',
              reference: 'cards/left.md',
              parent: hasParent ? 'parent-1' : null,
              created_at: now,
              due: now + MS_PER_DAY,
              reps: 0,
              state: State.New,
            }),
          ]);
        }
      ),
      { numRuns: 12 }
    );
  });

  it('gives one whose source links nowhere a row of no parent', async () => {
    const vault = makeItemVault({
      'cards/left.md': { 'ir-id': 'left-1', tags: [CARD_TAG] },
    });
    const repo = await TestRepository.create();
    vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(null);
    const manager = new CardManager(
      { app: vault.app, settings: {} } as never,
      repo
    );

    await manager.adoptLeftover(vault.files.get('cards/left.md')!, 'left-1');

    expect(repo.rows('srs_card')[0]).toMatchObject({ parent: null });
  });
});

describe('the note fingerprint a new card records', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The `note_mtime` the card row `id` holds. */
  const fingerprintOf = (repo: TestRepository, id: unknown) =>
    repo.storedRows('srs_card').find((row) => row.id === id)?.note_mtime;

  it('is the one the write of its id and tag left its note with', async () => {
    const { vault, repo, fromPdf } = await wire();

    const card = await fromPdf();

    const note = vault.files.get(card!.file.path)!;
    expect(vault.frontmatterOf(note.path)).toMatchObject({
      'ir-id': card!.data.id,
    });
    expect(fingerprintOf(repo, card!.data.id)).toBe(note.stat.mtime);
  });

  it("is the adopted leftover's mtime", async () => {
    const vault = makeItemVault({
      'cards/left.md': { 'ir-id': 'left-1', tags: [CARD_TAG] },
    });
    const repo = await TestRepository.create();
    vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(null);
    const manager = new CardManager({ app: vault.app } as never, repo);
    const file = vault.files.get('cards/left.md')!;

    await manager.adoptLeftover(file, 'left-1');

    expect(fingerprintOf(repo, 'left-1')).toBe(file.stat.mtime);
  });
});

describe('making a card of text cut from inside a block', () => {
  const sourceFile = { path: 'articles/source.md', extension: 'md' } as TFile;
  const reviewCard = {
    file: { path: 'cards/new.md', extension: 'md' },
    data: { id: 'card-1' },
  };
  const LINK = '[[new|ir-hide-title]]';
  const CODE = 'p\n\n```py\nx #ab\nef\n```\n\nq';
  /** The sections of CODE, as the metadata cache reads them. */
  const CODE_SECTIONS = [
    { type: 'paragraph', start: 0, end: 1 },
    { type: 'code', start: 3, end: 21 },
    { type: 'paragraph', start: 23, end: 24 },
  ];

  /** A card manager whose metadata cache reads any note as `sections`. */
  function setUp(sections: { type: string; start: number; end: number }[]) {
    const toCache = ({ type, start, end }: (typeof sections)[number]) => ({
      type,
      position: { start: { offset: start }, end: { offset: end } },
    });
    const manager = new CardManager(
      makePlugin({
        metadataCache: {
          getFileCache: () => ({}),
          computeMetadataAsync: async () => ({
            sections: sections.map(toCache),
          }),
        },
      }),
      makeRepo()
    );
    const createFileAndEntry = vi
      .spyOn(
        manager as unknown as {
          createFileAndEntry: (text: string, file: TFile) => Promise<unknown>;
        },
        'createFileAndEntry'
      )
      .mockResolvedValue(reviewCard);
    vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue(LINK);
    return { manager, createFileAndEntry };
  }

  /** An editor over `doc` whose CodeMirror view reads it as the editor does. */
  function makeCmEditor(doc: string) {
    const editor = makeEditor(doc);
    const cm = {
      state: {
        doc: {
          toString: () => editor.text,
          line: (n: number) => ({
            from: editor.text
              .split('\n')
              .slice(0, n - 1)
              .reduce((sum, line) => sum + line.length + 1, 0),
          }),
        },
      },
    };
    return Object.assign(editor, { cm });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes a code block before the embed and opens it again after, and gives the note its fence, its text copied as it is', async () => {
    const { manager, createFileAndEntry } = setUp(CODE_SECTIONS);
    const editor = makeEditor(CODE);
    const from = CODE.indexOf('#ab');
    const to = CODE.indexOf('ef') + 1;

    const result = await manager.createFromSelection(
      editor as never,
      { file: sourceFile } as never,
      { from, to, text: CODE.slice(from, to) },
      [4, 5]
    );

    const delimited = `#ab\n${LEFT} e ${RIGHT}`;
    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      '```py\n' + delimited + '\n```',
      sourceFile,
      undefined,
      delimited
    );
    expect(editor.text).toBe(
      'p\n\n```py\nx \n```\n!' + LINK + '\n```py\nf\n```\n\nq'
    );
    expect(result).toMatchObject({ before: '\n```\n', after: '\n```py\n' });
  });

  it('takes the closing fence of a code block it takes the rest of, leaving no empty block after the embed', async () => {
    const { manager, createFileAndEntry } = setUp(CODE_SECTIONS);
    const editor = makeEditor(CODE);
    const from = CODE.indexOf('#ab');
    const to = CODE.indexOf('\n```\n');

    const result = await manager.createFromSelection(
      editor as never,
      { file: sourceFile } as never,
      { from, to, text: CODE.slice(from, to) },
      [4, 6]
    );

    const delimited = `#ab\n${LEFT} ef ${RIGHT}\n\`\`\``;
    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      '```py\n' + delimited,
      sourceFile,
      undefined,
      delimited
    );
    expect(editor.text).toBe('p\n\n```py\nx \n```\n!' + LINK + '\n\nq');
    expect(result).toMatchObject({ before: '\n```\n', after: '' });
  });

  it('copies an answer that starts in code as it is', async () => {
    const { manager, createFileAndEntry } = setUp(CODE_SECTIONS);
    const from = CODE.indexOf('#ab');
    const to = from + 3;

    await manager.createFromSelection(
      makeEditor(CODE) as never,
      { file: sourceFile } as never,
      { from, to, text: '#ab' },
      [0, 3]
    );

    expect(createFileAndEntry.mock.calls[0][0]).toBe(
      `\`\`\`py\n${LEFT} #ab ${RIGHT}\n\`\`\``
    );
  });

  it('escapes a cut from inside a quote as from a line start, and gives it the quote markers it lacks', async () => {
    const doc = '> a > b\n\nq';
    const { manager, createFileAndEntry } = setUp([
      { type: 'blockquote', start: 0, end: 7 },
      { type: 'paragraph', start: 9, end: 10 },
    ]);
    const editor = makeEditor(doc);

    const result = await manager.createFromSelection(
      editor as never,
      { file: sourceFile } as never,
      { from: 4, to: 7, text: '> b' },
      [2, 3]
    );

    const pre = Markdown.escapeCutStart(doc, [4, 6], 'note');
    const delimited = Markdown.escapeCutUnderline(
      doc,
      4,
      `${pre}${LEFT} b ${RIGHT}`
    );
    expect(pre).not.toBe('> ');
    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      '> ' + delimited,
      sourceFile,
      undefined,
      delimited
    );
    expect(editor.text).toBe(`> a !${LINK}\n\nq`);
    expect(result).toMatchObject({ before: '', after: '' });
  });

  it('wraps a card of a line in a code block in its fence, and parts the embed from the code around it', async () => {
    const doc = 'p\n\n```py\nab#cd\n```';
    const { manager, createFileAndEntry } = setUp([
      { type: 'paragraph', start: 0, end: 1 },
      { type: 'code', start: 3, end: doc.length },
    ]);
    const editor = makeCmEditor(doc);
    vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
      line: 'ab#cd',
      lineNumber: 3,
      start: 0,
      end: 5,
    });
    vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
      selection: '#cd',
      start: { line: 3, ch: 2 },
      end: { line: 3, ch: 5 },
      startOffset: 11,
      endOffset: 14,
    });

    const result = await manager.create(
      editor as never,
      { file: sourceFile } as never
    );

    // Out of code, the answer's `#` would have been escaped
    expect(Markdown.escapeCutStart('ab#cd', [2, 5], 'answer')).not.toBe('#cd');
    const delimited = `ab${LEFT} #cd ${RIGHT}`;
    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      '```py\n' + delimited + '\n```',
      sourceFile,
      undefined,
      delimited
    );
    expect(editor.text).toBe(
      `p\n\n\`\`\`py\n\`\`\`\n!${LINK}\n\`\`\`py\n\`\`\``
    );
    expect(result).toMatchObject({ before: '```\n', after: '\n```py' });
  });

  it("escapes the answer of a card of a list item's line by where it stands", async () => {
    // A code block above, which an answer's offset counted from anywhere
    // but the line's start in the note would land in
    const code = '```\nxxxxxxxx\n```\n\n- ';
    for (const { marker, line, a } of [
      { marker: '[ ] ', line: 'ab#cd', a: 2 },
      { marker: '', line: 'ab cd ef#gh', a: 8 },
    ]) {
      const doc = code + marker + line;
      const { manager, createFileAndEntry } = setUp([
        { type: 'code', start: 0, end: 16 },
        { type: 'list', start: 18, end: doc.length },
      ]);
      const start = 2 + marker.length;
      vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
        line,
        lineNumber: 4,
        start,
        end: start + line.length,
      });
      vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
        selection: line.slice(a),
        start: { line: 4, ch: start + a },
        end: { line: 4, ch: start + line.length },
        startOffset: 18 + start + a,
        endOffset: doc.length,
      });

      await manager.create(
        makeCmEditor(doc) as never,
        {
          file: sourceFile,
        } as never
      );

      const answer = Markdown.escapeCutStart(line, [a, line.length], 'answer');
      expect(answer).not.toBe(line.slice(a));
      expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
        `${line.slice(0, a)}${LEFT} ${answer} ${RIGHT}`,
        sourceFile
      );
      vi.restoreAllMocks();
    }
  });

  it('copies an answer in code as it is, after a cut start out of it', async () => {
    const doc = 'pq\n\n```\nab#cd\nx\n```';
    const { manager, createFileAndEntry } = setUp([
      { type: 'paragraph', start: 0, end: 2 },
      { type: 'code', start: 4, end: doc.length },
    ]);

    await manager.createFromSelection(
      makeEditor(doc) as never,
      { file: sourceFile } as never,
      { from: 1, to: 13, text: doc.slice(1, 13) },
      [9, 12]
    );

    const pre = Markdown.escapeCutStart(doc, [1, 10], 'note');
    expect(Markdown.escapeCutStart(doc, [10, 13], 'answer')).not.toBe('#cd');
    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      Markdown.escapeCutUnderline(doc, 1, `${pre}${LEFT} #cd ${RIGHT}`) +
        '\n```',
      sourceFile,
      undefined,
      Markdown.escapeCutUnderline(doc, 1, `${pre}${LEFT} #cd ${RIGHT}`)
    );
  });

  it('puts nothing around the embed where the note can not be read', async () => {
    const manager = new CardManager(makePlugin(), makeRepo());
    vi.spyOn(
      manager as unknown as { createFileAndEntry: () => Promise<unknown> },
      'createFileAndEntry'
    ).mockResolvedValue(reviewCard);
    vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue(LINK);
    const editor = makeCmEditor(CODE);
    const from = CODE.indexOf('#ab');

    const fromSpan = await manager.createFromSelection(
      editor as never,
      { file: sourceFile } as never,
      { from, to: from + 3, text: '#ab' },
      [0, 3]
    );
    vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
      line: 'ef',
      lineNumber: 4,
      start: 0,
      end: 2,
    });
    vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
      selection: 'f',
      start: { line: 4, ch: 1 },
      end: { line: 4, ch: 2 },
      startOffset: 0,
      endOffset: 0,
    });
    const fromLine = await manager.create(
      makeEditor(CODE) as never,
      { file: sourceFile } as never
    );

    expect(fromSpan).toMatchObject({ before: '', after: '' });
    expect(fromLine).toMatchObject({ before: '', after: '' });
  });

  it('imputes nothing for a card of a fence line', async () => {
    const doc = '  ```py\nab\n```';
    const { manager, createFileAndEntry } = setUp([
      { type: 'code', start: 0, end: doc.length },
    ]);
    vi.spyOn(Obsidian, 'smartGetline').mockReturnValue({
      line: '```py',
      lineNumber: 0,
      start: 2,
      end: 7,
    });
    vi.spyOn(Obsidian, 'getSelectionWithBounds').mockReturnValue({
      selection: 'py',
      start: { line: 0, ch: 5 },
      end: { line: 0, ch: 7 },
      startOffset: 5,
      endOffset: 7,
    });

    const result = await manager.create(
      makeCmEditor(doc) as never,
      { file: sourceFile } as never
    );

    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      `\`\`\`${LEFT} py ${RIGHT}`,
      sourceFile
    );
    expect(result).toMatchObject({ before: '', after: '' });
  });
});

describe('create, from a selection over several lines', () => {
  const sourceFile = { path: 'articles/source.md', extension: 'md' } as TFile;
  const reviewCard = {
    file: { path: 'cards/new.md', extension: 'md' },
    data: { id: 'card-1' },
  };
  const LINK = '[[new|ir-hide-title]]';
  const EMBED = '!' + LINK;

  type Section = { type: string; start: number; end: number };

  /**
   * A card manager whose metadata cache reads any note as `sections`, its
   * lines `listLines` items of a list.
   */
  function setUp(sections: Section[], listLines: number[] = []) {
    const toCache = ({ type, start, end }: Section) => ({
      type,
      position: { start: { offset: start }, end: { offset: end } },
    });
    const listItems = listLines.map((line) => ({
      position: { start: { line }, end: { line } },
    }));
    const manager = new CardManager(
      makePlugin({
        metadataCache: {
          getFileCache: () => ({ listItems }),
          computeMetadataAsync: async () => ({
            sections: sections.map(toCache),
          }),
        },
      }),
      makeRepo()
    );
    const createFileAndEntry = vi
      .spyOn(
        manager as unknown as {
          createFileAndEntry: (text: string, file: TFile) => Promise<unknown>;
        },
        'createFileAndEntry'
      )
      .mockResolvedValue(reviewCard);
    const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
    vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue(LINK);
    return { manager, createFileAndEntry, notify };
  }

  /**
   * An editor over `doc` with `from`–`to` selected, the head at `head`, and
   * a CodeMirror view reading it as the editor does.
   */
  function makeSelectedEditor(
    doc: string,
    from: number,
    to: number,
    head = to
  ) {
    const editor = makeEditor(doc);
    const cm = {
      state: {
        doc: {
          toString: () => editor.text,
          line: (n: number) => ({
            from: editor.posToOffset({ line: n - 1, ch: 0 }),
          }),
        },
      },
    };
    return Object.assign(editor, {
      cm,
      getSelection: () => doc.slice(from, to),
      getCursor: (which?: 'from' | 'to') =>
        editor.offsetToPos(
          which === 'from' ? from : which === 'to' ? to : head
        ),
    });
  }

  /** What making a card did: the note's text, the card's, and the result. */
  async function made(
    createFileAndEntry: { mock: { calls: unknown[][] } },
    editor: ReturnType<typeof makeEditor>,
    make: () => Promise<unknown>
  ) {
    const result = await make();
    return {
      text: editor.text,
      card: createFileAndEntry.mock.calls,
      result,
      selected: editor.setSelection.mock.calls,
    };
  }

  const lineStart = (doc: string, line: number) =>
    doc
      .split('\n')
      .slice(0, line)
      .reduce((sum, l) => sum + l.length + 1, 0);
  const lineOf = (doc: string, at: number) =>
    doc.slice(0, at).split('\n').length - 1;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes one card from the first line through the last, the selection its answer, its embed in their place', async () => {
    const doc = 'aa bb\n\ncc dd\n\nee';
    const { manager, createFileAndEntry } = setUp([
      { type: 'paragraph', start: 0, end: 5 },
      { type: 'paragraph', start: 7, end: 12 },
      { type: 'paragraph', start: 14, end: 16 },
    ]);
    const editor = makeSelectedEditor(doc, 3, 9);

    const result = await manager.create(
      editor as never,
      { file: sourceFile } as never
    );

    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      `aa ${LEFT} bb\n\ncc ${RIGHT} dd`,
      sourceFile
    );
    expect(editor.text).toBe(`${EMBED}\n\nee`);
    expect(result).toMatchObject({
      line: 'aa bb\n\ncc dd',
      before: '',
      after: '',
    });
  });

  it('reads the lines of the selection, wherever its head is', async () => {
    const doc = 'aa bb\ncc dd';
    const { manager, createFileAndEntry } = setUp([
      { type: 'paragraph', start: 0, end: 11 },
    ]);

    await manager.create(
      makeSelectedEditor(doc, 3, 8, 3) as never,
      { file: sourceFile } as never
    );

    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      `aa ${LEFT} bb\ncc ${RIGHT} dd`,
      sourceFile
    );
  });

  it("cuts the first line's list marker off, as from a line of its own, but keeps the later lines'", async () => {
    const doc = 'x\n\n- aa bb\n- cc dd\n\ny';
    const { manager, createFileAndEntry } = setUp(
      [
        { type: 'paragraph', start: 0, end: 1 },
        { type: 'list', start: 3, end: 18 },
        { type: 'paragraph', start: 20, end: 21 },
      ],
      [2, 3]
    );
    const cases = [
      { from: doc.indexOf('bb'), card: `aa ${LEFT} bb\n- cc ${RIGHT} dd` },
      // From inside the first line's marker, which starts with its text
      { from: doc.indexOf('- aa'), card: `${LEFT} aa bb\n- cc ${RIGHT} dd` },
    ];
    for (const { from, card } of cases) {
      const editor = makeSelectedEditor(doc, from, doc.indexOf(' dd'));
      createFileAndEntry.mockClear();

      await manager.create(editor as never, { file: sourceFile } as never);

      expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
        card,
        sourceFile
      );
      expect(editor.text).toBe(`x\n\n- ${EMBED}\n\ny`);
    }
  });

  it('leaves the blank space around the selection out of the answer, and the lines that hold only that out of the card', async () => {
    const doc = 'aa bb\n\ncc dd\n\nee';
    const sections = [
      { type: 'paragraph', start: 0, end: 5 },
      { type: 'paragraph', start: 7, end: 12 },
      { type: 'paragraph', start: 14, end: 16 },
    ];
    const cases = [
      // From a blank line into the next paragraph
      { from: 6, to: 9, card: `${LEFT} cc ${RIGHT} dd`, rest: 'aa bb\n\n' },
      // A line selected whole, up to the next line's start
      { from: 7, to: 13, card: `${LEFT} cc dd ${RIGHT}`, rest: 'aa bb\n\n' },
      // Ending on a blank line, the line before it the last
      { from: 3, to: 13, card: `aa ${LEFT} bb\n\ncc dd ${RIGHT}`, rest: '' },
    ];
    for (const { from, to, card, rest } of cases) {
      const { manager, createFileAndEntry } = setUp(sections);
      const editor = makeSelectedEditor(doc, from, to);

      await manager.create(editor as never, { file: sourceFile } as never);

      expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
        card,
        sourceFile
      );
      expect(editor.text).toBe(`${rest}${EMBED}\n\nee`);
      vi.restoreAllMocks();
    }
  });

  it('leaves a list item selected no further than its marker out of the card, as a line selected up to its start is', async () => {
    const doc = 'x\n\n- aa bb\n- cc dd\n\n1. ee\n2. ff';
    const { manager, createFileAndEntry } = setUp(
      [
        { type: 'paragraph', start: 0, end: 1 },
        { type: 'list', start: 3, end: 18 },
        { type: 'list', start: 20, end: doc.length },
      ],
      [2, 3, 5, 6]
    );
    const cases = [
      // Up to the next item's text, onto one line
      {
        from: doc.indexOf('bb'),
        to: doc.indexOf('cc'),
        card: `aa ${LEFT} bb ${RIGHT}`,
        text: `x\n\n- ${EMBED}\n- cc dd\n\n1. ee\n2. ff`,
      },
      // Into a numbered item's marker, the lines before it kept
      {
        from: doc.indexOf('bb'),
        to: doc.indexOf('. ff'),
        card: `aa ${LEFT} bb\n- cc dd\n\n1. ee ${RIGHT}`,
        text: `x\n\n- ${EMBED}\n2. ff`,
      },
    ];
    for (const { from, to, card, text } of cases) {
      const editor = makeSelectedEditor(doc, from, to);
      createFileAndEntry.mockClear();

      await manager.create(editor as never, { file: sourceFile } as never);

      expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
        card,
        sourceFile
      );
      expect(editor.text).toBe(text);
    }
  });

  it('makes no card of a selection of nothing but a list marker', async () => {
    const doc = '- aa\n- bb';
    for (const [from, to] of [
      [4, 7],
      [5, 7],
    ]) {
      const { manager, createFileAndEntry, notify } = setUp(
        [{ type: 'list', start: 0, end: doc.length }],
        [0, 1]
      );
      const editor = makeSelectedEditor(doc, from, to);

      const result = await manager.create(
        editor as never,
        { file: sourceFile } as never
      );

      expect(result).toBeUndefined();
      expect(createFileAndEntry).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
      expect(editor.text).toBe(doc);
      vi.restoreAllMocks();
    }
  });

  it('makes a list item selected whole, from its marker to the next line, a card of its text', async () => {
    const doc = '- aa bb\n- cc';
    const { manager, createFileAndEntry } = setUp(
      [{ type: 'list', start: 0, end: doc.length }],
      [0, 1]
    );
    const editor = makeSelectedEditor(doc, 0, 8);

    await manager.create(editor as never, { file: sourceFile } as never);

    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      `${LEFT} aa bb ${RIGHT}`,
      sourceFile
    );
    expect(editor.text).toBe(`- ${EMBED}\n- cc`);
    // Off the embed's line, onto the next
    expect(editor.setSelection).toHaveBeenCalledExactlyOnceWith({
      line: 1,
      ch: 0,
    });
  });

  it('makes no card outside a note, nor with nothing selected', async () => {
    const doc = 'aa\nbb';
    for (const [file, to] of [
      [null, 4],
      [sourceFile, 0],
    ] as const) {
      const { manager, createFileAndEntry, notify } = setUp([]);
      const editor = makeSelectedEditor(doc, 0, to);

      const result = await manager.create(editor as never, { file } as never);

      expect(result ?? null).toBeNull();
      expect(createFileAndEntry).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
      expect(editor.text).toBe(doc);
      vi.restoreAllMocks();
    }
  });

  it('makes no card of a selection of only blank space', async () => {
    const doc = 'aa\n \n\nbb';
    const { manager, createFileAndEntry, notify } = setUp([]);
    const editor = makeSelectedEditor(doc, 2, 6);

    const result = await manager.create(
      editor as never,
      { file: sourceFile } as never
    );

    expect(result).toBeUndefined();
    expect(createFileAndEntry).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(editor.text).toBe(doc);
  });

  it('gives a card cut from inside a code block its fence, and closes the block before the embed', async () => {
    const doc = 'p\n\n```py\nx #ab\nef\n```\n\nq r';
    const { manager, createFileAndEntry } = setUp([
      { type: 'paragraph', start: 0, end: 1 },
      { type: 'code', start: 3, end: 21 },
      { type: 'paragraph', start: 23, end: 26 },
    ]);
    const editor = makeSelectedEditor(doc, doc.indexOf('f\n'), doc.length - 2);

    const result = await manager.create(
      editor as never,
      { file: sourceFile } as never
    );

    const delimited = `e${LEFT} f\n\`\`\`\n\nq ${RIGHT} r`;
    expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
      '```py\n' + delimited,
      sourceFile,
      undefined,
      delimited
    );
    expect(editor.text).toBe(`p\n\n\`\`\`py\nx #ab\n\`\`\`\n${EMBED}`);
    expect(result).toMatchObject({ line: 'ef\n```\n\nq r' });
  });

  it('keeps the quote the selection starts in a quote in the card', async () => {
    const doc = '> aa bb\n> cc\n\ndd';
    const { manager, createFileAndEntry } = setUp([
      { type: 'blockquote', start: 0, end: 12 },
      { type: 'paragraph', start: 14, end: 16 },
    ]);
    const editor = makeSelectedEditor(doc, doc.indexOf('bb'), doc.length);

    await manager.create(editor as never, { file: sourceFile } as never);

    expect(createFileAndEntry.mock.calls[0][0]).toBe(
      `> aa ${LEFT} bb\n> cc\n\ndd ${RIGHT}`
    );
    expect(editor.text).toBe(EMBED);
  });

  /**
   * A note of blocks of every kind the card's span can cut into or cross,
   * blank lines apart, their sections as the metadata cache reads them,
   * the lines of its lists, and the length of each line's list marker as the
   * line of a card made of it is cut.
   */
  const noteArb = fc
    .array(
      fc.record({
        kind: fc.constantFrom(
          'paragraph',
          'list',
          'code',
          'math',
          'blockquote'
        ),
        lines: fc.array(
          fc.string({
            unit: fc.constantFrom('a', 'b', ' ', '#', '*', '_', '\\', '`'),
            maxLength: 6,
          }),
          { minLength: 1, maxLength: 3 }
        ),
        marker: fc.constantFrom('- ', '1. ', '  - [ ] ', '* '),
      }),
      { minLength: 1, maxLength: 5 }
    )
    .chain((blocks) =>
      fc
        .array(fc.constantFrom('\n\n', '\n\n\n', '\n \n'), {
          minLength: blocks.length,
          maxLength: blocks.length,
        })
        .map((gaps) => {
          let doc = '';
          const sections: Section[] = [];
          const listLines: number[] = [];
          const cuts = new Map<number, number>();
          blocks.forEach(({ kind, lines, marker }, i) => {
            if (i > 0) doc += gaps[i];
            const firstLine = lineOf(doc, doc.length);
            const body =
              kind === 'list'
                ? lines.map((l) => marker + l)
                : kind === 'code'
                  ? ['```py', ...lines, '```']
                  : kind === 'math'
                    ? ['$$', ...lines, '$$']
                    : kind === 'blockquote'
                      ? lines.map((l) => '> ' + l)
                      : lines;
            if (kind === 'list') {
              lines.forEach((_, j) => {
                listLines.push(firstLine + j);
                // As far as the line of a card is cut, `* ` not
                const item = marker + lines[j];
                cuts.set(
                  firstLine + j,
                  item.length - Markdown.getListItemText(item).length
                );
              });
            }
            const start = doc.length;
            doc += body.join('\n');
            sections.push({ type: kind, start, end: doc.length });
          });
          return { doc, sections, listLines, cuts };
        })
    );

  /** {@link noteArb} with a selection in it from one line into another. */
  const multiLineArb = noteArb
    .chain((note) =>
      fc
        .tuple(fc.nat(note.doc.length), fc.nat(note.doc.length))
        .map(([x, y]) => ({
          ...note,
          from: Math.min(x, y),
          to: Math.max(x, y),
          headAtStart: x > y,
        }))
    )
    .filter(({ doc, from, to }) => lineOf(doc, from) !== lineOf(doc, to));

  it('makes the card of a selection over several lines of the span of its lines, the selection its answer, the blank space around it left out', async () => {
    await fc.assert(
      fc.asyncProperty(
        multiLineArb,
        async ({ doc, sections, listLines, cuts, from, to, headAtStart }) => {
          const selected = doc.slice(from, to);
          const a = from + selected.length - selected.trimStart().length;
          let b = to - selected.length + selected.trimEnd().length;
          fc.pre(a < b);
          const first = lineOf(doc, a);
          let last = lineOf(doc, b);
          const cut = (line: number) => cuts.get(line) ?? 0;
          // A last line selected no further than its marker is no line of it
          while (last > first && b - lineStart(doc, last) <= cut(last)) {
            b = a + doc.slice(a, lineStart(doc, last)).trimEnd().length;
            last = lineOf(doc, b);
          }
          const nothing =
            first === last && b - lineStart(doc, first) <= cut(first);

          const quick = setUp(sections, listLines);
          const editor = makeSelectedEditor(
            doc,
            from,
            to,
            headAtStart ? from : to
          );
          const actual = await made(quick.createFileAndEntry, editor, () =>
            quick.manager.create(
              editor as never,
              {
                file: sourceFile,
              } as never
            )
          );

          // The same card as of the trimmed selection on its one line, or
          // as of the span of its lines chosen in selection mode
          const expected = setUp(sections, listLines);
          const reference = makeSelectedEditor(doc, a, b);
          const spanFrom = lineStart(doc, first) + (cuts.get(first) ?? 0);
          const spanTo = lineStart(doc, last) + doc.split('\n')[last].length;
          const wanted = await made(
            expected.createFileAndEntry,
            reference,
            () =>
              first === last
                ? expected.manager.create(
                    reference as never,
                    {
                      file: sourceFile,
                    } as never
                  )
                : expected.manager.createFromSelection(
                    reference as never,
                    { file: sourceFile } as never,
                    {
                      from: spanFrom,
                      to: spanTo,
                      text: doc.slice(spanFrom, spanTo),
                    },
                    [Math.max(a - spanFrom, 0), b - spanFrom]
                  )
          );
          expect(actual).toStrictEqual(wanted);
          expect(actual.card).toHaveLength(nothing ? 0 : 1);
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 300 }
    );
  });

  it('makes the card of plain text selected from inside one line into another of those whole lines, delimiters at the ends of the selection', async () => {
    // Paragraphs and list items of plain words, which need no escaping nor
    // imputing, and a selection from a word's char on one line to one on a
    // later line, none of it in a list marker
    const plainNoteArb = fc
      .array(
        fc.record({
          list: fc.boolean(),
          lines: fc.array(fc.stringMatching(/^[ab]{1,3}( [ab]{1,3}){0,2}$/), {
            minLength: 1,
            maxLength: 3,
          }),
        }),
        { minLength: 1, maxLength: 4 }
      )
      .map((blocks) => {
        let doc = '';
        const sections: Section[] = [];
        const listLines: number[] = [];
        // Where each line's text starts, past its marker, and ends
        const contents: { from: number; to: number }[] = [];
        blocks.forEach(({ list, lines }, i) => {
          if (i > 0) doc += '\n\n';
          const start = doc.length;
          lines.forEach((line, j) => {
            if (j > 0) doc += '\n';
            if (list) {
              listLines.push(lineOf(doc, doc.length));
              doc += '- ';
            }
            contents.push({ from: doc.length, to: doc.length + line.length });
            doc += line;
          });
          sections.push({
            type: list ? 'list' : 'paragraph',
            start,
            end: doc.length,
          });
        });
        return { doc, sections, listLines, contents };
      })
      .filter(({ contents }) => contents.length > 1);
    const caseArb = plainNoteArb.chain((note) =>
      fc
        .tuple(
          fc.nat(note.contents.length - 1),
          fc.nat(note.contents.length - 1),
          fc.nat(),
          fc.nat(),
          fc.boolean()
        )
        .filter(([i, j]) => i !== j)
        .map(([i, j, x, y, headAtStart]) => {
          const [first, last] = [
            note.contents[Math.min(i, j)],
            note.contents[Math.max(i, j)],
          ];
          // Starting on a word's char, ending after one
          const starts = [...note.doc.slice(first.from, first.to)]
            .map((c, k) => (c === ' ' ? -1 : first.from + k))
            .filter((k) => k >= 0);
          const ends = [...note.doc.slice(last.from, last.to)]
            .map((c, k) => (c === ' ' ? -1 : last.from + k + 1))
            .filter((k) => k >= 0);
          return {
            ...note,
            first,
            last,
            from: starts[x % starts.length],
            to: ends[y % ends.length],
            headAtStart,
          };
        })
    );

    await fc.assert(
      fc.asyncProperty(
        caseArb,
        async ({
          doc,
          sections,
          listLines,
          first,
          last,
          from,
          to,
          headAtStart,
        }) => {
          const { manager, createFileAndEntry } = setUp(sections, listLines);
          const editor = makeSelectedEditor(
            doc,
            from,
            to,
            headAtStart ? from : to
          );

          await manager.create(editor as never, { file: sourceFile } as never);

          expect(createFileAndEntry).toHaveBeenCalledExactlyOnceWith(
            doc.slice(first.from, from) +
              `${LEFT} ${doc.slice(from, to)} ${RIGHT}` +
              doc.slice(to, last.to),
            sourceFile
          );
          expect(editor.text).toBe(
            doc.slice(0, first.from) + EMBED + doc.slice(last.to)
          );
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('leaves the note so that the text the card was made of, put back in place of its embed, restores it', async () => {
    await fc.assert(
      fc.asyncProperty(
        multiLineArb,
        async ({ doc, sections, listLines, from, to }) => {
          fc.pre(doc.slice(from, to).trim() !== '');
          const { manager } = setUp(sections, listLines);
          const editor = makeSelectedEditor(doc, from, to);

          const result = (await manager.create(
            editor as never,
            { file: sourceFile } as never
          )) as
            | { line: string; embed: string; before: string; after: string }
            | undefined;
          if (!result) {
            expect(editor.text).toBe(doc);
            vi.restoreAllMocks();
            return;
          }

          const placed = result.before + result.embed + result.after;
          const at = editor.text.indexOf(placed);
          expect(at).toBeGreaterThanOrEqual(0);
          expect(
            editor.text.slice(0, at) +
              result.line +
              editor.text.slice(at + placed.length)
          ).toBe(doc);
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 300 }
    );
  });
});
