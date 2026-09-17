import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSeenId,
  getSeenIds,
  removeSeenId,
  resetSeenIds,
  resetSession,
  store,
} from './store';

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

          expect(seenIds()).toEqual(
            asSet(ids.filter((id) => id !== removed))
          );
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
