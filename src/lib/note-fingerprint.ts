import type { TFile } from 'obsidian';
import { supportsFrontmatter } from './mime';
import type { ItemTable } from './moved-note-scan';
import type { MutationStatement } from './types';

/**
 * How a note's `ir-id` stands to the row at its path: the row's own id, some
 * other id, or none at all (absent, emptied, or not an id; see
 * `claimsIdentity`).
 */
export type IrIdRelation = 'same' | 'other' | 'none';

/**
 * Where the row stands: live, tombstoned in a way that can be undone (its note
 * trashed, say), or deleted for good (see `PURGED_REFERENCE_PREFIX`).
 */
export type RowState = 'live' | 'tombstoned' | 'purged';

/** What squaring a row with the note at its path may do to the row. */
export type ReconcileAction = 'none' | 'tombstone';

export interface ReconcileInput {
  /** The note's `stat.mtime` now, or null when it can't be read. */
  noteMtime: number | null;
  /** The row's `note_mtime`: the note's mtime as the plugin last wrote it. */
  rowMtime: number | null;
  relation: IrIdRelation;
  rowState: RowState;
}

/**
 * The note's fingerprint: its `stat.mtime`, which the plugin records on the row
 * each time it writes the note's identity frontmatter (`ir-id`, type tag), and
 * which is compared with that record before the row is touched over the note.
 * Only a note with frontmatter has one: a file without, a PDF say, is its row's
 * by path alone. Renames and moves leave mtime as it was, and Obsidian Sync
 * carries it across devices, so a note and the row written with it agree on
 * every device once both have arrived.
 *
 * `TFile.stat` is refreshed by the vault before a write's promise settles (read
 * from obsidian.asar, 1.13: `adapter.process` ends by reconciling the file,
 * which sets `stat` and fires `modify`, on desktop and mobile alike), so read
 * right after an awaited write, this is the mtime the write left.
 * @returns the mtime, or null for a file with no frontmatter, or one with no
 *   stat to read (a stand-in file object)
 */
export function noteFingerprint(file: TFile): number | null {
  const { stat } = file as Partial<Pick<TFile, 'stat'>>;
  if (typeof stat?.mtime !== 'number') return null;
  return supportsFrontmatter(file) ? stat.mtime : null;
}

/**
 * Whether the note on disk is provably the one the plugin last wrote the row's
 * identity into: its mtime equals the one recorded then. Any other mtime,
 * older or newer, or no record at all, proves nothing: the note may have come
 * over Sync ahead of the database that goes with it, or behind it.
 */
export function fingerprintMatches(
  noteMtime: number | null,
  rowMtime: number | null
): boolean {
  return rowMtime !== null && noteMtime === rowMtime;
}

/**
 * What squaring a row with the note at its path may do to the row: tombstone
 * a live row whose note now carries another item's `ir-id`, and only on a
 * matching fingerprint (see {@link fingerprintMatches}). Everything else is
 * left for a later look, once the note or the database has changed.
 *
 * A tombstoned row is never brought back from here, whatever its note says. A
 * note restored from the trash raises vault `create`, and
 * `ReviewManager.handleCreation` revives its row from there. And here the
 * fingerprint cannot tell that restore from a note trashed on another device
 * whose deletion Sync has yet to bring: trashing leaves mtime as it was, so the
 * row would be revived here, and Sync would carry that back. A row deleted for
 * good is never touched either.
 */
export function reconcileAction({
  noteMtime,
  rowMtime,
  relation,
  rowState,
}: ReconcileInput): ReconcileAction {
  if (!fingerprintMatches(noteMtime, rowMtime)) return 'none';
  return relation === 'other' && rowState === 'live' ? 'tombstone' : 'none';
}

/**
 * The write recording `file`'s fingerprint on the `table` row `id`, for a
 * caller that writes the note's identity frontmatter after the row (a
 * relink): run once that write has settled. Null for a file with no
 * fingerprint, which has nothing to record. An un-import records none: its row
 * is deleted for good, and nothing reads a purged row's fingerprint.
 */
export function recordFingerprint(
  table: ItemTable,
  id: string,
  file: TFile
): MutationStatement | null {
  const mtime = noteFingerprint(file);
  if (mtime === null) return null;
  return {
    query: `UPDATE ${table} SET note_mtime = $1 WHERE id = $2`,
    params: [mtime, id],
  };
}
