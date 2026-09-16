import type { QueuePage, QueueRow } from '#/components/types';
import { type QueryKey, QueryObserver } from '@tanstack/react-query';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOZE_DELIMITERS, MS_PER_DAY } from './constants';
import type ReviewManager from './items/ReviewManager';
import {
  applyQueueChange,
  currentItemQueryFn,
  currentItemQueryKey,
  getCurrentItemSync,
  queryClient,
  startItemCacheEviction,
} from './query-client';
import {
  addSeenId,
  resetSession,
  type ReviewPage,
  setCurrentItemId,
  setPage,
  store,
} from './store';
import type { NoteType, ReviewItem } from './types';

// #region HELPERS

function makeQueueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'a1',
    type: 'article',
    file: { path: 'articles/a1.md' } as TFile,
    due: new Date('2000-01-01T00:00:00Z'),
    reference: 'articles/a1.md',
    parent: null,
    scheduling: { kind: 'priority', value: '3' },
    ...overrides,
  };
}

/** A ReviewManager stub whose getQueueRow returns the queued map. */
function makeManager(resolved: Record<string, QueueRow | null>): ReviewManager {
  return {
    getQueueRow: vi.fn((id: string) =>
      Promise.resolve(id in resolved ? resolved[id] : null)
    ),
  } as unknown as ReviewManager;
}

/**
 * Seed a cached page. The queue's dated span defaults to unset, since these
 * tests are about how rows and totals are patched; the tests that care about
 * the span pass it explicitly.
 */
function seedQueue(
  key: unknown[],
  page: Omit<QueuePage, 'firstDue' | 'lastDue'> &
    Partial<Pick<QueuePage, 'firstDue' | 'lastDue'>>
) {
  queryClient.setQueryData<QueuePage>(key, {
    firstDue: null,
    lastDue: null,
    ...page,
  });
}

const QUEUE_KEY = ['queue', { slice: { pageNumber: 0, entriesPerPage: 10 } }];

function makeReviewItem(id: string): ReviewItem {
  return {
    data: { id, type: 'article' },
    file: { path: `articles/${id}.md` } as TFile,
  } as ReviewItem;
}

/** A ReviewManager stub whose queue holds exactly `item`, or nothing. */
function makeDueManager(item: ReviewItem | null): ReviewManager {
  const all = item ? [item] : [];
  return {
    getDue: vi.fn().mockResolvedValue({
      all,
      cards: [],
      snippets: [],
      articles: all,
    }),
  } as unknown as ReviewManager;
}

/** An item of any of the three types, under `id`. */
function makeTypedItem(id: string, type: NoteType): ReviewItem {
  return {
    data: { id, type },
    file: { path: `${type}s/${id}.md` } as TFile,
  } as ReviewItem;
}

/** What `getDue` resolves to for a queue holding exactly `item`, or nothing. */
function dueResult(item: ReviewItem | null) {
  const all = item ? [item] : [];
  return { all, cards: [], snippets: [], articles: all };
}

/** A promise held open until `resolve` is called, for pausing at an await. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A ReviewManager stub for an advance onto a card, holding the delimiter write
 * open: `writeStarted` settles once the write is under way, and the write
 * itself finishes when `finishWrite` is called.
 */
function makeCardWriteManager(card: ReviewItem) {
  const started = deferred<void>();
  const written = deferred<void>();
  const updateDelimiters = vi.fn(() => {
    started.resolve();
    return written.promise;
  });
  const manager = {
    getDue: vi.fn().mockResolvedValue(dueResult(card)),
    cards: { updateDelimiters },
  } as unknown as ReviewManager;
  return {
    manager,
    updateDelimiters,
    writeStarted: started.promise,
    finishWrite: () => written.resolve(),
  };
}

const noteTypeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

/** Two ids that are never equal — the cases about moving between items. */
const twoIdsArb = fc
  .tuple(fc.string(), fc.string())
  .filter(([a, b]) => a !== b);

/** An item review is on, and where it goes instead: another item, or none. */
const leaveArb = fc
  .tuple(fc.string(), fc.option(fc.string(), { nil: null }))
  .filter(([left, next]) => left !== next);

/** A clean cache and store, as at plugin load. */
function resetCacheAndStore() {
  queryClient.clear();
  store.dispatch(resetSession());
}

/** A watcher on `queryKey` that never fetches, standing in for a mounted hook. */
function watch(queryKey: QueryKey): () => void {
  return new QueryObserver(queryClient, { queryKey, enabled: false }).subscribe(
    () => {}
  );
}

const isCached = (queryKey: QueryKey) =>
  queryClient.getQueryCache().find({ queryKey, exact: true }) !== undefined;
// #endregion

describe('applyQueueChange', () => {
  afterEach(() => {
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it('replaces an updated row in place and keeps totalRows', async () => {
    seedQueue(QUEUE_KEY, {
      rows: [
        makeQueueRow({
          id: 'a1',
          scheduling: { kind: 'priority', value: '3' },
        }),
      ],
      totalRows: 1,
    });
    const updated = makeQueueRow({
      id: 'a1',
      scheduling: { kind: 'priority', value: '5' },
    });
    const manager = makeManager({ a1: updated });

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    const page = queryClient.getQueryData<QueuePage>(QUEUE_KEY);
    expect(page?.rows).toHaveLength(1);
    expect(page?.rows[0].scheduling.value).toBe('5');
    expect(page?.totalRows).toBe(1);
  });

  it('removes a row that has left the queue and decrements totalRows', async () => {
    seedQueue(QUEUE_KEY, {
      rows: [
        makeQueueRow({ id: 'a1' }),
        makeQueueRow({ id: 'a2', reference: 'articles/a2.md' }),
      ],
      totalRows: 2,
    });
    const manager = makeManager({ a1: null }); // a1 dismissed/deleted

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    const page = queryClient.getQueryData<QueuePage>(QUEUE_KEY);
    expect(page?.rows.map((r) => r.id)).toEqual(['a2']);
    expect(page?.totalRows).toBe(1);
  });

  it('leaves pages untouched when no displayed row matches the change', async () => {
    seedQueue(QUEUE_KEY, {
      rows: [makeQueueRow({ id: 'a1' })],
      totalRows: 1,
    });
    const getQueueRow = vi.fn();
    const manager = { getQueueRow } as unknown as ReviewManager;

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a99'] },
      manager
    );

    const page = queryClient.getQueryData<QueuePage>(QUEUE_KEY);
    expect(page?.rows.map((r) => r.id)).toEqual(['a1']);
    expect(page?.totalRows).toBe(1);
    // a99 is resolved (to reconcile) but no page is rewritten.
    expect(getQueueRow).toHaveBeenCalledWith('a99');
  });

  it('patches every cached page, not just the active one', async () => {
    const KEY_A = ['queue', { slice: { pageNumber: 0, entriesPerPage: 10 } }];
    const KEY_B = ['queue', { slice: { pageNumber: 1, entriesPerPage: 10 } }];
    seedQueue(KEY_A, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 20 });
    seedQueue(KEY_B, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 20 });
    const manager = makeManager({ a1: null });

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    expect(queryClient.getQueryData<QueuePage>(KEY_A)?.rows).toEqual([]);
    expect(queryClient.getQueryData<QueuePage>(KEY_B)?.rows).toEqual([]);
  });

  it('keeps the queue span when patching a page', async () => {
    // The span bounds the date field. This patch sees only cached pages, not
    // the whole queue, so it cannot recompute the extent — dropping it would
    // un-clamp the field until the next fetch, letting the user jump past the
    // end again. A slightly stale bound is the safe direction to err in.
    const firstDue = new Date(2026, 6, 10);
    const lastDue = new Date(2026, 8, 4);
    seedQueue(QUEUE_KEY, {
      rows: [
        makeQueueRow({ id: 'a1' }),
        makeQueueRow({ id: 'a2', reference: 'articles/a2.md' }),
      ],
      totalRows: 2,
      firstDue,
      lastDue,
    });
    const manager = makeManager({ a1: null });

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    const page = queryClient.getQueryData<QueuePage>(QUEUE_KEY);
    expect(page?.rows.map((r) => r.id)).toEqual(['a2']);
    expect(page?.firstDue).toEqual(firstDue);
    expect(page?.lastDue).toEqual(lastDue);
  });

  it('invalidates the queue so order and totals reconcile', async () => {
    seedQueue(QUEUE_KEY, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 1 });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const manager = makeManager({ a1: makeQueueRow({ id: 'a1' }) });

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    expect(spy).toHaveBeenCalledWith({
      queryKey: ['queue'],
      refetchType: 'all',
    });
  });

  it('invalidates without patching on insert (position unknown)', async () => {
    seedQueue(QUEUE_KEY, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 1 });
    const getQueueRow = vi.fn();
    const manager = { getQueueRow } as unknown as ReviewManager;
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await applyQueueChange(
      { table: 'article', op: 'insert', ids: ['a2'] },
      manager
    );

    expect(getQueueRow).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['queue'],
      refetchType: 'all',
    });
  });
});

describe('getCurrentItemSync', () => {
  afterEach(() => {
    queryClient.clear();
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it('reads the entry belonging to the id the store names', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        queryClient.clear();
        const item = makeReviewItem(id);
        queryClient.setQueryData(currentItemQueryKey(id), item);
        store.dispatch(setCurrentItemId(id));

        expect(getCurrentItemSync()).toBe(item);
      })
    );
  });

  it('finds nothing once the store has moved to another item', () => {
    // The commands this feeds act on whatever it returns — dismiss, skip, grade
    // — so serving the outgoing item's cache entry would aim them at the item
    // the user has just navigated away from. Every one of them treats an absent
    // item as "not applicable", which is the right answer for a moment when
    // review is not settled on anything.
    fc.assert(
      fc.property(twoIdsArb, ([cachedId, pickedId]) => {
        queryClient.clear();
        queryClient.setQueryData(
          currentItemQueryKey(cachedId),
          makeReviewItem(cachedId)
        );
        store.dispatch(setCurrentItemId(pickedId));

        expect(getCurrentItemSync()).toBeUndefined();
      })
    );
  });

  it('finds nothing while review is between items', () => {
    // A null id is the window an advance opens, and the entry under that key is
    // the item it has just finished with — the one case where a cache hit is
    // exactly the wrong answer.
    const item = makeReviewItem('finished');
    queryClient.setQueryData(currentItemQueryKey(null), item);
    store.dispatch(setCurrentItemId(null));

    expect(getCurrentItemSync()).toBeUndefined();
  });
});

describe('currentItemQueryFn', () => {
  afterEach(() => {
    queryClient.clear();
    store.dispatch(resetSession());
    vi.restoreAllMocks();
  });

  it('resolves the id it was handed, not the one the store holds', async () => {
    // The id comes in as an argument so this stays a function of the key it is
    // fetching for. Were it read off the store, a fetch started for one item
    // could finish after the user picked another and write that other item's
    // data into this item's cache entry.
    await fc.assert(
      fc.asyncProperty(twoIdsArb, async ([keyedId, storeId]) => {
        const item = makeReviewItem(keyedId);
        const getReviewItemFromId = vi.fn().mockResolvedValue(item);
        store.dispatch(setCurrentItemId(storeId));

        const resolved = await currentItemQueryFn(
          { getReviewItemFromId } as unknown as ReviewManager,
          keyedId
        );

        expect(resolved).toBe(item);
        expect(getReviewItemFromId).toHaveBeenCalledWith(keyedId);
      })
    );
  });

  it('caches the advanced-to item under its own key', async () => {
    // The advance names the next item and moves the store onto it in one go, so
    // without this seed the view lands on a key it has nothing for and refetches
    // what was just read — a second spinner for an item already in hand.
    const item = makeReviewItem('next-1');

    const resolved = await currentItemQueryFn(makeDueManager(item), null);

    expect(resolved).toBe(item);
    expect(store.getState().currentItemId).toBe('next-1');
    expect(queryClient.getQueryData(currentItemQueryKey('next-1'))).toBe(item);
  });

  it('advances past items already seen this session', async () => {
    // Skipped items stay due, so the queue hands them back; the advance has to
    // pass over them to the first one this session has not shown yet. Ids are
    // UUIDs because that is all the item managers ever mint.
    const queueArb = fc.uniqueArray(fc.tuple(fc.uuid(), fc.boolean()), {
      selector: ([id]) => id,
      minLength: 1,
      maxLength: 5,
    });
    await fc.assert(
      fc.asyncProperty(queueArb, async (queue) => {
        resetCacheAndStore();
        const resetTime = Date.now() + MS_PER_DAY;
        for (const [id, seen] of queue) {
          if (seen) store.dispatch(addSeenId({ id, resetTime }));
        }
        const due = queue.map(([id]) => makeReviewItem(id));
        const getDue = vi
          .fn()
          .mockResolvedValue({
            all: due,
            cards: [],
            snippets: [],
            articles: due,
          });

        const resolved = await currentItemQueryFn(
          { getDue } as unknown as ReviewManager,
          null
        );

        const firstUnseen = due.find((_, i) => !queue[i][1]) ?? null;
        expect(resolved).toBe(firstUnseen);
        expect(store.getState().currentItemId).toBe(
          firstUnseen?.data.id ?? null
        );
      })
    );
  });

  it('leaves the store empty-handed when the queue is exhausted', async () => {
    // The other end of the advance, and what tells an empty queue apart from one
    // still being resolved: a null id with a resolved null beside it.
    const resolved = await currentItemQueryFn(makeDueManager(null), null);

    expect(resolved).toBeNull();
    expect(store.getState().currentItemId).toBeNull();
  });

  it('asks the queue to pass over items already seen this session', async () => {
    // The queue reads one item at a time (`getDue`'s default limit), so a seen
    // item it is not told to exclude comes back in place of the unseen ones
    // behind it, and dropping it afterwards leaves nothing: an exhausted queue
    // with items still due.
    const queueArb = fc.uniqueArray(fc.tuple(fc.uuid(), fc.boolean()), {
      selector: ([id]) => id,
      minLength: 1,
      maxLength: 5,
    });
    await fc.assert(
      fc.asyncProperty(queueArb, async (queue) => {
        resetCacheAndStore();
        const resetTime = Date.now() + MS_PER_DAY;
        for (const [id, seen] of queue) {
          if (seen) store.dispatch(addSeenId({ id, resetTime }));
        }
        const due = queue.map(([id]) => makeReviewItem(id));
        const getDue = vi.fn(({ excludeIds = [] }: { excludeIds?: string[] }) =>
          Promise.resolve(
            dueResult(
              due.find((item) => !excludeIds.includes(item.data.id)) ?? null
            )
          )
        );

        const resolved = await currentItemQueryFn(
          { getDue } as unknown as ReviewManager,
          null
        );

        const firstUnseen = due.find((_, i) => !queue[i][1]) ?? null;
        expect(resolved).toBe(firstUnseen);
        expect(store.getState().currentItemId).toBe(
          firstUnseen?.data.id ?? null
        );
      })
    );
  });

  it('leaves review on an item picked while the queue was being read', async () => {
    // Back, forward, the queue table and `learn` all pick an item without
    // waiting for an advance in flight. The pick is the user's; the advance
    // finishing after it must neither move review off it nor seed entries for
    // an item review is not going to.
    const nextArb = fc.option(
      fc
        .tuple(fc.string(), noteTypeArb)
        .map(([id, type]) => makeTypedItem(id, type)),
      { nil: null }
    );
    await fc.assert(
      fc.asyncProperty(nextArb, fc.string(), async (next, pickedId) => {
        resetCacheAndStore();
        const due = deferred<ReturnType<typeof dueResult>>();
        const updateDelimiters = vi.fn(async () => {});
        const manager = {
          getDue: vi.fn(() => due.promise),
          cards: { updateDelimiters },
        } as unknown as ReviewManager;

        const advance = currentItemQueryFn(manager, null);
        store.dispatch(setCurrentItemId(pickedId));
        const dispatch = vi.spyOn(store, 'dispatch');
        try {
          due.resolve(dueResult(next));

          expect(await advance).toBe(next);
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          dispatch.mockRestore();
        }
        expect(store.getState().currentItemId).toBe(pickedId);
        expect(updateDelimiters).not.toHaveBeenCalled();
        if (next) {
          expect(
            queryClient.getQueryData(['item', next.data.id])
          ).toBeUndefined();
          expect(
            queryClient.getQueryData(currentItemQueryKey(next.data.id))
          ).toBeUndefined();
        }
      })
    );
  });

  it("leaves review on an item picked while a card's delimiters were written", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (cardId, pickedId) => {
        resetCacheAndStore();
        const card = makeTypedItem(cardId, 'card');
        const { manager, writeStarted, finishWrite } =
          makeCardWriteManager(card);

        const advance = currentItemQueryFn(manager, null);
        await writeStarted;
        store.dispatch(setCurrentItemId(pickedId));
        const dispatch = vi.spyOn(store, 'dispatch');
        try {
          finishWrite();

          expect(await advance).toBe(card);
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          dispatch.mockRestore();
        }
        expect(store.getState().currentItemId).toBe(pickedId);
        // Nothing seeded for a card review is not going to: eviction only
        // drops items review has left, so a seed would sit in the cache.
        expect(isCached(['item', cardId])).toBe(false);
        expect(isCached(currentItemQueryKey(cardId))).toBe(false);
      })
    );
  });

  it('hands a card to review once its delimiters are written', async () => {
    // Review only moves onto the card after the write, so the card is never
    // on screen with the delimiters it had before.
    await fc.assert(
      fc.asyncProperty(fc.string(), async (cardId) => {
        resetCacheAndStore();
        const card = makeTypedItem(cardId, 'card');
        const { manager, updateDelimiters, writeStarted, finishWrite } =
          makeCardWriteManager(card);

        const advance = currentItemQueryFn(manager, null);
        await writeStarted;

        expect(updateDelimiters).toHaveBeenCalledWith(card, CLOZE_DELIMITERS);
        expect(store.getState().currentItemId).toBeNull();

        finishWrite();

        expect(await advance).toBe(card);
        expect(store.getState().currentItemId).toBe(cardId);
        expect(queryClient.getQueryData(currentItemQueryKey(cardId))).toBe(
          card
        );
        expect(queryClient.getQueryData(['item', cardId])).toBe(card);
      })
    );
  });

  it('writes no delimiters for an article or a snippet', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.constantFrom<NoteType>('article', 'snippet'),
        async (id, type) => {
          resetCacheAndStore();
          const item = makeTypedItem(id, type);
          const updateDelimiters = vi.fn(async () => {});
          const manager = {
            getDue: vi.fn().mockResolvedValue(dueResult(item)),
            cards: { updateDelimiters },
          } as unknown as ReviewManager;

          expect(await currentItemQueryFn(manager, null)).toBe(item);
          expect(updateDelimiters).not.toHaveBeenCalled();
          expect(store.getState().currentItemId).toBe(id);
        }
      )
    );
  });
});

describe('startItemCacheEviction', () => {
  afterEach(() => {
    resetCacheAndStore();
    vi.restoreAllMocks();
  });

  it("drops an item's entries exactly when review moves off it", () => {
    // Modelled over whole sessions rather than single moves, because what it
    // must get right is the history: an item left once and then come back to
    // has still been left, an item never left keeps its entries through any
    // number of moves among the others, and a dispatch that leaves the id
    // where it was — the same id again, or another slice changing — is no
    // move at all. The `null` entry is the advance's, not an item's, and is
    // never dropped.
    const moveArb = (ids: string[]) =>
      fc.oneof(
        fc.record({ to: fc.option(fc.constantFrom(...ids), { nil: null }) }),
        fc.record({ page: fc.constantFrom<ReviewPage>('home', 'review') })
      );
    const sessionArb = fc
      .uniqueArray(fc.string(), { minLength: 1, maxLength: 4 })
      .chain((ids) =>
        fc.record({
          ids: fc.constant(ids),
          shownAtStart: fc.option(fc.constantFrom(...ids), { nil: null }),
          moves: fc.array(moveArb(ids), { maxLength: 10 }),
          subKey: fc.array(fc.jsonValue(), { maxLength: 3 }),
        })
      );

    fc.assert(
      fc.property(sessionArb, ({ ids, shownAtStart, moves, subKey }) => {
        resetCacheAndStore();
        store.dispatch(setCurrentItemId(shownAtStart));
        const keysOf = (id: string): QueryKey[] => [
          currentItemQueryKey(id),
          ['item', id],
          ['item', id, ...subKey],
        ];
        for (const id of ids) {
          for (const key of keysOf(id)) queryClient.setQueryData(key, id);
        }
        queryClient.setQueryData(currentItemQueryKey(null), 'advance');

        const left = new Set<string>();
        let shown = shownAtStart;
        const stop = startItemCacheEviction();
        try {
          for (const move of moves) {
            if ('page' in move) {
              store.dispatch(setPage(move.page));
              continue;
            }
            store.dispatch(setCurrentItemId(move.to));
            if (shown !== null && shown !== move.to) left.add(shown);
            shown = move.to;
          }
          // Nothing here was watched or fetching, so nothing is left waiting.
          expect(queryClient.getQueryCache().hasListeners()).toBe(false);
        } finally {
          stop();
        }

        for (const id of ids) {
          for (const key of keysOf(id)) {
            expect(queryClient.getQueryData(key)).toBe(
              left.has(id) ? undefined : id
            );
          }
        }
        expect(queryClient.getQueryData(currentItemQueryKey(null))).toBe(
          'advance'
        );
      })
    );
  });

  it('keeps what an advance cached for the item it moves review onto', async () => {
    // The advance seeds the next item's entries and then moves the store onto
    // it. Whatever review was on before is left, but the item it arrives at
    // is not, so the seed has to be there when the view lands on it.
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.option(fc.string(), { nil: null }),
        async (nextId, shownBefore) => {
          fc.pre(nextId !== shownBefore);
          resetCacheAndStore();
          store.dispatch(setCurrentItemId(shownBefore));
          const next = makeReviewItem(nextId);
          const stop = startItemCacheEviction();
          try {
            // Review leaves the item before asking for the next, as `getNext`
            // does: an advance only moves a review that is waiting for one.
            store.dispatch(setCurrentItemId(null));
            await currentItemQueryFn(makeDueManager(next), null);
          } finally {
            stop();
          }

          expect(queryClient.getQueryData(currentItemQueryKey(nextId))).toBe(
            next
          );
          expect(queryClient.getQueryData(['item', nextId])).toBe(next);
        }
      )
    );
  });

  it("waits for a left item's last watcher to let go before dropping it", () => {
    // Review's hooks are still watching the item they have just left until
    // they re-render onto the next one. Removing the entry under them would
    // strand them on a query the cache no longer holds.
    fc.assert(
      fc.property(
        leaveArb,
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        ([leftId, nextId], watcherCount, watchText) => {
          resetCacheAndStore();
          store.dispatch(setCurrentItemId(leftId));
          const key = watchText
            ? ['item', leftId, 'file-text']
            : currentItemQueryKey(leftId);
          queryClient.setQueryData(key, 'cached');
          const unwatches = Array.from({ length: watcherCount }, () =>
            watch(key)
          );
          const stop = startItemCacheEviction();
          try {
            store.dispatch(setCurrentItemId(nextId));
            for (const unwatch of unwatches) {
              expect(isCached(key)).toBe(true);
              unwatch();
            }

            expect(isCached(key)).toBe(false);
            expect(queryClient.getQueryCache().hasListeners()).toBe(false);
          } finally {
            stop();
          }
        }
      )
    );
  });

  it('goes on waiting while other entries come and go', () => {
    // The cache reports every entry's changes to every listener; a wait has to
    // tell its own entry's release apart from any other entry being removed.
    fc.assert(
      fc.property(
        leaveArb,
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 3 }),
        ([leftId, nextId], otherKey) => {
          const key = currentItemQueryKey(leftId);
          fc.pre(JSON.stringify(otherKey) !== JSON.stringify(key));
          resetCacheAndStore();
          store.dispatch(setCurrentItemId(leftId));
          queryClient.setQueryData(key, 'cached');
          const unwatch = watch(key);
          const stop = startItemCacheEviction();
          try {
            store.dispatch(setCurrentItemId(nextId));
            queryClient.setQueryData(otherKey, 'other');
            queryClient.removeQueries({ queryKey: otherKey, exact: true });
            unwatch();

            expect(isCached(key)).toBe(false);
          } finally {
            stop();
          }
        }
      )
    );
  });

  it('lets a fetch running on a left item finish before dropping it', async () => {
    // Removing a query cancels its fetch, and whoever is awaiting that fetch
    // through `fetchQuery` is rejected with the cancellation instead of its
    // result — `setCardsOnly` would never get as far as applying its toggle.
    await fc.assert(
      fc.asyncProperty(leaveArb, fc.boolean(), async ([leftId, nextId], ok) => {
        resetCacheAndStore();
        store.dispatch(setCurrentItemId(leftId));
        const outcome = ok ? makeReviewItem(leftId) : new Error('read failed');
        let settle = () => {};
        const stop = startItemCacheEviction();
        try {
          const fetched = queryClient
            .fetchQuery({
              queryKey: currentItemQueryKey(leftId),
              queryFn: () =>
                new Promise<ReviewItem>((resolve, reject) => {
                  settle = () =>
                    ok
                      ? resolve(outcome as ReviewItem)
                      : reject(outcome as Error);
                }),
            })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error })
            );

          store.dispatch(setCurrentItemId(nextId));
          expect(isCached(currentItemQueryKey(leftId))).toBe(true);
          settle();

          expect(await fetched).toEqual(
            ok ? { value: outcome } : { error: outcome }
          );
          expect(isCached(currentItemQueryKey(leftId))).toBe(false);
          expect(queryClient.getQueryCache().hasListeners()).toBe(false);
        } finally {
          stop();
        }
      })
    );
  });

  it('keeps an entry review comes back to before it was let go', () => {
    fc.assert(
      fc.property(leaveArb, ([leftId, nextId]) => {
        resetCacheAndStore();
        store.dispatch(setCurrentItemId(leftId));
        const key = currentItemQueryKey(leftId);
        queryClient.setQueryData(key, 'cached');
        const unwatch = watch(key);
        const stop = startItemCacheEviction();
        try {
          store.dispatch(setCurrentItemId(nextId));
          store.dispatch(setCurrentItemId(leftId));
          unwatch();

          expect(queryClient.getQueryData(key)).toBe('cached');
          expect(queryClient.getQueryCache().hasListeners()).toBe(false);
        } finally {
          stop();
        }
      })
    );
  });

  it('stops waiting on an entry once something else removes it', () => {
    fc.assert(
      fc.property(leaveArb, ([leftId, nextId]) => {
        resetCacheAndStore();
        store.dispatch(setCurrentItemId(leftId));
        const key = currentItemQueryKey(leftId);
        queryClient.setQueryData(key, 'cached');
        const unwatch = watch(key);
        const stop = startItemCacheEviction();
        try {
          store.dispatch(setCurrentItemId(nextId));
          queryClient.removeQueries({ queryKey: key, exact: true });

          expect(queryClient.getQueryCache().hasListeners()).toBe(false);
        } finally {
          unwatch();
          stop();
        }
      })
    );
  });

  it('drops nothing, now or pending, once cleaned up', () => {
    // Cleanup runs on plugin unload, and the review view's teardown empties the
    // store after it: nothing it does on the way out should touch the cache.
    fc.assert(
      fc.property(leaveArb, fc.string(), ([leftId, nextId], watchedId) => {
        fc.pre(watchedId !== nextId && watchedId !== leftId);
        resetCacheAndStore();
        store.dispatch(setCurrentItemId(watchedId));
        const watchedKey = currentItemQueryKey(watchedId);
        const leftKey = currentItemQueryKey(leftId);
        queryClient.setQueryData(watchedKey, 'watched');
        queryClient.setQueryData(leftKey, 'left');
        const unwatch = watch(watchedKey);
        const stop = startItemCacheEviction();

        store.dispatch(setCurrentItemId(nextId));
        stop();
        expect(queryClient.getQueryCache().hasListeners()).toBe(false);
        unwatch();
        store.dispatch(setCurrentItemId(leftId));
        store.dispatch(setCurrentItemId(nextId));

        expect(queryClient.getQueryData(watchedKey)).toBe('watched');
        expect(queryClient.getQueryData(leftKey)).toBe('left');
      })
    );
  });
});
