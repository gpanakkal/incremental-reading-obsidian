import {
  normalizePath,
  type MetadataCache,
  type TFile,
  type Vault,
} from 'obsidian';
import {
  holdersOf,
  ITEM_TABLES,
  PARAM_BATCH,
  type Holder,
  type RowId,
} from './moved-note-scan';
import { yieldToHost } from './pacing';
import type { MutationStatement, SQLiteRepository } from './types';

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

/** A row found by its id: where it points, and whether it is a tombstone. */
export interface ClaimedRow extends RowId {
  reference: string;
  deleted: boolean;
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

export type SkipReason =
  /** More than one row answers to the note, and there is no telling which. */
  | 'ambiguous'
  /** The row's own note is still where the row says, so this one is a copy. */
  | 'copy'
  /** Another row in the same table holds this path, which is `UNIQUE`. */
  | 'conflict';

/** What a note's claim, weighed against the rows around it, calls for. */
export type Verdict =
  | { kind: 'none' }
  | { kind: 'restore-id'; row: RowId; path: string }
  | { kind: 'undelete'; row: RowId; path: string }
  | { kind: 'skipped'; reason: SkipReason; rows: RowId[]; path: string };

/** A verdict there is something to write for. */
export type Repair = Extract<Verdict, { kind: 'restore-id' | 'undelete' }>;

const NOTHING: Verdict = { kind: 'none' };

const toRowId = ({ table, id }: RowId): RowId => ({ table, id });

/** Everything outside a note that deciding its fate takes. */
export interface ClaimContext {
  /** The rows whose `reference` is the note's own path. */
  holders: readonly Holder[];
  /**
   * The rows carrying the note's `ir-id`, wherever they point. Looked up by id
   * rather than by path because a tombstone need not point at a real path at
   * all: the moved-note scan parks one at `evictedSpot` when a note moves onto
   * the path it was holding, and calls that permanent on the grounds that every
   * restore overwrites `reference` outright — which is only true of restores
   * that do. This one does, for that reason.
   */
  claimed: readonly ClaimedRow[];
  /**
   * Whether the note at a row's own `reference` still carries that row's id,
   * which makes the note being judged a copy of it rather than its return.
   */
  heldElsewhere: (row: ClaimedRow) => boolean;
}

/**
 * What to do about the note at a path.
 *
 * `ir-id` is the authority on which row a note belongs to, so:
 *
 * - **No claim, and a live row is at this path**: the note makes no claim to
 *   weigh, so it gets the benefit of the doubt and the row's id goes back in.
 *   Same rule as `isStranded`'s in the moved-note scan, and the reason a note
 *   whose `ir-id` was deleted is still that row's note. Only a live row may do
 *   this: a tombstone keeps its `reference` with no note of its own left there,
 *   so stamping its id onto whatever now sits on that path would be a claim it
 *   has no right to.
 * - **A claim naming a tombstone**: the id was mangled, the row was marked
 *   deleted for it, and the edit has since been undone. The row comes back, and
 *   comes back pointed at this note.
 * - **A claim naming a live row**: already correct, whether that row is at this
 *   path or another note is a copy of it. Nothing to do — which is also what
 *   stops a repair's own write from looping.
 * - **A claim naming no row at all**: authoritative. The note is not the note of
 *   whichever row holds this path, and that row's fate is the review fetch
 *   path's to settle, not this module's.
 */
export function classifyClaim(
  claim: NoteClaim,
  { holders, claimed, heldElsewhere }: ClaimContext
): Verdict {
  const { path } = claim;

  if (!claimsIdentity(claim.irId)) {
    const live = holders.filter((holder) => !holder.deleted);
    if (live.length === 0) return NOTHING;
    // Two tables naming one path is a state nothing should be able to reach,
    // and there is no telling whose id the note should carry. Reported rather
    // than guessed at, as the moved-note scan does with an ambiguous move.
    if (live.length > 1) {
      return {
        kind: 'skipped',
        reason: 'ambiguous',
        rows: live.map(toRowId),
        path,
      };
    }
    return { kind: 'restore-id', row: toRowId(live[0]), path };
  }

  // Strict equality, so a truthy `ir-id` of some other type answers to nothing
  const answering = claimed.filter((row) => row.id === claim.irId);
  if (answering.length === 0) return NOTHING;
  if (answering.length > 1) {
    return {
      kind: 'skipped',
      reason: 'ambiguous',
      rows: answering.map(toRowId),
      path,
    };
  }

  const row = answering[0];
  if (!row.deleted) return NOTHING;

  // The same guard `ReviewManager.handleCreation` makes: copying a note carries
  // the id into the copy, and the original is the one the row belongs to
  if (row.reference !== path && heldElsewhere(row)) {
    return { kind: 'skipped', reason: 'copy', rows: [toRowId(row)], path };
  }

  // `reference` is `UNIQUE` per table, so the move onto this path has to be
  // free to make. Held back rather than attempted: the failure would roll back
  // every other row coming back in the same write.
  const blocking = holders.filter(
    (holder) => holder.table === row.table && holder.id !== row.id
  );
  if (blocking.length > 0) {
    return {
      kind: 'skipped',
      reason: 'conflict',
      rows: blocking.map(toRowId),
      path,
    };
  }

  return { kind: 'undelete', row: toRowId(row), path };
}

/**
 * Bring a row back, pointed at the note that asked for it.
 *
 * `reference` is rewritten, not merely left alone, and that is the point: a
 * tombstone the moved-note scan evicted points at `evictedSpot` and could never
 * be reached from its note again otherwise. Written the same way
 * `ReviewManager.handleCreation` writes it.
 *
 * Guarded on the row still being a tombstone, so a restore that got in first —
 * `handleCreation`, a rename handler — keeps both its row and the reference it
 * was given. That also settles it against the moved-note scan's eviction, whose
 * own write is guarded `AND deleted = 1`: whichever lands first, the other reads
 * as a no-op rather than undoing it.
 */
export function undeleteStatement({ row, path }: Repair): MutationStatement {
  return {
    // `table` comes from `ITEM_TABLES`, never from a note
    query: `UPDATE ${row.table} SET deleted = 0, reference = $1
            WHERE id = $2 AND deleted = 1`,
    params: [path, row.id],
  };
}

/**
 * The rows carrying each of `ids`, with where they point and whether they are
 * tombstones. Ids are unique within a table and are UUIDs, so in practice this
 * finds at most one row per id.
 */
export async function rowsById(
  repo: Pick<SQLiteRepository, 'query'>,
  ids: readonly string[]
): Promise<Map<string, ClaimedRow[]>> {
  const found = new Map<string, ClaimedRow[]>();
  for (const table of ITEM_TABLES) {
    for (let i = 0; i < ids.length; i += PARAM_BATCH) {
      const batch = ids.slice(i, i + PARAM_BATCH);
      const rows = (await repo.query(
        `SELECT id, reference, deleted FROM ${table}
         WHERE id IN (${batch.map((_, n) => `$${n + 1}`).join(', ')})`,
        batch
      )) as unknown as { id: string; reference: string; deleted: number }[];
      for (const { id, reference, deleted } of rows) {
        found.set(id, [
          ...(found.get(id) ?? []),
          { table, id, reference, deleted: deleted !== 0 },
        ]);
      }
    }
  }
  return found;
}

/** How long changed notes pile up before a pass reads the database. */
export const DEBOUNCE_MS = 250;

/** Notes resolved against the database per slice of work. */
export const PATH_BATCH = 200;

export interface IrIdRepairDeps {
  repo: Pick<SQLiteRepository, 'query' | 'bulkMutate'>;
  vault: Pick<Vault, 'getFileByPath'>;
  metadataCache: Pick<MetadataCache, 'getFileCache'>;
  /** Writes `ir-id` into a note's frontmatter, leaving the rest of it alone. */
  writeIrId: (file: TFile, id: string) => Promise<void>;
  /** Told what a pass wrote, so callers can refresh what read it. */
  onRepaired?: (repairs: readonly Repair[]) => void | Promise<void>;
  /**
   * Told the notes whose `ir-id` {@link readsAsTampering} counted as an edit the
   * user should not have made, once per pass that finds any. Raising anything at
   * them is the caller's business, including how often: a folder arriving over
   * Sync can name a great many at once.
   */
  onDamage?: (paths: readonly string[]) => void;
  yieldToHost?: () => Promise<void>;
  /** Runs `pass` after `ms`; returns a function that cancels it. */
  schedule?: (pass: () => void, ms: number) => () => void;
  debounceMs?: number;
  pathBatch?: number;
}

export interface IrIdRepairer {
  /** Remember a note the metadata cache has re-read, for the next pass. */
  handleChange(file: Pick<TFile, 'path' | 'extension'>): void;
  /** Run a pass now over everything remembered, and report what it wrote. */
  flush(): Promise<Repair[]>;
  /** Drop any pending pass and stop taking changes. */
  dispose(): void;
}

/**
 * Watch the metadata cache for `ir-id` frontmatter the plugin did not write, put
 * back what the user was not supposed to touch, and bring a row back when a
 * mangled id is undone.
 *
 * The editor guard only covers writes made through an open CodeMirror editor.
 * Reading mode's properties editor writes straight to the vault, and so do other
 * plugins, Sync, git checkouts, external editors and mobile file managers.
 * `metadataCache.on('changed')` is the one place all of them show up.
 *
 * It is also the earliest moment the new value can be read. An in-place
 * frontmatter edit raises vault `modify` first, but the cache has not reparsed
 * the note by then, so a `getFileCache` read from a `modify` handler still
 * returns the `ir-id` from before the edit.
 *
 * Nothing else brings a row back from a reverted edit. `rowToReviewArticle` and
 * its siblings do un-delete a row they are handed, but the only unfiltered way
 * to reach them is `fetch(id)` by way of `ReviewManager.getReviewItemFromId`,
 * which is keyed off the current review item; every `fetchMany` filters
 * `deleted = FALSE` and no caller asks it not to. So without this, a tombstone
 * that is not the item on screen is unreachable for good.
 *
 * Changes are batched rather than resolved one at a time. There is no sound test
 * to run on a single file first: the case most in need of repair — the `ir-id`
 * deleted outright — is exactly the case where the note carries no mark of this
 * plugin left to recognise it by, so any frontmatter or path filter would narrow
 * the policy rather than speed it up. Batching gets the saving honestly: a change
 * costs a `Set` insert and no database work at all, and a whole burst — a vault
 * being indexed, a folder arriving over Sync — is answered by one `IN (…)` read
 * per item table however many notes it covers.
 *
 * Writes are re-checked against the cache immediately beforehand, and a note that
 * is already correct yields no verdict to write for. That is what keeps a repair
 * from feeding itself: the frontmatter write raises `modify`, the cache reparses
 * and raises `changed` again, and the next pass finds an `ir-id` that now names a
 * live row and writes nothing.
 */
export function createIrIdRepairer({
  repo,
  vault,
  metadataCache,
  writeIrId,
  onRepaired,
  onDamage,
  yieldToHost: pause = yieldToHost,
  schedule = (pass, ms) => {
    const timer = window.setTimeout(pass, ms);
    return () => window.clearTimeout(timer);
  },
  debounceMs = DEBOUNCE_MS,
  pathBatch = PATH_BATCH,
}: IrIdRepairDeps): IrIdRepairer {
  const pending = new Set<string>();
  let cancelScheduled: (() => void) | null = null;
  let disposed = false;
  // Passes run one at a time: a pass's own writes raise `changed` again, so the
  // next pass is already on its way while this one is still writing. The chain
  // swallows failures only so it stays usable; `flush`'s caller still sees them.
  let chain: Promise<unknown> = Promise.resolve();

  // Normalized as `ObsidianHelpers.getNote` does it, or this disagrees with
  // every other reader about what a `reference` points at
  const fileAt = (path: string) => vault.getFileByPath(normalizePath(path));

  const claimAt = (path: string): { claim: NoteClaim; file: TFile } | null => {
    const file = fileAt(path);
    if (!file) return null;
    const irId: unknown =
      metadataCache.getFileCache(file)?.frontmatter?.['ir-id'];
    return { claim: { path, irId }, file };
  };

  const heldElsewhere = (row: ClaimedRow) =>
    claimAt(row.reference)?.claim.irId === row.id;

  type Conflict = Extract<Verdict, { kind: 'skipped' }>;

  async function repairBatch(batch: readonly string[]): Promise<{
    applied: Repair[];
    conflicts: Conflict[];
    damaged: string[];
  }> {
    const claims: NoteClaim[] = [];
    for (const path of batch) {
      // Gone since the change was remembered: a deletion is the vault delete
      // handler's business, not this one's
      const found = claimAt(path);
      if (found) claims.push(found.claim);
    }
    if (claims.length === 0) return { applied: [], conflicts: [], damaged: [] };

    const holders = await holdersOf(
      repo,
      claims.map(({ path }) => path)
    );
    // Only string ids are worth asking about. SQLite would coerce a number to
    // compare it against a `TEXT` column, and nothing should be matched that way
    const claimedIds = [
      ...new Set(
        claims
          .map(({ irId }) => irId)
          .filter((irId): irId is string => typeof irId === 'string' && !!irId)
      ),
    ];
    const claimed =
      claimedIds.length > 0
        ? await rowsById(repo, claimedIds)
        : new Map<string, ClaimedRow[]>();

    const repairs: Repair[] = [];
    const skipped: Extract<Verdict, { kind: 'skipped' }>[] = [];
    const damaged: string[] = [];
    for (const claim of claims) {
      const atPath = holders.get(claim.path) ?? [];
      const verdict = classifyClaim(claim, {
        holders: atPath,
        claimed:
          typeof claim.irId === 'string' ? (claimed.get(claim.irId) ?? []) : [],
        heldElsewhere,
      });
      if (verdict.kind === 'skipped') skipped.push(verdict);
      else if (verdict.kind !== 'none') repairs.push(verdict);
      // Judged from the note and the rows at its path, not from the verdict: an
      // id typed over calls for no repair at all, and is the damage that costs
      // the most
      if (readsAsTampering(claim, atPath)) damaged.push(claim.path);
    }
    // A copy is an everyday thing to make and needs no reporting. An ambiguous
    // note is a state the vault should not have been able to reach, so it is
    // reported here and now.
    const ambiguous = skipped.filter(({ reason }) => reason === 'ambiguous');
    if (ambiguous.length > 0) {
      console.warn(
        'Incremental Reading - could not settle these notes against their items:',
        ambiguous
      );
    }
    // A conflict may yet come free in a later round of this pass, so it is
    // handed back rather than reported, and only what is still standing when the
    // pass settles gets warned about.
    const conflicts = skipped.filter(({ reason }) => reason === 'conflict');

    const applied: Repair[] = [];
    const undeletes = repairs.filter(({ kind }) => kind === 'undelete');
    // One statement per row in a single paced run: a checkout can revert a whole
    // folder at once, and a plain `mutate` apiece rewrites the database file for
    // every one of them
    if (undeletes.length > 0) {
      try {
        await repo.bulkMutate(undeletes.map(undeleteStatement));
        applied.push(...undeletes);
      } catch (error) {
        // Contained so the frontmatter repairs below still run. The likeliest
        // cause is another row having taken one of these paths since it was
        // read, which the next change to the note comes back for.
        console.error(
          'Incremental Reading - failed to restore deleted items:',
          error
        );
      }
    }

    for (const repair of repairs) {
      if (repair.kind !== 'restore-id') continue;
      if (disposed) break;
      // Read again right before writing: the rows were read before the first of
      // these writes, and every one of them hands the thread back
      const found = claimAt(repair.path);
      if (!found || claimsIdentity(found.claim.irId)) continue;
      await writeIrId(found.file, repair.row.id);
      applied.push(repair);
    }
    return { applied, conflicts, damaged };
  }

  /**
   * Work through everything remembered, then settle.
   *
   * A row coming back takes the path of the note that asked for it, which frees
   * the path it was holding — and `reference` is `UNIQUE` per table, so any
   * restore that path was blocking becomes free to make in turn. One round is
   * therefore not enough, and waiting for the next `changed` event would be
   * waiting for something that may never come: the note whose restore was held
   * back has already been read, and nothing would bring it up again.
   *
   * Each further round has to have brought a row back to earn its place. That
   * bounds the settling without a cap to pick: an undelete is guarded
   * `AND deleted = 1`, so no row can be freed twice, and nothing here ever
   * deletes a row to replenish the supply.
   */
  async function runPass(): Promise<Repair[]> {
    if (disposed) return [];
    let paths = [...pending];
    pending.clear();

    const applied: Repair[] = [];
    // A settling round looks at paths an earlier one already judged, so the same
    // note must not be reported twice for the one edit
    const damaged = new Set<string>();
    for (;;) {
      const round: Repair[] = [];
      const conflicts: Conflict[] = [];
      for (let i = 0; i < paths.length; i += pathBatch) {
        if (disposed) break;
        const batch = await repairBatch(paths.slice(i, i + pathBatch));
        round.push(...batch.applied);
        conflicts.push(...batch.conflicts);
        for (const path of batch.damaged) damaged.add(path);
        // Nothing after the last batch waits on the thread being free, so only
        // the gaps between batches are paid for
        if (i + pathBatch < paths.length) await pause();
      }
      applied.push(...round);

      // Only an undelete frees a path, so only an undelete can have unblocked
      // anything; a round of frontmatter writes alone leaves the conflicts
      // exactly as they were
      const freed = round.some(({ kind }) => kind === 'undelete');
      if (disposed || !freed || conflicts.length === 0) {
        // Reported only now that the pass has given up on them: a conflict that
        // came free in a later round was never anything to tell anyone about.
        // Nothing is said while disposing, where every conflict is left over.
        if (!disposed && conflicts.length > 0) {
          console.warn(
            'Incremental Reading - could not settle these notes against their items:',
            conflicts
          );
        }
        break;
      }
      paths = [...new Set(conflicts.map(({ path }) => path))];
      await pause();
    }

    // Not while disposing: whatever is told about this is torn down alongside the
    // repairer, in no guaranteed order, and raising a notice as the plugin
    // unloads would leave one on screen with nothing behind it
    if (!disposed && damaged.size > 0) onDamage?.([...damaged]);
    if (applied.length > 0) await onRepaired?.(applied);
    return applied;
  }

  function flush(): Promise<Repair[]> {
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
      // Item notes are always markdown, while the cache raises this for
      // everything it indexes. Checked before the path is so much as
      // remembered: a vault being indexed runs this once per file in it.
      if (file.extension !== 'md') return;

      pending.add(file.path);
      // A fixed window from the first change of a burst, not a timer pushed back
      // by each: an index that keeps the cache busy for a minute would otherwise
      // put every repair off until it finished.
      if (cancelScheduled !== null) return;
      cancelScheduled = schedule(() => {
        cancelScheduled = null;
        void flush().catch((error: unknown) => {
          console.error(
            'Incremental Reading - failed to repair ir-id frontmatter:',
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
