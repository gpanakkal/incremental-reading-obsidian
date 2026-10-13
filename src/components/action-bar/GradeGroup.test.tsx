// @vitest-environment jsdom
import { ReviewContextProvider } from '#/components/ReviewContext';
import { createEmitter } from '#/lib/emitter';
import { formatInterval } from '#/lib/format-interval';
import { CardManager } from '#/lib/items/CardManager';
import type { ReviewCard } from '#/lib/types';
import fc from 'fast-check';
import { type ComponentChild, render } from 'preact';
import { act } from 'preact/test-utils';
import { generatorParameters, type Grade, Rating } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GradeGroup } from './GradeGroup';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // Synchronous: act flushes the effects, where the setting is subscribed to
  void act(() => {
    render(node as never, container);
  });
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

/** Which grades fuzz could move, each its own. */
const approximateArb = fc.tuple(...GRADES.map(() => fc.boolean()));

/** An interval as shown: `~` before it while fuzz makes it approximate. */
const labelOf = (offset: number, approximate: boolean) =>
  `${approximate ? '~' : ''}${formatInterval(offset)}`;

/** What a segment shows under its word for `offset`: none for no date. */
const intervalShown = (offset: number, approximate = false) =>
  Number.isNaN(offset) ? '–' : labelOf(offset, approximate);

/** A segment's accessible name for `offset`: the word alone for no date. */
const nameOf = (word: string, offset: number, approximate = false) =>
  Number.isNaN(offset)
    ? word
    : `${word}, next review in ${labelOf(offset, approximate)}`;

/**
 * A plugin holding the "Show intervals on grade buttons" setting, which
 * announces each change to its settings the way the real one does.
 */
function makePlugin(showGradeIntervals: boolean, actions: object = {}) {
  const emitter = createEmitter();
  const settings = { showGradeIntervals };
  return {
    plugin: {
      actions,
      settings,
      onSettingsChange: emitter.subscribe,
    },
    /** Change the setting and save it, as the settings tab does. */
    setShowGradeIntervals: (show: boolean) =>
      void act(() => {
        settings.showGradeIntervals = show;
        emitter.emit();
      }),
  };
}

/**
 * Mount the group for `card`, its preview putting each grade `offsets` out,
 * each `approximate` or not, with the intervals shown or not. Mocks are made
 * here rather than shared: the properties below mount many times per `it`, and
 * a spy counted across cases would read as a click the group never made.
 */
function mountGroup(
  card: ReviewCard,
  offsets: readonly number[],
  {
    ghost = false,
    approximate = [false, false, false, false],
    showIntervals = true,
  }: {
    ghost?: boolean;
    approximate?: readonly boolean[];
    showIntervals?: boolean;
  } = {}
) {
  document.body.innerHTML = '';
  const gradeCard = vi.fn();
  const gradePreview = vi.fn(() => ({
    approximate: Object.fromEntries(
      GRADES.map(([, grade], i) => [grade, approximate[i]])
    ),
    inMs: Object.fromEntries(GRADES.map(([, grade], i) => [grade, offsets[i]])),
  }));
  const { plugin, setShowGradeIntervals } = makePlugin(showIntervals, {
    gradeCard,
  });
  const container = mount(
    <ReviewContextProvider
      plugin={plugin as never}
      reviewView={{} as never}
      reviewManager={{ cards: { gradePreview } } as never}
    >
      <GradeGroup card={card} ghost={ghost} />
    </ReviewContextProvider>
  );
  return { container, gradeCard, gradePreview, setShowGradeIntervals };
}

/** Each segment's word, interval line (null for none) and accessible name. */
const segmentsShown = (container: HTMLElement) =>
  segments(container).map((button) => ({
    word: button.querySelector('.ir-grade-word')?.textContent,
    interval: button.querySelector('.ir-grade-interval')?.textContent ?? null,
    name: button.getAttribute('aria-label'),
  }));

/**
 * What the group shows for `offsets` with intervals on, or off. A ghost names
 * nothing: it is hidden from assistive technology.
 */
const expectedSegments = (
  offsets: readonly number[],
  approximate: readonly boolean[],
  showIntervals: boolean,
  ghost = false
) =>
  GRADES.map(([word], i) => {
    const shown = showIntervals
      ? {
          word,
          interval: intervalShown(offsets[i], approximate[i]),
          name: nameOf(word, offsets[i], approximate[i]),
        }
      : { word, interval: null, name: word };
    return ghost ? { ...shown, name: null } : shown;
  });

/**
 * A card under review, as the current-item poll hands it over: a new object
 * each time, equal in every field.
 */
function polledCard(id = 'card-id'): ReviewCard {
  return {
    data: {
      id,
      type: 'card',
      reference: `${id}.md`,
      state: 'Review',
      stability: 60,
      difficulty: 5,
      reps: 6,
      lapses: 0,
      learning_steps: 0,
      elapsed_days: 0,
      scheduled_days: 30,
      last_review: new Date(2026, 8, 12, 12),
      due: new Date(2026, 9, 12, 11),
      created_at: new Date(2026, 0, 1),
      dismissed: false,
      deleted: false,
      parent: null,
    },
    file: {},
  } as never;
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
      fc.property(offsetsArb, approximateArb, (offsets, approximate) => {
        const { container } = mountGroup(makeCard(), offsets, { approximate });

        const shown = segments(container).map((button) => [
          button.querySelector('.ir-grade-word')?.textContent,
          button.querySelector('.ir-grade-interval')?.textContent,
        ]);

        expect(shown).toEqual(
          GRADES.map(([word], i) => [
            word,
            intervalShown(offsets[i], approximate[i]),
          ])
        );
      })
    );
  });

  it('property: names each grade by its word and interval, on the button', () => {
    fc.assert(
      fc.property(offsetsArb, approximateArb, (offsets, approximate) => {
        const { container } = mountGroup(makeCard(), offsets, { approximate });

        segments(container).forEach((button, i) => {
          expect(button.getAttribute('aria-label')).toBe(
            nameOf(GRADES[i][0], offsets[i], approximate[i])
          );
          expect(button.hasAttribute('title')).toBe(false);
          for (const inner of Array.from(button.querySelectorAll('*'))) {
            expect(inner.hasAttribute('aria-label')).toBe(false);
          }
        });
      })
    );
  });

  it('property: shows and names each grade with its interval only while the setting is on, previewing nothing while it is off', () => {
    fc.assert(
      fc.property(
        offsetsArb,
        approximateArb,
        fc.boolean(),
        fc.boolean(),
        (offsets, approximate, showIntervals, ghost) => {
          const { container, gradePreview } = mountGroup(makeCard(), offsets, {
            approximate,
            showIntervals,
            ghost,
          });

          expect(segmentsShown(container)).toEqual(
            expectedSegments(offsets, approximate, showIntervals, ghost)
          );
          expect(gradePreview).toHaveBeenCalledTimes(showIntervals ? 1 : 0);
        }
      )
    );
  });

  it('property: follows the setting as it is turned on and off, without being mounted again', () => {
    fc.assert(
      fc.property(
        offsetsArb,
        approximateArb,
        fc.boolean(),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        (offsets, approximate, initially, flips, ghost) => {
          const { container, setShowGradeIntervals } = mountGroup(
            makeCard(),
            offsets,
            { approximate, showIntervals: initially, ghost }
          );

          for (const show of flips) {
            setShowGradeIntervals(show);
            expect(segmentsShown(container)).toEqual(
              expectedSegments(offsets, approximate, show, ghost)
            );
          }
        }
      )
    );
  });

  it('asks for the preview of the card on screen', () => {
    const card = makeCard();

    const { gradePreview } = mountGroup(card, [0, 0, 0, 0]);

    expect(gradePreview).toHaveBeenCalledWith(card.data);
  });

  it('keeps its intervals while the same card is polled, fuzz on, and moves on with the card', () => {
    vi.setSystemTime(new Date(2026, 9, 12, 12));
    const cards = new CardManager(
      {
        settings: {
          dayRolloverOffset: 4,
          fsrsParams: generatorParameters({ enable_fuzz: true }),
        },
        app: {},
      } as never,
      {} as never
    );
    const container = document.body.appendChild(document.createElement('div'));
    const shown = (card: ReviewCard) => {
      render(
        <ReviewContextProvider
          plugin={makePlugin(true).plugin as never}
          reviewView={{} as never}
          reviewManager={{ cards } as never}
        >
          <GradeGroup card={card} />
        </ReviewContextProvider>,
        container
      );
      return segments(container).map((b) => [
        b.querySelector('.ir-grade-interval')?.textContent,
        b.getAttribute('aria-label'),
      ]);
    };

    // Each poll at a new moment reseeded the fuzz: Easy went 5mo, 6mo, 5mo
    const first = shown(polledCard());
    for (let poll = 0; poll < 6; poll++) {
      vi.advanceTimersByTime(5_000);
      expect(shown(polledCard())).toEqual(first);
    }
    // Approximate where fuzz can move it, under the word and in the button's
    // name alike; Forgot's relearning step is never fuzzed
    expect(first.map(([interval]) => interval?.startsWith('~'))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    first.forEach(([interval, label], i) => {
      expect(label).toBe(`${GRADES[i][0]}, next review in ${interval}`);
    });

    const preview = vi.spyOn(cards, 'previewDue');
    shown(polledCard('other-card'));
    expect(preview).toHaveBeenCalledOnce();
  });

  it('still offers every grade, by its word alone, when the card cannot be previewed', () => {
    const card = makeCard();
    const { container, gradeCard } = mountGroup(card, [NaN, NaN, NaN, NaN]);

    expect(
      segments(container).map((b) => [
        b.getAttribute('aria-label'),
        b.querySelector('.ir-grade-interval')?.textContent,
      ])
    ).toEqual(GRADES.map(([word]) => [word, '–']));
    segments(container)[2]?.click();
    expect(gradeCard).toHaveBeenCalledExactlyOnceWith(card, Rating.Good);
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
