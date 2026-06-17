import fc from 'fast-check';
import { State, createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SRSCard from './SRSCard';

// #region HELPERS

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Arbitrary for any string the production code would accept as `reference`.
 *  The constructor does not validate input, so we cover the full string space
 *  (including empty string, whitespace, unicode, control characters). */
const referenceArb = fc.string();

/** Arbitrary for any Date the production code would accept as `creationTime`.
 *  Constrained to representable timestamps (rejecting NaN-producing extremes).
 *  ts-fsrs internally arithmetic-shifts the date, so we keep within a safe
 *  millisecond range. */
const creationTimeArb = fc
  .integer({
    min: new Date('1970-01-01T00:00:00Z').getTime(),
    max: new Date('9999-12-31T23:59:59Z').getTime(),
  })
  .map((ms) => new Date(ms));

// #endregion

describe('SRSCard constructor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes the reference argument through to the instance unchanged (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.reference).toBe(reference);
      })
    );
  });

  it('always sets type to the literal string "card" (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.type).toBe('card');
      })
    );
  });

  it('assigns a fresh UUID v4 to the id field on every instance (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.id).toMatch(UUID_REGEX);
      })
    );
  });

  it('produces a distinct id for each constructed instance (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, referenceArb, (refA, refB) => {
        const a = new SRSCard(refA);
        const b = new SRSCard(refB);
        expect(a.id).not.toBe(b.id);
      })
    );
  });

  it('initializes dismissed to false on every instance (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.dismissed).toBe(false);
      })
    );
  });

  it('initializes deleted to false on every instance (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.deleted).toBe(false);
      })
    );
  });

  it('uses the provided creationTime when supplied (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, creationTimeArb, (reference, creationTime) => {
        const card = new SRSCard(reference, creationTime);
        expect(card.created_at).toBe(creationTime);
      })
    );
  });

  it('falls back to the current system time when creationTime is omitted (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, creationTimeArb, (reference, systemTime) => {
        vi.setSystemTime(systemTime);
        const card = new SRSCard(reference);
        expect(card.created_at.getTime()).toBe(systemTime.getTime());
      })
    );
  });

  it('initializes state to State.New on every instance (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.state).toBe(State.New);
      })
    );
  });

  it('initializes reps and lapses to 0 on every instance (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.reps).toBe(0);
        expect(card.lapses).toBe(0);
      })
    );
  });

  it('initializes elapsed_days and scheduled_days to 0 on every instance (property-based)', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const card = new SRSCard(reference);
        expect(card.elapsed_days).toBe(0);
        expect(card.scheduled_days).toBe(0);
      })
    );
  });

  it('mirrors every FSRS field from createEmptyCard(created_at) (property-based)', () => {
    // The constructor copies `due`, `stability`, `difficulty`, `elapsed_days`,
    // `scheduled_days`, `reps`, `lapses`, `state`, `last_review` from the
    // result of createEmptyCard(created_at). Asserting field equality with an
    // independently-built expected card catches mutants that copy the wrong
    // field, drop a field, or compute its value from a different input.
    fc.assert(
      fc.property(referenceArb, creationTimeArb, (reference, creationTime) => {
        const card = new SRSCard(reference, creationTime);
        const expected = createEmptyCard(creationTime);
        expect(card.due).toEqual(expected.due);
        expect(card.stability).toBe(expected.stability);
        expect(card.difficulty).toBe(expected.difficulty);
        expect(card.elapsed_days).toBe(expected.elapsed_days);
        expect(card.scheduled_days).toBe(expected.scheduled_days);
        expect(card.reps).toBe(expected.reps);
        expect(card.lapses).toBe(expected.lapses);
        expect(card.state).toBe(expected.state);
        expect(card.last_review).toBe(expected.last_review);
      })
    );
  });
});
