import { useReviewContext } from '#/components/ReviewContext';
import { formatInterval } from '#/lib/format-interval';
import type { ReviewCard } from '#/lib/types';
import { useMemo } from 'react';
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
 * scheduler grading uses, at the moment the group renders. A grade it cannot
 * preview shows a dash, and is named by its word alone.
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
  const { actions, reviewManager } = useReviewContext();
  const intervals = useMemo(() => {
    const now = new Date();
    let due: Record<Grade, Date> | null = null;
    try {
      due = reviewManager.cards.previewDue(card.data, now);
    } catch (e) {
      // A card or settings ts-fsrs refuses fails the grade on click, where it
      // is reported; the buttons stay up to try
      console.warn('Could not preview the grades of a card', e);
    }
    return GRADE_SEGMENTS.map(({ grade }) => {
      const ms = due ? due[grade].getTime() - now.getTime() : NaN;
      // An Invalid Date — a step past the last date a Date can hold
      return Number.isNaN(ms) ? null : formatInterval(ms);
    });
  }, [card.data, reviewManager]);

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
              : intervals[i] === null
                ? word
                : `${word}, next review in ${intervals[i]}`
          }
          tabIndex={ghost ? -1 : undefined}
          onClick={
            ghost ? undefined : () => void actions.gradeCard(card, grade)
          }
        >
          <span className="ir-grade-word">{word}</span>
          <span className="ir-grade-interval">{intervals[i] ?? '–'}</span>
        </button>
      ))}
    </div>
  );
}
