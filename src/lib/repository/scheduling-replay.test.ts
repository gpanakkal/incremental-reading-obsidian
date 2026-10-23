import { migrations } from '#/db/migrations';
import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ArticleManager } from '#/lib/items/ArticleManager';
import { CardManager } from '#/lib/items/CardManager';
import { PURGED_REFERENCE_PREFIX } from '#/lib/items/row-delete';
import { SnippetManager } from '#/lib/items/SnippetManager';
import SRSCard from '#/lib/items/SRSCard';
import { TestRepository } from '#/test/item-vault';
import { makeLinkVault } from '#/test/link-vault';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import {
  createEmptyCard,
  generatorParameters,
  Rating,
  type FSRSParameters,
  type Grade,
} from 'ts-fsrs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MERGE_TABLES, mergeInto, openIncoming } from './row-merge';
import { armRowStamps, type StampSource } from './row-stamps';
import {
  DEFAULT_REPLAY_SETTINGS,
  initialCard,
  initialText,
  liveInOrder,
  replayCard,
  REPLAYED_LOGS,
  replayText,
  startOf,
  underRules,
  type CardSchedule,
  type LoggedGrade,
  type LoggedReview,
  type ReplaySettings,
  type TextSchedule,
} from './scheduling-replay';

// #region HELPERS

const SCHEMA = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
const T = 1_790_000_000_000;
const DAY = MS_PER_DAY;
/** What the fuzz spy draws: never a fuzz a fixture starts with. */
const DRAWN_FUZZ = -7;

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
] as const;
const TEXT_COLUMNS = ['interval', 'due', 'due_fuzz'] as const;

type Row = Record<string, number | string | null>;

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Databases opened by a test, closed after it. */
let open: Database[] = [];
afterEach(() => {
  for (const db of open) db.close();
  open = [];
  vi.restoreAllMocks();
});

function pick<K extends string>(row: Row, columns: readonly K[]) {
  return Object.fromEntries(columns.map((c) => [c, row[c]])) as Record<
    K,
    Row[string]
  >;
}

function rowsOf(db: Database, sql: string, params: (string | number)[] = []) {
  const statement = db.prepare(sql, params);
  const rows: Row[] = [];
  while (statement.step()) rows.push(statement.getAsObject() as Row);
  statement.free();
  return rows;
}

const fsrsParamsArb: fc.Arbitrary<Partial<FSRSParameters>> = fc.record({
  request_retention: fc.double({ min: 0.7, max: 0.99, noNaN: true }),
  maximum_interval: fc.integer({ min: 1, max: 36_500 }),
  enable_fuzz: fc.boolean(),
  enable_short_term: fc.boolean(),
  learning_steps: fc.constantFrom([], ['1m', '10m'], ['10m'], ['1d']),
  relearning_steps: fc.constantFrom([], ['10m'], ['1h', '1d']),
});

const gradeArb = fc.constantFrom<Grade>(
  Rating.Again,
  Rating.Hard,
  Rating.Good,
  Rating.Easy
);

const priorityArb = fc.integer({
  min: MINIMUM_PRIORITY,
  max: MAXIMUM_PRIORITY,
});
const fixedArb = fc.option(
  fc.integer({ min: 1, max: MAXIMUM_FIXED_REVIEW_INTERVAL }),
  { nil: null }
);

/** A plugin stub carrying just the settings reviews read. */
function plugin(settings: Partial<ReplaySettings>) {
  return {
    app: {},
    settings: {
      fsrsParams: generatorParameters(settings.fsrsParams),
      fuzzTextReviews: settings.fuzzTextReviews ?? false,
      dayRolloverOffset: 4,
    },
  } as never;
}

// `query` answers at once on sql.js, though typed for any repository

function storedRow(repo: TestRepository, table: string, id: string) {
  return (
    repo.query(`SELECT * FROM ${table} WHERE id = $1`, [id]) as unknown as Row[]
  )[0];
}

function textLog(repo: TestRepository, table: string, parent: string) {
  return repo.query(
    `SELECT id, review_time AS at, deleted FROM ${table} WHERE ${parent} = $1`,
    ['t']
  ) as unknown as LoggedReview[];
}

// One device's copy, rows and stamps as given

interface Stamped {
  updated_at?: number;
  updated_by?: string;
}

interface TextSeed extends Stamped {
  id: string;
  reference?: string;
  priority?: number;
  fixed_interval_days?: number | null;
  dismissed?: number;
  deleted?: number;
  scroll_top?: number;
  schedule: TextSchedule;
}

interface CardSeed extends Stamped {
  id: string;
  reference?: string;
  created_at: number;
  dismissed?: number;
  schedule: CardSchedule;
}

interface ReviewSeed extends Stamped {
  id: string;
  item: string;
  at: number;
  rating?: number;
  deleted?: number;
}

interface Copy {
  articles?: TextSeed[];
  snippets?: TextSeed[];
  cards?: CardSeed[];
  articleReviews?: ReviewSeed[];
  snippetReviews?: ReviewSeed[];
  cardReviews?: ReviewSeed[];
}

const HERE: StampSource = { deviceId: () => 'here', now: () => T };

let emptyBytes: Uint8Array | null = null;

function build(copy: Copy, armed = false): Database {
  if (!emptyBytes) {
    const empty = new SQL.Database();
    empty.exec(SCHEMA);
    emptyBytes = empty.export();
    empty.close();
  }
  const db = new SQL.Database(emptyBytes);
  open.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  const stamp = (s: Stamped) => [s.updated_at ?? 1, s.updated_by ?? 'x'];
  for (const [table, seeds] of [
    ['article', copy.articles],
    ['snippet', copy.snippets],
  ] as const) {
    for (const t of seeds ?? []) {
      const fixed = table === 'article' ? ', fixed_interval_days' : '';
      db.run(
        `INSERT INTO ${table} (id, reference, priority, dismissed, deleted,
           scroll_top, interval, due, due_fuzz, updated_at, updated_by${fixed})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${fixed ? ', ?' : ''})`,
        [
          t.id,
          t.reference ?? `${table}/${t.id}.md`,
          t.priority ?? 30,
          t.dismissed ?? 0,
          t.deleted ?? 0,
          t.scroll_top ?? 0,
          t.schedule.interval,
          t.schedule.due,
          t.schedule.due_fuzz,
          ...stamp(t),
          ...(fixed ? [t.fixed_interval_days ?? null] : []),
        ]
      );
    }
  }
  for (const c of copy.cards ?? []) {
    db.run(
      `INSERT INTO srs_card (id, reference, created_at, dismissed,
         ${CARD_COLUMNS.join(', ')}, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ${CARD_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      [
        c.id,
        c.reference ?? `cards/${c.id}.md`,
        c.created_at,
        c.dismissed ?? 0,
        ...CARD_COLUMNS.map((k) => c.schedule[k]),
        ...stamp(c),
      ]
    );
  }
  for (const [table, parent, seeds] of [
    ['article_review', 'article_id', copy.articleReviews],
    ['snippet_review', 'snippet_id', copy.snippetReviews],
  ] as const) {
    for (const r of seeds ?? []) {
      db.run(
        `INSERT INTO ${table} (id, ${parent}, review_time, deleted,
           updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [r.id, r.item, r.at, r.deleted ?? 0, ...stamp(r)]
      );
    }
  }
  for (const r of copy.cardReviews ?? []) {
    db.run(
      `INSERT INTO srs_card_review (id, card_id, due, review, stability,
         difficulty, elapsed_days, last_elapsed_days, scheduled_days, rating,
         state, deleted, updated_at, updated_by)
       VALUES (?, ?, 0, ?, 0, 0, 0, 0, 0, ?, 0, ?, ?, ?)`,
      [r.id, r.item, r.at, r.rating ?? Rating.Good, r.deleted ?? 0, ...stamp(r)]
    );
  }
  if (armed) armRowStamps(db, HERE);
  return db;
}

function incoming(copy: Copy): Database {
  const source = build(copy);
  const db = openIncoming(SQL, source.export(), migrations);
  open.push(db);
  return db;
}

/** Merge `theirs` into `mine`, replaying with `settings` unless null. */
function merged(
  mine: Copy,
  theirs: Copy,
  settings: ReplaySettings | null = DEFAULT_REPLAY_SETTINGS
) {
  const db = build(mine, true);
  const report = mergeInto(db, incoming(theirs), HERE, settings ?? undefined);
  return { db, report };
}

function everything(db: Database): Record<string, Row[]> {
  return Object.fromEntries(
    MERGE_TABLES.map(({ name, key }) => [
      name,
      rowsOf(db, `SELECT * FROM ${name} ORDER BY ${key}`),
    ])
  );
}

function row(db: Database, table: string, id: string): Row {
  return rowsOf(db, `SELECT * FROM ${table} WHERE id = ?`, [id])[0];
}

const text = (
  interval: number,
  due: number | null,
  due_fuzz: number | null = null
): TextSchedule => ({ interval, due, due_fuzz });

/** A text's schedule after `log`, replayed from its first one. */
function textAfter(
  log: readonly LoggedReview[],
  rules: { priority: number; fixed_interval_days?: number | null },
  start: TextSchedule
) {
  return replayText(log, rules, { fuzzTextReviews: false }, start);
}

/** A history of reviews, each made on one device, the other, or both. */
interface Event {
  at: number;
  rating: Grade;
  /** 0: this device only, 1: the other only, 2: both. */
  on: 0 | 1 | 2;
  /** Undone on: never, this device, the other. */
  undone: 0 | 1 | 2;
}

const eventsArb = fc.array(
  fc.record({
    at: fc.integer({ min: T, max: T + 400 * DAY }),
    rating: gradeArb,
    on: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
    undone: fc.constantFrom<0 | 1 | 2>(0, 0, 1, 2),
  }),
  { maxLength: 8 }
);

/**
 * Each copy's log of `events`: a review undone on a device is a tombstone
 * there, and on the other only if that device has the review at all.
 */
function logsOf(events: readonly Event[], item: string) {
  const copies: ReviewSeed[][] = [[], []];
  for (const [i, e] of events.entries()) {
    for (const side of [0, 1] as const) {
      const has = e.on === 2 || e.on === side || e.undone === side + 1;
      if (!has) continue;
      copies[side].push({
        id: `r${i}`,
        item,
        at: e.at,
        rating: e.rating,
        deleted: e.undone === side + 1 ? 1 : 0,
      });
    }
  }
  return copies;
}

/** The merged log: every review either copy has, undone if either undid it. */
function mergedLog(copies: readonly ReviewSeed[][]): LoggedGrade[] {
  const byId = new Map<string, LoggedGrade>();
  for (const r of copies.flat()) {
    const seen = byId.get(r.id);
    byId.set(r.id, {
      id: r.id,
      at: r.at,
      rating: r.rating ?? Rating.Good,
      deleted: (seen?.deleted ? 1 : 0) || r.deleted || 0,
    });
  }
  return [...byId.values()];
}

const asLog = (seeds: readonly ReviewSeed[]): LoggedGrade[] =>
  seeds.map((s) => ({
    id: s.id,
    at: s.at,
    rating: s.rating ?? Rating.Good,
    deleted: s.deleted ?? 0,
  }));

// #endregion

describe('liveInOrder', () => {
  it('keeps the reviews not undone, by time and then id, whatever order they come in', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.string({ maxLength: 4 }),
            at: fc.integer({ min: 0, max: 5 }),
            deleted: fc.oneof(
              fc.boolean(),
              fc.constantFrom(0, 1),
              fc.constant(undefined)
            ),
          }),
          { selector: (r) => r.id }
        ),
        (history) => {
          const live = liveInOrder(history);
          expect(live).toEqual(liveInOrder([...history].reverse()));
          expect(new Set(live)).toEqual(
            new Set(history.filter((r) => !r.deleted))
          );
          for (let i = 1; i < live.length; i++) {
            const [a, b] = [live[i - 1], live[i]];
            expect(a.at < b.at || (a.at === b.at && a.id < b.id)).toBe(true);
          }
        }
      )
    );
  });

  it('leaves the history it is given as it was', () => {
    const history = [
      { id: 'b', at: 2 },
      { id: 'a', at: 1, deleted: 1 },
    ];
    const copy = structuredClone(history);
    liveInOrder(history);
    expect(history).toEqual(copy);
  });
});

describe('startOf', () => {
  const logArb = fc
    .uniqueArray(fc.integer({ min: 0, max: 9 }), { maxLength: 6 })
    .map((ids) => ids.map((n) => ({ id: `r${n}`, at: n })));

  it('starts from the copy whose log is the longest start of the merged one, replaying the rest', () => {
    fc.assert(
      fc.property(
        fc.array(logArb, { maxLength: 3 }),
        logArb,
        (copies, merged) => {
          const { from, rest } = startOf(copies, merged);
          const starts = (log: readonly { id: string }[]) =>
            log.length <= merged.length &&
            log.every((r, i) => r.id === merged[i].id);
          const longest = Math.max(
            -1,
            ...copies.filter(starts).map((log) => log.length)
          );
          if (longest < 0) {
            expect(from).toBeNull();
            expect(rest).toEqual(merged);
          } else {
            expect(from).not.toBeNull();
            expect(starts(copies[from!])).toBe(true);
            expect(copies[from!]).toHaveLength(longest);
            expect(
              copies.findIndex((log) => starts(log) && log.length === longest)
            ).toBe(from);
            expect(rest).toEqual(merged.slice(longest));
          }
        }
      )
    );
  });

  it('picks the same copy whichever way round two different logs come', () => {
    fc.assert(
      fc.property(logArb, logArb, logArb, (a, b, merged) => {
        fc.pre(JSON.stringify(a) !== JSON.stringify(b));
        const forward = startOf([a, b], merged);
        const backward = startOf([b, a], merged);
        expect(backward.rest).toEqual(forward.rest);
        expect(backward.from).toBe(
          forward.from === null ? null : 1 - forward.from
        );
      })
    );
  });
});

describe('replayCard', () => {
  it('replays the grades of a card to the row grading it left, back to a new card once every grade is undone', async () => {
    await fc.assert(
      fc.asyncProperty(
        fsrsParamsArb,
        fc.integer({ min: T - 400 * DAY, max: T }),
        // Grades a millisecond apart at least: grades made in the same one
        // replay in id order, which needn't be the order they were made in
        fc.array(
          fc.record({
            grade: gradeArb,
            gap: fc.oneof(
              fc.integer({ min: 1, max: 60_000 }),
              fc.integer({ min: 1, max: 90 * DAY })
            ),
          }),
          { maxLength: 10 }
        ),
        fc.boolean(),
        async (fsrsParams, createdAt, grades, undoAll) => {
          const repo = await TestRepository.create();
          const manager = new CardManager(plugin({ fsrsParams }), repo);
          const card = new SRSCard('cards/c.md', new Date(createdAt));
          card.id = 'c';
          // The row records its note's fingerprint, so the note needs a `stat`
          const file = makeLinkVault({ 'cards/c.md': {} }).files.get(
            'cards/c.md'
          )!;
          await (
            manager as unknown as {
              insertRow(
                card: SRSCard,
                parent: null,
                file: TFile
              ): Promise<void>;
            }
          ).insertRow(card, null, file);
          let at = createdAt;
          let first: { id: string; before: Row } | null = null;
          for (const { grade, gap } of grades) {
            at += gap;
            const before = storedRow(repo, 'srs_card', 'c');
            const id = await manager.review(
              CardManager.rowToDisplay(before as never),
              grade,
              new Date(at)
            );
            first ??= { id, before };
          }
          if (undoAll && first) {
            await manager.rollbackBeforeReview(
              CardManager.rowToDisplay(first.before as never),
              first.id
            );
          }

          const stored = storedRow(repo, 'srs_card', 'c');
          const log = repo.query(
            `SELECT id, review AS at, rating, deleted FROM srs_card_review`
          ) as unknown as LoggedGrade[];
          expect(
            replayCard(
              log,
              fsrsParams,
              initialCard(stored.created_at as number)
            )
          ).toEqual(pick(stored, CARD_COLUMNS));
        }
      ),
      { numRuns: 60 }
    );
  }, 60_000);

  it('makes a new card due the day after it is made, ungraded', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4e12 }), (createdAt) => {
        const card = createEmptyCard(new Date(createdAt));
        expect(initialCard(createdAt)).toEqual({
          due: createdAt + DAY,
          last_review: null,
          stability: card.stability,
          difficulty: card.difficulty,
          elapsed_days: card.elapsed_days,
          scheduled_days: card.scheduled_days,
          learning_steps: card.learning_steps,
          reps: 0,
          lapses: 0,
          state: card.state,
        });
      })
    );
  });

  it('counts no undone or manual grade, in whatever order the log comes', () => {
    fc.assert(
      fc.property(
        fsrsParamsArb,
        fc.uniqueArray(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 3 }),
            at: fc.integer({ min: T, max: T + 3 * DAY }),
            rating: fc.constantFrom(
              Rating.Manual,
              Rating.Again,
              Rating.Hard,
              Rating.Good,
              Rating.Easy
            ),
            deleted: fc.constantFrom(0, 1),
          }),
          { selector: (r) => r.id, maxLength: 8 }
        ),
        (params, log) => {
          const start = initialCard(T - DAY);
          const counted = log.filter(
            (r) => !r.deleted && r.rating !== Rating.Manual
          );
          expect(replayCard([...log].reverse(), params, start)).toEqual(
            replayCard(counted, params, start)
          );
          expect(replayCard(log, params, start).reps).toBe(counted.length);
        }
      )
    );
  });

  it('goes on from the schedule it starts at', () => {
    const params = { enable_fuzz: false };
    const graded = replayCard(
      [{ id: 'a', at: T, rating: Rating.Good }],
      params,
      initialCard(T - DAY)
    );
    const later = { id: 'b', at: T + 5 * DAY, rating: Rating.Again };
    expect(replayCard([later], params, graded)).toEqual(
      replayCard(
        [{ id: 'a', at: T, rating: Rating.Good }, later],
        params,
        initialCard(T - DAY)
      )
    );
    expect(replayCard([], params, graded)).toEqual(graded);
  });
});

describe('replayText', () => {
  it('replays the reviews of a text to the row reviewing and undoing left', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('article', 'snippet'),
        priorityArb,
        fixedArb,
        fc.boolean(),
        fc.integer({ min: T - 30 * DAY, max: T + 30 * DAY }),
        fc.option(fc.integer({ min: 0, max: 6 * 3_600_000 }), { nil: null }),
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('review' as const),
              // Never back in time: a replay goes by time, not by the order
              // reviews were made in, so a clock gone back between two of
              // them dates the text from the later one by time
              gap: fc.oneof(
                fc.constant(0),
                fc.integer({ min: 1, max: 90 * DAY })
              ),
            }),
            fc.record({ kind: fc.constant('undo' as const) })
          ),
          { maxLength: 12 }
        ),
        async (kind, priority, fixed, fuzzTextReviews, due, fuzz, steps) => {
          vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(DRAWN_FUZZ);
          const repo = await TestRepository.create();
          const settings = { fuzzTextReviews };
          const fixedDays = kind === 'article' ? fixed : null;
          if (kind === 'article') {
            repo.mutate(
              `INSERT INTO article (id, reference, due, interval, priority,
                 fixed_interval_days, due_fuzz) VALUES ('t', 'a.md', $1, $2, $3, $4, $5)`,
              [due, TEXT_BASE_REVIEW_INTERVAL, priority, fixedDays, fuzz]
            );
          } else {
            repo.mutate(
              `INSERT INTO snippet (id, reference, due, interval, priority,
                 due_fuzz) VALUES ('t', 's.md', $1, $2, $3, $4)`,
              [due, TEXT_BASE_REVIEW_INTERVAL, priority, fuzz]
            );
          }
          const manager =
            kind === 'article'
              ? new ArticleManager(plugin(settings), repo)
              : new SnippetManager(plugin(settings), repo);
          const imported = storedRow(repo, kind, 't');
          const undo: { id: string; before: Row }[] = [];
          let at = T;
          for (const step of steps) {
            const current = storedRow(repo, kind, 't');
            const base = {
              ...current,
              type: kind,
              dismissed: !!current.dismissed,
            } as never;
            if (step.kind === 'review') {
              at += step.gap;
              undo.push({
                id: await manager.review(base, at),
                before: current,
              });
            } else {
              const last = undo.pop();
              if (!last) continue;
              await manager.undoReview(
                { ...last.before, dismissed: !!last.before.dismissed } as never,
                last.id
              );
            }
          }

          const stored = storedRow(repo, kind, 't');
          const log = textLog(repo, `${kind}_review`, `${kind}_id`);
          expect(
            replayText(
              log,
              { priority, fixed_interval_days: fixedDays },
              settings,
              initialText(imported as unknown as TextSchedule)
            )
          ).toEqual(pick(stored, TEXT_COLUMNS));
        }
      ),
      { numRuns: 80 }
    );
  }, 60_000);

  it('starts a text at the base interval, due and fuzzed as its row', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer(), { nil: null }),
        fc.option(fc.integer(), { nil: null }),
        (due, due_fuzz) => {
          expect(initialText({ due, due_fuzz })).toEqual({
            interval: TEXT_BASE_REVIEW_INTERVAL,
            due,
            due_fuzz,
          });
        }
      )
    );
  });

  it('leaves a text no live review is left of as it starts, fuzz and all', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string(),
            at: fc.integer(),
            deleted: fc.constantFrom(1, true),
          })
        ),
        fc.boolean(),
        (undone, fuzzTextReviews) => {
          const fuzz = vi
            .spyOn(IRScheduler, 'getDueFuzz')
            .mockReturnValue(DRAWN_FUZZ);
          const start = text(5 * DAY, T, 42);
          expect(
            replayText(undone, { priority: 30 }, { fuzzTextReviews }, start)
          ).toBe(start);
          expect(fuzz).not.toHaveBeenCalled();
          fuzz.mockRestore();
        }
      )
    );
  });

  it('grows the interval once per review on top of the one it starts at, due that long after the last', () => {
    fc.assert(
      fc.property(
        priorityArb,
        fc.integer({ min: 1, max: 400 * DAY }),
        fc.uniqueArray(fc.integer({ min: T, max: T + 9 }), {
          minLength: 1,
          maxLength: 5,
        }),
        (priority, interval, times) => {
          const log = times.map((at) => ({ id: `r${at}`, at }));
          let expected = interval;
          for (const _ of log) {
            expected = IRScheduler.nextInterval({
              priority,
              interval: expected,
              fixed_interval_days: null,
            } as never);
          }
          expect(textAfter(log, { priority }, text(interval, null, 3))).toEqual(
            text(expected, Math.max(...times) + expected, 3)
          );
        }
      )
    );
  });
});

describe('underRules', () => {
  it('puts the schedule of a reviewed text under new rules as changing them after its reviews does', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('article', 'snippet'),
        fc.record({ priority: priorityArb, fixed: fixedArb }),
        fc.record({ priority: priorityArb, fixed: fixedArb }),
        fc.array(fc.integer({ min: 0, max: 90 * DAY }), { maxLength: 5 }),
        fc.boolean(),
        async (kind, was, now, gaps, undoLast) => {
          const repo = await TestRepository.create();
          const article = kind === 'article';
          const wasFixed = article ? was.fixed : null;
          const nowFixed = article ? now.fixed : null;
          if (article) {
            repo.mutate(
              `INSERT INTO article (id, reference, due, interval, priority,
                 fixed_interval_days, due_fuzz) VALUES ('t', 'a.md', $1, $2, $3, $4, 9)`,
              [T, TEXT_BASE_REVIEW_INTERVAL, was.priority, wasFixed]
            );
          } else {
            repo.mutate(
              `INSERT INTO snippet (id, reference, due, interval, priority,
                 due_fuzz) VALUES ('t', 's.md', $1, $2, $3, 9)`,
              [T, TEXT_BASE_REVIEW_INTERVAL, was.priority]
            );
          }
          const manager = article
            ? new ArticleManager(plugin({}), repo)
            : new SnippetManager(plugin({}), repo);
          const current = () => {
            const stored = storedRow(repo, kind, 't');
            return {
              ...stored,
              type: kind,
              dismissed: !!stored.dismissed,
            } as never;
          };
          let at = T;
          let last: { id: string; before: Row } | null = null;
          for (const gap of gaps) {
            at += gap;
            const before = storedRow(repo, kind, 't');
            last = { id: await manager.review(current(), at), before };
          }
          // An undone review is in the log, but no longer counts
          if (undoLast && last) {
            await manager.undoReview(
              { ...last.before, dismissed: !!last.before.dismissed } as never,
              last.id
            );
          }
          const before = pick(storedRow(repo, kind, 't'), TEXT_COLUMNS);
          const log = textLog(repo, `${kind}_review`, `${kind}_id`);

          // What the settings of an item do, one change at a time
          if (manager instanceof ArticleManager) {
            if (wasFixed !== null && nowFixed === null) {
              await manager.disableFixedInterval(current(), now.priority);
            } else {
              await manager.reprioritize(current(), now.priority);
              if (nowFixed !== null && nowFixed !== wasFixed) {
                await manager.setFixedInterval(current(), nowFixed);
              }
            }
          } else {
            await manager.reprioritize(current(), now.priority);
          }

          expect(
            underRules(
              before as unknown as TextSchedule,
              { priority: was.priority, fixed_interval_days: wasFixed },
              { priority: now.priority, fixed_interval_days: nowFixed },
              log
            )
          ).toEqual(pick(storedRow(repo, kind, 't'), TEXT_COLUMNS));
        }
      ),
      { numRuns: 80 }
    );
  }, 60_000);

  it('leaves a schedule under the rules it has as it is', () => {
    fc.assert(
      fc.property(
        priorityArb,
        fixedArb,
        fc.array(fc.integer({ min: T, max: T + 99 * DAY }), { maxLength: 4 }),
        (priority, fixed, times) => {
          const rules = { priority, fixed_interval_days: fixed };
          const schedule = text(4 * DAY, T + 7, 3);
          const log = times.map((at, i) => ({ id: `r${i}`, at }));
          expect(underRules(schedule, rules, { ...rules }, log)).toEqual(
            schedule
          );
        }
      )
    );
  });
});

describe('merging with replay', () => {
  it('leaves every row whose log both copies agree on as the merge without replay leaves it', () => {
    fc.assert(
      fc.property(
        eventsArb,
        fc.array(
          fc.record({
            updated_at: fc.integer({ min: 1, max: 9 }),
            updated_by: fc.constantFrom('a', 'b'),
            priority: priorityArb,
            dismissed: fc.constantFrom(0, 1),
            interval: fc.integer({ min: 1, max: 99 * DAY }),
            due: fc.integer({ min: T, max: T + 99 * DAY }),
          }),
          { minLength: 2, maxLength: 2 }
        ),
        (events, seeds) => {
          // The same log on both devices, whatever their rows hold
          const log = logsOf(
            events.map((e) => ({ ...e, on: 2, undone: e.undone ? 1 : 0 })),
            'i'
          )[0];
          const copy = (side: number): Copy => {
            const s = seeds[side];
            const schedule = text(s.interval, s.due);
            return {
              articles: [{ id: 'i', ...s, schedule }],
              snippets: [{ id: 'i', ...s, schedule }],
              cards: [
                {
                  id: 'i',
                  created_at: T - DAY,
                  ...s,
                  schedule: { ...initialCard(T - DAY), due: s.due },
                },
              ],
              articleReviews: log,
              snippetReviews: log,
              cardReviews: log,
            };
          };
          expect(everything(merged(copy(0), copy(1)).db)).toEqual(
            everything(merged(copy(0), copy(1), null).db)
          );
        }
      )
    );
  }, 60_000);

  it('gives every item the schedule its merged log implies, the same whichever way round, stamped by this device', () => {
    fc.assert(
      fc.property(
        eventsArb,
        priorityArb,
        fixedArb,
        fsrsParamsArb,
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 9 }),
        (events, priority, fixed, fsrsParams, stampA, stampB) => {
          const logs = logsOf(events, 'i');
          const rules = { priority, fixed_interval_days: fixed };
          const start = text(TEXT_BASE_REVIEW_INTERVAL, T, null);
          const settings = { fsrsParams, fuzzTextReviews: false };
          // Each device's row is what its own log left
          const copyOf = (side: 0 | 1): Copy => {
            const log = asLog(logs[side]);
            const stamp = {
              updated_at: side ? stampB : stampA,
              updated_by: side ? 'b' : 'a',
            };
            return {
              articles: [
                {
                  id: 'i',
                  ...rules,
                  ...stamp,
                  schedule: textAfter(log, rules, start),
                },
              ],
              snippets: [
                {
                  id: 'i',
                  priority,
                  ...stamp,
                  schedule: textAfter(log, { priority }, start),
                },
              ],
              cards: [
                {
                  id: 'i',
                  created_at: T - DAY,
                  ...stamp,
                  schedule: replayCard(log, fsrsParams, initialCard(T - DAY)),
                },
              ],
              articleReviews: logs[side],
              snippetReviews: logs[side],
              cardReviews: logs[side],
            };
          };
          const copies = [copyOf(0), copyOf(1)];
          const copy = (side: 0 | 1) => copies[side];
          const log = mergedLog(logs);
          const expected = {
            article: textAfter(log, rules, start),
            snippet: textAfter(log, { priority }, start),
            srs_card: replayCard(log, fsrsParams, initialCard(T - DAY)),
          };
          const diverged =
            JSON.stringify(liveInOrder(asLog(logs[0])).map((r) => r.id)) !==
            JSON.stringify(liveInOrder(asLog(logs[1])).map((r) => r.id));
          // Whole-row LWW: the later stamp, then the greater device
          const winner = stampA > stampB ? copy(0) : copy(1);
          const winnerStamp =
            stampA > stampB
              ? { updated_at: stampA, updated_by: 'a' }
              : { updated_at: stampB, updated_by: 'b' };
          const won = {
            article: winner.articles![0].schedule,
            snippet: winner.snippets![0].schedule,
            srs_card: winner.cards![0].schedule,
          };
          // No review left, and each copy kept one the other undid: a text
          // is back at the base interval, due as the row that won
          const neitherStarts =
            liveInOrder(log).length === 0 &&
            logs.every((l) => liveInOrder(asLog(l)).length > 0);
          if (neitherStarts) {
            expected.article = initialText(won.article);
            expected.snippet = initialText(won.snippet);
          }
          for (const [mine, theirs] of [
            [copy(0), copy(1)],
            [copy(1), copy(0)],
          ]) {
            const { db } = merged(mine, theirs, settings);
            for (const { item } of REPLAYED_LOGS) {
              const after = row(db, item, 'i');
              const columns = item === 'srs_card' ? CARD_COLUMNS : TEXT_COLUMNS;
              expect(pick(after, columns)).toEqual(expected[item]);
              const rewritten =
                diverged &&
                JSON.stringify(expected[item]) !== JSON.stringify(won[item]);
              if (rewritten) {
                expect(after.updated_by).toBe('here');
                expect(after.updated_at).toBeGreaterThan(
                  Math.max(stampA, stampB)
                );
              } else {
                expect(pick(after, ['updated_at', 'updated_by'])).toEqual(
                  winnerStamp
                );
              }
            }
          }
        }
      ),
      { numRuns: 150 }
    );
  }, 60_000);

  it('property: gives each item of a merge the row merging it alone gives it, however many diverge together', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            events: eventsArb,
            priority: priorityArb,
            fixed: fixedArb,
            stamps: fc.tuple(
              fc.integer({ min: 1, max: 9 }),
              fc.integer({ min: 1, max: 9 })
            ),
          }),
          { minLength: 2, maxLength: 3 }
        ),
        fsrsParamsArb,
        (items, fsrsParams) => {
          const settings = { fsrsParams, fuzzTextReviews: false };
          const start = text(TEXT_BASE_REVIEW_INTERVAL, T, null);
          const ids = items.map((_, n) => `i${n}`);
          // Each item's reviews named after it, so no two items share one
          const logs = items.map(({ events }, n) =>
            logsOf(events, ids[n]).map((side) =>
              side.map((r) => ({ ...r, id: `${ids[n]}-${r.id}` }))
            )
          );
          /** One device's copy of the items `only` names, or of them all. */
          const copyOf = (side: 0 | 1, only?: number): Copy => {
            const copy: Required<Copy> = {
              articles: [],
              snippets: [],
              cards: [],
              articleReviews: [],
              snippetReviews: [],
              cardReviews: [],
            };
            for (const [n, { priority, fixed, stamps }] of items.entries()) {
              if (only !== undefined && n !== only) continue;
              const id = ids[n];
              const log = asLog(logs[n][side]);
              const stamp = {
                updated_at: stamps[side],
                updated_by: side ? 'b' : 'a',
              };
              const rules = { priority, fixed_interval_days: fixed };
              copy.articles.push({
                id,
                ...rules,
                ...stamp,
                schedule: textAfter(log, rules, start),
              });
              copy.snippets.push({
                id,
                priority,
                ...stamp,
                schedule: textAfter(log, { priority }, start),
              });
              copy.cards.push({
                id,
                created_at: T - DAY,
                ...stamp,
                schedule: replayCard(log, fsrsParams, initialCard(T - DAY)),
              });
              copy.articleReviews.push(...logs[n][side]);
              copy.snippetReviews.push(...logs[n][side]);
              copy.cardReviews.push(...logs[n][side]);
            }
            return copy;
          };
          for (const [mine, theirs] of [
            [0, 1],
            [1, 0],
          ] as const) {
            const { db } = merged(copyOf(mine), copyOf(theirs), settings);
            for (const [n, id] of ids.entries()) {
              const { db: alone } = merged(
                copyOf(mine, n),
                copyOf(theirs, n),
                settings
              );
              for (const { item } of REPLAYED_LOGS) {
                expect(row(db, item, id)).toEqual(row(alone, item, id));
              }
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  }, 60_000);

  describe('cases', () => {
    const R1 = T + 3_600_000;
    const R2 = T + 9 * DAY;
    const start = text(TEXT_BASE_REVIEW_INTERVAL, T, 11);
    const reviewed = textAfter([{ id: 'r1', at: R1 }], { priority: 30 }, start);
    /** A reviewed the article; B, not having seen it, dismissed it later. */
    const reviewedOnA: Copy = {
      articles: [
        { id: 'i', updated_at: 5, updated_by: 'a', schedule: reviewed },
      ],
      articleReviews: [{ id: 'r1', item: 'i', at: R1 }],
    };
    const dismissedOnB: Copy = {
      articles: [
        {
          id: 'i',
          dismissed: 1,
          updated_at: 6,
          updated_by: 'b',
          schedule: start,
        },
      ],
    };

    it('ends an article dismissed on one device after a review on the other dismissed, with the schedule of the review, on both', () => {
      for (const [mine, theirs] of [
        [reviewedOnA, dismissedOnB],
        [dismissedOnB, reviewedOnA],
      ]) {
        const { db } = merged(mine, theirs);
        expect(row(db, 'article', 'i')).toMatchObject({
          dismissed: 1,
          ...reviewed,
        });
      }
    });

    it('counts the rows it replays among those the merge writes', () => {
      const plain = merged(dismissedOnB, reviewedOnA, null).report;
      expect(merged(dismissedOnB, reviewedOnA).report).toEqual({
        ...plain,
        written: plain.written + 1,
      });
    });

    it('replays nothing when not given the settings to', () => {
      const { db } = merged(reviewedOnA, dismissedOnB, null);
      expect(row(db, 'article', 'i')).toMatchObject({
        dismissed: 1,
        ...start,
      });
    });

    it('changes nothing merging the same copy again', () => {
      const { db } = merged(reviewedOnA, dismissedOnB);
      const before = everything(db);
      const again = mergeInto(
        db,
        incoming(dismissedOnB),
        HERE,
        DEFAULT_REPLAY_SETTINGS
      );
      expect(again).toEqual({ replaced: 0, written: 0 });
      expect(everything(db)).toEqual(before);
    });

    it('gives a card graded on both devices the state both grades imply, the same on both, keeping both grades', () => {
      const params = generatorParameters({ enable_fuzz: true });
      const settings = { fsrsParams: params, fuzzTextReviews: false };
      const gradeA = { id: 'ga', item: 'c', at: R1, rating: Rating.Good };
      const gradeB = {
        id: 'gb',
        item: 'c',
        at: R1 + 60_000,
        rating: Rating.Again,
      };
      const copyWith = (
        grade: ReviewSeed,
        stamp: number,
        by: string
      ): Copy => ({
        cards: [
          {
            id: 'c',
            created_at: T - DAY,
            updated_at: stamp,
            updated_by: by,
            schedule: replayCard(asLog([grade]), params, initialCard(T - DAY)),
          },
        ],
        cardReviews: [grade],
      });
      const a = copyWith(gradeA, 7, 'a');
      const b = copyWith(gradeB, 6, 'b');
      const both = replayCard(
        asLog([gradeA, gradeB]),
        params,
        initialCard(T - DAY)
      );
      for (const db of [merged(a, b, settings).db, merged(b, a, settings).db]) {
        expect(pick(row(db, 'srs_card', 'c'), CARD_COLUMNS)).toEqual(both);
        expect(
          rowsOf(db, 'SELECT id, deleted FROM srs_card_review ORDER BY id')
        ).toEqual([
          { id: 'ga', deleted: 0 },
          { id: 'gb', deleted: 0 },
        ]);
      }
      expect(both.reps).toBe(2);
    });

    it('goes on from the schedule of the copy whose log the merged one starts with, under the priority of the merged row', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 400 * DAY }),
          priorityArb,
          fc.boolean(),
          (interval, priority, fuzzTextReviews) => {
            vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(DRAWN_FUZZ);
            // A's row holds what its log doesn't say: an interval a
            // priority change rescaled, say
            const a: Copy = {
              articles: [
                {
                  id: 'i',
                  priority,
                  updated_at: 3,
                  updated_by: 'a',
                  schedule: text(interval, R1 + interval, 5),
                },
              ],
              articleReviews: [{ id: 'r1', item: 'i', at: R1 }],
            };
            const b: Copy = {
              articles: [
                {
                  id: 'i',
                  priority,
                  updated_at: 2,
                  updated_by: 'b',
                  schedule: text(9 * DAY, R2 + 9 * DAY, 6),
                },
              ],
              articleReviews: [{ id: 'r2', item: 'i', at: R2 }],
            };
            const grown = IRScheduler.nextInterval({
              priority,
              interval,
              fixed_interval_days: null,
            } as never);
            const settings = { fsrsParams: {}, fuzzTextReviews };
            for (const [mine, theirs] of [
              [a, b],
              [b, a],
            ]) {
              const { db } = merged(mine, theirs, settings);
              expect(pick(row(db, 'article', 'i'), TEXT_COLUMNS)).toEqual(
                text(grown, R2 + grown, fuzzTextReviews ? DRAWN_FUZZ : 5)
              );
            }
          }
        )
      );
    }, 60_000);

    it('takes the schedule of a copy that holds the whole merged log as it is, fuzz too', () => {
      vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(DRAWN_FUZZ);
      const settings = { fsrsParams: {}, fuzzTextReviews: true };
      const { db } = merged(dismissedOnB, reviewedOnA, settings);
      expect(pick(row(db, 'article', 'i'), TEXT_COLUMNS)).toEqual(reviewed);
    });

    it('puts the schedule of the review under the rules of a row that changed them without it, on both', () => {
      const fixedReviewed = textAfter(
        [{ id: 'r1', at: R1 }],
        { priority: 30, fixed_interval_days: 12 },
        start
      );
      type Rules = { priority?: number; fixed_interval_days?: number };
      const changes: { was: Rules; now: Rules; schedule: TextSchedule }[] = [
        // B reprioritized, set a fixed interval, or dropped one
        { was: {}, now: { priority: 10 }, schedule: reviewed },
        { was: {}, now: { fixed_interval_days: 20 }, schedule: reviewed },
        {
          was: { fixed_interval_days: 12 },
          now: { priority: 50 },
          schedule: fixedReviewed,
        },
      ];
      for (const { was, now, schedule } of changes) {
        const a: Copy = {
          articles: [{ ...reviewedOnA.articles![0], ...was, schedule }],
          articleReviews: reviewedOnA.articleReviews,
        };
        const b: Copy = {
          articles: [{ ...dismissedOnB.articles![0], ...now }],
        };
        const expected = underRules(
          schedule,
          { priority: was.priority ?? 30, ...was },
          { priority: now.priority ?? 30, ...now },
          [{ id: 'r1', at: R1 }]
        );
        expect(expected).not.toEqual(schedule);
        for (const [mine, theirs] of [
          [a, b],
          [b, a],
        ]) {
          const after = row(merged(mine, theirs).db, 'article', 'i');
          expect(after).toMatchObject({ dismissed: 1, ...now, ...expected });
        }
      }
    });

    it('leaves every row of an item whose copies agree on its log as the merge without replay does, beside one replayed', () => {
      // Item i: A reviewed it, B did not. Item j: same log, rows differ
      const j = (stamp: number, by: string, interval: number): TextSeed => ({
        id: 'j',
        updated_at: stamp,
        updated_by: by,
        schedule: text(interval, R2 + interval, interval),
      });
      const shared = [{ id: 'r7', item: 'j', at: R2, updated_at: 2 }];
      const a: Copy = {
        articles: [...reviewedOnA.articles!, j(4, 'a', 3 * DAY)],
        articleReviews: [...reviewedOnA.articleReviews!, ...shared],
      };
      const b: Copy = {
        articles: [...dismissedOnB.articles!, j(8, 'b', 5 * DAY)],
        articleReviews: shared,
      };
      for (const [mine, theirs] of [
        [a, b],
        [b, a],
      ]) {
        const plain = everything(merged(mine, theirs, null).db);
        const replayed = everything(merged(mine, theirs).db);
        const of = (rows: Record<string, Row[]>, id: string) =>
          rows.article.find((r) => r.id === id);
        expect(of(replayed, 'j')).toEqual(of(plain, 'j'));
        expect(replayed.article_review).toEqual(plain.article_review);
        expect(of(replayed, 'i')).not.toEqual(of(plain, 'i'));
      }
    });

    it('agrees on one schedule once two copies each replayed with a fuzz of its own meet again', () => {
      let draws = 0;
      vi.spyOn(IRScheduler, 'getDueFuzz').mockImplementation(() => ++draws);
      const settings = { fsrsParams: {}, fuzzTextReviews: true };
      // A reviewed r1, B reviewed r2: neither copy holds the merged log
      const a: Copy = reviewedOnA;
      const b: Copy = {
        articles: [
          {
            id: 'i',
            updated_at: 6,
            updated_by: 'b',
            schedule: textAfter(
              [{ id: 'r2', at: R2 }],
              { priority: 30 },
              start
            ),
          },
        ],
        articleReviews: [{ id: 'r2', item: 'i', at: R2 }],
      };
      // Each device merges the other's copy at once, as both saved
      const on = (device: string, mine: Copy, theirs: Copy) => {
        const db = build(mine);
        const stamps = { deviceId: () => device, now: () => T };
        armRowStamps(db, stamps);
        mergeInto(db, incoming(theirs), stamps, settings);
        return db;
      };
      const meet = (mine: Database, theirs: Database, device: string) => {
        const stamps = { deviceId: () => device, now: () => T };
        const db = new SQL.Database(mine.export());
        open.push(db);
        armRowStamps(db, stamps);
        const other = openIncoming(SQL, theirs.export(), migrations);
        open.push(other);
        mergeInto(db, other, stamps, settings);
        return everything(db);
      };
      const onA = on('a', a, b);
      const onB = on('b', b, a);
      // Same interval and due; the fuzz each drew differs
      const [first, second] = [onA, onB].map((db) => row(db, 'article', 'i'));
      expect(pick(first, ['interval', 'due'])).toEqual(
        pick(second, ['interval', 'due'])
      );
      expect(first.due_fuzz).not.toBe(second.due_fuzz);
      const drawn = draws;
      expect(meet(onA, onB, 'a')).toEqual(meet(onB, onA, 'b'));
      // The logs agree now: no replay, so no draw, the newer row wins
      expect(draws).toBe(drawn);
    });

    it('leaves a purged item as it was, whatever its logs', () => {
      const purged = (copy: Copy): Copy => ({
        ...copy,
        articles: copy.articles!.map((t) => ({
          ...t,
          deleted: 1,
          reference: `${PURGED_REFERENCE_PREFIX}${t.id}`,
        })),
      });
      const mine = purged(dismissedOnB);
      const theirs = purged({
        ...reviewedOnA,
        articles: [{ ...reviewedOnA.articles![0], updated_at: 1 }],
      });
      const { db } = merged(mine, theirs);
      expect(row(db, 'article', 'i')).toEqual(
        everything(build(mine)).article[0]
      );
    });

    it('leaves an item only the other copy holds as it came', () => {
      const theirs: Copy = {
        articles: [
          {
            id: 'j',
            updated_at: 4,
            updated_by: 'b',
            schedule: text(3 * DAY, R2, 1),
          },
        ],
        articleReviews: [{ id: 'r9', item: 'j', at: R1 }],
      };
      const { db } = merged({}, theirs);
      expect(everything(db).article).toEqual(everything(build(theirs)).article);
    });

    it('leaves an item whose copies differ only in a review one undid that the other never had', () => {
      const mine: Copy = {
        ...dismissedOnB,
        articleReviews: [{ id: 'r1', item: 'i', at: R1, deleted: 1 }],
      };
      const { db } = merged(mine, {
        ...reviewedOnA,
        articles: [
          { ...reviewedOnA.articles![0], schedule: text(4 * DAY, R2) },
        ],
        articleReviews: [],
      });
      expect(row(db, 'article', 'i')).toEqual(
        everything(build(mine)).article[0]
      );
    });
  });
});
