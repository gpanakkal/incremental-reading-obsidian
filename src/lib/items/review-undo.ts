import {
  initialCard,
  initialText,
  liveInOrder,
  replayCard,
  replayText,
  startOf,
  underRules,
  type CardSchedule,
  type LoggedGrade,
  type ReplaySettings,
  type TextRules,
  type TextSchedule,
} from '#/lib/repository/scheduling-replay';
import type { FSRSParameters } from 'ts-fsrs';

/**
 * Undoing a review takes back that review and the reviews the same device
 * made of the item after it, never another device's, and gives the item the
 * schedule the reviews left imply, worked out as a merge works it out
 * (`replaySchedules`): from the item as it was before the review when that
 * still holds every review left, else from scratch. An undo and a later
 * merge so agree on the schedule, and a review merged in from another device
 * keeps its effect through an undo made after it.
 */

/** A review as an undo reads it: the device that made it, besides when. */
export interface AuthoredReview extends LoggedGrade {
  /** The device that made it, as its stamp says. */
  updated_by: string;
}

/** What undoing one review takes back and leaves. */
export interface UndoPlan {
  /**
   * The live reviews the item had when the undone review was made, in
   * replay order: what the item as it was before it reflects.
   */
  before: AuthoredReview[];
  /** The ids of the reviews the undo takes back, the undone one included. */
  taken: Set<string>;
  /** The live reviews left once they are taken back, in replay order. */
  left: AuthoredReview[];
}

/**
 * The reviews `ids` names, as `log` holds them, live as they were when they
 * were noted (see {@link planUndo}'s `before`), though undone since. One no
 * longer in `log` at all stands as a review of no time, so that the noted
 * reviews still start no log that lacks it (see `startOf`).
 */
export function notedLog(
  log: readonly AuthoredReview[],
  ids: readonly string[]
): AuthoredReview[] {
  const byId = new Map(log.map((review) => [review.id, review]));
  return ids.map((id) => ({
    ...(byId.get(id) ?? { id, at: 0, rating: 0, updated_by: '' }),
    deleted: false,
  }));
}

/**
 * What undoing review `undoneId` takes back: it, and each live review the
 * device that made it made of the item after it, which are those of that
 * device's the item didn't have when it was made. Another device's reviews
 * stay whatever their times say, as a clock set ahead dates a review made
 * before it later.
 * @param log the item's reviews, undone ones included
 * @param before the item's live reviews just before `undoneId` was made, as
 * noted then; when not noted (it was made by another session), those dated
 * no later than it are taken for them
 * @returns null when `undoneId` is no live review of the item
 */
export function planUndo(
  log: readonly AuthoredReview[],
  undoneId: string,
  before?: readonly AuthoredReview[]
): UndoPlan | null {
  const undone = log.find((review) => review.id === undoneId);
  if (!undone || undone.deleted) return null;
  const had =
    before ??
    log.filter(
      (review) =>
        !review.deleted && review.id !== undoneId && review.at <= undone.at
    );
  const known = new Set(had.map((review) => review.id));
  const taken = new Set(
    log
      .filter(
        (review) =>
          !review.deleted &&
          review.updated_by === undone.updated_by &&
          !known.has(review.id)
      )
      .map((review) => review.id)
  );
  return {
    before: liveInOrder(had),
    taken,
    left: liveInOrder(log.filter((review) => !taken.has(review.id))),
  };
}

/**
 * The schedule `plan` leaves a card with: the card as it was before the
 * undone grade, `snapshot`, graded with the reviews left that it doesn't
 * hold, or, when it holds one that is no longer left, a new card made at
 * `createdAt` graded with all of them (see `startOf`).
 */
export function cardAfterUndo(
  plan: UndoPlan,
  snapshot: CardSchedule,
  createdAt: number,
  params: Partial<FSRSParameters>
): CardSchedule {
  const { from, rest } = startOf([plan.before], plan.left);
  return replayCard(
    rest,
    params,
    from === null ? initialCard(createdAt) : snapshot
  );
}

/**
 * The schedule `plan` leaves a text with under `rules`, the rules it has
 * now: as for {@link cardAfterUndo}, from the text as it was before the
 * undone review, `snapshot`, put under those rules from its own (see
 * `underRules`), or from scratch, due when it was before the review once no
 * review is left.
 */
export function textAfterUndo(
  plan: UndoPlan,
  snapshot: TextSchedule & TextRules,
  rules: TextRules,
  settings: Pick<ReplaySettings, 'fuzzTextReviews'>
): TextSchedule {
  const { from, rest } = startOf([plan.before], plan.left);
  const schedule: TextSchedule = {
    interval: snapshot.interval,
    due: snapshot.due,
    due_fuzz: snapshot.due_fuzz,
  };
  return replayText(
    rest,
    rules,
    settings,
    from === null
      ? initialText(schedule)
      : underRules(schedule, snapshot, rules, plan.before)
  );
}
