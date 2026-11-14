import { purgedReference, REVIEW_LOG_OF } from '#/lib/items/row-delete';
import type { ItemTable } from '#/lib/moved-note-scan';
import type { WriteVector } from '#/lib/repository/write-stamp';
import type { SQLiteRepository } from '#/lib/types';
import type { Primitive } from '#/lib/utility-types';

/**
 * What an undo that discards an item noted of it when the action was taken,
 * to tell later whether another device has changed the item since (see
 * {@link changesSince}).
 */
export interface UndoFootprint {
  readonly table: ItemTable;
  readonly id: string;
  /** This device's id, whose own writes never count. */
  readonly device: string;
  /** The database's write stamp then: the saves of each device it held. */
  readonly seen: WriteVector;
  /** The item row's columns then, but for those {@link IGNORED} leaves out. */
  readonly snapshot: Readonly<Record<string, Primitive>>;
}

/**
 * What another device did to the items of an undo since it was recorded, of
 * what the undo discards with them: the item rows and their review logs.
 * Snippets and cards made from them there are not among it, as an undo
 * leaves them in place, moved up to what the item sat under.
 */
export interface ChangesElsewhere {
  /** The devices that did it, sorted. */
  readonly devices: readonly string[];
  /** What changed in the item rows, each once, sorted. */
  readonly edits: readonly ItemEdit[];
  /** Reviews of articles and snippets made there. */
  readonly reviews: number;
  /** Grades of cards made there. */
  readonly grades: number;
  /** Whether an article was rebound to a moved note there. */
  readonly relinked: boolean;
}

/** A change to an item row, as the user is told it. */
export type ItemEdit =
  | 'dismissed'
  | 'un-dismissed'
  | 'moved to the trash'
  | 'restored from the trash'
  | 'priority changed'
  | 'fixed interval changed'
  | 'edited';

type Repo = Pick<SQLiteRepository, 'query' | 'writeStamp'>;
type Row = Record<string, Primitive>;

/**
 * Item columns whose change alone is no work worth asking about: a stamp, a
 * reading position or a snippet's offsets, which merely opening the item or
 * editing its parent note writes, the fingerprint of its note, where its note
 * is (a move), and its schedule. A schedule follows from the review log,
 * whose rows are looked at on their own, and a merge replays it as the
 * device that merges, this one's own reviews included.
 */
const IGNORED: ReadonlySet<string> = new Set([
  'id',
  'reference',
  'scroll_top',
  'start_offset',
  'end_offset',
  'note_mtime',
  'updated_at',
  'updated_by',
  // Articles and snippets
  'due',
  'due_fuzz',
  'interval',
  // Cards, as ts-fsrs keeps them
  'last_review',
  'stability',
  'difficulty',
  'elapsed_days',
  'scheduled_days',
  'learning_steps',
  'reps',
  'lapses',
  'state',
]);

async function rowsOf(
  repo: Repo,
  query: string,
  params: Primitive[]
): Promise<Row[]> {
  return (await repo.query(query, params)) as unknown as Row[];
}

/** The `table` row `id`, unless there is none or it is deleted for good. */
async function liveRow(
  repo: Repo,
  table: ItemTable,
  id: string
): Promise<Row | null> {
  const [row] = await rowsOf(repo, `SELECT * FROM ${table} WHERE id = $1`, [
    id,
  ]);
  return row && row.reference !== purgedReference(id) ? row : null;
}

/**
 * Note what an undo of the action just taken on the `table` item `id` needs
 * to tell later whether another device has changed it since.
 * @returns null when it can't: the repository keeps no write stamps, or the
 *   item is gone
 */
export async function takeFootprint(
  repo: Repo,
  table: ItemTable,
  id: string
): Promise<UndoFootprint | null> {
  const stamp = repo.writeStamp?.() ?? null;
  if (!stamp) return null;
  const row = await liveRow(repo, table, id);
  if (!row) return null;
  return {
    table,
    id,
    device: stamp.device,
    seen: stamp.seen,
    snapshot: Object.fromEntries(
      Object.entries(row).filter(([column]) => !IGNORED.has(column))
    ),
  };
}

/** What changed between `then` and `now`, the same item row, as told. */
function editsOf(then: Row, now: Row): ItemEdit[] {
  return Object.keys(then)
    .filter((column) => then[column] !== now[column])
    .map((column): ItemEdit => {
      switch (column) {
        case 'dismissed':
          return now.dismissed ? 'dismissed' : 'un-dismissed';
        case 'deleted':
          return now.deleted ? 'moved to the trash' : 'restored from the trash';
        case 'priority':
          return 'priority changed';
        case 'fixed_interval_days':
          return 'fixed interval changed';
        default:
          return 'edited';
      }
    });
}

/**
 * What another device did to the items of `footprints` after they were
 * taken: a row whose stamp is another device's, from a save of that device
 * this one had not seen then. The stamps of a device's rows never exceed the
 * generation of its saves that hold them (see `SQLJSRepository`'s row clock),
 * however they arrived, so this holds through clock skew and fast-forwards
 * alike. An item gone since, or deleted for good, adds nothing: its undo
 * finds nothing left to take back.
 * @returns null when there is nothing
 */
export async function changesSince(
  repo: Repo,
  footprints: readonly UndoFootprint[]
): Promise<ChangesElsewhere | null> {
  const devices = new Set<string>();
  const edits = new Set<ItemEdit>();
  let reviews = 0;
  let grades = 0;
  let relinked = false;

  for (const { table, id, device, seen, snapshot } of footprints) {
    /** Whether `row` was written elsewhere after the footprint, saying who. */
    const newElsewhere = (row: Row) => {
      const by = row.updated_by;
      // An unstamped row predates stamps, and so the footprint
      if (typeof by !== 'string' || by === '' || by === device) return false;
      if (by in seen && Number(row.updated_at) <= seen[by]) return false;
      devices.add(by);
      return true;
    };

    const row = await liveRow(repo, table, id);
    if (!row) continue;
    // Told by the row's own stamp: a change this device wrote over since is
    // one the user has seen
    const changed = editsOf(snapshot, row);
    if (changed.length > 0 && newElsewhere(row)) {
      for (const edit of changed) edits.add(edit);
    }

    // A review undone there is gone already: discarding it loses nothing
    const [log, column] = REVIEW_LOG_OF[table];
    for (const review of await rowsOf(
      repo,
      `SELECT updated_at, updated_by FROM ${log}
       WHERE ${column} = $1 AND deleted = FALSE`,
      [id]
    )) {
      if (!newElsewhere(review)) continue;
      if (table === 'srs_card') grades++;
      else reviews++;
    }

    // Only an article is ever rebound: for anything else this finds nothing
    for (const rebind of await rowsOf(
      repo,
      'SELECT updated_at, updated_by FROM rebind WHERE article_id = $1',
      [id]
    )) {
      if (newElsewhere(rebind)) relinked = true;
    }
  }

  if (devices.size === 0) return null;
  return {
    devices: [...devices].sort(),
    edits: [...edits].sort(),
    reviews,
    grades,
    relinked,
  };
}

/** Whether `a` and `b` tell of the same changes. */
export function sameChanges(
  a: ChangesElsewhere | null,
  b: ChangesElsewhere | null
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `count` of `noun`, with an `s` for any count but one. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Where `changes` were made, as the user is told: no device has a name. */
export function changedWhere(changes: ChangesElsewhere): string {
  const { length } = changes.devices;
  return length === 1 ? 'another device' : `${length} other devices`;
}

/** What `changes` are, one phrase each, as the user is told. */
export function describeChanges(changes: ChangesElsewhere): string[] {
  const { edits, reviews, grades, relinked } = changes;
  const said: string[] = [...edits];
  if (reviews > 0) said.push(counted(reviews, 'review'));
  if (grades > 0) said.push(`graded ${counted(grades, 'time')}`);
  if (relinked) said.push('linked to a moved note');
  return said;
}
