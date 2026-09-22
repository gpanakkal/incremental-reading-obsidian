import {
  normalizePath,
  type MetadataCache,
  type TFile,
  type Vault,
} from 'obsidian';
import { yieldToHost } from './pacing';
import type { SQLiteRepository } from './types';

export const ITEM_TABLES = ['article', 'snippet', 'srs_card'] as const;
export type ItemTable = (typeof ITEM_TABLES)[number];

/** An item row, reduced to what finding its note takes. */
export interface ItemLocation {
  table: ItemTable;
  id: string;
  reference: string;
}

/** A row identified the way its table does: by id, within its own table. */
export type RowId = Pick<ItemLocation, 'table' | 'id'>;

/**
 * A row holding a path against `UNIQUE`, and whether only a tombstone does so.
 * A deleted row keeps its reference, with no note of its own left there.
 */
export interface Holder extends RowId {
  deleted: boolean;
}

/**
 * What the vault holds at a path: nothing (`null`), or a note and the `ir-id`
 * it carries, if any.
 */
export type NoteAt = (path: string) => { irId: string | undefined } | null;

/** A move, before the rows already holding its target have been consulted. */
export interface Move {
  row: ItemLocation;
  to: string;
}

export interface Relocation {
  table: ItemTable;
  id: string;
  from: string;
  to: string;
}

export type SkipReason = 'missing' | 'ambiguous' | 'conflict';

export interface Skip {
  row: ItemLocation;
  reason: SkipReason;
}

export interface RelocationPlan {
  relocations: Relocation[];
  skipped: Skip[];
  /**
   * The tombstones standing on the paths {@link relocations} land on, to be
   * moved aside in the same write. Each is given with the path it is giving up,
   * so the write can guard on finding it still there.
   */
  evicted: ItemLocation[];
}

const rowKey = (row: RowId) => `${row.table}\0${row.id}`;

/**
 * Whether a row's reference no longer leads to its own note: nothing is there,
 * or a note carrying some other `ir-id` is. A note without one gets the benefit
 * of the doubt — older items were created that way, and so reads a note
 * Obsidian has yet to index.
 */
export function isStranded(row: ItemLocation, noteAt: NoteAt): boolean {
  const note = noteAt(row.reference);
  return note === null || (note.irId !== undefined && note.irId !== row.id);
}

/**
 * Where each stranded row's note went, by the paths carrying its `ir-id`: one
 * is a move, none means the note is gone (or not synced yet), and more means
 * copies, with no telling which the user kept.
 */
export function resolveMoves(
  stranded: readonly ItemLocation[],
  pathsById: ReadonlyMap<string, readonly string[]>
): { moves: Move[]; skipped: Skip[] } {
  const moves: Move[] = [];
  const skipped: Skip[] = [];
  for (const row of stranded) {
    const paths = pathsById.get(row.id) ?? [];
    // The note turned up at home after all, between the scan's two looks
    if (paths.includes(row.reference)) continue;

    if (paths.length === 0) skipped.push({ row, reason: 'missing' });
    else if (paths.length > 1) skipped.push({ row, reason: 'ambiguous' });
    else moves.push({ row, to: paths[0] });
  }
  return { moves, skipped };
}

/**
 * Hold back every move onto a path another live row still names — `reference`
 * is `UNIQUE` — unless that row is moving off it too, which is what lets two
 * notes that traded places trade back. Dropping one move leaves its row where
 * it is, which can occupy another move's target in turn, so drops cascade.
 *
 * A tombstone holds a path just as firmly, but has no note there to lose and
 * no need of the path to be restored onto — every restore is keyed by id and
 * overwrites the reference outright. So one never blocks a move: it is reported
 * in {@link RelocationPlan.evicted} instead, to be moved aside in the same
 * write. Without that, a tombstone would block the same move on every launch,
 * forever.
 *
 * Settled as a worklist rather than by re-testing every move each round: a
 * stranded folder can hand this thousands of moves at once, and rescanning them
 * per drop is cubic in the length of the chain.
 * @param holders the rows naming each move's target, tombstones among them and
 * flagged as such
 */
export function dropConflicts(
  moves: readonly Move[],
  holders: ReadonlyMap<string, readonly Holder[]>
): RelocationPlan {
  // A slot per moving row, holding how many of its moves still stand: a row
  // frees its reference only once the last of them is dropped, and a row with
  // no slot at all is one nothing is moving
  const slotOf = new Map<string, number>();
  const standing: number[] = [];
  // The moves waiting on each slot to empty, which is every move a drop can
  // newly block
  const blocks: number[][] = [];
  const slots = moves.map(({ row }) => {
    const key = rowKey(row);
    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = standing.length;
      slotOf.set(key, slot);
      standing.push(0);
      blocks.push([]);
    }
    standing[slot] += 1;
    return slot;
  });

  const dropped = new Array<boolean>(moves.length).fill(false);
  let round: number[] = [];
  const drop = (move: number) => {
    if (dropped[move]) return;
    dropped[move] = true;
    round.push(move);
  };

  const claimants = new Map<string, number[]>();
  moves.forEach(({ to }, move) => {
    const after = claimants.get(to) ?? [];
    after.push(move);
    claimants.set(to, after);
    for (const holder of holders.get(to) ?? []) {
      // A tombstone gives the path up rather than standing in the way, so a
      // move never waits on one — settled once the drops have, below
      if (holder.deleted) continue;
      const slot = slotOf.get(rowKey(holder));
      if (slot === undefined) drop(move);
      else blocks[slot].push(move);
    }
  });
  // Two moves onto one path collide with each other, whatever holds it. The
  // caller settles one note per path, so this is a caller bug rather than a
  // state the vault can reach — but it would be a `UNIQUE` failure mid-write
  for (const after of claimants.values()) {
    if (after.length > 1) for (const move of after) drop(move);
  }

  const skipped: Skip[] = [];
  while (round.length > 0) {
    // Drain what this round blocked before what the next one does, in move
    // order within a round: the order a pass over every move reports them in
    const blocked = round.sort((a, b) => a - b);
    round = [];
    for (const move of blocked) {
      skipped.push({ row: moves[move].row, reason: 'conflict' });

      const slot = slots[move];
      standing[slot] -= 1;
      if (standing[slot] > 0) continue;
      for (const waiting of blocks[slot]) drop(waiting);
    }
  }

  // `standing` now counts the moves each row is left with, so a tombstone with
  // one of its own is leaving under its own steam and needs no eviction
  const evicted = new Map<string, ItemLocation>();
  moves.forEach(({ to }, move) => {
    if (dropped[move]) return;
    for (const holder of holders.get(to) ?? []) {
      if (!holder.deleted) continue;
      const slot = slotOf.get(rowKey(holder));
      if (slot !== undefined && standing[slot] > 0) continue;
      // Keyed by row, so a tombstone named more than once is evicted once
      evicted.set(rowKey(holder), {
        table: holder.table,
        id: holder.id,
        reference: to,
      });
    }
  });

  return {
    relocations: moves
      .filter((_, move) => !dropped[move])
      .map(({ row, to }) => ({
        table: row.table,
        id: row.id,
        from: row.reference,
        to,
      })),
    skipped,
    evicted: [...evicted.values()],
  };
}

/** Rows read per database page. */
export const PAGE_SIZE = 500;

/** How long the scan works before handing the thread back. */
export const SLICE_MS = 5;

/** Most paths named in one `IN (…)`, well under SQLite's parameter limit. */
const PARAM_BATCH = 500;

/**
 * Hand the thread back once a slice's worth of work has piled up, and report
 * whether to carry on. Paced by the clock, not by a row count: a page costs
 * well under a millisecond, so pausing per page would spend an idle wait — a
 * frame at best — for each, and dwarf the work it interrupts.
 */
function pacer(
  pause: () => Promise<void>,
  now: () => number,
  sliceMs: number,
  signal?: AbortSignal
) {
  let until = now() + sliceMs;
  return async () => {
    if (now() >= until) {
      await pause();
      until = now() + sliceMs;
    }
    return signal?.aborted !== true;
  };
}

export interface MovedNoteScanDeps {
  repo: Pick<SQLiteRepository, 'query' | 'mutate' | 'transaction'>;
  vault: Pick<Vault, 'getFileByPath' | 'getMarkdownFiles'>;
  metadataCache: Pick<MetadataCache, 'getFileCache'>;
  yieldToHost?: () => Promise<void>;
  /** Stops the scan at its next check; nothing is written once it fires. */
  signal?: AbortSignal;
  pageSize?: number;
  sliceMs?: number;
  /** The clock {@link sliceMs} is measured on. */
  now?: () => number;
}

interface LocationRow {
  rowid: number;
  id: string;
  reference: string;
}

/**
 * `reference` is `UNIQUE`, so moves are written in two passes, parking each row
 * here first. Vault paths are relative and never start with a slash, so no note
 * can already be named this.
 */
const parkingSpot = (move: Relocation) => `/ir-relocating/${move.id}`;

/**
 * Where a tombstone goes once the note that moved onto its path needs it: it
 * keeps its row, its review history and its id, and gives up only a path it has
 * no note at. Parking here is permanent, unlike {@link parkingSpot}'s — restores
 * are keyed by id and overwrite the reference outright, so nothing ever asks
 * for the old path back. Ids are unique within a table, and vault paths are
 * relative and never start with a slash, so no note can be named this and no
 * later scan can target it.
 */
export const evictedSpot = (row: RowId) => `/ir-evicted/${row.id}`;

/**
 * The rows naming each of `paths`, with whether each is only a tombstone: a
 * deleted row keeps its reference, and holds the path against `UNIQUE` with
 * nothing of its own there. Read here rather than carried along from the row
 * pass, so a path freed by a live handler since reads as free — and so that
 * pass need not keep every row it saw.
 */
async function holdersOf(
  repo: Pick<SQLiteRepository, 'query'>,
  paths: readonly string[]
): Promise<Map<string, Holder[]>> {
  const holders = new Map<string, Holder[]>();
  for (const table of ITEM_TABLES) {
    for (let i = 0; i < paths.length; i += PARAM_BATCH) {
      const batch = paths.slice(i, i + PARAM_BATCH);
      const held = (await repo.query(
        `SELECT id, reference, deleted FROM ${table}
         WHERE reference IN (${batch.map((_, n) => `$${n + 1}`).join(', ')})`,
        batch
      )) as unknown as { id: string; reference: string; deleted: number }[];
      for (const { id, reference, deleted } of held) {
        const at = holders.get(reference) ?? [];
        at.push({ table, id, deleted: deleted !== 0 });
        holders.set(reference, at);
      }
    }
  }
  return holders;
}

/**
 * Point rows back at notes that moved while nothing was listening for it: with
 * Obsidian closed, or before the plugin was ready to handle renames.
 *
 * Such a move reaches Obsidian as a new file, never as a rename, and timestamps
 * can't narrow the search — a move keeps the note's mtime and birthtime, and
 * Sync stamps the originals onto what it downloads. Obsidian's metadata cache
 * does catch every one, since it re-indexes on any mismatch of path, mtime or
 * size; so the scan leans on that, and must run once it has settled.
 *
 * Reads come from memory — rows from the database, `ir-id`s from the cache —
 * never from disk. Rows are checked as they are read, so only the stranded few
 * are kept, and the vault is searched at all only when one of them turns up
 * missing. The moves are then written in a single transaction, re-checked just
 * before it and guarded inside it, since the live rename handlers keep running
 * all the while. Any tombstone standing where a move lands is moved aside in
 * that same transaction — see {@link evictedSpot}.
 * @returns the moves written — including any a live handler got to first, whose
 * own write is left standing
 */
export async function scanForMovedNotes({
  repo,
  vault,
  metadataCache,
  yieldToHost: pause = yieldToHost,
  signal,
  pageSize = PAGE_SIZE,
  sliceMs = SLICE_MS,
  now = () => performance.now(),
}: MovedNoteScanDeps): Promise<Relocation[]> {
  const breathe = pacer(pause, now, sliceMs, signal);

  const irIdOf = (file: TFile) => {
    const irId: unknown =
      metadataCache.getFileCache(file)?.frontmatter?.['ir-id'];
    return typeof irId === 'string' ? irId : undefined;
  };
  // `getFileByPath` is a bare lookup: normalized as `ObsidianHelpers.getNote`
  // does it, or the scan disagrees with every other reader about a reference
  const noteAt: NoteAt = (path) => {
    const file = vault.getFileByPath(normalizePath(path));
    return file ? { irId: irIdOf(file) } : null;
  };

  // Deleted rows stay in the database and never move: they matter only for the
  // paths they hold, which is asked for by path once there is a move to place
  const stranded: ItemLocation[] = [];
  for (const table of ITEM_TABLES) {
    let after = 0;
    for (;;) {
      if (!(await breathe())) return [];
      const page = (await repo.query(
        `SELECT rowid, id, reference FROM ${table}
         WHERE rowid > $1 AND deleted = 0 ORDER BY rowid LIMIT $2`,
        [after, pageSize]
      )) as unknown as LocationRow[];
      for (const { id, reference } of page) {
        if (!(await breathe())) return [];
        const row: ItemLocation = { table, id, reference };
        if (isStranded(row, noteAt)) stranded.push(row);
      }
      if (page.length < pageSize) break;
      after = page[page.length - 1].rowid;
    }
  }
  if (stranded.length === 0) return [];

  const wanted = new Set(stranded.map((row) => row.id));
  const indexed: { path: string; id: string }[] = [];
  for (const file of vault.getMarkdownFiles()) {
    if (!(await breathe())) return [];
    const id = irIdOf(file);
    if (id !== undefined && wanted.has(id))
      indexed.push({ path: file.path, id });
  }
  // No note carries a stranded id: every one of them is gone, which the live
  // handlers deal with as notes turn up
  if (indexed.length === 0) return [];
  // The write cannot be broken up, so let the host go first and an abort land
  if (!(await breathe())) return [];

  // From here to the write nothing yields, so what is checked now still holds
  // when it lands. Notes can have moved on since they were indexed, though, and
  // planning without them holds back any move that depended on theirs.
  const pathsById = new Map<string, string[]>();
  for (const { path, id } of indexed) {
    if (noteAt(path)?.irId !== id) continue;
    pathsById.set(id, [...(pathsById.get(id) ?? []), path]);
  }
  const { moves, skipped: unresolved } = resolveMoves(stranded, pathsById);
  const targets = moves.map(({ to }) => to);
  const {
    relocations,
    skipped: conflicted,
    evicted,
  } = dropConflicts(moves, await holdersOf(repo, targets));

  // A missing note is usually one Sync has yet to deliver, and the live
  // handlers take it from there
  const unfollowed = [...unresolved, ...conflicted].filter(
    ({ reason }) => reason !== 'missing'
  );
  if (unfollowed.length > 0) {
    console.warn(
      'Incremental Reading - could not follow some moved notes:',
      unfollowed
    );
  }
  if (relocations.length === 0) return [];

  // Guarded on the row being where the scan read it: a live handler may have
  // moved or deleted it since, and its word is newer
  const landed = await repo.transaction(async () => {
    // Holders were read before the transaction opened. Read them again inside
    // it, where nothing else can commit, and hold back any move whose target
    // some other row has taken meanwhile. Landing on a taken path fails
    // `UNIQUE`, and that one failure would roll back every other move with it;
    // held back here, the rest still land and this one is followed next scan.
    //
    // The check cannot move to the parking pass below, which is what a plain
    // `NOT EXISTS` on the landing statement amounts to: a row that then failed
    // to land would be left sitting on its parking spot, pointing at a path no
    // note will ever be at. Nothing may park unless it is known to have
    // somewhere to go.
    const taken = await holdersOf(
      repo,
      relocations.map(({ to }) => to)
    );
    const ours = new Set([...relocations, ...evicted].map(rowKey));
    const landing = relocations.filter(({ to }) =>
      (taken.get(to) ?? []).every((holder) => ours.has(rowKey(holder)))
    );
    const wanted = new Set(landing.map(({ to }) => to));

    // Tombstones step aside first: nothing can land on a path one still names.
    // Guarded on it being the same deleted row at the same path, so a restore
    // that got in first keeps both its row and the reference it was given.
    for (const row of evicted) {
      if (!wanted.has(row.reference)) continue;
      await repo.mutate(
        `UPDATE ${row.table} SET reference = $1
         WHERE id = $2 AND reference = $3 AND deleted = 1`,
        [evictedSpot(row), row.id, row.reference]
      );
    }
    for (const move of landing) {
      await repo.mutate(
        `UPDATE ${move.table} SET reference = $1
         WHERE id = $2 AND reference = $3 AND deleted = 0`,
        [parkingSpot(move), move.id, move.from]
      );
    }
    for (const move of landing) {
      await repo.mutate(
        `UPDATE ${move.table} SET reference = $1
         WHERE id = $2 AND reference = $3`,
        [move.to, move.id, parkingSpot(move)]
      );
    }
    return landing;
  });

  const held = new Set(landed.map(rowKey));
  const beaten = relocations.filter((move) => !held.has(rowKey(move)));
  if (beaten.length > 0) {
    console.warn(
      'Incremental Reading - another row reached these paths first:',
      beaten
    );
  }
  // Bookkeeping rather than a problem to act on: the row, its schedule and its
  // history are all untouched, and only a path it had no note at is gone. Said
  // at debug level so support can see it happened without nagging the user
  // about a repair they neither asked for nor need to think about.
  const landedOn = new Set(landed.map(({ to }) => to));
  const freed = evicted.filter((row) => landedOn.has(row.reference));
  if (freed.length > 0) {
    console.debug(
      'Incremental Reading - freed paths held by deleted items:',
      freed
    );
  }
  return landed;
}
