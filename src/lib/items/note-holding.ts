import { supportsFrontmatter } from '#/lib/mime';
import type { App, MetadataCache, TFile } from 'obsidian';

/**
 * Which row a note is the note of, by the `ir-id` it claims and where it is:
 * the one rule the item layer's typing (`ItemManager.getItemType`), the note
 * bar's lookup (`ReviewManager.getReviewItemFromFile`) and the leftover scan
 * (`crash-leftovers`) all read a note by, so that a note the bar shows no
 * item for is one the leftover scan lists, and the other way round.
 *
 * The note at a row's reference is that row's note iff it claims the row's
 * id. A note claiming an id no live row at its path holds is no item's note:
 * a copy of the note a live row holding the id points at, while that note is
 * there and no live row holding another id holds the copy's path, or else a
 * leftover, for the user to say what it is.
 */

/**
 * The id a note claims by its `ir-id` property, `irId` as the metadata cache
 * holds it: `undefined` for none, anything falsy (as `claimsIdentity` reads
 * it), so that the note is known by its path, as a file with no frontmatter
 * is; a string as it is; a scalar YAML reads as no string, `ir-id: 7` say, by
 * its string form, as typed (`"7"`); `null` for a list or a map, a claim no
 * row can answer. Every reader comparing a note's `ir-id` with a row's id
 * reads it by this, so a hand-typed number is one id to all of them.
 */
export function claimedId(irId: unknown): string | null | undefined {
  if (!irId) return undefined;
  if (typeof irId === 'string') return irId;
  return typeof irId === 'number' ||
    typeof irId === 'boolean' ||
    typeof irId === 'bigint'
    ? String(irId)
    : null;
}

/**
 * The id `file` holds a row by, for what tells, while a menu is built, which
 * item a file is (`ArticleManager`'s `heldArticleLookup`, `item-source`'s
 * `itemNodeAt`): a string for the row with that id at `file`'s path;
 * `undefined` for a file with no frontmatter, a PDF say, which has nowhere to
 * claim an id in and so is the row at its path; `null` for a note claiming no
 * id (see {@link claimedId}), which holds no row even at a live row's path,
 * or claiming a list or a map, which no row can answer to.
 */
export function heldClaim(
  file: TFile,
  app: { metadataCache: Pick<MetadataCache, 'getFileCache'> }
): string | null | undefined {
  const id = claimedId(
    app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id']
  );
  return id === undefined && supportsFrontmatter(file) ? null : id;
}

/**
 * Whether `file`, the note at the reference of the row `id`, is there without
 * holding it (see {@link heldClaim}): a note claiming another id, or none, as
 * a note whose `ir-id` was taken off or typed over does, which the queue
 * flags. False for no file, a missing item flagged as one, for a file with no
 * frontmatter, a PDF, which holds the row at its path by having nowhere to
 * claim an id in, and for a note the metadata cache has not read yet, as one
 * just made is: its claim is not known, and a flag would stay until the queue
 * next refetches.
 */
export function unlinkedFrom(
  file: TFile | null,
  id: string,
  app: { metadataCache: Pick<MetadataCache, 'getFileCache'> }
): boolean {
  if (!file || !supportsFrontmatter(file)) return false;
  if (!app.metadataCache.getFileCache(file)) return false;
  return heldClaim(file, app) !== id;
}

/** A row holding the id a note claims: where it points, and whether it is live. */
export interface IdHolder {
  reference: string;
  live: boolean;
}

/**
 * Of `rows`, rows of any table holding the id a note at `path` claims, the
 * one whose note it is: a live one pointing at `path`, if any.
 */
export function heldRowOf<R extends IdHolder>(
  path: string,
  rows: readonly R[]
): R | undefined {
  return rows.find((row) => row.live && row.reference === path);
}

/**
 * What the note at `path` claiming an id is, given `rows`, the rows of any
 * table holding that id, deleted or not (rows deleted for good hold none),
 * and `taken`, whether a live row holding another id holds `path`:
 * - `held`: one of them is live and points at `path`, the note's row (see
 *   {@link heldRowOf});
 * - `copy`: else, on a path no live row holds (`taken` false), a live one
 *   points where a note claiming the id is (`claimedAt`), the note a copy of
 *   that one;
 * - `unheld`: neither, whether no row holds the id, only deleted ones do,
 *   live ones point where no note claiming it is, as a note moved where the
 *   plugin didn't see it as a move leaves them, or the note is a copy sitting
 *   where another item's note should be, which the user is asked about.
 */
export function holdingOf(
  path: string,
  rows: readonly IdHolder[],
  claimedAt: (reference: string) => boolean,
  taken: boolean
): 'held' | 'copy' | 'unheld' {
  if (heldRowOf(path, rows)) return 'held';
  if (taken) return 'unheld';
  return rows.some((row) => row.live && claimedAt(row.reference))
    ? 'copy'
    : 'unheld';
}

/**
 * Whether the vault holds a note at `path` whose cached `ir-id` claims `id`
 * (see {@link claimedId}).
 */
export function claimsIdAt(
  app: Pick<App, 'vault' | 'metadataCache'>,
  path: string,
  id: string
): boolean {
  const note = app.vault.getFileByPath(path);
  if (!note) return false;
  return (
    claimedId(app.metadataCache.getFileCache(note)?.frontmatter?.['ir-id']) ===
    id
  );
}
