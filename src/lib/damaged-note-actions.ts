import type { ArticleManager } from '#/lib/items/ArticleManager';
import { claimedId, heldClaim } from '#/lib/items/note-holding';
import { supportsFrontmatter } from '#/lib/mime';
import {
  normalizePath,
  type FileManager,
  type MetadataCache,
  type Vault,
  type WorkspaceLeaf,
} from 'obsidian';
import { claimsIdentity } from './ir-id-watch';
import { TAG_BY_TABLE, tagsKeyOf, withTag } from './item-tags';
import {
  holdersOf,
  ITEM_TABLES,
  PARAM_BATCH,
  type Holder,
  type ItemTable,
} from './moved-note-scan';
import { refusedAction } from './readiness';
import { stripFrontmatterTags } from './tags';
import type { SQLiteRepository } from './types';

/** A live item row, reduced to what tells which note it is the row of. */
export interface LiveRow {
  table: ItemTable;
  id: string;
  /** Where the row says its note is. */
  reference: string;
}

/**
 * A live row a note no row holds could be re-associated with (see
 * {@link mismatchOf}).
 */
export interface Candidate extends LiveRow {
  /**
   * `path`: the row is at the note's path, and Re-associate writes its id
   * into the note; `id`: it holds the id the note claims and points
   * elsewhere, and Re-associate brings it to the note's path.
   */
  by: 'path' | 'id';
  /**
   * Why Re-associate can't bring an `id` row to the note, if it can't: a file
   * is where the row points (`occupied`), its own note there or one that
   * could be, of which this note may be a copy; or a live row holds the
   * note's path (`held`), which the row would have to take. Null when it can,
   * and always for a `path` row.
   */
  blocked: 'occupied' | 'held' | null;
}

/**
 * The rows the note at `path`, claiming `claim` (see `heldClaim`; null for
 * none), could be re-associated with, out of `rows`, live rows of any table:
 * those at its path, then those holding its claim elsewhere, each with what
 * blocks it, by `fileAt`, whether the vault holds a file at a path (see
 * {@link Candidate}). Null when the note is no row's to re-associate: a row
 * at its path holds its claim, which makes it that row's note; or none is at
 * its path and none holding its claim could come to it, as for a copy, a
 * plain note, or a leftover (see `crash-leftovers`).
 */
export function mismatchOf(
  path: string,
  claim: string | null,
  rows: readonly LiveRow[],
  fileAt: (reference: string) => boolean
): Candidate[] | null {
  const atPath = rows.filter((row) => row.reference === path);
  if (atPath.some((row) => row.id === claim)) return null;
  const byPath = atPath.map(
    (row): Candidate => ({ ...row, by: 'path', blocked: null })
  );
  const byId = rows
    .filter(
      (row) => claim !== null && row.id === claim && row.reference !== path
    )
    .map(
      (row): Candidate => ({
        ...row,
        by: 'id',
        blocked: fileAt(row.reference)
          ? 'occupied'
          : byPath.length > 0
            ? 'held'
            : null,
      })
    );
  if (byPath.length === 0 && !byId.some((row) => row.blocked === null)) {
    return null;
  }
  return [...byPath, ...byId];
}

/** A note no live row holds by both its path and its `ir-id`, as it is now. */
export interface DamagedNote {
  path: string;
  /**
   * The table of the live row at its path, which is the kind of item it is;
   * with none, that of the row holding its id.
   */
  table: ItemTable;
  /**
   * `removed` when the note claims no id at all, `changed` when it claims one
   * the live row at its path doesn't hold, `moved` when no live row is at its
   * path and the row holding its id points where no file is.
   */
  change: 'removed' | 'changed' | 'moved';
  /**
   * Whether Restore can give it its id back: one live row, and only one, sits
   * at its path. Two (rows of different tables sharing the path) leave no way
   * to tell which id was the note's.
   */
  restorable: boolean;
  /** The rows it could be re-associated with (see {@link mismatchOf}). */
  candidates: Candidate[];
}

export interface DamagedNoteActionsDeps {
  repo: Pick<
    SQLiteRepository,
    'query' | 'readiness' | 'onReadinessChange' | 'writeRefusal'
  >;
  vault: Pick<Vault, 'getFileByPath'>;
  metadataCache: Pick<MetadataCache, 'getFileCache'>;
  fileManager: Pick<FileManager, 'processFrontMatter'>;
  workspace: {
    getLeaf(newLeaf?: boolean): Pick<WorkspaceLeaf, 'openFile'>;
  };
  /** What makes a note a row's note (see `ArticleManager.reassociateNote`). */
  reassociateNote: ArticleManager['reassociateNote'];
  /**
   * Told once a note at `path` is made a row's note by Re-associate, for what
   * shows items and notes to be refreshed.
   */
  onRepaired: (path: string) => unknown;
}

export interface DamagedNoteActions {
  /**
   * What became of the `ir-id` of each note at `paths` by now, in the order
   * given. A note whole again, gone, mid-parse, a file with no frontmatter,
   * or one no live row could be re-associated with (a copy, a plain note) is
   * left out.
   */
  describe(paths: readonly string[]): Promise<DamagedNote[]>;
  /**
   * Whether a note is at `path` that the metadata cache has not read yet, as
   * one just made, or just come over Sync, is: {@link describe} passes over
   * it, as over a note mid-parse.
   */
  unread(path: string): boolean;
  /**
   * Make the note at `path` the note of `candidate`, one of the rows
   * {@link describe} lists for it with nothing blocking it: write a `path`
   * row's id and type tag into it, or bring an `id` row to its path, as the
   * item layer does either (see `ArticleManager.reassociateNote`). Answers
   * false, writing nothing, when the note is gone or mid-parse, when the row
   * is no longer offered for it so, or when writes are refused.
   * @throws what the write threw
   */
  reassociate(path: string, candidate: Candidate): Promise<boolean>;
  /**
   * Give the note at `path` back the `ir-id` of the one live row at its path,
   * and that row's type tag in place of any other type's, as making the item
   * would have (see {@link reassociatedFrontmatter}). Answers whether the note
   * carries that id now (written now, or there already), and false, writing
   * nothing, when no single live row sits at its path (a copy, a plain note),
   * when the note is gone or mid-parse, or when writes are refused. Tells
   * `onRepaired` of a note it wrote, or found written since the cache last
   * read it.
   */
  restore(path: string): Promise<boolean>;
  /** Open the note at `path` in the current tab; false when it is gone. */
  open(path: string): Promise<boolean>;
}

/**
 * Write into `frontmatter`, which `processFrontMatter` hands out, the `ir-id`
 * of the row `{ table, id }` and its type tag, taking off any other item
 * type's tag (which would read the note as that type), every other tag and
 * property kept: what an explicit re-association writes, as
 * `ArticleManager`'s re-association of a snippet or card does.
 */
export function reassociatedFrontmatter(
  frontmatter: Record<string, unknown>,
  { table, id }: Pick<Holder, 'table' | 'id'>
): void {
  const tag = TAG_BY_TABLE[table];
  stripFrontmatterTags(
    frontmatter,
    Object.values(TAG_BY_TABLE).filter((typeTag) => typeTag !== tag)
  );
  // Where Obsidian reads tags from, or the note would still read as untagged
  const key = tagsKeyOf(frontmatter);
  frontmatter[key] = withTag(frontmatter[key], tag);
  frontmatter['ir-id'] = id;
}

/**
 * What the damaged-notes notice needs to say about a reported note, and its
 * Open and Restore buttons. A note is judged as the watch that reported it
 * judges it (`readsAsTampering`), so the two can't disagree about it.
 */
export function createDamagedNoteActions({
  repo,
  vault,
  metadataCache,
  fileManager,
  workspace,
  reassociateNote,
  onRepaired,
}: DamagedNoteActionsDeps): DamagedNoteActions {
  /** The live rows at `path`, as the database holds them now. */
  const liveAt = async (path: string) =>
    ((await holdersOf(repo, [path])).get(path) ?? []).filter(
      (holder) => !holder.deleted
    );

  /** The live rows of every table holding any of `ids`, in table order. */
  const liveHolding = async (ids: readonly string[]): Promise<LiveRow[]> => {
    const rows: LiveRow[] = [];
    for (const table of ITEM_TABLES) {
      for (let i = 0; i < ids.length; i += PARAM_BATCH) {
        const batch = ids.slice(i, i + PARAM_BATCH);
        const held = (await repo.query(
          `SELECT id, reference FROM ${table}
           WHERE deleted = FALSE AND id IN (${batch.map((_, n) => `$${n + 1}`).join(', ')})`,
          batch
        )) as unknown as { id: string; reference: string }[];
        for (const { id, reference } of held)
          rows.push({ table, id, reference });
      }
    }
    return rows;
  };

  const describe = async (paths: readonly string[]) => {
    const found = paths.flatMap((path) => {
      const file = vault.getFileByPath(normalizePath(path));
      // Null while the cache is part way through re-reading the note, which
      // would read as a note with no frontmatter
      const cache = file ? metadataCache.getFileCache(file) : null;
      // A file with no frontmatter is the row at its path by having nowhere
      // to claim an id in
      if (!file || !cache || !supportsFrontmatter(file)) return [];
      const irId: unknown = cache.frontmatter?.['ir-id'];
      return [
        { path, irId, claim: heldClaim(file, { metadataCache }) ?? null },
      ];
    });
    if (found.length === 0) return [];
    const holders = await holdersOf(
      repo,
      found.map(({ path }) => path)
    );
    const claims = [
      ...new Set(found.flatMap(({ claim }) => (claim === null ? [] : [claim]))),
    ];
    const holding = claims.length > 0 ? await liveHolding(claims) : [];
    return found.flatMap(({ path, irId, claim }): DamagedNote[] => {
      const atPath = (holders.get(path) ?? [])
        .filter((holder) => !holder.deleted)
        .map(({ table, id }) => ({ table, id, reference: path }));
      const candidates = mismatchOf(
        path,
        claim,
        [...atPath, ...holding.filter((row) => row.id === claim)],
        (reference) => vault.getFileByPath(reference) !== null
      );
      if (!candidates) return [];
      const byPath = candidates.filter((row) => row.by === 'path');
      return [
        {
          path,
          table: (byPath[0] ?? candidates[0]).table,
          change:
            byPath.length === 0
              ? 'moved'
              : claimsIdentity(irId)
                ? 'changed'
                : 'removed',
          restorable: byPath.length === 1,
          candidates,
        },
      ];
    });
  };

  /** `candidate`, as {@link describe} offers it for the note at `path` now. */
  const offered = async (path: string, candidate: Candidate) => {
    const [note] = await describe([path]);
    return note?.candidates.find(
      (row) =>
        row.by === candidate.by &&
        row.table === candidate.table &&
        row.id === candidate.id &&
        row.blocked === null
    );
  };

  return {
    describe,

    unread(path) {
      const file = vault.getFileByPath(normalizePath(path));
      return file !== null && !metadataCache.getFileCache(file);
    },

    async reassociate(path, candidate) {
      const file = vault.getFileByPath(normalizePath(path));
      if (!file || !(await offered(path, candidate))) return false;
      // A merge under way may be bringing a database that moves the row
      if (await refusedAction(repo, `re-associate "${file.name}"`)) {
        return false;
      }
      // Read again past the wait: the row is where it is brought from
      const row = await offered(path, candidate);
      if (!row) return false;
      await reassociateNote(
        file,
        row.table,
        row.id,
        row.by === 'id' ? row.reference : file.path
      );
      onRepaired(path);
      return true;
    },

    async restore(path) {
      const file = vault.getFileByPath(normalizePath(path));
      const cache = file ? metadataCache.getFileCache(file) : null;
      if (!file || !cache) return false;
      const before = await liveAt(path);
      if (before.length !== 1) return false;
      if (claimedId(cache.frontmatter?.['ir-id']) === before[0].id) {
        return true;
      }
      // A merge under way may be bringing a database that moves the row
      if (await refusedAction(repo, `restore the ir-id of "${file.name}"`)) {
        return false;
      }
      // Read again past the wait: the row is what the note is given the id of
      const live = await liveAt(path);
      if (live.length !== 1) return false;
      const [row] = live;

      let carries = false;
      await fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          // The file as it is now, which the cache may not have caught up
          // with: put back already, there is nothing to write
          carries = true;
          if (claimedId(frontmatter['ir-id']) === row.id) return;
          reassociatedFrontmatter(frontmatter, row);
        }
      );
      if (carries) onRepaired(path);
      return carries;
    },

    async open(path) {
      const file = vault.getFileByPath(normalizePath(path));
      if (!file) return false;
      await workspace.getLeaf(false).openFile(file);
      return true;
    },
  };
}
