import {
  ARTICLE_TAG,
  CARD_TAG,
  DATA_DIRECTORY,
  MS_PER_DAY,
  SNIPPET_TAG,
} from '#/lib/constants';
import { resolveItemContext } from '#/lib/item-context';
import { evictedSpot } from '#/lib/moved-note-scan';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { describeReclaim, recordRebind } from '#/lib/rebind-records';
import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import type {
  ArticleRow,
  IArticleBase,
  ISnippetBase,
  NoteType,
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
  SnippetRow,
  SQLiteRepository,
  SRSCardRow,
} from '#/lib/types';
import { getEndOfDay } from '#/lib/utils';
import { makeLinkVault } from '#/test/link-vault';
import { noteText } from '#/test/note-text';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App, TAbstractFile, TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { generatorParameters } from 'ts-fsrs';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CardManager } from './CardManager';
import ReviewManager from './ReviewManager';

// #region HELPERS

const YEAR_2000_MS = new Date('2000-01-01T12:00:00Z').getTime();
const YEAR_2100_MS = new Date('2100-01-01T12:00:00Z').getTime();

const FAKE_FILE = {
  path: 'incremental-reading/test.md',
  extension: 'md',
} as TFile;

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
    app: {
      metadataCache: {
        getFileCache: vi.fn(() => null),
        getFirstLinkpathDest: vi.fn(() => null),
      },
      ...appOverrides,
    },
    settings: { dayRolloverOffset: 4, fsrsParams: generatorParameters() },
    registerEvent: vi.fn(),
  } as never;
}

function makeArticleBase(overrides: Partial<IArticleBase> = {}): IArticleBase {
  return {
    id: 'article-1',
    type: 'article',
    reference: 'articles/test.md',
    due: Date.now(),
    due_fuzz: null,
    interval: 86_400_000,
    dismissed: false,
    deleted: false,
    priority: 30,
    fixed_interval_days: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeSnippetBase(overrides: Partial<ISnippetBase> = {}): ISnippetBase {
  return {
    id: 'snippet-1',
    type: 'snippet',
    reference: 'snippets/test.md',
    due: Date.now(),
    due_fuzz: null,
    interval: 86_400_000,
    dismissed: false,
    deleted: false,
    priority: 30,
    parent: null,
    start_offset: null,
    end_offset: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeArticleRow(overrides: Partial<ArticleRow> = {}): ArticleRow {
  const base = makeArticleBase();
  return {
    id: base.id,
    reference: base.reference,
    due: base.due,
    due_fuzz: base.due_fuzz,
    interval: base.interval,
    dismissed: 0,
    deleted: false,
    priority: base.priority,
    fixed_interval_days: base.fixed_interval_days,
    scroll_top: base.scroll_top,
    ...overrides,
  };
}

function makeSnippetRow(overrides: Partial<SnippetRow> = {}): SnippetRow {
  const base = makeSnippetBase();
  return {
    id: base.id,
    reference: base.reference,
    due: base.due,
    due_fuzz: base.due_fuzz,
    interval: base.interval,
    dismissed: 0,
    deleted: false,
    priority: base.priority,
    parent: base.parent,
    start_offset: base.start_offset,
    end_offset: base.end_offset,
    scroll_top: base.scroll_top,
    ...overrides,
  };
}

function makeCardRow(overrides: Partial<SRSCardRow> = {}): SRSCardRow {
  return {
    id: 'card-1',
    reference: 'cards/test.md',
    parent: null,
    due: Date.now() + 86_400_000,
    created_at: Date.now(),
    last_review: null,
    dismissed: 0,
    deleted: false,
    stability: 1,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    reps: 0,
    lapses: 0,
    state: 0,
    ...overrides,
  } as unknown as SRSCardRow;
}

function makeReviewArticleItem(due: number): ReviewArticle {
  return {
    data: makeArticleBase({ id: `article-${due}`, due }),
    file: FAKE_FILE,
  };
}

/** Build a ReviewItem from the given type for use in dismiss/undismiss tests */
function makeReviewItem(type: NoteType, id = 'item-1'): ReviewItem {
  if (type === 'article') {
    return {
      data: makeArticleBase({ id }),
      file: {
        ...FAKE_FILE,
        path: `${DATA_DIRECTORY}/articles/${id}.md`,
      } as TFile,
    } satisfies ReviewArticle;
  } else if (type === 'snippet') {
    return {
      data: makeSnippetBase({ id }),
      file: {
        ...FAKE_FILE,
        path: `${DATA_DIRECTORY}/snippets/${id}.md`,
      } as TFile,
    } satisfies ReviewSnippet;
  } else {
    return {
      data: CardManager.rowToDisplay(makeCardRow({ id })),
      file: { ...FAKE_FILE, path: `${DATA_DIRECTORY}/cards/${id}.md` } as TFile,
    } satisfies ReviewCard;
  }
}

function makeReviewArticle(due: number): ReviewArticle {
  return {
    data: {
      id: `article-${due}`,
      type: 'article',
      reference: 'articles/test.md',
      due,
      due_fuzz: null,
      interval: 86_400_000,
      dismissed: false,
      deleted: false,
      priority: 30,
      fixed_interval_days: null,
      scroll_top: 0,
    },
    file: FAKE_FILE,
  };
}

function makeReviewSnippet(due: number): ReviewSnippet {
  return {
    data: {
      id: `snippet-${due}`,
      type: 'snippet',
      reference: 'snippets/test.md',
      due,
      due_fuzz: null,
      interval: 86_400_000,
      dismissed: false,
      deleted: false,
      priority: 30,
      parent: null,
      start_offset: null,
      end_offset: null,
      scroll_top: 0,
    },
    file: FAKE_FILE,
  };
}

function makeReviewCard(due: number): ReviewCard {
  return {
    data: {
      id: `card-${due}`,
      type: 'card',
      reference: 'cards/test.md',
      due: new Date(due),
      created_at: new Date(due - 86_400_000),
      last_review: undefined,
      dismissed: false,
      deleted: false,
      parent: null,
      stability: 1,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: 'New',
    },
    file: FAKE_FILE,
  };
}

/**
 * Wire a manager whose queue holds one article per given due timestamp, with
 * every reference resolving to a fake TFile.
 */
function wireDueAt(dueTimes: number[]) {
  const repo = makeRepo();
  vi.mocked(repo.query).mockResolvedValue([] as never);
  const manager = new ReviewManager(makePlugin(), repo);
  const articles = dueTimes.map((due, i) =>
    makeArticleRow({
      // padded so lexicographic id order matches numeric order on ties
      id: `a${String(i).padStart(4, '0')}`,
      reference: `articles/a${i}.md`,
      due,
      due_fuzz: null,
    })
  );
  vi.spyOn(manager.articles, 'fetchMany').mockResolvedValue(articles as never);
  vi.spyOn(manager.snippets, 'fetchMany').mockResolvedValue([] as never);
  vi.spyOn(manager.cards, 'fetchMany').mockResolvedValue([] as never);
  vi.spyOn(Obsidian, 'getNote').mockImplementation(
    (reference: string) => ({ path: reference, extension: 'md' }) as TFile
  );
  return manager;
}

/**
 * Start of `date`'s review day under the rollover offset `makePlugin` sets:
 * the end of the review day before it.
 */
function startOfDay(date: Date) {
  const yesterday = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - 1
  );
  return getEndOfDay(4, yesterday);
}

/**
 * A file with no frontmatter: `pdf` in every casing, or any other extension
 * that isn't some casing of `md`, the empty one included.
 */
const binaryFileArb = fc
  .tuple(
    fc.string(),
    fc.oneof(
      fc.mixedCase(fc.constant('pdf')),
      fc.string().filter((ext) => ext.toLowerCase() !== 'md')
    )
  )
  .map(
    ([name, extension]) =>
      ({ path: `${name}.${extension}`, extension }) as TFile
  );

type ItemTable = 'article' | 'snippet' | 'srs_card';

const ROW_BY_TABLE: Record<
  ItemTable,
  (reference: string) => ArticleRow | SnippetRow | SRSCardRow
> = {
  article: (reference) => makeArticleRow({ reference }),
  snippet: (reference) => makeSnippetRow({ reference }),
  srs_card: (reference) => makeCardRow({ reference }),
};

/**
 * A manager over a vault holding only `file`, whose database holds `table`'s
 * row at `file`'s path (or no row at all), with every call that could read or
 * write the file's content or frontmatter spied on.
 */
function wireBinary(file: TFile, table: ItemTable | null) {
  const row = table && { ...ROW_BY_TABLE[table](file.path), table };
  const touches = {
    processFrontMatter: vi.fn().mockResolvedValue(undefined),
    process: vi.fn().mockResolvedValue(''),
    modify: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(''),
    cachedRead: vi.fn().mockResolvedValue(''),
  };
  const { processFrontMatter, ...vaultTouches } = touches;
  const app = {
    vault: {
      ...vaultTouches,
      getFileByPath: vi.fn((path: string) =>
        path === file.path ? file : null
      ),
    },
    fileManager: { processFrontMatter },
    metadataCache: {
      getFileCache: vi.fn(() => ({})),
      getFirstLinkpathDest: vi.fn(() => null),
    },
  };
  const repo = {
    ...makeRepo(),
    // Answers a lookup of `table` by the row's own id or reference
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (!row) return [];
      const [, from, column] =
        /FROM (\w+) WHERE (reference|id) = \$1/.exec(sql) ?? [];
      const key = column === 'id' ? row.id : row.reference;
      return from === row.table && params?.[0] === key ? [row] : [];
    }),
  } as unknown as SQLiteRepository;
  const plugin = makePlugin(app);
  (plugin as { settings: Record<string, unknown> }).settings.fuzzTextReviews =
    false;
  const manager = new ReviewManager(plugin, repo);
  return { manager, app, row, touches, repo };
}

const tableArb = fc.constantFrom<ItemTable>('article', 'snippet', 'srs_card');
const itemTableArb = fc.option(tableArb, { nil: null });

/** The tag that makes a note an item of each table's type. */
const TABLE_TAG = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  srs_card: CARD_TAG,
} as const;

const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
let SQL: SqlJsStatic;

/** A repository over a real in-memory database, with the disk write stubbed. */
class TestRepository extends SQLJSRepository {
  static create(): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    repo.registerUpdateHook();
    return repo;
  }

  protected override async save() {}

  /** Every row of `table`, read straight off the database. */
  rows(table: 'article' | 'snippet' | 'srs_card') {
    const [result] = this.db?.exec(
      `SELECT id, reference, deleted FROM ${table} ORDER BY id`
    ) ?? [undefined];
    return (result?.values ?? []).map(([id, reference, deleted]) => ({
      id: String(id),
      reference: String(reference),
      deleted: deleted === 1,
    }));
  }
}

/**
 * A manager over a real database and a vault of files that have no
 * frontmatter, which the test moves around itself before firing the event
 * Obsidian would. Every call that could read or write a file's content or
 * frontmatter is spied on.
 */
function wirePaths(paths: readonly string[]) {
  const repo = TestRepository.create();
  const files = new Map<string, TFile>();
  const extensionOf = (path: string) => path.slice(path.lastIndexOf('.') + 1);
  const fileAt = (path: string) => {
    const file = { path, extension: extensionOf(path) } as TFile;
    files.set(path, file);
    return file;
  };
  for (const path of paths) fileAt(path);
  const touches = {
    processFrontMatter: vi.fn().mockResolvedValue(undefined),
    process: vi.fn().mockResolvedValue(''),
    modify: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(''),
    cachedRead: vi.fn().mockResolvedValue(''),
  };
  const { processFrontMatter, ...vaultTouches } = touches;
  const plugin = makePlugin({
    vault: {
      ...vaultTouches,
      getFileByPath: (path: string) => files.get(path) ?? null,
    },
    fileManager: { processFrontMatter },
  });
  const manager = new ReviewManager(plugin, repo);

  const insertArticle = (id: string, reference: string, deleted = false) =>
    repo.mutate(
      `INSERT INTO article (id, reference, deleted, due, interval, priority)
       VALUES ($1, $2, $3, $4, 86400000, 30)`,
      [id, reference, deleted, YEAR_2000_MS]
    );
  const insertChildren = (parent: string) => {
    repo.mutate(
      `INSERT INTO snippet (id, reference, parent, due, interval, priority)
       VALUES ($1, $2, $3, $4, 86400000, 30)`,
      [`snippet-of-${parent}`, `snippets/${parent}.md`, parent, YEAR_2000_MS]
    );
    repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, created_at, due, stability,
         difficulty, elapsed_days, scheduled_days, state)
       VALUES ($1, $2, $3, $4, $4, 0, 0, 0, 0, 0)`,
      [`card-of-${parent}`, `cards/${parent}.md`, parent, YEAR_2000_MS]
    );
  };

  /** Move the file at `from` to `to`, as Obsidian does before it fires `rename`. */
  const rename = (from: string, to: string) => {
    const file = files.get(from)!;
    files.delete(from);
    // Obsidian re-derives the extension, which a rename can change too
    file.path = to;
    file.extension = extensionOf(to);
    files.set(to, file);
    return manager.handleExternalRename(file, from);
  };
  const remove = (path: string) => {
    const file = files.get(path)!;
    files.delete(path);
    return manager.handleDeletion(file);
  };
  const create = (path: string) => manager.handleCreation(fileAt(path));

  return {
    repo,
    manager,
    files,
    touches,
    insertArticle,
    insertChildren,
    rename,
    remove,
    create,
  };
}

/** An item's note: its id, its type's tag, and its `source`, if any. */
const note = (id: string, tag: string, source?: string) => ({
  'ir-id': id,
  tags: [tag],
  ...(source === undefined ? {} : { source }),
});

/**
 * A manager over a real database and a vault whose links resolve (see
 * `makeLinkVault`), with Obsidian's link-update queue: `hold` puts a rename's
 * link update in it that waits until released, as one does on Obsidian's prompt.
 */
function wireRenames(notes: Record<string, Record<string, unknown> | null>) {
  const vault = makeLinkVault(notes);
  let tail: Promise<unknown> = Promise.resolve();
  const updateQueue = {
    queue: vi.fn((job: () => Promise<unknown>) => (tail = tail.then(job, job))),
  };
  Object.assign(vault.app.fileManager, { updateQueue });
  const repo = TestRepository.create();
  const manager = new ReviewManager(makePlugin(vault.app), repo);

  const hold = () => {
    let release!: () => void;
    void updateQueue.queue(() => new Promise<void>((done) => (release = done)));
    return () => release();
  };
  /** Settles once every job queued so far has, the ones they queue too. */
  const drained = async () => {
    let seen: Promise<unknown>;
    do {
      seen = tail;
      await seen;
      await new Promise((done) => setTimeout(done, 0));
    } while (seen !== tail);
  };
  const rename = (from: string, to: string) =>
    manager.handleExternalRename(vault.move(from, to), from);
  const insert = (
    table: 'article' | 'snippet' | 'srs_card',
    id: string,
    reference: string,
    parent: string | null = null
  ) => {
    if (table === 'article') {
      repo.mutate(
        `INSERT INTO article (id, reference, due, interval, priority)
         VALUES ($1, $2, $3, 86400000, 30)`,
        [id, reference, YEAR_2000_MS]
      );
    } else if (table === 'snippet') {
      repo.mutate(
        `INSERT INTO snippet (id, reference, parent, due, interval, priority)
         VALUES ($1, $2, $3, $4, 86400000, 30)`,
        [id, reference, parent, YEAR_2000_MS]
      );
    } else {
      repo.mutate(
        `INSERT INTO srs_card (id, reference, parent, created_at, due,
           stability, difficulty, elapsed_days, scheduled_days, state)
         VALUES ($1, $2, $3, $4, $4, 0, 0, 0, 0, 0)`,
        [id, reference, parent, YEAR_2000_MS]
      );
    }
  };
  return {
    ...vault,
    repo,
    manager,
    updateQueue,
    hold,
    drained,
    rename,
    insert,
  };
}

/** Where each child's parent is, read through the parent id it holds. */
const parentPaths = (repo: TestRepository) =>
  ['snippet', 'srs_card'].flatMap((table) => {
    const [result] = repo.db!.exec(
      `SELECT child.id, article.reference FROM ${table} child
       JOIN article ON article.id = child.parent ORDER BY child.id`
    );
    return (result?.values ?? []).map(([id, reference]) => [id, reference]);
  });

/** A vault adapter for a log to be written through, finding nothing there yet. */
const makeLogAdapter = () => ({
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => {}),
  write: vi.fn(async () => {}),
  append: vi.fn(async () => {}),
});

/** One row of each item table, all under id `x`, for lookups by id. */
const ITEM_ROW_KINDS = [
  { table: 'article', type: 'article', reference: 'articles/x.md' },
  { table: 'snippet', type: 'snippet', reference: 'snippets/x.md' },
  { table: 'srs_card', type: 'card', reference: 'cards/x.md' },
] as const;

/** Insert the `kind` row `x`, live or a tombstone. */
function insertItemRow(
  repo: SQLJSRepository,
  kind: { table: (typeof ITEM_ROW_KINDS)[number]['table']; reference: string },
  deleted: boolean
) {
  if (kind.table === 'srs_card') {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, deleted, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state)
       VALUES ('x', $1, $2, $3, $3, 0, 0, 0, 0, 0)`,
      [kind.reference, deleted, YEAR_2000_MS]
    );
    return;
  }
  repo.mutate(
    `INSERT INTO ${kind.table} (id, reference, deleted, due, interval, priority)
     VALUES ('x', $1, $2, $3, 86400000, 30)`,
    [kind.reference, deleted, YEAR_2000_MS]
  );
}

/**
 * A manager over `notes` and a real database holding one live row (or, when
 * `deleted`, a tombstone) of `table`, with id `x`, naming `reference`.
 */
function wireItem(
  table: 'article' | 'snippet' | 'srs_card',
  reference: string,
  notes: Record<string, Record<string, unknown> | null>,
  deleted = false
) {
  const vault = makeLinkVault(notes);
  const repo = TestRepository.create();
  insertItemRow(
    repo,
    { ...ITEM_ROW_KINDS.find((kind) => kind.table === table)!, reference },
    deleted
  );
  const manager = new ReviewManager(makePlugin(vault.app), repo);
  return { ...vault, repo, manager };
}

/** A name for a file or folder: any text but a slash. */
const segmentArb = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 6 })
  .filter((name) => !name.includes('/'));

/**
 * A path of a name or a few, some of them names that sort next to `a` and
 * `a/`, as a folder's range of paths must tell apart.
 */
const pathArb = fc
  .array(fc.oneof(segmentArb, fc.constantFrom('a', 'a0', 'a.', 'b')), {
    minLength: 1,
    maxLength: 3,
  })
  .map((segments) => segments.join('/'));

// #endregion

describe('ReviewManager.getDue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns only items that are due and belong to the specified typesToInclude', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a "current time" between year 2000 and 2100 at day granularity.
        // Using day offsets (not milliseconds) shrinks the search space from ~3 trillion
        // to ~36 500 values, keeping shrinking fast without losing meaningful coverage.
        fc
          .integer({
            min: 0,
            max: Math.floor((YEAR_2100_MS - YEAR_2000_MS) / MS_PER_DAY),
          })
          .map((days) => YEAR_2000_MS + days * MS_PER_DAY),
        // Generate a non-empty subset of note types to include
        fc.subarray(['article', 'snippet', 'card'] as const, { minLength: 1 }),
        async (nowMs, includedTypes) => {
          vi.setSystemTime(nowMs);

          const typesToInclude = Object.fromEntries(
            includedTypes.map((t) => [t, true as const])
          ) as Partial<Record<NoteType, true>>;

          // For each type: one item due at nowMs (due), one item due after nowMs (not due)
          const dueArticle = makeReviewArticle(nowMs);
          const notDueArticle = makeReviewArticle(nowMs + MS_PER_DAY);
          const dueSnippet = makeReviewSnippet(nowMs);
          const notDueSnippet = makeReviewSnippet(nowMs + MS_PER_DAY);
          const dueCard = makeReviewCard(nowMs);
          const notDueCard = makeReviewCard(nowMs + MS_PER_DAY);

          const repo = makeRepo();
          const plugin = makePlugin();
          const manager = new ReviewManager(plugin, repo);

          // Direct assignment avoids registering Vitest spies on every iteration
          // (50 000 spies × 3 sub-managers would exhaust heap before afterEach fires).
          // We don't assert call counts here, so a tracked spy isn't needed.
          manager.articles.getDue = async (dueBy) => {
            const cutoff = dueBy ?? nowMs;
            return [dueArticle, notDueArticle].filter(
              (r) => r.data.due !== null && r.data.due <= cutoff
            );
          };
          manager.snippets.getDue = async (dueBy) => {
            const cutoff = dueBy ?? nowMs;
            return [dueSnippet, notDueSnippet].filter(
              (r) => r.data.due !== null && r.data.due <= cutoff
            );
          };
          manager.cards.getDue = async (dueBy) => {
            const cutoff = dueBy ?? nowMs;
            return [dueCard, notDueCard].filter(
              (r) => r.data.due.getTime() <= cutoff
            );
          };

          const result = await manager.getDue({ typesToInclude });

          // Only included types should appear in the results
          const allIds = result.all.map((r) => r.data.id);

          for (const type of ['article', 'snippet', 'card'] as const) {
            const dueItem =
              type === 'article'
                ? dueArticle
                : type === 'snippet'
                  ? dueSnippet
                  : dueCard;
            const notDueItem =
              type === 'article'
                ? notDueArticle
                : type === 'snippet'
                  ? notDueSnippet
                  : notDueCard;

            if (type in typesToInclude) {
              expect(allIds, `due ${type} should be included`).toContain(
                dueItem.data.id
              );
              expect(
                allIds,
                `not-due ${type} should be excluded`
              ).not.toContain(notDueItem.data.id);
            } else {
              expect(
                allIds,
                `${type} not in typesToInclude should be absent`
              ).not.toContain(dueItem.data.id);
              expect(
                allIds,
                `${type} not in typesToInclude should be absent`
              ).not.toContain(notDueItem.data.id);
            }
          }

          // Typed sub-arrays should match the same filtering
          if ('article' in typesToInclude) {
            expect(result.articles.map((r) => r.data.id)).toContain(
              dueArticle.data.id
            );
            expect(result.articles.map((r) => r.data.id)).not.toContain(
              notDueArticle.data.id
            );
          } else {
            expect(result.articles).toHaveLength(0);
          }

          if ('snippet' in typesToInclude) {
            expect(result.snippets.map((r) => r.data.id)).toContain(
              dueSnippet.data.id
            );
            expect(result.snippets.map((r) => r.data.id)).not.toContain(
              notDueSnippet.data.id
            );
          } else {
            expect(result.snippets).toHaveLength(0);
          }

          if ('card' in typesToInclude) {
            expect(result.cards.map((r) => r.data.id)).toContain(
              dueCard.data.id
            );
            expect(result.cards.map((r) => r.data.id)).not.toContain(
              notDueCard.data.id
            );
          } else {
            expect(result.cards).toHaveLength(0);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getQueue — maps rows to a unified QueueRow[] format for display in review queue table
// ---------------------------------------------------------------------------

describe('ReviewManager.getQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Wire a manager so each sub-manager's `fetchMany` returns the given rows and
   * every reference resolves to a distinct fake TFile. Returns the manager.
   */
  function wireQueue(rows: {
    articles?: ArticleRow[];
    snippets?: SnippetRow[];
    cards?: SRSCardRow[];
    /** id → reference pairs the parent-path lookup query resolves. */
    parents?: { id: string; reference: string }[];
  }) {
    const repo = makeRepo();
    // The only raw query getQueue issues is the parent id → path lookup.
    vi.mocked(repo.query).mockResolvedValue((rows.parents ?? []) as never);
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(manager.articles, 'fetchMany').mockResolvedValue(
      (rows.articles ?? []) as never
    );
    vi.spyOn(manager.snippets, 'fetchMany').mockResolvedValue(
      (rows.snippets ?? []) as never
    );
    vi.spyOn(manager.cards, 'fetchMany').mockResolvedValue(
      (rows.cards ?? []) as never
    );
    // Every reference resolves to a file whose path is the reference itself.
    vi.spyOn(Obsidian, 'getNote').mockImplementation(
      (reference: string) => ({ path: reference, extension: 'md' }) as TFile
    );
    return manager;
  }

  it('maps a due article to a QueueRow with id, type, reference, due, and file', async () => {
    const row = makeArticleRow({
      id: 'a1',
      reference: 'articles/a1.md',
      due: YEAR_2000_MS,
      due_fuzz: null,
    });
    const manager = wireQueue({ articles: [row] });

    const { rows: queue } = await manager.getQueue();

    expect(queue).toHaveLength(1);
    const [item] = queue;
    expect(item.id).toBe('a1');
    expect(item.type).toBe('article');
    expect(item.reference).toBe('articles/a1.md');
    expect(item.due).toEqual(new Date(YEAR_2000_MS));
    expect(item.file?.path).toBe('articles/a1.md');
  });

  it('omits redacted fields (due_fuzz, scroll_top, offsets, dismissed, deleted) from every QueueRow', async () => {
    const manager = wireQueue({
      articles: [makeArticleRow({ id: 'a1', reference: 'articles/a1.md' })],
      snippets: [
        makeSnippetRow({
          id: 's1',
          reference: 'snippets/s1.md',
          start_offset: 5,
          end_offset: 9,
        }),
      ],
      cards: [makeCardRow({ id: 'c1', reference: 'cards/c1.md' })],
    });

    const { rows: queue } = await manager.getQueue();

    const forbidden = [
      'due_fuzz',
      'scroll_top',
      'start_offset',
      'end_offset',
      'dismissed',
      'deleted',
    ];
    expect(queue).toHaveLength(3);
    for (const item of queue) {
      for (const key of forbidden) {
        expect(item).not.toHaveProperty(key);
      }
    }
  });

  it('applies due_fuzz to the due date for text items', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: YEAR_2000_MS, max: YEAR_2100_MS }),
        fc.integer({ min: -MS_PER_DAY, max: MS_PER_DAY }),
        async (due, fuzz) => {
          vi.restoreAllMocks();
          const manager = wireQueue({
            articles: [
              makeArticleRow({
                id: 'a1',
                reference: 'articles/a1.md',
                due,
                due_fuzz: fuzz,
              }),
            ],
          });
          const {
            rows: [item],
          } = await manager.getQueue();
          expect(item.due?.getTime()).toBe(due + fuzz);
        }
      )
    );
  });

  it('treats a null due_fuzz as zero fuzz', async () => {
    const manager = wireQueue({
      articles: [
        makeArticleRow({
          id: 'a1',
          reference: 'articles/a1.md',
          due: YEAR_2000_MS,
          due_fuzz: null,
        }),
      ],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.due?.getTime()).toBe(YEAR_2000_MS);
  });

  it('maps a null due to null (not the epoch) for articles and snippets', async () => {
    const manager = wireQueue({
      articles: [
        makeArticleRow({
          id: 'a1',
          reference: 'articles/a1.md',
          due: null,
          due_fuzz: 500,
        }),
      ],
      snippets: [
        makeSnippetRow({
          id: 's1',
          reference: 'snippets/s1.md',
          due: null,
          due_fuzz: null,
        }),
      ],
    });
    const { rows: queue } = await manager.getQueue();
    expect(queue).toHaveLength(2);
    for (const item of queue) {
      expect(item.due).toBeNull();
    }
  });

  it('resolves a snippet and card parent id to the parent note path', async () => {
    const manager = wireQueue({
      snippets: [
        makeSnippetRow({
          id: 's1',
          reference: 'snippets/s1.md',
          parent: 'a1',
        }),
      ],
      cards: [
        makeCardRow({ id: 'c1', reference: 'cards/c1.md', parent: 's1' }),
      ],
      parents: [
        { id: 'a1', reference: 'articles/a1.md' },
        { id: 's1', reference: 'snippets/s1.md' },
      ],
    });

    const { rows: queue } = await manager.getQueue();
    const byId = new Map(queue.map((row) => [row.id, row]));
    expect(byId.get('s1')?.parent).toBe('articles/a1.md');
    expect(byId.get('c1')?.parent).toBe('snippets/s1.md');
  });

  it("resolves an article's source frontmatter link to the note it was imported from", async () => {
    const manager = wireQueue({
      articles: [makeArticleRow({ id: 'a1', reference: 'articles/a1.md' })],
    });
    vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
      source: '[[Original Note]]',
    } as never);
    vi.spyOn(manager.app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(
      { path: 'notes/Original Note.md' } as TFile
    );

    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.parent).toBe('notes/Original Note.md');
  });

  it('falls back to the raw source text when its link resolves to no note', async () => {
    const manager = wireQueue({
      articles: [makeArticleRow({ id: 'a1', reference: 'articles/a1.md' })],
    });
    vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
      source: 'https://example.com/article',
    } as never);
    vi.spyOn(manager.app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(
      null
    );

    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.parent).toBe('https://example.com/article');
  });

  it('gives an article with no source frontmatter no source at all', async () => {
    const manager = wireQueue({
      articles: [makeArticleRow({ id: 'a1', reference: 'articles/a1.md' })],
    });
    vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue(undefined);

    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.parent).toBeNull();
  });

  it('maps a parent id with no surviving parent row to null, not the raw id', async () => {
    const manager = wireQueue({
      snippets: [
        makeSnippetRow({
          id: 's1',
          reference: 'snippets/s1.md',
          parent: 'gone',
        }),
      ],
      parents: [],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.parent).toBeNull();
  });

  it('carries a card difficulty and stability into its scheduling cell', async () => {
    const manager = wireQueue({
      cards: [
        makeCardRow({
          id: 'c1',
          reference: 'cards/c1.md',
          difficulty: 6.5,
          stability: 12.25,
        }),
      ],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.scheduling.kind).toBe('srs');
    expect(item.scheduling.value).toMatchObject({
      difficulty: 6.5,
      stability: 12.25,
    });
  });

  it('gives a never-reviewed card a null retrievability rather than a made-up one', async () => {
    const manager = wireQueue({
      cards: [
        makeCardRow({ id: 'c1', reference: 'cards/c1.md', last_review: null }),
      ],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.scheduling.value).toMatchObject({ retrievability: null });
  });

  it('derives a retrievability in [0, 1] for a reviewed card', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.1, max: 365, noNaN: true }),
        fc.integer({ min: 0, max: 365 }),
        async (stability, elapsedDays) => {
          vi.restoreAllMocks();
          const now = Date.now();
          const manager = wireQueue({
            cards: [
              makeCardRow({
                id: 'c1',
                reference: 'cards/c1.md',
                stability,
                last_review: now - elapsedDays * MS_PER_DAY,
                elapsed_days: elapsedDays,
                state: 2,
              }),
            ],
          });
          const {
            rows: [item],
          } = await manager.getQueue();
          const { retrievability } = item.scheduling.value as {
            retrievability: number | null;
          };
          expect(retrievability).not.toBeNull();
          expect(retrievability).toBeGreaterThanOrEqual(0);
          expect(retrievability).toBeLessThanOrEqual(1);
        }
      )
    );
  });

  it('sorts rows with no due time after every dated row', async () => {
    const manager = wireQueue({
      articles: [
        makeArticleRow({
          id: 'undated',
          reference: 'articles/undated.md',
          due: null,
        }),
        makeArticleRow({ id: 'dated', reference: 'articles/dated.md', due: 1 }),
      ],
    });
    const { rows: queue } = await manager.getQueue();
    expect(queue.map((r) => r.id)).toEqual(['dated', 'undated']);
  });

  it('does not fuzz card due dates (cards have no fuzz)', async () => {
    const manager = wireQueue({
      cards: [
        makeCardRow({ id: 'c1', reference: 'cards/c1.md', due: YEAR_2000_MS }),
      ],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.due?.getTime()).toBe(YEAR_2000_MS);
    expect(item.scheduling.kind).toBe('srs');
  });

  it('shows an article its fixed interval when set, never its priority', async () => {
    const manager = wireQueue({
      articles: [
        makeArticleRow({
          id: 'a1',
          reference: 'articles/a1.md',
          fixed_interval_days: 7,
          priority: 30,
        }),
      ],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.scheduling).toEqual({ kind: 'fixed-interval', value: '7' });
  });

  it('shows an article its priority when it has no fixed interval', async () => {
    const manager = wireQueue({
      articles: [
        makeArticleRow({
          id: 'a1',
          reference: 'articles/a1.md',
          fixed_interval_days: null,
          priority: 42,
        }),
      ],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.scheduling).toEqual({ kind: 'priority', value: '4.2' });
  });

  it('schedules snippets by priority', async () => {
    const manager = wireQueue({
      snippets: [
        makeSnippetRow({ id: 's1', reference: 'snippets/s1.md', priority: 15 }),
      ],
    });
    const {
      rows: [item],
    } = await manager.getQueue();
    expect(item.scheduling).toEqual({ kind: 'priority', value: '1.5' });
  });

  it('sorts the whole queue by fuzzed due ascending across all types', async () => {
    // article fuzzes from 3000 down to 1500 (earliest), card sits at 2000,
    // snippet at 3000 — so fuzzed order is article, card, snippet.
    const manager = wireQueue({
      articles: [
        makeArticleRow({
          id: 'a',
          reference: 'articles/a.md',
          due: 3000,
          due_fuzz: -1500,
        }),
      ],
      cards: [makeCardRow({ id: 'c', reference: 'cards/c.md', due: 2000 })],
      snippets: [
        makeSnippetRow({
          id: 's',
          reference: 'snippets/s.md',
          due: 3000,
          due_fuzz: 0,
        }),
      ],
    });
    const { rows: queue } = await manager.getQueue();
    expect(queue.map((r) => r.id)).toEqual(['a', 'c', 's']);
  });

  it('returns an empty page when nothing is due', async () => {
    const manager = wireQueue({});
    const page = await manager.getQueue();
    expect(page).toEqual({
      rows: [],
      totalRows: 0,
      firstDue: null,
      lastDue: null,
    });
  });

  it('keeps items whose note cannot be resolved, as missing rows with no file', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(manager.articles, 'fetchMany').mockResolvedValue([
      makeArticleRow({ id: 'gone', reference: 'articles/gone.md', due: 1 }),
      makeArticleRow({ id: 'here', reference: 'articles/here.md', due: 2 }),
    ] as never);
    vi.spyOn(manager.snippets, 'fetchMany').mockResolvedValue([
      makeSnippetRow({ id: 'gone-s', reference: 'snippets/gone.md', due: 3 }),
    ] as never);
    vi.spyOn(manager.cards, 'fetchMany').mockResolvedValue([
      makeCardRow({ id: 'gone-c', reference: 'cards/gone.md', due: 4 }),
    ] as never);
    vi.spyOn(Obsidian, 'getNote').mockImplementation((reference: string) =>
      reference === 'articles/here.md'
        ? ({ path: reference, extension: 'md' } as TFile)
        : null
    );
    const { rows: queue } = await manager.getQueue();
    expect(queue.map((r) => [r.id, r.file?.path ?? null])).toEqual([
      ['gone', null],
      ['here', 'articles/here.md'],
      ['gone-s', null],
      ['gone-c', null],
    ]);
    // A missing article has no note to read its source off
    expect(queue[0].parent).toBeNull();
  });

  it('uses the end of the given day when a date is supplied', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const articleFetch = vi
      .spyOn(manager.articles, 'fetchMany')
      .mockResolvedValue([] as never);
    vi.spyOn(manager.snippets, 'fetchMany').mockResolvedValue([] as never);
    vi.spyOn(manager.cards, 'fetchMany').mockResolvedValue([] as never);
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const date = new Date(YEAR_2000_MS);
    await manager.getQueue({ date });
    expect(articleFetch).toHaveBeenCalledWith({ dueBy: date.getTime() });
  });

  describe('pagination', () => {
    /** n articles with ids i0..i(n-1), due ascending in id order. */
    function makeDueArticles(n: number) {
      return Array.from({ length: n }, (_, i) =>
        makeArticleRow({
          id: `i${i}`,
          reference: `articles/i${i}.md`,
          due: 1000 * (i + 1),
          due_fuzz: null,
        })
      );
    }

    it('returns the requested page as a contiguous slice of the sorted queue', async () => {
      const manager = wireQueue({ articles: makeDueArticles(5) });

      const page = await manager.getQueue({
        slice: { pageNumber: 1, entriesPerPage: 2 },
      });

      expect(page.rows.map((r) => r.id)).toEqual(['i2', 'i3']);
    });

    it('reports the whole subset size as totalRows, not the page size', async () => {
      const manager = wireQueue({ articles: makeDueArticles(5) });

      const page = await manager.getQueue({
        slice: { pageNumber: 1, entriesPerPage: 2 },
      });

      expect(page.totalRows).toBe(5);
    });

    it('clamps a too-high pageNumber to the last page, which may be partial', async () => {
      // 5 rows / 2 per page → last page holds only i4, not the last 2 rows.
      const manager = wireQueue({ articles: makeDueArticles(5) });

      const page = await manager.getQueue({
        slice: { pageNumber: 99, entriesPerPage: 2 },
      });

      expect(page.rows.map((r) => r.id)).toEqual(['i4']);
    });

    it('orders due-ties the same way regardless of DB fetch order', async () => {
      // Same data, permuted fetch order — pages must not shuffle between calls.
      const tied = (ids: string[]) =>
        ids.map((id) =>
          makeArticleRow({
            id,
            reference: `articles/${id}.md`,
            due: 1000,
            due_fuzz: null,
          })
        );
      const slice = { pageNumber: 0, entriesPerPage: 2 };

      const first = await wireQueue({
        articles: tied(['b', 'a', 'c']),
      }).getQueue({ slice });
      vi.restoreAllMocks();
      const second = await wireQueue({
        articles: tied(['c', 'b', 'a']),
      }).getQueue({ slice });

      expect(first.rows.map((r) => r.id)).toEqual(second.rows.map((r) => r.id));
    });

    it('pages partition the queue: contiguous, full-sized except the last, covering every row once', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 30 }),
          fc.integer({ min: 1, max: 7 }),
          // Small due domain to force plenty of ties.
          fc.array(fc.integer({ min: 1, max: 5 }), {
            minLength: 30,
            maxLength: 30,
          }),
          async (count, entriesPerPage, dues) => {
            vi.restoreAllMocks();
            const articles = Array.from({ length: count }, (_, i) =>
              makeArticleRow({
                id: `i${i}`,
                reference: `articles/i${i}.md`,
                due: dues[i] * 1000,
                due_fuzz: null,
              })
            );
            const manager = wireQueue({ articles });

            const whole = await manager.getQueue();
            const pageCount = Math.max(1, Math.ceil(count / entriesPerPage));
            const pages = [];
            for (let p = 0; p < pageCount; p += 1) {
              pages.push(
                await manager.getQueue({
                  slice: { pageNumber: p, entriesPerPage },
                })
              );
            }

            // Every page but the last is exactly entriesPerPage long, and
            // each one reports the whole subset size.
            for (const page of pages.slice(0, -1)) {
              expect(page.rows).toHaveLength(entriesPerPage);
            }
            for (const page of pages) {
              expect(page.totalRows).toBe(count);
            }
            // Concatenated pages reproduce the whole queue, in order.
            expect(pages.flatMap((page) => page.rows).map((r) => r.id)).toEqual(
              whole.rows.map((r) => r.id)
            );
          }
        )
      );
    });

    it('returns an empty page when nothing is due', async () => {
      const manager = wireQueue({});
      const page = await manager.getQueue({
        slice: { pageNumber: 3, entriesPerPage: 10 },
      });
      expect(page).toEqual({
        rows: [],
        totalRows: 0,
        firstDue: null,
        lastDue: null,
      });
    });

    it('reports the whole queue span on every page, not the page span', async () => {
      // The bounds exist so the date field can offer the queue's whole extent
      // while holding only one page. A page-local span would shrink the field's
      // reachable range to whatever happened to be on screen.
      const manager = wireQueue({ articles: makeDueArticles(5) });

      const whole = await manager.getQueue();
      const pages = await Promise.all(
        [0, 1, 2].map((pageNumber) =>
          manager.getQueue({ slice: { pageNumber, entriesPerPage: 2 } })
        )
      );

      const first = whole.rows[0].due?.getTime();
      const last = whole.rows[whole.rows.length - 1].due?.getTime();
      for (const page of pages) {
        expect(page.firstDue?.getTime()).toBe(first);
        expect(page.lastDue?.getTime()).toBe(last);
      }
    });
  });

  describe('span', () => {
    it('spans from the earliest to the latest fuzzed due time', async () => {
      // Read off the sorted queue, so the span is in fuzz order like the rows.
      const manager = wireQueue({
        articles: [
          makeArticleRow({
            id: 'a',
            reference: 'articles/a.md',
            due: 3000,
            due_fuzz: -1500,
          }),
        ],
        cards: [makeCardRow({ id: 'c', reference: 'cards/c.md', due: 2000 })],
        snippets: [
          makeSnippetRow({
            id: 's',
            reference: 'snippets/s.md',
            due: 5000,
            due_fuzz: 0,
          }),
        ],
      });

      const page = await manager.getQueue();

      expect(page.firstDue?.getTime()).toBe(1500);
      expect(page.lastDue?.getTime()).toBe(5000);
    });

    it('collapses the span to a single instant for a one-item queue', async () => {
      const manager = wireQueue({
        cards: [
          makeCardRow({
            id: 'c1',
            reference: 'cards/c1.md',
            due: YEAR_2000_MS,
          }),
        ],
      });

      const page = await manager.getQueue();

      expect(page.firstDue?.getTime()).toBe(YEAR_2000_MS);
      expect(page.lastDue?.getTime()).toBe(YEAR_2000_MS);
    });

    it('closes the span at the last dated row, ignoring undated ones', async () => {
      // Undated rows sort last and carry no day, so they cannot bound the
      // span — taking the final row outright would report a null max and
      // leave the date field unbounded.
      const manager = wireQueue({
        articles: [
          makeArticleRow({
            id: 'undated',
            reference: 'articles/undated.md',
            due: null,
          }),
          makeArticleRow({
            id: 'dated',
            reference: 'articles/dated.md',
            due: 4000,
            due_fuzz: 0,
          }),
        ],
      });

      const page = await manager.getQueue();

      expect(page.rows.map((r) => r.id)).toEqual(['dated', 'undated']);
      expect(page.lastDue?.getTime()).toBe(4000);
    });

    it('has no span when every row is undated', async () => {
      const manager = wireQueue({
        articles: [
          makeArticleRow({
            id: 'u1',
            reference: 'articles/u1.md',
            due: null,
          }),
        ],
      });

      const page = await manager.getQueue();

      expect(page.firstDue).toBeNull();
      expect(page.lastDue).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// findPageForDate — maps a date to the page holding the first item due on or
// after the start of that day, under the same ordering getQueue applies.
// ---------------------------------------------------------------------------

describe('ReviewManager.findPageForDate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lands on the page holding the first item due on or after the date', async () => {
    // 25 items, one per day from 2024-06-01, 10 per page.
    const day0 = startOfDay(new Date(2024, 5, 1));
    const manager = wireDueAt(
      Array.from({ length: 25 }, (_, i) => day0 + i * MS_PER_DAY + 60_000)
    );

    // The item due 2024-06-13 is index 12 → page 1 (indices 10..19).
    const page = await manager.findPageForDate(new Date(2024, 5, 13), 10);

    expect(page).toBe(1);
  });

  it('treats the rollover offset as the day boundary, not midnight', async () => {
    // makePlugin sets a +4h offset, so review day 13 runs 13 04:00 → 14 04:00.
    // Items are given as literal wall-clock times rather than via startOfDay,
    // so this pins the boundary itself and not just internal consistency.
    const manager = wireDueAt([
      new Date(2024, 5, 13, 2, 0).getTime(), // 02:00 — still day 12
      new Date(2024, 5, 13, 6, 0).getTime(), // 06:00 — first of day 13
      new Date(2024, 5, 14, 2, 0).getTime(), // 02:00 next — still day 13
    ]);

    // One entry per page, so the returned page IS the matched index.
    await expect(
      manager.findPageForDate(new Date(2024, 5, 13), 1)
    ).resolves.toBe(1);
  });

  it('lands on the last page when nothing is due that late', async () => {
    const day0 = startOfDay(new Date(2024, 5, 1));
    const manager = wireDueAt(
      Array.from({ length: 25 }, (_, i) => day0 + i * MS_PER_DAY + 60_000)
    );

    // 25 rows at 10 per page → pages 0..2.
    const page = await manager.findPageForDate(new Date(2030, 0, 1), 10);

    expect(page).toBe(2);
  });

  it('returns page 0 for an empty queue', async () => {
    const manager = wireDueAt([]);

    await expect(
      manager.findPageForDate(new Date(2024, 5, 13), 10)
    ).resolves.toBe(0);
  });

  it('includes an item due exactly at the start of the day (on or after)', async () => {
    const target = new Date(2024, 5, 13);
    // One item a moment before the day starts, one exactly at the boundary.
    const manager = wireDueAt([startOfDay(target) - 1, startOfDay(target)]);

    // Index 1 is the boundary item; at 1 per page that is page 1.
    await expect(manager.findPageForDate(target, 1)).resolves.toBe(1);
  });

  it('skips rows with no due time rather than treating them as due', async () => {
    const target = new Date(2024, 5, 13);
    const repo = makeRepo();
    vi.mocked(repo.query).mockResolvedValue([] as never);
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(manager.articles, 'fetchMany').mockResolvedValue([
      makeArticleRow({ id: 'a0', reference: 'a0.md', due: null }),
      makeArticleRow({
        id: 'a1',
        reference: 'a1.md',
        due: startOfDay(target),
        due_fuzz: null,
      }),
    ] as never);
    vi.spyOn(manager.snippets, 'fetchMany').mockResolvedValue([] as never);
    vi.spyOn(manager.cards, 'fetchMany').mockResolvedValue([] as never);
    vi.spyOn(Obsidian, 'getNote').mockImplementation(
      (reference: string) => ({ path: reference, extension: 'md' }) as TFile
    );

    // Null-due rows sort last, so the dated row is index 0 → page 0. A null
    // treated as the epoch would match first and still give 0, so use one
    // entry per page: the dated row must be the match, not the null row.
    await expect(manager.findPageForDate(target, 1)).resolves.toBe(0);
  });

  it('lands on the page whose slice contains the first item due on or after the date', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 40 }), // queue size
        fc.integer({ min: 1, max: 10 }), // entries per page
        fc.integer({ min: -5, max: 45 }), // target day offset
        async (count, entriesPerPage, dayOffset) => {
          // One item per day starting 2024-06-01, each due just after that
          // day's start, so item i is the first due on or after day i.
          const day0 = startOfDay(new Date(2024, 5, 1));
          const manager = wireDueAt(
            Array.from({ length: count }, (_, i) => day0 + i * MS_PER_DAY + 1)
          );

          const page = await manager.findPageForDate(
            new Date(2024, 5, 1 + dayOffset),
            entriesPerPage
          );

          // Closed form from the generators alone — no call back into the
          // code under test. A target before day 0 matches item 0; one past
          // the last item matches nothing and must clamp to the last page.
          const lastPage = Math.ceil(count / entriesPerPage) - 1;
          const matchedIndex = dayOffset < 0 ? 0 : dayOffset;
          const expected =
            matchedIndex > count - 1
              ? lastPage
              : Math.floor(matchedIndex / entriesPerPage);

          expect(page).toBe(expected);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getQueueRow — resolves one item id to its current QueueRow, or null when the
// row no longer belongs in the queue (dismissed / deleted / missing / no due).
// ---------------------------------------------------------------------------

describe('ReviewManager.getQueueRow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Route `repo.query` by target table so a single raw row can be returned for
   * whichever `SELECT * FROM <table> WHERE id = ?` the method issues. Every
   * reference resolves to a file whose path is the reference itself.
   */
  function wireRow(rows: {
    article?: ArticleRow;
    snippet?: SnippetRow;
    card?: SRSCardRow;
  }) {
    const repo = makeRepo();
    vi.spyOn(repo, 'query').mockImplementation((sql: string) => {
      if (sql.includes('FROM article'))
        return Promise.resolve(rows.article ? [rows.article] : []);
      if (sql.includes('FROM snippet'))
        return Promise.resolve(rows.snippet ? [rows.snippet] : []);
      if (sql.includes('FROM srs_card'))
        return Promise.resolve(rows.card ? [rows.card] : []);
      return Promise.resolve([]);
    });
    vi.spyOn(Obsidian, 'getNote').mockImplementation(
      (reference: string) => ({ path: reference, extension: 'md' }) as TFile
    );
    return new ReviewManager(makePlugin(), repo);
  }

  it('returns the QueueRow for a due, non-dismissed, non-deleted article', async () => {
    const manager = wireRow({
      article: makeArticleRow({
        id: 'a1',
        reference: 'articles/a1.md',
        due: YEAR_2000_MS,
        due_fuzz: null,
      }),
    });

    const row = await manager.getQueueRow('a1');

    expect(row).not.toBeNull();
    expect(row?.id).toBe('a1');
    expect(row?.type).toBe('article');
    expect(row?.due).toEqual(new Date(YEAR_2000_MS));
    expect(row?.file?.path).toBe('articles/a1.md');
  });

  it('resolves a snippet id', async () => {
    const manager = wireRow({
      snippet: makeSnippetRow({
        id: 's1',
        reference: 'snippets/s1.md',
        due: YEAR_2000_MS,
      }),
    });
    const row = await manager.getQueueRow('s1');
    expect(row?.type).toBe('snippet');
    expect(row?.id).toBe('s1');
  });

  it('resolves a card id', async () => {
    const manager = wireRow({
      card: makeCardRow({ id: 'c1', reference: 'cards/c1.md' }),
    });
    const row = await manager.getQueueRow('c1');
    expect(row?.type).toBe('card');
    expect(row?.id).toBe('c1');
  });

  it('returns null when the row is dismissed', async () => {
    const manager = wireRow({
      article: makeArticleRow({ id: 'a1', dismissed: 1 }),
    });
    expect(await manager.getQueueRow('a1')).toBeNull();
  });

  it('returns null when the row is deleted', async () => {
    const manager = wireRow({
      article: makeArticleRow({ id: 'a1', deleted: true }),
    });
    expect(await manager.getQueueRow('a1')).toBeNull();
  });

  it('returns null when the row has no due time', async () => {
    const manager = wireRow({
      article: makeArticleRow({ id: 'a1', due: null, dismissed: 1 }),
    });
    expect(await manager.getQueueRow('a1')).toBeNull();
  });

  it('returns null when no table has the id', async () => {
    const manager = wireRow({});
    expect(await manager.getQueueRow('missing')).toBeNull();
  });

  it('resolves an item whose note cannot be resolved to a missing row', async () => {
    const repo = makeRepo();
    vi.spyOn(repo, 'query').mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('FROM article')
          ? [makeArticleRow({ id: 'a1', reference: 'articles/a1.md' })]
          : []
      )
    );
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const manager = new ReviewManager(makePlugin(), repo);
    const row = await manager.getQueueRow('a1');
    expect(row?.id).toBe('a1');
    expect(row?.file).toBeNull();
    expect(row?.parent).toBeNull();
  });
});

describe('ReviewManager delegation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parseCloze delegates to cards.parseCloze', () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const fakeResult = { start: 'before', answer: 'cloze', end: 'after' };
    const spy = vi
      .spyOn(manager.cards, 'parseCloze')
      .mockReturnValue(fakeResult);
    const result = manager.parseCloze('text (}cloze{)', ['(}', '{)']);
    expect(spy).toHaveBeenCalledWith('text (}cloze{)', ['(}', '{)']);
    expect(result).toEqual(fakeResult);
  });

  it('reviewCard delegates to cards.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const card = CardManager.rowToDisplay(makeCardRow());
    const spy = vi
      .spyOn(manager.cards, 'review')
      .mockResolvedValue(undefined as never);
    await manager.reviewCard(card, 3 as never);
    expect(spy).toHaveBeenCalledWith(card, 3, undefined);
  });

  it('reviewCard passes optional reviewTime to cards.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const card = CardManager.rowToDisplay(makeCardRow());
    const spy = vi
      .spyOn(manager.cards, 'review')
      .mockResolvedValue(undefined as never);
    const t = new Date();
    await manager.reviewCard(card, 1 as never, t);
    expect(spy).toHaveBeenCalledWith(card, 1, t);
  });

  it('getSnippetHighlights delegates to snippets.getHighlights', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.snippets, 'getHighlights')
      .mockResolvedValue([]);
    await manager.getSnippetHighlights(FAKE_FILE);
    expect(spy).toHaveBeenCalledWith(FAKE_FILE);
  });

  it('updateSnippetOffsets delegates to snippets.updateOffsets', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.snippets, 'updateOffsets')
      .mockResolvedValue(undefined as never);
    await manager.updateSnippetOffsets('snip-1', 10, 20);
    expect(spy).toHaveBeenCalledWith('snip-1', 10, 20);
  });

  it('reviewSnippet delegates to snippets.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const snippet = makeSnippetBase();
    const spy = vi
      .spyOn(manager.snippets, 'review')
      .mockResolvedValue(undefined as never);
    await manager.reviewSnippet(snippet, 1000, 86400000);
    expect(spy).toHaveBeenCalledWith(snippet, 1000, 86400000);
  });

  it('importArticle delegates to articles.import', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.articles, 'import')
      .mockResolvedValue(undefined as never);
    await manager.importArticle(FAKE_FILE, 30, null);
    expect(spy).toHaveBeenCalledWith(FAKE_FILE, 30, null, undefined);
  });

  it('importArticle forwards inPlace to articles.import', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.articles, 'import')
      .mockResolvedValue(undefined as never);
    await manager.importArticle(FAKE_FILE, 30, null, true);
    expect(spy).toHaveBeenCalledWith(FAKE_FILE, 30, null, true);
  });

  it('createEmptyArticle delegates to articles.create', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const spy = vi
      .spyOn(manager.articles, 'create')
      .mockResolvedValue(undefined as never);
    await manager.createEmptyArticle(25);
    expect(spy).toHaveBeenCalledWith(25, undefined);
  });

  it('reviewArticle delegates to articles.review', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const article = makeArticleBase();
    const spy = vi
      .spyOn(manager.articles, 'review')
      .mockResolvedValue(undefined as never);
    await manager.reviewArticle(article, 1000, 86400000);
    expect(spy).toHaveBeenCalledWith(article, 1000, 86400000);
  });

  it('renameArticle delegates to articles.rename', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const reviewArticle: ReviewArticle = {
      data: makeArticleBase(),
      file: FAKE_FILE,
    };
    const spy = vi
      .spyOn(manager.articles, 'rename')
      .mockResolvedValue(undefined as never);
    await manager.renameArticle(reviewArticle, 'new-name');
    expect(spy).toHaveBeenCalledWith(reviewArticle, 'new-name');
  });
});

// ---------------------------------------------------------------------------
// reprioritize — branches on isArticle
// ---------------------------------------------------------------------------

describe('ReviewManager.reprioritize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls articles.reprioritize for an article item', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 10, max: 50 }), async (priority) => {
        const repo = makeRepo();
        const manager = new ReviewManager(makePlugin(), repo);
        const article = makeArticleBase();
        // vi.fn() assigned directly: tracked per-iteration object, not added to
        // Vitest's global restore list (unlike vi.spyOn), so it won't accumulate.
        const articleMock = vi.fn().mockResolvedValue(undefined);
        const snippetMock = vi.fn().mockResolvedValue(undefined);
        manager.articles.reprioritize = articleMock;
        manager.snippets.reprioritize = snippetMock;
        await manager.reprioritize(article, priority);
        expect(articleMock).toHaveBeenCalledWith(article, priority);
        expect(snippetMock).not.toHaveBeenCalled();
      })
    );
  });

  it('calls snippets.reprioritize for a snippet item', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 10, max: 50 }), async (priority) => {
        const repo = makeRepo();
        const manager = new ReviewManager(makePlugin(), repo);
        const snippet = makeSnippetBase();
        const articleMock = vi.fn().mockResolvedValue(undefined);
        const snippetMock = vi.fn().mockResolvedValue(undefined);
        manager.articles.reprioritize = articleMock;
        manager.snippets.reprioritize = snippetMock;
        await manager.reprioritize(snippet, priority);
        expect(snippetMock).toHaveBeenCalledWith(snippet, priority);
        expect(articleMock).not.toHaveBeenCalled();
      })
    );
  });
});

// ---------------------------------------------------------------------------
// manageFixedInterval — branches on key presence
// ---------------------------------------------------------------------------

describe('ReviewManager.manageFixedInterval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls articles.setFixedInterval when changes has newIntervalDays', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30 }),
        async (newIntervalDays) => {
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          const article = makeArticleBase();
          const setMock = vi.fn().mockResolvedValue(undefined);
          const disableMock = vi.fn().mockResolvedValue(undefined);
          manager.articles.setFixedInterval = setMock;
          manager.articles.disableFixedInterval = disableMock;
          await manager.manageFixedInterval(article, { newIntervalDays });
          expect(setMock).toHaveBeenCalledWith(article, newIntervalDays);
          expect(disableMock).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('calls articles.disableFixedInterval when changes has newPriority', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10, max: 50 }),
        async (newPriority) => {
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          const article = makeArticleBase();
          const setMock = vi.fn().mockResolvedValue(undefined);
          const disableMock = vi.fn().mockResolvedValue(undefined);
          manager.articles.setFixedInterval = setMock;
          manager.articles.disableFixedInterval = disableMock;
          await manager.manageFixedInterval(article, { newPriority });
          expect(disableMock).toHaveBeenCalledWith(article, newPriority);
          expect(setMock).not.toHaveBeenCalled();
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// getDue — error path
// ---------------------------------------------------------------------------

describe('ReviewManager.getDue error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty arrays when a sub-manager throws', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(manager.articles, 'getDue').mockRejectedValue(
      new Error('db error')
    );
    vi.spyOn(manager.snippets, 'getDue').mockResolvedValue([]);
    vi.spyOn(manager.cards, 'getDue').mockResolvedValue([]);
    const result = await manager.getDue({
      typesToInclude: { article: true, snippet: true, card: true },
    });
    expect(result).toEqual({ all: [], cards: [], snippets: [], articles: [] });
  });
});

// ---------------------------------------------------------------------------
// getReviewItemFromFile
// ---------------------------------------------------------------------------

describe('ReviewManager.getReviewItemFromFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when getNoteType returns null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when article row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns ReviewArticle when article row is found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const row = makeArticleRow();
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(row as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).not.toBeNull();
    expect(result!.data.type).toBe('article');
    expect(result!.data.id).toBe(row.id);
    expect(result!.file).toBe(FAKE_FILE);
  });

  it('returns null when snippet row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns ReviewSnippet when snippet row is found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const row = makeSnippetRow();
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(row as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).not.toBeNull();
    expect(result!.data.type).toBe('snippet');
    expect(result!.data.id).toBe(row.id);
  });

  it('returns null when card row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    vi.spyOn(manager.cards, 'findCard').mockResolvedValue(null);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns ReviewCard when card row is found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const row = makeCardRow();
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    vi.spyOn(manager.cards, 'findCard').mockResolvedValue(row as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).not.toBeNull();
    expect(result!.data.type).toBe('card');
    expect(result!.data.id).toBe(row.id);
  });
});

// ---------------------------------------------------------------------------
// getReviewItemFromId — tries each sub-manager in order
// ---------------------------------------------------------------------------

describe('ReviewManager.getReviewItemFromId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the article when articles.fetch finds it', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const expected: ReviewArticle = {
      data: makeArticleBase(),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(expected);
    const snippetSpy = vi.spyOn(manager.snippets, 'fetch');
    const cardSpy = vi.spyOn(manager.cards, 'fetch');
    const result = await manager.getReviewItemFromId('article-1');
    expect(result).toBe(expected);
    expect(snippetSpy).not.toHaveBeenCalled();
    expect(cardSpy).not.toHaveBeenCalled();
  });

  it('falls through to snippets.fetch when articles.fetch returns null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const expected: ReviewSnippet = {
      data: makeSnippetBase(),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.snippets, 'fetch').mockResolvedValue(expected);
    const cardSpy = vi.spyOn(manager.cards, 'fetch');
    const result = await manager.getReviewItemFromId('snippet-1');
    expect(result).toBe(expected);
    expect(cardSpy).not.toHaveBeenCalled();
  });

  it('falls through to cards.fetch when both articles and snippets return null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const expected: ReviewCard = {
      data: CardManager.rowToDisplay(makeCardRow()),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.snippets, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.cards, 'fetch').mockResolvedValue(expected);
    const result = await manager.getReviewItemFromId('card-1');
    expect(result).toBe(expected);
  });

  it('returns null when no sub-manager finds the item', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(manager.articles, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.snippets, 'fetch').mockResolvedValue(null);
    vi.spyOn(manager.cards, 'fetch').mockResolvedValue(null);
    const result = await manager.getReviewItemFromId('missing-id');
    expect(result).toBeNull();
  });
});

describe('ReviewManager.getItemOrMissingFromId', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(ITEM_ROW_KINDS)(
    'resolves a live $table row with no file to a missing item, without writing to it',
    async (kind) => {
      const wired = wirePaths([]);
      insertItemRow(wired.repo, kind, false);

      const item = await wired.manager.getItemOrMissingFromId('x');

      expect(item?.file).toBeNull();
      expect(item?.data).toMatchObject({
        id: 'x',
        type: kind.type,
        reference: kind.reference,
      });
      expect(wired.repo.rows(kind.table)).toEqual([
        { id: 'x', reference: kind.reference, deleted: false },
      ]);
    }
  );

  it.each(ITEM_ROW_KINDS)(
    'answers null for a $table tombstone with no file, whose file was deleted, not lost',
    async (kind) => {
      const wired = wirePaths([]);
      insertItemRow(wired.repo, kind, true);

      expect(await wired.manager.getItemOrMissingFromId('x')).toBeNull();
      expect(wired.repo.rows(kind.table)).toEqual([
        { id: 'x', reference: kind.reference, deleted: true },
      ]);
    }
  );

  it.each(
    ITEM_ROW_KINDS.flatMap((kind) =>
      [false, true].map((deleted) => ({ ...kind, deleted }))
    )
  )(
    'resolves a $table row whose file is there (deleted: $deleted) as its ordinary review item',
    async ({ deleted, ...kind }) => {
      const wired = wirePaths([kind.reference]);
      insertItemRow(wired.repo, kind, deleted);

      const item = await wired.manager.getItemOrMissingFromId('x');

      expect(item).toEqual(await wired.manager.getReviewItemFromId('x'));
      expect(item?.file).toBe(wired.files.get(kind.reference));
    }
  );

  it('answers null for an id no table holds', async () => {
    const wired = wirePaths([]);
    expect(await wired.manager.getItemOrMissingFromId('nothing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dismissItem / unDismissItem — table routing and SQL args
// ---------------------------------------------------------------------------

describe('ReviewManager.dismissItem and unDismissItem', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)(
    'dismissItem uses table "%s" for %s type',
    async (type, expectedTable) => {
      const repo = makeRepo();
      const manager = new ReviewManager(makePlugin(), repo);
      const item = makeReviewItem(type);
      vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(type);
      await manager.dismissItem(item);
      const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(`UPDATE ${expectedTable}`);
      expect(sql).toContain('dismissed = 1');
      expect(params).toEqual([item.data.id]);
    }
  );

  it('drops a remembered session pointing at the dismissed item', async () => {
    // The note's own action bar dismisses through here and never reaches
    // `Actions`, and it does so with no review tab open — so the session
    // pointer is the only thing left naming the item.
    const repo = makeRepo();
    const plugin = makePlugin();
    const forgetIf = vi.fn();
    Object.assign(plugin, { sessionTracker: { forgetIf } });
    const manager = new ReviewManager(plugin, repo);
    const item = makeReviewItem('article');

    await manager.dismissItem(item);

    expect(forgetIf).toHaveBeenCalledWith(item.data.id);
  });

  it('dismisses without a session tracker running', async () => {
    // Dismissals can land before `onload` finishes wiring tracking up.
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const item = makeReviewItem('article');

    await expect(manager.dismissItem(item)).resolves.toBeUndefined();
    expect(repo.mutate).toHaveBeenCalled();
  });

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)(
    'unDismissItem uses table "%s" for %s type',
    async (type, expectedTable) => {
      const repo = makeRepo();
      const manager = new ReviewManager(makePlugin(), repo);
      const item = makeReviewItem(type);
      vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(type);
      await manager.unDismissItem(item);
      const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(`UPDATE ${expectedTable}`);
      expect(sql).toContain('dismissed = 0');
      expect(params).toEqual([item.data.id]);
    }
  );
});

// ---------------------------------------------------------------------------
// handleExternalRename
// ---------------------------------------------------------------------------

describe('ReviewManager.handleExternalRename', () => {
  const IR_DIR = DATA_DIRECTORY; // 'incremental-reading'

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeApp(
    fileExists: boolean,
    noteType: NoteType | null = 'article',
    filePath?: string
  ) {
    const resolvedPath = filePath ?? `${IR_DIR}/articles/renamed.md`;
    const file = fileExists
      ? ({ path: resolvedPath, extension: 'md' } as TFile)
      : null;
    const tagMap: Record<NonNullable<NoteType>, string> = {
      article: 'ir-article',
      snippet: 'ir-text-snippet',
      card: 'ir-card',
    };
    const frontmatterContent = noteType
      ? noteText({ tags: [tagMap[noteType]] })
      : 'no frontmatter here';
    return {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
        cachedRead: vi.fn().mockResolvedValue(frontmatterContent),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        on: vi
          .fn()
          .mockImplementation((_event: string, cb: (f: TFile) => void) => {
            if (file) cb(file);
            return Symbol('ref');
          }),
        offref: vi.fn(),
      },
    };
  }

  it('throws when the file cannot be found at newPath', async () => {
    const repo = makeRepo();
    const app = makeApp(false);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    const abstractFile = {
      path: `${IR_DIR}/articles/renamed.md`,
    } as TAbstractFile;
    await expect(
      manager.handleExternalRename(abstractFile, `${IR_DIR}/articles/old.md`)
    ).rejects.toThrow('Failed to find a file');
  });

  it('returns early (no mutate) when file has no IR note type', async () => {
    const repo = makeRepo();
    const app = makeApp(true, null);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = {
      path: `${IR_DIR}/articles/renamed.md`,
    } as TAbstractFile;
    await manager.handleExternalRename(
      abstractFile,
      `${IR_DIR}/articles/old.md`
    );
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it('updates reference when item moves from external folder into IR directory', async () => {
    const repo = makeRepo();
    const newPath = `${IR_DIR}/articles/renamed.md`;
    const oldPath = 'some-other-folder/old.md';
    const app = makeApp(true, 'article');
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE article');
    expect(params[0]).toBe(newPath);
    expect(params[1]).toBe(oldPath);
  });

  it('updates reference when item moves out of IR directory to external folder', async () => {
    const repo = makeRepo();
    const newPath = 'some-other-folder/renamed.md';
    const oldPath = `${IR_DIR}/articles/old.md`;
    const app = makeApp(true, 'article', newPath);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE article');
    expect(params[0]).toBe(newPath);
    expect(params[1]).toBe(oldPath);
  });

  it('updates reference when item moves between two non-IR folders', async () => {
    const repo = makeRepo();
    const newPath = 'folder-b/new-name.md';
    const oldPath = 'folder-a/old-name.md';
    const app = makeApp(true, 'article', newPath);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE article');
    expect(params[0]).toBe(newPath);
    expect(params[1]).toBe(oldPath);
  });

  it('returns early (no mutate) when old and new reference are identical', async () => {
    const repo = makeRepo();
    // same basename in same subfolder → same reference
    const sameFile = {
      path: `${IR_DIR}/articles/same.md`,
      extension: 'md',
    } as TFile;
    const appObj = {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(sameFile),
        cachedRead: vi
          .fn()
          .mockResolvedValue(noteText({ tags: ['ir-article'] })),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        on: vi.fn().mockReturnValue(Symbol()),
        offref: vi.fn(),
      },
    };
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = {
      path: `${IR_DIR}/articles/same.md`,
    } as TAbstractFile;
    await manager.handleExternalRename(
      abstractFile,
      `${IR_DIR}/articles/same.md`
    );
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)(
    'updates reference in table "%s" for note type %s',
    async (noteType, expectedTable) => {
      const repo = makeRepo();
      const tagMap: Record<string, string> = {
        article: 'ir-article',
        snippet: 'ir-text-snippet',
        card: 'ir-card',
      };
      const newPath = `${IR_DIR}/articles/new-name.md`;
      const oldPath = `${IR_DIR}/articles/old-name.md`;
      const file = { path: newPath, extension: 'md' } as TFile;
      const appObj = {
        vault: {
          getFileByPath: vi.fn().mockReturnValue(file),
          cachedRead: vi
            .fn()
            .mockResolvedValue(noteText({ tags: [tagMap[noteType]] })),
        },
        metadataCache: {
          getFileCache: vi.fn(),
          on: vi.fn().mockReturnValue(Symbol()),
          offref: vi.fn(),
        },
      };
      const manager = new ReviewManager(makePlugin(appObj as never), repo);
      manager.app = appObj as never;
      vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
        undefined
      );
      const abstractFile = { path: newPath } as TAbstractFile;
      await manager.handleExternalRename(abstractFile, oldPath);
      const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(`UPDATE ${expectedTable}`);
      expect(sql).toContain('SET reference');
      expect(params[0]).toBe(`${IR_DIR}/articles/new-name.md`);
      expect(params[1]).toBe(`${IR_DIR}/articles/old-name.md`);
    }
  );
});

// ---------------------------------------------------------------------------
// saveScrollPosition
// ---------------------------------------------------------------------------

describe('ReviewManager.saveScrollPosition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when noteType is null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    await manager.saveScrollPosition(FAKE_FILE, 100);
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it('does nothing when noteType is card', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    await manager.saveScrollPosition(FAKE_FILE, 100);
    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it.each(['article', 'snippet'] as const)(
    'mutates %s table with the rounded offset in scroll_top',
    async (noteType) => {
      await fc.assert(
        fc.asyncProperty(
          fc.float({ min: 0, max: 10000, noNaN: true }),
          async (offset) => {
            vi.restoreAllMocks();
            const repo = makeRepo();
            const manager = new ReviewManager(makePlugin(), repo);
            vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(noteType);
            await manager.saveScrollPosition(FAKE_FILE, offset);
            const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
              .calls[0] as [string, unknown[]];
            expect(sql).toContain(`UPDATE ${noteType}`);
            expect(sql).toContain('scroll_top');
            expect(params[0]).toBe(Math.round(offset));
          }
        )
      );
    }
  );
});

// ---------------------------------------------------------------------------
// loadScrollPosition
// ---------------------------------------------------------------------------

describe('ReviewManager.loadScrollPosition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when noteType is null', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when noteType is card', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when article row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(null);
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when article row scroll_top is 0 (unset)', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(
      makeArticleRow({ scroll_top: 0 }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns the offset when article row has scroll_top > 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100000 }),
        async (scrollTop) => {
          vi.restoreAllMocks();
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
          vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(
            makeArticleRow({ scroll_top: scrollTop }) as never
          );
          const result = await manager.loadScrollPosition(FAKE_FILE);
          expect(result).toBe(scrollTop);
        }
      )
    );
  });

  it('returns null when snippet row not found', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(null);
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns null when snippet row scroll_top is 0 (unset)', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
      makeSnippetRow({ scroll_top: 0 }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('returns the offset when snippet row has scroll_top > 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100000 }),
        async (scrollTop) => {
          vi.restoreAllMocks();
          const repo = makeRepo();
          const manager = new ReviewManager(makePlugin(), repo);
          vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
          vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
            makeSnippetRow({ scroll_top: scrollTop }) as never
          );
          const result = await manager.loadScrollPosition(FAKE_FILE);
          expect(result).toBe(scrollTop);
        }
      )
    );
  });

  it('card noteType does not call findArticle or findSnippet', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    const articleSpy = vi.spyOn(manager.articles, 'findArticle');
    const snippetSpy = vi.spyOn(manager.snippets, 'findSnippet');
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
    expect(articleSpy).not.toHaveBeenCalled();
    expect(snippetSpy).not.toHaveBeenCalled();
  });

  it('article noteType calls findArticle but not findSnippet', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    const articleSpy = vi
      .spyOn(manager.articles, 'findArticle')
      .mockResolvedValue(null);
    const snippetSpy = vi.spyOn(manager.snippets, 'findSnippet');
    await manager.loadScrollPosition(FAKE_FILE);
    expect(articleSpy).toHaveBeenCalled();
    expect(snippetSpy).not.toHaveBeenCalled();
  });

  it('snippet noteType calls findSnippet but not findArticle', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    const articleSpy = vi.spyOn(manager.articles, 'findArticle');
    const snippetSpy = vi
      .spyOn(manager.snippets, 'findSnippet')
      .mockResolvedValue(null);
    await manager.loadScrollPosition(FAKE_FILE);
    expect(snippetSpy).toHaveBeenCalled();
    expect(articleSpy).not.toHaveBeenCalled();
  });

  it('returns null when scroll_top is not a number', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    // scroll_top is undefined — exercises the typeof check
    vi.spyOn(manager.articles, 'findArticle').mockResolvedValue(
      makeArticleRow({ scroll_top: undefined as unknown as number }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });

  it('snippet: returns null when scroll_top is not a number', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
      makeSnippetRow({ scroll_top: undefined as unknown as number }) as never
    );
    const result = await manager.loadScrollPosition(FAKE_FILE);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scroll position of a binary item
// ---------------------------------------------------------------------------

describe('ReviewManager scroll position of a binary item', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves and loads an article's or snippet's position in its own row, and none for a card or an untracked file", async () => {
    await fc.assert(
      fc.asyncProperty(
        binaryFileArb,
        itemTableArb,
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        async (file, table, position) => {
          vi.restoreAllMocks();
          const { manager, row, repo } = wireBinary(file, table);
          const { mutate } = repo as unknown as {
            mutate: ReturnType<typeof vi.fn>;
          };
          if (row) Object.assign(row, { scroll_top: position });

          await manager.saveScrollPosition(file, position);
          const loaded = await manager.loadScrollPosition(file);

          const kept = table === 'article' || table === 'snippet';
          expect(mutate.mock.calls).toEqual(
            kept
              ? [
                  [
                    `UPDATE ${table} SET scroll_top = $1 WHERE reference = $2`,
                    [position, file.path],
                  ],
                ]
              : []
          );
          expect(loaded).toBe(kept ? position : null);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Additional targeted tests to kill surviving mutants
// ---------------------------------------------------------------------------

describe('ReviewManager.getDue sort order', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('all array is sorted by due date ascending across types', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const t1 = 1000;
    const t2 = 2000;
    const t3 = 3000;
    // Return items out of order from each sub-manager
    const article = makeReviewArticleItem(t3);
    const snippet: ReviewSnippet = {
      data: makeSnippetBase({ id: 'snip', due: t1 }),
      file: FAKE_FILE,
    };
    const card: ReviewCard = {
      data: CardManager.rowToDisplay(makeCardRow({ id: 'card', due: t2 })),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'getDue').mockResolvedValue([article]);
    vi.spyOn(manager.snippets, 'getDue').mockResolvedValue([snippet]);
    vi.spyOn(manager.cards, 'getDue').mockResolvedValue([card]);
    const result = await manager.getDue({
      typesToInclude: { article: true, snippet: true, card: true },
    });
    const ids = result.all.map((r) => r.data.id);
    expect(ids).toEqual(['snip', 'card', `article-${t3}`]);
  });

  it('folds due_fuzz into the cross-type sort, matching getQueue order', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    // article fuzzes from 3000 down to 1500 (earliest), card sits at 2000,
    // snippet at 3000 — so fuzzed order is article, card, snippet.
    const article: ReviewArticle = {
      data: makeArticleBase({ id: 'art', due: 3000, due_fuzz: -1500 }),
      file: FAKE_FILE,
    };
    const snippet: ReviewSnippet = {
      data: makeSnippetBase({ id: 'snip', due: 3000, due_fuzz: 0 }),
      file: FAKE_FILE,
    };
    const card: ReviewCard = {
      data: CardManager.rowToDisplay(makeCardRow({ id: 'card', due: 2000 })),
      file: FAKE_FILE,
    };
    vi.spyOn(manager.articles, 'getDue').mockResolvedValue([article]);
    vi.spyOn(manager.snippets, 'getDue').mockResolvedValue([snippet]);
    vi.spyOn(manager.cards, 'getDue').mockResolvedValue([card]);
    const result = await manager.getDue({
      typesToInclude: { article: true, snippet: true, card: true },
    });
    expect(result.all.map((r) => r.data.id)).toEqual(['art', 'card', 'snip']);
  });
});

describe('ReviewManager.getReviewItemFromFile card branch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call findCard when noteType is snippet (card branch not taken)', async () => {
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('snippet');
    vi.spyOn(manager.snippets, 'findSnippet').mockResolvedValue(
      makeSnippetRow() as never
    );
    const cardSpy = vi.spyOn(manager.cards, 'findCard');
    await manager.getReviewItemFromFile(FAKE_FILE);
    expect(cardSpy).not.toHaveBeenCalled();
  });
});

describe('ReviewManager.handleExternalRename rowId branch', () => {
  const IR_DIR = DATA_DIRECTORY;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeAppWithIrId(
    noteType: 'article' | 'snippet' | 'card',
    irId: string,
    newPath: string
  ) {
    const tagMap: Record<string, string> = {
      article: 'ir-article',
      snippet: 'ir-text-snippet',
      card: 'ir-card',
    };
    const file = { path: newPath, extension: 'md' } as TFile;
    return {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
        cachedRead: vi
          .fn()
          .mockResolvedValue(
            noteText({ tags: [tagMap[noteType]], 'ir-id': irId })
          ),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        on: vi.fn().mockReturnValue(Symbol()),
        offref: vi.fn(),
      },
    };
  }

  it('uses WHERE id = $2 (not WHERE reference = $2) when frontmatter has ir-id', async () => {
    const repo = makeRepo();
    const irId = 'known-row-id';
    const newPath = `${IR_DIR}/articles/renamed.md`;
    const oldPath = `${IR_DIR}/articles/old.md`;
    const app = makeAppWithIrId('article', irId, newPath);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );

    await manager.handleExternalRename(
      { path: newPath } as TAbstractFile,
      oldPath
    );

    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE id = $2');
    expect(sql).not.toContain('WHERE reference = $2');
    expect(params[0]).toBe(newPath);
    expect(params[1]).toBe(irId);
  });

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)(
    'rowId branch: updates table "%s" by id for note type %s',
    async (noteType, expectedTable) => {
      const repo = makeRepo();
      const irId = `id-for-${noteType}`;
      const newPath = `${IR_DIR}/articles/new-name.md`;
      const oldPath = `${IR_DIR}/articles/old-name.md`;
      const app = makeAppWithIrId(noteType, irId, newPath);
      const manager = new ReviewManager(makePlugin(app as never), repo);
      manager.app = app as never;
      vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
        undefined
      );

      await manager.handleExternalRename(
        { path: newPath } as TAbstractFile,
        oldPath
      );

      const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, unknown[]];
      expect(sql).toContain(`UPDATE ${expectedTable}`);
      expect(sql).toContain('WHERE id = $2');
      expect(params[1]).toBe(irId);
    }
  );

  it('un-deletes the row matching the ir-id, so renaming a note back to a deleted reference restores it', async () => {
    const repo = makeRepo();
    const irId = 'deleted-row-id';
    const newPath = `${IR_DIR}/articles/restored.md`;
    const oldPath = `${IR_DIR}/articles/temp-name.md`;
    const app = makeAppWithIrId('article', irId, newPath);
    const manager = new ReviewManager(makePlugin(app as never), repo);
    manager.app = app as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );

    await manager.handleExternalRename(
      { path: newPath } as TAbstractFile,
      oldPath
    );

    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('deleted = FALSE');
    expect(sql).toContain('WHERE id = $2');
    expect(params).toEqual([newPath, irId]);
  });
});

describe('ReviewManager.getReviewItemFromFile card vs null distinction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for getNoteType=null, NOT a card ReviewItem (card branch not taken)', async () => {
    // Mutant: `else if (noteType === 'card')` → `else if (true)` would try to
    // call findCard even when noteType is null, so we verify null is returned
    // without calling findCard.
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(null);
    const findCardSpy = vi
      .spyOn(manager.cards, 'findCard')
      .mockResolvedValue(makeCardRow() as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).toBeNull();
    expect(findCardSpy).not.toHaveBeenCalled();
  });

  it('returns a ReviewCard (not null) for noteType=card when card row exists', async () => {
    // This test distinguishes the card branch from the null fallthrough:
    // if mutant changes `=== 'card'` to `true`, the test above catches it;
    // if the mutant makes cards unreachable this test catches it.
    const repo = makeRepo();
    const manager = new ReviewManager(makePlugin(), repo);
    const row = makeCardRow({ id: 'distinct-card-id' });
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('card');
    vi.spyOn(manager.cards, 'findCard').mockResolvedValue(row as never);
    const result = await manager.getReviewItemFromFile(FAKE_FILE);
    expect(result).not.toBeNull();
    expect(result!.data.type).toBe('card');
    expect(result!.data.id).toBe('distinct-card-id');
  });
});

describe('ReviewManager.handleExternalRename CARD_TAG condition', () => {
  const IR_DIR = DATA_DIRECTORY;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses table "article" (not "srs_card") when file is tagged as article but not card', async () => {
    // Mutant: `frontmatter.tags.includes(CARD_TAG)` → `true` would make all
    // non-article, non-snippet files route to srs_card. An article-tagged file
    // would still hit the article branch before reaching the card branch, but a
    // file with ONLY the article tag verifies the cascade is correct.
    const repo = makeRepo();
    const newPath = `${IR_DIR}/articles/new-name.md`;
    const oldPath = `${IR_DIR}/articles/old-name.md`;
    const file = { path: newPath, extension: 'md' } as TFile;
    const appObj = {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
        cachedRead: vi
          .fn()
          .mockResolvedValue(noteText({ tags: ['ir-article'] })),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        on: vi.fn().mockReturnValue(Symbol()),
        offref: vi.fn(),
      },
    };
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    const [sql] = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('UPDATE article');
    expect(sql).not.toContain('UPDATE srs_card');
  });

  it('does not mutate when file has IR-formatted tags array but none match any IR tag', async () => {
    // A file with defined tags but no CARD/SNIPPET/ARTICLE tags — type stays null, no mutate.
    // If the CARD_TAG mutant is `true`, this file would get treated as a card and mutate.
    const repo = makeRepo();
    const newPath = `${IR_DIR}/articles/some.md`;
    const oldPath = `${IR_DIR}/articles/other.md`;
    const file = { path: newPath, extension: 'md' } as TFile;
    const appObj = {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
        cachedRead: vi
          .fn()
          .mockResolvedValue(noteText({ tags: ['some-other-tag'] })),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        on: vi.fn().mockReturnValue(Symbol()),
        offref: vi.fn(),
      },
    };
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const abstractFile = { path: newPath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, oldPath);
    expect(repo.mutate).not.toHaveBeenCalled();
  });
});

describe('ReviewManager.handleCreation copy detection', () => {
  const IR_DIR = DATA_DIRECTORY;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCreationApp(
    irId: string,
    existingFiles: { path: string; irId?: string }[]
  ) {
    const files = new Map(
      existingFiles.map(({ path }) => [
        path,
        { path, extension: 'md' } as TFile,
      ])
    );
    const cachedIds = new Map(
      existingFiles.map(({ path, irId: fileIrId }) => [path, fileIrId])
    );
    return {
      vault: {
        getFileByPath: vi.fn(
          (path: string): TFile | null => files.get(path) ?? null
        ),
        // The created note, whatever its path
        cachedRead: vi
          .fn()
          .mockResolvedValue(noteText({ tags: ['ir-article'], 'ir-id': irId })),
      },
      metadataCache: {
        getFileCache: vi.fn((file: TFile) => ({
          frontmatter: { 'ir-id': cachedIds.get(file.path) },
        })),
        on: vi.fn().mockReturnValue(Symbol()),
        offref: vi.fn(),
      },
    };
  }

  it('does not repoint the row when the original note still exists (copy)', async () => {
    const repo = makeRepo();
    const originalPath = `${IR_DIR}/articles/original.md`;
    const copyPath = `${IR_DIR}/articles/original 1.md`;
    (repo.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { reference: originalPath },
    ]);
    const appObj = makeCreationApp('article-1', [
      { path: originalPath, irId: 'article-1' },
      { path: copyPath, irId: 'article-1' },
    ]);
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;

    await manager.handleCreation({ path: copyPath } as TAbstractFile);

    expect(repo.mutate).not.toHaveBeenCalled();
  });

  it('repoints the row when the note at the reference has a different ir-id', async () => {
    // The stored reference points at a note that is no longer this item's
    // original (its ir-id differs), so the creation is treated as a restore.
    const repo = makeRepo();
    const originalPath = `${IR_DIR}/articles/original.md`;
    const createdPath = `${IR_DIR}/articles/original 1.md`;
    (repo.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { reference: originalPath },
    ]);
    const appObj = makeCreationApp('article-1', [
      { path: originalPath, irId: 'some-other-id' },
      { path: createdPath, irId: 'article-1' },
    ]);
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;

    await manager.handleCreation({ path: createdPath } as TAbstractFile);

    expect(repo.mutate).toHaveBeenCalled();
    const [, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(params).toEqual([createdPath, 'article-1']);
  });

  it('repoints and un-deletes the row when the original note is gone (restore)', async () => {
    const repo = makeRepo();
    const originalPath = `${IR_DIR}/articles/original.md`;
    const restoredPath = `${IR_DIR}/restored/original.md`;
    (repo.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { reference: originalPath },
    ]);
    const appObj = makeCreationApp('article-1', [
      { path: restoredPath, irId: 'article-1' },
    ]);
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;

    await manager.handleCreation({ path: restoredPath } as TAbstractFile);

    expect(repo.mutate).toHaveBeenCalled();
    const [sql, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(sql).toContain('deleted = FALSE');
    expect(params).toEqual([restoredPath, 'article-1']);
  });

  it('un-deletes the row when the note is restored at its original path', async () => {
    const repo = makeRepo();
    const originalPath = `${IR_DIR}/articles/original.md`;
    (repo.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { reference: originalPath },
    ]);
    const appObj = makeCreationApp('article-1', [
      { path: originalPath, irId: 'article-1' },
    ]);
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;

    await manager.handleCreation({ path: originalPath } as TAbstractFile);

    expect(repo.mutate).toHaveBeenCalled();
    const [, params] = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    expect(params).toEqual([originalPath, 'article-1']);
  });
});

describe('ReviewManager.handleExternalRename console.warn mutant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns (does not mutate) when old and new reference are identical', async () => {
    const repo = makeRepo();
    const samePath = `${DATA_DIRECTORY}/articles/same.md`;
    const file = { path: samePath, extension: 'md' } as TFile;
    const appObj = {
      vault: {
        getFileByPath: vi.fn().mockReturnValue(file),
        cachedRead: vi
          .fn()
          .mockResolvedValue(noteText({ tags: ['ir-article'] })),
      },
      metadataCache: {
        getFileCache: vi.fn(),
        on: vi.fn().mockReturnValue(Symbol()),
        offref: vi.fn(),
      },
    };
    const manager = new ReviewManager(makePlugin(appObj as never), repo);
    manager.app = appObj as never;
    vi.spyOn(manager.snippets.offsetTracker, 'renameFile').mockReturnValue(
      undefined
    );
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const abstractFile = { path: samePath } as TAbstractFile;
    await manager.handleExternalRename(abstractFile, samePath);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('did not change')
    );
    expect(repo.mutate).not.toHaveBeenCalled();
  });
});

describe('ReviewManager.updateManySnippetOffsets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands the highlights to the snippet manager and passes its result back (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.uuid(),
            start_offset: fc.integer({ min: 0 }),
            end_offset: fc.integer({ min: 0 }),
          }),
          { maxLength: 10 }
        ),
        async (highlights) => {
          const manager = new ReviewManager(makePlugin(), makeRepo());
          const updateManyOffsets = vi
            .spyOn(manager.snippets, 'updateManyOffsets')
            .mockResolvedValue(undefined);

          await expect(
            manager.updateManySnippetOffsets(highlights)
          ).resolves.toBeUndefined();

          expect(updateManyOffsets).toHaveBeenCalledTimes(1);
          expect(updateManyOffsets).toHaveBeenCalledWith(highlights);
        }
      )
    );
  });

  it('rejects when the snippet manager does', async () => {
    const manager = new ReviewManager(makePlugin(), makeRepo());
    vi.spyOn(manager.snippets, 'updateManyOffsets').mockRejectedValue(
      new Error('write failed')
    );

    await expect(manager.updateManySnippetOffsets([])).rejects.toThrow(
      'write failed'
    );
  });
});

describe('ReviewManager on a file without frontmatter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('types it by the row at its path when fetched from its file', async () => {
    await fc.assert(
      fc.asyncProperty(binaryFileArb, itemTableArb, async (file, table) => {
        const { manager, row } = wireBinary(file, table);

        const item = await manager.getReviewItemFromFile(file);

        expect(item?.file ?? null).toBe(row && file);
        expect(item?.data.id ?? null).toBe(row && row.id);
        expect(item?.data.type ?? null).toBe(
          table === 'srs_card' ? 'card' : table
        );
      })
    );
  });

  it('never touches its content or frontmatter when it is renamed or created', async () => {
    await fc.assert(
      fc.asyncProperty(
        binaryFileArb,
        itemTableArb,
        fc.string(),
        async (file, table, oldPath) => {
          const { manager, touches } = wireBinary(file, table);

          await manager.handleExternalRename(file, oldPath);
          await manager.handleCreation(file);

          for (const touch of Object.values(touches)) {
            expect(touch).not.toHaveBeenCalled();
          }
        }
      )
    );
  });

  it('never reads or writes its content or frontmatter, whatever is called on it in whatever order', async () => {
    type Call = (
      wired: ReturnType<typeof wireBinary>,
      file: TFile
    ) => Promise<unknown>;
    const calls: Record<string, Call> = {
      updateFrontMatter: ({ app }, file) =>
        Obsidian.updateFrontMatter(file, { tags: 'ir-source' }, app as never),
      updateFrontMatterFn: ({ app }, file) =>
        Obsidian.updateFrontMatter(file, () => {}, app as never),
      getNoteType: ({ app }, file) => Obsidian.getNoteType(file, app as never),
      getItemType: ({ manager }, file) => manager.articles.getItemType(file),
      setFrontmatter: ({ manager }, file) =>
        manager.articles.setFrontmatter(file, 'id', 'ir-article'),
      fetch: ({ manager, row }) =>
        manager.getReviewItemFromId(row?.id ?? 'none'),
      getDue: ({ manager }) => manager.articles.getDue(),
      getReviewItemFromFile: ({ manager }, file) =>
        manager.getReviewItemFromFile(file),
      handleExternalRename: ({ manager }, file) =>
        manager.handleExternalRename(file, 'old.pdf'),
      handleCreation: ({ manager }, file) => manager.handleCreation(file),
      resolveItemContext: ({ app, manager, row }) =>
        resolveItemContext(app as never, manager, {
          data: { ...makeSnippetBase(), parent: row?.id ?? null },
          file: { path: 'snippets/s.md', extension: 'md' } as TFile,
        }),
    };
    await fc.assert(
      fc.asyncProperty(
        binaryFileArb,
        itemTableArb,
        fc.array(fc.constantFrom(...Object.keys(calls))),
        async (file, table, sequence) => {
          const wired = wireBinary(file, table);
          vi.spyOn(wired.manager.articles, 'fetchMany').mockResolvedValue(
            wired.row?.table === 'article' ? [wired.row as never] : []
          );

          for (const name of sequence) await calls[name](wired, file);
          // Let the fire-and-forget writes those started run
          await Promise.resolve();

          for (const touch of Object.values(wired.touches)) {
            expect(touch).not.toHaveBeenCalled();
          }
        }
      )
    );
  });
});

describe('ReviewManager tracking files without frontmatter by path', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('moves the row at the old path to the new one, children and history and all', async () => {
    const wired = wirePaths(['papers/a.pdf']);
    wired.insertArticle('a', 'papers/a.pdf');
    wired.insertChildren('a');
    wired.repo.mutate(
      'INSERT INTO article_review (id, article_id, review_time) VALUES ($1, $2, $3)',
      ['review-1', 'a', YEAR_2000_MS]
    );
    const highlights = [{ id: 'snippet-of-a', start: 1, end: 2 }];
    wired.manager.snippets.offsetTracker.loadHighlights(
      'papers/a.pdf',
      highlights as never
    );

    await wired.rename('papers/a.pdf', 'archive/b.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'archive/b.pdf', deleted: false },
    ]);
    expect(parentPaths(wired.repo)).toStrictEqual([
      ['snippet-of-a', 'archive/b.pdf'],
      ['card-of-a', 'archive/b.pdf'],
    ]);
    expect(
      wired.repo.query('SELECT article_id FROM article_review')
    ).toStrictEqual([{ article_id: 'a' }]);
    expect(
      wired.manager.snippets.offsetTracker.getHighlights('archive/b.pdf')
    ).toStrictEqual(highlights);
    for (const touch of Object.values(wired.touches)) {
      expect(touch).not.toHaveBeenCalled();
    }
  });

  it('gives a tombstone brought back by its file turning up the parentless snippets and cards taken from that file, and keeps it back if that fails', async () => {
    const wired = wirePaths([]);
    wired.insertArticle('old', 'b.pdf', true);
    const failure = new Error('db busy');
    const claim = vi
      .spyOn(wired.manager.articles, 'claimFromBinary')
      .mockRejectedValue(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await wired.create('b.pdf');

    expect(claim).toHaveBeenCalledExactlyOnceWith(
      wired.files.get('b.pdf'),
      'old'
    );
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'old', reference: 'b.pdf', deleted: false },
    ]);
  });

  it('claims nothing for a file renamed onto a tombstone or a rebound article’s old path, whose links name its old path', async () => {
    const wired = wirePaths(['other.pdf', 'more.pdf', 'new.pdf']);
    wired.insertArticle('old', 'b.pdf', true);
    wired.insertArticle('a', 'new.pdf');
    await recordRebind(
      wired.repo,
      { id: 'a', from: 'old.pdf', to: 'new.pdf' },
      Date.now()
    );
    Object.assign(wired.manager.app.vault, { adapter: makeLogAdapter() });
    const claim = vi.spyOn(wired.manager.articles, 'claimFromBinary');

    await wired.rename('other.pdf', 'b.pdf');
    await wired.rename('more.pdf', 'old.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'old.pdf', deleted: false },
      { id: 'old', reference: 'b.pdf', deleted: false },
    ]);
    expect(claim).not.toHaveBeenCalled();
  });

  it('claims nothing where no tombstone is brought back', async () => {
    const wired = wirePaths(['other.pdf']);
    wired.insertArticle('live', 'a.pdf');
    const claim = vi.spyOn(wired.manager.articles, 'claimFromBinary');

    await wired.create('c.pdf');
    await wired.rename('other.pdf', 'd.pdf');

    expect(claim).not.toHaveBeenCalled();
  });

  it('gives the articles the startup scan moved onto a PDF what was taken from it, and no other row', async () => {
    const wired = wirePaths(['b.pdf', 'n.md', 'c.pdf']);
    const claim = vi
      .spyOn(wired.manager.articles, 'claimFromBinary')
      .mockResolvedValue(undefined);

    await wired.manager.claimMovedFiles([
      { table: 'article', id: 'pdf', to: 'b.pdf' },
      { table: 'article', id: 'note', to: 'n.md' },
      { table: 'snippet', id: 'snippet', to: 'c.pdf' },
      { table: 'article', id: 'gone', to: 'nowhere.pdf' },
    ]);

    expect(claim).toHaveBeenCalledExactlyOnceWith(
      wired.files.get('b.pdf'),
      'pdf'
    );
  });

  it('re-points the links of only the moves whose file is there', async () => {
    const wired = wirePaths(['b.pdf']);
    const retarget = vi
      .spyOn(wired.manager.articles, 'retargetChildSources')
      .mockResolvedValue(0);

    await wired.manager.followChildSources([
      { id: 'gone', from: 'a.pdf', to: 'nowhere.pdf' },
      { id: 'here', from: 'a.pdf', to: 'b.pdf' },
    ]);

    expect(retarget).toHaveBeenCalledExactlyOnceWith(
      'here',
      'a.pdf',
      wired.files.get('b.pdf')
    );
  });

  it('leaves every other row where it is', async () => {
    const wired = wirePaths(['a.pdf', 'b.pdf']);
    wired.insertArticle('a', 'a.pdf');
    wired.insertArticle('b', 'b.pdf');
    wired.insertArticle('gone', 'gone.pdf', true);

    await wired.rename('a.pdf', 'c.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'c.pdf', deleted: false },
      { id: 'b', reference: 'b.pdf', deleted: false },
      { id: 'gone', reference: 'gone.pdf', deleted: true },
    ]);
  });

  it('brings back a row the rename shows still has its file', async () => {
    const wired = wirePaths(['a.pdf']);
    wired.insertArticle('a', 'a.pdf', true);

    await wired.rename('a.pdf', 'b.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'b.pdf', deleted: false },
    ]);
  });

  it('moves a row onto a tombstoned path, putting the tombstone aside', async () => {
    const wired = wirePaths(['a.pdf']);
    wired.insertArticle('a', 'a.pdf');
    wired.insertArticle('old', 'b.pdf', true);

    await wired.rename('a.pdf', 'b.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'b.pdf', deleted: false },
      {
        id: 'old',
        reference: evictedSpot({ table: 'article', id: 'old' }),
        deleted: true,
      },
    ]);
  });

  it('moves a row onto the path of a row whose file is missing, leaving that one live', async () => {
    const wired = wirePaths(['a.pdf']);
    wired.insertArticle('a', 'a.pdf');
    wired.insertArticle('missing', 'b.pdf');

    await wired.rename('a.pdf', 'b.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'b.pdf', deleted: false },
      {
        id: 'missing',
        reference: evictedSpot({ table: 'article', id: 'missing' }),
        deleted: false,
      },
    ]);
  });

  it('restores a tombstone when an untracked file is renamed onto its path', async () => {
    const wired = wirePaths(['other.pdf']);
    wired.insertArticle('old', 'b.pdf', true);

    await wired.rename('other.pdf', 'b.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'old', reference: 'b.pdf', deleted: false },
    ]);
  });

  it('leaves the row of a note renamed to a type with no frontmatter where it was', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('pdf', 'PDF', 'png', 'txt'),
        fc.constantFrom('md', 'MD'),
        fc.boolean(),
        async (extension, noteExtension, tombstoneAtTarget) => {
          const oldPath = `notes/a.${noteExtension}`;
          const newPath = `notes/a.${extension}`;
          const wired = wirePaths([oldPath]);
          wired.insertArticle('a', oldPath);
          if (tombstoneAtTarget) wired.insertArticle('old', newPath, true);
          const before = wired.repo.rows('article');
          const mutate = vi.spyOn(wired.repo, 'mutate');
          const transaction = vi.spyOn(wired.repo, 'transaction');

          await wired.rename(oldPath, newPath);

          expect(mutate).not.toHaveBeenCalled();
          expect(transaction).not.toHaveBeenCalled();
          expect(wired.repo.rows('article')).toStrictEqual(before);
        }
      )
    );
  });

  it('writes nothing to the database for a file that is no item', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.constantFrom('pdf', 'PDF', 'png', ''),
        async (from, to, extension) => {
          const oldPath = `${from}.${extension}`;
          const newPath = `new/${to}.${extension}`;
          const wired = wirePaths([oldPath]);
          wired.insertArticle('a', 'elsewhere.pdf');
          const mutate = vi.spyOn(wired.repo, 'mutate');
          const transaction = vi.spyOn(wired.repo, 'transaction');

          await wired.rename(oldPath, newPath);
          await wired.create(`created.${extension}`);

          expect(mutate).not.toHaveBeenCalled();
          expect(transaction).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('writes nothing for a rename that leaves a tracked file where it was', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (deleted) => {
        const wired = wirePaths(['a.pdf']);
        wired.insertArticle('a', 'a.pdf', deleted);
        const mutate = vi.spyOn(wired.repo, 'mutate');

        await wired.rename('a.pdf', 'a.pdf');

        expect(mutate).not.toHaveBeenCalled();
        expect(wired.repo.rows('article')).toStrictEqual([
          { id: 'a', reference: 'a.pdf', deleted },
        ]);
      })
    );
  });

  it('tombstones the row at the path of a deleted file, and nothing else', async () => {
    const wired = wirePaths(['a.pdf', 'b.pdf']);
    wired.insertArticle('a', 'a.pdf');
    wired.insertArticle('b', 'b.pdf');

    await wired.remove('a.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'a.pdf', deleted: true },
      { id: 'b', reference: 'b.pdf', deleted: false },
    ]);
  });

  it('restores the tombstone at the path a file is created at', async () => {
    const wired = wirePaths(['a.pdf']);
    wired.insertArticle('a', 'a.pdf');
    wired.insertArticle('b', 'b.pdf', true);

    await wired.remove('a.pdf');
    await wired.create('a.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'a.pdf', deleted: false },
      { id: 'b', reference: 'b.pdf', deleted: true },
    ]);
    for (const touch of Object.values(wired.touches)) {
      expect(touch).not.toHaveBeenCalled();
    }
  });

  describe('a file turning up where a startup rebind took an article from', () => {
    /** Article `a`, rebound by the startup scan from `old.pdf` to `new.pdf`. */
    async function rebound(others: string[] = []) {
      const wired = wirePaths(['new.pdf', ...others]);
      wired.insertArticle('a', 'new.pdf');
      await recordRebind(
        wired.repo,
        { id: 'a', from: 'old.pdf', to: 'new.pdf' },
        Date.now()
      );
      const adapter = makeLogAdapter();
      Object.assign(wired.manager.app.vault, { adapter });
      const renameFile = vi.spyOn(
        wired.manager.snippets.offsetTracker,
        'renameFile'
      );
      return { ...wired, adapter, renameFile };
    }

    it('takes the article back to its own file, and logs it', async () => {
      const wired = await rebound();

      await wired.create('old.pdf');

      expect(wired.repo.rows('article')).toStrictEqual([
        { id: 'a', reference: 'old.pdf', deleted: false },
      ]);
      expect(wired.renameFile).toHaveBeenCalledWith('new.pdf', 'old.pdf');
      expect(wired.adapter.write).toHaveBeenCalledWith(
        expect.stringMatching(/\/rebinds-\d{4}-\d{2}\.log$/),
        expect.stringContaining(
          describeReclaim({ id: 'a', from: 'new.pdf', to: 'old.pdf' })
        )
      );
      for (const touch of Object.values(wired.touches)) {
        expect(touch).not.toHaveBeenCalled();
      }
    });

    it("points its snippets' and cards' source links back at its own file", async () => {
      const wired = await rebound();
      const retarget = vi
        .spyOn(wired.manager.articles, 'retargetChildSources')
        .mockResolvedValue(0);

      await wired.create('old.pdf');

      expect(retarget).toHaveBeenCalledExactlyOnceWith(
        'a',
        'new.pdf',
        wired.files.get('old.pdf')
      );
    });

    it('gives the article the parentless snippets and cards taken from its own file meanwhile', async () => {
      const wired = await rebound();
      const claim = vi
        .spyOn(wired.manager.articles, 'claimFromBinary')
        .mockResolvedValue(undefined);

      await wired.create('old.pdf');

      expect(claim).toHaveBeenCalledExactlyOnceWith(
        wired.files.get('old.pdf'),
        'a'
      );
    });

    it('takes the article back when a file is moved onto the old path too', async () => {
      const wired = await rebound(['downloads/old.pdf']);

      await wired.rename('downloads/old.pdf', 'old.pdf');

      expect(wired.repo.rows('article')).toStrictEqual([
        { id: 'a', reference: 'old.pdf', deleted: false },
      ]);
      expect(wired.renameFile).toHaveBeenCalledWith('new.pdf', 'old.pdf');
    });

    it('restores a tombstone at that path instead, as its own file', async () => {
      const wired = await rebound();
      wired.insertArticle('b', 'old.pdf', true);

      await wired.create('old.pdf');

      expect(wired.repo.rows('article')).toStrictEqual([
        { id: 'a', reference: 'new.pdf', deleted: false },
        { id: 'b', reference: 'old.pdf', deleted: false },
      ]);
      expect(wired.renameFile).not.toHaveBeenCalled();
      expect(wired.adapter.write).not.toHaveBeenCalled();
    });
  });

  it('leaves a live row alone when a file arrives at its path', async () => {
    const wired = wirePaths(['other.pdf']);
    wired.insertArticle('live', 'a.pdf');
    const mutate = vi.spyOn(wired.repo, 'mutate');

    await wired.create('a.pdf');
    wired.files.delete('a.pdf');
    await wired.rename('other.pdf', 'a.pdf');

    expect(mutate).not.toHaveBeenCalled();
    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'live', reference: 'a.pdf', deleted: false },
    ]);
  });

  it('follows every file of a renamed folder, one event per child', async () => {
    const wired = wirePaths(['f/a.pdf', 'f/sub/b.pdf', 'g/a.pdf']);
    wired.insertArticle('a', 'f/a.pdf');
    wired.insertArticle('b', 'f/sub/b.pdf');
    wired.insertArticle('ga', 'g/a.pdf');
    wired.insertChildren('b');

    await wired.rename('f/sub/b.pdf', 'h/sub/b.pdf');
    await wired.rename('f/a.pdf', 'h/a.pdf');

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'h/a.pdf', deleted: false },
      { id: 'b', reference: 'h/sub/b.pdf', deleted: false },
      { id: 'ga', reference: 'g/a.pdf', deleted: false },
    ]);
    expect(parentPaths(wired.repo)).toStrictEqual([
      ['snippet-of-b', 'h/sub/b.pdf'],
      ['card-of-b', 'h/sub/b.pdf'],
    ]);
  });

  describe('over any sequence of renames, deletions and creations', () => {
    /** Few names in few folders, so moves keep landing on used paths. */
    const PATHS = [
      'a.pdf',
      'b.pdf',
      'f/a.pdf',
      'f/c.pdf',
      'g/a.pdf',
      'g/b.pdf',
    ];
    const FOLDERS = ['f', 'g', 'h'];

    type Op =
      | { kind: 'rename'; from: number; to: string }
      | { kind: 'moveFolder'; from: string; to: string }
      | { kind: 'delete'; at: number }
      | { kind: 'create'; at: string };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant('rename' as const),
        from: fc.nat(),
        to: fc.constantFrom(...PATHS),
      }),
      fc.record({
        kind: fc.constant('moveFolder' as const),
        from: fc.constantFrom(...FOLDERS),
        to: fc.constantFrom(...FOLDERS),
      }),
      fc.record({ kind: fc.constant('delete' as const), at: fc.nat() }),
      fc.record({
        kind: fc.constant('create' as const),
        at: fc.constantFrom(...PATHS),
      })
    );

    /** The starting paths, and whether each holds a tracked file. */
    const startArb = fc.subarray(PATHS, { minLength: 1 }).chain((paths) =>
      fc.tuple(
        fc.constant(paths),
        fc.array(fc.constantFrom('none', 'live', 'tombstone'), {
          minLength: paths.length,
          maxLength: paths.length,
        })
      )
    );

    it('ends with the row of each file at its path, and every row without one tombstoned', async () => {
      await fc.assert(
        fc.asyncProperty(
          startArb,
          fc.array(opArb, { maxLength: 20 }),
          async ([paths, tracked], ops) => {
            const wired = wirePaths(paths);
            // The row each file is, if any, which renames carry along; and the
            // row a file arriving at a tombstoned path takes back
            const rowOf = new Map<TFile, string>();
            const tombstones = new Map<string, string>();
            // A tombstone starts with no file at its path, left by a deletion
            paths.forEach((path, i) => {
              if (tracked[i] === 'none') return;
              const tombstoned = tracked[i] === 'tombstone';
              wired.insertArticle(`row-${i}`, path, tombstoned);
              if (tombstoned) {
                wired.files.delete(path);
                tombstones.set(path, `row-${i}`);
              } else {
                rowOf.set(wired.files.get(path)!, `row-${i}`);
              }
            });

            const arrive = (file: TFile) => {
              const row = tombstones.get(file.path);
              if (row === undefined) return;
              tombstones.delete(file.path);
              if (!rowOf.has(file)) rowOf.set(file, row);
            };
            for (const op of ops) {
              const present = [...wired.files.keys()];
              if (op.kind === 'rename') {
                const from = present[op.from % present.length];
                if (from === undefined || wired.files.has(op.to)) continue;
                const file = wired.files.get(from)!;
                await wired.rename(from, op.to);
                arrive(file);
              } else if (op.kind === 'moveFolder') {
                const inside = (folder: string) =>
                  present.filter((path) => path.startsWith(`${folder}/`));
                if (op.from === op.to || inside(op.to).length > 0) continue;
                for (const from of inside(op.from)) {
                  const file = wired.files.get(from)!;
                  await wired.rename(from, `${op.to}${from.slice(1)}`);
                  arrive(file);
                }
              } else if (op.kind === 'delete') {
                const at = present[op.at % present.length];
                if (at === undefined) continue;
                const row = rowOf.get(wired.files.get(at)!);
                if (row !== undefined) tombstones.set(at, row);
                await wired.remove(at);
              } else {
                if (wired.files.has(op.at)) continue;
                await wired.create(op.at);
                arrive(wired.files.get(op.at)!);
              }
            }

            const rows = wired.repo.rows('article');
            // No row is ever lost, only moved or tombstoned
            expect(rows.map(({ id }) => id).sort()).toStrictEqual(
              tracked.flatMap((state, i) =>
                state === 'none' ? [] : [`row-${i}`]
              )
            );
            const expected = new Map<string, string>();
            for (const [file, row] of rowOf) {
              if (wired.files.get(file.path) === file)
                expected.set(row, file.path);
            }
            for (const row of rows) {
              if (expected.has(row.id)) {
                expect(row).toStrictEqual({
                  id: row.id,
                  reference: expected.get(row.id),
                  deleted: false,
                });
              } else {
                expect(row.deleted).toBe(true);
              }
            }
            for (const touch of Object.values(wired.touches)) {
              expect(touch).not.toHaveBeenCalled();
            }
          }
        )
      );
    });
  });
});

describe('ReviewManager following source links on rename', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves a renamed article's row at once, and its children's links once Obsidian's link update ahead is done", async () => {
    const wired = wireRenames({
      'IR/articles/A.md': note('art', ARTICLE_TAG),
      'IR/snippets/s.md': note('s', SNIPPET_TAG, '[[IR/articles/A|A]]'),
      'IR/cards/c.md': note('c', CARD_TAG, '[A](IR/articles/A.md)'),
    });
    wired.insert('article', 'art', 'IR/articles/A.md');
    wired.insert('snippet', 's', 'IR/snippets/s.md', 'art');
    wired.insert('srs_card', 'c', 'IR/cards/c.md', 'art');

    const release = wired.hold();
    await wired.rename('IR/articles/A.md', 'IR/articles/B.md');
    await new Promise((done) => setTimeout(done, 0));

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'art', reference: 'IR/articles/B.md', deleted: false },
    ]);
    expect(wired.sourceOf('IR/snippets/s.md')).toBe('[[IR/articles/A|A]]');

    release();
    await wired.drained();
    expect(wired.sourceOf('IR/snippets/s.md')).toBe('[[IR/articles/B|B]]');
    expect(wired.sourceOf('IR/cards/c.md')).toBe('[B](IR/articles/B.md)');
  });

  it('re-points the parentless snippets and cards of a renamed plain note and a plain PDF, and moves their highlights', async () => {
    const wired = wireRenames({
      'notes/N.md': {},
      'papers/P.pdf': null,
      'IR/snippets/s.md': note(
        's',
        SNIPPET_TAG,
        '[[papers/P.pdf#page=1|P, page 1]]'
      ),
      'IR/snippets/t.md': note('t', SNIPPET_TAG, '[[notes/N|N]]'),
      'IR/cards/c.md': note('c', CARD_TAG, '[[notes/N]]'),
    });
    wired.insert('snippet', 's', 'IR/snippets/s.md');
    wired.insert('snippet', 't', 'IR/snippets/t.md');
    wired.insert('srs_card', 'c', 'IR/cards/c.md');
    const tracker = wired.manager.snippets.offsetTracker;
    const highlight = (id: string) => ({ id, start: 1, end: 2 }) as never;
    tracker.loadHighlights('papers/P.pdf', [highlight('s')]);
    tracker.loadHighlights('notes/N.md', [highlight('t')]);

    await wired.rename('papers/P.pdf', 'archive/Q.pdf');
    await wired.rename('notes/N.md', 'archive/M.md');
    await wired.drained();

    expect(wired.sourceOf('IR/snippets/s.md')).toBe(
      '[[archive/Q.pdf#page=1|Q, page 1]]'
    );
    expect(wired.sourceOf('IR/snippets/t.md')).toBe('[[archive/M|M]]');
    expect(wired.sourceOf('IR/cards/c.md')).toBe('[[archive/M]]');
    expect(tracker.getHighlights('archive/Q.pdf')).toStrictEqual([
      highlight('s'),
    ]);
    expect(tracker.getHighlights('archive/M.md')).toStrictEqual([
      highlight('t'),
    ]);
  });

  it("points an article PDF's children at where it went, an alias that was its name taking the new one", async () => {
    const wired = wireRenames({
      'papers/P.pdf': null,
      'IR/snippets/s.md': note(
        's',
        SNIPPET_TAG,
        '[[papers/P.pdf#page=3|P, page 3]]'
      ),
      'IR/cards/c.md': note('c', CARD_TAG, '[[papers/P.pdf|my words]]'),
    });
    wired.insert('article', 'pdf', 'papers/P.pdf');
    wired.insert('snippet', 's', 'IR/snippets/s.md', 'pdf');
    wired.insert('srs_card', 'c', 'IR/cards/c.md', 'pdf');

    await wired.rename('papers/P.pdf', 'archive/Q.pdf');
    await wired.drained();

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'pdf', reference: 'archive/Q.pdf', deleted: false },
    ]);
    expect(wired.sourceOf('IR/snippets/s.md')).toBe(
      '[[archive/Q.pdf#page=3|Q, page 3]]'
    );
    expect(wired.sourceOf('IR/cards/c.md')).toBe('[[archive/Q.pdf|my words]]');
  });

  it("re-points a moved item note's own relative link that its move broke", async () => {
    const wired = wireRenames({
      'papers/P.pdf': null,
      'notes/c.md': note('c', CARD_TAG, '[[../papers/P.pdf]]'),
    });
    wired.insert('srs_card', 'c', 'notes/c.md');

    await wired.rename('notes/c.md', 'a/b/c.md');
    await wired.drained();

    expect(wired.repo.rows('srs_card')).toStrictEqual([
      { id: 'c', reference: 'a/b/c.md', deleted: false },
    ]);
    expect(wired.sourceOf('a/b/c.md')).toBe('[[papers/P.pdf]]');
  });

  it("follows every file of a renamed folder in one pass once Obsidian's update is done", async () => {
    const wired = wireRenames({
      'f/a.md': {},
      'f/b.pdf': null,
      'f/c.md': note('art', ARTICLE_TAG),
      'IR/snippets/s.md': note('s', SNIPPET_TAG, '[[f/a]]'),
      'IR/cards/c.md': note('c', CARD_TAG, '[[f/b.pdf]]'),
    });
    wired.insert('article', 'art', 'f/c.md');
    wired.insert('snippet', 's', 'IR/snippets/s.md');
    wired.insert('srs_card', 'c', 'IR/cards/c.md');
    const query = vi.spyOn(wired.repo, 'query');

    const release = wired.hold();
    await wired.rename('f/a.md', 'g/a.md');
    await wired.rename('f/b.pdf', 'g/b.pdf');
    await wired.rename('f/c.md', 'g/c.md');
    release();
    await wired.drained();

    expect(wired.sourceOf('IR/snippets/s.md')).toBe('[[g/a]]');
    expect(wired.sourceOf('IR/cards/c.md')).toBe('[[g/b.pdf]]');
    const scans = query.mock.calls.filter(([sql]) =>
      sql.includes('parent IS NULL')
    );
    expect(scans).toHaveLength(1);
    // One job of its own after the rename's
    expect(wired.updateQueue.queue).toHaveBeenCalledTimes(2);
  });

  it('writes nothing to a note whose link Obsidian updated meanwhile', async () => {
    const wired = wireRenames({
      'notes/N.md': {},
      'IR/snippets/s.md': note('s', SNIPPET_TAG, '[[notes/N|N]]'),
    });
    wired.insert('snippet', 's', 'IR/snippets/s.md');

    const release = wired.hold();
    await wired.rename('notes/N.md', 'notes/M.md');
    // "Just once" on Obsidian's prompt, which keeps the alias
    const snippet = wired.files.get('IR/snippets/s.md')!;
    await wired.processFrontMatter(snippet, (fm) => {
      fm.source = '[[notes/M|N]]';
    });
    wired.processFrontMatter.mockClear();
    release();
    await wired.drained();

    expect(wired.sourceOf('IR/snippets/s.md')).toBe('[[notes/M|N]]');
    expect(wired.processFrontMatter).not.toHaveBeenCalled();
  });

  it('logs links it cannot re-point, and keeps the row where it went', async () => {
    const wired = wireRenames({
      'papers/P.pdf': null,
      'IR/snippets/s.md': note('s', SNIPPET_TAG, '[[papers/P.pdf]]'),
    });
    wired.insert('article', 'pdf', 'papers/P.pdf');
    wired.insert('snippet', 's', 'IR/snippets/s.md', 'pdf');
    const failure = new Error('bad YAML');
    vi.spyOn(wired.manager.articles, 'retargetSources').mockRejectedValue(
      failure
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await wired.rename('papers/P.pdf', 'b.pdf');
    await wired.drained();

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'pdf', reference: 'b.pdf', deleted: false },
    ]);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('follows nothing for a rename that leaves a file where it was, of a file no item can be taken from, or that changes its type', async () => {
    const wired = wireRenames({
      'img/a.png': null,
      'notes/N.md': {},
      'notes/X.md': {},
      'papers/P.pdf': null,
      'IR/articles/A.md': note('art', ARTICLE_TAG),
      'IR/cards/x.md': note('x', CARD_TAG, '[[notes/X]]'),
      'IR/cards/p.md': note('p', CARD_TAG, '[[papers/P.pdf]]'),
    });
    wired.insert('article', 'art', 'IR/articles/A.md');
    wired.insert('srs_card', 'x', 'IR/cards/x.md');
    wired.insert('srs_card', 'p', 'IR/cards/p.md');
    const retarget = vi.spyOn(wired.manager.articles, 'retargetSources');
    const query = vi.spyOn(wired.repo, 'query');

    await wired.rename('img/a.png', 'img/b.png');
    await wired.rename('notes/N.md', 'notes/N.md');
    await wired.rename('IR/articles/A.md', 'IR/articles/A.md');
    await wired.rename('notes/X.md', 'notes/X.pdf');
    await wired.rename('papers/P.pdf', 'papers/P.md');
    await wired.drained();

    expect(retarget).not.toHaveBeenCalled();
    expect(
      query.mock.calls.filter(([sql]) => sql.includes('parent IS NULL'))
    ).toStrictEqual([]);
    expect(wired.sourceOf('IR/cards/x.md')).toBe('[[notes/X]]');
    expect(wired.sourceOf('IR/cards/p.md')).toBe('[[papers/P.pdf]]');
  });

  it("re-points a renamed snippet note's own snippets and cards", async () => {
    const wired = wireRenames({
      'IR/snippets/s.md': note('s', SNIPPET_TAG),
      'IR/snippets/t.md': note('t', SNIPPET_TAG, '[[IR/snippets/s|s]]'),
      'IR/cards/c.md': note('c', CARD_TAG, '[[IR/snippets/s]]'),
    });
    wired.insert('snippet', 's', 'IR/snippets/s.md');
    wired.insert('snippet', 't', 'IR/snippets/t.md', 's');
    wired.insert('srs_card', 'c', 'IR/cards/c.md', 's');

    await wired.rename('IR/snippets/s.md', 'IR/snippets/renamed.md');
    await wired.drained();

    expect(wired.repo.rows('snippet')).toContainEqual({
      id: 's',
      reference: 'IR/snippets/renamed.md',
      deleted: false,
    });
    expect(wired.sourceOf('IR/snippets/t.md')).toBe(
      '[[IR/snippets/renamed|renamed]]'
    );
    expect(wired.sourceOf('IR/cards/c.md')).toBe('[[IR/snippets/renamed]]');
  });

  it('re-points the children of a renamed article note that carries no ir-id, found by its path', async () => {
    const wired = wireRenames({
      'IR/articles/A.md': { tags: [ARTICLE_TAG] },
      'IR/snippets/s.md': note('s', SNIPPET_TAG, '[[IR/articles/A]]'),
    });
    wired.insert('article', 'art', 'IR/articles/A.md');
    wired.insert('snippet', 's', 'IR/snippets/s.md', 'art');

    await wired.rename('IR/articles/A.md', 'IR/articles/B.md');
    await wired.drained();

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'art', reference: 'IR/articles/B.md', deleted: false },
    ]);
    expect(wired.sourceOf('IR/snippets/s.md')).toBe('[[IR/articles/B]]');
  });

  it("follows every file of a renamed folder in one pass, though Obsidian's queue is idle and each file's handler takes its time", async () => {
    const wired = wireRenames({
      'f/a.md': {},
      'f/s.md': note('s', SNIPPET_TAG, '[[f/a]]'),
    });
    wired.insert('snippet', 's', 'IR/whatever.md');
    wired.repo.mutate('UPDATE snippet SET reference = $1 WHERE id = $2', [
      'f/s.md',
      's',
    ]);
    const query = vi.spyOn(wired.repo, 'query');

    // Fired together, as Obsidian fires a folder's events, the source first
    const renaming = [
      wired.rename('f/a.md', 'g/a.md'),
      wired.rename('f/s.md', 'g/s.md'),
    ];
    await Promise.all(renaming);
    await wired.drained();

    expect(wired.sourceOf('g/s.md')).toBe('[[g/a]]');
    expect(
      query.mock.calls.filter(([sql]) => sql.includes('parent IS NULL'))
    ).toHaveLength(1);
  });

  it("puts back a rebound article's links when a file is renamed onto its old path, once Obsidian's link update is done", async () => {
    const wired = wireRenames({
      'new.pdf': null,
      'downloads/old.pdf': null,
      'IR/snippets/s.md': note(
        's',
        SNIPPET_TAG,
        '[[new.pdf#page=1|new, page 1]]'
      ),
    });
    Object.assign(wired.app.vault, { adapter: makeLogAdapter() });
    wired.insert('article', 'a', 'new.pdf');
    wired.insert('snippet', 's', 'IR/snippets/s.md', 'a');
    await recordRebind(
      wired.repo,
      { id: 'a', from: 'old.pdf', to: 'new.pdf' },
      Date.now()
    );

    const release = wired.hold();
    await wired.rename('downloads/old.pdf', 'old.pdf');
    await new Promise((done) => setTimeout(done, 0));
    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'old.pdf', deleted: false },
    ]);
    expect(wired.sourceOf('IR/snippets/s.md')).toBe(
      '[[new.pdf#page=1|new, page 1]]'
    );

    release();
    await wired.drained();
    // Its parent's, though `new.pdf` is still there to take the link
    expect(wired.sourceOf('IR/snippets/s.md')).toBe(
      '[[old.pdf#page=1|old, page 1]]'
    );
  });

  it('follows a rename only where the file went somewhere else and stays the type, a note or a PDF, it was, for every pair of extensions', async () => {
    const EXTENSIONS = ['md', 'MD', 'Md', 'pdf', 'PDF', 'png', 'txt', ''];
    const name = (folder: string, extension: string) =>
      extension === '' ? `${folder}/a` : `${folder}/a.${extension}`;
    const typeOf = (extension: string) =>
      ({ md: 'note', pdf: 'pdf' })[extension.toLowerCase()] ?? null;

    // Every case, few as they are, rather than a sample of them
    const cases = EXTENSIONS.flatMap((fromExtension) =>
      EXTENSIONS.flatMap((toExtension) =>
        [false, true].map((moves) => ({ fromExtension, toExtension, moves }))
      )
    );
    for (const { fromExtension, toExtension, moves } of cases) {
      vi.restoreAllMocks();
      const from = name('f', fromExtension);
      const to = name(moves ? 'g' : 'f', toExtension);
      const wired = wireRenames({
        [from]: typeOf(fromExtension) === 'note' ? {} : null,
      });
      const query = vi.spyOn(wired.repo, 'query');

      await wired.rename(from, to);
      await wired.drained();

      const followed =
        from !== to &&
        typeOf(fromExtension) !== null &&
        typeOf(fromExtension) === typeOf(toExtension);
      expect(
        query.mock.calls.filter(([sql]) => sql.includes('parent IS NULL'))
      ).toHaveLength(followed ? 1 : 0);
    }
  });

  it('follows nothing for a rename it fails on, leaving the failure to its caller alone', async () => {
    const wired = wireRenames({ 'notes/N.md': {} });
    const retarget = vi.spyOn(wired.manager.articles, 'retargetSources');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const release = wired.hold();
      const file = wired.move('notes/N.md', 'notes/M.md');
      wired.files.delete('notes/M.md');

      await expect(
        wired.manager.handleExternalRename(file, 'notes/N.md')
      ).rejects.toThrow('Failed to find a file at notes/M.md');
      // Long enough for Node to call a rejection no one handles unhandled
      await new Promise((done) => setTimeout(done, 10));
      release();
      await wired.drained();

      expect(unhandled).not.toHaveBeenCalled();
      expect(retarget).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('logs each row whose links it cannot re-point at once, and goes on to the next', async () => {
    const wired = wireRenames({ 'a.pdf': null, 'b.pdf': null });
    const failure = new Error('bad YAML');
    const retarget = vi
      .spyOn(wired.manager.articles, 'retargetChildSources')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await wired.manager.followChildSources([
      { id: 'first', from: 'x.pdf', to: 'a.pdf' },
      { id: 'second', from: 'y.pdf', to: 'b.pdf' },
    ]);

    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(retarget).toHaveBeenLastCalledWith(
      'second',
      'y.pdf',
      wired.files.get('b.pdf')
    );
  });
});

describe('ReviewManager reads the frontmatter of a renamed or created note without writing it', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('follows a renamed item note by its tags and ir-id, never writing a note', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb,
        fc.boolean(),
        fc.boolean(),
        async (table, carriesId, lone) => {
          const tag = TABLE_TAG[table];
          const wired = wireRenames({
            'IR/a.md': {
              ...(carriesId ? { 'ir-id': 'row' } : {}),
              // A lone string, as a hand-written note can have it
              tags: lone ? tag : [tag],
            },
          });
          wired.insert(table, 'row', 'IR/a.md');

          await wired.rename('IR/a.md', 'IR/b.md');
          await wired.drained();

          expect(wired.repo.rows(table)).toStrictEqual([
            { id: 'row', reference: 'IR/b.md', deleted: false },
          ]);
          expect(wired.processFrontMatter).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('restores the row of a note created with its ir-id, never writing the note', async () => {
    await fc.assert(
      fc.asyncProperty(tableArb, fc.boolean(), async (table, lone) => {
        const tag = TABLE_TAG[table];
        const wired = wireRenames({});
        wired.insert(table, 'row', 'IR/gone.md');
        wired.repo.mutate(`UPDATE ${table} SET deleted = TRUE WHERE id = $1`, [
          'row',
        ]);

        const file = wired.add('IR/back.md', {
          'ir-id': 'row',
          tags: lone ? tag : [tag],
        });
        await wired.manager.handleCreation(file);

        expect(wired.repo.rows(table)).toStrictEqual([
          { id: 'row', reference: 'IR/back.md', deleted: false },
        ]);
        expect(wired.processFrontMatter).not.toHaveBeenCalled();
      })
    );
  });

  it('leaves the rows alone for a created note with no ir-id, or no type tag', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb,
        fc.oneof(
          fc.constant({ tags: ['ir-article'] }),
          fc.constant({ 'ir-id': 'row', tags: ['other'] }),
          fc.constant({ 'ir-id': 'row' }),
          // Not an id: a number matches no row by id
          fc.constant({ 'ir-id': 7, tags: ['ir-article'] }),
          fc.constant({ 'ir-id': '', tags: ['ir-article'] })
        ),
        async (table, frontmatter) => {
          const wired = wireRenames({});
          wired.insert(table, 'row', 'IR/gone.md');
          wired.repo.mutate(
            `UPDATE ${table} SET deleted = TRUE WHERE id = $1`,
            ['row']
          );
          const mutate = vi.spyOn(wired.repo, 'mutate');

          await wired.manager.handleCreation(
            wired.add('IR/back.md', frontmatter)
          );

          expect(mutate).not.toHaveBeenCalled();
          expect(wired.processFrontMatter).not.toHaveBeenCalled();
        }
      )
    );
  });
});

describe('ReviewManager.isItemFileAt', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers at once that a note is an item's only at a live row's path, carrying that row's ir-id", () => {
    fc.assert(
      fc.property(
        fc.constantFrom('article', 'snippet', 'srs_card' as const),
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
        fc.oneof(fc.constant('x'), fc.jsonValue()),
        fc.boolean(),
        fc.boolean(),
        (table, segments, irId, deleted, sameNote) => {
          const reference = `${segments.join('/')}.md`;
          const asked = sameNote ? reference : `other/${reference}`;
          const { files, manager } = wireItem(
            table,
            reference,
            { [asked]: { 'ir-id': irId } },
            deleted
          );

          expect(manager.isItemFileAt(files.get(asked)!, asked)).toBe(
            !deleted && sameNote && irId === 'x'
          );
        }
      )
    );
  });

  it('knows a file with no frontmatter by its path alone', () => {
    fc.assert(
      fc.property(
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        fc.boolean(),
        (segments, deleted, samePath) => {
          const reference = `${segments.join('/')}.pdf`;
          const asked = samePath ? reference : `other/${reference}`;
          const { files, manager } = wireItem(
            'article',
            reference,
            {
              [asked]: null,
            },
            deleted
          );

          expect(manager.isItemFileAt(files.get(asked)!, asked)).toBe(
            !deleted && samePath
          );
        }
      )
    );
  });

  it("answers no for a repository that can't answer at once, which a rename event can't wait on", () => {
    const vault = makeLinkVault({ 'articles/x.md': { 'ir-id': 'x' } });
    const repo = makeRepo();
    (repo.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'x' }]);
    const manager = new ReviewManager(makePlugin(vault.app), repo);

    expect(
      manager.isItemFileAt(vault.files.get('articles/x.md')!, 'articles/x.md')
    ).toBe(false);
    expect(manager.referencesUnder('articles')).toStrictEqual(new Set());
  });
});

describe('ReviewManager.handleDeletion at the path the database has', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  it('marks the row at the path it is given deleted, not one at where the file was deleted from', async () => {
    const wired = wirePaths(['x|y/a.pdf']);
    wired.insertArticle('a', 'xy/a.pdf');
    wired.insertArticle('b', 'x|y/a.pdf');

    await wired.manager.handleDeletion(
      wired.files.get('x|y/a.pdf')!,
      'xy/a.pdf'
    );

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'a', reference: 'xy/a.pdf', deleted: true },
      { id: 'b', reference: 'x|y/a.pdf', deleted: false },
    ]);
  });
});

describe('ReviewManager.referencesUnder', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  it('names every path at any depth in a folder that a live row of any table holds, and no other', () => {
    const tables = ['article', 'snippet', 'srs_card'] as const;
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            path: pathArb,
            table: fc.constantFrom(...tables),
            deleted: fc.boolean(),
          }),
          { selector: ({ path }) => path, maxLength: 8 }
        ),
        fc.oneof(pathArb, fc.constantFrom('a', 'a/b')),
        (rows, folder) => {
          const wired = wireRenames({});
          rows.forEach(({ path, table, deleted }, i) => {
            wired.insert(table, `row-${i}`, path);
            if (deleted) {
              wired.repo.mutate(
                `UPDATE ${table} SET deleted = TRUE WHERE id = $1`,
                [`row-${i}`]
              );
            }
          });

          expect(wired.manager.referencesUnder(folder)).toStrictEqual(
            new Set(
              rows
                .filter(
                  ({ path, deleted }) =>
                    !deleted && path.startsWith(`${folder}/`)
                )
                .map(({ path }) => path)
            )
          );
        }
      )
    );
  });
});

describe('ReviewManager.handleCreation reports an item arriving where its path breaks links', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  it.each([
    ['moved to a path that breaks links', 'a.md', false, 'x|y/a.md', true],
    ['moved to a plain path', 'a.md', false, 'xy/a.md', false],
    ['brought back where it breaks links', 'x|y/a.md', true, 'x|y/a.md', true],
    ['made again where it already was', 'x|y/a.md', false, 'x|y/a.md', false],
  ])('for a note %s', async (_, reference, deleted, arrives, reported) => {
    const wired = wireRenames({});
    wired.insert('article', 'x', reference);
    if (deleted) {
      wired.repo.mutate(`UPDATE article SET deleted = TRUE WHERE id = 'x'`);
    }

    const refused = await wired.manager.handleCreation(
      wired.add(arrives, note('x', ARTICLE_TAG))
    );

    expect(wired.repo.rows('article')).toStrictEqual([
      { id: 'x', reference: arrives, deleted: false },
    ]);
    expect(refused).toBe(reported ? arrives : null);
  });

  it('reports nothing for a note no row is waiting for, or one that is a copy', async () => {
    const wired = wireRenames({ 'a.md': note('x', ARTICLE_TAG) });
    wired.insert('article', 'x', 'a.md');

    expect(
      await wired.manager.handleCreation(
        wired.add('x|y/copy.md', note('x', ARTICLE_TAG))
      )
    ).toBeNull();
    expect(
      await wired.manager.handleCreation(
        wired.add('x|y/b.md', note('nobody', ARTICLE_TAG))
      )
    ).toBeNull();
    expect(
      await wired.manager.handleCreation(wired.add('x|y/plain.md', null))
    ).toBeNull();
  });

  it.each([
    ['p|q.pdf', true, 'p|q.pdf'],
    ['pq.pdf', true, null],
    ['p|q.pdf', false, null],
  ])(
    'for a file with no frontmatter at %s, a tombstone there: %s',
    async (path, tombstone, reported) => {
      const wired = wirePaths([]);
      if (tombstone) wired.insertArticle('x', path, true);

      expect(await wired.create(path)).toBe(reported);
    }
  );

  it('reports nothing for a file that is gone again', async () => {
    const wired = wirePaths([]);

    expect(
      await wired.manager.handleCreation({ path: 'x|y.pdf' } as TFile)
    ).toBeNull();
  });
});

describe('ReviewManager.itemPathsWithRefusedChars', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  it("lists, in order, every live item's path holding a refused character whose file is there", async () => {
    const wired = wireRenames({
      'b|card.md': note('card', CARD_TAG),
      'x>y/snippet.md': note('snippet', SNIPPET_TAG),
      'a#b.pdf': null,
      'gone#.md': null,
      'plain.md': note('plain', ARTICLE_TAG),
      'dead|.md': note('dead', ARTICLE_TAG),
      'not hers#.md': { 'ir-id': 'someone else' },
    });
    wired.insert('srs_card', 'card', 'b|card.md');
    wired.insert('snippet', 'snippet', 'x>y/snippet.md');
    wired.insert('article', 'pdf', 'a#b.pdf');
    wired.insert('article', 'plain', 'plain.md');
    wired.insert('article', 'dead', 'dead|.md');
    wired.repo.mutate(`UPDATE article SET deleted = TRUE WHERE id = 'dead'`);
    wired.insert('article', 'missing', 'missing#.md');
    wired.insert('article', 'hers', 'not hers#.md');
    // Its file is no note: the path names nothing
    wired.files.delete('gone#.md');

    expect(await wired.manager.itemPathsWithRefusedChars()).toStrictEqual([
      'a#b.pdf',
      'b|card.md',
      'x>y/snippet.md',
    ]);
  });
});
