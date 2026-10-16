// @vitest-environment jsdom
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_ITEM_REFETCH_TIME } from './constants';
import {
  REVIEW_REMINDER_POLL_TIME,
  REVIEW_REMINDER_TEXT,
  reminderTypes,
  startReviewReminder,
  type ReminderSettings,
} from './review-reminder';
import type { NoteType } from './types';

// #region HELPERS

const NOTE_TYPES = ['article', 'snippet', 'card'] as const;

type TypesToInclude = Partial<Record<NoteType, true>>;

const settingsArb = fc.record({
  reviewReminders: fc.boolean(),
  remindDueArticles: fc.boolean(),
  remindDueSnippets: fc.boolean(),
});

/** Which item types have something due. */
const dueArb = fc.subarray([...NOTE_TYPES]).map((types) => new Set(types));

/**
 * A reminder on a fresh status bar item, over a fake due query that finds
 * something due when any type it is asked about is in `due`. Settings and the due set are
 * live: change them, then fire the matching event.
 */
function makeReminder({
  settings = {
    reviewReminders: true,
    remindDueArticles: true,
    remindDueSnippets: true,
  },
  due = new Set<NoteType>(),
  firstAnswer,
}: {
  settings?: ReminderSettings;
  due?: Set<NoteType>;
  /** What the first query, the one made on start, answers instead. */
  firstAnswer?: Promise<boolean>;
} = {}) {
  const el = document.body.createDiv();
  const dataListeners = new Set<() => void>();
  const settingsListeners = new Set<() => void>();
  /** When each due query started, by the (fake) clock. */
  const queryTimes: number[] = [];
  /** When the reminder started, by the (fake) clock. */
  const start = Date.now();
  const anyDue = vi.fn((typesToInclude: TypesToInclude): Promise<boolean> => {
    queryTimes.push(Date.now());
    return Promise.resolve(
      NOTE_TYPES.some((type) => type in typesToInclude && due.has(type))
    );
  });
  if (firstAnswer) anyDue.mockReturnValueOnce(firstAnswer);
  const open = vi.fn();
  const reminder = startReviewReminder({
    el,
    icon: 'book-open-text',
    reviewManager: { anyDue },
    getSettings: () => settings,
    onDataChange: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onSettingsChange: (listener) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    open,
  });
  return {
    el,
    settings,
    due,
    anyDue,
    open,
    reminder,
    queryTimes,
    start,
    dataListeners,
    settingsListeners,
    fireDataChange: () => {
      for (const listener of dataListeners) listener();
    },
    changeSettings: (patch: Partial<ReminderSettings>) => {
      Object.assign(settings, patch);
      for (const listener of settingsListeners) listener();
    },
  };
}

/** Whether the status bar item can be seen. */
const isShown = (el: HTMLElement) =>
  el.isConnected && el.style.display !== 'none';

/** Let pending timers due within `ms`, and the promises they start, run. */
const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** The rule the indicator follows. */
function expectedVisible(settings: ReminderSettings, due: Set<NoteType>) {
  return (
    settings.reviewReminders &&
    (due.has('card') ||
      (settings.remindDueArticles && due.has('article')) ||
      (settings.remindDueSnippets && due.has('snippet')))
  );
}

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// #endregion

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('reminderTypes', () => {
  it('always includes cards, adds articles and snippets as their toggles say, and is nothing while reminders are off', () => {
    fc.assert(
      fc.property(settingsArb, (settings) => {
        expect(reminderTypes(settings)).toEqual(
          settings.reviewReminders
            ? {
                card: true,
                ...(settings.remindDueArticles && { article: true }),
                ...(settings.remindDueSnippets && { snippet: true }),
              }
            : null
        );
      })
    );
  });
});

describe('startReviewReminder', () => {
  it('shows only while reminders are on and an item of a type they cover is due', async () => {
    await fc.assert(
      fc.asyncProperty(settingsArb, dueArb, async (settings, due) => {
        const h = makeReminder({ settings, due });
        // Nothing is known before the first query answers
        expect(isShown(h.el)).toBe(false);

        await advance();

        expect(isShown(h.el)).toBe(expectedVisible(settings, due));
        for (const [typesToInclude] of h.anyDue.mock.calls) {
          expect(typesToInclude).toEqual(reminderTypes(settings));
        }
        expect(h.anyDue).toHaveBeenCalledTimes(
          settings.reviewReminders ? 1 : 0
        );
        h.reminder.dispose();
      })
    );
  });

  it('says it is ready for review with the plugin icon, never how many', async () => {
    const h = makeReminder({ due: new Set(['article', 'snippet', 'card']) });
    await advance();

    expect(h.el.textContent).toBe(REVIEW_REMINDER_TEXT);
    expect(REVIEW_REMINDER_TEXT).toBe('Ready for review');
    expect(
      h.el.querySelectorAll(
        '.status-bar-item-segment > .status-bar-item-icon > svg.lucide-book-open-text'
      )
    ).toHaveLength(1);
    expect(h.el.getAttribute('data-tooltip-position')).toBe('top');
    expect(h.el.classList.contains('mod-clickable')).toBe(true);
    expect(h.el.getAttribute('aria-label')).toBe('Open review');
  });

  it('opens review when clicked', async () => {
    const h = makeReminder({ due: new Set(['card']) });
    await advance();

    h.el
      .querySelector('svg')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(h.open).toHaveBeenCalledOnce();
  });

  it('follows a data change to what is due', async () => {
    const h = makeReminder();
    await advance();
    expect(isShown(h.el)).toBe(false);

    h.due.add('article');
    h.fireDataChange();
    await advance(CURRENT_ITEM_REFETCH_TIME);
    expect(isShown(h.el)).toBe(true);

    h.due.clear();
    h.fireDataChange();
    await advance(CURRENT_ITEM_REFETCH_TIME);
    expect(isShown(h.el)).toBe(false);
  });

  it('queries at most once per refetch interval, yet always within one after the last data change', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 * CURRENT_ITEM_REFETCH_TIME }), {
          maxLength: 15,
        }),
        async (gaps) => {
          const h = makeReminder();
          const times = h.queryTimes;
          const start = Date.now();
          await advance();
          /** Queries made by the time of the last change. */
          let queriedBeforeLast = 0;
          for (const gap of gaps) {
            await advance(gap);
            h.fireDataChange();
            queriedBeforeLast = times.length;
          }
          await advance(CURRENT_ITEM_REFETCH_TIME);

          for (let i = 1; i < times.length; i++) {
            expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(
              CURRENT_ITEM_REFETCH_TIME
            );
          }
          // The last change was read, by a query started after it
          if (gaps.length > 0) {
            expect(times.length).toBeGreaterThan(queriedBeforeLast);
          }
          // No query without a change or a poll to answer
          const polls = Math.floor(
            (Date.now() - start) / REVIEW_REMINDER_POLL_TIME
          );
          expect(times.length).toBeLessThanOrEqual(gaps.length + polls + 1);
          h.reminder.dispose();
        }
      )
    );
  });

  it('runs a burst of data changes as one query, once the refetch interval since the last query is out', async () => {
    const h = makeReminder();
    await advance();
    h.anyDue.mockClear();
    await advance(CURRENT_ITEM_REFETCH_TIME / 2);

    for (let i = 0; i < 5; i++) h.fireDataChange();
    await advance(CURRENT_ITEM_REFETCH_TIME / 2 - 1);
    expect(h.anyDue).not.toHaveBeenCalled();
    await advance(1);

    expect(h.anyDue).toHaveBeenCalledOnce();
  });

  it('counts a poll query as the last query, so a data change just after it waits out the refetch interval', async () => {
    const h = makeReminder();
    const times = h.queryTimes;
    await advance(REVIEW_REMINDER_POLL_TIME + 1);
    expect(times).toHaveLength(2);
    const pollQuery = times[1];

    h.fireDataChange();
    await advance(pollQuery + CURRENT_ITEM_REFETCH_TIME - Date.now() - 1);
    expect(times).toHaveLength(2);
    await advance(1);

    expect(times).toEqual([
      h.start,
      pollQuery,
      pollQuery + CURRENT_ITEM_REFETCH_TIME,
    ]);
  });

  it('checks again as time passes, for items that fall due on a new day', async () => {
    const h = makeReminder();
    await advance();
    h.due.add('card');

    await advance(REVIEW_REMINDER_POLL_TIME - 1);
    expect(isShown(h.el)).toBe(false);
    await advance(2);

    expect(isShown(h.el)).toBe(true);
    expect(h.anyDue).toHaveBeenCalledTimes(2);
  });

  it('hides at once when reminders are turned off, without asking the database', async () => {
    const h = makeReminder({ due: new Set(['card']) });
    await advance();
    expect(isShown(h.el)).toBe(true);

    h.changeSettings({ reviewReminders: false });

    expect(isShown(h.el)).toBe(false);
    expect(h.anyDue).toHaveBeenCalledOnce();
  });

  it('asks again at once when a reminder setting changes, without waiting out the minute', async () => {
    const h = makeReminder({
      settings: {
        reviewReminders: true,
        remindDueArticles: false,
        remindDueSnippets: true,
      },
      due: new Set(['article']),
    });
    await advance();
    expect(isShown(h.el)).toBe(false);

    h.changeSettings({ remindDueArticles: true });
    await advance();

    expect(isShown(h.el)).toBe(true);
    expect(h.anyDue).toHaveBeenCalledTimes(2);
  });

  it('keeps the latest answer when an earlier query finishes after it', async () => {
    const slow = deferred<boolean>();
    const h = makeReminder({
      due: new Set(['article']),
      firstAnswer: slow.promise,
    });
    await advance();

    h.changeSettings({ remindDueArticles: false });
    await advance();
    slow.resolve(true);
    await advance();

    expect(isShown(h.el)).toBe(false);
  });

  it('stays hidden when a query started before reminders were turned off finds something due', async () => {
    const slow = deferred<boolean>();
    const h = makeReminder({
      due: new Set(['card']),
      firstAnswer: slow.promise,
    });

    h.changeSettings({ reviewReminders: false });
    slow.resolve(true);
    await advance();

    expect(isShown(h.el)).toBe(false);
  });

  it('leaves the indicator as it was when a query fails', async () => {
    for (const shown of [false, true]) {
      const h = makeReminder({ due: new Set(shown ? ['card'] : []) });
      await advance();
      h.anyDue.mockRejectedValueOnce(new Error('no such table'));

      h.changeSettings({});
      await advance();

      expect(isShown(h.el)).toBe(shown);
      h.reminder.dispose();
    }
  });

  it('asks again on request, within the refetch interval', async () => {
    const h = makeReminder();
    await advance();
    h.due.add('snippet');

    h.reminder.refresh();
    await advance(CURRENT_ITEM_REFETCH_TIME);

    expect(isShown(h.el)).toBe(true);
    expect(h.anyDue).toHaveBeenCalledTimes(2);
  });

  it('removes the indicator and stops listening and querying once disposed', async () => {
    const slow = deferred<boolean>();
    const h = makeReminder({
      due: new Set(['card']),
      firstAnswer: slow.promise,
    });
    // A check waiting out the refetch interval
    h.fireDataChange();
    expect(vi.getTimerCount()).toBe(2);

    h.reminder.dispose();
    h.el.click();
    slow.resolve(true);
    h.fireDataChange();
    h.reminder.refresh();
    await advance(2 * REVIEW_REMINDER_POLL_TIME);

    expect(h.el.isConnected).toBe(false);
    expect(h.dataListeners.size).toBe(0);
    expect(h.settingsListeners.size).toBe(0);
    expect(h.anyDue).toHaveBeenCalledOnce();
    expect(h.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
