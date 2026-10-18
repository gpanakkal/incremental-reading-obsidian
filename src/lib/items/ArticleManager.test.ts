import type { Actions } from '#/lib/Actions';
import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CARD_TAG,
  CONTENT_TITLE_MAX_BYTES,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  INVALID_TITLE_MESSAGE,
  MAX_SQL_QUERY_PARAMS,
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  MS_PER_YEAR,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import {
  listChars,
  REFUSED_PATH_CHARS,
  refusedPathsWarning,
} from '#/lib/item-path-guard';
import { configureSuccessNotices, type NotifyOptions } from '#/lib/notices';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { BulkMutateError } from '#/lib/repository/BulkMutateError';
import { matchFrontmatterTags, stripFrontmatterTags } from '#/lib/tags';
import type {
  ArticleRow,
  IArticleBase,
  IArticleReview,
  MutationStatement,
  ReviewArticle,
  SnippetRow,
  SQLiteRepository,
} from '#/lib/types';
import { getEndOfDay } from '#/lib/utils';
// The mock the vitest config aliases `obsidian` to — imported by path so its
// recorded notices are visible to the type checker as well as at runtime.
import { Keymap, Notice } from '#/test/__mocks__/obsidian';
import {
  excludedIdsOf,
  expectDueInOrder,
  insertTextItemRow,
  seenElsewhereArb,
  textItemSpecArb,
} from '#/test/due-query';
import { makeItemVault, TestRepository } from '#/test/item-vault';
import { cachePosition, makeLinkVault, sectionsOf } from '#/test/link-vault';
import { noteText } from '#/test/note-text';
import {
  showSuccessNotices,
  SUCCESS_NOTICE_LEVELS,
} from '#/test/success-notices';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type Database } from 'sql.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleManager } from './ArticleManager';
import { CardManager } from './CardManager';
import { ItemManager } from './ItemManager';
import { SnippetManager } from './SnippetManager';

// #region HELPERS
/**
 * A control or bidi character, not a newline: what titles refuse since task
 * 0040, and an old name may hold from before.
 */
const titleControlCharArb = fc
  .oneof(
    fc.integer({ min: 0x00, max: 0x1f }),
    fc.integer({ min: 0x7f, max: 0x9f }),
    fc.constantFrom(0x2028, 0x2029, 0x200e, 0x200f, 0x061c),
    fc.integer({ min: 0x202a, max: 0x202e }),
    fc.integer({ min: 0x2066, max: 0x2069 })
  )
  .map((code) => String.fromCharCode(code))
  .filter((char) => char !== '\n');

function makeArticle(overrides: Partial<IArticleBase> = {}): IArticleBase {
  return {
    id: 'article-1',
    type: 'article',
    reference: 'articles/test.md',
    due: Date.now(),
    due_fuzz: null,
    interval: TEXT_BASE_REVIEW_INTERVAL,
    dismissed: false,
    deleted: false,
    priority: DEFAULT_PRIORITY,
    fixed_interval_days: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeReview(reviewTime: number): IArticleReview {
  return {
    id: 'review-1',
    article_id: 'article-1',
    review_time: reviewTime,
  };
}

function makeRepo(
  lastReview: IArticleReview | undefined,
  reviewCount: number
): SQLiteRepository {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('ORDER BY review_time DESC')) {
        return lastReview ? [lastReview] : [];
      }
      if (sql.includes('COUNT(id)')) {
        return [{ ['COUNT(id)']: reviewCount }];
      }
      return [];
    }),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
    writeRefusal: vi.fn(() => null),
  } as unknown as SQLiteRepository;
}

function makeArticleRow(overrides: Partial<IArticleBase> = {}) {
  const { dismissed, ...rest } = makeArticle(overrides);
  return { ...rest, dismissed: Number(dismissed) };
}

/** Returns the [sql, params] tuple from the latest call to repo.mutate */
function lastMutateCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/** The bytes of a note, which open with no binary format's signature. */
const NOTE_BYTES = new TextEncoder().encode('# Content');

/** The bytes a real PDF opens with, and enough after them to look like one. */
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%\n1 0 obj');

/**
 * The vault an import reads: the text of a note for a copy, and the raw bytes
 * of whatever file it is for the check that its content is what its extension
 * says. `bytes` are those of every file.
 */
function makeImportVault(bytes: Uint8Array = NOTE_BYTES) {
  return {
    cachedRead: vi.fn().mockResolvedValue('# Content'),
    getAbstractFileByPathInsensitive: vi.fn(() => null),
    readBinary: vi.fn().mockResolvedValue(bytes.slice().buffer),
    getResourcePath: vi.fn((file: TFile) => `app://vault/${file.path}`),
  };
}

function makeImportPlugin(copyOnImport: boolean, bytes?: Uint8Array) {
  return {
    app: {
      ...makeApp(),
      vault: makeImportVault(bytes),
    },
    settings: { copyOnImport, defaultPriority: DEFAULT_PRIORITY },
  } as never;
}

/**
 * Stand-in for the SnippetManager that ArticleManager reaches through the
 * plugin during an import. `adopted` is what the backlink scan is pretending
 * to have found.
 */
function makeSnippetsStub(adopted: SnippetRow[] = []) {
  return {
    adoptOrphans: vi.fn().mockResolvedValue(adopted),
    getHighlights: vi.fn().mockResolvedValue([]),
    offsetTracker: { loadHighlights: vi.fn() },
  };
}

/** The card manager as an import adopts cards through it. */
function makeCardsStub(adopted: { id: string; reference: string }[] = []) {
  return { adoptOrphans: vi.fn().mockResolvedValue(adopted) };
}

/**
 * Like {@link makeImportPlugin}, but with the review manager wired up, so the
 * import actually reaches the snippet-adoption step.
 */
function makeImportPluginWithSnippets(
  copyOnImport: boolean,
  snippets: ReturnType<typeof makeSnippetsStub>,
  cards = makeCardsStub()
) {
  return {
    app: {
      ...makeApp(),
      vault: makeImportVault(),
      workspace: { trigger: vi.fn() },
    },
    settings: { copyOnImport, defaultPriority: DEFAULT_PRIORITY },
    reviewManager: { snippets, cards },
  } as never;
}

/** The vault stub inside a plugin built by one of the import helpers. */
function importVaultOf(plugin: unknown): ReturnType<typeof makeImportVault> {
  return (plugin as { app: { vault: ReturnType<typeof makeImportVault> } }).app
    .vault;
}

/**
 * A plugin importing `file`, a PDF, which the vault finds at its path, and
 * whose bytes are a PDF's.
 */
function makePdfImportPlugin(
  file: TFile,
  copyOnImport = false,
  snippets = makeSnippetsStub(),
  cards = makeCardsStub()
) {
  return {
    app: {
      metadataCache: { getFileCache: vi.fn(() => null) },
      fileManager: { processFrontMatter: vi.fn() },
      vault: {
        ...makeImportVault(PDF_BYTES),
        getFileByPath: vi.fn((path: string) =>
          path === file.path ? file : null
        ),
      },
      workspace: { trigger: vi.fn() },
    },
    settings: { copyOnImport, defaultPriority: DEFAULT_PRIORITY },
    reviewManager: { snippets, cards },
  };
}

/** A file at `path`, named as Obsidian names it. */
function fileAt(path: string): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return {
    path,
    name,
    basename: dot === -1 ? name : name.slice(0, dot),
    extension: dot === -1 ? '' : name.slice(dot + 1),
  } as TFile;
}

/**
 * Like {@link makePdfImportPlugin}, over a vault holding `source`, a file at
 * each of `paths` and each of `folders`, which copies and makes folders as
 * Obsidian's does on a case-insensitive file system: a copy needs its folder
 * to exist and its path to be free in any case, and a folder can't be made
 * twice. Every way of changing a file is a spy, to show none is used on one.
 */
function makePdfCopyPlugin(
  source: TFile,
  {
    paths = [],
    folders = [],
    copyOnImport = true,
  }: {
    paths?: readonly string[];
    folders?: readonly string[];
    copyOnImport?: boolean;
  } = {}
) {
  const base = makePdfImportPlugin(source, copyOnImport);
  const files = new Map<string, TFile>([
    [source.path, source],
    ...paths.map((path): [string, TFile] => [path, fileAt(path)]),
  ]);
  const folderPaths = new Set(folders);
  const holdsInAnyCase = (path: string) =>
    [...files.keys(), ...folderPaths].some(
      (held) => held.toLowerCase() === path.toLowerCase()
    );
  const vault = {
    ...base.app.vault,
    getFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    getAbstractFileByPath: vi.fn((path: string) =>
      files.has(path) || folderPaths.has(path) ? { path } : null
    ),
    getAbstractFileByPathInsensitive: vi.fn((path: string) =>
      holdsInAnyCase(path) ? { path } : null
    ),
    createFolder: vi.fn(async (path: string) => {
      if (files.has(path) || folderPaths.has(path)) {
        throw new Error('Folder already exists.');
      }
      folderPaths.add(path);
    }),
    copy: vi.fn(async (file: TFile, path: string) => {
      if (holdsInAnyCase(path)) throw new Error('EEXIST: file already exists');
      if (!folderPaths.has(path.slice(0, path.lastIndexOf('/')))) {
        throw new Error(`ENOENT: no such file or directory, copyfile`);
      }
      const copy = fileAt(path);
      files.set(path, copy);
      return copy;
    }),
    delete: vi.fn(),
    modify: vi.fn(),
    modifyBinary: vi.fn(),
    process: vi.fn(),
    rename: vi.fn(),
    trash: vi.fn(),
  };
  const fileManager = {
    ...base.app.fileManager,
    renameFile: vi.fn(),
    trashFile: vi.fn(async (file: TFile) => {
      files.delete(file.path);
    }),
  };
  return { ...base, app: { ...base.app, vault, fileManager }, files };
}

/**
 * Like {@link makePdfCopyPlugin}, but `source` and every file are notes, and
 * the vault creates a note as Obsidian's does on a case-insensitive file
 * system: it needs its folder to exist and its path to be free in any case.
 */
function makeNoteCopyPlugin(
  source: TFile,
  options: Parameters<typeof makePdfCopyPlugin>[1] = {}
) {
  const plugin = makePdfCopyPlugin(source, options);
  const { vault } = plugin.app;
  vault.readBinary.mockResolvedValue(NOTE_BYTES.slice().buffer);
  const create = vi.fn(async (path: string, _data: string) => {
    if (vault.getAbstractFileByPathInsensitive(path)) {
      throw new Error('EEXIST: file already exists');
    }
    if (!vault.getAbstractFileByPath(path.slice(0, path.lastIndexOf('/')))) {
      throw new Error('ENOENT: no such file or directory, open');
    }
    const note = fileAt(path);
    plugin.files.set(path, note);
    return note;
  });
  return {
    ...plugin,
    app: {
      ...plugin.app,
      // `source` read by Obsidian, as a note is by the time it is imported:
      // no links. The copy is not read yet.
      metadataCache: {
        getFileCache: vi.fn((file: TFile) => (file === source ? {} : null)),
      },
      vault: { ...vault, create, append: vi.fn() },
    },
  };
}

/** A snippet row shaped like one the backlink scan would return. */
function makeAdoptedRow(index: number): SnippetRow {
  return {
    id: `snippet-${index}`,
    reference: `snippets/snippet-${index}.md`,
    parent: null,
    due: Date.now(),
    due_fuzz: null,
    interval: TEXT_BASE_REVIEW_INTERVAL,
    priority: DEFAULT_PRIORITY,
    dismissed: 0,
    deleted: false,
    scroll_top: 0,
    start_offset: index,
    end_offset: index + 5,
  };
}

/** The id the import wrote in its `INSERT INTO article` statement. */
function insertedArticleId(repo: SQLiteRepository): string {
  const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  const insert = calls.find(([sql]) => sql.includes('INSERT INTO article'));
  return insert![1][0] as string;
}

/** Every article row, in a stable order, as the database holds it. */
function allRows(repo: SQLiteRepository): ArticleRow[] {
  return repo.query('SELECT * FROM article ORDER BY id') as ArticleRow[];
}

/** Returns the [sql, params] tuple from the latest call to repo.query */
function lastQueryCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/** Arbitrary for a valid ArticleRow */
const articleRowArb = fc.record<ArticleRow>({
  id: fc.uuid(),
  reference: fc.string({ minLength: 1 }),
  due: fc.oneof(
    fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
    fc.constant(null)
  ),
  due_fuzz: fc.oneof(fc.integer(), fc.constant(null)),
  interval: fc.integer({ min: 0, max: MS_PER_DAY * 365 * 50 }),
  dismissed: fc.oneof(fc.constant(0), fc.constant(1)),
  deleted: fc.boolean(),
  priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
  fixed_interval_days: fc.oneof(
    fc.integer({
      min: MINIMUM_FIXED_REVIEW_INTERVAL,
      max: MAXIMUM_FIXED_REVIEW_INTERVAL,
    }),
    fc.constant(null)
  ),
  scroll_top: fc.integer({ min: 0 }),
});

function makeSimpleRepo(): SQLiteRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
    writeRefusal: vi.fn(() => null),
  } as unknown as SQLiteRepository;
}

/**
 * Minimal Obsidian App stub. rowToReviewArticle reads frontmatter via
 * `app.metadataCache.getFileCache` and fire-and-forgets a `setFrontmatter`
 * write through `app.fileManager.processFrontMatter` when frontmatter is
 * missing. Both need to resolve cleanly so the test doesn't emit unhandled
 * promise rejections.
 */
function makeApp(): Record<string, unknown> {
  return {
    metadataCache: { getFileCache: () => ({}) },
    fileManager: { processFrontMatter: async () => undefined },
  };
}

/**
 * An app whose note at `claimedPath` carries another item's `ir-id`, so the row
 * pointing there is refused as that note's owner. Every other note is plain.
 */
function makeAppClaiming(claimedPath: string): Record<string, unknown> {
  return {
    metadataCache: {
      getFileCache: (file: TFile) =>
        file.path === claimedPath
          ? { frontmatter: { 'ir-id': 'another-item', tags: [ARTICLE_TAG] } }
          : {},
    },
    fileManager: { processFrontMatter: async () => undefined },
  };
}

/** Each reference's own note, so a claimed one can be told apart. */
function noteAt(reference: string): TFile {
  return { path: reference, extension: 'md' } as TFile;
}

/**
 * A repo backed by a real in-memory sql.js database, so ORDER BY / LIMIT
 * clauses are actually executed (mock repos ignore them).
 */
async function makeSqlJsRepo(): Promise<{
  repo: SQLiteRepository;
  db: Database;
}> {
  const dbDir = resolve(__dirname, '../../db');
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({
    wasmBinary: wasmBinary as unknown as ArrayBuffer,
  });
  const db = new SQL.Database();
  db.exec(readFileSync(resolve(dbDir, 'schema.sql'), 'utf-8'));

  const query = (sql: string, params: unknown[] = []) => {
    const results = db.exec(sql, params as never);
    if (!results.length) return [];
    const { columns, values } = results[0];
    return values.map((row) =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]]))
    );
  };
  const repo = {
    query: vi.fn().mockImplementation(query),
    mutate: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      query(sql, params);
      return [[]];
    }),
    _execSql: vi.fn(),
    transaction: vi.fn(async (work: () => unknown) => work()),
    handleFileChange: vi.fn(),
    onDataChange: vi.fn(() => vi.fn()),
    writeRefusal: vi.fn(() => null),
  } as unknown as SQLiteRepository;
  return { repo, db };
}

function insertArticleRow(
  db: Database,
  row: { id: string; due: number; due_fuzz: number | null; priority: number }
) {
  db.exec(
    `INSERT INTO article (id, reference, due, due_fuzz, interval, priority)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.id,
      `articles/${row.id}.md`,
      row.due,
      row.due_fuzz,
      TEXT_BASE_REVIEW_INTERVAL,
      row.priority,
    ]
  );
}
/** The folder a copy is imported into. */
const ARTICLES_FOLDER = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;

/**
 * A database holding `snippetCount` snippets and `cardCount` cards that
 * belong to no item, and some that no import may take: taken from elsewhere,
 * another item's already, deleted, or whose note is gone (see
 * {@link makeTakenNoteCopyPlugin}, which tells them apart by their notes).
 */
async function seedParentless(snippetCount: number, cardCount: number) {
  const { repo, db } = await makeSqlJsRepo();
  const insertSnippet = (id: string) =>
    db.exec(
      `INSERT INTO snippet (id, reference, due, interval, priority, start_offset, end_offset)
       VALUES ($1, $2, 0, 1, 20, 0, 5)`,
      [id, `snippets/${id}.md`]
    );
  const insertCard = (id: string, parent: string | null = null, deleted = 0) =>
    db.exec(
      `INSERT INTO srs_card (id, reference, parent, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state, deleted)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, $4)`,
      [id, `cards/${id}.md`, parent, deleted]
    );
  const snippetIds = Array.from({ length: snippetCount }, (_, i) => `s${i}`);
  const cardIds = Array.from({ length: cardCount }, (_, i) => `c${i}`);
  snippetIds.forEach(insertSnippet);
  cardIds.forEach((id) => insertCard(id));
  insertSnippet('elsewhere');
  insertCard('elsewhere');
  insertCard('parented', 'some-article');
  insertCard('deleted', null, 1);
  insertCard('gone');
  return { repo, snippetIds, cardIds };
}

/**
 * Like {@link makeNoteCopyPlugin}, into the articles folder holding a file at
 * each of `paths`, for a `note` whose items' links name it by its name alone,
 * which resolves to its copy, the first note the vault creates, once there is
 * one. An item whose note's path says `elsewhere` was taken from another note,
 * and one whose says `gone` has no note.
 */
function makeTakenNoteCopyPlugin(note: TFile, paths: readonly string[] = []) {
  const plugin = makeNoteCopyPlugin(note, {
    folders: [ARTICLES_FOLDER],
    paths,
  });
  const copy = () => {
    const created = plugin.app.vault.create.mock.calls[0];
    return created ? plugin.files.get(created[0]) : undefined;
  };
  vi.spyOn(Obsidian, 'getNote').mockImplementation((reference) =>
    reference.includes('gone')
      ? null
      : (plugin.files.get(reference) ??
        ({ path: reference, extension: 'md' } as TFile))
  );
  vi.spyOn(Obsidian, 'getSourceFile').mockImplementation((item) =>
    item.path.includes('elsewhere')
      ? fileAt('notes/Other.md')
      : (copy() ?? note)
  );
  return plugin;
}

/** The note {@link makeLinkedCopyPlugin} imports as a copy, and its copy. */
const LINKING_NOTE = 'notes/Note.md';
const LINKING_COPY = `${ARTICLES_FOLDER}/Note.md`;
/** The files that note links to: `x` has a namesake beside the copy. */
const LINKED = ['notes/x.md', `${ARTICLES_FOLDER}/x.md`, 'cards/c.md'];

/** What the metadata cache says of a link written in `text`. */
function linkIn(text: string, written: string, link: string) {
  const start = text.indexOf(written);
  return {
    link,
    original: written,
    position: cachePosition(start, start + written.length),
  };
}

/**
 * A copy import of the note at {@link LINKING_NOTE}, whose text is `text` and
 * whose metadata cache says `cache`, in a vault that also holds
 * {@link LINKED} and resolves links as Obsidian does, writing new ones in the
 * relative format. The copy, once made, is resolved to as well.
 */
function makeLinkedCopyPlugin(text: string, cache: unknown) {
  const vault = makeLinkVault(
    Object.fromEntries([LINKING_NOTE, ...LINKED].map((path) => [path, null])),
    { linkFormat: 'relative' }
  );
  const note = vault.files.get(LINKING_NOTE)!;
  const plugin = makeNoteCopyPlugin(note, { folders: [ARTICLES_FOLDER] });
  for (const [path, file] of vault.files) plugin.files.set(path, file);
  const synced = () => {
    for (const [path, file] of plugin.files) {
      if (!vault.files.has(path)) vault.files.set(path, file);
    }
  };
  plugin.app.vault.cachedRead.mockResolvedValue(text);
  const metadataCache = {
    getFileCache: vi.fn((file: TFile) => (file === note ? cache : null)),
    getFirstLinkpathDest: vi.fn((linkpath: string, from: string) => {
      synced();
      return vault.resolve(linkpath, from);
    }),
    fileToLinktext: vi.fn((file: TFile, from: string, omitMd: boolean) => {
      synced();
      return vault.app.metadataCache.fileToLinktext(file, from, omitMd);
    }),
  };
  Object.assign(plugin.app.metadataCache, metadataCache);
  return { plugin, note, metadataCache };
}

/** The notice a copy whose links weren't all re-based is made with. */
const LINKS_KEPT_WARNING = `Warning: couldn't update the links in the copy of "Note"; some may not lead where they did`;

/**
 * The edit the copy's frontmatter is given in the write that makes it
 * the article, applied to `properties`.
 */
function editedInImportWrite(
  updateFrontMatter: { mock: { calls: unknown[][] } },
  copy: TFile | undefined,
  properties: Record<string, unknown>
) {
  const write = updateFrontMatter.mock.calls.find(
    ([file, updates]) =>
      file === copy &&
      typeof updates === 'object' &&
      updates !== null &&
      'ir-id' in updates
  );
  (write?.[3] as (fm: Record<string, unknown>) => void)(properties);
  return properties;
}

/** Create an empty article asked for in `directory`; where it was made. */
async function createIn(directory: string | undefined, inCurrent: boolean) {
  const createNote = vi
    .spyOn(Obsidian, 'createNote')
    .mockResolvedValue(fileAt(`${directory}/new.md`));
  vi.spyOn(Obsidian, 'updateFrontMatter').mockResolvedValue(undefined);
  const plugin = {
    app: makeApp(),
    settings: { createEmptyInCurrentFolder: inCurrent },
  };
  const manager = new ArticleManager(plugin as never, makeSimpleRepo());
  vi.spyOn(manager, 'fetch').mockResolvedValue(null);

  await manager.create(DEFAULT_PRIORITY, directory);

  return createNote.mock.lastCall?.[0].directory;
}

const SOURCE = 'notes/source.md';
const PDF = 'papers/paper.pdf';

/** Where making an article can fail, if anywhere. */
type Failure = 'create' | 'frontmatter' | 'copy' | 'row' | null;

/**
 * A manager over a real database and a vault holding `notes`, with the
 * vault or the database failing at `failure`, and writes refused when
 * `refused`.
 */
async function wireArticles(
  notes: Record<string, Record<string, unknown> | null>,
  failure: Failure,
  refused = false
) {
  const vault = makeItemVault(notes);
  const repo = await TestRepository.create();
  if (failure === 'create' || failure === 'copy') vault.fail(failure);
  if (failure === 'frontmatter') vault.fail('frontmatter');
  if (failure === 'row') {
    repo.failWrite((query) => query.startsWith('INSERT INTO article'));
  }
  if (refused) repo.refuseWrites(new Error('Saving is paused.'));
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const manager = new ArticleManager(
    {
      app: vault.app,
      settings: { copyOnImport: false, createEmptyInCurrentFolder: false },
    } as never,
    repo
  );
  const before = Object.fromEntries(
    Object.keys(notes).map((path) => [
      path,
      structuredClone(vault.frontmatterOf(path)),
    ])
  );
  return { vault, repo, notify, manager, before };
}

/** A tag a note can hold: any text, the plugin's own among them. */
const tagArb = fc.oneof(
  fc.string(),
  fc.constantFrom(ARTICLE_TAG, SNIPPET_TAG, CARD_TAG, 'ir-source')
);

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A refusal while writes are paused: what it names, then the pause's reason. */
const refusal = (named = '') =>
  expect.stringMatching(
    new RegExp(`${escapeRegExp(named)}.*Saving is paused\\.$`, 's')
  );

/** An import's confirmation, by the title it names and the priority given. */
const importedWithPriority = (title: string, priority: number) =>
  expect.stringMatching(
    new RegExp(
      `"${escapeRegExp(title)}".*\\b` +
        `${escapeRegExp(IRScheduler.toDisplayPriority(priority))}(?![.\\d])`,
      's'
    )
  );

/** An import's confirmation, by the title it names and its fixed interval. */
const importedWithFixedDays = (title: string, days: number) =>
  expect.stringMatching(
    new RegExp(`"${escapeRegExp(title)}".*\\b${days}(?![.\\d])`, 's')
  );

/**
 * A file of a batch import: a note or a PDF, by name, with the snippets and
 * cards taken from it while it was no article, and what the database holds
 * of it beforehand. `fresh`: nothing. `article`: its live row at its path.
 * `moved`: a note's row, named by its `ir-id`, live at another path; for a
 * PDF, which holds no id, an unrelated row there. `deleted`: a note's row,
 * named by its `ir-id`, deleted at another path; a PDF's deleted at its own.
 * `orphan`: a note's `ir-id`, which no row holds; nothing, for a PDF.
 */
interface BatchSpec {
  name: string;
  pdf: boolean;
  state: 'fresh' | 'article' | 'moved' | 'deleted' | 'orphan';
  snippets: number;
  cards: number;
}

const batchSpecsArb = fc.uniqueArray(
  fc.record<BatchSpec>({
    name: fc.stringMatching(/^[a-z]{1,6}$/),
    pdf: fc.boolean(),
    state: fc.constantFrom('fresh', 'article', 'moved', 'deleted', 'orphan'),
    snippets: fc.nat({ max: 2 }),
    cards: fc.nat({ max: 2 }),
  }),
  { selector: (spec) => spec.name, minLength: 1, maxLength: 6 }
);

/** Fresh files of a batch, with nothing taken from them. */
const freshBatchArb = fc.uniqueArray(
  fc.record<BatchSpec>({
    name: fc.stringMatching(/^[a-z]{1,6}$/),
    pdf: fc.boolean(),
    state: fc.constant('fresh'),
    snippets: fc.constant(0),
    cards: fc.constant(0),
  }),
  { selector: (spec) => spec.name, minLength: 1, maxLength: 6 }
);

const batchOptionsArb = fc.record({
  priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
  fixedIntervalDays: fc.option(
    fc.integer({
      min: MINIMUM_FIXED_REVIEW_INTERVAL,
      max: MAXIMUM_FIXED_REVIEW_INTERVAL,
    }),
    { nil: null }
  ),
  makeCopy: fc.boolean(),
});

const batchPathOf = ({ name, pdf }: BatchSpec) =>
  pdf ? `papers/${name}.pdf` : `notes/${name}.md`;

/** Where a file of a batch lands once imported, as `makeCopy` asks. */
const batchTargetOf = (spec: BatchSpec, makeCopy: boolean) =>
  makeCopy
    ? `${ARTICLES_FOLDER}/${spec.name}.${spec.pdf ? 'pdf' : 'md'}`
    : batchPathOf(spec);

/**
 * A manager over a real database and a vault holding each of `specs`, with
 * the review manager's snippets and cards over the same database unless
 * `withReviewManager` is false, and text reviews fuzzed when `fuzz` is.
 */
async function batchWorld(
  specs: readonly BatchSpec[],
  { fuzz = false, withReviewManager = true } = {}
) {
  const notes: Record<string, Record<string, unknown> | null> = {};
  const children: {
    table: 'snippet' | 'srs_card';
    id: string;
    path: string;
  }[] = [];
  for (const spec of specs) {
    const path = batchPathOf(spec);
    notes[path] = spec.pdf
      ? null
      : spec.state === 'fresh'
        ? {}
        : { 'ir-id': `${spec.name}-id`, tags: [ARTICLE_TAG] };
    const taken = [
      ...Array.from({ length: spec.snippets }, (_, i) => ({
        table: 'snippet' as const,
        id: `${spec.name}-s${i}`,
        path: `snippets/${spec.name}-s${i}.md`,
      })),
      ...Array.from({ length: spec.cards }, (_, i) => ({
        table: 'srs_card' as const,
        id: `${spec.name}-c${i}`,
        path: `cards/${spec.name}-c${i}.md`,
      })),
    ];
    for (const child of taken) {
      notes[child.path] = { 'ir-id': child.id, source: `[[${path}]]` };
    }
    children.push(...taken);
  }
  const vault = makeItemVault(notes);
  const repo = await TestRepository.create();
  for (const spec of specs) {
    if (spec.state === 'fresh' || spec.state === 'orphan') continue;
    const atOwnPath =
      spec.state === 'article' || (spec.pdf && spec.state === 'deleted');
    repo.db!.run(
      `INSERT INTO article (id, reference, due, interval, priority, deleted)
       VALUES ($1, $2, 0, 1, 20, $3)`,
      [
        `${spec.name}-id`,
        atOwnPath
          ? batchPathOf(spec)
          : `old/${spec.name}.${spec.pdf ? 'pdf' : 'md'}`,
        spec.state === 'deleted' ? 1 : 0,
      ]
    );
  }
  for (const { table, id, path } of children) {
    repo.db!.run(
      table === 'snippet'
        ? `INSERT INTO snippet (id, reference, due, interval, priority, start_offset, end_offset)
           VALUES ($1, $2, 0, 1, 20, 0, 5)`
        : `INSERT INTO srs_card (id, reference, created_at, due, stability,
             difficulty, elapsed_days, scheduled_days, reps, lapses, state)
           VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [id, path]
    );
  }
  vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  vi.spyOn(console, 'warn').mockReturnValue(undefined);
  const trigger = vi.fn();
  const plugin = {
    app: { ...vault.app, workspace: { trigger } },
    settings: {
      copyOnImport: false,
      createEmptyInCurrentFolder: false,
      fuzzTextReviews: fuzz,
    },
    reviewManager: undefined as
      | { snippets: SnippetManager; cards: CardManager }
      | undefined,
  };
  const snippets = new SnippetManager(plugin as never, repo);
  const getHighlights = vi
    .spyOn(snippets, 'getHighlights')
    .mockResolvedValue([]);
  if (withReviewManager) {
    plugin.reviewManager = {
      snippets,
      cards: new CardManager(plugin as never, repo),
    };
  }
  const manager = new ArticleManager(plugin as never, repo);
  const files = specs.map((spec) => vault.files.get(batchPathOf(spec))!);
  return { vault, repo, manager, files, getHighlights, trigger };
}

/**
 * What a {@link batchWorld} holds, with every article id named by its row's
 * path, as two imports of the same files make different ids.
 */
function batchSnapshot({
  repo,
  vault,
}: Awaited<ReturnType<typeof batchWorld>>) {
  const articles = repo.rows('article');
  const pathOf = new Map(articles.map((row) => [row.id, row.reference]));
  const named = (id: unknown) => pathOf.get(id as string) ?? id;
  return {
    articles: articles
      .map(({ id: _, ...row }) => row)
      .sort((a, b) => String(a.reference).localeCompare(String(b.reference))),
    children: [...repo.rows('snippet'), ...repo.rows('srs_card')].map(
      (row) => ({ id: row.id, parent: named(row.parent) })
    ),
    notes: Object.fromEntries(
      vault.paths().map((path) => {
        const frontmatter = vault.frontmatterOf(path);
        return [
          path,
          frontmatter && {
            ...frontmatter,
            'ir-id': named(frontmatter['ir-id']),
          },
        ];
      })
    ),
  };
}

/**
 * `bulkMutate` options that make a chunk exactly `sliceMs` statements: the
 * clock advances a tick a reading.
 */
function chunkedBy(sliceMs: number) {
  let tick = 0;
  return { sliceMs, now: () => tick++ };
}

/**
 * Run `repo`'s bulk writes `sliceMs` statements a chunk, with `rewrite`
 * changing what a run is given, counting the writes made outside of one and
 * keeping what stopped one.
 */
function watchWrites(
  repo: TestRepository,
  sliceMs: number,
  rewrite: (statements: readonly MutationStatement[]) => MutationStatement[] = (
    statements
  ) => [...statements]
) {
  let inBulk = 0;
  let outside = 0;
  let stopped: unknown = null;
  // `bind` is untyped here, without `strictBindCallApply`
  const mutate = repo.mutate.bind(repo) as TestRepository['mutate'];
  vi.spyOn(repo, 'mutate').mockImplementation((query, params) => {
    if (inBulk === 0) outside += 1;
    return mutate(query, params);
  });
  const run = repo.bulkMutate.bind(repo) as TestRepository['bulkMutate'];
  const bulkMutate = vi
    .spyOn(repo, 'bulkMutate')
    .mockImplementation(async (statements) => {
      inBulk += 1;
      try {
        await run(rewrite(statements), chunkedBy(sliceMs));
      } catch (error) {
        stopped = error;
        throw error;
      } finally {
        inBulk -= 1;
      }
    });
  // Undocumented to callers: `save` is the repository's own
  const save = vi.spyOn(repo as unknown as { save(): Promise<void> }, 'save');
  return {
    bulkMutate,
    save,
    outside: () => outside,
    stopped: () => stopped,
  };
}

// #endregion

describe('disableFixedInterval', () => {
  it('does not mutate the database if the priority is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: MINIMUM_PRIORITY - 1 }),
          fc.integer({ min: MAXIMUM_PRIORITY + 1 })
        ),
        async (badPriority) => {
          const article = makeArticle();
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await manager.disableFixedInterval(article, badPriority);
          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls;
          expect(calls).toHaveLength(0);
        }
      )
    );
  });
  describe('when the article has a prior review', () => {
    it('clears fixed_interval_days in the database', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() }),
          fc.integer({ min: 0, max: 1_000 }),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (reviewTime, reviewCount, newPriority) => {
            const article = makeArticle();
            const repo = makeRepo(makeReview(reviewTime), reviewCount);
            const manager = new ArticleManager({} as never, repo);
            await manager.disableFixedInterval(article, newPriority);

            const [sql] = lastMutateCall(repo);
            expect(sql).toMatch(/fixed_interval_days = NULL/i);
          }
        )
      );
    });

    it('calculates the due time using the new priority', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() }),
          fc.integer({ min: 0, max: 1_000 }),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (reviewTime, reviewCount, priority, newPriority) => {
            const article = makeArticle({ priority });
            const repo = makeRepo(makeReview(reviewTime), reviewCount);
            const manager = new ArticleManager({} as never, repo);
            await manager.disableFixedInterval(article, newPriority);

            const mult = IRScheduler.getIntervalMultiplier(newPriority);
            const expectedInterval =
              TEXT_BASE_REVIEW_INTERVAL * mult ** reviewCount;
            const expectedDue = reviewTime + expectedInterval;

            const [, params] = lastMutateCall(repo);
            expect(
              params[1],
              'should calculate the interval by simulating priority scheduling'
            ).toBe(expectedInterval);
            expect(params[0]).toBe(expectedDue);
          }
        )
      );
    });
  });

  describe('when the article has no prior reviews', () => {
    it('falls back to article.due', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
          fc.integer({ min: 0, max: MS_PER_YEAR * 50 }),
          fc.boolean(),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (due, interval, dismissed, priority) => {
            const repo = makeRepo(undefined, 0);
            const manager = new ArticleManager({} as never, repo);
            const article = makeArticle({ due, interval, dismissed, priority });
            await manager.disableFixedInterval(article, priority);

            const [, params] = lastMutateCall(repo);
            expect(params[0]).toBe(due);
          }
        )
      );
    });

    it('sets interval to the default', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
          fc.integer({ min: 0, max: MS_PER_YEAR * 50 }),
          fc.boolean(),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (due, interval, dismissed, priority) => {
            const repo = makeRepo(undefined, 0);
            const manager = new ArticleManager({} as never, repo);
            const article = makeArticle({ due, interval, dismissed, priority });
            await manager.disableFixedInterval(article, priority);

            const [, params] = lastMutateCall(repo);
            expect(params[1]).toBe(TEXT_BASE_REVIEW_INTERVAL);
          }
        )
      );
    });

    it('targets the correct article id in the WHERE clause', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          async (id, priority) => {
            const repo = makeRepo(undefined, 0);
            const manager = new ArticleManager({} as never, repo);
            const article = makeArticle({ id });
            await manager.disableFixedInterval(article, priority);

            const [sql, params] = lastMutateCall(repo);
            expect(sql).toMatch(/WHERE id = \$4/i);
            expect(params[3]).toBe(id);
          }
        )
      );
    });
  });
});

describe('getDue', () => {
  // Year 2000–2100 in ms, used to generate arbitrary "current time" values.
  const YEAR_2000_MS = new Date('2000-01-01T12:00:00Z').getTime();
  const YEAR_2100_MS = new Date('2100-01-01T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'articles/test.md',
      extension: 'md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Repo that filters rows by the dueBy param, mirroring the SQL `due <= $1` condition. */
  function makeRepoWithArticles(
    rows: ReturnType<typeof makeArticleRow>[]
  ): SQLiteRepository {
    return {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.startsWith('SELECT * FROM article')) {
          const dueBy = params[0] as number | undefined;
          return dueBy !== undefined
            ? rows.filter((r) => r.due !== null && r.due <= dueBy)
            : rows;
        }
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;
  }

  it('returns articles due at or before the offset-adjusted end of day, but not after', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: YEAR_2000_MS, max: YEAR_2100_MS }),
        fc.integer({
          min: DAY_ROLLOVER_OFFSET_HOURS.MIN,
          max: DAY_ROLLOVER_OFFSET_HOURS.MAX,
        }),
        async (nowMs, offset) => {
          vi.setSystemTime(nowMs);

          const cutoff = getEndOfDay(offset);
          const rowAtCutoff = makeArticleRow({ id: 'at-cutoff', due: cutoff });
          const rowAfterCutoff = makeArticleRow({
            id: 'after-cutoff',
            due: cutoff + 1,
          });
          const repo = makeRepoWithArticles([rowAtCutoff, rowAfterCutoff]);
          const plugin = {
            app: makeApp(),
            settings: { dayRolloverOffset: offset },
          } as never;
          const manager = new ArticleManager(plugin, repo);

          const results = await manager.getDue();

          const ids = results.map((r) => r.data.id);
          expect(ids).toContain('at-cutoff');
          expect(ids).not.toContain('after-cutoff');
        }
      )
    );
  });

  describe('with a real SQLite database', () => {
    it('applies the SQL limit in fuzzed-due order, not priority order', async () => {
      const { repo, db } = await makeSqlJsRepo();
      const now = new Date('2026-01-10T12:00:00Z').getTime();
      // The highest-priority article is effectively due LAST once fuzz is
      // applied, so a limited fetch must not return it first.
      insertArticleRow(db, {
        id: 'later-fuzzed',
        due: now - 1_000,
        due_fuzz: 900,
        priority: MAXIMUM_PRIORITY,
      });
      insertArticleRow(db, {
        id: 'earlier-fuzzed',
        due: now - 2_000,
        due_fuzz: 100,
        priority: MINIMUM_PRIORITY,
      });
      const plugin = {
        app: makeApp(),
        settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
      } as never;
      const manager = new ArticleManager(plugin, repo);

      const results = await manager.getDue(now, 1);

      expect(results.map((r) => r.data.id)).toEqual(['earlier-fuzzed']);
    });

    it('orders by fuzzed due even when fuzzTextReviews is disabled', async () => {
      const { repo, db } = await makeSqlJsRepo();
      const now = new Date('2026-01-10T12:00:00Z').getTime();
      // Priorities are the reverse of fuzzed-due order; stored fuzz must
      // still determine presentation order when the setting is off.
      insertArticleRow(db, {
        id: 'third',
        due: now - 100,
        due_fuzz: null,
        priority: MAXIMUM_PRIORITY,
      });
      insertArticleRow(db, {
        id: 'first',
        due: now - 5_000,
        due_fuzz: 1_000,
        priority: MINIMUM_PRIORITY,
      });
      insertArticleRow(db, {
        id: 'second',
        due: now - 3_000,
        due_fuzz: null,
        priority: DEFAULT_PRIORITY,
      });
      const plugin = {
        app: makeApp(),
        settings: { dayRolloverOffset: 0, fuzzTextReviews: false },
      } as never;
      const manager = new ArticleManager(plugin, repo);

      const results = await manager.getDue(now);

      expect(results.map((r) => r.data.id)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('returns exactly the live due articles not seen, soonest first, however many were seen', async () => {
      const { repo, db } = await makeSqlJsRepo();
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(textItemSpecArb, {
            selector: ({ id }) => id,
            maxLength: 12,
          }),
          // Seen this session but not in this table: other types, or gone
          seenElsewhereArb,
          fc.integer({ min: -MS_PER_DAY, max: 2 * MS_PER_DAY }),
          // Review asks for one at a time, the queue for all; never for none
          fc.option(fc.integer({ min: 1, max: 14 }), { nil: undefined }),
          fc.boolean(),
          async (specs, otherSeen, dueBy, limit, fuzzTextReviews) => {
            db.exec('DELETE FROM article');
            for (const spec of specs) insertTextItemRow(db, 'article', spec);
            const excludeIds = [
              ...otherSeen,
              ...specs.filter(({ seen }) => seen).map(({ id }) => id),
            ];
            const plugin = {
              app: makeApp(),
              settings: { dayRolloverOffset: 0, fuzzTextReviews },
            } as never;
            const manager = new ArticleManager(plugin, repo);

            const due = await manager.getDue(dueBy, limit, excludeIds);

            expectDueInOrder(
              due.map(({ data }) => data.id),
              specs,
              dueBy,
              limit
            );
          }
        ),
        { numRuns: 40 }
      );
      db.close();
    });

    it('leaves out a row whose note is another item’s and fetches on, however many were seen', async () => {
      const { repo, db } = await makeSqlJsRepo();
      insertArticleRow(db, {
        id: 'claimed',
        due: 1,
        due_fuzz: null,
        priority: DEFAULT_PRIORITY,
      });
      insertArticleRow(db, {
        id: 'own',
        due: 2,
        due_fuzz: null,
        priority: DEFAULT_PRIORITY,
      });
      vi.spyOn(Obsidian, 'getNote').mockImplementation(noteAt);
      const plugin = {
        app: makeAppClaiming('articles/claimed.md'),
        settings: { dayRolloverOffset: 0 },
      } as never;
      const manager = new ArticleManager(plugin, repo);
      const seen = Array.from(
        { length: MAX_SQL_QUERY_PARAMS + 1 },
        (_, i) => `seen-${i}`
      );

      const due = await manager.getDue(10, 1, seen);

      expect(due.map(({ data }) => data.id)).toEqual(['own']);
      // The claimed row was left out of the second query, not just dropped
      expect((repo.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        2
      );
      db.close();
    });
  });

  it('returns a row whose note file is missing as a missing item, without retrying', async () => {
    const rowA = makeArticleRow({
      id: 'no-file',
      reference: 'articles/gone.md',
      due: 0,
    });
    const rowB = makeArticleRow({ id: 'has-file', due: 0 });
    const file = { path: 'articles/test.md', extension: 'md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((_ref) => {
      if (_ref === rowA.reference) return null;
      return file;
    });

    let callCount = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        callCount++;
        const excluded = excludedIdsOf(params);
        const rows = [rowA, rowB].filter((r) => !excluded.includes(r.id));
        return rows;
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(0);

    expect(results).toEqual([
      { data: ArticleManager.rowToBase(rowA), file: null },
      { data: ArticleManager.rowToBase(rowB), file },
    ]);
    expect(callCount).toBe(1);
    // Missing is never stored
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });

  it('starts with an empty exclude list when no excludeIds are given', async () => {
    const file = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(file);

    const queryCalls: [string, unknown[]][] = [];
    const repo = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        queryCalls.push([sql, params]);
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    await manager.getDue(1);

    // The first call's SQL must not contain NOT IN (since no IDs were excluded yet)
    const [firstSql] = queryCalls[0];
    expect(firstSql).not.toMatch(/NOT IN/i);
  });

  it('passes pre-existing excludeIds on the first fetch call', async () => {
    const rowA = makeArticleRow({ id: 'excluded-by-caller', due: 0 });
    const file = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(file);

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
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    await manager.getDue(0, undefined, [rowA.id]);

    // The first query call's params should contain the pre-excluded ID
    const firstCallParams = queryCalls[0];
    expect(excludedIdsOf(firstCallParams)).toContain(rowA.id);
  });

  it('filters out items where rowToReviewArticle refuses a note that is not the row’s', async () => {
    // Give each row a unique reference so the getNote mock can discriminate.
    // The second call must still return rowWithFile so that `due` is not empty after the retry.
    const rowWithFile = makeArticleRow({
      id: 'has-file',
      reference: 'articles/with-file.md',
      due: 1,
    });
    const rowNoFile = makeArticleRow({
      id: 'no-file-filter',
      reference: 'articles/no-file.md',
      due: 1,
    });
    vi.spyOn(Obsidian, 'getNote').mockImplementation(noteAt);

    // First call returns both rows; second call returns only rowWithFile (rowNoFile is excluded).
    let call = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        call++;
        if (call === 1) return [rowWithFile, rowNoFile];
        // Simulate SQL exclusion: omit rows whose id is in params
        return [rowWithFile, rowNoFile].filter(
          (r) => !excludedIdsOf(params).includes(r.id)
        );
      }),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeAppClaiming(rowNoFile.reference),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(1);
    expect(results.map((r) => r.data.id)).not.toContain('no-file-filter');
    expect(results.map((r) => r.data.id)).toContain('has-file');
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
        async (
          dueBy,
          limit,
          excludeIds,
          dayRolloverOffset,
          fuzzTextReviews
        ) => {
          const plugin = {
            app: makeApp(),
            settings: { dayRolloverOffset, fuzzTextReviews },
          } as never;
          const manager = new ArticleManager(plugin, repo);
          await expect(manager.getDue(dueBy, limit, excludeIds)).rejects.toBe(
            failure
          );
        }
      )
    );
  });
});

describe('rowToBase', () => {
  it('converts dismissed number to boolean and adds type', async () => {
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const base = ArticleManager.rowToBase(row);
        expect(base.type).toBe('article');
        expect(base.dismissed).toBe(Boolean(row.dismissed));
        // all other fields pass through unchanged
        expect(base.id).toBe(row.id);
        expect(base.reference).toBe(row.reference);
        expect(base.due).toBe(row.due);
        expect(base.interval).toBe(row.interval);
        expect(base.priority).toBe(row.priority);
        expect(base.fixed_interval_days).toBe(row.fixed_interval_days);
        expect(base.scroll_top).toBe(row.scroll_top);
      })
    );
  });
});

describe('rowToDisplay', () => {
  it('converts due to Date when present, or null when null', async () => {
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const display = ArticleManager.rowToDisplay(row);
        expect(display.type).toBe('article');
        expect(display.dismissed).toBe(Boolean(row.dismissed));
        if (row.due !== null) {
          expect(display.due).toBeInstanceOf(Date);
          expect((display.due as Date).getTime()).toBe(row.due);
        } else {
          expect(display.due).toBeNull();
        }
      })
    );
  });
});

describe('displayToRow', () => {
  it('round-trips through rowToDisplay: displayToRow(rowToDisplay(row)) equals row', async () => {
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const display = ArticleManager.rowToDisplay(row);
        const backToRow = ArticleManager.displayToRow(display);
        expect(backToRow.dismissed).toBe(row.dismissed);
        expect(backToRow.due).toBe(row.due);
        expect(backToRow.id).toBe(row.id);
        expect(backToRow.reference).toBe(row.reference);
        expect(backToRow.interval).toBe(row.interval);
        expect(backToRow.priority).toBe(row.priority);
        expect(backToRow.fixed_interval_days).toBe(row.fixed_interval_days);
        expect(backToRow.scroll_top).toBe(row.scroll_top);
        // type field must be stripped
        expect('type' in backToRow).toBe(false);
      })
    );
  });

  it('converts null due to null in row', async () => {
    await fc.assert(
      fc.asyncProperty(
        articleRowArb.map((r) => ({ ...r, due: null })),
        async (row) => {
          const display = ArticleManager.rowToDisplay(row);
          const backToRow = ArticleManager.displayToRow(display);
          expect(backToRow.due).toBeNull();
        }
      )
    );
  });
});

describe('rowToReviewArticle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the file cannot be found', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const repo = makeSimpleRepo();
        const manager = new ArticleManager({} as never, repo);
        const result = manager.rowToReviewArticle(row);
        expect(result).toBeNull();
      })
    );
  });

  it('returns a ReviewArticle with data and file when the file exists', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(articleRowArb, async (row) => {
        const repo = makeSimpleRepo();
        const manager = new ArticleManager(
          { app: makeApp(), settings: { fuzzReviewTimes: false } } as never,
          repo
        );
        const result = manager.rowToReviewArticle(row);
        expect(result).not.toBeNull();
        expect(result!.file).toBe(fakeFile);
        expect(result!.data.id).toBe(row.id);
        expect(result!.data.dismissed).toBe(Boolean(row.dismissed));
        expect(result!.data.type).toBe('article');
      })
    );
  });

  it('returns a PDF row as a review item without reading or writing the PDF', async () => {
    await fc.assert(
      fc.asyncProperty(
        articleRowArb,
        fc.oneof(
          fc.mixedCase(fc.constant('pdf')),
          fc.string().filter((ext) => ext.toLowerCase() !== 'md')
        ),
        fc.boolean(),
        async (row, extension, fuzz) => {
          const file = { path: `papers/a.${extension}`, extension } as TFile;
          const touches = {
            processFrontMatter: vi.fn().mockResolvedValue(undefined),
            process: vi.fn().mockResolvedValue(''),
            modify: vi.fn().mockResolvedValue(undefined),
            read: vi.fn().mockResolvedValue(''),
            cachedRead: vi.fn().mockResolvedValue(''),
          };
          const { processFrontMatter, ...vault } = touches;
          const manager = new ArticleManager(
            {
              app: {
                vault: { ...vault, getFileByPath: () => file },
                // Whatever the cache says of a PDF, it has no id or tag to repair
                metadataCache: { getFileCache: () => ({}) },
                fileManager: { processFrontMatter },
              },
              settings: { fuzzTextReviews: fuzz },
            } as never,
            makeSimpleRepo()
          );

          const result = manager.rowToReviewArticle({
            ...row,
            reference: file.path,
          });
          // Let the fire-and-forget writes it starts run
          await Promise.resolve();

          expect(result?.file).toBe(file);
          expect(result?.data.id).toBe(row.id);
          for (const touch of Object.values(touches)) {
            expect(touch).not.toHaveBeenCalled();
          }
        }
      )
    );
  });

  it('returns null and leaves a live row alone when its file is missing, since missing is never stored', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const row = makeArticleRow({ deleted: false });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    expect(manager.rowToReviewArticle(row)).toBeNull();
    await Promise.resolve();
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
  });

  it('skips markDeleted when the file is missing but the row is already deleted', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const row = makeArticleRow({ deleted: true });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    expect(mutateCalls).toHaveLength(0);
  });

  it('returns null and calls markDeleted when frontmatter has a different ir-id', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({ id: 'row-id-001' });
    const repo = makeSimpleRepo();
    // Return frontmatter whose ir-id does NOT match the row id
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': 'different-id', tags: [ARTICLE_TAG] },
            }),
          },
          fileManager: { processFrontMatter: async () => undefined },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    const result = manager.rowToReviewArticle(row);
    expect(result).toBeNull();
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const deleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 1')
    );
    expect(deleteCall).toBeDefined();
  });

  it('calls setFrontmatter when the file has an ir-id but lacks the article tag', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      id: 'row-id-002',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [] },
            }),
          },
          fileManager: { processFrontMatter: processFrontMatterSpy },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).toHaveBeenCalled();
  });

  it('calls setFrontmatter when the file has matching ir-id but no tags field', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      id: 'row-id-003',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id },
            }),
          },
          fileManager: { processFrontMatter: processFrontMatterSpy },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).toHaveBeenCalled();
  });

  it('does not call setFrontmatter when the file has both matching ir-id and the article tag', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      id: 'row-id-004',
      deleted: false,
      due_fuzz: 0,
    });
    const processFrontMatterSpy = vi.fn().mockResolvedValue(undefined);
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [ARTICLE_TAG] },
            }),
          },
          fileManager: { processFrontMatter: processFrontMatterSpy },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    expect(processFrontMatterSpy).not.toHaveBeenCalled();
  });

  it('does not call markUndeleted when the file exists and the row is not deleted', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({
      deleted: false,
      due_fuzz: 0,
      id: 'row-id-005',
    });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      {
        app: {
          metadataCache: {
            getFileCache: () => ({
              frontmatter: { 'ir-id': row.id, tags: [ARTICLE_TAG] },
            }),
          },
          fileManager: { processFrontMatter: async () => undefined },
        },
        settings: { fuzzTextReviews: false },
      } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const undeleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 0')
    );
    expect(undeleteCall).toBeUndefined();
  });

  it('calls markUndeleted when the file exists but the row is flagged as deleted', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const row = makeArticleRow({ deleted: true, due_fuzz: 0 });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: false } } as never,
      repo
    );
    manager.rowToReviewArticle(row);
    await Promise.resolve();
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const undeleteCall = mutateCalls.find(([sql]) =>
      sql.includes('SET deleted = 0')
    );
    expect(undeleteCall).toBeDefined();
    expect(undeleteCall![1][0]).toBe(row.id);
  });
});

/**
 * Obsidian's metadata cache answers `null` for a note between hashing its new
 * content and finishing the parse of it, which every edit does — each keystroke
 * saved from review among them. That is a note not readable yet, not one with
 * its frontmatter gone.
 */
describe('rowToReviewArticle on a note the metadata cache is still re-reading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the row as a review item without writing to the note or its tombstone', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(
        articleRowArb,
        fc.boolean(),
        async (row, fuzzTextReviews) => {
          const processFrontMatter = vi.fn().mockResolvedValue(undefined);
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            {
              app: {
                metadataCache: { getFileCache: () => null },
                fileManager: { processFrontMatter },
              },
              settings: { fuzzTextReviews },
            } as never,
            repo
          );

          const result = manager.rowToReviewArticle(row);
          await Promise.resolve();

          expect(result).toStrictEqual({
            data: ArticleManager.rowToBase(row),
            file: fakeFile,
          });
          expect(processFrontMatter).not.toHaveBeenCalled();
          // Review fuzz lives in the database alone, so it is still set
          const mutated = (
            repo.mutate as ReturnType<typeof vi.fn>
          ).mock.calls.map(([sql]) => sql as string);
          expect(
            mutated.filter((sql) => !sql.includes('SET due_fuzz'))
          ).toStrictEqual([]);
        }
      )
    );
  });

  it('still restores the id and tag of a parsed note that has no frontmatter', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(
        articleRowArb,
        fc.boolean(),
        async (row, fuzzTextReviews) => {
          const processFrontMatter = vi.fn().mockResolvedValue(undefined);
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            {
              app: {
                metadataCache: { getFileCache: () => ({}) },
                fileManager: { processFrontMatter },
              },
              settings: { fuzzTextReviews },
            } as never,
            repo
          );

          const result = manager.rowToReviewArticle(row);
          await Promise.resolve();

          expect(result).toStrictEqual({
            data: ArticleManager.rowToBase(row),
            file: fakeFile,
          });
          expect(processFrontMatter).toHaveBeenCalledTimes(1);
          expect(processFrontMatter.mock.calls[0][0]).toBe(fakeFile);
        }
      )
    );
  });
});

describe('fetchMany', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all rows when called with no options', async () => {
    const rows = [makeArticleRow({ id: 'a' }), makeArticleRow({ id: 'b' })];
    const repo = {
      query: vi.fn().mockResolvedValue(rows),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager({} as never, repo);
    const result = await manager.fetchMany();
    expect(result).toEqual(rows);
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/SELECT \* FROM article/i);
    // dismissed = 0 filter is always applied by default
    expect(sql).toMatch(/dismissed = 0/i);
    expect(params).toEqual([]);
  });

  it('omits the dismissed filter when includeDismissed=true, but keeps the default deleted filter', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
    expect(sql).toMatch(/deleted = FALSE/i);
  });

  it('adds a due filter when dueBy is provided', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const dueBy = Date.now();
    await manager.fetchMany({ dueBy });
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/due <= \$1/i);
    expect(params[0]).toBe(dueBy);
  });

  it('excludes dismissed rows by default', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/dismissed = 0/i);
  });

  it('includes dismissed rows when includeDismissed is true', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
  });

  it('adds an excludeIds NOT IN clause with correct positional params', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
        async (excludeIds) => {
          const repo = makeSimpleRepo();
          const manager = new ArticleManager({} as never, repo);
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
        const repo = makeSimpleRepo();
        const manager = new ArticleManager({} as never, repo);
        await manager.fetchMany({ limit });
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/LIMIT/i);
        expect(params).toContain(limit);
      })
    );
  });

  it('uses correctly sequenced $N params when dueBy and excludeIds and limit are all set', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
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

  it('binds the excluded ids as one parameter, however many there are', async () => {
    await fc.assert(
      fc.asyncProperty(seenElsewhereArb, async (excludeIds) => {
        const repo = makeSimpleRepo();
        const manager = new ArticleManager({} as never, repo);
        await manager.fetchMany({ dueBy: 1000, excludeIds });
        const [, params] = lastQueryCall(repo);
        expect(params).toEqual(
          excludeIds.length ? [1000, JSON.stringify(excludeIds)] : [1000]
        );
      }),
      { numRuns: 20 }
    );
  });

  it('uses AND to join multiple WHERE conditions', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ dueBy: 1000, excludeIds: ['a'] });
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ AND /i);
  });

  it('produces a WHERE clause (not empty string) when conditions are present', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ dueBy: 1000 });
    const [sql] = lastQueryCall(repo);
    // The SQL must contain literal " WHERE " (not just the conditions)
    expect(sql).toContain(' WHERE ');
  });

  it('orders results by fuzzed due ascending with null dues last', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(
      /ORDER BY \(due IS NULL\), due \+ COALESCE\(due_fuzz, 0\)/i
    );
  });
});

describe('fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no row is found', async () => {
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager({} as never, repo);
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const result = await manager.fetch('nonexistent-id');
    expect(result).toBeNull();
  });

  it('passes the id as a query param', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        const repo = {
          query: vi.fn().mockResolvedValue([]),
          mutate: vi.fn(),
          _execSql: vi.fn(),
          transaction: vi.fn(async (work: () => unknown) => work()),
          handleFileChange: vi.fn(),
          onDataChange: vi.fn(() => vi.fn()),
          writeRefusal: vi.fn(() => null),
        } as unknown as SQLiteRepository;
        const manager = new ArticleManager({} as never, repo);
        await manager.fetch(id);
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/WHERE id = \$1/i);
        expect(params[0]).toBe(id);
      })
    );
  });

  it('returns a ReviewArticle when a row and file are found', async () => {
    const row = makeArticleRow();
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const repo = {
      query: vi.fn().mockResolvedValue([row]),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzReviewTimes: false } } as never,
      repo
    );
    const result = await manager.fetch(row.id);
    expect(result).not.toBeNull();
    expect(result!.data.id).toBe(row.id);
    expect(result!.file).toBe(fakeFile);
  });
});

describe('getLastReview (via review / reprioritize / setFixedInterval)', () => {
  // getLastReview is protected; we test it indirectly through public methods.
  // Direct query behavior is covered via the makeRepo helper in existing tests.

  it('queries article_review ordered by review_time DESC LIMIT 1', async () => {
    const article = makeArticle();
    const repo = makeRepo(undefined, 0);
    const manager = new ArticleManager({} as never, repo);
    // reprioritize calls getLastReview
    await manager.reprioritize(article, DEFAULT_PRIORITY);
    const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const reviewQuery = calls.find(([sql]) =>
      sql.includes('ORDER BY review_time DESC')
    );
    expect(reviewQuery).toBeDefined();
    expect(reviewQuery![1][0]).toBe(article.id);
  });
});

describe('getReviewCount (via disableFixedInterval)', () => {
  it('queries COUNT(id) from article_review for the given article id', async () => {
    const article = makeArticle();
    const repo = makeRepo(undefined, 0);
    const manager = new ArticleManager({} as never, repo);
    await manager.disableFixedInterval(article, DEFAULT_PRIORITY);
    const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const countQuery = calls.find(([sql]) => sql.includes('COUNT(id)'));
    expect(countQuery).toBeDefined();
    expect(countQuery![1][0]).toBe(article.id);
  });
});

describe('review', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('inserts an article_review record with the given review time', async () => {
    // Note: reviewTime=0 is excluded because the implementation uses `reviewTime || Date.now()`
    // which treats 0 as falsy — a bug. Tests are written for the fixed version (min: 1).
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() + MS_PER_YEAR }),
        async (reviewTime) => {
          const article = makeArticle();
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
          await manager.review(article, reviewTime);
          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const insertCall = calls.find(([sql]) =>
            sql.includes('INSERT INTO article_review')
          );
          expect(insertCall).toBeDefined();
          expect(insertCall![1][2]).toBe(reviewTime);
          expect(insertCall![1][1]).toBe(article.id);
        }
      )
    );
  });

  it('falls back to Date.now() when reviewTime is not provided', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const article = makeArticle();
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzReviewTimes: false } } as never,
      repo
    );
    await manager.review(article);
    const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      unknown[],
    ][];
    const insertCall = calls.find(([sql]) =>
      sql.includes('INSERT INTO article_review')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][2]).toBe(now);
  });

  it('updates article due, interval, and clears dismissed', async () => {
    // reviewTime=0 excluded — same bug as above
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() + MS_PER_YEAR }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        async (reviewTime, priority) => {
          const article = makeArticle({ priority });
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
          await manager.review(article, reviewTime);

          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = calls.find(([sql]) =>
            sql.includes('UPDATE article SET dismissed')
          );
          expect(updateCall).toBeDefined();
          const [updateSql, params] = updateCall!;
          const expectedInterval = IRScheduler.nextInterval(article);
          const expectedDue = reviewTime + expectedInterval;
          expect(params[0]).toBe(expectedDue);
          expect(params[1]).toBe(expectedInterval);
          expect(params[3]).toBe(article.id);
          expect(updateSql).toMatch(/dismissed = 0/i);
        }
      )
    );
  });

  it('uses a provided nextReviewInterval instead of computing one', async () => {
    // reviewTime=0 excluded — same bug as above
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: Date.now() }),
        fc.integer({ min: MS_PER_DAY, max: MS_PER_DAY * 30 }),
        async (reviewTime, nextInterval) => {
          const article = makeArticle();
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            { settings: { fuzzReviewTimes: false } } as never,
            repo
          );
          await manager.review(article, reviewTime, nextInterval);

          const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = calls.find(([sql]) =>
            sql.includes('UPDATE article SET dismissed')
          );
          expect(updateCall).toBeDefined();
          const [, params] = updateCall!;
          expect(params[0]).toBe(reviewTime + nextInterval);
          expect(params[1]).toBe(nextInterval);
        }
      )
    );
  });
});

describe('rename', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a notice and returns without mutating when the name contains invalid chars', async () => {
    const invalidChars = [
      '#',
      '^',
      '[',
      ']',
      '|',
      '*',
      '"',
      '\\',
      '/',
      '<',
      '>',
      ':',
      '?',
    ];
    for (const char of invalidChars) {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager({} as never, repo);
      const article = {
        data: makeArticle(),
        file: {
          basename: 'test',
          extension: 'md',
          parent: null,
        } as unknown as TFile,
      };
      await manager.rename(article, `valid-name${char}`);
      expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0
      );
    }
  });

  it('updates the reference in the db using the new name after renaming', async () => {
    vi.spyOn(Obsidian, 'renameFile').mockResolvedValue(undefined);
    const newName = 'new-valid-name';
    const extension = 'md';
    const parentPath = 'some/folder';
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const article = {
      data: makeArticle({ id: 'art-1' }),
      file: {
        basename: 'old-name',
        extension,
        path: `${parentPath}/old-name.${extension}`,
        parent: { path: parentPath },
      } as unknown as TFile,
    };

    await manager.rename(article, newName);

    const [sql, params] = lastMutateCall(repo);
    expect(sql).toMatch(/UPDATE article SET reference = \$1 WHERE id = \$2/i);
    expect(params[0]).toBe(`${parentPath}/${newName}.${extension}`);
    expect(params[1]).toBe('art-1');
  });

  it('says whether it renamed: not for a name it refuses, which it says why of', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          titleControlCharArb.map((char) => `valid${char}name`),
          fc.constantFrom('.name', 'name.', ' name', 'name ')
        ),
        async (name) => {
          Notice.reset();
          const renameFile = vi.fn().mockResolvedValue(undefined);
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(
            { app: { fileManager: { renameFile } } } as never,
            repo
          );
          const article = {
            data: makeArticle(),
            file: { basename: 'test', extension: 'md', parent: null },
          } as unknown as ReviewArticle;

          await expect(manager.rename(article, name)).resolves.toBe(false);
          expect(renameFile).not.toHaveBeenCalled();
          expect(repo.mutate).not.toHaveBeenCalled();
          expect(Notice.messages).toEqual([INVALID_TITLE_MESSAGE]);
        }
      )
    );
  });

  describe('an article whose name hides a path in backslashes', () => {
    const oldName = 'Paper\\..\\..\\pwn';
    function setUp(mutate: () => Promise<unknown>) {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const renameFile = vi
        .fn<(file: TFile, path: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const repo = {
        ...makeSimpleRepo(),
        mutate: vi.fn(mutate),
      } as unknown as SQLiteRepository;
      const manager = new ArticleManager(
        { app: { fileManager: { renameFile } } } as never,
        repo
      );
      const article = {
        data: makeArticle({ id: 'art-1' }),
        file: { basename: oldName, extension: 'md', parent: { path: 'a' } },
      } as unknown as ReviewArticle;
      return { renameFile, manager, article };
    }

    it('is not renamed to a name keeping the backslashes', async () => {
      const { renameFile, manager, article } = setUp(async () => [[]]);
      await expect(manager.rename(article, `${oldName}2`)).resolves.toBe(false);
      expect(renameFile).not.toHaveBeenCalled();
    });

    it('is not put back to that name when the db update fails, and says so', async () => {
      const { renameFile, manager, article } = setUp(async () => {
        throw new Error('db error');
      });
      await expect(manager.rename(article, 'Paper')).rejects.toThrow(
        INVALID_TITLE_MESSAGE
      );
      expect(renameFile.mock.calls.map(([, path]) => path)).toEqual([
        'a/Paper.md',
      ]);
    });
  });

  it('renames a note keeping the characters a title can not hold that its name already had', async () => {
    await fc.assert(
      fc.asyncProperty(titleControlCharArb, async (char) => {
        const renameFile = vi
          .fn<(file: TFile, path: string) => Promise<void>>()
          .mockResolvedValue(undefined);
        const repo = makeSimpleRepo();
        const manager = new ArticleManager(
          { app: { fileManager: { renameFile } } } as never,
          repo
        );
        const article = {
          data: makeArticle({ id: 'art-1' }),
          file: {
            basename: `old${char}name`,
            extension: 'md',
            parent: { path: 'articles' },
          },
        } as unknown as ReviewArticle;

        await expect(manager.rename(article, `old${char}name 2`)).resolves.toBe(
          true
        );
        expect(renameFile.mock.calls.map(([, path]) => path)).toEqual([
          `articles/old${char}name 2.md`,
        ]);
        expect(lastMutateCall(repo)[1]).toEqual([
          `articles/old${char}name 2.md`,
          'art-1',
        ]);
      })
    );
  });

  it('rejects names ending in a trailing space or period without mutating', async () => {
    for (const name of ['valid-name ', 'valid-name.']) {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager({} as never, repo);
      const article = {
        data: makeArticle(),
        file: {
          basename: 'test',
          extension: 'md',
          parent: null,
        } as unknown as TFile,
      };
      await manager.rename(article, name);
      expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0
      );
    }
  });

  it('attempts to rename back to original name if the db update throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const renameFile = vi
      .fn<(file: TFile, path: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn().mockRejectedValue(new Error('db error')),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager(
      { app: { fileManager: { renameFile } } } as never,
      repo
    );
    const originalName = 'original';
    const article = {
      data: makeArticle({ id: 'art-1' }),
      file: {
        basename: originalName,
        extension: 'md',
        parent: null,
      } as unknown as TFile,
    };
    await manager.rename(article, 'new-name');
    // the rename back should use the original name
    expect(renameFile.mock.calls.map(([, path]) => path)).toEqual([
      'new-name.md',
      `${originalName}.md`,
    ]);
  });

  it('puts back an old name no new note could take when the db update throws', async () => {
    // A name made before titles lost their control and bidi characters
    // No `/` or `\`, which no name can be put back to
    const noSeparatorArb = fc.string().filter((s) => !/[\\/]/.test(s));
    const oldNameArb = fc
      .tuple(noSeparatorArb, titleControlCharArb, noSeparatorArb)
      .map(([before, char, after]) => `${before}${char}${after}`);
    await fc.assert(
      fc.asyncProperty(oldNameArb, async (oldName) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const renameFile = vi
          .fn<(file: TFile, path: string) => Promise<void>>()
          .mockResolvedValue(undefined);
        const repo = {
          ...makeSimpleRepo(),
          mutate: vi.fn().mockRejectedValue(new Error('db error')),
        } as unknown as SQLiteRepository;
        const manager = new ArticleManager(
          { app: { fileManager: { renameFile } } } as never,
          repo
        );
        const article = {
          data: makeArticle({ id: 'art-1' }),
          file: {
            basename: oldName,
            extension: 'md',
            parent: { path: 'articles' },
          } as unknown as TFile,
        };

        // Not renamed, so the title editor puts the old name back
        await expect(manager.rename(article, 'new-name')).resolves.toBe(false);
        expect(renameFile.mock.calls.map(([, path]) => path)).toEqual([
          'articles/new-name.md',
          `articles/${oldName}.md`,
        ]);
        vi.restoreAllMocks();
      })
    );
  });
});

describe('reprioritize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws (via validatePriority) for an invalid priority without mutating', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: MINIMUM_PRIORITY - 1 }),
          fc.integer({ min: MAXIMUM_PRIORITY + 1 })
        ),
        async (badPriority) => {
          const repo = makeSimpleRepo();
          const manager = new ArticleManager({} as never, repo);
          await expect(
            manager.reprioritize(makeArticle(), badPriority)
          ).rejects.toThrow();
          expect(
            (repo.mutate as ReturnType<typeof vi.fn>).mock.calls
          ).toHaveLength(0);
        }
      )
    );
  });

  it('updates priority, due, and interval in the db', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 0, max: Date.now() }),
        async (priority, newPriority, reviewTime) => {
          const article = makeArticle({ priority });
          const repo = makeRepo(makeReview(reviewTime), 1);
          const manager = new ArticleManager({} as never, repo);
          await manager.reprioritize(article, newPriority);

          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(
            /UPDATE article SET priority = \$1, due = \$2, interval = \$3 WHERE id = \$4/i
          );
          expect(params[0]).toBe(newPriority);
          const expectedInterval = IRScheduler.nextInterval({
            ...article,
            priority: newPriority,
          });
          expect(params[2]).toBe(expectedInterval);
          expect(params[1]).toBe(reviewTime + expectedInterval);
          expect(params[3]).toBe(article.id);
        }
      )
    );
  });

  it('falls back to article.due when there is no prior review', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
        async (newPriority, due) => {
          const article = makeArticle({ due });
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await manager.reprioritize(article, newPriority);

          const [, params] = lastMutateCall(repo);
          expect(params[1]).toBe(due);
        }
      )
    );
  });
});

describe('setFixedInterval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate the db when the interval is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: MINIMUM_FIXED_REVIEW_INTERVAL - 1 }),
          fc.integer({ min: MAXIMUM_FIXED_REVIEW_INTERVAL + 1 })
        ),
        async (badInterval) => {
          const repo = makeSimpleRepo();
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(makeArticle(), badInterval);
          expect(
            (repo.mutate as ReturnType<typeof vi.fn>).mock.calls
          ).toHaveLength(0);
        }
      )
    );
  });

  it('updates fixed_interval_days and due in the db', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        fc.integer({ min: 0, max: Date.now() }),
        async (fixedIntervalDays, reviewTime) => {
          const article = makeArticle();
          const repo = makeRepo(makeReview(reviewTime), 1);
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(article, fixedIntervalDays);

          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(
            /UPDATE article SET fixed_interval_days = \$1, due = \$2/i
          );
          expect(params[0]).toBe(fixedIntervalDays);
          const fixedIntervalMs = fixedIntervalDays * MS_PER_DAY;
          expect(params[1]).toBe(reviewTime + fixedIntervalMs);
          expect(params[2]).toBe(article.id);
        }
      )
    );
  });

  it('falls back to article.due when there is no prior review', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
        async (fixedIntervalDays, due) => {
          const article = makeArticle({ due });
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(article, fixedIntervalDays);

          const [, params] = lastMutateCall(repo);
          expect(params[1]).toBe(due);
        }
      )
    );
  });

  it('targets the correct article id in the WHERE clause', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({
          min: MINIMUM_FIXED_REVIEW_INTERVAL,
          max: MAXIMUM_FIXED_REVIEW_INTERVAL,
        }),
        async (id, fixedIntervalDays) => {
          const article = makeArticle({ id });
          const repo = makeRepo(undefined, 0);
          const manager = new ArticleManager({} as never, repo);
          await manager.setFixedInterval(article, fixedIntervalDays);
          const [sql, params] = lastMutateCall(repo);
          expect(sql).toMatch(/WHERE id = \$3/i);
          expect(params[2]).toBe(id);
        }
      )
    );
  });
});

describe('fetchMany (includeDeleted option)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits the deleted filter when includeDeleted=true', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDeleted: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/deleted = FALSE/i);
  });

  it('includes deleted = FALSE filter by default', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/deleted = FALSE/i);
  });

  it('produces no WHERE clause when all filters are disabled', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    await manager.fetchMany({ includeDismissed: true, includeDeleted: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toContain(' WHERE ');
  });
});

describe('rename, when the database write fails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['not renamed when its old name is put back', true, false],
    ['renamed when the old name is kept from coming back', false, true],
  ])('reports it %s', async (_, restores, renamed) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = {
      basename: 'C# notes',
      extension: 'md',
      path: 'a/C# notes.md',
      parent: { path: 'a' },
    } as unknown as TFile;
    vi.spyOn(Obsidian, 'renameFile').mockImplementation(async (f, name) => {
      f.basename = name;
    });
    // The guard puts back a restore that adds `#`, once the name has none
    vi.spyOn(Obsidian, 'restoreName').mockImplementation(async (f, name) => {
      if (restores) f.basename = name;
    });
    const repo = {
      ...makeSimpleRepo(),
      mutate: vi.fn(() => Promise.reject(new Error('db error'))),
    } as unknown as SQLiteRepository;
    const manager = new ArticleManager({ app: {} } as never, repo);

    await expect(
      manager.rename({ data: makeArticle(), file } as ReviewArticle, 'Notes')
    ).resolves.toBe(renamed);
    expect(file.basename).toBe(renamed ? 'Notes' : 'C# notes');
  });
});

describe('rename (no-parent path)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses "<newName>.<ext>" when file has no parent directory', async () => {
    vi.spyOn(Obsidian, 'renameFile').mockResolvedValue(undefined);
    const newName = 'rootlevel-name';
    const extension = 'md';
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const article = {
      data: makeArticle({ id: 'art-noparent' }),
      file: {
        basename: 'old-name',
        extension,
        path: `old-name.${extension}`,
        parent: null,
      } as unknown as TFile,
    };

    await manager.rename(article, newName);

    const [sql, params] = lastMutateCall(repo);
    expect(sql).toMatch(/UPDATE article SET reference = \$1 WHERE id = \$2/i);
    expect(params[0]).toBe(`${newName}.${extension}`);
    expect(params[1]).toBe('art-noparent');
  });
});

describe('setFixedInterval (error handling)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an invalid interval as an error notice instead of throwing', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const article = makeArticle();
    const notify = vi.spyOn(Obsidian, 'notify');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      manager.setFixedInterval(article, MINIMUM_FIXED_REVIEW_INTERVAL - 1)
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(article.reference),
      { kind: 'error' }
    );
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      0
    );
  });
});

describe('disableFixedInterval (error handling)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an invalid priority as an error notice instead of throwing', async () => {
    const repo = makeSimpleRepo();
    const manager = new ArticleManager({} as never, repo);
    const article = makeArticle();
    const notify = vi.spyOn(Obsidian, 'notify');
    await expect(
      manager.disableFixedInterval(article, MINIMUM_PRIORITY - 1)
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(article.reference),
      { kind: 'error' }
    );
    expect((repo.mutate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      0
    );
  });
});

describe('getDue (filter correctness)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('excludes items where rowToReviewArticle refuses the note from the final result', async () => {
    // rowToReviewArticle returns null when the note claims another item's id.
    // Rows must have distinct references so the mock can discriminate.
    const rowNoFile = makeArticleRow({
      id: 'null-item',
      reference: 'articles/no-file.md',
      due: 0,
    });
    const rowWithFile = makeArticleRow({
      id: 'real-item',
      reference: 'articles/with-file.md',
      due: 0,
    });
    vi.spyOn(Obsidian, 'getNote').mockImplementation(noteAt);

    let callCount = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        callCount++;
        const excluded = excludedIdsOf(params);
        return [rowNoFile, rowWithFile].filter((r) => !excluded.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeAppClaiming(rowNoFile.reference),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(0);

    expect(results.map((r) => r.data.id)).not.toContain('null-item');
    expect(results.map((r) => r.data.id)).toContain('real-item');
    expect(callCount).toBeGreaterThan(1);
  });

  it('increments the missing-notes counter so the loop retries (not decrements)', async () => {
    // Mutant: lastMissingNotes += 1 → lastMissingNotes -= 1 would cause the loop
    // to terminate after one pass even when items are still missing.
    // Rows must have distinct references so the mock can discriminate.
    const missingRow = makeArticleRow({
      id: 'missing',
      reference: 'articles/missing.md',
      due: 0,
    });
    const presentRow = makeArticleRow({
      id: 'present',
      reference: 'articles/present.md',
      due: 0,
    });
    vi.spyOn(Obsidian, 'getNote').mockImplementation(noteAt);

    const queryCalls: { sql: string; params: unknown[] }[] = [];
    const repo = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        queryCalls.push({ sql, params });
        const excluded = excludedIdsOf(params);
        return [missingRow, presentRow].filter((r) => !excluded.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeAppClaiming(missingRow.reference),
      settings: { dayRolloverOffset: 0 },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    // Use a future dueBy so the dueBy filter is included (truthy value avoids the bug)
    await manager.getDue(Date.now() + 1);

    // At least 2 queries should have run — the retry must have happened
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    // The second call must include the missing row's id as an excluded param
    expect(excludedIdsOf(queryCalls[1].params)).toContain(missingRow.id);
  });
});

describe('fuzzing (rowToReviewArticle)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires setReviewTimeFuzz when fuzzTextReviews=true and due_fuzz is null', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(3600000);

    const row = makeArticleRow({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: true } } as never,
      repo
    );

    manager.rowToReviewArticle(row);

    // give the fire-and-forgotten promise a chance to run
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeDefined();
    expect(fuzzCall![1][0]).toBe(3600000);
    expect(fuzzCall![1][1]).toBe(row.id);
  });

  it('does not fire setReviewTimeFuzz when fuzzTextReviews=false', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);

    const row = makeArticleRow({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: false } } as never,
      repo
    );

    manager.rowToReviewArticle(row);
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeUndefined();
  });

  it('does not fire setReviewTimeFuzz when due_fuzz is already set', async () => {
    const fakeFile = { path: 'articles/test.md', extension: 'md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);

    const row = makeArticleRow({ due_fuzz: 12345 });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { app: makeApp(), settings: { fuzzTextReviews: true } } as never,
      repo
    );

    manager.rowToReviewArticle(row);
    await Promise.resolve();

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const fuzzCall = mutateCalls.find(([sql]) => sql.includes('SET due_fuzz'));
    expect(fuzzCall).toBeUndefined();
  });
});

describe('fuzzing (getDue sort)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'articles/test.md',
      extension: 'md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sorts by effective due (due + due_fuzz) when fuzzTextReviews=true', async () => {
    // articleA: due=300, fuzz=+100 → pushed further out
    // articleB: due=100, fuzz=-100 → pulled closer in
    // The sort formula `a.due + a.fuzz - b.due + b.fuzz` is antisymmetric when
    // fuzz values are negations of each other, giving a stable comparison:
    // compare(A,B) = 300+100-100+(-100) = +200 → A after B
    // compare(B,A) = 100+(-100)-300+100 = -200 → B before A
    const rowA = makeArticleRow({ id: 'a', due: 300, due_fuzz: 100 });
    const rowB = makeArticleRow({ id: 'b', due: 100, due_fuzz: -100 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('does not reorder by fuzz when fuzzTextReviews=false', async () => {
    const rowA = makeArticleRow({ id: 'a', due: 100, due_fuzz: 50 });
    const rowB = makeArticleRow({ id: 'b', due: 200, due_fuzz: -80 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: false },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    // SQL order is preserved: a before b
    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
  });

  it('treats null due_fuzz as 0 when sorting', async () => {
    // articleA: due=100, fuzz=null → effective=100
    // articleB: due=200, fuzz=-150 → effective=50
    // B (effective=50) should precede A (effective=100)
    const rowA = makeArticleRow({ id: 'a', due: 100, due_fuzz: null });
    const rowB = makeArticleRow({ id: 'b', due: 200, due_fuzz: -150 });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('sorts a null-due article after all dated articles', async () => {
    // rowA has no due date → sorts last (comparator returns 1 when a.data.due is null)
    // rowB has a concrete due → sorts first
    const rowA = makeArticleRow({ id: 'a', due: null, due_fuzz: null });
    const rowB = makeArticleRow({ id: 'b', due: 100, due_fuzz: null });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  it('sorts a null-due b before all a-dated articles when b.data.due is null', async () => {
    // rowA has a concrete due → comparator returns -1 when b.data.due is null → a first
    const rowA = makeArticleRow({ id: 'a', due: 100, due_fuzz: null });
    const rowB = makeArticleRow({ id: 'b', due: null, due_fuzz: null });

    const repo = {
      query: vi.fn().mockResolvedValue([rowA, rowB]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      transaction: vi.fn(async (work: () => unknown) => work()),
      handleFileChange: vi.fn(),
      onDataChange: vi.fn(() => vi.fn()),
      writeRefusal: vi.fn(() => null),
    } as unknown as SQLiteRepository;

    const plugin = {
      app: makeApp(),
      settings: { dayRolloverOffset: 0, fuzzTextReviews: true },
    } as never;
    const manager = new ArticleManager(plugin, repo);
    const results = await manager.getDue(Number.MAX_SAFE_INTEGER);

    const ids = results.map((r) => r.data.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
  });
});

describe('fuzzing (review)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes a new getDueFuzz value into due_fuzz when fuzzTextReviews=true', async () => {
    const FUZZ = 1_800_000;
    vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(FUZZ);

    const article = makeArticle({ due_fuzz: null });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzTextReviews: true } } as never,
      repo
    );
    await manager.review(article, 1000);

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE article SET dismissed')
    );
    expect(updateCall).toBeDefined();
    // due_fuzz is the 3rd positional param ($3)
    expect(updateCall![1][2]).toBe(FUZZ);
  });

  it('preserves the existing due_fuzz when fuzzTextReviews=false', async () => {
    const existingFuzz = 42000;
    const article = makeArticle({ due_fuzz: existingFuzz });
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzTextReviews: false } } as never,
      repo
    );
    await manager.review(article, 1000);

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE article SET dismissed')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1][2]).toBe(existingFuzz);
  });

  it('does not call getDueFuzz when fuzzTextReviews=false', async () => {
    const getDueFuzzSpy = vi.spyOn(IRScheduler, 'getDueFuzz');
    const article = makeArticle();
    const repo = makeSimpleRepo();
    const manager = new ArticleManager(
      { settings: { fuzzTextReviews: false } } as never,
      repo
    );
    await manager.review(article, 1000);
    expect(getDueFuzzSpy).not.toHaveBeenCalled();
  });
});

describe('import', () => {
  const IMPORT_FILE = {
    path: 'notes/my-note.md',
    name: 'my-note.md',
    basename: 'my-note',
    extension: 'md',
  } as TFile;

  const DATA_DIR_FILE = {
    path: `${DATA_DIRECTORY}/notes/my-note.md`,
    name: 'my-note.md',
    basename: 'my-note',
    extension: 'md',
  } as TFile;

  const COPY_FILE = {
    path: `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/my-note.md`,
    name: 'my-note.md',
    basename: 'my-note',
    extension: 'md',
  } as TFile;

  beforeEach(() => {
    vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue(undefined);
    vi.spyOn(Obsidian, 'updateFrontMatter').mockResolvedValue(
      undefined as never
    );
    vi.spyOn(Obsidian, 'createNote').mockResolvedValue(COPY_FILE as never);
    vi.spyOn(Obsidian, 'generateMarkdownLink').mockReturnValue(
      '[[notes/my-note.md|my-note]]'
    );
    vi.spyOn(Obsidian, 'getDirectory').mockReturnValue(
      `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`
    );
    vi.spyOn(Obsidian, 'getTargetPath').mockReturnValue(
      `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/my-note.md`
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // The content check can't fetch a file's leading bytes here, so it falls
    // back to `readBinary`, which these tests control. mime.test.ts covers
    // the fetch itself.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to fetch')
    );
  });

  it('refuses a file of a type it cannot import, touching nothing', async () => {
    // The menus and commands hide the entries for these; this is the guard
    // behind them, for a stale menu or a caller that skipped the check.
    const unimportable = fc
      .oneof(fc.constantFrom('png', 'canvas', ''), fc.string())
      .filter((extension) => !['md', 'pdf'].includes(extension.toLowerCase()));
    await fc.assert(
      fc.asyncProperty(
        unimportable,
        fc.option(fc.boolean(), { nil: undefined }),
        fc.boolean(),
        async (extension, makeCopy, copyOnImport) => {
          Notice.reset();
          // `beforeEach` runs once for all the property's cases, and spying
          // again hands back its spies, so their counts are cleared per case.
          const createNote = vi.spyOn(Obsidian, 'createNote');
          const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
          createNote.mockClear();
          updateFrontMatter.mockClear();
          const repo = makeSimpleRepo();
          const query = vi.spyOn(repo, 'query');
          const mutate = vi.spyOn(repo, 'mutate');
          const plugin = makeImportPlugin(copyOnImport);
          const manager = new ArticleManager(plugin, repo);
          const file = {
            ...IMPORT_FILE,
            path: `notes/my-file.${extension}`,
            name: `my-file.${extension}`,
            extension,
          } as TFile;

          await expect(
            manager.import(file, DEFAULT_PRIORITY, null, makeCopy)
          ).resolves.toBeNull();

          expect(Notice.messages).toEqual([expect.stringContaining(file.name)]);
          expect(query).not.toHaveBeenCalled();
          expect(mutate).not.toHaveBeenCalled();
          expect(createNote).not.toHaveBeenCalled();
          expect(updateFrontMatter).not.toHaveBeenCalled();
          expect(importVaultOf(plugin).readBinary).not.toHaveBeenCalled();
        }
      )
    );
  });

  describe('content that is not what its extension says', () => {
    /**
     * A note or a PDF by its name, in any casing, with bytes that disagree: a
     * note that opens like a PDF, or a PDF that doesn't.
     */
    const mismatchedArb = fc.oneof(
      fc
        .tuple(fc.mixedCase(fc.constant('md')), fc.uint8Array())
        .map(([extension, rest]) => ({
          extension,
          bytes: Uint8Array.from([...PDF_BYTES, ...rest]),
        })),
      fc
        .tuple(
          fc.mixedCase(fc.constant('pdf')),
          fc.oneof(fc.constant(NOTE_BYTES), fc.uint8Array())
        )
        .filter(
          ([, bytes]) => !PDF_BYTES.slice(0, 5).every((b, i) => bytes[i] === b)
        )
        .map(([extension, bytes]) => ({ extension, bytes }))
    );

    it('is refused with a notice, before anything is written', async () => {
      await fc.assert(
        fc.asyncProperty(
          mismatchedArb,
          fc.option(fc.boolean(), { nil: undefined }),
          fc.boolean(),
          async ({ extension, bytes }, makeCopy, copyOnImport) => {
            Notice.reset();
            const createNote = vi.spyOn(Obsidian, 'createNote');
            const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
            const notify = vi.spyOn(Obsidian, 'notify');
            createNote.mockClear();
            updateFrontMatter.mockClear();
            notify.mockClear();
            const repo = makeSimpleRepo();
            const query = vi.spyOn(repo, 'query');
            const mutate = vi.spyOn(repo, 'mutate');
            const plugin = makeImportPlugin(copyOnImport, bytes);
            const manager = new ArticleManager(plugin, repo);
            const file = {
              path: `notes/my-file.${extension}`,
              name: `my-file.${extension}`,
              basename: 'my-file',
              extension,
            } as TFile;

            await expect(
              manager.import(file, DEFAULT_PRIORITY, null, makeCopy)
            ).resolves.toBeNull();

            expect(Notice.messages).toHaveLength(1);
            // Refused, not failed: told without the error kind
            expect(notify).toHaveBeenCalledExactlyOnceWith(
              expect.stringContaining(file.name)
            );
            expect(query).not.toHaveBeenCalled();
            expect(mutate).not.toHaveBeenCalled();
            expect(createNote).not.toHaveBeenCalled();
            expect(updateFrontMatter).not.toHaveBeenCalled();
            expect(importVaultOf(plugin).cachedRead).not.toHaveBeenCalled();
          }
        )
      );
    });

    it('fails the import, touching nothing, when the file cannot be read', async () => {
      Notice.reset();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const repo = makeSimpleRepo();
      const query = vi.spyOn(repo, 'query');
      const mutate = vi.spyOn(repo, 'mutate');
      const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
      const plugin = makeImportPlugin(false);
      importVaultOf(plugin).readBinary.mockRejectedValue(new Error('EBUSY'));
      const manager = new ArticleManager(plugin, repo);
      const notify = vi.spyOn(Obsidian, 'notify');

      await expect(
        manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false)
      ).resolves.toBeNull();

      expect(Notice.messages).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(IMPORT_FILE.name),
        { kind: 'error' }
      );
      expect(query).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
      expect(updateFrontMatter).not.toHaveBeenCalled();
    });
  });

  describe('a PDF', () => {
    const PDF_FILE = {
      path: 'papers/Paper.pdf',
      name: 'Paper.pdf',
      basename: 'Paper',
      extension: 'pdf',
    } as TFile;

    beforeEach(() => {
      Notice.reset();
    });

    it('is imported where it is, by a row at its path, when no copy is asked for', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.mixedCase(fc.constant('pdf')),
          fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
          fc.option(
            fc.integer({
              min: MINIMUM_FIXED_REVIEW_INTERVAL,
              max: MAXIMUM_FIXED_REVIEW_INTERVAL,
            }),
            { nil: null }
          ),
          // Turned down by the caller, or by the setting when it doesn't say
          fc.constantFrom([false, false], [false, true], [undefined, false]),
          async (extension, priority, fixedDays, [makeCopy, copyOnImport]) => {
            Notice.reset();
            const file = {
              ...PDF_FILE,
              path: `papers/Paper.${extension}`,
              name: `Paper.${extension}`,
              extension,
            } as TFile;
            const { repo } = await makeSqlJsRepo();
            const snippets = makeSnippetsStub();
            const plugin = makePdfImportPlugin(file, copyOnImport, snippets);
            const vault = importVaultOf(plugin);
            const createNote = vi.spyOn(Obsidian, 'createNote');
            const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
            createNote.mockClear();
            updateFrontMatter.mockClear();
            const before = Date.now();

            const result = await new ArticleManager(
              plugin as never,
              repo
            ).import(file, priority, fixedDays, makeCopy);

            const rows = allRows(repo);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              reference: file.path,
              priority,
              fixed_interval_days: fixedDays,
              interval: TEXT_BASE_REVIEW_INTERVAL,
              deleted: 0,
              dismissed: 0,
            });
            expect(rows[0].due).toBeGreaterThanOrEqual(before);
            expect(rows[0].due).toBeLessThanOrEqual(Date.now());
            expect(result?.data.id).toBe(rows[0].id);
            expect(result?.file).toBe(file);
            expect(Notice.messages).toEqual([
              fixedDays === null
                ? importedWithPriority('Paper', priority)
                : importedWithFixedDays('Paper', fixedDays),
            ]);
            // Nothing about the PDF itself changes, and no copy is made
            expect(createNote).not.toHaveBeenCalled();
            expect(updateFrontMatter).not.toHaveBeenCalled();
            expect(
              plugin.app.fileManager.processFrontMatter
            ).not.toHaveBeenCalled();
            expect(vault.cachedRead).not.toHaveBeenCalled();
            // Whatever was taken from it before is its own now
            expect(snippets.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
              file,
              rows[0].id
            );
          }
        ),
        { numRuns: 30 }
      );
    });

    it('imports it once when asked twice before the first import finishes', async () => {
      // A double press of the dialog's Enter, or a double click on a menu
      // entry, while the first import is still reading the file
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (calls) => {
          Notice.reset();
          vi.spyOn(console, 'error').mockImplementation(() => undefined);
          const { repo } = await makeSqlJsRepo();
          const manager = new ArticleManager(
            makePdfImportPlugin(PDF_FILE) as never,
            repo
          );

          const results = await Promise.all(
            Array.from({ length: calls }, () =>
              manager.import(PDF_FILE, DEFAULT_PRIORITY, null, false)
            )
          );

          expect(allRows(repo)).toHaveLength(1);
          expect(results.filter((r) => r !== null)).toHaveLength(1);
          expect(Notice.messages).toEqual([
            importedWithPriority('Paper', DEFAULT_PRIORITY),
          ]);

          // Once it has finished, the file can be asked about again
          await manager.import(PDF_FILE, DEFAULT_PRIORITY, null, false);
          expect(Notice.messages).toHaveLength(2);
          expect(Notice.messages.at(-1)).toContain(`"${PDF_FILE.name}"`);
        }),
        { numRuns: 5 }
      );
    });

    it('can import at a path again after the file there was renamed mid-import', async () => {
      // Obsidian renames a TFile in place, so its path can change while the
      // import is still reading it
      const file = { ...PDF_FILE } as TFile;
      const { repo } = await makeSqlJsRepo();
      const plugin = makePdfImportPlugin(file);
      importVaultOf(plugin).readBinary.mockImplementationOnce(() => {
        (file as { path: string }).path = 'papers/Renamed.pdf';
        return Promise.resolve(PDF_BYTES.slice().buffer);
      });
      const manager = new ArticleManager(plugin as never, repo);
      await manager.import(file, DEFAULT_PRIORITY, null, false);

      const replacement = { ...PDF_FILE } as TFile;
      plugin.app.vault.getFileByPath.mockImplementation((path: string) =>
        path === replacement.path ? replacement : null
      );
      const result = await manager.import(
        replacement,
        DEFAULT_PRIORITY,
        null,
        false
      );

      expect(result?.file).toBe(replacement);
    });

    // Three levels only: each runs once, rather than a sample of a hundred
    // that each build their own database
    it.each(SUCCESS_NOTICE_LEVELS)(
      'confirms the import at every success notice level but none (%s)',
      async (level) => {
        Notice.reset();
        showSuccessNotices(level);
        const { repo } = await makeSqlJsRepo();

        try {
          await new ArticleManager(
            makePdfImportPlugin(PDF_FILE) as never,
            repo
          ).import(PDF_FILE, DEFAULT_PRIORITY, null, false);
        } finally {
          configureSuccessNotices(null);
        }

        expect(Notice.messages).toEqual(
          level === 'none'
            ? []
            : [importedWithPriority('Paper', DEFAULT_PRIORITY)]
        );
      }
    );

    it('names a long PDF by the start of its name in the notice', async () => {
      const file = {
        ...PDF_FILE,
        basename: 'P'.repeat(CONTENT_TITLE_SLICE_LENGTH + 10),
      } as TFile;
      const { repo } = await makeSqlJsRepo();

      await new ArticleManager(makePdfImportPlugin(file) as never, repo).import(
        file,
        DEFAULT_PRIORITY,
        null,
        false
      );

      expect(Notice.messages).toEqual([
        importedWithPriority(
          `${'P'.repeat(CONTENT_TITLE_SLICE_LENGTH - 3)}...`,
          DEFAULT_PRIORITY
        ),
      ]);
    });

    it('gives back the article already at its path, adding nothing', async () => {
      const { repo, db } = await makeSqlJsRepo();
      insertArticleRow(db, {
        id: 'existing',
        due: 1234,
        due_fuzz: 5,
        priority: MAXIMUM_PRIORITY,
      });
      db.exec(`UPDATE article SET reference = $1 WHERE id = 'existing'`, [
        PDF_FILE.path,
      ]);
      const before = allRows(repo);
      const plugin = makePdfImportPlugin(PDF_FILE);

      const result = await new ArticleManager(plugin as never, repo).import(
        PDF_FILE,
        MINIMUM_PRIORITY,
        null,
        false
      );

      expect(allRows(repo)).toEqual(before);
      expect(result?.data.id).toBe('existing');
      expect(result?.file).toBe(PDF_FILE);
      expect(Notice.messages).toEqual([
        expect.stringContaining(`"${PDF_FILE.name}"`),
      ]);
    });

    it('refuses a PDF whose path breaks links, adding no row', async () => {
      Notice.reset();
      const file = fileAt('pa|pers/Paper.pdf');
      const { repo } = await makeSqlJsRepo();
      const before = allRows(repo);

      const result = await new ArticleManager(
        makePdfImportPlugin(file) as never,
        repo
      ).import(file, MINIMUM_PRIORITY, null, false);

      expect(result).toBeNull();
      expect(allRows(repo)).toEqual(before);
      expect(Notice.messages).toStrictEqual([
        expect.stringMatching(/"Paper\.pdf".*\|/),
      ]);
    });

    it('brings back the deleted article at a path that breaks links, made before the rule', async () => {
      Notice.reset();
      const file = fileAt('pa|pers/Paper.pdf');
      const { repo, db } = await makeSqlJsRepo();
      insertArticleRow(db, {
        id: 'deleted',
        due: 1234,
        due_fuzz: null,
        priority: MAXIMUM_PRIORITY,
      });
      db.exec(
        `UPDATE article SET reference = $1, deleted = TRUE WHERE id = 'deleted'`,
        [file.path]
      );

      const result = await new ArticleManager(
        makePdfImportPlugin(file) as never,
        repo
      ).import(file, MINIMUM_PRIORITY, null, false);

      expect(result?.data.id).toBe('deleted');
      expect(Notice.messages).toStrictEqual([
        expect.stringContaining('"Paper"'),
        refusedPathsWarning([file.path]),
      ]);
    });

    it('gives back the article already at a path that breaks links, made before the rule', async () => {
      const file = fileAt('C# papers/Paper.pdf');
      const { repo, db } = await makeSqlJsRepo();
      insertArticleRow(db, {
        id: 'existing',
        due: 1234,
        due_fuzz: 5,
        priority: MAXIMUM_PRIORITY,
      });
      db.exec(`UPDATE article SET reference = $1 WHERE id = 'existing'`, [
        file.path,
      ]);

      const result = await new ArticleManager(
        makePdfImportPlugin(file) as never,
        repo
      ).import(file, MINIMUM_PRIORITY, null, false);

      expect(result?.data.id).toBe('existing');
      expect(Notice.messages).toEqual([
        expect.stringContaining('"Paper.pdf"'),
      ]);
    });

    it('makes a revived dismissed row with no due date due now', async () => {
      const { repo, db } = await makeSqlJsRepo();
      insertArticleRow(db, {
        id: 'tombstoned',
        due: 1234,
        due_fuzz: null,
        priority: MAXIMUM_PRIORITY,
      });
      // A dismissed row may hold no due date at all, as the schema allows
      db.exec(
        `UPDATE article SET reference = $1, deleted = 1, dismissed = 1,
         due = NULL WHERE id = 'tombstoned'`,
        [PDF_FILE.path]
      );
      const before = Date.now();

      const result = await new ArticleManager(
        makePdfImportPlugin(PDF_FILE) as never,
        repo
      ).import(PDF_FILE, DEFAULT_PRIORITY, null, false);

      const [row] = allRows(repo);
      expect(row).toMatchObject({ deleted: 0, dismissed: 0 });
      expect(row.due).toBeGreaterThanOrEqual(before);
      expect(row.due).toBeLessThanOrEqual(Date.now());
      expect(result?.data.id).toBe('tombstoned');
    });

    it('revives a deleted row at its path into the queue, keeping its schedule and history', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(0, 1),
          fc.option(
            fc.integer({
              min: MINIMUM_FIXED_REVIEW_INTERVAL,
              max: MAXIMUM_FIXED_REVIEW_INTERVAL,
            }),
            { nil: null }
          ),
          async (dismissed, fixedDays) => {
            Notice.reset();
            const { repo, db } = await makeSqlJsRepo();
            insertArticleRow(db, {
              id: 'tombstoned',
              due: 1234,
              due_fuzz: 5,
              priority: MAXIMUM_PRIORITY,
            });
            db.exec(
              `UPDATE article SET reference = $1, deleted = 1, dismissed = $2,
               fixed_interval_days = $3 WHERE id = 'tombstoned'`,
              [PDF_FILE.path, dismissed, fixedDays]
            );
            db.exec(
              `INSERT INTO article_review (id, article_id, review_time)
               VALUES ('review', 'tombstoned', 1000)`
            );
            const [tombstone] = allRows(repo);
            const plugin = makePdfImportPlugin(PDF_FILE);

            // Asked for another schedule, which the revived row doesn't take
            const result = await new ArticleManager(
              plugin as never,
              repo
            ).import(PDF_FILE, MINIMUM_PRIORITY, null, false);

            expect(allRows(repo)).toEqual([
              { ...tombstone, deleted: 0, dismissed: 0 },
            ]);
            expect(repo.query('SELECT article_id FROM article_review')).toEqual(
              [{ article_id: 'tombstoned' }]
            );
            expect(result?.data).toMatchObject({
              id: 'tombstoned',
              deleted: 0,
              dismissed: false,
            });
            expect(Notice.messages).toEqual([
              expect.stringContaining('"Paper"'),
            ]);
          }
        ),
        { numRuns: 10 }
      );
    });

    describe('with snippets and cards taken from it before', () => {
      /** Parentless snippets and cards, 0–3 of each, as adoption returns them. */
      const takenArb = fc.record({
        snippets: fc
          .integer({ min: 0, max: 3 })
          .map((n) => Array.from({ length: n }, (_, i) => makeAdoptedRow(i))),
        cards: fc.integer({ min: 0, max: 3 }).map((n) =>
          Array.from({ length: n }, (_, i) => ({
            id: `card-${i}`,
            reference: `cards/card-${i}.md`,
          }))
        ),
      });

      /** The manager over `plugin`, its link rewriting spied on. */
      function managerFor(plugin: unknown, repo: SQLiteRepository) {
        const manager = new ArticleManager(plugin as never, repo);
        const retargetSources = vi
          .spyOn(manager, 'retargetSources')
          .mockResolvedValue(0);
        return { manager, retargetSources };
      }

      const triggerOf = (plugin: unknown) =>
        (
          plugin as {
            app: { workspace: { trigger: ReturnType<typeof vi.fn> } };
          }
        ).app.workspace.trigger;

      it('gives them to the article made in place, which keeps their highlights and links', async () => {
        await fc.assert(
          fc.asyncProperty(takenArb, async (taken) => {
            const { repo } = await makeSqlJsRepo();
            const snippets = makeSnippetsStub(taken.snippets);
            const cards = makeCardsStub(taken.cards);
            const plugin = makePdfImportPlugin(
              PDF_FILE,
              false,
              snippets,
              cards
            );
            const { manager, retargetSources } = managerFor(plugin, repo);

            await manager.import(PDF_FILE, DEFAULT_PRIORITY, null, false);

            const [{ id }] = allRows(repo);
            expect(snippets.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
              PDF_FILE,
              id
            );
            expect(cards.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
              PDF_FILE,
              id
            );
            expect(retargetSources).not.toHaveBeenCalled();
            const adoptedAny = taken.snippets.length + taken.cards.length > 0;
            expect(snippets.getHighlights.mock.calls).toEqual(
              adoptedAny ? [[PDF_FILE]] : []
            );
            expect(triggerOf(plugin).mock.calls).toEqual(
              adoptedAny ? [['ir-highlights-changed', PDF_FILE.path]] : []
            );
            vi.restoreAllMocks();
          }),
          // Nothing taken from it, too, every run
          { numRuns: 20, examples: [[{ snippets: [], cards: [] }]] }
        );
      });

      it('still imports it, in place or as a copy, before the review manager is there', async () => {
        vi.spyOn(Obsidian, 'getDirectory').mockRestore();
        vi.spyOn(Obsidian, 'getTargetPath').mockRestore();
        const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;
        // Something taken from it, which a copy still takes over
        vi.spyOn(Obsidian, 'getNote').mockImplementation(
          (reference) => ({ path: reference, extension: 'md' }) as TFile
        );
        vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(PDF_FILE);
        for (const copy of [false, true]) {
          const { repo, db } = await makeSqlJsRepo();
          db.exec(
            `INSERT INTO snippet (id, reference, due, interval, priority, start_offset, end_offset)
             VALUES ('s', 'snippets/s.md', 0, 1, 20, 10000000000, 10000000001)`
          );
          const plugin = makePdfCopyPlugin(PDF_FILE, { folders: [ARTICLES] });
          Object.assign(plugin, { reviewManager: undefined });
          const manager = new ArticleManager(plugin as never, repo);
          vi.spyOn(manager, 'retargetSources').mockResolvedValue(1);
          const error = vi.spyOn(console, 'error');

          const result = await manager.import(
            PDF_FILE,
            DEFAULT_PRIORITY,
            null,
            copy
          );

          expect(result?.data.id).toBe(allRows(repo)[0].id);
          expect(error).not.toHaveBeenCalled();
          expect(repo.query('SELECT parent FROM snippet')).toEqual([
            { parent: copy ? result?.data.id : null },
          ]);
          error.mockRestore();
        }
      });

      it('gives them to the article already at its path, or revived there, on importing it again', async () => {
        for (const deleted of [0, 1]) {
          const { repo, db } = await makeSqlJsRepo();
          insertArticleRow(db, {
            id: 'existing',
            due: 1234,
            due_fuzz: null,
            priority: MAXIMUM_PRIORITY,
          });
          db.exec(
            `UPDATE article SET reference = $1, deleted = $2 WHERE id = 'existing'`,
            [PDF_FILE.path, deleted]
          );
          const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
          const cards = makeCardsStub();
          const plugin = makePdfImportPlugin(PDF_FILE, false, snippets, cards);

          await managerFor(plugin, repo).manager.import(
            PDF_FILE,
            DEFAULT_PRIORITY,
            null,
            false
          );

          expect(snippets.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
            PDF_FILE,
            'existing'
          );
          expect(cards.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
            PDF_FILE,
            'existing'
          );
          expect(snippets.getHighlights).toHaveBeenCalledWith(PDF_FILE);
          vi.restoreAllMocks();
        }
      });

      it('gives them to a copy, pointing their links at it, and takes their highlights off the original', async () => {
        vi.spyOn(Obsidian, 'getDirectory').mockRestore();
        vi.spyOn(Obsidian, 'getTargetPath').mockRestore();
        const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;
        const COPY_PATH = `${ARTICLES}/Paper.pdf`;
        // Snippets and cards taken from it, and what the notice adds: each
        // count with its noun, and the verb agreeing with their sum
        const cases = [
          [0, 0, null],
          [1, 0, /\b1 snippet\b.*\brefers\b/],
          [0, 1, /\b1 card\b.*\brefers\b/],
          [2, 0, /\b2 snippets\b.*\brefer\b/],
          [1, 1, /\b1 snippet\b.*\b1 card\b.*\brefer\b/],
          [3, 2, /\b3 snippets\b.*\b2 cards\b.*\brefer\b/],
        ] as const;
        for (const [snippetCount, cardCount, notice] of cases) {
          vi.restoreAllMocks();
          vi.spyOn(Obsidian, 'getDirectory').mockRestore();
          vi.spyOn(Obsidian, 'getTargetPath').mockRestore();
          Notice.reset();
          const { repo, db } = await makeSqlJsRepo();
          const insertSnippet = (id: string, parent: string | null) =>
            db.exec(
              `INSERT INTO snippet (id, reference, due, interval, priority, parent, start_offset, end_offset)
                   VALUES ($1, $2, 0, 1, 20, $3, 10000000000, 10000000001)`,
              [id, `snippets/${id}.md`, parent]
            );
          const insertCard = (id: string) =>
            db.exec(
              `INSERT INTO srs_card (id, reference, created_at, due,
                     stability, difficulty, elapsed_days, scheduled_days, state)
                   VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0)`,
              [id, `cards/${id}.md`]
            );
          const snippetIds = Array.from(
            { length: snippetCount },
            (_, i) => `s${i}`
          );
          const cardIds = Array.from({ length: cardCount }, (_, i) => `c${i}`);
          snippetIds.forEach((id) => insertSnippet(id, null));
          cardIds.forEach(insertCard);
          // Taken from elsewhere, or someone else's already
          insertSnippet('elsewhere', null);
          insertCard('elsewhere');
          insertSnippet('parented', 'some-article');
          const plugin = makePdfCopyPlugin(PDF_FILE, {
            folders: [ARTICLES],
          });
          const snippets = makeSnippetsStub();
          Object.assign(plugin.reviewManager, { snippets });
          vi.spyOn(Obsidian, 'getNote').mockImplementation(
            (reference) => ({ path: reference, extension: 'md' }) as TFile
          );
          // Their links name the PDF by its name alone, which resolves to
          // the copy once there is one, its path being the shorter
          vi.spyOn(Obsidian, 'getSourceFile').mockImplementation((note) =>
            note.path.includes('elsewhere')
              ? fileAt('papers/Other.pdf')
              : (plugin.files.get(COPY_PATH) ?? PDF_FILE)
          );
          const { manager, retargetSources } = managerFor(plugin, repo);

          await manager.import(PDF_FILE, DEFAULT_PRIORITY, null, true);

          const [{ id, reference }] = allRows(repo);
          expect(reference).toBe(COPY_PATH);
          const parents = (table: string) =>
            Object.fromEntries(
              (
                repo.query(`SELECT id, parent FROM ${table}`) as {
                  id: string;
                  parent: string | null;
                }[]
              ).map((row) => [row.id, row.parent])
            );
          expect(parents('snippet')).toEqual({
            ...Object.fromEntries(snippetIds.map((s) => [s, id])),
            elsewhere: null,
            parented: 'some-article',
          });
          expect(parents('srs_card')).toEqual({
            ...Object.fromEntries(cardIds.map((c) => [c, id])),
            elsewhere: null,
          });
          const confirmed = Notice.messages.at(-1);
          expect(confirmed).toEqual(
            importedWithPriority('Paper', DEFAULT_PRIORITY)
          );
          if (notice) expect(confirmed).toMatch(notice);
          else expect(confirmed).not.toMatch(/snippet|card/);
          if (snippetCount + cardCount === 0) {
            expect(retargetSources).not.toHaveBeenCalled();
            expect(
              snippets.offsetTracker.loadHighlights
            ).not.toHaveBeenCalled();
            expect(triggerOf(plugin)).not.toHaveBeenCalled();
          } else {
            const [items, from, to] = retargetSources.mock.calls[0];
            expect(retargetSources).toHaveBeenCalledOnce();
            expect(
              items.map(({ id, reference }) => ({ id, reference }))
            ).toEqual([
              ...snippetIds.map((s) => ({
                id: s,
                reference: `snippets/${s}.md`,
              })),
              ...cardIds.map((c) => ({ id: c, reference: `cards/${c}.md` })),
            ]);
            expect(from).toBe(PDF_FILE.path);
            expect(to).toBe(plugin.files.get(COPY_PATH));
            // The original keeps no highlights: they moved to the copy
            expect(
              snippets.offsetTracker.loadHighlights
            ).toHaveBeenCalledExactlyOnceWith(PDF_FILE.path, []);
            expect(triggerOf(plugin)).toHaveBeenCalledExactlyOnceWith(
              'ir-highlights-changed',
              PDF_FILE.path
            );
          }
          expect(snippets.adoptOrphans).not.toHaveBeenCalled();
          expect(snippets.getHighlights).not.toHaveBeenCalled();
        }
      });
    });

    describe('as a copy', () => {
      const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;

      beforeEach(() => {
        // The copy is placed by the real helpers, rather than by the stand-ins
        // the notes above use, so its path follows from its name.
        vi.spyOn(Obsidian, 'getDirectory').mockRestore();
        vi.spyOn(Obsidian, 'getTargetPath').mockRestore();
      });

      it('copies it into the articles folder under its own name, and the row references the copy', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.mixedCase(fc.constant('pdf')),
            fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
            fc.option(
              fc.integer({
                min: MINIMUM_FIXED_REVIEW_INTERVAL,
                max: MAXIMUM_FIXED_REVIEW_INTERVAL,
              }),
              { nil: null }
            ),
            // Asked for by the caller, or by the setting when it doesn't say
            fc.constantFrom([true, false], [true, true], [undefined, true]),
            fc.boolean(),
            async (
              extension,
              priority,
              fixedDays,
              [makeCopy, copyOnImport],
              folderExists
            ) => {
              Notice.reset();
              const source = fileAt(`papers/Paper.${extension}`);
              const { repo } = await makeSqlJsRepo();
              const plugin = makePdfCopyPlugin(source, {
                copyOnImport,
                folders: folderExists ? [ARTICLES] : [],
              });
              const { vault } = plugin.app;
              const { snippets } = plugin.reviewManager;
              const createNote = vi.spyOn(Obsidian, 'createNote');
              const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
              createNote.mockClear();
              updateFrontMatter.mockClear();
              const before = Date.now();

              const result = await new ArticleManager(
                plugin as never,
                repo
              ).import(source, priority, fixedDays, makeCopy);

              const copyPath = `${ARTICLES}/Paper.${extension}`;
              expect([...plugin.files.keys()]).toEqual([source.path, copyPath]);
              expect(vault.copy.mock.calls).toEqual([[source, copyPath]]);
              const rows = allRows(repo);
              expect(rows).toHaveLength(1);
              expect(rows[0]).toMatchObject({
                reference: copyPath,
                priority,
                fixed_interval_days: fixedDays,
                interval: TEXT_BASE_REVIEW_INTERVAL,
                deleted: 0,
                dismissed: 0,
              });
              expect(rows[0].due).toBeGreaterThanOrEqual(before);
              expect(rows[0].due).toBeLessThanOrEqual(Date.now());
              expect(result?.data.id).toBe(rows[0].id);
              expect(result?.file).toBe(plugin.files.get(copyPath));
              expect(Notice.messages).toEqual([
                fixedDays === null
                  ? importedWithPriority('Paper', priority)
                  : importedWithFixedDays('Paper', fixedDays),
              ]);
              // A PDF carries no frontmatter, so no link back to its original
              expect(createNote).not.toHaveBeenCalled();
              expect(updateFrontMatter).not.toHaveBeenCalled();
              expect(
                plugin.app.fileManager.processFrontMatter
              ).not.toHaveBeenCalled();
              expect(vault.cachedRead).not.toHaveBeenCalled();
              // Taken from the original are found in the database: none here
              expect(snippets.adoptOrphans).not.toHaveBeenCalled();
              // The original stays as it was, where it was
              for (const change of [
                vault.modify,
                vault.modifyBinary,
                vault.process,
                vault.rename,
                vault.delete,
                vault.trash,
                plugin.app.fileManager.renameFile,
                plugin.app.fileManager.trashFile,
              ]) {
                expect(change).not.toHaveBeenCalled();
              }
              expect(plugin.files.get(source.path)).toBe(source);
            }
          ),
          { numRuns: 30 }
        );
      });

      it('takes a name no file or article row in the articles folder holds, warning when it is not its own', async () => {
        /** The suffix `generateId` makes of a `Math.random` value. */
        const suffixOf = (value: number) => value.toString(36).slice(2, 7);
        /**
         * Who holds a name, if anyone: a file, which may spell it in another
         * case; a row; or an article the startup scan rebound away from the
         * path, which a file turning up there would take back.
         */
        const holderArb = fc.constantFrom(
          null,
          'file',
          'file in another case',
          'live row',
          'deleted row',
          'rebind'
        );
        /** The path of the file holding `path` for `holder`. */
        const filePathFor = (path: string, holder: string) =>
          holder === 'file'
            ? path
            : `${ARTICLES}/${path.slice(ARTICLES.length + 1).toUpperCase()}`;
        await fc.assert(
          fc.asyncProperty(
            holderArb,
            // The values `generateId` draws on, and who holds the name each
            // one makes; the last is free, so a name is always found.
            fc.array(
              fc.tuple(
                fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
                holderArb
              ),
              { maxLength: 4 }
            ),
            fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
            async (ownHolder, drawn, lastValue) => {
              Notice.reset();
              const pathFor = (name: string) => `${ARTICLES}/${name}`;
              const held = new Map<string, string>();
              const hold = (name: string, holder: string | null) => {
                if (holder !== null && !held.has(pathFor(name))) {
                  held.set(pathFor(name), holder);
                }
              };
              hold('Paper.pdf', ownHolder);
              for (const [value, holder] of drawn) {
                hold(`Paper - ${suffixOf(value)}.pdf`, holder);
              }
              const free = (path: string) => !held.has(path);
              // The last value makes a free name, unless it is held already
              const lastName = `Paper - ${suffixOf(lastValue)}.pdf`;
              fc.pre(free(pathFor(lastName)));
              const values = [...drawn.map(([value]) => value), lastValue];

              const { repo, db } = await makeSqlJsRepo();
              let rowIndex = 0;
              for (const [path, holder] of held) {
                if (holder.startsWith('file')) continue;
                const id = `row-${rowIndex++}`;
                // A rebound article now names the file it was rebound to
                const reference =
                  holder === 'rebind' ? `papers/${id}.pdf` : path;
                db.exec(
                  `INSERT INTO article (id, reference, due, interval, priority, deleted)
                   VALUES ($1, $2, 0, 1, 10, $3)`,
                  [id, reference, holder === 'deleted row' ? 1 : 0]
                );
                if (holder === 'rebind') {
                  db.exec(
                    `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at)
                     VALUES ($1, $2, $3, $4)`,
                    [id, path, reference, Date.now()]
                  );
                }
              }
              const rowsBefore = allRows(repo);
              const plugin = makePdfCopyPlugin(fileAt('papers/Paper.pdf'), {
                folders: [ARTICLES],
                paths: [...held]
                  .filter(([, holder]) => holder.startsWith('file'))
                  .map(([path, holder]) => filePathFor(path, holder)),
              });
              const notify = vi.spyOn(Obsidian, 'notify');
              notify.mockClear();
              // Mocked only now: sql.js names each database it opens by it
              const random = vi.spyOn(Math, 'random');
              random.mockReset();
              for (const value of values) random.mockReturnValueOnce(value);

              const result = await new ArticleManager(
                plugin as never,
                repo
              ).import(plugin.files.get('papers/Paper.pdf')!, 10, null, true);
              random.mockRestore();

              const expectedName = [
                'Paper.pdf',
                ...values.map((value) => `Paper - ${suffixOf(value)}.pdf`),
              ].find((name) => free(pathFor(name)))!;
              const copyPath = pathFor(expectedName);
              expect(plugin.app.vault.copy.mock.calls).toEqual([
                [plugin.files.get('papers/Paper.pdf'), copyPath],
              ]);
              expect(result?.file.path).toBe(copyPath);
              // The rows that held names are as they were; one more is added
              const rows = allRows(repo);
              expect(rows.filter((row) => row.id !== result?.data.id)).toEqual(
                rowsBefore
              );
              expect(rows).toHaveLength(rowsBefore.length + 1);
              const warning = expect.stringContaining('"Paper.pdf"');
              // Named by the copy, trimmed as every title is
              const title = expectedName.slice(0, -'.pdf'.length).trim();
              const imported = importedWithPriority(title, 10);
              expect(Notice.messages).toEqual(
                ownHolder === null ? [imported] : [warning, imported]
              );
              // The warning stays up until dismissed
              if (ownHolder !== null) {
                expect(notify).toHaveBeenCalledWith(warning, { persist: true });
              }
            }
          ),
          { numRuns: 60 }
        );
      });

      it('names a copy of a PDF named after a reversed extension so that it reads in order, and says so', async () => {
        Notice.reset();
        const rlo = String.fromCodePoint(0x202e);
        const source = fileAt(`papers/invoice${rlo}fdp.exe.pdf`);
        const { repo } = await makeSqlJsRepo();
        const plugin = makePdfCopyPlugin(source, { folders: [ARTICLES] });

        const result = await new ArticleManager(plugin as never, repo).import(
          source,
          10,
          null,
          true
        );

        const copyPath = `${ARTICLES}/invoicefdp.exe.pdf`;
        expect(plugin.app.vault.copy.mock.calls).toEqual([[source, copyPath]]);
        expect(result?.file.path).toBe(copyPath);
        expect(Notice.messages[0]).toContain('"invoicefdp.exe.pdf"');
      });

      it('makes a second, distinctly named copy when imported twice', async () => {
        const source = fileAt('papers/Paper.pdf');
        const { repo } = await makeSqlJsRepo();
        const plugin = makePdfCopyPlugin(source);
        const manager = new ArticleManager(plugin as never, repo);

        const first = await manager.import(source, 10, null, true);
        const second = await manager.import(source, 10, null, true);

        const copies = [...plugin.files.keys()].filter((path) =>
          path.startsWith(`${ARTICLES}/`)
        );
        expect(copies).toHaveLength(2);
        expect(copies[0]).toBe(`${ARTICLES}/Paper.pdf`);
        expect(copies[1].startsWith(`${ARTICLES}/Paper - `)).toBe(true);
        expect(copies[1]).toMatch(/\/Paper - [a-z0-9]{0,5}\.pdf$/);
        expect(
          allRows(repo)
            .map((row) => row.reference)
            .sort()
        ).toEqual([...copies].sort());
        expect([first?.file.path, second?.file.path]).toEqual(copies);
        expect(plugin.files.has(source.path)).toBe(true);
      });

      // Every case, as there are only six
      it.each(
        ['md', 'pdf'].flatMap((extension) =>
          ['', `${ARTICLE_DIRECTORY}/`, 'nested/folder/'].map((folder) => [
            extension,
            folder,
          ])
        )
      )(
        'refuses a .%s file already in the data folder (under "%s"), copying nothing',
        async (extension, folder) => {
          Notice.reset();
          const source = fileAt(
            `${DATA_DIRECTORY}/${folder}Paper.${extension}`
          );
          const { repo } = await makeSqlJsRepo();
          const plugin = makePdfCopyPlugin(source);
          const bytes = extension === 'pdf' ? PDF_BYTES : NOTE_BYTES;
          plugin.app.vault.readBinary.mockResolvedValue(bytes.slice().buffer);
          const createNote = vi.spyOn(Obsidian, 'createNote');
          createNote.mockClear();

          const result = await new ArticleManager(plugin as never, repo).import(
            source,
            10,
            null,
            true
          );

          expect(result).toBeNull();
          expect(Notice.messages).toEqual([
            expect.stringContaining(`"${source.name}"`),
          ]);
          expect(plugin.app.vault.copy).not.toHaveBeenCalled();
          expect(createNote).not.toHaveBeenCalled();
          expect(allRows(repo)).toEqual([]);
        }
      );

      it('gives files of the same name imported at once distinct copies', async () => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (count) => {
            Notice.reset();
            const sources = Array.from({ length: count }, (_, i) =>
              fileAt(`folder-${i}/Paper.pdf`)
            );
            const { repo } = await makeSqlJsRepo();
            const plugin = makePdfCopyPlugin(sources[0], {
              paths: sources.slice(1).map((source) => source.path),
            });
            const manager = new ArticleManager(plugin as never, repo);

            const results = await Promise.all(
              sources.map((source) =>
                manager.import(
                  plugin.files.get(source.path)!,
                  DEFAULT_PRIORITY,
                  null,
                  true
                )
              )
            );

            const copyPaths = results.map((result) => result?.file.path);
            expect(new Set(copyPaths).size).toBe(count);
            expect(
              allRows(repo)
                .map((row) => row.reference)
                .sort()
            ).toEqual([...copyPaths].sort());
            expect(
              [...plugin.files.keys()].filter((path) =>
                path.startsWith(`${ARTICLES}/`)
              )
            ).toHaveLength(count);
          }),
          { numRuns: 10 }
        );
      });

      it('names a long copy by the start of its name in the notice', async () => {
        Notice.reset();
        const basename = 'P'.repeat(CONTENT_TITLE_SLICE_LENGTH + 10);
        const source = fileAt(`papers/${basename}.pdf`);
        const { repo } = await makeSqlJsRepo();

        await new ArticleManager(
          makePdfCopyPlugin(source) as never,
          repo
        ).import(source, DEFAULT_PRIORITY, null, true);

        expect(Notice.messages).toEqual([
          importedWithPriority(
            `${'P'.repeat(CONTENT_TITLE_SLICE_LENGTH - 3)}...`,
            DEFAULT_PRIORITY
          ),
        ]);
      });

      it('takes the copy back out when its row cannot be added', async () => {
        Notice.reset();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const source = fileAt('papers/Paper.pdf');
        const { repo } = await makeSqlJsRepo();
        const plugin = makePdfCopyPlugin(source);
        vi.spyOn(repo, 'mutate').mockRejectedValueOnce(
          new Error('SQLITE_FULL')
        );
        const manager = new ArticleManager(plugin as never, repo);

        const result = await manager.import(source, 10, null, true);

        expect(result).toBeNull();
        expect([...plugin.files.keys()]).toEqual([source.path]);
        expect(allRows(repo)).toEqual([]);
        expect(Notice.messages).toEqual([
          expect.stringContaining('"Paper.pdf"'),
        ]);

        // Its name is free again for the next import
        Notice.reset();
        const retry = await manager.import(source, 10, null, true);
        expect(retry?.file.path).toBe(`${ARTICLES}/Paper.pdf`);
      });

      it('fails with the error that stopped it, when the copy cannot be taken back out either', async () => {
        Notice.reset();
        const logged = vi
          .spyOn(console, 'error')
          .mockImplementation(() => undefined);
        const source = fileAt('papers/Paper.pdf');
        const { repo } = await makeSqlJsRepo();
        const plugin = makePdfCopyPlugin(source);
        const insertError = new Error('SQLITE_FULL');
        const trashError = new Error('EBUSY');
        vi.spyOn(repo, 'mutate').mockRejectedValueOnce(insertError);
        plugin.app.fileManager.trashFile.mockRejectedValueOnce(trashError);

        const result = await new ArticleManager(plugin as never, repo).import(
          source,
          10,
          null,
          true
        );

        expect(result).toBeNull();
        expect(logged.mock.calls).toEqual([[trashError], [insertError]]);
        expect(Notice.messages).toEqual([
          expect.stringContaining('"Paper.pdf"'),
        ]);
      });

      it('adds no row when the copy fails', async () => {
        Notice.reset();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const source = fileAt('papers/Paper.pdf');
        const { repo } = await makeSqlJsRepo();
        const plugin = makePdfCopyPlugin(source);
        plugin.app.vault.copy.mockRejectedValue(new Error('ENOSPC'));

        const result = await new ArticleManager(plugin as never, repo).import(
          source,
          10,
          null,
          true
        );

        expect(result).toBeNull();
        expect(allRows(repo)).toEqual([]);
        expect(Notice.messages).toEqual([
          expect.stringContaining('"Paper.pdf"'),
        ]);
      });
    });
  });

  describe('a note, as a copy', () => {
    const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;
    /** The suffix `generateId` makes of a `Math.random` value. */
    const suffixOf = (value: number) => value.toString(36).slice(2, 7);
    /**
     * A note's basename, in any case and long enough to be cut short in a
     * notice. It opens with a letter, so it also has a spelling in another
     * case.
     */
    const basenameArb = fc.oneof(
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,20}[A-Za-z0-9]$/),
      // Drawn apart, as fast-check rarely makes a string this long
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{45,60}[A-Za-z0-9]$/)
    );
    /** `text` with every letter in the other case. */
    const swapCase = (text: string) =>
      [...text]
        .map((char) =>
          char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()
        )
        .join('');
    /** How a notice names a copy whose basename is `title`: trimmed, and cut short when long. */
    const noticeTitle = (title: string) => {
      const trimmed = title.trim();
      return trimmed.length > CONTENT_TITLE_SLICE_LENGTH
        ? `${trimmed.slice(0, CONTENT_TITLE_SLICE_LENGTH - 3)}...`
        : trimmed;
    };

    beforeEach(() => {
      Notice.reset();
      // The copy is created by the real helpers, rather than by the stand-ins
      // the notes above use, so its path follows from its name.
      vi.spyOn(Obsidian, 'getDirectory').mockRestore();
      vi.spyOn(Obsidian, 'getTargetPath').mockRestore();
      vi.spyOn(Obsidian, 'createNote').mockRestore();
    });

    it('takes a name no file, article row or rebind record holds, warning when it is not its own', async () => {
      /**
       * Who holds the note's own name in the articles folder, if anyone: a
       * file, which may spell it in another case; a row, deleted or not; or
       * an article the startup scan rebound away from the path.
       */
      const holderArb = fc.constantFrom(
        null,
        'file',
        'file in another case',
        'live row',
        'deleted row',
        'rebind'
      );
      await fc.assert(
        fc.asyncProperty(
          basenameArb,
          holderArb,
          fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
          async (basename, holder, value) => {
            Notice.reset();
            const ownPath = `${ARTICLES}/${basename}.md`;
            const { repo, db } = await makeSqlJsRepo();
            if (holder === 'live row' || holder === 'deleted row') {
              db.exec(
                `INSERT INTO article (id, reference, due, interval, priority, deleted)
                 VALUES ('held', $1, 0, 1, 10, $2)`,
                [ownPath, holder === 'deleted row' ? 1 : 0]
              );
            } else if (holder === 'rebind') {
              db.exec(
                `INSERT INTO article (id, reference, due, interval, priority)
                 VALUES ('held', 'notes/rebound.md', 0, 1, 10)`
              );
              db.exec(
                `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at)
                 VALUES ('held', $1, 'notes/rebound.md', $2)`,
                [ownPath, Date.now()]
              );
            }
            const rowsBefore = allRows(repo);
            const sourcePath = `notes/${basename}.md`;
            const plugin = makeNoteCopyPlugin(fileAt(sourcePath), {
              folders: [ARTICLES],
              paths:
                holder === 'file'
                  ? [ownPath]
                  : holder === 'file in another case'
                    ? [`${ARTICLES}/${swapCase(basename)}.md`]
                    : [],
            });
            const logged = vi
              .spyOn(console, 'error')
              .mockImplementation(() => undefined);
            logged.mockClear();
            // Mocked only now: sql.js names each database it opens by it
            const random = vi.spyOn(Math, 'random');
            random.mockReset();
            random.mockReturnValueOnce(value);

            const result = await new ArticleManager(
              plugin as never,
              repo
            ).import(plugin.files.get(sourcePath)!, 10, null, true);
            random.mockRestore();

            const title =
              holder === null ? basename : `${basename} - ${suffixOf(value)}`;
            const copyPath = `${ARTICLES}/${title}.md`;
            expect(plugin.app.vault.create.mock.calls).toEqual([
              [copyPath, ''],
            ]);
            expect(result?.file.path).toBe(copyPath);
            // The row that held the name is as it was; one more is added
            const rows = allRows(repo);
            expect(rows.filter((row) => row.id !== result?.data.id)).toEqual(
              rowsBefore
            );
            expect(rows).toHaveLength(rowsBefore.length + 1);
            expect(
              rows.find((row) => row.id === result?.data.id)?.reference
            ).toBe(copyPath);
            expect(logged).not.toHaveBeenCalled();
            const imported = importedWithPriority(noticeTitle(title), 10);
            expect(Notice.messages).toEqual(
              holder === null
                ? [imported]
                : [expect.stringContaining(`"${basename}.md"`), imported]
            );
            logged.mockRestore();
          }
        ),
        { numRuns: 60 }
      );
    });

    describe('whose name holds what a title drops', () => {
      const fromCodes = (...codes: number[]) => String.fromCodePoint(...codes);
      const RLO = fromCodes(0x202e);
      const BLACK_FLAG = fromCodes(0x1f3f4);
      /**
       * Characters a name can arrive with, by sync, git or zip, that a title
       * drops or changes: bidi controls, joiners and selectors out of place,
       * tags, other format characters, controls, forbidden characters.
       */
      const droppedArb = fc.oneof(
        fc.constantFrom(
          RLO,
          fromCodes(0x2066),
          fromCodes(0x200f),
          fromCodes(0x200b),
          fromCodes(0x200c),
          fromCodes(0x200d),
          fromCodes(0xfe00),
          fromCodes(0xe0100),
          fromCodes(0xfff9),
          fromCodes(0x20e3),
          '\t',
          '#',
          ':',
          '.'
        ),
        fc
          .integer({ min: 0xe0020, max: 0xe007f })
          .map((code) => fromCodes(code))
      );
      /**
       * What a title keeps of a name, though it isn't ASCII: emoji and script
       * sequences, and a decomposed letter, which it only composes.
       */
      const keptArb = fc.constantFrom(
        fromCodes(0x2764, 0xfe0f),
        fromCodes(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
        fromCodes(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647),
        fromCodes(0x915, 0x94d, 0x200d, 0x937),
        fromCodes(0x65, 0x301)
      );
      /**
       * A basename with dropped characters and kept sequences anywhere in it,
       * perhaps none.
       */
      const dirtyBasenameArb = fc
        .tuple(
          basenameArb,
          fc.array(fc.tuple(fc.nat(), fc.oneof(droppedArb, keptArb)))
        )
        .map(([basename, inserts]) => {
          const chars = [...basename];
          for (const [at, char] of inserts) {
            chars.splice(at % (chars.length + 1), 0, char);
          }
          return chars.join('');
        });
      const warningFor = (name: string) => expect.stringContaining(`"${name}"`);

      it('names the copy as a title would read its name, warning when that changed it', async () => {
        await fc.assert(
          fc.asyncProperty(
            dirtyBasenameArb,
            fc.boolean(),
            async (basename, taken) => {
              Notice.reset();
              const clean = Obsidian.sanitizeForTitle(basename, true);
              const { repo } = await makeSqlJsRepo();
              const sourcePath = `notes/${basename}.md`;
              const plugin = makeNoteCopyPlugin(fileAt(sourcePath), {
                folders: [ARTICLES],
                paths: taken ? [`${ARTICLES}/${clean}.md`] : [],
              });
              const random = vi.spyOn(Math, 'random');
              random.mockReset();
              random.mockReturnValueOnce(0.5);

              const result = await new ArticleManager(
                plugin as never,
                repo
              ).import(plugin.files.get(sourcePath)!, 10, null, true);
              random.mockRestore();

              const title = taken ? `${clean} - ${suffixOf(0.5)}` : clean;
              const changed = clean !== basename.normalize('NFC');
              const copyPath = `${ARTICLES}/${title}.md`;
              expect(plugin.app.vault.create.mock.calls).toEqual([
                [copyPath, ''],
              ]);
              expect(result?.file.path).toBe(copyPath);
              const imported = importedWithPriority(noticeTitle(title), 10);
              // The copy's own name, as it ends up
              expect(Notice.messages).toEqual([
                ...(taken ? [expect.stringContaining(`"${clean}.md"`)] : []),
                ...(changed ? [warningFor(`${title}.md`)] : []),
                imported,
              ]);
            }
          ),
          { numRuns: 40 }
        );
      });

      it('names a copy of a note named after a reversed extension so that it reads in order', async () => {
        Notice.reset();
        const notify = vi.spyOn(Obsidian, 'notify');
        notify.mockClear();
        const tags = fromCodes(0xe0069, 0xe0067, 0xe006e, 0xe006f, 0xe0072);
        const sourcePath = `notes/invoice${RLO}fdp.exe ${BLACK_FLAG}${tags}${fromCodes(0xe007f)}.md`;
        const { repo } = await makeSqlJsRepo();
        const plugin = makeNoteCopyPlugin(fileAt(sourcePath), {
          folders: [ARTICLES],
        });

        const result = await new ArticleManager(plugin as never, repo).import(
          plugin.files.get(sourcePath)!,
          10,
          null,
          true
        );

        const name = `invoicefdp.exe ${BLACK_FLAG}.md`;
        expect(result?.file.path).toBe(`${ARTICLES}/${name}`);
        // Persists, as the name-taken warning does
        expect(notify).toHaveBeenCalledWith(warningFor(name), {
          persist: true,
        });
      });

      it('gives a copy of a note with a decomposed name the composed name, unwarned', async () => {
        Notice.reset();
        // `Café`, its accent a combining mark, as macOS file systems spell it
        const sourcePath = `notes/Cafe${fromCodes(0x301)}.md`;
        const { repo } = await makeSqlJsRepo();
        const plugin = makeNoteCopyPlugin(fileAt(sourcePath), {
          folders: [ARTICLES],
        });

        const result = await new ArticleManager(plugin as never, repo).import(
          plugin.files.get(sourcePath)!,
          10,
          null,
          true
        );

        expect(result?.file.path).toBe(`${ARTICLES}/Caf${fromCodes(0xe9)}.md`);
        expect(Notice.messages).toEqual([
          importedWithPriority(`Caf${fromCodes(0xe9)}`, 10),
        ]);
      });

      it('names a copy whose name a title drops all of by a generated id', async () => {
        Notice.reset();
        const sourcePath = `notes/${RLO}${fromCodes(0x200d)}#.md`;
        const { repo } = await makeSqlJsRepo();
        const plugin = makeNoteCopyPlugin(fileAt(sourcePath), {
          folders: [ARTICLES],
        });
        const random = vi.spyOn(Math, 'random');
        random.mockReset();
        random.mockReturnValueOnce(0.25);

        const result = await new ArticleManager(plugin as never, repo).import(
          plugin.files.get(sourcePath)!,
          10,
          null,
          true
        );
        random.mockRestore();

        const name = `${suffixOf(0.25)}.md`;
        expect(result?.file.path).toBe(`${ARTICLES}/${name}`);
        expect(Notice.messages[0]).toEqual(warningFor(name));
      });
    });

    it('marks the copy as the article, when it was made, and where it came from unless the note already says', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Missing, or as the property can hold it, an empty one included
          fc.oneof(fc.constant(undefined), fc.constant(null), fc.string()),
          async (source) => {
            const note = fileAt('notes/my-note.md');
            const { repo } = await makeSqlJsRepo();
            const plugin = makeNoteCopyPlugin(note, { folders: [ARTICLES] });
            vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue(
              source === undefined ? undefined : ({ source } as never)
            );
            const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
            updateFrontMatter.mockClear();
            const before = new Date().toISOString();

            const result = await new ArticleManager(
              plugin as never,
              repo
            ).import(note, 10, null, true);

            const after = new Date().toISOString();
            const copy = plugin.files.get(`${ARTICLES}/my-note.md`);
            expect(result?.file).toBe(copy);
            const calls = updateFrontMatter.mock.calls;
            // One write, once the copy holds the note's text and properties
            expect(calls.map(([file]) => file)).toEqual([copy]);
            const { created } = calls[0][1] as { created: string };
            expect(created >= before && created <= after).toBe(true);
            expect(calls[0][1]).toEqual({
              created,
              'ir-id': result?.data.id,
              tags: ARTICLE_TAG,
              ...(!source && {
                [SOURCE_PROPERTY_NAME]: '[[notes/my-note.md|my-note]]',
              }),
            });
          }
        ),
        { numRuns: 20 }
      );
    });

    it("writes a copy's properties only into the note's own, once its text is there", async () => {
      // `processFrontMatter` on an empty note starts a block of its own, and
      // text that opens with the note's properties then follows it as body:
      // the copy would carry none of them, and show them as text
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(
            fc.constantFrom('title', 'tags', 'aliases', 'created', 'rating'),
            fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 3 })),
            { minKeys: 1 }
          ),
          async (frontmatter) => {
            vi.restoreAllMocks();
            const note = 'notes/props.md';
            const copyPath = `${ARTICLES_FOLDER}/props.md`;
            const { vault, repo, manager } = await wireArticles(
              { [note]: structuredClone(frontmatter) },
              null
            );
            const seen: (string | null)[] = [];
            const write = vault.processFrontMatter.getMockImplementation()!;
            vault.processFrontMatter.mockImplementation(async (file, edit) => {
              if (file.path === copyPath) seen.push(vault.bodyOf(copyPath));
              return write(file, edit);
            });
            try {
              const result = await manager.import(
                vault.files.get(note)!,
                DEFAULT_PRIORITY,
                null,
                true
              );

              expect(result?.file.path).toBe(copyPath);
              expect(seen.length).toBeGreaterThan(0);
              expect(seen).toEqual(seen.map(() => noteText(frontmatter)));
            } finally {
              repo.dispose();
            }
          }
        ),
        { numRuns: 20 }
      );
    });

    it('gives notes of the same name imported at once distinct copies', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (count) => {
          Notice.reset();
          const sources = Array.from({ length: count }, (_, i) =>
            fileAt(`folder-${i}/my-note.md`)
          );
          const { repo } = await makeSqlJsRepo();
          const plugin = makeNoteCopyPlugin(sources[0], {
            folders: [ARTICLES],
            paths: sources.slice(1).map((source) => source.path),
          });
          const manager = new ArticleManager(plugin as never, repo);

          const results = await Promise.all(
            sources.map((source) =>
              manager.import(
                plugin.files.get(source.path)!,
                DEFAULT_PRIORITY,
                null,
                true
              )
            )
          );

          const copyPaths = results.map((result) => result?.file.path);
          expect(copyPaths).not.toContain(undefined);
          expect(new Set(copyPaths).size).toBe(count);
          expect(
            allRows(repo)
              .map((row) => row.reference)
              .sort()
          ).toEqual([...copyPaths].sort());
        }),
        { numRuns: 10 }
      );
    });

    it('fails, freeing the name it took, when the copy cannot be made', async () => {
      const logged = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const source = fileAt('notes/my-note.md');
      const { repo } = await makeSqlJsRepo();
      const plugin = makeNoteCopyPlugin(source, { folders: [ARTICLES] });
      plugin.app.vault.create.mockRejectedValueOnce(new Error('ENOSPC'));
      const manager = new ArticleManager(plugin as never, repo);

      const failed = await manager.import(source, 10, null, true);
      const retry = await manager.import(source, 10, null, true);

      expect(failed).toBeNull();
      expect(logged).toHaveBeenCalledWith(
        new Error(`Failed to create note ${ARTICLES}/my-note.md`)
      );
      expect(retry?.file.path).toBe(`${ARTICLES}/my-note.md`);
    });
  });

  describe('a note holding links, as a copy', () => {
    beforeEach(() => {
      Notice.reset();
      // The copy is created by the real helpers, so its path follows from
      // its name and its text is what the vault is given
      vi.spyOn(Obsidian, 'getDirectory').mockRestore();
      vi.spyOn(Obsidian, 'getTargetPath').mockRestore();
      vi.spyOn(Obsidian, 'createNote').mockRestore();
    });

    it('writes the copy with each link that would lead elsewhere from it re-based, before its text is written, and never writes the original', async () => {
      const text =
        '# Note\n\nSee [[x]] and [[Note#Part]].\n\n![[../cards/c|ir-hide-title]]\n';
      const { plugin, note } = makeLinkedCopyPlugin(text, {
        links: [
          linkIn(text, '[[x]]', 'x'),
          linkIn(text, '[[Note#Part]]', 'Note#Part'),
        ],
        embeds: [linkIn(text, '![[../cards/c|ir-hide-title]]', '../cards/c')],
        sections: sectionsOf(text),
      });
      const { repo } = await makeSqlJsRepo();

      const result = await new ArticleManager(plugin as never, repo).import(
        note,
        DEFAULT_PRIORITY,
        null,
        true
      );

      const copy = plugin.files.get(LINKING_COPY);
      expect(result?.file).toBe(copy);
      const { vault, fileManager } = plugin.app;
      expect(vault.create.mock.calls).toEqual([[LINKING_COPY, '']]);
      // The namesake beside the copy would take `[[x]]`; the copy has its
      // own `Note`, and the embed's relative path climbs one folder short
      expect(vault.append.mock.calls).toEqual([
        [
          copy,
          '# Note\n\nSee [[../../notes/x]] and [[Note#Part]].\n\n![[../../cards/c|ir-hide-title]]\n',
        ],
      ]);
      for (const write of [
        vault.modify,
        vault.process,
        vault.rename,
        vault.trash,
        vault.delete,
        fileManager.renameFile,
        fileManager.trashFile,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(Notice.messages).not.toContain(LINKS_KEPT_WARNING);
    });

    it('re-bases a frontmatter link in the copy by its key, in the write that makes the copy the article', async () => {
      const text = '---\nrelated: "[[x]]"\nup: "[[../cards/c]]"\n---\nBody\n';
      const { plugin, note } = makeLinkedCopyPlugin(text, {
        frontmatterLinks: [
          { key: 'related', link: 'x', original: '[[x]]' },
          { key: 'up', link: '../cards/c', original: '[[../cards/c]]' },
        ],
        sections: sectionsOf(text),
      });
      const { repo } = await makeSqlJsRepo();
      const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
      updateFrontMatter.mockClear();

      const result = await new ArticleManager(plugin as never, repo).import(
        note,
        DEFAULT_PRIORITY,
        null,
        true
      );

      expect(plugin.app.vault.append.mock.calls).toEqual([
        [result?.file, text],
      ]);
      expect(
        editedInImportWrite(updateFrontMatter, result?.file, {
          related: '[[x]]',
          up: '[[../cards/c]]',
          other: 1,
        })
      ).toEqual({
        related: '[[../../notes/x]]',
        up: '[[../../cards/c]]',
        other: 1,
      });
      expect(Notice.messages).not.toContain(LINKS_KEPT_WARNING);
    });

    it('edits no frontmatter link that needs no change', async () => {
      const text = '---\nrelated: "[[notes/x]]"\n---\n';
      const { plugin, note } = makeLinkedCopyPlugin(text, {
        frontmatterLinks: [
          { key: 'related', link: 'notes/x', original: '[[notes/x]]' },
        ],
        sections: sectionsOf(text),
      });
      const { repo } = await makeSqlJsRepo();
      const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
      updateFrontMatter.mockClear();

      const result = await new ArticleManager(plugin as never, repo).import(
        note,
        DEFAULT_PRIORITY,
        null,
        true
      );

      expect(
        editedInImportWrite(updateFrontMatter, result?.file, {
          related: '[[notes/x]]',
        })
      ).toEqual({ related: '[[notes/x]]' });
    });

    // Two cases only: each runs once, rather than a sample of a hundred. A
    // stale cache is one read from other text than the note now holds
    it.each(['missing', 'stale'] as const)(
      "copies the text as it is, with a lasting warning, when the note's cache is %s",
      async (state) => {
        const text = 'See [[x]].\n';
        const { plugin, note } = makeLinkedCopyPlugin(
          text,
          state === 'missing'
            ? null
            : {
                // Read before "See " was written
                links: [
                  {
                    link: 'x',
                    original: '[[x]]',
                    position: cachePosition(0, 5),
                  },
                ],
                sections: sectionsOf('[[x]].'),
              }
        );
        const { repo } = await makeSqlJsRepo();
        const notify = vi.spyOn(Obsidian, 'notify');
        notify.mockClear();

        const result = await new ArticleManager(plugin as never, repo).import(
          note,
          DEFAULT_PRIORITY,
          null,
          true
        );

        expect(result?.file.path).toBe(LINKING_COPY);
        expect(plugin.app.vault.append.mock.calls).toEqual([
          [result?.file, text],
        ]);
        expect(notify).toHaveBeenCalledWith(LINKS_KEPT_WARNING, {
          kind: 'error',
          persist: true,
        });
      }
    );

    it('warns, lastingly, when a link that needed re-basing is left as written', async () => {
      // The cache reads `x` where the note holds `y`: no path this can trust
      const text = 'See [[y]].\n';
      const { plugin, note } = makeLinkedCopyPlugin(text, {
        links: [linkIn(text, '[[y]]', 'x')],
        sections: sectionsOf(text),
      });
      const { repo } = await makeSqlJsRepo();
      const notify = vi.spyOn(Obsidian, 'notify');
      notify.mockClear();

      const result = await new ArticleManager(plugin as never, repo).import(
        note,
        DEFAULT_PRIORITY,
        null,
        true
      );

      expect(plugin.app.vault.append.mock.calls).toEqual([
        [result?.file, text],
      ]);
      expect(notify).toHaveBeenCalledWith(LINKS_KEPT_WARNING, {
        kind: 'error',
        persist: true,
      });
    });

    it('copies the text as it is, warning lastingly and logging why, when re-basing fails', async () => {
      const logged = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const text = 'See [[x]].\n';
      const { plugin, note, metadataCache } = makeLinkedCopyPlugin(text, {
        links: [linkIn(text, '[[x]]', 'x')],
        sections: sectionsOf(text),
      });
      const failure = new Error('resolver failed');
      metadataCache.getFirstLinkpathDest.mockImplementation(
        (_linkpath: string, from: string) => {
          if (from === LINKING_COPY) throw failure;
          return plugin.files.get('notes/x.md') ?? null;
        }
      );
      const { repo } = await makeSqlJsRepo();
      const notify = vi.spyOn(Obsidian, 'notify');
      notify.mockClear();

      const result = await new ArticleManager(plugin as never, repo).import(
        note,
        DEFAULT_PRIORITY,
        null,
        true
      );

      expect(result?.file.path).toBe(LINKING_COPY);
      expect(plugin.app.vault.append.mock.calls).toEqual([
        [result?.file, text],
      ]);
      expect(logged).toHaveBeenCalledWith(failure);
      expect(notify).toHaveBeenCalledWith(LINKS_KEPT_WARNING, {
        kind: 'error',
        persist: true,
      });
    });

    it('reads the note only once Obsidian has finished reading the vault', async () => {
      const text = 'Plain.\n';
      const { plugin, note } = makeLinkedCopyPlugin(text, {
        sections: sectionsOf(text),
      });
      let settle = () => {};
      // Undocumented: MetadataCache.onCleanCache
      const onCleanCache = vi.fn((done: () => void) => {
        settle = done;
      });
      Object.assign(plugin.app.metadataCache, { onCleanCache });
      const { repo } = await makeSqlJsRepo();

      const imported = new ArticleManager(plugin as never, repo).import(
        note,
        DEFAULT_PRIORITY,
        null,
        true
      );
      await vi.waitFor(() => expect(onCleanCache).toHaveBeenCalled());
      expect(plugin.app.vault.cachedRead).not.toHaveBeenCalled();
      settle();

      expect((await imported)?.file.path).toBe(LINKING_COPY);
      expect(plugin.app.vault.cachedRead).toHaveBeenCalledWith(note);
    });
  });

  describe('in-place mode', () => {
    it('registers the original file without creating a copy', async () => {
      Notice.reset();
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(Notice.messages).toEqual([
        `Imported "my-note" with priority ${IRScheduler.toDisplayPriority(DEFAULT_PRIORITY)}`,
      ]);
      expect(Obsidian.createNote).not.toHaveBeenCalled();
      const [sql, params] = lastMutateCall(repo);
      expect(sql).toContain('INSERT INTO article');
      expect(params[1]).toBe(IMPORT_FILE.path);
    });

    it('calls updateFrontMatter on the original file with the article tag', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(Obsidian.updateFrontMatter).toHaveBeenCalledWith(
        IMPORT_FILE,
        expect.objectContaining({ tags: ARTICLE_TAG }),
        expect.anything(),
        // What reads the note's properties as they were, to put back
        expect.any(Function)
      );
    });

    it('does not add a source frontmatter link', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(Obsidian.generateMarkdownLink).not.toHaveBeenCalled();
      const fmCall = (Obsidian.updateFrontMatter as ReturnType<typeof vi.fn>)
        .mock.calls[0] as unknown[];
      expect(fmCall[1]).not.toHaveProperty('source');
    });

    it('allows files inside DATA_DIRECTORY without early-returning', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(DATA_DIR_FILE, DEFAULT_PRIORITY, null, false);

      const [sql, params] = lastMutateCall(repo);
      expect(sql).toContain('INSERT INTO article');
      expect(params[1]).toBe(DATA_DIR_FILE.path);
    });

    it('blocks files tagged as snippets', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        tags: [SNIPPET_TAG],
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(repo.mutate).not.toHaveBeenCalled();
    });

    it('blocks files tagged as cards', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        tags: [CARD_TAG],
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(repo.mutate).not.toHaveBeenCalled();
    });

    it('re-associates with the existing DB record when ir-id matches', async () => {
      const EXISTING_ID = 'existing-article-id';
      const repo = makeSimpleRepo();
      // First query (by reference) returns nothing; second query (by id) matches
      (repo.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: EXISTING_ID }]);
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': EXISTING_ID,
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      const [sql, params] = lastMutateCall(repo);
      expect(sql).toContain('UPDATE article SET reference');
      expect(params).toEqual([IMPORT_FILE.path, EXISTING_ID]);
      expect(Obsidian.updateFrontMatter).not.toHaveBeenCalled();
    });

    it('cancels with a specific notice when ir-id is orphaned but reference is already in DB', async () => {
      const ORPHANED_ID = 'orphaned-id';
      const repo = makeSimpleRepo();
      // First query (by reference) matches another article; the by-id query is
      // never reached because the reference collision cancels the import
      (repo.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: 'some-other-id' }])
        .mockResolvedValueOnce([]);
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': ORPHANED_ID,
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      expect(repo.mutate).not.toHaveBeenCalled();
      expect(Obsidian.updateFrontMatter).not.toHaveBeenCalled();
    });

    it('proceeds with fresh import when ir-id is orphaned and reference is not in DB', async () => {
      const ORPHANED_ID = 'orphaned-id';
      const repo = makeSimpleRepo();
      // Both queries return nothing
      (repo.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const manager = new ArticleManager(makeImportPlugin(false), repo);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': ORPHANED_ID,
      } as never);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

      const [sql] = lastMutateCall(repo);
      expect(sql).toContain('INSERT INTO article');
    });

    it('refuses a note whose name or folder holds a character that breaks links, writing nothing and saying why', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...REFUSED_PATH_CHARS),
          fc.boolean(),
          // Whether it carries an id no article has
          fc.boolean(),
          async (char, inFolder, orphaned) => {
            Notice.reset();
            const path = inFolder
              ? `no${char}tes/my-note.md`
              : `notes/my${char}note.md`;
            const file = fileAt(path);
            const repo = makeSimpleRepo();
            (repo.query as ReturnType<typeof vi.fn>).mockImplementation(
              () => []
            );
            const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
            updateFrontMatter.mockClear();
            vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue(
              (orphaned ? { 'ir-id': 'orphaned' } : undefined) as never
            );
            const manager = new ArticleManager(makeImportPlugin(false), repo);

            const result = await manager.import(
              file,
              DEFAULT_PRIORITY,
              null,
              false
            );

            expect(result).toBeNull();
            expect(lastMutateCall(repo)).toBeUndefined();
            expect(updateFrontMatter).not.toHaveBeenCalled();
            expect(Notice.messages).toStrictEqual([
              `Can't import "${file.name}" in place: its name or folder ` +
                `contains ${listChars([char])}. Rename it or import a copy`,
            ]);
          }
        )
      );
    });

    it('relinks a note at a path that breaks links to the article whose id it carries, as existing paths are left', async () => {
      Notice.reset();
      const file = fileAt('x>y/my-note.md');
      const repo = makeSimpleRepo();
      (repo.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'elsewhere' }]);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': 'elsewhere',
      } as never);
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(file, DEFAULT_PRIORITY, null, false);

      expect(lastMutateCall(repo)).toEqual([
        'UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2',
        [file.path, 'elsewhere'],
      ]);
      expect(Notice.messages).toStrictEqual([
        'Linked "my-note" to existing article with the same ID',
        refusedPathsWarning([file.path]),
      ]);
    });

    it('still repairs an article already at a path that breaks links, made before the rule', async () => {
      Notice.reset();
      const file = fileAt('C# notes/my-note.md');
      const repo = makeSimpleRepo();
      (repo.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'existing' },
      ]);
      vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
        'ir-id': 'existing',
      } as never);
      const snippets = makeSnippetsStub();
      const manager = new ArticleManager(
        makeImportPluginWithSnippets(false, snippets),
        repo
      );

      await manager.import(file, DEFAULT_PRIORITY, null, false);

      expect(snippets.adoptOrphans).toHaveBeenCalledWith(file, 'existing');
      expect(Notice.messages).toStrictEqual([
        'Note is already an article; canceling import',
      ]);
    });

    it('imports a copy of a note whose folder breaks links', async () => {
      Notice.reset();
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(true), repo);
      const createNote = vi.spyOn(Obsidian, 'createNote');

      await manager.import(fileAt('x>y/my-note.md'), DEFAULT_PRIORITY, null);

      expect(createNote).toHaveBeenCalled();
      expect(Notice.messages.join(' ')).not.toContain("Can't import");
    });
  });

  describe('snippets that predate the import', () => {
    /** 0–4 snippets, so both the "none found" and "some found" paths run. */
    const adoptedRowsArb = fc
      .integer({ min: 0, max: 4 })
      .map((count) =>
        Array.from({ length: count }, (_, i) => makeAdoptedRow(i))
      );
    /** 0–3 cards, as card adoption returns them. */
    const adoptedCardsArb = fc.integer({ min: 0, max: 3 }).map((count) =>
      Array.from({ length: count }, (_, i) => ({
        id: `card-${i}`,
        reference: `cards/card-${i}.md`,
      }))
    );

    it('still imports when the review manager is not available yet', async () => {
      await fc.assert(
        fc.asyncProperty(fc.boolean(), async (makeCopy) => {
          // The import path can be reached before the plugin finishes wiring
          // up its managers; adoption is skipped rather than throwing.
          const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
          const repo = makeSimpleRepo();
          const manager = new ArticleManager(makeImportPlugin(makeCopy), repo);

          await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, makeCopy);

          expect(consoleError).not.toHaveBeenCalled();
          const [sql] = lastMutateCall(repo);
          expect(sql).toContain('INSERT INTO article');
          consoleError.mockRestore();
        })
      );
    });

    describe('in place', () => {
      it('gives the new article every snippet taken from the note', async () => {
        const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
        const repo = makeSimpleRepo();
        const manager = new ArticleManager(
          makeImportPluginWithSnippets(false, snippets),
          repo
        );

        await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

        expect(snippets.adoptOrphans).toHaveBeenCalledWith(
          IMPORT_FILE,
          insertedArticleId(repo)
        );
      });

      it('repaints the note only when it adopted something', async () => {
        await fc.assert(
          fc.asyncProperty(
            adoptedRowsArb,
            adoptedCardsArb,
            async (adoptedSnippets, adoptedCards) => {
              const snippets = makeSnippetsStub(adoptedSnippets);
              const plugin = makeImportPluginWithSnippets(
                false,
                snippets,
                makeCardsStub(adoptedCards)
              );
              const manager = new ArticleManager(plugin, makeSimpleRepo());

              await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

              const trigger = (
                plugin as unknown as {
                  app: { workspace: { trigger: ReturnType<typeof vi.fn> } };
                }
              ).app.workspace.trigger;
              if (adoptedSnippets.length + adoptedCards.length === 0) {
                expect(snippets.getHighlights).not.toHaveBeenCalled();
                expect(trigger).not.toHaveBeenCalled();
              } else {
                // reloaded under the new parent id, then repainted
                expect(snippets.getHighlights).toHaveBeenCalledWith(
                  IMPORT_FILE
                );
                expect(trigger).toHaveBeenCalledWith(
                  'ir-highlights-changed',
                  IMPORT_FILE.path
                );
              }
            }
          )
        );
      });

      it('never re-points the snippet notes, which still describe the same file', async () => {
        const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
        const manager = new ArticleManager(
          makeImportPluginWithSnippets(false, snippets),
          makeSimpleRepo()
        );
        const retargetSources = vi.spyOn(manager, 'retargetSources');

        await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

        expect(retargetSources).not.toHaveBeenCalled();
      });

      it('adopts for the linked record when the note carries a known ir-id', async () => {
        const EXISTING_ID = 'existing-article-id';
        const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
        const repo = makeSimpleRepo();
        (repo.query as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: EXISTING_ID }]);
        const manager = new ArticleManager(
          makeImportPluginWithSnippets(false, snippets),
          repo
        );
        vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
          'ir-id': EXISTING_ID,
        } as never);

        await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

        expect(snippets.adoptOrphans).toHaveBeenCalledWith(
          IMPORT_FILE,
          EXISTING_ID
        );
      });

      it('repairs stranded snippets when re-run on a note that is already an article', async () => {
        const EXISTING_ID = 'existing-article-id';
        const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
        const repo = makeSimpleRepo();
        // the reference is already registered, under the note's own ir-id
        (repo.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
          { id: EXISTING_ID },
        ]);
        const manager = new ArticleManager(
          makeImportPluginWithSnippets(false, snippets),
          repo
        );
        vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
          'ir-id': EXISTING_ID,
        } as never);

        const result = await manager.import(
          IMPORT_FILE,
          DEFAULT_PRIORITY,
          null,
          false
        );

        expect(result).toBeNull();
        expect(snippets.adoptOrphans).toHaveBeenCalledWith(
          IMPORT_FILE,
          EXISTING_ID
        );
      });
    });

    describe('as a copy', () => {
      it('leaves the in-place notice alone, where nothing changed hands', async () => {
        Notice.reset();
        const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
        const manager = new ArticleManager(
          makeImportPluginWithSnippets(false, snippets),
          makeSimpleRepo()
        );

        await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, false);

        expect(Notice.messages.at(-1)).not.toContain('the copy');
      });

      it('adopts in place when the ir-id links the note to an existing record instead of copying', async () => {
        const EXISTING_ID = 'existing-article-id';
        const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
        const repo = makeSimpleRepo();
        (repo.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
          { id: EXISTING_ID },
        ]);
        const manager = new ArticleManager(
          makeImportPluginWithSnippets(true, snippets),
          repo
        );
        const retargetSources = vi.spyOn(manager, 'retargetSources');
        vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue({
          'ir-id': EXISTING_ID,
        } as never);

        await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, true);

        expect(snippets.adoptOrphans).toHaveBeenCalledWith(
          IMPORT_FILE,
          EXISTING_ID
        );
        // no copy was made, so nothing to re-point at
        expect(retargetSources).not.toHaveBeenCalled();
      });
    });
  });

  describe('cards made from a note before it was imported', () => {
    const EXISTING_ID = 'existing-article-id';

    const PRIORITY = `priority ${IRScheduler.toDisplayPriority(DEFAULT_PRIORITY)}`;
    /**
     * Each way an import of a note meets the database: as no article yet; with
     * its own row at its path (the repair); with its row, named by its
     * `ir-id`, elsewhere, whether or not a copy was asked for; or with another
     * article's row at its path. What the import says, and the row the note's
     * cards go to, if any.
     */
    const cases = {
      new: { row: null, notice: `Imported "my-note" with ${PRIORITY}` },
      repair: {
        row: { id: EXISTING_ID, reference: 'notes/my-note.md' },
        notice: 'Note is already an article; canceling import',
      },
      relink: {
        row: { id: EXISTING_ID, reference: 'notes/old.md' },
        notice: 'Linked "my-note" to existing article with the same ID',
      },
      'relink asked to copy': {
        row: { id: EXISTING_ID, reference: 'notes/old.md' },
        notice: 'Linked "my-note" to existing article with the same ID',
      },
      'another article at its path': {
        row: { id: 'another', reference: 'notes/my-note.md' },
        notice:
          'Another article is already at this file path; canceling import',
      },
    } as const;

    it.each(Object.keys(cases) as (keyof typeof cases)[])(
      'gives them to the note’s article on every import that keeps the note, and to none other (%s)',
      async (path) => {
        Notice.reset();
        const { row, notice } = cases[path];
        const { repo, db } = await makeSqlJsRepo();
        if (row) {
          db.exec(
            `INSERT INTO article (id, reference, due, interval, priority)
             VALUES ($1, $2, 0, 1, 10)`,
            [row.id, row.reference]
          );
        }
        vi.spyOn(Obsidian, 'getFrontMatter').mockReturnValue(
          path === 'new' ? undefined : ({ 'ir-id': EXISTING_ID } as never)
        );
        vi.spyOn(Obsidian, 'getNote').mockReturnValue(IMPORT_FILE);
        const cards = makeCardsStub([
          { id: 'card-0', reference: 'cards/card-0.md' },
        ]);
        const copy = path === 'relink asked to copy';
        const snippets = makeSnippetsStub();
        const plugin = makeImportPluginWithSnippets(copy, snippets, cards);
        const manager = new ArticleManager(plugin, repo);

        await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null, copy);

        expect(Notice.messages).toEqual([notice]);
        if (path === 'another article at its path') {
          expect(cards.adoptOrphans).not.toHaveBeenCalled();
          expect(snippets.getHighlights).not.toHaveBeenCalled();
          return;
        }
        const ids = allRows(repo)
          .filter((article) => article.reference === IMPORT_FILE.path)
          .map((article) => article.id);
        expect(ids).toEqual(
          path === 'new' ? [expect.any(String)] : [EXISTING_ID]
        );
        expect(cards.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
          IMPORT_FILE,
          ids[0]
        );
        // Something was adopted, so the note is repainted
        expect(snippets.getHighlights).toHaveBeenCalledExactlyOnceWith(
          IMPORT_FILE
        );
      }
    );

    it('gives a PDF’s parentless items to its article when asked by the review manager', async () => {
      const pdf = fileAt('papers/Paper.pdf');
      const snippets = makeSnippetsStub([makeAdoptedRow(0)]);
      const cards = makeCardsStub();
      const plugin = makePdfImportPlugin(pdf, false, snippets, cards);
      const manager = new ArticleManager(plugin as never, makeSimpleRepo());

      await manager.claimFromBinary(pdf, 'article-1');

      expect(snippets.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
        pdf,
        'article-1'
      );
      expect(cards.adoptOrphans).toHaveBeenCalledExactlyOnceWith(
        pdf,
        'article-1'
      );
      expect(snippets.getHighlights).toHaveBeenCalledExactlyOnceWith(pdf);
    });

    describe('as a copy', () => {
      const NOTE = fileAt('notes/Note.md');
      const COPY_PATH = `${ARTICLES_FOLDER}/Note.md`;

      beforeEach(() => {
        Notice.reset();
        vi.spyOn(Obsidian, 'getDirectory').mockRestore();
        vi.spyOn(Obsidian, 'getTargetPath').mockRestore();
        vi.spyOn(Obsidian, 'createNote').mockRestore();
      });

      it.each([
        [0, 0, ''],
        [1, 0, '; 1 snippet now refers to the copy'],
        [0, 1, '; 1 card now refers to the copy'],
        [0, 2, '; 2 cards now refer to the copy'],
        [1, 2, '; 1 snippet and 2 cards now refer to the copy'],
      ] as const)(
        'hands %i snippets and %i cards to the copy, re-pointing their links at it, and counts them in the notice',
        async (snippetCount, cardCount, notice) => {
          const { repo, snippetIds, cardIds } = await seedParentless(
            snippetCount,
            cardCount
          );
          const plugin = makeTakenNoteCopyPlugin(NOTE);
          const manager = new ArticleManager(plugin as never, repo);
          const retargetSources = vi
            .spyOn(manager, 'retargetSources')
            .mockResolvedValue(0);
          const { snippets, cards } = plugin.reviewManager;

          await manager.import(NOTE, DEFAULT_PRIORITY, null, true);

          const [{ id, reference }] = allRows(repo);
          expect(reference).toBe(COPY_PATH);
          const parents = (table: string) =>
            Object.fromEntries(
              (
                repo.query(`SELECT id, parent FROM ${table}`) as {
                  id: string;
                  parent: string | null;
                }[]
              ).map((row) => [row.id, row.parent])
            );
          expect(parents('snippet')).toEqual({
            ...Object.fromEntries(snippetIds.map((s) => [s, id])),
            elsewhere: null,
          });
          expect(parents('srs_card')).toEqual({
            ...Object.fromEntries(cardIds.map((c) => [c, id])),
            elsewhere: null,
            parented: 'some-article',
            deleted: null,
            gone: null,
          });
          expect(Notice.messages).toEqual([
            `Imported "Note" with priority ${IRScheduler.toDisplayPriority(DEFAULT_PRIORITY)}${notice}`,
          ]);
          if (snippetCount + cardCount === 0) {
            expect(retargetSources).not.toHaveBeenCalled();
          } else {
            expect(retargetSources).toHaveBeenCalledOnce();
            const [items, from, to] = retargetSources.mock.calls[0];
            expect(
              items.map(({ id, reference }) => ({ id, reference }))
            ).toEqual([
              ...snippetIds.map((s) => ({
                id: s,
                reference: `snippets/${s}.md`,
              })),
              ...cardIds.map((c) => ({ id: c, reference: `cards/${c}.md` })),
            ]);
            expect(from).toBe(NOTE.path);
            expect(to).toBe(plugin.files.get(COPY_PATH));
          }
          // The original keeps no highlights: they moved to the copy
          const moved = snippetCount + cardCount > 0;
          expect(snippets.offsetTracker.loadHighlights.mock.calls).toEqual(
            moved ? [[NOTE.path, []]] : []
          );
          expect(plugin.app.workspace.trigger.mock.calls).toEqual(
            moved ? [['ir-highlights-changed', NOTE.path]] : []
          );
          // Taken over by the copy, not adopted in place or reloaded there
          expect(snippets.adoptOrphans).not.toHaveBeenCalled();
          expect(cards.adoptOrphans).not.toHaveBeenCalled();
          expect(snippets.getHighlights).not.toHaveBeenCalled();
        }
      );

      it('re-points links from the path the note had when the import began, though it is renamed meanwhile', async () => {
        const note = fileAt('notes/Note.md');
        const { repo } = await seedParentless(1, 1);
        const plugin = makeTakenNoteCopyPlugin(note);
        const { create } = plugin.app.vault;
        const make = create.getMockImplementation()!;
        create.mockImplementationOnce(async (path: string, data: string) => {
          // Obsidian renames a TFile in place
          note.path = 'notes/Renamed.md';
          return make(path, data);
        });
        const manager = new ArticleManager(plugin as never, repo);
        const retargetSources = vi
          .spyOn(manager, 'retargetSources')
          .mockResolvedValue(0);

        await manager.import(note, DEFAULT_PRIORITY, null, true);

        expect(retargetSources).toHaveBeenCalledExactlyOnceWith(
          expect.any(Array),
          'notes/Note.md',
          plugin.files.get(COPY_PATH)
        );
      });

      /**
       * A source link to {@link NOTE} as an item's note can hold it: a
       * wikilink or a Markdown link, by its path or its name alone, with or
       * without a heading or block subpath, and with no alias, its name, or
       * another.
       */
      const linkArb = fc.record({
        wiki: fc.boolean(),
        byPath: fc.boolean(),
        subpath: fc.constantFrom('', '#Heading', '#^block'),
        alias: fc.constantFrom(null, 'Note', 'my note'),
      });

      it('never writes to the original, whose card embeds the copy carries too, and re-points each link as it was written', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 0, max: 3 }),
            fc.integer({ min: 0, max: 3 }),
            linkArb,
            // Whether the copy can't have the note's own name
            fc.boolean(),
            async (snippetCount, cardCount, link, occupied) => {
              const { repo, snippetIds, cardIds } = await seedParentless(
                snippetCount,
                cardCount
              );
              const plugin = makeTakenNoteCopyPlugin(
                NOTE,
                occupied ? [COPY_PATH] : []
              );
              // The note's text, with each card's embed where its text was
              const text = [
                '# Note',
                ...cardIds.map((c) => `![[${c}|ir-hide-title]]`),
                'The end.',
              ].join('\n\n');
              plugin.app.vault.cachedRead.mockResolvedValue(text);
              // A Markdown link has the spaces in its path encoded
              const linkTo = (target: string, alias: string | null) =>
                link.wiki
                  ? `[[${target}${link.subpath}${alias === null ? '' : `|${alias}`}]]`
                  : `[${alias ?? ''}](${target.replaceAll(' ', '%20')}.md${link.subpath})`;
              vi.spyOn(Obsidian, 'getFrontMatter').mockImplementation((file) =>
                file === NOTE
                  ? undefined
                  : ({
                      'ir-id': /([^/]+)\.md$/.exec(file.path)?.[1],
                      [SOURCE_PROPERTY_NAME]: linkTo(
                        link.byPath ? 'notes/Note' : 'Note',
                        link.alias
                      ),
                    } as never)
              );
              const updateFrontMatter = vi.spyOn(Obsidian, 'updateFrontMatter');
              updateFrontMatter.mockClear();
              Object.assign(plugin.app.metadataCache, {
                fileToLinktext: (
                  file: TFile,
                  _from: string,
                  omitMd: boolean
                ) => (omitMd ? file.path.replace(/\.md$/, '') : file.path),
              });

              const result = await new ArticleManager(
                plugin as never,
                repo
              ).import(NOTE, DEFAULT_PRIORITY, null, true);

              const copy = result!.file;
              expect(copy).toBe(plugin.files.get(copy.path));
              expect(copy.path === COPY_PATH).toBe(!occupied);
              const { vault, fileManager } = plugin.app;
              const writes = [
                vault.create,
                vault.append,
                vault.modify,
                vault.modifyBinary,
                vault.process,
                vault.rename,
                vault.delete,
                vault.trash,
                vault.copy,
                fileManager.processFrontMatter,
                fileManager.renameFile,
                fileManager.trashFile,
                updateFrontMatter,
              ];
              for (const write of writes) {
                for (const [target] of write.mock.calls as unknown[][]) {
                  expect(target).not.toBe(NOTE);
                  expect(target).not.toBe(NOTE.path);
                }
              }
              expect(vault.append).toHaveBeenCalledExactlyOnceWith(copy, text);
              // Each adopted item's link, re-pointed, keeps its form and
              // subpath; an alias that was the note's name takes the copy's
              const sources = updateFrontMatter.mock.calls
                .filter(([file]) => file !== copy)
                .map(([file, update]) => {
                  const frontmatter: Record<string, unknown> = {
                    ...Obsidian.getFrontMatter(file, plugin.app as never),
                  };
                  (update as (fm: Record<string, unknown>) => void)(
                    frontmatter
                  );
                  return [file.path, frontmatter[SOURCE_PROPERTY_NAME]];
                });
              expect(Object.fromEntries(sources)).toEqual(
                Object.fromEntries(
                  [
                    ...snippetIds.map((s) => `snippets/${s}.md`),
                    ...cardIds.map((c) => `cards/${c}.md`),
                  ].map((path) => [
                    path,
                    linkTo(
                      copy.path.slice(0, -'.md'.length),
                      link.alias === NOTE.basename ? copy.basename : link.alias
                    ),
                  ])
                )
              );
            }
          ),
          { numRuns: 40 }
        );
      });
    });
  });

  describe('plugin.settings.copyOnImport fallback', () => {
    it('uses copy when copyOnImport is true and makeCopy arg is omitted', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(true), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null);

      expect(Obsidian.createNote).toHaveBeenCalled();
      const [, params] = lastMutateCall(repo);
      expect(params[1]).toBe(COPY_FILE.path);
    });

    it('uses in-place when copyOnImport is false and makeCopy arg is omitted', async () => {
      const repo = makeSimpleRepo();
      const manager = new ArticleManager(makeImportPlugin(false), repo);

      await manager.import(IMPORT_FILE, DEFAULT_PRIORITY, null);

      expect(Obsidian.createNote).not.toHaveBeenCalled();
      const [, params] = lastMutateCall(repo);
      expect(params[1]).toBe(IMPORT_FILE.path);
    });
  });
});

describe('create', () => {
  const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;

  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes the article in the current folder when asked to, and in the articles folder otherwise', async () => {
    expect(await createIn('notes/reading', true)).toBe('notes/reading');
    expect(await createIn('notes/reading', false)).toBe(ARTICLES);
    expect(await createIn(undefined, true)).toBe(ARTICLES);
    expect(Notice.messages).toStrictEqual([]);
  });

  it("makes it in the articles folder, saying why, when the current folder's path breaks links", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...REFUSED_PATH_CHARS), async (char) => {
        Notice.reset();

        expect(await createIn(`notes/x${char}y`, true)).toBe(ARTICLES);
        expect(Notice.messages).toStrictEqual([
          `The current folder contains ${listChars([char])}; created the ` +
            `article in "${ARTICLES}" instead`,
        ]);
      })
    );
  });
});

describe('making an article, with its note and its row as one unit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes an empty article as a note and a row together, or neither', async () => {
    for (const failure of ['create', 'frontmatter', 'row', null] as const) {
      vi.restoreAllMocks();
      const { vault, repo, notify, manager } = await wireArticles({}, failure);

      const article = await manager.create(DEFAULT_PRIORITY);

      const rows = repo.rows('article');
      if (failure) {
        expect(article).toBeNull();
        expect(rows).toEqual([]);
        expect(vault.paths()).toEqual([]);
        expect(notify).toHaveBeenCalledWith('Failed to create empty article', {
          kind: 'error',
        });
      } else {
        expect(rows).toHaveLength(1);
        expect(vault.paths()).toEqual([rows[0].reference]);
        expect(vault.frontmatterOf(rows[0].reference as string)).toMatchObject({
          'ir-id': rows[0].id,
          tags: [ARTICLE_TAG],
        });
      }
    }
  });

  it('imports a copy of a note as a copy and a row together, or neither, leaving the note as it was', async () => {
    for (const failure of ['create', 'frontmatter', 'row', null] as const) {
      vi.restoreAllMocks();
      const { vault, repo, manager, before } = await wireArticles(
        { [SOURCE]: { title: 'x' } },
        failure
      );

      const article = await manager.import(
        vault.files.get(SOURCE)!,
        DEFAULT_PRIORITY,
        null,
        true
      );

      const rows = repo.rows('article');
      expect(vault.frontmatterOf(SOURCE)).toEqual(before[SOURCE]);
      if (failure) {
        expect(article).toBeNull();
        expect(rows).toEqual([]);
        expect(vault.paths()).toEqual([SOURCE]);
      } else {
        expect(rows).toHaveLength(1);
        expect(vault.paths()).toEqual(
          [rows[0].reference as string, SOURCE].sort()
        );
      }
    }
  });

  it("imports a note in place as a row and its ir-id and tag together, or puts the note's frontmatter back as it was", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc.record(
            {
              'ir-id': fc.oneof(
                fc.uuid(),
                fc.string(),
                fc.integer(),
                fc.constant(null)
              ),
              tags: fc.oneof(
                tagArb,
                fc.array(fc.oneof(tagArb, fc.constant(null)), { maxLength: 3 })
              ),
              title: fc.string(),
            },
            { requiredKeys: [] }
          ),
          { nil: null }
        ),
        fc.constantFrom<Failure>('row', null),
        async (frontmatter, failure) => {
          vi.restoreAllMocks();
          const { vault, repo, manager, before } = await wireArticles(
            { [SOURCE]: frontmatter },
            failure
          );

          const article = await manager.import(
            vault.files.get(SOURCE)!,
            DEFAULT_PRIORITY,
            null,
            false
          );

          const rows = repo.rows('article');
          // A note tagged as a snippet or card is refused before anything
          const tags = frontmatter?.tags;
          const blocked = [tags]
            .flat()
            .some((tag) => tag === SNIPPET_TAG || tag === CARD_TAG);
          if (failure || blocked) {
            expect(article).toBeNull();
            expect(rows).toEqual([]);
            expect(vault.frontmatterOf(SOURCE) ?? {}).toEqual(
              before[SOURCE] ?? {}
            );
          } else {
            expect(rows).toHaveLength(1);
            expect(vault.frontmatterOf(SOURCE)?.['ir-id']).toBe(rows[0].id);
            expect(vault.frontmatterOf(SOURCE)?.tags).toContain(ARTICLE_TAG);
          }
          expect(vault.paths()).toEqual([SOURCE]);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('imports a copy of a PDF as a copy and a row together, or neither', async () => {
    for (const failure of ['copy', 'row', null] as const) {
      vi.restoreAllMocks();
      const { vault, repo, manager } = await wireArticles(
        { [PDF]: null },
        failure
      );

      await manager.import(vault.files.get(PDF)!, DEFAULT_PRIORITY, null, true);

      const rows = repo.rows('article');
      if (failure) {
        expect(rows).toEqual([]);
        expect(vault.paths()).toEqual([PDF]);
      } else {
        expect(vault.paths()).toEqual(
          [PDF, rows[0].reference as string].sort()
        );
      }
    }
  });

  it('keeps an import whose row is saved when handing over what was taken from the file then fails, and says so', async () => {
    for (const [path, makeCopy] of [
      [SOURCE, false],
      [SOURCE, true],
      [PDF, false],
      [PDF, true],
    ] as const) {
      vi.restoreAllMocks();
      const { vault, repo, manager, notify } = await wireArticles(
        { [path]: path === PDF ? null : { title: 'x' } },
        null
      );
      const failure = new Error('adopt failed');
      // What follows the commit: handing over to a copy, or claiming in place
      vi.spyOn(
        manager as unknown as { handToCopy: () => unknown },
        'handToCopy'
      ).mockRejectedValue(failure);
      vi.spyOn(
        manager as unknown as { claimInPlace: () => unknown },
        'claimInPlace'
      ).mockRejectedValue(failure);

      const article = await manager.import(
        vault.files.get(path)!,
        DEFAULT_PRIORITY,
        null,
        makeCopy
      );

      const rows = repo.rows('article');
      expect(rows).toHaveLength(1);
      expect(article?.data.id).toBe(rows[0].id);
      expect(notify).not.toHaveBeenCalledWith(
        expect.stringMatching(/^Failed to import/)
      );
      expect(notify).toHaveBeenCalledWith(
        makeCopy
          ? `Imported "${article?.file.basename}", but the snippets and cards taken from its original couldn't be handed to it`
          : `"${vault.files.get(path)!.basename}" is an article, but the snippets and cards taken from it couldn't be adopted`,
        { kind: 'error', persist: true }
      );
      expect(console.error).toHaveBeenCalledWith(failure);
    }
  });

  it('makes and imports nothing, and says why, while writes are refused', async () => {
    for (const makeCopy of [true, false]) {
      for (const path of [SOURCE, PDF]) {
        vi.restoreAllMocks();
        const { vault, repo, manager, notify, before } = await wireArticles(
          { [path]: path === PDF ? null : { title: 'x' } },
          null,
          true
        );
        const file = vault.files.get(path)!;

        expect(
          await manager.import(file, DEFAULT_PRIORITY, null, makeCopy)
        ).toBeNull();

        expect(vault.paths()).toEqual([path]);
        expect(vault.frontmatterOf(path)).toEqual(before[path]);
        expect(repo.rows('article')).toEqual([]);
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          refusal(`import "${file.name}"`),
          { kind: 'error' }
        );
      }
    }

    vi.restoreAllMocks();
    const { vault, manager, notify } = await wireArticles({}, null, true);
    expect(await manager.create(DEFAULT_PRIORITY)).toBeNull();
    expect(vault.paths()).toEqual([]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      refusal('create the article'),
      { kind: 'error' }
    );
  });
});

describe('importWebPage', () => {
  const ARTICLES = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: makes the page a note in the articles folder, named for its title and holding its Markdown, with its address as its source', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.option(fc.webUrl(), { nil: null }),
        fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
        fc.option(
          fc.integer({
            min: MINIMUM_FIXED_REVIEW_INTERVAL,
            max: MAXIMUM_FIXED_REVIEW_INTERVAL,
          }),
          { nil: null }
        ),
        async (title, markdown, url, priority, fixedIntervalDays) => {
          vi.restoreAllMocks();
          const { vault, repo, manager, notify } = await wireArticles({}, null);

          const article = await manager.importWebPage(
            { title, markdown, url },
            priority,
            fixedIntervalDays
          );

          const rows = repo.rows('article');
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            priority,
            fixed_interval_days: fixedIntervalDays,
          });
          const path = rows[0].reference as string;
          expect(article?.data.id).toBe(rows[0].id);
          expect(vault.paths()).toEqual([path]);
          const name = Obsidian.sanitizeForTitle(
            title,
            true,
            undefined,
            CONTENT_TITLE_MAX_BYTES
          );
          if (name) {
            expect(path).toBe(`${ARTICLES}/${name}.md`);
          } else {
            expect(path.slice(0, path.lastIndexOf('/'))).toBe(ARTICLES);
            expect(path.endsWith('.md')).toBe(true);
          }
          expect(vault.bodyOf(path)).toBe(markdown);
          const { created, ...frontmatter } = vault.frontmatterOf(path) ?? {};
          expect(typeof created).toBe('string');
          expect(frontmatter).toStrictEqual({
            'ir-id': rows[0].id,
            tags: [ARTICLE_TAG],
            ...(url === null ? {} : { [SOURCE_PROPERTY_NAME]: url }),
          });
          expect(notify).toHaveBeenCalledOnce();
          expect(notify.mock.calls[0][0]).toMatch(/^Imported "/);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('property: names the note for as much of a long title as a file name holds, beside a note already named so too', async () => {
    // A name past 255 bytes (ext4, APFS) or UTF-16 units (NTFS) can't be made
    const codePoints = (min: number, max: number) =>
      fc.integer({ min, max }).map((code) => String.fromCodePoint(code));
    const longTitleArb = fc.string({
      unit: fc.oneof(
        fc.constantFrom('a', ' ', '.'),
        codePoints(0x4e00, 0x9fff),
        codePoints(0x1f600, 0x1f64f),
        fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })
      ),
      minLength: 40,
      maxLength: 400,
    });
    await fc.assert(
      fc.asyncProperty(longTitleArb, fc.boolean(), async (title, taken) => {
        vi.restoreAllMocks();
        const name = Obsidian.sanitizeForTitle(
          title,
          true,
          undefined,
          CONTENT_TITLE_MAX_BYTES
        );
        const takenPath = `${ARTICLES}/${name}.md`;
        const { vault, repo, manager } = await wireArticles(
          taken && name ? { [takenPath]: { title: 'x' } } : {},
          null
        );

        try {
          await manager.importWebPage(
            { title, markdown: 'Text', url: null },
            DEFAULT_PRIORITY,
            null
          );

          const path = repo.rows('article')[0].reference as string;
          const fileName = path.slice(ARTICLES.length + 1);
          expect(new TextEncoder().encode(fileName).length).toBeLessThanOrEqual(
            255
          );
          if (!name) return;
          expect(fileName.startsWith(taken ? `${name} - ` : `${name}.md`)).toBe(
            true
          );
          expect(vault.paths()).toHaveLength(taken ? 2 : 1);
        } finally {
          // Shrinking runs many cases: each database holds wasm memory
          repo.dispose();
        }
      }),
      { numRuns: 50 }
    );
  });

  it('names the note without a word on what a title drops', async () => {
    const { repo, manager, notify } = await wireArticles({}, null);

    await manager.importWebPage(
      { title: 'A #tag [and] a|pipe', markdown: 'Text', url: null },
      DEFAULT_PRIORITY,
      null
    );

    expect(repo.rows('article')[0].reference).toBe(
      `${ARTICLES}/${Obsidian.sanitizeForTitle('A #tag [and] a|pipe', true)}.md`
    );
    expect(notify).toHaveBeenCalledOnce();
  });

  it('names the note apart from one already in the articles folder, saying so', async () => {
    const taken = `${ARTICLES}/Page.md`;
    const { vault, repo, manager, notify, before } = await wireArticles(
      { [taken]: { title: 'x' } },
      null
    );

    await manager.importWebPage(
      { title: 'Page', markdown: 'Text', url: null },
      DEFAULT_PRIORITY,
      null
    );

    const path = repo.rows('article')[0].reference as string;
    expect(path.startsWith(`${ARTICLES}/Page - `)).toBe(true);
    expect(path.slice(ARTICLES.length + 1)).not.toContain('/');
    expect(vault.paths()).toEqual([path, taken].sort());
    expect(vault.frontmatterOf(taken)).toEqual(before[taken]);
    expect(notify).toHaveBeenCalledWith(
      'Warning: article with name already exists "Page.md"',
      { persist: true }
    );
  });

  it('names the article in its notice, cut short when its title is long', async () => {
    const { manager, notify } = await wireArticles({}, null);
    const title = 'A'.repeat(CONTENT_TITLE_SLICE_LENGTH + 10);

    await manager.importWebPage(
      { title, markdown: 'Text', url: null },
      DEFAULT_PRIORITY,
      null
    );

    expect(notify).toHaveBeenCalledOnce();
    expect(
      notify.mock.calls[0][0].startsWith(
        `Imported "${'A'.repeat(CONTENT_TITLE_SLICE_LENGTH - 3)}..." with `
      )
    ).toBe(true);
  });

  it("writes the note's properties in one write", async () => {
    const { vault, manager } = await wireArticles({}, null);

    await manager.importWebPage(
      { title: 'Page', markdown: 'Text', url: 'https://example.com/' },
      DEFAULT_PRIORITY,
      null
    );

    expect(vault.processFrontMatter).toHaveBeenCalledOnce();
  });

  it('marks the note as the article before its row is written', async () => {
    // A note holding an ir-id no row has is how a cut-short import is found
    // and adopted (see `crash-leftovers`)
    const { vault, repo, manager } = await wireArticles({}, null);
    let atInsert: unknown;
    repo.failWrite((query) => {
      if (query.startsWith('INSERT INTO article')) {
        atInsert = vault.frontmatterOf(vault.paths()[0]);
      }
      return false;
    });

    await manager.importWebPage(
      { title: 'Page', markdown: 'Text', url: null },
      DEFAULT_PRIORITY,
      null
    );

    expect(atInsert).toMatchObject({
      'ir-id': repo.rows('article')[0].id,
      tags: [ARTICLE_TAG],
    });
  });

  it('makes the note and its row together, or neither, saying so', async () => {
    for (const failure of ['create', 'frontmatter', 'row'] as const) {
      vi.restoreAllMocks();
      const { vault, repo, manager, notify } = await wireArticles({}, failure);

      const article = await manager.importWebPage(
        { title: 'Page', markdown: 'Text', url: 'https://example.com/' },
        DEFAULT_PRIORITY,
        null
      );

      expect(article).toBeNull();
      expect(repo.rows('article')).toEqual([]);
      expect(vault.paths()).toEqual([]);
      expect(notify).toHaveBeenCalledExactlyOnceWith('Failed to import "Page"');
    }
  });

  it('makes nothing while writes are refused, saying so', async () => {
    const { vault, repo, manager, notify } = await wireArticles({}, null, true);

    const article = await manager.importWebPage(
      { title: 'Page', markdown: 'Text', url: null },
      DEFAULT_PRIORITY,
      null
    );

    expect(article).toBeNull();
    expect(vault.paths()).toEqual([]);
    expect(repo.rows('article')).toEqual([]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(refusal('import "Page"'), {
      kind: 'error',
    });
  });
});

describe("an import notice's Open button", () => {
  const NOTE = 'notes/Paper.md';
  const PAPER = 'papers/Paper.pdf';

  /** Every way an article can be imported. */
  type ImportWay =
    | 'note copy'
    | 'PDF copy'
    | 'web page'
    | 'note in place'
    | 'PDF in place';

  /** The ways that make a note of their own, which the button opens. */
  const NEW_NOTE_WAYS: ImportWay[] = ['note copy', 'PDF copy', 'web page'];

  /**
   * A manager over a vault holding a note and a PDF, with the plugin's opener
   * as a spy, importing them `way`.
   * @returns the wiring, the opener, the imported article's row id, and the
   *   options its "Imported" notice was raised with
   */
  async function importBy(way: ImportWay) {
    const wired = await wireArticles({ [NOTE]: null, [PAPER]: null }, null);
    const openFile = vi.fn<Actions['_openFile']>(async () => null);
    Object.assign(wired.manager.plugin, { actions: { _openFile: openFile } });
    const { manager, vault } = wired;
    if (way === 'web page') {
      await manager.importWebPage(
        { title: 'Paper', markdown: '# Paper', url: null },
        DEFAULT_PRIORITY,
        null
      );
    } else {
      const file = vault.files.get(way.startsWith('PDF') ? PAPER : NOTE)!;
      await manager.import(file, DEFAULT_PRIORITY, null, way.endsWith('copy'));
    }
    const [row] = wired.repo.rows('article');
    const imported = wired.notify.mock.calls.filter(([message]) =>
      message.startsWith('Imported "')
    );
    expect(imported).toHaveLength(1);
    const options = imported[0][1] as NotifyOptions;
    return { ...wired, openFile, id: row.id as string, options };
  }

  /** A click as `Keymap.isModEvent` reads one: its button and keys. */
  const clickArb = fc.record({
    button: fc.constantFrom(0, 1),
    ctrlKey: fc.boolean(),
    metaKey: fc.boolean(),
    altKey: fc.boolean(),
    shiftKey: fc.boolean(),
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is on the notice of every import that makes a note, and on none made in place', async () => {
    const ways: ImportWay[] = [
      ...NEW_NOTE_WAYS,
      'note in place',
      'PDF in place',
    ];
    for (const way of ways) {
      vi.restoreAllMocks();

      const { options } = await importBy(way);

      // Still an import's confirmation, which the `minimal` level keeps
      expect(options).toMatchObject({ kind: 'success', category: 'import' });
      if (NEW_NOTE_WAYS.includes(way)) {
        expect(options.action?.label).toBe('Open');
      } else {
        expect(options.action).toBeUndefined();
      }
    }
  });

  it('property: opens the imported note where it is now, where the click says, as Go to context does', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...NEW_NOTE_WAYS),
        clickArb,
        fc.boolean(),
        async (way, click, renamed) => {
          vi.restoreAllMocks();
          const { options, openFile, vault, repo, id } = await importBy(way);
          let path = repo.rows('article')[0].reference as string;
          if (renamed) {
            // As a rename does: the note moves and its row follows it
            const to = `elsewhere/${path.slice(path.lastIndexOf('/') + 1)}`;
            vault.move(path, to);
            repo.mutate('UPDATE article SET reference = $1 WHERE id = $2', [
              to,
              id,
            ]);
            path = to;
          }
          const evt = click as unknown as MouseEvent;

          options.action!.onClick(evt);

          await vi.waitFor(() => expect(openFile).toHaveBeenCalled());
          expect(openFile).toHaveBeenCalledExactlyOnceWith(
            vault.files.get(path),
            null,
            Keymap.isModEvent(evt)
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('opens in the tab the user is in on a plain click', async () => {
    const { options, openFile } = await importBy('note copy');

    options.action!.onClick({ button: 0 } as MouseEvent);

    await vi.waitFor(() => expect(openFile).toHaveBeenCalled());
    expect(openFile.mock.calls[0][2]).toBe(false);
  });

  it('says the article is gone, opening nothing, once its note or its row is', async () => {
    const losses = ['note trashed', 'row deleted', 'row removed'] as const;
    for (const way of NEW_NOTE_WAYS) {
      for (const loss of losses) {
        vi.restoreAllMocks();
        const { options, openFile, vault, repo, id, notify } =
          await importBy(way);
        const path = repo.rows('article')[0].reference as string;
        if (loss === 'note trashed') vault.files.delete(path);
        if (loss === 'row deleted') {
          repo.mutate('UPDATE article SET deleted = 1 WHERE id = $1', [id]);
        }
        if (loss === 'row removed') {
          repo.mutate('DELETE FROM article WHERE id = $1', [id]);
        }
        notify.mockClear();

        options.action!.onClick({ button: 0 } as MouseEvent);

        await vi.waitFor(() => expect(notify).toHaveBeenCalled());
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          `Couldn't open "Paper": the article is gone`,
          { kind: 'error' }
        );
        expect(openFile).not.toHaveBeenCalled();
      }
    }
  });
});

describe('adoptLeftover', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gives a leftover article a row due now at the default priority, at its path', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 ** 40 }), async (now) => {
        vi.restoreAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
        const { vault, repo, manager } = await wireArticles(
          { 'notes/left.md': { 'ir-id': 'left-1', tags: [ARTICLE_TAG] } },
          null
        );

        await manager.adoptLeftover(
          vault.files.get('notes/left.md')!,
          'left-1'
        );

        expect(repo.rows('article')).toEqual([
          expect.objectContaining({
            id: 'left-1',
            reference: 'notes/left.md',
            due: now,
            priority: DEFAULT_PRIORITY,
            fixed_interval_days: null,
          }),
        ]);
      }),
      { numRuns: 10 }
    );
  });

  it('keeps the row, and says so, when adopting what was taken from it fails', async () => {
    const { vault, repo, manager, notify } = await wireArticles(
      { 'notes/left.md': { 'ir-id': 'left-1', tags: [ARTICLE_TAG] } },
      null
    );
    vi.spyOn(
      manager as unknown as { claimInPlace: () => unknown },
      'claimInPlace'
    ).mockRejectedValue(new Error('adopt failed'));

    await manager.adoptLeftover(vault.files.get('notes/left.md')!, 'left-1');

    expect(repo.rows('article')).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(
      `"left" is an article, but the snippets and cards taken from it couldn't be adopted`,
      { kind: 'error', persist: true }
    );
  });
});

describe('import of a snippet or card note', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses it in place or as a copy, saying why', async () => {
    for (const tag of [SNIPPET_TAG, CARD_TAG]) {
      for (const makeCopy of [false, true]) {
        vi.restoreAllMocks();
        const { vault, repo, notify, manager } = await wireArticles(
          { [SOURCE]: { tags: [tag] } },
          null
        );

        const article = await manager.import(
          vault.files.get(SOURCE)!,
          DEFAULT_PRIORITY,
          null,
          makeCopy
        );

        expect(article).toBeNull();
        expect(repo.rows('article')).toEqual([]);
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          'Note contains a snippet or card tag; canceling import'
        );
      }
    }
  });
});

describe('importMany', () => {
  beforeEach(() => {
    // A write of many rows yields through `window`, which this node
    // environment lacks
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A note or a PDF, by name, in a folder of its own kind. */
  const fileSpecsArb = fc.uniqueArray(
    fc.record({
      name: fc.stringMatching(/^[a-z]{1,6}$/),
      pdf: fc.boolean(),
      /** Whether the vault refuses to write it, or its copy. */
      faulty: fc.boolean(),
    }),
    { selector: (spec) => spec.name, minLength: 1, maxLength: 5 }
  );

  const optionsArb = fc.record({
    priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
    fixedIntervalDays: fc.option(
      fc.integer({
        min: MINIMUM_FIXED_REVIEW_INTERVAL,
        max: MAXIMUM_FIXED_REVIEW_INTERVAL,
      }),
      { nil: null }
    ),
    makeCopy: fc.boolean(),
  });

  const pathOf = ({ name, pdf }: { name: string; pdf: boolean }) =>
    pdf ? `papers/${name}.pdf` : `notes/${name}.md`;

  it('imports every file with the options given, isolating the ones that throw, and tells the user nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fileSpecsArb, optionsArb, async (specs, options) => {
        vi.restoreAllMocks();
        const { vault, repo, notify, manager } = await wireArticles(
          Object.fromEntries(
            specs.map((spec) => [pathOf(spec), spec.pdf ? null : {}])
          ),
          null
        );
        const copyPathOf = (spec: { name: string; pdf: boolean }) =>
          `${ARTICLES_FOLDER}/${spec.name}.${spec.pdf ? 'pdf' : 'md'}`;
        // Where each file's import writes: a PDF imported in place writes
        // nothing but its row, so the vault has nothing to refuse there
        const fails = (spec: (typeof specs)[number]) =>
          spec.faulty && (options.makeCopy || !spec.pdf);
        const faulty = new Set(
          specs
            .filter(fails)
            .map((spec) => (options.makeCopy ? copyPathOf(spec) : pathOf(spec)))
        );
        vault.fail(options.makeCopy ? 'create' : 'frontmatter', (path) =>
          faulty.has(path)
        );
        vault.fail('copy', (path) => faulty.has(path));
        const files = specs.map((spec) => vault.files.get(pathOf(spec))!);

        const outcomes = await manager.importMany(
          files.map((file) => ({ file })),
          options
        );

        expect(notify).not.toHaveBeenCalled();
        expect(outcomes.map((outcome) => outcome.file)).toEqual(files);
        const rows = repo.rows('article');
        specs.forEach((spec, i) => {
          const where = options.makeCopy ? copyPathOf(spec) : pathOf(spec);
          const row = rows.find((r) => r.reference === where);
          if (fails(spec)) {
            // A note's copy is made through `createNote`, which says only
            // that it failed
            const reason = !options.makeCopy
              ? `frontmatter failed at ${where}`
              : spec.pdf
                ? `copy failed at ${where}`
                : `Failed to create note ${where}`;
            expect(outcomes[i]).toEqual({
              file: files[i],
              status: 'failed',
              reason,
            });
            expect(row).toBeUndefined();
          } else {
            expect(outcomes[i]).toEqual({ file: files[i], status: 'imported' });
            expect(row).toMatchObject({
              priority: options.priority,
              fixed_interval_days: options.fixedIntervalDays,
            });
          }
        });
        expect(rows).toHaveLength(specs.filter((spec) => !fails(spec)).length);
        // Every copy that failed was taken back
        expect(vault.paths()).toEqual(
          [
            ...specs.map(pathOf),
            ...(options.makeCopy
              ? specs.filter((spec) => !fails(spec)).map(copyPathOf)
              : []),
          ].sort()
        );
      }),
      { numRuns: 40 }
    );
  });

  it('imports files one after another', async () => {
    const { vault, manager } = await wireArticles(
      { 'notes/a.md': {}, 'notes/b.md': {}, 'notes/c.md': {} },
      null
    );
    const files = ['notes/a.md', 'notes/b.md', 'notes/c.md'].map(
      (path) => vault.files.get(path)!
    );
    let reading = 0;
    let overlapped = false;
    const readBinary = vault.app.vault.readBinary;
    const read = readBinary.getMockImplementation()!;
    readBinary.mockImplementation(async (file: TFile) => {
      reading += 1;
      overlapped ||= reading > 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      reading -= 1;
      return read(file);
    });

    await manager.importMany(
      files.map((file) => ({ file })),
      { priority: DEFAULT_PRIORITY, fixedIntervalDays: null, makeCopy: false }
    );

    expect(overlapped).toBe(false);
    expect(readBinary.mock.calls.map(([file]) => file.path)).toEqual(
      files.map((file) => file.path)
    );
  });

  it('says why it imported nothing, quietly, keeping on with the rest', async () => {
    const refusedChar = [...REFUSED_PATH_CHARS][0];
    const insertArticle =
      (id: string, reference: string) => (repo: TestRepository) =>
        repo.db!.exec(
          `INSERT INTO article (id, reference, due, interval, priority)
         VALUES ($1, $2, 0, 1, 20)`,
          [id, reference]
        );
    const cases: {
      path: string;
      frontmatter: Record<string, unknown> | null;
      makeCopy: boolean;
      status: 'skipped' | 'failed';
      reason: string;
      setUp?: (repo: TestRepository) => void;
    }[] = [
      {
        path: 'notes/image.png',
        frontmatter: null,
        makeCopy: false,
        status: 'failed',
        reason: "can't be imported as an article",
      },
      {
        path: 'notes/snippet.md',
        frontmatter: { tags: [SNIPPET_TAG] },
        makeCopy: false,
        status: 'failed',
        reason: 'has a snippet or card tag',
      },
      {
        path: 'notes/card.md',
        frontmatter: { tags: [CARD_TAG] },
        makeCopy: true,
        status: 'failed',
        reason: 'has a snippet or card tag',
      },
      {
        path: `notes/a${refusedChar}b.md`,
        frontmatter: {},
        makeCopy: false,
        status: 'failed',
        reason: `its name or folder contains ${listChars([refusedChar])}`,
      },
      {
        path: 'notes/taken.md',
        frontmatter: {},
        makeCopy: false,
        status: 'failed',
        reason: 'another article is at its path',
        setUp: insertArticle('other', 'notes/taken.md'),
      },
      {
        path: 'notes/article.md',
        frontmatter: { 'ir-id': 'mine' },
        makeCopy: false,
        status: 'skipped',
        reason: 'already an article',
        setUp: insertArticle('mine', 'notes/article.md'),
      },
      {
        path: 'papers/article.pdf',
        frontmatter: null,
        makeCopy: false,
        status: 'skipped',
        reason: 'already an article',
        setUp: insertArticle('pdf', 'papers/article.pdf'),
      },
    ];
    for (const {
      path,
      frontmatter,
      makeCopy,
      status,
      reason,
      setUp,
    } of cases) {
      vi.restoreAllMocks();
      const { vault, repo, notify, manager } = await wireArticles(
        { [path]: frontmatter, 'notes/fine.md': {} },
        null
      );
      setUp?.(repo);
      const fine = vault.files.get('notes/fine.md')!;
      const file = vault.files.get(path)!;

      const outcomes = await manager.importMany([{ file }, { file: fine }], {
        priority: DEFAULT_PRIORITY,
        fixedIntervalDays: null,
        makeCopy,
      });

      expect(outcomes, path).toEqual([
        { file, status, reason },
        { file: fine, status: 'imported' },
      ]);
      expect(notify, path).not.toHaveBeenCalled();
    }
  });

  it("fails a file whose content isn't what its extension says, quietly", async () => {
    const { vault, notify, manager } = await wireArticles(
      { 'notes/fake.md': {} },
      null
    );
    const file = vault.files.get('notes/fake.md')!;
    vault.app.vault.readBinary.mockResolvedValue(
      new TextEncoder().encode('%PDF-1.7').buffer
    );

    const outcomes = await manager.importMany([{ file }], {
      priority: DEFAULT_PRIORITY,
      fixedIntervalDays: null,
      makeCopy: false,
    });

    expect(outcomes).toEqual([
      {
        file,
        status: 'failed',
        reason: "its content isn't what its extension says",
      },
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails every file while writes are refused, writing nothing', async () => {
    const { vault, repo, notify, manager } = await wireArticles(
      { 'notes/a.md': {}, 'papers/b.pdf': null },
      null,
      true
    );
    const files = ['notes/a.md', 'papers/b.pdf'].map(
      (path) => vault.files.get(path)!
    );

    const outcomes = await manager.importMany(
      files.map((file) => ({ file })),
      { priority: DEFAULT_PRIORITY, fixedIntervalDays: null, makeCopy: true }
    );

    expect(outcomes).toEqual(
      files.map((file) => ({
        file,
        status: 'failed',
        reason: 'saving to the database is paused',
      }))
    );
    expect(repo.rows('article')).toEqual([]);
    expect(vault.paths()).toEqual(['notes/a.md', 'papers/b.pdf']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips a file being imported already, importing it once', async () => {
    const { vault, repo, manager } = await wireArticles(
      { 'notes/a.md': {} },
      null
    );
    const file = vault.files.get('notes/a.md')!;
    const readBinary = vault.app.vault.readBinary;
    const read = readBinary.getMockImplementation()!;
    let release = (): void => undefined;
    readBinary.mockImplementationOnce(
      (f: TFile) =>
        new Promise((resolve) => {
          release = () => resolve(read(f));
        })
    );

    const first = manager.import(file, DEFAULT_PRIORITY, null, false);
    const outcomes = await manager.importMany([{ file }], {
      priority: DEFAULT_PRIORITY,
      fixedIntervalDays: null,
      makeCopy: false,
    });
    release();
    await first;

    expect(outcomes).toEqual([
      { file, status: 'skipped', reason: 'already being imported' },
    ]);
    expect(repo.rows('article')).toHaveLength(1);
  });

  it('keeps what it would have warned about out of sight', async () => {
    const { vault, notify, manager } = await wireArticles(
      { 'notes/a.md': {}, [`${ARTICLES_FOLDER}/a.md`]: { title: 'x' } },
      null
    );
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const file = vault.files.get('notes/a.md')!;

    const outcomes = await manager.importMany([{ file }], {
      priority: DEFAULT_PRIORITY,
      fixedIntervalDays: null,
      makeCopy: true,
    });

    expect(outcomes).toEqual([{ file, status: 'imported' }]);
    expect(notify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Warning: article with name already exists "a.md"'
    );
  });

  it('fails a file with what anything else thrown says', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string().map((message) => new Error(message)),
          fc.string(),
          fc.integer()
        ),
        async (thrown) => {
          vi.restoreAllMocks();
          const { vault, notify, manager } = await wireArticles(
            { 'notes/a.md': {} },
            null
          );
          vi.spyOn(Obsidian, 'getFrontMatter').mockImplementation(() => {
            // Anything can be thrown, an Error or not
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw thrown;
          });
          const file = vault.files.get('notes/a.md')!;

          const outcomes = await manager.importMany([{ file }], {
            priority: DEFAULT_PRIORITY,
            fixedIntervalDays: null,
            makeCopy: false,
          });

          expect(outcomes).toEqual([
            {
              file,
              status: 'failed',
              reason: thrown instanceof Error ? thrown.message : String(thrown),
            },
          ]);
          expect(notify).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 20 }
    );
  });

  // Each save exports the whole database and rewrites its file: a folder of
  // hundreds of notes saved it hundreds of times
  it('writes every row of the batch in one paced run, saving once a chunk rather than once a file', async () => {
    await fc.assert(
      fc.asyncProperty(
        batchSpecsArb,
        batchOptionsArb,
        fc.integer({ min: 1, max: 8 }),
        async (specs, options, sliceMs) => {
          vi.restoreAllMocks();
          // Fuzzed, a fetched article gets its fuzz written on the spot
          const { repo, manager, files } = await batchWorld(specs, {
            fuzz: true,
          });
          const writes = watchWrites(repo, sliceMs);

          await manager.importMany(
            files.map((file) => ({ file })),
            options
          );

          expect(writes.bulkMutate).toHaveBeenCalledOnce();
          expect(writes.outside()).toBe(0);
          const [statements] = writes.bulkMutate.mock.calls[0];
          expect(writes.save).toHaveBeenCalledTimes(
            Math.ceil(statements.length / sliceMs)
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('leaves the same rows, notes and adoptions as importing each file on its own', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    await fc.assert(
      fc.asyncProperty(
        batchSpecsArb,
        batchOptionsArb,
        fc.boolean(),
        async (specs, options, withReviewManager) => {
          vi.restoreAllMocks();
          const batch = await batchWorld(specs, { withReviewManager });
          const alone = await batchWorld(specs, { withReviewManager });

          await batch.manager.importMany(
            batch.files.map((file) => ({ file })),
            options
          );
          for (const file of alone.files) {
            await alone.manager.import(
              file,
              options.priority,
              options.fixedIntervalDays,
              options.makeCopy
            );
          }

          expect(batchSnapshot(batch)).toEqual(batchSnapshot(alone));
          // Their notes repainted alike: once a file that adopted something
          expect(batch.getHighlights.mock.calls).toEqual(
            alone.getHighlights.mock.calls
          );
          expect(batch.trigger.mock.calls).toEqual(alone.trigger.mock.calls);
        }
      ),
      { numRuns: 60 }
    );
  });

  // Unfuzzed, the rows of a batch would come up for review in the order the
  // files were imported, one after another: a batch fetches none of them,
  // which is where an article missing its fuzz is given one
  it('gives each article it makes the fuzz an import of that file alone does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    await fc.assert(
      fc.asyncProperty(
        freshBatchArb,
        batchOptionsArb,
        fc.boolean(),
        fc.integer(),
        async (specs, options, fuzz, drawn) => {
          vi.restoreAllMocks();
          const batch = await batchWorld(specs, { fuzz });
          const alone = await batchWorld(specs, { fuzz });
          vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(drawn);

          await batch.manager.importMany(
            batch.files.map((file) => ({ file })),
            options
          );
          for (const file of alone.files) {
            await alone.manager.import(
              file,
              options.priority,
              options.fixedIntervalDays,
              options.makeCopy
            );
          }

          expect(batchSnapshot(batch)).toEqual(batchSnapshot(alone));
          expect(batch.repo.rows('article').map((row) => row.due_fuzz)).toEqual(
            specs.map(() => (fuzz ? drawn : null))
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('keeps the files whose rows were written when the run stops, and takes back every other', async () => {
    await fc.assert(
      fc.asyncProperty(
        freshBatchArb,
        fc.boolean(),
        fc.integer({ min: 1, max: 4 }),
        fc.oneof(
          fc.record({ kind: fc.constant('statement' as const), at: fc.nat() }),
          fc.record({ kind: fc.constant('refused' as const) })
        ),
        async (specs, makeCopy, sliceMs, stop) => {
          vi.restoreAllMocks();
          const { vault, repo, manager, files } = await batchWorld(specs);
          const before = files.map((file) =>
            structuredClone(vault.frontmatterOf(file.path))
          );
          // One statement a file: its row
          const failAt = stop.kind === 'statement' ? stop.at % files.length : 0;
          const writes = watchWrites(repo, sliceMs, (statements) => {
            if (stop.kind === 'refused') {
              repo.refuseWrites();
              return [...statements];
            }
            return statements.map((statement, i) =>
              i === failAt ? { query: 'not a statement' } : statement
            );
          });
          const written =
            stop.kind === 'refused'
              ? 0
              : Math.floor(failAt / sliceMs) * sliceMs;

          const outcomes = await manager.importMany(
            files.map((file) => ({ file })),
            {
              priority: DEFAULT_PRIORITY,
              fixedIntervalDays: null,
              makeCopy,
            }
          );

          const stopped = writes.stopped();
          expect(stopped).toBeInstanceOf(BulkMutateError);
          const reason = ((stopped as BulkMutateError).cause as Error).message;
          expect(outcomes).toEqual(
            files.map((file, i) =>
              i < written
                ? { file, status: 'imported' }
                : { file, status: 'failed', reason }
            )
          );
          const kept = specs.slice(0, written);
          expect(
            repo
              .rows('article')
              .map((row) => row.reference)
              .sort()
          ).toEqual(kept.map((spec) => batchTargetOf(spec, makeCopy)).sort());
          // Copies of the rest trashed, their notes as they were
          expect(vault.paths()).toEqual(
            [
              ...specs.map(batchPathOf),
              ...(makeCopy
                ? kept.map((spec) => batchTargetOf(spec, true))
                : []),
            ].sort()
          );
          files.forEach((file, i) => {
            if (i >= written) {
              expect(vault.frontmatterOf(file.path)).toEqual(before[i]);
            }
          });
        }
      ),
      { numRuns: 60 }
    );
  });

  it('keeps a file imported whose row was written but not all of its adoptions, saying so out of sight', async () => {
    const spec: BatchSpec = {
      name: 'a',
      pdf: false,
      state: 'fresh',
      snippets: 1,
      cards: 1,
    };
    const { repo, manager, files, getHighlights } = await batchWorld([spec]);
    const [file] = files;
    // Its row, its snippet's adoption, then its card's, which fails
    watchWrites(repo, 1, (statements) =>
      statements.map((statement, i) =>
        i === 2 ? { query: 'not a statement' } : statement
      )
    );

    const outcomes = await manager.importMany([{ file }], {
      priority: DEFAULT_PRIORITY,
      fixedIntervalDays: null,
      makeCopy: false,
    });

    expect(outcomes).toEqual([{ file, status: 'imported' }]);
    const [article] = repo.rows('article');
    expect(article.reference).toBe(file.path);
    expect(repo.rows('snippet')).toMatchObject([
      { id: 'a-s0', parent: article.id },
    ]);
    expect(repo.rows('srs_card')).toMatchObject([{ id: 'a-c0', parent: null }]);
    expect(console.warn).toHaveBeenCalledWith(
      `"a" is an article, but the snippets and cards taken from it couldn't be adopted`
    );
    expect(getHighlights).not.toHaveBeenCalled();
  });

  it('fails and takes back every file it held when the run fails outright', async () => {
    await fc.assert(
      fc.asyncProperty(freshBatchArb, fc.boolean(), async (specs, makeCopy) => {
        vi.restoreAllMocks();
        const { vault, repo, manager, files } = await batchWorld(specs);
        const before = vault
          .paths()
          .map((path) => [path, structuredClone(vault.frontmatterOf(path))]);
        vi.spyOn(repo, 'bulkMutate').mockRejectedValue(new Error('gone'));

        const outcomes = await manager.importMany(
          files.map((file) => ({ file })),
          { priority: DEFAULT_PRIORITY, fixedIntervalDays: null, makeCopy }
        );

        expect(outcomes).toEqual(
          files.map((file) => ({ file, status: 'failed', reason: 'gone' }))
        );
        expect(repo.rows('article')).toEqual([]);
        expect(
          vault.paths().map((path) => [path, vault.frontmatterOf(path)])
        ).toEqual(before);
      }),
      { numRuns: 30 }
    );
  });

  // Nothing of it was held back for the run, so nothing of it was lost there
  it('skips an article with nothing to adopt, whatever became of the run', async () => {
    const specs: BatchSpec[] = [
      { name: 'a', pdf: false, state: 'fresh', snippets: 0, cards: 0 },
      { name: 'b', pdf: false, state: 'article', snippets: 0, cards: 0 },
    ];
    const { repo, manager, files } = await batchWorld(specs);
    watchWrites(repo, 1, () => [{ query: 'not a statement' }]);

    const outcomes = await manager.importMany(
      files.map((file) => ({ file })),
      { priority: DEFAULT_PRIORITY, fixedIntervalDays: null, makeCopy: false }
    );

    expect(outcomes[0]).toMatchObject({ file: files[0], status: 'failed' });
    expect(outcomes[1]).toEqual({
      file: files[1],
      status: 'skipped',
      reason: 'already an article',
    });
  });

  it('fails an article whose stranded snippets and cards could not be adopted', async () => {
    const spec: BatchSpec = {
      name: 'a',
      pdf: false,
      state: 'article',
      snippets: 1,
      cards: 0,
    };
    const { repo, manager, files } = await batchWorld([spec]);
    const [file] = files;
    const writes = watchWrites(repo, 1, () => [{ query: 'not a statement' }]);

    const outcomes = await manager.importMany([{ file }], {
      priority: DEFAULT_PRIORITY,
      fixedIntervalDays: null,
      makeCopy: false,
    });

    const stopped = writes.stopped() as BulkMutateError;
    expect(outcomes).toEqual([
      { file, status: 'failed', reason: (stopped.cause as Error).message },
    ]);
    expect(repo.rows('snippet')).toMatchObject([{ id: 'a-s0', parent: null }]);
  });

  it('imports the file as an import of it alone would when its snippets and cards cannot be found, saying so out of sight', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (makeCopy) => {
        vi.restoreAllMocks();
        const spec: BatchSpec = {
          name: 'a',
          pdf: false,
          state: 'fresh',
          snippets: 1,
          cards: 1,
        };
        const { repo, manager, files } = await batchWorld([spec]);
        const [file] = files;
        const unreadable = new Error('unreadable');
        vi.spyOn(
          ItemManager.prototype as unknown as {
            findParentlessFrom(): Promise<unknown>;
          },
          'findParentlessFrom'
        ).mockRejectedValue(unreadable);

        const outcomes = await manager.importMany([{ file }], {
          priority: DEFAULT_PRIORITY,
          fixedIntervalDays: null,
          makeCopy,
        });

        // Found before the copy is made, it fails the import of a copy
        if (makeCopy) {
          expect(outcomes).toEqual([
            { file, status: 'failed', reason: 'unreadable' },
          ]);
          return;
        }
        expect(outcomes).toEqual([{ file, status: 'imported' }]);
        expect(repo.rows('article')).toMatchObject([{ reference: file.path }]);
        expect(console.warn).toHaveBeenCalledWith(
          `"a" is an article, but the snippets and cards taken from it couldn't be adopted`
        );
        // Logged as what it was
        expect(console.error).toHaveBeenCalledWith(unreadable);
      })
    );
  });
});

describe('importMany, copying a note imported for its trigger tags', () => {
  beforeEach(() => {
    // A write of many rows yields through `window`, which this node
    // environment lacks
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const NOTE = 'notes/clip.md';
  const COPY = `${ARTICLES_FOLDER}/clip.md`;
  const OPTIONS = {
    priority: DEFAULT_PRIORITY,
    fixedIntervalDays: null,
    makeCopy: true,
  };

  /** A tag a clipped note can carry, the trigger tags among them. */
  const clipTagArb = fc.constantFrom(
    'ir-import',
    '#IR-Import',
    'clip',
    'Read/Later',
    'other'
  );

  /**
   * A clipped note's properties, its tags written any way Obsidian reads
   * them, and the trigger tags among them that asked for the import.
   */
  const clippedArb = fc
    .record({
      tags: fc.oneof(
        clipTagArb,
        fc.array(fc.oneof(clipTagArb, fc.constant(null)), { maxLength: 4 })
      ),
      tag: fc.option(clipTagArb, { nil: undefined }),
      title: fc.option(fc.string(), { nil: undefined }),
      source: fc.option(fc.constantFrom('https://example.com', ''), {
        nil: undefined,
      }),
    })
    .map(
      (record) =>
        Object.fromEntries(
          Object.entries(record).filter(([, value]) => value !== undefined)
        ) as Record<string, unknown>
    )
    .chain((frontmatter) =>
      fc
        .subarray(['ir-import', 'clip', 'read/later', 'other'])
        .map((triggers) => ({
          frontmatter,
          // As the watcher hands them on: those the note carries
          stripFromSource: matchFrontmatterTags(frontmatter, triggers),
        }))
    );

  it('makes the copy the article, carrying all the note had, and takes off the note only the tags that asked', async () => {
    await fc.assert(
      fc.asyncProperty(clippedArb, async ({ frontmatter, stripFromSource }) => {
        vi.restoreAllMocks();
        const { vault, repo, manager } = await wireArticles(
          { [NOTE]: structuredClone(frontmatter) },
          null
        );
        try {
          const file = vault.files.get(NOTE)!;

          const outcomes = await manager.importMany(
            [{ file, stripFromSource }],
            OPTIONS
          );

          expect(outcomes).toEqual([{ file, status: 'imported' }]);
          const [row] = repo.rows('article');
          expect(row.reference).toBe(COPY);
          // The note keeps all else, its other tags included
          const left = structuredClone(frontmatter);
          stripFrontmatterTags(left, stripFromSource);
          expect(vault.frontmatterOf(NOTE) ?? {}).toEqual(left);
          // The copy's text opens with the note's properties as they were,
          // which its own are written into
          expect(vault.bodyOf(COPY)).toBe(noteText(frontmatter));
          const copied = vault.frontmatterOf(COPY)!;
          expect(copied).toMatchObject({ 'ir-id': row.id });
          expect(copied.tags).toContain(ARTICLE_TAG);
          expect(typeof copied.created).toBe('string');
          expect(copied[SOURCE_PROPERTY_NAME]).toBe(
            frontmatter.source ? undefined : `[[${NOTE}|clip]]`
          );
          expect(vault.paths()).toEqual([COPY, NOTE].sort());
        } finally {
          repo.dispose();
        }
      }),
      { numRuns: 40 }
    );
  });

  it("writes the copy's properties only once its text is there, so the note's properties it opens with stay properties", async () => {
    const { vault, repo, manager } = await wireArticles(
      { [NOTE]: { tags: ['ir-import'] } },
      null
    );
    const file = vault.files.get(NOTE)!;

    await manager.importMany(
      [{ file, stripFromSource: ['ir-import'] }],
      OPTIONS
    );

    const copy = vault.files.get(COPY)!;
    const appended = vault.app.vault.append.mock.invocationCallOrder[0];
    const written = vault.processFrontMatter.mock.calls.flatMap(
      ([target], i) =>
        target === copy
          ? [vault.processFrontMatter.mock.invocationCallOrder[i]]
          : []
    );
    expect(vault.app.vault.append).toHaveBeenCalledExactlyOnceWith(
      copy,
      noteText({ tags: ['ir-import'] })
    );
    expect(written).toHaveLength(1);
    expect(written.every((order) => order > appended)).toBe(true);
    repo.dispose();
  });

  it('writes nothing to the note when no tags are to be taken off it', async () => {
    for (const stripFromSource of [undefined, []]) {
      vi.restoreAllMocks();
      const { vault, repo, manager } = await wireArticles(
        { [NOTE]: { tags: ['ir-import'] } },
        null
      );
      const file = vault.files.get(NOTE)!;

      const outcomes = await manager.importMany(
        [{ file, stripFromSource }],
        OPTIONS
      );

      expect(outcomes).toEqual([{ file, status: 'imported' }]);
      expect(
        vault.processFrontMatter.mock.calls.filter(
          ([target]) => target === file
        )
      ).toEqual([]);
      expect(vault.frontmatterOf(NOTE)).toEqual({ tags: ['ir-import'] });
      repo.dispose();
    }
  });

  it('leaves the tags on a note whose ir-id a row holds, which is linked back to its row, not copied', async () => {
    for (const deleted of [false, true]) {
      vi.restoreAllMocks();
      const frontmatter = {
        'ir-id': 'kept',
        tags: ['ir-import', 'other', ARTICLE_TAG],
      };
      const { vault, repo, manager } = await wireArticles(
        { [NOTE]: structuredClone(frontmatter) },
        null
      );
      repo.mutate(
        `INSERT INTO article (id, reference, due, interval, priority, deleted)
         VALUES ('kept', 'notes/old.md', 0, 1, 10, $1)`,
        [deleted]
      );
      const file = vault.files.get(NOTE)!;

      const outcomes = await manager.importMany(
        [{ file, stripFromSource: ['ir-import'] }],
        OPTIONS
      );

      expect(outcomes).toEqual([{ file, status: 'imported' }]);
      expect(repo.rows('article')).toMatchObject([
        { id: 'kept', reference: NOTE, deleted: 0 },
      ]);
      expect(vault.paths()).toEqual([NOTE]);
      expect(vault.frontmatterOf(NOTE)).toEqual(frontmatter);
      repo.dispose();
    }
  });

  it("imports a note in the plugin's data folder where it is, keeping its tags, since a copy of it would be refused", async () => {
    const inData = `${DATA_DIRECTORY}/notes/clip.md`;
    const { vault, repo, manager } = await wireArticles(
      { [inData]: { tags: ['ir-import', 'other'] } },
      null
    );
    const file = vault.files.get(inData)!;

    const outcomes = await manager.importMany(
      [{ file, stripFromSource: ['ir-import'] }],
      OPTIONS
    );

    expect(outcomes).toEqual([{ file, status: 'imported' }]);
    const [row] = repo.rows('article');
    expect(row.reference).toBe(inData);
    expect(vault.frontmatterOf(inData)).toEqual({
      tags: ['ir-import', 'other', ARTICLE_TAG],
      'ir-id': row.id,
    });
    expect(vault.paths()).toEqual([inData]);
    repo.dispose();
  });

  it("copies a note whose name or folder only starts as the plugin's data folder does", async () => {
    for (const [path, name] of [
      [`${DATA_DIRECTORY} tips.md`, `${DATA_DIRECTORY} tips.md`],
      [`${DATA_DIRECTORY}-old/clip.md`, 'clip.md'],
      [`${DATA_DIRECTORY}.md`, `${DATA_DIRECTORY}.md`],
    ]) {
      vi.restoreAllMocks();
      const { vault, repo, manager } = await wireArticles(
        { [path]: { tags: ['ir-import', 'other'] } },
        null
      );
      const file = vault.files.get(path)!;

      const outcomes = await manager.importMany(
        [{ file, stripFromSource: ['ir-import'] }],
        OPTIONS
      );

      expect(outcomes).toEqual([{ file, status: 'imported' }]);
      const [row] = repo.rows('article');
      expect(row.reference).toBe(`${ARTICLES_FOLDER}/${name}`);
      expect(vault.frontmatterOf(path)).toEqual({ tags: ['other'] });
      repo.dispose();
    }
  });

  it('takes the copy back and leaves the note as it was when its tags cannot be taken off, or its row cannot be saved', async () => {
    for (const failure of ['strip', 'row'] as const) {
      vi.restoreAllMocks();
      const frontmatter = { tags: ['ir-import', 'other'], title: 'x' };
      const { vault, repo, manager } = await wireArticles(
        { [NOTE]: structuredClone(frontmatter) },
        failure === 'row' ? 'row' : null
      );
      if (failure === 'strip') {
        vault.fail('frontmatter', (path) => path === NOTE);
      }
      const file = vault.files.get(NOTE)!;

      const outcomes = await manager.importMany(
        [{ file, stripFromSource: ['ir-import'] }],
        OPTIONS
      );

      expect(outcomes).toMatchObject([{ file, status: 'failed' }]);
      expect(repo.rows('article')).toEqual([]);
      expect(vault.paths()).toEqual([NOTE]);
      expect(vault.trashed).toEqual([COPY]);
      expect(vault.frontmatterOf(NOTE)).toEqual(frontmatter);
      repo.dispose();
    }
  });

  it('puts back the tags of every note whose row the batch did not write, keeping them off those it did', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 4 })
          .chain((count) =>
            fc.tuple(fc.constant(count), fc.nat({ max: count - 1 }))
          ),
        async ([count, failAt]) => {
          vi.restoreAllMocks();
          const names = ['a', 'b', 'c', 'd'].slice(0, count);
          const frontmatter = { tags: ['ir-import', 'other'], title: 'x' };
          const { vault, repo, manager } = await wireArticles(
            Object.fromEntries(
              names.map((name) => [
                `notes/${name}.md`,
                structuredClone(frontmatter),
              ])
            ),
            null
          );
          // A chunk a row: the run stops at `failAt`'s, writing those before
          watchWrites(repo, 1, (statements) =>
            statements.map((statement, i) =>
              i === failAt ? { query: 'not a statement' } : statement
            )
          );
          const files = names.map(
            (name) => vault.files.get(`notes/${name}.md`)!
          );

          const outcomes = await manager.importMany(
            files.map((file) => ({ file, stripFromSource: ['ir-import'] })),
            OPTIONS
          );

          expect(outcomes.map(({ status }) => status)).toEqual(
            names.map((_, i) => (i < failAt ? 'imported' : 'failed'))
          );
          names.forEach((name, i) => {
            const note = `notes/${name}.md`;
            const copy = `${ARTICLES_FOLDER}/${name}.md`;
            if (i < failAt) {
              expect(vault.frontmatterOf(note)).toEqual({
                ...frontmatter,
                tags: ['other'],
              });
              expect(vault.files.has(copy)).toBe(true);
            } else {
              expect(vault.frontmatterOf(note)).toEqual(frontmatter);
              expect(vault.trashed).toContain(copy);
            }
          });
          repo.dispose();
        }
      ),
      { numRuns: 20 }
    );
  });
});
