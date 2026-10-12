// @vitest-environment jsdom
import { ReviewContextProvider } from '#/components/ReviewContext';
import { formatInterval } from '#/lib/format-interval';
import type { ReviewCard } from '#/lib/types';
import fc from 'fast-check';
import { type ComponentChild, render } from 'preact';
import { type Grade, Rating } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GradeGroup } from './GradeGroup';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

/** The four grades as the group shows them, in the order it shows them. */
const GRADES = [
  ['Forgot', Rating.Again],
  ['Hard', Rating.Hard],
  ['Good', Rating.Good],
  ['Easy', Rating.Easy],
] as const;

function makeCard(): ReviewCard {
  return {
    data: { id: 'card-id', type: 'card', dismissed: false },
    file: {},
  } as never;
}

/**
 * How far out each grade would put the card: anything from overdue to the
 * last date a Date can hold, sub-minute steps included — settings put no
 * ceiling on steps or the maximum interval — and now and then no date at all — what
 * a learning step past the last date a Date can hold leaves (see
 * CardManager.previewDue's tests).
 */
const offsetsArb = fc.tuple(
  ...GRADES.map(() =>
    fc.oneof(
      {
        weight: 9,
        arbitrary: fc.integer({
          min: -60_000,
          max: 100 * 365 * 24 * 3_600_000,
        }),
      },
      // As far as a Date can reach past any review time drawn below
      { weight: 2, arbitrary: fc.integer({ min: 0, max: 8.6e15 }) },
      { weight: 1, arbitrary: fc.constant(NaN) }
    )
  )
);

/** What a segment shows under its word for `offset`: none for no date. */
const intervalShown = (offset: number) =>
  Number.isNaN(offset) ? '–' : formatInterval(offset);

/** A segment's accessible name for `offset`: the word alone for no date. */
const nameOf = (word: string, offset: number) =>
  Number.isNaN(offset)
    ? word
    : `${word}, next review in ${formatInterval(offset)}`;

/** Any moment a review could happen at, with a century past it to schedule in. */
const reviewTimeArb = fc.date({
  min: new Date(1970, 0, 1),
  max: new Date(2200, 0, 1),
  noInvalidDate: true,
});

/**
 * Mount the group for `card`, previewing `offsets` past the current (faked)
 * time. Mocks are made here rather than shared: the properties below mount
 * many times per `it`, and a spy counted across cases would read as a click
 * the group never made.
 */
function mountGroup(
  card: ReviewCard,
  offsets: readonly number[],
  { ghost = false }: { ghost?: boolean } = {}
) {
  document.body.innerHTML = '';
  const now = Date.now();
  const gradeCard = vi.fn();
  const previewDue = vi.fn(() => dueAt(now, offsets));
  const reviewManager = { cards: { previewDue } };
  const node = (shown: ReviewCard) => (
    <ReviewContextProvider
      plugin={{ actions: { gradeCard } } as never}
      reviewView={{} as never}
      reviewManager={reviewManager as never}
    >
      <GradeGroup card={shown} ghost={ghost} />
    </ReviewContextProvider>
  );
  const container = mount(node(card));
  return {
    container,
    gradeCard,
    previewDue,
    now,
    /** Render the group again, in place, for `next`. */
    rerender: (next: ReviewCard) => {
      render(node(next) as never, container);
    },
  };
}

/** A preview putting each grade `offsets` past `now`, in grade order. */
function dueAt(now: number, offsets: readonly number[]) {
  return Object.fromEntries(
    GRADES.map(([, grade], i) => [grade, new Date(now + offsets[i])])
  );
}

function segments(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('.ir-grade-group > button')
  );
}

// #endregion

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useDispatch')` throws "Cannot
// redefine property". This is the documented cannot-be-spied case.
vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
}));

describe('GradeGroup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('property: shows each grade, in order, as its word over when it would put the card next', () => {
    fc.assert(
      fc.property(reviewTimeArb, offsetsArb, (at, offsets) => {
        vi.setSystemTime(at);
        const { container } = mountGroup(makeCard(), offsets);

        const shown = segments(container).map((button) => [
          button.querySelector('.ir-grade-word')?.textContent,
          button.querySelector('.ir-grade-interval')?.textContent,
        ]);

        expect(shown).toEqual(
          GRADES.map(([word], i) => [word, intervalShown(offsets[i])])
        );
      })
    );
  });

  it('property: names each grade by its word and interval, on the button', () => {
    fc.assert(
      fc.property(offsetsArb, (offsets) => {
        const { container } = mountGroup(makeCard(), offsets);

        segments(container).forEach((button, i) => {
          expect(button.getAttribute('aria-label')).toBe(
            nameOf(GRADES[i][0], offsets[i])
          );
          expect(button.hasAttribute('title')).toBe(false);
          for (const inner of Array.from(button.querySelectorAll('*'))) {
            expect(inner.hasAttribute('aria-label')).toBe(false);
          }
        });
      })
    );
  });

  it('previews the card on screen at the time it renders', () => {
    vi.setSystemTime(new Date(2026, 9, 11, 9, 30));
    const card = makeCard();

    const { previewDue, now } = mountGroup(card, [0, 0, 0, 0]);

    expect(previewDue).toHaveBeenCalledExactlyOnceWith(
      card.data,
      new Date(now)
    );
  });

  it('previews again once another card is on screen, and only then', () => {
    const card = makeCard();
    const { container, previewDue, now, rerender } = mountGroup(
      card,
      [0, 0, 0, 0]
    );
    const intervals = () =>
      segments(container).map(
        (b) => b.querySelector('.ir-grade-interval')?.textContent
      );

    rerender({ ...card });
    expect(previewDue).toHaveBeenCalledTimes(1);

    previewDue.mockReturnValue(dueAt(now, [60_000, 3_600_000, 86_400_000, 0]));
    rerender({ ...card, data: { ...card.data } });

    expect(previewDue).toHaveBeenCalledTimes(2);
    expect(intervals()).toEqual(['1m', '1h', '1d', '<1m']);
  });

  it('still offers every grade, by its word alone, when the card cannot be previewed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const actions = { gradeCard: vi.fn() };
    const card = makeCard();
    const container = mount(
      <ReviewContextProvider
        plugin={{ actions } as never}
        reviewView={{} as never}
        reviewManager={
          {
            cards: {
              previewDue: () => {
                throw new Error('a card ts-fsrs will not schedule');
              },
            },
          } as never
        }
      >
        <GradeGroup card={card} />
      </ReviewContextProvider>
    );

    expect(
      segments(container).map((b) => [
        b.getAttribute('aria-label'),
        b.querySelector('.ir-grade-interval')?.textContent,
      ])
    ).toEqual(GRADES.map(([word]) => [word, '–']));
    segments(container)[2]?.click();
    expect(actions.gradeCard).toHaveBeenCalledExactlyOnceWith(
      card,
      Rating.Good
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Could not preview the grades of a card',
      expect.any(Error)
    );
  });

  it.each(GRADES)('grades the card %s', (word, rating: Grade) => {
    const card = makeCard();
    const { container, gradeCard } = mountGroup(card, [0, 0, 0, 0]);

    segments(container)
      .find((b) => b.querySelector('.ir-grade-word')?.textContent === word)
      ?.click();

    expect(gradeCard).toHaveBeenCalledExactlyOnceWith(card, rating);
  });

  it('is one group of four buttons, each in reach of the keyboard', () => {
    const { container } = mountGroup(makeCard(), [0, 0, 0, 0]);

    const group = container.querySelector('.ir-grade-group');
    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.hasAttribute('aria-hidden')).toBe(false);
    for (const button of segments(container)) {
      expect(button.tabIndex).toBe(0);
    }
  });

  it('marks each segment with the class styles.css tints its word by', () => {
    const { container } = mountGroup(makeCard(), [0, 0, 0, 0]);

    expect(
      segments(container).map((button) =>
        Array.from(button.classList).filter((c) => c.startsWith('mod-'))
      )
    ).toEqual([['mod-forgot'], ['mod-hard'], ['mod-good'], ['mod-easy']]);
  });

  it('shows no emoji', () => {
    const { container } = mountGroup(makeCard(), [0, 60_000, 600_000, 1e9]);

    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  describe('as a ghost, laid out only to be measured', () => {
    it('lays out the same four segments', () => {
      const offsets = [0, 60_000, 600_000, 1e9];
      const real = segments(mountGroup(makeCard(), offsets).container).map(
        (b) => b.textContent
      );

      const ghost = segments(
        mountGroup(makeCard(), offsets, { ghost: true }).container
      ).map((b) => b.textContent);

      expect(ghost).toEqual(real);
    });

    it('is hidden from assistive technology and from tabbing', () => {
      const { container } = mountGroup(makeCard(), [0, 0, 0, 0], {
        ghost: true,
      });

      const group = container.querySelector('.ir-grade-group');
      expect(group?.getAttribute('aria-hidden')).toBe('true');
      for (const button of segments(container)) {
        expect(button.tabIndex).toBe(-1);
      }
    });

    it('grades nothing when clicked', () => {
      const { container, gradeCard } = mountGroup(makeCard(), [0, 0, 0, 0], {
        ghost: true,
      });

      for (const button of segments(container)) button.click();

      expect(gradeCard).not.toHaveBeenCalled();
    });
  });
});
