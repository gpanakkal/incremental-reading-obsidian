import { EditingState, type EditState } from '#/components/types';
import type { UnknownAction } from '@reduxjs/toolkit';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actionsToReach,
  isDestination,
  placeOf,
  placeToEphemeralState,
  readPlace,
  REVIEW_PLACE_KEY,
  type ReviewPlace,
  samePlace,
} from './review-history';
import {
  type IRPluginState,
  resetCurrentItem,
  resetSession,
  type ReviewPage,
  setCurrentItemId,
  setEditState,
  setPage,
  setShowAnswer,
  store,
} from './store';

// #region HELPERS

const pageArb = fc.constantFrom<ReviewPage>('home', 'review');

/**
 * Item ids. A small shared pool alongside arbitrary strings and UUIDs, so the
 * cases where two ids coincide — the store already on the item a place names —
 * come up as often as the ones where they differ. The empty string is in the
 * pool because nothing stops an id from being one.
 */
const idArb = fc.oneof(fc.constantFrom('', 'a', 'b'), fc.string(), fc.uuid());

const itemIdArb = fc.option(idArb, { nil: null });

/** Every page and item combination, including home with an item named. */
const placeArb: fc.Arbitrary<ReviewPlace> = fc.record({
  page: pageArb,
  itemId: itemIdArb,
});

const editStateArb: fc.Arbitrary<EditState> = fc.oneof(
  fc.constantFrom(EditingState.cancel, EditingState.complete),
  fc.record({ x: fc.integer(), y: fc.integer() })
);

type SeededState = {
  page: ReviewPage;
  currentItemId: string | null;
  showAnswer: boolean;
  editState: EditState;
};

/** The parts of the store a move between places reads or may touch. */
const seededStateArb: fc.Arbitrary<SeededState> = fc.record({
  page: pageArb,
  currentItemId: itemIdArb,
  showAnswer: fc.boolean(),
  editState: editStateArb,
});

/**
 * A store state and a place to take it to. Places are drawn freely, and also
 * derived from the state itself — its own place, and its own item on either
 * page — so arriving where review already is gets tried as often as moving.
 */
const moveArb = seededStateArb.chain((state) =>
  fc.tuple(
    fc.constant(state),
    fc.oneof(
      placeArb,
      fc.constant(placeOf(state)),
      pageArb.map((page) => ({ page, itemId: state.currentItemId }))
    )
  )
);

/** The place `place` stands for once read the way the store would hold it. */
function normalized(place: ReviewPlace): ReviewPlace {
  return placeOf({ page: place.page, currentItemId: place.itemId });
}

/** Put the real store into `state`, starting from a fresh session. */
function seedStore(state: SeededState): IRPluginState {
  store.dispatch(resetSession());
  store.dispatch(setEditState(state.editState));
  store.dispatch(setCurrentItemId(state.currentItemId));
  store.dispatch(setPage(state.page));
  store.dispatch(setShowAnswer(state.showAnswer));
  return store.getState();
}

/**
 * Dispatch `actions` in order on the real store, recording the place review is
 * on after each one, which is what a store subscriber would see.
 */
function applyActions(actions: UnknownAction[]): {
  final: IRPluginState;
  seen: ReviewPlace[];
} {
  const seen: ReviewPlace[] = [];
  const unsubscribe = store.subscribe(() => {
    seen.push(placeOf(store.getState()));
  });
  try {
    for (const action of actions) store.dispatch(action);
  } finally {
    unsubscribe();
  }
  return { final: store.getState(), seen };
}

/** Everything in the store other than the place and the per-item state. */
function unrelatedSlices(state: IRPluginState) {
  const {
    page: _page,
    currentItemId: _currentItemId,
    showAnswer: _showAnswer,
    editState: _editState,
    ...rest
  } = state;
  return rest;
}

/** Whether review arrives on an item other than the one the store is on. */
function changesItem(state: SeededState, place: ReviewPlace): boolean {
  return place.page === 'review' && place.itemId !== state.currentItemId;
}

const anythingOptions: fc.ObjectConstraints = {
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withNullPrototype: true,
  withObjectString: true,
  withSet: true,
  withSparseArray: true,
  withTypedArray: true,
};

/** Any value at all, as far as fast-check can build one. */
const anyValueArb = fc.anything(anythingOptions);

/** Keys a place record may carry besides its own two, with anything in them. */
const placeExtrasArb = fc.dictionary(
  fc.string().filter((key) => key !== 'page' && key !== 'itemId'),
  anyValueArb,
  { maxKeys: 3 }
);

/**
 * The ephemeral state Obsidian builds for its own purposes, which a review tab
 * is handed alongside or instead of its place, plus arbitrary extra keys.
 */
const foreignEphemeralArb = fc
  .tuple(
    fc.record(
      {
        focus: fc.boolean(),
        subpath: fc.string(),
        scroll: fc.double(),
        line: fc.integer(),
        rename: fc.constantFrom('start', 'end', 'all'),
        active: fc.boolean(),
      },
      { requiredKeys: [] }
    ),
    fc.dictionary(
      fc.string().filter((key) => key !== REVIEW_PLACE_KEY),
      anyValueArb,
      { maxKeys: 3 }
    )
  )
  .map(([obsidian, extra]) => ({ ...extra, ...obsidian }));

/** Anything that is not a non-null object: what no place can be filed in. */
const nonObjectArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.string(),
  fc.double(),
  fc.integer(),
  fc.bigInt(),
  fc.boolean(),
  fc.constant(Symbol('state')),
  fc.func(anyValueArb)
);

/** A value is a page review has only if it is exactly one of the two strings. */
const notAPageArb = fc.oneof(
  anyValueArb.filter((value) => value !== 'home' && value !== 'review'),
  fc.constantFrom('Home', 'REVIEW', ' home', 'review ', '', 'homes'),
  // Boxed: a String object holding a page name is not the page name.
  pageArb.map((page) => Object(page) as object)
);

/** An item that is neither an id nor none. */
const notAnItemIdArb = fc.oneof(
  anyValueArb.filter((value) => value !== null && typeof value !== 'string'),
  fc.constant(undefined),
  idArb.map((id) => Object(id) as object)
);
// #endregion

afterEach(() => {
  store.dispatch(resetSession());
  store.dispatch(setEditState(EditingState.cancel));
});

describe('placeOf', () => {
  it('names the store item on the review page and no item on the home screen', () => {
    fc.assert(
      fc.property(pageArb, itemIdArb, (page, currentItemId) => {
        expect(placeOf({ page, currentItemId })).toEqual({
          page,
          itemId: page === 'home' ? null : currentItemId,
        });
      })
    );
  });
});

describe('samePlace', () => {
  it('holds for two places with the same page and item', () => {
    fc.assert(
      fc.property(placeArb, (place) => {
        expect(samePlace(place, { ...place })).toBe(true);
      })
    );
  });

  it('fails for places on different pages', () => {
    fc.assert(
      fc.property(itemIdArb, itemIdArb, (a, b) => {
        expect(
          samePlace({ page: 'home', itemId: a }, { page: 'review', itemId: b })
        ).toBe(false);
        expect(
          samePlace({ page: 'review', itemId: a }, { page: 'home', itemId: b })
        ).toBe(false);
      })
    );
  });

  it('fails for places naming different items, an empty id and none included', () => {
    const differentItemsArb = fc
      .tuple(itemIdArb, fc.oneof(itemIdArb, fc.constant('')))
      .filter(([a, b]) => a !== b);
    fc.assert(
      fc.property(pageArb, differentItemsArb, (page, [a, b]) => {
        expect(samePlace({ page, itemId: a }, { page, itemId: b })).toBe(false);
      })
    );
  });
});

describe('isDestination', () => {
  it('is any place but review between items', () => {
    fc.assert(
      fc.property(placeArb, (place) => {
        expect(isDestination(place)).toBe(
          !(place.page === 'review' && place.itemId === null)
        );
      })
    );
  });
});

describe('placeToEphemeralState', () => {
  it('files the place under its own key and nothing else', () => {
    // ReviewView spreads this over Obsidian's own ephemeral state, so any other
    // key here would overwrite one of Obsidian's.
    fc.assert(
      fc.property(placeArb, (place) => {
        const eState = placeToEphemeralState(place);

        expect(Object.keys(eState)).toEqual([REVIEW_PLACE_KEY]);
        expect(eState[REVIEW_PLACE_KEY]).toEqual(place);
      })
    );
  });
});

describe('readPlace', () => {
  it('reads back every place review can be on, beside any other keys', () => {
    fc.assert(
      fc.property(
        pageArb,
        itemIdArb,
        foreignEphemeralArb,
        (page, currentItemId, foreign) => {
          const place = placeOf({ page, currentItemId });

          expect(
            readPlace({ ...foreign, ...placeToEphemeralState(place) })
          ).toEqual(place);
        }
      )
    );
  });

  it('reads a place with extra fields, naming no item on the home screen', () => {
    fc.assert(
      fc.property(
        placeArb,
        placeExtrasArb,
        foreignEphemeralArb,
        (place, extras, foreign) => {
          const eState = {
            ...foreign,
            [REVIEW_PLACE_KEY]: { ...extras, ...place },
          };

          expect(readPlace(eState)).toEqual(normalized(place));
        }
      )
    );
  });

  it('reads the key earlier versions of the plugin filed places under', () => {
    // History entries live as long as the tab, through plugin updates and
    // reloads, so the key a place is filed under cannot move.
    fc.assert(
      fc.property(pageArb, itemIdArb, (page, currentItemId) => {
        const place = placeOf({ page, currentItemId });

        expect(readPlace({ incrementalReadingPlace: place })).toEqual(place);
        expect(Object.keys(placeToEphemeralState(place))).toEqual([
          'incrementalReadingPlace',
        ]);
      })
    );
  });

  it('finds nothing in a state that is not an object', () => {
    fc.assert(
      fc.property(nonObjectArb, (eState) => {
        expect(readPlace(eState)).toBeNull();
      })
    );
  });

  it('finds nothing in a state no place was filed in', () => {
    const noPlaceArb = fc
      .oneof(
        foreignEphemeralArb,
        anyValueArb,
        fc.array(anyValueArb),
        fc.constant({}),
        fc.constant(Object.create(null) as object)
      )
      .filter(
        (value) =>
          typeof value !== 'object' ||
          value === null ||
          !Object.hasOwn(value, REVIEW_PLACE_KEY)
      );
    fc.assert(
      fc.property(noPlaceArb, (eState) => {
        expect(readPlace(eState)).toBeNull();
      })
    );
  });

  it('ignores a place the state only inherits', () => {
    fc.assert(
      fc.property(
        pageArb,
        itemIdArb,
        fc.integer({ min: 1, max: 3 }),
        (page, currentItemId, depth) => {
          let eState: object = placeToEphemeralState(
            placeOf({ page, currentItemId })
          );
          for (let i = 0; i < depth; i++)
            eState = Object.create(eState) as object;

          expect(readPlace(eState)).toBeNull();
        }
      )
    );
  });

  it('rejects a filed place that is not an object', () => {
    const notARecordArb = fc.oneof(nonObjectArb, fc.array(anyValueArb));
    fc.assert(
      fc.property(notARecordArb, foreignEphemeralArb, (value, foreign) => {
        expect(readPlace({ ...foreign, [REVIEW_PLACE_KEY]: value })).toBeNull();
      })
    );
  });

  it('rejects a place on a page review does not have', () => {
    fc.assert(
      fc.property(
        fc.option(notAPageArb, { nil: undefined }),
        itemIdArb,
        placeExtrasArb,
        fc.boolean(),
        (page, itemId, extras, omitPage) => {
          const filed: Record<string, unknown> = { ...extras, page, itemId };
          if (omitPage) delete filed.page;

          expect(readPlace({ [REVIEW_PLACE_KEY]: filed })).toBeNull();
        }
      )
    );
  });

  it('rejects a place whose item is neither an id nor none', () => {
    fc.assert(
      fc.property(
        pageArb,
        notAnItemIdArb,
        placeExtrasArb,
        fc.boolean(),
        (page, itemId, extras, omitItemId) => {
          const filed: Record<string, unknown> = { ...extras, page, itemId };
          if (omitItemId) delete filed.itemId;

          expect(readPlace({ [REVIEW_PLACE_KEY]: filed })).toBeNull();
        }
      )
    );
  });
});

describe('actionsToReach', () => {
  it('puts review on exactly the place named', () => {
    fc.assert(
      fc.property(moveArb, ([state, place]) => {
        seedStore(state);

        const { final } = applyActions(actionsToReach(state, place));

        expect(placeOf(final)).toEqual(normalized(place));
      })
    );
  });

  it('dispatches nothing when review is already there, and something otherwise', () => {
    fc.assert(
      fc.property(moveArb, ([state, place]) => {
        const actions = actionsToReach(state, place);

        expect(actions.length === 0).toBe(
          samePlace(placeOf(state), normalized(place))
        );
      })
    );
  });

  it('moves the item before the page, and each only once', () => {
    fc.assert(
      fc.property(moveArb, ([state, place]) => {
        const actions = actionsToReach(state, place);
        const pageMoves = actions.filter((action) => setPage.match(action));

        expect(pageMoves.length).toBeLessThanOrEqual(1);
        if (pageMoves.length === 1) {
          expect(setPage.match(actions[actions.length - 1])).toBe(true);
        }
        expect(
          actions.filter((action) => setCurrentItemId.match(action)).length
        ).toBeLessThanOrEqual(1);
        expect(
          actions.filter((action) => resetCurrentItem.match(action)).length
        ).toBeLessThanOrEqual(1);
      })
    );
  });

  it('never shows review open on the item it is leaving', () => {
    // Store subscribers — the session tracker, the cache eviction — react to
    // every dispatch, so no state in between may put the review page back on
    // the item being left.
    fc.assert(
      fc.property(moveArb, ([state, place]) => {
        fc.pre(changesItem(state, place) && state.currentItemId !== null);
        seedStore(state);
        const leaving: ReviewPlace = {
          page: 'review',
          itemId: state.currentItemId,
        };

        const { seen } = applyActions(actionsToReach(state, place));

        for (const passed of seen) {
          expect(samePlace(passed, leaving)).toBe(false);
        }
      })
    );
  });

  it('leaves the item and its state alone on the way home', () => {
    fc.assert(
      fc.property(seededStateArb, itemIdArb, (state, itemId) => {
        const before = seedStore(state);
        const actions = actionsToReach(state, { page: 'home', itemId });

        const { final } = applyActions(actions);

        expect(actions.every((action) => setPage.match(action))).toBe(true);
        expect(final.currentItemId).toBe(before.currentItemId);
        expect(final.showAnswer).toBe(before.showAnswer);
        expect(final.editState).toEqual(before.editState);
      })
    );
  });

  it('resets the per-item state on arriving at a different item', () => {
    // As advancing does: a card arrived at through history starts with its
    // answer hidden, and no edit carries over from the item left.
    fc.assert(
      fc.property(moveArb, ([state, place]) => {
        fc.pre(changesItem(state, place));
        seedStore(state);

        const { final } = applyActions(actionsToReach(state, place));

        expect(final.showAnswer).toBe(false);
        expect(final.editState).toBe(EditingState.cancel);
      })
    );
  });

  it('keeps the per-item state when the item stays the same', () => {
    fc.assert(
      fc.property(seededStateArb, pageArb, (state, page) => {
        const before = seedStore(state);

        const { final } = applyActions(
          actionsToReach(state, { page, itemId: state.currentItemId })
        );

        expect(final.showAnswer).toBe(before.showAnswer);
        expect(final.editState).toEqual(before.editState);
      })
    );
  });

  it('arrives between items through the reset alone', () => {
    // The reset is how review asks the queue for the next item; naming the null
    // id on top of it would be a second store change for subscribers to see.
    fc.assert(
      fc.property(seededStateArb, idArb, (state, leftId) => {
        const from = { ...state, currentItemId: leftId };

        const actions = actionsToReach(from, { page: 'review', itemId: null });

        expect(actions.filter((action) => !setPage.match(action))).toEqual([
          resetCurrentItem(),
        ]);
      })
    );
  });

  it('touches nothing in the store beyond the place and the per-item state', () => {
    fc.assert(
      fc.property(moveArb, ([state, place]) => {
        const before = seedStore(state);

        const { final } = applyActions(actionsToReach(state, place));

        expect(unrelatedSlices(final)).toEqual(unrelatedSlices(before));
      })
    );
  });
});
