import type IncrementalReadingPlugin from '#/main';
import type { App, TFile } from 'obsidian';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import { extensionOfPath, getMimeType, supportsFrontmatter } from './mime';
import {
  ITEM_TABLES,
  type ItemTable,
  type RowId,
  evictedSpot,
} from './moved-note-scan';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import type { NoteType, SQLiteRepository } from './types';

/**
 * Pointing an item that lost its file back at one. "Missing" is never stored:
 * an item is missing while no file is at its `reference`, and relinking it is
 * only a matter of changing that reference. Snippets and cards name their
 * parent by id, so an item's children follow it without being touched, and its
 * review history hangs off its id too.
 */

/** What relinking needs of a file: where it is and what type it is. */
export type RelinkFile = Pick<TFile, 'path' | 'extension'>;

/**
 * What relinking reads of the vault, as callbacks, so the decisions below can
 * be made (and tested) apart from Obsidian.
 */
export interface RelinkVault<F extends RelinkFile = RelinkFile> {
  /** The `ir-id` a note's frontmatter carries, if any. */
  irIdOf(file: F): string | undefined;
  /** The item table a note's tags put it in, if any. */
  taggedTableOf(file: F): ItemTable | null;
  /** Whether a file is at `path`. */
  hasFileAt(path: string): boolean;
}

/** What the other live items hold: their files' paths and their ids. */
export interface Claims {
  paths: ReadonlySet<string>;
  ids: ReadonlySet<string>;
}

/** Why a file can't be an item's: see {@link unavailability}. */
export type Unavailable = 'taken' | 'tagged';

export type RelinkResult =
  | { ok: true; from: string }
  | {
      ok: false;
      reason: 'no-row' | 'not-missing' | 'wrong-type' | Unavailable;
    };

const TAG_BY_TABLE: Readonly<Record<ItemTable, string>> = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  srs_card: CARD_TAG,
};

/** The table rows of item type `type` live in. */
export function tableOf(type: NoteType): ItemTable {
  return type === 'card' ? 'srs_card' : type;
}

/**
 * The MIME type of the file that was at `reference`, going by the extension it
 * names, since there is no file left there to ask.
 */
function mimeTypeOfReference(reference: string): string | null {
  return getMimeType({ extension: extensionOfPath(reference) });
}

/**
 * Whether `file` already belongs to another live item: one holds its path, or
 * its note carries one's `ir-id`, which is what makes a note an item's own.
 * Tombstones claim nothing, having no file of their own left.
 */
export function isClaimed<F extends RelinkFile>(
  file: F,
  claims: Claims,
  irIdOf: RelinkVault<F>['irIdOf']
): boolean {
  if (claims.paths.has(file.path)) return true;
  const irId = irIdOf(file);
  return irId !== undefined && claims.ids.has(irId);
}

/**
 * Why `file` can't become `row`'s, or `null` when it can: another live item
 * claims it (see {@link isClaimed}), or its note is tagged as another kind of
 * item. Relinking adds the row's tag, and a note with two kinds' tags is read
 * as whichever comes first, so it would not stay this row's.
 */
export function unavailability<F extends RelinkFile>(
  row: RowId,
  file: F,
  claims: Claims,
  vault: Pick<RelinkVault<F>, 'irIdOf' | 'taggedTableOf'>
): Unavailable | null {
  if (isClaimed(file, claims, (f) => vault.irIdOf(f))) return 'taken';
  const tagged = vault.taggedTableOf(file);
  if (tagged !== null && tagged !== row.table) return 'tagged';
  return null;
}

/**
 * The files an item last at `oldReference` can be relinked to: those of the
 * same MIME type that are not `unavailable`, in the order given. None for a
 * reference whose type this plugin doesn't know.
 */
export function relinkCandidates<F extends RelinkFile>(
  files: readonly F[],
  oldReference: string,
  unavailable: (file: F) => boolean
): F[] {
  const type = mimeTypeOfReference(oldReference);
  if (type === null) return [];
  return files.filter(
    (file) => getMimeType(file) === type && !unavailable(file)
  );
}

/** Every live row's path and id, bar `own`'s. */
export async function readClaims(
  repo: SQLiteRepository,
  own: RowId
): Promise<Claims> {
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const table of ITEM_TABLES) {
    const rows = (await repo.query(
      `SELECT id, reference FROM ${table} WHERE deleted = 0`
    )) as unknown as { id: string; reference: string }[];
    for (const { id, reference } of rows) {
      if (table === own.table && id === own.id) continue;
      paths.add(reference);
      ids.add(id);
    }
  }
  return { paths, ids };
}

/**
 * Point `row` at `target`, refusing a target of another type or one that is
 * unavailable to it (see {@link unavailability}). A tombstone standing on the
 * path gives it up, parked where `moved-note-scan` parks the ones it evicts.
 *
 * Only a missing row is relinked: a live one with no file at its reference.
 * A tombstone is an item whose file was deleted, not lost, and stays out of
 * review. One whose file has come back since the picker opened (Sync
 * delivering it late, say) is refused too, or that file would be left behind
 * with the item's `ir-id` while another took its place.
 *
 * Everything is read inside the transaction, so nothing written since the
 * picker listed the target can be overwritten. Writes nothing to the file: a
 * note's `ir-id` is the caller's to add once the row is in place.
 */
export async function relinkRow<F extends RelinkFile>(
  repo: SQLiteRepository,
  row: RowId,
  target: F,
  vault: RelinkVault<F>
): Promise<RelinkResult> {
  return repo.transaction(async (): Promise<RelinkResult> => {
    const [current] = (await repo.query(
      `SELECT reference FROM ${row.table} WHERE id = $1 AND deleted = 0`,
      [row.id]
    )) as unknown as { reference: string }[];
    if (!current) return { ok: false, reason: 'no-row' };
    if (vault.hasFileAt(current.reference)) {
      return { ok: false, reason: 'not-missing' };
    }

    const type = mimeTypeOfReference(current.reference);
    if (type === null || getMimeType(target) !== type) {
      return { ok: false, reason: 'wrong-type' };
    }
    const unavailable = unavailability(
      row,
      target,
      await readClaims(repo, row),
      vault
    );
    if (unavailable) return { ok: false, reason: unavailable };

    // `reference` is UNIQUE per table, and only a tombstone can still be
    // holding it here: a live row would have claimed the target above
    const [tombstone] = (await repo.query(
      `SELECT id FROM ${row.table} WHERE reference = $1 AND id != $2`,
      [target.path, row.id]
    )) as unknown as { id: string }[];
    if (tombstone) {
      await repo.mutate(
        `UPDATE ${row.table} SET reference = $1 WHERE id = $2`,
        [evictedSpot({ table: row.table, id: tombstone.id }), tombstone.id]
      );
    }
    await repo.mutate(`UPDATE ${row.table} SET reference = $1 WHERE id = $2`, [
      target.path,
      row.id,
    ]);
    return { ok: true, from: current.reference };
  });
}

/**
 * A note's frontmatter `tags`, whether written as a list or a single string.
 * Only ever searched for an item tag, so a list's other entries, whatever
 * they are, are left as they come.
 */
function tagsOf(frontmatter: Record<string, unknown> | undefined): unknown[] {
  const tags = frontmatter?.tags;
  if (Array.isArray(tags)) return tags as unknown[];
  return typeof tags === 'string' ? tags.split(/[\s,]+/) : [];
}

/**
 * The vault as relinking reads it: notes' `ir-id` and tags from the metadata
 * cache, and files by path. A file without frontmatter has neither id nor tags,
 * and is never asked.
 */
export function vaultReader(app: App): RelinkVault<TFile> {
  const frontmatterOf = (file: TFile) =>
    supportsFrontmatter(file)
      ? (app.metadataCache.getFileCache(file)?.frontmatter as
          | Record<string, unknown>
          | undefined)
      : undefined;
  return {
    irIdOf: (file) => {
      const irId = frontmatterOf(file)?.['ir-id'];
      return typeof irId === 'string' ? irId : undefined;
    },
    taggedTableOf: (file) => {
      const tags = tagsOf(frontmatterOf(file));
      return (
        ITEM_TABLES.find((table) => tags.includes(TAG_BY_TABLE[table])) ?? null
      );
    },
    hasFileAt: (path) => Obsidian.getNote(path, app) !== null,
  };
}

/**
 * Reload the highlights of snippet `snippetId`'s parent, whose cached copy
 * still names the snippet's old path. Only the parent: a full reload would
 * throw away highlight moves other notes have not saved yet. A failure here
 * leaves the relink standing, and the parent catches up when next opened.
 */
async function reloadParentHighlights(
  plugin: IncrementalReadingPlugin,
  snippetId: string
) {
  const { app, reviewManager } = plugin;
  const { snippets } = reviewManager;
  try {
    const snippet = await snippets.findById(snippetId);
    const parentId = (snippet?.row as { parent?: string | null } | undefined)
      ?.parent;
    if (!parentId) return;
    const parent = await snippets.findById(parentId);
    const parentFile = parent && Obsidian.getNote(parent.row.reference, app);
    if (!parentFile) return;
    const highlights = await snippets.getHighlights(parentFile);
    snippets.offsetTracker.loadHighlights(parentFile.path, highlights);
    app.workspace.trigger('ir-highlights-changed', parentFile.path);
  } catch (error) {
    console.error(error);
  }
}

function refusal(
  reason: Exclude<RelinkResult, { ok: true }>['reason'],
  target: TFile
) {
  switch (reason) {
    case 'no-row':
      return 'The item no longer exists';
    case 'not-missing':
      return 'The item has its file again; nothing to relink';
    case 'wrong-type':
      return `"${target.path}" is not the same type of file as the item`;
    case 'taken':
      return `"${target.path}" already belongs to another item`;
    case 'tagged':
      return `"${target.path}" is tagged as another kind of item`;
  }
}

/**
 * Relink `row` to `target` (see {@link relinkRow}), then make the file the
 * item's own: a note gains the item's `ir-id` and tag, so the note is known as
 * the item's by the same frontmatter every other note is; a file with no
 * frontmatter, a PDF, is the item's by its path alone and is left untouched.
 * Highlights of the item's snippets move with it, and a snippet's own highlight
 * in its parent is reloaded to name its new path. The user hears how it went.
 *
 * The row is relinked even if the note's frontmatter can't be written
 * (malformed YAML, say): the note is at the row's reference either way, and a
 * review fetch puts the id back once it can.
 */
export async function relinkItem(
  plugin: IncrementalReadingPlugin,
  row: RowId,
  target: TFile
): Promise<RelinkResult> {
  const { app, reviewManager } = plugin;
  const result = await relinkRow(
    reviewManager.repo,
    row,
    target,
    vaultReader(app)
  );
  if (!result.ok) {
    Obsidian.notify(refusal(result.reason, target));
    return result;
  }

  let notice = `Relinked to "${target.path}"`;
  try {
    await Obsidian.updateFrontMatter(
      target,
      { 'ir-id': row.id, tags: TAG_BY_TABLE[row.table] },
      app
    );
  } catch (error) {
    console.error(error);
    notice += `, but its frontmatter could not be updated`;
  }
  reviewManager.snippets.offsetTracker.renameFile(result.from, target.path);
  app.workspace.trigger('ir-highlights-changed', target.path);
  if (row.table === 'snippet') await reloadParentHighlights(plugin, row.id);
  Obsidian.notify(notice);
  return result;
}
