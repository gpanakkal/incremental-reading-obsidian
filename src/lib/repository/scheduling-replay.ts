import { MS_PER_DAY, TEXT_BASE_REVIEW_INTERVAL } from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { NOT_PURGED } from '#/lib/items/row-delete';
import type { IArticleBase } from '#/lib/types';
import type { Database, SqlValue } from 'sql.js';
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type FSRS,
  type FSRSParameters,
  type Grade,
} from 'ts-fsrs';

/**
 * Scheduling columns are never taken from whichever copy of a row wins a
 * merge: an item whose review log the two copies disagree on gets them anew
 * from the merged log, so a review made on one device is never undone by a
 * row written on another without it.
 */

/** What replaying a log needs from the settings of this device. */
export interface ReplaySettings {
  /** The FSRS parameters cards are graded with now. */
  fsrsParams: Partial<FSRSParameters>;
  /**
   * Whether a text's due date is fuzzed when a review moves it, and a due
   * text row a merge brings without fuzz is given some (`mergeInto`), as is
   * one in a copy taken on whole (`fuzzTakenOn`).
   */
  fuzzTextReviews: boolean;
  /**
   * The rollover offset of the review day, in hours: a row a merge or
   * take-on brings is due, and so fuzzed, by the end of the day in progress
   * (`fuzzDueBy`). None, the default offset.
   */
  dayRolloverOffset?: number;
}

/** What a merge replays with when it is told nothing about the settings. */
export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = {
  fsrsParams: {},
  fuzzTextReviews: false,
};

/** One row of a review log: when, and whether it was undone. */
export interface LoggedReview {
  id: string;
  /** When the review was made, in ms. */
  at: number;
  /** Undone: a tombstone, which no replay counts. */
  deleted?: boolean | number;
}

/** One row of a card's review log. */
export interface LoggedGrade extends LoggedReview {
  rating: number;
}

/** The columns of `srs_card` a card's reviews decide. */
export interface CardSchedule {
  due: number;
  last_review: number | null;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
}

/** The columns of `article` and `snippet` a text's reviews decide. */
export interface TextSchedule {
  interval: number;
  due: number | null;
  due_fuzz: number | null;
}

/** What schedules a text besides its reviews, as the merged row has it. */
export interface TextRules {
  priority: number;
  /** Snippets have none. */
  fixed_interval_days?: number | null;
}

const CARD_COLUMNS = [
  'due',
  'last_review',
  'stability',
  'difficulty',
  'elapsed_days',
  'scheduled_days',
  'learning_steps',
  'reps',
  'lapses',
  'state',
] as const satisfies readonly (keyof CardSchedule)[];

const TEXT_COLUMNS = [
  'interval',
  'due',
  'due_fuzz',
] as const satisfies readonly (keyof TextSchedule)[];

/** The review logs replayed, and the item table each schedules. */
export const REPLAYED_LOGS = [
  {
    log: 'article_review',
    item: 'article',
    parent: 'article_id',
    at: 'review_time',
  },
  {
    log: 'snippet_review',
    item: 'snippet',
    parent: 'snippet_id',
    at: 'review_time',
  },
  { log: 'srs_card_review', item: 'srs_card', parent: 'card_id', at: 'review' },
] as const;

type ReplayedLog = (typeof REPLAYED_LOGS)[number];

/**
 * The reviews of `history` that count, in the order they are replayed:
 * by time, then by id, so reviews made in the same millisecond replay in
 * the same order on every device.
 */
export function liveInOrder<T extends LoggedReview>(
  history: readonly T[]
): T[] {
  return (
    history
      .filter((review) => !review.deleted)
      // Ids are unique: no two reviews compare equal
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  );
}

/**
 * Where a replay of `merged` can start: the copy whose log is the longest
 * run of reviews `merged` starts with, so that only the reviews after it
 * are replayed on top of that copy's schedule, which keeps what the log
 * doesn't record (a priority changed between reviews, the parameters a
 * card was graded with). Two different logs can't both be the same length
 * of run, so which copy is which never decides it.
 * @param copies the live reviews of each copy, in order
 * @param merged the live reviews after the merge, in order
 * @returns the index of that copy, or null when none is a start of
 * `merged` (a review of each was undone in the other, or the reviews of
 * the two interleave), and the reviews to replay from there
 */
export function startOf<T extends LoggedReview>(
  copies: readonly (readonly T[])[],
  merged: readonly T[]
): { from: number | null; rest: T[] } {
  let from: number | null = null;
  let length = 0;
  for (const [index, log] of copies.entries()) {
    const starts =
      log.length <= merged.length &&
      log.every((review, i) => review.id === merged[i].id);
    if (starts && (from === null || log.length > length)) {
      from = index;
      length = log.length;
    }
  }
  return { from, rest: merged.slice(length) };
}

/** A card as it is made, never graded (see `CardManager.insertRow`). */
export function initialCard(createdAt: number): CardSchedule {
  // New cards are due the day after they are made
  return toCardSchedule(createEmptyCard(new Date(createdAt + MS_PER_DAY)));
}

/**
 * `from` graded with each live review of `history` in turn, as
 * `CardManager.review` grades it, with the FSRS parameters `params`.
 *
 * This is ts-fsrs's `reschedule` loop (5.4.1: `Reschedule.replay` is
 * `next` per review, manual ratings skipped). `reschedule` itself always
 * starts from a new card (`createEmptyCard(first_card.due)`), so it can't
 * go on from the schedule a copy already holds. Fuzz, when on, is seeded
 * from each review's time and the card's state, so a replay draws what the
 * grading drew.
 */
export function replayCard(
  history: readonly LoggedGrade[],
  params: Partial<FSRSParameters>,
  from: CardSchedule
): CardSchedule {
  return replayCardWith(fsrs(generatorParameters(params)), history, from);
}

/** {@link replayCard} with a scheduler made once for many cards. */
function replayCardWith(
  scheduler: FSRS,
  history: readonly LoggedGrade[],
  from: CardSchedule
): CardSchedule {
  let card: Card = toCard(from);
  for (const { at, rating } of liveInOrder(history)) {
    if (rating === Number(Rating.Manual)) continue;
    card = scheduler.next(card, new Date(at), rating as Grade).card;
  }
  return toCardSchedule(card);
}

/**
 * A text as no review has left it: at the base interval its first review
 * grows, due when `row` is. What a text's due date was before its first
 * review is in no log, so it is the row's: undoing the reviews of a text
 * puts that date back (`ArticleManager.undoReview`). Replays start here only
 * when neither copy's log starts the merged one (see {@link startOf}).
 */
export function initialText(
  row: Pick<TextSchedule, 'due' | 'due_fuzz'>
): TextSchedule {
  return {
    interval: TEXT_BASE_REVIEW_INTERVAL,
    due: row.due,
    due_fuzz: row.due_fuzz,
  };
}

/**
 * `from` reviewed at each live review of `history` in turn, as
 * `ArticleManager.review` and `SnippetManager.review` review it under
 * `rules`: each review grows the interval (`IRScheduler.nextInterval`) and
 * makes the text due that long after it. A due date a review moved gets a
 * new fuzz when text reviews are fuzzed.
 */
export function replayText(
  history: readonly LoggedReview[],
  rules: TextRules,
  settings: Pick<ReplaySettings, 'fuzzTextReviews'>,
  from: TextSchedule
): TextSchedule {
  const reviews = liveInOrder(history);
  if (reviews.length === 0) return from;
  let { interval } = from;
  for (const _review of reviews) {
    // 0165's elapsed-time rule would take the gap since the previous
    // review here
    interval = IRScheduler.nextInterval({
      fixed_interval_days: rules.fixed_interval_days ?? null,
      priority: rules.priority,
      interval,
    } as IArticleBase);
  }
  return {
    interval,
    due: reviews[reviews.length - 1].at + interval,
    due_fuzz: settings.fuzzTextReviews
      ? IRScheduler.getDueFuzz()
      : from.due_fuzz,
  };
}

/**
 * `schedule`, which a text reviewed `log` holds under the rules `was`, as
 * changing them to `now` after those reviews leaves it: the priority first
 * (`reprioritize`: the interval rescaled, due that long after the last
 * review), then the fixed interval (`setFixedInterval`: due that long after
 * it; `disableFixedInterval`: grown from the base once per review under the
 * new priority). A replay that goes on from a copy whose rules lost the merge
 * starts here, so its schedule agrees with the rules of the row that won,
 * not with the ones it was reviewed under.
 */
export function underRules(
  schedule: TextSchedule,
  was: TextRules,
  now: TextRules,
  log: readonly LoggedReview[]
): TextSchedule {
  const wasFixed = was.fixed_interval_days ?? null;
  const nowFixed = now.fixed_interval_days ?? null;
  const reviews = liveInOrder(log);
  const last = reviews.length ? reviews[reviews.length - 1].at : undefined;
  const after = (interval: number) =>
    last === undefined ? schedule.due : last + interval;
  if (wasFixed !== null && nowFixed === null) {
    // As `disableFixedInterval`, which 0165 changes: the oracle test pins it
    const interval =
      TEXT_BASE_REVIEW_INTERVAL *
      IRScheduler.getIntervalMultiplier(now.priority) ** reviews.length;
    return { ...schedule, interval, due: after(interval) };
  }
  const rescaled = {
    ...schedule,
    ...IRScheduler.reprioritize(
      {
        ...schedule,
        priority: was.priority,
        fixed_interval_days: wasFixed,
      } as IArticleBase,
      now.priority,
      last
    ),
  };
  return nowFixed === null || nowFixed === wasFixed
    ? rescaled
    : { ...rescaled, due: after(nowFixed * MS_PER_DAY) };
}

function toCard(schedule: CardSchedule): Card {
  const { due, last_review, ...rest } = schedule;
  return {
    ...rest,
    due: new Date(due),
    ...(last_review !== null && { last_review: new Date(last_review) }),
  } as Card;
}

function toCardSchedule(card: Card): CardSchedule {
  return {
    due: card.due.getTime(),
    last_review: card.last_review ? card.last_review.getTime() : null,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
  };
}

// #region Merge

type Row = Record<string, SqlValue>;

/** One item whose copies disagree on its log, as the copies had it. */
interface Divergence {
  /** Each copy's live reviews in order: this device's, then the other's. */
  logs: LoggedGrade[][];
  /** Each copy's scheduling columns, in the same order. */
  schedules: Row[];
  /** Each copy's rules (texts: priority, fixed interval), in that order. */
  rules: Row[];
}

/** What {@link replaySchedules} needs, read before a merge writes. */
export type Divergences = Map<ReplayedLog, Map<string, Divergence>>;

function rowsOf(db: Database, sql: string, params: SqlValue[] = []): Row[] {
  const statement = db.prepare(sql, params);
  const rows: Row[] = [];
  try {
    // As `getAsObject`, which asks for the column names again for every row
    const names = statement.getColumnNames();
    while (statement.step()) {
      const values = statement.get();
      const row: Row = {};
      names.forEach((name, i) => (row[name] = values[i]));
      rows.push(row);
    }
  } finally {
    statement.free();
  }
  return rows;
}

const columnsOf = (item: ReplayedLog['item']) =>
  item === 'srs_card' ? CARD_COLUMNS : TEXT_COLUMNS;

/** The columns besides its reviews that schedule an item (see `TextRules`). */
const RULE_COLUMNS = {
  article: ['priority', 'fixed_interval_days'],
  snippet: ['priority'],
  srs_card: [],
} as const satisfies Record<ReplayedLog['item'], readonly (keyof TextRules)[]>;

/**
 * `schema`'s log of each item of `ids` under `table`, every row, as replays
 * read them, by item: one statement for every item, by the index on the
 * log's item column (migration v14).
 * @param ids the items, as a JSON array (see {@link jsonIds})
 */
function logsOf(
  db: Database,
  schema: string,
  table: ReplayedLog,
  ids: string
): Map<string, LoggedGrade[]> {
  const rating = table.item === 'srs_card' ? 'rating' : 'NULL';
  const logs = new Map<string, LoggedGrade[]>();
  const rows = rowsOf(
    db,
    `SELECT ${table.parent} AS item, id, ${table.at} AS at,
       ${rating} AS rating, deleted
     FROM ${schema}.${table.log}
     WHERE ${table.parent} IN (SELECT value FROM json_each(?))`,
    [ids]
  );
  for (const { item, ...review } of rows) {
    const log = logs.get(item as string) ?? [];
    log.push(review as unknown as LoggedGrade);
    logs.set(item as string, log);
  }
  return logs;
}

/**
 * `schema`'s rows of `table` keyed `ids`, by id, with the columns `columns`
 * (and the id), as one statement.
 * @param ids the rows, as a JSON array (see {@link jsonIds})
 * @param where a further condition the rows must meet
 */
function rowsById(
  db: Database,
  schema: string,
  table: string,
  columns: string,
  ids: string,
  where = 'TRUE'
): Map<string, Row> {
  const rows = rowsOf(
    db,
    `SELECT id AS ir_id, ${columns} FROM ${schema}.${table}
     WHERE id IN (SELECT value FROM json_each(?)) AND ${where}`,
    [ids]
  );
  return new Map(rows.map(({ ir_id, ...row }) => [ir_id as string, row]));
}

/** `ids` as the JSON array SQL reads them from (`json_each`). */
const jsonIds = (ids: Iterable<string>) => JSON.stringify([...ids]);

/**
 * The items both copies hold whose live reviews differ between the main
 * database and the copy attached as `incoming`: a review one has that the
 * other lacks or has undone. An item only one copy holds has its whole log
 * there, already behind its row, so there is nothing to reconcile. Read
 * before the merge writes, as each copy's log and schedule are what decide
 * where a replay starts (see {@link startOf}).
 */
export function readDivergences(db: Database, incoming: string): Divergences {
  const divergences: Divergences = new Map();
  for (const table of REPLAYED_LOGS) {
    const { log, item, parent } = table;
    const onlyLiveIn = (here: string, there: string) => `
      SELECT a.${parent} AS item FROM ${here}.${log} a
      LEFT JOIN ${there}.${log} b ON b.id = a.id
      WHERE a.deleted = 0 AND (b.id IS NULL OR b.deleted <> 0)`;
    // Materialized, the copies are compared once, not once per filter
    const ids = rowsOf(
      db,
      `WITH diverged (item) AS MATERIALIZED (
         ${onlyLiveIn('main', incoming)} UNION ${onlyLiveIn(incoming, 'main')}
       )
       SELECT item FROM diverged
       WHERE item IN (SELECT id FROM main.${item})
         AND item IN (SELECT id FROM ${incoming}.${item})`
    ).map((row) => row.item as string);
    const items = new Map<string, Divergence>();
    divergences.set(table, items);
    const columns = columnsOf(item);
    const rules: readonly string[] = RULE_COLUMNS[item];
    const list = jsonIds(ids);
    const schemas = ['main', incoming];
    const read = schemas.map((schema) => ({
      rows: rowsById(db, schema, item, [...columns, ...rules].join(', '), list),
      logs: logsOf(db, schema, table, list),
    }));
    const only = (row: Row, keys: readonly string[]) =>
      Object.fromEntries(keys.map((key) => [key, row[key]]));
    for (const id of ids) {
      const rows = read.map(({ rows }) => rows.get(id)!);
      items.set(id, {
        logs: read.map(({ logs }) => liveInOrder(logs.get(id) ?? [])),
        schedules: rows.map((row) => only(row, columns)),
        rules: rows.map((row) => only(row, rules)),
      });
    }
  }
  return divergences;
}

/**
 * Give every item of `divergences` the schedule its merged log implies,
 * once the merge has written: replayed from the copy whose log the merged
 * one starts with (a text's schedule first put under the merged row's rules,
 * see {@link underRules}), or from scratch. Rows a purge left are skipped. Each row
 * is rewritten by one `UPDATE`, so the stamp triggers, armed by the caller,
 * stamp it as this device's write, and skip it if nothing changed.
 * @returns how many rows changed
 */
export function replaySchedules(
  db: Database,
  divergences: Divergences,
  settings: ReplaySettings
): number {
  let changed = 0;
  const scheduler = fsrs(generatorParameters(settings.fsrsParams));
  for (const [table, items] of divergences) {
    const { item } = table;
    const columns = columnsOf(item);
    const list = jsonIds(items.keys());
    // Every row is read before any is written, which changes no read: each
    // write is to its own row, and the reads are of the rows' own columns
    const rows = rowsById(db, 'main', item, '*', list, NOT_PURGED);
    const histories = logsOf(db, 'main', table, list);
    const update = db.prepare(
      `UPDATE ${item} SET ${columns.map((c) => `${c} = ?`).join(', ')}
       WHERE id = ?`
    );
    try {
      for (const [id, { logs, schedules, rules }] of items) {
        const row = rows.get(id);
        if (!row) continue;
        const { from, rest } = startOf(
          logs,
          liveInOrder(histories.get(id) ?? [])
        );
        const schedule =
          item === 'srs_card'
            ? replayCardWith(
                scheduler,
                rest,
                from === null
                  ? initialCard(row.created_at as number)
                  : (schedules[from] as unknown as CardSchedule)
              )
            : replayText(
                rest,
                row as unknown as TextRules,
                settings,
                from === null
                  ? initialText(row as unknown as TextSchedule)
                  : underRules(
                      schedules[from] as unknown as TextSchedule,
                      rules[from] as unknown as TextRules,
                      row as unknown as TextRules,
                      logs[from]
                    )
              );
        update.run([
          ...columns.map(
            (c) => (schedule as unknown as Record<string, SqlValue>)[c]
          ),
          id,
        ]);
        changed += db.getRowsModified();
      }
    } finally {
      update.free();
    }
  }
  return changed;
}

// #endregion
