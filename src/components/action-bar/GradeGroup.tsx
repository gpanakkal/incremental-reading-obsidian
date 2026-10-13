import { useReviewContext } from '#/components/ReviewContext';
import { formatInterval } from '#/lib/format-interval';
import type { GradePreview } from '#/lib/items/CardManager';
import type { ReviewCard } from '#/lib/types';
import { useSyncExternalStore } from 'react';
import { type Grade, Rating } from 'ts-fsrs';

/**
 * The grades, in the order the group shows them, each with the word it shows
 * and the class styles.css tints that word by.
 */
const GRADE_SEGMENTS: readonly {
  grade: Grade;
  word: string;
  className: string;
}[] = [
  { grade: Rating.Again, word: 'Forgot', className: 'mod-forgot' },
  { grade: Rating.Hard, word: 'Hard', className: 'mod-hard' },
  { grade: Rating.Good, word: 'Good', className: 'mod-good' },
  { grade: Rating.Easy, word: 'Easy', className: 'mod-easy' },
];

/** On the group, as styles.css and the placement measurement find it. */
export const GRADE_GROUP_CLASS = 'ir-grade-group';

/**
 * The card's four grades as one segmented control: each segment its grade's
 * word over how far out that grade would put the card, previewed by the same
 * scheduler grading uses, once while the card is shown (see
 * `CardManager.gradePreview`), so it holds still through re-renders and
 * polls. With fuzz on the intervals leave it out, and those it could move
 * read `~10d`, under the word and in the button's name alike. A grade it
 * cannot preview shows a dash, and is named by its word alone.
 *
 * All of that only while "Show intervals on grade buttons" is on. Off, each
 * segment is its word alone, in both its label and its name, and nothing is
 * previewed. The setting is read afresh on each change to the settings, so an
 * open group follows it.
 *
 * A `ghost` lays out exactly as the real group would inline, for the bar to
 * measure while the real one is in its own row (see `useGradePlacement`). It
 * is hidden by styles.css and from assistive technology, takes no focus, and
 * grades nothing.
 */
export function GradeGroup({
  card,
  ghost = false,
}: {
  card: ReviewCard;
  ghost?: boolean;
}) {
  const { actions, plugin, reviewManager } = useReviewContext();
  const showIntervals = useSyncExternalStore(
    plugin.onSettingsChange,
    () => plugin.settings.showGradeIntervals
  );
  const intervals = showIntervals
    ? previewIntervals(reviewManager.cards.gradePreview(card.data))
    : null;

  return (
    <div
      className={GRADE_GROUP_CLASS}
      role={ghost ? undefined : 'group'}
      aria-hidden={ghost ? 'true' : undefined}
    >
      {GRADE_SEGMENTS.map(({ grade, word, className }, i) => (
        <button
          key={grade}
          className={`ir-grade-button ${className}`}
          aria-label={
            ghost
              ? undefined
              : intervals?.[i] == null
                ? word
                : `${word}, next review in ${intervals[i]}`
          }
          tabIndex={ghost ? -1 : undefined}
          onClick={
            ghost ? undefined : () => void actions.gradeCard(card, grade)
          }
        >
          <span className="ir-grade-word">{word}</span>
          {intervals && (
            <span className="ir-grade-interval">{intervals[i] ?? '–'}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Each grade's interval as its segment shows it, in {@link GRADE_SEGMENTS}
 * order: `~` first where fuzz can move it, null where there is no date.
 */
function previewIntervals({
  approximate,
  inMs,
}: GradePreview): (string | null)[] {
  return GRADE_SEGMENTS.map(({ grade }) =>
    // No date: a step past the last date a Date can hold, or no preview at all
    Number.isNaN(inMs[grade])
      ? null
      : `${approximate[grade] ? '~' : ''}${formatInterval(inMs[grade])}`
  );
}
