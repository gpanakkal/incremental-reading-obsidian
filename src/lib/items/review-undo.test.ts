import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
  MS_PER_DAY,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import {
  initialCard,
  initialText,
  liveInOrder,
  replayCard,
  replayText,
  underRules,
  type TextRules,
} from '#/lib/repository/scheduling-replay';
import fc from 'fast-check';
import { Rating, type FSRSParameters, type Grade } from 'ts-fsrs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cardAfterUndo,
  notedLog,
  planUndo,
  textAfterUndo,
  type AuthoredReview,
  type UndoPlan,
} from './review-undo';

// #region HELPERS

const T = 1_790_000_000_000;
/** Device ids; '' is a review written before rows were stamped. */
const DEVICES = ['me', 'other', 'third', ''] as const;

/**
 * Review times: often equal (the same millisecond), sometimes far apart, as
 * skewed clocks date them.
 */
const atArb = fc.oneof(
  fc.integer({ min: T, max: T + 3 }),
  fc.integer({ min: T - 400 * MS_PER_DAY, max: T + 400 * MS_PER_DAY })
);

const gradeArb = fc.constantFrom<Grade>(
  Rating.Again,
  Rating.Hard,
  Rating.Good,
  Rating.Easy
);

/** An item's log: reviews by any device, at any time, undone or not. */
const logArb: fc.Arbitrary<AuthoredReview[]> = fc
  .array(
    fc.record({
      at: atArb,
      rating: gradeArb,
      updated_by: fc.constantFrom(...DEVICES),
      deleted: fc.constantFrom(0, 1),
    }),
    { maxLength: 8 }
  )
  .map((reviews) => reviews.map((review, i) => ({ id: `r${i}`, ...review })));

/** A live log in replay order, every review graded. */
const liveLogArb = logArb.map((log) =>
  liveInOrder(log.map((review) => ({ ...review, deleted: 0 })))
);

const fsrsParamsArb: fc.Arbitrary<Partial<FSRSParameters>> = fc.record({
  request_retention: fc.double({ min: 0.7, max: 0.99, noNaN: true }),
  maximum_interval: fc.integer({ min: 1, max: 36_500 }),
  enable_fuzz: fc.boolean(),
  enable_short_term: fc.boolean(),
  learning_steps: fc.constantFrom([], ['1m', '10m'], ['10m'], ['1d']),
  relearning_steps: fc.constantFrom([], ['10m'], ['1h', '1d']),
});

const rulesArb: fc.Arbitrary<TextRules> = fc.record({
  priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
  fixed_interval_days: fc.option(
    fc.integer({ min: 1, max: MAXIMUM_FIXED_REVIEW_INTERVAL }),
    { nil: null }
  ),
});

/** A text as some reviews under some rules left it. */
const textSnapshotArb = fc.record({
  interval: fc.integer({ min: 1, max: 400 * MS_PER_DAY }),
  due: fc.option(atArb, { nil: null }),
  due_fuzz: fc.option(fc.integer({ min: -MS_PER_DAY, max: MS_PER_DAY }), {
    nil: null,
  }),
  priority: fc.integer({ min: MINIMUM_PRIORITY, max: MAXIMUM_PRIORITY }),
  fixed_interval_days: fc.option(
    fc.integer({ min: 1, max: MAXIMUM_FIXED_REVIEW_INTERVAL }),
    { nil: null }
  ),
});

/** A plan as `planUndo` makes it: `left` from `before` on, or not. */
function planOf(before: AuthoredReview[], left: AuthoredReview[]): UndoPlan {
  return { before, taken: new Set(), left };
}

/** `log` with its first review dropped from `left`, breaking the start. */
function brokenStart(log: AuthoredReview[], length: number) {
  return { before: log.slice(0, length), left: log.slice(1) };
}

/** What the fuzz spy draws: never a fuzz a snapshot starts with. */
const DRAWN_FUZZ = -MS_PER_DAY - 7;

// #endregion

describe('planUndo', () => {
  it('finds nothing to undo in a review the item has not, or has undone', () => {
    fc.assert(
      fc.property(logArb, fc.nat(9), (log, pick) => {
        const id = `r${pick}`;
        const review = log.find((r) => r.id === id);
        fc.pre(!review || review.deleted === 1);

        expect(planUndo(log, id)).toBeNull();
        expect(planUndo(log, id, [])).toBeNull();
      })
    );
  });

  it('takes back the undone review and the live ones its device made after it, never another device’s, and leaves the rest in replay order', () => {
    fc.assert(
      fc.property(
        logArb,
        fc.nat(),
        fc.option(fc.array(fc.boolean(), { maxLength: 8 }), { nil: undefined }),
        (log, pick, known) => {
          const live = log.filter((r) => !r.deleted);
          fc.pre(live.length > 0);
          const undone = live[pick % live.length];
          // What the item had when the undone review was made: any of its
          // other live reviews, as noted then, or not noted at all
          const before = known?.flatMap((had, i) =>
            had && live[i] && live[i] !== undone ? [live[i]] : []
          );

          const plan = planUndo(log, undone.id, before)!;

          const had =
            before ?? live.filter((r) => r !== undone && r.at <= undone.at);
          const taken = live.filter(
            (r) => r.updated_by === undone.updated_by && !had.includes(r)
          );
          expect([...plan.taken].sort()).toEqual(taken.map((r) => r.id).sort());
          expect(plan.taken.has(undone.id)).toBe(true);
          expect(plan.before).toEqual(liveInOrder(had));
          expect(plan.left).toEqual(
            liveInOrder(live.filter((r) => !taken.includes(r)))
          );
        }
      )
    );
  });

  it('keeps every review of another device, dated before the undone one or after it', () => {
    fc.assert(
      fc.property(
        fc.array(atArb, { minLength: 1, maxLength: 6 }),
        atArb,
        (theirs, at) => {
          const log: AuthoredReview[] = [
            { id: 'mine', at, rating: Rating.Good, updated_by: 'me' },
            ...theirs.map((t, i) => ({
              id: `theirs-${i}`,
              at: t,
              rating: Rating.Good,
              updated_by: 'other',
            })),
          ];

          for (const before of [undefined, [], log.slice(1)]) {
            const plan = planUndo(log, 'mine', before)!;
            expect([...plan.taken]).toEqual(['mine']);
            expect(plan.left).toEqual(liveInOrder(log.slice(1)));
          }
        }
      )
    );
  });

  it('takes the device’s reviews made after the undone one by what the item had, not by their times', () => {
    // A clock set back between the two: the later review is dated earlier
    const log: AuthoredReview[] = [
      { id: 'first', at: T, rating: Rating.Good, updated_by: 'me' },
      { id: 'undone', at: T + 5, rating: Rating.Good, updated_by: 'me' },
      { id: 'after', at: T + 1, rating: Rating.Good, updated_by: 'me' },
    ];

    const plan = planUndo(log, 'undone', [log[0]])!;

    expect([...plan.taken].sort()).toEqual(['after', 'undone']);
    expect(plan.left).toEqual([log[0]]);
  });

  it('keeps an unstamped review the item did not have when the undone one was made', () => {
    // Its author is unknown: it may be another device's, so it stays
    const log: AuthoredReview[] = [
      { id: 'undone', at: T, rating: Rating.Good, updated_by: 'me' },
      { id: 'unstamped', at: T + 1, rating: Rating.Good, updated_by: '' },
    ];

    for (const before of [undefined, []]) {
      const plan = planUndo(log, 'undone', before)!;
      expect([...plan.taken]).toEqual(['undone']);
      expect(plan.left).toEqual([log[1]]);
    }
  });
});

describe('notedLog', () => {
  it('reads back the noted reviews from the log, live as they were noted', () => {
    fc.assert(
      fc.property(
        logArb.chain((log) =>
          fc.tuple(fc.constant(log), fc.shuffledSubarray(log))
        ),
        ([log, noted]) => {
          expect(
            notedLog(
              log,
              noted.map(({ id }) => id)
            )
          ).toEqual(noted.map((review) => ({ ...review, deleted: false })));
        }
      )
    );
  });

  it('keeps a noted review gone from the log from letting an undo go on from the item as it was', () => {
    fc.assert(
      fc.property(
        fsrsParamsArb,
        liveLogArb,
        fc.integer({ min: T - 800 * MS_PER_DAY, max: T }),
        fc.boolean(),
        (params, had, createdAt, gone) => {
          const undone: AuthoredReview = {
            id: 'undone',
            at: T + 500 * MS_PER_DAY,
            rating: Rating.Good,
            updated_by: 'me',
          };
          const log = [...had, undone];
          const ids = had.map(({ id }) => id);
          // No replay of the log makes this many reviews
          const snapshot = {
            ...replayCard(had, params, initialCard(createdAt)),
            reps: 999,
          };

          const plan = planUndo(
            log,
            'undone',
            notedLog(log, gone ? [...ids, 'gone'] : ids)
          )!;

          expect(cardAfterUndo(plan, snapshot, createdAt, params)).toEqual(
            gone ? replayCard(had, params, initialCard(createdAt)) : snapshot
          );
        }
      )
    );
  });
});

describe('cardAfterUndo', () => {
  it('gives back the card as it was before the grade when the reviews left are those it had', () => {
    fc.assert(
      fc.property(
        fsrsParamsArb,
        liveLogArb,
        fc.integer({ min: T - 800 * MS_PER_DAY, max: T }),
        fsrsParamsArb,
        (params, log, createdAt, then) => {
          // Graded under any parameters, which the log doesn't record
          const snapshot = replayCard(log, then, initialCard(createdAt));

          expect(
            cardAfterUndo(planOf(log, log), snapshot, createdAt, params)
          ).toEqual(snapshot);
        }
      )
    );
  });

  it('grades the card as it was before the grade with the reviews left after those it had', () => {
    fc.assert(
      fc.property(
        fsrsParamsArb,
        liveLogArb,
        fc.nat(),
        fc.integer({ min: T - 800 * MS_PER_DAY, max: T }),
        fsrsParamsArb,
        (params, log, cut, createdAt, then) => {
          const length = cut % (log.length + 1);
          const before = log.slice(0, length);
          const snapshot = replayCard(before, then, initialCard(createdAt));

          expect(
            cardAfterUndo(planOf(before, log), snapshot, createdAt, params)
          ).toEqual(replayCard(log.slice(length), params, snapshot));
        }
      )
    );
  });

  it('grades a new card with every review left when a review the card had before the grade is gone', () => {
    fc.assert(
      fc.property(
        fsrsParamsArb,
        liveLogArb,
        fc.nat(),
        fc.integer({ min: T - 800 * MS_PER_DAY, max: T }),
        (params, log, cut, createdAt) => {
          fc.pre(log.length > 0);
          const { before, left } = brokenStart(log, 1 + (cut % log.length));
          const snapshot = replayCard(before, params, initialCard(createdAt));

          expect(
            cardAfterUndo(planOf(before, left), snapshot, createdAt, params)
          ).toEqual(replayCard(left, params, initialCard(createdAt)));
        }
      )
    );
  });
});

describe('textAfterUndo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives back the text as it was before the review when the reviews left are those it had and its rules are the same', () => {
    fc.assert(
      fc.property(
        textSnapshotArb,
        liveLogArb,
        fc.boolean(),
        (snapshot, log, fuzz) => {
          const { interval, due, due_fuzz } = snapshot;

          expect(
            textAfterUndo(planOf(log, log), snapshot, snapshot, {
              fuzzTextReviews: fuzz,
            })
          ).toEqual({ interval, due, due_fuzz });
        }
      )
    );
  });

  it('reviews the text as it was before the review, under the rules it has now, with the reviews left after those it had', () => {
    fc.assert(
      fc.property(
        textSnapshotArb,
        rulesArb,
        liveLogArb,
        fc.nat(),
        fc.boolean(),
        (snapshot, rules, log, cut, fuzz) => {
          vi.restoreAllMocks();
          vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(DRAWN_FUZZ);
          const length = cut % (log.length + 1);
          const before = log.slice(0, length);
          const { interval, due, due_fuzz } = snapshot;
          const settings = { fuzzTextReviews: fuzz };

          expect(
            textAfterUndo(planOf(before, log), snapshot, rules, settings)
          ).toEqual(
            replayText(
              log.slice(length),
              rules,
              settings,
              underRules({ interval, due, due_fuzz }, snapshot, rules, before)
            )
          );
        }
      )
    );
  });

  it('reviews a text at the base interval with every review left when a review it had before the review is gone, due as it was once none is left', () => {
    fc.assert(
      fc.property(
        textSnapshotArb,
        rulesArb,
        liveLogArb,
        fc.nat(),
        fc.boolean(),
        (snapshot, rules, log, cut, fuzz) => {
          fc.pre(log.length > 0);
          vi.restoreAllMocks();
          vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(DRAWN_FUZZ);
          const { before, left } = brokenStart(log, 1 + (cut % log.length));
          const settings = { fuzzTextReviews: fuzz };

          expect(
            textAfterUndo(planOf(before, left), snapshot, rules, settings)
          ).toEqual(replayText(left, rules, settings, initialText(snapshot)));
        }
      )
    );
  });
});
