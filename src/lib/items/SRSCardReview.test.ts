import fc from 'fast-check';
import type { ReviewLog } from 'ts-fsrs';
import { Rating, State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { ISRSCardReview, SRSCardReviewRow } from '#/lib/types';
import SRSCardReview from './SRSCardReview';

// #region HELPERS

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Date arbitrary constrained to representable ISO timestamps. `displayToRow`
 *  uses Date.prototype.toISOString(), which throws on dates outside the
 *  representable ISO range (year ±275760). Stay well inside it. */
const dateArb = fc
  .integer({
    min: new Date('1970-01-01T00:00:00Z').getTime(),
    max: new Date('9999-12-31T23:59:59Z').getTime(),
  })
  .map((ms) => new Date(ms));

/** Arbitrary timestamp in ms — the row representation of due/review. */
const timestampArb = fc.integer({
  min: new Date('1970-01-01T00:00:00Z').getTime(),
  max: new Date('9999-12-31T23:59:59Z').getTime(),
});

/** Arbitrary for any ts-fsrs ReviewLog. The library does not validate these
 *  fields on construction, so we cover the broad numeric space. */
const reviewLogArb: fc.Arbitrary<ReviewLog> = fc.record({
  rating: fc.constantFrom(
    Rating.Manual,
    Rating.Again,
    Rating.Hard,
    Rating.Good,
    Rating.Easy
  ),
  state: fc.constantFrom(
    State.New,
    State.Learning,
    State.Review,
    State.Relearning
  ),
  due: dateArb,
  stability: fc.double({ noNaN: true }),
  difficulty: fc.double({ noNaN: true }),
  elapsed_days: fc.integer(),
  last_elapsed_days: fc.integer(),
  scheduled_days: fc.integer(),
  review: dateArb,
});

/** Arbitrary for any SRSCardReviewRow (the DB-shape representation). */
const cardReviewRowArb: fc.Arbitrary<SRSCardReviewRow> = fc.record({
  id: fc.uuid(),
  card_id: fc.uuid(),
  rating: fc.constantFrom(
    Rating.Manual,
    Rating.Again,
    Rating.Hard,
    Rating.Good,
    Rating.Easy
  ),
  state: fc.constantFrom(
    State.New,
    State.Learning,
    State.Review,
    State.Relearning
  ),
  due: timestampArb,
  review: timestampArb,
  stability: fc.double({ noNaN: true }),
  difficulty: fc.double({ noNaN: true }),
  elapsed_days: fc.integer(),
  last_elapsed_days: fc.integer(),
  scheduled_days: fc.integer(),
});

/** Arbitrary for any ISRSCardReview (the display-shape representation). */
const cardReviewDisplayArb: fc.Arbitrary<ISRSCardReview> = fc.record({
  id: fc.uuid(),
  card_id: fc.uuid(),
  rating: fc.constantFrom(
    Rating.Manual,
    Rating.Again,
    Rating.Hard,
    Rating.Good,
    Rating.Easy
  ),
  state: fc.constantFrom(
    State.New,
    State.Learning,
    State.Review,
    State.Relearning
  ),
  due: dateArb,
  review: dateArb,
  stability: fc.double({ noNaN: true }),
  difficulty: fc.double({ noNaN: true }),
  elapsed_days: fc.integer(),
  last_elapsed_days: fc.integer(),
  scheduled_days: fc.integer(),
});

// #endregion

describe('SRSCardReview constructor', () => {
  it('binds the cardId argument to the card_id field unchanged (property-based)', () => {
    fc.assert(
      fc.property(fc.string(), reviewLogArb, (cardId, reviewLog) => {
        const review = new SRSCardReview(cardId, reviewLog);
        expect(review.card_id).toBe(cardId);
      })
    );
  });

  it('assigns a fresh UUID v4 to the id field on every instance (property-based)', () => {
    fc.assert(
      fc.property(fc.string(), reviewLogArb, (cardId, reviewLog) => {
        const review = new SRSCardReview(cardId, reviewLog);
        expect(review.id).toMatch(UUID_REGEX);
      })
    );
  });

  it('produces a distinct id for each constructed instance (property-based)', () => {
    fc.assert(
      fc.property(fc.string(), reviewLogArb, (cardId, reviewLog) => {
        const a = new SRSCardReview(cardId, reviewLog);
        const b = new SRSCardReview(cardId, reviewLog);
        expect(a.id).not.toBe(b.id);
      })
    );
  });

  it('mirrors every ReviewLog field onto the instance unchanged (property-based)', () => {
    fc.assert(
      fc.property(fc.string(), reviewLogArb, (cardId, reviewLog) => {
        const review = new SRSCardReview(cardId, reviewLog);
        expect(review.due).toBe(reviewLog.due);
        expect(review.review).toBe(reviewLog.review);
        expect(review.stability).toBe(reviewLog.stability);
        expect(review.difficulty).toBe(reviewLog.difficulty);
        expect(review.elapsed_days).toBe(reviewLog.elapsed_days);
        expect(review.last_elapsed_days).toBe(reviewLog.last_elapsed_days);
        expect(review.scheduled_days).toBe(reviewLog.scheduled_days);
        expect(review.rating).toBe(reviewLog.rating);
        expect(review.state).toBe(reviewLog.state);
      })
    );
  });
});

describe('SRSCardReview.rowToDisplay', () => {
  it('converts the numeric due field to a Date with the same epoch ms (property-based)', () => {
    fc.assert(
      fc.property(cardReviewRowArb, (row) => {
        const display = SRSCardReview.rowToDisplay(row);
        expect(display.due).toBeInstanceOf(Date);
        expect(display.due.getTime()).toBe(row.due);
      })
    );
  });

  it('converts the numeric review field to a Date with the same epoch ms (property-based)', () => {
    fc.assert(
      fc.property(cardReviewRowArb, (row) => {
        const display = SRSCardReview.rowToDisplay(row);
        expect(display.review).toBeInstanceOf(Date);
        expect(display.review.getTime()).toBe(row.review);
      })
    );
  });

  it('passes all non-date fields through unchanged (property-based)', () => {
    fc.assert(
      fc.property(cardReviewRowArb, (row) => {
        const display = SRSCardReview.rowToDisplay(row);
        expect(display.id).toBe(row.id);
        expect(display.card_id).toBe(row.card_id);
        expect(display.rating).toBe(row.rating);
        expect(display.state).toBe(row.state);
        expect(display.stability).toBe(row.stability);
        expect(display.difficulty).toBe(row.difficulty);
        expect(display.elapsed_days).toBe(row.elapsed_days);
        expect(display.last_elapsed_days).toBe(row.last_elapsed_days);
        expect(display.scheduled_days).toBe(row.scheduled_days);
      })
    );
  });

  it('does not mutate its input row (property-based)', () => {
    fc.assert(
      fc.property(cardReviewRowArb, (row) => {
        const snapshot = { ...row };
        SRSCardReview.rowToDisplay(row);
        expect(row).toEqual(snapshot);
      })
    );
  });
});

describe('SRSCardReview.displayToRow', () => {
  it('converts the Date due field to a numeric epoch ms (property-based)', () => {
    fc.assert(
      fc.property(cardReviewDisplayArb, (display) => {
        const row = SRSCardReview.displayToRow(display);
        expect(typeof row.due).toBe('number');
        expect(row.due).toBe(display.due.getTime());
      })
    );
  });

  it('converts the Date review field to a numeric epoch ms (property-based)', () => {
    fc.assert(
      fc.property(cardReviewDisplayArb, (display) => {
        const row = SRSCardReview.displayToRow(display);
        expect(typeof row.review).toBe('number');
        expect(row.review).toBe(display.review.getTime());
      })
    );
  });

  it('passes all non-date fields through unchanged (property-based)', () => {
    fc.assert(
      fc.property(cardReviewDisplayArb, (display) => {
        const row = SRSCardReview.displayToRow(display);
        expect(row.id).toBe(display.id);
        expect(row.card_id).toBe(display.card_id);
        expect(row.rating).toBe(display.rating);
        expect(row.state).toBe(display.state);
        expect(row.stability).toBe(display.stability);
        expect(row.difficulty).toBe(display.difficulty);
        expect(row.elapsed_days).toBe(display.elapsed_days);
        expect(row.last_elapsed_days).toBe(display.last_elapsed_days);
        expect(row.scheduled_days).toBe(display.scheduled_days);
      })
    );
  });

  it('does not mutate its input display (property-based)', () => {
    fc.assert(
      fc.property(cardReviewDisplayArb, (display) => {
        const snapshot = { ...display, due: display.due, review: display.review };
        SRSCardReview.displayToRow(display);
        expect(display).toEqual(snapshot);
      })
    );
  });
});

describe('SRSCardReview row/display round-trips', () => {
  it('rowToDisplay then displayToRow yields the original row (property-based)', () => {
    fc.assert(
      fc.property(cardReviewRowArb, (row) => {
        const roundTripped = SRSCardReview.displayToRow(
          SRSCardReview.rowToDisplay(row)
        );
        expect(roundTripped).toEqual(row);
      })
    );
  });

  it('displayToRow then rowToDisplay yields a display whose dates have the same epoch ms (property-based)', () => {
    fc.assert(
      fc.property(cardReviewDisplayArb, (display) => {
        const roundTripped = SRSCardReview.rowToDisplay(
          SRSCardReview.displayToRow(display)
        );
        // Date identity is not preserved across the round-trip (new Date objects
        // are constructed), but epoch ms must be.
        expect(roundTripped.due.getTime()).toBe(display.due.getTime());
        expect(roundTripped.review.getTime()).toBe(display.review.getTime());
        // All non-date fields must be referentially or value-equal.
        const { due: _d1, review: _r1, ...restRound } = roundTripped;
        const { due: _d2, review: _r2, ...restDisplay } = display;
        expect(restRound).toEqual(restDisplay);
      })
    );
  });
});
