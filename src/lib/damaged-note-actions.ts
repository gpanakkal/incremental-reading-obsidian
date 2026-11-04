import {
  normalizePath,
  type FileManager,
  type MetadataCache,
  type Vault,
  type WorkspaceLeaf,
} from 'obsidian';
import { claimsIdentity, readsAsTampering } from './ir-id-watch';
import { TAG_BY_TABLE, tagsKeyOf, withTag } from './item-tags';
import { holdersOf, type Holder, type ItemTable } from './moved-note-scan';
import { refusedAction } from './readiness';
import { stripFrontmatterTags } from './tags';
import type { SQLiteRepository } from './types';

/** A note whose `ir-id` was taken off or changed, as it is now. */
export interface DamagedNote {
  path: string;
  /** The table of the live row at its path, which is the kind of item it is. */
  table: ItemTable;
  /**
   * `removed` when the note claims no id at all, `changed` when it claims one
   * the live row at its path doesn't hold.
   */
  change: 'removed' | 'changed';
  /**
   * Whether Restore can give it its id back: one live row, and only one, sits
   * at its path. Two (rows of different tables sharing the path) leave no way
   * to tell which id was the note's.
   */
  restorable: boolean;
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
}

export interface DamagedNoteActions {
  /**
   * What became of the `ir-id` of each note at `paths` by now, in the order
   * given. A note whole again, gone, mid-parse, or no live row's (a copy, a
   * plain note) is left out.
   */
  describe(paths: readonly string[]): Promise<DamagedNote[]>;
  /**
   * Give the note at `path` back the `ir-id` of the one live row at its path,
   * and that row's type tag in place of any other type's, as making the item
   * would have (see {@link reassociatedFrontmatter}). Answers whether the note
   * carries that id now (written now, or there already), and false, writing
   * nothing, when no single live row sits at its path (a copy, a plain note),
   * when the note is gone or mid-parse, or when writes are refused.
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
}: DamagedNoteActionsDeps): DamagedNoteActions {
  /** The live rows at `path`, as the database holds them now. */
  const liveAt = async (path: string) =>
    ((await holdersOf(repo, [path])).get(path) ?? []).filter(
      (holder) => !holder.deleted
    );

  return {
    async describe(paths) {
      const found = paths.flatMap((path) => {
        const file = vault.getFileByPath(normalizePath(path));
        // Null while the cache is part way through re-reading the note, which
        // would read as a note with no frontmatter
        const cache = file ? metadataCache.getFileCache(file) : null;
        if (!cache) return [];
        const irId: unknown = cache.frontmatter?.['ir-id'];
        return [{ path, irId }];
      });
      const holders = await holdersOf(
        repo,
        found.map(({ path }) => path)
      );
      return found.flatMap((claim): DamagedNote[] => {
        const atPath = holders.get(claim.path) ?? [];
        if (!readsAsTampering(claim, atPath)) return [];
        // A note that reads as tampered with has a live row at its path
        const live = atPath.filter((holder) => !holder.deleted);
        const change = claimsIdentity(claim.irId) ? 'changed' : 'removed';
        return [
          {
            path: claim.path,
            table: live[0].table,
            change,
            restorable: live.length === 1,
          },
        ];
      });
    },

    async restore(path) {
      const file = vault.getFileByPath(normalizePath(path));
      const cache = file ? metadataCache.getFileCache(file) : null;
      if (!file || !cache) return false;
      const before = await liveAt(path);
      if (before.length !== 1) return false;
      if (cache.frontmatter?.['ir-id'] === before[0].id) return true;
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
          if (frontmatter['ir-id'] === row.id) return;
          reassociatedFrontmatter(frontmatter, row);
        }
      );
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
