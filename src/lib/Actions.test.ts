import { Actions } from '#/lib/Actions';
import { CONTENT_TITLE_SLICE_LENGTH } from '#/lib/constants';
import {
  addCompletedReview,
  removeCompletedReview,
  resetCurrentItem,
  setCurrentItemId,
  store,
} from '#/lib/store';
import type { NoteType, ReviewCard, ReviewItem, ReviewText } from '#/lib/types';
import { getEndOfDay } from '#/lib/utils';
import IncrementalReadingPlugin from '#/main';
import fc from 'fast-check';
// The Vitest alias points `obsidian` at this same file, so the class imported
// here is the one `ObsidianHelpers.notify` constructs — importing it by path is
// what gives TS the mock's `messages`/`reset`, which the real class lacks.
import { Notice } from '#/test/__mocks__/obsidian';
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#/lib/query-client', () => ({
  invalidateItemQuery: vi.fn().mockResolvedValue(undefined),
  invalidateCurrentItemQuery: vi.fn().mockResolvedValue(undefined),
  fetchCurrentItem: vi.fn().mockResolvedValue(null),
}));

// #region HELPERS

function makeTFile(basename: string, path?: string): TFile {
  return {
    path: path ?? `incremental-reading/articles/${basename}.md`,
    basename,
    name: `${basename}.md`,
    extension: 'md',
  } as unknown as TFile;
}

function makePlugin() {
  return {
    store: { dispatch: vi.fn() },
    settings: { dayRolloverOffset: 4 },
    reviewManager: {
      dismissItem: vi.fn().mockResolvedValue(undefined),
      unDismissItem: vi.fn().mockResolvedValue(undefined),
    },
    app: {
      workspace: {
        activeEditor: null,
        getActiveViewOfType: vi.fn().mockReturnValue(null),
      },
    },
  } as unknown as IncrementalReadingPlugin;
}

function makeReviewItem(basename: string, pathOverride?: string): ReviewItem {
  return {
    data: {
      id: 'item-1',
      type: 'article',
      reference: pathOverride ?? `incremental-reading/articles/${basename}.md`,
      due: Date.now(),
      dismissed: false,
      deleted: false,
    },
    file: makeTFile(basename, pathOverride),
  } as unknown as ReviewItem;
}

/**
 * A plugin whose review writes all resolve to `reviewId`, and whose reversals
 * of them all run `reverse` — enough to follow what the review actions tell the
 * store without a database behind them.
 */
function makeReviewingPlugin({
  reviewId,
  dayRolloverOffset,
  reverse = vi.fn().mockResolvedValue(undefined),
}: {
  reviewId: string;
  dayRolloverOffset: number;
  reverse?: () => Promise<void>;
}) {
  return {
    store: { dispatch: vi.fn() },
    settings: { dayRolloverOffset },
    reviewManager: {
      reviewArticle: vi.fn().mockResolvedValue(reviewId),
      reviewSnippet: vi.fn().mockResolvedValue(reviewId),
      reviewCard: vi.fn().mockResolvedValue(reviewId),
      dismissItem: vi.fn().mockResolvedValue(undefined),
      unDismissItem: vi.fn().mockResolvedValue(undefined),
      articles: { undoReview: reverse },
      snippets: { undoReview: reverse },
      cards: { rollbackBeforeReview: reverse },
    },
    app: {
      workspace: {
        activeEditor: null,
        getActiveViewOfType: vi.fn().mockReturnValue(null),
      },
    },
  } as unknown as IncrementalReadingPlugin & {
    store: { dispatch: ReturnType<typeof vi.fn> };
  };
}

function makeTypedItem<T extends ReviewItem>(
  type: NoteType,
  { id, dismissed }: { id: string; dismissed: boolean }
): T {
  return {
    data: { id, type, dismissed, reference: `${id}.md` },
    file: makeTFile(id),
  } as unknown as T;
}

/** Everything handed to `store.dispatch`, in order. */
function dispatched(plugin: { store: { dispatch: ReturnType<typeof vi.fn> } }) {
  return plugin.store.dispatch.mock.calls.map(([action]) => action as unknown);
}

/**
 * Review the item the way the action bar does, whichever kind it is: a text is
 * marked reviewed, a card graded.
 */
async function reviewWith(
  actions: Actions,
  item: ReviewItem,
  { grade, nextInterval }: { grade: 1 | 2 | 3 | 4; nextInterval?: number }
) {
  if (item.data.type === 'card') {
    await actions.gradeCard(item as ReviewCard, grade);
  } else {
    await actions.review(item as ReviewText, nextInterval);
  }
}

const noteTypeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

/** Clock readings whose end of day still fits in a `Date`. */
const nowArb = fc.integer({ min: 0, max: 8_639_000_000_000_000 });

/** Every rollover offset the setting could be saved with, and then some. */
const rolloverOffsetArb = fc.integer({ min: -48, max: 48 });

const reviewCaseArb = fc.record({
  type: noteTypeArb,
  reviewId: fc.string(),
  itemId: fc.string(),
  dismissed: fc.boolean(),
  currentItemId: fc.option(fc.string(), { nil: null }),
  dayRolloverOffset: rolloverOffsetArb,
  now: nowArb,
  grade: fc.constantFrom<1 | 2 | 3 | 4>(1, 2, 3, 4),
  nextInterval: fc.option(fc.integer({ min: 1 }), { nil: undefined }),
});

type ReviewCase =
  typeof reviewCaseArb extends fc.Arbitrary<infer T> ? T : never;

/** Put the case's clock and current item in place, and return its plugin. */
function wireCase(c: ReviewCase, reverse?: () => Promise<void>) {
  Notice.reset();
  vi.restoreAllMocks();
  vi.setSystemTime(c.now);
  vi.spyOn(store, 'getState').mockReturnValue({
    currentItemId: c.currentItemId,
  } as never);
  const plugin = makeReviewingPlugin({
    reviewId: c.reviewId,
    dayRolloverOffset: c.dayRolloverOffset,
    reverse,
  });
  const item = makeTypedItem(c.type, {
    id: c.itemId,
    dismissed: c.dismissed,
  });
  return { plugin, item, actions: new Actions(plugin) };
}

// #endregion

describe('Actions.skipItem — Notice message', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', () => {
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('my-article');
  });

  it('Notice names the skipped item and nothing more', () => {
    // A skip lasts until rollover or a restart, which no short phrase states
    // accurately, so the notice makes no promise about when the item returns.
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem('my-article'));
    expect(Notice.messages).toEqual(['Skipping my-article']);
  });

  it('does not leak folder name from multi-segment path into Notice', () => {
    // Regression: reference.split('/')[1] → folder name ('articles'), not file
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    actions.skipItem(item);
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
    expect(message).not.toContain('subfolder');
  });

  it('truncates long basename with ellipsis', () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem(longName));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('...');
  });

  it('does not truncate a name at exactly CONTENT_TITLE_SLICE_LENGTH + 5 characters', () => {
    // Kills ArithmeticOperator mutant: +5 → -5 (a 55-char name is truncated at 45 but not at 55)
    const name = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 5);
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem(name));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).not.toContain('...');
  });
});

describe('Actions.dismissItem — Notice message', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', async () => {
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('my-article');
  });

  it('Notice matches Dismissed "..." format', async () => {
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toMatch(/^Dismissed ".*"$/);
  });

  it('does not leak folder name from multi-segment path into Notice', async () => {
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    await actions.dismissItem(item);
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
  });

  it('truncates long basename with ellipsis', async () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem(longName));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('...');
  });
});

describe('Actions.unDismissItem — Notice message', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', async () => {
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('my-article');
  });

  it('Notice contains "to queue"', async () => {
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('to queue');
  });

  it('Notice matches Restored "..." to queue format', async () => {
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toMatch(/^Restored ".*" to queue$/);
  });

  it('does not leak folder name from multi-segment path into Notice', async () => {
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(item);
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
  });

  it('truncates long basename with ellipsis', async () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem(longName));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('...');
  });
});

describe('Actions.skipItem — dispatch', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches addSeenId and resets current item (store.dispatch called twice)', () => {
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    actions.skipItem(makeReviewItem('my-article'));
    // skipItem calls dispatch(addSeenId) directly, then getNext() calls dispatch(resetCurrentItem)
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('Actions.dismissItem — dispatch', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls store.dispatch (getNext) when the dismissed item is the current item', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'item-1',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.dismissItem(makeReviewItem('my-article')); // item id is 'item-1'
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not call store.dispatch when the dismissed item is not the current item', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'other-item',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.dismissItem(makeReviewItem('my-article')); // item id 'item-1' !== 'other-item'
    expect(plugin.store.dispatch).not.toHaveBeenCalled();
  });
});

describe('Actions.unDismissItem — dispatch', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls store.dispatch (getNext) when currentItemId is null', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not call store.dispatch when currentItemId is not null', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'some-item',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(plugin.store.dispatch).not.toHaveBeenCalled();
  });
});

describe('Actions — undo stack notifications', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifies subscribers when a skip is recorded', () => {
    // Regression: the stack was pushed to directly, so subscribers heard
    // nothing and the undo button kept showing the action before it.
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    actions.subscribe(listener);

    actions.skipItem(makeReviewItem('my-article'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when a dismissal is recorded', async () => {
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    actions.subscribe(listener);

    await actions.dismissItem(makeReviewItem('my-article'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when an action is undone', async () => {
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem('my-article'));
    const listener = vi.fn();
    actions.subscribe(listener);

    await actions.undo();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when there is nothing to undo', async () => {
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    actions.subscribe(listener);

    await actions.undo();

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies even when the reversal itself throws', async () => {
    // The entry is already off the stack by then, so subscribers must not be
    // left reading an entry that is no longer there.
    const actions = new Actions(makePlugin());
    actions.pushUndo({
      item: makeReviewItem('my-article'),
      description: 'doing something reversible',
      undo: () => {
        throw new Error('reversal failed');
      },
    });
    const listener = vi.fn();
    actions.subscribe(listener);

    await expect(actions.undo()).rejects.toThrow('reversal failed');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    const unsubscribe = actions.subscribe(listener);

    unsubscribe();
    actions.skipItem(makeReviewItem('my-article'));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('Actions.getNext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the session tracker the item is finished', () => {
    // The tracker cannot read "finished" off the store, and the close that
    // races this one is indistinguishable there — see `SessionTracker.finish`.
    const plugin = makePlugin();
    const finish = vi.fn();
    Object.assign(plugin, { sessionTracker: { finish } });
    const actions = new Actions(plugin);

    actions.getNext();

    expect(finish).toHaveBeenCalledTimes(1);
    expect(plugin.store.dispatch).toHaveBeenCalled();
  });

  it('still advances when no session tracker is running', () => {
    // `onload` wires the tracker up after the review manager, so an action can
    // land before it exists.
    const plugin = makePlugin();
    const actions = new Actions(plugin);

    expect(() => actions.getNext()).not.toThrow();
    expect(plugin.store.dispatch).toHaveBeenCalled();
  });
});

describe('Actions — completed reviews', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts each review under its type, stamped with the end of the day, before advancing', async () => {
    // Advancing past the last item due is what brings up the summary, so the
    // review has to be in the store by then or the summary misses it.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);

        await reviewWith(actions, item, c);

        const actionsSent = dispatched(plugin);
        const recorded = actionsSent.filter((a) =>
          addCompletedReview.match(a as never)
        );
        expect(recorded).toEqual([
          addCompletedReview({
            reviewId: c.reviewId,
            type: c.type,
            resetTime: getEndOfDay(c.dayRolloverOffset),
          }),
        ]);
        const advance = actionsSent.findIndex((a) =>
          resetCurrentItem.match(a as never)
        );
        expect(advance).toBeGreaterThan(actionsSent.indexOf(recorded[0]));
      })
    );
  });

  it('takes back the review it counted once that review is undone', async () => {
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await actions.undo();

        const removed = dispatched(plugin).filter((a) =>
          removeCompletedReview.match(a as never)
        );
        expect(removed).toEqual([
          removeCompletedReview({ reviewId: c.reviewId }),
        ]);
      })
    );
  });

  it('keeps counting a review whose reversal failed', async () => {
    // The review is still in the database, so it still happened.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const failure = new Error('reversal failed');
        const { plugin, item, actions } = wireCase(
          c,
          vi.fn().mockRejectedValue(failure)
        );
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await expect(actions.undo()).rejects.toBe(failure);

        expect(
          dispatched(plugin).some((a) =>
            removeCompletedReview.match(a as never)
          )
        ).toBe(false);
      })
    );
  });
});

describe('Actions — undo of a review', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts review back on the item whose review it reverses, from wherever review has got to', async () => {
    // Including the completion screen, where the store already holds no item:
    // asking the queue for the next one dispatches nothing that changes there,
    // so the summary stayed up until the refetch interval happened to pick the
    // item back up.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await actions.undo();

        const sent = dispatched(plugin);
        const arrival = sent.findIndex((a) =>
          setCurrentItemId.match(a as never)
        );
        expect(sent[arrival]).toEqual(setCurrentItemId(c.itemId));
        // Preceded by the reset, which drops the per-item state on the way in
        // the way arriving from the queue does — a card's answer goes back to
        // hidden; and last, so nothing takes review off the item again.
        expect(sent[arrival - 1]).toEqual(resetCurrentItem());
        expect(sent.slice(arrival + 1)).toEqual([]);
      })
    );
  });

  it('leaves review where it is when the reversal fails', async () => {
    // The review is still in the database, so the item's turn has not come
    // back and review must not go to it.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const failure = new Error('reversal failed');
        const { plugin, item, actions } = wireCase(
          c,
          vi.fn().mockRejectedValue(failure)
        );
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await expect(actions.undo()).rejects.toBe(failure);

        expect(
          dispatched(plugin).some((a) => setCurrentItemId.match(a as never))
        ).toBe(false);
      })
    );
  });
});
