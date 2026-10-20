import {
  normalizePath,
  type MetadataCache,
  type TFile,
  type Vault,
} from 'obsidian';
import { hasTag, TAG_BY_TABLE } from './item-tags';
import { supportsFrontmatter } from './mime';
import { holdersOf, type Holder, type RowId } from './moved-note-scan';
import { yieldToHost } from './pacing';
import type { SQLiteRepository } from './types';

/**
 * What the note at a path claims to be. `irId` is the `ir-id` frontmatter value
 * exactly as the metadata cache holds it, which is whatever the user left there:
 * `undefined` when the property is gone, `null` when only its value is, and any
 * other type when something that is not an id has been typed in.
 */
export interface NoteClaim {
  path: string;
  irId: unknown;
}

/**
 * Whether a note's `ir-id` amounts to a claim on an identity at all.
 *
 * Read exactly as `ArticleManager.rowToReviewArticle` and its siblings read it —
 * anything falsy is no claim — so the two paths cannot disagree about the same
 * note. A truthy value of the wrong type (a number the user typed in) is a claim,
 * and one no row can answer, since row ids are strings.
 */
export function claimsIdentity(irId: unknown): boolean {
  return Boolean(irId);
}

/**
 * Whether a note's `ir-id` reads as an edit nobody should have made, and so is
 * worth telling the user about.
 *
 * Two shapes of it. The property is gone from a note a live row still points at
 * — `Clear properties`, or select-all-and-delete in the properties editor, which
 * the editor guard cannot refuse because they never reach CodeMirror. Or the note
 * claims an id while a live row holding its path says otherwise, which is an id
 * typed over; that one costs the item its row on the next review fetch.
 *
 * A note carrying an `ir-id` no row holds is deliberately not counted. Nothing
 * says it was ever this plugin's note: a template or a duplicated file can carry
 * one, and warning about those would mean warning about notes the plugin has no
 * business claiming.
 */
export function readsAsTampering(
  claim: NoteClaim,
  holders: readonly Holder[]
): boolean {
  const live = holders.filter((holder) => !holder.deleted);
  // A tombstone holding the path has no note of its own there to have lost one
  if (!claimsIdentity(claim.irId)) return live.length > 0;
  return live.some((holder) => holder.id !== claim.irId);
}

/** A note missing its item's type tag, and the row it is missing it for. */
export interface TagLoss {
  row: RowId;
  path: string;
  tag: string;
}

/**
 * Whether the note at a path has lost its item's type tag, and which tag.
 *
 * A note belongs to the live row at its path that its `ir-id` names or, making
 * no claim, to the one live row at its path. A note no single live row answers
 * to (a plain note, an id typed over, a copy, a tombstone's old path, or one two
 * live rows could own) has no tag to have lost.
 */
export function classifyTag(
  { path, irId }: NoteClaim,
  tags: unknown,
  holders: readonly Holder[]
): TagLoss | null {
  const live = holders.filter((holder) => !holder.deleted);
  const owners = claimsIdentity(irId)
    ? live.filter((holder) => holder.id === irId)
    : live;
  if (owners.length !== 1) return null;
  const [{ table, id }] = owners;
  const tag = TAG_BY_TABLE[table];
  if (hasTag(tags, tag)) return null;
  return { row: { table, id }, path, tag };
}

/** How long changed notes pile up before a pass reads the database. */
export const DEBOUNCE_MS = 250;

/** Notes resolved against the database per slice of work. */
export const PATH_BATCH = 200;

export interface IrIdWatchDeps {
  repo: Pick<SQLiteRepository, 'query'>;
  vault: Pick<Vault, 'getFileByPath'>;
  metadataCache: Pick<MetadataCache, 'getFileCache'>;
  /**
   * Told the notes a pass found missing their `ir-id` or type tag, once per
   * pass that finds any. Telling the user is the caller's business, including
   * how: a folder arriving over Sync can name a great many at once.
   *
   * A note is told of once per loss, not once per pass: nothing puts the id
   * back, so every later edit of it would find it damaged again, and a notice
   * dismissed would come back with each keystroke. It is told of again only
   * after a pass has found it whole.
   */
  onDamage: (paths: readonly string[]) => void;
  yieldToHost?: () => Promise<void>;
  /** Runs `pass` after `ms`; returns a function that cancels it. */
  schedule?: (pass: () => void, ms: number) => () => void;
  debounceMs?: number;
  pathBatch?: number;
}

export interface IrIdWatch {
  /** Remember a note the metadata cache has re-read, for the next pass. */
  handleChange(file: Pick<TFile, 'path' | 'extension'>): void;
  /** Run a pass now over everything remembered; answers what it newly reported. */
  flush(): Promise<string[]>;
  /** Drop any pending pass and stop taking changes. */
  dispose(): void;
}

/**
 * Watch the metadata cache for item notes that lost their `ir-id` or type tag
 * outside the plugin, and report them. It never writes a note or a row.
 *
 * The editor guard only covers writes made through an open CodeMirror editor.
 * Reading mode's properties editor writes straight to the vault, and so do other
 * plugins, Sync, git checkouts, external editors and mobile file managers.
 * `metadataCache.on('changed')` is the one place all of them show up, and the
 * one place none of them can be told apart. This used to put the id and tag
 * back, and bring a row back for an id undone (0166): a note un-imported on
 * another device reaches this one over Sync before the database without its row
 * does, so the repair re-imported it, and Sync carried that back. Until a note
 * and its row can be ordered (0161), nothing here writes.
 *
 * It is also the earliest moment the new value can be read. An in-place
 * frontmatter edit raises vault `modify` first, but the cache has not reparsed
 * the note by then, so a `getFileCache` read from a `modify` handler still
 * returns the `ir-id` from before the edit.
 *
 * Changes are batched rather than judged one at a time: a change costs a `Set`
 * insert and no database work at all, and a whole burst (a vault being indexed,
 * a folder arriving over Sync) is answered by one `IN (…)` read per item table
 * however many notes it covers.
 */
export function createIrIdWatch({
  repo,
  vault,
  metadataCache,
  onDamage,
  yieldToHost: pause = yieldToHost,
  schedule = (pass, ms) => {
    const timer = window.setTimeout(pass, ms);
    return () => window.clearTimeout(timer);
  },
  debounceMs = DEBOUNCE_MS,
  pathBatch = PATH_BATCH,
}: IrIdWatchDeps): IrIdWatch {
  const pending = new Set<string>();
  let cancelScheduled: (() => void) | null = null;
  let disposed = false;
  // Passes run one at a time. The chain swallows failures only so it stays
  // usable; `flush`'s caller still sees them.
  let chain: Promise<unknown> = Promise.resolve();

  /**
   * What the note at `path` claims, and its tags, or null when there is
   * nothing to judge yet: no note there, or one the metadata cache is part way
   * through re-reading.
   *
   * The second is every edit, briefly. Obsidian points a note's cache entry at
   * the hash of its new content before the parse of that content has finished,
   * and `getFileCache` answers `null` until it has (read from
   * `MetadataCache.computeFileMetadataAsync` in obsidian.asar, 1.13; not
   * documented). Read as a note with no frontmatter, that is an `ir-id` gone
   * missing. Nothing is lost by passing over it, because the parse finishing
   * is what raises `changed`, and that brings the note back.
   */
  const claimAt = (
    path: string
  ): { claim: NoteClaim; tags: unknown } | null => {
    // Normalized as `ObsidianHelpers.getNote` does it, or this disagrees with
    // every other reader about what a `reference` points at
    const file = vault.getFileByPath(normalizePath(path));
    if (!file) return null;
    const cache = metadataCache.getFileCache(file);
    if (!cache) return null;
    const irId: unknown = cache.frontmatter?.['ir-id'];
    return { claim: { path, irId }, tags: cache.frontmatter?.tags };
  };

  /** Damaged notes already told of, until a pass finds them whole again. */
  const reported = new Set<string>();

  /** The notes in `batch` newly found damaged, now remembered as told of. */
  async function damagedIn(batch: readonly string[]): Promise<string[]> {
    // A note gone since the change was remembered, or mid-parse, is skipped
    const found = batch.flatMap((path) => {
      const at = claimAt(path);
      return at ? [at] : [];
    });
    const holders = await holdersOf(
      repo,
      found.map(({ claim }) => claim.path)
    );
    const damaged: string[] = [];
    for (const { claim, tags } of found) {
      const atPath = holders.get(claim.path) ?? [];
      const lost =
        readsAsTampering(claim, atPath) ||
        classifyTag(claim, tags, atPath) !== null;
      if (!lost) {
        reported.delete(claim.path);
      } else if (!reported.has(claim.path)) {
        reported.add(claim.path);
        damaged.push(claim.path);
      }
    }
    return damaged;
  }

  async function runPass(): Promise<string[]> {
    const paths = [...pending];
    pending.clear();
    const damaged: string[] = [];
    for (let i = 0; i < paths.length; i += pathBatch) {
      damaged.push(...(await damagedIn(paths.slice(i, i + pathBatch))));
      // Nothing after the last batch waits on the thread being free, so only
      // the gaps between batches are paid for
      if (i + pathBatch < paths.length) await pause();
    }
    // Not once disposed: whatever is told about this is torn down alongside
    // the watch, and a notice raised as the plugin unloads would be left on
    // screen with nothing behind it
    if (disposed) return [];
    if (damaged.length > 0) onDamage(damaged);
    return damaged;
  }

  function flush(): Promise<string[]> {
    const pass = chain.then(runPass, runPass);
    chain = pass.then(
      () => undefined,
      () => undefined
    );
    return pass;
  }

  return {
    handleChange(file) {
      if (disposed) return;
      // An `ir-id` lives in frontmatter, while the cache raises this for
      // everything it indexes. Checked before the path is so much as
      // remembered: a vault being indexed runs this once per file in it.
      if (!supportsFrontmatter(file)) return;

      pending.add(file.path);
      // A fixed window from the first change of a burst, not a timer pushed back
      // by each: an index that keeps the cache busy for a minute would otherwise
      // put every report off until it finished.
      if (cancelScheduled !== null) return;
      cancelScheduled = schedule(() => {
        cancelScheduled = null;
        void flush().catch((error: unknown) => {
          console.error(
            'Incremental Reading - failed to check ir-id frontmatter:',
            error
          );
        });
      }, debounceMs);
    },
    flush,
    dispose() {
      disposed = true;
      pending.clear();
      cancelScheduled?.();
      cancelScheduled = null;
    },
  };
}
