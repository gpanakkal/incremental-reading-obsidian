import { ArticleManager } from '#/lib/items/ArticleManager';
import { CardManager } from '#/lib/items/CardManager';
import ReviewManager from '#/lib/items/ReviewManager';
import {
  deleteRowStatements,
  REVIEW_LOG_OF,
  tombstoneRowStatements,
} from '#/lib/items/row-delete';
import { SnippetManager } from '#/lib/items/SnippetManager';
import { evictedSpot } from '#/lib/moved-note-scan';
import { makeItemVault, TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ARTICLE_TAG,
  CARD_TAG,
  DATA_DIRECTORY,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_TAG,
} from './constants';
import {
  type HeldChoice,
  type Leftover,
  type PathHolder,
  type Plan,
  type PurgedRow,
  actionsFor,
  failureDetail,
  failureOf,
  findCandidates,
  findLeftovers,
  findPathHolder,
  leftoversMessage,
  resolveLeftover,
} from './crash-leftovers';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';

import type { NoteType } from './types';

// #region HELPERS

const TAG_OF: Record<NoteType, string> = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  card: CARD_TAG,
};
const TABLE_OF: Record<NoteType, string> = {
  article: 'article',
  snippet: 'snippet',
  card: 'srs_card',
};

/**
 * Where a note may be: the data folder, each type's folder in it, a folder
 * nested in one of those, a folder named like either but beside it or outside
 * the data folder, and the vault's root.
 */
const FOLDERS = [
  `${DATA_DIRECTORY}/`,
  ...(['article', 'snippet', 'card'] as const).map(
    (type) => `${Obsidian.getDirectory(type)}/`
  ),
  `${Obsidian.getDirectory('article')}/nested/`,
  `${Obsidian.getDirectory('snippet')}-old/`,
  `${DATA_DIRECTORY}-old/`,
  `${DATA_DIRECTORY}-old/cards/`,
  'cards/',
  '',
];

/**
 * The type a note in each of {@link FOLDERS} was made as, by the folder it is
 * in, spelled out; any other folder names none.
 */
const FOLDER_TYPES: ReadonlyMap<string, NoteType> = new Map<string, NoteType>([
  [`${Obsidian.getDirectory('article')}/`, 'article'],
  [`${Obsidian.getDirectory('snippet')}/`, 'snippet'],
  [`${Obsidian.getDirectory('card')}/`, 'card'],
  [`${Obsidian.getDirectory('article')}/nested/`, 'article'],
]);

/** The type a note in `folder` was made as, by the folder it is in. */
const typeOfFolder = (folder: string): NoteType | null =>
  FOLDER_TYPES.get(folder) ?? null;

/** A note in the vault, an item's or not, with a row behind it or not. */
const noteArb = fc.record({
  type: fc.constantFrom<NoteType | null>('article', 'snippet', 'card', null),
  id: fc.option(
    fc.oneof(
      fc.uuid(),
      fc.string(),
      fc.integer(),
      fc.double(),
      fc.boolean(),
      fc.array(fc.string(), { maxLength: 2 })
    ),
    { nil: undefined }
  ),
  hasRow: fc.boolean(),
  /** The table holding the row: any, as an id is held wherever it is. */
  rowType: fc.constantFrom<NoteType>('article', 'snippet', 'card'),
  deletedRow: fc.boolean(),
  /** Deleted for good: a tombstone, which holds the id for no reader. */
  purgedRow: fc.boolean(),
  folder: fc.constantFrom(...FOLDERS),
  tagsAsString: fc.boolean(),
  /** Another item type's tag too, which `typeOfTags` ranks against it. */
  secondTag: fc.option(
    fc.constantFrom<NoteType>('article', 'snippet', 'card'),
    {
      nil: null,
    }
  ),
});
type NoteCase = typeof noteArb extends fc.Arbitrary<infer T> ? T : never;

const pathOf = (note: NoteCase, i: number) => `${note.folder}notes/n${i}.md`;

/** The type a note's tags name, as `typeOfTags` ranks them. */
const typeOf = (note: NoteCase): NoteType | null =>
  note.type && Obsidian.typeOfTags(tagsOf(note));

function tagsOf(note: NoteCase): string | string[] | undefined {
  if (!note.type) return undefined;
  if (note.tagsAsString) return TAG_OF[note.type];
  return [
    'other',
    TAG_OF[note.type],
    ...(note.secondTag ? [TAG_OF[note.secondTag]] : []),
  ];
}

/** Insert a row of `type`'s table with `id` at `reference`. */
function insertRow(
  repo: TestRepository,
  type: NoteType,
  id: string,
  reference: string,
  deleted = false
) {
  if (type === 'card') {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, deleted) VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $3)`,
      [id, reference, Number(deleted)]
    );
  } else {
    repo.mutate(
      `INSERT INTO ${type} (id, reference, due, interval, priority, deleted) VALUES ($1, $2, 0, 1, 30, $3)`,
      [id, reference, Number(deleted)]
    );
  }
}

/**
 * One database for every case of a property, emptied by {@link wireNotes}:
 * starting sql.js afresh for each case would take most of the test's time.
 */
let sharedRepo: TestRepository;

/** Empty every item table of {@link sharedRepo}. */
function resetSharedRepo(): TestRepository {
  for (const table of Object.values(TABLE_OF)) {
    sharedRepo.hardDelete(`DELETE FROM ${table}`);
  }
  return sharedRepo;
}

/** A vault and database holding `notes`, and managers over them. */
async function wireNotes(notes: NoteCase[]) {
  const vault = makeItemVault(
    Object.fromEntries(
      notes.map((note, i) => [
        pathOf(note, i),
        {
          ...(note.id === undefined ? {} : { 'ir-id': note.id }),
          ...(note.type ? { tags: tagsOf(note) } : {}),
        },
      ])
    )
  );
  const repo = resetSharedRepo();
  const inserted = new Set<string>();
  for (const [i, note] of notes.entries()) {
    if (note.hasRow && typeof note.id === 'string' && !inserted.has(note.id)) {
      // Under another path, and maybe another table: the row holds the id
      // wherever its note is
      insertRow(
        repo,
        note.rowType,
        note.id,
        `elsewhere/${i}.md`,
        note.deletedRow
      );
      if (note.purgedRow) {
        const table = note.rowType === 'card' ? 'srs_card' : note.rowType;
        for (const { query, params } of tombstoneRowStatements(
          table,
          note.id
        )) {
          repo.mutate(query, params);
        }
      }
      inserted.add(note.id);
    }
  }
  const plugin = { app: vault.app, settings: {} } as never;
  const managers = {
    articles: new ArticleManager(plugin, repo),
    snippets: new SnippetManager(plugin, repo),
    cards: new CardManager(plugin, repo),
  };
  vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const deps = { app: vault.app as never, repo, ...managers };
  return { vault, repo, managers, deps };
}

/**
 * One leftover note at `path`, holding `id`, and tagged as `type`, or, with
 * `null`, tagged with no item type at all; or with `tags` as given.
 */
async function wireLeftover(
  type: NoteType | null,
  path: string,
  id = 'left-1',
  { tags = type ? ['other', TAG_OF[type]] : ['other'] }: { tags?: unknown } = {}
) {
  const vault = makeItemVault({
    [path]: { 'ir-id': id, tags, title: 'kept' },
  });
  const repo = await TestRepository.create();
  const plugin = { app: vault.app, settings: {} } as never;
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const deps = {
    app: vault.app as never,
    repo,
    articles: new ArticleManager(plugin, repo),
    snippets: new SnippetManager(plugin, repo),
    cards: new CardManager(plugin, repo),
  };
  const [leftover] = await findLeftovers(deps);
  return { vault, repo, deps, leftover, notify };
}

const typeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

/** The id of the row holding a leftover's path, in the conflict tests. */
const HOLDER_ID = 'held-1234-abcd-0000';

/** The item tables, each type's. */
const ITEM_TABLE_OF = {
  article: 'article',
  snippet: 'snippet',
  card: 'srs_card',
} as const;

/** A review of the `kind` item `itemId` at `time`, undone or not. */
function insertReview(
  repo: TestRepository,
  kind: NoteType,
  itemId: string,
  time: number,
  deleted = false
) {
  const id = crypto.randomUUID();
  if (kind === 'card') {
    repo.mutate(
      `INSERT INTO srs_card_review (id, card_id, due, review, stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, rating, state, deleted) VALUES ($1, $2, 0, $3, 0, 0, 0, 0, 0, 3, 0, $4)`,
      [id, itemId, time, Number(deleted)]
    );
    return;
  }
  const [log, column] = REVIEW_LOG_OF[ITEM_TABLE_OF[kind]];
  repo.mutate(
    `INSERT INTO ${log} (id, ${column}, review_time, deleted) VALUES ($1, $2, $3, $4)`,
    [id, itemId, time, Number(deleted)]
  );
}

/** Every row of every item table and review log, as readers see them. */
function itemRows(repo: TestRepository) {
  return Object.fromEntries(
    Object.values(ITEM_TABLE_OF).flatMap((table) => [
      [table, repo.rows(table)],
      [REVIEW_LOG_OF[table][0], repo.rows(REVIEW_LOG_OF[table][0])],
    ])
  );
}

/** Where a leftover may be: the plugin's data folder, or the user's own. */
const leftoverPathArb = fc.constantFrom(
  `${DATA_DIRECTORY}/x/a.md`,
  'notes/a.md'
);

/** A leftover's tags: any item types', or none, beside one of the user's. */
const leftoverTagsArb = fc
  .subarray([ARTICLE_TAG, SNIPPET_TAG, CARD_TAG, 'other'])
  .chain((tags) => fc.shuffledSubarray(tags, { minLength: tags.length }));

/**
 * A leftover note at `path` holding `left-1`, tagged `tags`, and a `kind` row
 * `HOLDER_ID` holding its path, deleted or not, reviewed once, with managers
 * that can erase rows for good, and a conflicts hook whose `ask` does
 * `meanwhile` and then answers `choice`.
 */
async function wireConflict({
  path,
  tags,
  kind,
  deleted,
  choice,
  meanwhile = () => {},
}: {
  path: string;
  tags: unknown;
  kind: NoteType;
  deleted: boolean;
  choice: HeldChoice;
  meanwhile?: (wired: { repo: TestRepository }) => unknown;
}) {
  const vault = makeItemVault({
    [path]: { 'ir-id': 'left-1', tags, title: 'kept' },
  });
  const repo = await TestRepository.create();
  insertRow(repo, kind, HOLDER_ID, path, deleted);
  insertReview(repo, kind, HOLDER_ID, 1_000);
  const trigger = vi.fn();
  const plugin: Record<string, unknown> = {
    app: { ...vault.app, workspace: { trigger } },
    settings: {},
  };
  const reviewManager = new ReviewManager(plugin as never, repo);
  plugin.reviewManager = reviewManager;
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  vi.spyOn(console, 'warn').mockReturnValue(undefined);
  const ask = vi.fn(async (_file: unknown, _holder: PathHolder) => {
    await meanwhile({ repo });
    return choice;
  });
  const purge = vi.spyOn(reviewManager, 'deleteRow');
  const deps = {
    app: vault.app as never,
    repo,
    articles: reviewManager.articles,
    snippets: reviewManager.snippets,
    cards: reviewManager.cards,
    conflicts: {
      ask,
      purge: (table: 'article' | 'snippet' | 'srs_card', id: string) =>
        reviewManager.deleteRow(table, id),
    },
  };
  const [leftover] = await findLeftovers(deps);
  return { vault, repo, deps, leftover, notify, ask, purge, reviewManager };
}

/** The tags `tags` read as, by the entries they hold. */
const entriesOf = (tags: unknown): unknown[] =>
  tags === undefined ? [] : Array.isArray(tags) ? tags : [tags];

/** The tags `tags` hold once `kind`'s tag is in, in place of other types'. */
function retagged(tags: unknown, kind: NoteType): unknown[] {
  const tag = TAG_OF[kind];
  const others = Object.values(TAG_OF).filter((t) => t !== tag);
  const kept = entriesOf(tags).filter(
    (entry) => !others.includes(entry as string)
  );
  return kept.includes(tag) ? kept : [...kept, tag];
}

/** A row in a {@link worldArb} world. */
interface WorldRow {
  kind: NoteType;
  id: string;
  path: string;
  state: 'live' | 'deleted' | 'purged';
}

/** The ids and paths a {@link worldArb} world is made of. */
const WORLD_IDS = ['a', 'b'] as const;
const WORLD_PATHS = [
  'notes/p.md',
  'notes/q.md',
  `${DATA_DIRECTORY}/x/r.md`,
] as const;

/**
 * Notes at some of a few paths, each holding one of a few ids, tagged any
 * way, and rows of any table holding those ids or another, at those paths or
 * another, live, deleted or deleted for good: one row per id and per path
 * in each table, as `id` and `reference` are unique in each.
 */
const worldArb = fc.record({
  notes: fc.uniqueArray(
    fc.record({
      path: fc.constantFrom(...WORLD_PATHS),
      id: fc.constantFrom(...WORLD_IDS),
      tags: leftoverTagsArb,
    }),
    { maxLength: 3, selector: ({ path }) => path }
  ),
  rows: fc
    .array(
      fc.record<WorldRow>({
        kind: typeArb,
        id: fc.constantFrom(...WORLD_IDS, 'c'),
        path: fc.constantFrom(...WORLD_PATHS, 'gone/s.md'),
        state: fc.constantFrom('live', 'deleted', 'purged'),
      }),
      { maxLength: 4 }
    )
    .map((rows) =>
      rows.filter(
        (row, i) =>
          !rows
            .slice(0, i)
            .some(
              (other) =>
                other.kind === row.kind &&
                (other.id === row.id || other.path === row.path)
            )
      )
    ),
});
type World = typeof worldArb extends fc.Arbitrary<infer T> ? T : never;

/** A vault and {@link sharedRepo} holding `world`, and managers over them. */
function wireWorld(world: World) {
  const vault = makeItemVault(
    Object.fromEntries(
      world.notes.map(({ path, id, tags }) => [path, { 'ir-id': id, tags }])
    )
  );
  const repo = resetSharedRepo();
  for (const row of world.rows) {
    insertRow(repo, row.kind, row.id, row.path, row.state !== 'live');
    if (row.state !== 'purged') continue;
    for (const { query, params } of tombstoneRowStatements(
      ITEM_TABLE_OF[row.kind],
      row.id
    )) {
      repo.mutate(query, params);
    }
  }
  const plugin = { app: vault.app, settings: {} } as never;
  const deps = {
    app: vault.app as never,
    repo,
    articles: new ArticleManager(plugin, repo),
    snippets: new SnippetManager(plugin, repo),
    cards: new CardManager(plugin, repo),
  };
  return { vault, repo, deps };
}

const KIND_RANK: readonly NoteType[] = ['article', 'snippet', 'card'];
const byRank = (a: WorldRow, b: WorldRow) =>
  KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind);

/** The parts of a plan the world tests check, as {@link expectedPlan} gives them. */
function project(plan: Plan) {
  const { target, evicts, erase, refused, purged } = plan;
  return {
    target: target && {
      by: target.by,
      kind: target.row.kind,
      id: target.row.id,
      deleted: target.row.deleted,
      reference: target.by === 'id' ? target.row.reference : null,
    },
    evicts: evicts && { kind: evicts.kind, id: evicts.id },
    erase,
    refused: refused.map(({ row, why }) => ({
      kind: row.kind,
      id: row.id,
      why,
    })),
    purged: purged && { kind: purged.kind, id: purged.id },
  };
}

/**
 * What a note at `path` holding `id` may be re-associated with in `world`,
 * spelled out: the rows holding its id, first, each unless a note at its
 * reference holds that id too (a copy's original) or, for one elsewhere, a
 * live row of any table holds the note's path; else the row at its path,
 * a live one before any deleted one there. A deleted row at the path gives
 * way to one coming from elsewhere. Erasing is offered for a row at the path
 * only while no row not deleted for good holds the id. The first row deleted
 * for good holding it, if any, is told apart.
 */
function expectedPlan(world: World, path: string, id: string) {
  const kept = world.rows.filter((row) => row.state !== 'purged');
  const byId = kept.filter((row) => row.id === id).sort(byRank);
  const atPath = kept
    .filter((row) => row.path === path && row.id !== id)
    .sort(byRank);
  const holder =
    atPath.find((row) => row.state === 'live') ?? atPath[0] ?? null;
  const noteAt = (at: string) => world.notes.find((note) => note.path === at);
  let target: ReturnType<typeof project>['target'] = null;
  const refused: ReturnType<typeof project>['refused'] = [];
  for (const row of byId) {
    const moving = row.path !== path;
    const why =
      moving && noteAt(row.path)?.id === id
        ? 'copy'
        : moving && holder?.state === 'live'
          ? 'held'
          : null;
    if (why) refused.push({ kind: row.kind, id: row.id, why });
    else {
      target ??= {
        by: 'id',
        kind: row.kind,
        id: row.id,
        deleted: row.state !== 'live',
        reference: row.path,
      };
    }
  }
  if (!target && holder) {
    target = {
      by: 'path',
      kind: holder.kind,
      id: holder.id,
      deleted: holder.state !== 'live',
      reference: null,
    };
  }
  const evicts =
    target?.by === 'id' && target.reference !== path && holder
      ? holder.state === 'deleted'
        ? { kind: holder.kind, id: holder.id }
        : null
      : null;
  const [gone = null] = world.rows
    .filter((row) => row.state === 'purged' && row.id === id)
    .sort(byRank);
  return {
    target,
    evicts,
    erase: byId.length === 0 && holder !== null,
    refused,
    purged: gone && { kind: gone.kind, id: gone.id },
  };
}

/** The id a moved note holds, in the re-association tests. */
const MOVED_ID = 'moved-5678-efgh-0000';
/** When the moved note's row is due. */
const MOVED_DUE = 1_700_000_000_000;

/**
 * A note at `at` holding {@link MOVED_ID}, tagged `tags`, whose `kind` row
 * still points at `from`, deleted, as the plugin deletes the row of a note
 * moved where it saw only a delete and a create, unless `live`; due
 * {@link MOVED_DUE} and reviewed once. With `original`, a note at `from`
 * holds the id too; with `pathRow`, a row {@link HOLDER_ID} of its kind
 * holds `at`, deleted or not. Managers over them can erase rows for good,
 * and a conflicts hook's `ask` does `meanwhile` and then answers `choice`.
 */
async function wireMoved({
  kind,
  at = 'notes/new.md',
  from = 'notes/old.md',
  tags = ['other'],
  live = false,
  original = false,
  pathRow = null,
  choice,
  meanwhile = () => {},
}: {
  kind: NoteType;
  at?: string;
  from?: string;
  tags?: unknown;
  live?: boolean;
  original?: boolean;
  pathRow?: { kind: NoteType; deleted: boolean } | null;
  choice: HeldChoice;
  meanwhile?: (wired: { repo: TestRepository }) => unknown;
}) {
  const vault = makeItemVault({
    [at]: { 'ir-id': MOVED_ID, tags, title: 'kept' },
    ...(original ? { [from]: { 'ir-id': MOVED_ID } } : {}),
  });
  const repo = await TestRepository.create();
  const table = ITEM_TABLE_OF[kind];
  insertRow(repo, kind, MOVED_ID, from, !live);
  repo.mutate(`UPDATE ${table} SET due = $1 WHERE id = $2`, [
    MOVED_DUE,
    MOVED_ID,
  ]);
  insertReview(repo, kind, MOVED_ID, 1_000);
  if (pathRow) insertRow(repo, pathRow.kind, HOLDER_ID, at, pathRow.deleted);
  const trigger = vi.fn();
  const plugin: Record<string, unknown> = {
    app: { ...vault.app, workspace: { trigger } },
    settings: {},
  };
  const reviewManager = new ReviewManager(plugin as never, repo);
  plugin.reviewManager = reviewManager;
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  vi.spyOn(console, 'warn').mockReturnValue(undefined);
  const ask = vi.fn(
    async (_file: unknown, _holder: PathHolder, _plan?: Plan) => {
      await meanwhile({ repo });
      return choice;
    }
  );
  const purge = vi.spyOn(reviewManager, 'deleteRow');
  const deps = {
    app: vault.app as never,
    repo,
    articles: reviewManager.articles,
    snippets: reviewManager.snippets,
    cards: reviewManager.cards,
    conflicts: {
      ask,
      purge: (t: 'article' | 'snippet' | 'srs_card', id: string) =>
        reviewManager.deleteRow(t, id),
    },
  };
  const leftover = (await findLeftovers(deps)).find(
    ({ file }) => file.path === at
  )!;
  return { vault, repo, deps, leftover, notify, ask, purge, table };
}

/** The id a note holds whose row was deleted for good, in the import-fresh tests. */
const PURGED_ID = 'purged-9abc-ijkl-0000';

/**
 * A note at `path` holding {@link PURGED_ID}, tagged `tags`, whose `kind` row
 * was reviewed once and then deleted for good, as `ReviewManager.deleteRow`
 * deletes one; with `pathRow`, a row {@link HOLDER_ID} holds `path`, deleted
 * or not. Managers over them can erase rows for good, and a conflicts hook's
 * `askFresh` does `meanwhile` and then answers `fresh`, while its `ask`
 * answers `choice`.
 */
async function wirePurged({
  kind,
  path = 'notes/a.md',
  tags = ['other'],
  pathRow = null,
  fresh = true,
  choice = null,
  meanwhile = () => {},
}: {
  kind: NoteType;
  path?: string;
  tags?: unknown;
  pathRow?: { kind: NoteType; deleted: boolean } | null;
  fresh?: boolean;
  choice?: HeldChoice;
  meanwhile?: (wired: {
    repo: TestRepository;
    vault: ReturnType<typeof makeItemVault>;
  }) => unknown;
}) {
  const vault = makeItemVault({
    [path]: { 'ir-id': PURGED_ID, tags, title: 'kept' },
  });
  const repo = await TestRepository.create();
  const table = ITEM_TABLE_OF[kind];
  insertRow(repo, kind, PURGED_ID, 'gone.md');
  insertReview(repo, kind, PURGED_ID, 1_000);
  for (const { query, params } of deleteRowStatements(table, PURGED_ID)) {
    repo.mutate(query, params);
  }
  if (pathRow) insertRow(repo, pathRow.kind, HOLDER_ID, path, pathRow.deleted);
  const trigger = vi.fn();
  const plugin: Record<string, unknown> = {
    app: { ...vault.app, workspace: { trigger } },
    settings: {},
  };
  const reviewManager = new ReviewManager(plugin as never, repo);
  plugin.reviewManager = reviewManager;
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  vi.spyOn(console, 'warn').mockReturnValue(undefined);
  const ask = vi.fn(
    async (_file: unknown, _holder: PathHolder, _plan?: Plan) => choice
  );
  const askFresh = vi.fn(
    async (_file: unknown, _row: PurgedRow, _as: NoteType) => {
      await meanwhile({ repo, vault });
      return fresh;
    }
  );
  const purge = vi.spyOn(reviewManager, 'deleteRow');
  const deps = {
    app: vault.app as never,
    repo,
    articles: reviewManager.articles,
    snippets: reviewManager.snippets,
    cards: reviewManager.cards,
    conflicts: {
      ask,
      askFresh,
      purge: (t: 'article' | 'snippet' | 'srs_card', id: string) =>
        reviewManager.deleteRow(t, id),
    },
  };
  const [leftover] = await findLeftovers(deps);
  const [stored] = repo.storedRows(table, ` WHERE id = '${PURGED_ID}'`);
  /** The row deleted for good, as the user is told of it. */
  const gone: PurgedRow = {
    kind,
    id: PURGED_ID,
    erasedAt: stored.updated_at as number,
    erasedBy: stored.updated_by as string,
  };
  return { vault, repo, deps, leftover, notify, ask, askFresh, purge, gone };
}

/** Every stored row of every item table and review log, deleted or not. */
function storedItemRows(repo: TestRepository) {
  return Object.fromEntries(
    Object.values(ITEM_TABLE_OF).flatMap((table) => [
      [table, repo.storedRows(table)],
      [REVIEW_LOG_OF[table][0], repo.storedRows(REVIEW_LOG_OF[table][0])],
    ])
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// #endregion

beforeAll(async () => {
  sharedRepo = await TestRepository.create();
});

describe('findLeftovers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds every note whose ir-id no live row holds, tagged as an item or not, and no other', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(noteArb, { maxLength: 8 }), async (notes) => {
        vi.restoreAllMocks();
        const { deps } = await wireNotes(notes);

        const found = await findLeftovers(deps);

        // The first note with an id is the one whose row says if it's held
        const held = new Set<string>();
        const seen = new Set<string>();
        for (const note of notes) {
          if (!note.hasRow || typeof note.id !== 'string') continue;
          if (seen.has(note.id)) continue;
          seen.add(note.id);
          if (!note.purgedRow && !note.deletedRow) held.add(note.id);
        }
        const expected = notes.flatMap((note, i) =>
          typeof note.id === 'string' && !held.has(note.id)
            ? [{ path: pathOf(note, i), id: note.id }]
            : []
        );
        expect(found.map(({ file, id }) => ({ path: file.path, id }))).toEqual(
          expected
        );
      }),
      { numRuns: 60 }
    );
  });

  it("types a leftover by its tag, else by the data folder's subfolder it was made in, else not at all", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(noteArb, { maxLength: 8 }), async (notes) => {
        vi.restoreAllMocks();
        const rowless = notes.map((note) => ({ ...note, hasRow: false }));
        const { deps } = await wireNotes(rowless);

        const found = await findLeftovers(deps);

        const expected = rowless.flatMap((note) =>
          typeof note.id === 'string'
            ? [typeOf(note) ?? typeOfFolder(note.folder)]
            : []
        );
        expect(found.map(({ type }) => type)).toEqual(expected);
      }),
      { numRuns: 60 }
    );
  });

  it('asks about more ids than one query can hold', async () => {
    const notes = Array.from(
      { length: MAX_SQL_QUERY_PARAMS + 3 },
      (): NoteCase => ({
        type: 'snippet',
        id: undefined,
        hasRow: false,
        deletedRow: false,
        purgedRow: false,
        folder: `${DATA_DIRECTORY}/`,
        tagsAsString: false,
        secondTag: null,
        rowType: 'snippet',
      })
    ).map((note, i) => ({ ...note, id: `id-${i}`, hasRow: i % 2 === 0 }));
    const { deps } = await wireNotes(notes);

    const found = await findLeftovers(deps);

    expect(found).toHaveLength(Math.floor(notes.length / 2));
  });

  it('keeps each query within the parameter limit, however many notes claim ids', async () => {
    const notes = Array.from(
      { length: MAX_SQL_QUERY_PARAMS + 3 },
      (_, i): NoteCase => ({
        type: 'snippet',
        id: `id-${i}`,
        hasRow: i % 2 === 0,
        deletedRow: false,
        purgedRow: false,
        folder: `${DATA_DIRECTORY}/`,
        tagsAsString: false,
        secondTag: null,
        rowType: 'snippet',
      })
    );
    const { deps } = await wireNotes(notes);
    const query = vi.spyOn(deps.repo, 'query');

    await findLeftovers(deps);

    const counts = query.mock.calls.map(([, params]) => params?.length ?? 0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_SQL_QUERY_PARAMS);
  });

  // Every type, or none, in every folder: few enough to try them all
  it.each(
    (['article', 'snippet', 'card', null] as const).flatMap((type) =>
      FOLDERS.map((folder) => ({ type, folder }))
    )
  )(
    "calls a $type leftover in '$folder' the plugin's own only if it is in the data folder, or is a tagged snippet or card, and types it by its tag, else by its folder there",
    async ({ type, folder }) => {
      const { deps } = await wireNotes([
        {
          type,
          id: 'left-1',
          hasRow: false,
          rowType: 'article',
          deletedRow: false,
          purgedRow: false,
          folder,
          tagsAsString: false,
          secondTag: null,
        },
      ]);

      const [leftover] = await findLeftovers(deps);

      const inDataFolder = folder.startsWith(`${DATA_DIRECTORY}/`);
      expect(leftover.kind).toBe(
        inDataFolder || type === 'snippet' || type === 'card'
          ? 'made'
          : 'in-place'
      );
      expect(leftover.type).toBe(type ?? typeOfFolder(folder));
    }
  );
});

describe('actionsFor', () => {
  it.each([
    { type: 'article', kind: 'made', actions: ['adopt', 'trash'] },
    { type: 'article', kind: 'in-place', actions: ['adopt', 'strip'] },
    { type: 'snippet', kind: 'made', actions: ['adopt', 'trash'] },
    { type: 'card', kind: 'in-place', actions: ['adopt', 'strip'] },
    // No type of its own, but the user picks one to save it as; one the
    // plugin made can still be kept as a plain note too
    { type: null, kind: 'made', actions: ['adopt', 'strip', 'trash'] },
    { type: null, kind: 'in-place', actions: ['adopt', 'strip'] },
  ] as const)(
    'offers $actions for a $kind leftover of type $type',
    ({ type, kind, actions }) => {
      const leftover = { file: {}, id: 'x', type, kind } as Leftover;

      expect(actionsFor(leftover)).toEqual(actions);
    }
  );
});

describe('leftoversMessage', () => {
  it('counts the leftover notes, without naming any', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 50 }),
        (names) => {
          const leftovers = names.map(
            (basename) => ({ file: { basename } }) as unknown as Leftover
          );

          expect(leftoversMessage(leftovers)).toBe(
            `Incremental reading: ${names.length} notes were not found in the database.`
          );
        }
      )
    );
  });

  it('speaks of a lone leftover in the singular', () => {
    const leftovers = [{ file: { basename: 'a' } }] as unknown as Leftover[];

    expect(leftoversMessage(leftovers)).toBe(
      'Incremental reading: 1 note was not found in the database.'
    );
  });
});

describe('failureOf', () => {
  it('says what was thrown by its first line with any text, whatever was thrown', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('', ' ', '\t'), { maxLength: 3 }),
        fc
          .string({ minLength: 1 })
          .filter((s) => s.trim() !== '' && !s.includes('\n')),
        fc.array(fc.string(), { maxLength: 3 }),
        fc.boolean(),
        (blanks, line, rest, asError) => {
          const message = [...blanks, line, ...rest].join('\n');
          const failure = failureOf(asError ? new Error(message) : message);

          expect(failureDetail(failure)).toBe(line.trim());
        }
      )
    );
  });

  it('says what was thrown with no message by its kind, never by nothing', () => {
    for (const thrown of [new Error(''), new TypeError('\n ')]) {
      expect(failureDetail(failureOf(thrown))).toBe(thrown.name);
    }
  });
});

describe('resolveLeftover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adopts a leftover as a new item with its id, at its path', async () => {
    await fc.assert(
      fc.asyncProperty(typeArb, async (type) => {
        vi.restoreAllMocks();
        const path = `${DATA_DIRECTORY}/x/a.md`;
        const { vault, repo, deps, leftover } = await wireLeftover(type, path);

        expect(await resolveLeftover(deps, leftover, 'adopt')).toEqual({
          done: true,
        });

        const rows = repo.rows(TABLE_OF[type]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'left-1', reference: path });
        expect(await findLeftovers(deps)).toEqual([]);
        expect(vault.frontmatterOf(path)).toEqual({
          'ir-id': 'left-1',
          tags: ['other', TAG_OF[type]],
          title: 'kept',
        });
      }),
      { numRuns: 6 }
    );
  });

  it('records on the adopted row the fingerprint its tag left the note with, tagged as another type or untagged', async () => {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        fc.constantFrom<NoteType | null>(null, 'article', 'snippet', 'card'),
        async (type, taggedAs) => {
          vi.restoreAllMocks();
          const path = `${DATA_DIRECTORY}/x/a.md`;
          const { vault, repo, deps, leftover } = await wireLeftover(
            taggedAs,
            path
          );
          const file = vault.files.get(path)!;
          const untouched = file.stat.mtime;

          await resolveLeftover(deps, leftover, 'adopt', type);

          const [row] = repo.storedRows(TABLE_OF[type]);
          expect(row.note_mtime).toBe(file.stat.mtime);
          // Only a note that needed the tag was written
          expect(file.stat.mtime > untouched).toBe(taggedAs !== type);
        }
      ),
      { numRuns: 16 }
    );
  });

  it('adopts a snippet or card as a child of the item its source links to', async () => {
    for (const type of ['snippet', 'card'] as const) {
      vi.restoreAllMocks();
      const path = `${DATA_DIRECTORY}/x/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(type, path);
      vault.add('notes/parent.md', {
        'ir-id': 'parent-1',
        tags: [ARTICLE_TAG],
      });
      insertRow(repo, 'article', 'parent-1', 'notes/parent.md');
      vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(
        vault.files.get('notes/parent.md')!
      );

      await resolveLeftover(deps, leftover, 'adopt');

      expect(repo.rows(TABLE_OF[type])[0].parent).toBe('parent-1');
    }
  });

  it('trashes a leftover the plugin made, leaving no row', async () => {
    const { vault, repo, deps, leftover } = await wireLeftover(
      'snippet',
      `${DATA_DIRECTORY}/x/a.md`
    );

    expect(await resolveLeftover(deps, leftover, 'trash')).toEqual({
      done: true,
    });

    expect(vault.trashed).toEqual([`${DATA_DIRECTORY}/x/a.md`]);
    expect(repo.rows('snippet')).toEqual([]);
  });

  it("strips the plugin's ir-id and type tag from an imported note, leaving the rest", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 3 }),
        fc.dictionary(
          fc.string().filter((k) => k !== 'ir-id' && k !== 'tags'),
          fc.string(),
          { maxKeys: 3 }
        ),
        fc.boolean(),
        async (otherTags, properties, asString) => {
          vi.restoreAllMocks();
          const path = 'notes/a.md';
          const tags = asString
            ? ARTICLE_TAG
            : [...otherTags.filter((t) => t !== ARTICLE_TAG), ARTICLE_TAG];
          const vault = makeItemVault({
            [path]: { ...properties, 'ir-id': 'left-1', tags },
          });
          const repo = await TestRepository.create();
          const plugin = { app: vault.app, settings: {} } as never;
          const deps = {
            app: vault.app as never,
            repo,
            articles: new ArticleManager(plugin, repo),
            snippets: new SnippetManager(plugin, repo),
            cards: new CardManager(plugin, repo),
          };
          const [leftover] = await findLeftovers(deps);

          expect(await resolveLeftover(deps, leftover, 'strip')).toEqual({
            done: true,
          });

          const kept = asString ? [] : tags.slice(0, -1);
          expect(vault.frontmatterOf(path)).toEqual({
            ...properties,
            ...(kept.length > 0 ? { tags: kept } : {}),
          });
          expect(await findLeftovers(deps)).toEqual([]);
        }
      ),
      { numRuns: 40 }
    );
  });

  // Without its tag the note wouldn't read as an item (`getNoteType`)
  it('adopts a leftover with no type tag as the type of the folder it was made in, tagging it so', async () => {
    for (const type of ['article', 'snippet', 'card'] as const) {
      vi.restoreAllMocks();
      const path = `${Obsidian.getDirectory(type)}/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(null, path);

      expect(await resolveLeftover(deps, leftover, 'adopt')).toEqual({
        done: true,
      });

      expect(repo.rows(TABLE_OF[type])).toMatchObject([
        { id: 'left-1', reference: path },
      ]);
      expect(vault.frontmatterOf(path)).toEqual({
        'ir-id': 'left-1',
        tags: ['other', TAG_OF[type]],
        title: 'kept',
      });
    }
  });

  // A card needs more than a note to be one, so the modal offers only these
  it.each(
    (['article', 'snippet', 'card', 'cards folder'] as const).flatMap((from) =>
      (['article', 'snippet'] as const).map((as) => [from, as] as const)
    )
  )(
    'adopts a leftover typed as %s as the %s the user chose, its item tag replaced',
    async (from, as) => {
      const path =
        from === 'cards folder'
          ? `${Obsidian.getDirectory('card')}/a.md`
          : `${DATA_DIRECTORY}/x/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(
        from === 'cards folder' ? null : from,
        path
      );

      expect(await resolveLeftover(deps, leftover, 'adopt', as)).toEqual({
        done: true,
      });

      for (const type of Object.keys(TABLE_OF) as NoteType[]) {
        expect(repo.rows(TABLE_OF[type])).toMatchObject(
          type === as ? [{ id: 'left-1', reference: path }] : []
        );
      }
      expect(vault.frontmatterOf(path)).toEqual({
        'ir-id': 'left-1',
        tags: ['other', TAG_OF[as]],
        title: 'kept',
      });
    }
  );

  it.each<[string, unknown, NoteType, unknown]>([
    // Only the order would tell a rewrite apart
    ['already has', [ARTICLE_TAG, 'other'], 'article', null],
    [
      'has with another type',
      ['other', ARTICLE_TAG, SNIPPET_TAG],
      'snippet',
      ['other', SNIPPET_TAG],
    ],
    ["can't read as tags", 7, 'snippet', [7, SNIPPET_TAG]],
    [
      'has with another type, in a lone string,',
      `other ${CARD_TAG}`,
      'snippet',
      ['other', SNIPPET_TAG],
    ],
    ['has no tags, so lacks,', null, 'article', [ARTICLE_TAG]],
  ])(
    'tags a note adopted as a type whose tag it %s just as needed',
    async (_, tags, as, written) => {
      const path = `${Obsidian.getDirectory('snippet')}/a.md`;
      const { vault, deps, leftover } = await wireLeftover(
        null,
        path,
        'left-1',
        { tags }
      );
      const update = vi.spyOn(Obsidian, 'updateFrontMatter');

      expect(await resolveLeftover(deps, leftover, 'adopt', as)).toEqual({
        done: true,
      });

      expect(update).toHaveBeenCalledTimes(written === null ? 0 : 1);
      expect(vault.frontmatterOf(path)?.tags).toEqual(written ?? tags);
    }
  );

  it.each(['article', 'snippet'] as const)(
    'adopts a leftover of no known type as the %s the user chose, tagging it so',
    async (as) => {
      const path = 'notes/a.md';
      const { vault, repo, deps, leftover } = await wireLeftover(null, path);

      expect(await resolveLeftover(deps, leftover, 'adopt', as)).toEqual({
        done: true,
      });

      for (const type of Object.keys(TABLE_OF) as NoteType[]) {
        expect(repo.rows(TABLE_OF[type])).toMatchObject(
          type === as ? [{ id: 'left-1', reference: path }] : []
        );
      }
      expect(vault.frontmatterOf(path)).toEqual({
        'ir-id': 'left-1',
        tags: ['other', TAG_OF[as]],
        title: 'kept',
      });
    }
  );

  it('adopts nothing, and does nothing to the note, when its type is unknown and none is chosen', async () => {
    const path = 'notes/a.md';
    const { vault, repo, deps, leftover, notify } = await wireLeftover(
      null,
      path
    );

    expect(await resolveLeftover(deps, leftover, 'adopt')).toEqual({
      done: false,
    });

    for (const table of Object.values(TABLE_OF)) {
      expect(repo.rows(table)).toEqual([]);
    }
    expect(vault.frontmatterOf(path)?.['ir-id']).toBe('left-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('strips only the ir-id from a note with no type tag, leaving its tags as they were', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 3 })),
          { nil: undefined }
        ),
        fc.constantFrom(...FOLDERS),
        async (tags, folder) => {
          // Tags naming no item type, or the note would be typed by them
          fc.pre(Obsidian.typeOfTags(tags) === null);
          vi.restoreAllMocks();
          const path = `${folder}a.md`;
          const vault = makeItemVault({
            [path]: {
              'ir-id': 'left-1',
              ...(tags === undefined ? {} : { tags }),
            },
          });
          vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
          const deps = {
            app: vault.app as never,
            repo: resetSharedRepo(),
          } as never;
          const [leftover] = await findLeftovers(deps);

          expect(await resolveLeftover(deps, leftover, 'strip')).toEqual({
            done: true,
          });

          expect(vault.frontmatterOf(path)).toEqual(
            tags === undefined ? {} : { tags }
          );
        }
      ),
      { numRuns: 40 }
    );
  });

  it('trashes a leftover with no type tag that the plugin made', async () => {
    const path = `${DATA_DIRECTORY}/a.md`;
    const { vault, deps, leftover } = await wireLeftover(null, path);

    expect(await resolveLeftover(deps, leftover, 'trash')).toEqual({
      done: true,
    });

    expect(vault.trashed).toEqual([path]);
  });

  it('does nothing to a note that is no longer a leftover by the time it is resolved', async () => {
    for (const action of ['adopt', 'trash', 'strip'] as const) {
      vi.restoreAllMocks();
      const path = `${DATA_DIRECTORY}/x/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(
        'snippet',
        path
      );
      // A row for it arrived meanwhile, say with the database from Sync
      insertRow(repo, 'snippet', 'left-1', 'elsewhere.md');

      expect(await resolveLeftover(deps, leftover, action)).toEqual({
        done: false,
      });

      expect(vault.paths()).toEqual([path]);
      expect(vault.frontmatterOf(path)?.['ir-id']).toBe('left-1');
      expect(repo.rows('snippet')).toHaveLength(1);
    }
  });

  it('does nothing to a note deleted, or given another id, since it was found', async () => {
    for (const action of ['adopt', 'trash', 'strip'] as const) {
      for (const change of ['deleted', 'other id'] as const) {
        vi.restoreAllMocks();
        const path = `${DATA_DIRECTORY}/x/a.md`;
        const { vault, repo, deps, leftover } = await wireLeftover(
          'snippet',
          path
        );
        if (change === 'deleted') vault.files.delete(path);
        else {
          await vault.app.fileManager.processFrontMatter(
            leftover.file,
            (fm: Record<string, unknown>) => {
              fm['ir-id'] = 'other';
            }
          );
        }
        const paths = vault.paths();

        expect(await resolveLeftover(deps, leftover, action)).toEqual({
          done: false,
        });

        expect(vault.paths()).toEqual(paths);
        expect(vault.trashed).toEqual([]);
        expect(repo.rows('snippet')).toEqual([]);
      }
    }
  });

  it('does nothing, and says why, while writes are refused', async () => {
    const { vault, repo, deps, leftover, notify } = await wireLeftover(
      'snippet',
      `${DATA_DIRECTORY}/x/Quokka.md`
    );
    repo.refuseWrites(new Error('Saving is paused.'));

    expect(await resolveLeftover(deps, leftover, 'adopt')).toEqual({
      done: false,
    });

    expect(repo.rows('snippet')).toEqual([]);
    expect(vault.paths()).toHaveLength(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      kind: 'error',
    });
    const [message] = notify.mock.calls[0];
    expect(message).toContain('Quokka');
    expect(message).toContain('Saving is paused.');
  });

  it('names the note and why, and tells trashing apart from stripping, while writes are refused', async () => {
    const said: string[] = [];
    for (const action of ['trash', 'strip'] as const) {
      vi.restoreAllMocks();
      const { vault, deps, leftover, notify } = await wireLeftover(
        'article',
        'notes/Quokka.md'
      );
      deps.repo.refuseWrites(new Error('Saving is paused.'));

      expect(await resolveLeftover(deps, leftover, action)).toEqual({
        done: false,
      });

      expect(vault.trashed).toEqual([]);
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        kind: 'error',
      });
      const [message] = notify.mock.calls[0];
      expect(message).toContain('Quokka');
      expect(message).toContain('Saving is paused.');
      said.push(message);
    }
    expect(new Set(said).size).toBe(2);
  });

  it('says so when it fails', async () => {
    const { vault, deps, leftover, notify } = await wireLeftover(
      'snippet',
      `${DATA_DIRECTORY}/x/Quokka.md`
    );
    vault.fail('trash');

    expect(await resolveLeftover(deps, leftover, 'trash')).toMatchObject({
      done: false,
      failure: { reason: 'error' },
    });

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Quokka'),
      { kind: 'error' }
    );
  });

  it('adopts nothing, and writes nothing, when another row holds its path, deleted or not, and says which row', async () => {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        typeArb,
        fc.boolean(),
        fc.uuid(),
        fc.constantFrom<NoteType | null>(null, 'article', 'snippet', 'card'),
        async (as, kind, deleted, holderId, taggedAs) => {
          vi.restoreAllMocks();
          const path = `${DATA_DIRECTORY}/x/a.md`;
          const { vault, repo, deps, leftover, notify } = await wireLeftover(
            taggedAs,
            path
          );
          insertRow(repo, kind, holderId, path, deleted);
          const stored = repo.dump();
          const frontmatter = structuredClone(vault.frontmatterOf(path));
          // With its details, as findPathHolder reads them
          const holder = await findPathHolder(repo, path);
          expect(holder).toMatchObject({ kind, id: holderId, deleted });
          const mutate = vi.spyOn(repo, 'mutate');
          const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(outcome).toEqual({
            done: false,
            failure: { reason: 'held', holder },
          });
          expect(mutate).not.toHaveBeenCalled();
          expect(repo.dump()).toBe(stored);
          expect(vault.frontmatterOf(path)).toEqual(frontmatter);
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            expect.any(String),
            holder
          );
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(holderId.slice(0, 8)),
            { kind: 'error' }
          );
          const [message] = notify.mock.calls[0];
          expect(message).toContain(kind);
          expect(/deleted/.test(message)).toBe(deleted);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('adopts a leftover when other rows hold only other paths, one differing from its own only in case', async () => {
    for (const type of ['article', 'snippet', 'card'] as const) {
      vi.restoreAllMocks();
      const path = `${DATA_DIRECTORY}/x/a.md`;
      const { repo, deps, leftover } = await wireLeftover(type, path);
      insertRow(repo, type, 'other-1', path.toUpperCase(), true);
      insertRow(repo, type, 'other-2', `${path}.md`);

      expect(await resolveLeftover(deps, leftover, 'adopt')).toEqual({
        done: true,
      });

      expect(repo.rows(TABLE_OF[type])).toContainEqual(
        expect.objectContaining({ id: 'left-1', reference: path })
      );
    }
  });

  it('trashes or strips a leftover whose path another row holds, as neither adds a row', async () => {
    for (const action of ['trash', 'strip'] as const) {
      vi.restoreAllMocks();
      const path = `${DATA_DIRECTORY}/x/a.md`;
      const { repo, deps, leftover } = await wireLeftover('snippet', path);
      insertRow(repo, 'article', 'held-1', path, true);

      expect(await resolveLeftover(deps, leftover, action)).toEqual({
        done: true,
      });
    }
  });

  it('fails with what went wrong when adopting throws, and says it', async () => {
    for (const thrown of [new Error('Disk full\n  at write'), 'Disk full']) {
      vi.restoreAllMocks();
      const { deps, leftover, notify } = await wireLeftover(
        'article',
        'notes/Quokka.md'
      );
      vi.spyOn(deps.articles, 'adoptLeftover').mockRejectedValue(thrown);

      const outcome = await resolveLeftover(deps, leftover, 'adopt');

      expect(outcome).toEqual({
        done: false,
        failure: {
          reason: 'error',
          message: thrown instanceof Error ? thrown.message : thrown,
        },
      });
      const [message] = notify.mock.calls[0];
      expect(message).toContain('Quokka');
      expect(message).toContain('Disk full');
      expect(message).not.toContain('at write');
    }
  });
});

describe('findPathHolder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the row at a path with what the user is shown of it: due, dismissal, last review not undone, stamp, and the path of what it was taken from while its row has one', async () => {
    const parentArb = fc.option(
      fc.record({
        kind: fc.constantFrom<NoteType>('article', 'snippet'),
        state: fc.constantFrom('live', 'deleted', 'purged', 'absent'),
      }),
      { nil: null }
    );
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.integer({ min: 0, max: 8_640_000_000_000 }), {
          nil: null,
        }),
        fc.array(
          fc.record({
            time: fc.integer({ min: 0, max: 8_640_000_000_000 }),
            deleted: fc.boolean(),
          }),
          { maxLength: 4 }
        ),
        parentArb,
        async (kind, deleted, dismissed, due, reviews, parent) => {
          const repo = resetSharedRepo();
          for (const [log] of Object.values(REVIEW_LOG_OF)) {
            repo.hardDelete(`DELETE FROM ${log}`);
          }
          const path = 'notes/a.md';
          const table = ITEM_TABLE_OF[kind];
          // A row elsewhere, and one at a path only like it
          insertRow(repo, kind, 'decoy-1', `${path}.md`);
          insertRow(repo, kind, HOLDER_ID, path, deleted);
          // A card always has a due date; an item without one is dismissed
          const dueAt = kind === 'card' ? (due ?? 0) : due;
          const isDismissed = dismissed || dueAt === null;
          repo.mutate(
            `UPDATE ${table} SET due = $1, dismissed = $2 WHERE id = $3`,
            [dueAt, Number(isDismissed), HOLDER_ID]
          );
          let lastReview: number | null;
          if (kind === 'card') {
            lastReview = reviews.at(-1)?.time ?? null;
            repo.mutate(`UPDATE srs_card SET last_review = $1 WHERE id = $2`, [
              lastReview,
              HOLDER_ID,
            ]);
          } else {
            for (const review of reviews) {
              insertReview(repo, kind, HOLDER_ID, review.time, review.deleted);
            }
            const live = reviews.filter((review) => !review.deleted);
            lastReview =
              live.length > 0
                ? Math.max(...live.map((review) => review.time))
                : null;
            insertReview(repo, kind, 'decoy-1', 9_000_000_000_000);
          }
          let expectedParent: PathHolder['parent'] = null;
          if (parent && kind !== 'article') {
            const parentId = 'parent-1';
            if (parent.state !== 'absent') {
              insertRow(
                repo,
                parent.kind,
                parentId,
                'source.md',
                parent.state === 'deleted'
              );
              if (parent.state === 'purged') {
                for (const { query, params } of tombstoneRowStatements(
                  ITEM_TABLE_OF[parent.kind],
                  parentId
                )) {
                  repo.mutate(query, params);
                }
              }
            }
            repo.mutate(`UPDATE ${table} SET parent = $1 WHERE id = $2`, [
              parentId,
              HOLDER_ID,
            ]);
            expectedParent = {
              id: parentId,
              path:
                parent.state === 'live' || parent.state === 'deleted'
                  ? 'source.md'
                  : null,
            };
          }
          const [stored] = repo.storedRows(table, ` WHERE id = '${HOLDER_ID}'`);

          const holder = await findPathHolder(repo, path);

          expect(holder).toEqual({
            kind,
            id: HOLDER_ID,
            deleted,
            dismissed: isDismissed,
            due: dueAt,
            lastReview,
            updatedAt: stored.updated_at,
            updatedBy: stored.updated_by,
            parent: expectedParent,
          });
        }
      ),
      { numRuns: 40 }
    );
  });

  it('finds no row at a path only a row deleted for good held', async () => {
    const repo = resetSharedRepo();
    insertRow(repo, 'snippet', HOLDER_ID, 'notes/a.md');
    for (const { query, params } of tombstoneRowStatements(
      'snippet',
      HOLDER_ID
    )) {
      repo.mutate(query, params);
    }

    expect(await findPathHolder(repo, 'notes/a.md')).toBeNull();
  });
});

describe('resolveLeftover at a held path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks about the row holding its path, once, with its details, and with no answer writes nothing and says nothing, answering that the user backed out', async () => {
    await fc.assert(
      fc.asyncProperty(
        leftoverPathArb,
        leftoverTagsArb,
        typeArb,
        fc.boolean(),
        typeArb,
        async (path, tags, kind, deleted, as) => {
          vi.restoreAllMocks();
          const { vault, repo, deps, leftover, notify, ask, purge } =
            await wireConflict({ path, tags, kind, deleted, choice: null });
          const stored = repo.dump();
          const frontmatter = structuredClone(vault.frontmatterOf(path));
          const holder = await findPathHolder(repo, path);

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(ask).toHaveBeenCalledExactlyOnceWith(leftover.file, holder);
          expect(outcome).toEqual({ done: false, canceled: true });
          expect(repo.dump()).toBe(stored);
          expect(vault.frontmatterOf(path)).toEqual(frontmatter);
          expect(notify).not.toHaveBeenCalled();
          expect(purge).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 20 }
    );
  });

  it("re-associates the note with the row: the row's id and type tag in place of the leftover's id and other type tags, the row live with its schedule and history, nothing else changed", async () => {
    await fc.assert(
      fc.asyncProperty(
        leftoverPathArb,
        leftoverTagsArb,
        typeArb,
        fc.boolean(),
        typeArb,
        async (path, tags, kind, deleted, as) => {
          vi.restoreAllMocks();
          const { vault, repo, deps, leftover, ask, purge } =
            await wireConflict({
              path,
              tags,
              kind,
              deleted,
              choice: 'reassociate',
            });
          const table = ITEM_TABLE_OF[kind];
          const before = itemRows(repo);
          const file = leftover.file;
          const mtime = file.stat.mtime;

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(outcome).toEqual({ done: true });
          expect(ask).toHaveBeenCalledOnce();
          expect(purge).not.toHaveBeenCalled();
          const tag = TAG_OF[kind];
          const otherTypeTags = Object.values(TAG_OF).filter((t) => t !== tag);
          const kept = entriesOf(tags).filter(
            (entry) => !otherTypeTags.includes(entry as string)
          );
          expect(vault.frontmatterOf(path)).toEqual({
            'ir-id': HOLDER_ID,
            tags: kept.includes(tag) ? kept : [...kept, tag],
            title: 'kept',
          });
          // The row comes back, and nothing else in the database changes
          expect(itemRows(repo)).toEqual({
            ...before,
            [table]: before[table].map((row) =>
              row.id === HOLDER_ID ? { ...row, deleted: 0 } : row
            ),
          });
          expect(file.stat.mtime).toBeGreaterThan(mtime);
          const [stored] = repo.storedRows(table, ` WHERE id = '${HOLDER_ID}'`);
          expect(stored.note_mtime).toBe(file.stat.mtime);
        }
      ),
      { numRuns: 20 }
    );
  });

  it("erases the row for good, with its history, and saves the note as a new item of the type chosen under a fresh id written into it, never the note's own, which a row deleted for good may keep", async () => {
    await fc.assert(
      fc.asyncProperty(
        leftoverPathArb,
        leftoverTagsArb,
        typeArb,
        fc.boolean(),
        typeArb,
        fc.option(typeArb, { nil: undefined }),
        async (path, tags, kind, deleted, as, purgedType) => {
          vi.restoreAllMocks();
          const { vault, repo, deps, leftover, ask, purge } =
            await wireConflict({ path, tags, kind, deleted, choice: 'erase' });
          if (purgedType) {
            insertRow(repo, purgedType, 'left-1', 'gone.md');
            for (const { query, params } of tombstoneRowStatements(
              ITEM_TABLE_OF[purgedType],
              'left-1'
            )) {
              repo.mutate(query, params);
            }
          }

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(outcome).toEqual({ done: true });
          expect(ask).toHaveBeenCalledOnce();
          expect(purge).toHaveBeenCalledExactlyOnceWith(
            ITEM_TABLE_OF[kind],
            HOLDER_ID
          );
          const rows = itemRows(repo);
          for (const [table, held] of Object.entries(rows)) {
            expect(
              held.filter((row) =>
                [row.id, row.article_id, row.snippet_id, row.card_id].includes(
                  HOLDER_ID
                )
              ),
              table
            ).toEqual([]);
          }
          const atPath = rows[ITEM_TABLE_OF[as]].filter(
            (row) => row.reference === path
          );
          expect(atPath).toHaveLength(1);
          const [{ id }] = atPath;
          expect(id).not.toBe('left-1');
          expect(id).not.toBe(HOLDER_ID);
          const frontmatter = vault.frontmatterOf(path);
          expect(frontmatter?.['ir-id']).toBe(id);
          expect(Obsidian.typeOfTags(frontmatter?.tags)).toBe(as);
          expect(frontmatter?.title).toBe('kept');
        }
      ),
      { numRuns: 30 }
    );
  });

  it('writes nothing, and says so, when the row changed while the user was choosing', async () => {
    const changes: Record<
      string,
      (repo: TestRepository, kind: NoteType) => unknown
    > = {
      rescheduled: (repo, kind) =>
        repo.mutate(`UPDATE ${ITEM_TABLE_OF[kind]} SET due = 5 WHERE id = $1`, [
          HOLDER_ID,
        ]),
      reviewed: (repo, kind) =>
        kind === 'card'
          ? repo.mutate(
              `UPDATE srs_card SET last_review = 5000 WHERE id = $1`,
              [HOLDER_ID]
            )
          : insertReview(repo, kind, HOLDER_ID, 5_000),
      deletedOrBack: (repo, kind) =>
        repo.mutate(
          `UPDATE ${ITEM_TABLE_OF[kind]} SET deleted = 1 - deleted WHERE id = $1`,
          [HOLDER_ID]
        ),
      moved: (repo, kind) =>
        repo.mutate(
          `UPDATE ${ITEM_TABLE_OF[kind]} SET reference = 'elsewhere.md' WHERE id = $1`,
          [HOLDER_ID]
        ),
      replaced: (repo, kind) => {
        repo.mutate(
          `UPDATE ${ITEM_TABLE_OF[kind]} SET reference = 'elsewhere.md' WHERE id = $1`,
          [HOLDER_ID]
        );
        insertRow(repo, kind, 'other-holder', 'notes/a.md', true);
      },
    };
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...Object.keys(changes)),
        typeArb,
        fc.boolean(),
        fc.constantFrom<HeldChoice>('reassociate', 'erase'),
        typeArb,
        async (change, kind, deleted, choice, as) => {
          vi.restoreAllMocks();
          const path = 'notes/a.md';
          let changed = '';
          const { vault, repo, deps, leftover, notify, purge } =
            await wireConflict({
              path,
              tags: ['other'],
              kind,
              deleted,
              choice,
              meanwhile: ({ repo }) => {
                changes[change](repo, kind);
                changed = repo.dump();
              },
            });
          const frontmatter = structuredClone(vault.frontmatterOf(path));

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(repo.dump()).toBe(changed);
          expect(vault.frontmatterOf(path)).toEqual(frontmatter);
          expect(purge).not.toHaveBeenCalled();
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining('"a"'),
            { kind: 'error' }
          );
          // What holds the path now, if anything, is what it fails on
          const now = await findPathHolder(repo, path);
          expect(outcome).toEqual(
            now
              ? { done: false, failure: { reason: 'held', holder: now } }
              : { done: false }
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('writes nothing when saving is refused by the time the user chose', async () => {
    for (const choice of ['reassociate', 'erase'] as const) {
      vi.restoreAllMocks();
      const path = 'notes/a.md';
      const { vault, repo, deps, leftover, purge, notify } = await wireConflict(
        {
          path,
          tags: ['other'],
          kind: 'snippet',
          deleted: true,
          choice,
          meanwhile: ({ repo }) => repo.refuseWrites(),
        }
      );
      const stored = repo.dump();
      const frontmatter = structuredClone(vault.frontmatterOf(path));

      expect(await resolveLeftover(deps, leftover, 'adopt', 'article')).toEqual(
        { done: false }
      );

      expect(repo.dump()).toBe(stored);
      expect(vault.frontmatterOf(path)).toEqual(frontmatter);
      expect(purge).not.toHaveBeenCalled();
      // Saying what wasn't done, to which note
      expect(notify).toHaveBeenCalledOnce();
      expect(notify.mock.calls[0][0]).toContain('"a"');
    }
  });

  it('writes nothing when the note is no leftover any more by the time the user chose: its id given a row, or changed', async () => {
    for (const choice of ['reassociate', 'erase'] as const) {
      for (const change of ['row', 'id'] as const) {
        vi.restoreAllMocks();
        const path = 'notes/a.md';
        let changed = '';
        const { vault, repo, deps, leftover, purge } = await wireConflict({
          path,
          tags: ['other'],
          kind: 'card',
          deleted: false,
          choice,
          meanwhile: async ({ repo }) => {
            // By Sync, say, or the user: a row of its own, at its path, as
            // one elsewhere leaves it a leftover while the card holds it
            if (change === 'row') {
              insertRow(repo, 'article', 'left-1', path);
            } else {
              await Obsidian.updateFrontMatter(
                vault.files.get(path)!,
                { 'ir-id': 'left-2' },
                vault.app as never
              );
            }
            changed = repo.dump();
          },
        });
        const frontmatter = {
          ...structuredClone(vault.frontmatterOf(path)),
          ...(change === 'id' ? { 'ir-id': 'left-2' } : {}),
        };

        expect(
          await resolveLeftover(deps, leftover, 'adopt', 'snippet')
        ).toEqual({ done: false });

        expect(repo.dump()).toBe(changed);
        expect(vault.frontmatterOf(path)).toEqual(frontmatter);
        expect(purge).not.toHaveBeenCalled();
      }
    }
  });

  it("puts the note's id and tags back as they were when the row can't be brought back", async () => {
    const path = 'notes/a.md';
    const tags = ['kept', ARTICLE_TAG, CARD_TAG];
    const { vault, repo, deps, leftover, notify } = await wireConflict({
      path,
      tags,
      kind: 'snippet',
      deleted: true,
      choice: 'reassociate',
    });
    const frontmatter = structuredClone(vault.frontmatterOf(path));
    const stored = repo.dump();
    repo.failWrite((query) => query.startsWith('UPDATE snippet'));

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'article');

    expect(outcome).toMatchObject({
      done: false,
      failure: { reason: 'error' },
    });
    expect(vault.frontmatterOf(path)).toEqual(frontmatter);
    expect(repo.dump()).toBe(stored);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('hands the note the parentless snippets and cards taken from it once it is an article or snippet again, not a card, and is done even if that fails', async () => {
    for (const kind of ['article', 'snippet', 'card'] as const) {
      for (const fails of [false, true]) {
        vi.restoreAllMocks();
        const { deps, leftover, notify } = await wireConflict({
          path: 'notes/a.md',
          tags: ['other'],
          kind,
          deleted: false,
          choice: 'reassociate',
        });
        const claim = vi.spyOn(deps.articles, 'claimInPlace');
        if (fails) claim.mockRejectedValue(new Error('read failed'));

        expect(
          await resolveLeftover(deps, leftover, 'adopt', 'article')
        ).toEqual({ done: true });

        if (kind === 'card') {
          expect(claim).not.toHaveBeenCalled();
        } else {
          expect(claim).toHaveBeenCalledExactlyOnceWith(
            leftover.file,
            HOLDER_ID
          );
        }
        expect(notify.mock.calls).toEqual(
          fails && kind !== 'card'
            ? [
                [
                  expect.stringContaining('"a"'),
                  { kind: 'error', persist: true },
                ],
              ]
            : []
        );
      }
    }
  });

  it('says so, leaving the row erased as asked and the note as it was, when the note then fails to be saved', async () => {
    const { vault, repo, deps, leftover, notify } = await wireConflict({
      path: 'notes/Quokka.md',
      tags: ['other'],
      kind: 'snippet',
      deleted: true,
      choice: 'erase',
    });
    vi.spyOn(deps.articles, 'adoptLeftover').mockRejectedValue(
      new Error('Disk full')
    );
    const frontmatterBefore = structuredClone(
      vault.frontmatterOf('notes/Quokka.md')
    );

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'article');

    expect(outcome).toEqual({
      done: false,
      failure: { reason: 'error', message: 'Disk full' },
    });
    expect(repo.rows('snippet')).toEqual([]);
    // Its id and tags put back, so it is the same leftover still
    expect(vault.frontmatterOf('notes/Quokka.md')).toEqual(frontmatterBefore);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain('Quokka');
  });

  it('asks nothing when trashing or stripping a leftover whose path a row holds, nor when adopting one whose path none does', async () => {
    for (const action of ['trash', 'strip', 'adopt'] as const) {
      vi.restoreAllMocks();
      const { repo, deps, leftover, ask } = await wireConflict({
        path: `${DATA_DIRECTORY}/x/a.md`,
        tags: [SNIPPET_TAG],
        kind: 'article',
        deleted: true,
        choice: 'reassociate',
      });
      if (action === 'adopt') {
        repo.mutate(`UPDATE article SET reference = 'gone.md'`);
      }

      expect(await resolveLeftover(deps, leftover, action)).toEqual({
        done: true,
      });
      expect(ask).not.toHaveBeenCalled();
    }
  });
});

describe('findCandidates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers a note the row holding its id unless a note at the row's reference holds the id too or a live row holds the note's path, else the row at its path; moves a deleted row there aside; offers erasing only while no row holds its id", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        const { deps } = wireWorld(world);

        for (const { path, id } of world.notes) {
          const plan = await findCandidates(deps, path, id);

          expect(project(plan)).toEqual(expectedPlan(world, path, id));
        }
      }),
      { numRuns: 200 }
    );
  });

  it('reads the row holding an id with what the user is shown of it and where it points, deleted or not', async () => {
    const repo = resetSharedRepo();
    const vault = makeItemVault({ 'notes/new.md': { 'ir-id': MOVED_ID } });
    insertRow(repo, 'article', 'parent-1', 'notes/parent.md');
    insertRow(repo, 'snippet', MOVED_ID, 'notes/old.md', true);
    repo.mutate(
      `UPDATE snippet SET due = 42, dismissed = 1, parent = 'parent-1' WHERE id = $1`,
      [MOVED_ID]
    );

    const { target } = await findCandidates(
      { app: vault.app as never, repo },
      'notes/new.md',
      MOVED_ID
    );

    const [stored] = repo.storedRows('snippet', ` WHERE id = '${MOVED_ID}'`);
    expect(target).toEqual({
      by: 'id',
      row: {
        kind: 'snippet',
        id: MOVED_ID,
        deleted: true,
        dismissed: true,
        due: 42,
        lastReview: null,
        updatedAt: stored.updated_at,
        updatedBy: stored.updated_by,
        parent: { id: 'parent-1', path: 'notes/parent.md' },
        reference: 'notes/old.md',
      },
    });
  });
});

describe('findLeftovers of moved notes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists a note whose id no live row holds, or whose path a row holding another id holds while its id's row is elsewhere, typed as the row holding its id, which it is matched with, else, typeless, as the row at its path", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        const { deps } = wireWorld(world);

        const found = await findLeftovers(deps);

        const kept = world.rows.filter((row) => row.state !== 'purged');
        const live = kept.filter((row) => row.state === 'live');
        const expected = world.notes.flatMap((note) => {
          const own = live.some(
            (row) => row.id === note.id && row.path === note.path
          );
          const elsewhere = live.some((row) => row.id === note.id);
          const atPath = kept.some(
            (row) => row.path === note.path && row.id !== note.id
          );
          if (own || (elsewhere && !atPath)) return [];
          const { target } = expectedPlan(world, note.path, note.id);
          const match = target?.by === 'id' ? target : null;
          const holder = target?.by === 'path' ? target : null;
          return [
            {
              path: note.path,
              id: note.id,
              // A typeless note at a row's path starts as that row's type,
              // unless a card's: saved as a new item, it is no card's note
              type:
                match?.kind ??
                Obsidian.typeOfTags(note.tags) ??
                (holder?.kind === 'card' ? null : holder?.kind) ??
                null,
              match: match && { id: match.id, reference: match.reference },
              holder: holder && { id: holder.id, kind: holder.kind },
            },
          ];
        });
        expect(
          found.map(({ file, id, type, match, holder }) => ({
            path: file.path,
            id,
            type,
            match: match ? { id: match.id, reference: match.reference } : null,
            holder: holder ? { id: holder.id, kind: holder.kind } : null,
          }))
        ).toEqual(expected);
      }),
      { numRuns: 200 }
    );
  });

  it("types a typeless note at another row's path as that row unless a card, keeping the row as its holder either way, and a typed one by its tag", async () => {
    for (const kind of KIND_RANK) {
      for (const deleted of [false, true]) {
        for (const tags of [
          ['other'],
          ['other', TAG_OF[kind === 'article' ? 'snippet' : 'article']],
        ]) {
          vi.restoreAllMocks();
          const { leftover } = await wireConflict({
            path: 'notes/a.md',
            tags,
            kind,
            deleted,
            choice: null,
          });

          const typed = Obsidian.typeOfTags(tags);
          expect(leftover).toMatchObject({
            id: 'left-1',
            type: typed ?? (kind === 'card' ? null : kind),
            holder: { kind, id: HOLDER_ID, deleted },
          });
          expect(leftover.match).toBeUndefined();
        }
      }
    }
  });

  it('lists a note moved with its type tag, its row deleted, matched with that row', async () => {
    for (const kind of KIND_RANK) {
      vi.restoreAllMocks();
      const { leftover } = await wireMoved({
        kind,
        tags: ['other', TAG_OF[kind]],
        choice: null,
      });

      expect(leftover).toMatchObject({
        id: MOVED_ID,
        type: kind,
        match: { kind, id: MOVED_ID, deleted: true, reference: 'notes/old.md' },
      });
    }
  });

  it('leaves out a note whose id a live row holds elsewhere though a deleted row of another table holding the same id is at its path', async () => {
    const { deps } = wireWorld({
      notes: [{ path: 'notes/p.md', id: 'a', tags: [] }],
      rows: [
        { kind: 'article', id: 'a', path: 'notes/q.md', state: 'live' },
        { kind: 'snippet', id: 'a', path: 'notes/p.md', state: 'deleted' },
      ],
    });

    expect(await findLeftovers(deps)).toEqual([]);
  });

  it("lists a note moved while Obsidian was closed, its row deleted before, as one of its row's type the user made, matched with that row", async () => {
    const { leftover } = await wireMoved({ kind: 'card', choice: null });

    expect(leftover).toMatchObject({
      id: MOVED_ID,
      type: 'card',
      kind: 'in-place',
      match: { kind: 'card', id: MOVED_ID, reference: 'notes/old.md' },
    });
  });
});

describe('resolveLeftover of a note moved away from its row', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-associates the note with its row: the row live at the note's path with its schedule and history, the row's id and type tag in the note, a deleted row at the path moved aside, nothing else changed", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        leftoverTagsArb,
        typeArb,
        fc.constantFrom('notes/new.md', `${DATA_DIRECTORY}/x/new.md`),
        fc.option(typeArb, { nil: null }),
        async (kind, tags, as, at, deletedAtPath) => {
          vi.restoreAllMocks();
          const { vault, repo, deps, leftover, ask, purge, table } =
            await wireMoved({
              kind,
              at,
              tags,
              pathRow: deletedAtPath && { kind: deletedAtPath, deleted: true },
              choice: 'reassociate',
            });
          const plan = await findCandidates(deps, at, MOVED_ID);
          const before = itemRows(repo);
          const file = leftover.file;

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(outcome).toEqual({ done: true });
          expect(ask).toHaveBeenCalledExactlyOnceWith(
            file,
            plan.target!.row,
            plan
          );
          expect(purge).not.toHaveBeenCalled();
          expect(vault.frontmatterOf(at)).toEqual({
            'ir-id': MOVED_ID,
            tags: retagged(tags, kind),
            title: 'kept',
          });
          const after = Object.fromEntries(
            Object.entries(before).map(([name, rows]) => [
              name,
              rows.map((row) =>
                name === table && row.id === MOVED_ID
                  ? { ...row, reference: at, deleted: 0 }
                  : row.id === HOLDER_ID
                    ? {
                        ...row,
                        reference: evictedSpot({
                          table: name as never,
                          id: HOLDER_ID,
                        }),
                      }
                    : row
              ),
            ])
          );
          expect(itemRows(repo)).toEqual(after);
          const [stored] = repo.storedRows(table, ` WHERE id = '${MOVED_ID}'`);
          expect(stored.note_mtime).toBe(file.stat.mtime);
          expect(stored.due).toBe(MOVED_DUE);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('asks about the row holding its id, and with no answer writes nothing and says nothing, answering that the user backed out', async () => {
    for (const kind of KIND_RANK) {
      vi.restoreAllMocks();
      const { vault, repo, deps, leftover, notify, ask, purge } =
        await wireMoved({ kind, choice: null });
      const stored = repo.dump();
      const frontmatter = structuredClone(vault.frontmatterOf('notes/new.md'));
      const plan = await findCandidates(deps, 'notes/new.md', MOVED_ID);

      const outcome = await resolveLeftover(deps, leftover, 'adopt', 'article');

      expect(ask).toHaveBeenCalledOnce();
      expect(outcome).toEqual({ done: false, canceled: true });
      expect(plan.target).toMatchObject({ by: 'id', row: { kind } });
      expect(repo.dump()).toBe(stored);
      expect(vault.frontmatterOf('notes/new.md')).toEqual(frontmatter);
      expect(notify).not.toHaveBeenCalled();
      expect(purge).not.toHaveBeenCalled();
    }
  });

  it("re-associates the note with a live row at its path instead, while that row keeps its id's row from the path, and never offers to erase it", async () => {
    const { vault, repo, deps, leftover, ask, table } = await wireMoved({
      kind: 'snippet',
      pathRow: { kind: 'article', deleted: false },
      choice: 'reassociate',
    });
    const plan = await findCandidates(deps, 'notes/new.md', MOVED_ID);
    const moved = repo.rows(table);

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'snippet');

    expect(outcome).toEqual({ done: true });
    expect(plan).toMatchObject({
      target: { by: 'path', row: { kind: 'article', id: HOLDER_ID } },
      erase: false,
      refused: [{ row: { id: MOVED_ID }, why: 'held' }],
    });
    expect(ask).toHaveBeenCalledExactlyOnceWith(
      leftover.file,
      plan.target!.row,
      plan
    );
    expect(vault.frontmatterOf('notes/new.md')?.['ir-id']).toBe(HOLDER_ID);
    // The row holding its id stays deleted where it was
    expect(repo.rows(table)).toEqual(moved);
  });

  it("re-associates the note with a live row at its path though a deleted row of a table ranked before it is there too, never offering the row holding its id, which can't take the path", async () => {
    const { vault, repo, deps, leftover, ask, table } = await wireMoved({
      kind: 'snippet',
      pathRow: { kind: 'card', deleted: false },
      choice: 'reassociate',
    });
    insertRow(repo, 'article', 'gone-0000-aaaa', 'notes/new.md', true);
    const moved = repo.rows(table);

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'snippet');

    expect(outcome).toEqual({ done: true });
    const [[, holder, plan]] = ask.mock.calls;
    expect(holder).toMatchObject({ kind: 'card', id: HOLDER_ID });
    expect(plan).toMatchObject({
      target: { by: 'path' },
      evicts: null,
      refused: [{ row: { id: MOVED_ID }, why: 'held' }],
    });
    expect(vault.frontmatterOf('notes/new.md')?.['ir-id']).toBe(HOLDER_ID);
    expect(repo.rows(table)).toEqual(moved);
  });

  it("fails at once, saying why, for a copy: a note at its id's row's reference still holds the id", async () => {
    const { vault, repo, deps, leftover, notify, ask } = await wireMoved({
      kind: 'article',
      original: true,
      choice: 'reassociate',
    });
    const stored = repo.dump();
    const frontmatter = structuredClone(vault.frontmatterOf('notes/new.md'));

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'article');

    expect(outcome).toMatchObject({
      done: false,
      failure: {
        reason: 'matched',
        row: { id: MOVED_ID, reference: 'notes/old.md' },
        copy: true,
      },
    });
    expect(ask).not.toHaveBeenCalled();
    // Logged only when nothing could ask
    expect(console.warn).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain('notes/old.md');
    expect(repo.dump()).toBe(stored);
    expect(vault.frontmatterOf('notes/new.md')).toEqual(frontmatter);
  });

  it('writes nothing, and says so, when the row holding its id changed while the user was choosing', async () => {
    const { vault, repo, deps, leftover, notify } = await wireMoved({
      kind: 'snippet',
      choice: 'reassociate',
      meanwhile: ({ repo }) =>
        repo.mutate(`UPDATE snippet SET due = 7 WHERE id = $1`, [MOVED_ID]),
    });
    const frontmatter = structuredClone(vault.frontmatterOf('notes/new.md'));

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'snippet');

    expect(outcome).toMatchObject({
      done: false,
      failure: { reason: 'matched', row: { id: MOVED_ID, due: 7 } },
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('"new"'),
      { kind: 'error' }
    );
    expect(vault.frontmatterOf('notes/new.md')).toEqual(frontmatter);
    expect(repo.rows('snippet')).toMatchObject([
      { reference: 'notes/old.md', deleted: 1 },
    ]);
  });

  it("puts the note's id and tags back, and the rows as they were, when the row can't be moved", async () => {
    const { vault, repo, deps, leftover, notify } = await wireMoved({
      kind: 'snippet',
      tags: ['kept', ARTICLE_TAG],
      pathRow: { kind: 'snippet', deleted: true },
      choice: 'reassociate',
    });
    const frontmatter = structuredClone(vault.frontmatterOf('notes/new.md'));
    const stored = repo.dump();
    repo.failWrite((query) => query.includes('deleted = FALSE'));

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'snippet');

    expect(outcome).toMatchObject({
      done: false,
      failure: { reason: 'error' },
    });
    expect(vault.frontmatterOf('notes/new.md')).toEqual(frontmatter);
    expect(repo.dump()).toBe(stored);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('writes nothing when told to erase a row holding its id, which is never offered', async () => {
    const { vault, repo, deps, leftover, purge } = await wireMoved({
      kind: 'article',
      choice: 'erase',
    });
    const stored = repo.dump();
    const frontmatter = structuredClone(vault.frontmatterOf('notes/new.md'));

    const outcome = await resolveLeftover(deps, leftover, 'adopt', 'article');

    expect(outcome).toMatchObject({
      done: false,
      failure: { reason: 'matched', copy: false },
    });
    expect(purge).not.toHaveBeenCalled();
    expect(repo.dump()).toBe(stored);
    expect(vault.frontmatterOf('notes/new.md')).toEqual(frontmatter);
  });

  it('trashes or strips a moved note without asking, leaving its row deleted', async () => {
    for (const action of ['trash', 'strip'] as const) {
      vi.restoreAllMocks();
      const { repo, deps, leftover, ask, table } = await wireMoved({
        kind: 'snippet',
        at: `${DATA_DIRECTORY}/x/new.md`,
        choice: 'reassociate',
      });
      const rows = repo.rows(table);

      expect(await resolveLeftover(deps, leftover, action)).toEqual({
        done: true,
      });
      expect(ask).not.toHaveBeenCalled();
      expect(repo.rows(table)).toEqual(rows);
    }
  });

  it('strips the type tag a moved note carries though the row holding its id is of another type, leaving its other tags', async () => {
    for (const [kind, tagged] of [
      ['article', 'snippet'],
      ['snippet', 'card'],
      ['card', 'article'],
    ] as const) {
      vi.restoreAllMocks();
      const { vault, deps, leftover } = await wireMoved({
        kind,
        tags: ['other', TAG_OF[tagged]],
        choice: null,
      });

      expect(await resolveLeftover(deps, leftover, 'strip')).toEqual({
        done: true,
      });
      expect(vault.frontmatterOf('notes/new.md')).toEqual({
        title: 'kept',
        tags: ['other'],
      });
    }
  });

  it('re-associates several moved notes in turn, each with its own row', async () => {
    const vault = makeItemVault({
      'moved/a.md': { 'ir-id': 'id-a' },
      'moved/s.md': { 'ir-id': 'id-s' },
      'moved/c.md': { 'ir-id': 'id-c' },
    });
    const repo = await TestRepository.create();
    insertRow(repo, 'article', 'id-a', 'old/a.md', true);
    insertRow(repo, 'snippet', 'id-s', 'old/s.md', true);
    insertRow(repo, 'card', 'id-c', 'old/c.md', true);
    const plugin: Record<string, unknown> = {
      app: { ...vault.app, workspace: { trigger: vi.fn() } },
      settings: {},
    };
    const reviewManager = new ReviewManager(plugin as never, repo);
    plugin.reviewManager = reviewManager;
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    const ask = vi.fn(async () => 'reassociate' as const);
    const deps = {
      app: vault.app as never,
      repo,
      articles: reviewManager.articles,
      snippets: reviewManager.snippets,
      cards: reviewManager.cards,
      conflicts: { ask, purge: vi.fn() },
    };

    const leftovers = await findLeftovers(deps);
    const outcomes = [];
    for (const leftover of leftovers) {
      outcomes.push(await resolveLeftover(deps, leftover, 'adopt', 'article'));
    }

    expect(outcomes).toEqual([{ done: true }, { done: true }, { done: true }]);
    expect(ask).toHaveBeenCalledTimes(3);
    expect([
      ...repo.rows('article'),
      ...repo.rows('snippet'),
      ...repo.rows('srs_card'),
    ]).toMatchObject([
      { id: 'id-a', reference: 'moved/a.md', deleted: 0 },
      { id: 'id-s', reference: 'moved/s.md', deleted: 0 },
      { id: 'id-c', reference: 'moved/c.md', deleted: 0 },
    ]);
    expect(await findLeftovers(deps)).toEqual([]);
  });
});

describe('failureDetail of a note holding the id of a row', () => {
  it('names the row by its short id and where it points, and tells a copy apart', () => {
    fc.assert(
      fc.property(
        typeArb,
        fc.boolean(),
        fc.uuid(),
        fc.string({ minLength: 1 }),
        (kind, deleted, id, reference) => {
          const row = {
            kind,
            id,
            deleted,
            dismissed: false,
            due: null,
            lastReview: null,
            updatedAt: 0,
            updatedBy: '',
            parent: null,
            reference,
          };

          const matched = failureDetail({
            reason: 'matched',
            row,
            copy: false,
          });
          const copied = failureDetail({ reason: 'matched', row, copy: true });

          for (const detail of [matched, copied]) {
            expect(detail).toContain(id.slice(0, 8));
            expect(detail).not.toContain(id.slice(0, 9));
            expect(detail).toContain(`"${reference}"`);
            expect(detail).toContain(kind);
          }
          expect(matched).not.toBe(copied);
          expect(matched).not.toBe(
            failureDetail({
              reason: 'matched',
              row: { ...row, deleted: !deleted },
              copy: false,
            })
          );
        }
      )
    );
  });
});

describe('resolveLeftover of a note whose id belongs to a row deleted for good', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the note, and plans nothing for it but what holds its id: the row deleted for good, as the user is told of it', async () => {
    await fc.assert(
      fc.asyncProperty(typeArb, leftoverPathArb, async (kind, path) => {
        vi.restoreAllMocks();
        const { deps, leftover, gone } = await wirePurged({ kind, path });

        expect(leftover).toMatchObject({ id: PURGED_ID });
        expect(leftover.match).toBeUndefined();
        expect(await findCandidates(deps, path, PURGED_ID)).toEqual({
          target: null,
          evicts: null,
          erase: false,
          refused: [],
          purged: gone,
        });
        expect(gone.erasedAt).toBeGreaterThan(0);
        expect(gone.erasedBy).not.toBe('');
      }),
      { numRuns: 6 }
    );
  });

  it("imports the note fresh once the user chooses to: a new id and the chosen type's tag in place of other types' in the note, a new row of that type at its path, and nothing else written, the row deleted for good least of all", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        typeArb,
        leftoverPathArb,
        leftoverTagsArb,
        async (kind, as, path, tags) => {
          vi.restoreAllMocks();
          const wired = await wirePurged({ kind, path, tags });
          const { vault, repo, deps, leftover, notify, ask, askFresh } = wired;
          const before = storedItemRows(repo);

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(outcome).toEqual({ done: true });
          expect(askFresh).toHaveBeenCalledExactlyOnceWith(
            leftover.file,
            wired.gone,
            as
          );
          expect(ask).not.toHaveBeenCalled();
          expect(wired.purge).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
          const frontmatter = vault.frontmatterOf(path)!;
          const id = frontmatter['ir-id'] as string;
          expect(id).toMatch(UUID);
          expect(frontmatter).toEqual({
            'ir-id': id,
            tags: retagged(tags, as),
            title: 'kept',
          });
          const after = storedItemRows(repo);
          const table = ITEM_TABLE_OF[as];
          expect(after[table].filter((row) => row.id === id)).toEqual([
            expect.objectContaining({ id, reference: path, deleted: 0 }),
          ]);
          expect({
            ...after,
            [table]: after[table].filter((row) => row.id !== id),
          }).toEqual(before);
          expect(await findLeftovers(deps)).toEqual([]);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('gives each note imported fresh an id of its own', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      vi.restoreAllMocks();
      const { vault, deps, leftover } = await wirePurged({ kind: 'snippet' });

      await resolveLeftover(deps, leftover, 'adopt', 'snippet');

      ids.add(vault.frontmatterOf('notes/a.md')!['ir-id'] as string);
    }
    expect(ids.size).toBe(3);
    expect(ids.has(PURGED_ID)).toBe(false);
  });

  it('with no answer writes nothing and says nothing, answering that the user backed out', async () => {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        typeArb,
        leftoverTagsArb,
        async (kind, as, tags) => {
          vi.restoreAllMocks();
          const { vault, repo, deps, leftover, notify, askFresh } =
            await wirePurged({ kind, tags, fresh: false });
          const stored = repo.dump();
          const frontmatter = structuredClone(
            vault.frontmatterOf('notes/a.md')
          );

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(outcome).toEqual({ done: false, canceled: true });
          expect(askFresh).toHaveBeenCalledOnce();
          expect(repo.dump()).toBe(stored);
          expect(vault.frontmatterOf('notes/a.md')).toEqual(frontmatter);
          expect(notify).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 12 }
    );
  });

  it('writes nothing, and says why, with no way to ask the user', async () => {
    const { vault, repo, deps, leftover, notify, gone } = await wirePurged({
      kind: 'article',
    });
    const stored = repo.dump();
    const frontmatter = structuredClone(vault.frontmatterOf('notes/a.md'));
    const { ask, purge } = deps.conflicts;

    const outcome = await resolveLeftover(
      { ...deps, conflicts: { ask, purge } },
      leftover,
      'adopt',
      'article'
    );

    expect(outcome).toEqual({
      done: false,
      failure: { reason: 'purged', row: gone },
    });
    expect(repo.dump()).toBe(stored);
    expect(vault.frontmatterOf('notes/a.md')).toEqual(frontmatter);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain('"a"');
    expect(notify.mock.calls[0][0]).toContain(PURGED_ID.slice(0, 8));
  });

  it('writes nothing when saving is refused by the time the user chose', async () => {
    const { vault, repo, deps, leftover, notify } = await wirePurged({
      kind: 'card',
      meanwhile: ({ repo }) => repo.refuseWrites(),
    });
    const stored = repo.dump();
    const frontmatter = structuredClone(vault.frontmatterOf('notes/a.md'));

    expect(await resolveLeftover(deps, leftover, 'adopt', 'card')).toEqual({
      done: false,
    });

    expect(repo.dump()).toBe(stored);
    expect(vault.frontmatterOf('notes/a.md')).toEqual(frontmatter);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain('"a"');
  });

  it('writes nothing when the note is no leftover any more by the time the user chose: its id given a row, or changed', async () => {
    for (const change of ['row', 'id'] as const) {
      vi.restoreAllMocks();
      const path = 'notes/a.md';
      let changed = '';
      const { vault, repo, deps, leftover } = await wirePurged({
        kind: 'article',
        meanwhile: async ({ repo, vault }) => {
          // By Sync, say: a row of another table holding the id at its path
          if (change === 'row') insertRow(repo, 'snippet', PURGED_ID, path);
          else {
            await Obsidian.updateFrontMatter(
              vault.files.get(path)!,
              { 'ir-id': 'left-2' },
              vault.app as never
            );
          }
          changed = repo.dump();
        },
      });
      const frontmatter = {
        ...structuredClone(vault.frontmatterOf(path)),
        ...(change === 'id' ? { 'ir-id': 'left-2' } : {}),
      };

      expect(await resolveLeftover(deps, leftover, 'adopt', 'article')).toEqual(
        { done: false }
      );

      expect(repo.dump()).toBe(changed);
      expect(vault.frontmatterOf(path)).toEqual(frontmatter);
    }
  });

  it("writes nothing, and says so, when a row came to hold the note's path while the user was choosing, failing with that row", async () => {
    for (const deleted of [false, true]) {
      vi.restoreAllMocks();
      const path = 'notes/a.md';
      let changed = '';
      const { vault, repo, deps, leftover, notify } = await wirePurged({
        kind: 'snippet',
        meanwhile: ({ repo }) => {
          insertRow(repo, 'article', HOLDER_ID, path, deleted);
          changed = repo.dump();
        },
      });
      const frontmatter = structuredClone(vault.frontmatterOf(path));

      const outcome = await resolveLeftover(deps, leftover, 'adopt', 'article');

      expect(outcome).toEqual({
        done: false,
        failure: {
          reason: 'held',
          holder: expect.objectContaining({
            id: HOLDER_ID,
            deleted,
          }) as unknown,
        },
      });
      expect(repo.dump()).toBe(changed);
      expect(vault.frontmatterOf(path)).toEqual(frontmatter);
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('"a"'),
        {
          kind: 'error',
        }
      );
    }
  });

  it('writes nothing, and says so, when another row deleted for good came to hold its id while the user was choosing', async () => {
    const path = 'notes/a.md';
    let changed = '';
    const { vault, repo, deps, leftover, notify } = await wirePurged({
      kind: 'snippet',
      meanwhile: ({ repo }) => {
        // An article erased for good that Sync brought, say: first by table
        insertRow(repo, 'article', PURGED_ID, 'elsewhere.md');
        for (const { query, params } of deleteRowStatements(
          'article',
          PURGED_ID
        )) {
          repo.mutate(query, params);
        }
        changed = repo.dump();
      },
    });
    const frontmatter = structuredClone(vault.frontmatterOf(path));

    expect(await resolveLeftover(deps, leftover, 'adopt', 'article')).toEqual({
      done: false,
    });

    expect(repo.dump()).toBe(changed);
    expect(vault.frontmatterOf(path)).toEqual(frontmatter);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain('"a"');
  });

  it("puts the note's id and tags back as they were, and writes no row, when the new row can't be saved", async () => {
    await fc.assert(
      fc.asyncProperty(typeArb, leftoverTagsArb, async (as, tags) => {
        vi.restoreAllMocks();
        const { vault, repo, deps, leftover, notify } = await wirePurged({
          kind: 'article',
          tags,
        });
        const frontmatter = structuredClone(vault.frontmatterOf('notes/a.md'));
        const stored = repo.dump();
        const insert = new RegExp(`^\\s*INSERT INTO ${ITEM_TABLE_OF[as]}\\b`);
        repo.failWrite((query) => insert.test(query));

        const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

        expect(outcome).toMatchObject({
          done: false,
          failure: { reason: 'error' },
        });
        expect(vault.frontmatterOf('notes/a.md')).toEqual(frontmatter);
        expect(repo.dump()).toBe(stored);
        expect(notify).toHaveBeenCalledOnce();
      }),
      { numRuns: 12 }
    );
  });

  it("re-associates the note with the row at its path, once the user chooses to, writing that row's id into the note and leaving the row deleted for good and its history as they were", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        typeArb,
        fc.boolean(),
        typeArb,
        leftoverTagsArb,
        async (kind, holderKind, deleted, as, tags) => {
          vi.restoreAllMocks();
          const { vault, repo, deps, leftover, askFresh, purge } =
            await wirePurged({
              kind,
              tags,
              pathRow: { kind: holderKind, deleted },
              choice: 'reassociate',
            });
          const ofPurged = (rows: ReturnType<typeof storedItemRows>) =>
            Object.fromEntries(
              Object.entries(rows).map(([table, stored]) => [
                table,
                stored.filter((row) => Object.values(row).includes(PURGED_ID)),
              ])
            );
          const before = ofPurged(storedItemRows(repo));

          const outcome = await resolveLeftover(deps, leftover, 'adopt', as);

          expect(outcome).toEqual({ done: true });
          expect(askFresh).not.toHaveBeenCalled();
          expect(purge).not.toHaveBeenCalled();
          expect(vault.frontmatterOf('notes/a.md')).toEqual({
            'ir-id': HOLDER_ID,
            tags: retagged(tags, holderKind),
            title: 'kept',
          });
          expect(ofPurged(storedItemRows(repo))).toEqual(before);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('asks nothing when trashing or stripping such a note', async () => {
    for (const action of ['trash', 'strip'] as const) {
      vi.restoreAllMocks();
      const { deps, leftover, askFresh } = await wirePurged({
        kind: 'snippet',
        path: `${DATA_DIRECTORY}/x/a.md`,
      });

      expect(await resolveLeftover(deps, leftover, action)).toEqual({
        done: true,
      });
      expect(askFresh).not.toHaveBeenCalled();
    }
  });
});

describe('failureDetail of a note whose id belongs to a row deleted for good', () => {
  it('names the row by its kind and short id', () => {
    fc.assert(
      fc.property(
        typeArb,
        fc.uuid(),
        fc.nat(),
        fc.string(),
        (kind, id, erasedAt, erasedBy) => {
          const detail = failureDetail({
            reason: 'purged',
            row: { kind, id, erasedAt, erasedBy },
          });

          expect(detail).toContain(id.slice(0, 8));
          expect(detail).not.toContain(id.slice(0, 9));
          expect(detail).toContain(
            kind === 'article' ? 'an article' : `a ${kind}`
          );
        }
      )
    );
  });
});
