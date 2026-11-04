import type { ArticleManager } from '#/lib/items/ArticleManager';
import type { CardManager } from '#/lib/items/CardManager';
import {
  claimedId,
  claimsIdAt,
  holdingOf,
  type IdHolder,
} from '#/lib/items/note-holding';
import { NOT_PURGED, purgedReference } from '#/lib/items/row-delete';
import type { SnippetManager } from '#/lib/items/SnippetManager';
import type { ItemTable } from '#/lib/moved-note-scan';
import type { App, TFile } from 'obsidian';
import { refusedWrite, withCompensation } from './compensation';
import {
  ARTICLE_TAG,
  CARD_TAG,
  DATA_DIRECTORY,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_TAG,
} from './constants';
import {
  hasTag,
  isTag,
  tagEntries,
  tagsKeyOf,
  typeOfTags,
  withTag,
} from './item-tags';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import { stripFrontmatterTags } from './tags';
import type { NoteType, SQLiteRepository } from './types';

/**
 * Crash leftovers: notes holding an `ir-id` that no live row at their path
 * holds, tagged with an item type or not, copies aside (see `note-holding`,
 * the rule the note bar reads a note by too, so a note it shows no item for
 * is listed here). Making an item writes its note before its row, the row being
 * the commit point (see `withCompensation`), and a failure between the two is
 * undone; but a crash or a kill between them skips the undo, and leaves the
 * note. Nothing else reads such a note as an item — the moved-note scan looks
 * only for the ids of rows, and the `ir-id` repair passes them over — so they
 * are found here, and the user is asked what to do with each. Nothing is done
 * to one without asking: a note the plugin made may have been written in
 * since, and one imported in place is the user's own.
 *
 * Found the same way: a note whose id only deleted rows hold, as a note moved
 * outside Obsidian while it runs leaves it, the move reaching the vault as a
 * delete, which deletes the row, and a create, which brings back only a row
 * at the note's own path, tagged or not (see `ReviewManager.handleCreation`);
 * and one at a path a row holding another id
 * holds. The user may re-associate it with such a row (see
 * {@link findCandidates}); nothing pairs the two on its own. A note whose id
 * only a row deleted for good holds is found too, and can only be imported
 * fresh under a new id, should the user choose to (see {@link PurgedRow}).
 */

/**
 * Who made a leftover's note: the plugin (`made`), which put it in its data
 * folder, as it does every snippet, card and copied article; or the user
 * (`in-place`), whose note outside that folder was being imported where it
 * is. Told apart by where the note is, as nothing else is written to tell
 * them apart. An empty article made in the current folder reads as
 * `in-place` too, which only offers to strip it rather than trash it.
 */
export type LeftoverKind = 'made' | 'in-place';

export interface Leftover {
  file: TFile;
  id: string;
  /**
   * The item type the note was made as: the one its tag names; else, for a
   * note the plugin made (`kind: 'made'`), the one whose folder in the data
   * folder it is in (see `Obsidian.getDirectory`); else unknown (`null`), and
   * the note can be kept as an item only as a type the user chooses (see
   * `resolveLeftover`'s `as`).
   */
  type: NoteType | null;
  kind: LeftoverKind;
  /**
   * The deleted row holding the note's id that it would be re-associated
   * with, if any (see {@link findCandidates}): its note was moved or put back
   * where the plugin didn't see it as a move. Its type, the row's, is the
   * note's `type` then, as rows and `ir-id`s are the authority on what an
   * item is.
   */
  match?: MatchedRow;
  /**
   * The row at the note's path, holding another id, that it would be
   * re-associated with when no row holds its id (see {@link findCandidates}).
   */
  holder?: PathHolder;
}

/**
 * A row holding a note's path as its `reference`, deleted (a tombstone not
 * purged) or not, with what the user is shown of it to choose what to do
 * about it: see {@link findPathHolder}.
 */
export interface PathHolder {
  kind: NoteType;
  id: string;
  deleted: boolean;
  dismissed: boolean;
  /** When it is due, in ms; null for a dismissed row that has no due date. */
  due: number | null;
  /** When it was last reviewed, in ms; null when it never was. */
  lastReview: number | null;
  /** When it was last written, in ms (`updated_at`); 0 when never stamped. */
  updatedAt: number;
  /** The device that last wrote it (`updated_by`); `''` when unknown. */
  updatedBy: string;
  /**
   * For a snippet or card taken from an item, that item: by id, with its
   * note's path when a row of it holds one (not deleted for good).
   */
  parent: { id: string; path: string | null } | null;
}

/**
 * A row holding a note's `ir-id`, deleted or not, wherever it points: see
 * {@link findCandidates}.
 */
export interface MatchedRow extends PathHolder {
  /** Where the row says its note is: where the note was last seen. */
  reference: string;
}

/**
 * Why a row holding a leftover's id can't be made its row: a note at the
 * row's reference still holds that id, so the leftover is a copy, and copies
 * never take their original's row (`copy`); or a live row holds the
 * leftover's path, which the row would have to take (`held`).
 */
export type Refusal = 'copy' | 'held';

/**
 * A row deleted for good holding a note's `ir-id`: gone, and never written
 * again, nor brought back, and its id never taken by another row, so that
 * every copy of the database comes to the same deletion. A note holding its
 * id can only be saved as a new item under a new id (see
 * {@link resolveLeftover}). What the user is told of it: what it was, and
 * when, and on which device, it was erased (its last write's stamp).
 */
export interface PurgedRow {
  kind: NoteType;
  id: string;
  /** When it was erased, in ms (`updated_at`); 0 when never stamped. */
  erasedAt: number;
  /** The device that erased it (`updated_by`); `''` when unknown. */
  erasedBy: string;
}

/**
 * What a leftover may be re-associated with, from what holds its id and its
 * path (see {@link findCandidates}).
 */
export interface Plan {
  /**
   * The row Re-associate makes the note's: one holding the note's id (`id`),
   * first; else the one at its path (`path`), a live one before a deleted
   * one, should rows of two tables be there; else none.
   */
  target:
    | { by: 'id'; row: MatchedRow }
    | { by: 'path'; row: PathHolder }
    | null;
  /**
   * A deleted row at the note's path, which gives the path up to `target`
   * coming there from elsewhere: moved aside, as the moved-note scan moves
   * the tombstones in its way (see `evictedSpot`). Of deleted rows of two
   * tables there, the one shown; each is moved aside.
   */
  evicts: PathHolder | null;
  /**
   * Whether erasing the row at the note's path and saving the note as a new
   * item under a fresh id (see {@link adoptFresh}) is offered: only while no
   * row holds the note's id, which makes that row the note's own item, to be
   * re-associated rather than erased.
   */
  erase: boolean;
  /** The rows holding the note's id that can't be made its row, and why. */
  refused: { row: MatchedRow; why: Refusal }[];
  /**
   * A row deleted for good holding the note's id, the first by table
   * (articles, snippets, cards), if any: the note can't be saved under that
   * id, only imported fresh under a new one.
   */
  purged: PurgedRow | null;
}

/**
 * What the user chose to do about a row holding a leftover's path: make the
 * note that row's note (`reassociate`), erase the row and save the note as a
 * new item (`erase`), or neither (`null`).
 */
export type HeldChoice = 'reassociate' | 'erase' | null;

/**
 * Why a leftover's action was not done: another row holds its note's path,
 * so a row for it can't be added there (`held`); or the action threw.
 */
export type LeftoverFailure =
  | { reason: 'held'; holder: PathHolder }
  | {
      /**
       * A row holds the note's id, which it could be re-associated with
       * (`copy` false), or which a note at the row's reference still holds
       * (`copy` true).
       */
      reason: 'matched';
      row: MatchedRow;
      copy: boolean;
    }
  /** A row deleted for good holds the note's id, which no row can take. */
  | { reason: 'purged'; row: PurgedRow }
  | { reason: 'error'; message: string };

/**
 * What came of resolving a leftover: done, or not, with why when it failed.
 * One not done for no failure was left be: no longer a leftover, of no type to
 * adopt it as, or with writes refused (which says so itself). One `canceled`
 * is one the user backed out of when asked what to do about it, which is no
 * failure.
 */
export type LeftoverOutcome =
  | { done: true }
  | { done: false; failure?: LeftoverFailure }
  | { done: false; canceled: true };

/** What can be done with a leftover: see {@link actionsFor}. */
export type LeftoverAction = 'adopt' | 'trash' | 'strip';

/** What is needed to find leftovers and resolve them. */
export interface LeftoverDeps {
  app: Pick<App, 'vault' | 'metadataCache' | 'fileManager'>;
  repo: SQLiteRepository;
  articles: Pick<
    ArticleManager,
    'adoptLeftover' | 'reassociateNote' | 'claimInPlace'
  >;
  snippets: Pick<SnippetManager, 'adoptLeftover'>;
  cards: Pick<CardManager, 'adoptLeftover'>;
  /**
   * What lets a leftover whose path another row holds be adopted anyway (see
   * {@link resolveLeftover}); without it, adopting one fails.
   */
  conflicts?: {
    /**
     * Ask the user what to do about `holder`, a row at `file`'s path; or,
     * with `plan`, about what `plan` offers, `holder` being its target: a
     * row holding the note's id, or one at its path while one does (see
     * {@link Plan}).
     */
    ask: (file: TFile, holder: PathHolder, plan?: Plan) => Promise<HeldChoice>;
    /**
     * Ask the user whether to import `file`, whose id `row`, a row deleted for
     * good, held, as a new item of `as` under a new id. Without it, saving
     * such a note fails, saying why.
     */
    askFresh?: (file: TFile, row: PurgedRow, as: NoteType) => Promise<boolean>;
    /** Erase the `table` row `id` for good (see `ReviewManager.deleteRow`). */
    purge: (table: ItemTable, id: string) => Promise<void>;
  };
}

const ITEM_TABLES = ['article', 'snippet', 'srs_card'] as const;
const KIND_OF_TABLE: Readonly<Record<ItemTable, NoteType>> = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
};
const TABLE_OF_KIND: Readonly<Record<NoteType, ItemTable>> = {
  article: 'article',
  snippet: 'snippet',
  card: 'srs_card',
};
const TAG_OF: Readonly<Record<NoteType, string>> = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  card: CARD_TAG,
};

/**
 * The `ir-id` the cache has for `file`, if it claims one a row can hold (see
 * `claimedId`), and the item type its tags name, if they name one. Tag-only
 * by design: a leftover is a note no row holds, so its tags are the only type
 * it claims.
 */
function claimOf(
  app: Pick<App, 'metadataCache'>,
  file: TFile
): { id: string; type: NoteType | null } | null {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const id = claimedId(frontmatter?.['ir-id']);
  const type = typeOfTags(frontmatter);
  return typeof id === 'string' ? { id, type } : null;
}

const NOTE_TYPES: readonly NoteType[] = ['article', 'snippet', 'card'];

/** The type of item the plugin makes in the folder `path` is in, if any. */
function typeOfFolder(path: string): NoteType | null {
  return (
    NOTE_TYPES.find((type) =>
      path.startsWith(`${Obsidian.getDirectory(type)}/`)
    ) ?? null
  );
}

/** Who made the note at `path` claiming to be of `type`, and what it is. */
function placeOf(
  path: string,
  type: NoteType | null
): Pick<Leftover, 'type' | 'kind'> {
  const made = path.startsWith(`${DATA_DIRECTORY}/`);
  if (type) {
    return { type, kind: type === 'article' && !made ? 'in-place' : 'made' };
  }
  return made
    ? { type: typeOfFolder(path), kind: 'made' }
    : { type: null, kind: 'in-place' };
}

/** What each action does to the note `name`, as the user is told of it. */
const DOING: Readonly<Record<LeftoverAction, (name: string) => string>> = {
  adopt: (name) => `keep ${name} as an item`,
  trash: (name) => `move ${name} to the trash`,
  strip: (name) => `remove the incremental reading properties from ${name}`,
};

/** Whether the database holds any item at all. */
export async function holdsItems(repo: SQLiteRepository): Promise<boolean> {
  for (const table of ITEM_TABLES) {
    const rows = await repo.query(
      `SELECT 1 FROM ${table} WHERE ${NOT_PURGED} LIMIT 1`,
      [],
      {
        throwOnError: true,
      }
    );
    if (rows.length > 0) return true;
  }
  return false;
}

/** A note's claim on an item: where the note is, and the id it holds. */
interface Claim {
  path: string;
  id: string;
}

/**
 * Of `claims`, those of leftovers, each with whether a row holds its id or
 * its path at all, deleted or not. A note is a leftover unless a live row
 * holding its id points at it (its row), or points where a note holding the
 * id is (a copy's original) while no live row holding another id holds the
 * note's path (see `holdingOf`): a copy sitting where another item's note
 * should be is asked about, with that row as its holder.
 * So a note whose id only deleted rows hold is one: its note was moved where
 * the plugin saw only a delete and a create, say, as a move outside Obsidian
 * while it runs is. So is one whose id's live row points where no note
 * holding the id is, and one at a path a row holding another id holds while
 * no row holds its id. A row deleted for good holds no id and no path here.
 */
async function leftoverClaims<C extends Claim>(
  { app, repo }: Pick<LeftoverDeps, 'app' | 'repo'>,
  claims: readonly C[]
): Promise<{ claim: C; rowed: boolean }[]> {
  /** Each id's rows not deleted for good, by whether each is live. */
  const rowsOf = new Map<string, IdHolder[]>();
  /** The rows at each path, by id and whether each is live. */
  const rowsAt = new Map<string, { id: string; live: boolean }[]>();
  for (let i = 0; i < claims.length; i += MAX_SQL_QUERY_PARAMS) {
    const batch = claims.slice(i, i + MAX_SQL_QUERY_PARAMS);
    const marks = batch.map((_, j) => `$${j + 1}`).join(', ');
    for (const table of ITEM_TABLES) {
      const byId = (await repo.query(
        `SELECT id, reference, deleted FROM ${table} WHERE id IN (${marks}) AND ${NOT_PURGED}`,
        batch.map(({ id }) => id),
        { throwOnError: true }
      )) as unknown as { id: string; reference: string; deleted: unknown }[];
      for (const { id, reference, deleted } of byId) {
        const live = !deleted;
        rowsOf.set(id, [...(rowsOf.get(id) ?? []), { reference, live }]);
      }
      const atPath = (await repo.query(
        `SELECT id, reference, deleted FROM ${table} WHERE reference IN (${marks})`,
        batch.map(({ path }) => path),
        { throwOnError: true }
      )) as unknown as { id: string; reference: string; deleted: unknown }[];
      for (const { id, reference, deleted } of atPath) {
        const at = { id, live: !deleted };
        rowsAt.set(reference, [...(rowsAt.get(reference) ?? []), at]);
      }
    }
  }
  return claims.flatMap((claim) => {
    const rows = rowsOf.get(claim.id) ?? [];
    const others = (rowsAt.get(claim.path) ?? []).filter(
      ({ id }) => id !== claim.id
    );
    const holding = holdingOf(
      claim.path,
      rows,
      (reference) => claimsIdAt(app, reference, claim.id),
      others.some(({ live }) => live)
    );
    if (holding !== 'unheld') return [];
    return [{ claim, rowed: rows.length > 0 || others.length > 0 }];
  });
}

/**
 * The path of the item `<table>.parent` names, while a row of it holds one: an
 * article's or a snippet's, deleted short of for good (see `NOT_PURGED`,
 * which the subquery reads with its own `id` and `reference`).
 */
const parentPath = (table: ItemTable) =>
  ['article', 'snippet']
    .map(
      (parent) =>
        `(SELECT reference FROM ${parent} AS p WHERE p.id = ${table}.parent AND ${NOT_PURGED})`
    )
    .join(', ');

/** A row as {@link detailRows} reads it. */
interface DetailRow {
  item_table: ItemTable;
  id: string;
  reference: string;
  deleted: unknown;
  dismissed: unknown;
  due: number | null;
  updated_at: number;
  updated_by: string;
  parent: string | null;
  parent_path: string | null;
  last_review: number | null;
}

/**
 * The rows of every item table that `where` holds for, articles first, then
 * snippets, then cards, with what the user is shown of each (see
 * {@link PathHolder}) and its reference. Its last review is the latest not
 * undone; a card keeps its own.
 * @param where read against each table's own columns, with `params`
 * @throws if the item tables cannot be read
 */
async function detailRows(
  repo: SQLiteRepository,
  where: string,
  params: string[]
): Promise<DetailRow[]> {
  return (await repo.query(
    `SELECT 0 AS rank, 'article' AS item_table, id, reference, deleted, dismissed, due, updated_at, updated_by,
       NULL AS parent, NULL AS parent_path,
       (SELECT MAX(review_time) FROM article_review
        WHERE article_id = article.id AND deleted = FALSE) AS last_review
     FROM article WHERE ${where}
     UNION ALL SELECT 1, 'snippet', id, reference, deleted, dismissed, due, updated_at, updated_by,
       parent, COALESCE(${parentPath('snippet')}),
       (SELECT MAX(review_time) FROM snippet_review
        WHERE snippet_id = snippet.id AND deleted = FALSE)
     FROM snippet WHERE ${where}
     UNION ALL SELECT 2, 'srs_card', id, reference, deleted, dismissed, due, updated_at, updated_by,
       parent, COALESCE(${parentPath('srs_card')}), last_review
     FROM srs_card WHERE ${where}
     ORDER BY rank`,
    params,
    { throwOnError: true }
  )) as unknown as DetailRow[];
}

/**
 * The row whose `reference` is `path`, of any item table, deleted or not, with
 * what the user is shown of it (see {@link PathHolder}): a row for another
 * note can't be added at `path` while it is there, as each table's
 * `reference` is unique, and one in another table would point a second item
 * at the same note. A purged row's reference is no path (see `NOT_PURGED`),
 * so never matches.
 * @throws if the item tables cannot be read
 */
export async function findPathHolder(
  repo: SQLiteRepository,
  path: string
): Promise<PathHolder | null> {
  const [row] = await detailRows(repo, 'reference = $1', [path]);
  return row ? holderOf(row) : null;
}

/**
 * What the user is shown of the row `row` (see {@link PathHolder}).
 */
function holderOf(row: DetailRow): PathHolder {
  return {
    kind: KIND_OF_TABLE[row.item_table],
    id: row.id,
    deleted: Boolean(row.deleted),
    dismissed: Boolean(row.dismissed),
    due: row.due,
    lastReview: row.last_review,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    parent: row.parent ? { id: row.parent, path: row.parent_path } : null,
  };
}

/**
 * What the note at `path` holding the id `id` may be re-associated with (see
 * {@link Plan}).
 * @throws if the item tables cannot be read
 */
export async function findCandidates(
  { app, repo }: Pick<LeftoverDeps, 'app' | 'repo'>,
  path: string,
  id: string
): Promise<Plan> {
  const rows = await detailRows(repo, 'id = $1', [id]);
  const gone = (row: DetailRow) => row.reference === purgedReference(row.id);
  const byId = rows.filter((row) => !gone(row));
  const erased = rows.find(gone);
  // Another table may hold the id at this very path: that row is no holder
  const atPathRows = await detailRows(repo, 'reference = $1 AND id != $2', [
    path,
    id,
  ]);
  // A live row there keeps the path from any row, whatever the tables' rank,
  // and is the one whose note this may be: a deleted one has none
  const atPath = atPathRows.find((row) => !row.deleted) ?? atPathRows[0];
  const holder = atPath ? holderOf(atPath) : null;
  let matched: MatchedRow | null = null;
  const refused: Plan['refused'] = [];
  for (const found of byId) {
    const row: MatchedRow = { ...holderOf(found), reference: found.reference };
    const moving = row.reference !== path;
    const note = moving ? app.vault.getFileByPath(row.reference) : null;
    const why: Refusal | null =
      note && claimOf(app, note)?.id === id
        ? 'copy'
        : moving && holder && !holder.deleted
          ? 'held'
          : null;
    if (why) refused.push({ row, why });
    else matched ??= row;
  }
  const target: Plan['target'] = matched
    ? { by: 'id', row: matched }
    : holder && { by: 'path', row: holder };
  const evicts =
    matched && matched.reference !== path && holder?.deleted ? holder : null;
  return {
    target,
    evicts,
    erase: byId.length === 0 && holder !== null,
    refused,
    purged: erased
      ? {
          kind: KIND_OF_TABLE[erased.item_table],
          id: erased.id,
          erasedAt: erased.updated_at,
          erasedBy: erased.updated_by,
        }
      : null,
  };
}

/** Whether `plan` has anything to offer or refuse: any row at all. */
const hasCandidates = (plan: Plan) =>
  plan.target !== null || plan.refused.length > 0;

/**
 * The failure of saving a note as a new item while `plan` stands, saying
 * which row is in the way: the one it would be re-associated with, else the
 * one it is a copy of.
 */
function failureOfPlan(plan: Plan): LeftoverFailure {
  const { target } = plan;
  if (target?.by === 'path') return { reason: 'held', holder: target.row };
  if (target) return { reason: 'matched', row: target.row, copy: false };
  return { reason: 'matched', row: plan.refused[0].row, copy: true };
}

/**
 * The failure of an action that threw `error`, saying what went wrong: an
 * error's message, or, with none, its name; anything else thrown, as text.
 */
export function failureOf(error: unknown): LeftoverFailure {
  if (!(error instanceof Error))
    return { reason: 'error', message: String(error) };
  const { message, name } = error;
  return { reason: 'error', message: message.trim() ? message : name };
}

/** The short form of the id `id`, as the user is shown it. */
const shortId = (id: string) => id.slice(0, 8);

/**
 * Why `failure` happened, as the user is told: for a held path or id, which
 * row holds it and what to do about it; else the first line of what went
 * wrong, `''` if it says nothing.
 */
export function failureDetail(failure: LeftoverFailure): string {
  if (failure.reason === 'error') {
    // Its first line with any text: a stack, say, can follow
    const line = failure.message.split('\n').find((text) => text.trim());
    return line?.trim() ?? '';
  }
  if (failure.reason === 'purged') {
    const { kind, id } = failure.row;
    return (
      `This note holds the ID of ${kind === 'article' ? 'an' : 'a'} ${kind} that was erased for good, ` +
      `id ${shortId(id)}, so it can't be saved under that ID. ` +
      'Confirm again to import it fresh under a new ID.'
    );
  }
  if (failure.reason === 'matched') {
    const { kind, id, deleted, reference } = failure.row;
    const row =
      `This note holds the ID of ${deleted ? 'a deleted' : 'an existing'} ` +
      `${kind}, id ${shortId(id)}, last at "${reference}". `;
    return failure.copy
      ? `${row}The note there still holds that ID, so this note is a copy of it and can't take its record.`
      : `${row}Confirm again to re-associate this note with it.`;
  }
  const { kind, id, deleted } = failure.holder;
  const short = shortId(id);
  return (
    `Another item's record already points at this note's path: ` +
    `${deleted ? 'a deleted' : 'an existing'} ${kind}, id ${short}. ` +
    'Confirm again to re-associate this note with it or erase it, ' +
    'or move this note to save it as a new item.'
  );
}

/**
 * Every leftover in the vault, by the metadata cache: to be read once it has
 * settled, and once the moved-note scan has pointed every row it could at its
 * note.
 * @throws if the item tables cannot be read
 */
export async function findLeftovers(
  deps: Pick<LeftoverDeps, 'app' | 'repo'>
): Promise<Leftover[]> {
  const { app } = deps;
  const claims = app.vault.getMarkdownFiles().flatMap((file) => {
    const claim = claimOf(app, file);
    return claim ? [{ file, path: file.path, ...claim }] : [];
  });
  const leftovers: Leftover[] = [];
  for (const { claim, rowed } of await leftoverClaims(deps, claims)) {
    const { file, id, type } = claim;
    const leftover: Leftover = { file, id, ...placeOf(file.path, type) };
    // Looked up only for the few whose id or path a row holds
    const { target } = rowed
      ? await findCandidates(deps, file.path, id)
      : { target: null };
    if (target?.by === 'id') {
      leftover.match = target.row;
      leftover.type = target.row.kind;
    } else if (target) {
      leftover.holder = target.row;
      // A note of no type of its own starts as the type of the row whose
      // place it took, which the user may change, saving it as a new item;
      // never a card, which a note of no type is no card's note as: only
      // Re-associate makes it the card's, whatever type it is saved as
      if (target.row.kind !== 'card') leftover.type ??= target.row.kind;
    }
    leftovers.push(leftover);
  }
  return leftovers;
}

/**
 * What the user may do with `leftover`: give it a row (`adopt`), and, for a
 * note the plugin made, move it to the trash, or, for the user's own note,
 * take the plugin's `ir-id` and type tag off it (`strip`). Whatever its type,
 * known or not: one of no known type is adopted as the type the user chooses.
 * One of no known type the plugin made may also be stripped, to keep it as a
 * plain note.
 */
export function actionsFor(leftover: Leftover): LeftoverAction[] {
  if (leftover.kind !== 'made') return ['adopt', 'strip'];
  return leftover.type ? ['adopt', 'trash'] : ['adopt', 'strip', 'trash'];
}

/** What the user is told of `leftovers`, in one notice. */
export function leftoversMessage(leftovers: readonly Leftover[]): string {
  const count = leftovers.length;
  return count === 1
    ? 'Incremental reading: 1 note was not found in the database.'
    : `Incremental reading: ${count} notes were not found in the database.`;
}

/**
 * Give the note `file` a row as an item of `type` with `id`. The note gets the
 * type's tag first, in place of any other item type's. One typed by its folder
 * alone, or of no type, has none, and the tag is what Obsidian's tag search
 * shows an item's note by and what lets the note take its row along when it
 * is renamed from a path the row doesn't name (see
 * `ReviewManager.handleExternalRename`). One the user chose to keep as another
 * type than its tag names (a card kept as a snippet, say) would read as the old
 * type. The row comes last, as it commits the adoption, and a note left tagged
 * by a failed one is still a leftover.
 */
async function adopt(
  deps: LeftoverDeps,
  file: TFile,
  id: string,
  type: NoteType
): Promise<void> {
  const tag = TAG_OF[type];
  const others = Object.values(TAG_OF).filter((t) => t !== tag);
  const isOther = (entry: unknown) =>
    others.some((other) => isTag(entry, other));
  // Decided on the note as the write reads it: the metadata cache may not
  // have caught up with an edit made a moment ago
  await Obsidian.updateFrontMatterIfNeeded(
    file,
    (frontmatter) => {
      if (
        hasTag(frontmatter, tag) &&
        !others.some((other) => hasTag(frontmatter, other))
      ) {
        return false;
      }
      // Where Obsidian reads tags from, which is where it reads the others
      const key = tagsKeyOf(frontmatter);
      const entries = tagEntries(frontmatter[key]);
      const kept = entries.filter((entry) => !isOther(entry));
      frontmatter[key] = withTag(
        kept.length < entries.length ? kept : frontmatter[key],
        tag
      );
      return true;
    },
    deps.app as App
  );
  await adoptRow(deps, file, id, type);
}

/** Add the row of the note `file` as an item of `type` with `id`. */
async function adoptRow(
  deps: LeftoverDeps,
  file: TFile,
  id: string,
  type: NoteType
): Promise<void> {
  if (type === 'article') await deps.articles.adoptLeftover(file, id);
  else if (type === 'snippet') await deps.snippets.adoptLeftover(file, id);
  else await deps.cards.adoptLeftover(file, id);
}

/**
 * Give the note `file` a row as a new item of `type` under a fresh id, written
 * into it in place of its own with the type's tag in place of any other item
 * type's, as a fresh import does: for a note whose path an erased row held,
 * whose own id is no item's to keep, and may be one a row deleted for good
 * keeps; or one whose own id only a row deleted for good holds (see
 * {@link resolvePurged}). A row that can't be saved puts the note's id and
 * tags back as they were, so it is the same leftover still.
 * @throws what the note's or the row's write threw, once undone
 */
async function adoptFresh(
  deps: LeftoverDeps,
  file: TFile,
  type: NoteType
): Promise<void> {
  const id = crypto.randomUUID();
  const tag = TAG_OF[type];
  const others = Object.values(TAG_OF).filter((other) => other !== tag);
  await withCompensation(async (step) => {
    await step(
      () =>
        Obsidian.updateFrontMatterUndoably(
          file,
          { 'ir-id': id, tags: tag },
          deps.app as App,
          (frontmatter) => stripFrontmatterTags(frontmatter, others)
        ),
      (undo) => undo()
    );
    await adoptRow(deps, file, id, type);
  });
}

/**
 * Whether `leftover` is one still: its note where it was, holding the same id,
 * which no live row at its path holds, and no copy (see {@link leftoverClaims}).
 */
async function isLeftover(
  deps: Pick<LeftoverDeps, 'app' | 'repo'>,
  { file, id }: Leftover
): Promise<boolean> {
  const { app } = deps;
  const claim =
    app.vault.getFileByPath(file.path) === file ? claimOf(app, file) : null;
  return (
    claim?.id === id &&
    (await leftoverClaims(deps, [{ path: file.path, id }])).length === 1
  );
}

/**
 * Do `action` to `leftover`, unless it is no leftover any more: its note gone,
 * changed to hold another id, or given a row meanwhile, by Sync bringing the
 * database, say. Says so when it fails, or when writes are refused.
 * @param as for `adopt`, the type to keep it as, the user's choice: by
 *   default the one it was made as; with neither, it isn't adopted
 * Adopting a note whose id or path another row holds asks the user what to
 * do about that row, when `deps.conflicts` can (see {@link resolveHeld}); else
 * it fails before anything is written, saying which row (see
 * {@link findCandidates}).
 * @returns whether it was done, and why not when it failed
 */
export async function resolveLeftover(
  deps: LeftoverDeps,
  leftover: Leftover,
  action: LeftoverAction,
  as: NoteType | null = leftover.type
): Promise<LeftoverOutcome> {
  const { app, repo } = deps;
  const { file, id } = leftover;
  // A note of no known type is adopted only as a type the user chose
  if (action === 'adopt' && !as) return { done: false };
  const what = DOING[action](`"${file.basename}"`);
  if (await refusedWrite(repo, what)) return { done: false };
  try {
    if (!(await isLeftover(deps, leftover))) return { done: false };
    const plan =
      action === 'adopt' ? await findCandidates(deps, file.path, id) : null;
    if (plan && as && hasCandidates(plan)) {
      return await resolveHeld(deps, leftover, plan, as);
    }
    if (plan?.purged && as) {
      return await resolvePurged(deps, leftover, plan, plan.purged, as);
    }
    if (action === 'trash') {
      await app.fileManager.trashFile(file);
    } else if (action === 'strip') {
      await Obsidian.updateFrontMatter(
        file,
        (frontmatter) => {
          delete frontmatter['ir-id'];
          // Every item type's tag: one typed by the row holding its id may
          // carry another type's. A note typed by its folder alone has no
          // type tag to take off, and its tags are left as they are
          const typeTags = Object.values(TAG_OF);
          const isTypeTag = (tag: unknown) =>
            typeTags.some((typeTag) => isTag(tag, typeTag));
          // Off the key Obsidian reads tags from; one dropped for holding
          // nothing else hands that role to the next, so on to that one
          while (typeTags.some((typeTag) => hasTag(frontmatter, typeTag))) {
            const key = tagsKeyOf(frontmatter);
            const kept = tagEntries(frontmatter[key]).filter(
              (tag) => !isTypeTag(tag)
            );
            if (kept.length > 0) frontmatter[key] = kept;
            else delete frontmatter[key];
          }
        },
        app as App
      );
    } else if (as) {
      await adopt(deps, file, id, as);
    }
    return { done: true };
  } catch (error) {
    console.error(error);
    return failed(what, failureOf(error));
  }
}

/** Whether `a` and `b` offer the same, as the user would be shown it. */
const samePlan = (a: Plan, b: Plan) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Adopt `leftover` as `as`, though rows hold its id or its note's path, as
 * `plan` offers and the user chooses (see `conflicts.ask`): make the note
 * the target row's note, keeping its schedule and history (`reassociate`: see
 * `ArticleManager.reassociateNote`), a row from elsewhere coming to the
 * note's path, and hand it the parentless snippets and cards taken from the
 * note, unless it is a card; or, where offered, erase the row at its path
 * for good and save the note as a new item of `as`, under a fresh id
 * (`erase`: see {@link adoptFresh}); or neither, which writes nothing and
 * fails saying which row is in the way, saying nothing more. With no target, it fails at once, saying
 * why. The plan itself is passed to `ask` only where it offers more than the
 * row at the path, or other than it (see {@link Plan.erase}).
 *
 * The user may take a while to choose, so before writing anything, checks
 * again that saving is allowed, that the note is still a leftover, and that
 * the rows holding its id and path are still as they were shown; any changed
 * meanwhile is refused, saying so.
 */
async function resolveHeld(
  deps: LeftoverDeps,
  leftover: Leftover,
  plan: Plan,
  as: NoteType
): Promise<LeftoverOutcome> {
  const { repo, conflicts } = deps;
  const { file } = leftover;
  const what = DOING.adopt(`"${file.basename}"`);
  const held = failureOfPlan(plan);
  const { target } = plan;
  if (!conflicts || !target) {
    if (!conflicts) {
      console.warn(
        `Incremental Reading - can't ${what}: another row holds its id or path`,
        target?.row ?? plan
      );
    }
    return failed(what, held);
  }
  const choice = plan.erase
    ? await conflicts.ask(file, target.row)
    : await conflicts.ask(file, target.row, plan);
  if (!choice) return { done: false, canceled: true };
  // Erasing is offered for a row at the path only (see `Plan.erase`)
  if (choice === 'erase' && !plan.erase) return { done: false, failure: held };
  if (await refusedWrite(repo, what)) return { done: false };
  if (!(await isLeftover(deps, leftover))) return { done: false };
  const now = await findCandidates(deps, file.path, leftover.id);
  if (!samePlan(now, plan)) {
    const which = target.by === 'id' ? 'holding its ID' : 'at its path';
    Obsidian.notify(
      `Nothing was done to "${file.basename}": the ${target.row.kind} ${which} changed while you chose. Confirm again to see it as it is now.`,
      { kind: 'error' }
    );
    return hasCandidates(now)
      ? { done: false, failure: failureOfPlan(now) }
      : { done: false };
  }
  const holder = target.row;
  const table = TABLE_OF_KIND[holder.kind];
  if (choice === 'erase') {
    await conflicts.purge(table, holder.id);
    await adoptFresh(deps, file, as);
    return { done: true };
  }
  if (target.by === 'id') {
    // From where the row last had its note: the note's path, for one whose
    // note came back to it
    await deps.articles.reassociateNote(
      file,
      table,
      holder.id,
      target.row.reference
    );
  } else {
    await deps.articles.reassociateNote(file, table, holder.id);
  }
  // Nothing is ever taken from a card
  if (holder.kind !== 'card') {
    try {
      await deps.articles.claimInPlace(file, holder.id);
    } catch (error) {
      console.error(error);
      Obsidian.notify(
        `"${file.basename}" is the ${holder.kind}'s note again, but the snippets and cards taken from it couldn't be adopted`,
        { kind: 'error', persist: true }
      );
    }
  }
  return { done: true };
}

/**
 * Import `leftover` fresh as `as`, though its id is held by `purged`, a row
 * deleted for good, as `plan` has it, should the user choose to (see
 * `conflicts.askFresh`): a new id in the note, and a new row (see
 * {@link adoptFresh}). The row deleted for good is never written. With no
 * answer, writes nothing and says nothing, answering that the user backed
 * out; with no way to ask, fails at once, saying why.
 *
 * The user may take a while to choose, so before writing anything, checks
 * again that saving is allowed, that the note is still a leftover, and that
 * nothing but that row holds its id or its path; if any changed meanwhile,
 * it is refused, saying so.
 */
async function resolvePurged(
  deps: LeftoverDeps,
  leftover: Leftover,
  plan: Plan,
  purged: PurgedRow,
  as: NoteType
): Promise<LeftoverOutcome> {
  const { repo } = deps;
  const { file } = leftover;
  const what = DOING.adopt(`"${file.basename}"`);
  const askFresh = deps.conflicts?.askFresh;
  if (!askFresh) return failed(what, { reason: 'purged', row: purged });
  if (!(await askFresh(file, purged, as)))
    return { done: false, canceled: true };
  if (await refusedWrite(repo, what)) return { done: false };
  if (!(await isLeftover(deps, leftover))) return { done: false };
  const now = await findCandidates(deps, file.path, leftover.id);
  if (!samePlan(now, plan)) {
    Obsidian.notify(
      `Nothing was done to "${file.basename}": a row came to hold its ID or its path while you chose. Confirm again to see it as it is now.`,
      { kind: 'error' }
    );
    return hasCandidates(now)
      ? { done: false, failure: failureOfPlan(now) }
      : { done: false };
  }
  await adoptFresh(deps, file, as);
  return { done: true };
}

/** Tell the user doing `what` failed, and why, and answer so. */
function failed(what: string, failure: LeftoverFailure): LeftoverOutcome {
  const detail = failureDetail(failure);
  Obsidian.notify(`Couldn't ${what}${detail ? `. ${detail}` : ''}`, {
    kind: 'error',
  });
  return { done: false, failure };
}
