// @vitest-environment jsdom
import * as ReviewContext from '#/components/ReviewContext';
import { CURRENT_ITEM_REFETCH_TIME } from '#/lib/constants';
import type ReviewManager from '#/lib/items/ReviewManager';
import { queryClient } from '#/lib/query-client';
import { resetSession, store } from '#/lib/store';
import {
  NOTE_TYPES,
  type MaybeMissingItem,
  type NoteType,
  type ReviewItem,
} from '#/lib/types';
import type * as ReactQueryModule from '@tanstack/react-query';
import {
  QueryClientProvider,
  type UseQueryOptions,
} from '@tanstack/react-query';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useCardsDueLaterToday,
  useCurrentItem,
  useCurrentItemFileText,
  useQueue,
  useReviewItems,
} from './useReactQuery';

// #region HELPERS

type QueryResult = {
  data: unknown;
  isLoading: boolean;
  isError?: boolean;
  /** Whether a fetch has settled since the hook took up the key. */
  isFetchedAfterMount?: boolean;
};

/**
 * What react-query has cached, keyed the way react-query keys it: by the whole
 * query key, not by its first segment. Modelling the key faithfully is the
 * point — the hook's job is to ask under a key that cannot reach another item's
 * data, and a lookup that ignored the key could not tell whether it did.
 */
let cache = new Map<string, QueryResult>();
/** Every options object the hook handed to `useQuery`, in call order. */
let optionsSeen: UseQueryOptions[] = [];

const keyOf = (queryKey: unknown) => JSON.stringify(queryKey);

/** What react-query answers for a key it has nothing for: a fetch in flight. */
const MISS: QueryResult = {
  data: undefined,
  isLoading: true,
  isError: false,
  isFetchedAfterMount: false,
};

// react-query is mocked rather than spied on so the two queries this hook
// chains can be driven independently: the point of the hook is how it combines
// them, and a real client would make their timing the test's subject instead.
//
// Partial, because `QueryClient` is constructed at import time further down the
// hook's dependency chain (query-client.ts), so a bare factory breaks the
// module graph before any test runs.
//
// Except where a case sets `liveQueries`: whether the error survives the
// poll is react-query's timing, so those cases run on the real hook.
let liveQueries = false;
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactQueryModule>();
  return {
    ...actual,
    useQuery: (options: UseQueryOptions) => {
      if (liveQueries) return actual.useQuery(options);
      optionsSeen.push(options);
      return cache.get(keyOf(options.queryKey)) ?? MISS;
    },
  };
});

/** The slice of the store the hook reads. Replaced per case by `wireQueries`. */
let reduxState: { currentItemId: string | null } = { currentItemId: null };

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useSelector')` throws "Cannot
// redefine property". This is the documented cannot-be-spied case. Which id the
// store names is the hook's input, not incidental subscription bookkeeping, so
// unlike the queries it cannot be stubbed away to a constant.
vi.mock('react-redux', () => ({
  useSelector: (select: (state: typeof reduxState) => unknown) =>
    select(reduxState),
  useStore: () => ({ getState: () => reduxState }),
  useDispatch: () => vi.fn(),
}));

function makeItem(id: string, extension = 'md'): ReviewItem {
  return {
    data: { type: 'article', id },
    file: { path: `sources/${id}.${extension}`, extension } as TFile,
  } as ReviewItem;
}

/**
 * Seed the entry react-query holds for the current item, under both the bare
 * key and the keyed-by-id form.
 *
 * Both, so the cases below describe what the hook *shows* rather than which key
 * shape it happens to ask under: an item reachable by either route is an item
 * the hook can put on screen, and one belonging to an id the store has moved
 * off is the flicker however it was reached.
 */
function seedCurrentItem(cachedFor: string | null, result: QueryResult) {
  cache.set(keyOf(['current-review-item']), result);
  cache.set(keyOf(['current-review-item', cachedFor]), result);
}

/** The vault the hook reads file text through. Replaced per case. */
let vault = { read: vi.fn() };

function wireContext() {
  vault = { read: vi.fn().mockResolvedValue('text') };
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    plugin: { app: { vault } },
    reviewManager: {},
    // The hook pushes the current file into the view from an effect. Preact
    // defers effects past `render`, so these are never reached here, but the
    // context has to carry them for the hook to typecheck against it.
    reviewView: {
      file: null,
      setFile: vi.fn(),
      onLoadFile: vi.fn(),
      onUnloadFile: vi.fn(),
    },
  } as never);
}

function wireQueries({
  item,
  itemLoading,
  text,
  textLoading,
  currentItemId = item?.data.id ?? null,
}: {
  item: MaybeMissingItem | null;
  itemLoading: boolean;
  text: string | undefined;
  textLoading: boolean;
  /** Defaults to the store agreeing with the cache — the settled case. */
  currentItemId?: string | null;
}) {
  cache = new Map();
  optionsSeen = [];
  reduxState = { currentItemId };
  // `data: item`, not `item ?? undefined`: react-query distinguishes a query
  // that resolved to nothing (null) from one that has not resolved yet
  // (undefined), and so does the hook — the first is an exhausted queue, the
  // second is a fetch still running.
  seedCurrentItem(item?.data.id ?? null, {
    data: item,
    isLoading: itemLoading,
    isError: false,
    isFetchedAfterMount: true,
  });
  cache.set(keyOf(['item', item?.data.id, 'file-text']), {
    data: text,
    isLoading: textLoading,
  });
  wireContext();
}

/** Render the hook in a throwaway component and hand back what it returned. */
function callHook(): ReturnType<typeof useCurrentItemFileText> {
  let captured: ReturnType<typeof useCurrentItemFileText> | undefined;
  function Probe() {
    /* eslint-disable-next-line react-hooks/globals --
       A probe, not a component: the assignment is how the hook's return value
       leaves the render it has to happen inside. Nothing here re-renders, so
       the impurity the rule guards against cannot arise. */
    captured = useCurrentItemFileText();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(<Probe />, container);
  if (!captured) throw new Error('hook did not run');
  return captured;
}

/** The options of the query whose key starts with `head`. */
function queryOptions(head: string): UseQueryOptions {
  const options = optionsSeen.find((o) => (o.queryKey as string[])[0] === head);
  if (!options) throw new Error(`${head} query was never created`);
  return options;
}

/** The options the file-text query was created with. */
const textQueryOptions = () => queryOptions('item');
/** The options the current-item query was created with. */
const currentQueryOptions = () => queryOptions('current-review-item');

/** Two ids that are never equal — the cases about moving between items. */
const twoIdsArb = fc
  .tuple(fc.string(), fc.string())
  .filter(([a, b]) => a !== b);

/** Let the fetch, react-query's notification and preact's render land. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

/** Run the next poll, and let what it started land. */
const poll = async () => {
  await act(() => {
    vi.advanceTimersByTime(CURRENT_ITEM_REFETCH_TIME);
  });
  await settle();
};

/** The review tab the hook pushes the current item's file into. */
function makeReviewViewStub() {
  return {
    file: null,
    setFile: vi.fn(),
    onLoadFile: vi.fn(),
    onUnloadFile: vi.fn(),
  };
}

/** Mount the hook for `currentItemId` and record what every render returned. */
async function mountLive(
  currentItemId: string | null,
  reviewManager: Partial<ReviewManager>,
  reviewView = makeReviewViewStub()
) {
  reduxState = { currentItemId };
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    plugin: { app: { vault: { read: vi.fn() } } },
    reviewManager,
    reviewView,
  } as never);
  const renders: ReturnType<typeof useCurrentItem>[] = [];
  function Probe() {
    renders.push(useCurrentItem());
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(() =>
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
      container
    )
  );
  await settle();
  return renders;
}

/**
 * A read that fails (or, from `start`, hangs) until told otherwise; a hung
 * read waits to be settled, so a case can look at the hook while a fetch is
 * still in flight.
 */
function controlledRead(start: 'fail' | 'hold' = 'fail') {
  let mode = start;
  let release: (outcome: 'fail' | 'succeed') => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<'succeed'>((resolve, reject) => {
        const failure = new Error('read failed');
        if (mode === 'fail') return reject(failure);
        release = (outcome) =>
          outcome === 'fail' ? reject(failure) : resolve('succeed');
      })
  );
  return {
    read,
    hold: () => {
      mode = 'hold';
    },
    release: (outcome: 'fail' | 'succeed') => release(outcome),
  };
}

/**
 * The review manager the current-item query reads through: the queue for the
 * `null` key, the item lookup for an id. Either resolves to `item` once its
 * read does.
 */
function readingManager(
  currentItemId: string | null,
  read: () => Promise<unknown>,
  item: ReviewItem
): Partial<ReviewManager> {
  return (currentItemId === null
    ? {
        getDue: vi.fn(async () => {
          await read();
          return { all: [item], cards: [], snippets: [], articles: [item] };
        }),
      }
    : {
        getItemOrMissingFromId: vi.fn(async () => {
          await read();
          return item;
        }),
      }) as unknown as Partial<ReviewManager>;
}

// #endregion

describe('useCurrentItemFileText', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reports loading while either the item or its file text is in flight', () => {
    // The two queries run on separate legs — the item resolves, then its file
    // is read — so the caller is still loading while *either* is pending. The
    // combinations where a query reports loading with data already present are
    // included on purpose: react-query does not produce them, and the hook
    // must not quietly come to depend on that.
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: undefined }),
        (itemLoading, textLoading, id, text) => {
          wireQueries({
            item: id === null ? null : makeItem(id),
            itemLoading,
            text,
            textLoading,
          });

          const result = callHook();

          expect(result.isLoading).toBe(itemLoading || textLoading);
        }
      )
    );
  });

  it('settles rather than hanging when there is no item to read a file for', () => {
    // The guard that keeps the disjunction above honest. With no item the text
    // query is disabled, and a disabled query never reports loading, so the
    // pair resolves to "not loading" and the caller is free to say the queue is
    // empty. Were the query left enabled it would run and stay pending, and the
    // empty queue would sit behind a spinner forever.
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (id) => {
        const item = id === null ? null : makeItem(id);
        wireQueries({
          item,
          itemLoading: false,
          text: undefined,
          textLoading: false,
        });

        const result = callHook();

        expect(textQueryOptions().enabled).toBe(item !== null);
        expect(result.isLoading).toBe(false);
      })
    );
  });

  it('never reads the file of an item that is not text', async () => {
    // A PDF read as text is what the review editor would show and then write
    // back over the PDF; with the query off, nothing is read and so nothing can
    // be written. A markdown item in any casing still reads as before.
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.oneof(fc.mixedCase(fc.constantFrom('pdf', 'md')), fc.string()),
        async (id, extension) => {
          const item = makeItem(id, extension);
          const isText = extension.toLowerCase() === 'md';
          wireQueries({
            item,
            itemLoading: false,
            text: undefined,
            textLoading: false,
          });

          callHook();
          const { enabled, queryFn } = textQueryOptions();
          const text = await (queryFn as () => Promise<unknown>)();

          expect(enabled).toBe(isText);
          expect(text).toBe(isText ? 'text' : undefined);
          expect(vault.read.mock.calls).toStrictEqual(
            isText ? [[item.file]] : []
          );
        }
      )
    );
  });

  it('reads nothing for a missing item, and hands it over settled', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.constantFrom<NoteType>('article', 'snippet', 'card'),
        async (id, type) => {
          const item = {
            data: { type, id, reference: 'gone.md' },
            file: null,
          } as unknown as MaybeMissingItem;
          wireQueries({
            item,
            itemLoading: false,
            text: undefined,
            textLoading: false,
          });

          const result = callHook();
          const { enabled, queryFn } = textQueryOptions();
          const text = await (queryFn as () => Promise<unknown>)();

          expect(result).toEqual({
            item,
            text: undefined,
            isLoading: false,
            isError: false,
          });
          expect(enabled).toBe(false);
          expect(text).toBeUndefined();
          expect(vault.read).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('pairs the fetched text with the item it was keyed on', () => {
    // Normalising the absent item to null is the hook's whole contract beyond
    // the flag: callers branch on `!item`, and react-query hands back
    // `undefined`, not null, for a query that has not produced data.
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: undefined }),
        (id, text) => {
          const item = id === null ? null : makeItem(id);
          wireQueries({ item, itemLoading: false, text, textLoading: false });

          const result = callHook();

          expect(result.item).toBe(item);
          expect(result.text).toBe(text);
          // The text is cached per item id, so the id in the key has to be the
          // id of the item being returned alongside it — a mismatch would put
          // one note's contents in front of another note's file, and the review
          // editor writes back what it displays.
          expect(textQueryOptions().queryKey).toEqual([
            'item',
            item?.data.id,
            'file-text',
          ]);
        }
      )
    );
  });

  it('keys the current item on the id the store names', () => {
    // The same rule the file-text key follows, for the same reason. One shared
    // key for every item means react-query serves the item that was on screen a
    // moment ago as settled data for the item just picked, because nothing in
    // the key says they are different fetches. The id in the key makes moving
    // between items a cache miss, which is the only state a new item may
    // arrive in.
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (currentItemId) => {
        wireQueries({
          item: null,
          itemLoading: false,
          text: undefined,
          textLoading: false,
          currentItemId,
        });

        callHook();

        expect(currentQueryOptions().queryKey).toEqual([
          'current-review-item',
          currentItemId,
        ]);
      })
    );
  });

  it('shows nothing but loading once the store moves to another item', () => {
    // The reported flicker: open an item, go back to the home screen, open a
    // different one, and the first is painted again before the second arrives.
    // Everything downstream believes this hook — the review pane renders the
    // item, the action bar aims dismiss and grade at it — so handing back the
    // outgoing item is wrong twice over, not merely ugly.
    fc.assert(
      fc.property(twoIdsArb, fc.string(), ([openId, pickedId], text) => {
        wireQueries({
          item: makeItem(openId),
          itemLoading: false,
          text,
          textLoading: false,
          currentItemId: pickedId,
        });

        const result = callHook();

        expect(result.item).toBeNull();
        expect(result.text).toBeUndefined();
        expect(result.isLoading).toBe(true);
      })
    );
  });

  it('stays loading across an advance rather than re-showing the item just finished', () => {
    // Finishing an item clears the id and lets the queue name the next one, so
    // for that window the id is null while the cache still holds the item that
    // was finished. The same flicker as above with no id to compare against,
    // and the one every review passes through.
    fc.assert(
      fc.property(fc.string(), fc.string(), (finishedId, text) => {
        wireQueries({
          item: makeItem(finishedId),
          itemLoading: false,
          text,
          textLoading: false,
          currentItemId: null,
        });

        const result = callHook();

        expect(result.item).toBeNull();
        expect(result.isLoading).toBe(true);
      })
    );
  });

  it('reports an exhausted queue rather than loading forever', () => {
    // The limit on the two cases above, and why neither can simply say "no id,
    // no item": an advance that comes back empty is also a null id, and it is
    // how the queue reports there is nothing left. It is told apart by the
    // cached value — a resolved null, not an absent one — so an empty queue
    // settles instead of spinning.
    wireQueries({
      item: null,
      itemLoading: false,
      text: undefined,
      textLoading: false,
      currentItemId: null,
    });

    const result = callHook();

    expect(result.item).toBeNull();
    expect(result.isLoading).toBe(false);
  });

  it('reports a failed advance, or an item that failed before it was ever read, as an error, never as an item, an empty queue or loading', () => {
    // A failed advance has no data, which the advance rule above would read as
    // loading forever, or the stale data of an earlier advance; either way the
    // caller is told it failed, and handed nothing to show or act on. An item
    // whose first read failed has nothing to show either.
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        // What the last good fetch left: nothing at all (`undefined`) after
        // a first fetch that failed, else a resolved null or item
        fc.option(fc.option(fc.string(), { nil: null }), { nil: undefined }),
        fc.boolean(),
        (currentItemId, cachedId, itemLoading) => {
          wireQueries({
            item: null,
            itemLoading: false,
            text: undefined,
            textLoading: false,
            currentItemId,
          });
          // An item's own key holds data only once it has been read
          const cached =
            currentItemId !== null || cachedId === undefined
              ? undefined
              : cachedId === null
                ? null
                : makeItem(cachedId);
          seedCurrentItem(currentItemId, {
            data: cached,
            isLoading: itemLoading,
            isError: true,
            isFetchedAfterMount: true,
          });
          // With no item the text query is disabled, and a disabled query is
          // not loading; the stub's miss would say it is
          cache.set(keyOf(['item', undefined, 'file-text']), {
            data: undefined,
            isLoading: false,
          });

          const result = callHook();

          expect(result.item).toBeNull();
          expect(result.text).toBeUndefined();
          expect(result.isError).toBe(true);
          expect(result.isLoading).toBe(false);
        }
      )
    );
  });

  it('keeps showing what an item last read as when a refetch of it fails', () => {
    // Swapping the item for the error would unmount the editor under the
    // user over one failed poll; the next good poll replaces it anyway.
    fc.assert(
      fc.property(
        fc.string(),
        fc.boolean(),
        fc.option(fc.string(), { nil: undefined }),
        (id, stillThere, text) => {
          const item = stillThere ? makeItem(id) : null;
          wireQueries({
            item,
            itemLoading: false,
            text,
            textLoading: false,
            currentItemId: id,
          });
          seedCurrentItem(id, {
            data: item,
            isLoading: false,
            isError: true,
            isFetchedAfterMount: true,
          });

          const result = callHook();

          expect(result.item).toBe(item);
          expect(result.isError).toBe(false);
          expect(result.isLoading).toBe(false);
        }
      )
    );
  });

  it('reports no error while the current item query has not failed', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: null }),
        fc.boolean(),
        (currentItemId, cachedId, itemLoading) => {
          wireQueries({
            item: cachedId === null ? null : makeItem(cachedId),
            itemLoading,
            text: undefined,
            textLoading: false,
            currentItemId,
          });

          expect(callHook().isError).toBe(false);
        }
      )
    );
  });

  // The option is the behavior here, as for `useQueue` below: react-query is
  // mocked out in this file, and what `retry: false` does is react-query's own
  it('asks react-query to report a failed current item fetch at once, not retry it', () => {
    wireQueries({
      item: null,
      itemLoading: false,
      text: undefined,
      textLoading: false,
    });

    callHook();

    // Each retry would hold the spinner up a while longer before the error
    // shows; the five-second poll is what tries again
    expect(currentQueryOptions().retry).toBe(false);
  });
});

describe('useCurrentItem on a live query client', () => {
  beforeEach(() => {
    liveQueries = true;
    // Only the poll's clock: rendering and react-query's notifications keep
    // running on real timeouts
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    liveQueries = false;
    vi.useRealTimers();
    queryClient.clear();
    store.dispatch(resetSession());
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const item = makeItem('item-1');

  it.each([
    { label: 'an advance', currentItemId: null },
    { label: 'an item never read', currentItemId: 'item-1' },
  ])(
    'reports a failed read of $label through every poll that retries it, never as loading, until a poll succeeds',
    async ({ currentItemId }) => {
      const reads = controlledRead();
      const renders = await mountLive(
        currentItemId,
        readingManager(currentItemId, reads.read, item)
      );
      // Loading until the first read has failed, never an error ahead of it
      expect(renders[0]).toEqual({
        data: undefined,
        isLoading: true,
        isError: false,
      });
      expect(renders.at(-1)).toEqual({
        data: undefined,
        isLoading: false,
        isError: true,
      });

      // A poll in flight, then failing again: the error throughout
      reads.hold();
      const before = renders.length;
      await poll();
      expect(reads.read).toHaveBeenCalledTimes(2);
      reads.release('fail');
      await settle();
      for (const shown of renders.slice(before)) {
        expect(shown).toEqual({
          data: undefined,
          isLoading: false,
          isError: true,
        });
      }

      // The next good poll clears it, with nothing reopened
      await poll();
      expect(reads.read).toHaveBeenCalledTimes(3);
      reads.release('succeed');
      await settle();
      const recovered = renders.at(-1);
      expect(recovered?.isError).toBe(false);
      // Off the advance, review moves onto the item; the store that does
      // that is not the one this hook reads here, so it is still advancing
      expect(recovered?.data).toBe(currentItemId === null ? undefined : item);
      expect(store.getState().currentItemId).toBe(
        currentItemId === null ? item.data.id : null
      );
    }
  );

  // Examples rather than properties: what varies here is the key's shape (the
  // advance or an item) and what the cache held, not the id itself, which the
  // mocked cases above already draw at random
  it.each([
    { label: 'an advance', currentItemId: null, emptyBefore: false },
    {
      label: 'an advance that had come back empty',
      currentItemId: null,
      emptyBefore: true,
    },
    {
      label: 'an item never read',
      currentItemId: 'item-1',
      emptyBefore: false,
    },
  ])(
    'shows loading, not what was cached before a failure from before it mounted, while its first read of $label is in flight',
    async ({ currentItemId, emptyBefore }) => {
      // A review tab closed on the error leaves it cached; the next one to
      // open asks again, and nothing it has seen has failed yet. An empty
      // queue that failed after is no more an answer than the failure: the
      // summary it stands for would say nothing is due.
      if (emptyBefore) {
        queryClient.setQueryData(['current-review-item', currentItemId], null);
      }
      await queryClient.prefetchQuery({
        queryKey: ['current-review-item', currentItemId],
        queryFn: () => Promise.reject(new Error('read failed')),
        retry: false,
        // Fetch even over the empty answer just cached
        staleTime: 0,
      });
      expect(
        queryClient.getQueryState(['current-review-item', currentItemId])
          ?.status
      ).toBe('error');
      const reads = controlledRead('hold');
      const renders = await mountLive(
        currentItemId,
        readingManager(currentItemId, reads.read, item)
      );
      expect(reads.read).toHaveBeenCalledTimes(1);
      for (const shown of renders) {
        expect(shown).toEqual({
          data: undefined,
          isLoading: true,
          isError: false,
        });
      }

      reads.release('succeed');
      await settle();
      expect(renders.at(-1)?.isError).toBe(false);
    }
  );
});

describe('useCurrentItem handing the item to the review tab', () => {
  afterEach(() => {
    queryClient.clear();
    store.dispatch(resetSession());
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each(NOTE_TYPES)(
    "gives the tab the %s's type along with its file, so a card's name stays out of its title",
    async (type) => {
      liveQueries = true;
      try {
        const item = {
          data: { type, id: 'item-1' },
          file: { path: 'notes/item-1.md', extension: 'md' } as TFile,
        } as ReviewItem;
        const reviewView = makeReviewViewStub();

        await mountLive(
          'item-1',
          readingManager('item-1', async () => {}, item),
          reviewView
        );

        expect(reviewView.setFile).toHaveBeenLastCalledWith(item.file, type);
      } finally {
        liveQueries = false;
      }
    }
  );
});

describe('useQueue', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    optionsSeen = [];
    vi.restoreAllMocks();
  });

  // The option is the behavior here: react-query is mocked out in this file,
  // and what `retry: false` does is react-query's own
  it('asks react-query to report a failed fetch at once, not retry it', () => {
    vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
      reviewManager: { getQueue: vi.fn() },
    } as never);
    function Probe() {
      useQueue({});
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<Probe />, container);

    // A failed read of the database fails again on retry, and each retry
    // holds the spinner up a while longer before the error shows
    expect(queryOptions('queue').retry).toBe(false);
  });
});

describe('useReviewItems', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /**
   * Ids to look up, against a database holding items for `storedIds`. The ids
   * asked for mix ones the database holds with ones it does not, in any order
   * and with repeats — an id held in the store can outlive its item.
   */
  const lookupArb = fc.uniqueArray(fc.string()).chain((storedIds) =>
    fc.record({
      storedIds: fc.constant(storedIds),
      ids: fc.array(
        storedIds.length
          ? fc.oneof(fc.constantFrom(...storedIds), fc.string())
          : fc.string()
      ),
    })
  );

  /** Render the hook for `ids` and hand back the query it built. */
  function buildQuery(ids: string[], storedIds: string[]) {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    optionsSeen = [];
    cache = new Map();

    const stored = new Map(storedIds.map((id) => [id, makeItem(id)]));
    const getReviewItemFromId = vi.fn(
      async (id: string) => stored.get(id) ?? null
    );
    vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
      reviewManager: { getReviewItemFromId },
    } as never);

    function Probe() {
      useReviewItems(ids);
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<Probe />, container);

    const options = queryOptions('review-items');
    const run = options.queryFn as () => Promise<ReviewItem[]>;
    return { options, run, stored, getReviewItemFromId };
  }

  it('keys the lookup on the ids asked for, apart from the entries review evicts', () => {
    fc.assert(
      fc.property(lookupArb, ({ ids, storedIds }) => {
        const { options } = buildQuery(ids, storedIds);

        expect(options.queryKey).toEqual(['review-items', ids]);
      })
    );
  });

  it('resolves the ids that name an item, in the order asked, leaving out the rest', async () => {
    await fc.assert(
      fc.asyncProperty(lookupArb, async ({ ids, storedIds }) => {
        const { run, stored, getReviewItemFromId } = buildQuery(ids, storedIds);

        const items = await run();

        const expected = ids.flatMap((id) => stored.get(id) ?? []);
        expect(items).toHaveLength(expected.length);
        items.forEach((item, i) => expect(item).toBe(expected[i]));
        expect(getReviewItemFromId.mock.calls).toEqual(ids.map((id) => [id]));
      })
    );
  });
});

describe('useCardsDueLaterToday', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    optionsSeen = [];
    vi.restoreAllMocks();
  });

  /** Render the hook against a database counting `count`; hand back its query. */
  function buildQuery(count: number) {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    optionsSeen = [];
    cache = new Map();

    const countDueLaterToday = vi.fn(async () => count);
    vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
      reviewManager: { cards: { countDueLaterToday } },
    } as never);

    function Probe() {
      useCardsDueLaterToday();
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<Probe />, container);

    const options = queryOptions('cards-due-later-today');
    const run = options.queryFn as () => Promise<number>;
    return { options, run, countDueLaterToday };
  }

  it('resolves to the count the card table gives for now', async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat(), async (count) => {
        const { options, run, countDueLaterToday } = buildQuery(count);

        expect(options.queryKey).toEqual(['cards-due-later-today']);
        expect(await run()).toBe(count);
        // Left to default to the current time
        expect(countDueLaterToday.mock.calls).toEqual([[]]);
      })
    );
  });

  // The option is the behavior here: react-query is mocked out in this file,
  // and what a zero stale time does is react-query's own
  it('asks react-query to count again each time the summary mounts', () => {
    const { options } = buildQuery(0);

    // The card just graded may be the one that changed the count
    expect(options.staleTime).toBe(0);
  });

  it('keeps no count once the summary unmounts, so the next one never shows the last', () => {
    const { options } = buildQuery(0);

    // A kept count is served the instant the next summary mounts, before the
    // recount settles: a card graduated since would still show as coming due
    expect(options.gcTime).toBe(0);
  });
});
