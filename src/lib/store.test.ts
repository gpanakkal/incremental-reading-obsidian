import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addCompletedReview,
  addSeenId,
  completedReviewsSlice,
  getCompletedReviews,
  getSeenIds,
  removeCompletedReview,
  removeSeenId,
  resetSeenIds,
  resetSession,
  store,
} from './store';
import type { NoteType } from './types';

// #region HELPERS

// Item managers only ever mint UUIDs, and the ids are object keys, so this is
// every id the slice will be handed.
const idsArb = fc.uniqueArray(fc.uuid(), { maxLength: 8 });

// Wide enough to reach any wall clock the plugin runs under, with offsets that
// land exactly on the reset time as well as either side of it.
const nowArb = fc.integer({ min: 0, max: 7_258_118_400_000 });
const offsetArb = fc.oneof(
  fc.integer({ min: -2, max: 2 }),
  fc.integer({ min: -2 * 86_400_000, max: 2 * 86_400_000 })
);

/** Empty the list, as at plugin load, with the clock at `now`. */
function freshList(now: number) {
  vi.setSystemTime(now);
  store.dispatch(resetSeenIds(0));
}

function skipAll(ids: string[], resetTime: number) {
  for (const id of ids) store.dispatch(addSeenId({ id, resetTime }));
}

function seenIds() {
  return getSeenIds(store.getState());
}

function asSet(ids: string[]): Record<string, true> {
  return Object.fromEntries(ids.map((id) => [id, true as const]));
}

// #endregion

describe('seenIds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    store.dispatch(resetSeenIds(0));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps skipped items out of review after the review tab closes', () => {
    // The last review tab to close ends the session with `resetSession`. A
    // skip is meant to last the day, so reopening review must not hand the
    // item straight back.
    fc.assert(
      fc.property(
        nowArb,
        idsArb,
        fc.integer({ min: 1, max: 2 * 86_400_000 }),
        (now, ids, ahead) => {
          freshList(now);
          skipAll(ids, now + ahead);

          store.dispatch(resetSession());

          expect(seenIds()).toEqual(asSet(ids));
        }
      )
    );
  });

  it('lists skipped items only until the day rolls over', () => {
    fc.assert(
      fc.property(nowArb, idsArb, offsetArb, (now, ids, offset) => {
        const resetTime = now + Math.abs(offset) + 1;
        freshList(now);
        skipAll(ids, resetTime);

        vi.setSystemTime(resetTime + offset);

        expect(seenIds()).toEqual(offset < 0 ? asSet(ids) : {});
      })
    );
  });

  it('starts a new list on the first skip after rollover', () => {
    fc.assert(
      fc.property(
        nowArb,
        idsArb,
        fc.uuid(),
        offsetArb,
        fc.integer({ min: 1, max: 2 * 86_400_000 }),
        (now, earlier, id, offset, ahead) => {
          const resetTime = now + Math.abs(offset) + 1;
          freshList(now);
          skipAll(earlier, resetTime);

          const later = resetTime + offset;
          vi.setSystemTime(later);
          store.dispatch(addSeenId({ id, resetTime: later + ahead }));

          expect(seenIds()).toEqual(
            offset < 0 ? { ...asSet(earlier), [id]: true } : { [id]: true }
          );
          // A new list waits for the rollover its first skip named, not the
          // one the stale list was waiting for.
          if (offset >= 0) {
            vi.setSystemTime(later + ahead - 1);
            expect(seenIds()).toEqual({ [id]: true });
          }
        }
      )
    );
  });

  it('returns only the unskipped item to review', () => {
    fc.assert(
      fc.property(
        nowArb,
        idsArb.filter((ids) => ids.length > 0),
        fc.nat(),
        (now, ids, pick) => {
          const removed = ids[pick % ids.length];
          freshList(now);
          skipAll(ids, now + 1);

          store.dispatch(removeSeenId({ id: removed }));

          expect(seenIds()).toEqual(asSet(ids.filter((id) => id !== removed)));
        }
      )
    );
  });

  it('empties the list and waits for the rollover it is given', () => {
    fc.assert(
      fc.property(nowArb, idsArb, offsetArb, (now, ids, offset) => {
        freshList(now);
        skipAll(ids, now + 1);
        const resetTime = now + offset;

        store.dispatch(resetSeenIds(resetTime));

        expect(store.getState().seenIds).toEqual({ ids: {}, resetTime });
      })
    );
  });
});

// #region HELPERS

type CompletedReviewsState = ReturnType<
  typeof completedReviewsSlice.getInitialState
>;

const { reducer } = completedReviewsSlice;

const MAX_TIME = 8_640_000_000_000_000;

const noteTypeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

/**
 * Review ids. Production ids are UUIDs, but the reducer takes any string, so
 * this reaches wider — including the keys a plain object treats specially,
 * which a record keyed by id has to hold like any other.
 */
const reviewIdArb = fc.oneof(
  fc.string(),
  fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty')
);

/** Any epoch-millisecond time, rollover or clock. */
const timeArb = fc.integer({ min: 0, max: MAX_TIME });

const stateArb: fc.Arbitrary<CompletedReviewsState> = fc.record({
  reviews: fc.dictionary(reviewIdArb, noteTypeArb),
  resetTime: timeArb,
});

/**
 * A record paired with a clock reading before its reset time: the day it
 * covers is still on.
 */
function withCurrentClock<T extends { resetTime: number }>(
  arb: fc.Arbitrary<T>
) {
  return arb
    .filter(({ resetTime }) => resetTime > 0)
    .chain((state) =>
      fc.record({
        state: fc.constant(state),
        now: fc.integer({ min: 0, max: state.resetTime - 1 }),
      })
    );
}

/**
 * A record paired with a clock reading at or past its reset time: the day it
 * covers is over. The boundary is drawn on purpose, since rollover is due the
 * instant it arrives.
 */
function withExpiredClock<T extends { resetTime: number }>(
  arb: fc.Arbitrary<T>
) {
  return arb.chain((state) =>
    fc.record({
      state: fc.constant(state),
      now: fc.oneof(
        fc.constant(state.resetTime),
        fc.integer({ min: state.resetTime, max: MAX_TIME })
      ),
    })
  );
}

/** Read the selector the way the store does, off the root state. */
function readCompleted(state: CompletedReviewsState) {
  return getCompletedReviews({ completedReviews: state } as never);
}

/** Own entries in a stable order, so records compare by content alone. */
function entriesOf(record: Record<string, unknown>) {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
}

// #endregion

describe('completedReviews', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts with no completed reviews', () => {
    fc.assert(
      fc.property(timeArb, (now) => {
        vi.setSystemTime(now);
        expect(readCompleted(reducer(undefined, { type: '' }))).toEqual({});
      })
    );
  });

  it('adds a review to those already completed while the day is still on', () => {
    fc.assert(
      fc.property(
        withCurrentClock(stateArb),
        reviewIdArb,
        noteTypeArb,
        timeArb,
        ({ state, now }, reviewId, type, nextResetTime) => {
          vi.setSystemTime(now);

          const next = reducer(
            state,
            addCompletedReview({ reviewId, type, resetTime: nextResetTime })
          );

          const expected = { ...state.reviews };
          Object.defineProperty(expected, reviewId, {
            value: type,
            enumerable: true,
          });
          expect(entriesOf(next.reviews)).toEqual(entriesOf(expected));
          // The day in progress keeps its own end, not the one the new review
          // was stamped with.
          expect(next.resetTime).toBe(state.resetTime);
        }
      )
    );
  });

  it('starts the record over once the day has rolled over', () => {
    fc.assert(
      fc.property(
        withExpiredClock(stateArb),
        reviewIdArb,
        noteTypeArb,
        timeArb,
        ({ state, now }, reviewId, type, nextResetTime) => {
          vi.setSystemTime(now);

          const next = reducer(
            state,
            addCompletedReview({ reviewId, type, resetTime: nextResetTime })
          );

          expect(entriesOf(next.reviews)).toEqual([[reviewId, type]]);
          expect(next.resetTime).toBe(nextResetTime);
        }
      )
    );
  });

  it('takes back exactly the review named, leaving the rest', () => {
    // Drawn both ways: an id the record holds, which is what undo sends, and
    // one it does not, which a review completed before a rollover becomes.
    const caseArb = stateArb.chain((state) =>
      fc.record({
        state: fc.constant(state),
        reviewId: Object.keys(state.reviews).length
          ? fc.oneof(
              fc.constantFrom(...Object.keys(state.reviews)),
              reviewIdArb
            )
          : reviewIdArb,
      })
    );

    fc.assert(
      fc.property(caseArb, timeArb, ({ state, reviewId }, now) => {
        vi.setSystemTime(now);

        const next = reducer(state, removeCompletedReview({ reviewId }));

        expect(entriesOf(next.reviews)).toEqual(
          entriesOf(state.reviews).filter(([id]) => id !== reviewId)
        );
        expect(next.resetTime).toBe(state.resetTime);
      })
    );
  });

  it('forgets every review when the session ends, keeping the day it covers', () => {
    fc.assert(
      fc.property(stateArb, timeArb, (state, now) => {
        vi.setSystemTime(now);

        const next = reducer(state, resetSession());

        expect(entriesOf(next.reviews)).toEqual([]);
        expect(next.resetTime).toBe(state.resetTime);
      })
    );
  });

  it('reads the completed reviews while the day is still on', () => {
    fc.assert(
      fc.property(withCurrentClock(stateArb), ({ state, now }) => {
        vi.setSystemTime(now);
        expect(readCompleted(state)).toBe(state.reviews);
      })
    );
  });

  it('reads as empty, and the same empty each time, once the day has rolled over', () => {
    fc.assert(
      fc.property(withExpiredClock(stateArb), ({ state, now }) => {
        vi.setSystemTime(now);

        const first = readCompleted(state);

        expect(entriesOf(first)).toEqual([]);
        // A fresh object per read would re-render every subscriber on every
        // store change.
        expect(readCompleted({ ...state })).toBe(first);
      })
    );
  });
});

describe('getSeenIds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const seenArb = fc.record({
    ids: fc.dictionary(fc.string(), fc.constant(true as const)),
    resetTime: timeArb,
  });

  it('reads the skipped ids while the day is still on', () => {
    fc.assert(
      fc.property(withCurrentClock(seenArb), ({ state, now }) => {
        vi.setSystemTime(now);
        expect(getSeenIds({ seenIds: state } as never)).toBe(state.ids);
      })
    );
  });

  it('reads as empty, and the same empty each time, once the day has rolled over', () => {
    fc.assert(
      fc.property(withExpiredClock(seenArb), ({ state, now }) => {
        vi.setSystemTime(now);

        const first = getSeenIds({ seenIds: state } as never);

        expect(entriesOf(first)).toEqual([]);
        expect(getSeenIds({ seenIds: { ...state } } as never)).toBe(first);
      })
    );
  });
});
