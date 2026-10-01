import {
  normalizePath,
  type MetadataCache,
  type TFile,
  type Vault,
} from 'obsidian';
import { extensionOfPath, getMimeType, supportsFrontmatter } from './mime';
import { yieldToHost } from './pacing';
import {
  describeAmbiguous,
  describeRebind,
  describeReclaim,
  forgetRebind,
  isReclaimable,
  readRebinds,
  recordRebind,
} from './rebind-records';
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

/** The last segment of a vault path: a file's name, extension included. */
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Whether `row` is known by its path alone: an article in a format the plugin
 * knows but cannot keep an `ir-id` in, having no frontmatter (a PDF). A
 * reference of no format the plugin knows is left to the `ir-id` pass.
 */
export function isPathIdentified(row: ItemLocation): boolean {
  const file = { extension: extensionOfPath(row.reference) };
  return (
    row.table === 'article' &&
    getMimeType(file) !== null &&
    !supportsFrontmatter(file)
  );
}

/** `values`, grouped by the key each one gives. */
function groupBy<T>(values: readonly T[], keyOf: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

/**
 * Where each missing PDF row's file went. A PDF carries no `ir-id` to be
 * followed by, so it is followed by its filename (extension included) instead:
 * a row moves onto the one untracked PDF with the name its reference ends in,
 * provided no other missing row ends in that name too. Names are compared
 * exactly, case included, and on purpose: a file renamed in case alone while
 * Obsidian was closed is a renamed file, left missing like any other, for
 * **Relink file…** — never a guess that could pick the wrong file.
 *
 * No PDF bearing the name leaves the row missing; more than one, on either
 * side, leaves it ambiguous and for **Relink file…** to settle. Neither is
 * recorded anywhere: a row that is skipped is simply looked at again on the
 * next scan.
 *
 * Known blind spot: the name is all there is to go on, so a PDF that takes on
 * a missing file's name is taken for that file. Two PDFs that swap names while
 * Obsidian is closed are each bound to the other's row, and a PDF deleted
 * while closed is bound to an unrelated untracked one of the same name.
 */
export function matchPdfMoves(
  missing: readonly ItemLocation[],
  untracked: readonly string[]
): { moves: Move[]; skipped: Skip[] } {
  const nameOf = (row: ItemLocation) => fileName(row.reference);
  const rowsNamed = groupBy(missing, nameOf);
  const pathsNamed = groupBy(untracked, fileName);

  const moves: Move[] = [];
  const skipped: Skip[] = [];
  for (const row of missing) {
    const name = nameOf(row);
    const paths = pathsNamed.get(name);
    if (!paths) skipped.push({ row, reason: 'missing' });
    else if (paths.length > 1 || rowsNamed.get(name)?.length !== 1)
      skipped.push({ row, reason: 'ambiguous' });
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
export const PARAM_BATCH = 500;

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
  vault: Pick<Vault, 'getFileByPath' | 'getMarkdownFiles' | 'getFiles'>;
  metadataCache: Pick<MetadataCache, 'getFileCache'>;
  yieldToHost?: () => Promise<void>;
  /** Stops the scan at its next check; nothing is written once it fires. */
  signal?: AbortSignal;
  pageSize?: number;
  sliceMs?: number;
  /** The clock {@link sliceMs} is measured on. */
  now?: () => number;
  /** The wall clock rebinds are stamped with, and expire by. */
  dateNow?: () => number;
  /**
   * Where the scan records, once per scan, the PDFs it rebound or reclaimed
   * and those it had to leave missing for want of a unique filename.
   */
  log?: (entries: string[]) => unknown;
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
export async function holdersOf(
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
 * Obsidian closed, or before the plugin was ready to handle renames. PDF
 * articles, which have no frontmatter to carry an `ir-id`, are followed by
 * filename instead — see {@link matchPdfMoves}.
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
  dateNow = Date.now,
  log,
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
  // A PDF the scan rebound by filename can still be taken back by its own
  // file turning up at the old path; see `reclaimAtPath`
  const rebinds = await readRebinds(repo);

  // A PDF has no `ir-id` to be found by, so its rows are followed by filename
  // instead, and never looked for among the notes
  const strandedPdfs = stranded.filter(isPathIdentified);
  const strandedNotes = stranded.filter((row) => !isPathIdentified(row));

  const wanted = new Set(strandedNotes.map((row) => row.id));
  const indexed: { path: string; id: string }[] = [];
  if (strandedNotes.length > 0) {
    for (const file of vault.getMarkdownFiles()) {
      if (!(await breathe())) return [];
      const id = irIdOf(file);
      if (id !== undefined && wanted.has(id))
        indexed.push({ path: file.path, id });
    }
  }
  const names = new Set(strandedPdfs.map((row) => fileName(row.reference)));
  const namesakes: string[] = [];
  if (strandedPdfs.length > 0) {
    for (const file of vault.getFiles()) {
      if (!(await breathe())) return [];
      // Every name wanted is a PDF's, so a file bearing one is a PDF
      if (names.has(file.name)) namesakes.push(file.path);
    }
  }
  // No note carries a stranded id and no PDF a stranded name: every one of
  // them is gone, which the live handlers deal with as files turn up
  if (indexed.length === 0 && namesakes.length === 0 && rebinds.length === 0)
    return [];
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

  // A rebind whose article has moved on or outlived its window is forgotten.
  // One still open is taken back once a file is at its old path and no row
  // names that path, since by then the path's own claim is newer — unless
  // two articles were rebound away from it, with no telling whose file it is.
  // An article deleted since, with its stand-in, comes back to life with it.
  const wallNow = dateNow();
  const lapsed = rebinds.filter((record) => !isReclaimable(record, wallNow));
  const returning = rebinds.filter(
    (record) =>
      isReclaimable(record, wallNow) && noteAt(record.oldReference) !== null
  );
  const oldHolders = await holdersOf(
    repo,
    returning.map((record) => record.oldReference)
  );
  const claimants = groupBy(returning, (record) => record.oldReference);
  const homecomings = returning.filter(
    (record) =>
      !oldHolders.has(record.oldReference) &&
      claimants.get(record.oldReference)?.length === 1
  );
  const reclaims: Move[] = homecomings
    .filter((record) => !record.deleted)
    .map((record) => ({
      row: {
        table: 'article',
        id: record.articleId,
        reference: record.newReference,
      },
      to: record.oldReference,
    }));
  const revivals: Relocation[] = homecomings
    .filter((record) => record.deleted)
    .map((record) => ({
      table: 'article',
      id: record.articleId,
      from: record.newReference,
      to: record.oldReference,
    }));
  const reclaiming = new Set(reclaims.map(({ row }) => rowKey(row)));

  // Any row naming a PDF, even a tombstone, makes it that row's file: a PDF is
  // known by its path alone. So a PDF move never lands on a tombstone, and the
  // eviction below only ever makes way for notes.
  const present = namesakes.filter((path) => noteAt(path) !== null);
  const tracked = await holdersOf(repo, present);
  // A file at a rebind's old path is claimed already, if by no row yet: being
  // taken back, or contested by more than one article
  const reclaimed = new Set(returning.map((record) => record.oldReference));
  const untracked = present.filter(
    (path) => !tracked.has(path) && !reclaimed.has(path)
  );
  // A PDF back at home after all, between the scan's two looks, is not
  // missing; one being reclaimed is going back to its own file already
  const missingPdfs = strandedPdfs.filter(
    (row) => noteAt(row.reference) === null && !reclaiming.has(rowKey(row))
  );

  const notes = resolveMoves(strandedNotes, pathsById);
  const pdfs = matchPdfMoves(missingPdfs, untracked);
  const rebinding = new Set(pdfs.moves.map(({ row }) => rowKey(row)));
  const moves = [...notes.moves, ...pdfs.moves, ...reclaims];
  const unresolved = [...notes.skipped, ...pdfs.skipped];
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
      'Incremental Reading - could not follow some moved files:',
      unfollowed
    );
  }
  const entries = pdfs.skipped
    .filter(({ reason }) => reason === 'ambiguous')
    .map(({ row }) => describeAmbiguous(row));
  // The PDF moves the write really made, which alone are recorded and logged
  const settled = new Set<string>();
  const report = async (landed: Relocation[]) => {
    for (const move of landed) {
      if (!settled.has(rowKey(move))) continue;
      if (rebinding.has(rowKey(move))) entries.push(describeRebind(move));
      else entries.push(describeReclaim(move));
    }
    if (entries.length > 0) await log?.(entries);
    return landed;
  };
  if (relocations.length === 0 && lapsed.length === 0 && revivals.length === 0)
    return report([]);

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

    // A deleted article coming back to its own file is no move for the
    // passes above, which leave deleted rows be: it is restored in one step,
    // guarded on it still being the same tombstone, onto a path still free
    const free = await holdersOf(
      repo,
      revivals.map(({ to }) => to)
    );
    for (const move of revivals) {
      if (free.has(move.to)) continue;
      await repo.mutate(
        `UPDATE article SET reference = $1, deleted = 0
         WHERE id = $2 AND reference = $3 AND deleted = 1`,
        [move.to, move.id, move.from]
      );
    }

    // Filename rebinds are kept a while in case they were wrong; see
    // `reclaimAtPath`. Written in this transaction, so none lands unrecorded,
    // and only for a row the writes above really moved: a live handler may
    // have moved or deleted it since the scan read it.
    for (const record of lapsed) {
      await forgetRebind(repo, record.articleId, record.reboundAt);
    }
    const tracked = landing.filter(
      (move) => rebinding.has(rowKey(move)) || reclaiming.has(rowKey(move))
    );
    for (const move of [...tracked, ...revivals]) {
      // Every write above is guarded to leave a row alone that has moved on
      // since the scan read it, deleted rows included, so one at its target
      // is one this scan put there
      const [row] = (await repo.query(
        'SELECT reference FROM article WHERE id = $1',
        [move.id]
      )) as unknown as { reference: string }[];
      if (row?.reference !== move.to) continue;
      if (rebinding.has(rowKey(move))) await recordRebind(repo, move, wallNow);
      else await forgetRebind(repo, move.id);
      settled.add(rowKey(move));
    }
    return [
      ...landing,
      ...revivals.filter((move) => settled.has(rowKey(move))),
    ];
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
  return report(landed);
}
