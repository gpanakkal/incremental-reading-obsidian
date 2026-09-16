import type { UnknownAction } from '@reduxjs/toolkit';
import {
  type IRPluginState,
  resetCurrentItem,
  type ReviewPage,
  setCurrentItemId,
  setPage,
} from './store';

/**
 * Where review is: the home screen, or an item in review. This is what a review
 * tab's back and forward move between, the way a markdown tab's move between
 * notes.
 *
 * `itemId` is `null` on the home screen, which names no item even though the
 * store keeps the last one while it is up, and in review between items, while
 * the queue has not handed over the next.
 */
export type ReviewPlace = { page: ReviewPage; itemId: string | null };

/**
 * The ephemeral-state key a review tab files its place under.
 *
 * Ephemeral state rather than view state: Obsidian carries both on history
 * entries, but only view state is written to `workspace.json`. Kept out of it,
 * a restored tab goes on resuming from the session tracker the way it always
 * has. (Reopening a closed tab replays ephemeral state as well, which is why
 * `ReviewView.getEphemeralState` leaves the place out for a closing tab.) Namespaced
 * because the same object carries Obsidian's own keys — `focus`, `scroll`,
 * `subpath` and the rest.
 */
export const REVIEW_PLACE_KEY = 'incrementalReadingPlace';

export function placeOf({
  page,
  currentItemId,
}: Pick<IRPluginState, 'page' | 'currentItemId'>): ReviewPlace {
  return page === 'home'
    ? { page, itemId: null }
    : { page, itemId: currentItemId };
}

export function samePlace(a: ReviewPlace, b: ReviewPlace): boolean {
  return a.page === b.page && a.itemId === b.itemId;
}

/**
 * Whether a place is somewhere to come back to. Review between items is not:
 * it is on its way to the next one, and an entry for it would take back to a
 * spinner, or to whatever the queue picks by then.
 */
export function isDestination(place: ReviewPlace): boolean {
  return place.page === 'home' || place.itemId !== null;
}

export function placeToEphemeralState(
  place: ReviewPlace
): Record<typeof REVIEW_PLACE_KEY, ReviewPlace> {
  return { [REVIEW_PLACE_KEY]: place };
}

/**
 * The place filed in an ephemeral state, or `null` when it carries none.
 *
 * Checked field by field, since Obsidian hands a view whatever ephemeral state
 * its caller built — a link's `subpath`, `focusLeaf`'s bare `{ focus: true }` —
 * and a history entry can outlive the version of this plugin that wrote it.
 */
export function readPlace(eState: unknown): ReviewPlace | null {
  if (typeof eState !== 'object' || eState === null) return null;
  if (!Object.hasOwn(eState, REVIEW_PLACE_KEY)) return null;
  const place: unknown = (eState as Record<string, unknown>)[REVIEW_PLACE_KEY];
  if (typeof place !== 'object' || place === null) return null;
  const { page, itemId } = place as Record<string, unknown>;
  if (page !== 'home' && page !== 'review') return null;
  if (itemId !== null && typeof itemId !== 'string') return null;
  return placeOf({ page, currentItemId: itemId });
}

/**
 * The store actions that take review from `state` to `place`, in the order they
 * must be dispatched.
 *
 * The item goes first, so nothing watching the store — the session tracker, the
 * cache eviction — ever sees review open on the item it is leaving. Arriving at
 * a different item resets the per-item state the way advancing does, which
 * keeps a card's answer hidden; arriving between items is that reset alone,
 * which is how review asks the queue for the next. The home screen leaves the
 * item where it is, as the home button does.
 */
export function actionsToReach(
  state: Pick<IRPluginState, 'page' | 'currentItemId'>,
  place: ReviewPlace
): UnknownAction[] {
  const actions: UnknownAction[] = [];
  if (place.page === 'review' && place.itemId !== state.currentItemId) {
    actions.push(resetCurrentItem());
    if (place.itemId !== null) actions.push(setCurrentItemId(place.itemId));
  }
  if (place.page !== state.page) actions.push(setPage(place.page));
  return actions;
}
